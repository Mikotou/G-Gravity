import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AcpSessionUpdateNotification, AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import { AcpClient } from '../acp/acp-client';
import { ClientStore } from '../storage/client-store';

const WORKER = 'thought-translator';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type Binding = { workerId: string; proof: string };
interface ParentSession {
  ready: Promise<void>;
  queue: Promise<unknown>;
  starting: boolean;
  workerId?: string;
  target?: string;
  busy: boolean;
  epoch: number;
}

function trackTool(name: string, matches: (input: Record<string, unknown>) => boolean, completedOnly: boolean) {
  const candidates = new Set<string>();
  const title = new RegExp('\\b' + name + '\\b', 'i');
  return (update: AcpSessionUpdatePayload): boolean => {
    if (!['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return false;
    const id = update.toolCallId;
    if (update.status === 'failed') { if (id) candidates.delete(id); return false; }
    const input = update.rawInput;
    const match = Boolean((update.name === name || title.test(update.title || '')) &&
      input && typeof input === 'object' && matches(input));
    if (id && match) candidates.add(id);
    return (match || Boolean(id && candidates.has(id))) && (!completedOnly || update.status === 'completed');
  };
}

/** A real swarm member belongs to one parent. No additional top-level ACP session is created. */
export class SwarmTranslator {
  private parents = new Map<string, ParentSession>();
  private profileId = 'default';
  private bindings: Record<string, Binding> = {};

  constructor(
    private client: AcpClient,
    private store: ClientStore,
    private isUserSession: (id: string) => boolean,
    private onActivity?: (parentId: string, memberId: string, status: 'waiting' | 'working' | 'stopped') => void,
  ) {}

  setProfile(profileId: string): void {
    this.reset();
    this.profileId = profileId;
    this.bindings = this.store.read(this.filename(), {}) || {};
  }

  private filename(): string { return 'swarm-translators-' + this.profileId + '.json'; }
  isStarting(id: string): boolean { return this.parents.get(id)?.starting === true; }
  hasAttempt(id: string): boolean { return this.parents.has(id); }
  pendingStart(id: string): Promise<void> | undefined { return this.parents.get(id)?.ready; }

  start(parentId: string, cwd: string, report: (message: string) => void): Promise<void> {
    const existing = this.parents.get(parentId);
    if (existing) return existing.ready;
    const state: ParentSession = { ready: Promise.resolve(), queue: Promise.resolve(), starting: true, busy: false, epoch: 0 };
    this.parents.set(parentId, state);
    state.ready = (async () => {
      try {
        const saved = this.bindings[parentId];
        const binding = saved || await this.delegate(parentId, state);
        if (this.parents.get(parentId) !== state) return;
        if (!UUID.test(binding.workerId) || !binding.proof?.startsWith('gravity-ready-') || !UUID.test(binding.proof.slice('gravity-ready-'.length)) ||
            binding.workerId === parentId || this.isUserSession(binding.workerId) ||
            Object.entries(this.bindings).some(([id, item]) => id !== parentId && item.workerId === binding.workerId)) {
          throw new Error('没有收到可核对的独立成员标识');
        }
        await this.attachMember(parentId, state, binding, cwd);
        if (this.parents.get(parentId) !== state) return;
        state.workerId = binding.workerId;
        this.bindings[parentId] = binding;
        this.store.write(this.filename(), this.bindings);
        this.onActivity?.(parentId, binding.workerId, 'waiting');
        report('蜂群翻译成员已就绪，将翻译本会话公开显示的英文思考。');
      } catch (error) {
        if (this.parents.get(parentId) !== state) return;
        if (state.target) this.cancelTarget(state.target);
        report('蜂群翻译暂不可用，使用本地翻译。' + (error instanceof Error ? error.message : '成员未确认'));
      } finally { state.starting = false; state.target = undefined; }
    })();
    return state.ready;
  }

  private async delegate(parentId: string, state: ParentSession): Promise<Binding> {
    const proof = 'gravity-ready-' + randomUUID();
    const instruction = [
      '现在启动本会话的蜂群思考翻译。你是协调者。实际调用 swarm 工具的 add 操作，只创建一名成员 thought-translator，使用可用 Flash 模型、inherit 工作区。',
      '把以下要求和标记逐字写进 brief：只做简体中文翻译，不读写文件、不运行命令、不再委派。现在用 post_message 在消息板向 @coordinator 回报这个就绪标记一次：' + proof,
      'swarm add 成功后立即用 manage_subagents 的 list 取得该成员的真实 conversation UUID，直接回复，不调用 swarm_wait、read_board，不等待子成员执行完毕。客户端负责核对就绪回报。',
      '最后只回复一行 JSON {"workerId":"该成员真实的 conversation UUID"}。缺少蜂群能力就说明原因。不要创建其他成员，不要猜测 ID。'
    ].join('\n');
    let reply = '';
    let added = false;
    const addedMember = trackTool('swarm', input => input.action === 'add' && input.name === WORKER &&
      typeof input.brief === 'string' && input.brief.includes(proof), true);
    const observe = ({ sessionId, update }: AcpSessionUpdateNotification) => {
      if (sessionId !== parentId) return;
      if (update.sessionUpdate === 'agent_message_chunk') reply = (reply + (update.content?.text || '')).slice(-8192);
      if (addedMember(update)) added = true;
    };
    state.target = parentId;
    this.client.on('session/update', observe);
    try {
      await this.client.request('session/prompt', { sessionId: parentId, prompt: [{ type: 'text', text: instruction }] }, 120000);
      const workerId = /"workerId"\s*:\s*"([^"]+)"/.exec(reply)?.[1];
      if (!added || !workerId) throw new Error('主模型未确认蜂群成员或未返回其标识');
      return { workerId, proof };
    } finally { this.client.off('session/update', observe); }
  }

  /** The child's own board post proves that it received this parent's one-time registration marker. */
  private async attachMember(parentId: string, state: ParentSession, binding: Binding, cwd: string): Promise<void> {
    let verified = false;
    const memberPost = trackTool('post_message', input => typeof input.text === 'string' && input.text.includes(binding.proof), false);
    const observe = ({ sessionId, update }: AcpSessionUpdateNotification) => {
      if (sessionId === binding.workerId && memberPost(update)) verified = true;
    };
    state.target = undefined;
    this.client.on('session/update', observe);
    try {
      // The member can post just after the parent returns its ID. Replay only the public ACP events.
      for (const pause of [0, 1000, 2500, 5000]) {
        if (pause) await delay(pause);
        if (this.parents.get(parentId) !== state) return;
        await this.client.request('session/load', { sessionId: binding.workerId, cwd, mcpServers: [] });
        if (verified) break;
      }
      if (this.parents.get(parentId) !== state || !verified) throw new Error('未能从成员的就绪回报确认会话归属');
    } finally { this.client.off('session/update', observe); }
  }

  async translate(parentId: string, segment: string, onDelta?: (value: string) => void): Promise<string> {
    const state = this.parents.get(parentId);
    if (!state) return '';
    const epoch = state.epoch;
    const run = async () => {
      await state.ready;
      const workerId = state.workerId;
      const current = () => this.parents.get(parentId) === state && state.epoch === epoch;
      if (!workerId || !current()) return '';
      let reply = '';
      const observe = ({ sessionId, update }: AcpSessionUpdateNotification) => {
        if (current() && sessionId === workerId && update.sessionUpdate === 'agent_message_chunk') {
          reply += update.content?.text || '';
          onDelta?.(reply);
        }
      };
      state.busy = true;
      this.onActivity?.(parentId, workerId, 'working');
      this.client.on('session/update', observe);
      try {
        const response = await this.client.request<{ stopReason: string }>('session/prompt', {
          sessionId: workerId,
          prompt: [{ type: 'text', text: '把以下 JSON 字符串中的可见文本译成简体中文，保留代码、路径与命令。只输出译文，不使用工具或消息板。\n' + JSON.stringify(segment) }],
        }, 45000);
        return current() && response.stopReason === 'end_turn' ? reply.trim() : '';
      } catch (error) {
        if (current()) this.cancelTarget(workerId);
        throw error;
      } finally {
        state.busy = false;
        this.client.off('session/update', observe);
        if (this.parents.get(parentId) === state) this.onActivity?.(parentId, workerId, 'waiting');
      }
    };
    const result = state.queue.then(run, run);
    state.queue = result.catch(() => {});
    return result;
  }

  cancelTurn(parentId: string): void {
    const state = this.parents.get(parentId);
    if (!state) return;
    state.epoch++;
    if (state.busy && state.workerId) this.cancelTarget(state.workerId);
  }

  release(parentId: string): void {
    const state = this.parents.get(parentId);
    if (!state) return;
    this.cancelTurn(parentId);
    this.parents.delete(parentId);
    if (state.workerId) this.onActivity?.(parentId, state.workerId, 'stopped');
    if (state.target) this.cancelTarget(state.target);
    if (state.workerId && this.client.connected && this.client.initializeResult?.agentCapabilities.sessionCapabilities?.close) {
      void this.client.request('session/close', { sessionId: state.workerId }, 3000).catch(() => {});
    }
  }

  private cancelTarget(id: string): void {
    if (this.client.connected) {
      try { this.client.notify('session/cancel', { sessionId: id }); } catch { /* already disconnected */ }
    }
  }
  reset(): void { for (const id of this.parents.keys()) this.release(id); }
}

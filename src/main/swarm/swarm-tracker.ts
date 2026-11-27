import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import type {
  SwarmActionEvent, SwarmBoardMessage, SwarmHistoryCursor, SwarmTopologyState, SwarmWorkerNode,
  SwarmWorkerStatus,
} from '../../shared/swarm-contract';
import type { ClientStore } from '../storage/client-store';
import { SwarmPendingWrites } from './swarm-pending-writes';
import { SwarmArchive } from './swarm-archive';
import type { SwarmSessionLog } from './swarm-session-log';
import { swarmMessageMentions } from '../../shared/swarm-contract';

type ToolFields = Record<string, unknown>;
const supported = new Set([
  'swarm',
  'post_message',
  'read_board',
  'swarm_wait',
  'invoke_subagent',
  'send_message',
  'manage_subagents',
  'define_subagent',
  'run_workflow',
]);
const statuses = new Set(['working', 'waiting', 'stopped', 'killed', 'completed', 'failed', 'unconfirmed']);
function objectFields(value: unknown): ToolFields {
  if (typeof value === 'string') {
    try {
      return objectFields(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ToolFields) : {};
}
const firstText = (...values: unknown[]): string =>
  (values.find((v) => typeof v === 'string' && v.trim()) as string) || '';
function detectTool(update: AcpSessionUpdatePayload, input: ToolFields): string | undefined {
  const explicit = firstText(input.toolName, update.name);
  if (supported.has(explicit)) return explicit;
  if (explicit) return;
  const title = firstText(update.title).trim().toLowerCase();
  const direct = [...supported].find(
    (item) =>
      title === item ||
      title.startsWith(item + ' ') ||
      title.startsWith(item + '(') ||
      title.endsWith('/' + item) ||
      title.endsWith(':' + item)
  );
  if (direct) return direct;
  if (
    typeof input.TypeName === 'string' &&
    (typeof input.Prompt === 'string' || typeof input.Role === 'string')
  )
    return 'invoke_subagent';
  if (typeof input.Name === 'string' && typeof input.SystemPrompt === 'string') return 'define_subagent';
  if (typeof input.Recipient === 'string' && typeof input.Message === 'string') return 'send_message';
  if (
    ['list', 'kill', 'kill_all'].includes(firstText(input.Action)) &&
    (Array.isArray(input.ConversationIds) || /subagent/i.test(title))
  )
    return 'manage_subagents';
  if (
    /swarm/.test(title) &&
    ['status', 'models', 'add', 'model', 'kill', 'title', 'spawn', 'create'].includes(firstText(input.action))
  )
    return 'swarm';
  if (/workflow/.test(title) && (typeof input.Script === 'string' || typeof input.ScriptPath === 'string'))
    return 'run_workflow';
}
function readToolOutput(update: AcpSessionUpdatePayload): ToolFields {
  const result: ToolFields = {};
  const content = update.toolContent || (Array.isArray(update.content) ? update.content : []);
  const parts = [...content.map((c: { content?: { text?: string } }) => c.content?.text), update.rawOutput];
  for (const part of parts) {
    const data = objectFields(part);
    Object.assign(result, data);
    const raw = typeof part === 'string' ? part : firstText(data.output, data.Output, data.text);
    if (!raw) continue;
    Object.assign(result, objectFields(raw));
    const id = /\bconversation[_ ]?id["':=\s]+([a-zA-Z0-9_-]{6,})/i.exec(raw)?.[1];
    if (id && !result.conversationId) result.conversationId = id;
    if (!Object.keys(data).length) result.textOutput = raw;
  }
  return result;
}
interface TrackedCall {
  name: string;
  input: ToolFields;
  output: ToolFields;
  status?: string;
}

export class SwarmTracker extends EventEmitter {
  private archive: SwarmArchive;
  private pending = new Map<string, TrackedCall>();
  private connectionSessions = new Set<string>();
  private recovering = new Set<string>();
  private replays = new Map<string, Map<string, TrackedCall>>();
  private unsaved = new SwarmPendingWrites(id => {
    if (this.listenerCount('updated')) this.emit('updated', this.unavailable(id));
  }, id => {
    if (!this.listenerCount('updated')) return;
    let state: SwarmTopologyState;
    try { state = this.archive.read(id, log => log.state()); } catch { state = this.unavailable(id); }
    if (this.unsaved.has(id)) state.historyUnavailable = true;
    state.refreshHistoryWorkers = true;
    this.emit('updated', state);
  });
  constructor(private store?: ClientStore) {
    super();
    this.archive = new SwarmArchive(store);
  }
  setProfile(profile?: string, owned?: ReadonlySet<string>): void {
    if (this.flush().length) throw new Error('Swarm 仍有未保存记录，请重试');
    this.clear();
    this.archive = new SwarmArchive(this.store, profile, owned);
  }
  clear(): string[] {
    if (this.unsaved.ids().length) {
      if (this.store) this.archive.close();
      return this.unsaved.ids();
    }
    this.pending.clear();
    this.connectionSessions.clear();
    this.replays.clear();
    this.archive.close();
    return [];
  }
  flush(): string[] {
    for (const id of this.unsaved.ids()) while (this.unsaved.drain(id)) { /* finish each FIFO batch before switching */ }
    return this.unsaved.ids();
  }
  remove(sessionId: string): void {
    this.archive.remove(sessionId);
    this.dropPending(sessionId);
    this.replays.delete(sessionId);
    this.unsaved.remove(sessionId);
    this.connectionSessions.delete(sessionId);
  }
  private dropPending(sessionId: string): void {
    for (const key of this.pending.keys()) if (key.startsWith(sessionId + '\0')) this.pending.delete(key);
  }
  getState(sessionId: string, before?: SwarmHistoryCursor): SwarmTopologyState {
    try {
      const read = () => this.archive.read(sessionId, log => log.state(before));
      if (!this.unsaved.has(sessionId)) return read();
      return this.archive.withoutLockWait(() => {
        if (this.unsaved.drain(sessionId, true) && !this.recovering.has(sessionId)) {
          this.recovering.add(sessionId);
          const archive = this.archive;
          setImmediate(() => {
            this.recovering.delete(sessionId);
            if (this.archive !== archive || !this.unsaved.has(sessionId)) return;
            this.getState(sessionId);
          }).unref();
        }
        const state = read();
        if (this.unsaved.has(sessionId)) state.historyUnavailable = true;
        return state;
      });
    } catch {
      if (before) throw Error('暂时无法读取这一页 Swarm 记录');
      return this.unavailable(sessionId);
    }
  }
  private unavailable(sessionId: string): SwarmTopologyState {
    return {
      sessionId,
      isActive: false,
      swarmTitle: '',
      workers: [],
      boardMessages: [],
      actionTimeline: [],
      channels: [],
      stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 },
      updatedAt: '',
      historyUnavailable: true,
    };
  }
  needsReplay(sessionId: string): boolean {
    try {
      return this.unsaved.has(sessionId) || this.archive.read(sessionId, (log) => !log.checked());
    } catch {
      return true;
    }
  }
  trackNew(sessionId: string): void {
    this.unsaved.persist(sessionId, () => this.archive.write(sessionId, log => log.markChecked()));
  }
  beginReplay(sessionId: string): void {
    this.replays.set(sessionId, new Map());
  }
  discardReplay(sessionId: string): void {
    this.replays.delete(sessionId);
  }
  finishReplay(sessionId: string): void {
    const calls = this.replays.get(sessionId);
    this.replays.delete(sessionId);
    if (!calls) return;
    if (calls.size) this.connectionSessions.add(sessionId);
    this.unsaved.persist(sessionId, () => {
      let changed = false;
      this.archive.write(sessionId, (log) => {
        log.markChecked();
        for (const [id, call] of calls)
          if (this.terminal(call.status) && !log.seen(id)) {
            this.apply(log, id, call, true);
            changed = true;
          }
      });
      if (changed && !this.unsaved.draining(sessionId)) this.emit('updated', this.archive.read(sessionId, log => log.state()));
    });
  }
  private terminal(status?: string): boolean {
    return ['completed', 'failed', 'rejected', 'cancelled', 'canceled'].includes(status || '');
  }

  consume(sessionId: string, update: AcpSessionUpdatePayload, replay = false): void {
    const id = update.toolCallId;
    if (!id || !['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
    const staged = replay ? this.replays.get(sessionId) : undefined;
    if (replay && !staged) return;
    const table = staged || this.pending,
      key = staged ? id : sessionId + '\0' + id;
    const previous = table.get(key),
      input = { ...previous?.input, ...objectFields(update.rawInput) };
    const name = previous?.name || detectTool(update, input);
    if (!name) return;
    const call: TrackedCall = {
      name,
      input,
      output: { ...previous?.output, ...readToolOutput(update) },
      status: update.status ?? previous?.status,
    };
    if (staged) {
      if (!this.terminal(previous?.status) && this.terminal(call.status)) table.delete(key);
      table.set(key, call);
      return;
    }
    this.connectionSessions.add(sessionId);
    if (!this.terminal(call.status)) {
      table.set(key, call);
      const sender = firstText(input.sender, input.actor);
      if (sender)
        this.unsaved.persist(sessionId, () => {
          this.update(sessionId, (log) => {
            if (log.seen(id)) return false;
            const worker = log.member(sender);
            if (!worker) return false;
            const latest = this.latestCall(sessionId, worker);
            if (!latest || worker.currentCallId === latest.id && worker.currentAction === latest.action) return false;
            log.put({ ...worker, currentAction: latest.action, currentCallId: latest.id });
            return true;
          });
        });
      return;
    }
    this.unsaved.persist(sessionId, () => this.update(sessionId, log => {
      if (log.seen(id)) return false;
      this.apply(log, id, call, false);
      return true;
    }));
    table.delete(key);
  }
  private update(sessionId: string, edit: (log: SwarmSessionLog) => boolean) {
    const changed = this.archive.write(sessionId, log => {
      if (!edit(log)) return;
      log.touch(new Date().toISOString());
      if (this.listenerCount('updated') && !this.unsaved.draining(sessionId)) return [...log.changedWorkers.values()];
    });
    if (changed) {
      const state = this.archive.read(sessionId, log => log.state());
      if (changed.length > state.workers.length) state.refreshHistoryWorkers = true;
      else if (changed.length) state.changedWorkers = changed;
      this.emit('updated', state);
    }
  }
  markUnconfirmed(sessionId: string, zh = '连接已中断', en = 'Connection interrupted'): void {
    this.connectionSessions.delete(sessionId);
    this.dropPending(sessionId);
    this.unsaved.persist(sessionId, () => {
      this.update(sessionId, (log) => {
        const work = log.matching('status', 'working');
        for (const worker of work) {
          const now = new Date().toISOString();
          log.put({
            ...worker,
            status: 'unconfirmed',
            currentAction: undefined,
            currentCallId: undefined,
            updatedAt: now,
          });
          this.event(
            log,
            'worker_status_changed',
            worker.name,
            zh + '，成员状态待确认',
            en + '; worker status unconfirmed',
            worker.name,
            now
          );
        }
        return work.length > 0;
      });
    });
  }
  disconnected(): void {
    // Opening the archive already retires earlier connections. Only this connection can introduce new working members.
    for (const id of [...this.connectionSessions]) this.markUnconfirmed(id);
    this.pending.clear();
  }
  private event(
    log: SwarmSessionLog,
    type: SwarmActionEvent['eventType'],
    actor: string,
    zh: string,
    en: string,
    target?: string,
    timestamp = new Date().toISOString()
  ): void {
    log.addEvent({
      id: randomUUID(),
      sessionId: log.sessionId,
      eventType: type,
      actorName: actor,
      targetName: target,
      summaryZh: zh,
      summaryEn: en,
      timestamp,
    });
  }
  private latestCall(sessionId: string, worker: SwarmWorkerNode, exclude?: string) {
    const prefix = sessionId + '\0';
    let latest: { id: string; action: string } | undefined;
    for (const [key, call] of this.pending) {
      if (key.startsWith(prefix) && key !== prefix + exclude && [worker.id, worker.name].includes(firstText(call.input.sender, call.input.actor))) {
        latest = { id: key.slice(prefix.length), action: '正在执行 ' + call.name };
      }
    }
    return latest;
  }
  private apply(log: SwarmSessionLog, id: string, call: TrackedCall, replay: boolean): void {
    log.ensure();
    log.replaying = replay;
    const { name, input, output } = call,
      actor = firstText(input.sender, input.actor, '协调者');
    const now = firstText(output.timestamp, input.timestamp, new Date().toISOString());
    const event = (type: SwarmActionEvent['eventType'], zh: string, en: string, target?: string) =>
      this.event(log, type, actor, zh, en, target, now);
    const source = log.member(firstText(input.sender, input.actor));
    if (source?.currentCallId === id) {
      const latest = this.latestCall(log.sessionId, source, id);
      log.put({ ...source, currentAction: latest?.action, currentCallId: latest?.id, updatedAt: now });
    }
    if (call.status !== 'completed') {
      const reason = firstText(output.message, output.error, output.textOutput);
      event(
        'tool_failed',
        name + ' 未成功' + (reason ? ' · ' + reason : ''),
        name + ' ' + call.status + (reason ? ' · ' + reason : '')
      );
    } else {
      const kind = name === 'invoke_subagent' ? 'subagent' : 'swarm-worker';
      const action = firstText(input.action, input.Action, input.command).toLowerCase();
      const title = firstText(output.title, input.title);
      if ((name === 'swarm' || name === 'invoke_subagent') && title && title !== log.title()) {
        log.setTitle(title);
        event('swarm_titled', '蜂群主题：' + title, 'Swarm title: ' + title);
      }
      if (name === 'define_subagent') {
        const target = firstText(input.Name, input.name);
        if (target)
          event(
            'subagent_invoked',
            '已定义专属子个体类型：' + target,
            'Defined subagent type: ' + target,
            target
          );
      }
      if (name === 'run_workflow') {
        const description = firstText(input.Description, input.ScriptPath, 'Workflow');
        event('workflow_completed', '工作流已完成：' + description, 'Workflow completed: ' + description);
      }
      const workers = Array.isArray(output.workers)
        ? output.workers
        : Array.isArray(output.agents)
          ? output.agents
          : Array.isArray(input.workers)
            ? input.workers
            : Array.isArray(input.agents)
              ? input.agents
              : [];
      for (const raw of workers) this.upsert(log, objectFields(raw), kind, actor, now, replay);
      if (
        !workers.length &&
        (name === 'invoke_subagent' || (name === 'swarm' && ['add', 'create', 'spawn'].includes(action)))
      ) {
        const tasks = Array.isArray(input.tasks) ? input.tasks : [];
        const requestedCount = input.n ?? input.count;
        const count = tasks.length || (typeof requestedCount === 'number' && Number.isSafeInteger(requestedCount) && requestedCount > 1 ? requestedCount : 1);
        const ids = Array.isArray(output.conversationIds) ? output.conversationIds : Array.isArray(input.conversationIds) ? input.conversationIds : [];
        const base = firstText(input.name, 'worker');
        if (count === 1 && tasks.length === 0)
          this.upsert(log, { ...input, ...output }, kind, actor, now, replay);
        else
          for (let i = 0; i < count; i++)
            this.upsert(
              log,
              {
                ...input,
                ...output,
                ...(count > 1 && { id: undefined, agentId: undefined, ConversationId: undefined, conversationId: ids[i] }),
                name: base + '-' + (i + 1),
                brief: tasks.length
                  ? [firstText(input.brief), firstText(tasks[i], objectFields(tasks[i]).brief)]
                      .filter(Boolean)
                      .join(' · ')
                  : input.brief,
              },
              kind,
              actor,
              now,
              replay
            );
      }
      if (name === 'swarm' && action === 'model') {
        const worker = log.member(firstText(input.name)),
          model = firstText(input.model);
        if (worker && model && worker.model !== model) {
          log.put({ ...worker, model, updatedAt: now });
          event(
            'model_switched',
            worker.name + ' 切换到 ' + model,
            worker.name + ' switched to ' + model,
            worker.name
          );
        }
      }
      if (['read_board', 'post_message', 'send_message'].includes(name)) {
        const messages = Array.isArray(output.messages)
          ? output.messages
          : name === 'read_board'
            ? []
            : [{ ...input, ...output }];
        const occurrences = new Map<string, number>();
        for (const raw of messages)
          this.message(log, objectFields(raw), name, input, actor, now, replay, occurrences);
      }
      if (['manage_subagents', 'swarm', 'swarm_wait'].includes(name)) {
        const byAction: Record<string, SwarmWorkerStatus> = {
          kill: 'killed',
          kill_all: 'killed',
          stop: 'stopped',
          pause: 'stopped',
          resume: 'working',
          wait: 'waiting',
        };
        const status = byAction[action];
        if (status) {
          const ids = [
            ...new Set(
              [
                firstText(input.target, input.name, input.agentId),
                ...(Array.isArray(input.ConversationIds) ? input.ConversationIds.map((v) => firstText(v)) : []),
              ].filter(Boolean)
            ),
          ];
          const targets =
            action === 'kill_all'
              ? log.matching('kind', 'subagent')
              : ids.map((v) => log.member(v)).filter((worker): worker is SwarmWorkerNode => !!worker);
          for (const worker of targets) {
            if (
              worker.status === status ||
              (action === 'kill_all' && ['completed', 'killed', 'failed'].includes(worker.status))
            )
              continue;
            log.put({
              ...worker,
              status: replay && status === 'working' ? 'unconfirmed' : status,
              currentAction: undefined,
              currentCallId: undefined,
              updatedAt: now,
            });
            event(
              status === 'killed' ? 'worker_killed' : 'worker_status_changed',
              worker.name + ' 状态已更新',
              worker.name + ' status updated',
              worker.name
            );
          }
        }
      }
    }
    log.touch(now);
    log.markSeen(id);
  }
  private upsert(
    log: SwarmSessionLog,
    data: ToolFields,
    kind: SwarmWorkerNode['kind'],
    actor: string,
    now: string,
    replay: boolean
  ): void {
    const id = firstText(data.id, data.conversationId, data.ConversationId, data.agentId);
    const byId = id ? log.byId(id) : undefined;
    const name = firstText(data.name, data.workerName, data.Role, data.TypeName, data.Name, byId?.name, id);
    if (!name) return;
    const byName = log.byName(name),
      old = id ? byId || (byName?.id === name ? byName : undefined) : byName;
    const raw = firstText(data.status, data.Status).toLowerCase();
    let status = statuses.has(raw) ? (raw as SwarmWorkerStatus) : old?.status || 'working';
    if (replay && status === 'working') status = old?.status || 'unconfirmed';
    const mode = firstText(
      data.workspaceMode,
      data.workspace_mode,
      data.workspace,
      data.Workspace,
      old?.workspaceMode
    );
    const worker: SwarmWorkerNode = {
      rowId: old?.rowId,
      id: id || old?.id || name,
      name,
      role: firstText(data.role, data.Role, data.Description, old?.role, '子任务执行者'),
      kind: old?.kind || kind,
      model: firstText(data.model, data.Model, old?.model, 'inherit'),
      status,
      workspaceMode: mode === 'share' || mode === 'branch' ? mode : 'inherit',
      channels: Array.isArray(data.channels)
        ? data.channels.filter((v): v is string => typeof v === 'string')
        : old?.channels || [],
      brief: firstText(
        data.brief,
        data.Prompt,
        data.task,
        data.prompt,
        data.Description,
        old?.brief,
        '未报告任务简报'
      ),
      currentAction:
        status === 'working' ? firstText(data.currentAction, old?.currentAction) || undefined : undefined,
      currentCallId: status === 'working' ? old?.currentCallId : undefined,
      resultSummary:
        firstText(data.resultSummary, status === 'failed' ? data.error : undefined, old?.resultSummary) ||
        undefined,
      parentWorkerName: firstText(data.parentWorkerName, old?.parentWorkerName, actor),
      startedAt: old?.startedAt || now,
      updatedAt: now,
    };
    log.put(worker);
    if (!old)
      this.event(
        log,
        kind === 'subagent' ? 'subagent_invoked' : 'worker_spawned',
        actor,
        '已创建子个体：' + name,
        'Created worker: ' + name,
        name,
        now
      );
  }
  private message(
    log: SwarmSessionLog,
    data: ToolFields,
    tool: string,
    input: ToolFields,
    actor: string,
    now: string,
    replay: boolean,
    occurrences: Map<string, number>
  ): void {
    const content = firstText(data.content, data.message, data.Message, data.text);
    if (!content) return;
    const sender = firstText(data.sender, actor),
      channel = firstText(data.channel, tool === 'send_message' ? 'subagent' : 'general');
    const official = typeof data.seq === 'number' && Number.isSafeInteger(data.seq);
    const message: SwarmBoardMessage = {
      seq: official ? Number(data.seq) : log.nextSeq(),
      sender,
      channel,
      content,
      mentions: swarmMessageMentions(content, data.mentions),
      isDoneReport: /^\s*\[done\]/i.test(content),
      isStallAlert: /\[stall(?:ed)?\]/i.test(content),
      timestamp: firstText(data.timestamp, now),
    };
    if (tool === 'read_board' && !official) {
      const timestamp = firstText(data.timestamp);
      const key = JSON.stringify([sender, channel, content, timestamp]);
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      if (log.alreadyRead(message, firstText(data.messageId, data.id), timestamp, occurrence)) return;
    }
    const added = log.addBoard(message, official, false, replay);
    if (!added && !replay) return;
    const recipient = firstText(data.Recipient, input.Recipient, input.target, input.to);
    const author = log.member(sender),
      destination = log.member(recipient);
    if (author && message.isDoneReport && !(replay && ['killed', 'failed', 'stopped'].includes(author.status)))
      log.put({
        ...author,
        status: 'completed',
        resultSummary: content,
        currentAction: undefined,
        currentCallId: undefined,
        updatedAt: message.timestamp,
      });
    else if (added && destination && !['killed', 'failed', 'stopped'].includes(destination.status)) {
      // Delivery confirms receipt, not that a finished or disconnected member started new work.
      log.put({
        ...destination,
        currentAction: destination.status === 'working' ? '收到消息：' + content.slice(0, 60) : undefined,
        updatedAt: message.timestamp,
      });
    }
    if (!added) return;
    this.event(
      log,
      message.isStallAlert ? 'stall_detected' : tool === 'send_message' ? 'subagent_messaged' : 'board_posted',
      sender,
      sender + '：' + content.slice(0, 100),
      sender + ': ' + content.slice(0, 100),
      recipient || undefined,
      message.timestamp
    );
  }
}

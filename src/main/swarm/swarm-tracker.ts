import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import type { SwarmActionEvent, SwarmTopologyState, SwarmWorkerNode, SwarmWorkerStatus } from '../../shared/swarm-contract';
import type { ClientStore } from '../storage/client-store';

type Data = Record<string, unknown>;
const SUPPORTED = [
  'swarm',
  'post_message',
  'read_board',
  'swarm_wait',
  'invoke_subagent',
  'send_message',
  'manage_subagents',
  'define_subagent',
  'run_workflow',
];

function object(value: unknown): Data {
  if (typeof value === 'string') {
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * 同时兼容标准工具名与真实 `agy acp` 的描述性 title / PascalCase 参数签名。
 */
function detectSwarmToolName(title: string | undefined, input: Data): string | undefined {
  // 工具名优先于描述性标题和参数特征。无法识别的普通工具返回 undefined，由调用方跳过。
  const explicitTool = text(input.toolName);
  if (explicitTool && SUPPORTED.includes(explicitTool)) return explicitTool;

  const rawTitle = (title || '').trim();
  const direct = SUPPORTED.find(
    (item) =>
      rawTitle === item ||
      rawTitle.startsWith(`${item} `) ||
      rawTitle.startsWith(`${item}(`) ||
      rawTitle.endsWith(`/${item}`) ||
      rawTitle.endsWith(`:${item}`)
  );
  if (direct) return direct;

  const lowerTitle = rawTitle.toLowerCase();
  // 真实 Antigravity invoke_subagent 参数：{ TypeName, Role, Prompt, Model?, Workspace? }
  if (
    (typeof input.TypeName === 'string' && (typeof input.Prompt === 'string' || typeof input.Role === 'string')) ||
    /\binvoke_subagent\b/.test(lowerTitle)
  ) {
    return 'invoke_subagent';
  }
  // 真实 Antigravity define_subagent 参数：{ Name, Description, SystemPrompt }
  if (
    (typeof input.Name === 'string' && typeof input.SystemPrompt === 'string') ||
    /\bdefine_subagent\b/.test(lowerTitle)
  ) {
    return 'define_subagent';
  }
  // 真实 Antigravity send_message 参数：{ Recipient, Message }
  if (
    (typeof input.Recipient === 'string' && typeof input.Message === 'string') ||
    /\bsend_message\b/.test(lowerTitle)
  ) {
    return 'send_message';
  }
  // 真实 Antigravity manage_subagents 参数：{ Action: 'list' | 'kill' | 'kill_all', ConversationIds? }
  if (
    (typeof input.Action === 'string' && ['list', 'kill', 'kill_all'].includes(input.Action)) ||
    /\bmanage_subagents\b/.test(lowerTitle)
  ) {
    return 'manage_subagents';
  }
  // 真实 Antigravity swarm 参数：{ action: 'status'|'models'|'add'|'model'|'kill'|'title', name?, brief?, title?, tasks?, n? }
  if (
    (typeof input.action === 'string' &&
      ['status', 'models', 'add', 'model', 'kill', 'title', 'spawn', 'create'].includes(input.action) &&
      ('brief' in input || 'title' in input || 'tasks' in input || 'n' in input || 'workers' in input || /\bswarm\b/.test(lowerTitle))) ||
    /\bswarm\b/.test(lowerTitle)
  ) {
    return 'swarm';
  }
  // 真实 Antigravity run_workflow 参数：{ Script | ScriptPath, Description? }
  if (
    typeof input.Script === 'string' ||
    typeof input.ScriptPath === 'string' ||
    /\brun_workflow\b/.test(lowerTitle)
  ) {
    return 'run_workflow';
  }

  return undefined;
}

export class SwarmTracker extends EventEmitter {
  private states = new Map<string, SwarmTopologyState>();
  private calls = new Map<string, { name: string; input: Data; applied: boolean }>();
  private filename = 'swarm-states.json';

  constructor(private store?: ClientStore) {
    super();
    this.setProfile();
  }
  setProfile(profileId?: string, owned?: ReadonlySet<string>): void {
    this.clear();
    this.filename = profileId ? 'swarm-states-' + profileId + '.json' : 'swarm-states.json';
    if (this.store) {
      const saved = this.store.readSessionRecords<SwarmTopologyState>(this.filename, 'swarm-states.json', owned);
      if (saved && typeof saved === 'object') {
        let purgedLegacyGuard = false;
        for (const [sid, st] of Object.entries(saved)) {
          if (st && typeof st === 'object' && Array.isArray(st.workers)) {
            if (st.swarmTitle === '演示蜂群（模拟数据）' && st.workers.every(w => ['demo-research', 'demo-ui'].includes(w.name))) continue;
            const copy = structuredClone(st);
            // 清理旧版误注入蜂群拓扑的合成 @approval-guard 假子个体及消息，避免与真实外部 API 代审混淆
            const origWorkers = copy.workers.length;
            const origMsgs = Array.isArray(copy.boardMessages) ? copy.boardMessages.length : 0;
            const origTimeline = Array.isArray(copy.actionTimeline) ? copy.actionTimeline.length : 0;
            copy.workers = copy.workers.filter((w) => w.name !== 'approval-guard');
            copy.boardMessages = (copy.boardMessages || []).filter((m) => m.sender !== 'approval-guard');
            copy.actionTimeline = (copy.actionTimeline || []).filter(
              (e) => e.actorName !== 'approval-guard' && e.targetName !== 'approval-guard'
            );
            if (
              copy.workers.length !== origWorkers ||
              copy.boardMessages.length !== origMsgs ||
              copy.actionTimeline.length !== origTimeline
            ) {
              purgedLegacyGuard = true;
              if (!copy.boardMessages.some((m) => m.channel === 'approval')) {
                copy.channels = (copy.channels || []).filter((c) => c !== 'approval');
              }
              if (
                copy.workers.length === 0 &&
                copy.boardMessages.length === 0 &&
                copy.actionTimeline.length === 0
              ) {
                continue;
              }
            }
            // 冷启动恢复时清理上一次进程退出前遗留的僵尸 working 状态
            for (const w of copy.workers) {
              if (w.status === 'working') {
                w.status = 'completed';
                w.currentAction = undefined;
                if (!w.resultSummary) w.resultSummary = '已完成（上次会话归档）';
              }
            }
            copy.isActive = copy.workers.length > 0 || copy.boardMessages.length > 0;
            copy.stats = {
              total: copy.workers.length,
              working: 0,
              waiting: copy.workers.filter((w) => w.status === 'waiting').length,
              completed: copy.workers.filter((w) => w.status === 'completed').length,
              killed: copy.workers.filter((w) => w.status === 'killed').length,
            };
            this.states.set(sid, copy);
          }
        }
        if (purgedLegacyGuard) {
          this.store.write(this.filename, Object.fromEntries(this.states));
        }
      }
    }
  }

  /**
   * 当后台子个体完成执行并触发主会话 Reactive Wakeup（或会话主动关闭）时，将此前运行中的子个体归档为已完成。
   */
  markWorkingSubagentsCompleted(sessionId: string, summaryText = '已完成任务并向主会话回报结果'): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const worker of state.workers) {
      if (worker.status === 'working') {
        worker.status = 'completed';
        worker.currentAction = undefined;
        if (!worker.resultSummary) {
          worker.resultSummary = summaryText;
        }
        worker.updatedAt = now;
        state.actionTimeline.push({
          id: randomUUID(),
          sessionId,
          actorName: worker.name,
          eventType: 'worker_status_changed',
          summaryZh: `@${worker.name} 已完成并向协调者汇报结果`,
          summaryEn: `@${worker.name} completed and reported back`,
          timestamp: now,
        });
        changed = true;
      }
    }
    if (changed) {
      this.save(state);
    }
  }

  remove(id: string): void {
    for (const key of this.calls.keys()) if (key.startsWith(id + '\0')) this.calls.delete(key);
    this.states.delete(id);
    this.store?.write(this.filename, Object.fromEntries(this.states));
  }
  clear(): void {
    this.states.clear();
    this.calls.clear();
  }
  getState(sessionId: string): SwarmTopologyState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        isActive: false,
        swarmTitle: '',
        channels: [],
        workers: [],
        boardMessages: [],
        actionTimeline: [],
        stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 },
        updatedAt: new Date().toISOString(),
      };
      this.states.set(sessionId, state);
    }
    return structuredClone(state);
  }

  /** 把同一工具的开始与完成通知关联起来。已消费的结果保存在调用状态中，重复通知不会再次创建成员或消息。 */
  consume(sessionId: string, update: AcpSessionUpdatePayload): void {
    if (!update.toolCallId || !['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
    const key = `${sessionId}\0${update.toolCallId}`;
    const previous = this.calls.get(key);
    const input =
      update.rawInput === undefined
        ? previous?.input || {}
        : { ...(previous?.input || {}), ...object(update.rawInput) };
    const name = previous?.name || detectSwarmToolName(update.name || update.title, input);
    if (!name || !SUPPORTED.includes(name)) return;

    const call = { name, input, applied: previous?.applied || false };
    this.calls.set(key, call);

    // 仅有请求时展示动作，待工具完成确认后落盘真实子个体状态（兼容单测断言与真实 ACP 返回）
    if (!call.applied && update.status === 'completed') {
      call.applied = true;
      const rawOut =
        typeof update.rawOutput === 'string'
          ? (() => {
              try {
                return object(JSON.parse(update.rawOutput));
              } catch {
                const convMatch = /conversationId["':=\s]+([a-zA-Z0-9_-]{6,})/i.exec(update.rawOutput);
                return convMatch ? { conversationId: convMatch[1], textOutput: update.rawOutput } : { textOutput: update.rawOutput };
              }
            })()
          : object(update.rawOutput);
      this.ingest(sessionId, name, input, rawOut);
    } else if (!call.applied && update.status !== 'failed') {
      const state = this.getState(sessionId);
      state.isActive = true;
      const actor = state.workers.find((worker) => worker.name === text(input.sender, '协调者'));
      if (actor) actor.currentAction = `正在执行 ${name}`;
      this.save(state);
    }
    if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value!);
  }

  ingest(sessionId: string, toolName: string, input: Data, output: Data = {}): SwarmTopologyState {
    const state = this.getState(sessionId);
    const now = new Date().toISOString();
    state.isActive = true;
    const actorName = text(input.sender, text(input.actor, '协调者'));

    const event = (type: SwarmActionEvent['eventType'], zh: string, en: string, targetName?: string) =>
      state.actionTimeline.push({
        id: randomUUID(),
        sessionId,
        actorName,
        targetName,
        eventType: type,
        summaryZh: zh,
        summaryEn: en,
        timestamp: now,
      });

    const upsert = (data: Data, kind: SwarmWorkerNode['kind']) => {
      const idVal = text(data.id, text(data.conversationId, text(data.agentId)));
      const name = text(
        data.name,
        text(
          data.workerName,
          text(
            data.Role,
            text(data.TypeName, text(data.Name, idVal))
          )
        )
      );
      if (!name) return;

      // 首次事件可能只有成员名称，后续结果才带稳定 ID。
      // 按两者查找已有节点，补全角色与状态，保留最初开始时间。
      const existing = state.workers.find((worker) => worker.name === name || (idVal && worker.id === idVal));
      const rawStatus = text(data.status);
      const status: SwarmWorkerStatus = ['working', 'waiting', 'stopped', 'killed', 'completed'].includes(rawStatus)
        ? (rawStatus as SwarmWorkerStatus)
        : existing?.status || 'working';
      const workspace = text(
        data.workspaceMode,
        text(data.workspace_mode, text(data.workspace, text(data.Workspace, existing?.workspaceMode || 'inherit')))
      );
      const worker: SwarmWorkerNode = {
        id: idVal || existing?.id || name,
        name,
        role: text(data.role, text(data.Role, text(data.Description, existing?.role || '子任务执行者'))),
        kind,
        model: text(data.model, text(data.Model, existing?.model || 'inherit')),
        status,
        workspaceMode: ['inherit', 'share', 'branch'].includes(workspace)
          ? (workspace as SwarmWorkerNode['workspaceMode'])
          : 'inherit',
        channels: Array.isArray(data.channels)
          ? (data.channels.filter((value) => typeof value === 'string') as string[])
          : existing?.channels || [],
        brief: text(
          data.brief,
          text(
            data.Prompt,
            text(data.task, text(data.prompt, text(data.Description, existing?.brief || '未报告任务简报')))
          )
        ),
        currentAction: text(data.currentAction, existing?.currentAction),
        resultSummary: text(data.resultSummary, existing?.resultSummary),
        parentWorkerName: text(data.parentWorkerName, actorName),
        startedAt: existing?.startedAt || now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, worker);
      else state.workers.push(worker);
      if (!existing) {
        event(
          kind === 'subagent' ? 'subagent_invoked' : 'worker_spawned',
          `已创建子个体：${name}`,
          `Created worker: ${name}`,
          name
        );
      }
    };

    if (toolName === 'define_subagent') {
      const defName = text(input.Name, text(input.name));
      if (defName) {
        event('subagent_invoked', `已定义专属子个体类型：${defName}`, `Defined subagent type: ${defName}`, defName);
      }
    }

    if (toolName === 'run_workflow') {
      const wfDesc = text(input.Description, text(input.ScriptPath, 'Python 多智能体编排工作流'));
      upsert(
        {
          name: 'workflow-runner',
          role: 'Workflow 编排引擎',
          model: 'inherit',
          brief: wfDesc,
          status: 'working',
        },
        'subagent'
      );
    }

    if (toolName === 'swarm' || toolName === 'invoke_subagent') {
      const title = text(output.title, text(input.title));
      if (title && title !== state.swarmTitle) {
        state.swarmTitle = title;
        event('swarm_titled', `蜂群主题：${title}`, `Swarm title: ${title}`);
      }
      const workers = Array.isArray(output.workers)
        ? output.workers
        : Array.isArray(input.workers)
          ? input.workers
          : Array.isArray(input.agents)
            ? input.agents
            : [];
      for (const worker of workers) {
        upsert(object(worker), toolName === 'invoke_subagent' ? 'subagent' : 'swarm-worker');
      }

      const action = text(input.action, text(input.command));
      if (!workers.length && (toolName === 'invoke_subagent' || ['spawn', 'create', 'add'].includes(action))) {
        const tasks = Array.isArray(input.tasks) ? input.tasks : [];
        const copies = typeof input.n === 'number' && input.n > 1 ? Math.min(16, Math.floor(input.n)) : 0;
        const baseName = text(input.name, 'worker');
        if (toolName === 'swarm' && tasks.length > 0) {
          tasks.forEach((slice, idx) => {
            upsert(
              {
                ...input,
                ...output,
                name: `${baseName}-${idx + 1}`,
                brief: `${text(input.brief)} · ${String(slice)}`.trim(),
              },
              'swarm-worker'
            );
          });
        } else if (toolName === 'swarm' && copies > 1) {
          for (let idx = 1; idx <= copies; idx++) {
            upsert({ ...input, ...output, name: `${baseName}-${idx}` }, 'swarm-worker');
          }
        } else {
          upsert({ ...input, ...output }, toolName === 'invoke_subagent' ? 'subagent' : 'swarm-worker');
        }
      }
      if (toolName === 'swarm' && action === 'model') {
        const target = text(input.name);
        const nextModel = text(input.model);
        const found = state.workers.find((w) => w.name === target);
        if (found && nextModel) {
          found.model = nextModel;
          found.updatedAt = now;
        }
      }
    }

    if (Array.isArray(output.workers)) {
      for (const worker of output.workers) upsert(object(worker), 'swarm-worker');
    }

    // 读取消息板返回一批已有消息。主动发信可由当前输入和输出合成单条记录。两条路径共用下方去重逻辑。
    if (toolName === 'post_message' || toolName === 'read_board' || toolName === 'send_message') {
      const messages = Array.isArray(output.messages)
        ? output.messages
        : toolName === 'read_board'
          ? []
          : [{ ...input, ...output }];
      for (const raw of messages) {
        const data = object(raw);
        const content = text(data.content, text(data.message, text(data.Message, text(data.text))));
        if (!content) continue;
        const sender = text(data.sender, actorName);
        const channel = text(data.channel, toolName === 'send_message' ? 'subagent' : 'general');
        const seq = typeof data.seq === 'number' ? data.seq : (state.boardMessages.at(-1)?.seq || 0) + 1;
        // 序号只在发送者和频道的上下文中判重，避免读取消息板时再次展示同一条发言。
        if (
          state.boardMessages.some(
            (message) => message.seq === seq && message.sender === sender && message.channel === channel
          )
        ) {
          continue;
        }
        const mentions = [...content.matchAll(/@([\w-]+)/g)].map((match) => match[1]);
        const done = /^\s*\[done\]/i.test(content);
        const stalled = /\[stall(?:ed)?\]/i.test(content);
        state.boardMessages.push({
          seq,
          sender,
          channel,
          content,
          mentions,
          isDoneReport: done,
          isStallAlert: stalled,
          timestamp: text(data.timestamp, now),
        });
        if (!state.channels.includes(channel)) state.channels.push(channel);
        const recipient = text(input.Recipient, text(input.target, text(input.to)));
        const worker = state.workers.find(
          (item) => item.name === sender || (recipient && (item.id === recipient || item.name === recipient))
        );
        if (worker && done && itemMatchesSender(worker, sender)) {
          worker.status = 'completed';
          worker.resultSummary = content;
          worker.updatedAt = now;
        } else if (worker && recipient && (worker.id === recipient || worker.name === recipient)) {
          worker.status = 'working';
          worker.currentAction = `收到消息：${content.slice(0, 60)}`;
          worker.updatedAt = now;
        }
        event(
          stalled ? 'stall_detected' : toolName === 'send_message' ? 'subagent_messaged' : 'board_posted',
          `${sender}：${content.slice(0, 100)}`,
          `${sender}: ${content.slice(0, 100)}`,
          recipient || undefined
        );
      }
    }

    if (toolName === 'manage_subagents' || toolName === 'swarm' || toolName === 'swarm_wait') {
      const action = text(input.action, text(input.Action, text(input.command))).toLowerCase();
      if (action === 'kill_all') {
        for (const w of state.workers) {
          if (w.kind === 'subagent') {
            w.status = 'killed';
            w.updatedAt = now;
          }
        }
        event('worker_killed', '已终止全部子个体', 'Killed all subagents');
      } else {
        const targets: string[] = [];
        const single = text(input.target, text(input.name, text(input.agentId)));
        if (single) targets.push(single);
        if (Array.isArray(input.ConversationIds)) {
          for (const cid of input.ConversationIds) if (typeof cid === 'string') targets.push(cid);
        }
        for (const target of targets) {
          const worker = state.workers.find((item) => item.name === target || item.id === target);
          if (worker && ['kill', 'stop', 'pause', 'resume', 'wait'].includes(action)) {
            worker.status =
              action === 'kill'
                ? 'killed'
                : action === 'resume'
                  ? 'working'
                  : action === 'wait'
                    ? 'waiting'
                    : 'stopped';
            worker.updatedAt = now;
            event(
              action === 'kill' ? 'worker_killed' : 'worker_status_changed',
              `${worker.name} 状态已更新`,
              `${worker.name} status updated`,
              worker.name
            );
          }
        }
      }
    }

    this.save(state);
    return this.getState(sessionId);
  }

  /** 裁剪保留的节点、消息和活动记录，再根据裁剪后的节点重算状态计数，保证列表和统计来自同一份快照。 */
  private save(state: SwarmTopologyState): void {
    state.workers = state.workers.slice(-100);
    state.boardMessages = state.boardMessages.slice(-500);
    state.actionTimeline = state.actionTimeline.slice(-500);
    state.stats = {
      total: state.workers.length,
      working: state.workers.filter((w) => w.status === 'working').length,
      waiting: state.workers.filter((w) => w.status === 'waiting').length,
      completed: state.workers.filter((w) => w.status === 'completed').length,
      killed: state.workers.filter((w) => w.status === 'killed').length,
    };
    state.updatedAt = new Date().toISOString();
    this.states.set(state.sessionId, state);
    if (this.store) {
      try {
        const persisted = Object.fromEntries([...this.states.entries()].slice(-200));
        this.store.write(this.filename, persisted);
      } catch {
        /* 忽略只读环境保存异常 */
      }
    }
    this.emit('updated', structuredClone(state));
  }
}

function itemMatchesSender(worker: SwarmWorkerNode, sender: string): boolean {
  return worker.name === sender || worker.id === sender;
}

import { DatabaseSync } from 'node:sqlite';
import {
  swarmMessageMentions, type SwarmActionEvent, type SwarmBoardMessage, type SwarmTopologyState,
  type SwarmWorkerNode,
} from '../../shared/swarm-contract';
import type { ClientStore } from '../storage/client-store';
import { SwarmSessionLog } from './swarm-session-log';
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter(Boolean) : []);
const workerStatuses = new Set([
  'working',
  'waiting',
  'stopped',
  'killed',
  'completed',
  'unconfirmed',
  'failed',
]);
const legacyCompletions = new Set([
  '已完成（上次会话归档）',
  '已完成任务并向主会话回报结果',
  '用户已停止执行',
  '会话已关闭',
]);

function legacyRecords(store?: ClientStore, profile?: string, owned?: ReadonlySet<string>): Record<string, SwarmTopologyState> {
    if (!store) return {};
    const name = profile ? 'swarm-states-' + profile + '.json' : 'swarm-states.json';
    const scoped = store.read<Record<string, SwarmTopologyState>>(name, {}) || {};
    if (!profile || !owned) return scoped;
    const shared = store.read<Record<string, SwarmTopologyState>>('swarm-states.json', {}) || {};
    const ownedSharedIds = Object.keys(shared).filter((id) => owned.has(id));
    if (!ownedSharedIds.length) return scoped;

    // The oldest file had no profile column. A reused session ID cannot identify an owner.
    const profiles = store.read<{ profiles?: { profileId: string }[] }>('profiles.json', {});
    const peers = new Set([
      'default',
      ...list<{ profileId: string }>(profiles?.profiles).map((item) => item.profileId),
    ]);
    const ambiguous = new Set(list<string>(store.read('swarm-legacy-ambiguous-v2.json', [])));
    const previousSize = ambiguous.size;
    for (const peer of peers) {
      if (peer === profile || !/^[a-z0-9-]+$/i.test(peer)) continue;
      const ledger = store.read<Record<string, unknown>>('owned-sessions-' + peer + '.json', {});
      if (ledger) for (const id of ownedSharedIds) if (Object.hasOwn(ledger, id)) ambiguous.add(id);
    }
    if (ambiguous.size !== previousSize) store.write('swarm-legacy-ambiguous-v2.json', [...ambiguous]);
    const combined = { ...scoped };
    for (const id of ownedSharedIds) {
      if (ambiguous.has(id) || !shared[id]) continue;
      const older = shared[id],
        newer = scoped[id];
      if (!newer) {
        combined[id] = older;
        continue;
      }
      const merge = <T>(first: T[] | undefined, second: T[] | undefined, key: (value: T) => unknown) => [
        ...new Map([...list<T>(first), ...list<T>(second)].map((value) => [key(value), value])).values(),
      ];
      combined[id] = {
        ...older,
        ...newer,
        workers: merge(older.workers, newer.workers, (worker) => worker.id),
        boardMessages: merge(older.boardMessages, newer.boardMessages, (message) =>
          JSON.stringify([message.sender, message.channel, message.seq])
        ),
        actionTimeline: merge(older.actionTimeline, newer.actionTimeline, (event) => event.id),
        channels: [...new Set([...list<string>(older.channels), ...list<string>(newer.channels)])],
      };
    }
    return combined;
  }
export function importLegacy(database: DatabaseSync, store?: ClientStore, profile?: string, owned?: ReadonlySet<string>): void {
    if (!store) return;
    const records = legacyRecords(store, profile, owned);
    for (const [sessionId, state] of Object.entries(records)) {
      if (
        !state ||
        (!Array.isArray(state.workers) &&
          !Array.isArray(state.boardMessages) &&
          !Array.isArray(state.actionTimeline))
      )
        continue;
      if (owned && !owned.has(sessionId)) continue;
      const workers = list<SwarmWorkerNode>(state.workers).filter(
        (worker) =>
          typeof worker.name === 'string' && typeof worker.id === 'string' && typeof worker.brief === 'string'
      );
      if (
        state.swarmTitle === '演示蜂群（模拟数据）' &&
        workers.every((worker) => ['demo-research', 'demo-ui'].includes(worker.name))
      )
        continue;
      const guard = (worker: SwarmWorkerNode) =>
        worker.name === 'approval-guard' &&
        worker.model === 'local-ast-guard' &&
        typeof worker.role === 'string' &&
        worker.role.includes('代审');
      const fake =
        workers.some(guard) && !workers.some((worker) => worker.name === 'approval-guard' && !guard(worker));
      const log = new SwarmSessionLog(database, sessionId);
      log.ensure();
      if (typeof state.swarmTitle === 'string') log.setTitle(state.swarmTitle);
      for (const worker of workers.filter((worker) => !guard(worker))) {
        const inferred = worker.status === 'completed' && legacyCompletions.has(worker.resultSummary || '');
        const status =
          inferred || !workerStatuses.has(worker.status) || worker.status === 'working'
            ? 'unconfirmed'
            : worker.status;
        const existing = log.byId(worker.id);
        log.put({
          ...worker,
          rowId: existing?.rowId,
          status,
          currentAction: undefined,
          currentCallId: undefined,
          role: typeof worker.role === 'string' ? worker.role : worker.name,
          model: typeof worker.model === 'string' ? worker.model : 'inherit',
          channels: list<string>(worker.channels).filter((s) => typeof s === 'string'),
          resultSummary:
            inferred || typeof worker.resultSummary !== 'string' ? undefined : worker.resultSummary,
        });
      }
      let hasRecords = !!log.changedWorkers.size || !!state.swarmTitle;
      for (const message of list<SwarmBoardMessage>(state.boardMessages)) {
        if (
          typeof message.sender !== 'string' ||
          typeof message.channel !== 'string' ||
          typeof message.content !== 'string' ||
          (fake && message.sender === 'approval-guard' && message.channel === 'approval')
        )
          continue;
        log.addBoard(
          {
            ...message,
            seq: Number.isSafeInteger(message.seq) ? message.seq : log.nextSeq(),
            mentions: swarmMessageMentions(message.content, message.mentions),
            timestamp: typeof message.timestamp === 'string' ? message.timestamp : '',
          },
          false,
          true
        );
        hasRecords = true;
      }
      for (const event of list<SwarmActionEvent>(state.actionTimeline)) {
        if (
          typeof event.id !== 'string' ||
          typeof event.summaryZh !== 'string' ||
          typeof event.summaryEn !== 'string' ||
          (fake && [event.actorName, event.targetName].includes('approval-guard'))
        )
          continue;
        const inferred =
          event.eventType === 'worker_status_changed' &&
          event.summaryZh.endsWith('已完成并向协调者汇报结果') &&
          log.member(event.actorName)?.status === 'unconfirmed';
        log.addEvent(
          {
            ...event,
            sessionId: sessionId,
            timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
            ...(inferred ? { summaryZh: '成员状态待确认', summaryEn: 'Worker status unconfirmed' } : {}),
          },
          true
        );
        hasRecords = true;
      }
      for (const channel of list<string>(state.channels))
        if (typeof channel === 'string' && (!fake || channel !== 'approval'))
          database.prepare('INSERT OR IGNORE INTO channels VALUES (?,?)').run(sessionId, channel);
      if (hasRecords)
        log.touch((typeof state.updatedAt === 'string' && state.updatedAt) || new Date().toISOString());
    }
  }

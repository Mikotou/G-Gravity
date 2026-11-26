/**
 * 蜂群模式（Swarm Mode）与多子智能体（Subagents）实时态势感知契约
 *
 * 适配目标：
 * 让用户在客户端中直观看到蜂群内其他子个体的角色、模型、工作空间隔离方式、
 * 当前状态（工作中/休眠待命/已暂停/已销毁/已完成）、专属任务简报（Brief）、
 * 实时动作轨迹与共享消息板（Message Board）协作流。
 */

export type SwarmWorkerStatus =
  | 'working'
  | 'waiting'
  | 'stopped'
  | 'killed'
  | 'unconfirmed'
  | 'failed'
  | 'completed';

export type SwarmWorkspaceMode = 'inherit' | 'share' | 'branch';

export type SwarmMemberKind =
  | 'coordinator'
  | 'swarm-worker'
  | 'verifier'
  | 'narrator'
  | 'monitor'
  | 'subagent';

export interface SwarmWorkerNode {
  /** Stable local row even when a provisional display name acquires its official ID. */
  rowId?: number;
  id: string;
  name: string;
  role: string;
  kind: SwarmMemberKind;
  model: string;
  status: SwarmWorkerStatus;
  workspaceMode: SwarmWorkspaceMode;
  channels: string[];
  /** 派发给该子个体的任务简报 */
  brief: string;
  /** 该子个体当前正在执行的动作或工具描述 */
  currentAction?: string;
  currentCallId?: string;
  /** 完成时的 `[done]` 摘要汇报 */
  resultSummary?: string;
  parentWorkerName?: string;
  startedAt: string;
  updatedAt: string;
}

/** 消息板条目保留频道、发送者和序号供去重。完成报告与停滞提示各有标记，渲染层据此筛选。 */
export interface SwarmBoardMessage {
  rowId?: number;
  seq: number;
  sender: string;
  mentions: string[];
  channel: string;
  content: string;
  isDoneReport: boolean;
  isStallAlert: boolean;
  timestamp: string;
}

export function swarmMessageMentions(content: string, reported?: unknown): string[] {
  const names = new Set<string>();
  if (Array.isArray(reported)) {
    for (const item of reported) {
      const name = typeof item === 'string' ? item.trim().replace(/^@/, '').trim() : '';
      if (name) names.add(name);
    }
  }
  for (const match of content.matchAll(/@([\p{L}\p{N}_-]+)/gu)) names.add(match[1]);
  return [...names];
}

export interface SwarmActionEvent {
  id: string;
  sessionId: string;
  actorName: string;
  targetName?: string;
  eventType:
    | 'swarm_titled'
    | 'worker_spawned'
    | 'worker_status_changed'
    | 'board_posted'
    | 'model_switched'
    | 'worker_killed'
    | 'subagent_invoked'
    | 'subagent_messaged'
    | 'stall_detected'
    | 'tool_failed'
    | 'workflow_completed';
  summaryZh: string;
  summaryEn: string;
  timestamp: string;
}

/** 每个会话独立维护一份拓扑。成员是当前状态，消息和时间线保留过程，stats 为这份成员列表的计数。 */
export interface SwarmTopologyState {
  sessionId: string;
  isActive: boolean;
  swarmTitle: string;
  channels: string[];
  workers: SwarmWorkerNode[];
  boardMessages: SwarmBoardMessage[];
  actionTimeline: SwarmActionEvent[];
  stats: {
    total: number;
    working: number;
    waiting: number;
    completed: number;
    killed: number;
  };
  updatedAt: string;
  earlier?: SwarmHistoryCursor;
  /** Updated members outside the recent page can also be visible in an expanded inspector. */
  changedWorkers?: SwarmWorkerNode[];
  refreshHistoryWorkers?: boolean;
  historyUnavailable?: boolean;
}

export interface SwarmHistoryCursor {
  workers: number | null;
  boardMessages: number | null;
  actionTimeline: number | null;
}

export const SWARM_PAGE_SIZE = 48;

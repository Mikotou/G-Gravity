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
  /** 完成时的 `[done]` 摘要汇报 */
  resultSummary?: string;
  parentWorkerName?: string;
  startedAt: string;
  updatedAt: string;
}

/** 消息板条目保留频道、发送者和序号供去重。完成报告与停滞提示各有标记，渲染层据此筛选。 */
export interface SwarmBoardMessage {
  seq: number;
  sender: string;
  mentions: string[];
  channel: string;
  content: string;
  isDoneReport: boolean;
  isStallAlert: boolean;
  timestamp: string;
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
    | 'stall_detected';
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
}

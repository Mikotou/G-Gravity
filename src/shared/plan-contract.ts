/**
 * Gravity v0.3.6 — 会话 Plan 执行进度与私有文档（summary / content 分视图）契约
 *
 * 合规与隔离约束：
 * 1. 自动 Plan 文档仅只读当前 Profile 自有会话的 `brain/<sessionId>/implementation_plan.md`，
 *    不再扫描工作区引用（`workspace-reference`）或历史归档；
 * 2. 物理文件硬读上限 131,072 字节（128 KiB），超出在读正文前硬拒绝；
 * 3. `summary` 与 `content` 视图拥有独立修订号，摘要响应不携带原文正文。
 */

import type { SessionOwner } from './session-owner';

export const PLAN_ARTIFACT_FILENAME = 'implementation_plan.md';
/** 128 KiB 物理硬读上限（超过此字节数的文件在读取正文前直接拒绝） */
export const PLAN_ARTIFACT_MAX_BYTES = 131_072;

export type SessionTodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'unknown';

export interface SessionTodoItem {
  id: string;
  content: string;
  status: SessionTodoStatus;
  /** 遇到非标准状态值时保留的原始状态文案（截断至 ≤64 码点） */
  rawStatus?: string;
  priority?: 'high' | 'medium' | 'low';
}

export type SessionPlanState = 'unreceived' | 'empty' | 'present';

export interface SessionPlanSummary {
  state: SessionPlanState;
  revision: number;
  truncated: boolean;
  totalCount: number;
  completedCount: number;
  failedCount: number;
}

export interface PlanArtifactOwner extends SessionOwner {
  revision?: number;
  summaryRevision?: number;
  contentRevision?: number;
}

export type PlanArtifactView = 'summary' | 'content';

export interface PlanOutlineSection {
  /** 稳定锚点/节 ID */
  id: string;
  /** 章节标题 */
  heading: string;
  /** Markdown 标题层级（1–6） */
  level: number;
  /** 本地规则提取的精炼单句摘要（跳过 Mermaid/围栏/表格/front matter） */
  summary: string;
  /** 可选精简要点（最多若干条，纯展示中性条目，非执行待办） */
  bullets?: string[];
}

export interface PlanOutline {
  title: string;
  /** 1–2 行目标概述 */
  goal?: string;
  sections: PlanOutlineSection[];
  sectionCount: number;
  truncated?: boolean;
}

export interface GetSessionPlanArtifactInput {
  profileId: string;
  sessionId: string;
  /** 视图模式：缺省或 `'summary'` 仅返回本地解析摘要，不传正文；`'content'` 按需返回原文 */
  view?: PlanArtifactView;
  knownRevision?: number;
}

export interface PlanArtifactSnapshot {
  status: 'missing' | 'unavailable' | 'ready' | 'unchanged';
  view?: PlanArtifactView;
  owner: SessionOwner;
  /** 归属实例代次（随 owner 透传，供渲染层丢弃迟到响应） */
  epoch?: number;
  /** 当前所请求视图对应的修订号（兼容既有调用方） */
  revision: number;
  /** 摘要视图独立修订号 */
  summaryRevision?: number;
  /** 原文视图独立修订号 */
  contentRevision?: number;
  /** 仅允许当前会话自有 `brain/<sessionId>/implementation_plan.md` */
  source?: 'brain-artifact';
  filePath?: string;
  /** 仅在 `view: 'summary'` 且 `status: 'ready'` 时返回 */
  outline?: PlanOutline;
  /** 仅在 `view: 'content'` 且 `status: 'ready'` 时返回；`summary` 视图严禁携带 */
  content?: string;
  truncated?: boolean;
  reason?: string;
  updatedAt?: string;
}

export interface PlanArtifactChangedEvent {
  profileId: string;
  sessionId: string;
  epoch?: number;
  /** 兼容主修订号（通常等于最新变更视图的修订号） */
  revision: number;
  summaryRevision?: number;
  contentRevision?: number;
}

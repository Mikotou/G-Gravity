/**
 * v0.3.6 Plan 检视器纯函数（无副作用）：四态判定、时间线分组、当前步骤与旧桥接正文 → 概要回退。
 *
 * 四态：
 * ① `empty`        —— 无执行进度、无计划文档：纯空态（不出现文件栏或文件名）；
 * ①′ `unavailable`  —— 计划文档不可读：仅一行原因，不出现文件名；
 * ② `outline`      —— 仅有计划文档：目标 + 编号章节（中性圆点，绝不伪造百分比或「待执行」）；
 * ③ `execution`    —— 有结构化待办：摘要条 + 6 态时间线，文档收成底部一行；
 * ④ `cleared`      —— `plan.state === 'empty'`：中性提示，绝不复活旧消息待办。
 */
import type {
  ChatMessageItem,
  PlanArtifactSnapshot,
  PlanOutline,
  PlanOutlineSection,
  SessionPlanSummary,
  SessionTodoItem,
  SessionTodoStatus,
} from '@shared';

export type PlanViewKind = 'empty' | 'unavailable' | 'outline' | 'execution' | 'cleared';

export interface PlanProgress {
  done: number;
  total: number;
  failed: number;
  truncated: boolean;
  /** 正在执行（或下一步待执行）的条目文本 */
  current?: string;
}

export const PLAN_TODO_STATUSES: readonly SessionTodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'skipped',
  'failed',
  'unknown',
];

export function normalizeTodoStatus(status: unknown): SessionTodoStatus {
  return PLAN_TODO_STATUSES.includes(status as SessionTodoStatus) ? (status as SessionTodoStatus) : 'unknown';
}

/**
 * 权威待办解析：存在 `plan` 摘要时只认快照（`empty` / `unreceived` 绝不回溯旧消息）；
 * 仅当旧快照缺省 `plan` 时，才从最近的消息向前回溯已有的待办列表（历史兼容）。
 */
export function resolveAuthoritativeTodos(
  plan: SessionPlanSummary | undefined,
  snapshotTodos: readonly SessionTodoItem[] | undefined,
  messages: readonly ChatMessageItem[]
): SessionTodoItem[] {
  if (plan) return plan.state === 'present' ? [...(snapshotTodos ?? [])] : [];
  if (snapshotTodos && snapshotTodos.length > 0) return [...snapshotTodos];
  for (let i = messages.length - 1; i >= 0; i--) {
    const todos = messages[i].todos;
    if (todos && todos.length > 0) return [...todos];
  }
  return [];
}

export function currentPlanStep(todos: readonly SessionTodoItem[]): SessionTodoItem | undefined {
  return todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
}

export function computePlanProgress(
  plan: SessionPlanSummary | undefined,
  todos: readonly SessionTodoItem[]
): PlanProgress {
  const present = plan?.state === 'present';
  const done = present ? plan!.completedCount : todos.filter((t) => t.status === 'completed').length;
  const total = present ? Math.max(plan!.totalCount, todos.length) : todos.length;
  const failed = present ? plan!.failedCount : todos.filter((t) => t.status === 'failed').length;
  return {
    done: Math.max(0, Math.min(done, total)),
    total,
    failed: Math.max(0, failed),
    truncated: Boolean(plan?.truncated),
    current: currentPlanStep(todos)?.content,
  };
}

export function derivePlanViewKind(input: {
  plan: SessionPlanSummary | undefined;
  todos: readonly SessionTodoItem[];
  artifactStatus?: PlanArtifactSnapshot['status'] | 'loading' | 'error';
  hasOutline: boolean;
}): PlanViewKind {
  if (input.todos.length > 0) return 'execution';
  if (input.plan?.state === 'empty') return 'cleared';
  if (input.hasOutline) return 'outline';
  if (input.artifactStatus === 'unavailable' || input.artifactStatus === 'error') return 'unavailable';
  return 'empty';
}

export type PlanTimelineEntry =
  | { kind: 'item'; item: SessionTodoItem }
  | { kind: 'collapsed'; key: string; items: SessionTodoItem[] };

/** ≥ `minRun` 条连续「已完成」自动折叠为「已完成 N 步」组。 */
export function groupPlanTimeline(todos: readonly SessionTodoItem[], minRun = 3): PlanTimelineEntry[] {
  const out: PlanTimelineEntry[] = [];
  let run: SessionTodoItem[] = [];
  const flush = () => {
    if (run.length >= minRun) out.push({ kind: 'collapsed', key: `done-${run[0].id}`, items: run });
    else for (const item of run) out.push({ kind: 'item', item });
    run = [];
  };
  for (const item of todos) {
    if (normalizeTodoStatus(item.status) === 'completed') run.push(item);
    else {
      flush();
      out.push({ kind: 'item', item });
    }
  }
  flush();
  return out;
}

/** 消息流中仅最新一条含待办的助手消息显示 Plan chip。 */
export function latestTodoMessageId(messages: readonly ChatMessageItem[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.todos && m.todos.length > 0) return m.id;
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * 旧桥接回退：摘要请求返回正文但无 outline 时，本地提取概要（跳过 front matter / 围栏 / 表格 / 引用标记）。
 * ------------------------------------------------------------------------- */

function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string, max = 140): string {
  const plain = plainInline(text);
  const m = /^(.+?[。！？.!?])(?:\s|$)/.exec(plain);
  const s = m ? m[1] : plain;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function outlineFromMarkdown(content: string, maxSections = 24): PlanOutline {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  let title = '';
  let goal = '';
  const sections: PlanOutlineSection[] = [];
  let current: PlanOutlineSection | null = null;
  let inFence = false;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(' ');
    paragraph = [];
    if (current && !current.summary) current.summary = firstSentence(text);
    else if (!current && !goal) goal = firstSentence(text, 220);
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = plainInline(heading[2]);
      if (level === 1 && !title) {
        title = text;
        continue;
      }
      if (level <= 2 || !sections.length) {
        current = { id: `s${sections.length + 1}`, heading: text, level, summary: '' };
        sections.push(current);
      }
      continue;
    }
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*>\s*\[!/.test(line)) {
      flushParagraph();
      continue;
    }
    paragraph.push(line.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, '').replace(/^\s*>\s?/, ''));
  }
  flushParagraph();
  return {
    title,
    ...(goal ? { goal } : {}),
    sections: sections.slice(0, maxSections),
    sectionCount: sections.length,
    ...(sections.length > maxSections ? { truncated: true } : {}),
  };
}

/** Mermaid 围栏行数（供原文抽屉折叠标签「流程图（N 行）」）。 */
export function countFenceLines(body: readonly string[]): number {
  return body.filter((l) => l.trim().length > 0).length;
}

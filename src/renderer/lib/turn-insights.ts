import { isToolCallFailure, type ChatMessageItem, type SemanticToolCallCard } from '@shared';

/**
 * 回合洞察（纯函数，无副作用）：
 * 把一轮对话里零散的工具调用归类、合并、汇总，让用户一眼看到「改了什么、跑了什么、哪里失败」。
 */

export type ToolCategory = 'explore' | 'edit' | 'exec' | 'web' | 'agent' | 'other';

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write']);
const EXEC_TOOLS = new Set(['Bash']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const AGENT_TOOLS = new Set(['Swarm', 'Subagent']);

export function classifyTool(canonicalName: string): ToolCategory {
  if (EXPLORE_TOOLS.has(canonicalName)) return 'explore';
  if (EDIT_TOOLS.has(canonicalName)) return 'edit';
  if (EXEC_TOOLS.has(canonicalName)) return 'exec';
  if (WEB_TOOLS.has(canonicalName)) return 'web';
  if (AGENT_TOOLS.has(canonicalName)) return 'agent';
  return 'other';
}

export function isToolActive(tool: SemanticToolCallCard): boolean {
  return tool.status === 'pending' || tool.status === 'running';
}

export type ToolSegment =
  | { kind: 'single'; key: string; tool: SemanticToolCallCard }
  | { kind: 'explore-group'; key: string; tools: SemanticToolCallCard[] };

/**
 * 把连续 ≥2 个「已成功完成的只读探索类工具」（Read / Grep / Glob）合并为一行；
 * 编辑、命令、失败或仍在运行的工具始终单独展示，保证关键动作不被淹没。
 */
export function groupToolCalls(tools: SemanticToolCallCard[]): ToolSegment[] {
  const segments: ToolSegment[] = [];
  let buffer: SemanticToolCallCard[] = [];

  const flush = () => {
    if (buffer.length >= 2) {
      segments.push({ kind: 'explore-group', key: `grp-${buffer[0].toolCallId}`, tools: buffer });
    } else {
      for (const t of buffer) segments.push({ kind: 'single', key: t.toolCallId, tool: t });
    }
    buffer = [];
  };

  for (const tool of tools) {
    const groupable =
      classifyTool(tool.canonicalToolName) === 'explore' && tool.status === 'completed' && !isToolCallFailure(tool);
    if (groupable) {
      buffer.push(tool);
    } else {
      flush();
      segments.push({ kind: 'single', key: tool.toolCallId, tool });
    }
  }
  flush();
  return segments;
}

export interface ChangedFileStat {
  path: string;
  added: number;
  removed: number;
}

export interface TurnInsights {
  changedFiles: ChangedFileStat[];
  addedLines: number;
  removedLines: number;
  commands: number;
  failedCommands: number;
  explored: number;
  failedTools: number;
  activeTools: number;
  totalTools: number;
  durationMs?: number;
}

export function summarizeTurn(message: ChatMessageItem, turnStartedAt?: string): TurnInsights {
  const fileMap = new Map<string, ChangedFileStat>();
  let commands = 0;
  let failedCommands = 0;
  let explored = 0;
  let failedTools = 0;
  let activeTools = 0;
  const tools = message.toolCalls ?? [];

  for (const t of tools) {
    const cat = classifyTool(t.canonicalToolName);
    const failed = isToolCallFailure(t);
    if (failed) failedTools += 1;
    if (isToolActive(t)) activeTools += 1;
    if (cat === 'explore') explored += 1;
    if (cat === 'exec') {
      commands += 1;
      if (failed) failedCommands += 1;
    }
    // 文件统计只纳入已完成工具产生的补丁。同一路径多次修改时累计各次增删行数，体现本回合的修改量。
    if (t.diffPatch && t.status === 'completed') {
      const prev = fileMap.get(t.diffPatch.filePath);
      fileMap.set(t.diffPatch.filePath, {
        path: t.diffPatch.filePath,
        added: (prev?.added ?? 0) + t.diffPatch.addedLines,
        removed: (prev?.removed ?? 0) + t.diffPatch.removedLines,
      });
    }
  }

  const changedFiles = Array.from(fileMap.values()).sort((a, b) => b.added + b.removed - (a.added + a.removed));
  // TA-1：优先使用主进程记录的整回合起点 turnStartedAt 与收口时间 turnSettledAt；
  // 提问中间分段（存在 question 且尚无 turnSettledAt）不用分段 completedAt 误报整回合耗时。
  const start = Date.parse(message.turnStartedAt || turnStartedAt || message.createdAt);
  const endIso = message.turnSettledAt || (message.question ? undefined : message.completedAt);
  const end = endIso ? Date.parse(endIso) : NaN;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;

  return {
    changedFiles,
    addedLines: changedFiles.reduce((s, f) => s + f.added, 0),
    removedLines: changedFiles.reduce((s, f) => s + f.removed, 0),
    commands,
    failedCommands,
    explored,
    failedTools,
    activeTools,
    totalTools: tools.length,
    durationMs,
  };
}

/**
 * TA-4：对缺少 turnSettledAt 的旧历史消息执行三条件未确认展示判定：
 * 1) 消息本身非流式、无 turnSettledAt、无明确 turnStop；
 * 2) 当前并非进行中回合（不是最新助手消息，或会话状态已处于 idle/closed/error）；
 * 3) 存在未终态证据（仍有 pending/running 工具，或缺少 completedAt）。
 */
export function isTurnUnconfirmed(
  message: ChatMessageItem,
  options?: { isLatestAssistant?: boolean; sessionStatus?: string }
): boolean {
  if (message.isStreaming || message.turnSettledAt || message.turnStop) return false;
  const isLatest = options?.isLatestAssistant;
  const status = options?.sessionStatus;
  const knownNotLive =
    isLatest === false ||
    status === 'idle' ||
    status === 'closed' ||
    status === 'error';
  if (!knownNotLive) return false;
  const hasActiveTools = (message.toolCalls ?? []).some(isToolActive);
  return hasActiveTools || !message.completedAt;
}

export function toolDurationMs(tool: SemanticToolCallCard): number | undefined {
  const s = Date.parse(tool.startedAt);
  const e = tool.completedAt ? Date.parse(tool.completedAt) : NaN;
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? e - s : undefined;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${(Math.max(100, ms) / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

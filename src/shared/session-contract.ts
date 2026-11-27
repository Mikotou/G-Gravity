/**
 * Gravity v0.2 — 三栏工作台布局（Projects / Claude Code Stage / Inspector）、
 * 会话状态、Diff/Todo/Terminal 衍生模型与标题整理契约
 */

import type {
  AcpModelOption,
  AgentExecutionMode,
  AgentReasoningEffort,
} from './acp-protocol';
import type { ApprovalMode } from './approval-contract';
import type { SessionDiagnosticBanner, TurnStopState } from './diagnostic-contract';
import type { FileDiffEntry } from './line-diff';
import type { MessageAnnotation } from './message-annotation';
import type { SessionPlanSummary, SessionTodoItem } from './plan-contract';
import type { SessionOwner } from './session-owner';

export * from './line-diff';
export * from './plan-contract';
export * from './message-annotation';

/** 客户端支持并行活跃对话硬上限 */
export const MAX_PARALLEL_ACTIVE_SESSIONS = 4;

export const MESSAGE_PAGE_SIZE = 64;

export interface MessagePagePosition {
  historyIndexUnavailable?: boolean;
  earlierCount: number;
  earlierUserCount: number;
  earlierVisibleCount: number;
  precedingOriginId: string | null;
}

export interface ConversationMessagePage extends MessagePagePosition {
  messages: ChatMessageItem[];
}

export const emptyMessagePosition = (): MessagePagePosition => ({
  earlierCount: 0, earlierUserCount: 0, earlierVisibleCount: 0, precedingOriginId: null,
});

export function advanceMessagePosition(position: MessagePagePosition, messages: ChatMessageItem[]): MessagePagePosition {
  const next = { ...position };
  for (const m of messages) {
    next.earlierCount++;
    if (m.role === 'system') continue;
    if (m.content) next.earlierVisibleCount++;
    if (m.role === 'user') next.earlierUserCount++;
    next.precedingOriginId = m.originMessageId || m.id;
  }
  return next;
}

export function pageMessages(messages: ChatMessageItem[], before = messages.length): ConversationMessagePage {
  const end = Math.max(0, Math.min(messages.length, before));
  const start = Math.max(0, end - MESSAGE_PAGE_SIZE);
  return { ...advanceMessagePosition(emptyMessagePosition(), messages.slice(0, start)), messages: messages.slice(start, end) };
}

/** 思考折叠框双轨展示模式 */
export type ThoughtDisplayTrack = 'zh' | 'raw';

export interface DualTrackThoughtBlock {
  id: string;
  originalText: string;
  translatedZhText: string;
  isStreaming: boolean;
  isTranslating?: boolean;
  languageDetected: 'zh' | 'en' | 'mixed';
  translationSource:
    | 'native-zh'
    | 'original'
    | 'acp-subagent'
    | 'local-model'
    | 'external-api'
    | 'pending'
    | 'local-stream-glossary';
}

/**
 * Claude Code 风格工具调用行卡片（`⏺ Bash / Read / Edit / Write / Grep`，默认折叠）
 */
export interface SemanticToolCallCard {
  toolCallId: string;
  rawToolName: string;
  /** 规范英文工具名：Bash / Read / Edit / Write / Grep / Glob / WebSearch / Swarm / Subagent */
  canonicalToolName: string;
  /** 单行紧凑目标描述，例如 `npm test` 或 `src/main/index.ts` */
  compactTarget: string;
  command?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rejected';
  argsSummary: string;
  locations?: Array<{ path: string; line?: number }>;
  outputPreview?: string;
  diffPatch?: FileDiffEntry;
  exitCode?: number;
  startedAt: string;
  completedAt?: string;
}

/** 统一判定一条工具调用是否失败：包括 failed、rejected 以及以非零退出码结束的命令。 */
export function isToolCallFailure(card: Pick<SemanticToolCallCard, 'status' | 'exitCode'>): boolean {
  return (
    card.status === 'failed' ||
    card.status === 'rejected' ||
    (typeof card.exitCode === 'number' && card.exitCode !== 0)
  );
}

export function terminalCommand(tool: SemanticToolCallCard): string {
  if (tool.command) return tool.command;
  try {
    const args = JSON.parse(tool.argsSummary);
    const command = args?.command ?? args?.CommandLine ?? args?.cmd ?? args?.Command;
    if (typeof command === 'string') return command;
  } catch {
    if (tool.argsSummary && !tool.argsSummary.trimStart().startsWith('{')) return tool.argsSummary;
  }
  return tool.compactTarget || tool.argsSummary;
}

export interface SessionTerminalEntry {
  id: string;
  toolCallId: string;
  command: string;
  output: string;
  status: 'running' | 'completed' | 'failed' | 'rejected';
  exitCode?: number;
  timestamp: string;
  /** 单调递增修订号，供渲染层避免逐字符哈希终端输出 */
  revision?: number;
}

export interface SessionInspectorData {
  sessionId: string;
  /** 归属元数据（v0.3.6 起附带，用于阻止跨 Profile / 过期代次事件污染） */
  owner?: SessionOwner;
  profileId?: string;
  epoch?: number;
  diffs: FileDiffEntry[];
  todos: SessionTodoItem[];
  terminals: SessionTerminalEntry[];
  /** 权威 Plan 摘要元数据；旧快照缺省时前端按历史兼容回溯，存在时以本字段为准 */
  plan?: SessionPlanSummary;
}

export interface MessageAttachmentPreview {
  id: string;
  name: string;
  mimeType: string;
  dataUrl?: string;
  textContent?: string;
  dataBase64?: string;
  uri?: string;
  sizeBytes: number;
}

export interface ChatMessageItem {
  question?: import('./user-question').UserQuestion;
  /** 原生提问走显式普通消息跟进时的投递状态投影 */
  questionFollowup?: import('./user-question').QuestionFollowupMetadata;
  annotations?: MessageAnnotation[];
  id: string;
  /** 跨分支稳定的原始消息标识；继承自父分支前缀时保留原消息的 originMessageId || id，用于精确匹配同分叉点 */
  originMessageId?: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming?: boolean;
  revisionHistory?: boolean;
  sendFailed?: boolean;
  /** A repeated network interruption has no further detail. Other continuation failures retain the service error. */
  autoResumeFailure?: { detail?: string };
  /** 本轮非正常结束或暂停时的结构化诊断状态（如 max_tokens、refusal、user_cancelled、429/403、断连等） */
  turnStop?: TurnStopState;
  attachments?: MessageAttachmentPreview[];
  references?: Array<{ kind: 'file' | 'session'; label: string; value: string }>;
  thoughts?: DualTrackThoughtBlock[];
  toolCalls?: SemanticToolCallCard[];
  todos?: SessionTodoItem[];
  pendingApprovalId?: string;
  createdAt: string;
  /** 助手回合真正结束（流式收口）的时间，用于计算本轮耗时 */
  completedAt?: string;
  /** 整回合开始时间（跨提问分段保持一致，供 TurnActivity 准确统计耗时） */
  turnStartedAt?: string;
  /** 整回合真正结算时间（区分中间提问分段与最终收口） */
  turnSettledAt?: string;
}

export type ManagedSessionStatus =
  | 'idle'
  | 'streaming'
  | 'waiting_approval'
  | 'waiting_question'
  | 'error'
  | 'closed';

export type SessionOriginKind = 'acp-live';

export interface ManagedSessionSummary {
  archivedAt?: string;
  sessionId: string;
  cwd: string;
  rawCwd: string;
  title: string;
  rawTitle?: string;
  categoryTag?: string;
  /** 已通过标题整理功能整理过的时间戳；存在时「全部整理」将跳过该会话 */
  titleOrganizedAt?: string;
  /** 上次整理所使用的模型标识（例如 Hydrogen (medium)） */
  titleOrganizedModel?: string;
  pinned: boolean;
  isLegacyApprovalPollution: boolean;
  status: ManagedSessionStatus;
  modelId: string;
  executionMode: AgentExecutionMode;
  /** Explicit approvals belong to this saved conversation, profile and workspace. */
  approvalModeOverride?: ApprovalMode;
  hasApprovalGrants?: boolean;
  reasoningEffort: AgentReasoningEffort;
  availableModels?: AcpModelOption[];
  availableEfforts?: Array<{ value: AgentReasoningEffort; name: string }>;
  originKind: SessionOriginKind;
  readOnly: boolean;
  profileId: string;
  updatedAt: string;
  /** 所属主对话（根会话）ID；未分叉时可省略 */
  rootSessionId?: string;
  /** 拓扑父分支会话 ID；非空表示该会话属于主对话树内的子分支，不在左侧历史会话栏重复列出 */
  parentBranchId?: string | null;
  /** 分叉发生在其后的稳定消息 ID（originMessageId），null 表示首条用户消息分叉 */
  forkAfterMessageId?: string | null;
  /** 所属主对话树的分支总数（> 1 时左侧栏显示分支数徽标） */
  branchCount?: number;
  /** 所属主对话树当前激活的分支会话 ID */
  activeBranchId?: string;
  /** 会话级暂停/断连/错误诊断横幅与恢复建议（非持久字段，重连或新回合开始时自动清除） */
  diagnostic?: SessionDiagnosticBanner;
}

export type SessionAction = 'archive' | 'restore' | 'delete';

export type WorkspaceSplitMode = 'single' | 'split-2';

export function workspaceSlots(layout: WorkspaceLayoutState, tabs = layout.openTabSessionIds): Array<string | null> {
  const ordered = layout.openTabSessionIds.filter(id => tabs.includes(id));
  const has = (id: string | null) => id !== null && ordered.includes(id);
  const reserved = layout.layoutMode === 'split-2' ? layout.splitSecondarySessionId : null;
  const primary = has(layout.activePrimarySessionId) ? layout.activePrimarySessionId : ordered.find(id => id !== reserved) ?? null;
  if (layout.layoutMode === 'single') return [primary];
  const secondary = layout.splitSecondarySessionId;
  return [primary, has(secondary) && secondary !== primary ? secondary : ordered.find(id => id !== primary) ?? null];
}

export function placeSession(layout: WorkspaceLayoutState, slot: number, id: string): Partial<WorkspaceLayoutState> {
  const [left, right] = workspaceSlots(layout);
  const tabs = layout.openTabSessionIds.includes(id) ? layout.openTabSessionIds : [...layout.openTabSessionIds, id];
  if (slot === 1 && layout.layoutMode === 'split-2') {
    return { openTabSessionIds: tabs, activePrimarySessionId: id === left ? right ?? null : left, splitSecondarySessionId: id };
  }
  return { openTabSessionIds: tabs, activePrimarySessionId: id,
    splitSecondarySessionId: layout.layoutMode === 'split-2' ? (id === right ? left : right ?? null) :
      (id === layout.splitSecondarySessionId ? left : layout.splitSecondarySessionId) };
}

export function withoutSessionPatch(
  layout: WorkspaceLayoutState,
  id: string
): Pick<WorkspaceLayoutState, 'openTabSessionIds' | 'activePrimarySessionId' | 'splitSecondarySessionId'> {
  const tabs = layout.openTabSessionIds.filter(tab => tab !== id);
  const secondary = layout.splitSecondarySessionId === id ? null : layout.splitSecondarySessionId;
  return {
    openTabSessionIds: tabs,
    activePrimarySessionId: layout.activePrimarySessionId === id ? tabs.find(t => t !== secondary) ?? tabs[0] ?? null : layout.activePrimarySessionId,
    splitSecondarySessionId: secondary,
  };
}

export function withoutSession(layout: WorkspaceLayoutState, id: string): WorkspaceLayoutState {
  return { ...layout, ...withoutSessionPatch(layout, id) };
}

const inspectorTabs = ['diff', 'files', 'plan', 'terminal', 'context', 'tree', 'swarm'] as const;
export type RightInspectorTab = (typeof inspectorTabs)[number];
export function isRightInspectorTab(value: unknown): value is RightInspectorTab {
  return inspectorTabs.some(tab => tab === value);
}

export interface WorkspaceLayoutState {
  openTabSessionIds: string[];
  activePrimarySessionId: string | null;
  splitSecondarySessionId: string | null;
  layoutMode: WorkspaceSplitMode;
  hideLegacyPollutionSessions: boolean;
  /** 左栏折叠态（快捷键 Ctrl+B） */
  leftSidebarCollapsed: boolean;
  /** 左栏持久化像素宽度 */
  leftSidebarWidth: number;
  /** 右栏 Inspector 折叠态（快捷键 Ctrl+J） */
  rightInspectorCollapsed: boolean;
  /** 右栏 Inspector 持久化像素宽度（支持鼠标拖拽调节） */
  rightInspectorWidth: number;
  /** 右栏当前激活标签页 */
  activeInspectorTab: RightInspectorTab;
  /** 左右分屏时左侧窗格所占比例（0.25–0.75，拖动分隔条调整，缺省 0.5） */
  splitRatio?: number;
  /** 右侧检视器是否以悬浮模式展开（持久化至 layout.json，跨便携版更新保留） */
  inspectorFloating?: boolean;
  /** 输入框自定义最小高度像素值（46–520，持久化至 layout.json，跨便携版更新保留） */
  composerMinHeight?: number;
}

/** 可拖拽栏宽与分屏比例的统一边界。主进程按此校验，渲染层在更窄的区间内钳制。 */
export const LAYOUT_LIMITS = {
  leftSidebarWidth: { min: 160, max: 600 },
  rightInspectorWidth: { min: 240, max: 1000 },
  splitRatio: { min: 0.25, max: 0.75 },
  composerMinHeight: { min: 46, max: 520 },
} as const;

/** 把分屏比例钳制到允许区间。非数字回到对半分。 */
export function clampSplitRatio(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
  return Math.min(LAYOUT_LIMITS.splitRatio.max, Math.max(LAYOUT_LIMITS.splitRatio.min, n));
}

/**
 * 内置 `/` Slash 命令补全定义（名称保留英文，描述按客户端语言切换）
 */
export interface SlashCommandSpec {
  command: string;
  descriptionZh: string;
  descriptionEn: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    command: '/compact',
    descriptionZh: '压缩并总结当前会话 Context 以释放窗口空间',
    descriptionEn: 'Compact and summarize current conversation context',
  },
  {
    command: '/clear',
    descriptionZh: '清空当前对话视图并开启全新上下文',
    descriptionEn: 'Clear current thread view and start fresh',
  },
  {
    command: '/plan',
    descriptionZh: '切换至 Plan 模式先制定分步实施方案',
    descriptionEn: 'Switch to Plan mode for step-by-step architecture design',
  },
  {
    command: '/goal',
    descriptionZh: '启动长程目标驱动执行模式直至目标达成',
    descriptionEn: 'Run thorough goal-driven execution until completion',
  },
  {
    command: '/review',
    descriptionZh: '对当前工作区变更执行代码审查与 Diff 检查',
    descriptionEn: 'Review workspace file changes and diffs',
  },
  {
    command: '/boost',
    descriptionZh: '开启深度推理、多视角权衡与严格验证流程',
    descriptionEn: 'Enable deep reasoning and multi-perspective verification',
  },
  {
    command: '/voice',
    descriptionZh: '开始或停止语音听写（快捷键 F5）',
    descriptionEn: 'Start or stop voice dictation (shortcut F5)',
  },
  {
    command: '/record',
    descriptionZh: '开始或停止语音听写（/voice 别名）',
    descriptionEn: 'Start or stop voice dictation (alias for /voice)',
  },
] as const;

export const TITLE_ORGANIZE_MODEL_LABEL = 'Hydrogen (medium)';
export const TITLE_ORGANIZE_RATE_LIMIT = {
  maxCalls: 4,
  windowMs: 60_000,
  batchSize: 30,
} as const;

export type TitleOrganizeScope = 'all' | 'project' | 'session';

export interface TitleOrganizeRequest {
  /** 整理范围：all 跳过已整理会话；project / session 显式整理目标 */
  scope?: TitleOrganizeScope;
  sessionIds?: string[];
  projectCwd?: string;
}

export interface TitleOrganizeSuggestion {
  sessionId: string;
  previousTitle: string;
  organizedTitle: string;
  categoryTag: string;
}

export interface TitleOrganizeResult {
  updatedCount: number;
  hiddenPollutionCount: number;
  /** Remaining candidates for a user-requested continuation of this scope. */
  nextBatch?: TitleOrganizeRequest & { sessionIds: string[] };
  skippedOrganizedCount?: number;
  skippedChangedCount?: number;
  modelUsed?: string;
  remainingQuotaInWindow?: number;
  cooldownResetAt?: string;
  suggestions: TitleOrganizeSuggestion[];
}

/* ============================================================================
 * 前后端共享纯函数
 * ========================================================================== */

/**
 * 识别打包/便携版应用自动解压产生的临时目录（Windows NSIS Temp、Linux AppImage、macOS AppTranslocation），
 * 仅过滤应用临时解压路径，不误伤用户在系统 Temp 下主动创建的普通工程目录。
 */
export function isTempExtractionDir(rawPath?: string | null): boolean {
  if (!rawPath) return false;
  return (
    /[\\/]AppData[\\/]Local[\\/]Temp[\\/]ns[a-z0-9]{3,}\.tmp(?:[\\/]|$)/i.test(rawPath) ||
    /^\/tmp\/\.mount_[^/]+(?:\/|$)/i.test(rawPath) ||
    /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/AppTranslocation\/[^/]+\/d(?:\/?$|\/[^/]+\.app(?:\/|$))/i.test(
      rawPath
    )
  );
}

export function normalizeWorkspacePath(rawCwd: string): string {
  if (!rawCwd || !rawCwd.trim()) {
    return '';
  }
  let decoded = rawCwd.trim();
  const isFileUri = /^file:\/\//i.test(decoded);
  if (isFileUri) {
    decoded = decoded.replace(/^file:\/\/(?:localhost)?/i, '');
  }
  // 仅对 file:// URI 或 URI 形式的 /C:/ / /d%3A/ 路径执行 URL 解码，避免破坏原生目录名中的 %XX 字面量。
  if (isFileUri || /^\/[a-zA-Z](?::|%3A)[\\/]/i.test(decoded)) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // keep raw
    }
  }

  // Windows 文件 URI 解码后常以 /C:/ 开头，先消去多余的斜杠。驱动器根目录则保留结尾分隔符。
  const winUriMatch = /^\/([a-zA-Z]):[\\/](.*)$/.exec(decoded);
  if (winUriMatch) {
    const drive = winUriMatch[1].toUpperCase();
    const rest = winUriMatch[2].replace(/\//g, '\\').replace(/\\+$/, '');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  if (/^[a-zA-Z]:$/.test(decoded)) {
    return `${decoded[0].toUpperCase()}:\\`;
  }

  const winNativeMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(decoded);
  if (winNativeMatch) {
    const drive = winNativeMatch[1].toUpperCase();
    const rest = winNativeMatch[2].replace(/\//g, '\\').replace(/\\+$/, '');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  // Windows UNC 路径（\\server\share\）规范化并去除尾部多余反斜杠。
  if (/^\\\\[^\\]/.test(decoded)) {
    return decoded.replace(/\//g, '\\').replace(/\\+$/, '');
  }

  return decoded.replace(/\/+$/, '') || '/';
}

/**
 * 跨平台项目目录比较键：
 * - Windows 盘符路径与 UNC 路径忽略大小写；
 * - POSIX 路径保留大小写（避免大小写敏感 APFS/ext4 上不同项目被静默合并）。
 */
export function normalizeProjectCompareKey(rawPath: string): string {
  const normalized = normalizeWorkspacePath(rawPath);
  if (!normalized) return '';
  return /^[A-Za-z]:\\|^\\\\/.test(normalized) ? normalized.toLowerCase() : normalized;
}

const LEGACY_POLLUTION_PATTERNS: readonly RegExp[] = [
  /^You are ['"]?Approve for Me['"]?/i,
  /automated tool-approval (?:security )?reviewer/i,
  /^根据输入数据为每条对话整理标题/,
  /^\[Gravity Translator\]/i,
  /^\[Gravity Title Organizer\]/i,
];

export function isLegacyPollutionSessionTitle(title?: string | null): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  return LEGACY_POLLUTION_PATTERNS.some((re) => re.test(trimmed));
}

const TRANSIENT_STREAM_INTERRUPTION_LINE_RE =
  /^ {0,3}(?:⚠\uFE0F?|Error:)[ \t]*(?:There was a network issue connecting to the server[,.][ \t]*please try again\.?|The stream was interrupted\.?(?:[ \t]*Please continue the task you were working on\.?)?|Stream interrupted[^\n]*|Network error(?::[^\n]*|\.?)|Connection interrupted[^\n]*)[ \t]*$/i;

/** 判断单行文本是否为服务端流式断连产生的瞬态错误提示（例如 `⚠ The stream was interrupted...`）。 */
export function isTransientStreamInterruptionLine(line: string): boolean {
  return TRANSIENT_STREAM_INTERRUPTION_LINE_RE.test(line) &&
    !/\b(?:401|403|429|RESOURCE_EXHAUSTED|PERMISSION_DENIED|UNAUTHENTICATED|rate limit(?:ed)?|permission denied)\b/i.test(line);
}

/**
 * 剥离消息中的瞬态流式中断提示行（在流恢复继续输出、工具继续执行或自动续接后调用），
 * 同时收拢因剥离产生的多余首尾空行，保留所有实质回复正文。
 */
export function stripTransientStreamInterruptions(text: string): string {
  return inspectStreamInterruption(text).content;
}

/** A warning after partial output still interrupts the turn. Content following it resumes the stream. */
export function inspectStreamInterruption(text: string): { content: string; found: boolean; trailing: boolean } {
  if (!/⚠|Error:/i.test(text)) return { content: text, found: false, trailing: false };
  const kept: string[] = [];
  let fence = '', found = false, trailing = false;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1].startsWith(fence) && !delimiter[2].trim()) fence = '';
    }
    if (!fence && isTransientStreamInterruptionLine(line)) {
      found = trailing = true;
    } else {
      kept.push(line);
      if (line.trim()) trailing = false;
    }
  }
  const content = found ? kept.join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '') : text;
  return { content, found, trailing };
}

/**
 * Gravity v0.2 — 三栏工作台布局（Projects / Claude Code Stage / Inspector）、
 * 会话状态、Diff/Todo/Terminal 衍生模型与标题整理契约
 */

import type {
  AcpModelOption,
  AgentExecutionMode,
  AgentReasoningEffort,
} from './acp-protocol';

/** 客户端支持并行活跃对话硬上限 */
export const MAX_PARALLEL_ACTIVE_SESSIONS = 4;

/** 思考折叠框双轨展示模式 */
export type ThoughtDisplayTrack = 'zh' | 'raw';

export interface DualTrackThoughtBlock {
  id: string;
  originalText: string;
  translatedZhText: string;
  isStreaming: boolean;
  isTranslating?: boolean;
  /** 已完成中文定稿的前缀片段（供前端渲染平滑交替动效） */
  zhFinalized?: string;
  /** 当前正在流式生成并逐步替代英文片段的中文译文 */
  zhMorphing?: string;
  /** 当前正在被中文逐步吞噬/消融的剩余英文片段 */
  enMorphingRemainder?: string;
  /** 尚待子个体翻译的后续英文队列尾部 */
  enPendingTail?: string;
  languageDetected: 'zh' | 'en' | 'mixed';
  translationSource:
    | 'native-zh'
    | 'acp-subagent'
    | 'local-model'
    | 'external-api'
    | 'pending'
    | 'local-stream-glossary';
}

export interface DiffHunkLine {
  type: 'context' | 'add' | 'remove';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface FileDiffEntry {
  filePath: string;
  oldText: string;
  newText: string;
  addedLines: number;
  removedLines: number;
  lines: DiffHunkLine[];
  toolCallId?: string;
  updatedAt: string;
}

/**
 * 纯函数：根据修改前后文本计算逐行红绿 Diff（供 Edit/Write 内联展示及右栏 Diff/Files Changed 使用）
 */
export function computeUnifiedLineDiff(
  filePath: string,
  oldText: string,
  newText: string,
  toolCallId?: string
): FileDiffEntry {
  const rawOld = oldText ?? '';
  const rawNew = newText ?? '';
  const oldLines = rawOld.length === 0 ? [] : rawOld.split(/\r?\n/);
  const newLines = rawNew.length === 0 ? [] : rawNew.split(/\r?\n/);
  const lines: DiffHunkLine[] = [];
  let addedLines = 0;
  let removedLines = 0;

  // 先剥离完全相同的公共前缀与公共后缀，使大文件局部修改或相同文件达到 O(N) 精确对齐
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    lines.push({
      type: 'context',
      oldLineNumber: prefixLen + 1,
      newLineNumber: prefixLen + 1,
      content: oldLines[prefixLen],
    });
    prefixLen++;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > prefixLen &&
    newEnd > prefixLen &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const midOld = oldLines.slice(prefixLen, oldEnd);
  const midNew = newLines.slice(prefixLen, newEnd);

  // 只对两边都不超过 400 行的差异区计算最长公共子序列，使动态规划矩阵的空间开销有界。
  const maxMatrix = 400;
  if (midOld.length === 0 && midNew.length === 0) {
    // 中间无任何差异
  } else if (midOld.length <= maxMatrix && midNew.length <= maxMatrix) {
    const m = midOld.length;
    const n = midNew.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0)
    );
    // 从末尾向前填表，dp[i][j] 表示两侧剩余行还能匹配的最大行数。随后沿表回溯生成增删行和上下文。
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] =
          midOld[i] === midNew[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midOld[i] === midNew[j]) {
        lines.push({
          type: 'context',
          oldLineNumber: prefixLen + i + 1,
          newLineNumber: prefixLen + j + 1,
          content: midOld[i],
        });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({
          type: 'remove',
          oldLineNumber: prefixLen + i + 1,
          content: midOld[i],
        });
        removedLines++;
        i++;
      } else {
        lines.push({
          type: 'add',
          newLineNumber: prefixLen + j + 1,
          content: midNew[j],
        });
        addedLines++;
        j++;
      }
    }
    while (i < m) {
      lines.push({
        type: 'remove',
        oldLineNumber: prefixLen + i + 1,
        content: midOld[i++],
      });
      removedLines++;
    }
    while (j < n) {
      lines.push({
        type: 'add',
        newLineNumber: prefixLen + j + 1,
        content: midNew[j++],
      });
      addedLines++;
    }
  } else {
    // 差异区过大时整段输出旧行删除与新行新增。首尾的公共行仍精确对齐，避免大文件占用过多内存。
    for (let idx = 0; idx < midOld.length; idx++) {
      lines.push({
        type: 'remove',
        oldLineNumber: prefixLen + idx + 1,
        content: midOld[idx],
      });
      removedLines++;
    }
    for (let idx = 0; idx < midNew.length; idx++) {
      lines.push({
        type: 'add',
        newLineNumber: prefixLen + idx + 1,
        content: midNew[idx],
      });
      addedLines++;
    }
  }

  // 两侧相同行可能因中间插入或删除而行号不同，公共尾部的旧、新行号分别从各自偏移计算。
  for (let s = 0; s < oldLines.length - oldEnd; s++) {
    lines.push({
      type: 'context',
      oldLineNumber: oldEnd + s + 1,
      newLineNumber: newEnd + s + 1,
      content: oldLines[oldEnd + s],
    });
  }

  return {
    filePath,
    oldText: rawOld,
    newText: rawNew,
    addedLines,
    removedLines,
    lines,
    toolCallId,
    updatedAt: new Date().toISOString(),
  };
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

export interface SessionTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
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
}

export interface SessionInspectorData {
  sessionId: string;
  diffs: FileDiffEntry[];
  todos: SessionTodoItem[];
  terminals: SessionTerminalEntry[];
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
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming?: boolean;
  revisionHistory?: boolean;
  sendFailed?: boolean;
  attachments?: MessageAttachmentPreview[];
  references?: Array<{ kind: 'file' | 'session'; label: string; value: string }>;
  thoughts?: DualTrackThoughtBlock[];
  toolCalls?: SemanticToolCallCard[];
  todos?: SessionTodoItem[];
  pendingApprovalId?: string;
  createdAt: string;
  /** 助手回合真正结束（流式收口）的时间，用于计算本轮耗时 */
  completedAt?: string;
}

export type ManagedSessionStatus =
  | 'idle'
  | 'streaming'
  | 'waiting_approval'
  | 'error'
  | 'closed';

export type SessionOriginKind =
  | 'acp-live'
  | 'antigravity-desktop-readonly'
  | 'antigravity-cli-readonly';

export interface ManagedSessionSummary {
  archivedAt?: string;
  sessionId: string;
  cwd: string;
  rawCwd: string;
  title: string;
  rawTitle?: string;
  categoryTag?: string;
  pinned: boolean;
  isLegacyApprovalPollution: boolean;
  status: ManagedSessionStatus;
  modelId: string;
  executionMode: AgentExecutionMode;
  reasoningEffort: AgentReasoningEffort;
  availableModels?: AcpModelOption[];
  availableEfforts?: Array<{ value: AgentReasoningEffort; name: string }>;
  originKind: SessionOriginKind;
  readOnly: boolean;
  profileId: string;
  updatedAt: string;
}

export type SessionAction = 'archive' | 'restore' | 'delete';

export function withoutSession(layout: WorkspaceLayoutState, id: string): WorkspaceLayoutState {
  const tabs = layout.openTabSessionIds.filter(tab => tab !== id);
  const secondary = layout.splitSecondarySessionId === id ? null : layout.splitSecondarySessionId;
  const third = layout.tertiarySessionId === id ? null : layout.tertiarySessionId;
  const fourth = layout.quaternarySessionId === id ? null : layout.quaternarySessionId;
  return { ...layout, openTabSessionIds: tabs,
    activePrimarySessionId: layout.activePrimarySessionId === id ? tabs.find(t => ![secondary, third, fourth].includes(t)) ?? null : layout.activePrimarySessionId,
    splitSecondarySessionId: secondary, tertiarySessionId: third, quaternarySessionId: fourth };
}

export type WorkspaceSplitMode = 'single' | 'split-2' | 'grid-4';

const inspectorTabs = ['diff', 'files', 'plan', 'terminal', 'context', 'swarm'] as const;
export type RightInspectorTab = (typeof inspectorTabs)[number];
export function isRightInspectorTab(value: unknown): value is RightInspectorTab {
  return inspectorTabs.some(tab => tab === value);
}

export interface WorkspaceLayoutState {
  openTabSessionIds: string[];
  activePrimarySessionId: string | null;
  splitSecondarySessionId: string | null;
  tertiarySessionId: string | null;
  quaternarySessionId: string | null;
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
] as const;

export interface TitleOrganizeRequest {
  sessionIds?: string[];
  useExternalModelPolish?: boolean;
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
  suggestions: TitleOrganizeSuggestion[];
}

/* ============================================================================
 * 前后端共享纯函数
 * ========================================================================== */

export function normalizeWorkspacePath(rawCwd: string): string {
  if (!rawCwd || !rawCwd.trim()) {
    return '';
  }
  let decoded = rawCwd.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw
  }

  // Windows 文件 URI 解码后常以 /C:/ 开头，先消去多余的斜杠。驱动器根目录则保留结尾分隔符。
  const winUriMatch = /^\/([a-zA-Z]):[\\/](.*)$/.exec(decoded);
  if (winUriMatch) {
    const drive = winUriMatch[1].toUpperCase();
    const rest = winUriMatch[2].replace(/\//g, '\\').replace(/\\+$/, '');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  const winNativeMatch = /^([a-zA-Z]):[\\/]?(.*)$/.exec(decoded);
  if (winNativeMatch) {
    const drive = winNativeMatch[1].toUpperCase();
    const rest = winNativeMatch[2].replace(/\//g, '\\').replace(/\\+$/, '');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  return decoded.replace(/\/+$/, '') || '/';
}

const LEGACY_POLLUTION_PATTERNS: readonly RegExp[] = [
  /^You are ['"]?Approve for Me['"]?/i,
  /automated tool-approval (?:security )?reviewer/i,
  /^根据输入数据为每条对话整理标题/,
  /^\[Gravity Translator\]/i,
];

export function isLegacyPollutionSessionTitle(title?: string | null): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  return LEGACY_POLLUTION_PATTERNS.some((re) => re.test(trimmed));
}

export function generateStructuredChineseTitle(
  rawInputOrTitle: string,
  cwd?: string
): { organizedTitle: string; categoryTag: string } {
  const cleanText = (rawInputOrTitle || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\d.\s]+/, '')
    .trim();

  // 保留已符合长度约束的「分类｜主题」，这样对同一标题再次整理可以得到相同的结果。
  const existingSplit = cleanText.split(/[｜|]/);
  if (
    existingSplit.length === 2 &&
    existingSplit[0].trim().length >= 2 &&
    existingSplit[0].trim().length <= 14 &&
    existingSplit[1].trim().length >= 2 &&
    existingSplit[1].trim().length <= 26
  ) {
    const tag = existingSplit[0].trim();
    const body = existingSplit[1].trim();
    return {
      organizedTitle: `${tag}｜${body}`,
      categoryTag: tag,
    };
  }

  let category = 'General';
  const lower = cleanText.toLowerCase();
  if (/蜂群|swarm|subagent|多智能体/.test(lower)) {
    category = 'Swarm';
  } else if (/react|ui|css|主题|配色|界面|前端|组件/.test(lower)) {
    category = 'Frontend';
  } else if (/acp|json-rpc|ipc|后端|electron|进程|接口/.test(lower)) {
    category = 'Backend';
  } else if (/测试|test|vitest|修复|bug|报错|异常/.test(lower)) {
    category = 'QA & Debug';
  } else if (/审批|权限|安全|合规|tos|approve/.test(lower)) {
    category = 'Security';
  } else if (/文档|ppt|报告|总结|翻译|合同/.test(lower)) {
    category = 'Docs';
  } else if (cwd) {
    const normalized = normalizeWorkspacePath(cwd);
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    const folder = parts[parts.length - 1];
    if (folder && folder.length <= 14 && !/^[A-Z]:$/i.test(folder)) {
      category = folder;
    }
  }

  if (!cleanText) {
    return {
      organizedTitle: `${category}｜新建会话`,
      categoryTag: category,
    };
  }

  const core = cleanText
    .replace(/^(请帮我|帮我|请问|我想|我们需要|开始研发|请你|麻烦)\s*/, '')
    .slice(0, 22)
    .replace(/[，。！？,.!?、；;：:]+$/, '')
    .trim();

  const summary = core || cleanText.slice(0, 18);
  return {
    organizedTitle: `${category}｜${summary}`,
    categoryTag: category,
  };
}

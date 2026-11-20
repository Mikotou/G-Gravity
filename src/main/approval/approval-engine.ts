import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, win32 as winPath } from 'node:path';
import type { AcpRequestPermissionParams, AcpRequestPermissionResult, AgentExecutionMode } from '../../shared/acp-protocol';
import {
  EXTERNAL_REVIEWER_DEFAULTS,
  isExternalReviewerConnected,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApproveForMeConfig,
  type DeterministicScreeningResult,
  type PendingApprovalRequest,
} from '../../shared/approval-contract';
import type { ExternalReviewerUsageRecordInput } from '../../shared/telemetry-contract';
import { ClientStore } from '../storage/client-store';
import {
  assessShellHighRiskFloor,
  compileSafePattern,
  hasUnsafeNetworkOrLocalUrl,
  inspectGeminiPathPolicy,
  isDestructiveOrPrivilegedToolName,
  isMutatingShellCommand,
  isPureReadOnlyLookupTool,
  isReadOnlyScriptReviewCandidate,
  isShellToolName,
  parseShellCommand,
  screenCommand,
  sensitiveTarget,
} from './shell-screening';
import {
  IndependentModelCallError,
  IndependentModelLimitError,
  reviewWithIndependentModel,
  validateExternalEndpoint,
  type Reviewer,
  type AiReviewResult,
} from './external-reviewer';

export const DEFAULT_APPROVAL_CONFIG: ApproveForMeConfig = {
  mode: 'manual',
  enableSafeDownloadAutoApprove: false,
  maxDownloadSizeMB: 50,
  cacheTtlHours: EXTERNAL_REVIEWER_DEFAULTS.cacheTtlHours,
  allowPatterns: [],
  askPatterns: [],
  denyPatterns: [],
  externalReviewer: {
    enabled: false,
    provider: 'gemini-api-key',
    endpoint: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash-lite',
    timeoutMs: EXTERNAL_REVIEWER_DEFAULTS.timeoutMs,
    maxOutputTokens: EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens,
    thinkingLevel: EXTERNAL_REVIEWER_DEFAULTS.thinkingLevel,
  },
};

interface Pending {
  card: PendingApprovalRequest;
  params: AcpRequestPermissionParams;
  screen: DeterministicScreeningResult;
  withinWorkspace: boolean;
  explicitAskRule: boolean;
  hardHumanFloor: boolean;
  hardHumanFloorReason?: string;
  conversationContext?: string;
  resolve: (result: AcpRequestPermissionResult) => void;
  reject: (error: unknown) => void;
  started: number;
  reviewing: boolean;
}

interface SessionBurstTracker {
  timestamps: number[];
  proactiveBurstUntil: number;
  autoApprovedInTurn: number;
}

export interface ApprovalGuardActivityEvent {
  sessionId: string;
  source: 'local-burst-guard' | 'external-ai' | 'user-delegated';
  command: string;
  autoApprovedCount: number;
  modelLabel: string;
}

export interface ApprovalEngineOptions {
  store: ClientStore;
  config?: Partial<ApproveForMeConfig>;
  reviewer?: Reviewer;
  now?: () => number;
}

const BURST_WINDOW_MS = 45_000;
const BURST_THRESHOLD = 2;

function isPathWithinWorkspace(targetPath: string, workspaceCwd: string): boolean {
  if (!targetPath || !workspaceCwd) return false;
  try {
    const useWin = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(workspaceCwd) || /^[A-Za-z]:[\\/]/.test(targetPath);
    const p = useWin ? winPath : { resolve, relative, isAbsolute };
    const base = p.resolve(workspaceCwd);
    const resolved = p.resolve(base, targetPath);
    const baseCmp = useWin ? base.toLowerCase() : base;
    const targetCmp = useWin ? resolved.toLowerCase() : resolved;
    const rel = p.relative(baseCmp, targetCmp);
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
  } catch {
    return false;
  }
}

function collectCandidatePaths(rawObj?: Record<string, unknown>, locations?: Array<{ path: string }>): string[] {
  const paths: string[] = [];
  if (rawObj) {
    for (const key of ['Path', 'path', 'file_path', 'filePath', 'DirectoryPath', 'SearchPath', 'SearchDirectory']) {
      const val = rawObj[key];
      if (typeof val === 'string' && val.trim()) paths.push(val.trim());
    }
  }
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc && typeof loc.path === 'string' && loc.path.trim()) paths.push(loc.path.trim());
    }
  }
  return paths;
}

/** 提取真实工具标识：当 ACP 仅标注笼统的 other/fetch 时优先使用 title 或 MCP Server/Tool 名，避免丢失工具身份。 */
function resolveToolName(params: AcpRequestPermissionParams, rawObj?: Record<string, unknown>): string {
  if (rawObj && typeof rawObj.toolName === 'string' && rawObj.toolName.trim()) {
    return rawObj.toolName.trim();
  }
  const declaredKind = (params.toolCall.kind || '').trim().toLowerCase();
  const rawTitle = (params.toolCall.title || '').trim();
  if (!declaredKind || declaredKind === 'other' || declaredKind === 'fetch') {
    if (
      rawObj &&
      typeof rawObj.ServerName === 'string' &&
      rawObj.ServerName.trim() &&
      typeof rawObj.ToolName === 'string' &&
      rawObj.ToolName.trim()
    ) {
      return `mcp_${rawObj.ServerName.trim()}_${rawObj.ToolName.trim()}`;
    }
    if (rawTitle && rawTitle.toLowerCase() !== 'other' && rawTitle.toLowerCase() !== 'fetch') {
      return rawTitle;
    }
    return declaredKind || '未知工具';
  }
  return params.toolCall.kind || rawTitle || '未知工具';
}

/** 为明确的非 Shell 扩展工具构造安全的会话前缀；匿名 other 或自然语言标题不授予宽泛前缀。 */
function buildSafeToolPrefix(toolName: string, declaredKind: string, isReadOnlyLookup: boolean): string | undefined {
  const trimmed = (toolName || '').trim();
  const lower = trimmed.toLowerCase();
  if (
    trimmed &&
    lower !== 'other' &&
    lower !== 'fetch' &&
    lower !== '未知工具' &&
    /^[a-zA-Z0-9._:/-]{2,80}$/.test(trimmed)
  ) {
    return `tool:${trimmed}`;
  }
  if (isReadOnlyLookup) {
    return declaredKind === 'fetch' ? 'fetch_read' : 'search_docs';
  }
  return undefined;
}

/** 将一次 ACP 权限询问转换为本地待审请求。自动规则、复审和用户选择都经 finish 回答同一个协议请求。 */
export class ApprovalEngine extends EventEmitter {
  private config: ApproveForMeConfig;
  private pending = new Map<string, Pending>();
  private cache = new Map<string, number>();
  private prefixes = new Map<string, Set<string>>();
  private sessionDelegated = new Set<string>();
  private sessionModes = new Map<string, AgentExecutionMode>();
  private burstTrackers = new Map<string, SessionBurstTracker>();
  private reviewer: Reviewer;
  private now: () => number;
  private configRevision = 0;

  constructor(private options: ApprovalEngineOptions) {
    super();
    this.reviewer = options.reviewer || reviewWithIndependentModel;
    this.now = options.now || Date.now;
    this.config = structuredClone(DEFAULT_APPROVAL_CONFIG);
    if (options.config) this.updateConfig(options.config);
  }

  getConfig(): ApproveForMeConfig {
    return structuredClone(this.config);
  }

  /** 判断当前外部复核是否已正常配置并连通（仅此时允许执行 AI 代审）。 */
  isExternalReviewerReady(): boolean {
    return isExternalReviewerConnected(this.config.externalReviewer);
  }

  updateConfig(patch: Partial<ApproveForMeConfig>): ApproveForMeConfig {
    const next = {
      ...this.config,
      ...patch,
      externalReviewer: { ...this.config.externalReviewer, ...patch.externalReviewer },
    };
    if (!['manual', 'rules-only', 'hybrid'].includes(next.mode)) throw new Error('无效的审批模式');
    for (const field of ['allowPatterns', 'askPatterns', 'denyPatterns'] as const) {
      if (!Array.isArray(next[field]) || next[field].length > 50) throw new Error('每类审批规则最多 50 条');
      next[field].forEach(compileSafePattern);
    }
    if (!Number.isFinite(next.cacheTtlHours) || next.cacheTtlHours < 0 || next.cacheTtlHours > 168) {
      throw new Error('缓存有效期必须介于 0 至 168 小时');
    }
    if (!Number.isFinite(next.maxDownloadSizeMB) || next.maxDownloadSizeMB < 0) {
      throw new Error('下载大小限制无效');
    }
    if (
      next.externalReviewer.timeoutMs !== undefined &&
      (!Number.isFinite(next.externalReviewer.timeoutMs) ||
        next.externalReviewer.timeoutMs < 100 ||
        next.externalReviewer.timeoutMs > 60_000)
    ) {
      throw new Error('外部复核超时时间必须介于 100 至 60000 ms');
    }
    if (
      next.externalReviewer.maxOutputTokens !== undefined &&
      (!Number.isFinite(next.externalReviewer.maxOutputTokens) ||
        next.externalReviewer.maxOutputTokens < 64 ||
        next.externalReviewer.maxOutputTokens > 65_536)
    ) {
      throw new Error('最大输出 Token 上限必须介于 64 至 65536');
    }
    if (
      next.externalReviewer.thinkingLevel !== undefined &&
      !['auto', 'off', 'minimal', 'low', 'medium', 'high'].includes(next.externalReviewer.thinkingLevel)
    ) {
      throw new Error('无效的思考强度配置');
    }
    if (next.externalReviewer.enabled) validateExternalEndpoint(next.externalReviewer);
    // 整份配置通过校验后才替换当前值。增加版本号使正在等待的外部复审能识别规则已变更。
    this.config = structuredClone(next);
    this.configRevision++;
    this.cache.clear();
    this.prefixes.clear();
    if (next.mode === 'manual') {
      this.sessionDelegated.clear();
    }
    return this.getConfig();
  }

  setSessionExecutionMode(sessionId: string, mode: AgentExecutionMode): void {
    this.sessionModes.set(sessionId, mode);
  }

  /**
   * 当上层预测到本轮将产生密集工具/命令调用（如 Plan 含多步任务或用户开启批量执行）时提前预热批量守卫窗口。
   */
  enableBurstGuard(sessionId: string, durationMs = 120_000): void {
    const tracker = this.ensureBurstTracker(sessionId);
    tracker.proactiveBurstUntil = Math.max(tracker.proactiveBurstUntil, this.now() + durationMs);
  }

  resetTurnBurstCounter(sessionId: string): void {
    const tracker = this.burstTrackers.get(sessionId);
    if (tracker) tracker.autoApprovedInTurn = 0;
  }

  enableSessionDelegation(sessionId: string, cwd: string): void {
    this.sessionDelegated.add(`${sessionId}\0${cwd}`);
  }

  isSessionDelegated(sessionId: string, cwd: string): boolean {
    return this.sessionDelegated.has(`${sessionId}\0${cwd}`);
  }

  private ensureBurstTracker(sessionId: string): SessionBurstTracker {
    let tracker = this.burstTrackers.get(sessionId);
    if (!tracker) {
      tracker = { timestamps: [], proactiveBurstUntil: 0, autoApprovedInTurn: 0 };
      this.burstTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /** 每个会话独立维护滑动时间窗，过期请求先移出计数。连续操作和计划触发的守卫有效期在此合并判定。 */
  private recordBurstRequest(sessionId: string): boolean {
    const now = this.now();
    const tracker = this.ensureBurstTracker(sessionId);
    tracker.timestamps = tracker.timestamps.filter((ts) => now - ts <= BURST_WINDOW_MS);
    tracker.timestamps.push(now);
    return tracker.timestamps.length >= BURST_THRESHOLD || now < tracker.proactiveBurstUntil;
  }

  private isBurstGuardActive(sessionId: string): boolean {
    const now = this.now();
    const tracker = this.burstTrackers.get(sessionId);
    if (!tracker) return false;
    const recent = tracker.timestamps.filter((ts) => now - ts <= BURST_WINDOW_MS);
    return recent.length >= BURST_THRESHOLD || now < tracker.proactiveBurstUntil;
  }

  private recordGuardAutoApproval(
    sessionId: string,
    source: ApprovalGuardActivityEvent['source'],
    command: string
  ): void {
    const tracker = this.ensureBurstTracker(sessionId);
    tracker.autoApprovedInTurn++;
    const shouldNotify =
      source !== 'local-burst-guard' || tracker.autoApprovedInTurn >= BURST_THRESHOLD || this.isBurstGuardActive(sessionId);
    if (shouldNotify) {
      const modelLabel =
        source === 'external-ai' && this.config.externalReviewer.enabled
          ? this.config.externalReviewer.model
          : 'local-ast-guard';
      const payload: ApprovalGuardActivityEvent = {
        sessionId,
        source,
        command,
        autoApprovedCount: tracker.autoApprovedInTurn,
        modelLabel,
      };
      this.emit('guard-activity', payload);
    }
  }

  screen(command: string, cwd: string, toolName = 'run_command', rawInput?: unknown): DeterministicScreeningResult {
    return screenCommand(command, cwd, this.config, toolName, rawInput);
  }

  listPending(): PendingApprovalRequest[] {
    return [...this.pending.values()].map((item) => structuredClone(item.card));
  }

  listAudit(limit = 100): ApprovalAuditEntry[] {
    return this.options.store.lines<ApprovalAuditEntry>('audit.jsonl', Math.max(1, Math.min(limit, 1000))).reverse();
  }

  /** 把会话、目录、去除单次 toolCallId 的工具参数和审批配置一并计入缓存键，限制已有结论可复用的范围并确保同类请求真实命中缓存。 */
  private key(item: Pending): string {
    const { kind, title, rawInput, locations } = item.params.toolCall;
    return createHash('sha256')
      .update(
        JSON.stringify([
          item.card.sessionId,
          item.card.cwd,
          item.card.toolName,
          { kind, title, rawInput, locations },
          this.config,
        ])
      )
      .digest('hex');
  }

  /**
   * 仿 Codex Approve for me（Guardian）三段式审批入口：
   * Stage 1（内部确定性规则：硬拒绝 / manual 直通 / askPatterns / 本地快筛自动通过）
   * → Stage 2（未通过 Stage 1 的请求统一转交外部 AI 复核，附带脱敏对话意图上下文）
   * → Stage 3（AI 未放行、异常超时、命中高危人工底线或未连接外部复核时，交由人工确认）。
   */
  requestPermission(
    params: AcpRequestPermissionParams,
    cwd: string,
    conversationContext?: string
  ): Promise<AcpRequestPermissionResult> {
    if (!params?.sessionId || !params.toolCall?.toolCallId || !Array.isArray(params.options)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const raw = params.toolCall.rawInput;
    const rawObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const declaredKind = (params.toolCall.kind || '').toLowerCase();
    const rawTitle = (params.toolCall.title || '').trim();
    const toolName = resolveToolName(params, rawObj);

    // 同时兼容标准 command/cmd 与官方 agy acp 的 PascalCase CommandLine / Path / Query
    const command =
      typeof raw === 'string'
        ? raw
        : rawObj && typeof rawObj.command === 'string'
          ? rawObj.command
          : rawObj && typeof rawObj.cmd === 'string'
            ? rawObj.cmd
            : rawObj && typeof rawObj.CommandLine === 'string'
              ? rawObj.CommandLine
              : rawObj && typeof rawObj.Path === 'string'
                ? `${toolName} ${rawObj.Path}`
                : rawObj && typeof rawObj.path === 'string'
                  ? `${toolName} ${rawObj.path}`
                  : rawObj && typeof rawObj.DirectoryPath === 'string'
                    ? `${toolName} ${rawObj.DirectoryPath}`
                    : rawObj && typeof rawObj.SearchPath === 'string'
                      ? `${toolName} ${rawObj.SearchPath}`
                      : params.toolCall.locations?.[0]?.path && (declaredKind === 'read' || declaredKind === 'search')
                        ? `${toolName} ${params.toolCall.locations[0].path}`
                        : JSON.stringify(raw || {});

    const screening = this.screen(command, cwd, toolName, raw);
    const rawSerialized = JSON.stringify(params.toolCall);
    const candidatePaths = collectCandidatePaths(rawObj, params.toolCall.locations);

    // 只读工具也要检查参数的实际用途。含命令或修改字段的请求会进入更严格的分支。
    const hasMutationFields = Boolean(
      rawObj &&
        Object.keys(rawObj).some((k) =>
          /^(Content|content|Replacement|newText|new_string|Target|oldText|old_string|CommandLine|command|cmd|Overwrite|Append)$/.test(k)
        )
    );

    const isPureReadOrSearchTool =
      !['edit', 'delete', 'move', 'execute'].includes(declaredKind) &&
      !hasMutationFields &&
      (declaredKind === 'read' ||
        declaredKind === 'search' ||
        (Boolean(rawObj) &&
          /^(read|read_file|view_file|view_file_outline|view_code_item|list_dir|glob|find_by_name|grep|grep_search|search)$/i.test(
            toolName
          )));

    const isPureReadOnlyWebOrMcpTool =
      !isPureReadOrSearchTool && !hasMutationFields && isPureReadOnlyLookupTool(toolName, declaredKind, rawObj);

    const isEditOrWriteTool =
      declaredKind === 'edit' ||
      (Boolean(rawObj) && /^(edit|edit_file|replace|write|write_file|create_file)$/i.test(toolName));

    const isDeleteOrMoveTool =
      declaredKind === 'delete' ||
      declaredKind === 'move' ||
      /^(delete|remove|rm|unlink|move|rename)/i.test(toolName);

    const commandKind = declaredKind === 'execute' || isShellToolName(toolName);
    const customCwd =
      rawObj && (rawObj.cwd ?? rawObj.Cwd ?? rawObj.DirectoryPath ?? rawObj.WorkingDirectory);
    const hasOutOfScopeCwd =
      typeof customCwd === 'string' && customCwd.trim() !== '' && !isPathWithinWorkspace(customCwd, cwd);
    const hasOutOfScopeLocations = Boolean(
      params.toolCall.locations?.some((loc) => !loc?.path || !isPathWithinWorkspace(loc.path, cwd))
    );
    const geminiPolicy = inspectGeminiPathPolicy(rawSerialized, candidatePaths, cwd);
    const isMutatingToolOperation =
      isEditOrWriteTool ||
      isDeleteOrMoveTool ||
      (hasMutationFields && !commandKind) ||
      (commandKind && isMutatingShellCommand(command));

    let withinWorkspace =
      !hasOutOfScopeCwd &&
      !hasOutOfScopeLocations &&
      candidatePaths.every((p) => isPathWithinWorkspace(p, cwd));

    const explicitAskRule = Boolean(screening.matchedRule && screening.verdict === 'force_ask');
    let hardHumanFloor = false;
    let hardHumanFloorReason: string | undefined;

    if (
      sensitiveTarget(rawSerialized) ||
      candidatePaths.some((p) => sensitiveTarget(p)) ||
      geminiPolicy.tier === 'forbidden'
    ) {
      screening.verdict = 'deny';
      screening.riskLevel = 'critical';
      screening.commandPrefix = undefined;
      screening.explanation.risk =
        geminiPolicy.tier === 'forbidden' && geminiPolicy.reason
          ? geminiPolicy.reason
          : '完整工具参数涉及敏感凭据、密钥或私有认证状态文件，客户端硬性拒绝';
    } else if (
      (geminiPolicy.tier === 'readonly_official' || geminiPolicy.tier === 'unknown_gemini') &&
      isMutatingToolOperation
    ) {
      screening.verdict = 'deny';
      screening.riskLevel = 'critical';
      screening.commandPrefix = undefined;
      screening.explanation.risk =
        geminiPolicy.tier === 'readonly_official'
          ? '该路径属于 .gemini 官方只读数据/历史或受控配置区（请通过官方 agy CLI 管理），客户端禁止直接修改或写入'
          : '该路径位于 .gemini 根目录或未白名单内部状态区，客户端禁止直接写入或修改';
    } else if (geminiPolicy.tier === 'unknown_gemini' && screening.verdict !== 'deny') {
      screening.verdict = 'force_ask';
      screening.riskLevel = 'high';
      screening.commandPrefix = undefined;
      screening.explanation.risk = '目标位于 .gemini 未分类子目录，转交人工核对确认不含凭据后再读取';
      hardHumanFloor = true;
      hardHumanFloorReason = screening.explanation.risk;
    } else if (geminiPolicy.tier === 'user_custom' && isMutatingToolOperation && screening.verdict !== 'deny') {
      screening.verdict = 'force_ask';
      screening.riskLevel = 'medium';
      screening.commandPrefix = undefined;
      screening.explanation.risk = '目标位于 .gemini 用户自定义规则/技能/插件目录，修改全局配置前请人工核对确认';
      hardHumanFloor = true;
      hardHumanFloorReason = screening.explanation.risk;
    } else if (screening.verdict !== 'deny') {
      if (isPureReadOrSearchTool) {
        if (!explicitAskRule) {
          screening.verdict = 'auto_approve';
          screening.riskLevel = 'safe';
          screening.commandPrefix = declaredKind === 'search' ? 'search' : 'read';
          screening.explanation.risk =
            geminiPolicy.tier === 'readonly_official'
              ? '纯只读查阅 .gemini 官方只读数据/历史/内置文档，不含凭据且零写入'
              : geminiPolicy.tier === 'user_custom'
                ? '纯只读查阅 .gemini 用户自定义插件/技能/规则/日志，不含凭据'
                : '纯只读文件/代码检索操作，不含敏感凭据路径，已安全放行';
        }
      } else if (isPureReadOnlyWebOrMcpTool) {
        if (hasOutOfScopeLocations || hasOutOfScopeCwd) {
          screening.verdict = 'force_ask';
          screening.riskLevel = 'high';
          screening.commandPrefix = undefined;
          screening.explanation.risk = '只读工具携带工作区外路径参数，必须人工确认';
          hardHumanFloor = true;
          hardHumanFloorReason = screening.explanation.risk;
        } else if (!explicitAskRule) {
          screening.verdict = 'auto_approve';
          screening.riskLevel = 'safe';
          screening.commandPrefix = buildSafeToolPrefix(toolName, declaredKind, true);
          screening.explanation.risk = '纯只读文档/网络/MCP 检索查询操作，不含写入或凭据访问，已安全放行';
        }
      } else if (isEditOrWriteTool) {
        const primaryTarget = candidatePaths[0] || '';
        const allWithinWorkspace =
          Boolean(primaryTarget) &&
          candidatePaths.every((p) => isPathWithinWorkspace(p, cwd)) &&
          !candidatePaths.some((p) => /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(p)) &&
          !candidatePaths.some((p) => /\.(?:exe|bat|cmd|ps1|vbs|vbe|wsf|wsh|msi|dll|sys|reg|sh|bash|zsh|command|pkg|dmg|app|dylib|plist)$/i.test(p));
        withinWorkspace = allWithinWorkspace;

        if (allWithinWorkspace && !explicitAskRule) {
          screening.verdict = 'grey_zone';
          screening.riskLevel = 'medium';
          const isWriteOp =
            /^(write|write_file|create_file)$/i.test(toolName) || /^(write|write_file|create_file)$/i.test(rawTitle);
          screening.commandPrefix = isWriteOp ? 'write_file (当前工作区)' : 'edit_file (当前工作区)';
          screening.explanation.risk = '修改当前工作区内的源码/文档文件，支持外部 AI 复核、本会话前缀放行或 Approve for me 托管';
        } else {
          screening.verdict = 'force_ask';
          screening.riskLevel = 'high';
          screening.commandPrefix = undefined;
          screening.explanation.risk = '涉及跨工作区文件写入、可执行脚本或缺少明确路径，必须人工确认';
          hardHumanFloor = true;
          hardHumanFloorReason = screening.explanation.risk;
        }
      } else if (isDeleteOrMoveTool) {
        screening.verdict = 'force_ask';
        screening.riskLevel = 'high';
        screening.commandPrefix = undefined;
        screening.explanation.risk = '涉及删除或移动文件/资源，必须人工确认';
        hardHumanFloor = true;
        hardHumanFloorReason = screening.explanation.risk;
      } else if (commandKind) {
        const explicitCommand =
          typeof raw === 'string' ||
          Boolean(
            rawObj &&
              (typeof rawObj.command === 'string' ||
                typeof rawObj.cmd === 'string' ||
                typeof rawObj.CommandLine === 'string')
          );
        const allowedMetaKeys = new Set([
          'command',
          'cmd',
          'CommandLine',
          'toolName',
          'description',
          'toolSummary',
          'WaitMsBeforeAsync',
          'IsDaemon',
          'cwd',
          'Cwd',
          'DirectoryPath',
          'WorkingDirectory',
          'timeout',
          'timeoutMs',
        ]);
        const extraFields = Boolean(rawObj && Object.keys(rawObj).some((key) => !allowedMetaKeys.has(key)));

        if (!explicitCommand || extraFields || hasOutOfScopeCwd || hasOutOfScopeLocations) {
          screening.verdict = 'force_ask';
          screening.riskLevel = 'high';
          screening.commandPrefix = undefined;
          screening.explanation.risk = '终端命令包含附加文件参数或跨工作区目录，必须人工确认';
          hardHumanFloor = true;
          hardHumanFloorReason = screening.explanation.risk;
        } else {
          const parsedCmd = parseShellCommand(command.slice(0, 32_768));
          const floor = assessShellHighRiskFloor(command, parsedCmd);
          if (floor.hardFloor) {
            hardHumanFloor = true;
            hardHumanFloorReason = floor.reason;
          } else if (
            screening.verdict === 'force_ask' &&
            !explicitAskRule &&
            this.config.mode === 'hybrid' &&
            this.isExternalReviewerReady()
          ) {
            // 三段式 Codex Guardian：未命中 Stage 1 本地快筛且未触及高危底线的命令/只读脚本，统一转交 Stage 2 外部 AI 复核
            screening.verdict = 'grey_zone';
            screening.riskLevel = isReadOnlyScriptReviewCandidate(command) ? 'medium' : screening.riskLevel;
            screening.explanation.risk = isReadOnlyScriptReviewCandidate(command)
              ? '只读统计/分析脚本已转交外部 AI 复核代码用意与安全性'
              : '未在内部规则直接通过，已转交外部 AI 复核代码用意与风险';
          }
        }
      } else {
        // 非 Shell 结构化扩展 / MCP / other / fetch 工具：区分高危/SSRF 与常规灰区
        const hasHiddenShellCmd = Boolean(
          rawObj &&
            (typeof rawObj.command === 'string' ||
              typeof rawObj.cmd === 'string' ||
              typeof rawObj.CommandLine === 'string')
        );
        if (hasUnsafeNetworkOrLocalUrl(rawObj)) {
          screening.verdict = 'force_ask';
          screening.riskLevel = 'high';
          screening.commandPrefix = undefined;
          screening.explanation.risk = '工具参数指向本机/内网地址或非安全协议（防 SSRF），必须人工确认';
          hardHumanFloor = true;
          hardHumanFloorReason = screening.explanation.risk;
        } else if (
          hasHiddenShellCmd ||
          isDestructiveOrPrivilegedToolName(toolName) ||
          hasOutOfScopeCwd ||
          hasOutOfScopeLocations ||
          explicitAskRule
        ) {
          screening.verdict = 'force_ask';
          screening.riskLevel = 'high';
          screening.commandPrefix = undefined;
          if (!explicitAskRule) {
            screening.explanation.risk = '该扩展工具涉及破坏性、提权、隐藏终端命令或跨工作区操作，必须人工确认';
            hardHumanFloor = true;
            hardHumanFloorReason = screening.explanation.risk;
          }
        } else {
          screening.verdict = 'grey_zone';
          screening.riskLevel = 'medium';
          screening.commandPrefix = buildSafeToolPrefix(toolName, declaredKind, false);
          screening.explanation.risk = '非纯只读外部/MCP 工具调用，可由外部 AI 复核，或按工具名人工/会话放行';
        }
      }
    }

    if (this.config.mode === 'hybrid') {
      this.recordBurstRequest(params.sessionId);
    }

    const card: PendingApprovalRequest = {
      requestId: randomUUID(),
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      toolName,
      commandOrSummary: command,
      cwd,
      createdAt: new Date(this.now()).toISOString(),
      riskLevel: screening.riskLevel,
      commandPrefix: screening.commandPrefix,
      explanation: screening.explanation,
      screeningSource:
        this.config.mode === 'manual' ? 'manual-mode' : screening.matchedRule ? 'regex-rule' : 'local-ast',
    };

    return new Promise((resolvePromise, rejectPromise) => {
      const item: Pending = {
        card,
        params,
        screen: screening,
        withinWorkspace,
        explicitAskRule,
        hardHumanFloor,
        hardHumanFloorReason,
        conversationContext,
        resolve: resolvePromise,
        reject: rejectPromise,
        started: this.now(),
        reviewing: false,
      };
      // 先登记待审项，再开始三段式自动审批流程。人工选择、撤销和外部复审据此查找同一请求。
      this.pending.set(card.requestId, item);
      void this.initialDecision(item).catch(() => {
        if (this.pending.has(card.requestId)) {
          card.explanation.risk = '审查发生异常，必须人工确认';
          this.emit('requested', structuredClone(card));
        }
      });
    });
  }

  /**
   * 仿 Codex Approve for me 三段式审查流水线：
   * Stage 1（内部规则：硬拒绝 / manual 直通 / askPatterns / 本地快筛自动通过）
   * → Stage 2（所有未通过 Stage 1 的操作转交外部 AI 复核）
   * → Stage 3（AI 未放行、触及高危底线或未连接外部复核时交人工确认）。
   */
  private async initialDecision(item: Pending): Promise<void> {
    // ── Stage 1A: 绝对红线硬拒绝（0ms，绝不放行、绝不外发给第三方模型）──
    if (item.screen.verdict === 'deny') {
      this.finish(item, false, 'denied', 'local-rule', item.screen.explanation.risk);
      return;
    }

    // ── Stage 1B: 纯人工模式（除 1A 硬拒绝外全部直达 Stage 3）──
    if (this.config.mode === 'manual') {
      if (this.pending.has(item.card.requestId)) this.emit('requested', structuredClone(item.card));
      return;
    }

    // ── Stage 1C: 用户显式「总是询问」规则（尊重用户强制拦截意愿，直达 Stage 3）──
    if (item.explicitAskRule) {
      if (this.pending.has(item.card.requestId)) this.emit('requested', structuredClone(item.card));
      return;
    }

    // ── Stage 1D: 内部规则确定性快速通过（0ms，0 API 消耗）──
    if (!item.hardHumanFloor && item.screen.verdict !== 'force_ask') {
      if ((this.cache.get(this.key(item)) || 0) > this.now()) {
        this.finish(item, true, 'auto_approved', 'cache-hit', '命中同会话、工作区与完整工具参数缓存');
        return;
      }
      if (
        item.card.commandPrefix &&
        this.prefixes.get(`${item.card.sessionId}\0${item.card.cwd}`)?.has(item.card.commandPrefix)
      ) {
        this.finish(item, true, 'auto_approved', 'session-prefix', '命中本会话经确认的命令前缀');
        return;
      }
    }
    if (item.screen.verdict === 'auto_approve') {
      this.finish(item, true, 'auto_approved', 'local-rule', item.screen.explanation.risk);
      if (this.config.mode === 'hybrid') {
        this.recordGuardAutoApproval(item.card.sessionId, 'local-burst-guard', item.card.commandOrSummary);
      }
      return;
    }
    const execMode = this.sessionModes.get(item.card.sessionId) || 'default';
    const isWorkspaceEdit = /^(?:edit_file|write_file)\s*\(/.test(item.card.commandPrefix || '');
    if (isWorkspaceEdit && !item.hardHumanFloor && (execMode === 'accept-edits' || execMode === 'auto')) {
      const reason = `会话处于 ${execMode} 模式，已核验为当前工作区源码/文档编辑并自动放行`;
      this.finish(item, true, 'auto_approved', 'local-rule', reason);
      if (this.config.mode === 'hybrid') {
        this.recordGuardAutoApproval(item.card.sessionId, 'local-burst-guard', item.card.commandOrSummary);
      }
      return;
    }

    // ── Stage 2: 外部 AI 复核（所有未在 Stage 1 通过的请求，在 hybrid + 连通外部模型时统一送审）──
    if (this.config.mode === 'hybrid') {
      if (this.isExternalReviewerReady()) {
        if (await this.review(item)) {
          return;
        }
      } else {
        // 未连接外部复核模型时严禁伪装 AI 代审自动放行：保留原始风险说明，附加基础规则回退提示
        const baseRisk = item.card.explanation.risk?.trim();
        const suffix = '未连接外部复核模型，当前按基础规则模式转交人工确认；连接外部复核后方可开启 AI 代审';
        item.card.explanation.risk = baseRisk ? `${baseRisk}（${suffix}）` : suffix;
      }
    }

    // ── Stage 3: 人工内联确认（Stage 1 未通过且 Stage 2 未放行 / 触及高危底线 / 规则模式）──
    if (this.pending.has(item.card.requestId)) this.emit('requested', structuredClone(item.card));
  }

  private async review(item: Pending): Promise<boolean> {
    if (item.reviewing) throw new Error('该请求正在复核');
    if (
      !this.isExternalReviewerReady() ||
      this.config.mode !== 'hybrid' ||
      item.screen.verdict === 'deny' ||
      item.explicitAskRule
    ) {
      item.card.explanation.risk = '未启用独立 AI 复核，或此操作必须人工确认';
      return false;
    }
    item.reviewing = true;
    const start = this.now();
    const revision = this.configRevision;
    const reviewerConfig = structuredClone(this.config.externalReviewer);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = Math.min(
        Math.max(reviewerConfig.timeoutMs || EXTERNAL_REVIEWER_DEFAULTS.timeoutMs, 100),
        60_000
      );
      const review: AiReviewResult = await Promise.race([
        this.reviewer(item.card.commandOrSummary, item.card.cwd, reviewerConfig, {
          toolName: item.card.toolName,
          executionMode: this.sessionModes.get(item.card.sessionId) || 'default',
          intentSummary: item.card.explanation.meaning,
          localRiskLevel: item.screen.riskLevel,
          localRiskReason: item.hardHumanFloorReason || item.screen.explanation.risk,
          withinWorkspace: item.withinWorkspace,
          conversationContext: item.conversationContext,
          hardHumanFloor: item.hardHumanFloor,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`复核超时（超过 ${timeout}ms）`)), timeout);
        }),
      ]);
      const elapsedMs = Math.max(0, Math.round(review.latencyMs || this.now() - start));
      const usageEvent: ExternalReviewerUsageRecordInput = {
        sessionId: item.card.sessionId,
        provider: reviewerConfig.provider,
        endpoint: reviewerConfig.endpoint,
        modelId: reviewerConfig.model,
        outcome: review.recommended,
        latencyMs: elapsedMs,
        usage: review.usage,
        timestamp: this.now(),
      };
      this.emit('external-review-usage', usageEvent);

      // 等待远端时用户可能已处理请求或更改配置。先核对待审表和版本号，再采用返回的建议。
      if (!this.pending.has(item.card.requestId)) return true;
      if (revision !== this.configRevision || this.config.mode !== 'hybrid') {
        item.card.explanation.risk = '审批配置已变更，请按当前规则人工确认';
        return false;
      }

      item.card.screeningSource = 'ai-reviewer-fallback';

      // 防御纵深：触及本地高危底线（管道注入、提权、递归删除、SSRF、越区写删等）时，
      // 外部 AI 仅提供风险评估建议，绝不允许静默自动放行，必须落到 Stage 3 由人工最终确认。
      if (review.recommended === 'approve' && ['safe', 'low'].includes(review.riskLevel)) {
        if (!item.hardHumanFloor) {
          item.card.aiSuggestion = {
            ...review,
            model: reviewerConfig.model,
            isError: false,
          };
          this.recordGuardAutoApproval(item.card.sessionId, 'external-ai', item.card.commandOrSummary);
          this.finish(item, true, 'ai_approved', 'external-ai', review.reason);
          return true;
        }
        const floorMsg = item.hardHumanFloorReason || '命中本地高危安全底线，此类操作必须人工确认';
        item.card.aiSuggestion = {
          ...review,
          recommended: 'ask',
          reason: `${floorMsg}（外部 AI 评估：${review.reason}）`,
          model: reviewerConfig.model,
          isError: false,
        };
        item.card.explanation.risk = floorMsg;
        return false;
      }

      item.card.aiSuggestion = {
        ...review,
        model: reviewerConfig.model,
        isError: false,
      };
      // 若外部 AI 判定了更高风险，同步抬高卡片风险徽标以便人工重点关注
      const riskOrder: Record<PendingApprovalRequest['riskLevel'], number> = {
        safe: 0,
        low: 1,
        medium: 2,
        high: 3,
        critical: 4,
      };
      if (riskOrder[review.riskLevel] > riskOrder[item.card.riskLevel]) {
        item.card.riskLevel = review.riskLevel;
      }
      item.card.explanation.risk = item.hardHumanFloor && item.hardHumanFloorReason
        ? item.hardHumanFloorReason
        : review.reason;
      return false;
    } catch (error) {
      const elapsedMs = Math.max(0, this.now() - start);
      const usageEvent: ExternalReviewerUsageRecordInput = {
        sessionId: item.card.sessionId,
        provider: reviewerConfig.provider,
        endpoint: reviewerConfig.endpoint,
        modelId: reviewerConfig.model,
        outcome: 'error',
        latencyMs: elapsedMs,
        usage: error instanceof IndependentModelCallError ? error.usage : undefined,
        timestamp: this.now(),
      };
      this.emit('external-review-usage', usageEvent);

      const rawMsg = error instanceof Error ? error.message.trim() : '';
      const maskedMsg =
        rawMsg && reviewerConfig.apiKey
          ? rawMsg.split(reviewerConfig.apiKey).join('***')
          : rawMsg;
      const reason =
        error instanceof IndependentModelLimitError
          ? maskedMsg
          : maskedMsg
            ? `外部复核失败（${maskedMsg.slice(0, 180)}），已回退人工确认`
            : '独立 AI 复核不可用或超时，已回退人工确认';
      item.card.aiSuggestion = {
        recommended: 'ask',
        reason,
        latencyMs: elapsedMs,
        model: reviewerConfig.model,
        isError: true,
      };
      item.card.screeningSource = 'ai-reviewer-fallback';
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      item.reviewing = false;
    }
  }

  async submitDecision(submission: ApprovalDecisionSubmission): Promise<void> {
    const item = this.pending.get(submission.requestId);
    if (!item || item.card.sessionId !== submission.sessionId) throw new Error('审批请求不存在或会话不匹配');
    if (item.reviewing) throw new Error('审批正在复核，请稍候');

    if (submission.decision === 'approve_for_me_ai') {
      if (item.screen.verdict === 'deny') {
        throw new Error('该操作涉及敏感凭据或受保护状态，禁止放行');
      }
      const reviewerReady = this.isExternalReviewerReady();
      if (item.card.commandPrefix && !item.hardHumanFloor && item.screen.verdict !== 'force_ask') {
        const prefixKey = `${item.card.sessionId}\0${item.card.cwd}`;
        const prefixes = this.prefixes.get(prefixKey) || new Set<string>();
        prefixes.add(item.card.commandPrefix);
        this.prefixes.set(prefixKey, prefixes);
      }

      if (reviewerReady) {
        // 已正常连接外部复核：切至 hybrid（AI 代审）并对当前未触及询问规则的请求重新提交外部 AI 复核
        this.enableSessionDelegation(item.card.sessionId, item.card.cwd);
        if (this.config.mode !== 'hybrid') {
          this.config = { ...this.config, mode: 'hybrid' };
          this.configRevision++;
          this.emit('config-updated', this.getConfig());
        }
        if (!item.explicitAskRule && !item.hardHumanFloor) {
          if (await this.review(item)) {
            return;
          }
          if (!this.pending.has(item.card.requestId)) return;
          if (item.card.aiSuggestion?.recommended === 'deny') {
            this.emit('requested', structuredClone(item.card));
            return;
          }
        }
        this.finish(
          item,
          true,
          'user_approved',
          'user-inline',
          '用户点击 Approve for me 放行本次操作，并开启 AI 代审外部复核托管'
        );
        this.recordGuardAutoApproval(item.card.sessionId, 'user-delegated', item.card.commandOrSummary);
        return;
      }

      // 未连接外部复核：禁止伪开启 AI 代审，仅切换至基础「仅规则」机制并放行本次操作（同时记住安全前缀）
      if (this.config.mode !== 'rules-only') {
        this.config = { ...this.config, mode: 'rules-only' };
        this.configRevision++;
        this.emit('config-updated', this.getConfig());
      }
      this.finish(
        item,
        true,
        'user_approved',
        'user-inline',
        '未连接外部复核模型，已放行本次操作并切换至基础规则模式（连接外部复核后可开启 AI 代审）'
      );
      return;
    }

    if (submission.decision === 'reject_with_feedback') {
      this.finish(
        item,
        false,
        'rejected_with_feedback',
        'user-inline',
        '用户拒绝了操作',
        submission.feedbackText?.slice(0, 2000)
      );
      return;
    }

    if (submission.decision !== 'allow_once' && submission.decision !== 'allow_session_prefix') {
      throw new Error('无效的审批动作');
    }

    if (submission.decision === 'allow_session_prefix') {
      if (!item.card.commandPrefix || submission.allowedPrefix !== item.card.commandPrefix || item.screen.verdict === 'force_ask') {
        throw new Error('此请求不支持安全的会话前缀放行');
      }
      const key = `${item.card.sessionId}\0${item.card.cwd}`;
      const prefixes = this.prefixes.get(key) || new Set<string>();
      prefixes.add(item.card.commandPrefix);
      this.prefixes.set(key, prefixes);
    }

    this.finish(
      item,
      true,
      'user_approved',
      'user-inline',
      submission.decision === 'allow_once' ? '用户仅允许此次操作' : '用户允许本会话同类前缀'
    );
  }

  /** 汇合各类审批结果。审计记录成功后才向 ACP 返回选择。缺少相应的一次性选项时返回取消。 */
  private finish(
    item: Pending,
    allow: boolean,
    verdict: ApprovalAuditEntry['verdict'],
    source: ApprovalAuditEntry['decisionSource'],
    reason: string,
    feedbackText?: string
  ): void {
    if (!this.pending.has(item.card.requestId)) return;
    // 永远选择 allow_once，前缀与缓存由客户端控制，不扩大为官方 allow_always。
    const option = item.params.options.find((opt) => opt.kind === (allow ? 'allow_once' : 'reject_once'));
    const actualAllow = allow && !!option;
    const entry: ApprovalAuditEntry = {
      id: randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
      sessionId: item.card.sessionId,
      toolCallId: item.card.toolCallId,
      cwd: item.card.cwd,
      toolName: item.card.toolName,
      commandOrSummary: item.card.commandOrSummary,
      modeAtDecision: this.config.mode,
      verdict: allow && !option ? 'denied' : verdict,
      decisionSource: source,
      riskLevel: item.card.riskLevel,
      latencyMs: this.now() - item.started,
      reason: allow && !option ? '官方未提供单次允许选项，已安全取消' : reason,
      feedbackText,
    };
    // 审计失败不能静默授权。
    try {
      this.options.store.append('audit.jsonl', entry);
    } catch {
      this.pending.delete(item.card.requestId);
      item.resolve({ outcome: { outcome: 'cancelled' } });
      this.emit('resolved', { requestId: item.card.requestId, sessionId: item.card.sessionId });
      throw new Error('审计日志写入失败，已取消授权');
    }
    this.pending.delete(item.card.requestId);
    if (actualAllow && (verdict === 'auto_approved' || verdict === 'ai_approved') && this.config.cacheTtlHours > 0) {
      if (this.cache.size >= 2000) this.cache.clear();
      this.cache.set(this.key(item), this.now() + this.config.cacheTtlHours * 3600000);
    }
    item.resolve({ outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
    this.emit('audit', entry);
    this.emit('resolved', { requestId: item.card.requestId, sessionId: item.card.sessionId });
    if (feedbackText) this.emit('feedback', { sessionId: item.card.sessionId, text: feedbackText });
  }

  /** 关闭会话时解除该会话的等待、前缀和委托，并清除审批缓存，以免下次恢复时沿用旧结论。 */
  cancelSession(sessionId: string): void {
    for (const item of [...this.pending.values()]) {
      if (item.card.sessionId === sessionId) {
        this.pending.delete(item.card.requestId);
        item.resolve({ outcome: { outcome: 'cancelled' } });
        this.emit('resolved', { requestId: item.card.requestId, sessionId });
      }
    }
    for (const key of this.prefixes.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.prefixes.delete(key);
    }
    for (const key of this.sessionDelegated) {
      if (key.startsWith(`${sessionId}\0`)) this.sessionDelegated.delete(key);
    }
    this.burstTrackers.delete(sessionId);
    this.cache.clear();
  }

  dispose(): void {
    for (const item of [...this.pending.values()]) this.cancelSession(item.card.sessionId);
    this.sessionDelegated.clear();
    this.sessionModes.clear();
    this.burstTrackers.clear();
  }
}

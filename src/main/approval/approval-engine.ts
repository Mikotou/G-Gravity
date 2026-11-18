import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AcpRequestPermissionParams, AcpRequestPermissionResult, AgentExecutionMode } from '../../shared/acp-protocol';
import type {
  ApprovalAuditEntry,
  ApprovalDecisionSubmission,
  ApproveForMeConfig,
  DeterministicScreeningResult,
  PendingApprovalRequest,
} from '../../shared/approval-contract';
import { ClientStore } from '../storage/client-store';
import { compileSafePattern, screenCommand, sensitiveTarget } from './shell-screening';
import {
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
  cacheTtlHours: 1,
  allowPatterns: [],
  askPatterns: [],
  denyPatterns: [],
  externalReviewer: {
    enabled: false,
    provider: 'gemini-api-key',
    endpoint: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash-lite',
    timeoutMs: 2500,
  },
};

interface Pending {
  card: PendingApprovalRequest;
  params: AcpRequestPermissionParams;
  screen: DeterministicScreeningResult;
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
    const base = resolve(workspaceCwd);
    const resolved = resolve(base, targetPath);
    const baseCmp = process.platform === 'win32' ? base.toLowerCase() : base;
    const targetCmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const rel = relative(baseCmp, targetCmp);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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

  /** 把会话、目录、原始工具调用和审批配置一并计入缓存键，限制已有结论可以复用的范围。 */
  private key(item: Pending): string {
    return createHash('sha256')
      .update(JSON.stringify([item.card.sessionId, item.card.cwd, item.card.toolName, item.params.toolCall, this.config]))
      .digest('hex');
  }

  /** 调用者等待最终的 ACP 选项。界面显示的说明和风险由完整输入、候选路径及执行类型共同推导。 */
  requestPermission(params: AcpRequestPermissionParams, cwd: string): Promise<AcpRequestPermissionResult> {
    if (!params?.sessionId || !params.toolCall?.toolCallId || !Array.isArray(params.options)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const raw = params.toolCall.rawInput;
    const rawObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const declaredKind = (params.toolCall.kind || '').toLowerCase();
    const toolName =
      rawObj && typeof rawObj.toolName === 'string'
        ? rawObj.toolName
        : params.toolCall.kind || params.toolCall.title || '未知工具';

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

    const isEditOrWriteTool =
      Boolean(rawObj) &&
      (declaredKind === 'edit' || /^(edit|edit_file|replace|write|write_file|create_file)$/i.test(toolName));

    if (sensitiveTarget(rawSerialized) || candidatePaths.some((p) => sensitiveTarget(p))) {
      screening.verdict = 'deny';
      screening.riskLevel = 'critical';
      screening.explanation.risk = '完整工具参数涉及敏感凭据或受保护目录';
    } else if (screening.verdict !== 'deny') {
      if (isPureReadOrSearchTool) {
        if (!screening.matchedRule || screening.verdict !== 'force_ask') {
          screening.verdict = 'auto_approve';
          screening.riskLevel = 'safe';
          screening.commandPrefix = declaredKind === 'search' ? 'search' : 'read';
          screening.explanation.risk = '纯只读文件/代码检索操作，不含敏感凭据路径，已安全放行';
        }
      } else if (isEditOrWriteTool) {
        const primaryTarget = candidatePaths[0] || '';
        const allWithinWorkspace =
          Boolean(primaryTarget) &&
          candidatePaths.every((p) => isPathWithinWorkspace(p, cwd)) &&
          !candidatePaths.some((p) => /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(p)) &&
          !candidatePaths.some((p) => /\.(?:exe|bat|cmd|ps1|vbs|vbe|wsf|wsh|msi|dll|sys|reg|sh)$/i.test(p));

        if (allWithinWorkspace && (!screening.matchedRule || screening.verdict !== 'force_ask')) {
          screening.verdict = 'grey_zone';
          screening.riskLevel = 'medium';
          screening.commandPrefix = /^(write|write_file|create_file)$/i.test(toolName)
            ? 'write_file (当前工作区)'
            : 'edit_file (当前工作区)';
          screening.explanation.risk = '修改当前工作区内的源码/文档文件，支持本会话前缀放行或 AI 代审托管';
        } else {
          screening.verdict = 'force_ask';
          screening.commandPrefix = undefined;
          screening.explanation.risk = '涉及跨工作区文件写入、可执行脚本或缺少明确路径，已解析代码用意并转交人工确认';
        }
      } else {
        const commandKind = /^(execute|run_command|bash|powershell|command|terminal)$/i.test(toolName);
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
        const customCwd =
          rawObj && (rawObj.cwd ?? rawObj.Cwd ?? rawObj.DirectoryPath ?? rawObj.WorkingDirectory);
        const hasOutOfScopeCwd =
          typeof customCwd === 'string' && customCwd.trim() !== '' && !isPathWithinWorkspace(customCwd, cwd);
        const hasOutOfScopeLocations = Boolean(
          params.toolCall.locations?.some((loc) => !loc?.path || !isPathWithinWorkspace(loc.path, cwd))
        );

        if (!commandKind || !explicitCommand || extraFields || hasOutOfScopeCwd || hasOutOfScopeLocations) {
          screening.verdict = 'force_ask';
          screening.commandPrefix = undefined;
          screening.explanation.risk = '涉及文件写入/编辑或特殊工具参数，已解析上方明确代码用意并转交人工确认';
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
        resolve: resolvePromise,
        reject: rejectPromise,
        started: this.now(),
        reviewing: false,
      };
      // 先登记待审项，再开始可能立即完成的自动审批。人工选择、撤销和外部复审据此查找同一请求。
      this.pending.set(card.requestId, item);
      void this.initialDecision(item).catch(() => {
        if (this.pending.has(card.requestId)) {
          card.explanation.risk = '审查发生异常，必须人工确认';
          this.emit('requested', structuredClone(card));
        }
      });
    });
  }

  /** 先处理明确禁止的操作。其余请求依次检查记忆、规则和混合模式，仍未决的才发布到界面。 */
  private async initialDecision(item: Pending): Promise<void> {
    if (item.screen.verdict === 'deny') {
      this.finish(item, false, 'denied', 'local-rule', item.screen.explanation.risk);
      return;
    }
    if (this.config.mode !== 'manual') {
      if (item.screen.verdict !== 'force_ask') {
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
      if (item.screen.verdict === 'grey_zone' && this.config.mode === 'hybrid') {
        if (this.config.externalReviewer.enabled) {
          if (await this.review(item)) {
            this.recordGuardAutoApproval(item.card.sessionId, 'external-ai', item.card.commandOrSummary);
            return;
          }
        } else {
          const delegated = this.isSessionDelegated(item.card.sessionId, item.card.cwd);
          const execMode = this.sessionModes.get(item.card.sessionId) || 'default';
          const burstActive = this.isBurstGuardActive(item.card.sessionId);
          const isWorkspaceEdit = /^(?:edit_file|write_file)\s*\(/.test(item.card.commandPrefix || '');

          if (
            (item.screen.riskLevel === 'low' && (delegated || execMode === 'auto' || burstActive)) ||
            (isWorkspaceEdit && (delegated || execMode === 'accept-edits' || execMode === 'auto'))
          ) {
            const reason = delegated
              ? '本会话已开启 Approve for me 智能托管，本地语义守卫核验低风险自动放行'
              : execMode === 'auto' || execMode === 'accept-edits'
                ? `会话处于 ${execMode} 模式，AI 代审本地语义守卫核验放行`
                : '检测到多命令密集运行，AI 代审批量守卫自动核验低风险命令放行';
            this.finish(item, true, 'auto_approved', 'local-rule', reason);
            this.recordGuardAutoApproval(
              item.card.sessionId,
              delegated ? 'user-delegated' : 'local-burst-guard',
              item.card.commandOrSummary
            );
            return;
          }
        }
      }
    }
    if (this.pending.has(item.card.requestId)) this.emit('requested', structuredClone(item.card));
  }

  private async review(item: Pending): Promise<boolean> {
    if (item.reviewing) throw new Error('该请求正在复核');
    if (
      !this.config.externalReviewer.enabled ||
      this.config.mode !== 'hybrid' ||
      item.screen.verdict === 'force_ask' ||
      item.screen.verdict === 'deny'
    ) {
      item.card.explanation.risk = '未启用独立 AI 复核，或此操作必须人工确认';
      return false;
    }
    item.reviewing = true;
    const start = this.now();
    const revision = this.configRevision;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = Math.min(Math.max(this.config.externalReviewer.timeoutMs || 2500, 100), 30000);
      const review: AiReviewResult = await Promise.race([
        this.reviewer(item.card.commandOrSummary, item.card.cwd, structuredClone(this.config.externalReviewer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('复核超时')), timeout);
        }),
      ]);
      // 等待远端时用户可能已处理请求或更改配置。先核对待审表和版本号，再采用返回的建议。
      if (!this.pending.has(item.card.requestId)) return true;
      if (revision !== this.configRevision || this.config.mode !== 'hybrid') {
        item.card.explanation.risk = '审批配置已变更，请按当前规则人工确认';
        return false;
      }
      item.card.aiSuggestion = review;
      item.card.screeningSource = 'ai-reviewer-fallback';
      if (review.recommended === 'approve' && ['safe', 'low'].includes(review.riskLevel)) {
        this.finish(item, true, 'ai_approved', 'external-ai', review.reason);
        return true;
      }
      item.card.explanation.risk = review.reason;
      return false;
    } catch (error) {
      item.card.aiSuggestion = {
        recommended: 'ask',
        reason:
          error instanceof IndependentModelLimitError
            ? error.message
            : '独立 AI 复核不可用或超时，已回退人工确认',
        latencyMs: this.now() - start,
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
      // 1. 激活当前会话的 Approve for me 智能批量托管，并确保全局切至 hybrid（AI 代审）档位（不清空已有会话前缀）
      this.enableSessionDelegation(item.card.sessionId, item.card.cwd);
      if (this.config.mode !== 'hybrid') {
        this.config = { ...this.config, mode: 'hybrid' };
        this.configRevision++;
        this.emit('config-updated', this.getConfig());
      }
      if (item.card.commandPrefix && item.screen.verdict !== 'force_ask') {
        const prefixKey = `${item.card.sessionId}\0${item.card.cwd}`;
        const prefixes = this.prefixes.get(prefixKey) || new Set<string>();
        prefixes.add(item.card.commandPrefix);
        this.prefixes.set(prefixKey, prefixes);
      }

      // 2. 若已配置外部独立复核模型且当前为灰区命令，优先尝试由独立模型给出审计结论
      if (this.config.externalReviewer.enabled && item.screen.verdict === 'grey_zone') {
        if (await this.review(item)) {
          this.recordGuardAutoApproval(item.card.sessionId, 'external-ai', item.card.commandOrSummary);
          return;
        }
        if (!this.pending.has(item.card.requestId)) return;
        if (item.card.aiSuggestion?.recommended === 'deny') {
          this.emit('requested', structuredClone(item.card));
          return;
        }
      }

      // 3. 放行当前待审操作并接管后续同类与低风险密集命令
      this.finish(
        item,
        true,
        'user_approved',
        'user-inline',
        '用户点击 Approve for me 放行本次操作，并开启本会话智能批量代审托管'
      );
      this.recordGuardAutoApproval(item.card.sessionId, 'user-delegated', item.card.commandOrSummary);
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

import { IndependentModelCallError, IndependentModelLimitError } from '../llm/external-llm-transport';
import { decisionCacheKey, type Pending } from './approval-request';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AcpRequestPermissionParams, AcpRequestPermissionResult, AgentExecutionMode } from '../../shared/acp-protocol';
import {
  EXTERNAL_REVIEWER_DEFAULTS, isExternalReviewerConnected, type ApprovalAuditEntry,
  type ApprovalGuardActivityEvent, type ApprovalReviewingEvent, type SessionApprovalGrantsSnapshot,
  type RevokeSessionApprovalGrantInput, type ApprovalDecisionSubmission, type ApprovalDecisionResult,
  type ApprovalMode, type ApproveForMeConfig, type DeterministicScreeningResult,
  type PendingApprovalRequest,
} from '../../shared/approval-contract';
import type { ExternalReviewerUsageRecordInput } from '../../shared/telemetry-contract';
import { ClientStore } from '../storage/client-store';
import { maskKnownSecret, redactSecretsForReviewer } from '../security/redaction';
import { approvalWorkspaceKey, SessionGrants } from './session-grants';
import { screenCommand } from './shell-screening';
import {
  applyGuardianPolicy, reviewWithIndependentModel,
  type Reviewer, type AiReviewResult,
} from './external-reviewer';

import { DEFAULT_APPROVAL_CONFIG } from '../../shared/approval-contract';
import { validatedApprovalConfig } from './approval-settings';
import { BurstGuard, BURST_WINDOW_MS } from './burst-guard';
import { classifyPermission } from './permission-classifier';
export { DEFAULT_APPROVAL_CONFIG } from '../../shared/approval-contract';


export type { ApprovalGuardActivityEvent } from '../../shared/approval-contract';

export interface ApprovalEngineOptions {
  getProfileId?: () => string;
  store: ClientStore;
  config?: Partial<ApproveForMeConfig>;
  reviewer?: Reviewer;
  now?: () => number;
}

class ApprovalAuditError extends Error {}
/** 将一次 ACP 权限询问转换为本地待审请求。自动规则、复审和用户选择都经 finish 回答同一个协议请求。 */
export class ApprovalEngine extends EventEmitter {
  private config: ApproveForMeConfig;
  private pending = new Map<string, Pending>();
  private cache = new Map<string, number>();
  private grants: SessionGrants;
  private sessionModes = new Map<string, AgentExecutionMode>();
  private burst = new BurstGuard(() => this.now(), (...args) => this.guardActivity(...args));
  private reviewer: Reviewer;
  private now: () => number;
  private configRevision = 0;
  private ruleRevision = 0;

  constructor(private options: ApprovalEngineOptions) {
    super();
    this.grants = new SessionGrants(options.store, () => this.profileId);
    this.reviewer = options.reviewer || reviewWithIndependentModel;
    this.now = options.now || Date.now;
    this.config = structuredClone(DEFAULT_APPROVAL_CONFIG);
    if (options.config) this.config = structuredClone(validatedApprovalConfig(this.config, options.config, true));
  }

  getConfig(): ApproveForMeConfig {
    const snapshot = structuredClone(this.config);
    snapshot.externalReviewer.hasApiKey = Boolean(snapshot.externalReviewer.apiKey?.trim());
    if (!snapshot.externalReviewer.hasApiKey) delete snapshot.externalReviewer.apiKey;
    return snapshot;
  }

  /** 判断当前外部复核是否已正常配置并连通（仅此时允许执行 AI 代审）。 */
  private isExternalReviewerReady(): boolean {
    return isExternalReviewerConnected(this.config.externalReviewer);
  }

  updateConfig(patch: Partial<ApproveForMeConfig>, beforeCommit?: (validated: ApproveForMeConfig) => void): ApproveForMeConfig {
    const next = validatedApprovalConfig(this.config, patch);
    beforeCommit?.(next);
    // 整份配置通过校验后才替换当前值。增加版本号使正在等待的外部复审能识别规则已变更。
    const rulesChanged = next.fastPassLowRiskDev !== this.config.fastPassLowRiskDev ||
      next.allowAlignedHighRiskPass !== this.config.allowAlignedHighRiskPass || next.alignedHighRiskMaxScore !== this.config.alignedHighRiskMaxScore ||
      next.enableSafeDownloadAutoApprove !== this.config.enableSafeDownloadAutoApprove ||
      next.maxDownloadSizeMB !== this.config.maxDownloadSizeMB ||
      (['allowPatterns', 'askPatterns', 'denyPatterns'] as const).some(field =>
        next[field].length !== this.config[field].length || next[field].some((pattern, index) => pattern !== this.config[field][index]));
    this.config = structuredClone(next);
    this.configRevision++;
    this.cache.clear();
    if (rulesChanged) {
      ++this.ruleRevision;
      for (const item of [...this.pending.values()]) {
        if (item.awaitingUser && !item.review) this.requestUser(item);
      }
    }
    return this.getConfig();
  }

  setSessionExecutionMode(sessionId: string, mode: AgentExecutionMode): void {
    this.sessionModes.set(sessionId, mode);
  }
  enableBurstGuard(id: string, durationMs?: number): void { this.burst.enableBurstGuard(id, durationMs); }
  resetTurnBurstCounter(id: string): void { this.burst.resetTurnBurstCounter(id); }
  private guardActivity(sessionId: string, kind: ApprovalGuardActivityEvent['kind'], message: string, activeCount: number): void {
    this.emit('guard-activity', { sessionId, kind, message, activeCount,
      timestamp: new Date(this.now()).toISOString() } satisfies ApprovalGuardActivityEvent);
  }

  isSessionDelegated(sessionId: string, cwd: string): boolean {
    return Boolean(this.grants.get(sessionId, cwd)?.delegation);
  }

  hasSessionGrants(sessionId: string, cwd: string): boolean { return Boolean(this.grants.get(sessionId, cwd)); }

  clearSessionGrants(sessionId: string, cwd?: string): void {
    this.grants.clear(sessionId, cwd);
    this.invalidateSessionDecisions(sessionId, cwd);
  }

  getSessionGrantsSnapshot(sessionId: string, cwd: string): SessionApprovalGrantsSnapshot {
    return this.grants.getSessionGrantsSnapshot(sessionId, cwd);
  }

  revokeSessionGrant(sessionId: string, cwd: string, input: RevokeSessionApprovalGrantInput): SessionApprovalGrantsSnapshot {
    if (input.sessionId !== sessionId) throw new Error('会话授权不匹配');
    const snapshot = this.grants.revokeSessionGrant(sessionId, cwd, input);
    this.invalidateSessionDecisions(sessionId, cwd);
    return snapshot;
  }

  private invalidateSessionDecisions(sessionId: string, cwd?: string): void {
    for (const item of this.pending.values()) {
      if (item.profileId === this.profileId && item.card.sessionId === sessionId &&
          (cwd === undefined || approvalWorkspaceKey(cwd) === approvalWorkspaceKey(item.card.cwd))) {
        item.revokedDuringReview = Boolean(item.review);
        item.batchReview = undefined;
        item.reviewRevision = undefined;
      }
    }
    for (const key of this.cache.keys()) if (key.startsWith(sessionId + '\0')) this.cache.delete(key);
  }

  sessionApprovalOverride(sessionId: string, cwd: string): 'hybrid' | 'rules-only' | undefined {
    const mode = this.grants.get(sessionId, cwd)?.delegation;
    return mode === 'hybrid' && !this.isExternalReviewerReady() ? 'rules-only' : mode;
  }

  private effectiveMode(sessionId: string, cwd: string): ApprovalMode {
    return this.sessionApprovalOverride(sessionId, cwd) ?? this.config.mode;
  }

  screen(command: string, cwd: string, toolName = 'run_command', rawInput?: unknown): DeterministicScreeningResult {
    return screenCommand(command, cwd, this.config, toolName, rawInput);
  }

  hasPendingForSession(sessionId: string): boolean {
    for (const item of this.pending.values()) if (item.card.sessionId === sessionId) return true;
    return false;
  }

  listPending(): PendingApprovalRequest[] {
    return [...this.pending.values()].map((item) => structuredClone(item.card));
  }

  listActiveReviews(): ApprovalReviewingEvent[] {
    return [...this.pending.values()].flatMap(item => item.profileId === this.profileId && item.review && !item.review.controller.signal.aborted
      ? [{ ...item.review.event }] : []);
  }

  listAwaitingUser(): PendingApprovalRequest[] {
    return [...this.pending.values()].filter(item => item.awaitingUser).map(item => structuredClone(item.card));
  }

  private get profileId(): string { return this.options.getProfileId?.() ?? 'default'; }

  private ownsPending(item: Pending): boolean {
    if (!this.pending.has(item.card.requestId)) return false;
    if (item.profileId === this.profileId) return true;
    this.pending.delete(item.card.requestId);
    item.resolve({ outcome: { outcome: 'cancelled' } });
    return false;
  }

  private requestUser(item: Pending, forceManual = false): void {
    if (!this.ownsPending(item)) return;
    if (item.ruleRevision !== this.ruleRevision) {
      this.pending.delete(item.card.requestId);
      this.emit('resolved', { requestId: item.card.requestId, sessionId: item.card.sessionId });
      // Re-evaluate the original ACP request and settle its original promise under the saved rules.
      this.screenPermission(item.params, item.card.cwd, item.conversationContext, item.rpcId, forceManual || !!item.manualTakeover).then(item.resolve, item.reject);
      return;
    }
    item.awaitingUser = true;
    this.emit('requested', structuredClone(item.card));
  }

  listAudit(limit = 100): ApprovalAuditEntry[] {
    return this.options.store.readTailLines<ApprovalAuditEntry>('audit.jsonl', Math.max(1, Math.min(limit, 1000))).reverse();
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
    conversationContext?: string,
    rpcId?: string | number
  ): Promise<AcpRequestPermissionResult> {
    return this.screenPermission(params, cwd, conversationContext, rpcId, false);
  }

  private screenPermission(
    params: AcpRequestPermissionParams, cwd: string, conversationContext: string | undefined,
    rpcId: string | number | undefined, forceManual: boolean
  ): Promise<AcpRequestPermissionResult> {
    if (!params?.sessionId || !params.toolCall?.toolCallId || !Array.isArray(params.options)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const mode = this.effectiveMode(params.sessionId, cwd);
    const classified = classifyPermission(params, cwd, this.config, mode, this.now());
    const { card } = classified;
    if (mode === 'hybrid') this.burst.recordBurstRequest(params.sessionId);
    return new Promise((resolvePromise, rejectPromise) => {
      const item: Pending = {
        profileId: this.profileId,
        rpcId,
        ...classified,
        params,
        manualTakeover: forceManual,
        conversationContext: conversationContext && redactSecretsForReviewer(conversationContext).slice(0, 2800),
        resolve: resolvePromise,
        reject: rejectPromise,
        started: this.now(),
        awaitingUser: false,
        ruleRevision: this.ruleRevision,
      };
      // 先登记待审项，再开始三段式自动审批流程。人工选择、撤销和外部复审据此查找同一请求。
      this.pending.set(card.requestId, item);
      void this.initialDecision(item, forceManual).catch(() => {
        if (this.pending.has(card.requestId)) {
          card.explanation.risk = '审查发生异常，必须人工确认';
          this.requestUser(item);
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
  private async initialDecision(item: Pending, forceManual: boolean, batchMode?: 'hybrid' | 'rules-only'): Promise<void> {
    const mode = batchMode ?? this.effectiveMode(item.card.sessionId, item.card.cwd);
    // ── Stage 1A: 绝对红线硬拒绝（0ms，绝不放行、绝不外发给第三方模型）──
    if (item.screen.verdict === 'deny') {
      this.finish(item, false, 'denied', 'local-rule', item.screen.explanation.risk);
      return;
    }

    if (forceManual) {
      this.requestUser(item, true);
      return;
    }

    const execMode = this.sessionModes.get(item.card.sessionId) || 'default';
    if (execMode === 'full-access' && item.turboEligible) {
      this.finish(item, true, 'auto_approved_turbo', 'turbo-mode', 'Turbo 模式已放行经核验的开发操作');
      return;
    }

    // A prefix is an explicit user choice, scoped to this session and screened workspace.
    const prefix = item.card.commandPrefix;
    if (prefix && !item.explicitAskRule && item.card.floorTier !== 'tier_a_immutable' &&
        this.grants.get(item.card.sessionId, item.card.cwd)?.prefixes.includes(prefix)) {
      this.finish(item, true, 'auto_approved', 'session-prefix', '命中本会话经确认的命令前缀');
      return;
    }

    // 其余请求在纯人工模式逐次询问。
    if (mode === 'manual') {
      this.requestUser(item);
      return;
    }

    // ── Stage 1C: 用户显式「总是询问」规则（尊重用户强制拦截意愿，直达 Stage 3）──
    if (item.explicitAskRule) {
      this.requestUser(item);
      return;
    }

    // ── Stage 1D: 内部规则确定性快速通过（0ms，0 API 消耗）──
    if (item.card.floorTier === 'standard' && item.screen.verdict !== 'force_ask') {
      if ((this.cache.get(decisionCacheKey(item, this.config)) || 0) > this.now()) {
        this.finish(item, true, 'auto_approved', 'cache-hit', '命中同会话、工作区与完整工具参数缓存');
        return;
      }
    }
    if (item.card.floorTier === 'standard' && item.screen.verdict === 'auto_approve') {
      this.finish(item, true, 'auto_approved', 'local-rule', item.screen.explanation.risk);
      return;
    }
    const isWorkspaceEdit = /^(?:edit_file|write_file)\s*\(/.test(item.card.commandPrefix || '');
    if (isWorkspaceEdit && item.card.floorTier === 'standard' && (execMode === 'accept-edits' || execMode === 'auto')) {
      const reason = `会话处于 ${execMode} 模式，已核验为当前工作区源码/文档编辑并自动放行`;
      this.finish(item, true, 'auto_approved', 'local-rule', reason);
      return;
    }

    // ── Stage 2: 外部 AI 复核（所有未在 Stage 1 通过的请求，在 hybrid + 连通外部模型时统一送审）──
    if (mode === 'hybrid') {
      if (this.isExternalReviewerReady()) {
        await this.review(item, false, Boolean(batchMode));
        return;
      } else {
        // 未连接外部复核模型时严禁伪装 AI 代审自动放行：保留原始风险说明，附加基础规则回退提示
        const baseRisk = item.card.explanation.risk?.trim();
        const suffix = '未连接外部复核模型，当前按基础规则模式转交人工确认；连接外部复核后方可开启 AI 代审';
        item.card.explanation.risk = baseRisk ? `${baseRisk}（${suffix}）` : suffix;
      }
    }

    // ── Stage 3: 人工内联确认（Stage 1 未通过且 Stage 2 未放行 / 触及高危底线 / 规则模式）──
    this.requestUser(item);
  }

  private async review(item: Pending, delegate = false, batch = false): Promise<ApprovalDecisionResult> {
    if (item.review) throw new Error('该请求正在复核');
    if (
      !this.isExternalReviewerReady() ||
      (!delegate && !batch && this.effectiveMode(item.card.sessionId, item.card.cwd) !== 'hybrid') ||
      item.screen.verdict === 'deny' ||
      item.explicitAskRule
    ) {
      item.card.explanation.risk = '未启用独立 AI 复核，或此操作必须人工确认';
      this.requestUser(item);
      return { outcome: 'pending' };
    }
    item.awaitingUser = false;
    item.revokedDuringReview = false;
    const start = this.now();
    const revision = this.configRevision;
    const reviewerConfig = structuredClone(this.config.externalReviewer);
    const ownerProfile = item.profileId;
    const controller = new AbortController();
    const event: ApprovalReviewingEvent = {
      requestId: item.card.requestId, sessionId: item.card.sessionId,
      toolCallId: item.card.toolCallId, toolName: item.card.toolName,
      commandPreview: redactSecretsForReviewer(maskKnownSecret(item.card.commandOrSummary, reviewerConfig.apiKey)).slice(0, 240),
      provider: reviewerConfig.provider, model: reviewerConfig.model,
      status: 'reviewing', startedAt: new Date(start).toISOString(),
    };
    const active = { controller, event };
    item.review = active;
    const timeout = Math.min(Math.max(reviewerConfig.timeoutMs || EXTERNAL_REVIEWER_DEFAULTS.timeoutMs, 100), 60_000);
    const timer = setTimeout(() => controller.abort(new Error('复核超时（超过 ' + timeout + 'ms）')), timeout);
    timer.unref?.();
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    try {
      this.emit('approval-reviewing', { ...event });
      const response: AiReviewResult = await Promise.race([
        controller.signal.aborted ? aborted : this.reviewer(item.card.commandOrSummary, item.card.cwd, reviewerConfig, {
          signal: controller.signal,
          toolName: item.card.toolName,
          executionMode: this.sessionModes.get(item.card.sessionId) || 'default',
          intentSummary: item.card.explanation.meaning,
          localRiskLevel: item.screen.riskLevel,
          localRiskReason: item.screen.explanation.risk,
          withinWorkspace: item.withinWorkspace,
          conversationContext: item.conversationContext,
          floorTier: item.card.floorTier,
          toolArguments: item.toolArguments?.slice(0, 16_384),
        }),
        aborted,
      ]);
      if (item.review !== active) return { outcome: this.pending.has(event.requestId) ? 'pending' : 'cancelled' };
      const review = applyGuardianPolicy(response, this.config, item.card.floorTier, item.readOnly);
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
      this.emit('external-review-usage', usageEvent, ownerProfile);

      // 等待远端时用户可能已处理请求或更改配置。先核对待审表和版本号，再采用返回的建议。
      if (!this.ownsPending(item)) return { outcome: 'cancelled' };
      if (item.review !== active) return { outcome: 'pending' };
      if (revision !== this.configRevision || item.revokedDuringReview) {
        item.card.explanation.risk = '审批配置已变更，请按当前规则人工确认';
        delete item.card.aiSuggestion;
        return { outcome: 'pending' };
      }

      item.reviewRevision = revision;
      item.card.screeningSource = 'ai-reviewer-fallback';

      item.card.aiSuggestion = { ...review, model: reviewerConfig.model, isError: false };
      if (item.card.floorTier !== 'tier_a_immutable') {
        item.card.riskLevel = review.riskLevel;
        item.card.explanation.risk = review.reason;
      } else if (review.recommended === 'ask') {
        item.card.aiSuggestion.reason = item.screen.explanation.risk + '。外部 AI 评估：' + review.reason;
      }
      if (review.recommended !== 'approve') return { outcome: 'pending' };
      const decision = this.finish(item, true, 'ai_approved', 'external-ai', review.reason, undefined, delegate ? 'hybrid' : undefined);
      if (decision.outcome === 'approved') this.enableBurstGuard(item.card.sessionId, BURST_WINDOW_MS);
      return decision;
    } catch (error) {
      // Errors committing an already settled approval are local, not a second model invocation.
      if (!this.pending.has(item.card.requestId) && error instanceof ApprovalAuditError) throw error;
      if (item.review !== active) return { outcome: this.pending.has(event.requestId) ? 'pending' : 'cancelled' };
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
      this.emit('external-review-usage', usageEvent, ownerProfile);
      if (!this.ownsPending(item)) return { outcome: 'cancelled' };
      if (item.review !== active) return { outcome: 'pending' };
      if (revision !== this.configRevision || item.revokedDuringReview) {
        item.card.explanation.risk = '审批配置已变更，请按当前规则人工确认';
        delete item.card.aiSuggestion;
        return { outcome: 'pending' };
      }

      const rawMsg = error instanceof Error ? error.message.trim() : '';
      const maskedMsg = redactSecretsForReviewer(maskKnownSecret(rawMsg, reviewerConfig.apiKey));
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
      return { outcome: 'pending' };
    } finally {
      clearTimeout(timer);
      if (item.review === active) {
        item.review = undefined;
        if (item.profileId === this.profileId) {
          const pending = this.pending.has(event.requestId);
          this.emit('approval-reviewing', { ...event, status: pending ? 'escalated' : 'resolved',
            elapsedMs: Math.max(0, this.now() - start) } satisfies ApprovalReviewingEvent);
          if (pending) this.requestUser(item);
        }
      }
    }
  }

  cancelStage2Review(requestId: string): { cancelled: boolean } {
    const item = this.pending.get(requestId);
    if (!item?.review || !this.ownsPending(item)) return { cancelled: false };
    const { controller, event } = item.review;
    item.review = undefined;
    item.reviewRevision = undefined;
    delete item.card.aiSuggestion;
    controller.abort();
    this.emit('approval-reviewing', { ...event, status: 'cancelled',
      elapsedMs: Math.max(0, this.now() - Date.parse(event.startedAt)) } satisfies ApprovalReviewingEvent);
    item.manualTakeover = true;
    item.batchReview = undefined;
    this.guardActivity(event.sessionId, 'review-cancelled', '已停止外部复核，请在审批卡中确认此次操作', 0);
    this.requestUser(item, true);
    return { cancelled: true };
  }

  async submitDecision(submission: ApprovalDecisionSubmission): Promise<ApprovalDecisionResult> {
    const item = this.pending.get(submission.requestId);
    if (!item || item.card.sessionId !== submission.sessionId) throw new Error('审批请求不存在或会话不匹配');
    if (!this.ownsPending(item)) return { outcome: 'cancelled' };
    if (item.review || !item.awaitingUser) throw new Error('审批正在复核，请稍候');

    if (submission.decision === 'approve_for_me_ai') {
      if (item.screen.verdict === 'deny') throw new Error('此项操作不能批准');
      const delegatedMode = this.isExternalReviewerReady() ? 'hybrid' : 'rules-only';
      const suggestion = item.reviewRevision === this.configRevision ? item.card.aiSuggestion : undefined;
      if (item.card.floorTier === 'tier_a_immutable' || suggestion?.recommended === 'deny' ||
          (suggestion?.recommended === 'ask' && (suggestion.intentAlignment !== undefined || suggestion.riskScore !== undefined))) {
        item.card.explanation.risk = (suggestion?.reason || item.card.explanation.risk).replace(/。请明确选择允许一次或拒绝。$/, '') + '。请明确选择允许一次或拒绝。';
        this.requestUser(item);
        return { outcome: 'pending' };
      }
      const confirmedAsk = item.reviewRevision === this.configRevision &&
        item.card.aiSuggestion?.recommended === 'ask' && !item.card.aiSuggestion.isError;
      if (delegatedMode === 'hybrid' && !item.explicitAskRule && !confirmedAsk) return this.review(item, true);
      return this.finish(item, true, 'user_approved', 'user-inline',
        delegatedMode === 'hybrid' ? '用户允许本次操作并为当前会话开启 AI 代审' : '用户允许本次操作并为当前会话启用基础规则',
        undefined, delegatedMode);
    }

    if (submission.decision === 'reject_with_feedback') {
      return this.finish(item, false, 'rejected_with_feedback', 'user-inline', '用户拒绝了操作', submission.feedbackText?.slice(0, 2000));
    }
    if (submission.decision === 'allow_once') {
      return this.finish(item, true, 'user_approved', 'user-inline', '用户仅允许此次操作');
    }
    if (submission.decision !== 'allow_session_prefix') throw new Error('无效的审批动作');
    if (!item.card.commandPrefix || submission.allowedPrefix !== item.card.commandPrefix || item.card.floorTier === 'tier_a_immutable') {
      throw new Error('此请求不支持安全的会话前缀放行');
    }
    return this.finish(item, true, 'user_approved', 'user-inline', '用户允许本会话同类前缀', undefined, 'prefix');
  }

  /** 汇合各类审批结果。审计记录成功后才向 ACP 返回选择。缺少相应的一次性选项时返回取消。 */
  private finish(
    item: Pending,
    allow: boolean,
    verdict: ApprovalAuditEntry['verdict'],
    source: ApprovalAuditEntry['decisionSource'],
    reason: string,
    feedbackText?: string,
    grant?: 'prefix' | 'hybrid' | 'rules-only'
  ): ApprovalDecisionResult {
    if (!this.ownsPending(item)) return { outcome: 'cancelled' };
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
      modeAtDecision: this.effectiveMode(item.card.sessionId, item.card.cwd),
      verdict: allow && !option ? 'denied' : verdict,
      decisionSource: source,
      riskLevel: item.card.riskLevel,
      latencyMs: this.now() - item.started,
      reason: allow && !option ? '官方未提供单次允许选项，已安全取消' : reason,
      feedbackText,
    };
    const delegatedMode = actualAllow && grant && grant !== 'prefix' ? grant : undefined;
    const prefix = actualAllow && grant === 'prefix' && item.card.floorTier !== 'tier_a_immutable' && !item.explicitAskRule
      ? item.card.commandPrefix : undefined;
    try {
      const matchedPrefix = actualAllow && source === 'session-prefix' ? item.card.commandPrefix : undefined;
      if (prefix || delegatedMode || matchedPrefix) this.grants.commit(entry, prefix, delegatedMode, matchedPrefix);
      else this.options.store.append('audit.jsonl', entry);
    } catch {
      this.pending.delete(item.card.requestId);
      item.resolve({ outcome: { outcome: 'cancelled' } });
      this.emit('resolved', { requestId: item.card.requestId, sessionId: item.card.sessionId });
      throw new ApprovalAuditError('授权记录或审计日志写入失败，已取消授权');
    }
    this.pending.delete(item.card.requestId);
    if (actualAllow && item.card.floorTier === 'standard' && source !== 'session-prefix' && (verdict === 'auto_approved' || verdict === 'ai_approved') && this.config.cacheTtlHours > 0) {
      if (this.cache.size >= 2000) this.cache.clear();
      this.cache.set(decisionCacheKey(item, this.config), this.now() + this.config.cacheTtlHours * 3600000);
    }
    item.resolve({ outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
    this.emit('audit', entry);
    this.emit('resolved', { requestId: item.card.requestId, sessionId: item.card.sessionId, grantsChanged: Boolean(prefix || delegatedMode) });
    if (feedbackText) this.emit('feedback', { sessionId: item.card.sessionId, text: feedbackText });
    if (delegatedMode) void this.recheckAwaiting(item, delegatedMode);
    return { outcome: actualAllow ? 'approved' : option ? 'rejected' : 'cancelled', delegatedMode };
  }

  private async recheckAwaiting(delegated: Pending, mode: 'hybrid' | 'rules-only'): Promise<void> {
    const workspace = approvalWorkspaceKey(delegated.card.cwd);
    const batch = Symbol();
    const revision = this.configRevision;
    const candidates = [...this.pending.values()].filter(item =>
      item !== delegated && item.card.sessionId === delegated.card.sessionId && item.profileId === delegated.profileId &&
      approvalWorkspaceKey(item.card.cwd) === workspace && item.awaitingUser && !item.batchReview &&
      !item.manualTakeover && !item.review && item.card.floorTier !== 'tier_a_immutable');
    for (const item of candidates) item.batchReview = batch;
    for (const item of candidates) {
      if (item.batchReview !== batch) continue;
      item.batchReview = undefined;
      if (!this.ownsPending(item) || revision !== this.configRevision || !item.awaitingUser || item.manualTakeover || item.review) continue;
      item.awaitingUser = false;
      try { await this.initialDecision(item, false, mode); }
      catch { if (this.ownsPending(item)) this.requestUser(item); }
    }
  }

  cancelPending(sessionId?: string, rpcId?: string | number): void {
    for (const item of [...this.pending.values()]) {
      if ((sessionId === undefined || item.card.sessionId === sessionId) && (rpcId === undefined || item.rpcId === rpcId)) {
        const review = item.review;
        item.review = undefined;
        review?.controller.abort();
        if (review && item.profileId === this.profileId) {
          this.emit('approval-reviewing', { ...review.event, status: 'cancelled' } satisfies ApprovalReviewingEvent);
        }
        this.pending.delete(item.card.requestId);
        item.resolve({ outcome: { outcome: 'cancelled' } });
        this.emit('resolved', { requestId: item.card.requestId, sessionId: item.card.sessionId });
      }
    }
  }

  /** Live requests and transient caches end with the connection. Explicit grants belong to the saved conversation. */
  cancelSession(sessionId: string): void {
    this.cancelPending(sessionId);
    this.resetTurnBurstCounter(sessionId);
    this.sessionModes.delete(sessionId);
    for (const key of this.cache.keys()) if (key.startsWith(sessionId + '\0')) this.cache.delete(key);
  }

  dispose(): void {
    this.cancelPending();
    this.cache.clear();
    this.sessionModes.clear();
    this.burst.dispose();
  }
}

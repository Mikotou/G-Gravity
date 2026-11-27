import { ownedExternalUsage } from '../telemetry/external-usage-owner';
import { ServiceVerifier } from '../llm/service-verifier';
import { maskKnownSecret, redactSecretsForReviewer } from '../security/redaction';
import { reviewerCircuit } from '../llm/external-llm-transport';
import { discoverExternalModels } from '../approval/external-reviewer';
import type { ExternalReviewerModelsDiscoveryInput } from '../../shared/approval-contract';
import type { ExternalUsageHost, CoreServiceOptions } from '../core-contracts';
import { ApprovalEngine } from '../approval/approval-engine';
import { IndependentModelCallError, reviewWithIndependentModel } from '../approval/external-reviewer';
import type { ManagedSessionSummary, ChatMessageItem } from '../../shared/session-contract';
import {
  hasReviewerConnectionSettings, isExternalReviewerConnected, sameExternalService, sameReviewerSettings,
  type ApproveForMeConfig, type ExternalAiReviewerConfig, type ExternalReviewerTestResult,
  type RevokeSessionApprovalGrantInput,
} from '../../shared/approval-contract';
import type { ExternalReviewerUsageRecordInput } from '../../shared/telemetry-contract';
import { SecretVault, publicApprovalConfig } from './secret-vault';


export class ApprovalCoordinator {
  readonly approval: ApprovalEngine;
  private verifier = new ServiceVerifier(sameReviewerSettings);

  async listSessionApprovalGrants(sessionId: string) {
    return this.approval.getSessionGrantsSnapshot(sessionId, this.app.sessions.get(sessionId).cwd);
  }
  async clearSessionApprovals(sessionId: string): Promise<ManagedSessionSummary> {
    const session = this.app.sessions.get(sessionId);
    this.approval.clearSessionGrants(sessionId, session.cwd);
    const updated = this.enrichSession(session);
    this.app.emit('session-updated', updated);
    return updated;
  }
  async discoverExternalReviewerModels(input: ExternalReviewerModelsDiscoveryInput) {
    const current = this.approval.getConfig().externalReviewer;
    const candidate = input.apiKey === undefined && sameExternalService(current, input)
      ? { ...input, apiKey: current.apiKey } : input;
    return discoverExternalModels(candidate, this.options.modelDiscoveryFetcher);
  }

  constructor(private app: ExternalUsageHost, private vault: SecretVault,
    private options: Pick<CoreServiceOptions, 'reviewer' | 'modelDiscoveryFetcher'>,
    private enrichSession: (session: ManagedSessionSummary) => ManagedSessionSummary,
    private isDisposed: () => boolean) {
    const engineOptions = { store: app.store, reviewer: options.reviewer, getProfileId: () => app.sessions.profileId };
    const config = vault.loadApprovalConfig();
    try { this.approval = new ApprovalEngine({ ...engineOptions, config }); }
    catch { this.approval = new ApprovalEngine(engineOptions); }
    this.approval.on('approval-reviewing', event => app.emit('approval-reviewing', event));
    this.approval.on('guard-activity', event => app.emit('approval-guard-activity', event));
    this.approval.on('external-review-usage', (ev: ExternalReviewerUsageRecordInput, profileId: string) => {
      if (this.isDisposed()) return;
      this.app.telemetry.recordExternalReviewUsage(ownedExternalUsage(this.app, profileId, ev), profileId);
    });
  }

  private reviewerCandidate(input: Partial<ExternalAiReviewerConfig>): ExternalAiReviewerConfig {
    const current = this.approval.getConfig().externalReviewer;
    const key = input.apiKey ?? (sameExternalService(current, input) ? current.apiKey : '');
    const { hasApiKey: _publicFlag, ...settings } = input;
    return {
      ...current, ...settings, endpoint: (input.endpoint ?? current.endpoint).trim(), model: (input.model ?? current.model).trim(),
      hasApiKey: Boolean(key?.trim()), apiKey: key?.trim(),
    };
  }
  async updateApprovalConfig(patch: Partial<ApproveForMeConfig>) {
    const current = this.approval.getConfig();
    const next = this.reviewerCandidate(patch.externalReviewer ?? {});
    const unchangedSettings = sameReviewerSettings(current.externalReviewer, next);
    const proof = this.verifier.verifiedAt(next) ?? (unchangedSettings && isExternalReviewerConnected({ ...current.externalReviewer, enabled: true })
        ? current.externalReviewer.lastVerifiedAt : undefined);
    if (patch.externalReviewer?.enabled && !proof) {
      throw new Error('尚未连接外部复核模型，请先用所选模型完成一次复核测试，再启用。');
    }
    next.verificationMethod = proof ? 'review-call' : undefined;
    next.lastVerifiedAt = proof;
    next.connectionStatus = proof ? 'connected' : unchangedSettings && current.externalReviewer.connectionStatus === 'failed' ? 'failed' : 'untested';
    next.enabled = Boolean(next.enabled && proof);
    if (patch.mode === 'hybrid' && !isExternalReviewerConnected(next)) {
      throw new Error('尚未连接外部复核模型，请先用所选模型完成一次复核测试。');
    }
    const merged = { ...patch, externalReviewer: next };
    if ((patch.mode ?? current.mode) === 'hybrid' && !next.enabled) merged.mode = 'rules-only';
    const previous = [...this.app.sessions.sessions.values()].map(session => ({
      session, override: this.approval.sessionApprovalOverride(session.sessionId, session.cwd),
    }));
    const saved = this.approval.updateConfig(merged, cfg => this.vault.persistApprovalConfig(cfg));
    if (patch.externalReviewer) {
      this.verifier.changed(next, current.externalReviewer.enabled !== next.enabled);
      if (current.externalReviewer.apiKey !== next.apiKey) reviewerCircuit.reset(next.endpoint);
    }
    for (const { session, override } of previous) {
      if (override !== this.approval.sessionApprovalOverride(session.sessionId, session.cwd)) this.app.emit('session-updated', this.enrichSession(session));
    }
    const snapshot = publicApprovalConfig(saved);
    this.app.emit('approval-config-updated', snapshot);
    return snapshot;
  }
  async testExternalReviewerConnection(input: ExternalAiReviewerConfig): Promise<ExternalReviewerTestResult> {
    const candidate = { ...this.reviewerCandidate(input), enabled: true };
    this.verifier.begin(candidate);
    if (!hasReviewerConnectionSettings(candidate)) return { ok: false, message: '请填写有效的服务地址、模型与所需的 API Key。' };
    const verified = reviewerCircuit.successRecorder(candidate.endpoint);
    try {
      const review = await (this.options.reviewer ?? reviewWithIndependentModel)('git status', '.', candidate,
        { skipCircuitCheck: true, toolName: 'run_command', intentSummary: 'Connection test using a fixed read-only example', withinWorkspace: true },
        this.options.modelDiscoveryFetcher);
      if (!['approve','ask','deny'].includes(review.recommended) || !['safe','low','medium','high','critical'].includes(review.riskLevel) || !review.reason?.trim()) {
        throw new IndependentModelCallError('所选模型未返回有效的复核意见。', review.usage);
      }
      if (!this.verifier.current(candidate) || this.isDisposed()) return { ok: false, message: '配置或测试已更新，请重新测试当前设置。' };
      const verifiedAt = this.verifier.accept(candidate);
      verified();
      return { ok: true, verifiedAt, message: maskKnownSecret(review.reason, candidate.apiKey).slice(0, 300) };
    } catch (err) {
      if (!this.verifier.current(candidate) || this.isDisposed()) return { ok: false, message: '配置或测试已更新，请重新测试当前设置。' };
      this.verifier.reject();
      const current = this.approval.getConfig().externalReviewer;
      if (sameReviewerSettings(current, candidate) && current.verificationMethod) {
        const downgraded = { ...current, enabled: false, verificationMethod: undefined, lastVerifiedAt: undefined, connectionStatus: 'failed' as const };
        const saved = this.approval.updateConfig({ externalReviewer: downgraded, ...(this.approval.getConfig().mode === 'hybrid' ? { mode: 'rules-only' as const } : {}) },
          cfg => this.vault.persistApprovalConfig(cfg));
        this.app.emit('approval-config-updated', publicApprovalConfig(saved));
        for (const session of this.app.sessions.sessions.values()) this.app.emit('session-updated', this.enrichSession(session));
      }
      const reason = err instanceof Error ? err.message : '复核测试失败';
      const message = redactSecretsForReviewer(maskKnownSecret(reason, candidate.apiKey));
      return { ok: false, message: message.slice(0, 300) };
    } finally {
      this.verifier.finish(candidate);
    }
  }
  revokeSessionApprovalGrant(input: RevokeSessionApprovalGrantInput) {
    const session = this.app.sessions.get(input.sessionId);
    const snapshot = this.approval.revokeSessionGrant(session.sessionId, session.cwd, input);
    this.app.emit('session-updated', this.enrichSession(session));
    return snapshot;
  }
}

export function approvalConversationContext(recent: ChatMessageItem[]): string | undefined {
  const users = recent.filter(m => m.role === 'user' && m.content?.trim());
  const selected = users.slice(-4);
  if (users[0] && !selected.includes(users[0])) selected.unshift(users[0]);
  const assistant = recent.filter(m => m.role === 'assistant' && m.content?.trim()).at(-1);
  const snippet = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 1) + '…';
  const clean = (m: ChatMessageItem) => redactSecretsForReviewer(m.content).replace(/\s+/g, ' ').trim();
  const assistantLine = assistant ? '[Assistant] ' + snippet(clean(assistant), 180) : '';
  let available = 2800 - assistantLine.length - (assistantLine ? 1 : 0);
  const contents = selected.map(clean);
  const lines = contents.map((content, i) => {
    // Reserve room for every later user message before spending the budget on the initial goal.
    const reserve = contents.slice(i + 1).reduce((sum, s) => sum + Math.min(390, s.length) + 8, 0);
    const line = '[User] ' + snippet(content, available - reserve - 7);
    available -= line.length + 1;
    return line;
  });
  if (assistantLine) lines.push(assistantLine);
  return lines.length ? lines.join('\n') : undefined;
}

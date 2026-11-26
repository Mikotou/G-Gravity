import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { AgentExecutionMode, AgentReasoningEffort } from '../shared/acp-protocol';
import type {
  ApprovalDecisionSubmission, ApprovalMode, ApproveForMeConfig, ExternalAiReviewerConfig,
  ExternalReviewerModelsDiscoveryInput, RevokeSessionApprovalGrantInput,
} from '../shared/approval-contract';
import type {
  AppBootstrapPayload, AcpConnectionStatus, AppUpdateState, CreateSessionInput, OpenLinkOrFileInput,
  OpenLinkOrFileResult, ReviseMessageInput, SendPromptInput,
} from '../shared/ipc-channels';
import type {
  ManagedSessionSummary, SessionAction, TitleOrganizeRequest, WorkspaceLayoutState,
} from '../shared/session-contract';
import { MAX_PARALLEL_ACTIVE_SESSIONS } from '../shared/session-contract';
import type { ClientPreferences, GravityIconPreference } from '../shared/theme-i18n-contract';
import { APP_BRAND } from '../shared/theme-i18n-contract';
import type { ExternalTranslatorConfig, TranslationConfigPatch } from '../shared/translation-contract';
import type { ModelRateCard } from '../shared/telemetry-contract';
import type { AccountQuotaReadResult, CreateAccountProfileInput } from '../shared/accounts-history-contract';
import type { PluginActionInput, McpActionInput } from '../shared/plugins-contract';
import type { SwarmHistoryCursor } from '../shared/swarm-contract';
import type { SwitchConversationBranchInput } from '../shared/conversation-tree';
import type { QuestionSubmission } from '../shared/user-question';
import { AcpClient, AcpRequestNotSentError } from './acp/acp-client';
import { ApprovalEngine } from './approval/approval-engine';
import { ClientStore } from './storage/client-store';
import { ConversationMessages } from './storage/conversation-messages';
import { SessionMultiplexer } from './session/session-multiplexer';
import { TitleOrganizer } from './organizer/title-organizer';
import { TelemetryStore } from './telemetry/telemetry-store';
import { ThoughtTranslator } from './translation/thought-translator';
import { SwarmWorkerClient } from './swarm/swarm-worker-client';
import { AccountQuotaUnavailable, MacQuotaNotReported, readAccountQuota } from './accounts/account-quota';
import { AccountManager } from './accounts/account-manager';
import { PluginsManager } from './plugins/plugins-manager';
import { WorkspaceFiles } from './workspace/workspace-files';
import { InspectorStore } from './session/inspector-store';
import { ConversationTreeStore } from './session/conversation-tree-store';
import { GitHubUpdater } from './updater/github-updater';
import { ConversationBranches } from './services/conversation-branches';
import { WorkspaceSettings } from './services/workspace-settings';
import { TranslationService } from './services/translation-service';
import { TitleOrganizerService } from './services/title-organizer-service';
import { ApprovalCoordinator } from './services/approval-coordinator';
import { SecretVault, publicApprovalConfig, publicTranslationConfig } from './services/secret-vault';
import { openExternalTarget, localTargetContext } from './services/external-opener';
import { diagnosticDetail, officialLoginRequiredMessage } from './services/session-diagnostics';
import { inspectLocalTargets } from './services/local-media-inspector';
import type { InspectLocalTargetsInput, InspectLocalTargetsResult } from '../shared/media-contract';
import type { CoreServiceOptions } from './core-contracts';
import { TurnOrchestrator } from './session/turn-orchestrator';
import { SessionLifecycleService } from './session/session-lifecycle-service';
import { TelemetryCoordinator } from './telemetry/telemetry-coordinator';
export type { CoreServiceOptions } from './core-contracts';
/** 主进程的业务入口。窗口请求进入此处，ACP 更新按会话分发给消息、审批、统计和检视器，再由事件通知渲染层。 */
export class CoreService extends EventEmitter {
  readonly store: ClientStore; readonly client: AcpClient; readonly sessions: SessionMultiplexer; readonly approval: ApprovalEngine;
  telemetry: TelemetryStore; readonly titles: TitleOrganizer; readonly thoughts: ThoughtTranslator;
  readonly accounts: AccountManager; readonly plugins: PluginsManager;
  readonly updater: GitHubUpdater; readonly workspaceFiles = new WorkspaceFiles();
  private readonly settings: WorkspaceSettings;
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly translation: TranslationService;
  get messages(): ConversationMessages { return this.lifecycle.profileData.messages; }
  get swarm(): SwarmWorkerClient { return this.lifecycle.profileData.swarm; }
  get inspector(): InspectorStore { return this.lifecycle.profileData.inspector; }
  get trees(): ConversationTreeStore { return this.lifecycle.profileData.trees; }
  disposed = false;
  private readonly turns = new TurnOrchestrator(this);
  private readonly monitor: TelemetryCoordinator;
  private readonly lifecycle: SessionLifecycleService;
  private readonly branches: ConversationBranches;
  private readonly titleOrganizer: TitleOrganizerService;
  private quotaRequests = new Map<string, { controller: AbortController; result: Promise<AccountQuotaReadResult> }>();
  private quotaResumedAfter = 0;
  private lastPublishedConnection?: string;
  private bootstrapping?: Promise<AppBootstrapPayload>;
  private autoUpdateTimer?: NodeJS.Timeout;
  constructor(private options: CoreServiceOptions) {
    super(); this.store = new ClientStore(options.dataDir);
    this.monitor = new TelemetryCoordinator(this, options);
    const vault = new SecretVault(this.store, options.secretCipher);
    this.settings = new WorkspaceSettings(this, vault, options, () => this.disposed);
    this.lifecycle = new SessionLifecycleService(this, this.turns, this.monitor, this.settings, options);
    this.client = options.acp || new AcpClient({ ...options.acpOptions, args: options.acpOptions?.args || ['acp', ...(this.settings.preferences.processPerSession ? ['--process-per-session'] : [])] });
    this.sessions = new SessionMultiplexer(this.client, this.store);
    this.approvalCoordinator = new ApprovalCoordinator(this, vault, options, session => this.enrichSession(session), () => this.disposed);
    this.approval = this.approvalCoordinator.approval;
    this.titles = new TitleOrganizer(this.store);
    this.branches = new ConversationBranches(this, this.settings, {
      messages: () => this.messages, branchTelemetry: ids => this.monitor.branchSnapshot(ids), enrich: session => this.enrichSession(session),
      isManaging: id => this.lifecycle.managing.has(id), isSessionTurnActive: id => this.turns.isSessionTurnActive(id), isDisposed: () => this.disposed,
      upsert: message => this.turns.upsert(message), discardNewBranch: id => this.lifecycle.discardNewBranch(id),
    });
    this.titleOrganizer = new TitleOrganizerService(this, () => this.messages, session => this.enrichSession(session),
      id => this.branches.emitTreeUpdate(id), () => this.nowMs(), () => this.disposed, options.homeDir);
    this.translation = new TranslationService(this.settings, this, options, id => this.turns.thoughtOwners.get(id)?.sessionId,
      () => this.nowMs(), () => this.disposed);
    this.thoughts =
      options.translator ||
      new ThoughtTranslator((originalText, thoughtId, signal) =>
        this.translation.translateThoughtSegment(originalText, thoughtId, signal)
      );
    this.plugins = new PluginsManager({ store: this.store, binaryPath: options.acpOptions?.binaryPath, executor: options.pluginsExecutor, homeDir: options.homeDir });
    this.updater = new GitHubUpdater({
      currentVersion: options.appVersion || APP_BRAND.version,
      updatesDir: join(options.dataDir, 'updates'),
      ...options.updaterOptions,
    });
    this.updater.on('state', (state: AppUpdateState) => this.emit('update-state', state));
    if (options.enableAutoUpdateCheck && this.settings.preferences.autoCheckUpdates !== false) {
      this.autoUpdateTimer = setTimeout(() => {
        this.autoUpdateTimer = undefined;
        if (!this.disposed && this.settings.preferences.autoCheckUpdates !== false) {
          void this.updater.checkForUpdates().catch(() => {});
        }
      }, 4500);
      this.autoUpdateTimer.unref?.();
    }
    // 切换账号要跨越两套会话状态。旧消息在切换前保存，新账号的消息在窗格和内存索引清空后载入。
    this.accounts = new AccountManager({ store: this.store, client: this.client, sessions: this.sessions,
      beforeSwitch: async () => {
        if (this.lifecycle.managing.size || this.branches.revising.size || this.sessions.isOpeningSession || this.titleOrganizer.organizingTitles) throw new Error('正在创建、恢复或整理会话，请稍后切换账号');
        await this.lifecycle.completePendingDeletions();
        await this.flushSwarm();
        this.settings.profileWillChange();
        await this.cancelQuotaRequests();
        this.store.flushPending();
        this.turns.prepareDisconnect();
        this.messages.save();
      },
      afterDisconnect: async () => {
        this.turns.releaseProfile();
        this.inspector.flush();
        await this.flushSwarm();
        await this.swarm.clear();
        await this.store.drain();
      },
      prepareProfile: profileId => this.lifecycle.prepareProfileSwitch(profileId),
      afterSwitch: () => this.lifecycle.completePendingDeletions(),
    });
    this.telemetry = this.monitor.createTelemetryStore(this.accounts.activeProfileId);
    this.lifecycle.profileData = this.lifecycle.readProfileData(this.accounts.activeProfileId);
    this.settings.preferences.activeProfileId = this.accounts.activeProfileId;
    void this.lifecycle.completePendingDeletions().catch(error => this.emit('diagnostic', diagnosticDetail(error)));
    this.monitor.scheduleTelemetryClock();
    this.accounts.on('updated', state => {
      this.emit('account-updated', state);
      this.publishConnection(true);
    });
    this.client.on('before-connect', () => {
      // An in-flight restore or profile change may still be awaiting the previous transport's shutdown.
      if (this.disposed) throw new AcpRequestNotSentError('ACP 正在关闭');
      this.settings.syncAcpArgs();
    });
    this.client.on('connected', () => this.publishConnection());
    this.client.on('connection-changed', () => this.publishConnection());
    this.turns.bindEvents();
  }
  getPreferences(): ClientPreferences { return structuredClone(this.settings.preferences); }
  /** 并发打开工作台时共用一次快照。连接失败仍返回本地会话记录，客户端可据此显示离线历史。 */
  async getBootstrap(): Promise<AppBootstrapPayload> {
    if (this.bootstrapping) return this.bootstrapping;
    this.bootstrapping = (async () => {
      await this.lifecycle.completePendingDeletions();
      try {
        this.accounts.assertReady();
        await this.sessions.listSessions(true);
      } catch (error) {
        this.client.lastError = diagnosticDetail(error) || 'ACP 连接失败';
      }
      // Take the live snapshots together, after I/O. A Dock-resident turn can stop during either refresh.
      const sessions = this.sessions.localSessionSummaries(true).map(item => this.enrichSession(item));
      for (const s of sessions) {
        this.telemetry.hydrateFromMessages(s.sessionId, s.modelId, () => this.messages.forStatistics(s.sessionId));
      }
      const roots = new Set(Array.from(this.sessions.sessions.keys(), id => this.trees.resolveRootId(id)));
      for (const root of roots) {
        for (const bid of this.trees.listBranchIds(root)) {
          const branchSess = this.sessions.sessions.get(bid);
          if (branchSess && !this.telemetry.hasSessionTelemetry(bid)) {
            this.telemetry.hydrateFromMessages(bid, branchSess.modelId, () => this.messages.forStatistics(bid));
          }
        }
      }
      return { preferences: { ...this.settings.preferences }, connection: this.connectionStatus(), accounts: this.accounts.getState(), plugins: this.plugins.getCachedSnapshot(), approvalConfig: publicApprovalConfig(this.approval.getConfig()), activeReviews: this.approval.listActiveReviews(), translationConfig: publicTranslationConfig(this.settings.translationConfig), sessions, layout: structuredClone(this.settings.layout), pendingApprovals: this.approval.listAwaitingUser(), telemetry: this.telemetry.snapshot(), windowChrome: this.options.windowChrome ?? 'standard', updateState: this.updater.getState() };
    })();
    try { return await this.bootstrapping; } finally { this.bootstrapping = undefined; }
  }
  private async cancelQuotaRequests(): Promise<void> {
    const requests = [...this.quotaRequests.values()];
    for (const { controller } of requests) controller.abort();
    await Promise.allSettled(requests.map(request => request.result));
  }

  async getAccountQuota(manual = true): Promise<AccountQuotaReadResult> {
    this.accounts.assertReady();
    if (this.disposed) throw new Error('客户端正在退出。');
    if (typeof manual !== 'boolean') throw new Error('额度刷新参数无效');
    const deadline = this.client.cooldownUntilMs;
    const assertAllowed = () => {
      this.client.assertRequestAllowed();
      if (this.client.cooldownUntilMs !== deadline || (!manual && this.quotaResumedAfter < deadline)) {
        throw new Error('额度自动刷新已暂停，请手动刷新。');
      }
    };
    assertAllowed();
    if (manual) this.quotaResumedAfter = deadline;
    const state = this.accounts.getState();
    const profile = state.profiles.find(p => p.profileId === state.activeProfileId)!;
    const existing = this.quotaRequests.get(profile.profileId);
    if (existing) return existing.result;
    const controller = new AbortController();
    const result = readAccountQuota(profile, this.client.options.binaryPath, controller.signal, assertAllowed)
      .catch((error): AccountQuotaReadResult => {
        if (error instanceof AccountQuotaUnavailable) return { profileId: profile.profileId, unavailable: error.reason };
        if (error instanceof MacQuotaNotReported && this.client.lastErrorCode === 'auth_required_401') {
          throw new Error(officialLoginRequiredMessage);
        }
        throw error;
      }).finally(() => this.quotaRequests.delete(profile.profileId));
    this.quotaRequests.set(profile.profileId, { controller, result });
    return result;
  }
  private connectionStatus(): AcpConnectionStatus {
    const version = this.client.initializeResult?.agentInfo?.version;
    return { connected: this.client.connected, agyBinaryPath: this.client.binaryPath, agyVersion: version || '',
      agentServerVersion: version, activeSessionCount: this.sessions.activeSessionCount, maxParallelSessions: MAX_PARALLEL_ACTIVE_SESSIONS,
      activeProfileId: this.accounts.activeProfileId, ...this.sessions.modelList(), lastError: this.client.lastError,
      lastErrorCode: this.client.lastErrorCode, lastExitCode: this.client.lastExitCode, lastSignal: this.client.lastSignal,
      cooldownUntil: this.client.isRateLimited ? new Date(this.client.cooldownUntilMs).toISOString() : undefined,
      cooldownKind: this.client.isRateLimited ? this.client.cooldownKind : undefined };
  }
  async getConnectionStatus(): Promise<AcpConnectionStatus> { return this.connectionStatus(); }
  publishConnection(force = false): void {
    if (this.disposed) return;
    const snapshot = this.connectionStatus();
    const signature = JSON.stringify(snapshot);
    if (force || signature !== this.lastPublishedConnection) {
      this.lastPublishedConnection = signature;
      this.emit('connection-updated', snapshot);
    }
  }
  async updatePreferences(patch: Partial<ClientPreferences>) { return this.settings.updatePreferences(patch); }
  async checkForUpdates(): Promise<AppUpdateState> { return this.updater.checkForUpdates(); }
  async downloadUpdate(): Promise<AppUpdateState> { return this.updater.downloadUpdate(); }
  async installUpdate(): Promise<{ launched: boolean; message: string }> { return this.updater.installUpdate(); }
  async launchOfficialLogin(profileId?: string) { return this.accounts.login(profileId); }
  async listSessions(includeHiddenPollution = false) { this.accounts.assertReady(); await this.lifecycle.completePendingDeletions(); return (await this.sessions.listSessions(includeHiddenPollution)).map(item => this.enrichSession(item)); }
  async getSessionMessagePage(sessionId: string, before?: number) { return structuredClone(this.messages.page(sessionId, before)); }
  async reviseMessage(input: ReviseMessageInput) { return this.branches.reviseMessage(input); }
  async getConversationTree(sessionId: string) { return this.branches.getConversationTree(sessionId); }
  async switchConversationBranch(input: SwitchConversationBranchInput) { return this.branches.switchConversationBranch(input); }
  async saveWorkspaceLayout(patch: Partial<WorkspaceLayoutState>) { return this.settings.saveWorkspaceLayout(patch); }
  async renameSession(sessionId: string, newTitle: string) { return this.titleOrganizer.renameSession(sessionId, newTitle); }
  async togglePinSession(sessionId: string) { return this.titleOrganizer.togglePinSession(sessionId); }
  private nowMs(): number { return this.options.now ? this.options.now() : Date.now(); }
  async organizeTitles(request?: TitleOrganizeRequest) { return this.titleOrganizer.organizeTitles(request); }
  async setApprovalMode(mode: ApprovalMode) { return this.updateApprovalConfig({ mode }); }
  async updateApprovalConfig(patch: Partial<ApproveForMeConfig>) { return this.approvalCoordinator.updateApprovalConfig(patch); }
  async testExternalReviewerConnection(input: ExternalAiReviewerConfig) { return this.approvalCoordinator.testExternalReviewerConnection(input); }
  async revokeSessionApprovalGrant(input: RevokeSessionApprovalGrantInput) { return this.approvalCoordinator.revokeSessionApprovalGrant(input); }
  async cancelStage2ApprovalReview(requestId: string) { return this.approval.cancelStage2Review(requestId); }
  async submitApprovalDecision(submission: ApprovalDecisionSubmission) { return this.approval.submitDecision(submission); }
  async listApprovalAudit(limit?: number) { return this.approval.listAudit(limit); }
  async getTranslationConfig() { return this.translation.getTranslationConfig(); }
  async updateTranslationConfig(patch: TranslationConfigPatch) { return this.translation.updateTranslationConfig(patch); }
  async discoverExternalTranslationModels(input: ExternalReviewerModelsDiscoveryInput) { return this.translation.discoverExternalTranslationModels(input); }
  async testExternalTranslatorConnection(input?: Partial<ExternalTranslatorConfig>) { return this.translation.testExternalTranslatorConnection(input); }
  async getTelemetryDashboard() { return this.telemetry.snapshot(); }
  async updateModelRateCards(rates: ModelRateCard[]) { return this.telemetry.updateModelRateCards(rates); }
  async setAppIcon(iconId: GravityIconPreference) { return this.updatePreferences({ appIcon: iconId }); }
  async copyText(text: string): Promise<void> {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) {
      throw new Error('复制文本无效或超过 4 MB 大小限制');
    }
    if (!this.options.copyTextHandler) throw new Error('系统剪贴板不可用');
    await this.options.copyTextHandler(text);
  }
  readonly mediaContext = () => localTargetContext(this.options.homeDir, this.accounts);
  async inspectLocalTargets(input: InspectLocalTargetsInput): Promise<InspectLocalTargetsResult> {
    return inspectLocalTargets(input, this.mediaContext());
  }
  async openLinkOrFileTarget(input: OpenLinkOrFileInput): Promise<OpenLinkOrFileResult> {
    return openExternalTarget(input, this.options, this.accounts);
  }
  async getAccountsState() { return this.accounts.getState(); }
  async createAccountProfile(input: CreateAccountProfileInput) { return this.accounts.createProfile(input); }
  async deleteAccountProfile(profileId: string) { return this.accounts.deleteProfile(profileId); }
  async switchAccountProfile(profileId: string) { return this.accounts.switchProfile(profileId); }
  async officialLogout() { return this.accounts.logout(); }
  async getSessionInspector(sessionId: string) { return this.inspector.get(sessionId); }
  async listWorkspaceFiles(cwd: string, query?: string) { return this.workspaceFiles.list(cwd, query); }
  async getPluginsSnapshot(workspaceCwd?: string) { return this.plugins.getSnapshot(workspaceCwd); }
  async runPluginAction(input: PluginActionInput) { return this.plugins.runPluginAction(input); }
  async runMcpAction(input: McpActionInput) { return this.plugins.runMcpAction(input); }
  async toggleSkillEnabled(skillId: string, enabled: boolean) { return this.plugins.toggleSkillEnabled(skillId, enabled); }
  async getSwarmState(sessionId: string, before?: SwarmHistoryCursor) {
    this.accounts.assertReady();
    if (this.disposed) throw new Error('客户端正在退出。');
    return this.swarm.readState(sessionId, before);
  }

  private async flushSwarm(): Promise<void> {
    const failed = await this.swarm.flush();
    if (failed.length) throw new Error('Swarm 未能保存以下会话，请重试：' + failed.join(', '));
  }
  /** 退出时先终止定时器与事件来源，再刷新用量账本。即便写盘抛错，finally 也会关闭 ACP 连接。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const quotaStopped = this.cancelQuotaRequests();
    this.monitor.dispose();
    if (this.autoUpdateTimer) { clearTimeout(this.autoUpdateTimer); this.autoUpdateTimer = undefined; }
    const stopped = await Promise.allSettled([quotaStopped, this.client.stop()]);
    const results = [...stopped, ...await Promise.allSettled([
      () => this.turns.releaseProfile(), () => this.thoughts.dispose(), () => this.translation.dispose(), () => this.approval.dispose(),
      () => this.messages.save(), () => this.inspector.flush(), () => this.telemetry.dispose(),
      () => this.lifecycle.waitForDeletions(), async () => { await this.flushSwarm(); await this.swarm.clear(); },
    ].map(clean => Promise.resolve().then(clean)))];
    try { this.store.dispose(); } finally { await this.store.drain(); this.monitor.dispose(); }
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  enrichSession(session: ManagedSessionSummary) { return this.lifecycle.enrichSession(session); }
  isEphemeral(id: string) { return this.sessions.slots.find(id)?.hidden === true; }
  isChangingSession(id: string) { return this.lifecycle.managing.has(id) || this.branches.revising.has(id); }
  syncSessionCheckpointWindow(id: string) { this.monitor.syncSessionCheckpointWindow(id); }
  maybeSyncSessionCheckpointWindow(id: string) { this.monitor.maybeSyncSessionCheckpointWindow(id); }
  treeUpdated(id: string) { this.branches.emitTreeUpdate(id); }
  createSession(input: CreateSessionInput) { return this.lifecycle.createSession(input); }
  resumeSession(sessionId: string, cwd: string) { return this.lifecycle.resumeSession(sessionId, cwd); }
  closeSession(sessionId: string) { return this.lifecycle.closeSession(sessionId); }
  manageSession(id: string, action: SessionAction) { return this.lifecycle.manageSession(id, action); }
  setSessionMode(sessionId: string, mode: AgentExecutionMode) { return this.lifecycle.setSessionMode(sessionId, mode); }
  setSessionModel(sessionId: string, modelId: string) { return this.lifecycle.setSessionModel(sessionId, modelId); }
  setSessionEffort(sessionId: string, effort: AgentReasoningEffort) { return this.lifecycle.setSessionEffort(sessionId, effort); }
  answerQuestion(input: QuestionSubmission) { return this.turns.answerQuestion(input); }
  cancelPrompt(sessionId: string) { return this.turns.cancelPrompt(sessionId); }
  sendPrompt(input: SendPromptInput) { return this.turns.sendPrompt(input); }
  compactSessionContext(sessionId: string) { return this.turns.compactSessionContext(sessionId); }
  exportCustomTheme() { return this.settings.exportCustomTheme(); }
  importCustomTheme(jsonText: string) { return this.settings.importCustomTheme(jsonText); }
  selectDirectory(defaultPath?: string) { return this.settings.selectDirectory(defaultPath); }
  listSessionApprovalGrants(sessionId: string) { return this.approvalCoordinator.listSessionApprovalGrants(sessionId); }
  clearSessionApprovals(sessionId: string) { return this.approvalCoordinator.clearSessionApprovals(sessionId); }
  discoverExternalReviewerModels(input: ExternalReviewerModelsDiscoveryInput) { return this.approvalCoordinator.discoverExternalReviewerModels(input); }
}

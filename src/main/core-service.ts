import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AcpConfigOption, AcpRequestPermissionParams, AcpSessionNewResult, AcpSessionUpdateNotification, AcpPromptContentBlock, AgentExecutionMode, AgentReasoningEffort } from '../shared/acp-protocol';
import { EXTERNAL_REVIEWER_DEFAULTS, isExternalReviewerConnected, type ApprovalAuditEntry, type ApprovalDecisionSubmission, type ApprovalMode, type ApproveForMeConfig, type ExternalReviewerConnectionStatus, type ExternalReviewerModelsDiscoveryInput, type ExternalReviewerThinkingLevel } from '../shared/approval-contract';
import type { ExternalReviewerUsageRecordInput } from '../shared/telemetry-contract';
import type { AppBootstrapPayload, AcpConnectionStatus, AppUpdateState, CreateSessionInput, OpenLinkOrFileInput, OpenLinkOrFileResult, SendPromptInput } from '../shared/ipc-channels';
import { isForbiddenCredentialOrStatePath } from '../shared/accounts-history-contract';
import type { ChatMessageItem, ManagedSessionSummary, TitleOrganizeRequest, TitleOrganizeResult, WorkspaceLayoutState } from '../shared/session-contract';
import { clampSplitRatio, containsTransientStreamInterruption, generateStructuredChineseTitle, isLegacyPollutionSessionTitle, isRightInspectorTab, LAYOUT_LIMITS, normalizeWorkspacePath, stripTransientStreamInterruptions, TITLE_ORGANIZE_MODEL_LABEL, TITLE_ORGANIZE_RATE_LIMIT } from '../shared/session-contract';
import type { ClientPreferences, GravityIconId, WorkspaceProjectConfig } from '../shared/theme-i18n-contract';
import { APP_BRAND, THEME_PRESETS, GRAVITY_ICON_VARIANTS, UI_SCALE_LIMITS, clampUiScale, sanitizeCustomThemeConfig, validateCustomThemeConfig } from '../shared/theme-i18n-contract';
import type { ModelRateCard } from '../shared/telemetry-contract';
import type { CreateAccountProfileInput, ContinueHistoryInGravityInput } from '../shared/accounts-history-contract';
import type { PluginActionInput, McpActionInput } from '../shared/plugins-contract';
import { AcpClient, type AcpClientOptions } from './acp/acp-client';
import { ApprovalEngine, DEFAULT_APPROVAL_CONFIG, type ApprovalGuardActivityEvent } from './approval/approval-engine';
import { discoverExternalModels, validateExternalEndpoint, type Reviewer } from './approval/external-reviewer';
import { compileSafePattern } from './approval/shell-screening';
import { ClientStore } from './storage/client-store';
import { SessionMultiplexer } from './session/session-multiplexer';
import { TitleOrganizer } from './organizer/title-organizer';
import { estimateTokens, TelemetryStore } from './telemetry/telemetry-store';
import { readSessionCheckpointLimit } from './telemetry/checkpoint-limit-reader';
import { ThoughtTranslator } from './translation/thought-translator';
import { SwarmTracker } from './swarm/swarm-tracker';
import { readAccountQuota } from './accounts/account-quota';
import { AccountManager } from './accounts/account-manager';
import { HistoryImporter } from './history/history-importer';
import { PluginsManager, type CliExecutor } from './plugins/plugins-manager';
import { WorkspaceFiles } from './workspace/workspace-files';
import { InspectorStore } from './session/inspector-store';

import { prepareRevision, revisionContext } from '../shared/message-revision';
import type { ReviseMessageInput } from '../shared/ipc-channels';
import { withoutSession, type SessionAction } from '../shared/session-contract';
import { AgentQuestions } from './session/agent-questions';
import type { QuestionSubmission } from '../shared/user-question';
import { modelMessage, restoreAnnotatedMessage } from './session/annotation-prompt';
import { appendImage } from './session/message-images';
import { LocalTranslator } from './translation/local-translator';
import { GitHubUpdater, type GitHubUpdaterOptions } from './updater/github-updater';

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

const REVIEWER_SECRET_FILE = 'reviewer-secret.enc';
const VALID_THINKING_LEVELS = new Set<ExternalReviewerThinkingLevel>(['auto', 'off', 'minimal', 'low', 'medium', 'high']);

function sanitizeStoredApprovalConfig(raw: unknown, restoredApiKey?: string): ApproveForMeConfig {
  const base = structuredClone(DEFAULT_APPROVAL_CONFIG);
  if (!raw || typeof raw !== 'object') {
    if (restoredApiKey) base.externalReviewer.apiKey = restoredApiKey;
    return base;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.mode === 'manual' || rec.mode === 'rules-only' || rec.mode === 'hybrid') base.mode = rec.mode;
  if (typeof rec.enableSafeDownloadAutoApprove === 'boolean') base.enableSafeDownloadAutoApprove = rec.enableSafeDownloadAutoApprove;
  if (typeof rec.maxDownloadSizeMB === 'number' && Number.isFinite(rec.maxDownloadSizeMB) && rec.maxDownloadSizeMB >= 0) {
    base.maxDownloadSizeMB = rec.maxDownloadSizeMB;
  }
  if (typeof rec.cacheTtlHours === 'number' && Number.isFinite(rec.cacheTtlHours)) {
    base.cacheTtlHours = Math.min(168, Math.max(0, rec.cacheTtlHours));
  }
  for (const field of ['allowPatterns', 'askPatterns', 'denyPatterns'] as const) {
    if (Array.isArray(rec[field])) {
      const valid: string[] = [];
      for (const item of rec[field] as unknown[]) {
        if (typeof item !== 'string' || valid.length >= 50) continue;
        try { compileSafePattern(item); valid.push(item); } catch { /* 跳过损坏的旧正则，保留其余全部规则 */ }
      }
      base[field] = valid;
    }
  }
  if (rec.externalReviewer && typeof rec.externalReviewer === 'object') {
    const ext = rec.externalReviewer as Record<string, unknown>;
    if (ext.provider === 'gemini-api-key' || ext.provider === 'openai-compatible' || ext.provider === 'local-ollama') {
      base.externalReviewer.provider = ext.provider;
    }
    if (typeof ext.endpoint === 'string' && ext.endpoint.trim()) base.externalReviewer.endpoint = ext.endpoint.trim();
    if (typeof ext.model === 'string' && ext.model.trim()) base.externalReviewer.model = ext.model.trim();
    if (typeof ext.timeoutMs === 'number' && Number.isFinite(ext.timeoutMs)) {
      base.externalReviewer.timeoutMs = Math.min(60_000, Math.max(100, Math.round(ext.timeoutMs)));
    }
    if (typeof ext.maxOutputTokens === 'number' && Number.isFinite(ext.maxOutputTokens)) {
      base.externalReviewer.maxOutputTokens = Math.min(65_536, Math.max(64, Math.round(ext.maxOutputTokens)));
    } else {
      base.externalReviewer.maxOutputTokens = EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens;
    }
    // 兼容旧版保存的 reasoningEffort 字段，平滑迁移到 thinkingLevel
    const rawLevel = typeof ext.thinkingLevel === 'string'
      ? ext.thinkingLevel
      : typeof ext.reasoningEffort === 'string'
        ? ext.reasoningEffort
        : undefined;
    if (rawLevel && VALID_THINKING_LEVELS.has(rawLevel.toLowerCase() as ExternalReviewerThinkingLevel)) {
      base.externalReviewer.thinkingLevel = rawLevel.toLowerCase() as ExternalReviewerThinkingLevel;
    }
    if (ext.connectionStatus === 'untested' || ext.connectionStatus === 'connected' || ext.connectionStatus === 'failed') {
      base.externalReviewer.connectionStatus = ext.connectionStatus as ExternalReviewerConnectionStatus;
    }
    if (typeof ext.lastVerifiedAt === 'string' && ext.lastVerifiedAt.trim()) {
      base.externalReviewer.lastVerifiedAt = ext.lastVerifiedAt.trim();
    }
    const effectiveKey = restoredApiKey || (typeof ext.apiKey === 'string' && ext.apiKey.trim() ? ext.apiKey.trim() : undefined);
    if (effectiveKey) base.externalReviewer.apiKey = effectiveKey;
    const wantsEnabled = Boolean(ext.enabled);
    if (wantsEnabled) {
      try {
        validateExternalEndpoint({ ...base.externalReviewer, enabled: true });
        base.externalReviewer.enabled = true;
      } catch {
        // 仅当远端服务缺少可恢复密钥或地址无效时自动回落关闭，其余字段原样保留
        base.externalReviewer.enabled = false;
      }
    }
  }
  // 严格遵循：未正常连接外部复核时不允许处于 AI 代审（hybrid），自动降级为基础规则通过机制（rules-only）
  if (base.mode === 'hybrid' && !isExternalReviewerConnected(base.externalReviewer)) {
    base.mode = 'rules-only';
  }
  return base;
}

export const DEFAULT_PREFERENCES: ClientPreferences = { locale: 'zh-CN', theme: 'claude-code-dark', appIcon: 'gravity-claude-dark', defaultThoughtTrack: 'zh', translationEngine: 'local', processPerSession: false, activeProfileId: 'default', defaultWorkspaceCwd: '', projects: [], autoCheckUpdates: true };
export const DEFAULT_LAYOUT: WorkspaceLayoutState = { openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null, layoutMode: 'single', hideLegacyPollutionSessions: true, leftSidebarCollapsed: false, leftSidebarWidth: 260, rightInspectorCollapsed: false, rightInspectorWidth: 360, activeInspectorTab: 'context', splitRatio: 0.5 };
export interface CoreServiceOptions { dataDir: string; acp?: AcpClient; acpOptions?: AcpClientOptions; reviewer?: Reviewer; modelDiscoveryFetcher?: typeof fetch; secretCipher?: SecretCipher; translator?: ThoughtTranslator; historyRoots?: string[]; pluginsExecutor?: CliExecutor; homeDir?: string; now?: () => number; appVersion?: string; enableAutoUpdateCheck?: boolean; updaterOptions?: Partial<GitHubUpdaterOptions>; windowChrome?: 'win-overlay' | 'mac-inset' | 'standard'; setIcon?: (iconId: GravityIconId) => void | Promise<void>; setZoom?: (factor: number) => void; onThemeChanged?: (preferences: ClientPreferences) => void; openTargetHandler?: (resolvedTarget: string, mode: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy' | 'copy-image', isDirectory?: boolean) => void | Promise<void>; selectDirectoryHandler?: (defaultPath?: string) => Promise<string | null> }
/** 主进程的业务入口。窗口请求进入此处，ACP 更新按会话分发给消息、审批、统计和检视器，再由事件通知渲染层。 */
export class CoreService extends EventEmitter {
  readonly store: ClientStore; readonly client: AcpClient; readonly sessions: SessionMultiplexer; readonly approval: ApprovalEngine;
  readonly telemetry: TelemetryStore; readonly titles: TitleOrganizer; readonly thoughts: ThoughtTranslator; readonly swarm: SwarmTracker;
  readonly accounts: AccountManager; readonly history: HistoryImporter; readonly plugins: PluginsManager;
  readonly inspector: InspectorStore; readonly updater: GitHubUpdater; readonly workspaceFiles = new WorkspaceFiles();
  private preferences: ClientPreferences;
  private layout: WorkspaceLayoutState;
  private messages = new Map<string, ChatMessageItem[]>();
  private assistantMessages = new Map<string, ChatMessageItem>();
  private thoughtOwners = new Map<string, { sessionId: string; message: ChatMessageItem }>();
  private customAnswers = new Map<string, string[]>();
  private questions = new AgentQuestions(m => {
    if (m.question?.state === 'open') this.finishAssistantMessage(m.sessionId);
    this.upsert(m);
  }, id => this.sessions.isActive(id), (id, text) => {
    this.customAnswers.set(id, [...this.customAnswers.get(id) || [], text]);
  });
  private feedback = new Map<string, string[]>();
  private compactAvailable = new Set<string>();
  private reactiveTurnTimers = new Map<string, NodeJS.Timeout>();
  private reactiveWakeupActive = new Set<string>();
  private replayedUsers = new Map<string, ChatMessageItem>();
  private disposed = false;
  private skipReplayedMessages = new Set<string>();
  private quotaRequests = new Map<string, ReturnType<typeof readAccountQuota>>();
  private managing = new Set<string>();
  private revising = new Set<string>();
  private ephemeralSessionIds = new Set<string>();
  private titleOrganizeTimestamps: number[] = [];
  private organizingTitles = false;
  private localTranslator = new LocalTranslator();
  private guardActiveSessions = new Map<string, { count: number; modelLabel: string }>();
  private checkpointSyncAt = new Map<string, number>();
  private checkpointResolvedModel = new Map<string, string>();
  private turnUserCancelled = new Set<string>();
  private turnStreamInterrupted = new Set<string>();
  private turnAutoDenied = new Map<string, Array<{ toolCallId?: string; toolName: string; command: string; reason: string }>>();
  private autoDeniedByToolCall = new Map<string, string>();
  private bootstrapping?: Promise<AppBootstrapPayload>;
  private telemetryPush?: NodeJS.Timeout;
  private autoUpdateTimer?: NodeJS.Timeout;
  constructor(private options: CoreServiceOptions) {
    super(); this.store = new ClientStore(options.dataDir);
    this.preferences = { ...DEFAULT_PREFERENCES, ...this.store.read('preferences.json', {}) };
    if (this.preferences.translationEngine !== 'local') {
      this.preferences.translationEngine = 'local';
      this.store.write('preferences.json', this.preferences);
    }
    if (!THEME_PRESETS.some(theme => theme.id === this.preferences.theme) && !['custom', 'system'].includes(this.preferences.theme)) this.preferences.theme = DEFAULT_PREFERENCES.theme;
    if (!GRAVITY_ICON_VARIANTS.some(icon => icon.id === this.preferences.appIcon)) this.preferences.appIcon = DEFAULT_PREFERENCES.appIcon;
    if (this.preferences.customTheme) {
      const rescued = sanitizeCustomThemeConfig(this.preferences.customTheme);
      if (rescued) this.preferences.customTheme = rescued;
      else { delete this.preferences.customTheme; if (this.preferences.theme === 'custom') this.preferences.theme = DEFAULT_PREFERENCES.theme; }
    }
    if (this.preferences.theme === 'custom' && !this.preferences.customTheme) this.preferences.theme = DEFAULT_PREFERENCES.theme;
    if (this.preferences.thoughtExpandedByDefault !== undefined && typeof this.preferences.thoughtExpandedByDefault !== 'boolean') {
      delete this.preferences.thoughtExpandedByDefault;
    }
    const stored = this.store.read<Partial<Omit<WorkspaceLayoutState, 'layoutMode'>> & {
      layoutMode?: WorkspaceLayoutState['layoutMode'] | 'grid-4'; tertiarySessionId?: string; quaternarySessionId?: string;
    }>('layout.json', {});
    const { tertiarySessionId, quaternarySessionId, layoutMode, ...saved } = stored;
    this.layout = { ...DEFAULT_LAYOUT, ...saved, layoutMode: layoutMode === 'grid-4' || layoutMode === 'split-2' ? 'split-2' : 'single' };
    if (layoutMode === 'grid-4') {
      this.layout.openTabSessionIds = [...new Set([...this.layout.openTabSessionIds, tertiarySessionId, quaternarySessionId].filter((id): id is string => Boolean(id)))];
    }
    if (!isRightInspectorTab(this.layout.activeInspectorTab)) this.layout.activeInspectorTab = DEFAULT_LAYOUT.activeInspectorTab;
    // 启动时修复越界的栏宽与分屏比例，避免一个坏值让之后所有布局保存都被整体拒绝。
    const fitWidth = (value: unknown, key: 'leftSidebarWidth' | 'rightInspectorWidth') => {
      const { min, max } = LAYOUT_LIMITS[key];
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : DEFAULT_LAYOUT[key];
    };
    this.layout.leftSidebarWidth = fitWidth(this.layout.leftSidebarWidth, 'leftSidebarWidth');
    this.layout.rightInspectorWidth = fitWidth(this.layout.rightInspectorWidth, 'rightInspectorWidth');
    this.layout.splitRatio = clampSplitRatio(this.layout.splitRatio);
    if (this.layout.inspectorFloating !== undefined && typeof this.layout.inspectorFloating !== 'boolean') {
      delete this.layout.inspectorFloating;
    }
    if (this.layout.composerMinHeight !== undefined) {
      const { min, max } = LAYOUT_LIMITS.composerMinHeight;
      if (typeof this.layout.composerMinHeight === 'number' && Number.isFinite(this.layout.composerMinHeight)) {
        this.layout.composerMinHeight = Math.min(max, Math.max(min, Math.round(this.layout.composerMinHeight)));
      } else {
        delete this.layout.composerMinHeight;
      }
    }
    if (this.preferences.uiScale !== undefined) this.preferences.uiScale = clampUiScale(this.preferences.uiScale);
    this.client = options.acp || new AcpClient({ ...options.acpOptions, args: options.acpOptions?.args || ['acp', ...(this.preferences.processPerSession ? ['--process-per-session'] : [])] });
    this.sessions = new SessionMultiplexer(this.client, this.store);
    const rawApproval = this.store.read<unknown>('approval-config.json', null);
    const restoredApiKey = this.loadStoredReviewerApiKey();
    const config = sanitizeStoredApprovalConfig(rawApproval, restoredApiKey);
    try { this.approval = new ApprovalEngine({ store: this.store, config, reviewer: options.reviewer }); }
    catch { this.approval = new ApprovalEngine({ store: this.store, reviewer: options.reviewer }); }
    this.telemetry = new TelemetryStore({ store: this.store });
    this.swarm = new SwarmTracker(this.store);
    this.inspector = new InspectorStore(this.store);
    this.titles = new TitleOrganizer(this.store);
    this.thoughts =
      options.translator ||
      new ThoughtTranslator(originalText => this.localTranslator.translate(originalText));
    // 默认与外部 Antigravity 历史完全隔离（roots=[]），仅在显式指定 historyRoots（如单测）时扫描
    this.history = new HistoryImporter({ roots: options.historyRoots ?? [], cacheDir: join(options.dataDir, 'history-cache') });
    this.plugins = new PluginsManager({ store: this.store, binaryPath: options.acpOptions?.binaryPath, executor: options.pluginsExecutor, homeDir: options.homeDir });
    this.updater = new GitHubUpdater({
      currentVersion: options.appVersion || APP_BRAND.version,
      updatesDir: join(options.dataDir, 'updates'),
      ...options.updaterOptions,
    });
    this.updater.on('state', (state: AppUpdateState) => this.emit('update-state', state));
    if (options.enableAutoUpdateCheck && this.preferences.autoCheckUpdates !== false) {
      this.autoUpdateTimer = setTimeout(() => {
        this.autoUpdateTimer = undefined;
        if (!this.disposed && this.preferences.autoCheckUpdates !== false) {
          void this.updater.checkForUpdates().catch(() => {});
        }
      }, 4500);
      this.autoUpdateTimer.unref?.();
    }
    // 切换账号要跨越两套会话状态。旧消息在切换前保存，新账号的消息在窗格和内存索引清空后载入。
    this.accounts = new AccountManager({ store: this.store, client: this.client, sessions: this.sessions,
      beforeSwitch: async () => { if (this.managing.size) throw new Error('正在保存会话变更'); this.questions.cancel(); this.customAnswers.clear(); this.approval.dispose(); this.feedback.clear(); this.saveMessages(); },
      afterSwitch: profileId => {
        this.thoughts.dispose();
        for (const id of this.reactiveTurnTimers.keys()) this.clearReactiveTurnTimer(id);
        this.guardActiveSessions.clear();
        this.checkpointSyncAt.clear();
        this.checkpointResolvedModel.clear();
        this.turnUserCancelled.clear();
        this.turnStreamInterrupted.clear();
        this.turnAutoDenied.clear();
        this.autoDeniedByToolCall.clear();
        for (const id of this.messages.keys()) this.telemetry.remove(id);
        this.assistantMessages.clear(); this.thoughtOwners.clear(); this.compactAvailable.clear(); this.messages.clear();
        this.preferences.activeProfileId = profileId; this.store.write('preferences.json', this.preferences);
        this.layout = { ...this.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null };
        this.store.write('layout.json', this.layout); this.loadProfileData();
      },
    });
    this.preferences.activeProfileId = this.accounts.activeProfileId; this.loadProfileData();
    this.accounts.on('updated', state => this.emit('account-updated', state));
    this.history.on('updated', records => this.emit('history-updated', records));
    this.inspector.on('updated', data => this.emit('inspector-updated', data));
    // 权限请求由代理反向发起。先确认会话仍激活，再把请求交给审批引擎等待决定。
    this.client.registerRequestHandler('elicitation/create', (raw, id) => this.questions.request(raw, id));
    this.client.on('$/cancel_request', ({ requestId } = {}) => { if (requestId !== undefined) this.questions.cancel(undefined, requestId); });
    this.client.registerRequestHandler('session/request_permission', (raw) => {
      const params = raw as AcpRequestPermissionParams;
      if (!params?.sessionId || !this.sessions.isActive(params.sessionId)) return { outcome: { outcome: 'cancelled' } };
      return this.approval.requestPermission(params, this.sessions.get(params.sessionId).cwd);
    });
    this.client.on('disconnected', () => { this.questions.cancel(); this.customAnswers.clear(); this.approval.dispose(); });
    this.client.on('rateLimited', (warning: string) => {
      for (const session of this.sessions.sessions.values()) if (this.sessions.isActive(session.sessionId)) this.upsert({ id: randomUUID(), sessionId: session.sessionId, role: 'system', content: warning, createdAt: new Date().toISOString() });
    });
    this.sessions.on('session', (session: ManagedSessionSummary) => this.emit('session-updated', this.titles.apply(session)));
    this.sessions.on('update', (payload: AcpSessionUpdateNotification) => this.consumeUpdate(payload));
    this.sessions.on('localPreference', ({ sessionId, text }) => this.upsert({ id: randomUUID(), sessionId, role: 'system', content: text, createdAt: new Date().toISOString() }));
    this.sessions.on('cancelled', (id: string) => { this.questions.cancel(id); this.customAnswers.delete(id); this.approval.cancelSession(id); this.feedback.delete(id); });
    this.sessions.on('closed', (id: string) => { this.questions.cancel(id); this.customAnswers.delete(id); this.approval.cancelSession(id); this.telemetry.cancelTurn(id); });
    this.approval.on('requested', request => { this.sessions.setStatus(request.sessionId, 'waiting_approval'); this.emit('approval-requested', request); });
    this.approval.on('resolved', payload => {
      if (!this.approval.listPending().some(item => item.sessionId === payload.sessionId)) this.sessions.setStatus(payload.sessionId, this.sessions.isBusy(payload.sessionId) ? 'streaming' : 'idle');
      this.emit('approval-resolved', payload);
    });
    this.approval.on('feedback', ({ sessionId, text }) => {
      const list = this.feedback.get(sessionId) || []; list.push(text); this.feedback.set(sessionId, list);
      this.upsert({ id: randomUUID(), sessionId, role: 'system', content: `已拒绝操作。反馈将在当前执行结束后发送给智能体：${text}`, createdAt: new Date().toISOString() });
    });
    this.approval.on('audit', (entry: ApprovalAuditEntry) => {
      if (entry.verdict !== 'denied' || entry.decisionSource !== 'local-rule') return;
      const list = this.turnAutoDenied.get(entry.sessionId) || [];
      list.push({ toolCallId: entry.toolCallId, toolName: entry.toolName, command: entry.commandOrSummary, reason: entry.reason });
      this.turnAutoDenied.set(entry.sessionId, list);
      if (entry.toolCallId) {
        this.autoDeniedByToolCall.set(`${entry.sessionId}\0${entry.toolCallId}`, entry.reason);
        const activeMsg = this.assistantMessages.get(entry.sessionId);
        const card = activeMsg?.toolCalls?.find((tc) => tc.toolCallId === entry.toolCallId);
        if (card && (!card.outputPreview || /^\s*(?:\{\s*"output"\s*:\s*""\s*\})?\s*$/.test(card.outputPreview))) {
          card.outputPreview = `已由本地安全策略拦截：${entry.reason}`;
          this.upsert(activeMsg!);
        }
      }
    });
    this.approval.on('config-updated', (cfg: ApproveForMeConfig) => {
      this.persistApprovalConfig(cfg);
    });
    this.approval.on('guard-activity', (ev: ApprovalGuardActivityEvent) => {
      this.guardActiveSessions.set(ev.sessionId, { count: ev.autoApprovedCount, modelLabel: ev.modelLabel });
      this.swarm.ingest(ev.sessionId, 'invoke_subagent', {
        name: 'approval-guard',
        role: 'Approve for me 安全代审守卫',
        model: ev.modelLabel,
        brief: '多命令密集运行实时审查（本地多段 AST 语义快筛 / 独立模型复核，零订阅额度消耗）',
        status: 'working',
      });
    });
    this.approval.on('external-review-usage', (ev: ExternalReviewerUsageRecordInput) => {
      this.telemetry.recordExternalReviewUsage(ev);
    });
    this.thoughts.on('block', block => {
      const owner = this.thoughtOwners.get(block.id); if (!owner) return;
      owner.message.thoughts = [block]; this.upsert(owner.message);
      if (!owner.message.isStreaming && !block.isStreaming && !block.isTranslating) {
        if (this.assistantMessages.get(owner.sessionId) !== owner.message) this.saveMessages();
        this.thoughtOwners.delete(block.id);
        this.thoughts.clear(block.id);
      }
    });
    // Token 事件可很密集：跨进程看板最多每 100ms 推送一次，主回复流不节流。
    this.telemetry.on('updated', () => {
      if (!this.telemetryPush) { this.telemetryPush = setTimeout(() => { this.telemetryPush = undefined; this.emit('telemetry-updated', this.telemetry.snapshot()); }, 100); this.telemetryPush.unref(); }
    });
    this.swarm.on('updated', state => this.emit('swarm-updated', state));
  }
  private messagesFile(): string { return `messages-${this.accounts.activeProfileId}.json`; }
  private loadProfileData(): void {
    this.loadMessages();
    const profileId = this.accounts.activeProfileId;
    const owned = new Set(this.sessions.sessions.keys());
    this.inspector.setProfile(profileId, owned);
    this.swarm.setProfile(profileId, owned);
    const pending = this.store.read<string[]>('pending-session-deletes-' + profileId + '.json', []);
    for (const id of pending) this.finishDeletion(id);
  }
  getPreferences(): ClientPreferences { return structuredClone(this.preferences); }
  private saveMessages(): void { this.store.write(this.messagesFile(), Object.fromEntries(this.messages)); }
  /**
   * 恢复每个会话最近 500 条消息，并重置流式标记。
   * 默认 Profile 可读取旧版消息文件，缺少归属清单时以本地消息补建。
   */
  private loadMessages(): void {
    const saved = this.store.read<Record<string, ChatMessageItem[]>>(this.messagesFile(), this.accounts.activeProfileId === 'default' ? this.store.read('messages.json', {}) : {});
    const seedEntries: Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }> = [];
    const hasLedger = this.sessions.hasPersistedLedger();
    for (const [id, items] of Object.entries(saved || {})) {
      if (!Array.isArray(items) || (hasLedger && !this.sessions.sessions.has(id))) continue;
      const normalizedItems = items.slice(-500).filter(item => item && typeof item.id === 'string').map(item => ({
        ...restoreAnnotatedMessage(item), isStreaming: false,
        question: item.question?.state === 'open' ? { ...item.question, state: 'cancelled' as const } : item.question,
        thoughts: item.thoughts?.map(block => ({ ...block, isStreaming: false, isTranslating: false })),
      }));
      this.messages.set(id, normalizedItems);
      const firstUser = normalizedItems.find(m => m.role === 'user')?.content || '';
      if (normalizedItems.length > 0 && !isLegacyPollutionSessionTitle(firstUser)) {
        const plainTitle = firstUser.replace(/\s+/g, ' ').trim().slice(0, 36) || '新建对话';
        seedEntries.push({
          sessionId: id,
          title: plainTitle,
          cwd: this.options.homeDir || homedir(),
          updatedAt: normalizedItems.at(-1)?.createdAt || new Date().toISOString(),
        });
      }
    }
    // 已有归属清单时以清单为准，避免根据遗留消息重新加入先前移出的会话。
    if (!this.sessions.hasPersistedLedger()) {
      this.sessions.seedOwnedFromLocalMessages(seedEntries);
    }
  }
  private upsert(message: ChatMessageItem): void {
    const items = this.messages.get(message.sessionId) || []; const index = items.findIndex(item => item.id === message.id);
    if (index >= 0) items[index] = message; else items.push(message);
    this.messages.set(message.sessionId, items.slice(-500)); this.emit('message-upserted', { sessionId: message.sessionId, message: structuredClone(message) });
  }
  private assistant(sessionId: string): ChatMessageItem {
    let message = this.assistantMessages.get(sessionId);
    if (!message) { message = { id: randomUUID(), sessionId, role: 'assistant', content: '', isStreaming: true, createdAt: new Date().toISOString() }; this.assistantMessages.set(sessionId, message); }
    return message;
  }
  private clearTransientStreamWarning(sessionId: string, message: ChatMessageItem): boolean {
    if (!containsTransientStreamInterruption(message.content)) return false;
    message.content = stripTransientStreamInterruptions(message.content);
    this.turnStreamInterrupted.delete(sessionId);
    return true;
  }
  /** 按 ACP 更新类型合并增量。回复正文、思考、工具状态和用量共享 sessionId，各自维护自己的累计方式。 */
  private consumeUpdate({ sessionId, update }: AcpSessionUpdateNotification): void {
    if (this.disposed) return;
    const replaying = this.sessions.isResuming(sessionId);
    if (replaying && this.skipReplayedMessages.has(sessionId) &&
        !['available_commands_update', 'current_mode_update', 'config_option_update'].includes(update.sessionUpdate)) return;
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan'].includes(update.sessionUpdate)) {
      this.finishReplayedUser(sessionId);
    }
    if (update.sessionUpdate === 'plan') {
      this.inspector.consume(sessionId, update);
      const todos = this.inspector.get(sessionId).todos;
      if (todos.length >= 2) this.approval.enableBurstGuard(sessionId);
      const message = this.assistant(sessionId);
      this.clearTransientStreamWarning(sessionId, message);
      message.todos = todos;
      this.upsert(message);
    }
    if (update.sessionUpdate === 'current_mode_update' && ['default', 'accept-edits', 'plan', 'auto'].includes(update.currentModeId || '')) {
      const nextMode = update.currentModeId as AgentExecutionMode;
      this.sessions.get(sessionId).executionMode = nextMode;
      this.approval.setSessionExecutionMode(sessionId, nextMode);
      this.sessions.setStatus(sessionId, this.sessions.get(sessionId).status);
    }
    const text = update.content?.text || '';
    if (update.sessionUpdate === 'available_commands_update') {
      const commands = (update as unknown as { availableCommands?: Array<{ name: string }> }).availableCommands;
      if (commands?.some(command => command.name === 'compact')) this.compactAvailable.add(sessionId);
    }
    if (update.sessionUpdate === 'usage_update') {
      if (typeof update.used === 'number' || typeof update.size === 'number') {
        this.telemetry.applyContextWindow(sessionId, update.used, update.size);
      }
      if (update.usage) this.telemetry.applyUsage(sessionId, update.usage);
      if (!replaying) this.maybeSyncSessionCheckpointWindow(sessionId);
      if (this.reactiveWakeupActive.has(sessionId)) {
        this.scheduleReactiveTurnSettle(sessionId, true);
      }
    }
    // 后台子个体完成触发的服务端主动唤醒回合（!isBusy）：同步归档子个体状态并在输出收敛后自动收口流式光标
    const isReactiveAgentUpdate =
      !replaying && !this.sessions.isBusy(sessionId) &&
      ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate);
    if (isReactiveAgentUpdate && !this.reactiveWakeupActive.has(sessionId)) {
      this.reactiveWakeupActive.add(sessionId);
      if (this.sessions.isActive(sessionId)) {
        this.sessions.setStatus(sessionId, 'streaming');
      }
      this.swarm.markWorkingSubagentsCompleted(sessionId);
    }

    if (update.sessionUpdate === 'user_message_chunk') {
      if (replaying) {
        this.finishAssistantMessage(sessionId);
        const message = this.replayedUsers.get(sessionId) || { id: randomUUID(), sessionId, role: 'user', content: '', createdAt: new Date().toISOString() };
        message.content += text;
        appendImage(message, update.content);
        this.replayedUsers.set(sessionId, message);
        return;
      }
      // Our outgoing turn was already published with the user's structured annotations.
      if (this.sessions.isBusy(sessionId)) return;
      const items = this.messages.get(sessionId) || []; const previous = items.at(-1);
      const message: ChatMessageItem = previous?.role === 'user' && previous.isStreaming ? previous : { id: randomUUID(), sessionId, role: 'user', content: '', isStreaming: true, createdAt: new Date().toISOString() };
      appendImage(message, update.content);
      message.content += text; this.upsert(message); return;
    }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const message = this.assistant(sessionId);
      if (update.sessionUpdate === 'agent_message_chunk') {
        this.completeStreamingThoughts(message);
        appendImage(message, update.content);
        message.content += text;
        if (containsTransientStreamInterruption(message.content)) {
          const cleaned = stripTransientStreamInterruptions(message.content);
          if (cleaned.length > 0) {
            // 流式已恢复并输出真实正文，自动清除此前残留的瞬态中断提示
            message.content = cleaned;
            this.turnStreamInterrupted.delete(sessionId);
          } else {
            this.turnStreamInterrupted.add(sessionId);
          }
        }
        this.telemetry.addChunk(sessionId, text);
      } else {
        if (text.trim()) this.clearTransientStreamWarning(sessionId, message);
        const id = `${message.id}:thought`;
        this.thoughtOwners.set(id, { sessionId, message });
        const prev = message.thoughts?.[0];
        const prefix = prev && !prev.isStreaming && prev.originalText && !prev.originalText.endsWith('\n') && !text.startsWith('\n') ? '\n\n' : '';
        message.thoughts = [this.thoughts.append(id, prefix + text)];
        this.telemetry.addChunk(sessionId, text, 'thoughtTokens');
      }
      this.upsert(message);
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.swarm.consume(sessionId, update); if (!update.toolCallId) return;
      const message = this.assistant(sessionId);
      this.completeStreamingThoughts(message);
      // 工具创建和后续状态通知共用 toolCallId。传入旧卡片以保留增量更新里省略的字段。
      const cards = message.toolCalls ||= [];
      const index = cards.findIndex(card => card.toolCallId === update.toolCallId);
      const toolResults = Array.isArray(update.content) ? update.content : update.toolContent || [];
      for (const result of toolResults) appendImage(message, result);
      const card = this.inspector.consume(sessionId, update, index >= 0 ? cards[index] : undefined);
      if (card) {
        if (card.status === 'failed' && (!card.outputPreview || /^\s*(?:\{\s*"output"\s*:\s*""\s*\})?\s*$/.test(card.outputPreview))) {
          const denyReason = this.autoDeniedByToolCall.get(`${sessionId}\0${update.toolCallId}`);
          if (denyReason) {
            card.outputPreview = `已由本地安全策略拦截：${denyReason}`;
          } else if ((this.turnAutoDenied.get(sessionId)?.length || 0) > 0) {
            card.outputPreview = '因同批次其他命令触发本地安全策略拦截，此并行命令被一并取消';
          }
        }
        if (index >= 0) cards[index] = card; else cards.push(card);
        if (update.sessionUpdate === 'tool_call' || (card.status !== 'failed' && card.status !== 'rejected')) {
          this.clearTransientStreamWarning(sessionId, message);
        }
      }
      if (!replaying && update.sessionUpdate === 'tool_call') {
        this.maybeSyncSessionCheckpointWindow(sessionId);
      }
      this.telemetry.addChunk(sessionId, JSON.stringify(update), 'toolCallsTokens'); this.upsert(message);
    }
    if (isReactiveAgentUpdate) {
      this.scheduleReactiveTurnSettle(sessionId, false);
    }
  }
  private clearReactiveTurnTimer(sessionId: string): void {
    const timer = this.reactiveTurnTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reactiveTurnTimers.delete(sessionId);
    }
    this.reactiveWakeupActive.delete(sessionId);
  }
  /**
   * 服务端主动唤醒产生的回复没有本地 prompt 等待点，通过静默计时收尾。
   * 审批挂起时暂停收尾，计时到期再检查工具状态。
   */
  private scheduleReactiveTurnSettle(sessionId: string, usageArrived: boolean): void {
    const prev = this.reactiveTurnTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const activeMsg = this.assistantMessages.get(sessionId);
    const hasPendingTool = Boolean(
      activeMsg?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
    );
    const hasPendingApproval = this.approval.listPending().some((item) => item.sessionId === sessionId);
    if (hasPendingApproval) {
      this.reactiveTurnTimers.delete(sessionId);
      return;
    }
    const delayMs = hasPendingTool
      ? 8000
      : usageArrived && activeMsg?.content?.trim()
        ? 380
        : activeMsg?.content?.trim()
          ? 950
          : 2600;
    const timer = setTimeout(() => {
      this.reactiveTurnTimers.delete(sessionId);
      if (this.sessions.isBusy(sessionId)) return;
      const currentMsg = this.assistantMessages.get(sessionId);
      const stillRunningTool = Boolean(
        currentMsg?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
      );
      if (stillRunningTool || this.approval.listPending().some((item) => item.sessionId === sessionId)) {
        this.scheduleReactiveTurnSettle(sessionId, false);
        return;
      }
      this.reactiveWakeupActive.delete(sessionId);
      this.finishMessage(sessionId);
      if (this.sessions.isActive(sessionId) && this.sessions.get(sessionId).status === 'streaming') {
        this.sessions.setStatus(sessionId, 'idle');
      }
      this.syncSessionCheckpointWindow(sessionId);
    }, delayMs);
    timer.unref?.();
    this.reactiveTurnTimers.set(sessionId, timer);
  }
  private completeStreamingThoughts(message: ChatMessageItem): void {
    if (!message.thoughts?.length) return;
    message.thoughts = message.thoughts.map(block => (block.isStreaming ? this.thoughts.complete(block.id) || block : block));
  }
  private finishReplayedUser(sessionId: string): void {
    const message = this.replayedUsers.get(sessionId);
    if (message) {
      this.replayedUsers.delete(sessionId);
      this.upsert(restoreAnnotatedMessage(message));
    }
  }
  private finishAssistantMessage(sessionId: string): void {
    const message = this.assistantMessages.get(sessionId);
    if (message) { message.isStreaming = false; if (!message.completedAt) message.completedAt = new Date().toISOString(); for (const block of message.thoughts || []) this.thoughts.complete(block.id); this.upsert(message); }
    this.assistantMessages.delete(sessionId);
  }
  private finishMessage(sessionId: string): void {
    this.finishAssistantMessage(sessionId);
    const guardInfo = this.guardActiveSessions.get(sessionId);
    if (guardInfo) {
      this.guardActiveSessions.delete(sessionId);
      this.swarm.ingest(sessionId, 'post_message', {
        sender: 'approval-guard',
        channel: 'approval',
        content: `[done] 本轮已实时审查并自动放行 ${guardInfo.count} 项低风险操作（${guardInfo.modelLabel}）`,
      });
    }
    this.approval.resetTurnBurstCounter(sessionId);
    for (const item of this.messages.get(sessionId) || []) item.isStreaming = false;
    this.saveMessages();
  }
  /** 并发打开工作台时共用一次快照。连接失败仍返回本地会话记录，客户端可据此显示离线历史。 */
  async getBootstrap(): Promise<AppBootstrapPayload> {
    if (this.bootstrapping) return this.bootstrapping;
    this.bootstrapping = (async () => {
      let sessions: ManagedSessionSummary[] = [];
      try {
        sessions = await this.listSessions(true);
      } catch (error) {
        this.client.lastError = error instanceof Error ? error.message : 'ACP 连接失败';
        sessions = [...this.sessions.sessions.values()].map(item => this.titles.apply({ ...item }));
      }
      for (const s of sessions) {
        this.telemetry.hydrateFromMessages(s.sessionId, s.modelId, this.messages.get(s.sessionId) || []);
      }
      const importedHistory = await this.history.refresh();
      if (this.history.roots.length > 0) this.history.startWatching();
      return { preferences: { ...this.preferences }, connection: await this.getConnectionStatus(), accounts: this.accounts.getState(), importedHistory, plugins: this.plugins.getCachedSnapshot(), approvalConfig: this.approval.getConfig(), sessions, layout: structuredClone(this.layout), pendingApprovals: this.approval.listPending(), telemetry: this.telemetry.snapshot(), windowChrome: this.options.windowChrome ?? 'standard', updateState: this.updater.getState() };
    })();
    try { return await this.bootstrapping; } finally { this.bootstrapping = undefined; }
  }
  async getAccountQuota() {
    this.accounts.assertReady();
    const state = this.accounts.getState();
    const profile = state.profiles.find(p => p.profileId === state.activeProfileId)!;
    let query = this.quotaRequests.get(profile.profileId);
    if (!query) {
      query = readAccountQuota(profile, this.client.options.binaryPath).finally(() => this.quotaRequests.delete(profile.profileId));
      this.quotaRequests.set(profile.profileId, query);
    }
    return query;
  }
  async getConnectionStatus(): Promise<AcpConnectionStatus> { return { connected: this.client.connected, agyBinaryPath: this.client.binaryPath, agyVersion: this.client.initializeResult?.agentInfo?.version || '', agentServerVersion: this.client.initializeResult?.agentInfo?.version, activeSessionCount: this.sessions.activeSessionCount, maxParallelSessions: 4, activeProfileId: this.accounts.activeProfileId, availableModels: this.sessions.availableModels(), lastError: this.client.lastError }; }
  async updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences> {
    const next = { ...this.preferences, ...patch };
    next.translationEngine = 'local';
    if (!['zh-CN', 'en-US'].includes(next.locale) || !['zh', 'raw'].includes(next.defaultThoughtTrack) || !(['system', 'custom'].includes(next.theme) || THEME_PRESETS.some(theme => theme.id === next.theme)) || typeof next.processPerSession !== 'boolean' || !GRAVITY_ICON_VARIANTS.some(icon => icon.id === next.appIcon)) throw new Error('偏好设置格式无效');
    // Profile 切换还涉及关闭旧连接和加载新的消息索引，必须走账号管理器的完整切换流程。
    if (next.activeProfileId !== this.accounts.activeProfileId) throw new Error('切换 Profile 必须使用专用账号切换入口');
    if (next.customTheme) next.customTheme = validateCustomThemeConfig(next.customTheme);
    if (next.theme === 'custom' && !next.customTheme) throw new Error('请先导入或创建自定义主题');
    if (next.defaultWorkspaceCwd !== undefined) {
      if (typeof next.defaultWorkspaceCwd !== 'string' || next.defaultWorkspaceCwd.length > 1024 || next.defaultWorkspaceCwd.includes('\0')) {
        throw new Error('默认文件夹路径无效');
      }
      next.defaultWorkspaceCwd = next.defaultWorkspaceCwd.trim() ? normalizeWorkspacePath(next.defaultWorkspaceCwd.trim()) : '';
    }
    if (next.projects !== undefined) {
      if (!Array.isArray(next.projects) || next.projects.length > 60) {
        throw new Error('自定义项目数量无效');
      }
      // 先重建并校验项目清单，再整体保存偏好。相同目录只保留第一项，比较使用规范化的小写路径。
      const normalizedProjects: WorkspaceProjectConfig[] = [];
      const seenPaths = new Set<string>();
      for (const rawProj of next.projects) {
        if (!rawProj || typeof rawProj !== 'object') throw new Error('项目配置格式无效');
        const cleanPath = normalizeWorkspacePath(String(rawProj.path || '').trim());
        const cleanName = String(rawProj.name || '').trim().slice(0, 80);
        const isAbs = isAbsolute(cleanPath) || /^[A-Za-z]:[\\/]/.test(cleanPath) || cleanPath.startsWith('\\\\');
        if (!cleanPath || !isAbs || !cleanName) {
          throw new Error('项目名称不能为空且路径必须为绝对路径');
        }
        const pathKey = cleanPath.toLowerCase();
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);
        normalizedProjects.push({
          id: String(rawProj.id || randomUUID()).slice(0, 64),
          name: cleanName,
          path: cleanPath,
          description: rawProj.description ? String(rawProj.description).trim().slice(0, 240) : undefined,
          defaultMode:
            rawProj.defaultMode && ['default', 'accept-edits', 'plan', 'auto'].includes(rawProj.defaultMode)
              ? rawProj.defaultMode
              : undefined,
          defaultModelId: rawProj.defaultModelId ? String(rawProj.defaultModelId).trim().slice(0, 120) : undefined,
          pinned: Boolean(rawProj.pinned),
        });
      }
      next.projects = normalizedProjects;
    }
    if (this.client.connected && next.processPerSession !== this.preferences.processPerSession) throw new Error('请重启客户端后修改进程隔离设置');
    if (next.uiScale !== undefined) {
      if (typeof next.uiScale !== 'number' || !Number.isFinite(next.uiScale) || next.uiScale < UI_SCALE_LIMITS.min || next.uiScale > UI_SCALE_LIMITS.max) throw new Error('界面缩放倍率无效');
      next.uiScale = clampUiScale(next.uiScale);
    }
    if (next.autoCheckUpdates !== undefined && typeof next.autoCheckUpdates !== 'boolean') {
      throw new Error('自动检查更新设置无效');
    }
    if (next.thoughtExpandedByDefault !== undefined && typeof next.thoughtExpandedByDefault !== 'boolean') {
      throw new Error('思考区默认展开设置无效');
    }
    if (next.appIcon !== this.preferences.appIcon) await this.options.setIcon?.(next.appIcon);
    if ((next.uiScale ?? 1) !== (this.preferences.uiScale ?? 1)) this.options.setZoom?.(next.uiScale ?? 1);
    const themeChanged = next.theme !== this.preferences.theme || next.customTheme !== this.preferences.customTheme;
    this.preferences = next; this.store.write('preferences.json', next);
    if (themeChanged) this.options.onThemeChanged?.(structuredClone(next));
    if (!this.client.connected) { this.client.options.args = ['acp', ...(next.processPerSession ? ['--process-per-session'] : [])]; this.accounts.applyArgs(); }
    return structuredClone(next);
  }
  async selectDirectory(defaultPath?: string): Promise<string | null> {
    if (defaultPath !== undefined && (typeof defaultPath !== 'string' || defaultPath.length > 1024)) {
      throw new Error('无效的默认目录参数');
    }
    const picked = await this.options.selectDirectoryHandler?.(defaultPath?.trim() || this.preferences.defaultWorkspaceCwd || undefined);
    return picked ? normalizeWorkspacePath(picked) : null;
  }
  async getUpdateState(): Promise<AppUpdateState> { return this.updater.getState(); }
  async checkForUpdates(): Promise<AppUpdateState> { return this.updater.checkForUpdates(); }
  async downloadUpdate(): Promise<AppUpdateState> { return this.updater.downloadUpdate(); }
  async installUpdate(): Promise<{ launched: boolean; message: string }> { return this.updater.installUpdate(); }
  async launchOfficialLogin(profileId?: string) { return this.accounts.login(profileId); }
  async listSessions(includeHiddenPollution = false) { this.accounts.assertReady(); return (await this.sessions.listSessions(includeHiddenPollution)).map(item => this.titles.apply(item)); }
  private hasAntigravityOptions(sessionId?: string): boolean {
    const agentName = this.client.initializeResult?.agentInfo?.name || '';
    return agentName.toLowerCase().includes('antigravity') || Boolean(sessionId && this.sessions.hasConfigOptions(sessionId));
  }
  /** 在后台读取当前 Profile 里该会话的压缩阈值，成功后再更新看板并记录同模型学习值。缺失读数时继续使用已有窗口估计。 */
  private syncSessionCheckpointWindow(sessionId: string): void {
    if (!this.hasAntigravityOptions(sessionId)) return;
    const session = this.sessions.sessions.get(sessionId);
    const modelId = session?.modelId;
    const modelKey = (modelId || '').trim().toLowerCase();
    this.checkpointSyncAt.set(sessionId, this.nowMs());
    const activeProfile = this.accounts
      .getState()
      .profiles.find((p) => p.profileId === this.accounts.activeProfileId);
    void readSessionCheckpointLimit({
      sessionId,
      cacheDir: join(this.options.dataDir, 'checkpoint-cache'),
      isolatedAppDataDir: activeProfile?.isDefault ? undefined : activeProfile?.isolatedAppDataDir,
      homeDir: this.options.homeDir,
    })
      .then((limit) => {
        if (limit) {
          this.checkpointResolvedModel.set(sessionId, modelKey);
          this.telemetry.setCheckpointWindowLimit(sessionId, limit, modelId);
        }
      })
      .catch(() => {});
  }
  /** 回合进行中按 4 秒节流读取一次实测压缩阈值，避免长回合首轮一直停留在 256k 默认值。 */
  private maybeSyncSessionCheckpointWindow(sessionId: string): void {
    if (!this.hasAntigravityOptions(sessionId)) return;
    const modelKey = (this.sessions.sessions.get(sessionId)?.modelId || '').trim().toLowerCase();
    if (this.checkpointResolvedModel.get(sessionId) === modelKey && modelKey) return;
    const last = this.checkpointSyncAt.get(sessionId) || 0;
    if (this.nowMs() - last < 4000) return;
    this.syncSessionCheckpointWindow(sessionId);
  }
  async createSession(input: CreateSessionInput) {
    this.accounts.assertReady();
    if (input.executionMode && !['default', 'accept-edits', 'plan', 'auto'].includes(input.executionMode) || input.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoningEffort)) throw new Error('会话 Mode 或 Effort 无效');
    let session = await this.sessions.createSession(input);
    try {
      if (input.modelId && input.modelId !== session.modelId) session = await this.sessions.setSessionModel(session.sessionId, input.modelId);
      if (input.executionMode && input.executionMode !== session.executionMode) session = await this.sessions.setSessionMode(session.sessionId, input.executionMode);
      if (input.reasoningEffort && (input.reasoningEffort !== session.reasoningEffort ||
          session.availableEfforts?.every(level => level.value !== input.reasoningEffort))) session = await this.sessions.setSessionEffort(session.sessionId, input.reasoningEffort);
    // 初始模式、推理强度或模型设置失败时尝试关闭刚创建的会话，避免半配置的会话继续占用活动名额。
    } catch (error) { await this.sessions.closeSession(session.sessionId).catch(() => {}); throw error; }
    this.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
    this.telemetry.hydrateFromMessages(session.sessionId, session.modelId, this.messages.get(session.sessionId) || []);
    this.syncSessionCheckpointWindow(session.sessionId);
    return this.titles.apply(session);
  }
  async resumeSession(sessionId: string, cwd: string) {
    this.accounts.assertReady();
    if (this.managing.has(sessionId) || this.sessions.get(sessionId).archivedAt) throw new Error('请先从归档恢复会话');
    if (this.sessions.isActive(sessionId)) return this.titles.apply(this.sessions.get(sessionId));
    if (this.sessions.isResuming(sessionId)) throw new Error('此会话正在恢复');
    const hadLocalMessages = Boolean(this.messages.get(sessionId)?.length);
    if (hadLocalMessages) this.skipReplayedMessages.add(sessionId);
    let session: ManagedSessionSummary;
    try {
      session = await this.sessions.resumeSession(sessionId, cwd);
      this.finishReplayedUser(sessionId);
    } catch (error) {
      if (!hadLocalMessages) {
        this.messages.delete(sessionId);
        this.assistantMessages.delete(sessionId);
        for (const [id, owner] of this.thoughtOwners) if (owner.sessionId === sessionId) {
          this.thoughts.clear(id);
          this.thoughtOwners.delete(id);
        }
      }
      const localExisting = this.sessions.sessions.get(sessionId);
      // 已保存的对话可以离线阅读。只在恢复成功后重新启用输入和编辑。
      if (localExisting && hadLocalMessages && (!this.client.connected || this.hasAntigravityOptions())) {
        session = { ...localExisting, readOnly: true, status: 'closed' };
      } else {
        throw error;
      }
    } finally { this.skipReplayedMessages.delete(sessionId); this.replayedUsers.delete(sessionId); }
    this.approval.setSessionExecutionMode(session.sessionId, session.executionMode);
    this.telemetry.hydrateFromMessages(sessionId, session.modelId, this.messages.get(sessionId) || []);
    this.syncSessionCheckpointWindow(sessionId);
    this.finishMessage(sessionId);
    return this.titles.apply(session);
  }
  async closeSession(sessionId: string): Promise<void> { this.questions.cancel(sessionId); this.customAnswers.delete(sessionId); this.clearReactiveTurnTimer(sessionId); this.swarm.markWorkingSubagentsCompleted(sessionId, '会话已关闭'); this.approval.cancelSession(sessionId); await this.sessions.closeSession(sessionId); this.finishMessage(sessionId); }
  private finishDeletion(id: string): void {
    const profile = this.accounts.activeProfileId;
    for (const [key, owner] of this.thoughtOwners) if (owner.sessionId === id) {
      this.thoughtOwners.delete(key);
      this.thoughts.clear(key);
    }
    this.clearReactiveTurnTimer(id);
    this.feedback.delete(id); this.compactAvailable.delete(id); this.guardActiveSessions.delete(id);
    this.checkpointSyncAt.delete(id); this.checkpointResolvedModel.delete(id);
    this.turnUserCancelled.delete(id); this.turnStreamInterrupted.delete(id); this.turnAutoDenied.delete(id);
    for (const key of this.autoDeniedByToolCall.keys()) if (key.startsWith(`${id}\0`)) this.autoDeniedByToolCall.delete(key);
    this.assistantMessages.delete(id);
    this.messages.delete(id);
    this.saveMessages();
    this.inspector.remove(id);
    this.swarm.remove(id);
    this.titles.remove(profile, id);
    this.telemetry.remove(id);
    if (profile === 'default') {
      for (const file of ['messages.json', 'inspector-states.json', 'swarm-states.json']) {
        const legacy = this.store.read<Record<string, unknown>>(file, {});
        if (Object.hasOwn(legacy, id)) { delete legacy[id]; this.store.write(file, legacy); }
      }
    }
    this.sessions.forgetSession(id);
    this.layout = withoutSession(this.layout, id);
    this.store.write('layout.json', this.layout);
    const journal = 'pending-session-deletes-' + profile + '.json';
    this.store.write(journal, this.store.read<string[]>(journal, []).filter(item => item !== id));
  }
  async manageSession(id: string, action: SessionAction) {
    this.accounts.assertReady();
    if (!['archive', 'restore', 'delete'].includes(action)) throw new Error('未知会话操作');
    const journal = 'pending-session-deletes-' + this.accounts.activeProfileId + '.json';
    const pendingDelete = this.store.read<string[]>(journal, []).includes(id);
    if (pendingDelete && action !== 'delete') throw new Error('会话删除尚未完成');
    const session = pendingDelete ? this.sessions.sessions.get(id) : this.sessions.get(id);
    if (this.sessions.isBusy(id) || this.sessions.isResuming(id) || this.revising.has(id) || this.managing.has(id) ||
        session?.status === 'waiting_approval' || session?.status === 'streaming') throw new Error('请等待当前回合结束后再管理会话');
    this.managing.add(id);
    try {
      if (action !== 'restore' && this.sessions.isActive(id)) await this.closeSession(id);
      if (action === 'delete') {
        this.store.write(journal, [...new Set([...this.store.read<string[]>(journal, []), id])]);
        this.finishDeletion(id);
      } else {
        if (action === 'archive') {
          this.layout = withoutSession(this.layout, id);
          this.store.write('layout.json', this.layout);
        }
        const updated = { ...this.sessions.get(id), archivedAt: action === 'archive' ? session?.archivedAt || new Date().toISOString() : undefined };
        this.sessions.updateSessionRecord(updated);
        this.emit('session-updated', this.titles.apply(updated));
      }
      return { sessions: [...this.sessions.sessions.values()].map(s => this.titles.apply(s)), layout: structuredClone(this.layout) };
    } finally { this.managing.delete(id); }
  }
  async getSessionMessages(sessionId: string): Promise<ChatMessageItem[]> { return structuredClone(this.messages.get(sessionId) || []); }
  private userMessage(input: SendPromptInput): ChatMessageItem {
    return {
      id: randomUUID(), sessionId: input.sessionId, role: 'user', content: input.text, annotations: input.annotations,
      references: input.references, createdAt: new Date().toISOString(),
      attachments: (input.attachments || []).map(item => ({
        id: randomUUID(), name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, uri: item.uri,
        textContent: item.textContent, dataBase64: item.mimeType.startsWith('image/') ? undefined : item.dataBase64,
        dataUrl: item.dataBase64 && item.mimeType.startsWith('image/') ? 'data:' + item.mimeType + ';base64,' + item.dataBase64 : undefined,
      })),
    };
  }
  async reviseMessage(input: ReviseMessageInput): Promise<ManagedSessionSummary> {
    this.accounts.assertReady();
    const origin = this.sessions.get(input.sessionId);
    const profile = this.accounts.activeProfileId;
    if (origin.profileId !== profile || origin.readOnly || !this.sessions.isActive(origin.sessionId) ||
        this.sessions.isBusy(origin.sessionId) || this.revising.has(origin.sessionId) || this.managing.has(origin.sessionId)) {
      throw new Error('请等当前回合结束后再编辑');
    }
    const { prefix, references, attachments, annotations } = prepareRevision(this.messages.get(origin.sessionId) || [], input);
    let branch: ManagedSessionSummary | undefined;
    this.revising.add(origin.sessionId);
    try {
      // The edited branch replaces this live tab. Release the official worker first and restore it on failure.
      await this.closeSession(origin.sessionId);
      this.accounts.assertReady();
      if (profile !== this.accounts.activeProfileId) throw new Error('账号资料已切换');
      branch = await this.createSession({ cwd: origin.cwd, title: origin.title + ' · ' + (this.preferences.locale === 'en-US' ? 'Revision' : '修订'),
        executionMode: origin.executionMode, reasoningEffort: origin.availableEfforts?.length === 0 ? undefined : origin.reasoningEffort,
        modelId: origin.modelId || undefined });
      const id = branch.sessionId;
      if (profile !== this.accounts.activeProfileId) throw new Error('账号资料已切换');
      const history = prefix.map(m => {
        const copy = structuredClone(m);
        copy.id = randomUUID(); copy.sessionId = id; copy.revisionHistory = true; copy.isStreaming = false;
        delete copy.pendingApprovalId;
        for (const thought of copy.thoughts || []) { thought.id = randomUUID(); thought.isStreaming = false; thought.isTranslating = false; }
        return copy;
      });
      this.messages.set(id, [...history, ...(this.messages.get(id) || [])]);
      this.saveMessages();
      const revision = { sessionId: id, text: input.text, references, attachments, annotations };
      void this.sendPrompt(revision).catch(error => {
        if (this.disposed || this.accounts.activeProfileId !== profile || !this.sessions.sessions.has(id)) return;
        if (!(this.messages.get(id) || []).some(m => m.role === 'user' && !m.revisionHistory)) {
          this.upsert({ ...this.userMessage(revision), sendFailed: true });
        }
        this.upsert({ id: randomUUID(), sessionId: id, role: 'system', createdAt: new Date().toISOString(),
          content: '修订消息发送失败。' + (error instanceof Error ? error.message : String(error)) });
        this.saveMessages();
      });
      return branch;
    } catch (error) {
      if (profile === this.accounts.activeProfileId) {
        if (branch) await this.closeSession(branch.sessionId).catch(() => {});
        if (!this.sessions.isActive(origin.sessionId)) await this.resumeSession(origin.sessionId, origin.cwd).catch(() => {});
      }
      throw error;
    } finally { this.revising.delete(origin.sessionId); }
  }
  async sendPrompt(input: SendPromptInput): Promise<void> {
    this.accounts.assertReady();
    if (this.revising.has(input.sessionId) || this.managing.has(input.sessionId)) throw new Error('该会话正在创建修订分支');
    if (typeof input?.text !== 'string' || (input.annotations !== undefined && (!Array.isArray(input.annotations) ||
        input.annotations.some(a => !a || typeof a.excerpt !== 'string' || !a.excerpt.trim() || (a.comment !== undefined && typeof a.comment !== 'string'))))) throw new Error('消息格式无效');
    const wireText = modelMessage(input.text, input.annotations);
    if (wireText.length > 1000000 || (!wireText.trim() && !input.attachments?.length)) throw new Error('请输入有效的提示词');
    if (!this.sessions.isActive(input.sessionId) || this.sessions.isBusy(input.sessionId)) throw new Error('会话未激活或仍在生成');
    const profileId = this.accounts.activeProfileId; const session = this.sessions.get(input.sessionId);
    this.approval.setSessionExecutionMode(input.sessionId, session.executionMode);
    const isManualCompact = !input.annotations?.length && input.text.trim() === '/compact';
    const prompt: AcpPromptContentBlock[] = [...revisionContext(this.messages.get(input.sessionId) || []), { type: 'text', text: wireText }];
    // 旧会话缺少原生配置能力时，用额外提示文本传递模式偏好。支持该能力的会话经专门的配置请求设置。
    if (!this.sessions.hasNativeSessionOptions(input.sessionId) && (session.executionMode !== 'default' || session.reasoningEffort !== 'high')) {
      prompt.push({ type: 'text', text: `客户端本地偏好（不表示官方推理参数已改变）：Mode=${session.executionMode}，Effort=${session.reasoningEffort}。${session.executionMode === 'plan' ? '本轮先只读分析并制定计划，不执行文件修改。' : ''}权限操作仍须遵循审批结果。` });
    }
    // 每次最多展开 20 个引用。文件读取当前工作区的正文，会话引用只取最近 30 条消息，并截断拼接后的文本。
    for (const reference of (input.references || []).slice(0, 20)) {
      if (reference.kind === 'file') {
        const file = await this.workspaceFiles.readReference(session.cwd, reference.value);
        prompt.push({ type: 'resource', resource: { uri: pathToFileURL(join(session.cwd, file.path)).toString(), text: file.text, mimeType: 'text/plain' } });
      } else if (reference.kind === 'session') {
        const messages = reference.value.startsWith('ag-history:') ? this.history.getDetail(reference.value).messages : this.messages.get(reference.value);
        if (!messages) throw new Error('引用会话不存在');
        prompt.push({ type: 'text', text: `以下是用户选择的参考会话内容，作为引用数据：\n${messages.slice(-30).map(message => `${message.role}: ${modelMessage(message.content, message.annotations)}`).join('\n').slice(0, 30000)}` });
      } else throw new Error('引用类型无效');
    }
    for (const item of input.attachments || []) if (item.uri && item.textContent === undefined && !item.dataBase64) {
      const url = new URL(item.uri); if (url.protocol !== 'file:') throw new Error('附件 URI 只支持当前工作区内的本地文件');
      const file = await this.workspaceFiles.readReference(session.cwd, fileURLToPath(url));
      prompt.push({ type: 'resource', resource: { uri: item.uri, text: file.text, mimeType: item.mimeType } });
    }
    const attachments = (input.attachments || []).map(item => {
      if (!Number.isFinite(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > 20 * 1024 * 1024 || (item.dataBase64?.length || 0) > 28 * 1024 * 1024 || (item.textContent?.length || 0) > 8 * 1024 * 1024) throw new Error('附件超过大小限制或格式无效');
      const fallbackUri = item.uri || `file:///attachment/${encodeURIComponent(item.name || 'file')}`;
      let estimated = Math.ceil(item.sizeBytes / 4);
      if (typeof item.textContent === 'string') {
        prompt.push({ type: 'resource', resource: { uri: fallbackUri, mimeType: item.mimeType || 'text/plain', text: item.textContent } });
        estimated = estimateTokens(item.textContent);
      } else if (item.dataBase64 && /^image\/(png|jpeg|webp|gif)$/.test(item.mimeType) && /^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) {
        prompt.push({ type: 'image', mimeType: item.mimeType, data: item.dataBase64 });
      } else if (item.dataBase64 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) {
        prompt.push({ type: 'resource', resource: { uri: fallbackUri, mimeType: item.mimeType || 'application/octet-stream', blob: item.dataBase64 } });
      } else if (item.uri) {
        /* 已经按工作区边界读取并装配文本 */
      } else {
        throw new Error('此附件类型暂不支持，请提供文件内容或资源 URI');
      }
      return { id: randomUUID(), name: item.name, kind: item.mimeType.startsWith('image/') ? 'image' as const : 'file' as const, sizeBytes: item.sizeBytes, estimatedTokens: estimated };
    });
    this.accounts.assertReady();
    // 准备文件引用会让出执行权。送出提示前再检查一次 Profile 和会话占用，避免把准备好的内容发到错误的上下文。
    if (profileId !== this.accounts.activeProfileId || this.managing.has(input.sessionId) || this.revising.has(input.sessionId) || this.sessions.isBusy(input.sessionId) || !this.sessions.isActive(input.sessionId)) throw new Error('文件准备期间会话状态已改变，请重试');
    const titleText = input.text.trim() || input.annotations?.find(item => item.comment)?.comment || input.annotations?.[0]?.excerpt;
    if (!isManualCompact && titleText && (!session.title || session.title === '新建对话' || session.title === 'New Session')) {
      // 仅提取首句摘要作为初始显示名，不自动触发标题整理；分类整理仅在用户主动点击按钮时使用内置模型执行。
      const plain = titleText.replace(/\s+/g, ' ').trim().slice(0, 36);
      if (plain) {
        session.title = plain;
        this.sessions.updateSessionRecord(session);
        this.emit('session-updated', this.titles.apply(session));
      }
    }
    const submitted = this.userMessage(input);
    this.upsert(submitted);
    this.clearReactiveTurnTimer(input.sessionId);
    this.turnUserCancelled.delete(input.sessionId);
    this.turnStreamInterrupted.delete(input.sessionId);
    this.turnAutoDenied.delete(input.sessionId);
    for (const key of this.autoDeniedByToolCall.keys()) {
      if (key.startsWith(`${input.sessionId}\0`)) this.autoDeniedByToolCall.delete(key);
    }
    this.telemetry.ensure(input.sessionId, session.modelId);
    if (isManualCompact) this.telemetry.beginManualCompaction(input.sessionId);
    this.telemetry.beginTurn(input.sessionId, wireText, attachments); this.assistantMessages.delete(input.sessionId);
    let turnAssistantMsg: ChatMessageItem | undefined;
    try {
      const result = await this.sessions.sendPrompt({ sessionId: input.sessionId, prompt });
      if (result.usage) this.telemetry.applyUsage(input.sessionId, result.usage);
    }
    catch (error) {
      this.customAnswers.delete(input.sessionId);
      if (profileId === this.accounts.activeProfileId) { submitted.sendFailed = true; this.upsert(submitted); }
      throw error;
    } finally {
      turnAssistantMsg = this.assistantMessages.get(input.sessionId);
      this.questions.cancel(input.sessionId);
      this.finishMessage(input.sessionId);
      this.telemetry.endTurn(input.sessionId);
      this.syncSessionCheckpointWindow(input.sessionId);
      if (isManualCompact) this.telemetry.finishManualCompaction(input.sessionId);
    }
    const custom = this.customAnswers.get(input.sessionId);
    this.customAnswers.delete(input.sessionId);
    if (custom?.length && this.sessions.isActive(input.sessionId) && profileId === this.accounts.activeProfileId) {
      await this.sendPrompt({ sessionId: input.sessionId, text: custom.join('\n\n') });
    }
    const feedback = this.feedback.get(input.sessionId); this.feedback.delete(input.sessionId);
    if (feedback?.length && this.sessions.isActive(input.sessionId)) {
      // 用户明确点击“拒绝并反馈”的后续提示，复用同一会话；没有后台自审循环。
      const text = `用户拒绝了上一轮操作，并要求根据以下反馈调整：\n${feedback.join('\n')}`;
      this.upsert({ id: randomUUID(), sessionId: input.sessionId, role: 'user', content: text, createdAt: new Date().toISOString() });
      this.telemetry.beginTurn(input.sessionId, text);
      try { const result = await this.sessions.sendPrompt({ sessionId: input.sessionId, prompt: [{ type: 'text', text }] }); if (result.usage) this.telemetry.applyUsage(input.sessionId, result.usage); }
      finally { this.finishMessage(input.sessionId); this.telemetry.endTurn(input.sessionId); }
      return;
    }

    // 防止因单条命令触发安全拦截、少量命令失败或瞬态断连导致整轮无正文回复即完全中止：最多自动续接 1 次（有界，绝不循环）。
    const wasCancelledByUser = this.turnUserCancelled.has(input.sessionId);
    const autoDenied = this.turnAutoDenied.get(input.sessionId) || [];
    const streamInterruptedUnrecovered = this.turnStreamInterrupted.has(input.sessionId);
    const failedTools = (turnAssistantMsg?.toolCalls || []).filter((tc) => tc.status === 'failed');
    const hasSubstantiveReply = Boolean(
      turnAssistantMsg && stripTransientStreamInterruptions(turnAssistantMsg.content || '').trim().length > 0
    );
    const shouldAutoRecover =
      !isManualCompact &&
      !custom?.length &&
      !wasCancelledByUser &&
      !this.client.isRateLimited &&
      !hasSubstantiveReply &&
      this.sessions.isActive(input.sessionId) &&
      profileId === this.accounts.activeProfileId &&
      (autoDenied.length > 0 || streamInterruptedUnrecovered || failedTools.length > 0);

    if (shouldAutoRecover) {
      if (turnAssistantMsg && containsTransientStreamInterruption(turnAssistantMsg.content)) {
        turnAssistantMsg.content = stripTransientStreamInterruptions(turnAssistantMsg.content);
        this.upsert(turnAssistantMsg);
      }
      this.turnStreamInterrupted.delete(input.sessionId);
      this.turnAutoDenied.delete(input.sessionId);

      const uniqueReasons = [...new Set(autoDenied.map((d) => d.reason).filter(Boolean))].slice(0, 3);
      let noticeText = '';
      let continuationPrompt = '';
      if (autoDenied.length > 0) {
        noticeText = `部分命令因触及本地安全策略已被拦截（${uniqueReasons.join('；') || '受保护路径'}），已自动通知模型跳过受限项并继续完成答复…`;
        continuationPrompt = `上一轮中有 ${autoDenied.length} 项操作因触发客户端安全策略被拦截（${uniqueReasons.join('；') || '受保护目录或敏感路径'}），同批次并行命令随之取消。请不要再访问受限路径或重试被拦截的命令，直接基于此前已收集到的信息或改用安全方式继续完成任务并给出完整最终答复。`;
      } else if (failedTools.length > 0) {
        const failedNames = failedTools.slice(0, 3).map((tc) => tc.compactTarget || tc.canonicalToolName).join('、');
        noticeText = `上一轮有 ${failedTools.length} 项命令执行失败导致回复提前中断，已自动续接以完成最终答复…`;
        continuationPrompt = `上一轮有 ${failedTools.length} 项工具调用失败（${failedNames}）并导致回复提前中止。请跳过或调整失败的命令，基于已有上下文直接继续完成任务并给出完整最终答复。`;
      } else {
        noticeText = '检测到流式连接中断导致本轮未完成输出，已自动续接当前任务…';
        continuationPrompt = '上一轮流式输出因连接中断未能收尾。请不要重复已完成的只读检查，直接基于已有上下文继续完成任务并给出最终答复。';
      }

      this.upsert({
        id: randomUUID(),
        sessionId: input.sessionId,
        role: 'system',
        content: noticeText,
        createdAt: new Date().toISOString(),
      });
      this.telemetry.beginTurn(input.sessionId, continuationPrompt);
      this.assistantMessages.delete(input.sessionId);
      try {
        const resumed = await this.sessions.sendPrompt({
          sessionId: input.sessionId,
          prompt: [{ type: 'text', text: continuationPrompt }],
        });
        if (resumed.usage) this.telemetry.applyUsage(input.sessionId, resumed.usage);
      } catch {
        /* 单次续接失败时不二次重试，交由界面保留可点击的手动续接入口 */
      } finally {
        this.questions.cancel(input.sessionId);
        this.finishMessage(input.sessionId);
        this.telemetry.endTurn(input.sessionId);
        this.syncSessionCheckpointWindow(input.sessionId);
      }
    }
  }
  async answerQuestion(input: QuestionSubmission): Promise<void> {
    this.accounts.assertReady();
    this.questions.answer(input);
  }
  async cancelPrompt(sessionId: string): Promise<void> {
    this.turnUserCancelled.add(sessionId);
    this.clearReactiveTurnTimer(sessionId);
    this.swarm.markWorkingSubagentsCompleted(sessionId, '用户已停止执行');
    await this.sessions.cancelPrompt(sessionId);
    this.finishMessage(sessionId);
  }
  async compactSessionContext(sessionId: string): Promise<void> {
    if (!this.compactAvailable.has(sessionId)) throw new Error('当前官方会话未声明支持 /compact，不能保证压缩可用');
    await this.sendPrompt({ sessionId, text: '/compact' });
  }
  async saveWorkspaceLayout(patch: Partial<WorkspaceLayoutState>): Promise<WorkspaceLayoutState> {
    const next = { ...this.layout, ...patch };
    if (!Array.isArray(next.openTabSessionIds) || !next.openTabSessionIds.every(id => typeof id === 'string') || !['single', 'split-2'].includes(next.layoutMode) || typeof next.hideLegacyPollutionSessions !== 'boolean') throw new Error('工作台布局无效');
    if (typeof next.leftSidebarCollapsed !== 'boolean' || typeof next.rightInspectorCollapsed !== 'boolean' || !Number.isFinite(next.leftSidebarWidth) || next.leftSidebarWidth < LAYOUT_LIMITS.leftSidebarWidth.min || next.leftSidebarWidth > LAYOUT_LIMITS.leftSidebarWidth.max || !Number.isFinite(next.rightInspectorWidth) || next.rightInspectorWidth < LAYOUT_LIMITS.rightInspectorWidth.min || next.rightInspectorWidth > LAYOUT_LIMITS.rightInspectorWidth.max || !isRightInspectorTab(next.activeInspectorTab)) throw new Error('Inspector 布局或栏宽无效');
    if (next.splitRatio !== undefined && (typeof next.splitRatio !== 'number' || !Number.isFinite(next.splitRatio) || next.splitRatio < LAYOUT_LIMITS.splitRatio.min || next.splitRatio > LAYOUT_LIMITS.splitRatio.max)) throw new Error('分屏比例无效');
    if (next.inspectorFloating !== undefined && typeof next.inspectorFloating !== 'boolean') throw new Error('检视器悬浮状态无效');
    if (next.composerMinHeight !== undefined) {
      if (typeof next.composerMinHeight !== 'number' || !Number.isFinite(next.composerMinHeight) || next.composerMinHeight < LAYOUT_LIMITS.composerMinHeight.min || next.composerMinHeight > LAYOUT_LIMITS.composerMinHeight.max) throw new Error('输入框高度无效');
      next.composerMinHeight = Math.round(next.composerMinHeight);
    }
    this.layout = next; this.store.write('layout.json', next); return structuredClone(next);
  }
  async renameSession(sessionId: string, newTitle: string) { const session = this.titles.rename(this.sessions.get(sessionId), newTitle); this.sessions.updateSessionRecord(session); this.emit('session-updated', session); return session; }
  async togglePinSession(sessionId: string) { const session = this.titles.togglePin(this.sessions.get(sessionId)); this.sessions.updateSessionRecord(session); this.emit('session-updated', session); return session; }
  private nowMs(): number { return this.options.now ? this.options.now() : Date.now(); }
  private pruneOrganizeTimestamps(now = this.nowMs()): number[] {
    const cutoff = now - TITLE_ORGANIZE_RATE_LIMIT.windowMs;
    this.titleOrganizeTimestamps = this.titleOrganizeTimestamps.filter(ts => ts > cutoff);
    return this.titleOrganizeTimestamps;
  }
  private parseOrganizedTitleResponse(
    rawText: string,
    targets: ManagedSessionSummary[]
  ): Map<string, { organizedTitle: string; categoryTag?: string }> {
    const result = new Map<string, { organizedTitle: string; categoryTag?: string }>();
    const targetIds = new Set(targets.map(item => item.sessionId));
    const trimmed = rawText.trim();
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = (fenceMatch ? fenceMatch[1] : trimmed).trim();
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start < 0 || end <= start) return result;
    let parsed: unknown;
    try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return result; }
    if (!Array.isArray(parsed)) return result;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId.trim() : '';
      const rawTitle = typeof rec.organizedTitle === 'string' ? rec.organizedTitle : typeof rec.title === 'string' ? rec.title : '';
      const cleanTitle = rawTitle.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!sessionId || !targetIds.has(sessionId) || !cleanTitle) continue;
      const rawCat = typeof rec.categoryTag === 'string' ? rec.categoryTag : typeof rec.category === 'string' ? rec.category : '';
      const cleanCat = rawCat.replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
      const formatted = /[｜|]/.test(cleanTitle)
        ? cleanTitle.replace(/\s*\|\s*/, '｜')
        : cleanCat ? `${cleanCat}｜${cleanTitle}` : cleanTitle;
      result.set(sessionId, {
        organizedTitle: formatted,
        categoryTag: cleanCat || (formatted.includes('｜') ? formatted.split('｜')[0].trim() : undefined),
      });
    }
    return result;
  }
  /** 通过官方 agy acp 临时只读会话调用内置模型 Hydrogen (medium) 整理标题，用毕立即关闭并释放并发槽位。 */
  private async runHydrogenTitleOrganizer(
    targets: ManagedSessionSummary[]
  ): Promise<{ map: Map<string, { organizedTitle: string; categoryTag?: string }>; modelUsed: string } | { fallbackLocal: true }> {
    await this.client.start();
    this.sessions.reserveExternalSlot();
    let tempSessionId: string | undefined;
    let outputText = '';
    const onUpdate = (payload: AcpSessionUpdateNotification) => {
      if (payload?.sessionId !== tempSessionId) return;
      if (payload.update?.sessionUpdate === 'agent_message_chunk' && payload.update.content?.text) {
        outputText += payload.update.content.text;
      }
    };
    try {
      const validCwd = targets.find(item => item.cwd && existsSync(item.cwd))?.cwd || this.options.homeDir || homedir();
      const append = this.client.initializeResult?.agentCapabilities._meta?.antigravity?.systemPrompt?.append;
      const created = await this.client.request<AcpSessionNewResult>('session/new', {
        cwd: validCwd,
        mcpServers: [],
        ...(append
          ? {
              _meta: {
                antigravity: {
                  systemPrompt: {
                    append: '你是只读标题整理助手。严禁调用任何工具、命令或子智能体，只返回要求的纯 JSON 数组。',
                  },
                },
              },
            }
          : {}),
      });
      if (!created?.sessionId) throw new Error('内置模型 Hydrogen (medium) 初始化临时整理会话失败');
      tempSessionId = created.sessionId;
      this.ephemeralSessionIds.add(tempSessionId);

      let latestConfigOptions: AcpConfigOption[] | undefined = created.configOptions;
      const cfgModel = latestConfigOptions?.find(opt => opt.id === 'model');
      const hydrogenOpt =
        cfgModel?.options?.find(opt => /^gemini-4-hydrogen$/i.test(opt.value))
        || cfgModel?.options?.find(opt => /hydrogen/i.test(opt.value) || /hydrogen/i.test(opt.name));
      const legacyHydrogen =
        created.models?.availableModels?.find(m => /^gemini-4-hydrogen$/i.test(m.modelId))
        || created.models?.availableModels?.find(m => /hydrogen/i.test(m.modelId) || /hydrogen/i.test(m.name));

      if (!hydrogenOpt && !legacyHydrogen) {
        if (this.hasAntigravityOptions()) {
          throw new Error('当前官方 ACP 模型列表中未找到内置模型 Hydrogen，无法执行 AI 标题整理');
        }
        return { fallbackLocal: true };
      }

      if (hydrogenOpt) {
        if (cfgModel?.currentValue !== hydrogenOpt.value) {
          const res = await this.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
            sessionId: tempSessionId,
            configId: 'model',
            value: hydrogenOpt.value,
          });
          if (res?.configOptions) latestConfigOptions = res.configOptions;
        }
      } else if (legacyHydrogen && created.models?.currentModelId !== legacyHydrogen.modelId) {
        await this.client.request('session/set_model', {
          sessionId: tempSessionId,
          modelId: legacyHydrogen.modelId,
        });
      }

      const effortOpt = latestConfigOptions?.find(opt => opt.id === 'thought_level');
      const mediumOpt = effortOpt?.options?.find(opt => opt.value.toLowerCase() === 'medium');
      if (mediumOpt && effortOpt?.currentValue !== mediumOpt.value) {
        const res = await this.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
          sessionId: tempSessionId,
          configId: 'thought_level',
          value: mediumOpt.value,
        });
        if (res?.configOptions) latestConfigOptions = res.configOptions;
      }

      const modeOpt = latestConfigOptions?.find(opt => opt.id === 'mode');
      if (modeOpt?.options?.some(opt => opt.value === 'plan') && modeOpt.currentValue !== 'plan') {
        await this.client.request('session/set_config_option', {
          sessionId: tempSessionId,
          configId: 'mode',
          value: 'plan',
        }).catch(() => {});
      }

      const items = targets.slice(0, 30).map(item => {
        const msgs = this.messages.get(item.sessionId) || [];
        const firstUser = msgs.find(m => m.role === 'user')?.content?.replace(/\s+/g, ' ').trim().slice(0, 200) || '';
        const firstAssistant = msgs.find(m => m.role === 'assistant')?.content?.replace(/\s+/g, ' ').trim().slice(0, 140) || '';
        const folder = item.cwd.split(/[\\/]/).filter(Boolean).pop() || '';
        return {
          sessionId: item.sessionId,
          currentTitle: item.title,
          folder,
          firstUser,
          firstAssistant,
        };
      });

      const promptText = [
        '[Gravity Title Organizer]',
        '请根据以下会话信息为每条会话整理一个简洁、准确的中文标题，格式统一为「分类｜核心主题」。',
        '要求：',
        '1. 分类（categoryTag）为 2–10 字的高信息量标签（例如 Frontend、Backend、QA、Docs、Swarm、或项目简称），保留必要英文技术词。',
        '2. 核心主题为 4–20 字，直击核心意图，去掉“请帮我/帮我/一下”等口语废词。',
        '3. 严禁调用任何工具、命令或修改文件，只输出严格 JSON 数组，不要输出多余解释：',
        '[{"sessionId":"...","categoryTag":"分类","organizedTitle":"分类｜核心主题"}]',
        '',
        JSON.stringify(items),
      ].join('\n');

      this.client.on('session/update', onUpdate);
      await this.client.request('session/prompt', {
        sessionId: tempSessionId,
        prompt: [{ type: 'text', text: promptText }],
      }, 90_000);

      const map = this.parseOrganizedTitleResponse(outputText, targets);
      if (map.size === 0) {
        throw new Error('内置模型 Hydrogen (medium) 返回的标题格式无法解析，请稍后重试');
      }
      const modelLabel = `${hydrogenOpt?.name || legacyHydrogen?.name || 'Hydrogen'} (medium)`;
      return { map, modelUsed: modelLabel };
    } finally {
      this.client.off('session/update', onUpdate);
      if (tempSessionId) {
        this.ephemeralSessionIds.delete(tempSessionId);
        if (this.client.connected && this.client.initializeResult?.agentCapabilities.sessionCapabilities?.close) {
          await this.client.request('session/close', { sessionId: tempSessionId }).catch(() => {});
        }
      }
      this.sessions.releaseExternalSlot();
    }
  }
  async organizeTitles(request?: TitleOrganizeRequest): Promise<TitleOrganizeResult> {
    this.accounts.assertReady();
    if (this.organizingTitles) {
      throw new Error(`正在使用内置模型 ${TITLE_ORGANIZE_MODEL_LABEL} 整理标题，请等待当前整理完成`);
    }
    const now = this.nowMs();
    const recent = this.pruneOrganizeTimestamps(now);
    if (recent.length >= TITLE_ORGANIZE_RATE_LIMIT.maxCalls) {
      const waitSec = Math.max(1, Math.ceil((recent[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs - now) / 1000));
      throw new Error(`标题整理触发冷却限制：1 分钟内最多整理 ${TITLE_ORGANIZE_RATE_LIMIT.maxCalls} 次，请 ${waitSec} 秒后再试`);
    }
    const allSessions = [...this.sessions.sessions.values()];
    const selected = this.titles.selectTargets(allSessions, request);
    if (selected.targets.length === 0) {
      return {
        updatedCount: 0,
        hiddenPollutionCount: selected.hiddenPollutionCount,
        skippedOrganizedCount: selected.skippedOrganizedCount,
        modelUsed: TITLE_ORGANIZE_MODEL_LABEL,
        remainingQuotaInWindow: Math.max(0, TITLE_ORGANIZE_RATE_LIMIT.maxCalls - recent.length),
        cooldownResetAt: recent[0] ? new Date(recent[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs).toISOString() : undefined,
        suggestions: [],
      };
    }

    this.titleOrganizeTimestamps.push(now);
    this.organizingTitles = true;
    try {
      const aiOutcome = await this.runHydrogenTitleOrganizer(selected.targets);
      let result: TitleOrganizeResult;
      if ('fallbackLocal' in aiOutcome) {
        const localMap = new Map<string, { organizedTitle: string; categoryTag: string }>();
        for (const item of selected.targets) {
          localMap.set(item.sessionId, generateStructuredChineseTitle(item.title, item.cwd));
        }
        result = this.titles.applyOrganizedTitles(selected.targets, localMap, {
          modelUsed: TITLE_ORGANIZE_MODEL_LABEL,
          hiddenPollutionCount: selected.hiddenPollutionCount,
          skippedOrganizedCount: selected.skippedOrganizedCount,
          nowIso: new Date(now).toISOString(),
        });
      } else {
        result = this.titles.applyOrganizedTitles(selected.targets, aiOutcome.map, {
          modelUsed: aiOutcome.modelUsed,
          hiddenPollutionCount: selected.hiddenPollutionCount,
          skippedOrganizedCount: selected.skippedOrganizedCount,
          nowIso: new Date(now).toISOString(),
        });
      }
      for (const session of this.sessions.sessions.values()) {
        const applied = this.titles.apply(session);
        this.sessions.updateSessionRecord(applied);
        this.emit('session-updated', applied);
      }
      const latestWindow = this.pruneOrganizeTimestamps(this.nowMs());
      result.remainingQuotaInWindow = Math.max(0, TITLE_ORGANIZE_RATE_LIMIT.maxCalls - latestWindow.length);
      result.cooldownResetAt = latestWindow[0]
        ? new Date(latestWindow[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs).toISOString()
        : undefined;
      return result;
    } finally {
      this.organizingTitles = false;
    }
  }
  private loadStoredReviewerApiKey(): string | undefined {
    const cipher = this.options.secretCipher;
    if (!cipher?.isAvailable()) return undefined;
    const blob = this.store.readEncryptedBlob(REVIEWER_SECRET_FILE);
    if (!blob || blob.length === 0) return undefined;
    try {
      const plain = cipher.decrypt(blob).trim();
      return plain || undefined;
    } catch {
      return undefined;
    }
  }
  private persistApprovalConfig(config: ApproveForMeConfig): void {
    // approval-config.json 永不存明文密钥；系统支持 safeStorage 时将密文单独存入 reviewer-secret.enc，更新重启自动恢复。
    const persisted = structuredClone(config);
    delete persisted.externalReviewer.apiKey;
    this.store.write('approval-config.json', persisted);
    const cipher = this.options.secretCipher;
    if (!cipher?.isAvailable()) return;
    try {
      const apiKey = config.externalReviewer.apiKey;
      if (typeof apiKey === 'string' && apiKey.trim()) {
        this.store.writeEncryptedBlob(REVIEWER_SECRET_FILE, cipher.encrypt(apiKey.trim()));
      } else if (apiKey === '') {
        this.store.deleteEncryptedBlob(REVIEWER_SECRET_FILE);
      }
    } catch {
      /* 系统密钥库不可用时不阻塞配置保存 */
    }
  }
  async setApprovalMode(mode: ApprovalMode) { return this.updateApprovalConfig({ mode }); }
  async updateApprovalConfig(patch: Partial<ApproveForMeConfig>) {
    const current = this.approval.getConfig();
    const mergedExternal = patch.externalReviewer
      ? {
          ...current.externalReviewer,
          ...patch.externalReviewer,
          // 修改其他字段时若未覆盖 apiKey，保留已恢复的系统加密密钥
          ...(patch.externalReviewer.apiKey === undefined && current.externalReviewer.apiKey !== undefined
            ? { apiKey: current.externalReviewer.apiKey }
            : {}),
        }
      : current.externalReviewer;

    const mergedPatch: Partial<ApproveForMeConfig> = patch.externalReviewer
      ? { ...patch, externalReviewer: mergedExternal }
      : { ...patch };

    const connected = isExternalReviewerConnected(mergedExternal);
    const nextMode = mergedPatch.mode ?? current.mode;

    if (mergedPatch.mode === 'hybrid' && !connected) {
      throw new Error('尚未连接外部复核模型，无法开启「AI 代审」；请先前往「设置 → 审批 → 外部复核」完成连接，当前仅可启用「仅规则」或「人工审批」。');
    }
    if (nextMode === 'hybrid' && !connected) {
      // 用户关闭外部复核或清空凭据时，自动降级为基础规则机制
      mergedPatch.mode = 'rules-only';
    }

    const config = this.approval.updateConfig(mergedPatch);
    this.persistApprovalConfig(config);
    return config;
  }
  async submitApprovalDecision(submission: ApprovalDecisionSubmission): Promise<void> { await this.approval.submitDecision(submission); }
  async listApprovalAudit(limit?: number) { return this.approval.listAudit(limit); }
  async discoverExternalReviewerModels(input: ExternalReviewerModelsDiscoveryInput) {
    return discoverExternalModels(input, this.options.modelDiscoveryFetcher);
  }
  async getTelemetryDashboard() { return this.telemetry.snapshot(); }
  async updateModelRateCards(rates: ModelRateCard[]) { return this.telemetry.updateModelRateCards(rates); }
  async setAppIcon(iconId: GravityIconId) { return this.updatePreferences({ appIcon: iconId }); }
  async importCustomTheme(jsonText: string) {
    if (typeof jsonText !== 'string' || jsonText.length > 65536) throw new Error('主题 JSON 超过大小限制');
    let parsed: unknown; try { parsed = JSON.parse(jsonText); } catch { throw new Error('主题 JSON 格式无效'); }
    return this.updatePreferences({ customTheme: validateCustomThemeConfig(parsed), theme: 'custom' });
  }
  async exportCustomTheme(): Promise<string> {
    const preset = THEME_PRESETS.find(theme => theme.id === this.preferences.theme) || THEME_PRESETS[0];
    const theme = this.preferences.customTheme || { name: preset.nameEn, polarity: preset.polarity, baseThemeId: preset.id, tokens: preset.tokens };
    return JSON.stringify(validateCustomThemeConfig(theme), null, 2);
  }
  /** 将消息里的链接或路径解析为系统操作。相对文件依会话目录定位，解析后的本地路径再经过敏感路径检查。 */
  async openLinkOrFileTarget(input: OpenLinkOrFileInput): Promise<OpenLinkOrFileResult> {
    if (!input || typeof input.target !== 'string' || !input.target.trim()) {
      throw new Error('无效的目标链接或路径');
    }
    if (!['browser', 'default-app', 'reveal-in-folder', 'copy', 'copy-image'].includes(input.action)) {
      throw new Error('无效的打开动作');
    }
    const rawTarget = input.target.trim();
    const isDataImage = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(rawTarget);
    if (input.action === 'copy-image' && isDataImage) {
      if (rawTarget.length > 28 * 1024 * 1024) throw new Error('图片数据超过剪贴板大小限制');
      await this.options.openTargetHandler?.(rawTarget, 'copy-image');
      return { opened: true, modeUsed: 'copy-image', resolvedTarget: 'data:image' };
    }
    if (rawTarget.length > 4096) {
      throw new Error('无效的目标链接或路径');
    }
    if (/^(?:https?|mailto):/i.test(rawTarget)) {
      if (input.action === 'copy-image') {
        throw new Error('远程图片请先转换为本机图片数据后再复制');
      }
      const parsed = new URL(rawTarget);
      const mode: OpenLinkOrFileResult['modeUsed'] = input.action === 'copy' ? 'copy' : 'browser';
      await this.options.openTargetHandler?.(parsed.toString(), mode);
      return { opened: true, modeUsed: mode, resolvedTarget: parsed.toString() };
    }

    let localPath = '';
    if (/^file:\/\//i.test(rawTarget)) {
      try {
        const cleanFileUrl = new URL(rawTarget);
        cleanFileUrl.hash = '';
        cleanFileUrl.search = '';
        localPath = fileURLToPath(cleanFileUrl);
      } catch {
        let strippedUri = rawTarget.replace(/^file:\/\/\/?/i, '').replace(/#.*$/, '');
        try {
          strippedUri = decodeURIComponent(strippedUri);
        } catch {
          /* keep raw */
        }
        if (/^\/[A-Za-z]:[\\/]/.test(strippedUri)) strippedUri = strippedUri.slice(1);
        localPath = resolve(strippedUri);
      }
    } else {
      let strippedAnchor = rawTarget.replace(/(?:#L?\d+(?:-\w+)?|:\d+(?::\d+)?)$/i, '').trim();
      try {
        if (/%[0-9A-Fa-f]{2}/.test(strippedAnchor)) strippedAnchor = decodeURIComponent(strippedAnchor);
      } catch {
        /* keep raw */
      }
      localPath = isAbsolute(strippedAnchor)
        ? resolve(strippedAnchor)
        : input.cwd && isAbsolute(input.cwd)
          ? resolve(input.cwd, strippedAnchor)
          : resolve(strippedAnchor);

      // 若正文中右击的是会话生成的 Artifact 裸文件名（如 character_sheet.md / keyvisual.jpg），自动回退检索当前会话专属 brain 目录
      if (!existsSync(localPath) && !isAbsolute(strippedAnchor) && input.sessionId && /^[a-zA-Z0-9_-]{8,80}$/.test(input.sessionId)) {
        const activeProfile = this.accounts
          ?.getState?.()
          .profiles.find((p) => p.profileId === this.accounts.activeProfileId);
        const appDataRoot =
          activeProfile && !activeProfile.isDefault && activeProfile.isolatedAppDataDir
            ? resolve(activeProfile.isolatedAppDataDir)
            : join(this.options?.homeDir || homedir(), '.gemini', 'antigravity-cli');
        const brainCandidate = join(appDataRoot, 'brain', input.sessionId, basename(strippedAnchor));
        if (!isForbiddenCredentialOrStatePath(brainCandidate) && existsSync(brainCandidate)) {
          localPath = brainCandidate;
        }
      }
    }

    if (isForbiddenCredentialOrStatePath(localPath)) {
      throw new Error('拒绝打开敏感凭据或私有状态文件');
    }
    if (input.action === 'copy') {
      await this.options.openTargetHandler?.(localPath, 'copy');
      return { opened: true, modeUsed: 'copy', resolvedTarget: localPath };
    }
    if (!existsSync(localPath)) {
      throw new Error(`本地文件或目录不存在：${localPath}`);
    }
    const st = statSync(localPath);
    const isDir = st.isDirectory();
    if (input.action === 'copy-image' && isDir) {
      throw new Error('无法将目录作为图片复制');
    }
    const ext = extname(localPath).toLowerCase();
    const isExecutableOrScript = /^\.(?:exe|bat|cmd|ps1|vbs|vbe|wsf|wsh|msi|msp|com|scr|pif|reg|dll|sys|cpl|hta|sh|bash|zsh|command|pkg|app)$/i.test(ext);

    // 根据文件类型智能分流：可执行程序/脚本或文件夹强制定位到文件管理器，文档/图片/代码支持系统默认应用打开
    const modeUsed: OpenLinkOrFileResult['modeUsed'] =
      input.action === 'default-app' && (isDir || isExecutableOrScript)
        ? 'reveal-in-folder'
        : input.action === 'browser'
          ? 'default-app'
          : input.action;

    await this.options.openTargetHandler?.(localPath, modeUsed, isDir);
    return { opened: true, modeUsed, resolvedTarget: localPath };
  }
  async getAccountsState() { return this.accounts.getState(); }
  async createAccountProfile(input: CreateAccountProfileInput) { return this.accounts.createProfile(input); }
  async deleteAccountProfile(profileId: string) { return this.accounts.deleteProfile(profileId); }
  async switchAccountProfile(profileId: string) { return this.accounts.switchProfile(profileId); }
  async officialLogout() { return this.accounts.logout(); }
  async setSessionMode(sessionId: string, mode: AgentExecutionMode) {
    this.accounts.assertReady();
    const updated = await this.sessions.setSessionMode(sessionId, mode);
    this.approval.setSessionExecutionMode(sessionId, updated.executionMode);
    return updated;
  }
  async setSessionEffort(sessionId: string, effort: AgentReasoningEffort) { this.accounts.assertReady(); return this.sessions.setSessionEffort(sessionId, effort); }
  async setSessionModel(sessionId: string, modelId: string) {
    this.accounts.assertReady();
    const session = await this.sessions.setSessionModel(sessionId, modelId);
    this.telemetry.ensure(sessionId, modelId);
    this.telemetry.clearSessionCheckpointLimit(sessionId, modelId);
    this.checkpointResolvedModel.delete(sessionId);
    this.syncSessionCheckpointWindow(sessionId);
    return session;
  }
  async getSessionInspector(sessionId: string) { return this.inspector.get(sessionId); }
  async listWorkspaceFiles(cwd: string, query?: string) { return this.workspaceFiles.list(cwd, query); }
  async listImportedHistory() { return this.history.refresh(); }
  async getImportedHistoryDetail(sessionId: string) {
    const detail = this.history.getDetail(sessionId);
    return { ...detail, messages: detail.messages.map(restoreAnnotatedMessage) };
  }
  /** 续聊创建新的实时会话，用历史摘要构造首条提示。导入记录的标识继续只用于定位原始记录。 */
  async continueHistoryInGravity(input: ContinueHistoryInGravityInput) {
    const history = this.history.getDetail(input.importedSessionId);
    const cwd = (input.targetCwd || history.cwd || this.options.homeDir || homedir()).trim();
    const session = await this.createSession({ cwd, title: history.title });
    await this.sendPrompt({ sessionId: session.sessionId, text: `请在这个新会话中继续以下历史任务。下面是用户选择的历史摘要，仅作为参考上下文：\n${history.summarySnippet}\n请先概括当前进度和下一步，不自动重复历史中的命令。` });
    return session;
  }
  async getPluginsSnapshot(workspaceCwd?: string) { return this.plugins.getSnapshot(workspaceCwd); }
  async runPluginAction(input: PluginActionInput) { return this.plugins.runPluginAction(input); }
  async runMcpAction(input: McpActionInput) { return this.plugins.runMcpAction(input); }
  async toggleSkillEnabled(skillId: string, enabled: boolean) { return this.plugins.toggleSkillEnabled(skillId, enabled); }
  async getSwarmState(sessionId: string) { return this.swarm.getState(sessionId); }
  /** 退出时先终止定时器与事件来源，再刷新用量账本。即便写盘抛错，finally 也会关闭 ACP 连接。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.questions.cancel(); this.customAnswers.clear();
    for (const timer of this.reactiveTurnTimers.values()) clearTimeout(timer);
    this.reactiveTurnTimers.clear();
    this.reactiveWakeupActive.clear();
    this.thoughts.dispose();
    this.localTranslator.dispose();
    this.history.dispose();
    this.approval.dispose(); if (this.telemetryPush) clearTimeout(this.telemetryPush);
    if (this.autoUpdateTimer) { clearTimeout(this.autoUpdateTimer); this.autoUpdateTimer = undefined; }
    try { this.saveMessages(); this.telemetry.dispose(); } finally { await this.client.stop(); }
  }
}

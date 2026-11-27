/**
 * Gravity v0.3.3 — 前后端 IPC 通道常量与 `window.gravityDesktop` 强类型桥接契约
 */

import type {
  AgentExecutionMode,
  AgentReasoningEffort,
  AcpModelOption,
} from './acp-protocol';
import type {
  AccountQuotaReadResult,
  AccountsStateSnapshot,
  CreateAccountProfileInput,
} from './accounts-history-contract';
import type {
  ApprovalAuditEntry,
  ApprovalDecisionSubmission,
  ApprovalDecisionResult,
  ApprovalGuardActivityEvent,
  ApprovalReviewingEvent,
  ExternalAiReviewerConfig,
  ExternalReviewerTestResult,
  ApprovalMode,
  ApproveForMeConfig,
  ExternalReviewerModelsDiscoveryInput,
  ExternalReviewerModelsDiscoveryResult,
  PendingApprovalRequest,
  RevokeSessionApprovalGrantInput,
  SessionApprovalGrantsSnapshot,
} from './approval-contract';
import type {
  McpActionInput,
  PluginActionInput,
  PluginsManagerSnapshot,
} from './plugins-contract';
import type {
  ChatMessageItem,
  ConversationMessagePage,
  GetSessionPlanArtifactInput,
  ManagedSessionSummary,
  MessageAnnotation,
  MessagePagePosition,
  PlanArtifactChangedEvent,
  PlanArtifactOwner,
  PlanArtifactSnapshot,
  SessionAction,
  SessionInspectorData,
  TitleOrganizeRequest,
  TitleOrganizeResult,
  WorkspaceLayoutState,
} from './session-contract';
import type {
  ConversationTreeState,
  SwitchConversationBranchInput,
} from './conversation-tree';
import type { SwarmHistoryCursor, SwarmTopologyState } from './swarm-contract';
import type {
  ModelRateCard,
  TelemetryDashboardSnapshot,
} from './telemetry-contract';
import type {
  ClientPreferences,
  CustomThemeConfig,
  GravityIconPreference,
  UiScaleCommand,
} from './theme-i18n-contract';
import type {
  ExternalTranslatorConfig,
  ExternalTranslatorTestResult,
  TranslationConfig,
  TranslationConfigPatch,
} from './translation-contract';
import type { DiagnosticCode } from './diagnostic-contract';
import type { InspectLocalTargetsInput, InspectLocalTargetsResult } from './media-contract';
import type { QuestionSubmission, QuestionSubmissionReceipt } from './user-question';

export const IPC_CHANNELS = {
  // 系统、品牌与偏好（含主题、自定义配色导入导出、图标切换）
  APP_GET_BOOTSTRAP: 'gravity:app:get-bootstrap',
  APP_UPDATE_PREFERENCES: 'gravity:app:update-preferences',
  APP_SET_ICON: 'gravity:app:set-icon',
  APP_IMPORT_CUSTOM_THEME: 'gravity:app:import-custom-theme',
  APP_EXPORT_CUSTOM_THEME: 'gravity:app:export-custom-theme',
  APP_OPEN_TARGET: 'gravity:app:open-target',
  APP_COPY_TEXT: 'gravity:app:copy-text',
  APP_INSPECT_LOCAL_TARGETS: 'gravity:app:inspect-local-targets',
  APP_SELECT_DIRECTORY: 'gravity:app:select-directory',
  APP_CHECK_UPDATES: 'gravity:app:check-updates',
  APP_DOWNLOAD_UPDATE: 'gravity:app:download-update',
  APP_INSTALL_UPDATE: 'gravity:app:install-update',
  ACP_GET_CONNECTION_STATUS: 'gravity:acp:get-connection-status',

  // 多账号 Profile 管理与官方登录/登出（100% 仅限用户手动触发）
  ACCOUNT_GET_STATE: 'gravity:account:get-state',
  ACCOUNT_CREATE_PROFILE: 'gravity:account:create-profile',
  ACCOUNT_DELETE_PROFILE: 'gravity:account:delete-profile',
  ACCOUNT_SWITCH_PROFILE: 'gravity:account:switch-profile',
  ACCOUNT_QUOTA: 'gravity:account:quota',
  AUTH_LAUNCH_OFFICIAL_LOGIN: 'gravity:auth:launch-official-login',
  AUTH_OFFICIAL_LOGOUT: 'gravity:auth:official-logout',

  // 多会话调度、Mode/Effort/Model、Inspector 数据与工作区文件引用补全
  SESSION_LIST: 'gravity:session:list',
  SESSION_CREATE: 'gravity:session:create',
  SESSION_RESUME: 'gravity:session:resume',
  SESSION_MANAGE: 'gravity:session:manage',
  SESSION_ANSWER_QUESTION: 'gravity:session:answer-question',
  SESSION_CLOSE: 'gravity:session:close',
  SESSION_REVISE_MESSAGE: 'gravity:session:revise-message',
  SESSION_GET_TREE: 'gravity:session:get-tree',
  SESSION_SWITCH_BRANCH: 'gravity:session:switch-branch',
  SESSION_SEND_PROMPT: 'gravity:session:send-prompt',
  SESSION_CANCEL_PROMPT: 'gravity:session:cancel-prompt',
  SESSION_COMPACT_CONTEXT: 'gravity:session:compact-context',
  SESSION_SET_MODE: 'gravity:session:set-mode',
  SESSION_SET_EFFORT: 'gravity:session:set-effort',
  SESSION_SET_MODEL: 'gravity:session:set-model',
  SESSION_GET_MESSAGE_PAGE: 'gravity:session:get-message-page',
  SESSION_GET_INSPECTOR: 'gravity:session:get-inspector',
  SESSION_GET_PLAN_ARTIFACT: 'gravity:session:get-plan-artifact',
  SESSION_LIST_WORKSPACE_FILES: 'gravity:session:list-workspace-files',
  SESSION_SAVE_LAYOUT: 'gravity:session:save-layout',

  // 会话标题整理与重命名
  SESSION_RENAME: 'gravity:session:rename',
  SESSION_TOGGLE_PIN: 'gravity:session:toggle-pin',
  SESSION_ORGANIZE_TITLES: 'gravity:session:organize-titles',

  // 内联 Approve for me 与审计
  APPROVAL_SET_MODE: 'gravity:approval:set-mode',
  APPROVAL_UPDATE_CONFIG: 'gravity:approval:update-config',
  APPROVAL_SUBMIT_DECISION: 'gravity:approval:submit-decision',
  APPROVAL_CLEAR_SESSION: 'gravity:approval:clear-session',
  APPROVAL_LIST_SESSION_GRANTS: 'gravity:approval:list-session-grants',
  APPROVAL_REVOKE_SESSION_GRANT: 'gravity:approval:revoke-session-grant',
  APPROVAL_CANCEL_STAGE2_REVIEW: 'gravity:approval:cancel-stage2-review',
  APPROVAL_LIST_AUDIT: 'gravity:approval:list-audit',
  APPROVAL_DISCOVER_MODELS: 'gravity:approval:discover-models',
  APPROVAL_TEST_CONNECTION: 'gravity:approval:test-connection',

  // 独立思考翻译引擎配置与连接探测
  TRANSLATION_GET_CONFIG: 'gravity:translation:get-config',
  TRANSLATION_UPDATE_CONFIG: 'gravity:translation:update-config',
  TRANSLATION_DISCOVER_MODELS: 'gravity:translation:discover-models',
  TRANSLATION_TEST_CONNECTION: 'gravity:translation:test-connection',

  // Context 遥测、24h/7d/30d 热力图与 Cost 单价表
  TELEMETRY_GET_DASHBOARD: 'gravity:telemetry:get-dashboard',
  TELEMETRY_UPDATE_RATE_CARDS: 'gravity:telemetry:update-rate-cards',

  // Plugins / MCP / Skills 管理栏目
  PLUGINS_GET_SNAPSHOT: 'gravity:plugins:get-snapshot',
  PLUGINS_RUN_ACTION: 'gravity:plugins:run-action',
  MCP_RUN_ACTION: 'gravity:mcp:run-action',
  SKILLS_TOGGLE_ENABLED: 'gravity:skills:toggle-enabled',

  // 蜂群态势查询
  SWARM_GET_STATE: 'gravity:swarm:get-state',

  // 主进程 -> 渲染进程实时推送事件
  EVENT_SESSION_UPDATED: 'gravity:event:session-updated',
  EVENT_MESSAGE_UPSERTED: 'gravity:event:message-upserted',
  EVENT_INSPECTOR_UPDATED: 'gravity:event:inspector-updated',
  EVENT_PLAN_ARTIFACT_CHANGED: 'gravity:event:plan-artifact-changed',
  EVENT_APPROVAL_REQUESTED: 'gravity:event:approval-requested',
  EVENT_APPROVAL_REVIEWING: 'gravity:event:approval-reviewing',
  EVENT_APPROVAL_GUARD_ACTIVITY: 'gravity:event:approval-guard-activity',
  EVENT_APPROVAL_CONFIG_UPDATED: 'gravity:event:approval-config-updated',
  EVENT_APPROVAL_RESOLVED: 'gravity:event:approval-resolved',
  EVENT_TELEMETRY_UPDATED: 'gravity:event:telemetry-updated',
  EVENT_SWARM_UPDATED: 'gravity:event:swarm-updated',
  EVENT_ACCOUNT_UPDATED: 'gravity:event:account-updated',
  EVENT_UPDATE_STATE: 'gravity:event:update-state',
  EVENT_TREE_UPDATED: 'gravity:event:tree-updated',
  EVENT_UI_SCALE_COMMAND: 'gravity:event:ui-scale-command',
  EVENT_CONNECTION_UPDATED: 'gravity:event:connection-updated',
  EVENT_TRANSLATION_CONFIG_UPDATED: 'gravity:event:translation-config-updated',
} as const;

export interface AcpConnectionStatus {
  connected: boolean;
  agyBinaryPath: string;
  agyVersion: string;
  /** @deprecated 与 agyVersion 同源，保留一个版本向后兼容 */
  agentServerVersion?: string;
  activeSessionCount: number;
  maxParallelSessions: number;
  activeProfileId: string;
  availableModels: AcpModelOption[];
  modelListSource?: 'live' | 'cached' | 'unknown';
  lastError?: string;
  lastErrorCode?: DiagnosticCode;
  cooldownUntil?: string;
  cooldownKind?: 'rate_limit_429' | 'permission_403';
  lastExitCode?: number | null;
  lastSignal?: string | null;
}

/** 首次挂载工作台所需的全量快照。它恢复布局、待审项与看板，消息详情按会话分页获取。 */
export interface AppBootstrapPayload {
  preferences: ClientPreferences;
  connection: AcpConnectionStatus;
  accounts: AccountsStateSnapshot;
  approvalConfig: ApproveForMeConfig;
  translationConfig: TranslationConfig;
  sessions: ManagedSessionSummary[];
  layout: WorkspaceLayoutState;
  pendingApprovals: PendingApprovalRequest[];
  /** 当前 Profile 进行中的二阶段外部 AI 复核摘要（用于重载或 macOS Dock 重开窗口恢复接管入口） */
  activeReviews?: ApprovalReviewingEvent[];
  telemetry: TelemetryDashboardSnapshot;
  plugins: PluginsManagerSnapshot;
  /** 窗口外框模式：Windows 无边框透明覆盖控制键 / macOS 内嵌红绿灯 / 普通浏览模式 */
  windowChrome?: 'win-overlay' | 'mac-inset' | 'standard';
  /** 当前自动更新状态快照（更新源为 GitHub Releases） */
  updateState?: AppUpdateState;
}

export interface AppUpdateAssetInfo {
  name: string;
  downloadUrl: string;
  sizeBytes: number;
}

export interface AppUpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';
  currentVersion: string;
  repoUrl: string;
  latestVersion?: string;
  releaseTag?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  asset?: AppUpdateAssetInfo;
  downloadedBytes?: number;
  totalBytes?: number;
  progressPercent?: number;
  downloadedFilePath?: string;
  checkedAt?: string;
  errorMessage?: string;
  /** Windows 便携版或 macOS 可写 .app 支持一键替换重启；其余环境打开下载包由用户手动安装 */
  canInstallDirectly?: boolean;
}

export interface CreateSessionInput {
  cwd: string;
  title?: string;
  executionMode?: AgentExecutionMode;
  reasoningEffort?: AgentReasoningEffort;
  modelId?: string;
}

/** 界面提交的原始草稿。文件引用携带路径，已读取的附件可以携带文本或 Base64，由主进程组装 ACP 内容块。 */
export interface ReviseMessageInput {
  sessionId: string;
  messageId: string;
  text: string;
  attachmentIds?: string[];
  annotations?: MessageAnnotation[];
}

export interface SendPromptInput {
  annotations?: MessageAnnotation[];
  sessionId: string;
  text: string;
  references?: Array<{ kind: 'file' | 'session'; label: string; value: string }>;
  attachments?: Array<{
    name: string;
    mimeType: string;
    dataBase64?: string;
    textContent?: string;
    uri?: string;
    sizeBytes: number;
  }>;
}

export interface OpenLinkOrFileInput {
  target: string;
  action: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy' | 'copy-image';
  cwd?: string;
  sessionId?: string;
  planArtifactOwner?: PlanArtifactOwner;
}

export interface OpenLinkOrFileResult {
  opened: boolean;
  modeUsed: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy' | 'copy-image';
  resolvedTarget: string;
}

export interface SwitchConversationBranchResult {
  session: ManagedSessionSummary;
  previousBranchId: string | null;
  messages: ChatMessageItem[];
  messagePosition?: MessagePagePosition;
  inspector: SessionInspectorData;
  swarm: SwarmTopologyState;
  tree: ConversationTreeState;
  telemetry: TelemetryDashboardSnapshot;
  layout: WorkspaceLayoutState;
}

export interface GravityDesktopBridge {
  // 系统、主题与图标
  getBootstrap(): Promise<AppBootstrapPayload>;
  updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences>;
  setAppIcon(iconId: GravityIconPreference): Promise<ClientPreferences>;
  importCustomTheme(jsonText: string): Promise<ClientPreferences>;
  exportCustomTheme(): Promise<string>;
  openLinkOrFileTarget(input: OpenLinkOrFileInput): Promise<OpenLinkOrFileResult>;
  /** 通过主进程系统剪贴板安全复制纯文本（规避 Electron 沙箱 file:// 下 navigator.clipboard 被拒） */
  copyText(text: string): Promise<void>;
  inspectLocalTargets(input: InspectLocalTargetsInput): Promise<InspectLocalTargetsResult>;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  checkForUpdates(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  installUpdate(): Promise<{ launched: boolean; message: string }>;
  getConnectionStatus(): Promise<AcpConnectionStatus>;

  // 账号 Profile 与官方认证（仅用户手动触发）
  getAccountsState(): Promise<AccountsStateSnapshot>;
  createAccountProfile(input: CreateAccountProfileInput): Promise<AccountsStateSnapshot>;
  deleteAccountProfile(profileId: string): Promise<AccountsStateSnapshot>;
  switchAccountProfile(profileId: string): Promise<AccountsStateSnapshot>;
  getAccountQuota(manual?: boolean): Promise<AccountQuotaReadResult>;
  launchOfficialLogin(profileId?: string): Promise<{ launched: boolean; message: string }>;
  officialLogout(): Promise<{ loggedOut: boolean; message: string }>;

  // 会话、Mode/Effort/Model、Inspector 与多开布局
  listSessions(includeHiddenPollution?: boolean): Promise<ManagedSessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<ManagedSessionSummary>;
  resumeSession(sessionId: string, cwd: string): Promise<ManagedSessionSummary>;
  closeSession(sessionId: string): Promise<void>;
  manageSession(id: string, action: SessionAction): Promise<{ sessions: ManagedSessionSummary[]; layout: WorkspaceLayoutState }>;
  answerQuestion(input: QuestionSubmission): Promise<QuestionSubmissionReceipt | void>;
  setSessionMode(sessionId: string, mode: AgentExecutionMode): Promise<ManagedSessionSummary>;
  setSessionEffort(
    sessionId: string,
    effort: AgentReasoningEffort
  ): Promise<ManagedSessionSummary>;
  setSessionModel(sessionId: string, modelId: string): Promise<ManagedSessionSummary>;
  getSessionMessagePage(sessionId: string, before?: number): Promise<ConversationMessagePage>;
  getSessionInspector(sessionId: string): Promise<SessionInspectorData>;
  getSessionPlanArtifact?(input: GetSessionPlanArtifactInput): Promise<PlanArtifactSnapshot>;
  listWorkspaceFiles(cwd: string, query?: string): Promise<string[]>;
  reviseMessage(input: ReviseMessageInput): Promise<ManagedSessionSummary>;
  getConversationTree(sessionId: string): Promise<ConversationTreeState>;
  switchConversationBranch(input: SwitchConversationBranchInput): Promise<SwitchConversationBranchResult>;
  sendPrompt(input: SendPromptInput): Promise<void>;
  cancelPrompt(sessionId: string): Promise<void>;
  compactSessionContext(sessionId: string): Promise<void>;
  saveWorkspaceLayout(layout: Partial<WorkspaceLayoutState>): Promise<WorkspaceLayoutState>;

  // 标题整理
  renameSession(sessionId: string, newTitle: string): Promise<ManagedSessionSummary>;
  togglePinSession(sessionId: string): Promise<ManagedSessionSummary>;
  organizeTitles(request?: TitleOrganizeRequest): Promise<TitleOrganizeResult>;

  // 内联 Approve for me
  setApprovalMode(mode: ApprovalMode): Promise<ApproveForMeConfig>;
  updateApprovalConfig(patch: Partial<ApproveForMeConfig>): Promise<ApproveForMeConfig>;
  submitApprovalDecision(submission: ApprovalDecisionSubmission): Promise<ApprovalDecisionResult>;
  clearSessionApprovals(sessionId: string): Promise<ManagedSessionSummary>;
  listSessionApprovalGrants(sessionId: string): Promise<SessionApprovalGrantsSnapshot>;
  revokeSessionApprovalGrant(
    input: RevokeSessionApprovalGrantInput
  ): Promise<SessionApprovalGrantsSnapshot>;
  cancelStage2ApprovalReview(requestId: string): Promise<{ cancelled: boolean }>;
  testExternalReviewerConnection(input: ExternalAiReviewerConfig): Promise<ExternalReviewerTestResult>;
  listApprovalAudit(limit?: number): Promise<ApprovalAuditEntry[]>;
  discoverExternalReviewerModels(
    input: ExternalReviewerModelsDiscoveryInput
  ): Promise<ExternalReviewerModelsDiscoveryResult>;

  // 独立外部翻译 API 配置与测试
  getTranslationConfig(): Promise<TranslationConfig>;
  updateTranslationConfig(patch: TranslationConfigPatch): Promise<TranslationConfig>;
  discoverExternalTranslationModels(
    input: ExternalReviewerModelsDiscoveryInput
  ): Promise<ExternalReviewerModelsDiscoveryResult>;
  testExternalTranslatorConnection(
    input?: Partial<ExternalTranslatorConfig>
  ): Promise<ExternalTranslatorTestResult>;

  // Context 遥测、24h/7d/30d 热力图与 Cost 单价配置
  getTelemetryDashboard(): Promise<TelemetryDashboardSnapshot>;
  updateModelRateCards(rateCards: ModelRateCard[]): Promise<TelemetryDashboardSnapshot>;

  // Plugins / MCP / Skills 管理
  getPluginsSnapshot(workspaceCwd?: string): Promise<PluginsManagerSnapshot>;
  runPluginAction(input: PluginActionInput): Promise<PluginsManagerSnapshot>;
  runMcpAction(input: McpActionInput): Promise<PluginsManagerSnapshot>;
  toggleSkillEnabled(skillId: string, enabled: boolean): Promise<PluginsManagerSnapshot>;

  // 蜂群态势
  getSwarmState(sessionId: string, before?: SwarmHistoryCursor): Promise<SwarmTopologyState>;

  // 实时事件订阅
  // 事件订阅返回取消函数。组件销毁或切换桥接实例时应逐个调用，避免重复收到同一条更新。
  onSessionUpdated(listener: (session: ManagedSessionSummary) => void): () => void;
  onMessageUpserted(
    listener: (payload: { sessionId: string; message: ChatMessageItem }) => void
  ): () => void;
  onInspectorUpdated(listener: (data: SessionInspectorData) => void): () => void;
  onPlanArtifactChanged?(listener: (event: PlanArtifactChangedEvent) => void): () => void;
  onApprovalRequested(listener: (request: PendingApprovalRequest) => void): () => void;
  onApprovalReviewing(listener: (event: ApprovalReviewingEvent) => void): () => void;
  onApprovalGuardActivity(listener: (event: ApprovalGuardActivityEvent) => void): () => void;
  onApprovalConfigUpdated(listener: (config: ApproveForMeConfig) => void): () => void;
  onApprovalResolved(
    listener: (payload: { requestId: string; sessionId: string }) => void
  ): () => void;
  onTelemetryUpdated(listener: (snapshot: TelemetryDashboardSnapshot) => void): () => void;
  onSwarmUpdated(listener: (topology: SwarmTopologyState) => void): () => void;
  onAccountUpdated(listener: (state: AccountsStateSnapshot) => void): () => void;
  onUpdateState(listener: (state: AppUpdateState) => void): () => void;
  onTreeUpdated(listener: (tree: ConversationTreeState) => void): () => void;
  onUiScaleCommand(listener: (command: UiScaleCommand) => void): () => void;
  onConnectionUpdated(listener: (status: AcpConnectionStatus) => void): () => void;
  onTranslationConfigUpdated(listener: (config: TranslationConfig) => void): () => void;
}

declare global {
  interface Window {
    gravityDesktop?: GravityDesktopBridge;
  }
}

export type { CustomThemeConfig };

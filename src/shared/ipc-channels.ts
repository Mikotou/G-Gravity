/**
 * Gravity v0.2 — 前后端 IPC 通道常量与 `window.gravityDesktop` / `window.agyDesktop` 强类型桥接契约
 */

import type {
  AgentExecutionMode,
  AgentReasoningEffort,
  AcpModelOption,
} from './acp-protocol';
import type {
  AccountsStateSnapshot,
  ContinueHistoryInGravityInput,
  CreateAccountProfileInput,
  ImportedHistoryDetail,
  ImportedHistorySessionRecord,
} from './accounts-history-contract';
import type {
  ApprovalAuditEntry,
  ApprovalDecisionSubmission,
  ApprovalMode,
  ApproveForMeConfig,
  PendingApprovalRequest,
} from './approval-contract';
import type {
  McpActionInput,
  PluginActionInput,
  PluginsManagerSnapshot,
} from './plugins-contract';
import type {
  ChatMessageItem,
  ManagedSessionSummary,
  SessionInspectorData,
  TitleOrganizeRequest,
  TitleOrganizeResult,
  WorkspaceLayoutState,
} from './session-contract';
import type { SwarmTopologyState } from './swarm-contract';
import type {
  ModelRateCard,
  TelemetryDashboardSnapshot,
} from './telemetry-contract';
import type {
  ClientPreferences,
  CustomThemeConfig,
  GravityIconId,
} from './theme-i18n-contract';

export const IPC_CHANNELS = {
  // 系统、品牌与偏好（含主题、自定义配色导入导出、图标切换）
  APP_GET_BOOTSTRAP: 'gravity:app:get-bootstrap',
  APP_UPDATE_PREFERENCES: 'gravity:app:update-preferences',
  APP_SET_ICON: 'gravity:app:set-icon',
  APP_IMPORT_CUSTOM_THEME: 'gravity:app:import-custom-theme',
  APP_EXPORT_CUSTOM_THEME: 'gravity:app:export-custom-theme',
  APP_OPEN_TARGET: 'gravity:app:open-target',
  APP_SELECT_DIRECTORY: 'gravity:app:select-directory',
  ACP_GET_CONNECTION_STATUS: 'gravity:acp:get-connection-status',

  // 多账号 Profile 管理与官方登录/登出（100% 仅限用户手动触发）
  ACCOUNT_GET_STATE: 'gravity:account:get-state',
  ACCOUNT_CREATE_PROFILE: 'gravity:account:create-profile',
  ACCOUNT_DELETE_PROFILE: 'gravity:account:delete-profile',
  ACCOUNT_SWITCH_PROFILE: 'gravity:account:switch-profile',
  AUTH_LAUNCH_OFFICIAL_LOGIN: 'gravity:auth:launch-official-login',
  AUTH_OFFICIAL_LOGOUT: 'gravity:auth:official-logout',

  // 多会话调度、Mode/Effort/Model、Inspector 数据与工作区文件引用补全
  SESSION_LIST: 'gravity:session:list',
  SESSION_CREATE: 'gravity:session:create',
  SESSION_RESUME: 'gravity:session:resume',
  SESSION_MANAGE: 'gravity:session:manage',
  ACCOUNT_QUOTA: 'gravity:account:quota',
  SESSION_ANSWER_QUESTION: 'gravity:session:answer-question',
  SESSION_CLOSE: 'gravity:session:close',
  SESSION_REVISE_MESSAGE: 'gravity:session:revise-message',
  SESSION_SEND_PROMPT: 'gravity:session:send-prompt',
  SESSION_CANCEL_PROMPT: 'gravity:session:cancel-prompt',
  SESSION_COMPACT_CONTEXT: 'gravity:session:compact-context',
  SESSION_SET_MODE: 'gravity:session:set-mode',
  SESSION_SET_EFFORT: 'gravity:session:set-effort',
  SESSION_SET_MODEL: 'gravity:session:set-model',
  SESSION_GET_MESSAGES: 'gravity:session:get-messages',
  SESSION_GET_INSPECTOR: 'gravity:session:get-inspector',
  SESSION_LIST_WORKSPACE_FILES: 'gravity:session:list-workspace-files',
  SESSION_SAVE_LAYOUT: 'gravity:session:save-layout',

  // 会话标题整理与重命名
  SESSION_RENAME: 'gravity:session:rename',
  SESSION_TOGGLE_PIN: 'gravity:session:toggle-pin',
  SESSION_ORGANIZE_TITLES: 'gravity:session:organize-titles',

  // 本地历史只读同步与“在 Gravity 中继续”
  HISTORY_LIST_IMPORTED: 'gravity:history:list-imported',
  HISTORY_GET_DETAIL: 'gravity:history:get-detail',
  HISTORY_CONTINUE_IN_GRAVITY: 'gravity:history:continue-in-gravity',

  // 内联 Approve for me 与审计
  APPROVAL_SET_MODE: 'gravity:approval:set-mode',
  APPROVAL_UPDATE_CONFIG: 'gravity:approval:update-config',
  APPROVAL_SUBMIT_DECISION: 'gravity:approval:submit-decision',
  APPROVAL_LIST_AUDIT: 'gravity:approval:list-audit',

  // Context 遥测、24h/7d/30d 热力图与 Cost 单价表
  TELEMETRY_GET_DASHBOARD: 'gravity:telemetry:get-dashboard',
  TELEMETRY_UPDATE_RATE_CARDS: 'gravity:telemetry:update-rate-cards',

  // Plugins / MCP / Skills 管理栏目
  PLUGINS_GET_SNAPSHOT: 'gravity:plugins:get-snapshot',
  PLUGINS_RUN_ACTION: 'gravity:plugins:run-action',
  MCP_RUN_ACTION: 'gravity:mcp:run-action',
  SKILLS_TOGGLE_ENABLED: 'gravity:skills:toggle-enabled',

  // 蜂群态势查询与演示模拟
  SWARM_GET_STATE: 'gravity:swarm:get-state',

  // 主进程 -> 渲染进程实时推送事件
  EVENT_SESSION_UPDATED: 'gravity:event:session-updated',
  EVENT_MESSAGE_UPSERTED: 'gravity:event:message-upserted',
  EVENT_INSPECTOR_UPDATED: 'gravity:event:inspector-updated',
  EVENT_APPROVAL_REQUESTED: 'gravity:event:approval-requested',
  EVENT_APPROVAL_RESOLVED: 'gravity:event:approval-resolved',
  EVENT_TELEMETRY_UPDATED: 'gravity:event:telemetry-updated',
  EVENT_SWARM_UPDATED: 'gravity:event:swarm-updated',
  EVENT_HISTORY_UPDATED: 'gravity:event:history-updated',
  EVENT_ACCOUNT_UPDATED: 'gravity:event:account-updated',
} as const;

export interface AcpConnectionStatus {
  connected: boolean;
  agyBinaryPath: string;
  agyVersion: string;
  agentServerVersion?: string;
  activeSessionCount: number;
  maxParallelSessions: number;
  activeProfileId: string;
  availableModels: AcpModelOption[];
  lastError?: string;
}

/** 首次挂载工作台所需的全量快照。它恢复布局、待审项与看板，消息详情按会话另行获取。 */
export interface AppBootstrapPayload {
  preferences: ClientPreferences;
  connection: AcpConnectionStatus;
  accounts: AccountsStateSnapshot;
  approvalConfig: ApproveForMeConfig;
  sessions: ManagedSessionSummary[];
  importedHistory: ImportedHistorySessionRecord[];
  layout: WorkspaceLayoutState;
  pendingApprovals: PendingApprovalRequest[];
  telemetry: TelemetryDashboardSnapshot;
  plugins: PluginsManagerSnapshot;
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
  annotations?: import('./session-contract').MessageAnnotation[];
}

export interface SendPromptInput {
  annotations?: import('./session-contract').MessageAnnotation[];
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
  action: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy';
  cwd?: string;
  sessionId?: string;
}

export interface OpenLinkOrFileResult {
  opened: boolean;
  modeUsed: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy';
  resolvedTarget: string;
}

export interface GravityDesktopBridge {
  // 系统、主题与图标
  getBootstrap(): Promise<AppBootstrapPayload>;
  updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences>;
  setAppIcon(iconId: GravityIconId): Promise<ClientPreferences>;
  importCustomTheme(jsonText: string): Promise<ClientPreferences>;
  exportCustomTheme(): Promise<string>;
  openLinkOrFileTarget(input: OpenLinkOrFileInput): Promise<OpenLinkOrFileResult>;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  getConnectionStatus(): Promise<AcpConnectionStatus>;

  // 账号 Profile 与官方认证（仅用户手动触发）
  getAccountsState(): Promise<AccountsStateSnapshot>;
  createAccountProfile(input: CreateAccountProfileInput): Promise<AccountsStateSnapshot>;
  deleteAccountProfile(profileId: string): Promise<AccountsStateSnapshot>;
  switchAccountProfile(profileId: string): Promise<AccountsStateSnapshot>;
  launchOfficialLogin(profileId?: string): Promise<{ launched: boolean; message: string }>;
  officialLogout(): Promise<{ loggedOut: boolean; message: string }>;

  // 会话、Mode/Effort/Model、Inspector 与多开布局
  listSessions(includeHiddenPollution?: boolean): Promise<ManagedSessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<ManagedSessionSummary>;
  resumeSession(sessionId: string, cwd: string): Promise<ManagedSessionSummary>;
  closeSession(sessionId: string): Promise<void>;
  manageSession(id: string, action: import('./session-contract').SessionAction): Promise<{ sessions: ManagedSessionSummary[]; layout: WorkspaceLayoutState }>;
  answerQuestion(input: import('./user-question').QuestionSubmission): Promise<void>;
  getAccountQuota(): Promise<import('./accounts-history-contract').AccountQuota>;
  setSessionMode(sessionId: string, mode: AgentExecutionMode): Promise<ManagedSessionSummary>;
  setSessionEffort(
    sessionId: string,
    effort: AgentReasoningEffort
  ): Promise<ManagedSessionSummary>;
  setSessionModel(sessionId: string, modelId: string): Promise<ManagedSessionSummary>;
  getSessionMessages(sessionId: string): Promise<ChatMessageItem[]>;
  getSessionInspector(sessionId: string): Promise<SessionInspectorData>;
  listWorkspaceFiles(cwd: string, query?: string): Promise<string[]>;
  reviseMessage(input: ReviseMessageInput): Promise<ManagedSessionSummary>;
  sendPrompt(input: SendPromptInput): Promise<void>;
  cancelPrompt(sessionId: string): Promise<void>;
  compactSessionContext(sessionId: string): Promise<void>;
  saveWorkspaceLayout(layout: Partial<WorkspaceLayoutState>): Promise<WorkspaceLayoutState>;

  // 标题整理
  renameSession(sessionId: string, newTitle: string): Promise<ManagedSessionSummary>;
  togglePinSession(sessionId: string): Promise<ManagedSessionSummary>;
  organizeTitles(request?: TitleOrganizeRequest): Promise<TitleOrganizeResult>;

  // 本地只读历史会话同步与续聊
  listImportedHistory(): Promise<ImportedHistorySessionRecord[]>;
  getImportedHistoryDetail(importedSessionId: string): Promise<ImportedHistoryDetail>;
  continueHistoryInGravity(
    input: ContinueHistoryInGravityInput
  ): Promise<ManagedSessionSummary>;

  // 内联 Approve for me
  setApprovalMode(mode: ApprovalMode): Promise<ApproveForMeConfig>;
  updateApprovalConfig(patch: Partial<ApproveForMeConfig>): Promise<ApproveForMeConfig>;
  submitApprovalDecision(submission: ApprovalDecisionSubmission): Promise<void>;
  listApprovalAudit(limit?: number): Promise<ApprovalAuditEntry[]>;

  // Context 遥测、24h/7d/30d 热力图与 Cost 单价配置
  getTelemetryDashboard(): Promise<TelemetryDashboardSnapshot>;
  updateModelRateCards(rateCards: ModelRateCard[]): Promise<TelemetryDashboardSnapshot>;

  // Plugins / MCP / Skills 管理
  getPluginsSnapshot(workspaceCwd?: string): Promise<PluginsManagerSnapshot>;
  runPluginAction(input: PluginActionInput): Promise<PluginsManagerSnapshot>;
  runMcpAction(input: McpActionInput): Promise<PluginsManagerSnapshot>;
  toggleSkillEnabled(skillId: string, enabled: boolean): Promise<PluginsManagerSnapshot>;

  // 蜂群态势
  getSwarmState(sessionId: string): Promise<SwarmTopologyState>;

  // 实时事件订阅
  // 事件订阅返回取消函数。组件销毁或切换桥接实例时应逐个调用，避免重复收到同一条更新。
  onSessionUpdated(listener: (session: ManagedSessionSummary) => void): () => void;
  onMessageUpserted(
    listener: (payload: { sessionId: string; message: ChatMessageItem }) => void
  ): () => void;
  onInspectorUpdated(listener: (data: SessionInspectorData) => void): () => void;
  onApprovalRequested(listener: (request: PendingApprovalRequest) => void): () => void;
  onApprovalResolved(
    listener: (payload: { requestId: string; sessionId: string }) => void
  ): () => void;
  onTelemetryUpdated(listener: (snapshot: TelemetryDashboardSnapshot) => void): () => void;
  onSwarmUpdated(listener: (topology: SwarmTopologyState) => void): () => void;
  onHistoryUpdated(
    listener: (records: ImportedHistorySessionRecord[]) => void
  ): () => void;
  onAccountUpdated(listener: (state: AccountsStateSnapshot) => void): () => void;
}

/** 向后兼容类型别名 */
export type AgyDesktopBridge = GravityDesktopBridge;

declare global {
  interface Window {
    gravityDesktop?: GravityDesktopBridge;
    agyDesktop?: GravityDesktopBridge;
  }
}

export type { CustomThemeConfig };

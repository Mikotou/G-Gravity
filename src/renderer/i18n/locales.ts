import { V034_EN, V034_ZH, type V034Strings } from './domains/v034';
import { V035_EN, V035_ZH, type V035Strings } from './domains/v035';
import { COPY_EN, COPY_ZH, type ComponentCopyStrings } from './domains/copy';
import type {
  AgentExecutionMode,
  AgentReasoningEffort,
  ApprovalMode,
  ClientLocale,
  CostTimeScope,
  ExternalReviewerThinkingLevel,
  ManagedSessionStatus,
  RightInspectorTab,
  RiskLevel,
  SwarmMemberKind,
  SwarmWorkerStatus,
  SwarmWorkspaceMode,
  ThemePaletteTokens,
  TokenHeatmapRange,
} from '@shared';

/**
 * 术语策略：技术术语（模型名、工具名、Token、Context、Diff、MCP、Skills、Plugins、mode / effort 名称、快捷键）
 * 在两种语言下都保留英文；说明、动作与错误使用对应语言。
 */
export type SettingsSection =
  | 'general'
  | 'themes'
  | 'tokens'
  | 'icons'
  | 'projects'
  | 'accounts'
  | 'approvals'
  | 'plugins'
  | 'rates'
  | 'about';

/** 两种语言共用的词典结构。固定文案是字符串，含计数、时间或状态的文案可用类型明确的格式化函数。 */
export interface UiDictionary {
  ui: WorkbenchStrings;
  appTagline: string;

  // 通用动作
  newSession: string;
  saveAction: string;
  cancelAction: string;
  closeAction: string;
  deleteAction: string;
  copyAction: string;
  copiedAction: string;
  renameSession: string;
  pinSession: string;
  unpinSession: string;

  // 侧栏
  searchPlaceholder: string;
  navPlugins: string;
  navSettings: string;
  navAccounts: string;
  sidebarToggleShow: string;
  sidebarToggleHide: string;
  inspectorToggleShow: string;
  inspectorToggleHide: string;
  acpConnected: string;
  acpDisconnected: string;
  organizeTitlesBtn: string;
  organizingTitles: string;
  hidePollutionSessions: string;
  showPollutionSessions: string;
  pollutionBadge: string;
  emptySessions: string;
  emptySearch: string;
  timeJustNow: string;
  timeMinutes: (n: number) => string;
  timeHours: (n: number) => string;
  timeDays: (n: number) => string;

  // 布局 / 主区
  layoutSingle: string;
  layoutSplit2: string;
  switchPaneSession: string;
  emptyPaneTitle: string;
  welcomeTitle: string;
  recentThreadsTitle: string;
  shortcutsTitle: string;
  pendingApprovalsBadge: (n: number) => string;
  shortcutLabels: {
    newThread: string;
    sidebar: string;
    inspector: string;
    split: string;
    mode: string;
    settings: string;
  };


  // Inspector
  inspectorTabs: Record<RightInspectorTab, string>;
  diffEmpty: string;
  filesChangedEmpty: string;
  planEmpty: string;
  terminalEmpty: string;
  planProgress: (done: number, total: number) => string;

  // 会话状态 / Mode / Effort
  sessionStatus: Record<ManagedSessionStatus, string>;
  executionModes: Record<AgentExecutionMode, { label: string; desc: string }>;
  effortLevels: Record<AgentReasoningEffort, string>;

  // Thinking 与工具
  thinkingStreamingTitle: string;
  thinkingCompletedTitle: string;
  thoughtSourceNativeZh: string;
  thoughtSourceGlossary: string;
  thoughtSourceExternal: string;
  thoughtSourceSubagent: string;
  thoughtTranslatingBadge: string;
  thoughtTrackZh: string;
  thoughtTrackRaw: string;
  toolStatusPending: string;
  toolStatusRunning: string;
  toolStatusCompleted: string;
  toolStatusFailed: string;
  toolStatusRejected: string;
  openDiffInInspector: string;

  // Composer
  composerPlaceholder: string;
  composerPlaceholderBusy: string;
  sendMessageBtn: string;
  stopGeneratingBtn: string;
  slashMenuHeader: string;
  mentionMenuHeader: string;
  pastedImageBadge: string;
  attachedFileBadge: string;
  removeAttachmentLabel: string;
  attachFileLabel: string;
  attachImageLabel: string;
  modeCycleHint: string;
  composerHint: string;
  approvalMenuTitle: string;
  clearSessionApprovals: string;
  rulesAndAuditLink: string;

  // 审批
  approvalModes: Record<ApprovalMode, { label: string; shortDesc: string }>;
  riskLevels: Record<RiskLevel, string>;
  screeningLocalAst: string;
  screeningRegexRule: string;
  screeningAiFallback: string;
  screeningManualMode: string;
  expTargetLabel: string;
  prefixUnavailableReason: string;
  actionErrorPrefix: string;
  unknownError: string;
  bootstrapErrorTitle: string;
  bootstrapLoading: string;
  retryBootstrapBtn: string;
  feedbackPlaceholder: string;
  confirmRejectBtn: string;
  approvalTabAudit: string;
  approvalTabRules: string;
  approvalTabReviewer: string;
  auditEmpty: string;
  verdictLabels: {
    auto_approved: string;
    auto_approved_turbo: string;
    user_approved: string;
    ai_approved: string;
    denied: string;
    rejected_with_feedback: string;
  };
  decisionSourceLabels: {
    'cache-hit': string;
    'session-prefix': string;
    'local-rule': string;
    'external-ai': string;
    'user-inline': string;
    'turbo-mode': string;
  };
  allowRulesTitle: string;
  askRulesTitle: string;
  denyRulesTitle: string;
  rulesEmpty: string;
  addPatternPlaceholder: string;
  addRuleBtn: string;
  deleteRuleBtn: string;
  safeDownloadToggle: string;
  safeDownloadDesc: string;
  approvalModeLabel: string;
  reviewerEnableToggle: string;
  reviewerProviderLabel: string;
  reviewerProviderGemini: string;
  reviewerProviderOpenAi: string;
  reviewerProviderOllama: string;
  reviewerEndpointLabel: string;
  reviewerModelLabel: string;
  reviewerApiKeyLabel: string;
  reviewerDiscoverBtn: string;
  reviewerDiscovering: string;
  reviewerDiscoveredCount: (n: number) => string;
  reviewerDiscoverPromptHint: string;
  reviewerCustomModelOption: string;
  reviewerThinkingLabel: string;
  reviewerThinkingUnsupported: string;
  reviewerThinkingLevels: Record<ExternalReviewerThinkingLevel, string>;
  reviewerMaxOutputLabel: string;
  reviewerMaxOutputHint: string;
  reviewerTimeoutLabel: string;
  reviewerTimeoutHint: string;
  reviewerCacheTtlLabel: string;
  saveReviewerBtn: string;

  // Context / Cost
  compactContextBtn: string;
  compactingContext: string;
  contextWindowTitle: string;
  heatmapSectionTitle: string;
  heatmapRanges: Record<TokenHeatmapRange, string>;
  heatmapLess: string;
  heatmapMore: string;
  costSectionTitle: string;
  costScopes: Record<CostTimeScope, string>;
  costDimInput: string;
  costDimCached: string;
  costDimOutput: string;
  costDimThinking: string;
  stackedBarChartTitle: string;
  donutChartTitle: string;
  costEmpty: string;
  editRateCardsBtn: string;
  breakdownSystem: string;
  breakdownUser: string;
  breakdownAssistant: string;
  breakdownThought: string;
  breakdownTools: string;
  breakdownAttachments: string;
  attachmentAuditTitle: string;
  compactionMonitorTitle: string;
  compactionCountBadge: (n: number) => string;
  compactionEmpty: string;
  compactionBeforeLabel: string;
  compactionManualLabel: string;
  compactionAutoLabel: string;
  usageSources: {
    'acp-reported': string;
    estimated: string;
    mixed: string;
  };
  contextEmpty: string;

  // 设置
  settingsTitle: string;
  settingsNav: Record<SettingsSection, string>;
  settingsNavGroups: { app: string; workspace: string; info: string };
  languageLabel: string;
  localeZhLabel: string;
  localeEnLabel: string;
  defaultThoughtTrackLabel: string;
  translationEngineLabel: string;
  localTranslatorLabel: string;
  translationEngineLocal: string;
  translationEngineExternal: string;
  translationExternalCardTitle: string;
  translationExternalBanner: string;
  translationExternalEnableToggle: string;
  translationExternalDiscoverBtn: string;
  translationExternalTestBtn: string;
  translationExternalTesting: string;
  translationExternalSaveBtn: string;
  translationExternalViewStatsBtn: string;
  translationExternalConnectPrompt: string;
  translationMaxOutputHint: string;
  translationTimeoutHint: string;
  translationSavedKeyHint: string;
  ctxViewContext: string;
  ctxViewReviewer: string;
  ctxViewTranslator: string;
  treeCostTooltip: (
    branchCount: number,
    total: string,
    model: string,
    reviewer: string,
    translator: string
  ) => string;
  processPerSessionLabel: string;
  processPerSessionDesc: string;
  themeSystemOption: string;
  themeSystemDesc: string;
  themeDarkGroup: string;
  themeLightGroup: string;
  customThemeNameLabel: string;
  customThemePolarityLabel: string;
  importThemeJsonBtn: string;
  exportThemeJsonBtn: string;
  applyCustomThemeBtn: string;
  startFromPresetLabel: string;
  tokenGroups: {
    surfaces: string;
    text: string;
    accent: string;
    status: string;
    diff: string;
    syntax: string;
  };
  tokenLabels: Record<keyof ThemePaletteTokens, string>;
  rateCardsSaveBtn: string;
  rateCardsResetBtn: string;
  rateColModel: string;
  savedHint: string;

  // Plugins
  pluginsTabBuiltins: string;
  pluginsTabPlugins: string;
  pluginsTabMcp: string;
  pluginsTabSkills: string;
  pluginInstallPlaceholder: string;
  pluginInstallBtn: string;
  pluginEnableBtn: string;
  pluginDisableBtn: string;
  pluginUninstallBtn: string;
  pluginsEmpty: string;
  mcpNamePlaceholder: string;
  mcpCmdPlaceholder: string;
  mcpAddBtn: string;
  mcpRemoveBtn: string;
  mcpEmpty: string;
  skillsEmpty: string;
  activeLabel: string;
  lastCommandLabel: string;

  // Accounts
  accountsActiveLabel: string;
  accountsSwitchBtn: string;
  accountsCreatePlaceholder: string;
  accountsCreateBtn: string;
  accountsDeleteBtn: string;
  accountsIdentityTitle: string;
  accountsProfilesTitle: string;
  officialLogin: string;
  officialLogout: string;
  officialDefaultBadge: string;

  // 新建会话 / 标题整理
  newSessionModalTitle: string;
  newSessionCwdLabel: string;
  newSessionNormalizedPreview: string;
  newSessionTitleLabel: string;
  newSessionTitlePlaceholder: string;
  recentWorkspacesLabel: string;
  createSessionConfirm: string;
  organizeModalTitle: string;
  organizeSummaryText: (updated: number, hidden: number) => string;
  organizeNoChanges: string;
  organizeBeforeCol: string;
  organizeAfterCol: string;
  reOrganizeBtn: string;

  // Swarm
  swarmActivePill: (total: number, working: number) => string;
  swarmViewAll: string;
  swarmViewWorkers: string;
  swarmViewBoard: string;
  swarmViewTimeline: string;
  swarmEmptyDesc: string;
  swarmStatTotal: string;
  swarmStatWorking: string;
  swarmStatWaiting: string;
  swarmStatCompleted: string;
  swarmWorkerStatuses: Record<SwarmWorkerStatus, string>;
  swarmWorkspaceModes: Record<SwarmWorkspaceMode, string>;
  swarmMemberKinds: Record<SwarmMemberKind, string>;
  swarmBriefLabel: string;
  swarmCurrentActionLabel: string;
  swarmBoardTitle: string;
  swarmDoneBadge: string;
  swarmStallBadge: string;
  swarmTimelineTitle: string;

  // About & Updates
  updatesSectionTitle: string;
  updatesSourceLabel: string;
  updatesAutoCheckLabel: string;
  updatesAutoCheckDesc: string;
  updatesCheckBtn: string;
  updatesIdleHint: string;
  updatesChecking: string;
  updatesUpToDate: string;
  updatesAvailableBadge: (version: string) => string;
  updatesDownloadBtn: string;
  updatesDownloading: string;
  updatesInstallRestartBtn: string;
  updatesOpenPackageBtn: string;
  updatesInstalling: string;
  updatesViewReleaseBtn: string;
  updatesNoMatchingAsset: string;
  updatesToastAvailable: (version: string) => string;
}

// 标签用共享主题色键索引。增删一个色键时，两份本地化标签都需要随类型一起更新。
const TOKEN_LABELS_ZH: Record<keyof ThemePaletteTokens, string> = {
  bgApp: '应用背景',
  bgSidebar: '侧栏背景',
  bgSurface: '卡片表面',
  bgElevated: '浮层背景',
  bgCode: '代码块背景',
  textPrimary: '主要文字',
  textSecondary: '次要文字',
  textMuted: '弱化文字',
  borderSubtle: '细边框',
  borderStrong: '强调边框',
  accentPrimary: '主色',
  accentSoft: '主色柔光',
  statusSuccess: '成功',
  statusWarning: '警告',
  statusDanger: '危险',
  diffAddedBg: 'Diff 新增底色',
  diffAddedText: 'Diff 新增文字',
  diffRemovedBg: 'Diff 删除底色',
  diffRemovedText: 'Diff 删除文字',
  syntaxKeyword: '关键字',
  syntaxString: '字符串',
  syntaxFunction: '函数 / 数字',
  syntaxComment: '注释',
};

const TOKEN_LABELS_EN: Record<keyof ThemePaletteTokens, string> = {
  bgApp: 'App background',
  bgSidebar: 'Sidebar',
  bgSurface: 'Surface',
  bgElevated: 'Elevated',
  bgCode: 'Code block',
  textPrimary: 'Primary text',
  textSecondary: 'Secondary text',
  textMuted: 'Muted text',
  borderSubtle: 'Subtle border',
  borderStrong: 'Strong border',
  accentPrimary: 'Accent',
  accentSoft: 'Accent soft',
  statusSuccess: 'Success',
  statusWarning: 'Warning',
  statusDanger: 'Danger',
  diffAddedBg: 'Diff added bg',
  diffAddedText: 'Diff added text',
  diffRemovedBg: 'Diff removed bg',
  diffRemovedText: 'Diff removed text',
  syntaxKeyword: 'Keyword',
  syntaxString: 'String',
  syntaxFunction: 'Function / number',
  syntaxComment: 'Comment',
};

/** v0.1.5 工作台新增的交互文案（缩放、拖拽调整、分级菜单、状态反馈）。 */
export interface WorkbenchStrings {
  interruptHint: string;
  uiScaleLabel: string;
  uiScaleToast: (percent: number) => string;
  resetAction: string;
  resizeSidebar: string;
  resizeInspector: string;
  resizeSplit: string;
  resizeComposer: string;
  accountMenu: string;
  projects: string;
  modelMenuTitle: string;
  effortTitle: string;
  changesTab: string;
  viewDiff: string;
  viewFiles: string;
  detailsAction: string;
  newActivity: string;
  backToLatest: string;
  dockInspector: string;
  floatInspector: string;
  clearSearch: string;
  realtimeTpsLabel: string;
  sessionAvgTpsLabel: string;
  sessionCacheHitLabel: string;
  sessionCacheHitUnknown: string;
  sessionCacheHitUnknownDetail: string;
  organizeAllTitle: string;
  organizeProjectTitle: (projectName: string) => string;
  organizeSessionTitle: string;
  organizingWithModel: (model: string) => string;
  organizeCooldownBanner: (seconds: number) => string;
  organizeSkippedNote: (count: number) => string;
  organizeWindowQuota: (remaining: number, max: number) => string;
  organizeModelBadge: (model: string) => string;
  copyImageAction: string;
  copiedImageAction: string;
  /* ---- v0.2.4 Guardian 审查 / 会话信任 / 欢迎直达 / 设置补齐 ---- */
  guardianReviewingTitle: string;
  guardianReviewingDesc: string;
  guardianTakeOver: string;
  guardianTakingOver: string;
  guardianTakeOverFailed: string;
  guardianModelPill: (provider: string, model: string) => string;
  guardianActionTitle: (tool: string) => string;
  riskScoreLabel: (score: number) => string;
  riskScoreTitle: string;
  intentAlignmentLabels: Record<'aligned' | 'uncertain' | 'misaligned', string>;
  intentAlignmentTitle: string;
  requestWhyManual: string;
  screeningAiRequestedReview: string;
  aiReviewNoteLabel: string;
  aiReviewReferenceLabel: string;
  aiReviewDenyLabel: string;
  aiReviewErrorLabel: string;
  commandExpand: string;
  commandCollapse: string;
  feedbackHint: string;
  approvalGlobalDefaultSuffix: string;
  approvalHybridLockedTitle: string;
  approvalHybridNotConnected: string;
  approvalConnectPromptText: string;
  approvalConnectPromptBtn: string;
  reviewerUsageTitle: string;
  reviewerUsageLive: string;
  reviewerUsageOff: string;
  reviewerUsageSession: string;
  reviewerUsageAllTime: (providerCount: number) => string;
  reviewerUsageCombinedTitle: (providerCount: number) => string;
  reviewerUsageStatsLink: string;
  trustTitle: string;
  trustDelegated: string;
  trustDelegatedSince: (time: string) => string;
  trustFollowingHybrid: string;
  trustNotDelegated: string;
  trustRevokeDelegation: string;
  trustPrefixesTitle: string;
  trustPrefixHits: (count: number) => string;
  trustNoPrefixes: string;
  trustLoading: string;
  trustRevokePrefix: (prefix: string) => string;
  trustUnavailable: string;
  welcomeQuickPlaceholder: string;
  welcomeQuickChooseDir: string;
  welcomeQuickBrowse: string;
  welcomeQuickNoDir: string;
  welcomeQuickSend: string;
  welcomeQuickHint: string;
  welcomeQuickStarting: string;
  welcomeRecentDirs: string;
  reviewerArchTitle: string;
  reviewerArchLayer1Title: string;
  reviewerArchLayer1Body: string;
  reviewerArchLayer2Title: string;
  reviewerArchLayer2Lead: string;
  reviewerArchLayer2Rest: string;
  reviewerModeMismatch: (current: string, hybrid: string) => string;
  switchToMode: (label: string) => string;
  reviewerOllamaDiscoverHint: string;
  reviewerBackToList: string;
  reviewerModelDefaultLevel: (level: string) => string;
  pluginSectionNames: Record<'plugins' | 'mcp' | 'skills', string>;
  pluginSectionError: (section: string, message: string) => string;
  pluginInstallHint: string;
  attachmentTooLarge: (name: string) => string;
  colorTokenInvalid: (key: string) => string;
  heatmapRowCostTitle: (date: string, cost: string) => string;
  /* ---- v0.3.1 媒体混排 / 暂停诊断 / 缺陷修复 ---- */
  v031: V031Strings;
  /* ---- v0.3.2 Turbo / Approve for me 策略 / 回合结算反馈 ---- */
  v032: V032Strings;
  /* ---- v0.3.3 前端缺陷修复 ---- */
  v033: V033Strings;
  /* ---- v0.3.4 五维重塑（按域拆分，见 i18n/domains/v034.ts & copy.ts） ---- */
  v034: V034Strings;
  /* ---- v0.3.5 热力图 / Plan 提问与检视器 / UI 精简（见 i18n/domains/v035.ts） ---- */
  v035: V035Strings;
  copy: ComponentCopyStrings;
}

export interface V033Strings {
  /** 回合进行中禁用推理强度切换时的提示 */
  effortBusyHint: string;
  /** 检视器变更摘要中的文件计数单位 */
  inspectorFilesUnit: string;
  /** Terminal 页签中被策略拦截（rejected）命令的徽标 */
  terminalRejected: string;
}

export interface V032Strings {
  /** Composer 执行模式弹出菜单 */
  modeMenuTitle: string;
  modeMenuCycleHint: (shortcut: string) => string;
  turboActiveTitle: (shortcut: string) => string;
  turboConfirmTitle: string;
  turboConfirmBody: string;
  turboConfirmSafeguards: string;
  turboConfirmAction: string;
  turboConfirmCancel: string;
  /** Approve for me v0.3.2 放行策略 */
  policyTitle: string;
  policyLead: string;
  allowAlignedHighRiskLabel: string;
  allowAlignedHighRiskDesc: string;
  alignedHighRiskMaxScoreLabel: string;
  alignedHighRiskMaxScoreDesc: (score: number) => string;
  fastPassLowRiskDevLabel: string;
  fastPassLowRiskDevDesc: string;
  policyHybridNote: string;
  policySaved: string;
  /** 审批卡片规则地板层级 */
  floorTierALabel: string;
  floorTierADesc: string;
  floorTierAWithAiLabel: string;
  floorTierAWithAiDesc: (reason?: string) => string;
  floorTierAReferenceHint: string;
  screeningFloorForcedManual: string;
  floorTierBLabel: string;
  floorTierBDesc: (alignment: 'aligned' | 'uncertain' | 'misaligned' | undefined) => string;
  /** 回合结算状态条 */
  turnSettledFailed: (failed: number) => string;
  turnSettledFailedWithReply: (failed: number) => string;
  modeMenuBusyHint: string;
  turnSettledRejected: (rejected: number) => string;
  turnSettledHint: string;
  turnSettledContinue: string;
  toolExitCode: (code: number) => string;
  /** 其他 */
  heatmapThreads: (n: number) => string;
  defaultCwdPlaceholder: (mac: boolean) => string;
  pluginPathPlaceholder: (base: string, mac: boolean) => string;
}

export interface V031Strings {
  filesTrayTitle: string;
  galleryTitle: string;
  expandImages: (n: number) => string;
  collapseImages: string;
  expandFiles: (n: number) => string;
  collapseFiles: string;
  zoomImage: string;
  revealInFolder: string;
  revealInFinder: string;
  /** 右键菜单：在系统文件管理器中定位文件（Windows / Linux） */
  ctxRevealFile: string;
  /** 右键菜单：在访达中定位文件（macOS） */
  ctxRevealFileFinder: string;
  ctxOpenFolder: string;
  ctxOpenFolderFinder: string;
  ctxRevealExecutable: string;
  ctxRevealExecutableFinder: string;
  imageUnavailable: string;
  vectorLabel: string;
  folderLabel: string;
  filePreviewSummary: string;
  lightboxPrev: string;
  lightboxNext: string;
  lightboxPosition: (index: number, total: number) => string;
  closePreview: string;
  linkOpenFailed: (message: string) => string;
  dismissAction: string;
  diagSuggestions: string;
  diagTechnical: string;
  diagCooldown: (seconds: number) => string;
  diagCooldownDone: string;
  diagActionLabels: Record<import('@shared').DiagnosticActionId, string>;
  diagActionFailed: (message: string) => string;
  stoppingLabel: string;
  stoppedChip: string;
  pausedChip: string;
  warningChip: string;
  errorChip: string;
  waitingAnswerChip: string;
  retryAction: string;
  trustLoadFailed: (message: string) => string;
  compactErrorTitle: string;
  swarmSnapshotStats: string;
  archiveMatches: (shown: number, total: number) => string;
  testNeedsKey: string;
  themeSaveFailed: (message: string) => string;
  bootstrapTroubleshoot: string[];
  swarmLaunchPrompt: (task: string) => string;
  continuePrompt: string;
  noApprovalPending: string;
}

const WORKBENCH_ZH: WorkbenchStrings = {
  interruptHint: 'Esc 中断',
  uiScaleLabel: '界面缩放',
  uiScaleToast: (p) => `界面缩放 ${p}%`,
  resetAction: '重置',
  resizeSidebar: '拖动调整侧栏宽度，双击恢复默认',
  resizeInspector: '拖动调整检视器宽度，双击恢复默认',
  resizeSplit: '拖动调整分屏比例，双击对半',
  resizeComposer: '拖动调整输入框高度，双击恢复默认',
  accountMenu: '账户与工作区',
  projects: '项目与目录',
  modelMenuTitle: '模型',
  effortTitle: '推理强度',
  changesTab: 'Changes',
  viewDiff: 'Diff',
  viewFiles: 'Files',
  detailsAction: '详情',
  newActivity: '有新内容',
  backToLatest: '回到最新',
  dockInspector: '停靠到右侧',
  floatInspector: '切换为悬浮面板',
  clearSearch: '清空搜索',
  realtimeTpsLabel: '实时输出速率',
  sessionAvgTpsLabel: '会话平均速率',
  sessionCacheHitLabel: '平均缓存命中率',
  sessionCacheHitUnknown: '未知',
  sessionCacheHitUnknownDetail: '当前记录缺少计算整个会话命中率所需的用量数据。',
  organizeAllTitle: '全部整理未整理会话（内置 Hydrogen medium · 1分钟限4次）',
  organizeProjectTitle: (name) => `使用 Hydrogen (medium) 整理「${name}」项目标题`,
  organizeSessionTitle: '使用 Hydrogen (medium) 整理此会话标题',
  organizingWithModel: (model) => `正在使用内置模型 ${model} 整理标题…`,
  organizeCooldownBanner: (sec) => `标题整理冷却中 ${sec}s（1分钟最多4次）`,
  organizeSkippedNote: (n) => `已跳过 ${n} 个先前已整理的会话`,
  organizeWindowQuota: (left, max) => `本分钟剩余 ${left}/${max} 次`,
  organizeModelBadge: (model) => `内置模型 · ${model}`,
  copyImageAction: '复制图片',
  copiedImageAction: '已复制图片',
  guardianReviewingTitle: 'Guardian AI 正在审查…',
  guardianReviewingDesc: '外部复核模型正在评估这项操作。通过后自动放行，存疑时转交给你确认。',
  guardianTakeOver: '立即转为人工审批',
  guardianTakingOver: '正在转交…',
  guardianTakeOverFailed: '未能中止复核，请稍后再试',
  guardianModelPill: (provider, model) => `${provider} · ${model}`,
  guardianActionTitle: (tool) => `是否允许 ${tool} 执行这项操作？`,
  riskScoreLabel: (score) => `风险分 ${score}`,
  riskScoreTitle: 'Guardian 给出的 0–100 结构化风险评分，越高越需要谨慎',
  intentAlignmentLabels: { aligned: '符合当前意图', uncertain: '意图待确认', misaligned: '偏离当前意图' },
  intentAlignmentTitle: '这项操作与当前对话目标的一致性评估',
  requestWhyManual: '转交原因',
  screeningAiRequestedReview: '外部 AI 复核转人工',
  aiReviewNoteLabel: 'AI 代审说明',
  aiReviewReferenceLabel: 'AI 风险参考（仅辅助人工）',
  aiReviewDenyLabel: 'AI 代审建议拒绝',
  aiReviewErrorLabel: 'AI 代审异常',
  commandExpand: '展开完整内容',
  commandCollapse: '收起',
  feedbackHint: '告诉 AI 应该怎样调整做法，它会据此继续。',
  approvalGlobalDefaultSuffix: '（全局默认）',
  approvalHybridLockedTitle: '需先连接外部复核模型方可开启 AI 代审',
  approvalHybridNotConnected: '未连接外部复核',
  approvalConnectPromptText: '尚未连接外部复核模型，无法开启「AI 代审」；当前仅可使用基础规则机制（仅规则 / 人工审批）。',
  approvalConnectPromptBtn: '前往连接外部复核 →',
  reviewerUsageTitle: '外部复核 API 用量',
  reviewerUsageLive: '已连接',
  reviewerUsageOff: '未连接',
  reviewerUsageSession: '本会话',
  reviewerUsageAllTime: (n) => `客户端累计${n > 1 ? ` (${n}商)` : ''}`,
  reviewerUsageCombinedTitle: (n) => `已联合统计 ${n} 个历史 API 服务商`,
  reviewerUsageStatsLink: '查看 24h / 7d / 30d 分布与明细 →',
  trustTitle: '本会话信任',
  trustDelegated: '已委派 Guardian 代审',
  trustDelegatedSince: (t) => `自 ${t} 起`,
  trustFollowingHybrid: '跟随全局 · AI 代审生效中',
  trustNotDelegated: '未单独委派 · 按当前审批模式处理',
  trustRevokeDelegation: '撤销委派',
  trustPrefixesTitle: '已记住的命令前缀',
  trustPrefixHits: (n) => `命中 ${n} 次`,
  trustNoPrefixes: '暂无记住的命令前缀',
  trustLoading: '正在读取本会话授权…',
  trustRevokePrefix: (p) => `撤销前缀 ${p}`,
  trustUnavailable: '当前连接不支持查看授权明细',
  welcomeQuickPlaceholder: '描述你要完成的任务，按 Enter 在所选目录新建会话并发送…',
  welcomeQuickChooseDir: '选择工作目录',
  welcomeQuickBrowse: '浏览其他目录…',
  welcomeQuickNoDir: '请先选择一个工作目录',
  welcomeQuickSend: '新建并发送',
  welcomeQuickHint: 'Enter 发送 · Shift+Enter 换行',
  welcomeQuickStarting: '正在创建会话…',
  welcomeRecentDirs: '最近目录',
  reviewerArchTitle: '双层零配额守卫架构（严格遵循合规红线 #6）',
  reviewerArchLayer1Title: '第一层（基础规则机制，0ms、零额度消耗）',
  reviewerArchLayer1Body: '未连接外部复核时仅启用基础规则（只读文件/代码/文档/MCP 查询、多级只读管道、自定义规则与会话前缀放行）。',
  reviewerArchLayer2Title: '第二层（AI 代审，需正常连接外部复核）',
  reviewerArchLayer2Lead: '对接本机',
  reviewerArchLayer2Rest: 'Ollama 或自备公开 API Key 模型，自动复核灰区开发命令、非只读 MCP 工具、默认模式源码编辑及只读 PowerShell 分析脚本（结果按 TTL 缓存，用量与花费由各 API Provider 汇总统计，API Key 经系统级加密存储）。',
  reviewerModeMismatch: (c, h) => `当前审批模式为「${c}」，外部模型复核仅在「${h}」模式下触发。`,
  switchToMode: (label) => `切至${label}`,
  reviewerOllamaDiscoverHint: '从本机 Ollama 查询已安装的模型列表',
  reviewerBackToList: '列表',
  reviewerModelDefaultLevel: (lv) => `模型默认: ${lv}`,
  pluginSectionNames: { plugins: '插件', mcp: 'MCP 服务', skills: 'Skills' },
  pluginSectionError: (section, msg) => `${section}刷新失败：${msg}`,
  pluginInstallHint: '支持插件名、name@marketplace，或本地插件目录的绝对路径（例如 D:\\dev\\my-plugin 或 /opt/plugins/my-plugin）。',
  attachmentTooLarge: (name) => `文件 ${name} 超过 20MB 限制`,
  colorTokenInvalid: (key) => `颜色格式无效 (${key})：请使用 #HEX 或 rgba(...)`,
  heatmapRowCostTitle: (date, cost) => `${date} 合计花费 ${cost}`,
  v031: {
    filesTrayTitle: '相关文件与目录',
    galleryTitle: '图片',
    expandImages: (n) => `展开其余 ${n} 张图片`,
    collapseImages: '收起图片',
    expandFiles: (n) => `展开其余 ${n} 个文件`,
    collapseFiles: '收起文件',
    zoomImage: '放大查看',
    revealInFolder: '在文件夹中显示',
    revealInFinder: '在访达中显示',
    ctxRevealFile: '在文件管理器中定位',
    ctxRevealFileFinder: '在访达中显示',
    ctxOpenFolder: '在文件管理器中打开目录',
    ctxOpenFolderFinder: '在访达中打开目录',
    ctxRevealExecutable: '在文件管理器中定位文件',
    ctxRevealExecutableFinder: '在访达中显示文件',
    imageUnavailable: '图片无法显示',
    vectorLabel: '矢量图',
    folderLabel: '文件夹',
    filePreviewSummary: '预览内容',
    lightboxPrev: '上一张',
    lightboxNext: '下一张',
    lightboxPosition: (i, n) => `第 ${i} / ${n} 张`,
    closePreview: '关闭预览',
    linkOpenFailed: (m) => `无法打开：${m}`,
    dismissAction: '关闭提示',
    diagSuggestions: '建议操作',
    diagTechnical: '技术详情',
    diagCooldown: (s) => `冷却中，${s} 秒后可重试`,
    diagCooldownDone: '冷却已结束，可以重试',
    diagActionLabels: {
      continue_turn: '继续生成',
      retry_turn: '重试',
      reconnect_session: '重新连接',
      compact_context: '压缩上下文 (/compact)',
      launch_official_login: '启动官方登录',
      open_accounts_settings: '账号设置',
      open_approval_settings: '审批设置',
      new_session: '新建会话',
      edit_last_message: '编辑上一条消息',
      scroll_to_approval: '前往审批卡片',
      focus_question_bar: '前往问题栏',
      dismiss: '忽略',
    },
    diagActionFailed: (m) => `操作未完成：${m}`,
    stoppingLabel: '正在停止…',
    stoppedChip: '已停止',
    pausedChip: '已暂停',
    warningChip: '未正常结束',
    errorChip: '出错',
    waitingAnswerChip: '待回答',
    retryAction: '重试',
    trustLoadFailed: (m) => `读取授权明细失败：${m}`,
    compactErrorTitle: '压缩上下文失败',
    swarmSnapshotStats: '当前快照统计',
    archiveMatches: (shown, total) => (shown === total ? `${total}` : `${shown} / ${total}`),
    testNeedsKey: '请先填写 API Key 再测试',
    themeSaveFailed: (m) => `主题保存失败：${m}`,
    bootstrapTroubleshoot: [
      '确认官方 agy CLI 已安装并可在终端中运行 agy --version；',
      '检查是否已通过官方登录完成认证；',
      '重启 Gravity 后重试，若仍失败请查看日志中的详细错误。',
    ],
    swarmLaunchPrompt: (task) => `请针对以下任务启动多子个体并行协作（优先调用 swarm 或 invoke_subagent 拆分独立角色分工并行执行，并汇总各子个体结果）：\n\n${task}`,
    continuePrompt: '请继续完成刚才中断的任务并给出完整回复。',
    noApprovalPending: '当前没有待审批的操作',
  },
  v032: {
    modeMenuTitle: '执行模式',
    modeMenuCycleHint: (k) => `${k} 仅在 default / accept-edits / plan 之间切换`,
    turboActiveTitle: (k) => `Turbo 已启用：完全访问权限，无操作审批限制（保留防封号底线）。按 ${k} 回到 default。`,
    turboConfirmTitle: '启用 Turbo · 完全访问',
    turboConfirmBody: '连接支持原生 full-access 的官方 agy 会话时，将启用服务端完全访问模式；否则在客户端回调层启用本地 Turbo 直通。执行命令、写入或删除文件、调用 MCP 工具都不再弹出审批。',
    turboConfirmSafeguards: '客户端本地仍保留防封号红线（不读取凭据、不写入 ~/.gemini 官方目录）与系统级破坏防护。',
    turboConfirmAction: '确认启用 Turbo',
    turboConfirmCancel: '取消',
    policyTitle: 'AI 代审放行策略',
    policyLead: '在「AI 代审」模式下，除账号安全/防封号红线外，最终裁决权归外部 AI：符合用户意图时高风险及以下自动放行，不符合意图时中风险及以上不放行。',
    allowAlignedHighRiskLabel: '允许符合意图的高风险操作自动放行',
    allowAlignedHighRiskDesc: 'AI 判定操作符合你的当前意图时，高风险及以下（评分不超过上限）自动放行并记录审计；关闭后仅放行中/低风险。',
    alignedHighRiskMaxScoreLabel: '高风险放行评分上限',
    alignedHighRiskMaxScoreDesc: (n) => `符合意图的高风险操作在评分 ≤ ${n} 时自动放行；高于此分或属于 critical 仍需人工确认（可设 60–100）。`,
    fastPassLowRiskDevLabel: '直接放行只读与测试构建命令',
    fastPassLowRiskDevDesc: '工作区内的只读查看、git 只读查询、测试/构建/类型检查链与目录创建由本地规则直接放行，无需调用外部复核。',
    policyHybridNote: '高风险放行仅在「AI 代审」模式且外部复核已连接时生效。',
    policySaved: '放行策略已保存。',
    floorTierALabel: '触及账号安全底线，需人工确认',
    floorTierADesc: '此类操作涉及账号安全/防封号红线（凭据、.gemini 受保护目录、云元数据、受限 Google 内部地址、截断载荷或你设定的询问规则），不允许 AI 代为放行。',
    floorTierAWithAiLabel: '已由安全底线强制转人工（不受 AI 评分与意图放行）',
    floorTierAWithAiDesc: (reason) =>
      reason
        ? `${reason}。此红线优先级高于 AI 风险分与意图判定，即使评分低于自动放行上限也不会自动放行；下方 AI 解释仅作人工审查参考。`
        : '此类操作触及账号安全/防封号红线，优先级高于 AI 风险分与意图判定，即使评分低于自动放行上限也不会自动放行；下方 AI 解释仅作人工审查参考。',
    floorTierAReferenceHint: '已命中安全底线，此评估仅作人工参考，不会触发自动放行',
    screeningFloorForcedManual: '安全底线强制转人工（附 AI 参考）',
    floorTierBLabel: '高风险操作，需确认是否符合你的意图',
    floorTierBDesc: (a) =>
      a === 'misaligned'
        ? 'AI 复核认为这一步偏离了你当前的需求，因此转交你决定。'
        : a === 'uncertain'
          ? 'AI 复核无法确认这一步与当前需求一致，因此转交你决定。'
          : a === 'aligned'
            ? 'AI 复核认为符合你的意图，但风险评分超过了自动放行上限，因此转交你决定。'
            : '这是可按意图放行的高风险操作，本次未获得 AI 复核确认，因此转交你决定。',
    turnSettledFailed: (n) => `回合已结束 · ${n} 项操作失败`,
    turnSettledFailedWithReply: (n) => `本轮有 ${n} 项操作失败，助手已给出说明`,
    modeMenuBusyHint: '当前回合进行中，空闲后可切换模式',
    turnSettledRejected: (n) => `${n} 项被拦截`,
    turnSettledHint: '模型在失败后没有继续输出。可以让它继续，或调整指令后重试。',
    turnSettledContinue: '继续任务',
    toolExitCode: (c) => `exit ${c}`,
    heatmapThreads: (n) => `${n} 个会话`,
    defaultCwdPlaceholder: (mac) => (mac ? '例如 /Users/you/Projects/my-app' : '例如 C:\\path\\to\\project'),
    pluginPathPlaceholder: (base, mac) => `${base}（如 ${mac ? '/path/to/plugin' : 'C:\\path\\to\\plugin'}）`,
  },
  v033: {
    effortBusyHint: '当前回合进行中，空闲后可切换推理强度',
    inspectorFilesUnit: '个文件',
    terminalRejected: '已拦截',
  },
  v034: V034_ZH,
  v035: V035_ZH,
  copy: COPY_ZH,
};

const WORKBENCH_EN: WorkbenchStrings = {
  interruptHint: 'Esc to interrupt',
  uiScaleLabel: 'Interface scale',
  uiScaleToast: (p) => `Interface scale ${p}%`,
  resetAction: 'Reset',
  resizeSidebar: 'Drag to resize the sidebar, double-click to reset',
  resizeInspector: 'Drag to resize the inspector, double-click to reset',
  resizeSplit: 'Drag to resize panes, double-click to split evenly',
  resizeComposer: 'Drag to resize the input, double-click to reset',
  accountMenu: 'Account & workspace',
  projects: 'Projects',
  modelMenuTitle: 'Model',
  effortTitle: 'Thinking effort',
  changesTab: 'Changes',
  viewDiff: 'Diff',
  viewFiles: 'Files',
  detailsAction: 'Details',
  newActivity: 'New activity',
  backToLatest: 'Latest',
  dockInspector: 'Dock inspector',
  floatInspector: 'Float inspector',
  clearSearch: 'Clear search',
  realtimeTpsLabel: 'Realtime speed',
  sessionAvgTpsLabel: 'Session avg speed',
  sessionCacheHitLabel: 'Avg cache hit rate',
  sessionCacheHitUnknown: 'Unknown',
  sessionCacheHitUnknownDetail: 'The available usage data is insufficient to calculate a rate for the whole session.',
  organizeAllTitle: 'Organize unorganized threads (built-in Hydrogen medium · max 4/min)',
  organizeProjectTitle: (name) => `Organize "${name}" titles with Hydrogen (medium)`,
  organizeSessionTitle: 'Organize this thread title with Hydrogen (medium)',
  organizingWithModel: (model) => `Organizing titles with built-in ${model}…`,
  organizeCooldownBanner: (sec) => `Title organize cooldown ${sec}s (max 4/min)`,
  organizeSkippedNote: (n) => `Skipped ${n} previously organized threads`,
  organizeWindowQuota: (left, max) => `${left}/${max} left this minute`,
  organizeModelBadge: (model) => `Built-in · ${model}`,
  copyImageAction: 'Copy image',
  copiedImageAction: 'Image copied',
  guardianReviewingTitle: 'Guardian AI reviewing…',
  guardianReviewingDesc: 'An external reviewer is assessing this action. It runs automatically if approved, or comes back to you if in doubt.',
  guardianTakeOver: 'Take over manually',
  guardianTakingOver: 'Handing over…',
  guardianTakeOverFailed: 'Could not stop the review. Try again in a moment.',
  guardianModelPill: (provider, model) => `${provider} · ${model}`,
  guardianActionTitle: (tool) => `Allow ${tool} to do this?`,
  riskScoreLabel: (score) => `Risk ${score}`,
  riskScoreTitle: 'Structured 0–100 risk score from Guardian. Higher means more caution.',
  intentAlignmentLabels: { aligned: 'Matches intent', uncertain: 'Intent unclear', misaligned: 'Off-intent' },
  intentAlignmentTitle: 'How well this action matches the current conversation goal',
  requestWhyManual: 'Why manual',
  screeningAiRequestedReview: 'External AI requested review',
  aiReviewNoteLabel: 'AI Review Note',
  aiReviewReferenceLabel: 'AI Reference (advisory only)',
  aiReviewDenyLabel: 'AI Review Deny',
  aiReviewErrorLabel: 'AI Review Error',
  commandExpand: 'Show all',
  commandCollapse: 'Collapse',
  feedbackHint: 'Tell the agent what to do instead. It continues with your guidance.',
  approvalGlobalDefaultSuffix: ' (global default)',
  approvalHybridLockedTitle: 'Connect an external reviewer first to enable AI review',
  approvalHybridNotConnected: 'Not connected',
  approvalConnectPromptText: 'Connect an external reviewer API first to enable AI review; only basic rules or manual mode are available.',
  approvalConnectPromptBtn: 'Connect External Reviewer →',
  reviewerUsageTitle: 'Reviewer API Usage',
  reviewerUsageLive: 'Live',
  reviewerUsageOff: 'Off',
  reviewerUsageSession: 'Session',
  reviewerUsageAllTime: () => 'All-time',
  reviewerUsageCombinedTitle: (n) => `Combined across ${n} API providers`,
  reviewerUsageStatsLink: 'View 24h / 7d / 30d stats →',
  trustTitle: 'Session trust',
  trustDelegated: 'Delegated to Guardian',
  trustDelegatedSince: (t) => `since ${t}`,
  trustFollowingHybrid: 'Following global · AI review active',
  trustNotDelegated: 'Not individually delegated · uses the current approval mode',
  trustRevokeDelegation: 'Revoke',
  trustPrefixesTitle: 'Remembered command prefixes',
  trustPrefixHits: (n) => `${n} ${n === 1 ? 'hit' : 'hits'}`,
  trustNoPrefixes: 'No remembered command prefixes',
  trustLoading: 'Loading session approvals…',
  trustRevokePrefix: (p) => `Revoke prefix ${p}`,
  trustUnavailable: 'Approval details are unavailable on this connection',
  welcomeQuickPlaceholder: 'Describe a task — press Enter to start a thread in the selected folder…',
  welcomeQuickChooseDir: 'Choose working folder',
  welcomeQuickBrowse: 'Browse for another folder…',
  welcomeQuickNoDir: 'Choose a working folder first',
  welcomeQuickSend: 'Start and send',
  welcomeQuickHint: 'Enter to send · Shift+Enter for newline',
  welcomeQuickStarting: 'Starting thread…',
  welcomeRecentDirs: 'Recent folders',
  reviewerArchTitle: 'Two-layer zero-quota guard (compliance rule #6)',
  reviewerArchLayer1Title: 'Layer 1 (basic rules, 0 ms, no quota)',
  reviewerArchLayer1Body: 'Without an external reviewer only basic rules apply: read-only file/code/doc/MCP queries, read-only pipelines, custom rules and remembered session prefixes.',
  reviewerArchLayer2Title: 'Layer 2 (AI review, needs a connected reviewer)',
  reviewerArchLayer2Lead: 'Connects to local',
  reviewerArchLayer2Rest: 'Ollama or your own public API key model to review grey-zone dev commands, non-read-only MCP tools, source edits in default mode and read-only PowerShell analysis (results are cached by TTL, usage and cost are tracked per API provider, and keys are encrypted by the OS).',
  reviewerModeMismatch: (c, h) => `Approval mode is "${c}". External review only runs in "${h}" mode.`,
  switchToMode: (label) => `Switch to ${label}`,
  reviewerOllamaDiscoverHint: 'Query installed models from local Ollama',
  reviewerBackToList: 'List',
  reviewerModelDefaultLevel: (lv) => `Model default: ${lv}`,
  pluginSectionNames: { plugins: 'Plugins', mcp: 'MCP servers', skills: 'Skills' },
  pluginSectionError: (section, msg) => `Couldn't refresh ${section}: ${msg}`,
  pluginInstallHint: 'Accepts a plugin name, name@marketplace, or the absolute path of a local plugin folder (for example D:\\dev\\my-plugin or /opt/plugins/my-plugin).',
  attachmentTooLarge: (name) => `${name} is larger than the 20 MB limit`,
  colorTokenInvalid: (key) => `Invalid color (${key}): use #HEX or rgba(...)`,
  heatmapRowCostTitle: (date, cost) => `${date} total ${cost}`,
  v031: {
    filesTrayTitle: 'Files & Folders',
    galleryTitle: 'Images',
    expandImages: (n) => `Show ${n} more image${n === 1 ? '' : 's'}`,
    collapseImages: 'Show fewer images',
    expandFiles: (n) => `Show ${n} more file${n === 1 ? '' : 's'}`,
    collapseFiles: 'Show fewer files',
    zoomImage: 'Zoom',
    revealInFolder: 'Reveal in folder',
    revealInFinder: 'Show in Finder',
    ctxRevealFile: 'Show in File Explorer',
    ctxRevealFileFinder: 'Show in Finder',
    ctxOpenFolder: 'Open folder in File Explorer',
    ctxOpenFolderFinder: 'Open folder in Finder',
    ctxRevealExecutable: 'Reveal executable in Explorer',
    ctxRevealExecutableFinder: 'Show executable in Finder',
    imageUnavailable: 'Image unavailable',
    vectorLabel: 'Vector',
    folderLabel: 'Folder',
    filePreviewSummary: 'Preview contents',
    lightboxPrev: 'Previous image',
    lightboxNext: 'Next image',
    lightboxPosition: (i, n) => `${i} of ${n}`,
    closePreview: 'Close preview',
    linkOpenFailed: (m) => `Could not open: ${m}`,
    dismissAction: 'Dismiss',
    diagSuggestions: 'What you can do',
    diagTechnical: 'Technical details',
    diagCooldown: (s) => `Cooling down — retry available in ${s}s`,
    diagCooldownDone: 'Cooldown finished — you can retry now',
    diagActionLabels: {
      continue_turn: 'Continue',
      retry_turn: 'Retry',
      reconnect_session: 'Reconnect',
      compact_context: 'Compact context (/compact)',
      launch_official_login: 'Launch official login',
      open_accounts_settings: 'Account settings',
      open_approval_settings: 'Approval settings',
      new_session: 'New session',
      edit_last_message: 'Edit previous message',
      scroll_to_approval: 'Go to approval',
      focus_question_bar: 'Go to question',
      dismiss: 'Dismiss',
    },
    diagActionFailed: (m) => `Action failed: ${m}`,
    stoppingLabel: 'Stopping…',
    stoppedChip: 'Stopped',
    pausedChip: 'Paused',
    warningChip: 'Incomplete',
    errorChip: 'Error',
    waitingAnswerChip: 'Waiting for answer',
    retryAction: 'Retry',
    trustLoadFailed: (m) => `Could not load grants: ${m}`,
    compactErrorTitle: 'Compaction failed',
    swarmSnapshotStats: 'Current snapshot',
    archiveMatches: (shown, total) => (shown === total ? `${total}` : `${shown} / ${total}`),
    testNeedsKey: 'Enter an API key before testing',
    themeSaveFailed: (m) => `Could not save theme: ${m}`,
    bootstrapTroubleshoot: [
      'Make sure the official agy CLI is installed and `agy --version` runs in a terminal.',
      'Check that you have signed in through the official login.',
      'Restart Gravity and try again; if it still fails, check the logs for details.',
    ],
    swarmLaunchPrompt: (task) => `Launch parallel sub-agents for the task below (prefer swarm or invoke_subagent to split it into independent roles, run them in parallel, and summarize each sub-agent's result):\n\n${task}`,
    continuePrompt: 'Please continue the interrupted task and provide the complete response.',
    noApprovalPending: 'No approval is pending',
  },
  v032: {
    modeMenuTitle: 'Execution mode',
    modeMenuCycleHint: (k) => `${k} cycles default / accept-edits / plan only`,
    turboActiveTitle: (k) => `Turbo is on: full access with no approval prompts (anti-ban safeguards kept). Press ${k} to return to default.`,
    turboConfirmTitle: 'Turn on Turbo · Full access',
    turboConfirmBody: 'If the official agy session supports native full-access, the server-side full-access mode is turned on; otherwise Turbo pass-through is applied locally at the client callback layer. Commands, file writes and deletes, and MCP tool calls run without approval prompts.',
    turboConfirmSafeguards: 'The client still enforces anti-ban safeguards locally (no credential reads, no writes to the official ~/.gemini folder) and blocks system-level destructive actions.',
    turboConfirmAction: 'Turn on Turbo',
    turboConfirmCancel: 'Cancel',
    policyTitle: 'AI review pass policy',
    policyLead: 'In AI review mode, the external AI holds final authority except for account-safety / anti-ban floors: aligned actions up to high risk pass; misaligned medium+ actions always ask.',
    allowAlignedHighRiskLabel: 'Auto-approve high-risk actions that match your intent',
    allowAlignedHighRiskDesc: 'When the reviewer finds the action matches your intent, high-risk actions and below (within score cap) pass automatically and are logged.',
    alignedHighRiskMaxScoreLabel: 'High-risk pass score cap',
    alignedHighRiskMaxScoreDesc: (n) => `Aligned high-risk actions scoring ${n} or lower pass. Higher scores and critical actions still need you (60–100).`,
    fastPassLowRiskDevLabel: 'Pass read-only and test/build commands directly',
    fastPassLowRiskDevDesc: 'Read-only inspection, git read queries, test/build/typecheck chains, and workspace mkdir pass by local rule without an external review.',
    policyHybridNote: 'High-risk passes only apply in AI review mode with a connected reviewer.',
    policySaved: 'Pass policy saved.',
    floorTierALabel: 'Hits an account-safety floor — needs you',
    floorTierADesc: 'This touches an account-safety / anti-ban floor (credentials, protected .gemini paths, cloud metadata, internal Google hosts, truncated payload, or your Ask rules) and cannot be auto-approved by AI.',
    floorTierAWithAiLabel: 'Mandatory manual check — overrides AI score & intent',
    floorTierAWithAiDesc: (reason) =>
      reason
        ? `${reason}. This safety floor overrides AI risk score and intent alignment — even scores below the auto-pass cap require your approval; AI notes below are for your reference only.`
        : 'This touches an account-safety / anti-ban floor that overrides AI risk score and intent alignment — even scores below the auto-pass cap require your approval; AI notes below are for your reference only.',
    floorTierAReferenceHint: 'A safety floor applies — this AI assessment is advisory only and will not auto-approve',
    screeningFloorForcedManual: 'Safety floor required manual check (with AI notes)',
    floorTierBLabel: 'High-risk — confirm it matches your intent',
    floorTierBDesc: (a) =>
      a === 'misaligned'
        ? 'The reviewer thinks this step drifts from your current request, so it is handed to you.'
        : a === 'uncertain'
          ? 'The reviewer could not confirm this step matches your current request, so it is handed to you.'
          : a === 'aligned'
            ? 'The reviewer found it matches your intent, but its risk score is above the auto-approve cap, so it is handed to you.'
            : 'This high-risk action can pass on intent, but no reviewer confirmation was available, so it is handed to you.',
    turnSettledFailed: (n) => `Turn ended · ${n} action${n === 1 ? '' : 's'} failed`,
    turnSettledFailedWithReply: (n) => `${n} action${n === 1 ? '' : 's'} failed this turn; the assistant has explained`,
    modeMenuBusyHint: 'A turn is in progress. You can switch modes once it is idle.',
    turnSettledRejected: (n) => `${n} blocked`,
    turnSettledHint: 'The model stopped without replying after the failure. Ask it to continue, or adjust the request and retry.',
    turnSettledContinue: 'Continue',
    toolExitCode: (c) => `exit ${c}`,
    heatmapThreads: (n) => `${n} thread${n === 1 ? '' : 's'}`,
    defaultCwdPlaceholder: (mac) => (mac ? 'e.g. /Users/you/Projects/my-app' : 'e.g. C:\\path\\to\\project'),
    pluginPathPlaceholder: (base, mac) => `${base} (e.g. ${mac ? '/path/to/plugin' : 'C:\\path\\to\\plugin'})`,
  },
  v033: {
    effortBusyHint: 'A turn is in progress. You can change effort once it is idle.',
    inspectorFilesUnit: 'files',
    terminalRejected: 'Blocked',
  },
  v034: V034_EN,
  v035: V035_EN,
  copy: COPY_EN,
};

// 语言切换使用同一组字段。每种语言自行处理复数、语序和数值插入，组件只提供数据。
export const UI_DICTIONARIES: Record<ClientLocale, UiDictionary> = {
  'zh-CN': {
    ui: WORKBENCH_ZH,
    appTagline: '基于官方 ACP 协议的本地编码工作台',

    newSession: '新建会话',
    saveAction: '保存',
    cancelAction: '取消',
    closeAction: '关闭',
    deleteAction: '删除',
    copyAction: '复制',
    copiedAction: '已复制',
    renameSession: '重命名',
    pinSession: '置顶',
    unpinSession: '取消置顶',

    searchPlaceholder: '搜索会话…',
    navPlugins: 'Plugins',
    navSettings: '设置',
    navAccounts: '账号',
    sidebarToggleShow: '展开侧栏',
    sidebarToggleHide: '收起侧栏',
    inspectorToggleShow: '展开 Inspector',
    inspectorToggleHide: '收起 Inspector',
    acpConnected: 'ACP 已连接',
    acpDisconnected: 'ACP 未连接',
    organizeTitlesBtn: '整理标题',
    organizingTitles: '整理中…',
    hidePollutionSessions: '已隐藏旧审批会话，点击显示',
    showPollutionSessions: '正在显示全部会话，点击隐藏旧审批会话',
    pollutionBadge: '旧审批',
    emptySessions: '还没有会话，点击左侧「+」或按快捷键新建会话开始。',
    emptySearch: '没有匹配的会话',
    timeJustNow: '刚刚',
    timeMinutes: (n) => `${n} 分钟`,
    timeHours: (n) => `${n} 小时`,
    timeDays: (n) => `${n} 天`,

    layoutSingle: '单栏',
    layoutSplit2: '双栏',
    switchPaneSession: '选择会话',
    emptyPaneTitle: '空闲窗格',
    welcomeTitle: '今天想构建什么？',
    recentThreadsTitle: '最近会话',
    shortcutsTitle: '快捷键',
    pendingApprovalsBadge: (n) => `${n} 项待审批`,
    shortcutLabels: {
      newThread: '新建会话',
      sidebar: '侧栏',
      inspector: 'Inspector',
      split: '分屏',
      mode: '切换 Mode',
      settings: '设置',
    },


    inspectorTabs: {
      diff: 'Diff',
      files: 'Files',
      plan: 'Plan',
      terminal: 'Terminal',
      context: 'Context',
      tree: '分支树',
      swarm: 'Swarm',
    },
    diffEmpty: '本会话还没有文件改动',
    filesChangedEmpty: '本会话还没有已完成的文件改动',
    planEmpty: '本会话还没有 Plan / Todo',
    terminalEmpty: '本会话还没有 Bash 输出',
    planProgress: (done, total) => `已完成 ${done} / ${total}`,

    sessionStatus: {
      idle: '空闲',
      streaming: '运行中',
      waiting_approval: '待审批',
      waiting_question: '待回答',
      error: '异常',
      closed: '未打开',
    },
    executionModes: {
      default: { label: 'default', desc: '标准模式，敏感操作需要确认' },
      'accept-edits': { label: 'accept-edits', desc: '自动接受工作区内的 Edit / Write' },
      plan: { label: 'plan', desc: '先只读分析并制定计划，再修改' },
      'full-access': { label: 'Turbo', desc: '完全访问权限，无操作审批限制（保留防封号底线）' },
      auto: { label: 'auto', desc: '在 Approve for me 规则保护下自主执行' },
    },
    effortLevels: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },

    thinkingStreamingTitle: 'Thinking…',
    thinkingCompletedTitle: 'Thinking',
    thoughtSourceNativeZh: '原生中文',
    thoughtSourceGlossary: '实时翻译',
    thoughtSourceExternal: '外部模型翻译',
    thoughtSourceSubagent: '子个体翻译',
    thoughtTranslatingBadge: '翻译中…',
    thoughtTrackZh: '中文',
    thoughtTrackRaw: '原文',
    toolStatusPending: '等待中',
    toolStatusRunning: '执行中',
    toolStatusCompleted: '完成',
    toolStatusFailed: '失败',
    toolStatusRejected: '已拒绝',
    openDiffInInspector: '在 Inspector 中查看',

    composerPlaceholder: '输入消息，/ 命令，@ 文件',
    composerPlaceholderBusy: '正在生成…',
    sendMessageBtn: '发送 (Enter)',
    stopGeneratingBtn: '停止',
    slashMenuHeader: '命令',
    mentionMenuHeader: '引用',
    pastedImageBadge: '图片',
    attachedFileBadge: '文件',
    removeAttachmentLabel: '移除附件',
    attachFileLabel: '添加文件',
    attachImageLabel: '添加图片',
    modeCycleHint: 'Shift+Tab 切换',
    composerHint: 'Enter 发送 · Shift+Enter 换行',
    approvalMenuTitle: '命令审批策略 (Approve for me)',
    clearSessionApprovals: '清除本会话已记住的授权',
    rulesAndAuditLink: '规则与审计…',

    approvalModes: {
      hybrid: { label: 'AI 代审', shortDesc: '本地快筛 + 灰区独立复核' },
      'rules-only': { label: '仅规则', shortDesc: '仅按本地确定性规则判定' },
      manual: { label: '人工审批', shortDesc: '全部敏感操作手动确认' },
    },
    riskLevels: {
      safe: '只读安全',
      low: '低风险',
      medium: '中风险',
      high: '高风险',
      critical: '极高风险',
    },
    screeningLocalAst: '本地快筛',
    screeningRegexRule: '命中询问规则',
    screeningAiFallback: '复核失败转人工',
    screeningManualMode: '人工审批模式',
    expTargetLabel: '范围',
    prefixUnavailableReason: '安全引擎未给出可复用的安全前缀，不能按前缀放行',
    actionErrorPrefix: '操作失败：',
    unknownError: '未知错误',
    bootstrapErrorTitle: 'Gravity 初始化失败',
    bootstrapLoading: '正在连接 Gravity…',
    retryBootstrapBtn: '重试',
    feedbackPlaceholder: '告诉 Gravity 应该怎么做（例如：只读查看，不要删除）',
    confirmRejectBtn: '拒绝并发送',
    approvalTabAudit: '审计日志',
    approvalTabRules: '规则',
    approvalTabReviewer: '外部复核',
    auditEmpty: '暂无审批记录',
    verdictLabels: {
      auto_approved: '自动放行',
      auto_approved_turbo: 'Turbo 直通',
      user_approved: '人工批准',
      ai_approved: 'Approve for me 放行',
      denied: '已阻断',
      rejected_with_feedback: '拒绝并反馈',
    },
    decisionSourceLabels: {
      'cache-hit': '缓存',
      'session-prefix': '会话前缀',
      'local-rule': '本地规则',
      'external-ai': '外部复核',
      'user-inline': '人工选择',
      'turbo-mode': 'Turbo 模式',
    },
    allowRulesTitle: 'Allow · 自动放行',
    askRulesTitle: 'Ask · 总是询问',
    denyRulesTitle: 'Deny · 直接阻断',
    rulesEmpty: '暂无规则',
    addPatternPlaceholder: '正则，例如 ^git\\s+(status|diff)',
    addRuleBtn: '添加',
    deleteRuleBtn: '移除',
    safeDownloadToggle: '自动放行安全的小文件下载',
    safeDownloadDesc: '仅限受信任来源的只读下载，体积受上限约束',
    approvalModeLabel: '审批模式',
    reviewerEnableToggle: '启用外部模型复核',
    reviewerProviderLabel: '服务商',
    reviewerProviderGemini: 'Google AI Studio API Key',
    reviewerProviderOpenAi: 'OpenAI 兼容接口',
    reviewerProviderOllama: '本地 Ollama (127.0.0.1)',
    reviewerEndpointLabel: 'Endpoint',
    reviewerModelLabel: 'Model',
    reviewerApiKeyLabel: 'API Key',
    reviewerDiscoverBtn: '查询可用模型',
    reviewerDiscovering: '正在查询服务端允许的模型…',
    reviewerDiscoveredCount: (n) => `已查询到 ${n} 个可用模型`,
    reviewerDiscoverPromptHint: '填写 API Key 后将自动查询服务端允许使用的模型及思考强度',
    reviewerCustomModelOption: '手动输入自定义模型 ID…',
    reviewerThinkingLabel: '思考强度',
    reviewerThinkingUnsupported: '该模型不支持单独调节思考强度',
    reviewerThinkingLevels: {
      auto: '自动（跟随模型默认）',
      off: '关闭（不思考）',
      minimal: 'Minimal（极简）',
      low: 'Low（低 · 推荐快审）',
      medium: 'Medium（中）',
      high: 'High（高）',
    },
    reviewerMaxOutputLabel: 'Max Output Tokens',
    reviewerMaxOutputHint: '默认 4096（含思考与最终 JSON 回复总量，按实际生成计费）',
    reviewerTimeoutLabel: '超时 (ms)',
    reviewerTimeoutHint: '默认 8000 ms，思考型模型建议 8000–15000 ms',
    reviewerCacheTtlLabel: '审批结果缓存 (小时)',
    saveReviewerBtn: '保存复核配置',

    compactContextBtn: '压缩',
    compactingContext: '压缩中…',
    contextWindowTitle: 'Context 窗口',
    heatmapSectionTitle: 'Token 用量',
    heatmapRanges: {
      '24h': '24h',
      '7d': '7d',
      '30d': '30d',
    },
    heatmapLess: '少',
    heatmapMore: '多',
    costSectionTitle: 'Cost',
    costScopes: {
      session: '本会话',
      today: '今日',
      '7d': '7d',
      '30d': '30d',
    },
    costDimInput: 'Input',
    costDimCached: 'Cached',
    costDimOutput: 'Output',
    costDimThinking: 'Thinking',
    stackedBarChartTitle: '分模型费用构成',
    donutChartTitle: '模型占比',
    costEmpty: '该时间范围内还没有用量',
    editRateCardsBtn: '编辑单价',
    breakdownSystem: 'System & Rules',
    breakdownUser: 'User',
    breakdownAssistant: 'Assistant',
    breakdownThought: 'Thinking',
    breakdownTools: 'Tools & Diff',
    breakdownAttachments: 'Attachments',
    attachmentAuditTitle: '附件',
    compactionMonitorTitle: '压缩监控',
    compactionCountBadge: (n) => `${n} 次`,
    compactionEmpty: '尚未触发上下文压缩',
    compactionBeforeLabel: '压缩前',
    compactionManualLabel: '手动',
    compactionAutoLabel: '自动',
    usageSources: {
      'acp-reported': 'ACP 上报',
      estimated: '估算',
      mixed: '上报 + 估算',
    },
    contextEmpty: '选择一个会话以查看 Context',

    settingsTitle: '设置',
    settingsNav: {
      general: '通用',
      themes: '外观',
      tokens: '自定义配色',
      icons: '应用图标',
      projects: '项目与目录',
      accounts: '账号',
      approvals: 'Approve for me',
      plugins: 'Plugins',
      rates: 'Cost 单价',
      about: '关于',
    },
    settingsNavGroups: { app: '应用', workspace: '工作区', info: '信息' },
    languageLabel: '界面语言',
    localeZhLabel: '中文',
    localeEnLabel: 'English',
    translationEngineLabel: '思考翻译方式',
    localTranslatorLabel: '本地离线翻译',
    translationEngineLocal: '内置离线模型 (Bergamot 44MB，默认)',
    translationEngineExternal: '外部 API 模型',
    translationExternalCardTitle: '外部翻译 API 配置（与 AI 代审相互独立）',
    translationExternalBanner:
      '独立于 AI 代审配置与密钥：仅使用你单独配置的公开 API Key 或本机 127.0.0.1 Ollama；API Key 经系统级加密独立存储（translator-secret.enc），超时或异常时自动静默回退内置本地翻译。',
    translationExternalEnableToggle: '启用外部翻译 API',
    translationExternalDiscoverBtn: '拉取可用模型',
    translationExternalTestBtn: '测试连接',
    translationExternalTesting: '测试中…',
    translationExternalSaveBtn: '保存配置',
    translationExternalViewStatsBtn: '查看翻译 API 统计',
    translationExternalConnectPrompt:
      '请填写服务商、模型与密钥（或本机 Ollama 地址）。所选模型成功返回测试译文后，保存即可切换。',
    translationMaxOutputHint: '默认 2048（按实际生成 Token 计费）',
    translationTimeoutHint: '默认 8000 ms，超时当次自动回退内置本地翻译',
    translationSavedKeyHint: '密钥已保存（留空保持不变）',
    ctxViewContext: 'Context 窗口',
    ctxViewReviewer: '外部复核统计',
    ctxViewTranslator: '翻译 API 统计',
    treeCostTooltip: (branchCount, total, model, reviewer, translator) =>
      `当前对话树总计（${branchCount} 个分支）：${total} · 主模型 ${model} · 外部代审 ${reviewer} · 外部翻译 ${translator}`,
    defaultThoughtTrackLabel: 'Thinking 默认显示',
    processPerSessionLabel: '会话进程隔离',
    processPerSessionDesc: '启动 agy acp 时附加 --process-per-session，修改后需重启',
    themeSystemOption: '跟随系统',
    themeSystemDesc: '在 Claude Code Dark 与 Light 之间自动切换',
    themeDarkGroup: '深色',
    themeLightGroup: '浅色',
    customThemeNameLabel: '主题名称',
    customThemePolarityLabel: '明暗',
    importThemeJsonBtn: '导入 JSON',
    exportThemeJsonBtn: '导出 JSON',
    applyCustomThemeBtn: '应用配色',
    startFromPresetLabel: '从预设开始',
    tokenGroups: {
      surfaces: '背景与边框',
      text: '文字',
      accent: '主色',
      status: '状态',
      diff: 'Diff',
      syntax: '代码高亮',
    },
    tokenLabels: TOKEN_LABELS_ZH,
    rateCardsSaveBtn: '保存并重算',
    rateCardsResetBtn: '恢复默认',
    rateColModel: 'Model',
    savedHint: '已保存',

    pluginsTabBuiltins: 'Built-in',
    pluginsTabPlugins: 'Plugins',
    pluginsTabMcp: 'MCP Servers',
    pluginsTabSkills: 'Skills',
    pluginInstallPlaceholder: '插件名、name@marketplace 或本地目录绝对路径',
    pluginInstallBtn: '安装',
    pluginEnableBtn: '启用',
    pluginDisableBtn: '禁用',
    pluginUninstallBtn: '卸载',
    pluginsEmpty: '还没有安装插件',
    mcpNamePlaceholder: '名称',
    mcpCmdPlaceholder: '命令或 URL，例如 npx -y @modelcontextprotocol/server-filesystem',
    mcpAddBtn: '添加',
    mcpRemoveBtn: '移除',
    mcpEmpty: '还没有配置 MCP Server',
    skillsEmpty: '工作区和全局目录中没有发现 SKILL.md',
    activeLabel: '已启用',
    lastCommandLabel: '上次命令输出',

    accountsActiveLabel: '当前',
    accountsSwitchBtn: '切换',
    accountsCreatePlaceholder: '新 Profile 名称，例如 Work',
    accountsCreateBtn: '新建 Profile',
    accountsDeleteBtn: '删除',
    accountsIdentityTitle: 'ACP 连接',
    accountsProfilesTitle: 'Profiles',
    officialLogin: '官方登录',
    officialLogout: '登出',
    officialDefaultBadge: 'Default',

    newSessionModalTitle: '新建会话',
    newSessionCwdLabel: '工作目录',
    newSessionNormalizedPreview: '将使用：',
    newSessionTitleLabel: '标题',
    newSessionTitlePlaceholder: '可选，默认自动生成',
    recentWorkspacesLabel: '最近使用',
    createSessionConfirm: '创建',
    organizeModalTitle: '标题整理',
    organizeSummaryText: (updated, hidden) => `已更新 ${updated} 个标题，隐藏 ${hidden} 个旧审批会话`,
    organizeNoChanges: '所有标题已是标准格式',
    organizeBeforeCol: '原标题',
    organizeAfterCol: '新标题',
    reOrganizeBtn: '重新整理',

    swarmActivePill: (total, working) => `Swarm ${working}/${total}`,
    swarmViewAll: '全部',
    swarmViewWorkers: '成员',
    swarmViewBoard: '消息板',
    swarmViewTimeline: '时间线',
    swarmEmptyDesc: '本会话还没有 Swarm 或 Subagent 任务。',
    swarmStatTotal: '总数',
    swarmStatWorking: '运行',
    swarmStatWaiting: '待命',
    swarmStatCompleted: '完成',
    swarmWorkerStatuses: {
      working: '运行中',
      waiting: '待命',
      stopped: '已暂停',
      killed: '已结束',
      unconfirmed: '状态待确认',
      failed: '失败',
      completed: '已完成',
    },
    swarmWorkspaceModes: {
      inherit: 'inherit',
      share: 'share',
      branch: 'branch',
    },
    swarmMemberKinds: {
      coordinator: 'Coordinator',
      'swarm-worker': 'Worker',
      verifier: 'Verifier',
      narrator: 'Narrator',
      monitor: 'Monitor',
      subagent: 'Subagent',
    },
    swarmBriefLabel: '任务',
    swarmCurrentActionLabel: '当前',
    swarmBoardTitle: '消息板',
    swarmDoneBadge: '完成',
    swarmStallBadge: '停滞',
    swarmTimelineTitle: '时间线',

    updatesSectionTitle: '软件更新',
    updatesSourceLabel: '更新源',
    updatesAutoCheckLabel: '启动时自动检查更新',
    updatesAutoCheckDesc: '启动 Gravity 时静默检查 GitHub Releases 是否有新版本，按需下载安装',
    updatesCheckBtn: '检查更新',
    updatesIdleHint: '尚未检查，点击右侧按钮检查 GitHub Releases 最新版本',
    updatesChecking: '正在检查 GitHub Releases…',
    updatesUpToDate: '当前已是最新版本',
    updatesAvailableBadge: (version) => `发现新版本 v${version}`,
    updatesDownloadBtn: '下载更新',
    updatesDownloading: '正在下载更新包…',
    updatesInstallRestartBtn: '安装并重启',
    updatesOpenPackageBtn: '打开更新包',
    updatesInstalling: '正在准备更新并重启…',
    updatesViewReleaseBtn: '查看 Release 页面',
    updatesNoMatchingAsset: '当前系统暂无自动匹配的安装包，请前往 Release 页面查看。',
    updatesToastAvailable: (version) => `发现 Gravity v${version} 新版本，可在“设置 → 关于”中一键更新`,
  },

  'en-US': {
    ui: WORKBENCH_EN,
    appTagline: 'Local coding studio on the official ACP protocol',

    newSession: 'New thread',
    saveAction: 'Save',
    cancelAction: 'Cancel',
    closeAction: 'Close',
    deleteAction: 'Delete',
    copyAction: 'Copy',
    copiedAction: 'Copied',
    renameSession: 'Rename',
    pinSession: 'Pin',
    unpinSession: 'Unpin',

    searchPlaceholder: 'Search threads…',
    navPlugins: 'Plugins',
    navSettings: 'Settings',
    navAccounts: 'Account',
    sidebarToggleShow: 'Show sidebar',
    sidebarToggleHide: 'Hide sidebar',
    inspectorToggleShow: 'Show inspector',
    inspectorToggleHide: 'Hide inspector',
    acpConnected: 'ACP connected',
    acpDisconnected: 'ACP offline',
    organizeTitlesBtn: 'Organize titles',
    organizingTitles: 'Organizing…',
    hidePollutionSessions: 'Legacy approval threads hidden — click to show',
    showPollutionSessions: 'Showing all threads — click to hide legacy ones',
    pollutionBadge: 'Legacy',
    emptySessions: 'No threads yet. Click “+” on the left or use the shortcut to start one.',
    emptySearch: 'No matching threads',
    timeJustNow: 'now',
    timeMinutes: (n) => `${n}m`,
    timeHours: (n) => `${n}h`,
    timeDays: (n) => `${n}d`,

    layoutSingle: 'Single',
    layoutSplit2: 'Split',
    switchPaneSession: 'Choose thread',
    emptyPaneTitle: 'Empty pane',
    welcomeTitle: 'What should we build?',
    recentThreadsTitle: 'Recent',
    shortcutsTitle: 'Shortcuts',
    pendingApprovalsBadge: (n) => `${n} pending`,
    shortcutLabels: {
      newThread: 'New thread',
      sidebar: 'Sidebar',
      inspector: 'Inspector',
      split: 'Split view',
      mode: 'Cycle mode',
      settings: 'Settings',
    },


    inspectorTabs: {
      diff: 'Diff',
      files: 'Files',
      plan: 'Plan',
      terminal: 'Terminal',
      context: 'Context',
      tree: 'Tree',
      swarm: 'Swarm',
    },
    diffEmpty: 'No file changes in this thread yet',
    filesChangedEmpty: 'No completed file changes yet',
    planEmpty: 'No plan or todos yet',
    terminalEmpty: 'No Bash output yet',
    planProgress: (done, total) => `${done} of ${total} done`,

    sessionStatus: {
      idle: 'Idle',
      streaming: 'Running',
      waiting_approval: 'Needs approval',
      waiting_question: 'Waiting for answer',
      error: 'Error',
      closed: 'Not open',
    },
    executionModes: {
      default: { label: 'default', desc: 'Ask before sensitive actions' },
      'accept-edits': { label: 'accept-edits', desc: 'Auto-accept Edit / Write inside the workspace' },
      plan: { label: 'plan', desc: 'Read-only analysis and planning first' },
      'full-access': { label: 'Turbo', desc: 'Full access without approval prompts (anti-ban safeguards kept)' },
      auto: { label: 'auto', desc: 'Autonomous, guarded by Approve for me rules' },
    },
    effortLevels: {
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },

    thinkingStreamingTitle: 'Thinking…',
    thinkingCompletedTitle: 'Thinking',
    thoughtSourceNativeZh: 'Native ZH',
    thoughtSourceGlossary: 'Live translation',
    thoughtSourceExternal: 'External model',
    thoughtSourceSubagent: 'Subagent',
    thoughtTranslatingBadge: 'Translating…',
    thoughtTrackZh: '中文',
    thoughtTrackRaw: 'Original',
    toolStatusPending: 'Pending',
    toolStatusRunning: 'Running',
    toolStatusCompleted: 'Done',
    toolStatusFailed: 'Failed',
    toolStatusRejected: 'Rejected',
    openDiffInInspector: 'Open in inspector',

    composerPlaceholder: 'Message Gravity — / commands, @ files',
    composerPlaceholderBusy: 'Generating…',
    sendMessageBtn: 'Send (Enter)',
    stopGeneratingBtn: 'Stop',
    slashMenuHeader: 'Commands',
    mentionMenuHeader: 'Mention',
    pastedImageBadge: 'Image',
    attachedFileBadge: 'File',
    removeAttachmentLabel: 'Remove attachment',
    attachFileLabel: 'Attach file',
    attachImageLabel: 'Attach image',
    modeCycleHint: 'Shift+Tab to cycle',
    composerHint: 'Enter to send · Shift+Enter for newline',
    approvalMenuTitle: 'Permission Guard (Approve for me)',
    clearSessionApprovals: 'Clear saved approvals for this conversation',
    rulesAndAuditLink: 'Rules & audit…',

    approvalModes: {
      hybrid: { label: 'AI review', shortDesc: 'Local screening + independent fallback review' },
      'rules-only': { label: 'Rules only', shortDesc: 'Deterministic local rules only' },
      manual: { label: 'Manual', shortDesc: 'Confirm every sensitive action' },
    },
    riskLevels: {
      safe: 'Read-only',
      low: 'Low risk',
      medium: 'Medium risk',
      high: 'High risk',
      critical: 'Critical',
    },
    screeningLocalAst: 'Local screening',
    screeningRegexRule: 'Matched ask rule',
    screeningAiFallback: 'Review fell back',
    screeningManualMode: 'Manual mode',
    expTargetLabel: 'Scope',
    prefixUnavailableReason: 'No reusable safe prefix from the security engine; prefix allow is disabled',
    actionErrorPrefix: 'Failed: ',
    unknownError: 'Unknown error',
    bootstrapErrorTitle: 'Gravity failed to start',
    bootstrapLoading: 'Connecting to Gravity…',
    retryBootstrapBtn: 'Retry',
    feedbackPlaceholder: 'Tell Gravity what to do instead (e.g. read-only, do not delete)',
    confirmRejectBtn: 'Reject & send',
    approvalTabAudit: 'Audit log',
    approvalTabRules: 'Rules',
    approvalTabReviewer: 'External review',
    auditEmpty: 'No approvals recorded yet',
    verdictLabels: {
      auto_approved: 'Auto-approved',
      auto_approved_turbo: 'Turbo pass',
      user_approved: 'Approved',
      ai_approved: 'Approve for me',
      denied: 'Blocked',
      rejected_with_feedback: 'Rejected',
    },
    decisionSourceLabels: {
      'cache-hit': 'Cache',
      'session-prefix': 'Session prefix',
      'local-rule': 'Local rule',
      'external-ai': 'External review',
      'user-inline': 'You',
      'turbo-mode': 'Turbo mode',
    },
    allowRulesTitle: 'Allow',
    askRulesTitle: 'Ask',
    denyRulesTitle: 'Deny',
    rulesEmpty: 'No rules',
    addPatternPlaceholder: 'Regex, e.g. ^git\\s+(status|diff)',
    addRuleBtn: 'Add',
    deleteRuleBtn: 'Remove',
    safeDownloadToggle: 'Auto-approve small safe downloads',
    safeDownloadDesc: 'Read-only downloads from trusted hosts, size-capped',
    approvalModeLabel: 'Approval mode',
    reviewerEnableToggle: 'Enable external review',
    reviewerProviderLabel: 'Provider',
    reviewerProviderGemini: 'Google AI Studio API Key',
    reviewerProviderOpenAi: 'OpenAI-compatible',
    reviewerProviderOllama: 'Local Ollama (127.0.0.1)',
    reviewerEndpointLabel: 'Endpoint',
    reviewerModelLabel: 'Model',
    reviewerApiKeyLabel: 'API Key',
    reviewerDiscoverBtn: 'Fetch models',
    reviewerDiscovering: 'Querying allowed models…',
    reviewerDiscoveredCount: (n) => `${n} models available`,
    reviewerDiscoverPromptHint: 'Enter your API key to query available models and thinking levels',
    reviewerCustomModelOption: 'Custom model ID…',
    reviewerThinkingLabel: 'Thinking level',
    reviewerThinkingUnsupported: 'Thinking level is not configurable for this model',
    reviewerThinkingLevels: {
      auto: 'Auto (model default)',
      off: 'Off (no thinking)',
      minimal: 'Minimal',
      low: 'Low (recommended)',
      medium: 'Medium',
      high: 'High',
    },
    reviewerMaxOutputLabel: 'Max Output Tokens',
    reviewerMaxOutputHint: 'Default 4096 (covers thinking + JSON reply; billed by actual output)',
    reviewerTimeoutLabel: 'Timeout (ms)',
    reviewerTimeoutHint: 'Default 8000 ms; 8000–15000 ms recommended for thinking models',
    reviewerCacheTtlLabel: 'Approval cache TTL (hours)',
    saveReviewerBtn: 'Save review settings',

    compactContextBtn: 'Compact',
    compactingContext: 'Compacting…',
    contextWindowTitle: 'Context window',
    heatmapSectionTitle: 'Token usage',
    heatmapRanges: {
      '24h': '24h',
      '7d': '7d',
      '30d': '30d',
    },
    heatmapLess: 'Less',
    heatmapMore: 'More',
    costSectionTitle: 'Cost',
    costScopes: {
      session: 'Thread',
      today: 'Today',
      '7d': '7d',
      '30d': '30d',
    },
    costDimInput: 'Input',
    costDimCached: 'Cached',
    costDimOutput: 'Output',
    costDimThinking: 'Thinking',
    stackedBarChartTitle: 'Cost by model',
    donutChartTitle: 'Model share',
    costEmpty: 'No usage in this range yet',
    editRateCardsBtn: 'Edit rates',
    breakdownSystem: 'System & Rules',
    breakdownUser: 'User',
    breakdownAssistant: 'Assistant',
    breakdownThought: 'Thinking',
    breakdownTools: 'Tools & Diff',
    breakdownAttachments: 'Attachments',
    attachmentAuditTitle: 'Attachments',
    compactionMonitorTitle: 'Compactions',
    compactionCountBadge: (n) => `${n}×`,
    compactionEmpty: 'No compactions recorded yet',
    compactionBeforeLabel: 'Before',
    compactionManualLabel: 'Manual',
    compactionAutoLabel: 'Auto',
    usageSources: {
      'acp-reported': 'ACP reported',
      estimated: 'Estimated',
      mixed: 'Mixed',
    },
    contextEmpty: 'Select a thread to see its context',

    settingsTitle: 'Settings',
    settingsNav: {
      general: 'General',
      themes: 'Appearance',
      tokens: 'Custom colors',
      icons: 'App icon',
      projects: 'Projects & folders',
      accounts: 'Accounts',
      approvals: 'Approve for me',
      plugins: 'Plugins',
      rates: 'Cost rates',
      about: 'About',
    },
    settingsNavGroups: { app: 'App', workspace: 'Workspace', info: 'Info' },
    languageLabel: 'Language',
    localeZhLabel: '中文',
    localeEnLabel: 'English',
    translationEngineLabel: 'Thinking translation',
    localTranslatorLabel: 'Local offline translator',
    translationEngineLocal: 'Built-in offline (Bergamot 44MB, default)',
    translationEngineExternal: 'External API model',
    translationExternalCardTitle: 'External Translation API (independent from AI review)',
    translationExternalBanner:
      'Completely independent from AI review settings & secrets: uses only your separate public API key or local 127.0.0.1 Ollama. API keys are encrypted at rest (translator-secret.enc); timeouts or errors silently fall back to built-in offline translation.',
    translationExternalEnableToggle: 'Enable external translation API',
    translationExternalDiscoverBtn: 'Fetch models',
    translationExternalTestBtn: 'Test connection',
    translationExternalTesting: 'Testing…',
    translationExternalSaveBtn: 'Save config',
    translationExternalViewStatsBtn: 'View translation API stats',
    translationExternalConnectPrompt:
      'Choose a provider and model, enter the key or local Ollama address, and run a translation test. Save after the sample succeeds to switch engines.',
    translationMaxOutputHint: 'Default 2048 (billed by actual output tokens)',
    translationTimeoutHint: 'Default 8000 ms; falls back to built-in local translator on timeout',
    translationSavedKeyHint: 'Key saved (leave blank to keep)',
    ctxViewContext: 'Context',
    ctxViewReviewer: 'Reviewer API',
    ctxViewTranslator: 'Translator API',
    treeCostTooltip: (branchCount, total, model, reviewer, translator) =>
      `Conversation tree total (${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}): ${total} · Main ${model} · Reviewer ${reviewer} · Translator ${translator}`,
    defaultThoughtTrackLabel: 'Default thinking track',
    processPerSessionLabel: 'Process per session',
    processPerSessionDesc: 'Adds --process-per-session when starting agy acp; restart required',
    themeSystemOption: 'Follow system',
    themeSystemDesc: 'Switch between Claude Code Dark and Light automatically',
    themeDarkGroup: 'Dark',
    themeLightGroup: 'Light',
    customThemeNameLabel: 'Theme name',
    customThemePolarityLabel: 'Polarity',
    importThemeJsonBtn: 'Import JSON',
    exportThemeJsonBtn: 'Export JSON',
    applyCustomThemeBtn: 'Apply colors',
    startFromPresetLabel: 'Start from preset',
    tokenGroups: {
      surfaces: 'Surfaces & borders',
      text: 'Text',
      accent: 'Accent',
      status: 'Status',
      diff: 'Diff',
      syntax: 'Syntax',
    },
    tokenLabels: TOKEN_LABELS_EN,
    rateCardsSaveBtn: 'Save & recalculate',
    rateCardsResetBtn: 'Reset defaults',
    rateColModel: 'Model',
    savedHint: 'Saved',

    pluginsTabBuiltins: 'Built-in',
    pluginsTabPlugins: 'Plugins',
    pluginsTabMcp: 'MCP Servers',
    pluginsTabSkills: 'Skills',
    pluginInstallPlaceholder: 'Plugin name, name@marketplace, or absolute local path',
    pluginInstallBtn: 'Install',
    pluginEnableBtn: 'Enable',
    pluginDisableBtn: 'Disable',
    pluginUninstallBtn: 'Uninstall',
    pluginsEmpty: 'No plugins installed',
    mcpNamePlaceholder: 'Name',
    mcpCmdPlaceholder: 'Command or URL, e.g. npx -y @modelcontextprotocol/server-filesystem',
    mcpAddBtn: 'Add',
    mcpRemoveBtn: 'Remove',
    mcpEmpty: 'No MCP servers configured',
    skillsEmpty: 'No SKILL.md found in workspace or global folders',
    activeLabel: 'Enabled',
    lastCommandLabel: 'Last command output',

    accountsActiveLabel: 'Active',
    accountsSwitchBtn: 'Switch',
    accountsCreatePlaceholder: 'New profile name, e.g. Work',
    accountsCreateBtn: 'New profile',
    accountsDeleteBtn: 'Delete',
    accountsIdentityTitle: 'ACP connection',
    accountsProfilesTitle: 'Profiles',
    officialLogin: 'Official login',
    officialLogout: 'Log out',
    officialDefaultBadge: 'Default',

    newSessionModalTitle: 'New thread',
    newSessionCwdLabel: 'Workspace folder',
    newSessionNormalizedPreview: 'Will use: ',
    newSessionTitleLabel: 'Title',
    newSessionTitlePlaceholder: 'Optional',
    recentWorkspacesLabel: 'Recent',
    createSessionConfirm: 'Create',
    organizeModalTitle: 'Organize titles',
    organizeSummaryText: (updated, hidden) => `Updated ${updated} titles, hid ${hidden} legacy threads`,
    organizeNoChanges: 'All titles are already organized',
    organizeBeforeCol: 'Before',
    organizeAfterCol: 'After',
    reOrganizeBtn: 'Run again',

    swarmActivePill: (total, working) => `Swarm ${working}/${total}`,
    swarmViewAll: 'All',
    swarmViewWorkers: 'Members',
    swarmViewBoard: 'Board',
    swarmViewTimeline: 'Timeline',
    swarmEmptyDesc: 'No swarm or subagent tasks in this thread yet.',
    swarmStatTotal: 'Total',
    swarmStatWorking: 'Working',
    swarmStatWaiting: 'Waiting',
    swarmStatCompleted: 'Done',
    swarmWorkerStatuses: {
      working: 'Working',
      waiting: 'Waiting',
      stopped: 'Stopped',
      killed: 'Killed',
      unconfirmed: 'Unconfirmed',
      failed: 'Failed',
      completed: 'Completed',
    },
    swarmWorkspaceModes: {
      inherit: 'inherit',
      share: 'share',
      branch: 'branch',
    },
    swarmMemberKinds: {
      coordinator: 'Coordinator',
      'swarm-worker': 'Worker',
      verifier: 'Verifier',
      narrator: 'Narrator',
      monitor: 'Monitor',
      subagent: 'Subagent',
    },
    swarmBriefLabel: 'Brief',
    swarmCurrentActionLabel: 'Now',
    swarmBoardTitle: 'Board',
    swarmDoneBadge: 'Done',
    swarmStallBadge: 'Stalled',
    swarmTimelineTitle: 'Timeline',

    updatesSectionTitle: 'Software updates',
    updatesSourceLabel: 'Source',
    updatesAutoCheckLabel: 'Check for updates on startup',
    updatesAutoCheckDesc: 'Silently check GitHub Releases on launch; download and install only when you choose',
    updatesCheckBtn: 'Check now',
    updatesIdleHint: 'Click Check now to look for the latest GitHub Release',
    updatesChecking: 'Checking GitHub Releases…',
    updatesUpToDate: 'You are up to date',
    updatesAvailableBadge: (version) => `Update available: v${version}`,
    updatesDownloadBtn: 'Download update',
    updatesDownloading: 'Downloading update…',
    updatesInstallRestartBtn: 'Install & restart',
    updatesOpenPackageBtn: 'Open package',
    updatesInstalling: 'Applying update and restarting…',
    updatesViewReleaseBtn: 'View on GitHub',
    updatesNoMatchingAsset: 'No matching package found for this platform; open the GitHub Release page to download.',
    updatesToastAvailable: (version) => `Gravity v${version} is available — open Settings → About to update`,
  },
};


/** 保留操作自身的具体错误信息，外层前缀按当前界面语言生成。遇到空值或未知对象时使用通用提示。 */
/** Electron IPC 把主进程异常包装成 `Error invoking remote method '<channel>': Error: ...`，界面不应露出内部通道名。 */
const IPC_REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i;

/** 取出异常的可读信息并剥离 Electron IPC 包装前缀（`Error invoking remote method '<channel>': Error:`）。 */
export function stripIpcErrorPrefix(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : err == null ? '' : String(err);
  return raw.trim().replace(IPC_REMOTE_ERROR_PREFIX, '').trim();
}

export function formatActionError(err: unknown, dict: UiDictionary): string {
  // D-LIVE-01-UI：剥离 IPC 裸错误前缀，剩余为空时回落到通用未知错误文案。
  const detail = (err instanceof Error || typeof err === 'string' ? stripIpcErrorPrefix(err) : '') || dict.unknownError;
  return `${dict.actionErrorPrefix}${detail}`;
}

/** 相对时间：用于侧栏会话列表 */
export function formatRelativeTime(iso: string, dict: UiDictionary, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  // 将设备时钟差造成的未来时间归到「刚刚」，之后按整分钟、小时和天选择当前语言的时间文案。
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return dict.timeJustNow;
  if (minutes < 60) return dict.timeMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return dict.timeHours(hours);
  return dict.timeDays(Math.floor(hours / 24));
}

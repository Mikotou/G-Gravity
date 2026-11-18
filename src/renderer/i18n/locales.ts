import type {
  AgentExecutionMode,
  AgentReasoningEffort,
  ApprovalMode,
  ClientLocale,
  CostTimeScope,
  ManagedSessionStatus,
  RightInspectorTab,
  RiskLevel,
  SwarmMemberKind,
  SwarmWorkerStatus,
  SwarmWorkspaceMode,
  ThemePaletteTokens,
  TokenHeatmapRange,
  WorkspaceSplitMode,
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
  appName: string;
  appTagline: string;

  // 通用动作
  newSession: string;
  saveAction: string;
  cancelAction: string;
  closeAction: string;
  refreshAction: string;
  deleteAction: string;
  copyAction: string;
  copiedAction: string;
  renameSession: string;
  pinSession: string;
  unpinSession: string;
  doubleClickRenameHint: string;

  // 侧栏
  searchPlaceholder: string;
  navThreads: string;
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
  historySectionTitle: string;
  readOnlyBadge: string;
  emptySessions: string;
  emptySearch: string;
  timeJustNow: string;
  timeMinutes: (n: number) => string;
  timeHours: (n: number) => string;
  timeDays: (n: number) => string;

  // 布局 / 主区
  layoutSingle: string;
  layoutSplit2: string;
  maxParallelReached: string;
  switchPaneSession: string;
  emptyPaneTitle: string;
  emptyPaneDesc: string;
  welcomeTitle: string;
  welcomeSubtitle: string;
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

  // 只读历史
  continueInGravityBtn: string;
  continuingInGravity: string;
  readOnlyBannerDesc: string;

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
  thoughtCharCountSuffix: string;
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
  triggerDemoApprovalBtn: string;
  slashMenuHeader: string;
  mentionMenuHeader: string;
  pastedImageBadge: string;
  attachedFileBadge: string;
  removeAttachmentLabel: string;
  attachFileLabel: string;
  attachImageLabel: string;
  permissionPillPrefix: string;
  modeCycleHint: string;
  composerHint: string;
  approvalMenuTitle: string;
  rulesAndAuditLink: string;

  // 审批
  approvalModes: Record<ApprovalMode, { label: string; shortDesc: string }>;
  riskLevels: Record<RiskLevel, string>;
  requestViewTitle: string;
  requestQuestion: string;
  screeningLocalAst: string;
  screeningRegexRule: string;
  screeningAiFallback: string;
  screeningManualMode: string;
  expMeaningLabel: string;
  expTargetLabel: string;
  expRiskLabel: string;
  aiSuggestionPrefix: string;
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
  approvalModeDesc: string;
  reviewerComplianceBanner: string;
  reviewerEnableToggle: string;
  reviewerEnableDesc: string;
  reviewerProviderLabel: string;
  reviewerProviderGemini: string;
  reviewerProviderOpenAi: string;
  reviewerProviderOllama: string;
  reviewerEndpointLabel: string;
  reviewerModelLabel: string;
  reviewerApiKeyLabel: string;
  reviewerTimeoutLabel: string;
  saveReviewerBtn: string;

  // Context / Cost
  compactContextBtn: string;
  compactingContext: string;
  contextWindowTitle: string;
  heatmapSectionTitle: string;
  heatmapRanges: Record<TokenHeatmapRange, string>;
  heatmapLess: string;
  heatmapMore: string;
  heatmapHoverHint: string;
  costSectionTitle: string;
  costScopes: Record<CostTimeScope, string>;
  totalCostLabel: string;
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
  settingsSectionDescs: Record<SettingsSection, string>;
  languageLabel: string;
  languageDesc: string;
  localeZhLabel: string;
  localeEnLabel: string;
  defaultThoughtTrackLabel: string;
  translationEngineLabel: string;
  localTranslatorLabel: string;
  defaultThoughtTrackDesc: string;
  processPerSessionLabel: string;
  processPerSessionDesc: string;
  themeSystemOption: string;
  themeSystemDesc: string;
  themeDarkGroup: string;
  themeLightGroup: string;
  themeCustomActive: string;
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
  appIconSectionDesc: string;
  rateCardsDesc: string;
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
  disabledLabel: string;
  lastCommandLabel: string;
  pluginsCliHint: string;

  // Accounts
  accountsComplianceNote: string;
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
  organizeExternalToggle: string;
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
  swarmResultSummaryLabel: string;
  swarmBoardTitle: string;
  swarmDoneBadge: string;
  swarmStallBadge: string;
  swarmTimelineTitle: string;

  // About
  aboutComplianceNote: string;
  aboutVersionLabel: string;
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

// 语言切换使用同一组字段。每种语言自行处理复数、语序和数值插入，组件只提供数据。
export const UI_DICTIONARIES: Record<ClientLocale, UiDictionary> = {
  'zh-CN': {
    appName: 'Gravity',
    appTagline: '基于官方 ACP 协议的本地编码工作台',

    newSession: '新建会话',
    saveAction: '保存',
    cancelAction: '取消',
    closeAction: '关闭',
    refreshAction: '刷新',
    deleteAction: '删除',
    copyAction: '复制',
    copiedAction: '已复制',
    renameSession: '重命名',
    pinSession: '置顶',
    unpinSession: '取消置顶',
    doubleClickRenameHint: '双击重命名',

    searchPlaceholder: '搜索会话…',
    navThreads: '会话',
    navPlugins: 'Plugins',
    navSettings: '设置',
    navAccounts: '账号',
    sidebarToggleShow: '展开侧栏 (Ctrl+B)',
    sidebarToggleHide: '收起侧栏 (Ctrl+B)',
    inspectorToggleShow: '展开 Inspector (Ctrl+J)',
    inspectorToggleHide: '收起 Inspector (Ctrl+J)',
    acpConnected: 'ACP 已连接',
    acpDisconnected: 'ACP 未连接',
    organizeTitlesBtn: '整理标题',
    organizingTitles: '整理中…',
    hidePollutionSessions: '已隐藏旧审批会话，点击显示',
    showPollutionSessions: '正在显示全部会话，点击隐藏旧审批会话',
    pollutionBadge: '旧审批',
    historySectionTitle: 'Antigravity 历史',
    readOnlyBadge: 'Read-only',
    emptySessions: '还没有会话，点击上方「新建会话」开始。',
    emptySearch: '没有匹配的会话',
    timeJustNow: '刚刚',
    timeMinutes: (n) => `${n} 分钟`,
    timeHours: (n) => `${n} 小时`,
    timeDays: (n) => `${n} 天`,

    layoutSingle: '单栏',
    layoutSplit2: '双栏',
    maxParallelReached: '最多同时打开 4 个会话，已替换当前标签',
    switchPaneSession: '选择会话',
    emptyPaneTitle: '空闲窗格',
    emptyPaneDesc: '从左侧选择会话，或在此绑定一个已打开的会话。',
    welcomeTitle: '今天想构建什么？',
    welcomeSubtitle: '新建会话选择工作目录，或从最近会话继续。所有请求通过本机官方 agy acp 处理。',
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

    continueInGravityBtn: '在 Gravity 中继续',
    continuingInGravity: '正在创建会话…',
    readOnlyBannerDesc: '本地只读导入的历史记录，不会写回 Antigravity。继续时会带上摘要新建一个 ACP 会话。',

    inspectorTabs: {
      diff: 'Diff',
      files: 'Files',
      plan: 'Plan',
      terminal: 'Terminal',
      context: 'Context',
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
      error: '异常',
      closed: '未打开',
    },
    executionModes: {
      default: { label: 'default', desc: '标准模式，敏感操作需要确认' },
      'accept-edits': { label: 'accept-edits', desc: '自动接受工作区内的 Edit / Write' },
      plan: { label: 'plan', desc: '先只读分析并制定计划，再修改' },
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
    thoughtCharCountSuffix: '字',
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
    triggerDemoApprovalBtn: '演示审批',
    slashMenuHeader: '命令',
    mentionMenuHeader: '引用',
    pastedImageBadge: '图片',
    attachedFileBadge: '文件',
    removeAttachmentLabel: '移除附件',
    attachFileLabel: '添加文件',
    attachImageLabel: '添加图片',
    permissionPillPrefix: '权限',
    modeCycleHint: 'Shift+Tab 切换',
    composerHint: 'Enter 发送 · Shift+Enter 换行',
    approvalMenuTitle: '命令审批策略 (Approve for me)',
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
    requestViewTitle: '需要你的确认',
    requestQuestion: '是否允许 Gravity 执行此操作？',
    screeningLocalAst: '本地快筛',
    screeningRegexRule: '命中询问规则',
    screeningAiFallback: '复核失败转人工',
    screeningManualMode: '人工审批模式',
    expMeaningLabel: '作用',
    expTargetLabel: '范围',
    expRiskLabel: '风险',
    aiSuggestionPrefix: '复核建议',
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
    approvalModeDesc: '也可以在输入框左下角随时切换',
    reviewerComplianceBanner:
      '外部复核只使用你单独填写的公开 API Key 或本机 127.0.0.1 模型，绝不调用 agy 订阅会话；超时或出错一律转人工确认。API Key 只保存在内存中。',
    reviewerEnableToggle: '启用外部模型复核',
    reviewerEnableDesc: '仅在 AI 代审模式下，对本地规则无法判定的命令生效',
    reviewerProviderLabel: '服务商',
    reviewerProviderGemini: 'Google AI Studio API Key',
    reviewerProviderOpenAi: 'OpenAI 兼容接口',
    reviewerProviderOllama: '本地 Ollama (127.0.0.1)',
    reviewerEndpointLabel: 'Endpoint',
    reviewerModelLabel: 'Model',
    reviewerApiKeyLabel: 'API Key',
    reviewerTimeoutLabel: '超时 (ms)',
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
    heatmapHoverHint: '悬停查看详情',
    costSectionTitle: 'Cost',
    costScopes: {
      session: '本会话',
      today: '今日',
      '7d': '7d',
      '30d': '30d',
    },
    totalCostLabel: '合计',
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
    settingsSectionDescs: {
      general: '语言、Thinking 展示与默认工作目录',
      themes: '选择预设主题，或跟随系统明暗',
      tokens: '逐项调整 23 个颜色 Token，可导入 / 导出 JSON',
      icons: '原创 Gravity 图标的多套配色',
      projects: '自定义项目文件夹、修改默认目录与配置专属 Project',
      accounts: '多个隔离 Profile，均由官方 agy 管理登录',
      approvals: '审批模式、规则与审计日志',
      plugins: '通过官方 agy plugin / agy mcp 命令管理扩展',
      rates: '用于估算 Cost 的每百万 Token 参考单价',
      about: '版本与合规说明',
    },
    languageLabel: '界面语言',
    languageDesc: '技术术语始终保留英文',
    localeZhLabel: '中文',
    localeEnLabel: 'English',
    translationEngineLabel: '思考翻译方式',
    localTranslatorLabel: '本地离线翻译',
    defaultThoughtTrackLabel: 'Thinking 默认显示',
    defaultThoughtTrackDesc: '每个 Thinking 块仍可单独切换',
    processPerSessionLabel: '会话进程隔离',
    processPerSessionDesc: '启动 agy acp 时附加 --process-per-session，修改后需重启',
    themeSystemOption: '跟随系统',
    themeSystemDesc: '在 Claude Code Dark 与 Light 之间自动切换',
    themeDarkGroup: '深色',
    themeLightGroup: '浅色',
    themeCustomActive: '当前使用自定义配色',
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
    appIconSectionDesc: '切换后窗口图标与侧栏标志立即更新',
    rateCardsDesc: '单位 USD / 1M Tokens。参考 API 价格估算，非实际账单。',
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
    disabledLabel: '已禁用',
    lastCommandLabel: '上次命令输出',
    pluginsCliHint: '所有操作都通过官方 agy CLI 子命令执行，Gravity 不直接改写 agy 配置文件。',

    accountsComplianceNote:
      '每个 Profile 通过官方 --app-data-dir 隔离，登录态由 agy 自己保存；Gravity 不读取任何凭据文件，只能由你手动切换，不会自动轮换账号。',
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
    organizeExternalToggle: '外部模型润色',
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
    swarmResultSummaryLabel: '结果',
    swarmBoardTitle: '消息板',
    swarmDoneBadge: '完成',
    swarmStallBadge: '停滞',
    swarmTimelineTitle: '时间线',

    aboutComplianceNote:
      'Gravity 只通过本机未修改的官方 agy acp（stdio JSON-RPC）工作：不读取私有凭据，不请求非公开接口，不自动轮换账号。',
    aboutVersionLabel: '版本',
  },

  'en-US': {
    appName: 'Gravity',
    appTagline: 'Local coding studio on the official ACP protocol',

    newSession: 'New thread',
    saveAction: 'Save',
    cancelAction: 'Cancel',
    closeAction: 'Close',
    refreshAction: 'Refresh',
    deleteAction: 'Delete',
    copyAction: 'Copy',
    copiedAction: 'Copied',
    renameSession: 'Rename',
    pinSession: 'Pin',
    unpinSession: 'Unpin',
    doubleClickRenameHint: 'Double-click to rename',

    searchPlaceholder: 'Search threads…',
    navThreads: 'Threads',
    navPlugins: 'Plugins',
    navSettings: 'Settings',
    navAccounts: 'Account',
    sidebarToggleShow: 'Show sidebar (Ctrl+B)',
    sidebarToggleHide: 'Hide sidebar (Ctrl+B)',
    inspectorToggleShow: 'Show inspector (Ctrl+J)',
    inspectorToggleHide: 'Hide inspector (Ctrl+J)',
    acpConnected: 'ACP connected',
    acpDisconnected: 'ACP offline',
    organizeTitlesBtn: 'Organize titles',
    organizingTitles: 'Organizing…',
    hidePollutionSessions: 'Legacy approval threads hidden — click to show',
    showPollutionSessions: 'Showing all threads — click to hide legacy ones',
    pollutionBadge: 'Legacy',
    historySectionTitle: 'Antigravity history',
    readOnlyBadge: 'Read-only',
    emptySessions: 'No threads yet. Start one with “New thread”.',
    emptySearch: 'No matching threads',
    timeJustNow: 'now',
    timeMinutes: (n) => `${n}m`,
    timeHours: (n) => `${n}h`,
    timeDays: (n) => `${n}d`,

    layoutSingle: 'Single',
    layoutSplit2: 'Split',
    maxParallelReached: 'Up to 4 threads can be open; replaced the current tab.',
    switchPaneSession: 'Choose thread',
    emptyPaneTitle: 'Empty pane',
    emptyPaneDesc: 'Pick a thread from the sidebar or bind an open one here.',
    welcomeTitle: 'What should we build?',
    welcomeSubtitle: 'Start a thread in a workspace or pick up a recent one. Everything runs through your local official agy acp.',
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

    continueInGravityBtn: 'Continue in Gravity',
    continuingInGravity: 'Creating thread…',
    readOnlyBannerDesc: 'Read-only local import — nothing is written back to Antigravity. Continuing starts a new ACP thread with a summary.',

    inspectorTabs: {
      diff: 'Diff',
      files: 'Files',
      plan: 'Plan',
      terminal: 'Terminal',
      context: 'Context',
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
      error: 'Error',
      closed: 'Not open',
    },
    executionModes: {
      default: { label: 'default', desc: 'Ask before sensitive actions' },
      'accept-edits': { label: 'accept-edits', desc: 'Auto-accept Edit / Write inside the workspace' },
      plan: { label: 'plan', desc: 'Read-only analysis and planning first' },
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
    thoughtCharCountSuffix: 'chars',
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
    triggerDemoApprovalBtn: 'Demo approval',
    slashMenuHeader: 'Commands',
    mentionMenuHeader: 'Mention',
    pastedImageBadge: 'Image',
    attachedFileBadge: 'File',
    removeAttachmentLabel: 'Remove attachment',
    attachFileLabel: 'Attach file',
    attachImageLabel: 'Attach image',
    permissionPillPrefix: 'Guard',
    modeCycleHint: 'Shift+Tab to cycle',
    composerHint: 'Enter to send · Shift+Enter for newline',
    approvalMenuTitle: 'Permission Guard (Approve for me)',
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
    requestViewTitle: 'Needs your approval',
    requestQuestion: 'Allow Gravity to run this?',
    screeningLocalAst: 'Local screening',
    screeningRegexRule: 'Matched ask rule',
    screeningAiFallback: 'Review fell back',
    screeningManualMode: 'Manual mode',
    expMeaningLabel: 'Does',
    expTargetLabel: 'Scope',
    expRiskLabel: 'Risk',
    aiSuggestionPrefix: 'Review hint',
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
    approvalModeDesc: 'Also switchable from the composer at any time',
    reviewerComplianceBanner:
      'External review only uses your separate public API key or a 127.0.0.1 model — never an agy subscription session. Timeouts and errors fall back to you. The key is kept in memory only.',
    reviewerEnableToggle: 'Enable external review',
    reviewerEnableDesc: 'Only in AI review mode, for commands local rules cannot decide',
    reviewerProviderLabel: 'Provider',
    reviewerProviderGemini: 'Google AI Studio API Key',
    reviewerProviderOpenAi: 'OpenAI-compatible',
    reviewerProviderOllama: 'Local Ollama (127.0.0.1)',
    reviewerEndpointLabel: 'Endpoint',
    reviewerModelLabel: 'Model',
    reviewerApiKeyLabel: 'API Key',
    reviewerTimeoutLabel: 'Timeout (ms)',
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
    heatmapHoverHint: 'Hover for details',
    costSectionTitle: 'Cost',
    costScopes: {
      session: 'Thread',
      today: 'Today',
      '7d': '7d',
      '30d': '30d',
    },
    totalCostLabel: 'Total',
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
    settingsSectionDescs: {
      general: 'Language, thinking display and default workspace folder',
      themes: 'Pick a preset theme or follow the system',
      tokens: 'Tune all 23 color tokens; import or export JSON',
      icons: 'Color variants of the original Gravity icon',
      projects: 'Manage custom project folders, default directory and Project presets',
      accounts: 'Isolated profiles, each logged in by official agy',
      approvals: 'Approval mode, rules and audit log',
      plugins: 'Manage extensions via official agy plugin / agy mcp',
      rates: 'Reference per-million-token rates used to estimate cost',
      about: 'Version and compliance',
    },
    languageLabel: 'Language',
    languageDesc: 'Technical terms always stay in English',
    localeZhLabel: '中文',
    localeEnLabel: 'English',
    translationEngineLabel: 'Thinking translation',
    localTranslatorLabel: 'Local offline translator',
    defaultThoughtTrackLabel: 'Default thinking track',
    defaultThoughtTrackDesc: 'Each thinking block can still be toggled',
    processPerSessionLabel: 'Process per session',
    processPerSessionDesc: 'Adds --process-per-session when starting agy acp; restart required',
    themeSystemOption: 'Follow system',
    themeSystemDesc: 'Switch between Claude Code Dark and Light automatically',
    themeDarkGroup: 'Dark',
    themeLightGroup: 'Light',
    themeCustomActive: 'Custom colors are active',
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
    appIconSectionDesc: 'The window icon and sidebar logo update immediately',
    rateCardsDesc: 'USD per 1M tokens. Estimated at reference API rates, not an actual bill.',
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
    disabledLabel: 'Disabled',
    lastCommandLabel: 'Last command output',
    pluginsCliHint: 'Every action runs an official agy CLI subcommand; Gravity never edits agy config files directly.',

    accountsComplianceNote:
      'Each profile is isolated with the official --app-data-dir and agy stores its own login. Gravity never reads credential files, and switching is manual only — no automatic rotation.',
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
    organizeExternalToggle: 'External API polish',
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
    swarmResultSummaryLabel: 'Result',
    swarmBoardTitle: 'Board',
    swarmDoneBadge: 'Done',
    swarmStallBadge: 'Stalled',
    swarmTimelineTitle: 'Timeline',

    aboutComplianceNote:
      'Gravity works only through your local, unmodified official agy acp (stdio JSON-RPC): no private credential access, no non-public endpoints, no automatic account rotation.',
    aboutVersionLabel: 'Version',
  },
};

export function getLayoutLabel(mode: WorkspaceSplitMode, dict: UiDictionary): string {
  switch (mode) {
    case 'single':
      return dict.layoutSingle;
    case 'split-2':
      return dict.layoutSplit2;
  }
}

/** 保留操作自身的具体错误信息，外层前缀按当前界面语言生成。遇到空值或未知对象时使用通用提示。 */
export function formatActionError(err: unknown, dict: UiDictionary): string {
  const detail =
    err instanceof Error && err.message.trim()
      ? err.message.trim()
      : typeof err === 'string' && err.trim()
        ? err.trim()
        : dict.unknownError;
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

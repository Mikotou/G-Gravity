import type { ClientLocale } from '@shared';

/**
 * Centralized component UI copy migrated from inline locale ternaries (v0.3.4 i18n governance).
 */
export interface ComponentCopyStrings {
  accountQuota: string;
  active: string;
  activeBranchContext: string;
  activity: string;
  addProject: string;
  addProject2: string;
  aiReview: string;
  allTime: string;
  answerTheRequiredFields: string;
  approvalCancelled: string;
  approved: string;
  archiveConversation: string;
  archived: string;
  asked: string;
  basicRules: string;
  blocked: string;
  branchModel: string;
  browse: string;
  browse2: string;
  calls: string;
  cancel: string;
  cancel2: string;
  clickToSwitchToThis: string;
  clientAllTime: string;
  close: string;
  collapse: string;
  connected: string;
  connectionFailed: string;
  continue: string;
  continue2: string;
  conversationBranchTree: string;
  copyImage: string;
  copyLinkUrl: string;
  copyLocalPath: string;
  createsANewBranchFrom: string;
  currentlyActiveBranch: string;
  currentSession: string;
  customAnswer: string;
  default: string;
  defaultFolder: string;
  defaultFolder2: string;
  defaultMode: string;
  defaultMode2: string;
  deleteConversation: string;
  denied: string;
  describeAMultiAgentTask: string;
  disabled: string;
  display: string;
  done: string;
  earlierRecords: string;
  editAnnotation: string;
  editLastMessageInEmpty: string;
  editMessage: string;
  editNotation: string;
  editOption: string;
  editOriginalMessage: string;
  editProject: string;
  enterAValidEndpointAnd: string;
  enterTheEditedOption: string;
  enterYourAnswer: string;
  enUs: string;
  error: string;
  error2: string;
  error3: string;
  estimated: string;
  executionMode: string;
  executionModeForTheNew: string;
  externalReviewEnabled: string;
  externalReviewerApi: string;
  externalReviewerIsNotConnected: string;
  externalReviewTurnedOff: string;
  externalTranslationApiIsReady: string;
  externalTranslatorConnectionFailedCheck: string;
  failed: string;
  failed2: string;
  failed3: string;
  failedToCopyImageTo: string;
  fetchInstalledModelsFromLocal: string;
  geminiWeekly: string;
  globalDefault: string;
  image: string;
  includesChatAndItsTranslation: string;
  inspectThisBranchInContext: string;
  keyEntered: string;
  label5hWindow: string;
  labelItem: string;
  labelItem2: string;
  lastReportedForThisAccount: string;
  latestRecords: string;
  launch: string;
  list: string;
  localFallback: string;
  main: string;
  mainThread: string;
  manageConversation: string;
  manageProjects: string;
  modelQuestion: string;
  newerRecords: string;
  no: string;
  noCallsInSession: string;
  noCallsInTree: string;
  noExternalReviewerApiCalls: string;
  noExternalTranslationApiCalls: string;
  noProjectsYet: string;
  notation: string;
  notConnected: string;
  notConnected2: string;
  notConnected3: string;
  noteOptional: string;
  off: string;
  offIsRecommendedForFast: string;
  openInLocalBrowser: string;
  openWithDefaultApp: string;
  originalUnavailable: string;
  permanentlyDelete: string;
  permanentlyDeleteThisConversationAnd: string;
  pinned: string;
  projectDefault: string;
  projectFolderPath: string;
  projectName: string;
  projectName2: string;
  projects: string;
  providerModelBreakdown: string;
  providerShare: string;
  quote: string;
  quoteInstead: string;
  readingOfficialQuota: string;
  refresh: string;
  remainingQuota: string;
  removeNotation: string;
  removeNotation2: string;
  removeQuote: string;
  reportedByOtherSessionsWaiting: string;
  resend: string;
  resets: string;
  restoreConversation: string;
  reviewerApiCost: string;
  reviewerTokenUsage: string;
  reviewSettingsSaved: string;
  reviewTestPassed: string;
  reviewVerificationWasIncompleteTry: string;
  runASuccessfulTranslationTest: string;
  running: string;
  running2: string;
  save: string;
  save2: string;
  saveAsProject: string;
  savedCustomPalette: string;
  saveMark: string;
  savingReviewSettings: string;
  selectAConversationToView: string;
  sendAnswer: string;
  setAsDefaultFolder: string;
  setDefault: string;
  showingTheLatest50: string;
  showLatest8: string;
  skip: string;
  someCollaborationHistoryCouldNot: string;
  streamBrieflyInterruptedWaitingTo: string;
  success: string;
  switchToExternalApi: string;
  testAndEnable: string;
  testing: string;
  testPassedTurnOnTo: string;
  theAccountChangedReopenTo: string;
  theAutomaticContinuationCouldNot: string;
  theStreamWasInterruptedBefore: string;
  thirdParty: string;
  thisSessionOffersNoSwitchable: string;
  tipHoverAnyUserMessage: string;
  translationApiCost: string;
  translationApiUsage: string;
  translationTokenUsage: string;
  tree: string;
  turboFullAccessWithNo: string;
  turnDuration: string;
  turnOnToTestThe: string;
  unclassifiedUnpriced: string;
  updated: string;
  waitForTheCurrentTurn: string;
  waitingForTheModelList: string;
  weekly: string;
  yes: string;
  yourDecisionIsStillNeeded: string;
  fmtAddNotationForThis: (p0: string | number) => string;
  fmtBranch: (p0: string | number, p1: string | number) => string;
  fmtCallsProviders: (p0: string | number) => string;
  fmtCmd: (p0: string | number) => string;
  fmtConversationBranches: (p0: string | number) => string;
  fmtConversationTree: (p0: string | number) => string;
  fmtCouldNotReadOfficial: (p0: string | number) => string;
  fmtCurrentlyUsing: (p0: string | number) => string;
  fmtCurrentlyUsingTestThe: (p0: string | number) => string;
  fmtExpand: (p0: string | number) => string;
  fmtExplored: (p0: string | number) => string;
  fmtFailed: (p0: string | number) => string;
  fmtFailed2: (p0: string | number) => string;
  fmtHide: (p0: string | number) => string;
  fmtHideSimilar: (p0: string | number) => string;
  fmtNewThreadIn: (p0: string | number) => string;
  fmtPending: (p0: string | number) => string;
  fmtProjects: (p0: string | number) => string;
  fmtRemaining: (p0: string | number) => string;
  fmtSendOneSampleReview: (p0: string | number) => string;
  fmtShowOlder: (p0: string | number) => string;
  fmtSimilar: (p0: string | number) => string;
  fmtSimilar2: (p0: string | number) => string;
  fmtSkippedChangedSessions: (p0: string | number) => string;
  fmtTestingAReviewWith: (p0: string | number) => string;
  fmtTurnFork: (p0: string | number, p1: string | number, p2: string | number) => string;
  fmtTurns: (p0: string | number) => string;
}

export const COPY_ZH: ComponentCopyStrings = {
  accountQuota: "账户额度",
  active: "当前",
  activeBranchContext: "当前分支 Context",
  activity: "操作记录",
  addProject: "添加项目",
  addProject2: "添加 Project",
  aiReview: "AI 代审",
  allTime: "累计",
  answerTheRequiredFields: "请回答所有必填问题",
  approvalCancelled: "本次审批已取消",
  approved: "AI 放行",
  archiveConversation: "归档会话",
  archived: "已归档",
  asked: "转人工",
  basicRules: "基础规则",
  blocked: "已拦截",
  branchModel: "本分支主模型",
  browse: "浏览…",
  browse2: "选择目录…",
  calls: " 次",
  cancel: "取消",
  cancel2: "取消回答",
  clickToSwitchToThis: "点击切换至此分支并同步 Context 窗口",
  clientAllTime: "客户端累计（全服务商）",
  close: "关闭",
  collapse: "收起",
  connected: "已连接",
  connectionFailed: "连接失败",
  continue: "继续任务",
  continue2: "继续整理",
  conversationBranchTree: "对话分支树",
  copyImage: "复制图片",
  copyLinkUrl: "复制链接地址",
  copyLocalPath: "复制本地路径",
  createsANewBranchFrom: "从此处创建新分支。原回复与已有文件改动均会保留，可通过分支按钮或右侧「分支树」随时切换。",
  currentlyActiveBranch: "当前正在查看此分支",
  currentSession: "当前会话消耗",
  customAnswer: "自定义回答",
  default: "默认目录",
  defaultFolder: "已是默认目录",
  defaultFolder2: "默认工作目录",
  defaultMode: "项目默认 Mode",
  defaultMode2: "跟随全局 Mode",
  deleteConversation: "删除会话",
  denied: "建议拒绝",
  describeAMultiAgentTask: "输入需要多子个体并行协作的任务…",
  disabled: "未启用",
  display: "显示",
  done: "完成",
  earlierRecords: "查看更早记录",
  editAnnotation: "编辑批注 ",
  editLastMessageInEmpty: "编辑上一条消息（输入框内按 ↑）",
  editMessage: "编辑消息",
  editNotation: "编辑批注",
  editOption: "修改选项 ",
  editOriginalMessage: "编辑原消息",
  editProject: "编辑项目",
  enterAValidEndpointAnd: "请填写有效的服务地址和模型。使用云端服务时还需要 API Key。",
  enterTheEditedOption: "请填写修改后的选项",
  enterYourAnswer: "请填写回答",
  enUs: "zh-CN",
  error: "异常/超时",
  error2: "异常",
  error3: "出错",
  estimated: " · 含估算",
  executionMode: "执行模式",
  executionModeForTheNew: "新会话执行模式",
  externalReviewEnabled: "已启用外部模型复核。",
  externalReviewerApi: "外部复核 API 用量",
  externalReviewerIsNotConnected: "尚未连接外部复核模型，无法开启「AI 代审」；未连接前仅可启用「仅规则」或「人工审批」。",
  externalReviewTurnedOff: "已关闭外部模型复核。",
  externalTranslationApiIsReady: "外部翻译 API 已连接就绪，当前引擎仍为「内置离线模型」。",
  externalTranslatorConnectionFailedCheck: "外部翻译连接校验失败，请检查 API Key / Endpoint 并重新进行翻译测试",
  failed: "连接失败",
  failed2: "失败",
  failed3: "项失败",
  failedToCopyImageTo: "复制图片到剪贴板失败",
  fetchInstalledModelsFromLocal: "从本机 Ollama 拉取已安装的模型列表",
  geminiWeekly: "Gemini 周额度",
  globalDefault: "跟随全局默认",
  image: "图片",
  includesChatAndItsTranslation: "仅统计聊天及其翻译、复核调用。日期按本地时间。",
  inspectThisBranchInContext: "在 Context 窗口查看该分支详情",
  keyEntered: "已填写密钥",
  label5hWindow: "5 小时",
  labelItem: "is-active",
  labelItem2: "：",
  lastReportedForThisAccount: "本账号上次上报的清单，待当前会话确认。",
  latestRecords: "回到最新记录",
  launch: "启动蜂群",
  list: "列表",
  localFallback: "回退本地",
  main: "主对话",
  mainThread: "主对话",
  manageConversation: "管理会话",
  manageProjects: "管理 Project",
  modelQuestion: "模型提问",
  newerRecords: "查看较新记录",
  no: "否",
  noCallsInSession: "本会话暂无调用",
  noCallsInTree: "本对话树暂无调用",
  noExternalReviewerApiCalls: "暂无外部复核 API 调用记录",
  noExternalTranslationApiCalls: "暂无外部翻译 API 调用记录",
  noProjectsYet: "暂无项目",
  notation: "添加批注",
  notConnected: "未连接 · 去配置",
  notConnected2: "未连接",
  notConnected3: "未连接（仅基础规则）",
  noteOptional: "备注（可选）",
  off: "未连接",
  offIsRecommendedForFast: "翻译推荐关闭思考（off）以最快响应且节省费用",
  openInLocalBrowser: "在本地浏览器中打开",
  openWithDefaultApp: "使用默认应用打开",
  originalUnavailable: "（原文件不可用）",
  permanentlyDelete: "确认永久删除",
  permanentlyDeleteThisConversationAnd: "永久删除 Gravity 中保存的这条会话及消息？此操作无法撤销。",
  pinned: "侧栏常驻",
  projectDefault: "跟随项目默认",
  projectFolderPath: "项目文件夹绝对路径",
  projectName: "输入 Project 名称，例如：核心网关服务",
  projectName2: "项目名称",
  projects: "项目",
  providerModelBreakdown: "多 API 服务商 / 模型费用构成",
  providerShare: "服务商 / 模型占比",
  quote: "引用",
  quoteInstead: "改为仅引用",
  readingOfficialQuota: "正在读取官方额度…",
  refresh: "刷新",
  remainingQuota: "剩余额度",
  removeNotation: "移除批注",
  removeNotation2: "移除此标记",
  removeQuote: "移除引用",
  reportedByOtherSessionsWaiting: "其他会话已上报这些模型，当前会话尚未确认。",
  resend: "重新发送",
  resets: "重置于 ",
  restoreConversation: "恢复会话",
  reviewerApiCost: "复核 API 花费",
  reviewerTokenUsage: "复核 Token 分布",
  reviewSettingsSaved: "复核配置已保存。",
  reviewTestPassed: "所选模型复核测试已通过",
  reviewVerificationWasIncompleteTry: "服务未确认本次测试，请重试。",
  runASuccessfulTranslationTest: "请先使用所选模型完成翻译测试，再启用外部翻译 API",
  running: "执行中",
  running2: "运行中",
  save: "保存项目",
  save2: "保存",
  saveAsProject: "存为 Project",
  savedCustomPalette: "已保存的自定义配色",
  saveMark: "标记批注",
  savingReviewSettings: "正在保存复核设置…",
  selectAConversationToView: "选择一个对话后，可在此查看与切换对话分支树",
  sendAnswer: "发送回答",
  setAsDefaultFolder: "设为默认工作目录",
  setDefault: "设为默认目录",
  showingTheLatest50: "显示最近 50 次",
  showLatest8: "仅显示最近 8 组",
  skip: "跳过",
  someCollaborationHistoryCouldNot: "暂时无法保存或读取完整的协作记录。",
  streamBrieflyInterruptedWaitingTo: "流式连接短暂波动，正在等待恢复…",
  success: "成功",
  switchToExternalApi: "切换至外部 API",
  testAndEnable: "测试并启用",
  testing: "正在测试…",
  testPassedTurnOnTo: "测试已通过。打开开关会保存设置，并将默认审批模式设为「AI 代审」。",
  theAccountChangedReopenTo: "账户已切换，请重新查看当前账户的额度。",
  theAutomaticContinuationCouldNot: "已自动续接一次，仍未能完成。",
  theStreamWasInterruptedBefore: "流式连接意外中断，本轮输出未能完整收尾。",
  thirdParty: "第三方模型",
  thisSessionOffersNoSwitchable: "当前会话未提供可切换的模型。",
  tipHoverAnyUserMessage: "提示：悬停任意历史用户消息并点击编辑（或在空输入框按 ↑），即可从该位置分叉并保留原回复；编辑后的分支同样可以继续追问与再次分叉，左侧历史栏始终只保留主对话。",
  translationApiCost: "翻译 API 花费",
  translationApiUsage: "翻译 API 用量",
  translationTokenUsage: "翻译 Token 分布",
  tree: "整树",
  turboFullAccessWithNo: "Turbo：完全访问权限，无操作审批限制；仍保留防封号底线（不读取凭据、不写入 ~/.gemini）。",
  turnDuration: "本轮耗时",
  turnOnToTestThe: "打开开关可测试所选模型，通过后启用。",
  unclassifiedUnpriced: "其中未分类、未估价",
  updated: "更新于 ",
  waitForTheCurrentTurn: "请等待当前回合结束后切换分支",
  waitingForTheModelList: "尚未收到当前会话的模型清单。",
  weekly: "每周",
  yes: "是",
  yourDecisionIsStillNeeded: "这项操作仍需你确认，请查看审批卡。",
  fmtAddNotationForThis: (p0) => `写下对该处内容的修改意见或疑问 (${p0} 标记)…`,
  fmtBranch: (p0, p1) => `分支 ${p0}/${p1}`,
  fmtCallsProviders: (p0) => ` 次 · ${p0} 个服务商`,
  fmtCmd: (p0) => `命令 ${p0}`,
  fmtConversationBranches: (p0) => `包含 ${p0} 个对话分支`,
  fmtConversationTree: (p0) => `当前对话树消耗 (${p0} 分支)`,
  fmtCouldNotReadOfficial: (p0) => `额度读取失败：${p0}。请确认官方 agy 已登录后重试，也可在终端运行 agy 后输入 /usage 查看。`,
  fmtCurrentlyUsing: (p0) => `当前使用 ${p0}。`,
  fmtCurrentlyUsingTestThe: (p0) => `当前使用 ${p0}。保存前请测试新设置，保存未验证的配置会关闭复核。`,
  fmtExpand: (p0) => `展开全文 (${p0}字)`,
  fmtExplored: (p0) => `探索 ${p0}`,
  fmtFailed: (p0) => `${p0} 项失败`,
  fmtFailed2: (p0) => ` · ${p0} 失败`,
  fmtHide: (p0) => `收起 (${p0})`,
  fmtHideSimilar: (p0) => `收起相似 (${p0})`,
  fmtNewThreadIn: (p0) => `在「${p0}」中新建会话`,
  fmtPending: (p0) => `${p0} 项等待中`,
  fmtProjects: (p0) => `已保存的项目 · ${p0}`,
  fmtRemaining: (p0) => `还有 ${p0} 个待整理`,
  fmtSendOneSampleReview: (p0) => `将向 ${p0} 发送 1 条固定复核样例，服务商可能计费。测试通过后保存设置，并将默认审批模式设为「AI 代审」。`,
  fmtShowOlder: (p0) => `展开更早记录 (+${p0})`,
  fmtSimilar: (p0) => `已折叠 ${p0} 条相似`,
  fmtSimilar2: (p0) => `折叠了 ${p0} 条相似事件`,
  fmtSkippedChangedSessions: (p0) => `已跳过期间有改动的 ${p0} 个会话`,
  fmtTestingAReviewWith: (p0) => `正在测试 ${p0} 的复核能力…`,
  fmtTurnFork: (p0, p1, p2) => `第 ${p0} 轮分叉 · ${p1}/${p2}`,
  fmtTurns: (p0) => `${p0} 轮`,
};

export const COPY_EN: ComponentCopyStrings = {
  accountQuota: "Account quota",
  active: "Active",
  activeBranchContext: "Active branch Context",
  activity: "Activity",
  addProject: "Add project",
  addProject2: "Add Project",
  aiReview: "AI review",
  allTime: "All-time",
  answerTheRequiredFields: "Answer the required fields",
  approvalCancelled: "Approval cancelled",
  approved: "Approved",
  archiveConversation: "Archive conversation",
  archived: "Archived",
  asked: "Asked",
  basicRules: "basic rules",
  blocked: "blocked",
  branchModel: "Branch model",
  browse: "Browse…",
  browse2: "Browse…",
  calls: " calls",
  cancel: "Cancel",
  cancel2: "Cancel",
  clickToSwitchToThis: "Click to switch to this branch and sync Context",
  clientAllTime: "Client All-Time",
  close: "Close",
  collapse: "Collapse",
  connected: "Connected",
  connectionFailed: "Connection failed",
  continue: "Continue",
  continue2: "Continue",
  conversationBranchTree: "Conversation branch tree",
  copyImage: "Copy image",
  copyLinkUrl: "Copy link URL",
  copyLocalPath: "Copy local path",
  createsANewBranchFrom: "Creates a new branch from here. Original replies and file changes are preserved — switch anytime via inline controls or the Tree tab.",
  currentlyActiveBranch: "Currently active branch",
  currentSession: "Current Session",
  customAnswer: "Custom answer",
  default: "Default",
  defaultFolder: "Default folder",
  defaultFolder2: "Default folder",
  defaultMode: "Default Mode",
  defaultMode2: "Default mode",
  deleteConversation: "Delete conversation",
  denied: "Denied",
  describeAMultiAgentTask: "Describe a multi-agent task to launch swarm…",
  disabled: "Disabled",
  display: "Display",
  done: "Done",
  earlierRecords: "Earlier records",
  editAnnotation: "Edit annotation ",
  editLastMessageInEmpty: "Edit last message (↑ in empty composer)",
  editMessage: "Edit message",
  editNotation: "Edit notation",
  editOption: "Edit option ",
  editOriginalMessage: "Edit original message",
  editProject: "Edit project",
  enterAValidEndpointAnd: "Enter a valid endpoint and model. Cloud services also require an API key.",
  enterTheEditedOption: "Enter the edited option",
  enterYourAnswer: "Enter your answer",
  enUs: "en-US",
  error: "Error",
  error2: "Error",
  error3: "Error",
  estimated: " · Estimated",
  executionMode: "Execution mode",
  executionModeForTheNew: "Execution mode for the new session",
  externalReviewEnabled: "External review enabled.",
  externalReviewerApi: "External Reviewer API",
  externalReviewerIsNotConnected: "External reviewer is not connected. Connect one before enabling AI review.",
  externalReviewTurnedOff: "External review turned off.",
  externalTranslationApiIsReady: "External translation API is ready while the active engine is still Built-in offline.",
  externalTranslatorConnectionFailedCheck: "External translator connection failed. Check API key / endpoint and re-test.",
  failed: "Failed",
  failed2: "failed",
  failed3: "failed",
  failedToCopyImageTo: "Failed to copy image to clipboard",
  fetchInstalledModelsFromLocal: "Fetch installed models from local Ollama",
  geminiWeekly: "Gemini weekly",
  globalDefault: "Global default",
  image: "Image",
  includesChatAndItsTranslation: "Includes chat and its translation and review calls. Dates use local time.",
  inspectThisBranchInContext: "Inspect this branch in Context",
  keyEntered: "Key entered",
  label5hWindow: "5h window",
  labelItem: "",
  labelItem2: ": ",
  lastReportedForThisAccount: "Last reported for this account. Waiting for this session to confirm.",
  latestRecords: "Latest records",
  launch: "Launch",
  list: "List",
  localFallback: "Local fallback",
  main: "Main",
  mainThread: "Main thread",
  manageConversation: "Manage conversation",
  manageProjects: "Manage Projects",
  modelQuestion: "Model question",
  newerRecords: "Newer records",
  no: "No",
  noCallsInSession: "No calls in session",
  noCallsInTree: "No calls in tree",
  noExternalReviewerApiCalls: "No external reviewer API calls yet",
  noExternalTranslationApiCalls: "No external translation API calls yet",
  noProjectsYet: "No projects yet",
  notation: "Notation",
  notConnected: "Not connected",
  notConnected2: "Not connected",
  notConnected3: "Not connected",
  noteOptional: "Note (optional)",
  off: "Off",
  offIsRecommendedForFast: "Off is recommended for fast, low-cost translation",
  openInLocalBrowser: "Open in local browser",
  openWithDefaultApp: "Open with default app",
  originalUnavailable: " (original unavailable)",
  permanentlyDelete: "Permanently delete",
  permanentlyDeleteThisConversationAnd: "Permanently delete this conversation and its messages from Gravity? This cannot be undone.",
  pinned: "Pinned",
  projectDefault: "Project default",
  projectFolderPath: "Project folder path",
  projectName: "Project name",
  projectName2: "Project name",
  projects: "Projects",
  providerModelBreakdown: "Provider & Model Breakdown",
  providerShare: "Provider Share",
  quote: "Quote",
  quoteInstead: "Quote instead",
  readingOfficialQuota: "Reading official quota…",
  refresh: "Refresh",
  remainingQuota: "Remaining quota",
  removeNotation: "Remove notation",
  removeNotation2: "Remove notation",
  removeQuote: "Remove quote",
  reportedByOtherSessionsWaiting: "Reported by other sessions. Waiting for this session to confirm.",
  resend: "Resend",
  resets: "Resets ",
  restoreConversation: "Restore conversation",
  reviewerApiCost: "Reviewer API Cost",
  reviewerTokenUsage: "Reviewer Token Usage",
  reviewSettingsSaved: "Review settings saved.",
  reviewTestPassed: "Review test passed",
  reviewVerificationWasIncompleteTry: "Review verification was incomplete. Try again.",
  runASuccessfulTranslationTest: "Run a successful translation test with the selected model before enabling it.",
  running: "Running",
  running2: "Running",
  save: "Save",
  save2: "Save",
  saveAsProject: "Save as Project",
  savedCustomPalette: "Saved custom palette",
  saveMark: "Save mark",
  savingReviewSettings: "Saving review settings…",
  selectAConversationToView: "Select a conversation to view and switch its branch tree",
  sendAnswer: "Send answer",
  setAsDefaultFolder: "Set as default folder",
  setDefault: "Set default",
  showingTheLatest50: "Showing the latest 50",
  showLatest8: "Show latest 8",
  skip: "Skip",
  someCollaborationHistoryCouldNot: "Some collaboration history could not be saved or read.",
  streamBrieflyInterruptedWaitingTo: "Stream briefly interrupted, waiting to resume…",
  success: "Success",
  switchToExternalApi: "Switch to External API",
  testAndEnable: "Test and enable",
  testing: "Testing…",
  testPassedTurnOnTo: "Test passed. Turn on to save and make AI review the default approval mode.",
  theAccountChangedReopenTo: "The account changed. Reopen to view the current account quota.",
  theAutomaticContinuationCouldNot: "The automatic continuation could not finish.",
  theStreamWasInterruptedBefore: "The stream was interrupted before finishing.",
  thirdParty: "Third-party",
  thisSessionOffersNoSwitchable: "This session offers no switchable models.",
  tipHoverAnyUserMessage: "Tip: Hover any user message and click Edit (or press ↑ in an empty composer) to branch in place without losing the original reply. You can continue replying and branching inside any branch while the sidebar stays clean.",
  translationApiCost: "Translation API Cost",
  translationApiUsage: "Translation API Usage",
  translationTokenUsage: "Translation Token Usage",
  tree: "Tree",
  turboFullAccessWithNo: "Turbo: full access with no approval prompts. Anti-ban safeguards stay on (no credential reads, no writes to ~/.gemini).",
  turnDuration: "Turn duration",
  turnOnToTestThe: "Turn on to test the selected model and enable it after a successful review.",
  unclassifiedUnpriced: "Unclassified, unpriced",
  updated: "Updated ",
  waitForTheCurrentTurn: "Wait for the current turn to finish before switching",
  waitingForTheModelList: "Waiting for the model list from this session.",
  weekly: "Weekly",
  yes: "Yes",
  yourDecisionIsStillNeeded: "Your decision is still needed. See the approval card.",
  fmtAddNotationForThis: (p0) => `Add notation for this passage (${p0} to save)…`,
  fmtBranch: (p0, p1) => `Branch ${p0}/${p1}`,
  fmtCallsProviders: (p0) => ` calls · ${p0} providers`,
  fmtCmd: (p0) => `${p0} cmd`,
  fmtConversationBranches: (p0) => `${p0} conversation branches`,
  fmtConversationTree: (p0) => `Conversation Tree (${p0})`,
  fmtCouldNotReadOfficial: (p0) => `Could not read official quota: ${p0}. Check your agy sign-in and try again, or run agy and enter /usage in the terminal.`,
  fmtCurrentlyUsing: (p0) => `Currently using ${p0}.`,
  fmtCurrentlyUsingTestThe: (p0) => `Currently using ${p0}. Test the new settings before saving to keep review enabled.`,
  fmtExpand: (p0) => `Expand (${p0})`,
  fmtExplored: (p0) => `${p0} explored`,
  fmtFailed: (p0) => `${p0} failed`,
  fmtFailed2: (p0) => ` · ${p0} failed`,
  fmtHide: (p0) => `Hide (${p0})`,
  fmtHideSimilar: (p0) => `Hide ${p0} similar`,
  fmtNewThreadIn: (p0) => `New thread in ${p0}`,
  fmtPending: (p0) => `${p0} pending`,
  fmtProjects: (p0) => `Projects · ${p0}`,
  fmtRemaining: (p0) => `${p0} remaining`,
  fmtSendOneSampleReview: (p0) => `Send one sample review to ${p0}. Your provider may charge for it. A successful test saves the settings and makes AI review the default approval mode.`,
  fmtShowOlder: (p0) => `Show +${p0} older`,
  fmtSimilar: (p0) => `+${p0} similar`,
  fmtSimilar2: (p0) => `+${p0} similar`,
  fmtSkippedChangedSessions: (p0) => `Skipped ${p0} changed sessions`,
  fmtTestingAReviewWith: (p0) => `Testing a review with ${p0}…`,
  fmtTurnFork: (p0, p1, p2) => `Turn ${p0} fork · ${p1}/${p2}`,
  fmtTurns: (p0) => `${p0} turns`,
};

export function getComponentCopy(localeOrZh: ClientLocale | boolean): ComponentCopyStrings {
  const isZh = typeof localeOrZh === 'boolean' ? localeOrZh : localeOrZh === 'zh-CN';
  return isZh ? COPY_ZH : COPY_EN;
}

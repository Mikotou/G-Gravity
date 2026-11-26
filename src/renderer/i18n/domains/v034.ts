/**
 * v0.3.4 新增文案域：复制反馈、新建会话模型选择、图标跟随主题、外部服务密钥投影、热力图洞察等。
 * 组件只读取字段，不再内联 `locale === 'zh-CN' ? ... : ...`。
 */
export interface V034Strings {
  copyFailed: string;
  /* U-02 新建会话模型选择 */
  newSessionModelLabel: string;
  newSessionModelFollowProject: (name: string) => string;
  newSessionModelFollowOfficial: string;
  newSessionModelCatalogPending: string;
  newSessionEffortLabel: string;
  newSessionEffortFollow: string;
  welcomeModelPillTitle: string;
  /* D2 图标跟随主题 */
  iconAutoName: string;
  iconAutoDesc: (resolvedName: string) => string;
  /* D4 外部服务密钥投影 */
  apiKeySavedPlaceholder: string;
  apiKeyClear: string;
  apiKeyCleared: string;
  apiKeyReenterHint: string;
  apiKeyUndoClear: string;
  /* D1 Context 二级视图 */
  contextViewUsage: string;
  contextViewTree: string;
  contextViewSwitch: string;
  /* U-04 热力图 */
  heatmapKpiActiveHours: string;
  heatmapKpiActiveDays: string;
  heatmapKpiHourlyAvg: string;
  heatmapKpiDailyAvg: string;
  heatmapKpiPeakHour: string;
  heatmapKpiPeakDay: string;
  heatmapWeekdaysShort: readonly string[];
  heatmapMonthShort: (month: number) => string;
  heatmapDayLabel: (weekday: string, month: number, day: number) => string;
  heatmapToday: string;
  heatmapLess: string;
  heatmapMore: string;
  heatmapNoActivity: string;
  heatmapHint: string;
  heatmapCellTitle: (date: string, tokens: string, extra: string) => string;
  heatmapHourCellTitle: (date: string, hour: number, tokens: string) => string;
  heatmapThreads: (n: number) => string;
  heatmapDayTotal: string;
  /* D3 / F-10 设置页草稿保护 */
  settingsDiscardConfirm: string;
  /* F-07 启动单标签容错 */
  paneLoadFailed: string;
  paneLoadRetry: string;
  /* 待办状态 */
  todoPending: string;
  todoInProgress: string;
  todoCompleted: string;
  /* 无障碍 */
  contextRingLabel: (percent: number) => string;
  costRingLabel: string;
  /* i18n 治理：原组件内联三元迁入（RightInspector / SessionPane / WorkspacePanels） */
  scrollTabsLeft: string;
  scrollTabsRight: string;
  activeBranchMain: string;
  activeBranchTurn: (turn: number, index: number, count: number) => string;
  treeShort: string;
  expandAction: string;
  collapseAction: string;
  questionSkipped: string;
  questionCancelled: string;
  prevBranch: string;
  prevBranchTitle: string;
  nextBranch: string;
  nextBranchTitle: string;
  viewTreeTitle: string;
  branchPillTitle: string;
  historyIndexPartial: string;
  loadEarlier: string;
  viewingSaved: string;
  reconnect: string;
  reviewerAdjusted: string;
  connectReviewerFirst: string;
  connectReviewerArrow: string;
  reviewerCumulativeTitle: string;
  allTimePrefix: string;
  sessionPrefix: string;
  callsSep: string;
  apiKeyEntered: string;
  testingModel: string;
  testReviewModel: string;
  retryLoad: string;
  enterCommandQuotes: string;
}

const WEEKDAYS_ZH = ['一', '二', '三', '四', '五', '六', '日'] as const;
const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const V034_ZH: V034Strings = {
  copyFailed: '复制失败',
  newSessionModelLabel: '模型',
  newSessionModelFollowProject: (name) => `跟随项目默认（${name}）`,
  newSessionModelFollowOfficial: '跟随官方默认',
  newSessionModelCatalogPending: '模型目录尚未同步，将使用官方默认模型；连接后可在输入框右下角切换。',
  newSessionEffortLabel: '推理强度',
  newSessionEffortFollow: '跟随模型默认',
  welcomeModelPillTitle: '为新对话选择模型',
  iconAutoName: '跟随主题（自动）',
  iconAutoDesc: (n) => `当前：${n}`,
  apiKeySavedPlaceholder: '密钥已保存（安全加密，留空保持不变）',
  apiKeyClear: '清除密钥',
  apiKeyCleared: '保存后将清除已保存的密钥',
  apiKeyReenterHint: '已更换服务商或地址，请重新输入 API Key',
  apiKeyUndoClear: '撤销清除',
  contextViewUsage: '用量与费用',
  contextViewTree: '分支树',
  contextViewSwitch: 'Context 视图',
  heatmapKpiActiveHours: '活跃时段',
  heatmapKpiActiveDays: '活跃天数',
  heatmapKpiHourlyAvg: '时均',
  heatmapKpiDailyAvg: '日均',
  heatmapKpiPeakHour: '峰值时段',
  heatmapKpiPeakDay: '峰值日期',
  heatmapWeekdaysShort: WEEKDAYS_ZH,
  heatmapMonthShort: (m) => `${m}月`,
  heatmapDayLabel: (w, m, d) => `周${w} ${m}/${d}`,
  heatmapToday: '今天',
  heatmapLess: '少',
  heatmapMore: '多',
  heatmapNoActivity: '暂无活动',
  heatmapHint: '悬停或用方向键聚焦格子查看详情',
  heatmapCellTitle: (date, tokens, extra) => `${date} · ${tokens} tokens${extra ? ` · ${extra}` : ''}`,
  heatmapHourCellTitle: (date, h, tokens) => `${date} ${String(h).padStart(2, '0')}:00 · ${tokens} tokens`,
  heatmapThreads: (n) => `${n} 个会话`,
  heatmapDayTotal: '当日合计',
  settingsDiscardConfirm: '有未保存的修改，确定放弃并关闭设置吗？',
  paneLoadFailed: '会话内容加载失败',
  paneLoadRetry: '重试加载',
  todoPending: '待办',
  todoInProgress: '进行中',
  todoCompleted: '已完成',
  contextRingLabel: (p) => `上下文已用 ${p}%`,
  costRingLabel: '分模型费用构成',
  scrollTabsLeft: '向左滑动页签',
  scrollTabsRight: '向右滑动页签',
  activeBranchMain: '当前视角：主对话分支',
  activeBranchTurn: (t, i, c) => `当前视角：第 ${t} 轮分叉 (${i}/${c})`,
  treeShort: '分支树',
  expandAction: '展开',
  collapseAction: '收起',
  questionSkipped: '已跳过',
  questionCancelled: '已取消',
  prevBranch: '上一个分支',
  prevBranchTitle: '切换到上一个分支',
  nextBranch: '下一个分支',
  nextBranchTitle: '切换到下一个分支',
  viewTreeTitle: '在右侧检视器查看完整分支树',
  branchPillTitle: '查看并切换对话分支树',
  historyIndexPartial: '部分历史消息的索引无法读取，已保留本地副本。',
  loadEarlier: '加载更早的消息',
  viewingSaved: '正在查看本机保存的对话',
  reconnect: '重新连接',
  reviewerAdjusted: '已按所选模型的能力调整参数，请用当前设置测试。',
  connectReviewerFirst: '需先连接外部复核',
  connectReviewerArrow: '去连接外部复核 →',
  reviewerCumulativeTitle: '外部复核 API 累计用量（合并全部历史服务商）',
  allTimePrefix: '客户端累计：',
  sessionPrefix: '当前会话：',
  callsSep: '次 · ',
  apiKeyEntered: '已填写 API Key',
  testingModel: '正在测试所选模型…',
  testReviewModel: '测试所选模型的复核能力',
  retryLoad: '重新加载',
  enterCommandQuotes: '请输入启动命令，并检查引号是否成对。',
};

export const V034_EN: V034Strings = {
  copyFailed: 'Copy failed',
  newSessionModelLabel: 'Model',
  newSessionModelFollowProject: (name) => `Project default (${name})`,
  newSessionModelFollowOfficial: 'Official default',
  newSessionModelCatalogPending: 'The model catalog has not synced yet. The official default will be used; you can switch from the composer once connected.',
  newSessionEffortLabel: 'Reasoning effort',
  newSessionEffortFollow: 'Model default',
  welcomeModelPillTitle: 'Choose a model for the new conversation',
  iconAutoName: 'Follow theme (auto)',
  iconAutoDesc: (n) => `Now: ${n}`,
  apiKeySavedPlaceholder: 'Saved securely (leave blank to keep)',
  apiKeyClear: 'Clear key',
  apiKeyCleared: 'The saved key will be removed when you save',
  apiKeyReenterHint: 'Provider or endpoint changed. Enter the API key again.',
  apiKeyUndoClear: 'Undo',
  contextViewUsage: 'Usage & cost',
  contextViewTree: 'Branch tree',
  contextViewSwitch: 'Context view',
  heatmapKpiActiveHours: 'Active hours',
  heatmapKpiActiveDays: 'Active days',
  heatmapKpiHourlyAvg: 'Hourly avg',
  heatmapKpiDailyAvg: 'Daily avg',
  heatmapKpiPeakHour: 'Peak hour',
  heatmapKpiPeakDay: 'Peak day',
  heatmapWeekdaysShort: WEEKDAYS_EN,
  heatmapMonthShort: (m) => MONTHS_EN[(m - 1 + 12) % 12],
  heatmapDayLabel: (w, m, d) => `${w} ${m}/${d}`,
  heatmapToday: 'Today',
  heatmapLess: 'Less',
  heatmapMore: 'More',
  heatmapNoActivity: 'No activity',
  heatmapHint: 'Hover or focus a cell with the arrow keys for details',
  heatmapCellTitle: (date, tokens, extra) => `${date} · ${tokens} tokens${extra ? ` · ${extra}` : ''}`,
  heatmapHourCellTitle: (date, h, tokens) => `${date} ${String(h).padStart(2, '0')}:00 · ${tokens} tokens`,
  heatmapThreads: (n) => `${n} thread${n === 1 ? '' : 's'}`,
  heatmapDayTotal: 'Day total',
  settingsDiscardConfirm: 'You have unsaved changes. Discard them and close settings?',
  paneLoadFailed: 'Failed to load this conversation',
  paneLoadRetry: 'Retry',
  todoPending: 'Pending',
  todoInProgress: 'In progress',
  todoCompleted: 'Completed',
  contextRingLabel: (p) => `Context ${p}% used`,
  costRingLabel: 'Cost by model',
  scrollTabsLeft: 'Scroll tabs left',
  scrollTabsRight: 'Scroll tabs right',
  activeBranchMain: 'Active branch: Main',
  activeBranchTurn: (t, i, c) => `Active branch: Turn ${t} (${i}/${c})`,
  treeShort: 'Tree',
  expandAction: 'Expand',
  collapseAction: 'Collapse',
  questionSkipped: 'Skipped',
  questionCancelled: 'Cancelled',
  prevBranch: 'Previous branch',
  prevBranchTitle: 'Switch to previous branch',
  nextBranch: 'Next branch',
  nextBranchTitle: 'Switch to next branch',
  viewTreeTitle: 'View full branch tree in right panel',
  branchPillTitle: 'View and switch conversation branch tree',
  historyIndexPartial: 'Part of this history index could not be read. Its local copy was preserved.',
  loadEarlier: 'Load earlier messages',
  viewingSaved: 'Viewing the saved conversation',
  reconnect: 'Reconnect',
  reviewerAdjusted: 'The settings were adjusted to match the model’s capabilities. Test the current settings.',
  connectReviewerFirst: 'Connect reviewer',
  connectReviewerArrow: 'Connect Reviewer →',
  reviewerCumulativeTitle: 'Cumulative External Reviewer API Usage',
  allTimePrefix: 'All-time: ',
  sessionPrefix: 'This session: ',
  callsSep: 'calls · ',
  apiKeyEntered: 'API key entered',
  testingModel: 'Testing selected model…',
  testReviewModel: 'Test a review with this model',
  retryLoad: 'Retry',
  enterCommandQuotes: 'Enter a command and check the quotation marks.',
};

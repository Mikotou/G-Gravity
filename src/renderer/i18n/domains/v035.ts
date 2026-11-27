/**
 * v0.3.5 新增文案域：热力图重设计、Plan 提问卡片、Plan 检视器与只读计划文档、UI 精简与无障碍、插件前端修复。
 * 组件只读取字段，不内联 `locale === 'zh-CN' ? ... : ...`。
 */
import type { SessionTodoStatus } from '@shared';

export interface V035Strings {
  /* ---- 热力图 ---- */
  heatmapLegendCaption: string;
  heatmapLegendDetail: string;
  heatmapWeekTotal: string;
  heatmapWeekOf: (date: string) => string;
  heatmapDayCard: (day: string, tokens: string, cost: string) => string;
  heatmapHourBar: (hour: string, tokens: string, cost: string) => string;
  heatmapLevel: (level: number) => string;
  heatmapRangePanel: (title: string, range: string) => string;

  /* ---- Plan 提问卡片 ---- */
  qStep: (index: number, total: number) => string;
  qPrev: string;
  qNext: string;
  qNavLabel: string;
  qJumpTo: (index: number, state: string) => string;
  qStateUnanswered: string;
  qStateAnswered: string;
  qStateEdited: string;
  qEditOptionBtn: (label: string) => string;
  qRestoreOption: (label: string) => string;
  qEditedMark: string;
  qCustomPlaceholder: string;
  qCustomDraft: string;
  qCustomDraftRestore: string;
  qOpenAnswerPlaceholder: string;
  qSendWithCount: (answered: number, total: number) => string;
  qMissingRequired: (index: number, title: string) => string;
  qInvalidField: (index: number, title: string) => string;
  qFollowupPreviewTitle: string;
  qFollowupPreviewBody: string;
  qFollowupConfirm: string;
  qFollowupBack: string;
  qFollowupEditedFrom: (original: string) => string;
  qFollowupCustom: string;
  qFollowupState: Record<'queued' | 'sending' | 'sent' | 'failed-unsent' | 'unknown', string>;
  qFollowupRetry: string;
  qShortcutHint: (keys: string) => string;
  qMaxItemsHint: (max: number) => string;
  qMaxItemsReached: (max: number) => string;

  /* ---- Plan 检视器 ---- */
  planStatus: Record<SessionTodoStatus, string>;
  planRawStatus: (raw: string) => string;
  planTruncated: string;
  planProgressAria: (done: number, total: number) => string;
  planFailedCount: (n: number) => string;
  planArtifactTitle: string;
  planArtifactReadonly: string;
  planArtifactOpenFile: string;
  planArtifactRefresh: string;
  planArtifactLoading: string;
  planArtifactMissing: string;
  planArtifactUnavailable: (reason: string) => string;
  planArtifactTruncated: string;
  planArtifactUpdated: (when: string) => string;
  planArtifactToggle: string;
  planArtifactOpenError: string;

  /* ---- UI 精简 / 无障碍 ---- */
  closeTab: (title: string) => string;
  inspectorTabsLabel: string;
  contextAnchorUsage: string;
  contextAnchorHeatmap: string;
  contextAnchorCost: string;
  contextAnchorsLabel: string;
  sectionCollapse: (name: string) => string;
  sectionExpand: (name: string) => string;
  appearanceSubTheme: string;
  appearanceSubColors: string;
  appearanceSubIcon: string;
  appearanceSubnavLabel: string;
  prefsSaveFailed: (reason: string) => string;
  prefsSaved: string;
  auditSourceAi: string;
  auditSourceRule: string;
  auditSourceUser: string;

  /* ---- 外部服务 / 插件 / 额度 ---- */
  discoverModels: string;
  testConnection: string;
  targetOrigin: (origin: string) => string;
  targetOriginInvalid: string;
  autoDiscoverLocalOnly: string;
  pluginsProfileScope: (profile: string) => string;
  pluginsDefaultScope: string;
  pluginsManualRefresh: string;
  quotaCooldownPaused: (seconds: number, kind: string) => string;
  quotaIsolatedManual: string;

  /* ---- 审批规则 ---- */
  approvalPriorityHint: string;
  approvalPatternError: Record<'not_string' | 'empty' | 'whitespace_only' | 'too_long' | 'unsafe_syntax' | 'invalid_regex', string>;
  approvalPatternDuplicate: string;
  approvalPatternLimit: (max: number) => string;
  approvalPatternBroad: string;
  approvalPatternConflict: (other: string) => string;
  approvalPatternLegacyBlank: string;
  approvalPatternLegacyWhitespace: string;
  approvalPatternCount: (n: number, max: number) => string;

  /* ---- 其它 P2 ---- */
  thinkingToggle: string;
  treeTitle: string;
  treeBranchCount: (n: number) => string;
  treeContextLimitUnknown: string;
  composerAttachPartial: (failed: number, total: number) => string;
  composerSendAnnotations: (n: number) => string;
  composerMentionFile: string;
  composerMentionThread: string;
  composerRunningEnterHint: string;
  updateProgressLabel: string;
  updateVersionUnknown: string;
  imageBlockedTitle: string;
  imageBlockedOpen: string;
  imageRetry: string;
  codeExpand: (lines: number) => string;
  codeCollapse: string;
  codeScrollRegion: (lang: string) => string;
  tableScrollRegion: string;
  calloutTitle: Record<'note' | 'tip' | 'important' | 'warning' | 'caution', string>;
  turnUnconfirmed: string;
  turnUnconfirmedShort: string;
}

const PLAN_STATUS_ZH: Record<SessionTodoStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
  unknown: '未知状态',
};

const PLAN_STATUS_EN: Record<SessionTodoStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
  failed: 'Failed',
  unknown: 'Unknown status',
};

export const V035_ZH: V035Strings = {
  heatmapLegendCaption: '色深 = 绝对用量 × 窗口占比',
  heatmapLegendDetail: '颜色同时参考该格绝对 Token 用量与在当前窗口中的占比，费用不参与着色',
  heatmapWeekTotal: '周合计',
  heatmapWeekOf: (d) => `${d} 起一周`,
  heatmapDayCard: (day, tokens, cost) => `${day} · ${tokens} Tokens · ${cost}`,
  heatmapHourBar: (hour, tokens, cost) => `${hour} · ${tokens} Tokens · ${cost}`,
  heatmapLevel: (n) => `强度 ${n}/4`,
  heatmapRangePanel: (title, range) => `${title} · ${range}`,

  qStep: (i, n) => `${i}/${n}`,
  qPrev: '上一题',
  qNext: '下一题',
  qNavLabel: '题目导航',
  qJumpTo: (i, state) => `第 ${i} 题（${state}）`,
  qStateUnanswered: '未答',
  qStateAnswered: '已选',
  qStateEdited: '已编辑',
  qEditOptionBtn: (label) => `编辑选项「${label}」`,
  qRestoreOption: (label) => `还原选项「${label}」`,
  qEditedMark: '已编辑',
  qCustomPlaceholder: '输入你的回答…',
  qCustomDraft: '自定义草稿',
  qCustomDraftRestore: '恢复',
  qOpenAnswerPlaceholder: '输入回答…',
  qSendWithCount: (a, n) => `发送回答（已答 ${a}/${n}）`,
  qMissingRequired: (i, t) => `第 ${i} 题「${t}」尚未回答`,
  qInvalidField: (i, t) => `第 ${i} 题「${t}」的回答格式不符合要求`,
  qFollowupPreviewTitle: '将以普通消息发送，跳过当前表单',
  qFollowupPreviewBody: '你修改了选项文字或填写了表单无法表达的自定义回答。确认后，下列逐题回答将作为一条普通消息发送给模型，当前表单会被跳过。',
  qFollowupConfirm: '确认以消息发送',
  qFollowupBack: '返回修改',
  qFollowupEditedFrom: (o) => `（原选项：${o}）`,
  qFollowupCustom: '自定义',
  qFollowupState: {
    queued: '回答已排队，等待发送',
    sending: '正在以消息发送回答…',
    sent: '回答已作为普通消息发送',
    'failed-unsent': '回答未能发送，模型尚未收到',
    unknown: '回答投递状态未知，请在对话中核对模型是否已收到，确认未收到后再手动补发',
  },
  qFollowupRetry: '重新发送',
  qShortcutHint: (k) => `${k} 发送`,
  qMaxItemsHint: (m) => `最多可选 ${m} 项`,
  qMaxItemsReached: (m) => `最多只能选择 ${m} 项`,

  planStatus: PLAN_STATUS_ZH,
  planRawStatus: (r) => `原始状态：${r}`,
  planTruncated: '计划条目过多，仅显示前一部分',
  planProgressAria: (d, t) => `计划进度：已完成 ${d}/${t}`,
  planFailedCount: (n) => `${n} 项失败`,
  planArtifactTitle: 'implementation_plan.md',
  planArtifactReadonly: '只读',
  planArtifactOpenFile: '打开计划文档',
  planArtifactRefresh: '刷新计划文档',
  planArtifactLoading: '正在读取计划文档…',
  planArtifactMissing: '本会话暂无 implementation_plan.md',
  planArtifactUnavailable: (r) => `计划文档暂不可读${r ? `：${r}` : ''}`,
  planArtifactTruncated: '文档较长，仅显示前一部分',
  planArtifactUpdated: (w) => `更新于 ${w}`,
  planArtifactToggle: '计划文档',
  planArtifactOpenError: '无法打开该链接',

  closeTab: (t) => `关闭 ${t}`,
  inspectorTabsLabel: '检视器页签',
  contextAnchorUsage: '用量',
  contextAnchorHeatmap: '热力',
  contextAnchorCost: '费用',
  contextAnchorsLabel: '跳转到分区',
  sectionCollapse: (n) => `折叠${n}`,
  sectionExpand: (n) => `展开${n}`,
  appearanceSubTheme: '主题',
  appearanceSubColors: '自定义配色',
  appearanceSubIcon: '应用图标',
  appearanceSubnavLabel: '外观分类',
  prefsSaveFailed: (r) => `设置未保存：${r}`,
  prefsSaved: '设置已保存',
  auditSourceAi: 'AI',
  auditSourceRule: '规则',
  auditSourceUser: '用户',

  discoverModels: '获取模型列表',
  testConnection: '测试连接',
  targetOrigin: (o) => `将请求：${o}`,
  targetOriginInvalid: '地址无效，无法确定请求目标',
  autoDiscoverLocalOnly: '仅无需密钥的本机 Ollama（127.0.0.1）会自动发现模型；其它服务请点击按钮获取。',
  pluginsProfileScope: (p) => `当前为隔离账号「${p}」：插件 / MCP / Skills 操作仅作用于该账号的 CLI 数据目录`,
  pluginsDefaultScope: '当前为默认账号：插件 / MCP / Skills 操作作用于默认 CLI 数据目录',
  pluginsManualRefresh: '刷新',
  quotaCooldownPaused: (s, k) => `${k} 冷却中，自动额度探测已暂停（约 ${s} 秒）`,
  quotaIsolatedManual: '隔离账号不自动探测额度，可手动刷新',

  approvalPriorityHint: '优先级：拒绝 > 询问 > 允许。同一命令命中多条规则时按此顺序生效。',
  approvalPatternError: {
    not_string: '规则必须是文本',
    empty: '规则不能为空',
    whitespace_only: '规则不能只包含空白',
    too_long: '规则不能超过 200 个字符',
    unsafe_syntax: '规则包含不安全的写法（分组、花括号、反向引用、前瞻，或未以 ^ 锚定的 + / * 量词）',
    invalid_regex: '不是合法的正则表达式',
  },
  approvalPatternDuplicate: '该列表已存在相同规则',
  approvalPatternLimit: (m) => `每类最多 ${m} 条规则`,
  approvalPatternBroad: '该规则几乎匹配所有命令，请确认是否过于宽泛',
  approvalPatternConflict: (o) => `与「${o}」列表中的同名规则冲突，将按优先级处理`,
  approvalPatternLegacyBlank: '旧版空规则（已停用不会生效，建议删除）',
  approvalPatternLegacyWhitespace: '旧版纯空白规则（仍按字面空白匹配，建议删除）',
  approvalPatternCount: (n, m) => `${n}/${m}`,

  thinkingToggle: '展开或收起思考',
  treeTitle: '对话分支树',
  treeBranchCount: (n) => `${n} 个分支`,
  treeContextLimitUnknown: '上限未知',
  composerAttachPartial: (f, t) => `${t} 个附件中有 ${f} 个未能添加，其余已加入`,
  composerSendAnnotations: (n) => `发送 ${n} 条批注`,
  composerMentionFile: '文件',
  composerMentionThread: '对话',
  composerRunningEnterHint: '模型生成中，当前回合结束后可发送；按 Esc 可中断当前回合',
  updateProgressLabel: '更新下载进度',
  updateVersionUnknown: '未知版本',
  imageBlockedTitle: '远程图片已被安全策略拦截',
  imageBlockedOpen: '在浏览器中打开',
  imageRetry: '重试',
  codeExpand: (n) => `展开全部 ${n} 行`,
  codeCollapse: '收起代码',
  codeScrollRegion: (l) => `代码块${l ? ` ${l}` : ''}（可横向滚动）`,
  tableScrollRegion: '表格（可横向滚动）',
  calloutTitle: { note: '注意', tip: '提示', important: '重要', warning: '警告', caution: '小心' },
  turnUnconfirmed: '该回合未确认结束（可能已中断），记录可能不完整',
  turnUnconfirmedShort: '未确认结束',
};

export const V035_EN: V035Strings = {
  heatmapLegendCaption: 'Shade = absolute usage × share of window',
  heatmapLegendDetail: 'Color reflects both the absolute token usage of the cell and its share of the current window; cost does not affect color',
  heatmapWeekTotal: 'Week total',
  heatmapWeekOf: (d) => `Week of ${d}`,
  heatmapDayCard: (day, tokens, cost) => `${day} · ${tokens} tokens · ${cost}`,
  heatmapHourBar: (hour, tokens, cost) => `${hour} · ${tokens} tokens · ${cost}`,
  heatmapLevel: (n) => `Intensity ${n}/4`,
  heatmapRangePanel: (title, range) => `${title} · ${range}`,

  qStep: (i, n) => `${i}/${n}`,
  qPrev: 'Previous question',
  qNext: 'Next question',
  qNavLabel: 'Questions',
  qJumpTo: (i, state) => `Question ${i} (${state})`,
  qStateUnanswered: 'unanswered',
  qStateAnswered: 'answered',
  qStateEdited: 'edited',
  qEditOptionBtn: (label) => `Edit option “${label}”`,
  qRestoreOption: (label) => `Restore option “${label}”`,
  qEditedMark: 'Edited',
  qCustomPlaceholder: 'Type your answer…',
  qCustomDraft: 'Custom draft',
  qCustomDraftRestore: 'Restore',
  qOpenAnswerPlaceholder: 'Type an answer…',
  qSendWithCount: (a, n) => `Send answers (${a}/${n} answered)`,
  qMissingRequired: (i, t) => `Question ${i} “${t}” has not been answered`,
  qInvalidField: (i, t) => `The answer to question ${i} “${t}” is not in the expected format`,
  qFollowupPreviewTitle: 'Will be sent as a normal message, skipping this form',
  qFollowupPreviewBody: 'You edited option text or wrote a custom answer that this form cannot express. After you confirm, the answers below are sent to the model as one normal message and this form is skipped.',
  qFollowupConfirm: 'Send as message',
  qFollowupBack: 'Back to editing',
  qFollowupEditedFrom: (o) => `(original option: ${o})`,
  qFollowupCustom: 'Custom',
  qFollowupState: {
    queued: 'Answer queued for sending',
    sending: 'Sending the answer as a message…',
    sent: 'Answer sent as a normal message',
    'failed-unsent': 'The answer was not sent; the model has not received it',
    unknown: 'Delivery status is unknown. Check the conversation to confirm whether the model received it before sending again.',
  },
  qFollowupRetry: 'Resend',
  qShortcutHint: (k) => `${k} to send`,
  qMaxItemsHint: (m) => `Select up to ${m}`,
  qMaxItemsReached: (m) => `You can select at most ${m} options`,

  planStatus: PLAN_STATUS_EN,
  planRawStatus: (r) => `Raw status: ${r}`,
  planTruncated: 'The plan is long; only the first items are shown',
  planProgressAria: (d, t) => `Plan progress: ${d} of ${t} completed`,
  planFailedCount: (n) => `${n} failed`,
  planArtifactTitle: 'implementation_plan.md',
  planArtifactReadonly: 'Read-only',
  planArtifactOpenFile: 'Open plan document',
  planArtifactRefresh: 'Refresh plan document',
  planArtifactLoading: 'Loading the plan document…',
  planArtifactMissing: 'No implementation_plan.md for this conversation yet',
  planArtifactUnavailable: (r) => `The plan document cannot be read${r ? `: ${r}` : ''}`,
  planArtifactTruncated: 'The document is long; only the beginning is shown',
  planArtifactUpdated: (w) => `Updated ${w}`,
  planArtifactToggle: 'Plan document',
  planArtifactOpenError: 'Could not open the link',

  closeTab: (t) => `Close ${t}`,
  inspectorTabsLabel: 'Inspector tabs',
  contextAnchorUsage: 'Usage',
  contextAnchorHeatmap: 'Heatmap',
  contextAnchorCost: 'Cost',
  contextAnchorsLabel: 'Jump to section',
  sectionCollapse: (n) => `Collapse ${n}`,
  sectionExpand: (n) => `Expand ${n}`,
  appearanceSubTheme: 'Theme',
  appearanceSubColors: 'Custom colors',
  appearanceSubIcon: 'App icon',
  appearanceSubnavLabel: 'Appearance sections',
  prefsSaveFailed: (r) => `Setting not saved: ${r}`,
  prefsSaved: 'Setting saved',
  auditSourceAi: 'AI',
  auditSourceRule: 'Rule',
  auditSourceUser: 'User',

  discoverModels: 'Fetch models',
  testConnection: 'Test connection',
  targetOrigin: (o) => `Will request: ${o}`,
  targetOriginInvalid: 'Invalid address; the request target cannot be determined',
  autoDiscoverLocalOnly: 'Only keyless local Ollama (127.0.0.1) discovers models automatically; click the button for other services.',
  pluginsProfileScope: (p) => `Isolated account “${p}”: plugin / MCP / skill actions only affect this account's CLI data directory`,
  pluginsDefaultScope: 'Default account: plugin / MCP / skill actions affect the default CLI data directory',
  pluginsManualRefresh: 'Refresh',
  quotaCooldownPaused: (s, k) => `${k} cooldown: automatic quota checks paused (about ${s}s)`,
  quotaIsolatedManual: 'Quota is not checked automatically for isolated accounts; refresh manually',

  approvalPriorityHint: 'Priority: deny > ask > allow. When a command matches several rules, they apply in this order.',
  approvalPatternError: {
    not_string: 'The rule must be text',
    empty: 'The rule cannot be empty',
    whitespace_only: 'The rule cannot be only whitespace',
    too_long: 'The rule cannot exceed 200 characters',
    unsafe_syntax: 'The rule uses unsafe syntax (groups, braces, back-references, lookarounds, or + / * without a leading ^)',
    invalid_regex: 'Not a valid regular expression',
  },
  approvalPatternDuplicate: 'This rule already exists in this list',
  approvalPatternLimit: (m) => `Up to ${m} rules per list`,
  approvalPatternBroad: 'This rule matches almost every command. Make sure it is not too broad.',
  approvalPatternConflict: (o) => `Conflicts with the same rule in the “${o}” list; priority decides`,
  approvalPatternLegacyBlank: 'Legacy empty rule (disabled and never matches; consider deleting)',
  approvalPatternLegacyWhitespace: 'Legacy whitespace-only rule (still matches literal whitespace; consider deleting)',
  approvalPatternCount: (n, m) => `${n}/${m}`,

  thinkingToggle: 'Expand or collapse thinking',
  treeTitle: 'Conversation branch tree',
  treeBranchCount: (n) => `${n} ${n === 1 ? 'branch' : 'branches'}`,
  treeContextLimitUnknown: 'limit unknown',
  composerAttachPartial: (f, t) => `${f} of ${t} attachments could not be added; the rest were added`,
  composerSendAnnotations: (n) => `Send annotations (${n})`,
  composerMentionFile: 'File',
  composerMentionThread: 'Thread',
  composerRunningEnterHint: 'Generating — send once this turn finishes, or press Esc to stop the current turn',
  updateProgressLabel: 'Update download progress',
  updateVersionUnknown: 'unknown version',
  imageBlockedTitle: 'The remote image was blocked by the security policy',
  imageBlockedOpen: 'Open in browser',
  imageRetry: 'Retry',
  codeExpand: (n) => `Show all ${n} lines`,
  codeCollapse: 'Collapse code',
  codeScrollRegion: (l) => `Code block${l ? ` ${l}` : ''} (scrollable)`,
  tableScrollRegion: 'Table (scrollable)',
  calloutTitle: { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' },
  turnUnconfirmed: 'This turn was never confirmed as finished (it may have been interrupted); the record may be incomplete',
  turnUnconfirmedShort: 'Unconfirmed',
};

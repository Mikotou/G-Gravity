/**
 * v0.3.6 新增文案域：Plan 四态时间线与原文抽屉、划词标注保序配对、合规语音听写、信息精简与缺陷修复。
 * 组件只读取字段，不内联 `locale === 'zh-CN' ? ... : ...`。
 */

export interface V036Strings {
  /* ---- Plan 四态 ---- */
  planEmptyTitle: string;
  planEmptyHint: string;
  planUnavailable: (reason: string) => string;
  planCleared: string;
  planGoal: string;
  planSections: (n: number) => string;
  planViewSource: string;
  planUpdated: (when: string) => string;
  planOpenExternal: string;
  planNow: (step: string) => string;
  planDoneGroup: (n: number) => string;
  planDocLine: string;
  planDocWithSections: (n: number) => string;
  planOutlineFooterHint: string;
  planChip: (done: number, total: number) => string;
  planChipNow: (step: string) => string;
  planChipOpen: string;
  planDrawerTitle: string;
  planDrawerClose: string;
  planMermaid: (n: number) => string;
  planLoadingSource: string;
  planSectionsMore: (n: number) => string;

  /* ---- 划词标注 ---- */
  annQuote: string;
  annQuoteOnly: string;
  annAlreadyQuoted: (n: number) => string;
  annCommentPlaceholder: string;
  annCommentLabel: (n: number) => string;
  annRemove: (n: number) => string;
  annPin: (n: number) => string;
  annQuoteOnlyTag: string;
  annSupplement: string;
  annSupplementPlaceholder: string;
  annTrayLabel: (n: number) => string;
  annEditOptional: string;
  annRestoreFailed: string;

  /* ---- 语音听写 ---- */
  voiceStart: string;
  voiceStop: string;
  voiceShortcutHint: (mac: boolean) => string;
  voiceRecording: (elapsed: string) => string;
  voiceFinishing: string;
  voiceProbing: string;
  voiceBackpressure: string;
  voiceCapReached: string;
  voiceRevoked: string;
  voiceError: (reason: string) => string;
  voiceUnavailable: string;
  voiceModelMissing: string;
  voiceMore: string;
  voiceAttach: string;
  voiceSettingsTitle: string;
  voiceSettingsDesc: string;
  voiceEngine: string;
  voiceEngineOff: string;
  voiceEngineLocal: string;
  voiceEngineExternal: string;
  voiceLocale: string;
  voiceLocaleAuto: string;
  voiceDevice: string;
  voiceDeviceDefault: string;
  voicePickDevice: string;
  voiceMicTest: string;
  voiceMicTesting: string;
  voiceMicTestDone: (text: string) => string;
  voiceMicTestPass: (seconds: string) => string;
  voiceMicTestSilent: string;
  voiceEncryptionUnavailable: string;
  voiceCooldownActive: (kind: string, until: string) => string;
  voiceModelStatus: Record<'ready' | 'missing' | 'downloading' | 'verifying' | 'loading' | 'error', string>;
  voiceModelInstall: string;
  voiceModelInstallConfirm: (mb: string) => string;
  voiceModelCancel: string;
  voiceModelProgress: (pct: number) => string;
  voiceExternalTitle: string;
  voiceExternalProvider: string;
  voiceExternalEndpoint: string;
  voiceExternalModel: string;
  voiceExternalKey: string;
  voiceExternalKeySaved: string;
  voiceExternalRate: string;
  voiceDiscover: string;
  voiceTest: string;
  voiceTestOk: (ms: number) => string;
  voiceTestFail: (reason: string) => string;
  voiceSave: string;
  voiceCostTitle: string;
  voiceCostSummary: (calls: number, minutes: string, cost: string) => string;
  voiceCostUnknown: string;

  /* ---- 信息精简 / 缺陷修复 ---- */
  iconAutoToggle: string;
  iconAutoHint: string;
  settingsDirtyLeave: string;
  settingsDirtyStay: string;
  settingsDirtyDiscard: string;
  confirmDelete: string;
  confirmDeleteAsk: (name: string) => string;
  cancel: string;
  compactRunning: string;
  connectionLabel: Record<'connected' | 'connecting' | 'disconnected' | 'error', string>;
  treeCurrent: string;
  swarmFilter: string;
  dropBusy: string;
  needsApproval: (count: number) => string;
  rejectedByUserFallback: string;
  quotaUnavailable: Record<'platform' | 'profile' | 'helper' | 'preview', string>;
  taskDoneLabel: string;
  taskTodoLabel: string;
  costScopes: Record<'session' | 'today' | '7d' | '30d' | 'all', string>;
}

export const V036_ZH: V036Strings = {
  planEmptyTitle: '暂无计划',
  planEmptyHint: 'Agent 开始规划后，这里会显示目标、步骤和执行进度。',
  planUnavailable: (r) => `计划暂不可读${r ? `：${r}` : ''}`,
  planCleared: '计划已清空',
  planGoal: '目标',
  planSections: (n) => `${n} 个章节`,
  planViewSource: '查看原文',
  planUpdated: (w) => `更新于 ${w}`,
  planOpenExternal: '外部打开',
  planNow: (s) => `正在：${s}`,
  planDoneGroup: (n) => `已完成 ${n} 步`,
  planDocLine: '计划文档',
  planDocWithSections: (n) => `计划文档 · ${n} 个章节`,
  planOutlineFooterHint: '执行开始后显示实时进度',
  planChip: (d, t) => `Plan ${d}/${t}`,
  planChipNow: (s) => `正在：${s}`,
  planChipOpen: '在 Plan 页签查看',
  planDrawerTitle: '计划原文',
  planDrawerClose: '返回概要',
  planMermaid: (n) => `流程图（${n} 行）`,
  planLoadingSource: '正在读取原文…',
  planSectionsMore: (n) => `另有 ${n} 个章节`,

  annQuote: '引用',
  annQuoteOnly: '仅引用',
  annAlreadyQuoted: (n) => `已引用为 #${n}`,
  annCommentPlaceholder: '针对这段写批注（可留空）',
  annCommentLabel: (n) => `第 ${n} 条批注`,
  annRemove: (n) => `移除第 ${n} 条引用`,
  annPin: (n) => `引用 #${n}`,
  annQuoteOnlyTag: '仅引用',
  annSupplement: '补充说明',
  annSupplementPlaceholder: '补充说明（可选）',
  annTrayLabel: (n) => `已引用 ${n} 处`,
  annEditOptional: '（可留空）',
  annRestoreFailed: '发送失败，引用与批注已恢复',

  voiceStart: '语音听写',
  voiceStop: '停止听写',
  voiceShortcutHint: (mac) => (mac ? '语音听写（fn F5）' : '语音听写（F5）'),
  voiceRecording: (e) => `正在听写 ${e}`,
  voiceFinishing: '正在转写…',
  voiceProbing: '正在准备麦克风…',
  voiceBackpressure: '转写稍慢，音频已排队',
  voiceCapReached: '已达 3 分 30 秒上限，已停止听写',
  voiceRevoked: '听写已停止',
  voiceError: (r) => `听写失败${r ? `：${r}` : ''}`,
  voiceUnavailable: '当前版本未启用语音听写',
  voiceModelMissing: '本地语音模型未安装，请到「设置 → 通用」安装',
  voiceMore: '更多输入方式',
  voiceAttach: '添加附件',
  voiceSettingsTitle: '语音听写',
  voiceSettingsDesc: '默认在本机离线转写。音频不发送给 agy；只有启用外部转写后才发送到你配置的服务。',
  voiceEngine: '转写引擎',
  voiceEngineOff: '关闭',
  voiceEngineLocal: '本机离线',
  voiceEngineExternal: '外部服务',
  voiceLocale: '识别语言',
  voiceLocaleAuto: '自动',
  voiceDevice: '输入设备',
  voiceDeviceDefault: '系统默认',
  voicePickDevice: '选择输入设备',
  voiceMicTest: '3 秒试录',
  voiceMicTesting: '试录中…',
  voiceMicTestDone: (t) => (t ? `试录结果：${t}` : '试录完成，未识别到语音'),
  voiceMicTestPass: (sec) => `麦克风工作正常（已采集 ${sec} 秒音频，仅本地检测未外发）`,
  voiceMicTestSilent: '试录完成，未检测到声音输入，请检查麦克风设备或系统音量',
  voiceEncryptionUnavailable: '当前系统安全加密仓不可用，无法保存外部语音 API 密钥或启用外部转写。',
  voiceCooldownActive: (kind, until) => `外部语音服务触发 ${kind} 冷却保护，暂不可调用（预计恢复：${until}）`,
  voiceModelStatus: {
    ready: '本地模型已就绪',
    missing: '本地模型未安装',
    downloading: '正在下载本地模型',
    verifying: '正在校验本地模型',
    loading: '正在加载本地模型',
    error: '本地模型不可用',
  },
  voiceModelInstall: '安装本地模型',
  voiceModelInstallConfirm: (mb) => `将下载约 ${mb} MB 的离线语音模型并校验 SHA-256，是否继续？`,
  voiceModelCancel: '取消安装',
  voiceModelProgress: (p) => `${p}%`,
  voiceExternalTitle: '外部转写服务',
  voiceExternalProvider: '服务类型',
  voiceExternalEndpoint: '接口地址',
  voiceExternalModel: '模型',
  voiceExternalKey: 'API 密钥',
  voiceExternalKeySaved: '已加密保存，留空则保持不变',
  voiceExternalRate: '参考单价（USD/分钟，可选）',
  voiceDiscover: '获取模型列表',
  voiceTest: '测试连接',
  voiceTestOk: (ms) => `连接成功（${ms} ms）`,
  voiceTestFail: (r) => `测试失败：${r}`,
  voiceSave: '保存',
  voiceCostTitle: '语音转写费用',
  voiceCostSummary: (c, m, cost) => `${c} 次 · ${m} 分钟 · ${cost}`,
  voiceCostUnknown: '部分费用未知',

  iconAutoToggle: '跟随主题自动切换',
  iconAutoHint: '开启后应用图标随当前主题变化',
  settingsDirtyLeave: '当前分组有未保存的修改。',
  settingsDirtyStay: '继续编辑',
  settingsDirtyDiscard: '放弃修改',
  confirmDelete: '确认删除',
  confirmDeleteAsk: (n) => `删除「${n}」？`,
  cancel: '取消',
  compactRunning: '正在压缩上下文…',
  connectionLabel: { connected: '已连接', connecting: '连接中', disconnected: '未连接', error: '连接异常' },
  treeCurrent: '当前分支',
  swarmFilter: '按成员筛选',
  dropBusy: '正在处理上一次拖放',
  needsApproval: (count) => `待审批${count > 1 ? ` ×${count}` : ''}`,
  rejectedByUserFallback: '用户拒绝执行',
  quotaUnavailable: {
    platform: '此平台暂不支持自动读取额度。在终端运行 agy，然后输入 /usage 查看。',
    profile: '当前官方 CLI 只提供默认登录资料的额度。终端里的 agy → /usage 显示默认资料的额度。',
    helper: '此安装缺少 macOS 额度读取组件。在终端运行 agy，然后输入 /usage 查看。',
    preview: '请在 G-Gravity 桌面端查看额度，或在终端运行 agy 后输入 /usage。',
  },
  taskDoneLabel: '已完成',
  taskTodoLabel: '待完成',
  costScopes: { session: '本会话', today: '今日', '7d': '7d', '30d': '30d', all: '全部' },
};

export const V036_EN: V036Strings = {
  planEmptyTitle: 'No plan yet',
  planEmptyHint: 'Once the agent starts planning, its goal, steps and progress appear here.',
  planUnavailable: (r) => `The plan can't be read right now${r ? `: ${r}` : ''}`,
  planCleared: 'The plan was cleared',
  planGoal: 'Goal',
  planSections: (n) => `${n} ${n === 1 ? 'section' : 'sections'}`,
  planViewSource: 'View source',
  planUpdated: (w) => `Updated ${w}`,
  planOpenExternal: 'Open externally',
  planNow: (s) => `Now: ${s}`,
  planDoneGroup: (n) => `${n} steps done`,
  planDocLine: 'Plan document',
  planDocWithSections: (n) => `Plan document · ${n} ${n === 1 ? 'section' : 'sections'}`,
  planOutlineFooterHint: 'Live progress will appear once execution begins.',
  planChip: (d, t) => `Plan ${d}/${t}`,
  planChipNow: (s) => `Now: ${s}`,
  planChipOpen: 'Open in the Plan tab',
  planDrawerTitle: 'Plan source',
  planDrawerClose: 'Back to summary',
  planMermaid: (n) => `Diagram (${n} lines)`,
  planLoadingSource: 'Loading source…',
  planSectionsMore: (n) => `${n} more ${n === 1 ? 'section' : 'sections'}`,

  annQuote: 'Quote',
  annQuoteOnly: 'Quote only',
  annAlreadyQuoted: (n) => `Already quoted as #${n}`,
  annCommentPlaceholder: 'Comment on this passage (optional)',
  annCommentLabel: (n) => `Comment ${n}`,
  annRemove: (n) => `Remove quote ${n}`,
  annPin: (n) => `Quote #${n}`,
  annQuoteOnlyTag: 'Quote only',
  annSupplement: 'Additional notes',
  annSupplementPlaceholder: 'Additional notes (optional)',
  annTrayLabel: (n) => `${n} ${n === 1 ? 'quote' : 'quotes'}`,
  annEditOptional: '(optional)',
  annRestoreFailed: 'Send failed. Your quotes and comments were restored.',

  voiceStart: 'Dictate',
  voiceStop: 'Stop dictation',
  voiceShortcutHint: (mac) => (mac ? 'Dictate (fn F5)' : 'Dictate (F5)'),
  voiceRecording: (e) => `Dictating ${e}`,
  voiceFinishing: 'Transcribing…',
  voiceProbing: 'Preparing microphone…',
  voiceBackpressure: 'Transcription is behind; audio is queued',
  voiceCapReached: 'Reached the 3:30 limit; dictation stopped',
  voiceRevoked: 'Dictation stopped',
  voiceError: (r) => `Dictation failed${r ? `: ${r}` : ''}`,
  voiceUnavailable: 'Voice dictation is not available in this build',
  voiceModelMissing: 'The local voice model is not installed. Install it in Settings → General.',
  voiceMore: 'More input options',
  voiceAttach: 'Attach files',
  voiceSettingsTitle: 'Voice dictation',
  voiceSettingsDesc: 'Transcribes offline on this computer by default. Audio is never sent to agy, and only goes to a service you configure if you turn on external transcription.',
  voiceEngine: 'Engine',
  voiceEngineOff: 'Off',
  voiceEngineLocal: 'On this computer',
  voiceEngineExternal: 'External service',
  voiceLocale: 'Language',
  voiceLocaleAuto: 'Auto',
  voiceDevice: 'Input device',
  voiceDeviceDefault: 'System default',
  voicePickDevice: 'Choose input device',
  voiceMicTest: '3-second test',
  voiceMicTesting: 'Testing…',
  voiceMicTestDone: (t) => (t ? `Test result: ${t}` : 'Test finished; no speech recognized'),
  voiceMicTestPass: (sec) => `Microphone is working (${sec}s captured locally, nothing uploaded)`,
  voiceMicTestSilent: 'Test finished with no sound detected. Check your microphone device or input volume.',
  voiceEncryptionUnavailable: 'OS credential encryption is unavailable; external voice keys cannot be stored or enabled.',
  voiceCooldownActive: (kind, until) => `External voice service is in ${kind} cooldown until ${until}.`,
  voiceModelStatus: {
    ready: 'Local model ready',
    missing: 'Local model not installed',
    downloading: 'Downloading local model',
    verifying: 'Verifying local model',
    loading: 'Loading local model',
    error: 'Local model unavailable',
  },
  voiceModelInstall: 'Install local model',
  voiceModelInstallConfirm: (mb) => `Download the ${mb} MB offline voice model and verify its SHA-256?`,
  voiceModelCancel: 'Cancel install',
  voiceModelProgress: (p) => `${p}%`,
  voiceExternalTitle: 'External transcription',
  voiceExternalProvider: 'Provider',
  voiceExternalEndpoint: 'Endpoint',
  voiceExternalModel: 'Model',
  voiceExternalKey: 'API key',
  voiceExternalKeySaved: 'Saved encrypted. Leave blank to keep it.',
  voiceExternalRate: 'Reference rate (USD/min, optional)',
  voiceDiscover: 'Fetch models',
  voiceTest: 'Test connection',
  voiceTestOk: (ms) => `Connected (${ms} ms)`,
  voiceTestFail: (r) => `Test failed: ${r}`,
  voiceSave: 'Save',
  voiceCostTitle: 'Transcription cost',
  voiceCostSummary: (c, m, cost) => `${c} calls · ${m} min · ${cost}`,
  voiceCostUnknown: 'Some costs unknown',

  iconAutoToggle: 'Match the theme automatically',
  iconAutoHint: 'When on, the app icon follows the current theme',
  settingsDirtyLeave: 'This section has unsaved changes.',
  settingsDirtyStay: 'Keep editing',
  settingsDirtyDiscard: 'Discard changes',
  confirmDelete: 'Delete',
  confirmDeleteAsk: (n) => `Delete “${n}”?`,
  cancel: 'Cancel',
  compactRunning: 'Compacting context…',
  connectionLabel: { connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', error: 'Connection error' },
  treeCurrent: 'Current branch',
  swarmFilter: 'Filter by member',
  dropBusy: 'Still handling the previous drop',
  needsApproval: (count) => `Needs approval${count > 1 ? ` ×${count}` : ''}`,
  rejectedByUserFallback: 'Rejected by user',
  quotaUnavailable: {
    platform: 'Automatic quota readings are unavailable on this platform. Run agy in a terminal and enter /usage.',
    profile: 'The official CLI reports quota for its default sign-in only. Running agy and entering /usage in a terminal shows that default account.',
    helper: 'The macOS quota reader is unavailable in this installation. Run agy in a terminal and enter /usage.',
    preview: 'Open G-Gravity on the desktop to view quota, or run agy in a terminal and enter /usage.',
  },
  taskDoneLabel: 'completed',
  taskTodoLabel: 'todo',
  costScopes: { session: 'Session', today: 'Today', '7d': '7d', '30d': '30d', all: 'All' },
};

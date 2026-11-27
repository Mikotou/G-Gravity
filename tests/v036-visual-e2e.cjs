'use strict';

/**
 * Gravity v0.3.6 — Offline Real-Browser 6-Theme × 4-Width Visual E2E & Geometry Verification Suite (V1–V4).
 *
 * - Serves compiled `dist/renderer` from ephemeral loopback HTTP (`127.0.0.1:0`) with strict production CSP;
 *   all non-loopback network requests are aborted and asserted = 0.
 * - Zero writes to `~/.gemini` or the Git worktree; default screenshot dir is `os.tmpdir()/gravity-v036-visual-e2e`
 *   (overridable via `GRAVITY_VISUAL_OUT`).
 * - Covers:
 *   V1: 6 preset themes panorama (workbench annotations + Plan drawer + VoiceSettingsCard + Icons 3×2 + auto switch)
 *   V2: 4 pane container widths (720 / 560 / 460 / 340px incl. 340px active voice recording 0 overflow) + 280px Plan drawer
 *   V3: Plan 4 states (① empty, ①′ unavailable, ② outline, ③ execution w/ collapsed done group, ④ cleared DEC-04) + EditUserMessage cards
 *   V4: `prefers-reduced-motion: reduce` 0 infinite running animations (streaming + recording `.voice-dot`) + real CSS.highlights
 */

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { existsSync } = require('node:fs');
const { mkdir, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_RENDERER = path.join(REPO_ROOT, 'dist', 'renderer');
const SCREENSHOT_DIR = process.env.GRAVITY_VISUAL_OUT
  ? path.resolve(process.env.GRAVITY_VISUAL_OUT)
  : path.join(os.tmpdir(), 'gravity-v036-visual-e2e');

const ALL_THEMES = [
  'claude-code-dark',
  'claude-code-light',
  'ubuntu-aubergine',
  'macos-dark',
  'macos-light',
  'solarized-dark',
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function launchHeadlessChromium() {
  const channels = [process.env.GRAVITY_BROWSER_CHANNEL, 'msedge', 'chrome'].filter(
    (c, i, all) => c && all.indexOf(c) === i
  );
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try next channel */
    }
  }
  return chromium.launch({ headless: true });
}

async function startDistServer() {
  assert.ok(existsSync(path.join(DIST_RENDERER, 'index.html')), 'dist/renderer/index.html missing — run npm run build first');
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const abs = path.resolve(DIST_RENDERER, rel);
      if (!abs.startsWith(DIST_RENDERER + path.sep) && abs !== DIST_RENDERER) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const buf = await readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, port };
}

function injectOfflineV036Bridge() {
  const makeChannel = () => {
    const subs = new Set();
    return {
      sub: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      emit: (payload) => {
        for (const fn of subs) fn(payload);
      },
    };
  };

  // Synthetic offline microphone stream (AudioContext oscillator -> MediaStreamDestination, 0 hardware mic access)
  const makeSyntheticStream = () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ac = new Ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.05;
    const dest = ac.createMediaStreamDestination();
    osc.frequency.value = 440;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    const origStop = dest.stream.getTracks()[0].stop.bind(dest.stream.getTracks()[0]);
    dest.stream.getTracks()[0].stop = () => {
      try { osc.stop(); } catch {}
      try { ac.close(); } catch {}
      origStop();
    };
    return dest.stream;
  };
  const fakeDevices = [
    { kind: 'audioinput', deviceId: 'qa-mic-1', label: 'Gravity QA Virtual Mic', groupId: 'g1' },
  ];
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => makeSyntheticStream(),
      enumerateDevices: async () => fakeDevices,
    },
  });

  const chSession = makeChannel();
  const chMsg = makeChannel();
  const chInspector = makeChannel();
  const chPlanArtifact = makeChannel();
  const chApprovalReq = makeChannel();
  const chApprovalRev = makeChannel();
  const chApprovalGuard = makeChannel();
  const chApprovalCfg = makeChannel();
  const chApprovalRes = makeChannel();
  const chTelemetry = makeChannel();
  const chSwarm = makeChannel();
  const chAccount = makeChannel();
  const chUpdate = makeChannel();
  const chTree = makeChannel();
  const chUiScale = makeChannel();
  const chConnection = makeChannel();
  const chTranslation = makeChannel();
  const chVoiceSegment = makeChannel();
  const chVoiceSettled = makeChannel();
  const chVoiceRevoked = makeChannel();

  let preferences = {
    locale: 'zh-CN',
    theme: 'claude-code-dark',
    appIcon: 'auto',
    defaultThoughtTrack: 'zh',
    processPerSession: false,
    activeProfileId: 'profile-v036',
    uiScale: 1,
    projects: [{ path: 'C:\\Workspace\\Gravity', name: 'Gravity' }],
    defaultProjectCwd: 'C:\\Workspace\\Gravity',
  };

  const accounts = {
    activeProfileId: 'profile-v036',
    acpIdentity: { connected: true, agentName: 'agy acp', agentVersion: '0.3.6-qa', supportsLogout: true },
    profiles: [
      { profileId: 'profile-v036', name: 'QA 主账号', isDefault: true, isolatedAppDataDir: 'C:\\Temp\\qa-default', createdAt: '2026-11-28T00:00:00.000Z' },
      { profileId: 'profile-alt', name: 'QA 隔离账号', isDefault: false, isolatedAppDataDir: 'C:\\Temp\\qa-alt', createdAt: '2026-11-28T00:00:00.000Z' },
    ],
  };

  const connection = {
    connected: true,
    agyBinaryPath: 'C:\\Tools\\agy.exe',
    agyVersion: '0.3.6-qa',
    availableModels: [
      { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
      { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    ],
    defaultModelId: 'gemini-4-carbon',
    authenticated: true,
  };

  let approvalConfig = {
    mode: 'rules-only',
    enableSafeDownloadAutoApprove: true,
    allowPatterns: ['^git\\s+status$'],
    askPatterns: ['^git\\s+push'],
    denyPatterns: ['^rm\\s+-rf'],
    cacheTtlHours: 24,
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
      hasApiKey: false,
      timeoutMs: 8000,
      maxOutputTokens: 2048,
      thinkingLevel: 'auto',
    },
  };

  const translationConfig = {
    engine: 'local',
    externalTranslator: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      hasApiKey: false,
      timeoutMs: 8000,
      maxOutputTokens: 2048,
      thinkingLevel: 'auto',
    },
  };

  const mkSession = (sessionId, title, extra = {}) => ({
    sessionId,
    profileId: 'profile-v036',
    title,
    cwd: 'C:\\Workspace\\Gravity',
    rawCwd: 'C:\\Workspace\\Gravity',
    pinned: false,
    isLegacyApprovalPollution: false,
    originKind: 'acp-live',
    readOnly: false,
    status: 'idle',
    modelId: 'gemini-4-carbon',
    executionMode: 'default',
    reasoningEffort: 'high',
    updatedAt: '2026-11-28T01:00:00.000Z',
    ...extra,
  });

  let sessions = [
    mkSession('sess-s3-exec', 'v0.3.6 主工作台 · 执行态'),
    mkSession('sess-s1-empty', 'Plan ① 纯空态'),
    mkSession('sess-s1p-unavail', 'Plan ①′ 不可读'),
    mkSession('sess-s2-outline', 'Plan ② 文档概要态'),
    mkSession('sess-s4-cleared', 'Plan ④ 显式清空态'),
  ];

  let layout = {
    openTabSessionIds: sessions.map((s) => s.sessionId),
    activePrimarySessionId: 'sess-s3-exec',
    splitSecondarySessionId: 'sess-s2-outline',
    layoutMode: 'single',
    hideLegacyPollutionSessions: true,
    leftSidebarCollapsed: false,
    leftSidebarWidth: 252,
    rightInspectorCollapsed: false,
    rightInspectorWidth: 380,
    activeInspectorTab: 'plan',
    splitRatio: 0.5,
  };

  const planMdContent = [
    '# Gravity v0.3.6 实施与验收计划',
    '',
    '> [!IMPORTANT]',
    '> 严格执行十大合规红线：静息零权限、本地音频不落盘、CSP 零放宽。',
    '',
    '## 1. 架构与契约冻结',
    '- [x] 冻结 `voice-contract.ts` 与 `plan-contract.ts`',
    '- [x] 落地四态 Plan 时间线与按需抽屉',
    '- [ ] 完成 [视觉 E2E 验证](#2-视觉与打包门禁)',
    '',
    '| 模块 | 状态 | 说明 |',
    '| --- | --- | --- |',
    '| Voice | Ready | AudioWorklet 16kHz PCM16 |',
    '| Plan | Ready | 双 Revision 缓存 |',
    '',
    '```mermaid',
    'flowchart LR',
    '  Summary[Plan Summary] --> Drawer[Source Drawer]',
    '  Drawer --> Verify[QA Sign-off]',
    '```',
    '',
    '```typescript',
    'export const veryLongReadonlyCodeLine = "src/main/services/very-deeply-nested-directory-structure/plan-artifact-reader-with-strict-utf8-boundary-check.ts";',
    '```',
    '',
    '## 2. 视觉与打包门禁',
    '![拦截远端信标](https://blocked.example.com/v036-beacon.png)',
    '',
    '参考：[安全规范](https://example.com/v036) · [本地代码](./src/renderer/components/PlanTimeline.tsx)',
  ].join('\n');

  const planOutline = {
    title: 'Gravity v0.3.6 实施与验收计划',
    goal: '落地合规语音听写、划词保序标注、Plan 四态时间线与全套 UI 缺陷清零。',
    sections: [
      { id: 'sec-1', heading: '1. 架构与契约冻结', summary: '冻结 voice/plan/annotation 共享契约并隔离状态机' },
      { id: 'sec-2', heading: '2. 视觉与打包门禁', summary: '6 主题 × 4 档窗格宽度 0 溢出与离线 Worklet 冒烟' },
    ],
    sectionCount: 2,
  };

  const messagesBySession = {
    'sess-s3-exec': [
      {
        id: 'm-u1',
        sessionId: 'sess-s3-exec',
        role: 'user',
        content: '请对照以上两条划词批注继续完善 Plan 抽屉与语音听写体验。',
        annotations: [
          {
            id: 'ann-qa-1',
            messageId: 'm-a0',
            excerpt: 'AudioWorklet 必须接入静音 GainNode(0) 防止 Chromium 悬空回收',
            comment: '已在 QA-1 核实修复，请纳入打包态冒烟验证',
          },
          {
            id: 'ann-qa-2',
            messageId: 'm-a0',
            excerpt: 'Plan 状态 ④ 严格 0 文件栏、0 implementation_plan.md 字样',
          },
        ],
        createdAt: '2026-11-28T00:50:00.000Z',
      },
      {
        id: 'm-a1',
        sessionId: 'sess-s3-exec',
        role: 'assistant',
        content: [
          '已完成 **v0.3.6** 全部前后端联调修复，重点验证划词锚点、Plan 四态与语音听写状态机：',
          '',
          '```typescript',
          'export function verifyVoiceBoundary(bytes: number): boolean {',
          '  return bytes > 0 && bytes <= 6_720_000;',
          '}',
          '```',
          '',
          '接下来进入 6 主题 × 4 档宽度视觉验收与无障碍减敏核查。',
        ].join('\n'),
        todos: [
          { id: 't1', content: '冻结语音与 Plan 共享契约', status: 'completed' },
          { id: 't2', content: '修复 QA-1 全部 18 项前端缺陷', status: 'completed' },
          { id: 't3', content: '合入 Astra 后端 10 项修复', status: 'completed' },
          { id: 't4', content: '执行 6 主题 × 4 宽度视觉 E2E 核验', status: 'in_progress' },
          { id: 't5', content: '等待 Windows 打包态 Worklet 冒烟', status: 'pending' },
          { id: 't6', content: '跳过废弃的旧双模型配置项', status: 'skipped' },
          { id: 't7', content: '校验长路径折行：src/renderer/components/settings/very-long-voice-settings-card-regression-check.tsx', status: 'failed' },
          { id: 't8', content: '等待外部审批回执', status: 'unknown', rawStatus: 'waiting-signoff' },
        ],
        createdAt: '2026-11-28T00:51:00.000Z',
        completedAt: '2026-11-28T00:51:12.000Z',
        turnStartedAt: '2026-11-28T00:50:00.000Z',
        turnSettledAt: '2026-11-28T00:51:12.000Z',
      },
    ],
    'sess-s1-empty': [],
    'sess-s1p-unavail': [],
    'sess-s2-outline': [],
    'sess-s4-cleared': [
      {
        id: 'm-s4-old',
        sessionId: 'sess-s4-cleared',
        role: 'assistant',
        content: '历史步骤已显式清空，右侧 Plan 不得复活旧待办，也不得展示文件栏。',
        todos: [{ id: 'ghost-todo', content: '绝不复活的旧待办', status: 'in_progress' }],
        createdAt: '2026-11-28T00:40:00.000Z',
      },
    ],
  };

  const inspectorBySession = {
    'sess-s3-exec': {
      sessionId: 'sess-s3-exec',
      diffs: [],
      terminals: [],
      todos: messagesBySession['sess-s3-exec'][1].todos,
      plan: { state: 'present', revision: 8, truncated: true, totalCount: 16, completedCount: 3, failedCount: 1 },
    },
    'sess-s1-empty': {
      sessionId: 'sess-s1-empty',
      diffs: [],
      terminals: [],
      todos: [],
      plan: { state: 'unreceived', revision: 0, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
    },
    'sess-s1p-unavail': {
      sessionId: 'sess-s1p-unavail',
      diffs: [],
      terminals: [],
      todos: [],
      plan: { state: 'unreceived', revision: 0, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
    },
    'sess-s2-outline': {
      sessionId: 'sess-s2-outline',
      diffs: [],
      terminals: [],
      todos: [],
      plan: { state: 'unreceived', revision: 1, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
    },
    'sess-s4-cleared': {
      sessionId: 'sess-s4-cleared',
      diffs: [],
      terminals: [],
      todos: [],
      plan: { state: 'empty', revision: 4, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
    },
  };

  const telemetry = {
    generatedAt: '2026-11-28T01:00:00.000Z',
    pricingSource: 'reference-api-estimate',
    activeSessions: {
      'sess-s3-exec': {
        sessionId: 'sess-s3-exec',
        modelId: 'gemini-4-carbon',
        usedContextTokens: 64_000,
        maxContextTokens: 1_000_000,
        usageRatio: 0.064,
        pressureLevel: 'healthy',
        breakdown: {
          systemAndRulesTokens: 10_000,
          userMessagesTokens: 12_000,
          agentMessagesTokens: 20_000,
          thoughtTokens: 8_000,
          toolCallsTokens: 10_000,
          attachmentsTokens: 4_000,
        },
        attachments: [],
        compactions: [],
        currentTokensPerSecond: 78,
        averageTokensPerSecond: 66,
        peakTokensPerSecond: 98,
        averageCacheHitRate: 0.42,
        costSummary: { totalInputTokens: 32000, totalOutputTokens: 8000, totalCachedTokens: 12000, totalTokens: 52000, totalCostUsd: 0.092, byModel: [] },
        usageSource: 'acp-reported',
        pricingSource: 'reference-api-estimate',
        updatedAt: '2026-11-28T01:00:00.000Z',
      },
    },
    today: { totalInputTokens: 32000, totalOutputTokens: 8000, totalCachedTokens: 12000, totalTokens: 52000, totalCostUsd: 0.092, byModel: [] },
    last7Days: { totalInputTokens: 120000, totalOutputTokens: 30000, totalCachedTokens: 40000, totalTokens: 190000, totalCostUsd: 0.36, byModel: [] },
    last30Days: { totalInputTokens: 480000, totalOutputTokens: 120000, totalCachedTokens: 160000, totalTokens: 760000, totalCostUsd: 1.44, byModel: [] },
    hourly24h: [],
    daily7d: [],
    calendar30d: [],
    costByRange: {
      today: { totalInputTokens: 32000, totalOutputTokens: 8000, totalCachedTokens: 12000, totalTokens: 52000, totalCostUsd: 0.092, byModel: [] },
      '7d': { totalInputTokens: 120000, totalOutputTokens: 30000, totalCachedTokens: 40000, totalTokens: 190000, totalCostUsd: 0.36, byModel: [] },
      '30d': { totalInputTokens: 480000, totalOutputTokens: 120000, totalCachedTokens: 160000, totalTokens: 760000, totalCostUsd: 1.44, byModel: [] },
      all: { totalInputTokens: 480000, totalOutputTokens: 120000, totalCachedTokens: 160000, totalTokens: 760000, totalCostUsd: 1.44, byModel: [] },
    },
    sessionModelBreakdowns: { 'sess-s3-exec': [] },
    modelBreakdownByRange: { today: [], '7d': [], '30d': [], all: [] },
    rateCards: [],
    externalVoice: {
      cumulativeCalls: 4,
      totalDurationMs: 126_000,
      knownCostUsd: 0.0126,
      hasUnknownCost: false,
      byProvider: {},
    },
  };

  let voiceConfig = {
    engine: 'local',
    locale: 'auto',
    externalProvider: {
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      hasApiKey: false,
      ratePerMinuteUsd: 0.006,
    },
  };
  let captureCounter = 0;
  const activeCaptures = new Map();

  const voiceStateSnapshot = () => ({
    config: structuredClone(voiceConfig),
    model: {
      status: 'ready',
      modelId: 'whisper-base-q5_1',
      fileName: 'ggml-base-q5_1.bin',
      source: 'bundled',
      expectedBytes: 59_700_000,
      sha256Verified: true,
    },
    external: {
      ready: false,
      encryptionAvailable: true,
    },
    activeCapture: null,
    heldCapture: null,
    updatedAt: '2026-11-28T01:00:00.000Z',
  });

  const plugins = {
    profileId: 'profile-v036',
    isIsolatedProfile: false,
    builtins: [],
    plugins: [{ name: 'approve-for-me', enabled: true, source: 'bundled' }],
    mcpServers: [{ name: 'local-fs', type: 'stdio', command: 'node', enabled: true }],
    skills: [],
    updatedAt: '2026-11-28T01:00:00.000Z',
  };

  window.gravityDesktop = {
    getBootstrap: async () => ({
      preferences,
      connection,
      accounts,
      approvalConfig,
      translationConfig,
      voiceState: voiceStateSnapshot(),
      sessions,
      layout,
      pendingApprovals: [],
      activeReviews: [],
      telemetry,
      plugins,
      windowChrome: 'standard',
      updateState: { status: 'up-to-date', currentVersion: '0.3.6', repoUrl: 'https://github.com/Mikotou/G-Gravity', canInstallDirectly: false },
    }),
    updatePreferences: async (patch) => {
      preferences = { ...preferences, ...patch };
      return preferences;
    },
    setAppIcon: async (iconId) => {
      preferences = { ...preferences, appIcon: iconId };
      return preferences;
    },
    importCustomTheme: async () => preferences,
    exportCustomTheme: async () => '{}',
    openLinkOrFileTarget: async (input) => ({ opened: true, modeUsed: input.action || 'browser', resolvedTarget: input.target }),
    copyText: async () => undefined,
    inspectLocalTargets: async () => ({ items: {} }),
    selectDirectory: async () => null,
    checkForUpdates: async () => ({ status: 'up-to-date', currentVersion: '0.3.6', repoUrl: '' }),
    downloadUpdate: async () => ({ status: 'idle', currentVersion: '0.3.6', repoUrl: '' }),
    installUpdate: async () => ({ launched: false, message: 'offline' }),
    getConnectionStatus: async () => connection,
    getAccountsState: async () => accounts,
    createAccountProfile: async () => accounts,
    deleteAccountProfile: async () => accounts,
    switchAccountProfile: async () => accounts,
    getAccountQuota: async () => ({
      profileId: 'profile-v036',
      checkedAt: '2026-11-28T01:00:00.000Z',
      buckets: [{ id: 'gemini-weekly', remainingFraction: 0.88 }],
    }),
    launchOfficialLogin: async () => ({ launched: false, message: 'offline' }),
    officialLogout: async () => ({ loggedOut: false }),
    listSessions: async () => sessions,
    createSession: async () => sessions[0],
    resumeSession: async (id) => sessions.find((s) => s.sessionId === id) || sessions[0],
    closeSession: async () => undefined,
    manageSession: async () => ({ sessions, layout }),
    answerQuestion: async () => ({ mode: 'form', submissionId: 'sub-1', followupState: 'queued' }),
    setSessionMode: async (id, mode) => {
      sessions = sessions.map((s) => (s.sessionId === id ? { ...s, executionMode: mode } : s));
      const updated = sessions.find((s) => s.sessionId === id) || sessions[0];
      chSession.emit(updated);
      return updated;
    },
    setSessionEffort: async (id, effort) => {
      sessions = sessions.map((s) => (s.sessionId === id ? { ...s, reasoningEffort: effort } : s));
      const updated = sessions.find((s) => s.sessionId === id) || sessions[0];
      chSession.emit(updated);
      return updated;
    },
    setSessionModel: async (id, modelId) => {
      sessions = sessions.map((s) => (s.sessionId === id ? { ...s, modelId } : s));
      const updated = sessions.find((s) => s.sessionId === id) || sessions[0];
      chSession.emit(updated);
      return updated;
    },
    getSessionMessagePage: async (id) => ({
      earlierCount: 0,
      earlierUserCount: 0,
      earlierVisibleCount: 0,
      precedingOriginId: null,
      messages: messagesBySession[id] || [],
    }),
    getSessionInspector: async (id) => inspectorBySession[id] || { sessionId: id, diffs: [], todos: [], terminals: [] },
    getSessionPlanArtifact: async (input) => {
      const owner = { profileId: input.profileId || 'profile-v036', sessionId: input.sessionId };
      if (input.sessionId === 'sess-s1-empty') return { status: 'missing', owner, revision: 0 };
      if (input.sessionId === 'sess-s1p-unavail') return { status: 'unavailable', owner, revision: 0, reason: '离线权限只读受限' };
      const view = input.view || 'summary';
      return {
        status: 'ready',
        view,
        owner,
        revision: 8,
        summaryRevision: 8,
        contentRevision: 8,
        filePath: 'C:\\Temp\\gravity-qa\\brain\\implementation_plan.md',
        truncated: false,
        updatedAt: '2026-11-28T00:55:00.000Z',
        ...(view === 'content' ? { content: planMdContent } : { outline: planOutline }),
      };
    },
    listWorkspaceFiles: async () => ['src/renderer/components/PlanTimeline.tsx'],
    reviseMessage: async () => sessions[0],
    getConversationTree: async (id) => ({
      rootSessionId: id,
      rootTitle: 'Main',
      activeBranchId: id,
      totalBranches: 1,
      updatedAt: '2026-11-28T01:00:00.000Z',
      nodes: [],
      nodesById: {},
    }),
    switchConversationBranch: async () => sessions[0],
    sendPrompt: async () => undefined,
    cancelPrompt: async () => undefined,
    compactSessionContext: async () => undefined,
    saveWorkspaceLayout: async (patch) => {
      layout = { ...layout, ...patch };
      return layout;
    },
    renameSession: async () => sessions[0],
    togglePinSession: async () => sessions[0],
    organizeTitles: async () => ({ organizedCount: 0, skippedCount: 0, sessions }),
    setApprovalMode: async (mode) => {
      approvalConfig = { ...approvalConfig, mode };
      chApprovalCfg.emit(approvalConfig);
      return approvalConfig;
    },
    updateApprovalConfig: async (patch) => {
      approvalConfig = { ...approvalConfig, ...patch };
      chApprovalCfg.emit(approvalConfig);
      return approvalConfig;
    },
    submitApprovalDecision: async () => ({ accepted: true }),
    clearSessionApprovals: async () => sessions[0],
    listSessionApprovalGrants: async (sessionId) => ({ sessionId, delegatedToGuardian: false, prefixes: [] }),
    revokeSessionApprovalGrant: async (input) => ({ sessionId: input.sessionId, delegatedToGuardian: false, prefixes: [] }),
    cancelStage2ApprovalReview: async () => ({ cancelled: true }),
    testExternalReviewerConnection: async () => ({ ok: true, latencyMs: 12 }),
    listApprovalAudit: async () => [],
    discoverExternalReviewerModels: async () => ({ provider: 'gemini-api-key', endpoint: '', fetchedAt: '', models: [] }),
    getTranslationConfig: async () => translationConfig,
    updateTranslationConfig: async () => translationConfig,
    discoverExternalTranslationModels: async () => ({ provider: 'gemini-api-key', endpoint: '', fetchedAt: '', models: [] }),
    testExternalTranslatorConnection: async () => ({ ok: true, latencyMs: 12 }),
    getTelemetryDashboard: async () => telemetry,
    updateModelRateCards: async () => telemetry,
    getPluginsSnapshot: async () => plugins,
    runPluginAction: async () => plugins,
    runMcpAction: async () => plugins,
    toggleSkillEnabled: async () => plugins,
    getSwarmState: async (sessionId) => ({
      sessionId,
      isActive: false,
      swarmTitle: 'Swarm',
      channels: [],
      workers: [],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 },
      updatedAt: '2026-11-28T01:00:00.000Z',
    }),
    // Voice bridge
    getVoiceState: async () => voiceStateSnapshot(),
    updateVoiceConfig: async (patch) => {
      const { apiKey, ratePerMinuteUsd, ...ext } = patch.externalProvider || {};
      voiceConfig = {
        ...voiceConfig,
        ...(patch.engine ? { engine: patch.engine } : {}),
        ...(patch.locale ? { locale: patch.locale } : {}),
        externalProvider: {
          ...voiceConfig.externalProvider,
          ...ext,
          ratePerMinuteUsd: ratePerMinuteUsd === null ? undefined : ratePerMinuteUsd ?? voiceConfig.externalProvider.ratePerMinuteUsd,
          ...(apiKey ? { hasApiKey: true } : {}),
        },
      };
      return voiceStateSnapshot();
    },
    discoverVoiceModels: async (input) => ({
      provider: input.provider,
      endpoint: input.endpoint,
      fetchedAt: '2026-11-28T01:00:00.000Z',
      models: [{ id: 'gpt-4o-mini-transcribe', displayName: 'gpt-4o-mini-transcribe', supportsThinking: false, supportedThinkingLevels: [] }],
    }),
    testVoiceConnection: async () => ({ ok: true, latencyMs: 42 }),
    installVoiceModel: async () => ({ started: false, state: voiceStateSnapshot().model, message: 'bundled' }),
    voiceArmCapture: async (input) => {
      if (input && typeof input === 'object' && (input.op === 'media-ready' || input.op === 'release-media')) {
        const cap = activeCaptures.get(input.captureId);
        return {
          captureId: input.captureId,
          owner: cap ? cap.owner : { profileId: 'profile-v036' },
          epoch: 0,
          purpose: cap ? cap.purpose : 'dictation',
          engine: voiceConfig.engine,
          sampleRate: 16000,
          maxDurationMs: 210000,
          maxPcmBytes: 6720000,
          state: input.op === 'media-ready' ? 'capturing' : 'released',
        };
      }
      const id = `qa-cap-${++captureCounter}`;
      activeCaptures.set(id, { owner: input.owner, purpose: input.purpose || 'dictation', bytes: 0, seq: 0 });
      return {
        captureId: id,
        owner: input.owner,
        epoch: 0,
        purpose: input.purpose || 'dictation',
        engine: voiceConfig.engine,
        sampleRate: 16000,
        maxDurationMs: input.purpose === 'mic-test' ? 3000 : 210000,
        maxPcmBytes: input.purpose === 'mic-test' ? 96000 : 6720000,
        state: 'armed',
      };
    },
    voiceAppend: async (input) => {
      const cap = activeCaptures.get(input.captureId);
      const len = input.pcm16 ? input.pcm16.byteLength : 0;
      if (cap) {
        cap.seq = input.seq;
        cap.bytes += len;
      }
      return {
        captureId: input.captureId,
        accepted: true,
        seq: input.seq,
        acceptedBytes: cap ? cap.bytes : len,
        remainingBytes: 6720000,
      };
    },
    voiceFinish: async (input) => {
      const cap = activeCaptures.get(input.captureId);
      activeCaptures.delete(input.captureId);
      if (cap) {
        setTimeout(() => {
          chVoiceSegment.emit({ owner: cap.owner, epoch: 0, captureId: input.captureId, seq: 1, text: '离线语音听写验收通过', isFinal: true });
          chVoiceSettled.emit({
            owner: cap.owner,
            epoch: 0,
            captureId: input.captureId,
            finalSeq: 1,
            text: '离线语音听写验收通过',
            durationMs: 1200,
            engine: 'local',
            outcome: 'completed',
          });
        }, 10);
      }
      return { captureId: input.captureId, status: 'finishing', acceptedSeq: cap ? cap.seq : 0, acceptedBytes: cap ? cap.bytes : 0 };
    },
    voiceAbort: async (input) => ({ captureId: input.captureId, aborted: activeCaptures.delete(input.captureId) }),
    onSessionUpdated: chSession.sub,
    onMessageUpserted: chMsg.sub,
    onInspectorUpdated: chInspector.sub,
    onPlanArtifactChanged: chPlanArtifact.sub,
    onApprovalRequested: chApprovalReq.sub,
    onApprovalReviewing: chApprovalRev.sub,
    onApprovalGuardActivity: chApprovalGuard.sub,
    onApprovalConfigUpdated: chApprovalCfg.sub,
    onApprovalResolved: chApprovalRes.sub,
    onTelemetryUpdated: chTelemetry.sub,
    onSwarmUpdated: chSwarm.sub,
    onAccountUpdated: chAccount.sub,
    onUpdateState: chUpdate.sub,
    onTreeUpdated: chTree.sub,
    onUiScaleCommand: chUiScale.sub,
    onConnectionUpdated: chConnection.sub,
    onTranslationConfigUpdated: chTranslation.sub,
    onVoiceSegment: chVoiceSegment.sub,
    onVoiceSettled: chVoiceSettled.sub,
    onVoiceCaptureRevoked: chVoiceRevoked.sub,
  };

  window.__v036Qa = {
    setSessionStatus(sessionId, status) {
      sessions = sessions.map((s) => (s.sessionId === sessionId ? { ...s, status } : s));
      const updated = sessions.find((s) => s.sessionId === sessionId);
      if (updated) chSession.emit(updated);
    },
  };
}

async function selectThemeViaUi(page, themeId) {
  await page.keyboard.press('Control+,');
  await page.getByTestId('theme-settings-modal').waitFor({ timeout: 10000 });
  await page.getByTestId('settings-tab-themes').click();
  await page.getByTestId('settings-subtab-themes').click();
  await page.getByTestId(`theme-card-${themeId}`).click();
  await page.waitForFunction((id) => document.documentElement.getAttribute('data-theme') === id, themeId);
  await page.keyboard.press('Escape');
  await page.getByTestId('theme-settings-modal').waitFor({ state: 'detached', timeout: 10000 });
  await delay(120);
}

async function setInspectorWidth(page, widthPx) {
  await page.evaluate((w) => {
    const aside = document.querySelector('[data-testid="right-inspector"]');
    if (aside) aside.style.width = `${w}px`;
  }, widthPx);
  await delay(140);
}

async function selectRangeAndQuote(page, bodyTestId, selector, comment) {
  const el = page.locator(`[data-testid="${bodyTestId}"] ${selector}`).first();
  await el.scrollIntoViewIfNeeded();
  await el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 280, clientY: 220 }));
  });
  await page.getByTestId('selection-quote-btn').click();
  const commentBox = page.locator('[data-testid^="composer-annotation-comment-"]').last();
  await commentBox.waitFor({ timeout: 5000 });
  if (comment) {
    await commentBox.fill(comment);
  }
  await commentBox.press('Enter');
  await delay(80);
}

async function main() {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const { server, baseUrl, port } = await startDistServer();
  let browser;
  const pageErrors = [];
  const consoleErrors = [];
  const externalRequests = [];
  const report = { v1: [], v2: [], v3: {}, v4: {} };

  try {
    browser = await launchHeadlessChromium();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => {
      console.error('[PAGEERROR]', err.stack || err.message || String(err));
      pageErrors.push(err.message || String(err));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('[CONSOLE ERROR]', msg.text());
        consoleErrors.push(msg.text());
      }
    });

    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://127.0.0.1:${port}/`) || url.startsWith('data:') || url.startsWith('blob:')) {
        return route.continue();
      }
      externalRequests.push(url);
      return route.abort();
    });

    await page.addInitScript(injectOfflineV036Bridge);
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('agy-app-root').waitFor({ timeout: 15000 });
    await page.getByTestId('plan-timeline').waitFor({ timeout: 15000 });
    await delay(200);

    // Seed 1 live annotation in the composer tray + CSS.highlights so V1 captures full annotation UI + dual pins
    await selectRangeAndQuote(page, 'assistant-body-m-a1', 'strong', '验证 6 主题划词托盘对比度与双编号钉');
    const highlightCount = await page.evaluate(() => (window.CSS && CSS.highlights ? CSS.highlights.get('gravity-annotations')?.size || 0 : -1));
    assert.equal(highlightCount, 1, '[V1/V4] expected CSS.highlights gravity-annotations size === 1');

    /* =====================================================================
     * V1: 6 套真实预设主题全景（工作台 + 划词托盘 + Plan 抽屉 + 语音设置卡 + 图标 3×2）
     * =================================================================== */
    await setInspectorWidth(page, 380);
    for (const theme of ALL_THEMES) {
      await selectThemeViaUi(page, theme);
      const wbCheck = await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="session-pane-sess-s3-exec"]');
        const plan = document.querySelector('[data-testid="inspector-view-plan"]');
        return {
          paneOverflow: pane ? Math.round(pane.scrollWidth - pane.clientWidth) : -1,
          planOverflow: plan ? Math.round(plan.scrollWidth - plan.clientWidth) : -1,
          hasSentAnnotations: Boolean(document.querySelector('[data-testid="sent-annotations"]')),
          hasTray: Boolean(document.querySelector('[data-testid="composer-annotations-sess-s3-exec"]')),
          hasPlanChip: Boolean(document.querySelector('[data-testid="plan-chip-m-a1"]')),
          hasVoiceBtn: Boolean(document.querySelector('[data-testid="voice-toggle-sess-s3-exec"]')),
        };
      });
      assert.ok(wbCheck.paneOverflow <= 1, `[V1 ${theme}] pane overflow=${wbCheck.paneOverflow}`);
      assert.ok(wbCheck.planOverflow <= 1, `[V1 ${theme}] plan overflow=${wbCheck.planOverflow}`);
      assert.equal(wbCheck.hasSentAnnotations, true);
      assert.equal(wbCheck.hasTray, true);
      assert.equal(wbCheck.hasPlanChip, true);
      assert.equal(wbCheck.hasVoiceBtn, true);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `v1-${theme}-workbench.png`) });

      // 打开 Plan 原文抽屉截屏并校验 0 <img> / Mermaid 折叠 / GFM 表格 / 0 溢出
      await page.getByTestId('plan-source-open').click();
      await page.getByTestId('plan-artifact-document').waitFor({ timeout: 10000 });
      await delay(100);
      const drawerCheck = await page.getByTestId('inspector-view-plan').evaluate((el) => ({
        overflow: Math.round(el.scrollWidth - el.clientWidth),
        imgs: el.querySelectorAll('img').length,
        hasMermaid: Boolean(el.querySelector('[data-testid="plan-doc-mermaid"]')),
        hasTable: Boolean(el.querySelector('table.md-table')),
      }));
      assert.ok(drawerCheck.overflow <= 1, `[V1 ${theme} drawer] overflow=${drawerCheck.overflow}`);
      assert.equal(drawerCheck.imgs, 0);
      assert.equal(drawerCheck.hasMermaid, true);
      assert.equal(drawerCheck.hasTable, true);
      await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, `v1-${theme}-plan-drawer.png`) });
      await page.getByTestId('plan-source-close').click();
      await delay(80);

      // 截屏 General → VoiceSettingsCard（暗/亮双代表及全部 6 主题检查 Icons 3×2 + 顶部开关）
      await page.keyboard.press('Control+,');
      const modal = page.getByTestId('theme-settings-modal');
      await modal.waitFor();
      await page.getByTestId('settings-tab-general').click();
      await page.getByTestId('voice-settings-card').waitFor();
      await page.getByTestId('voice-settings-card').scrollIntoViewIfNeeded();
      await delay(100);
      await modal.screenshot({ path: path.join(SCREENSHOT_DIR, `v1-${theme}-voice-settings.png`) });

      await page.getByTestId('settings-tab-themes').click();
      await page.getByTestId('settings-tab-icons').click();
      const iconAudit = await modal.evaluate(() => ({
        gridCount: document.querySelector('[data-testid="app-icons-grid"]')?.children.length || 0,
        autoChecked: Boolean(document.querySelector('[data-testid="icon-variant-auto"]')?.checked),
        autoInsideGrid: Boolean(document.querySelector('[data-testid="app-icons-grid"] [data-testid="icon-variant-auto"]')),
      }));
      assert.equal(iconAudit.gridCount, 6, `[V1 ${theme} icons] expected 6 grid icons`);
      assert.equal(iconAudit.autoChecked, true);
      assert.equal(iconAudit.autoInsideGrid, false);
      if (theme === 'claude-code-dark' || theme === 'claude-code-light') {
        await modal.screenshot({ path: path.join(SCREENSHOT_DIR, `v1-${theme}-icons.png`) });
      }
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'detached' });

      report.v1.push({ theme, wbCheck, drawerCheck, iconAudit });
    }
    console.log('[V1] Passed all 6 preset themes panorama, Plan drawer, VoiceSettingsCard & Icons 3×2');

    /* =====================================================================
     * V2: 4 档窗格容器宽度（720 / 560 / 460 / 340px，含 340px 录音中 0 溢出）+ 280px 抽屉
     * =================================================================== */
    await selectThemeViaUi(page, 'claude-code-dark');
    // 清除托盘标注以免挡住底栏几何测量
    const removeTrayBtn = page.locator('[data-testid^="composer-annotation-remove-"]').first();
    if (await removeTrayBtn.count()) await removeTrayBtn.click();

    // 1) 280px 窄 Inspector 下的 Plan 原文抽屉 0 横向溢出（代码块内部独立滚动）
    await setInspectorWidth(page, 280);
    await page.getByTestId('plan-source-open').click();
    await page.getByTestId('plan-artifact-document').waitFor();
    await delay(120);
    const narrowDrawer = await page.getByTestId('inspector-view-plan').evaluate((el) => ({
      width: Math.round(el.getBoundingClientRect().width),
      overflow: Math.round(el.scrollWidth - el.clientWidth),
    }));
    assert.ok(narrowDrawer.overflow <= 1, `[V2 280px drawer] overflow=${narrowDrawer.overflow}`);
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'v2-plan-280-drawer.png') });
    await page.getByTestId('plan-source-close').click();

    // 2) 收起侧栏与右侧检视器，精准通过视口宽度将主窗格容器宽度逼近 720 / 560 / 460 / 340px
    await page.getByTestId('toggle-right-inspector-btn').click();
    await page.getByTestId('toggle-left-sidebar-btn').click();
    await delay(140);
    const railWidth = await page.evaluate(() => Math.round(document.querySelector('.activity-rail')?.getBoundingClientRect().width || 48));

    for (const targetPaneW of [720, 560, 460, 340]) {
      // 略减 2px 保证严格落入 `@container pane (max-width: ${targetPaneW}px)` 区间
      const vpW = railWidth + targetPaneW - 2;
      await page.setViewportSize({ width: vpW, height: 760 });
      await delay(160);
      const geom = await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="session-pane-sess-s3-exec"]');
        const composer = pane.querySelector('.composer');
        const bar = pane.querySelector('.composer-bar');
        const sendBtn = pane.querySelector('[data-testid="send-prompt-btn-sess-s3-exec"]');
        const inlineTools = pane.querySelector('.composer-inline-tools');
        const moreWrap = pane.querySelector('.composer-more');
        const effortChip = pane.querySelector('.model-chip-effort');
        const cRect = composer.getBoundingClientRect();
        const bRect = bar.getBoundingClientRect();
        const sRect = sendBtn.getBoundingClientRect();
        return {
          paneW: Math.round(pane.getBoundingClientRect().width),
          composerOverflow: Math.round(composer.scrollWidth - composer.clientWidth),
          barOverflow: Math.round(bar.scrollWidth - bar.clientWidth),
          barHeight: Math.round(bRect.height),
          sendInsideComposer: sRect.right <= cRect.right + 1 && sRect.left >= cRect.left - 1,
          inlineToolsVisible: inlineTools ? getComputedStyle(inlineTools).display !== 'none' : false,
          moreVisible: moreWrap ? getComputedStyle(moreWrap).display !== 'none' : false,
          effortVisible: effortChip ? getComputedStyle(effortChip).display !== 'none' : false,
        };
      });
      assert.ok(geom.paneW <= targetPaneW, `[V2 ${targetPaneW}] actual paneW=${geom.paneW}`);
      assert.ok(geom.composerOverflow <= 1, `[V2 ${targetPaneW}] composerOverflow=${geom.composerOverflow}`);
      assert.ok(geom.barOverflow <= 1, `[V2 ${targetPaneW}] barOverflow=${geom.barOverflow}`);
      assert.ok(geom.barHeight <= 48, `[V2 ${targetPaneW}] composer-bar wrapped! h=${geom.barHeight}`);
      assert.equal(geom.sendInsideComposer, true, `[V2 ${targetPaneW}] send button clipped outside composer`);
      if (targetPaneW <= 560) assert.equal(geom.effortVisible, false, `[V2 ${targetPaneW}] expected effort chip hidden`);
      if (targetPaneW <= 460) {
        assert.equal(geom.inlineToolsVisible, false, `[V2 ${targetPaneW}] expected inline tools hidden`);
        assert.equal(geom.moreVisible, true, `[V2 ${targetPaneW}] expected + overflow menu visible`);
      } else {
        assert.equal(geom.inlineToolsVisible, true, `[V2 ${targetPaneW}] expected inline tools visible`);
      }
      await page.locator('[data-testid="session-pane-sess-s3-exec"] .composer-dock').screenshot({
        path: path.join(SCREENSHOT_DIR, `v2-pane-${targetPaneW}-idle.png`),
      });
      report.v2.push({ targetPaneW, mode: 'idle', geom });
    }

    // 3) 340px 极窄窗格 + 语音录制中（.voice-status.is-recording + .voice-dot 可见）-> 严格 0 横向溢出 & 0 按钮裁切
    await page.getByTestId('composer-more-sess-s3-exec').click();
    await page.getByTestId('composer-more-voice-sess-s3-exec').click();
    await page.getByTestId('voice-status-sess-s3-exec').waitFor({ timeout: 10000 });
    await delay(160);
    const rec340 = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="session-pane-sess-s3-exec"]');
      const composer = pane.querySelector('.composer');
      const bar = pane.querySelector('.composer-bar');
      const status = pane.querySelector('[data-testid="voice-status-sess-s3-exec"]');
      const sendBtn = pane.querySelector('[data-testid="send-prompt-btn-sess-s3-exec"]');
      const moreBtn = pane.querySelector('[data-testid="composer-more-sess-s3-exec"]');
      const cRect = composer.getBoundingClientRect();
      const sRect = sendBtn.getBoundingClientRect();
      const mRect = moreBtn.getBoundingClientRect();
      return {
        paneW: Math.round(pane.getBoundingClientRect().width),
        composerOverflow: Math.round(composer.scrollWidth - composer.clientWidth),
        barOverflow: Math.round(bar.scrollWidth - bar.clientWidth),
        barHeight: Math.round(bar.getBoundingClientRect().height),
        statusVisible: Boolean(status && status.getBoundingClientRect().width > 20),
        hasDot: Boolean(pane.querySelector('.voice-dot')),
        sendInsideComposer: sRect.right <= cRect.right + 1,
        moreActive: moreBtn.classList.contains('is-active'),
        moreInsideComposer: mRect.right <= cRect.right + 1,
      };
    });
    assert.ok(rec340.composerOverflow <= 1, `[V2 340px recording] composerOverflow=${rec340.composerOverflow}`);
    assert.ok(rec340.barOverflow <= 1, `[V2 340px recording] barOverflow=${rec340.barOverflow}`);
    assert.ok(rec340.barHeight <= 48, `[V2 340px recording] bar wrapped h=${rec340.barHeight}`);
    assert.equal(rec340.statusVisible, true);
    assert.equal(rec340.hasDot, true);
    assert.equal(rec340.sendInsideComposer, true);
    assert.equal(rec340.moreActive, true);
    await page.locator('[data-testid="session-pane-sess-s3-exec"] .composer-dock').screenshot({
      path: path.join(SCREENSHOT_DIR, 'v2-pane-340-recording.png'),
    });
    report.v2.push({ targetPaneW: 340, mode: 'recording', geom: rec340 });

    /* =====================================================================
     * V4: prefers-reduced-motion: reduce（流式生成 + 语音录音中同时开启 -> 0 无限动画）
     * =================================================================== */
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('toggle-left-sidebar-btn').click();
    await page.getByTestId('toggle-right-inspector-btn').click();
    await setInspectorWidth(page, 380);
    await page.evaluate(() => window.__v036Qa.setSessionStatus('sess-s3-exec', 'streaming'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="session-pane-sess-s3-exec"]')?.getAttribute('data-pane-state') === 'streaming'
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await delay(140);
    const reducedAnims = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getTiming?.()?.iterations === Infinity)
        .map((a) => a.animationName)
    );
    assert.deepEqual(reducedAnims, [], `[V4] Expected 0 infinite running animations under reduced-motion, got ${JSON.stringify(reducedAnims)}`);
    await page.getByTestId('session-pane-sess-s3-exec').screenshot({
      path: path.join(SCREENSHOT_DIR, 'v4-reduced-motion-recording.png'),
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // 按 Esc 中止语音录音（不中断流式态，再手动切回 idle）
    await page.keyboard.press('Escape');
    await page.getByTestId('voice-status-sess-s3-exec').waitFor({ state: 'detached', timeout: 10000 });
    await page.evaluate(() => window.__v036Qa.setSessionStatus('sess-s3-exec', 'idle'));
    await delay(120);
    report.v4 = { reducedInfiniteCount: reducedAnims.length, highlightCount };
    console.log('[V2 & V4] Passed 4 widths (incl. 340px recording 0 overflow), 280px drawer & reduced-motion 0 infinite animations');

    /* =====================================================================
     * V3: Plan 四态（① 纯空 / ①′ 不可读 / ② 概要 / ③ 执行折叠 / ④ 显式清空 DEC-04）+ 标注编辑流
     * =================================================================== */
    // 编辑用户带标注消息 -> 卡片在上、正文在下、每卡含删除按钮
    await page.getByTestId('edit-msg-m-u1').click({ force: true });
    await page.getByTestId('edit-annotation-remove-ann-qa-1').waitFor();
    await delay(100);
    const editOrderOk = await page.evaluate(() => {
      const form = document.querySelector('.message-editor');
      const list = form?.querySelector('.annotation-list.is-editing');
      const bodyArea = form?.querySelector('textarea[aria-label*="编辑原消息"]');
      return Boolean(list && bodyArea && (list.compareDocumentPosition(bodyArea) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(editOrderOk, true, '[V3] Expected annotation cards rendered above body textarea in EditUserMessage');
    await page.locator('.message-editor').screenshot({ path: path.join(SCREENSHOT_DIR, 'v3-ann-edit-cards.png') });
    await page.keyboard.press('Escape');

    // 状态 ③（默认会话）：验证已完成 3 步折叠组 & 点击展开 & 底栏章节数
    const doneGroup = page.getByTestId('plan-done-group-t1');
    await doneGroup.waitFor();
    assert.ok((await page.getByTestId('plan-source-open').textContent()).includes('2 个章节'));
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'v3-plan-state-3-execution.png') });

    // 状态 ① 纯空态
    await page.getByTestId('tab-item-sess-s1-empty').click();
    await page.getByTestId('plan-empty').waitFor();
    const s1Text = await page.getByTestId('inspector-view-plan').textContent();
    assert.equal(await page.getByTestId('plan-source-line').count(), 0);
    assert.equal(s1Text.includes('implementation_plan.md'), false);
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'v3-plan-state-1-empty.png') });

    // 状态 ①′ unavailable
    await page.getByTestId('tab-item-sess-s1p-unavail').click();
    await page.getByTestId('plan-unavailable').waitFor();
    const s1pText = await page.getByTestId('plan-unavailable').textContent();
    assert.ok(s1pText.includes('离线权限只读受限'));
    assert.equal(s1pText.includes('implementation_plan.md'), false);
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'v3-plan-state-1p-unavailable.png') });

    // 状态 ② 概要态
    await page.getByTestId('tab-item-sess-s2-outline').click();
    await page.getByTestId('plan-outline').waitFor();
    assert.equal(await page.getByTestId('plan-progressbar').count(), 0);
    assert.ok((await page.getByTestId('plan-outline').textContent()).includes('执行开始后显示实时进度'));
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'v3-plan-state-2-outline.png') });

    // 状态 ④ 显式清空态（DEC-04：0 文件栏、0 implementation_plan.md、0 旧待办复活）
    await page.getByTestId('tab-item-sess-s4-cleared').click();
    await page.getByTestId('plan-cleared').waitFor();
    const s4Text = await page.getByTestId('inspector-view-plan').textContent();
    assert.equal(await page.getByTestId('plan-source-line').count(), 0, '[V3 State ④ DEC-04] plan-source-line must not render');
    assert.equal(s4Text.includes('implementation_plan.md'), false, '[V3 State ④ DEC-04] filename must not appear');
    assert.equal(s4Text.includes('绝不复活的旧待办'), false, '[V3 State ④] old todos must not resurrect');
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'v3-plan-state-4-cleared.png') });

    report.v3 = { editOrderOk, statesVerified: ['empty', 'unavailable', 'outline', 'execution', 'cleared'] };
    console.log('[V3] Passed Plan 4 states (incl. DEC-04 State ④) & EditUserMessage annotation cards');

    assert.deepEqual(externalRequests, [], `Unexpected external requests: ${JSON.stringify(externalRequests)}`);
    assert.deepEqual(pageErrors, [], `Detected pageerror(s): ${JSON.stringify(pageErrors)}`);
    assert.deepEqual(consoleErrors, [], `Detected console error(s): ${JSON.stringify(consoleErrors)}`);

    console.log('\n=== V036_VISUAL_E2E_SUMMARY ===');
    console.log(JSON.stringify({ externalRequests: 0, pageErrors: 0, consoleErrors: 0, screenshotDir: SCREENSHOT_DIR, ...report }, null, 2));
    console.log('=== ALL V1–V4 PLAYWRIGHT VISUAL E2E CHECKS PASSED ===');
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('[V036-VISUAL-E2E FAILED]', err);
  process.exitCode = 1;
});

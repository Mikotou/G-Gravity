'use strict';

/**
 * Gravity v0.3.5 — Offline Real-Browser 6-Theme Visual E2E & Geometry Verification Suite (M1–M6).
 *
 * - Loads the compiled production `dist/renderer` directly via an ephemeral loopback HTTP server (`127.0.0.1:0`)
 *   with full production CSP active and zero external network access (all non-loopback http(s) requests aborted & asserted = 0).
 * - Zero writes to `~/.gemini` or any user directory.
 * - Saves screenshots under `tests/screenshots/v035-qa/` for mandatory multimodal visual inspection.
 */

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { existsSync } = require('node:fs');
const { mkdir, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_RENDERER = path.join(REPO_ROOT, 'dist', 'renderer');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'tests', 'screenshots', 'v035-qa');

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
      /* fallback to next channel */
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

function buildBridgeInitScript() {
  const localToday = new Date();
  const fmtDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // 24h buckets: 0..23 with zero bars, low capped bars (tier 1 & 2), mid (tier 3) and peak (tier 4), plus DST offset labels
  const hourly24h = Array.from({ length: 24 }, (_, i) => {
    const pattern = [
      0, 0, 1400, 3200, 0, 8500, 18000, 42000,
      95000, 185000, 260000, 130000, 62000, 28000, 12000, 4800,
      0, 9200, 48000, 145000, 220000, 74000, 19000, 6500,
    ];
    const levels = [
      0, 0, 1, 1, 0, 1, 2, 2,
      3, 4, 4, 3, 2, 2, 1, 1,
      0, 1, 2, 3, 4, 3, 2, 1,
    ];
    const totalTokens = pattern[i];
    const level = levels[i];
    const hh = String(i).padStart(2, '0');
    return {
      hourKey: `2026-11-27T${hh}`,
      hourLabel: `${hh}:00`,
      startIso: `2026-11-27T${hh}:00:00+08:00`,
      inputTokens: Math.round(totalTokens * 0.65),
      cachedInputTokens: Math.round(totalTokens * 0.15),
      outputTokens: Math.round(totalTokens * 0.15),
      thinkingTokens: Math.round(totalTokens * 0.05),
      totalTokens,
      costUsd: Number((totalTokens * 0.0000032).toFixed(4)),
      intensity: level,
    };
  });

  // 7d daily cards ending on local today so `is-today` and `aria-current="date"` match reliably
  const daily7dLevels = [0, 1, 2, 3, 4, 2, 3];
  const daily7dTokens = [0, 18500, 64200, 182000, 1240000, 88400, 315000];
  const daily7d = Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() - (6 - i));
    const totalTokens = daily7dTokens[i];
    return {
      date: fmtDate(dt),
      inputTokens: Math.round(totalTokens * 0.6),
      cachedInputTokens: Math.round(totalTokens * 0.2),
      outputTokens: Math.round(totalTokens * 0.15),
      thinkingTokens: Math.round(totalTokens * 0.05),
      totalTokens,
      costUsd: Number((totalTokens * 0.000003).toFixed(3)),
      sessionCount: totalTokens > 0 ? i + 1 : 0,
      intensity: daily7dLevels[i],
    };
  });

  // 30d calendar: cross-month, guaranteed non-Monday start & all 5 intensity tiers 0..4
  const calendar30d = Array.from({ length: 30 }, (_, i) => {
    const dt = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() - (29 - i));
    const level = i >= 23 ? daily7dLevels[i - 23] : ([0, 1, 2, 0, 3, 4, 1, 2, 3, 0, 4, 2, 1, 3, 0, 2, 4, 1, 3, 2, 0, 1, 4][i]);
    const tokMap = [0, 16000, 58000, 195000, 960000];
    const totalTokens = i >= 23 ? daily7dTokens[i - 23] : tokMap[level];
    return {
      date: fmtDate(dt),
      inputTokens: Math.round(totalTokens * 0.6),
      cachedInputTokens: Math.round(totalTokens * 0.2),
      outputTokens: Math.round(totalTokens * 0.15),
      thinkingTokens: Math.round(totalTokens * 0.05),
      totalTokens,
      costUsd: Number((totalTokens * 0.000003).toFixed(3)),
      sessionCount: totalTokens > 0 ? Math.max(1, level) : 0,
      intensity: level,
    };
  });

  const costSummary = (tot, usd) => ({
    inputTokens: Math.round(tot * 0.6),
    cachedInputTokens: Math.round(tot * 0.2),
    outputTokens: Math.round(tot * 0.15),
    thinkingTokens: Math.round(tot * 0.05),
    totalTokens: tot,
    inputCostUsd: Number((usd * 0.5).toFixed(3)),
    cachedInputCostUsd: Number((usd * 0.1).toFixed(3)),
    outputCostUsd: Number((usd * 0.3).toFixed(3)),
    thinkingCostUsd: Number((usd * 0.1).toFixed(3)),
    totalCostUsd: usd,
  });

  const longCode = Array.from({ length: 48 }, (_, i) => `export const step_${String(i + 1).padStart(2, '0')} = ${i + 1}; // v0.3.5 fold test`).join('\n');
  const p2Markdown = [
    '### Gravity v0.3.5 P2 排版与安全胶囊抽检',
    '',
    '> [!NOTE]',
    '> 全部非合成动效已迁移至 GPU `transform` / `opacity`，流式光条独立裁切不遮挡弹出菜单。',
    '',
    '> [!WARNING]',
    '> 超过 40 行的代码块默认折叠，点击展开按钮可查看完整源码并支持键盘横向滚动。',
    '',
    '> [!CAUTION]',
    '> 远程图片受生产 CSP 保护，绝不自动发起外网请求，仅展示安全外链胶囊：',
    '',
    '![远程架构图](https://blocked.example.com/gravity-v035-arch.png)',
    '',
    '```ts',
    longCode,
    '```',
  ].join('\n');

  const fourQuestion = {
    id: 'q-v035-4steps',
    message: '实施重构前请确认以下 4 项关键决策：',
    state: 'open',
    submissionVersion: 2,
    fields: [
      {
        name: 'storage',
        title: '1. 状态持久化采用哪种存储策略？',
        type: 'string',
        required: true,
        choices: [
          { value: 'sqlite', label: 'SQLite WAL 本地库', description: '零外部依赖、支持事务与并发读' },
          { value: 'jsonl', label: '原子临时文件 + JSONL', description: '人类可读、按会话分片' },
          { value: 'memory', label: '仅内存缓存（会话结束清空）' },
        ],
      },
      {
        name: 'checks',
        title: '2. 本轮回归需要启用哪些门禁（最多选 2 项）？',
        type: 'array',
        required: true,
        maxItems: 2,
        choices: [
          { value: 'a11y', label: '无障碍键盘漫游与读屏检查' },
          { value: 'visual', label: '6 主题 Playwright 实机截图' },
          { value: 'perf', label: '长流式帧率与内存监控' },
        ],
      },
      {
        name: 'budget',
        title: '3. 允许的误差阈值（-10 ~ 10）',
        type: 'number',
        required: true,
        minimum: -10,
        maximum: 10,
      },
      {
        name: 'notes',
        title: '4. 补充说明或特殊约束（选填）',
        type: 'string',
        required: false,
      },
    ],
  };

  return {
    hourly24h,
    daily7d,
    calendar30d,
    costSummary: {
      today: costSummary(1_690_000, 4.82),
      '7d': costSummary(1_908_100, 5.72),
      '30d': costSummary(7_420_000, 22.18),
    },
    p2Markdown,
    fourQuestion,
  };
}

function injectOfflineDesktopBridge(data) {
  const mkChannel = () => {
    const set = new Set();
    return {
      sub(fn) {
        set.add(fn);
        return () => set.delete(fn);
      },
      emit(payload) {
        for (const fn of set) fn(payload);
      },
    };
  };

  const chSession = mkChannel();
  const chMsg = mkChannel();
  const chInspector = mkChannel();
  const chPlanArtifact = mkChannel();
  const chApprovalReq = mkChannel();
  const chApprovalRev = mkChannel();
  const chApprovalGuard = mkChannel();
  const chApprovalCfg = mkChannel();
  const chApprovalRes = mkChannel();
  const chTelemetry = mkChannel();
  const chSwarm = mkChannel();
  const chAccount = mkChannel();
  const chUpdate = mkChannel();
  const chTree = mkChannel();
  const chUiScale = mkChannel();
  const chConnection = mkChannel();
  const chTranslation = mkChannel();

  const models = [
    { modelId: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { modelId: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
  ];

  const efforts = [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
    { value: 'xhigh', name: 'XHigh' },
  ];

  let preferences = {
    locale: 'zh-CN',
    theme: 'claude-code-dark',
    uiScale: 1,
    appIcon: 'auto',
    defaultThoughtTrack: 'zh',
    translationEngine: 'local',
    processPerSession: false,
    activeProfileId: 'profile-work',
    autoCheckUpdates: false,
  };

  const accounts = {
    activeProfileId: 'profile-work',
    profiles: [
      {
        profileId: 'default',
        name: 'Default Official Profile',
        isDefault: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        lastActivatedAt: '2026-11-26T00:00:00.000Z',
      },
      {
        profileId: 'profile-work',
        name: 'QA Isolated Profile',
        isDefault: false,
        isolatedAppDataDir: 'C:\\Temp\\gravity-qa-isolated-profile',
        createdAt: '2026-11-15T00:00:00.000Z',
        lastActivatedAt: '2026-11-27T01:00:00.000Z',
      },
    ],
    acpIdentity: {
      connected: true,
      agentName: 'Antigravity ACP Agent',
      agentVersion: '1.5.10',
      authMethods: [],
      supportsLogout: false,
    },
  };

  const connection = {
    connected: true,
    agyBinaryPath: 'C:\\Program Files\\Antigravity\\agy.exe',
    agyVersion: '1.5.10',
    activeSessionCount: 2,
    maxParallelSessions: 4,
    activeProfileId: 'profile-work',
    availableModels: models,
    modelListSource: 'live',
  };

  let approvalConfig = {
    mode: 'hybrid',
    enableSafeDownloadAutoApprove: true,
    maxDownloadSizeMB: 25,
    cacheTtlHours: 24,
    allowPatterns: ['', '   ', '^npm\\s+test$', '^.*'],
    askPatterns: ['^git\\s+push\\b'],
    denyPatterns: ['^npm\\s+test$', '^rm\\s+-rf\\s+/'],
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      hasApiKey: true,
      timeoutMs: 8000,
      maxOutputTokens: 4096,
      thinkingLevel: 'auto',
    },
  };

  const auditEntries = [
    {
      id: 'audit-c1-ai',
      timestamp: '2026-11-27T03:10:00.000Z',
      sessionId: 'sess-plan-qa',
      cwd: 'C:\\Workspace\\GravityQA',
      toolName: 'run_command',
      commandOrSummary: 'npx vitest run tests/v035-heatmap-ramp.test.ts',
      modeAtDecision: 'hybrid',
      riskLevel: 'low',
      verdict: 'ai_approved',
      decisionSource: 'external-ai',
      reason: '只读单元测试执行，与当前 QA 验收意图一致',
      latencyMs: 185,
    },
    {
      id: 'audit-c1-rule',
      timestamp: '2026-11-27T03:09:00.000Z',
      sessionId: 'sess-plan-qa',
      cwd: 'C:\\Workspace\\GravityQA',
      toolName: 'run_command',
      commandOrSummary: 'git status --short',
      modeAtDecision: 'rules-only',
      riskLevel: 'safe',
      verdict: 'auto_approved',
      decisionSource: 'local-rule',
      reason: '命中本地只读白名单规则',
      latencyMs: 1.4,
    },
    {
      id: 'audit-c1-user',
      timestamp: '2026-11-27T03:08:00.000Z',
      sessionId: 'sess-plan-qa',
      cwd: 'C:\\Workspace\\GravityQA',
      toolName: 'run_command',
      commandOrSummary: 'node tests/v035-visual-e2e.cjs',
      modeAtDecision: 'manual',
      riskLevel: 'medium',
      verdict: 'user_approved',
      decisionSource: 'user-inline',
      reason: '用户在内联审批卡片确认放行',
      latencyMs: 1240,
    },
  ];

  const plugins = {
    builtins: [
      {
        id: 'builtin-approve-for-me',
        name: 'Approve for me',
        badge: 'Built-in',
        descriptionZh: '本地规则快筛 + 外部 AI 复核与审计日志',
        descriptionEn: 'Local rules + External AI approval & audit',
        enabled: true,
      },
      {
        id: 'builtin-context-viewer',
        name: 'Context & Cost',
        badge: 'Built-in',
        descriptionZh: '上下文窗口与 24h / 7d / 30d Token 热力图',
        descriptionEn: 'Context window & 24h / 7d / 30d token heatmaps',
        enabled: true,
      },
    ],
    plugins: [
      {
        name: 'chrome-devtools-mcp',
        version: '1.4.2',
        enabled: true,
        description: 'Inspect DOM & layout in Chromium',
        marketplace: 'official',
      },
    ],
    mcpServers: [
      {
        name: 'local-docs-mcp',
        type: 'stdio',
        command: 'node',
        args: ['docs-mcp.js'],
        enabled: true,
        status: 'ready',
      },
    ],
    skills: [
      {
        id: 'skill-v035-qa',
        name: 'v035-visual-qa',
        description: 'Offline 6-theme Playwright verification',
        enabled: true,
        source: 'workspace',
      },
    ],
    refreshedAt: '2026-11-27T03:00:00.000Z',
  };

  let sessions = [
    {
      sessionId: 'sess-plan-qa',
      cwd: 'C:\\Workspace\\GravityQA',
      rawCwd: 'C:\\Workspace\\GravityQA',
      title: 'v0.3.5 Plan 提问卡、热力图与只读计划文档验收',
      rawTitle: 'v0.3.5 Plan 提问卡、热力图与只读计划文档验收',
      pinned: true,
      isLegacyApprovalPollution: false,
      status: 'waiting_question',
      modelId: 'gemini-4-neon',
      executionMode: 'plan',
      reasoningEffort: 'xhigh',
      availableModels: models,
      availableEfforts: efforts,
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'profile-work',
      updatedAt: '2026-11-27T03:15:00.000Z',
    },
    {
      sessionId: 'sess-p2-showcase',
      cwd: 'C:\\Workspace\\GravityQA',
      rawCwd: 'C:\\Workspace\\GravityQA',
      title: 'v0.3.5 MO-01 流式态与 P2 排版视觉验收',
      rawTitle: 'v0.3.5 MO-01 流式态与 P2 排版视觉验收',
      pinned: false,
      isLegacyApprovalPollution: false,
      status: 'idle',
      modelId: 'gemini-4-neon',
      executionMode: 'default',
      reasoningEffort: 'high',
      availableModels: models,
      availableEfforts: efforts,
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'profile-work',
      updatedAt: '2026-11-27T03:10:00.000Z',
    },
  ];

  let layout = {
    openTabSessionIds: ['sess-plan-qa', 'sess-p2-showcase'],
    activePrimarySessionId: 'sess-plan-qa',
    splitSecondarySessionId: 'sess-p2-showcase',
    layoutMode: 'single',
    hideLegacyPollutionSessions: true,
    leftSidebarCollapsed: false,
    leftSidebarWidth: 256,
    rightInspectorCollapsed: false,
    rightInspectorWidth: 420,
    activeInspectorTab: 'context',
    splitRatio: 0.5,
  };

  const messagesBySession = {
    'sess-plan-qa': [
      {
        id: 'm-plan-u1',
        sessionId: 'sess-plan-qa',
        role: 'user',
        content: '请先梳理 v0.3.5 重构方案并在 Plan 模式提出需要确认的问题。',
        createdAt: '2026-11-27T03:01:00.000Z',
      },
      {
        id: 'm-plan-a-fail',
        sessionId: 'sess-plan-qa',
        role: 'assistant',
        content: '上一轮原生改写跟进示例（确认未送达，提供唯一重新发送按钮）：',
        question: {
          id: 'q-prev-fail',
          message: '上一轮配置确认',
          state: 'answered',
          answer: '数据库 · SQLite WAL',
          fields: [],
        },
        questionFollowup: {
          questionMessageId: 'm-plan-a-fail',
          submissionId: 'sub-fail-001',
          state: 'failed-unsent',
          detail: '本地通道临时中断（确认未投递）',
        },
        createdAt: '2026-11-27T03:02:00.000Z',
        completedAt: '2026-11-27T03:02:05.000Z',
      },
      {
        id: 'm-plan-a-unk',
        sessionId: 'sess-plan-qa',
        role: 'assistant',
        content: '历史断连恢复示例（状态未知，绝不自动重发）：',
        question: {
          id: 'q-prev-unk',
          message: '断连状态确认',
          state: 'answered',
          answer: '确认继续',
          fields: [],
        },
        questionFollowup: {
          questionMessageId: 'm-plan-a-unk',
          submissionId: 'sub-unk-002',
          state: 'unknown',
          detail: '请核对后续对话是否已收到',
        },
        createdAt: '2026-11-27T03:03:00.000Z',
        completedAt: '2026-11-27T03:03:04.000Z',
      },
      {
        id: 'm-plan-a-open',
        sessionId: 'sess-plan-qa',
        role: 'assistant',
        content: '我已草拟完实施计划，并准备好了 `implementation_plan.md`。请在下方卡片逐题确认 4 项细节：',
        question: data.fourQuestion,
        createdAt: '2026-11-27T03:14:00.000Z',
      },
    ],
    'sess-p2-showcase': [
      {
        id: 'm-p2-u1',
        sessionId: 'sess-p2-showcase',
        role: 'user',
        content: '请展示 P2 全部视觉修复效果（>40 行代码折叠、GFM 中文 Callout 与 CSP 远程图胶囊）。',
        createdAt: '2026-11-27T03:05:00.000Z',
      },
      {
        id: 'm-p2-a1',
        sessionId: 'sess-p2-showcase',
        role: 'assistant',
        content: data.p2Markdown,
        createdAt: '2026-11-27T03:05:10.000Z',
        completedAt: '2026-11-27T03:05:18.000Z',
        turnStartedAt: '2026-11-27T03:05:00.000Z',
        turnSettledAt: '2026-11-27T03:05:18.000Z',
      },
    ],
  };

  const inspectorBySession = {
    'sess-plan-qa': {
      sessionId: 'sess-plan-qa',
      diffs: [],
      terminals: [],
      todos: [
        { id: 't1', content: '升级 OKLCH 热力图色阶与 7d/30d 布局', status: 'completed' },
        { id: 't2', content: '接入 Plan 提问卡片 v2 步进器与右上角铅笔编辑', status: 'in_progress' },
        { id: 't3', content: '等待补充 macOS 真机签名回归验证', status: 'pending' },
        { id: 't4', content: '跳过已废弃的 Orchestrator 双模型旧配置', status: 'skipped' },
        {
          id: 't5',
          content:
            '校验超长路径折行：src/main/services/very-deeply-nested-directory-structure/plan-artifact-security-boundary-and-utf8-truncation-guard-v035.ts',
          status: 'failed',
        },
        { id: 't6', content: '等待外部审批网关回执', status: 'unknown', rawStatus: 'waiting-ci-gate' },
      ],
      plan: {
        state: 'present',
        revision: 7,
        truncated: true,
        totalCount: 101,
        completedCount: 42,
        failedCount: 1,
      },
    },
    'sess-p2-showcase': {
      sessionId: 'sess-p2-showcase',
      diffs: [],
      terminals: [],
      todos: [],
    },
  };

  const planArtifactDoc = {
    status: 'ready',
    owner: { profileId: 'profile-work', sessionId: 'sess-plan-qa' },
    revision: 7,
    filePath: 'C:\\Temp\\gravity-qa-isolated-profile\\brain\\sess-plan-qa\\implementation_plan.md',
    truncated: true,
    updatedAt: '2026-11-27T03:12:00.000Z',
    content: [
      '# Gravity v0.3.5 实施计划',
      '',
      '## 1. 验收里程碑',
      '- [x] OKLCH 5 阶热力图与 6 主题视觉验收',
      '- [x] Plan 提问卡 v2 步进器 + 铅笔就地编辑',
      '- [ ] 完成 [安全边界检查](#2-安全与隐私红线)',
      '',
      '## 2. 安全与隐私红线',
      '本只读预览绝不自动加载任何远程图片信标：',
      '',
      '![远端信标拦截](https://blocked.example.com/plan-beacon.png)',
      '',
      '参考：[外部规范](https://example.com/spec) · [本地代码](./src/renderer/components/PlanArtifactPanel.tsx)',
    ].join('\n'),
  };

  const telemetry = {
    generatedAt: '2026-11-27T03:15:00.000Z',
    pricingSource: 'reference-api-estimate',
    activeSessions: {
      'sess-plan-qa': {
        sessionId: 'sess-plan-qa',
        modelId: 'gemini-4-neon',
        usedContextTokens: 148_000,
        maxContextTokens: 1_000_000,
        usageRatio: 0.148,
        pressureLevel: 'healthy',
        breakdown: {
          systemAndRulesTokens: 18_000,
          userMessagesTokens: 32_000,
          agentMessagesTokens: 46_000,
          thoughtTokens: 14_000,
          toolCallsTokens: 28_000,
          attachmentsTokens: 10_000,
        },
        attachments: [],
        compactions: [],
        currentTokensPerSecond: 84,
        averageTokensPerSecond: 72,
        peakTokensPerSecond: 112,
        averageCacheHitRate: 0.37,
        costSummary: data.costSummary.today,
        usageSource: 'acp-reported',
        pricingSource: 'reference-api-estimate',
        updatedAt: '2026-11-27T03:15:00.000Z',
      },
      'sess-p2-showcase': {
        sessionId: 'sess-p2-showcase',
        modelId: 'gemini-4-neon',
        usedContextTokens: 42_000,
        maxContextTokens: 0,
        usageRatio: 0,
        pressureLevel: 'healthy',
        breakdown: {
          systemAndRulesTokens: 8_000,
          userMessagesTokens: 10_000,
          agentMessagesTokens: 14_000,
          thoughtTokens: 4_000,
          toolCallsTokens: 4_000,
          attachmentsTokens: 2_000,
        },
        attachments: [],
        compactions: [],
        currentTokensPerSecond: 65,
        averageTokensPerSecond: 61,
        peakTokensPerSecond: 96,
        costSummary: { ...data.costSummary.today, totalCostUsd: 0.42 },
        usageSource: 'acp-reported',
        pricingSource: 'reference-api-estimate',
        updatedAt: '2026-11-27T03:15:00.000Z',
      },
    },
    rateCards: [],
    hourly24h: data.hourly24h,
    daily7d: data.daily7d,
    matrix7d: [],
    calendar30d: data.calendar30d,
    costByRange: data.costSummary,
    modelBreakdownByRange: {
      today: [
        {
          modelId: 'gemini-4-neon',
          displayName: 'Gemini 4 Neon',
          ...data.costSummary.today,
          shareRatio: 0.72,
        },
        {
          modelId: 'claude-opus-5.5',
          displayName: 'Claude Opus 5.5',
          ...data.costSummary.today,
          totalTokens: 480_000,
          totalCostUsd: 1.35,
          shareRatio: 0.28,
        },
      ],
      '7d': [],
      '30d': [],
    },
    sessionModelBreakdowns: {},
  };

  const p2Tree = {
    rootSessionId: 'sess-p2-showcase',
    rootTitle: 'v0.3.5 MO-01 流式态与 P2 排版视觉验收',
    activeBranchId: 'sess-p2-showcase',
    totalBranches: 2,
    updatedAt: '2026-11-27T03:15:00.000Z',
    nodes: [
      {
        branchId: 'sess-p2-showcase',
        rootSessionId: 'sess-p2-showcase',
        parentBranchId: null,
        forkAfterMessageId: null,
        forkUserTurnIndex: -1,
        forkPromptPreview: '主分支：展示 P2 全部视觉修复效果',
        createdAt: '2026-11-27T03:05:00.000Z',
        updatedAt: '2026-11-27T03:15:00.000Z',
        childrenIds: ['sess-p2-branch-2'],
        depth: 0,
        siblingIndex: 1,
        siblingCount: 1,
        isActiveBranch: true,
        isOnActivePath: true,
        userTurnCount: 1,
        ownMessageCount: 2,
        latestUserPreview: '请展示 P2 全部视觉修复效果',
        latestAssistantPreview: 'Gravity v0.3.5 P2 排版与安全胶囊抽检',
        status: 'idle',
        modelId: 'gemini-4-neon',
        usedContextTokens: 42_000,
        maxContextTokens: 0,
        usageRatio: 0,
        totalCostUsd: 0.42,
      },
      {
        branchId: 'sess-p2-branch-2',
        rootSessionId: 'sess-p2-showcase',
        parentBranchId: 'sess-p2-showcase',
        forkAfterMessageId: 'm-p2-u1',
        forkUserTurnIndex: 0,
        forkPromptPreview: '备选分支：使用 Flash 快速验证',
        createdAt: '2026-11-27T03:08:00.000Z',
        updatedAt: '2026-11-27T03:12:00.000Z',
        childrenIds: [],
        depth: 1,
        siblingIndex: 2,
        siblingCount: 2,
        isActiveBranch: false,
        isOnActivePath: false,
        userTurnCount: 1,
        ownMessageCount: 2,
        latestUserPreview: '改用 Flash 模型',
        latestAssistantPreview: '已切换至 Flash 模型',
        status: 'idle',
        modelId: 'gemini-3.8-flash',
        usedContextTokens: 18_500,
        maxContextTokens: 256_000,
        usageRatio: 0.072,
        totalCostUsd: 0.065,
      },
    ],
    nodesById: {},
  };
  p2Tree.nodesById = Object.fromEntries(p2Tree.nodes.map((n) => [n.branchId, n]));

  const translationConfig = {
    engine: 'local',
    externalTranslator: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      hasApiKey: true,
      timeoutMs: 8000,
      maxOutputTokens: 2048,
      thinkingLevel: 'auto',
    },
  };

  const bridge = {
    getBootstrap: async () => ({
      preferences,
      connection,
      accounts,
      approvalConfig,
      translationConfig,
      sessions,
      layout,
      pendingApprovals: [],
      activeReviews: [],
      telemetry,
      plugins,
      windowChrome: 'standard',
      updateState: {
        status: 'up-to-date',
        currentVersion: '0.3.5',
        repoUrl: 'https://github.com/Mikotou/G-Gravity',
        canInstallDirectly: false,
      },
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
    openLinkOrFileTarget: async (input) => ({
      opened: true,
      modeUsed: input.action || 'browser',
      resolvedTarget: input.target,
    }),
    copyText: async () => undefined,
    inspectLocalTargets: async () => ({ items: {} }),
    selectDirectory: async () => null,
    checkForUpdates: async () => ({ status: 'up-to-date', currentVersion: '0.3.5', repoUrl: 'https://github.com/Mikotou/G-Gravity' }),
    downloadUpdate: async () => ({ status: 'idle', currentVersion: '0.3.5', repoUrl: 'https://github.com/Mikotou/G-Gravity' }),
    installUpdate: async () => ({ launched: false, message: 'disabled in offline qa' }),
    getConnectionStatus: async () => connection,
    getAccountsState: async () => accounts,
    createAccountProfile: async () => accounts,
    deleteAccountProfile: async () => accounts,
    switchAccountProfile: async () => accounts,
    getAccountQuota: async () => ({
      profileId: 'profile-work',
      checkedAt: '2026-11-27T03:15:00.000Z',
      buckets: [
        { id: 'gemini-weekly', remainingFraction: 0.84 },
        { id: 'gemini-5h', remainingFraction: 0.92 },
      ],
    }),
    launchOfficialLogin: async () => ({ launched: false, message: 'offline' }),
    officialLogout: async () => ({ loggedOut: false }),
    listSessions: async () => sessions,
    createSession: async () => sessions[0],
    resumeSession: async (id) => sessions.find((s) => s.sessionId === id) || sessions[0],
    closeSession: async () => undefined,
    manageSession: async () => ({ sessions, layout }),
    answerQuestion: async (input) => ({ mode: input.delivery || 'form', submissionId: input.submissionId || 'sub-qa', followupState: 'queued' }),
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
      if (input.sessionId === 'sess-plan-qa') return planArtifactDoc;
      return { status: 'missing', owner: { profileId: input.profileId, sessionId: input.sessionId }, revision: 0 };
    },
    listWorkspaceFiles: async () => ['src/renderer/App.tsx', 'src/renderer/components/PlanArtifactPanel.tsx'],
    reviseMessage: async () => sessions[0],
    getConversationTree: async (id) =>
      id === 'sess-p2-showcase'
        ? p2Tree
        : {
            rootSessionId: id,
            rootTitle: 'Single',
            activeBranchId: id,
            totalBranches: 1,
            updatedAt: '2026-11-27T03:15:00.000Z',
            nodes: [],
            nodesById: {},
          },
    switchConversationBranch: async () => {
      throw new Error('not used');
    },
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
    listSessionApprovalGrants: async (sessionId) => ({
      sessionId,
      delegatedToGuardian: false,
      prefixes: [],
    }),
    revokeSessionApprovalGrant: async (input) => ({
      sessionId: input.sessionId,
      delegatedToGuardian: false,
      prefixes: [],
    }),
    cancelStage2ApprovalReview: async () => ({ cancelled: true }),
    testExternalReviewerConnection: async () => ({ ok: true, latencyMs: 12 }),
    listApprovalAudit: async () => auditEntries,
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
      channels: ['general'],
      workers: [],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 },
      updatedAt: '2026-11-27T03:15:00.000Z',
    }),
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
  };

  window.gravityDesktop = bridge;
  window.__v035Qa = {
    setSessionStatus(sessionId, status) {
      sessions = sessions.map((s) => (s.sessionId === sessionId ? { ...s, status } : s));
      const updated = sessions.find((s) => s.sessionId === sessionId);
      if (updated) chSession.emit(updated);
    },
    emitTree(sessionId) {
      if (sessionId === 'sess-p2-showcase') chTree.emit(p2Tree);
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
  await delay(140);
}

async function setInspectorWidth(page, widthPx) {
  await page.evaluate((w) => {
    const aside = document.querySelector('[data-testid="right-inspector"]');
    if (aside) aside.style.width = `${w}px`;
  }, widthPx);
  await delay(160);
}

async function main() {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const { server, baseUrl, port } = await startDistServer();
  let browser;
  const pageErrors = [];
  const externalRequests = [];
  const report = { m1: [], m2: [], m3: {}, m4: {}, m5: {}, m6: {} };

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
      if (msg.type() === 'error') console.error('[CONSOLE ERROR]', msg.text());
    });

    // 严格离线拦截：只放行本机 127.0.0.1:<port> 的 dist/renderer 静态资源
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://127.0.0.1:${port}/`) || url.startsWith('data:') || url.startsWith('blob:')) {
        return route.continue();
      }
      externalRequests.push(url);
      return route.abort();
    });

    const fixtureData = buildBridgeInitScript();
    await page.addInitScript(injectOfflineDesktopBridge, fixtureData);

    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('agy-app-root').waitFor({ timeout: 15000 });
    await page.getByTestId('token-heatmap-section').waitFor({ timeout: 15000 });
    await delay(250);

    /* =====================================================================
     * M1: 6 套真实预设主题 × 热力图 24h / 7d / 30d + 暗/亮双全景图
     * =================================================================== */
    await setInspectorWidth(page, 420);
    for (const theme of ALL_THEMES) {
      await selectThemeViaUi(page, theme);
      const hm = page.getByTestId('token-heatmap-section');

      // 24h
      await page.getByTestId('heatmap-range-24h').click();
      await delay(100);
      await hm.scrollIntoViewIfNeeded();
      const check24 = await hm.evaluate((el) => {
        const bars = Array.from(el.querySelectorAll('.hm-bar'));
        const capped = bars.filter((b) => b.classList.contains('has-cap')).length;
        const overflow = Math.round(el.scrollWidth - el.clientWidth);
        const hmVars = [0, 1, 2, 3, 4].map((i) => getComputedStyle(document.documentElement).getPropertyValue(`--hm-${i}`).trim());
        const borderVar = getComputedStyle(document.documentElement).getPropertyValue('--hm-0-border').trim();
        return { count: bars.length, capped, overflow, hmVars, borderVar };
      });
      assert.equal(check24.count, 24, `[M1 ${theme} 24h] expected 24 bars`);
      assert.ok(check24.capped > 0, `[M1 ${theme} 24h] expected low-bar caps (.has-cap)`);
      assert.ok(check24.overflow <= 1, `[M1 ${theme} 24h] horizontal overflow: ${check24.overflow}`);
      await hm.screenshot({ path: path.join(SCREENSHOT_DIR, `m1-${theme}-24h.png`) });

      // 7d（按日柱状图 + 与 24h 同款左侧 Token 用量刻度）
      await page.getByTestId('heatmap-range-7d').click();
      await delay(100);
      const check7 = await hm.evaluate((el) => {
        const cols = Array.from(el.querySelectorAll('[data-testid="heatmap-7d-matrix"] .heatmap-cell'));
        const bars = Array.from(el.querySelectorAll('[data-testid="heatmap-7d-matrix"] .hm-bar-7d'));
        const yTicks = Array.from(el.querySelectorAll('[data-testid="heatmap-y-scale"] > span')).map((s) => (s.textContent || '').trim());
        const ys = cols.map((c) => Math.round(c.getBoundingClientRect().y));
        const singleRow = ys.every((y) => Math.abs(y - ys[0]) <= 2);
        const todayCount = cols.filter((c) => c.getAttribute('aria-current') === 'date').length;
        const overflow = Math.round(el.scrollWidth - el.clientWidth);
        return { count: cols.length, barCount: bars.length, yTicks, singleRow, todayCount, overflow };
      });
      assert.equal(check7.count, 7, `[M1 ${theme} 7d] expected 7 day columns`);
      assert.equal(check7.barCount, 7, `[M1 ${theme} 7d] expected 7 day bars`);
      assert.equal(check7.yTicks.length, 3, `[M1 ${theme} 7d] expected 3 Y-axis token ticks`);
      assert.equal(check7.yTicks[2], '0', `[M1 ${theme} 7d] expected Y-axis bottom tick 0`);
      assert.equal(check7.singleRow, true, `[M1 ${theme} 7d] columns wrapped onto multiple rows`);
      assert.equal(check7.todayCount, 1, `[M1 ${theme} 7d] expected exactly 1 aria-current="date"`);
      assert.ok(check7.overflow <= 1, `[M1 ${theme} 7d] horizontal overflow: ${check7.overflow}`);
      await hm.screenshot({ path: path.join(SCREENSHOT_DIR, `m1-${theme}-7d.png`) });

      // 30d
      await page.getByTestId('heatmap-range-30d').click();
      await delay(100);
      const check30 = await hm.evaluate((el) => {
        const cells = Array.from(el.querySelectorAll('[data-testid="heatmap-30d-calendar"] .heatmap-cell'));
        const maxAspectDiff = Math.max(
          ...cells.map((c) => {
            const r = c.getBoundingClientRect();
            return Math.abs(r.width - r.height);
          })
        );
        const overflow = Math.round(el.scrollWidth - el.clientWidth);
        return { count: cells.length, maxAspectDiff: Number(maxAspectDiff.toFixed(2)), overflow };
      });
      assert.equal(check30.count, 30, `[M1 ${theme} 30d] expected 30 calendar cells`);
      assert.ok(check30.maxAspectDiff <= 1.5, `[M1 ${theme} 30d] non-square cell |w-h|=${check30.maxAspectDiff}`);
      assert.ok(check30.overflow <= 1, `[M1 ${theme} 30d] horizontal overflow: ${check30.overflow}`);
      await hm.screenshot({ path: path.join(SCREENSHOT_DIR, `m1-${theme}-30d.png`) });

      if (theme === 'claude-code-dark' || theme === 'claude-code-light') {
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `m1-panorama-${theme}.png`) });
      }
      report.m1.push({ theme, check24: { capped: check24.capped, overflow: check24.overflow }, check7, check30 });
    }
    console.log('[M1] Passed all 6 preset themes × 24h / 7d / 30d');

    /* =====================================================================
     * M2: Inspector 响应宽度 280px (219px 净宽) / 380px / 540px / 680px
     * =================================================================== */
    await selectThemeViaUi(page, 'claude-code-light');
    for (const widthPx of [280, 380, 540, 680]) {
      if (widthPx === 540) await selectThemeViaUi(page, 'claude-code-dark');
      await setInspectorWidth(page, widthPx);
      const hm = page.getByTestId('token-heatmap-section');

      await page.getByTestId('heatmap-range-7d').click();
      await delay(120);
      await hm.scrollIntoViewIfNeeded();
      const d7 = await hm.evaluate((el) => {
        const cardW = Math.round(el.getBoundingClientRect().width);
        const shortWd = el.querySelector('.hm-7d-axis-short');
        const wd = el.querySelector('.hm-7d-axis-wd');
        const dateEl = el.querySelector('.hm-7d-axis-date');
        const yScale = el.querySelector('[data-testid="heatmap-y-scale"]');
        return {
          cardW,
          overflow: Math.round(el.scrollWidth - el.clientWidth),
          yScaleVisible: yScale ? getComputedStyle(yScale).display !== 'none' : false,
          shortWdVisible: shortWd ? getComputedStyle(shortWd).display !== 'none' : false,
          wdVisible: wd ? getComputedStyle(wd).display !== 'none' : false,
          dateVisible: dateEl ? getComputedStyle(dateEl).display !== 'none' : false,
        };
      });
      assert.ok(d7.overflow <= 1, `[M2 ${widthPx}px 7d] overflow=${d7.overflow}`);
      assert.equal(d7.yScaleVisible, true, `[M2 ${widthPx}px 7d] expected Y-axis token scale visible`);
      if (widthPx === 280) {
        assert.equal(d7.shortWdVisible, true, '[M2 280px 7d] expected compact short weekday visible');
        assert.equal(d7.wdVisible, false, '[M2 280px 7d] expected full weekday hidden in compact mode');
        await hm.screenshot({ path: path.join(SCREENSHOT_DIR, 'm2-280px-7d-light.png') });
      }
      if (widthPx === 380) {
        assert.equal(d7.wdVisible, true, '[M2 380px 7d] expected weekday visible');
        assert.equal(d7.dateVisible, true, '[M2 380px 7d] expected date visible at 380px');
        await hm.screenshot({ path: path.join(SCREENSHOT_DIR, 'm2-380px-7d-light.png') });
      }
      if (widthPx === 540) {
        assert.equal(d7.dateVisible, true, '[M2 540px 7d] expected date visible at 540px');
      }

      await page.getByTestId('heatmap-range-30d').click();
      await delay(120);
      const d30 = await hm.evaluate((el) => {
        const cells = Array.from(el.querySelectorAll('[data-testid="heatmap-30d-calendar"] .heatmap-cell'));
        const maxAspectDiff = Math.max(...cells.map((c) => Math.abs(c.getBoundingClientRect().width - c.getBoundingClientRect().height)));
        const weekLabel = el.querySelector('.hm-week-label');
        const weekTotal = el.querySelector('.hm-week-total');
        return {
          overflow: Math.round(el.scrollWidth - el.clientWidth),
          maxAspectDiff: Number(maxAspectDiff.toFixed(2)),
          weekLabelVisible: weekLabel ? getComputedStyle(weekLabel).display !== 'none' : false,
          weekTotalVisible: weekTotal ? getComputedStyle(weekTotal).display !== 'none' : false,
        };
      });
      assert.ok(d30.overflow <= 1, `[M2 ${widthPx}px 30d] overflow=${d30.overflow}`);
      assert.ok(d30.maxAspectDiff <= 1.5, `[M2 ${widthPx}px 30d] non-square cell |w-h|=${d30.maxAspectDiff}`);
      if (widthPx === 280) {
        assert.equal(d30.weekLabelVisible, false, '[M2 280px 30d] expected week label hidden at 280px');
        await hm.screenshot({ path: path.join(SCREENSHOT_DIR, 'm2-280px-30d-light.png') });
      }
      if (widthPx === 540) {
        assert.equal(d30.weekTotalVisible, true, '[M2 540px 30d] expected week total visible at 540px');
        await hm.screenshot({ path: path.join(SCREENSHOT_DIR, 'm2-540px-30d-dark.png') });
      }
      if (widthPx === 680) {
        assert.equal(d30.weekTotalVisible, true, '[M2 680px 30d] expected week total visible at 680px');
        await hm.screenshot({ path: path.join(SCREENSHOT_DIR, 'm2-680px-30d-dark.png') });
      }
      report.m2.push({ widthPx, d7, d30 });
    }
    await setInspectorWidth(page, 400);
    console.log('[M2] Passed Inspector responsive widths 280/380/540/680px');

    /* =====================================================================
     * M3: Plan 提问卡 v2（4 题步进器、铅笔编辑+还原、自定义恢复、v2 预览、failed-unsent/unknown、窄双屏）
     * =================================================================== */
    await selectThemeViaUi(page, 'claude-code-dark');
    const qBar = page.getByTestId('question-bar');
    await qBar.waitFor({ timeout: 10000 });

    // 1) 点选选项不切题 + 点击未选中项铅笔进入就地编辑
    await qBar.getByRole('radio', { name: /SQLite WAL/ }).click();
    assert.equal((await page.getByTestId('question-step-count').textContent()).trim(), '1/4');
    await qBar.getByRole('button', { name: '编辑选项「原子临时文件 + JSONL」' }).click();
    const editInput = qBar.getByRole('textbox', { name: '修改选项 原子临时文件 + JSONL' });
    await editInput.fill('原子临时文件 + JSONL（启用 fsync 刷盘）');
    await delay(100);
    await qBar.screenshot({ path: path.join(SCREENSHOT_DIR, 'm3-question-pencil-editing.png') });

    // Enter 确认不提交 -> 显示 已编辑 + 还原按钮
    await editInput.press('Enter');
    await delay(100);
    assert.ok(await qBar.getByText('已编辑').isVisible());
    assert.ok(await qBar.getByRole('button', { name: '还原选项「原子临时文件 + JSONL」' }).isVisible());
    await qBar.screenshot({ path: path.join(SCREENSHOT_DIR, 'm3-question-edited-and-restore.png') });

    // 2) 自定义回答 -> 切回选项 -> 显示自定义草稿恢复条
    await qBar.getByRole('button', { name: '自定义回答' }).click();
    await qBar.getByRole('textbox', { name: '自定义回答' }).fill('结合 SQLite WAL 与定期快照导出');
    await qBar.getByRole('radio', { name: /原子临时文件/ }).click();
    await page.getByTestId('question-custom-restore').waitFor();
    await delay(100);
    await qBar.screenshot({ path: path.join(SCREENSHOT_DIR, 'm3-question-custom-restore.png') });

    // 3) 填完第 2/3 题 -> 点发送进入 v2 改写预览页
    await page.getByTestId('question-next').click();
    await qBar.getByRole('checkbox', { name: /无障碍键盘漫游/ }).click();
    await qBar.getByRole('checkbox', { name: /6 主题 Playwright/ }).click();
    await page.getByTestId('question-next').click();
    await qBar.getByRole('textbox', { name: /误差阈值/ }).fill('-2.5');
    await page.getByTestId('question-send').click();
    await page.getByTestId('question-followup-preview').waitFor();
    assert.equal(await page.getByTestId('question-stepper').count(), 0);
    await delay(100);
    await qBar.screenshot({ path: path.join(SCREENSHOT_DIR, 'm3-question-v2-preview.png') });

    // 返回正常答题态并截取消息流中的 failed-unsent vs unknown 投递状态条
    await page.getByTestId('question-followup-back').click();
    const failStrip = page.getByTestId('question-followup-m-plan-a-fail');
    const unkStrip = page.getByTestId('question-followup-m-plan-a-unk');
    await failStrip.scrollIntoViewIfNeeded();
    assert.equal(await failStrip.getByRole('button').count(), 1);
    assert.equal(await unkStrip.getByRole('button').count(), 0);
    await page.locator('[data-testid="session-pane-sess-plan-qa"] .stream').screenshot({
      path: path.join(SCREENSHOT_DIR, 'm3-followup-failed-vs-unknown.png'),
    });

    // 4) 窄双屏 <420px 步进器折叠（隐藏 .qb-pills，保留 1/4 + 左右箭头，0 横向溢出）
    await page.setViewportSize({ width: 960, height: 760 });
    await page.getByTestId('toggle-right-inspector-btn').click();
    await page.getByTestId('layout-btn-split-2').click();
    await delay(200);
    const narrowCheck = await qBar.evaluate((el) => {
      const w = Math.round(el.getBoundingClientRect().width);
      const pills = el.querySelector('.qb-pills');
      const pillsHidden = pills ? getComputedStyle(pills).display === 'none' : false;
      const stepCount = el.querySelector('[data-testid="question-step-count"]')?.textContent?.trim() || '';
      return { w, pillsHidden, stepCount, overflow: Math.round(el.scrollWidth - el.clientWidth) };
    });
    assert.ok(narrowCheck.w < 420, `[M3 narrow] expected question-bar width < 420px, got ${narrowCheck.w}`);
    assert.equal(narrowCheck.pillsHidden, true, '[M3 narrow] expected .qb-pills hidden under 420px');
    assert.ok(narrowCheck.overflow <= 1, `[M3 narrow] horizontal overflow=${narrowCheck.overflow}`);
    await qBar.screenshot({ path: path.join(SCREENSHOT_DIR, 'm3-question-narrow-split2.png') });
    report.m3 = { narrowCheck };

    // 恢复单栏 1440×900 并重新打开 Inspector
    await page.getByTestId('layout-btn-single').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('toggle-right-inspector-btn').click();
    await delay(180);
    console.log('[M3] Passed Plan QuestionBar v2 & narrow <420px stepper collapse');

    /* =====================================================================
     * M4: 右侧 Plan 页 6 态待办 + 截断横幅 + 长路径折行 + 只读 implementation_plan.md
     * =================================================================== */
    await setInspectorWidth(page, 380);
    await page.getByTestId('inspector-tab-plan').click();
    await page.getByTestId('plan-artifact-document').waitFor({ timeout: 10000 });
    await delay(150);
    const planView = page.getByTestId('inspector-view-plan');
    const planCheck = await planView.evaluate((el) => {
      const items = Array.from(el.querySelectorAll('[data-testid^="plan-item-"]')).map((n) => n.dataset.status);
      const bar = el.querySelector('[data-testid="plan-progressbar"]');
      const barWidth = bar ? Math.round(bar.getBoundingClientRect().width) : 0;
      const doc = el.querySelector('[data-testid="plan-artifact-document"]');
      const imgsInDoc = doc ? doc.querySelectorAll('img').length : -1;
      const overflow = Math.round(el.scrollWidth - el.clientWidth);
      const truncatedHint = Boolean(el.querySelector('[data-testid="plan-truncated-hint"]'));
      const artifactTruncated = (el.textContent || '').includes('文档较长，仅显示前一部分');
      return { items, barWidth, imgsInDoc, overflow, truncatedHint, artifactTruncated };
    });
    assert.deepEqual(planCheck.items, ['completed', 'in_progress', 'pending', 'skipped', 'failed', 'unknown']);
    assert.ok(planCheck.barWidth > 40, `[M4] progressbar width too small: ${planCheck.barWidth}`);
    assert.equal(planCheck.imgsInDoc, 0, '[M4] plan artifact rendered <img> tag');
    assert.ok(planCheck.overflow <= 1, `[M4] plan view horizontal overflow: ${planCheck.overflow}`);
    assert.equal(planCheck.truncatedHint, true);
    assert.equal(planCheck.artifactTruncated, true);
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'm4-plan-tab-and-artifact.png') });
    report.m4 = planCheck;
    console.log('[M4] Passed Plan 6-state todos, wrapping & readonly implementation_plan.md');

    /* =====================================================================
     * M5: 设置中心 8 项导航 + 外观 3 二级页签 + Approvals 规则 & C1 三色徽章（暗+亮）+ Plugins 隔离横幅
     * =================================================================== */
    await page.keyboard.press('Control+,');
    const settingsModal = page.getByTestId('theme-settings-modal');
    await settingsModal.waitFor();
    const navIds = await settingsModal.locator('.settings-nav .settings-nav-item').evaluateAll((els) => els.map((e) => e.dataset.testid));
    assert.equal(navIds.length, 8, `[M5] expected 8 settings nav items, got ${navIds.length}`);
    assert.ok(!(await settingsModal.textContent()).match(/orchestrator|规划执行双模型/i), '[M5] unexpected Orchestrator text');

    await page.getByTestId('settings-tab-themes').click();
    await delay(120);
    const subTabsCount = await page.getByTestId('settings-appearance-subnav').getByRole('tab').count();
    assert.equal(subTabsCount, 3, '[M5] expected 3 Appearance subtabs');
    await settingsModal.screenshot({ path: path.join(SCREENSHOT_DIR, 'm5-settings-appearance-dark.png') });

    // Approvals Rules (top + scrolled pattern list)
    await page.getByTestId('settings-tab-approvals').click();
    await page.getByTestId('drawer-tab-rules').click();
    await delay(120);
    assert.ok(await page.getByTestId('pattern-legacy-blank-allowPatterns-0').isVisible());
    assert.ok(await page.getByTestId('pattern-legacy-whitespace-allowPatterns-1').isVisible());
    assert.ok(await page.getByTestId('pattern-conflict-warning-allowPatterns-2').isVisible());
    assert.ok(await page.getByTestId('pattern-broad-warning-allowPatterns-3').isVisible());
    await settingsModal.screenshot({ path: path.join(SCREENSHOT_DIR, 'm5-approvals-rules-dark.png') });
    await page.getByTestId('pattern-legacy-blank-allowPatterns-0').scrollIntoViewIfNeeded();
    await delay(100);
    await settingsModal.screenshot({ path: path.join(SCREENSHOT_DIR, 'm5-approvals-rules-list-dark.png') });

    // Approvals Audit C1 三色徽章（Dark）
    await page.getByTestId('drawer-tab-audit').click();
    await delay(120);
    const getC1Colors = () =>
      page.evaluate(() => {
        const read = (id) => {
          const el = document.querySelector(`[data-testid="audit-source-${id}"]`);
          const s = el ? getComputedStyle(el) : null;
          return s ? { color: s.color, bg: s.backgroundColor, text: el.textContent } : null;
        };
        return { ai: read('audit-c1-ai'), rule: read('audit-c1-rule'), user: read('audit-c1-user') };
      });
    const c1Dark = await getC1Colors();
    assert.equal(new Set([c1Dark.ai.color, c1Dark.rule.color, c1Dark.user.color]).size, 3, '[M5] C1 dark colors not distinct');
    await settingsModal.screenshot({ path: path.join(SCREENSHOT_DIR, 'm5-approvals-audit-c1-dark.png') });

    // Plugins 隔离账号横幅
    await page.getByTestId('settings-tab-plugins').click();
    await page.getByTestId('plugins-profile-scope-banner').waitFor();
    await delay(120);
    assert.equal(await page.getByTestId('plugins-profile-scope-banner').getAttribute('data-profile-isolated'), 'true');
    await settingsModal.screenshot({ path: path.join(SCREENSHOT_DIR, 'm5-plugins-isolated-banner.png') });

    // 切换亮色主题（claude-code-light）复查 Approvals Audit C1 三色徽章
    await page.getByTestId('settings-tab-themes').click();
    await page.getByTestId('theme-card-claude-code-light').click();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'claude-code-light');
    await page.getByTestId('settings-tab-approvals').click();
    await page.getByTestId('drawer-tab-audit').click();
    await delay(140);
    const c1Light = await getC1Colors();
    assert.equal(new Set([c1Light.ai.color, c1Light.rule.color, c1Light.user.color]).size, 3, '[M5] C1 light colors not distinct');
    await settingsModal.screenshot({ path: path.join(SCREENSHOT_DIR, 'm5-approvals-audit-c1-light.png') });
    await page.keyboard.press('Escape');
    await settingsModal.waitFor({ state: 'detached' });
    report.m5 = { navCount: navIds.length, subTabsCount, c1Dark, c1Light };
    console.log('[M5] Passed Settings 8-nav, Appearance 3-subtabs, C1 3-color audit (dark+light) & Plugins isolated banner');

    /* =====================================================================
     * M6: MO-01 流式态上浮菜单 0 裁切 + reduced-motion + P2 视觉抽检
     * =================================================================== */
    await selectThemeViaUi(page, 'claude-code-dark');
    await page.getByTestId('tab-item-sess-p2-showcase').click();
    await page.getByTestId('session-pane-sess-p2-showcase').waitFor();
    await delay(150);

    // 切至 streaming 态并展开 Composer 审批上浮菜单，验证 MO-01 流式光条独立裁切且 0 裁切上浮菜单
    await page.evaluate(() => window.__v035Qa.setSessionStatus('sess-p2-showcase', 'streaming'));
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="session-pane-sess-p2-showcase"]')?.getAttribute('data-pane-state') === 'streaming'
    );
    await page.getByTestId('approval-mode-pill-sess-p2-showcase').click();
    const popover = page.getByTestId('approval-menu-sess-p2-showcase');
    await popover.waitFor();
    await delay(140);
    const clipAudit = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid="session-pane-sess-p2-showcase"]');
      const composer = pane.querySelector('.composer');
      const pop = pane.querySelector('.popover');
      const pRect = pane.getBoundingClientRect();
      const cRect = composer.getBoundingClientRect();
      const mRect = pop.getBoundingClientRect();
      const runningAnims = document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName);
      return {
        paneOverflow: getComputedStyle(pane).overflow,
        composerOverflow: getComputedStyle(composer).overflow,
        popoverAboveComposer: mRect.top < cRect.top,
        popoverFullyInViewport: mRect.top >= 0 && mRect.bottom <= window.innerHeight && mRect.height > 80,
        popoverWithinPaneVertically: mRect.top >= pRect.top,
        hasActivityFlow: runningAnims.includes('gv-activity-flow'),
        hasBusyLine: runningAnims.includes('gv-busy-line'),
      };
    });
    assert.notEqual(clipAudit.paneOverflow, 'hidden', '[M6] .pane must not use overflow: hidden');
    assert.notEqual(clipAudit.composerOverflow, 'hidden', '[M6] .composer must not use overflow: hidden');
    assert.equal(clipAudit.popoverAboveComposer, true, '[M6] Composer popover did not float above composer');
    assert.equal(clipAudit.popoverFullyInViewport, true, `[M6] Composer popover clipped: ${JSON.stringify(clipAudit)}`);
    assert.equal(clipAudit.hasActivityFlow, true, '[M6] Expected gv-activity-flow running');
    assert.equal(clipAudit.hasBusyLine, true, '[M6] Expected gv-busy-line running');
    await page.getByTestId('session-pane-sess-p2-showcase').screenshot({
      path: path.join(SCREENSHOT_DIR, 'm6-mo01-streaming-popover-unclipped.png'),
    });

    // prefers-reduced-motion: reduce -> 0 无限动画
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await delay(120);
    const reducedInfinite = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running' && a.effect?.getTiming?.()?.iterations === Infinity)
          .map((a) => a.animationName)
    );
    assert.deepEqual(reducedInfinite, [], `[M6] Expected 0 infinite animations under reduced-motion, got ${JSON.stringify(reducedInfinite)}`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // 关闭 popover 并切回 idle，截取 P2 视觉抽检（>40 行折叠代码块 + GFM 中文 Callout + 远程图外链胶囊）
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.__v035Qa.setSessionStatus('sess-p2-showcase', 'idle');
      window.__v035Qa.emitTree('sess-p2-showcase');
    });
    await delay(180);
    const p2Audit = await page.locator('[data-testid="session-pane-sess-p2-showcase"] .stream').evaluate((el) => {
      const foldBtn = el.querySelector('[data-testid="code-fold-btn"]');
      const calloutTitles = Array.from(el.querySelectorAll('.md-alert-title')).map((n) => n.textContent?.trim());
      const capsule = el.querySelector('[data-testid="md-img-blocked-capsule"]');
      const imgs = el.querySelectorAll('img').length;
      return {
        foldExpanded: foldBtn?.getAttribute('aria-expanded'),
        calloutTitles,
        hasCapsule: Boolean(capsule),
        imgs,
      };
    });
    assert.equal(p2Audit.foldExpanded, 'false', '[M6 P2] >40-line code block should default to folded');
    assert.deepEqual(p2Audit.calloutTitles, ['注意', '警告', '小心'], '[M6 P2] GFM Callout Chinese titles mismatch');
    assert.equal(p2Audit.hasCapsule, true, '[M6 P2] Remote image capsule missing');
    assert.equal(p2Audit.imgs, 0, '[M6 P2] Blocked remote image must not render <img>');
    await page.locator('[data-testid="session-pane-sess-p2-showcase"] .stream').screenshot({
      path: path.join(SCREENSHOT_DIR, 'm6-p2-markdown-codefold-callout-capsule.png'),
    });
    // 滚到消息顶部截取 GFM 中文 Callout（注意/警告/小心）与 CSP 远程图外链胶囊
    await page.locator('[data-testid="session-pane-sess-p2-showcase"] .stream').evaluate((el) => {
      el.scrollTop = 0;
    });
    await delay(120);
    await page.locator('[data-testid="session-pane-sess-p2-showcase"] .stream').screenshot({
      path: path.join(SCREENSHOT_DIR, 'm6-p2-markdown-callouts-and-capsule.png'),
    });

    // 分支树模型与费用分离 & 上限未知
    await page.getByTestId('inspector-tab-context').click();
    await page.getByTestId('inspector-tab-tree').click();
    await page.getByTestId('conversation-tree-panel').waitFor();
    await delay(140);
    const treeAudit = await page.getByTestId('conversation-tree-panel').evaluate((el) => ({
      activeCtx: el.querySelector('[data-testid="conversation-tree-active-context"]')?.textContent || '',
      modelText: el.querySelector('[data-testid="tree-node-model-sess-p2-showcase"]')?.textContent || '',
      costText: el.querySelector('[data-testid="tree-node-cost-sess-p2-showcase"]')?.textContent || '',
    }));
    assert.ok(treeAudit.activeCtx.includes('上限未知') && !treeAudit.activeCtx.includes('512'), `[M6 Tree] ${treeAudit.activeCtx}`);
    assert.equal(treeAudit.modelText, 'gemini-4-neon');
    assert.equal(treeAudit.costText, '$0.420');
    await page.getByTestId('right-inspector').screenshot({ path: path.join(SCREENSHOT_DIR, 'm6-p2-conversation-tree.png') });

    report.m6 = { clipAudit, reducedInfiniteCount: reducedInfinite.length, p2Audit, treeAudit };
    console.log('[M6] Passed MO-01 streaming unclipped popover, reduced-motion & P2 visual showcase');

    assert.deepEqual(externalRequests, [], `Detected unexpected external network requests: ${JSON.stringify(externalRequests)}`);
    assert.deepEqual(pageErrors, [], `Detected pageerror(s): ${JSON.stringify(pageErrors)}`);

    console.log('\n=== V035_VISUAL_E2E_SUMMARY ===');
    console.log(JSON.stringify({ externalRequests: 0, pageErrors: 0, screenshotDir: SCREENSHOT_DIR, ...report }, null, 2));
    console.log('=== ALL M1–M6 PLAYWRIGHT VISUAL E2E CHECKS PASSED ===');
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('[V035-VISUAL-E2E FAILED]', err);
  process.exitCode = 1;
});

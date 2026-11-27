// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { buildAgyEnvironment } from '../src/main/acp/agy-environment';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { networkTargetFloor, screenCommand } from '../src/main/approval/shell-screening';
import { CoreService } from '../src/main/core-service';
import { openExternalTarget } from '../src/main/services/external-opener';
import { inspectLocalTargets } from '../src/main/services/local-media-inspector';
import { ConversationTreeStore } from '../src/main/session/conversation-tree-store';
import { InspectorStore } from '../src/main/session/inspector-store';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { WorkspaceFiles } from '../src/main/workspace/workspace-files';
import {
  buildDiagnosticBanner,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_MODEL_RATE_CARDS,
  isBareExtensionOrFragment,
  isExternalTranslatorConnected,
  isForbiddenCredentialOrStatePath,
  mergeTelemetryDashboard,
  normalizeWorkspacePath,
  parseMcpCommandLine,
  resolveModelRateCard,
  sameExternalService,
  withoutSessionPatch,
  writtenQuestion,
  type AcpRequestPermissionParams,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type PendingApprovalRequest,
  type TelemetryDashboardSnapshot,
  type WorkspaceLayoutState,
} from '../src/shared';
import { readAllSessionMessages } from './helpers/core-bridge';

/* ============================================================================
 * Helpers & Fixtures
 * ========================================================================== */

const tempDirs: string[] = [];
const services: CoreService[] = [];
const engines: ApprovalEngine[] = [];
const clients: AcpClient[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

class FakeRpcChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  sent: Array<Record<string, unknown>> = [];
  killed = false;
  stdin = new Writable({
    write: (chunk, _enc, done) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: number | string; method?: string };
        this.sent.push(msg);
        if (msg.method === 'initialize') {
          queueMicrotask(() =>
            this.emitMessage({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: 'v033-fake-acp', version: '1.0.0' },
                agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } },
              },
            })
          );
        }
      }
      done();
    },
  });
  constructor() {
    super();
    this.stdin.on('finish', () => setImmediate(() => this.emit('close', 0)));
  }
  emitMessage(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

function makeSpyCore() {
  const dir = makeTempDir('gravity-v033-core-bug-');
  const client = new AcpClient();
  const initRes = {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity CLI', version: '1.5.17' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
  };
  client.initializeResult = initRes;
  let connected = true;
  vi.spyOn(client, 'connected', 'get').mockImplementation(() => connected);
  vi.spyOn(client, 'start').mockImplementation(async () => {
    connected = true;
    return initRes;
  });
  vi.spyOn(client, 'stop').mockImplementation(async () => {
    connected = false;
  });
  vi.spyOn(client, 'notify').mockImplementation(() => {});

  let seq = 0;
  let promptHandler: (params: AcpSessionPromptParams, attempt: number) => Promise<AcpSessionPromptResult> | AcpSessionPromptResult =
    () => ({ stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 } });
  let promptCalls = 0;

  const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'session/new') {
      return {
        sessionId: `sess-v033-${++seq}`,
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
              { value: 'full-access', name: 'Turbo' },
            ],
          },
          {
            id: 'model',
            name: 'Model',
            currentValue: 'gemini-4-neon',
            options: [{ value: 'gemini-4-neon', name: 'Neon' }],
          },
        ],
      };
    }
    if (method === 'session/prompt') {
      promptCalls += 1;
      return promptHandler(params as AcpSessionPromptParams, promptCalls);
    }
    if (method === 'session/close') return {};
    return {};
  });

  const core = new CoreService({
    acp: client,
    dataDir: dir,
    homeDir: path.join(dir, 'home'),
    enableAutoUpdateCheck: false,
  });
  services.push(core);

  return {
    dir,
    client,
    core,
    requestSpy,
    setConnected(v: boolean) {
      connected = v;
    },
    setPromptHandler(fn: typeof promptHandler) {
      promptHandler = fn;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const s of services.splice(0)) await s.dispose().catch(() => {});
  for (const e of engines.splice(0)) e.dispose();
  for (const c of clients.splice(0)) await c.stop().catch(() => {});
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. Wave 0 Shared Layer Fixes (SH-01 ~ SH-10) — MUST PASS ON WAVE 0
 * ========================================================================== */

describe('Wave 0 共享层修复回归（SH-01 ~ SH-10）', () => {
  it('SH-01 (D3): isForbiddenCredentialOrStatePath 放行正常源码与官方技能，100% 拦截凭据与官方状态路径', () => {
    const allowedPaths = [
      'src/main/services/secret-vault.ts',
      'F:/work/G-Gravity/src/main/services/secret-vault.ts',
      'C:\\Users\\dev\\.gemini\\config\\plugins\\chrome-devtools-plugin\\skills\\cookie-debugging\\SKILL.md',
      '/Users/dev/.agents/skills/token-helper/SKILL.md',
      '/work/project/docs/password-policy.md',
    ];
    for (const p of allowedPaths) {
      expect(isForbiddenCredentialOrStatePath(p), `D3 must allow: ${p}`).toBe(false);
    }

    const blockedPaths = [
      'C:\\Users\\dev\\.gemini\\antigravity\\conversations\\state.pb',
      '/Users/dev/.gemini/user_settings.pb',
      'C:/work/oauth_token.json',
      '/Users/dev/.gemini/oauth_creds.json',
      '/Users/dev/project/.env',
      'C:\\work\\app\\.env.production',
      '/etc/passwd',
      '/etc/shadow',
      '/etc/sudoers',
      'C:\\certs\\private.key',
      '/Users/dev/certs/client.p12',
      '/Users/dev/.ssh/id_ed25519',
      '/Users/dev/.aws/credentials',
      '/Users/dev/.gemini/antigravity/state.vscdb',
      '/Users/dev/.gemini/antigravity/installation_id',
    ];
    for (const p of blockedPaths) {
      expect(isForbiddenCredentialOrStatePath(p), `D3 must block: ${p}`).toBe(true);
    }
  });

  it('SH-02: mergeTelemetryDashboard 增量推送为 undefined 时保留既有 externalReviewer 与 externalTranslator 统计', () => {
    const emptyCost = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      outputCostUsd: 0,
      thinkingCostUsd: 0,
      totalCostUsd: 0,
    };
    const fakeServiceStats = {
      bySession: { s1: { ...emptyCost, callCount: 3, lastUsedAt: '2026-11-25T00:00:00Z', providers: ['openai-compatible'] as const } },
      costByRange: { today: emptyCost, '7d': emptyCost, '30d': emptyCost },
      cumulativeAllTime: { ...emptyCost, callCount: 3 },
      hourly24h: [],
      matrix7d: [],
      calendar30d: [],
      modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
    };
    const previous: TelemetryDashboardSnapshot = {
      profileId: 'default',
      sequence: 1,
      activeSessions: {},
      hourly24h: [],
      matrix7d: [],
      calendar30d: [],
      costByRange: { today: emptyCost, '7d': emptyCost, '30d': emptyCost },
      modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
      sessionModelBreakdowns: {},
      rateCards: [],
      pricingSource: 'reference-api-estimate',
      generatedAt: '2026-11-25T00:00:00Z',
      externalReviewer: fakeServiceStats as unknown as TelemetryDashboardSnapshot['externalReviewer'],
      externalTranslator: fakeServiceStats as unknown as TelemetryDashboardSnapshot['externalTranslator'],
    };

    const incremental: TelemetryDashboardSnapshot = {
      ...previous,
      sequence: 2,
      changedSessionIds: ['s1'],
      generatedAt: '2026-11-25T00:01:00Z',
      externalReviewer: undefined,
      externalTranslator: undefined,
    };

    const merged = mergeTelemetryDashboard(previous, incremental);
    expect(merged.externalReviewer).toEqual(fakeServiceStats);
    expect(merged.externalTranslator).toEqual(fakeServiceStats);
  });

  it('SH-03: claude-opus-4-6 精确匹配 $5/$25 费率卡而非回退 default', () => {
    const card = resolveModelRateCard('claude-opus-4-6', DEFAULT_MODEL_RATE_CARDS);
    expect(card.modelId).toContain('claude-opus-4-6');
    expect(card.inputPerMillionUsd).toBe(5);
    expect(card.outputPerMillionUsd).toBe(25);
  });

  it('SH-04: normalizeWorkspacePath 保留非 URI 的 %20 目录名、不破坏 C:foo、并去除 UNC 尾斜杠', () => {
    expect(normalizeWorkspacePath('C:\\Users\\dev\\folder%20name')).toBe('C:\\Users\\dev\\folder%20name');
    expect(normalizeWorkspacePath('/home/dev/dir%20one')).toBe('/home/dev/dir%20one');
    expect(normalizeWorkspacePath('file:///C:/Users/My%20Project')).toBe('C:\\Users\\My Project');
    expect(normalizeWorkspacePath('/d%3A/my%20repo')).toBe('D:\\my repo');
    expect(normalizeWorkspacePath('C:foo')).not.toBe('C:\\foo');
    expect(normalizeWorkspacePath('\\\\server\\share\\proj\\')).toBe('\\\\server\\share\\proj');
  });

  it('SH-05: sanitizeDetail 脱敏 Google OAuth ya29.*、URL 内嵌账密与 ?key=/api_key=/token= 查询参数', () => {
    const raw =
      'Failed calling https://alice:SuperPass99@proxy.example.com/v1?key=AIzaSecretQuery12345&api_key=my_api_key_99&token=tok_abc_123456 with ya29.a0AfH6SMC1234567890abcdef';
    const banner = buildDiagnosticBanner('auth_required_401', { technicalDetail: raw });
    const detail = banner.technicalDetail || '';
    expect(detail).not.toContain('SuperPass99');
    expect(detail).not.toContain('AIzaSecretQuery12345');
    expect(detail).not.toContain('my_api_key_99');
    expect(detail).not.toContain('tok_abc_123456');
    expect(detail).not.toContain('ya29.a0AfH6SMC1234567890abcdef');
    expect(detail).toContain('[redacted]');
  });

  it('SH-06: isBareExtensionOrFragment 放行 ./.gitignore / .npmrc / .eslintrc，同时继续拒绝裸扩展名噪音', () => {
    for (const validDotfile of ['./.gitignore', '.gitignore', '.npmrc', '.eslintrc', '.prettierrc', 'src/.gitignore']) {
      expect(isBareExtensionOrFragment(validDotfile), `must allow dotfile: ${validDotfile}`).toBe(false);
    }
    for (const noise of ['.svg', '.png', '.ico', '-mac.png', '/.svg']) {
      expect(isBareExtensionOrFragment(noise), `must reject noise: ${noise}`).toBe(true);
    }
  });

  it('SH-07: writtenQuestion 要求围栏闭合行无尾部语言标签，防止嵌套代码块提前闭合误判提问', () => {
    const fencedOnly = [
      'Here is an example markdown snippet:',
      '```markdown',
      '```ts',
      'Which option do you prefer?',
      '1. Option A',
      '2. Option B',
      '```',
      'Done.',
    ].join('\n');
    expect(writtenQuestion(fencedOnly)).toBeUndefined();

    const genuineQuestion = [
      '```ts',
      'const x = 1;',
      '```',
      'Which approach should we take?',
      '1. Keep local storage',
      '2. Migrate to SQLite',
    ].join('\n');
    const parsed = writtenQuestion(genuineQuestion);
    expect(parsed).toBeDefined();
    expect(parsed?.fields[0]?.choices?.length).toBeGreaterThanOrEqual(2);
  });

  it('SH-08: parseMcpCommandLine 保留 Windows 路径末尾反斜杠（C:\\dir\\ arg2）', () => {
    expect(parseMcpCommandLine('C:\\dir\\ arg2')).toEqual(['C:\\dir\\', 'arg2']);
    expect(parseMcpCommandLine('C:\\Program Files\\tool.exe --flag')).toBeTruthy();
  });

  it('SH-09: isExternalTranslatorConnected 校验合法日期；sameExternalService 对 endpoint trim', () => {
    const baseCfg = {
      enabled: true,
      provider: 'openai-compatible' as const,
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-valid-key',
      timeoutMs: 4000,
      connectionStatus: 'connected' as const,
      verifiedBy: 'translation-call' as const,
    };
    expect(isExternalTranslatorConnected({ ...baseCfg, lastVerifiedAt: 'invalid-date-string' })).toBe(false);
    expect(isExternalTranslatorConnected({ ...baseCfg, lastVerifiedAt: '2026-11-25T10:00:00.000Z' })).toBe(true);

    expect(
      sameExternalService(
        { provider: 'openai-compatible', endpoint: '  https://api.openai.com/v1/  ' },
        { provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1' }
      )
    ).toBe(true);
  });

  it('SH-10: withoutSessionPatch 仅返回 3 个标签槽位局部字段，绝不覆盖 composerMinHeight 等无关布局项', () => {
    const layout: WorkspaceLayoutState = {
      layoutMode: 'split-2',
      openTabSessionIds: ['s1', 's2'],
      activePrimarySessionId: 's1',
      splitSecondarySessionId: 's2',
      leftSidebarCollapsed: false,
      rightInspectorCollapsed: false,
      leftSidebarWidth: 280,
      rightInspectorWidth: 360,
      splitRatio: 0.5,
      activeInspectorTab: 'context',
      hideLegacyPollutionSessions: true,
      composerMinHeight: 164,
    };
    const patch = withoutSessionPatch(layout, 's2');
    expect(Object.keys(patch).sort()).toEqual([
      'activePrimarySessionId',
      'openTabSessionIds',
      'splitSecondarySessionId',
    ]);
    expect(patch).toEqual({
      openTabSessionIds: ['s1'],
      activePrimarySessionId: 's1',
      splitSecondarySessionId: null,
    });
    expect(patch).not.toHaveProperty('composerMinHeight');
  });
});

/* ============================================================================
 * 2. Security Fixes (SEC-01 & SEC-02)
 * ========================================================================== */

describe('v0.3.3 安全防线回归（SEC-01 / SEC-02）', () => {
  it('SEC-01: Stage 1D 绝不自动放行 curl -sIL / --location，且 metadata.goog 与 169.254.170.2 触发 Tier A SSRF 阻断', async () => {
    const workspace = makeTempDir('gravity-v033-sec01-');
    const rulesCfg = { ...DEFAULT_APPROVAL_CONFIG, mode: 'rules-only' as const };

    expect(screenCommand('curl -sIL https://example.com', workspace, rulesCfg).verdict).not.toBe('auto_approve');
    expect(screenCommand('curl -sI --location https://example.com', workspace, rulesCfg).verdict).not.toBe('auto_approve');
    expect(screenCommand('curl -sI https://example.com', workspace, rulesCfg).verdict).toBe('auto_approve');

    expect(networkTargetFloor({ url: 'http://metadata.goog/computeMetadata/v1/' })).toBe('tier_a_immutable');
    expect(networkTargetFloor({ url: 'http://169.254.170.2/v2/credentials' })).toBe('tier_a_immutable');

    // Even with an overly permissive Stage 2 reviewer, metadata.goog and 169.254.170.2 MUST escalate to human
    const permissiveReviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'safe',
      riskScore: 1,
      intentAlignment: 'aligned',
      reason: 'mock compromised reviewer',
      latencyMs: 5,
    });
    const engine = new ApprovalEngine({
      store: new ClientStore(makeTempDir('gravity-v033-sec01-store-')),
      config: {
        mode: 'hybrid',
        externalReviewer: {
          enabled: true,
          provider: 'local-ollama',
          endpoint: 'http://127.0.0.1:11434',
          model: 'mock',
          timeoutMs: 2000,
          connectionStatus: 'connected',
          verificationMethod: 'review-call',
          lastVerifiedAt: '2026-11-25T00:00:00Z',
        },
      },
      reviewer: permissiveReviewer,
    });
    engines.push(engine);

    for (const cmd of [
      'curl -s http://metadata.goog/computeMetadata/v1/',
      'curl -s http://169.254.170.2/v2/credentials',
    ]) {
      let escalated: PendingApprovalRequest | undefined;
      const onReq = (card: PendingApprovalRequest) => {
        escalated = card;
        engine.cancelPending('s-sec01');
      };
      engine.on('requested', onReq);
      const res = await engine.requestPermission(
        {
          sessionId: 's-sec01',
          toolCall: { toolCallId: `tc-${cmd.length}`, kind: 'execute', title: 'run_command', rawInput: { CommandLine: cmd } },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
        workspace
      );
      engine.off('requested', onReq);
      expect(escalated, `must escalate Tier A SSRF: ${cmd}`).toBeDefined();
      expect(res.outcome.outcome).toBe('cancelled');
    }
  });

  it('SEC-02: buildAgyEnvironment 在 Windows / macOS / Linux 全平台剥离 NODE_OPTIONS 与 ELECTRON_RUN_AS_NODE', () => {
    const dirtyEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require=/tmp/pwn.js',
      ELECTRON_RUN_AS_NODE: '1',
      CUSTOM_SAFE: 'keep-me',
    };
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const clean = buildAgyEnvironment('/usr/local/bin/agy', dirtyEnv, platform, '/Users/dev');
      expect(clean.NODE_OPTIONS, `${platform} NODE_OPTIONS`).toBeUndefined();
      expect(clean.ELECTRON_RUN_AS_NODE, `${platform} ELECTRON_RUN_AS_NODE`).toBeUndefined();
      expect(clean.CUSTOM_SAFE, `${platform} CUSTOM_SAFE`).toBe('keep-me');
    }
  });
});

/* ============================================================================
 * 3. Backend Core & Lifecycle Bug Regressions (CORE-01 ~ CORE-18)
 * ========================================================================== */

describe('v0.3.3 后端核心与生命周期 Bug 回归（CORE-01 ~ CORE-18）', () => {
  it('CORE-01: macOS AcpClient.fail() 在 stopping 期间（即使存在 macGroup）绝不提前断开或覆盖 lastError', async () => {
    const child = new FakeRpcChild();
    const client = new AcpClient({ spawn: () => child });
    clients.push(client);
    await client.start();

    const disconnected = vi.fn();
    client.on('disconnected', disconnected);

    // Simulate macOS process group drain window during stop()
    let releaseClose!: () => void;
    (client as unknown as { macGroup?: { close: () => Promise<void> } }).macGroup = {
      close: () => new Promise<void>((resolve) => { releaseClose = resolve; }),
    };

    const stopPromise = client.stop();
    const errorBeforeDrain = client.lastError;
    try {
      // Pipe error arrives while stopping & macGroup is draining
      child.emit('error', new Error('mac pipe closed during drain'));
      await Promise.resolve();

      expect(disconnected).not.toHaveBeenCalled();
      expect(client.lastError).toBe(errorBeforeDrain);
    } finally {
      releaseClose();
      await stopPromise.catch(() => {});
    }
  });

  it('CORE-02: WorkspaceFiles.readReference() 执行有界读取，拒绝超过 512KB 上限的文件', async () => {
    const workspace = makeTempDir('gravity-v033-core02-');
    writeFileSync(path.join(workspace, 'small.txt'), 'hello bounded read', 'utf8');
    writeFileSync(path.join(workspace, 'oversized.txt'), 'A'.repeat(600 * 1024), 'utf8');

    const wf = new WorkspaceFiles();
    const small = await wf.readReference(workspace, 'small.txt');
    expect(small.text).toBe('hello bounded read');

    await expect(wf.readReference(workspace, 'oversized.txt')).rejects.toThrow(/512|大小|超限|limit/i);
  });

  it('CORE-03: InspectorStore 超过 200 会话时维护真实 LRU，持续更新的早期活跃会话不被截断丢失', () => {
    const dir = makeTempDir('gravity-v033-core03-');
    const disk = new ClientStore(dir);
    const inspector = new InspectorStore(disk);
    inspector.setProfile('default');

    inspector.consume('s-hot', { sessionUpdate: 'plan', entries: [{ content: 'initial hot task' }] });
    for (let i = 1; i <= 205; i++) {
      inspector.consume(`s-cold-${i}`, { sessionUpdate: 'plan', entries: [{ content: `cold ${i}` }] });
    }
    // Touch early session s-hot again so it becomes MRU
    inspector.consume('s-hot', { sessionUpdate: 'plan', entries: [{ content: 'updated hot task' }] });
    inspector.flush();

    const reloaded = new InspectorStore(disk);
    reloaded.setProfile('default');
    expect(reloaded.get('s-hot').todos[0]?.content).toBe('updated hot task');
    expect(reloaded.get('s-cold-1').todos[0]?.content).toBe('cold 1');
  });

  it('CORE-04: openExternalTarget 与 inspectLocalTargets 拦截 .js/.mjs/.cjs/.jar/.msc/.chm/.appref-ms/.scf/.inf/.dmg/.mpkg 并强制降级为 reveal-in-folder', async () => {
    const workspace = makeTempDir('gravity-v033-core04-');
    const extensions = ['.js', '.mjs', '.cjs', '.jar', '.msc', '.chm', '.appref-ms', '.scf', '.inf', '.dmg', '.mpkg'];
    const targets: string[] = [];

    for (const ext of extensions) {
      const filePath = path.join(workspace, `payload${ext}`);
      writeFileSync(filePath, 'dummy executable script payload', 'utf8');
      targets.push(filePath);
    }

    const inspected = await inspectLocalTargets({ targets, cwd: workspace, includePreviewData: false });
    const openHandler = vi.fn(async () => {});
    for (const filePath of targets) {
      expect(inspected.items[filePath]?.isExecutable, `inspect must flag executable: ${filePath}`).toBe(true);
      const res = await openExternalTarget(
        { target: filePath, action: 'default-app', cwd: workspace },
        { openTargetHandler: openHandler }
      );
      expect(res.modeUsed, `openExternalTarget must downgrade to reveal-in-folder: ${filePath}`).toBe('reveal-in-folder');
    }
  });

  it('CORE-05: AcpClient.dispatch 忽略伪造的 disconnected/error 通知，且不将消费端监听异常吞成无效 JSON 协议错误', async () => {
    const child = new FakeRpcChild();
    const client = new AcpClient({ spawn: () => child });
    clients.push(client);
    await client.start();

    const disconnectedSpy = vi.fn();
    const errorSpy = vi.fn();
    const protocolErrorSpy = vi.fn();
    client.on('disconnected', disconnectedSpy);
    client.on('error', errorSpy);
    client.on('protocolError', protocolErrorSpy);

    // 1. Forged server notifications targeting internal lifecycle event names must be ignored
    child.emitMessage({ jsonrpc: '2.0', method: 'disconnected', params: 'spoofed disconnect' });
    child.emitMessage({ jsonrpc: '2.0', method: 'error', params: 'spoofed error' });
    await new Promise((r) => setImmediate(r));

    expect(disconnectedSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(client.connected).toBe(true);

    // 2. Listener exception during a valid JSON notification must NOT be swallowed as invalid JSON protocolError
    client.on('session/update', () => {
      throw new Error('downstream listener bug');
    });
    let thrownOutside = false;
    try {
      child.emitMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
      });
    } catch {
      thrownOutside = true;
    }
    await new Promise((r) => setImmediate(r));
    expect(protocolErrorSpy.mock.calls.some(([msg]) => String(msg).includes('无效 JSON'))).toBe(false);
    expect(thrownOutside || protocolErrorSpy.mock.calls.every(([msg]) => !String(msg).includes('无效 JSON'))).toBe(true);
  });

  it('CORE-06: 响应式唤醒被用户 sendPrompt 打断时自动 finishMessage 收口，不残留 isStreaming 孤儿与 thoughtOwners 泄漏', async () => {
    const { dir, client, core, setPromptHandler } = makeSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    // Emit unsolicited reactive wakeup text + still-streaming thought while session is idle
    client.emit('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reactive background partial.' } },
    });
    client.emit('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reactive background still-streaming thought.' } },
    });

    const beforeMsgs = await readAllSessionMessages(core, sid);
    expect(beforeMsgs.at(-1)?.isStreaming).toBe(true);
    expect(beforeMsgs.at(-1)?.thoughts?.[0]?.isStreaming).toBe(true);

    // User immediately interrupts by sending a new prompt
    setPromptHandler(() => {
      client.emit('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fresh answer.' } },
      });
      return { stopReason: 'end_turn' };
    });
    await core.sendPrompt({ sessionId: sid, text: 'User interrupting prompt' });

    const afterMsgs = await readAllSessionMessages(core, sid);
    const reactiveMsg = afterMsgs.find((m) => m.role === 'assistant' && m.content.includes('Reactive background partial.'));
    expect(reactiveMsg).toBeDefined();
    expect(reactiveMsg!.isStreaming).toBe(false);
    expect(reactiveMsg!.completedAt).toBeTruthy();
    expect(reactiveMsg!.thoughts?.every((b) => !b.isStreaming)).toBe(true);
    expect(afterMsgs.every((m) => !m.isStreaming)).toBe(true);
  });

  it('CORE-07: ACP 断连自动调用 cancelManualCompaction 并妥善标记在途用户消息 sendFailed', async () => {
    const { dir, client, core, setConnected, setPromptHandler } = makeSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    // Arm manual compaction flag and leave a prompt in-flight with no assistant reply yet
    core.telemetry.applyContextWindow(sid, 120_000, 256_000);
    core.telemetry.beginManualCompaction(sid);

    let rejectPrompt!: (err: Error) => void;
    setPromptHandler(() => new Promise((_res, rej) => { rejectPrompt = rej; }));
    const turn = core.sendPrompt({ sessionId: sid, text: 'Will disconnect mid-flight' });
    await Promise.resolve();

    setConnected(false);
    client.emit('disconnected', 'ACP 进程意外退出');
    rejectPrompt(new Error('ACP 连接已断开'));
    await expect(turn).rejects.toThrow();

    // Subsequent context window drop MUST be classified as 'auto' (NOT stale 'manual' from before disconnect!)
    core.telemetry.applyContextWindow(sid, 40_000, 256_000);
    const compactions = core.telemetry.getSessionTelemetry(sid)?.compactions || [];
    expect(compactions.at(-1)?.trigger).toBe('auto');

    // In-flight user message without reply should be marked sendFailed
    const msgs = await readAllSessionMessages(core, sid);
    const userMsg = msgs.find((m) => m.role === 'user' && m.content === 'Will disconnect mid-flight');
    expect(userMsg?.sendFailed).toBe(true);
  });

  it('CORE-08: 自动续接中用户取消（cancelPrompt）正确回到 idle 而非卡死在 error', async () => {
    const { dir, client, core, setPromptHandler } = makeSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    let rejectContinuation!: (err: Error) => void;
    let continuationStarted!: () => void;
    const continuationReady = new Promise<void>((resolve) => { continuationStarted = resolve; });

    setPromptHandler((_params, attempt) => {
      if (attempt === 1) {
        client.emit('session/update', {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '⚠ There was a network issue connecting to the server, please try again.' },
          },
        });
        return { stopReason: 'end_turn' };
      }
      continuationStarted();
      return new Promise((_res, rej) => { rejectContinuation = rej; });
    });

    const run = core.sendPrompt({ sessionId: sid, text: 'Trigger continuation then cancel' });
    await continuationReady;

    await core.cancelPrompt(sid);
    rejectContinuation(new Error('cancelled by user during continuation'));
    await run.catch(() => {});

    expect(core.sessions.get(sid).status).toBe('idle');
  });

  it('CORE-09: 切号 activate() 先清旧响应式定时器再切换 telemetry，且 dispose() 单步异常不跳过后续清理', async () => {
    const { dir, client, core } = makeSpyCore();
    const second = (await core.createAccountProfile({ name: 'Profile B' })).profiles.find((p) => !p.isDefault)!;

    // 1. Arm reactive wakeup on default profile, then switch to Profile B
    const s1 = await core.createSession({ cwd: dir, title: 'Default reactive' });
    client.emit('session/update', {
      sessionId: s1.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reactive stream' } },
    });

    await core.switchAccountProfile(second.profileId);
    // Profile B's fresh telemetry must NOT have default profile's session created by endTurn during switch
    expect(core.telemetry.getSessionTelemetry(s1.sessionId)).toBeUndefined();

    // 2. v0.3.6 4-step resumable quit: Step 1 checkpoint failure MUST keep CoreService & telemetry alive for retry,
    // and retrying dispose() after fault clears MUST execute swarm.flush() and telemetry.dispose().
    const telemetryDisposeSpy = vi.spyOn(core.telemetry, 'dispose');
    const swarmFlushSpy = vi.spyOn(core.swarm, 'flush');
    const origWrite = core.store.write.bind(core.store);
    const writeSpy = vi.spyOn(core.store, 'write').mockImplementation((name, value) => {
      if (name.startsWith('message-index-v2-')) throw new Error('simulated disk full on saveMessages');
      return origWrite(name, value);
    });

    await expect(core.dispose()).rejects.toThrow('simulated disk full on saveMessages');
    expect(core.disposed).toBe(false);
    expect(core.savingForQuit).toBe(false);
    expect(telemetryDisposeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
    await core.dispose();
    expect(core.disposed).toBe(true);
    expect(telemetryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(swarmFlushSpy).toHaveBeenCalled();
  });

  it('CORE-11 & CORE-12: waiting_question / 活动回合拒绝归档，且 reviseMessage 异步失败自动脱敏凭据不产生未捕获异常', async () => {
    const { dir, client, core, setPromptHandler } = makeSpyCore();
    const session = await core.createSession({ cwd: dir });
    const sid = session.sessionId;

    // 1. waiting_question status must be rejected by manageSession (not bypassed when sessions.isBusy is false)
    core.sessions.setStatus(sid, 'waiting_question');
    await expect(core.manageSession(sid, 'archive')).rejects.toThrow(/正在生成|活动|回答|进行|回合/);
    core.sessions.setStatus(sid, 'idle');

    // 2. Complete a normal turn, then revise with a failing prompt that leaks a Bearer token
    setPromptHandler((_p, attempt) => {
      if (attempt === 1) {
        client.emit('session/update', {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Normal reply.' } },
        });
        return { stopReason: 'end_turn' };
      }
      throw new Error('Upstream failed Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.supersecret.sig at C:\\Users\\Admin\\.gemini\\secret');
    });

    await core.sendPrompt({ sessionId: sid, text: 'Initial message' });
    const msgs = await readAllSessionMessages(core, sid);
    const firstUser = msgs.find((m) => m.role === 'user')!;

    const branch = await core.reviseMessage({
      sessionId: sid,
      messageId: firstUser.id,
      text: 'Edited message',
    });
    await vi.waitFor(() => expect(core.sessions.isBusy(branch.sessionId)).toBe(false));

    const branchMsgs = await readAllSessionMessages(core, branch.sessionId);
    const serialized = JSON.stringify(branchMsgs);
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9.supersecret.sig');
  });

  it('CORE-13: setSessionMode 期间会话关闭后不回写 session-settings.json 也不污染已删会话', async () => {
    const dir = makeTempDir('gravity-v033-core13-');
    const store = new ClientStore(dir);
    const client = new AcpClient();
    const initRes = {
      protocolVersion: 1,
      agentInfo: { name: 'stub-core13', version: '1.0.0' },
      agentCapabilities: { sessionCapabilities: { close: {} } },
    };
    client.initializeResult = initRes;
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(initRes);

    let resolveSetMode!: (v: unknown) => void;
    const setModeStarted = new Promise<void>((resolve) => {
      vi.spyOn(client, 'request').mockImplementation(async (method) => {
        if (method === 'session/new') {
          return {
            sessionId: 'sess-race-13',
            configOptions: [
              {
                id: 'mode',
                name: 'Mode',
                currentValue: 'default',
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'full-access', name: 'Turbo' },
                ],
              },
            ],
          };
        }
        if (method === 'session/set_config_option') {
          resolve();
          return new Promise((r) => { resolveSetMode = r; });
        }
        return {};
      });
    });

    const mux = new SessionMultiplexer(client, store);
    const s = await mux.createSession({ cwd: dir });

    const setModePromise = mux.setSessionMode(s.sessionId, 'full-access');
    await setModeStarted;

    // Close session while RPC is still in flight
    await mux.closeSession(s.sessionId);
    const updatesAfterClose = vi.fn();
    mux.on('updated', updatesAfterClose);

    resolveSetMode({
      configOptions: [{ id: 'mode', name: 'Mode', currentValue: 'full-access', options: [{ value: 'full-access', name: 'Turbo' }] }],
    });
    await setModePromise.catch(() => {});

    expect(updatesAfterClose).not.toHaveBeenCalled();
    const savedSettings = store.read<Record<string, { executionMode?: string }>>('session-settings.json', {});
    expect(savedSettings[`default:${s.sessionId}`]?.executionMode).not.toBe('full-access');
  });

  it('CORE-14: ClientStore.writeDebounced 保持原始文件名大小写不强转小写', () => {
    const dir = makeTempDir('gravity-v033-core14-');
    const store = new ClientStore(dir);
    store.writeDebounced('MixedCaseSnapshot.json', { ok: true }, 50);
    store.flushPending('MixedCaseSnapshot.json');

    const filesOnDisk = readdirSync(dir);
    expect(filesOnDisk).toContain('MixedCaseSnapshot.json');
    expect(filesOnDisk).not.toContain('mixedcasesnapshot.json');
  });

  it('CORE-15: ConversationTreeStore.setProfile 传入空 ownedSessionIds 集合时仍裁剪孤儿分支树', () => {
    const dir = makeTempDir('gravity-v033-core15-');
    const store = new ClientStore(dir);
    const trees = new ConversationTreeStore(store);
    trees.setProfile('default');
    trees.recordBranch({
      rootSessionId: 'orphan-root',
      rootPromptPreview: 'old',
      branchId: 'orphan-child',
      parentBranchId: 'orphan-root',
      forkAfterMessageId: null,
      forkUserTurnIndex: 0,
      forkPromptPreview: 'edited',
      nowIso: '2026-11-25T00:00:00Z',
    });
    expect(trees.hasTree('orphan-root')).toBe(true);

    const reloaded = new ConversationTreeStore(store);
    reloaded.setProfile('default', new Set());
    expect(reloaded.hasTree('orphan-root')).toBe(false);
  });

  it('CORE-16: 单次 agent_thought_chunk 仅触发 1 次 message-upserted（消除双重 upsert/推送）', async () => {
    const { dir, client, core } = makeSpyCore();
    const session = await core.createSession({ cwd: dir });

    const upserts = vi.fn();
    core.on('message-upserted', upserts);

    client.emit('session/update', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Inspecting architecture modules.' },
      },
    });

    expect(upserts).toHaveBeenCalledTimes(1);
  });

  it('CORE-17 & CORE-18: 历史回放 plan 不误开 burstGuard，WorkspaceSettings 拒绝含空字节的路径', async () => {
    const { dir, client, core } = makeSpyCore();
    const session = await core.createSession({ cwd: dir });

    const burstSpy = vi.spyOn(core.approval, 'enableBurstGuard');
    vi.spyOn(core.sessions, 'isResuming').mockReturnValue(true);
    client.emit('session/update', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'step 1', status: 'completed' },
          { content: 'step 2', status: 'completed' },
        ],
      },
    });
    expect(burstSpy).not.toHaveBeenCalled();

    // WorkspaceSettings rejects null-byte path
    await expect(
      core.updatePreferences({ defaultWorkspaceCwd: `${dir}\0injected` })
    ).rejects.toThrow();
  });
});

// @vitest-environment node
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import ts from 'typescript';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
 * Minimal Electron Mock (strictly for R14 WIN-01 / D2 window-manager testing)
 * ========================================================================== */

const { mockWindowOverlays, mockWindowBgColors, mockNativeTheme } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const nativeTheme = {
    shouldUseDarkColors: true,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return nativeTheme;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return nativeTheme;
    },
    removeListener(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return nativeTheme;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
      return true;
    },
  };
  return {
    mockWindowOverlays: [] as Array<{ color: string; symbolColor: string; height: number }>,
    mockWindowBgColors: [] as string[],
    mockNativeTheme: nativeTheme,
  };
});

vi.mock('electron', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const { tmpdir: getTmpDir } = await import('node:os');
  class MockBrowserWindow extends EE {
    webContents = Object.assign(new EE(), {
      mainFrame: { url: 'file:///trusted/index.html' },
      getURL: () => 'file:///trusted/index.html',
      isDestroyed: () => false,
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
    });
    private destroyed = false;
    constructor(opts?: { backgroundColor?: string; titleBarOverlay?: { color: string; symbolColor: string; height: number } }) {
      super();
      if (opts?.backgroundColor) mockWindowBgColors.push(opts.backgroundColor);
      if (opts?.titleBarOverlay) mockWindowOverlays.push(opts.titleBarOverlay);
    }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return false; }
    maximize() {}
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    getNormalBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    setBackgroundColor(c: string) { mockWindowBgColors.push(c); }
    setTitleBarOverlay(overlay: { color: string; symbolColor: string; height: number }) { mockWindowOverlays.push(overlay); }
    setIcon = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    loadFile = vi.fn().mockResolvedValue(undefined);
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return {
    app: { isPackaged: false, dock: { setIcon: vi.fn() }, quit: vi.fn(), getPath: () => getTmpDir() },
    BrowserWindow: MockBrowserWindow,
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
    nativeTheme: mockNativeTheme,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  };
});

import * as quotaModule from '../src/main/accounts/account-quota';
import { AcpClient, AcpRpcError } from '../src/main/acp/acp-client';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import type { Reviewer } from '../src/main/approval/external-reviewer';
import { CoreService } from '../src/main/core-service';
import { flushDesktopWindow, getLiveWindow, iconPath, openWindow, syncWindowChrome } from '../src/main/desktop/window-manager';
import { registerIpcRouter } from '../src/main/ipc-router';
import { OriginCircuitBreaker, reviewerCircuit, translatorCircuit } from '../src/main/llm/external-llm-transport';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { inspectLocalTargets } from '../src/main/services/local-media-inspector';
import type { SecretCipher } from '../src/main/services/secret-vault';
import { AgentQuestions } from '../src/main/session/agent-questions';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { GitHubUpdater, selectReleaseAsset } from '../src/main/updater/github-updater';
import { windowsUpdateScript } from '../src/main/updater/windows-installer';
import { isUnsafeLocalFile, isUnsafeLocalPath } from '../src/main/workspace/local-path-safety';
import {
  classifyErrorToDiagnosticCode,
  DEFAULT_MODEL_RATE_CARDS,
  IPC_CHANNELS,
  isBlockedExternalEndpointHost,
  isForbiddenCredentialOrStatePath,
  normalizeProjectCompareKey,
  normalizeWorkspacePath,
  resolveEffectiveGravityIconId,
  resolveModelRateCard,
  THEME_PRESETS,
  type AcpRequestPermissionParams,
  type AcpSessionPromptParams,
  type AcpSessionPromptResult,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ExternalAiReviewerConfig,
  type TranslationConfig,
} from '../src/shared';

/* ============================================================================
 * Shared Helpers & Fixtures
 * ========================================================================== */

const tempDirs: string[] = [];
const services: CoreService[] = [];
const engines: ApprovalEngine[] = [];
const clients: AcpClient[] = [];
const trackers: SwarmTracker[] = [];
const telemetries: TelemetryStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeCipher(): SecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`ENC:${plain}`, 'utf8'),
    decrypt: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('ENC:')) throw new Error('invalid cipher');
      return s.slice(4);
    },
  };
}

class FakeRpcChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: Array<{ id?: number | string; method?: string; params?: unknown }> = [];
  stdin = new Writable({
    write: (chunk, _enc, done) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: unknown };
        this.sent.push(msg);
        if (msg.method === 'initialize') {
          queueMicrotask(() =>
            this.emitMessage({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: 'v034-fake-acp', version: '1.5.17' },
                agentCapabilities: {
                  loadSession: true,
                  sessionCapabilities: { list: {}, resume: {}, close: {} },
                },
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
    this.stdin.on('finish', () => {
      this.exitCode = 0;
      setImmediate(() => this.emit('close', 0));
    });
  }
  emitMessage(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  kill(): boolean {
    this.exitCode = 0;
    setImmediate(() => this.emit('close', 0));
    return true;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

function makeMinimalPng(width: number, height: number): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type RGB
  const ihdrCrc = Buffer.alloc(4);
  const iend = Buffer.from('0000000049454e44ae426082', 'hex');
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc, iend]);
}

function makeSpyCore(opts: {
  dataDir?: string;
  supportsClose?: boolean;
  now?: () => number;
  secretCipher?: SecretCipher;
  reviewer?: Reviewer;
  externalTranslator?: NonNullable<ConstructorParameters<typeof CoreService>[0]['externalTranslator']>;
  modelDiscoveryFetcher?: typeof fetch;
  copyTextHandler?: (text: string) => void | Promise<void>;
  onRequest?: (method: string, params: unknown, seq: number) => Promise<unknown> | unknown;
} = {}) {
  const dir = opts.dataDir ?? makeTempDir('gravity-v034-r-');
  const client = new AcpClient();
  const initRes = {
    protocolVersion: 1,
    agentInfo: { name: 'Antigravity CLI', version: '1.5.17' },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        resume: {},
        ...(opts.supportsClose === false ? {} : { close: {} }),
      },
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
  const requests: Array<{ method: string; params: unknown }> = [];
  const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    requests.push({ method, params });
    if (opts.onRequest) {
      const handled = await opts.onRequest(method, params, seq + 1);
      if (handled !== undefined) {
        if (method === 'session/new') seq += 1;
        return handled;
      }
    }
    if (method === 'session/new') {
      seq += 1;
      return {
        sessionId: `sess-r-${seq}`,
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'accept-edits', name: 'Accept Edits' },
              { value: 'plan', name: 'Plan' },
            ],
          },
          {
            id: 'model',
            name: 'Model',
            currentValue: 'gemini-3.8-flash',
            options: [
              { value: 'gemini-3.8-flash', name: 'Flash' },
              { value: 'gemini-4-neon', name: 'Neon' },
              { value: 'gemini-4-hydrogen', name: 'Hydrogen' },
            ],
          },
          {
            id: 'thought_level',
            name: 'Effort',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'max', name: 'Max' },
            ],
          },
        ],
      };
    }
    if (method === 'session/list') return { sessions: [] };
    if (method === 'session/close') return {};
    if (method === 'session/set_config_option') return {};
    if (method === 'session/prompt') return { stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 10 } };
    return {};
  });

  const core = new CoreService({
    acp: client,
    dataDir: dir,
    homeDir: path.join(dir, 'home'),
    now: opts.now,
    secretCipher: opts.secretCipher,
    reviewer: opts.reviewer,
    externalTranslator: opts.externalTranslator,
    modelDiscoveryFetcher: opts.modelDiscoveryFetcher,
    copyTextHandler: opts.copyTextHandler,
    enableAutoUpdateCheck: false,
  });
  services.push(core);
  return { dir, client, core, requestSpy, requests, setConnected: (v: boolean) => { connected = v; } };
}

afterEach(async () => {
  vi.useRealTimers();
  reviewerCircuit.reset();
  translatorCircuit.reset();
  mockWindowOverlays.length = 0;
  mockWindowBgColors.length = 0;
  mockNativeTheme.shouldUseDarkColors = true;
  getLiveWindow()?.destroy();
  flushDesktopWindow();
  for (const s of services.splice(0)) await s.dispose().catch(() => {});
  for (const e of engines.splice(0)) e.dispose();
  for (const c of clients.splice(0)) await c.stop().catch(() => {});
  for (const t of trackers.splice(0)) t.clear();
  for (const tl of telemetries.splice(0)) tl.dispose();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

/* ============================================================================
 * R01: CAP-01 & TTL-01
 * ========================================================================== */

describe('R01 · CAP-01（并发上限 <= 4 槽位严守）与 TTL-01（标题整理发 session/new 即计预算）', () => {
  it('R01-A (CAP-01): 服务端缺 close 能力时标题整理绝不创建临时会话（session/new = 0）', async () => {
    const { core, requests, dir } = makeSpyCore({ supportsClose: false });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    // Seed 1 local owned session so organizeTitles has a target
    const store = core.store;
    store.write('owned-sessions-default.json', {
      's-old': {
        sessionId: 's-old',
        cwd,
        rawCwd: cwd,
        title: 'old title',
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'closed',
        modelId: 'gemini-4-neon',
        executionMode: 'default',
        reasoningEffort: 'medium',
        originKind: 'acp-live',
        readOnly: false,
        profileId: 'default',
        updatedAt: '2026-11-26T00:00:00.000Z',
      },
    });
    core.sessions.sessions.set('s-old', store.read<Record<string, never>>('owned-sessions-default.json', {})['s-old']);

    const newCallsBefore = requests.filter((r) => r.method === 'session/new').length;
    await expect(core.organizeTitles({ scope: 'all' })).rejects.toThrow();
    const newCallsAfter = requests.filter((r) => r.method === 'session/new').length;
    expect(newCallsAfter - newCallsBefore, '缺少 sessionCapabilities.close 时严禁新建临时整理会话').toBe(0);
  });

  it('R01-B (CAP-01): 3 活跃会话下临时会话 close 失败/拒绝时不得提前归还并发槽位（绝不送出第 5 个可能活跃会话）', async () => {
    let failNextClose = false;
    const { core, requests, dir } = makeSpyCore({
      onRequest: (method, _params, nextSeq) => {
        if (method === 'session/close' && failNextClose) {
          return Promise.reject(new AcpRpcError(-32000, 'close failed / timed out'));
        }
        if (method === 'session/new' && nextSeq === 4) {
          // 4th session (ephemeral title organizer) fails because no Hydrogen, then close fails!
          failNextClose = true;
          return {
            sessionId: 'sess-ephemeral-stuck',
            configOptions: [
              { id: 'model', name: 'Model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Neon' }] },
            ],
          };
        }
        return undefined;
      },
    });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });

    // Open 3 live sessions (slots 1..3 occupied)
    await core.createSession({ cwd, title: 's1' });
    await core.createSession({ cwd, title: 's2' });
    await core.createSession({ cwd, title: 's3' });
    expect(core.sessions.activeSessionCount).toBe(3);

    // 4th slot used by title organizer whose session/close FAILS (server may still hold 4th session!)
    await expect(core.organizeTitles({ scope: 'all' })).rejects.toThrow();

    // Now attempting to open another session MUST NOT send a 5th `session/new`!
    const newCountBefore = requests.filter((r) => r.method === 'session/new').length;
    expect(newCountBefore).toBe(4);
    await expect(core.createSession({ cwd, title: 's5-forbidden' })).rejects.toThrow();
    const newCountAfter = requests.filter((r) => r.method === 'session/new').length;
    expect(newCountAfter, 'close 失败后提前释放槽位导致送出第 5 个可能活跃会话').toBe(4);
  });

  it('R01-C (TTL-01): 4 次因缺少 Hydrogen 失败的标题整理后，60s 内第 5 次必须在本地拦截（不发第 5 次 session/new）', async () => {
    let now = Date.UTC(2026, 10, 26, 10, 0, 0);
    const { core, requests, dir } = makeSpyCore({
      now: () => now,
      onRequest: (method, _params, nextSeq) => {
        if (method === 'session/new' && nextSeq >= 2) {
          // Ephemeral organizer sessions lack Hydrogen model -> fail before session/prompt
          return {
            sessionId: `sess-no-hydrogen-${nextSeq}`,
            configOptions: [
              { id: 'model', name: 'Model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Neon' }] },
            ],
          };
        }
        return undefined;
      },
    });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    await core.createSession({ cwd, title: 'target-session' });

    const countNew = () => requests.filter((r) => r.method === 'session/new').length;
    expect(countNew()).toBe(1);

    // 4 failed attempts (each sends session/new -> Hydrogen missing)
    for (let i = 0; i < 4; i += 1) {
      now += 1000;
      await expect(core.organizeTitles({ scope: 'all' })).rejects.toThrow(/Hydrogen/);
    }
    expect(countNew()).toBe(5); // 1 user session + 4 organizer attempts

    // 5th click within 60s MUST be locally rate-limited with 0 additional session/new!
    now += 1000;
    await expect(core.organizeTitles({ scope: 'all' })).rejects.toThrow(/冷却|最多整理/);
    expect(countNew(), '第 5 次标题整理未在本地拦截，多发了 session/new').toBe(5);
  });
});

/* ============================================================================
 * R02: RATE-01, RATE-02 & QA-03
 * ========================================================================== */

describe('R02 · RATE-01（迟到 429/403 冷却）、RATE-02（冷却期禁重握手与禁额度）与 QA-03', () => {
  it('R02-A (RATE-01): 请求超时后迟到的 429/403 仍须建立冷却且不缩短已有截止，未知 ID 对冷却 0 影响', async () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 10, 26, 11, 0, 0);
    vi.setSystemTime(t0);

    const stub = new FakeRpcChild();
    const acp = new AcpClient({ requestTimeoutMs: 50, spawn: () => stub as never });
    clients.push(acp);
    const sp = acp.start();
    await vi.advanceTimersByTimeAsync(10);
    await sp;

    // 1. Unknown ID error must have ZERO effect on cooldown
    stub.emitMessage({ jsonrpc: '2.0', id: 999999, error: { code: 403, message: 'HTTP 403 Forbidden' } });
    expect(acp.isRateLimited).toBe(false);
    expect(acp.cooldownUntilMs).toBe(0);

    // 2. Send request A -> let it time out -> then late 403 arrives!
    const reqA = acp.request('session/list', {}, 50);
    const idA = stub.sent.at(-1)!.id!;
    const reqARejected = expect(reqA).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(60);
    await reqARejected;

    stub.emitMessage({ jsonrpc: '2.0', id: idA, error: { code: 403, message: 'HTTP 403 PERMISSION_DENIED' } });
    expect(acp.isRateLimited, '超时后迟到的 403 必须仍建立冷却').toBe(true);
    const untilAfter403 = acp.cooldownUntilMs;
    expect(untilAfter403 - Date.now()).toBeGreaterThanOrEqual(300_000 - 100);

    // 3. A subsequent late 429 (60s) must NOT shorten the existing 300s 403 cooldown!
    stub.emitMessage({ jsonrpc: '2.0', id: idA, error: { code: 429, message: 'HTTP 429 RESOURCE_EXHAUSTED' } });
    expect(acp.cooldownUntilMs).toBeGreaterThanOrEqual(untilAfter403);
  });

  it('R02-B (RATE-02): 冷却期调 start()、主动 RPC、默认 Profile getAccountQuota() 均被拦截（spawn/initialize/quota = 0）', async () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 10, 26, 11, 10, 0);
    vi.setSystemTime(t0);

    let spawnCount = 0;
    let currentChild: FakeRpcChild | undefined;
    const acp = new AcpClient({
      spawn: () => {
        spawnCount += 1;
        currentChild = new FakeRpcChild();
        return currentChild as never;
      },
    });
    clients.push(acp);

    const start1 = acp.start();
    await vi.advanceTimersByTimeAsync(10);
    await start1;
    expect(spawnCount).toBe(1);

    // Trigger 429 cooldown (60s)
    const p = acp.request('session/list', {});
    const reqId = currentChild!.sent.at(-1)!.id!;
    currentChild!.emitMessage({ jsonrpc: '2.0', id: reqId, error: { code: 429, message: 'HTTP 429' } });
    await expect(p).rejects.toThrow(/429/);
    expect(acp.isRateLimited).toBe(true);

    // Active RPC blocked locally
    const sentBeforeRpc = currentChild!.sent.length;
    await expect(acp.request('session/new', { cwd: 'C:\\ws' })).rejects.toThrow(/429|暂停/);
    expect(currentChild!.sent.length).toBe(sentBeforeRpc);

    // Stop transport while still in cooldown -> start() MUST NOT respawn or send initialize!
    const stopP = acp.stop();
    await vi.advanceTimersByTimeAsync(800);
    await stopP;
    await expect(acp.start()).rejects.toThrow(/429|冷却|暂停/);
    expect(spawnCount, '冷却期内 start() 不得重新 spawn 进程或重握手 initialize').toBe(1);

    // Default Profile getAccountQuota() during cooldown MUST NOT invoke quota probe!
    const quotaProbeSpy = vi.spyOn(quotaModule, 'readAccountQuota').mockResolvedValue({
      profileId: 'default',
      checkedAt: new Date(t0).toISOString(),
      buckets: [{ id: 'pro', remainingFraction: 0.9 }],
    });
    const core = new CoreService({
      acp,
      dataDir: makeTempDir('gravity-v034-rate02-'),
      enableAutoUpdateCheck: false,
    });
    services.push(core);

    await expect(core.getAccountQuota()).rejects.toThrow(/429|冷却|暂停/);
    expect(quotaProbeSpy, '冷却期内默认 Profile 刷额度必须被本地拦截').toHaveBeenCalledTimes(0);
  });

  it('R02-C (QA-03): OriginCircuitBreaker 强类型直调 remaining / fail / reset 与 401 策略区分', () => {
    const t0 = Date.UTC(2026, 10, 26, 12, 0, 0);
    const origin = 'https://api.v034-r02.example/v1';
    const bNo401 = new OriginCircuitBreaker({ tripOn401: false });
    expect(bNo401.remaining(origin, t0)).toBe(0);
    expect(bNo401.fail(origin, 401, t0)).toBe(0);
    expect(bNo401.fail(origin, 429, t0)).toBe(60_000);
    expect(bNo401.fail(origin, 403, t0)).toBe(300_000);
    expect(bNo401.remaining(origin, t0)).toBe(300_000);
    bNo401.reset(origin);
    expect(bNo401.remaining(origin, t0)).toBe(0);

    const b401 = new OriginCircuitBreaker({ tripOn401: true });
    expect(b401.fail(origin, 401, t0)).toBe(300_000);
    expect(b401.remaining(origin, t0)).toBe(300_000);
  });
});

/* ============================================================================
 * R03: TURN-01 & MEM-01
 * ========================================================================== */

describe('R03 · TURN-01（准备期取消 0 发送 0 计费）与 MEM-01（思考/提交/翻译状态零泄漏）', () => {
  it('R03-A (TURN-01): 挂起引用文件准备期间用户取消，解除挂起后 ACP prompt 与遥测计费各为 0', async () => {
    const { core, requests, dir } = makeSpyCore();
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const filePath = path.join(cwd, 'notes.txt');
    writeFileSync(filePath, 'important reference content', 'utf8');

    const sess = await core.createSession({ cwd, title: 'turn01' });

    let releaseRead!: (res: { path: string; text: string }) => void;
    vi.spyOn(core.workspaceFiles, 'readReference').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );

    const beginTurnSpy = vi.spyOn(core.telemetry, 'beginTurn');
    const promptPromise = core.sendPrompt({
      sessionId: sess.sessionId,
      text: 'analyze notes',
      references: [{ kind: 'file', label: 'notes.txt', value: 'notes.txt' }],
    });

    await vi.waitFor(() => expect(releaseRead).toBeDefined());
    await core.cancelPrompt(sess.sessionId);
    releaseRead({ path: 'notes.txt', text: 'important reference content' });

    await Promise.allSettled([promptPromise]);

    const sentPrompts = requests.filter((r) => r.method === 'session/prompt');
    expect(sentPrompts, '准备期已取消的回合绝不可发送 session/prompt').toHaveLength(0);
    expect(beginTurnSpy, '准备期已取消的回合绝不可开启遥测计费').toHaveBeenCalledTimes(0);
  });

  it('R03-B (MEM-01): 100 轮中文思考先于正文结束 + 在途关会话/切号后 submitted/thoughtOwners/翻译状态残留各为 0', async () => {
    const { core, client, dir } = makeSpyCore({
      onRequest: (method, params) => {
        if (method === 'session/prompt') {
          const sid = (params as AcpSessionPromptParams).sessionId;
          client.emit('session/update', {
            sessionId: sid,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在分析边界条件与架构。' } },
          });
          client.emit('session/update', {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成分析。' } },
          });
          return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 8 } };
        }
        return undefined;
      },
    });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sess = await core.createSession({ cwd, title: 'mem01' });

    for (let i = 0; i < 100; i += 1) {
      await core.sendPrompt({ sessionId: sess.sessionId, text: `turn-${i}` });
    }

    const turnsInternal = (core as unknown as {
      turns: { submitted: Map<string, unknown>; thoughtOwners: Map<string, unknown> };
    }).turns;
    const thoughtsInternal = (core.thoughts as unknown as { entries?: Map<string, unknown>; states?: Map<string, unknown> });

    expect(turnsInternal.submitted.size, '100 轮后 submitted 残留应为 0').toBe(0);
    expect(turnsInternal.thoughtOwners.size, '100 轮中文思考先于正文结束后 thoughtOwners 残留应为 0').toBe(0);
    const thoughtMapSize = thoughtsInternal.entries?.size ?? thoughtsInternal.states?.size ?? 0;
    expect(thoughtMapSize, 'ThoughtTranslator 内部缓存残留应为 0').toBe(0);

    // 关闭会话与切号后同样残留 = 0
    await core.closeSession(sess.sessionId);
    const created = await core.createAccountProfile({ name: 'P2' });
    const p2 = created.profiles.find((p) => !p.isDefault)!;
    await core.switchAccountProfile(p2.profileId);

    expect(turnsInternal.submitted.size).toBe(0);
    expect(turnsInternal.thoughtOwners.size).toBe(0);
  });
});

/* ============================================================================
 * R04: TURN-02 & SWM-01
 * ========================================================================== */

describe('R04 · TURN-02（回合末写盘失败不卡死第 2 轮）与 SWM-01（Swarm 写失败阻断静默清除与切号）', () => {
  it('R04-A (TURN-02): 回合末消息写盘失败后首轮正常收尾且第 2 轮可正常发送完成', async () => {
    const { core, dir } = makeSpyCore();
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sess = await core.createSession({ cwd, title: 'turn02' });

    const origWrite = ClientStore.prototype.write;
    let failMessageSaveOnce = true;
    vi.spyOn(ClientStore.prototype, 'write').mockImplementation(function (this: ClientStore, name, val) {
      if (failMessageSaveOnce && name === 'message-index-v2-default.json') {
        failMessageSaveOnce = false;
        throw new Error('EIO: simulated disk error on turn end');
      }
      return origWrite.call(this, name, val);
    });

    const endTurnSpy = vi.spyOn(core.telemetry, 'endTurn');
    await Promise.allSettled([core.sendPrompt({ sessionId: sess.sessionId, text: 'turn 1' })]);
    expect(endTurnSpy, '首轮虽写盘失败仍必须精确结算 telemetry.endTurn 1 次').toHaveBeenCalledTimes(1);

    // 第 2 轮必须能够正常发送，不得因首轮遥测回合未结束而报「同一会话不能重复开启遥测回合」
    await expect(core.sendPrompt({ sessionId: sess.sessionId, text: 'turn 2' })).resolves.toBeUndefined();
    expect(endTurnSpy).toHaveBeenCalledTimes(2);
  });

  it('R04-B (SWM-01): 真实外部 SQLite BEGIN IMMEDIATE 写锁触发 SQLITE_BUSY 时阻断静默 clear() 与切号，释锁后恢复持久化 1 条', async () => {
    const { core, client, dir } = makeSpyCore();
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sess = await core.createSession({ cwd, title: 'swm01-lock' });
    const created = await core.createAccountProfile({ name: 'Work' });
    const p2 = created.profiles.find((p) => !p.isDefault)!;

    // 1. 经 CoreService 生产路径落盘一条初始事件，确保 swarm-v2-*.sqlite 在磁盘建库就绪
    client.emit('session/update', {
      sessionId: sess.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-swm01-seed',
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'lead', content: 'seed initial record' },
      },
    });
    const seeded = await core.getSwarmState(sess.sessionId);
    expect(seeded.boardMessages.some((m) => m.content === 'seed initial record')).toBe(true);

    const sqliteFile = readdirSync(dir).find((f) => /^swarm-v2-.*\.sqlite$/.test(f));
    expect(sqliteFile).toBeTruthy();
    const dbPath = path.join(dir, sqliteFile!);

    // 2. 用外部独立 SQLite 连接在数据库文件上持真实 BEGIN IMMEDIATE 写锁（对主线程同步内核与 Worker 线程均生效）
    const lockDb = new DatabaseSync(dbPath);
    let lockHeld = false;
    try {
      lockDb.exec('BEGIN IMMEDIATE');
      lockHeld = true;

      // 3. 持锁期间经 CoreService 灌入关键终态 Swarm 更新
      client.emit('session/update', {
        sessionId: sess.sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-swm01-1',
          name: 'post_message',
          status: 'completed',
          rawInput: { sender: 'lead', content: 'critical final board update' },
        },
      });

      // 4. 写锁未释放时，flush / 切号遇 SQLITE_BUSY 必须拒绝（主线程不崩不挂死，且绝不可静默 clear() 丢数据或完成切号）
      await expect(core.switchAccountProfile(p2.profileId)).rejects.toThrow();
      expect(core.accounts.activeProfileId).toBe('default');

      // 5. 释放外部写锁后重试 flush，记录精确持久化 1 条且无重复、无异常
      lockDb.exec('ROLLBACK');
      lockHeld = false;
      lockDb.close();

      await Promise.resolve(core.swarm.flush());
      await Promise.resolve(core.swarm.flush());
      const state = await core.getSwarmState(sess.sessionId);
      expect(state.boardMessages.filter((m) => m.content === 'critical final board update')).toHaveLength(1);
      expect(state.historyUnavailable).toBeFalsy();
    } finally {
      if (lockHeld) {
        try { lockDb.exec('ROLLBACK'); } catch { /* ignore */ }
      }
      try { lockDb.close(); } catch { /* ignore */ }
    }
  }, 20_000);
});

/* ============================================================================
 * R05: ROOT-01 & PROC-01
 * ========================================================================== */

describe('R05 · ROOT-01（启动数据目录越界/软链拦截）与 PROC-01（Windows 进程树退清屏障）', () => {
  it('R05-A (ROOT-01): --user-data-dir 指向受保护目录及软链/联接时禁止创建锁/DB/文件', () => {
    const root = makeTempDir('gravity-v034-root01-');
    const fakeGemini = path.join(root, '.gemini', 'antigravity-cli');
    const fakeSsh = path.join(root, '.ssh');
    mkdirSync(fakeGemini, { recursive: true });
    mkdirSync(fakeSsh, { recursive: true });

    // 1. 软链/目录联接指向受保护目录：ClientStore 必须沿 realpath 拒绝（不得在目标目录写入）
    const linkToGemini = path.join(root, 'innocent-looking-dir');
    symlinkSync(fakeGemini, linkToGemini, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new ClientStore(linkToGemini), '指向 .gemini 的软链/联接必须被 ClientStore 拦截').toThrow();
    expect(() => new ClientStore(fakeSsh), '指向 .ssh 受保护目录必须被 ClientStore 拦截').toThrow();
    expect(readdirSync(fakeGemini)).toEqual([]);
    expect(readdirSync(fakeSsh)).toEqual([]);

    // 2. 启动入口 src/main/index.ts 必须在 app.setPath("userData") 与 requestSingleInstanceLock 之前校验 user-data-dir
    const indexSrc = readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8');
    const setPathIdx = indexSrc.indexOf("app.setPath('userData'");
    const lockIdx = indexSrc.indexOf('app.requestSingleInstanceLock()');
    expect(setPathIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(setPathIdx);
    const beforeSetPath = indexSrc.slice(0, setPathIdx);
    expect(
      /realpath|isUnsafeLocalPath|isForbiddenCredentialOrStatePath|validateUserDataDir|assertSafeUserDataDir/i.test(beforeSetPath),
      'src/main/index.ts 必须在 app.setPath("userData") 之前执行受保护目录与 realpath 校验'
    ).toBe(true);
  });

  it('R05-B (PROC-01): 父进程先退出但孙子进程延迟存活时，stop() 必须等整个子进程树退清且不影响无关进程', async () => {
    const dir = makeTempDir('gravity-v034-proc01-');
    const grandPidFile = path.join(dir, 'grandchild.pid');

    const parentScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const readline = require('node:readline');
      const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });
      grand.unref();
      fs.writeFileSync(${JSON.stringify(grandPidFile)}, String(grand.pid));
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: 'proc01-parent', version: '1.0.0' },
              agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
            },
          }) + '\\n');
        }
      });
      // Parent exits IMMEDIATELY on stdin end while grandchild stays alive 4s!
      process.stdin.on('end', () => process.exit(0));
    `;

    const unrelated = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let grandPid = 0;

    // Exercise the macOS group owner on Linux with real POSIX process groups.
    const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      if (hostPlatform.value === 'linux') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'darwin' });
      const acp = new AcpClient({
        binaryPath: process.execPath,
        spawn: (_bin, _args, opts) =>
          realSpawn(process.execPath, ['-e', parentScript], {
            ...opts,
            shell: false,
            windowsHide: true,
          }) as never,
      });
      clients.push(acp);

      await acp.start();
      await vi.waitFor(() => expect(existsSync(grandPidFile)).toBe(true), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 120));
      grandPid = Number(readFileSync(grandPidFile, 'utf8').trim());
      expect(grandPid).toBeGreaterThan(0);
      expect(isPidAlive(grandPid)).toBe(true);
      expect(isPidAlive(unrelated.pid!)).toBe(true);

      await acp.stop();

      // After stop() resolves, grandchild MUST already be dead; unrelated process MUST remain alive!
      expect(isPidAlive(grandPid), 'PROC-01: stop() 返回时孙子进程仍存活，未建立 Windows 进程树退清屏障').toBe(false);
      expect(isPidAlive(unrelated.pid!), 'PROC-01: 不得误杀无关进程').toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', hostPlatform);
      if (grandPid > 0 && isPidAlive(grandPid)) {
        try { process.kill(grandPid, 'SIGKILL'); } catch { /* ignore */ }
      }
      if (unrelated.pid && isPidAlive(unrelated.pid)) {
        try { unrelated.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  }, 15_000);
});

/* ============================================================================
 * R06: CFG-01, ASK-01 & U-02 (BE)
 * ========================================================================== */

describe('R06 · CFG-01（以官方回执为准）、ASK-01（cancel/decline 残留 customReply）与 U-02（createSession 模型/推理）', () => {
  it('R06-A (CFG-01): setSessionEffort 官方返回不同 thought_level 回执时必须以官方回执为准', async () => {
    const { core, dir } = makeSpyCore({
      onRequest: (method, params) => {
        if (method === 'session/set_config_option' && (params as { configId?: string }).configId === 'thought_level') {
          // Server returns 'high' even though client requested 'max'
          return {
            configOptions: [
              {
                id: 'thought_level',
                name: 'Effort',
                currentValue: 'high',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                  { value: 'max', name: 'Max' },
                ],
              },
            ],
          };
        }
        return undefined;
      },
    });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sess = await core.createSession({ cwd, title: 'cfg01' });

    const updated = await core.setSessionEffort(sess.sessionId, 'max');
    expect(updated.reasoningEffort, '应以官方 configOptions 回执的 high 为准，不得覆写为客户端请求值 max').toBe('high');
  });

  it('R06-B (ASK-01): cancel / decline 携带残留 customReply 时发送同名 RPC 动作且额外 prompt = 0', async () => {
    const queuedReplies: Array<{ sessionId: string; text: string }> = [];
    const questions = new AgentQuestions(
      () => {},
      () => true,
      (sid, text) => queuedReplies.push({ sessionId: sid, text })
    );

    const schema = {
      type: 'object',
      required: ['choice'],
      properties: { choice: { type: 'string', enum: ['a', 'b'] } },
    };

    // Case 1: cancel with residual customReply -> MUST resolve { action: 'cancel' } (NOT 'decline'!) and 0 queued reply
    let openMsgId = '';
    const q1 = new AgentQuestions(
      (m) => { if (m.question?.state === 'open') openMsgId = m.id; },
      () => true,
      (sid, text) => queuedReplies.push({ sessionId: sid, text })
    );
    const pCancel = q1.request({ sessionId: 's-ask', mode: 'form', message: 'Pick one', requestedSchema: schema }, 'rpc-1');
    q1.answer({
      sessionId: 's-ask',
      messageId: openMsgId,
      action: 'cancel',
      customReply: 'stale unsent draft text',
    });
    expect(await pCancel, 'cancel 携带残留 customReply 仍须回传 action: cancel').toEqual({ action: 'cancel' });

    // Case 2: decline with residual customReply -> MUST resolve { action: 'decline' } and 0 queued reply
    let openMsgId2 = '';
    const q2 = new AgentQuestions(
      (m) => { if (m.question?.state === 'open') openMsgId2 = m.id; },
      () => true,
      (sid, text) => queuedReplies.push({ sessionId: sid, text })
    );
    const pDecline = q2.request({ sessionId: 's-ask', mode: 'form', message: 'Pick two', requestedSchema: schema }, 'rpc-2');
    q2.answer({
      sessionId: 's-ask',
      messageId: openMsgId2,
      action: 'decline',
      customReply: 'another stale draft',
    });
    expect(await pDecline).toEqual({ action: 'decline' });
    expect(queuedReplies, 'cancel/decline 均不得追加自定义 prompt').toEqual([]);
    void questions;
  });

  it('keeps the legacy model selection when createSession applies thought_level', async () => {
    const effort = (currentValue: string) => [{ id: 'thought_level', name: 'Effort', currentValue,
      options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] }];
    const { core, dir, requests } = makeSpyCore({ onRequest(method) {
      if (method === 'session/new') return { sessionId: 'mixed', configOptions: effort('high'),
        models: { currentModelId: 'mock-model-a', availableModels: ['mock-model-a', 'mock-model-b'].map(modelId => ({ modelId, name: modelId })) } };
      if (method === 'session/set_config_option') return { configOptions: effort('low') };
    } });
    const result = await core.createSession({ cwd: dir, modelId: 'mock-model-b', reasoningEffort: 'low' });
    expect(result).toMatchObject({ modelId: 'mock-model-b', reasoningEffort: 'low' });
    expect(requests).toContainEqual({ method: 'session/set_model', params: { sessionId: 'mixed', modelId: 'mock-model-b' } });
    expect(requests).toContainEqual({ method: 'session/set_config_option', params: { sessionId: 'mixed', configId: 'thought_level', value: 'low' } });
  });

  it('R06-C (U-02 BE): createSession 显式传 modelId/reasoningEffort 精准应用，并复用 model-catalog 缓存', async () => {
    const dir = makeTempDir('gravity-v034-u02-');
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });

    const { core, requests } = makeSpyCore({
      dataDir: dir,
      onRequest: (method, params) => {
        if (method === 'session/set_config_option') {
          const p = params as { configId: string; value: string };
          return {
            configOptions: [
              { id: 'mode', name: 'Mode', currentValue: p.configId === 'mode' ? p.value : 'default', options: [{ value: 'default', name: 'Default' }, { value: 'accept-edits', name: 'Accept Edits' }] },
              { id: 'model', name: 'Model', currentValue: p.configId === 'model' ? p.value : 'gemini-4-neon', options: [{ value: 'gemini-3.8-flash', name: 'Flash' }, { value: 'gemini-4-neon', name: 'Neon' }] },
              { id: 'thought_level', name: 'Effort', currentValue: p.configId === 'thought_level' ? p.value : 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
            ],
          };
        }
        return undefined;
      },
    });

    const created = await core.createSession({
      cwd,
      title: 'u02-model',
      modelId: 'gemini-4-neon',
      reasoningEffort: 'high',
      executionMode: 'accept-edits',
    });
    expect(created.modelId).toBe('gemini-4-neon');
    expect(created.reasoningEffort).toBe('high');
    expect(created.executionMode).toBe('accept-edits');
    expect(
      requests.some(
        (r) =>
          r.method === 'session/set_config_option' &&
          (r.params as { configId?: string; value?: string }).configId === 'model' &&
          (r.params as { value?: string }).value === 'gemini-4-neon'
      )
    ).toBe(true);

    // 关闭会话并重启后，无活动会话时 connectionStatus.availableModels 应复用 cached model-catalog
    await core.closeSession(created.sessionId);
    await core.dispose();
    services.pop();

    const { core: reloaded } = makeSpyCore({ dataDir: dir });
    const status = await reloaded.getConnectionStatus();
    expect(status.modelListSource).toBe('cached');
    expect(status.availableModels.map((m) => m.modelId)).toContain('gemini-4-neon');
  });
});

/* ============================================================================
 * R07: IPC-01 & U-01 (BE)
 * ========================================================================== */

describe('R07 · IPC-01（附件解码字节预算放行 2×12 MiB）与 U-01（copyText 主进程复制）', () => {
  it('R07-A (IPC-01): 2×12 MiB 合法 Base64 附件通过 IPC 路由，超限/非法编码拒绝且送 ACP = 0', async () => {
    const { core, requests, dir } = makeSpyCore();
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sess = await core.createSession({ cwd, title: 'ipc01' });

    const handlers = new Map<string, Function>();
    const ipcMain = {
      handle: (ch: string, cb: Function) => handlers.set(ch, cb),
      removeHandler: (ch: string) => handlers.delete(ch),
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const dispose = registerIpcRouter(ipcMain, core, trusted);
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;

    try {
      const sendHandler = handlers.get(IPC_CHANNELS.SESSION_SEND_PROMPT)!;
      const b64_12MiB = Buffer.alloc(12 * 1024 * 1024, 0x42).toString('base64'); // 16 MiB base64 string -> 2x = 32 MiB + overhead > 32 MiB raw!
      expect(b64_12MiB.length).toBe(16 * 1024 * 1024);

      // 1. 合法 2×12 MiB（解码 24 MiB）必须受理并成功送达 ACP
      await sendHandler(event, {
        sessionId: sess.sessionId,
        text: 'two 12MiB attachments',
        attachments: [
          { name: 'a.bin', mimeType: 'application/octet-stream', dataBase64: b64_12MiB, sizeBytes: 12 * 1024 * 1024 },
          { name: 'b.bin', mimeType: 'application/octet-stream', dataBase64: b64_12MiB, sizeBytes: 12 * 1024 * 1024 },
        ],
      });
      expect(requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1);

      // 2. 修订入口同样受理原消息携带的 2×12 MiB 附件
      const firstUser = core.messages.recent(sess.sessionId).find((m) => m.role === 'user')!;
      const reviseHandler = handlers.get(IPC_CHANNELS.SESSION_REVISE_MESSAGE)!;
      const revised = await reviseHandler(event, {
        sessionId: sess.sessionId,
        messageId: firstUser.id,
        text: 'revised with both 12MiB attachments',
        attachmentIds: firstUser.attachments!.map((a) => a.id),
      });
      expect(revised.sessionId).not.toBe(sess.sessionId);

      // 3. 超限（单文件 21 MiB）或非法 Base64 编码必须拒绝且送 ACP = 0
      const promptsBeforeInvalid = requests.filter((r) => r.method === 'session/prompt').length;
      const b64_21MiB = Buffer.alloc(21 * 1024 * 1024, 0x43).toString('base64');
      await expect(
        Promise.resolve().then(() =>
          sendHandler(event, {
            sessionId: revised.sessionId,
            text: 'too big',
            attachments: [{ name: 'big.bin', mimeType: 'application/octet-stream', dataBase64: b64_21MiB, sizeBytes: 21 * 1024 * 1024 }],
          })
        )
      ).rejects.toThrow();

      await expect(
        Promise.resolve().then(() =>
          sendHandler(event, {
            sessionId: revised.sessionId,
            text: 'bad base64',
            attachments: [{ name: 'bad.bin', mimeType: 'application/octet-stream', dataBase64: '@@@not-valid-base64@@@', sizeBytes: 10 }],
          })
        )
      ).rejects.toThrow();
      expect(requests.filter((r) => r.method === 'session/prompt').length).toBe(promptsBeforeInvalid);
    } finally {
      dispose();
    }
  });

  it('R07-B (U-01 BE): copyText 合法多行代码精准写剪贴板，超 4 MB 与非主 frame 均拒绝', async () => {
    const clipboardWrites: string[] = [];
    const { core } = makeSpyCore({ copyTextHandler: (txt) => { clipboardWrites.push(txt); } });
    const handlers = new Map<string, Function>();
    const ipcMain = { handle: (ch: string, cb: Function) => handlers.set(ch, cb), removeHandler: (ch: string) => handlers.delete(ch) } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const dispose = registerIpcRouter(ipcMain, core, trusted);
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;

    try {
      const copyFn = handlers.get(IPC_CHANNELS.APP_COPY_TEXT)!;
      const code = 'function hello() {\n  return "Gravity v0.3.4";\n}\n';
      await copyFn(event, code);
      expect(clipboardWrites).toEqual([code]);

      await expect(copyFn(event, 'x'.repeat(4 * 1024 * 1024 + 1))).rejects.toThrow(/4 MB|大小/);
      expect(() => copyFn({ ...event, senderFrame: { url: 'https://evil.invalid/' } }, 'bad')).toThrow('非主窗口');
      expect(clipboardWrites).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

/* ============================================================================
 * R08: APR-01 & D4 Key Projection Lifecycle
 * ========================================================================== */

describe('R08 · APR-01（重载恢复 activeReviews 与防重复放行）与 D4（密钥投影留空/清除/换源）', () => {
  it('R08-A (APR-01): 二阶段外部 AI 复核期间重载窗口，Bootstrap 恢复 activeReviews、同请求仅 1 卡且迟到 AI 重复放行 = 0', async () => {
    let resolveReview!: (res: { recommended: 'approve'; riskLevel: 'low'; riskScore: 10; intentAlignment: 'aligned'; reason: string; latencyMs: number }) => void;
    const { core, dir } = makeSpyCore({
      secretCipher: makeCipher(),
      reviewer: vi.fn((_cmd, _cwd, _cfg, ctx) => {
        if (ctx?.intentSummary?.includes('Connection test')) {
          return Promise.resolve({
            recommended: 'approve', riskLevel: 'safe', riskScore: 5, intentAlignment: 'aligned', reason: 'probe ok', latencyMs: 5,
          });
        }
        return new Promise((resolve) => { resolveReview = resolve; });
      }) as unknown as Reviewer,
    });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const sess = await core.createSession({ cwd, title: 'apr01' });

    const reviewerCfg: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
      timeoutMs: 10_000,
    };
    expect((await core.testExternalReviewerConnection(reviewerCfg)).ok).toBe(true);
    await core.updateApprovalConfig({ mode: 'hybrid', externalReviewer: reviewerCfg });

    // Start a Stage 2 review that remains pending
    const permPromise = core.approval.requestPermission(
      {
        sessionId: sess.sessionId,
        toolCall: { toolCallId: 'tc-apr01', kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'npm publish --dry-run' } },
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
      cwd
    );

    await vi.waitFor(() => expect(resolveReview).toBeDefined());

    // Simulate window reload -> getBootstrap() MUST include activeReviews with 1 reviewing entry, 0 duplicate in pendingApprovals
    const boot = await core.getBootstrap();
    expect(boot.activeReviews, 'APR-01: Bootstrap 必须返回进行中的 activeReviews 供重载接管').toHaveLength(1);
    expect(boot.activeReviews![0].sessionId).toBe(sess.sessionId);
    expect(boot.activeReviews![0].status).toBe('reviewing');
    const reqId = boot.activeReviews![0].requestId;
    expect(boot.pendingApprovals.some((p) => p.requestId === reqId)).toBe(false);

    // Human cancels Stage 2 review to take over manually
    expect((await core.cancelStage2ApprovalReview(reqId)).cancelled).toBe(true);
    const bootAfterTakeover = await core.getBootstrap();
    expect(bootAfterTakeover.activeReviews ?? []).toHaveLength(0);
    expect(bootAfterTakeover.pendingApprovals.filter((p) => p.requestId === reqId)).toHaveLength(1);

    // Late AI response arrives with 'approve' -> MUST NOT auto-approve! Card stays awaiting manual decision!
    resolveReview({ recommended: 'approve', riskLevel: 'low', riskScore: 10, intentAlignment: 'aligned', reason: 'late approve', latencyMs: 50 });
    await new Promise((r) => setTimeout(r, 30));
    expect(core.approval.listAwaitingUser().filter((p) => p.requestId === reqId)).toHaveLength(1);

    // Cleanly reject to settle promise
    await core.submitApprovalDecision({ requestId: reqId, sessionId: sess.sessionId, decision: 'reject_with_feedback', feedbackText: 'done' });
    await permPromise;
  });

  it('R08-B (D4): 复核与翻译 Key 保存/重启/留空保原/清空/换源（公开配置明文 Key = 0，换 origin 继承旧 Key = 0）', async () => {
    const dir = makeTempDir('gravity-v034-d4-lifecycle-');
    const cipher = makeCipher();
    const key1 = 'sk-v034-d4-primary-key-alpha';
    const seenReviewerKeys: Array<string | undefined> = [];
    const seenTranslatorKeys: Array<string | undefined> = [];

    const makeSvc = () =>
      makeSpyCore({
        dataDir: dir,
        secretCipher: cipher,
        reviewer: vi.fn(async (_cmd, _cwd, cfg) => {
          seenReviewerKeys.push(cfg.apiKey);
          return { recommended: 'approve', riskLevel: 'safe', riskScore: 5, intentAlignment: 'aligned', reason: 'ok', latencyMs: 5 };
        }) as unknown as Reviewer,
        externalTranslator: vi.fn(async (_txt, cfg) => {
          seenTranslatorKeys.push(cfg.apiKey);
          return { text: '正在检查配置文件。', latencyMs: 5 };
        }),
      });

    // 1. Save with Key
    const s1 = makeSvc();
    const emitted: Array<ApproveForMeConfig | TranslationConfig> = [];
    s1.core.on('approval-config-updated', (c: ApproveForMeConfig) => emitted.push(c));
    s1.core.on('translation-config-updated', (c: TranslationConfig) => emitted.push(c));

    await s1.core.testExternalReviewerConnection({
      enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: key1, timeoutMs: 3000,
    });
    const revSaved = await s1.core.updateApprovalConfig({
      mode: 'hybrid',
      externalReviewer: { enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: key1, timeoutMs: 3000 },
    });
    await s1.core.testExternalTranslatorConnection({
      enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: key1, timeoutMs: 3000,
    });
    const trnSaved = await s1.core.updateTranslationConfig({
      engine: 'external-api',
      externalTranslator: { enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: key1, timeoutMs: 3000 },
    });

    expect(revSaved.externalReviewer.apiKey).toBeUndefined();
    expect(revSaved.externalReviewer.hasApiKey).toBe(true);
    expect(trnSaved.externalTranslator.apiKey).toBeUndefined();
    expect(trnSaved.externalTranslator.hasApiKey).toBe(true);
    expect(JSON.stringify(emitted)).not.toContain(key1);

    await s1.core.dispose();
    services.pop();

    // 2. Restart: Bootstrap still hides plaintext, hasApiKey = true; omitted apiKey retains key for test & save!
    const s2 = makeSvc();
    const boot2 = await s2.core.getBootstrap();
    expect(boot2.approvalConfig.externalReviewer.apiKey).toBeUndefined();
    expect(boot2.approvalConfig.externalReviewer.hasApiKey).toBe(true);
    expect(boot2.translationConfig.externalTranslator.apiKey).toBeUndefined();
    expect(boot2.translationConfig.externalTranslator.hasApiKey).toBe(true);

    // Update omitting apiKey -> retains original key
    const keptRev = await s2.core.updateApprovalConfig({
      externalReviewer: { timeoutMs: 5000 } as ExternalAiReviewerConfig,
    });
    expect(keptRev.externalReviewer.apiKey).toBeUndefined();
    expect(keptRev.externalReviewer.hasApiKey).toBe(true);

    // Test connection omitting apiKey -> main process injects real decrypted key
    seenReviewerKeys.length = 0;
    await s2.core.testExternalReviewerConnection({
      enabled: true, provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 5000,
    });
    expect(seenReviewerKeys.at(-1)).toBe(key1);

    // 3. Change origin omitting apiKey -> MUST NOT inherit old key!
    const switchedOrigin = await s2.core.updateApprovalConfig({
      externalReviewer: {
        enabled: false,
        provider: 'openai-compatible',
        endpoint: 'https://openrouter.ai/api/v1',
        model: 'gpt-4o-mini',
        timeoutMs: 5000,
      },
    });
    expect(switchedOrigin.externalReviewer.apiKey).toBeUndefined();
    expect(switchedOrigin.externalReviewer.hasApiKey).toBe(false);

    // 4. Explicitly clear translator key with apiKey: '' -> hasApiKey becomes false
    const clearedTrn = await s2.core.updateTranslationConfig({
      externalTranslator: { apiKey: '' },
    });
    expect(clearedTrn.externalTranslator.apiKey).toBeUndefined();
    expect(clearedTrn.externalTranslator.hasApiKey).toBe(false);
  });
});

/* ============================================================================
 * R09: SKL-01 & PLG-01
 * ========================================================================== */

describe('R09 · SKL-01（Skills 写盘失败回滚一致）与 PLG-01（未知插件 JSON 结构报分区错误）', () => {
  it('R09-A (SKL-01): Skills 写盘失败后再改另一项，失败项内存/磁盘/UI 保持一致未改', async () => {
    const dir = makeTempDir('gravity-v034-skl01-');
    const ws = path.join(dir, 'ws');
    for (const name of ['skill-a', 'skill-b']) {
      const p = path.join(ws, '.agents', 'skills', name, 'SKILL.md');
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, `---\nname: ${name}\ndescription: test\n---\nbody`, 'utf8');
    }
    const store = new ClientStore(path.join(dir, 'store'));
    const mgr = new PluginsManager({
      store,
      homeDir: path.join(dir, 'home'),
      executor: vi.fn<CliExecutor>(async (_b, args) => ({
        stdout: args[0] === 'plugin' ? '[]' : '{"mcpServers":{}}',
      })),
    });

    const snap0 = await mgr.getSnapshot(ws);
    const skillA = snap0.skills.find((s) => s.name === 'skill-a')!;
    const skillB = snap0.skills.find((s) => s.name === 'skill-b')!;
    expect(skillA.enabled).toBe(true);
    expect(skillB.enabled).toBe(true);

    // Fail write when toggling skillA -> false
    const origWrite = store.write.bind(store);
    let failOnce = true;
    vi.spyOn(store, 'write').mockImplementation((name, value) => {
      if (failOnce && name === 'skill-preferences.json') {
        failOnce = false;
        throw new Error('EACCES: simulated write failure');
      }
      return origWrite(name, value);
    });

    expect(() => mgr.toggleSkillEnabled(skillA.id, false)).toThrow(/EACCES/);

    // Now toggle skillB -> false (succeeds)
    const afterB = mgr.toggleSkillEnabled(skillB.id, false);
    expect(afterB.skills.find((s) => s.id === skillB.id)?.enabled).toBe(false);
    expect(afterB.skills.find((s) => s.id === skillA.id)?.enabled).toBe(true);

    // Disk & fresh getSnapshot MUST still show skillA enabled === true!
    const persisted = store.read<Record<string, boolean>>('skill-preferences.json', {});
    expect(persisted[skillA.id], '写盘失败的 skillA 不得残留在内存并在下次写入落盘').not.toBe(false);
    const snapReloaded = await mgr.getSnapshot(ws);
    expect(snapReloaded.skills.find((s) => s.id === skillA.id)?.enabled).toBe(true);
    expect(snapReloaded.skills.find((s) => s.id === skillB.id)?.enabled).toBe(false);
  });

  it('R09-B (PLG-01): plugin list --json 合法空表无错，未知结构恰报 1 分区错误且 MCP 正常', async () => {
    const dir = makeTempDir('gravity-v034-plg01-');
    const ws = path.join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    let pluginOutput = '[]';

    const mgr = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      homeDir: path.join(dir, 'home'),
      executor: vi.fn<CliExecutor>(async (_b, args) => {
        if (args[0] === 'plugin') return { stdout: pluginOutput };
        return { stdout: JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['docs.js'], enabled: true } } }) };
      }),
    });

    // Valid empty outputs
    for (const validEmpty of ['[]', '{"plugins":[]}']) {
      pluginOutput = validEmpty;
      const snap = await mgr.getSnapshot(ws);
      expect(snap.sectionErrors?.plugins).toBeUndefined();
      expect(snap.plugins).toEqual([]);
      expect(snap.mcpServers.map((m) => m.name)).toEqual(['docs']);
    }

    // Unknown JSON structures -> MUST report sectionErrors.plugins while MCP stays healthy
    for (const unknownShape of ['{"items":[]}', '{"ok":true}', 'null', '42']) {
      pluginOutput = unknownShape;
      const snap = await mgr.getSnapshot(ws);
      expect(snap.sectionErrors?.plugins, `未知插件 JSON 结构 ${unknownShape} 必须报告分区错误`).toBeTruthy();
      expect(Object.keys(snap.sectionErrors || {})).toEqual(['plugins']);
      expect(snap.mcpServers.map((m) => m.name)).toEqual(['docs']);
    }
  });
});

/* ============================================================================
 * R10: SWM-02 & TEL-01
 * ========================================================================== */

describe('R10 · SWM-02（同成员并发 2 同名工具状态）与 TEL-01（新回合首片前实时速度归零）', () => {
  it('R10-A (SWM-02): 同成员并发 2 个同名工具按两种结束顺序，第 1 个结束仍显示第 2 个动作，全结束才清空', () => {
    for (const finishOrder of [
      ['tc-1', 'tc-2'],
      ['tc-2', 'tc-1'],
    ] as const) {
      const tracker = new SwarmTracker();
      trackers.push(tracker);
      const sid = `s-swm02-${finishOrder.join('-')}`;

      // Spawn worker 'alice'
      tracker.consume(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-spawn',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'add', name: 'alice', brief: 'parallel tools' },
      });

      // Start 2 concurrent in_progress calls with the SAME tool name for 'alice'
      tracker.consume(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        name: 'post_message',
        status: 'in_progress',
        rawInput: { sender: 'alice', content: 'first msg' },
      });
      tracker.consume(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-2',
        name: 'post_message',
        status: 'in_progress',
        rawInput: { sender: 'alice', content: 'second msg' },
      });

      expect(tracker.getState(sid).workers[0].currentAction).toBe('正在执行 post_message');

      // Finish 1st call -> 2nd call is STILL in progress, so currentAction MUST remain!
      tracker.consume(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: finishOrder[0],
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'alice', content: `done ${finishOrder[0]}` },
      });
      expect(
        tracker.getState(sid).workers[0].currentAction,
        `顺序 ${finishOrder.join('->')}：第 1 个结束后第 2 个仍在运行，currentAction 不得被提前清空`
      ).toBe('正在执行 post_message');

      // Finish 2nd call -> now ALL concurrent calls finished, currentAction MUST clear!
      tracker.consume(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: finishOrder[1],
        name: 'post_message',
        status: 'completed',
        rawInput: { sender: 'alice', content: `done ${finishOrder[1]}` },
      });
      expect(tracker.getState(sid).workers[0].currentAction).toBeUndefined();
    }
  });

  it('R10-B (TEL-01): 新回合 beginTurn 后首片到达前实时速度 currentTokensPerSecond = 0，均速与峰值保留', () => {
    let now = Date.UTC(2026, 10, 26, 13, 0, 0);
    const store = new TelemetryStore({
      store: new ClientStore(makeTempDir('gravity-v034-tel01-')),
      now: () => now,
      profileId: 'default',
    });
    telemetries.push(store);

    // Turn 1 produces real output speed
    store.ensure('s-tel', 'gemini-4-neon');
    store.beginTurn('s-tel', 'first question');
    now += 500;
    store.addChunk('s-tel', 'A'.repeat(200));
    now += 500;
    store.addChunk('s-tel', 'B'.repeat(200));
    store.endTurn('s-tel');

    const afterTurn1 = store.getSessionTelemetry('s-tel')!;
    expect(afterTurn1.currentTokensPerSecond).toBeGreaterThan(0);
    expect(afterTurn1.averageTokensPerSecond).toBeGreaterThan(0);
    expect(afterTurn1.peakTokensPerSecond).toBeGreaterThan(0);
    const peak1 = afterTurn1.peakTokensPerSecond;
    const avg1 = afterTurn1.averageTokensPerSecond!;

    // Turn 2 begins — BEFORE first chunk arrives, real-time speed MUST be 0 while avg & peak remain!
    now += 2000;
    store.beginTurn('s-tel', 'second question');
    const beforeFirstChunk = store.getSessionTelemetry('s-tel')!;
    expect(beforeFirstChunk.currentTokensPerSecond, '新回合首片前实时速度必须归零而非残留上轮速度').toBe(0);
    expect(beforeFirstChunk.peakTokensPerSecond).toBe(peak1);
    expect(beforeFirstChunk.averageTokensPerSecond).toBe(avg1);
  });
});

/* ============================================================================
 * R11: BR-01 & MED-01
 * ========================================================================== */

describe('R11 · BR-01（修订失败回滚不丢无关布局）与 MED-01（等长保 mtime 替换图片一致性）', () => {
  it('R11-A (BR-01): 修订建分支期间调整布局后建分支失败，无关布局改动丢失 = 0', async () => {
    let holdCreate!: (res: unknown) => void;
    let createCalls = 0;
    const { core, dir } = makeSpyCore({
      onRequest: (method) => {
        if (method === 'session/new') {
          createCalls += 1;
          if (createCalls === 2) {
            return new Promise((resolve) => { holdCreate = resolve; });
          }
        }
        return undefined;
      },
    });
    const cwd = path.join(dir, 'ws');
    mkdirSync(cwd, { recursive: true });
    const origin = await core.createSession({ cwd, title: 'br01-origin' });
    await core.saveWorkspaceLayout({
      openTabSessionIds: [origin.sessionId],
      activePrimarySessionId: origin.sessionId,
      leftSidebarWidth: 260,
      activeInspectorTab: 'context',
    });
    await core.sendPrompt({ sessionId: origin.sessionId, text: 'first prompt' });
    const firstUser = core.messages.recent(origin.sessionId).find((m) => m.role === 'user')!;

    // Make recordBranch throw after branch session is created so reviseMessage hits catch rollback!
    vi.spyOn(core.trees, 'recordBranch').mockImplementation(() => {
      throw new Error('simulated tree persist failure');
    });

    const revisePromise = core.reviseMessage({
      sessionId: origin.sessionId,
      messageId: firstUser.id,
      text: 'edited prompt',
    });
    await vi.waitFor(() => expect(holdCreate).toBeDefined());

    // While branch creation is in flight, user resizes sidebar & switches inspector tab
    await core.saveWorkspaceLayout({ leftSidebarWidth: 410, activeInspectorTab: 'plan' });

    // Complete session/new with full matching configOptions -> recordBranch throws -> rollback runs
    holdCreate({
      sessionId: 'sess-br01-failed',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
        {
          id: 'model',
          name: 'Model',
          currentValue: 'gemini-3.8-flash',
          options: [{ value: 'gemini-3.8-flash', name: 'Flash' }],
        },
        {
          id: 'thought_level',
          name: 'Effort',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    await expect(revisePromise).rejects.toThrow(/simulated tree persist failure/);

    // Unrelated layout adjustments MUST be preserved after rollback!
    const boot = await core.getBootstrap();
    expect(boot.layout.leftSidebarWidth, 'BR-01: 回滚失败分支不得覆盖用户期间调整的侧栏宽度').toBe(410);
    expect(boot.layout.activeInspectorTab, 'BR-01: 回滚失败分支不得覆盖用户期间切换的检视器页签').toBe('plan');
    expect(boot.layout.openTabSessionIds).toContain(origin.sessionId);
  });

  it('R11-B (MED-01): 等长保 mtime 替换图片二次探测，预览字节与尺寸来自同一版本且 0 句柄泄漏', async () => {
    const ws = makeTempDir('gravity-v034-med01-');
    const imgPath = path.join(ws, 'sample.png');

    const pngV1 = makeMinimalPng(10, 20);
    const pngV2 = makeMinimalPng(30, 40);
    expect(pngV1.length).toBe(pngV2.length);

    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    writeFileSync(imgPath, pngV1);
    utimesSync(imgPath, fixedTime, fixedTime);
    const st1 = statSync(imgPath);

    const res1 = await inspectLocalTargets({ targets: ['sample.png'], cwd: ws });
    const item1 = res1.items['sample.png'];
    expect(item1.kind).toBe('image');
    expect(item1.width).toBe(10);
    expect(item1.height).toBe(20);
    expect(item1.previewDataUrl).toBeTruthy();

    // Replace with DIFFERENT PNG of EXACT SAME byte length AND bit-identical mtimeMs!
    writeFileSync(imgPath, pngV2);
    utimesSync(imgPath, fixedTime, fixedTime);
    expect(statSync(imgPath).mtimeMs).toBe(st1.mtimeMs);
    expect(statSync(imgPath).size).toBe(st1.size);

    const res2 = await inspectLocalTargets({ targets: ['sample.png'], cwd: ws });
    const item2 = res2.items['sample.png'];
    expect(item2.width).toBe(30);
    expect(item2.height).toBe(40);
    expect(item2.previewDataUrl).toBeTruthy();

    const decodedBytes = Buffer.from(item2.previewDataUrl!.split(',', 2)[1], 'base64');
    const previewWidth = decodedBytes.readUInt32BE(16);
    const previewHeight = decodedBytes.readUInt32BE(20);
    expect([previewWidth, previewHeight], 'MED-01: 预览 DataURL 字节与探测尺寸必须来自同一图片版本').toEqual([30, 40]);

    // Deleting file immediately confirms zero leaked OS file handles (especially on Windows)
    expect(() => rmSync(imgPath)).not.toThrow();
  });
});

/* ============================================================================
 * R12: QTA-01
 * ========================================================================== */

describe('R12 · QTA-01（Win/Mac 额度白名单字段投影、保留 0 值、退出 0 临时残留、非默认 Profile 0 探测）', () => {
  it('R12 (QTA-01 / ACQ-01): 最小字段白名单投影（Win buckets / Mac quota）、保留 0 值与禁用桶、临时目录 0 残留、非默认 Profile 0 探测', async () => {
    const richPayload = {
      product: 'antigravity',
      email: 'private-user@example.invalid',
      account_id: 'acct-secret-999',
      token: 'ya29.TOP_LEVEL_SECRET_TOKEN',
      cwd: 'C:\\SecretWorkspace',
      plan_tier: 'Pro',
      quota: {
        zero_bucket: {
          remaining_fraction: 0,
          remaining_amount: 0,
          reset_in_seconds: 0,
          internal_email: 'leak@example.invalid',
          nested: { privateToken: 'ya29.MUST_NOT_WRITE_TO_DISK' },
        },
        disabled_bucket: {
          disabled: true,
          extra_debug: 'should-be-dropped',
        },
        empty_waiting: {},
      },
    };
    const expectedMacProjected = {
      plan: 'Pro',
      quota: {
        zero_bucket: {
          remaining_fraction: 0,
          remaining_amount: 0,
          reset_in_seconds: 0,
        },
        disabled_bucket: {
          disabled: true,
        },
      },
    };

    // 1. macOS status-line-macos.js whitelist projection
    const macJs = readFileSync(path.resolve(process.cwd(), 'assets/quota/status-line-macos.js'), 'utf8');
    const macProject = vm.runInNewContext(macJs + '\nquotaSnapshot', { ObjC: { import() {} } }) as (v: unknown) => unknown;
    expect(JSON.parse(JSON.stringify(macProject(richPayload)))).toEqual(expectedMacProjected);

    // 2. Non-default profile must throw AccountQuotaUnavailable('profile') with 0 probe invocations
    await expect(
      quotaModule.readAccountQuota({
        profileId: 'profile-11111111-1111-1111-1111-111111111111',
        name: 'Isolated',
        isDefault: false,
        createdAt: '',
        lastActivatedAt: '',
      })
    ).rejects.toMatchObject({ reason: 'profile' });

    // 3. queryQuotaSnapshot leaves 0 temporary files/directories behind on exit (legacy quota format)
    const tempRoot = makeTempDir('gravity-v034-qta01-root-');
    const snap = await quotaModule.queryQuotaSnapshot('default', tempRoot, async (_dir, resultFile) => {
      writeFileSync(resultFile, JSON.stringify(expectedMacProjected), 'utf8');
    });
    expect(snap.buckets.find((b) => b.id === 'zero_bucket')).toMatchObject({ remainingFraction: 0, remainingAmount: 0 });
    expect(snap.buckets.find((b) => b.id === 'disabled_bucket')?.disabled).toBe(true);
    expect(readdirSync(tempRoot), '额度查询退出后临时目录残留必须为 0').toEqual([]);

    // 4. Windows real status-line PowerShell callback: ACQ-01 minimal whitelist { plan?, buckets: [...] }
    if (process.platform === 'win32') {
      // Transpile account-quota.ts with a stubbed child_process to capture the exact runtime GRAVITY_QUOTA_COMMAND!
      const quotaSrc = readFileSync(path.resolve(process.cwd(), 'src/main/accounts/account-quota.ts'), 'utf8');
      const compiled = ts.transpileModule(quotaSrc, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;

      let capturedCommand = '';
      const modExports: Record<string, unknown> = {};
      const customRequire = (spec: string) => {
        if (spec === 'node:child_process') {
          return {
            execFile: (_file: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: (err: Error | null) => void) => {
              capturedCommand = opts?.env?.GRAVITY_QUOTA_COMMAND || '';
              cb(new Error('captured'));
            },
            spawn: () => { throw new Error('unexpected spawn'); },
          };
        }
        if (spec === '../acp/acp-client') return { discoverAgyBinary: () => 'C:\\Fake\\agy.exe' };
        if (spec === '../acp/agy-environment') return { buildAgyEnvironment: () => ({}) };
        if (spec === './account-temp') {
          return {
            createAccountTempDirectory: async (r: string) => mkdtempSync(path.join(r, 'cap-')),
            readAccountTempFile: async () => '',
          };
        }
        return require(spec);
      };
      vm.runInNewContext(compiled, {
        exports: modExports,
        module: { exports: modExports },
        require: customRequire,
        __dirname: path.resolve(process.cwd(), 'src/main/accounts'),
        process,
        Buffer,
        Date,
        Set,
        Object,
        JSON,
        Number,
        Error,
        Promise,
        setTimeout,
        clearTimeout,
      });

      const capturedRead = modExports.readAccountQuota as typeof quotaModule.readAccountQuota;
      await capturedRead(
        { profileId: 'default', name: 'Default', isDefault: true, createdAt: '', lastActivatedAt: '' },
        'C:\\Fake\\agy.exe'
      ).catch(() => {});

      const encMatch = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(capturedCommand);
      expect(encMatch, '未能从 Windows 额度命令中提取 -EncodedCommand').not.toBeNull();

      const outDir = makeTempDir('gravity-v034-qta01-win-');
      const outFile = path.join(outDir, 'quota.json');
      const psRun = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encMatch![1]],
        {
          input: JSON.stringify(richPayload),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000,
          env: { ...process.env, GRAVITY_QUOTA_RESULT: outFile },
        }
      );
      expect(psRun.error).toBeUndefined();
      expect(psRun.status).toBe(0);
      expect(existsSync(outFile)).toBe(true);

      const rawWritten = readFileSync(outFile, 'utf8');
      expect(rawWritten, 'ACQ-01: Windows 额度临时文件不得写入多余嵌套字段或敏感信息').not.toContain('privateToken');
      expect(rawWritten).not.toContain('TOP_LEVEL_SECRET_TOKEN');
      expect(rawWritten).not.toContain('internal_email');
      expect(rawWritten).not.toContain('private-user@example.invalid');
      expect(rawWritten).not.toContain('acct-secret-999');
      expect(rawWritten).not.toContain('SecretWorkspace');
      expect(rawWritten).not.toContain('extra_debug');
      expect(rawWritten).not.toContain('empty_waiting');

      const parsedWin = JSON.parse(rawWritten) as {
        plan?: unknown;
        quota?: unknown;
        buckets?: Array<Record<string, unknown>>;
      };
      // ACQ-01 契约：不透传原始 $j.quota，仅落盘最小白名单 { plan?, buckets: [...] }
      expect(parsedWin.quota, 'ACQ-01: Windows 临时文件不得透传原始 quota 对象').toBeUndefined();
      expect(Object.keys(parsedWin).every((k) => k === 'plan' || k === 'buckets')).toBe(true);
      expect(parsedWin.plan).toBe('Pro');
      expect(Array.isArray(parsedWin.buckets)).toBe(true);
      expect(parsedWin.buckets).toHaveLength(2);

      const allowedBucketKeys = new Set(['id', 'remainingFraction', 'remainingAmount', 'resetAt', 'disabled']);
      for (const bucket of parsedWin.buckets!) {
        for (const key of Object.keys(bucket)) {
          expect(allowedBucketKeys.has(key), `ACQ-01: 桶对象含非白名单字段 "${key}"`).toBe(true);
        }
      }

      const zeroBucket = parsedWin.buckets!.find((b) => b.id === 'zero_bucket');
      expect(zeroBucket).toBeDefined();
      expect(zeroBucket!.remainingFraction).toBe(0);
      expect(zeroBucket!.remainingAmount).toBe(0);
      expect(zeroBucket!.disabled).toBe(false);
      if (zeroBucket!.resetAt !== undefined) {
        expect(typeof zeroBucket!.resetAt).toBe('string');
        expect(Number.isFinite(Date.parse(zeroBucket!.resetAt as string))).toBe(true);
      }

      const disabledBucket = parsedWin.buckets!.find((b) => b.id === 'disabled_bucket');
      expect(disabledBucket).toBeDefined();
      expect(disabledBucket!.disabled).toBe(true);

      // parseQuota 兼容新 buckets 白名单格式回环解析
      const reparsed = quotaModule.parseQuota(parsedWin as never, 'default');
      expect(reparsed.plan).toBe('Pro');
      expect(reparsed.buckets.find((b) => b.id === 'zero_bucket')).toMatchObject({ remainingFraction: 0, remainingAmount: 0, disabled: false });
      expect(reparsed.buckets.find((b) => b.id === 'disabled_bucket')).toMatchObject({ disabled: true });
    }
  });
});

/* ============================================================================
 * R13: UPD-01 & UPD-02
 * ========================================================================== */

describe('R13 · UPD-01（下载收据完整性校验）与 UPD-02（跨平台资产精准筛选与回滚）', () => {
  it('R13-A (UPD-01): 等长篡改包、截断包、无收据旧缓存安装回调均为 0；合法包安装回调 = 1', async () => {
    const payload = Buffer.from('MZ-VALID-GRAVITY-v0.3.4-BINARY-PAYLOAD-0001');
    const tamperedSameLen = Buffer.from('MZ-EVIL!-GRAVITY-v0.3.4-BINARY-PAYLOAD-9999');
    expect(tamperedSameLen.length).toBe(payload.length);

    const makeFetcher = () =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.github.com')) {
          return Response.json({
            tag_name: 'v0.3.4',
            assets: [
              {
                name: 'Gravity.exe',
                size: payload.length,
                browser_download_url: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.3.4/Gravity.exe',
              },
            ],
          });
        }
        return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
      }) as unknown as typeof fetch;

    // 1. Valid download -> installHandler called exactly 1 time
    const dirValid = makeTempDir('gravity-v034-upd01-ok-');
    const installOk = vi.fn().mockResolvedValue({ launched: true, message: 'ok' });
    const uOk = new GitHubUpdater({
      currentVersion: '0.3.3',
      updatesDir: dirValid,
      platform: 'win32',
      arch: 'x64',
      fetcher: makeFetcher(),
      installHandler: installOk,
    });
    const dlOk = await uOk.downloadUpdate();
    expect(dlOk.status).toBe('downloaded');
    await uOk.installUpdate();
    expect(installOk).toHaveBeenCalledTimes(1);

    // 2. Same-length tampered package -> installHandler MUST be called 0 times!
    const dirTamper = makeTempDir('gravity-v034-upd01-tamper-');
    const installTamper = vi.fn().mockResolvedValue({ launched: true, message: 'ok' });
    const uTamper = new GitHubUpdater({
      currentVersion: '0.3.3',
      updatesDir: dirTamper,
      platform: 'win32',
      arch: 'x64',
      fetcher: makeFetcher(),
      installHandler: installTamper,
    });
    const dlTamper = await uTamper.downloadUpdate();
    writeFileSync(dlTamper.downloadedFilePath!, tamperedSameLen);
    await expect(uTamper.installUpdate(), 'UPD-01: 等长篡改包必须被 SHA-256 收据拦截').rejects.toThrow();
    expect(installTamper).toHaveBeenCalledTimes(0);

    // 3. Truncated package -> installHandler called 0 times
    const dirTrunc = makeTempDir('gravity-v034-upd01-trunc-');
    const installTrunc = vi.fn().mockResolvedValue({ launched: true, message: 'ok' });
    const uTrunc = new GitHubUpdater({
      currentVersion: '0.3.3',
      updatesDir: dirTrunc,
      platform: 'win32',
      arch: 'x64',
      fetcher: makeFetcher(),
      installHandler: installTrunc,
    });
    const dlTrunc = await uTrunc.downloadUpdate();
    writeFileSync(dlTrunc.downloadedFilePath!, payload.subarray(0, 10));
    await expect(uTrunc.installUpdate()).rejects.toThrow();
    expect(installTrunc).toHaveBeenCalledTimes(0);

    // 4. Legacy unreceipted cache on disk with matching size -> checkForUpdates MUST NOT trust it as downloaded!
    const dirLegacy = makeTempDir('gravity-v034-upd01-legacy-');
    const legacyDir = path.join(dirLegacy, 'v0.3.4');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, 'Gravity.exe'), tamperedSameLen);
    const installLegacy = vi.fn().mockResolvedValue({ launched: true, message: 'ok' });
    const uLegacy = new GitHubUpdater({
      currentVersion: '0.3.3',
      updatesDir: dirLegacy,
      platform: 'win32',
      arch: 'x64',
      fetcher: makeFetcher(),
      installHandler: installLegacy,
    });
    const checkedLegacy = await uLegacy.checkForUpdates();
    expect(checkedLegacy.status, 'UPD-01: 无 SHA-256 收据的旧缓存文件不得被信任为 downloaded').toBe('available');
    await expect(uLegacy.installUpdate()).rejects.toThrow();
    expect(installLegacy).toHaveBeenCalledTimes(0);
  });

  it('R13-B (UPD-02): Linux/Win ZIP 排前混合 Release 下 Mac 精准选同架构（先 ZIP 后 DMG），错平台返回 undefined，安装回滚恢复旧包', () => {
    const base = 'https://github.com/Mikotou/G-Gravity/releases/download/v0.3.4/';
    const mixedAssets = [
      { name: 'Gravity-0.3.4-linux-arm64.zip', downloadUrl: `${base}Gravity-0.3.4-linux-arm64.zip`, sizeBytes: 100 },
      { name: 'Gravity-0.3.4-linux-x64.zip', downloadUrl: `${base}Gravity-0.3.4-linux-x64.zip`, sizeBytes: 100 },
      { name: 'Gravity-0.3.4-win-x64.zip', downloadUrl: `${base}Gravity-0.3.4-win-x64.zip`, sizeBytes: 100 },
      { name: 'Gravity-0.3.4-mac-arm64.dmg', downloadUrl: `${base}Gravity-0.3.4-mac-arm64.dmg`, sizeBytes: 200 },
      { name: 'Gravity-0.3.4-mac-arm64.zip', downloadUrl: `${base}Gravity-0.3.4-mac-arm64.zip`, sizeBytes: 190 },
      { name: 'Gravity-0.3.4-mac-x64.dmg', downloadUrl: `${base}Gravity-0.3.4-mac-x64.dmg`, sizeBytes: 205 },
    ];

    expect(
      selectReleaseAsset(mixedAssets, 'darwin', 'arm64')?.name,
      'UPD-02: macOS arm64 必须跳过 linux-arm64.zip 并优先选择 mac-arm64.zip'
    ).toBe('Gravity-0.3.4-mac-arm64.zip');
    expect(
      selectReleaseAsset(mixedAssets, 'darwin', 'x64')?.name,
      'UPD-02: macOS x64 必须跳过 linux-x64.zip/win-x64.zip 并选择 mac-x64.dmg'
    ).toBe('Gravity-0.3.4-mac-x64.dmg');

    // 仅含非 macOS 资产时必须返回 undefined（绝不误选错平台包）
    const linuxOnly = [
      { name: 'Gravity-0.3.4-linux-arm64.zip', downloadUrl: `${base}Gravity-0.3.4-linux-arm64.zip`, sizeBytes: 100 },
    ];
    expect(selectReleaseAsset(linuxOnly, 'darwin', 'arm64')).toBeUndefined();

    // Windows 回滚后旧包完整可启动（校验 windowsUpdateScript 回滚恢复逻辑）
    if (process.platform === 'win32') {
      const dir = makeTempDir('gravity-v034-upd02-rb-');
      const target = path.join(dir, 'Gravity.exe');
      const stage = path.join(dir, 'staged.exe');
      const backup = path.join(dir, 'backup.exe');
      const download = path.join(dir, 'dl.exe');
      const psFile = path.join(dir, 'rollback-check.ps1');
      writeFileSync(target, 'OLD_LAUNCHABLE_BINARY');
      writeFileSync(stage, 'BROKEN_NEW_BINARY');
      writeFileSync(download, 'BROKEN_NEW_BINARY');
      writeFileSync(
        psFile,
        '\uFEFF' +
          [
            '$script:calls = 0',
            'function Start-Process { param($FilePath) $script:calls++; if ($script:calls -eq 1) { throw "new binary crashed" } }',
            'function Start-Sleep { param($Milliseconds) }',
            windowsUpdateScript(2147483647, target, stage, backup, download),
          ].join('\r\n')
      );
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
        windowsHide: true,
        timeout: 10_000,
      });
      expect(res.status).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe('OLD_LAUNCHABLE_BINARY');
    }
  });
});

/* ============================================================================
 * R14: PATH-01, PRJ-01, WIN-01 & D2 (BE)
 * ========================================================================== */

describe('R14 · PATH-01、PRJ-01、WIN-01 与 D2 品牌图标跟随主题（BE）', () => {
  it('R14-A (D2 Wave 0 共享契约): resolveEffectiveGravityIconId 精准解析 auto 与手动锁定', () => {
    for (const preset of THEME_PRESETS) {
      expect(resolveEffectiveGravityIconId('auto', preset.id)).toBe(preset.recommendedIconId);
      expect(resolveEffectiveGravityIconId('gravity-ubuntu', preset.id)).toBe('gravity-ubuntu');
    }
    expect(resolveEffectiveGravityIconId('auto', 'system', undefined, true)).toBe('gravity-claude-light');
    expect(resolveEffectiveGravityIconId('auto', 'system', undefined, false)).toBe('gravity-claude-dark');
    expect(resolveEffectiveGravityIconId('auto', 'custom', { baseThemeId: 'solarized-dark', polarity: 'dark' })).toBe(
      'gravity-solarized'
    );

    // K6 共享层路径键函数（Wave 0 PASS）
    expect(normalizeProjectCompareKey('/Users/dev/Repo')).toBe('/Users/dev/Repo');
    expect(normalizeProjectCompareKey('/Users/dev/repo')).toBe('/Users/dev/repo');
    expect(normalizeProjectCompareKey('C:\\Work\\App')).toBe(normalizeProjectCompareKey('c:/work/app/'));
  });

  it('R14-B (PATH-01 + PRJ-01): POSIX 大小写敏感目录保留 2 项、Win 合并 1 项，且项目 defaultMode: full-access 保留不丢', async () => {
    const { core } = makeSpyCore();
    const saved = await core.updatePreferences({
      projects: [
        { id: 'p-posix-1', name: 'UpperRepo', path: '/Users/dev/Repo', defaultMode: 'full-access' },
        { id: 'p-posix-2', name: 'LowerRepo', path: '/Users/dev/repo', defaultMode: 'plan' },
        { id: 'p-win-1', name: 'WinA', path: 'C:\\Work\\ProjectA', defaultMode: 'full-access' },
        { id: 'p-win-2', name: 'WinADup', path: 'c:/work/projecta/', defaultMode: 'default' },
      ],
    });

    const paths = (saved.projects || []).map((p) => p.path);
    expect(paths, 'PATH-01: APFS/POSIX 两不同大小写目录必须保留 2 项，Windows 同目录合并为 1 项').toEqual([
      '/Users/dev/Repo',
      '/Users/dev/repo',
      'C:\\Work\\ProjectA',
    ]);
    expect(
      saved.projects?.find((p) => p.id === 'p-posix-1')?.defaultMode,
      'PRJ-01: workspace-settings 不得丢弃项目 defaultMode: full-access'
    ).toBe('full-access');
    expect(saved.projects?.find((p) => p.id === 'p-win-1')?.defaultMode).toBe('full-access');
  });

  it('R14-C (WIN-01 + D2 新用户默认 auto): 新用户默认 appIcon=auto，6 主题切换时 Windows symbolColor 与图标随主题联动', async () => {
    const { core } = makeSpyCore();
    const freshPrefs = core.getPreferences();
    expect(freshPrefs.appIcon, 'D2: 全新用户默认偏好应为 appIcon = "auto"').toBe('auto');

    // Open mocked window and sweep all 6 presets -> symbolColor must follow each theme palette (not 2 static values!)
    await openWindow(core, {}, () => undefined, () => {});
    const symbolColorsByTheme = new Map<string, string>();
    for (const preset of THEME_PRESETS) {
      mockWindowOverlays.length = 0;
      const nextPrefs = { ...freshPrefs, theme: preset.id, appIcon: 'auto' as const };
      syncWindowChrome(nextPrefs);
      if (process.platform === 'win32') {
        expect(mockWindowOverlays.length).toBeGreaterThanOrEqual(1);
        symbolColorsByTheme.set(preset.id, mockWindowOverlays.at(-1)!.symbolColor.toLowerCase());
      }
      // 图标路径按 auto 解析到对应主题原创图标
      const resolvedIcon = iconPath('auto', nextPrefs);
      expect(resolvedIcon).toContain(preset.recommendedIconId);
    }

    if (process.platform === 'win32') {
      const darkSymbols = THEME_PRESETS.filter((p) => p.polarity === 'dark').map((p) => symbolColorsByTheme.get(p.id)!);
      expect(
        new Set(darkSymbols).size,
        'WIN-01: 4 套深色主题的 Windows 标题栏控制键 symbolColor 必须随各主题 Token 联动，而非全部硬编码同一静态色值'
      ).toBeGreaterThan(1);
    }
  });
});

/* ============================================================================
 * R15: SH-01 ~ SH-05 (Wave 0 Shared PASS + Backend SH-02 Alignment TDD RED)
 * ========================================================================== */

describe('R15 · SH-01–SH-05 共享层精准匹配与后端 local-path-safety 对齐', () => {
  it('R15-A (SH-01 ~ SH-05 Wave 0 共享层): metadata.goog/八进制 IPv4、.env 模板、行号 403/429、/d%3A/、gpt-oss-120b-medium 费率全绿', () => {
    // SH-01
    expect(isBlockedExternalEndpointHost('metadata.goog')).toBe(true);
    expect(isBlockedExternalEndpointHost('metadata.google.internal')).toBe(true);
    expect(isBlockedExternalEndpointHost('0177.0.0.1')).toBe(true);
    expect(isBlockedExternalEndpointHost('0177.0.0.01')).toBe(true);
    expect(isBlockedExternalEndpointHost('0x7f.0.0.1')).toBe(true);
    expect(isBlockedExternalEndpointHost('api.openai.com')).toBe(false);

    // SH-02 (shared contract)
    expect(isForbiddenCredentialOrStatePath('/repo/.env')).toBe(true);
    expect(isForbiddenCredentialOrStatePath('/repo/.env.local')).toBe(true);
    expect(isForbiddenCredentialOrStatePath('/repo/.env.production')).toBe(true);
    expect(isForbiddenCredentialOrStatePath('/repo/.env.example')).toBe(false);
    expect(isForbiddenCredentialOrStatePath('/repo/.env.sample')).toBe(false);
    expect(isForbiddenCredentialOrStatePath('/repo/.env.template')).toBe(false);

    // SH-03 (line numbers / ports must NOT trigger 403 / 429 / 401; real HTTP errors MUST match)
    expect(classifyErrorToDiagnosticCode('TypeError at src/app.ts:403:12')).toBe('unknown_error');
    expect(classifyErrorToDiagnosticCode('Line 429: unexpected identifier')).toBe('unknown_error');
    expect(classifyErrorToDiagnosticCode('Compiled 401 modules in 200ms')).toBe('unknown_error');
    expect(classifyErrorToDiagnosticCode('HTTP 429 Too Many Requests')).toBe('rate_limited_429');
    expect(classifyErrorToDiagnosticCode('403 Forbidden: access denied')).toBe('permission_denied_403');
    expect(classifyErrorToDiagnosticCode('status 401 unauthorized')).toBe('auth_required_401');

    // SH-04
    expect(normalizeWorkspacePath('/d%3A/my%20repo')).toBe('D:\\my repo');

    // SH-05
    const ossCard = resolveModelRateCard('gpt-oss-120b-medium', DEFAULT_MODEL_RATE_CARDS);
    expect(ossCard.modelId).toBe('gpt-oss-120b-medium');
    expect(ossCard.inputPerMillionUsd).toBe(0.15);
    expect(ossCard.outputPerMillionUsd).toBe(0.6);
  });

  it('R15-B (SH-02 后端 local-path-safety 对齐): 拦截 .env/.env.local/.env.production，一致放行 .env.example/.sample/.template', () => {
    expect(isUnsafeLocalFile('/repo/.env')).toBe(true);
    expect(isUnsafeLocalFile('/repo/.env.local')).toBe(true);
    expect(isUnsafeLocalFile('/repo/.env.production')).toBe(true);
    expect(isUnsafeLocalPath('C:\\work\\project\\.env.secret')).toBe(true);

    // 后端 local-path-safety.ts:15 必须与共享层 SH-02 一致放行三个标准模板文件
    expect(isUnsafeLocalFile('/repo/.env.example'), 'local-path-safety 必须放行 .env.example').toBe(false);
    expect(isUnsafeLocalFile('/repo/.env.sample'), 'local-path-safety 必须放行 .env.sample').toBe(false);
    expect(isUnsafeLocalFile('/repo/.env.template'), 'local-path-safety 必须放行 .env.template').toBe(false);
    expect(isUnsafeLocalPath('C:\\work\\project\\.env.example')).toBe(false);
  });
});

// Ensure unused type/class references stay cleanly used if needed
void SessionMultiplexer;
void (undefined as unknown as ChatMessageItem);

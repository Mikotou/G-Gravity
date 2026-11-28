// @vitest-environment node
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
 * Controllable Worker Mock for BE-14 (LocalTranslator ensureWorker throw)
 * ========================================================================== */

let failLocalTranslatorWorkerCtor = false;

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class TestableWorker extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        if (failLocalTranslatorWorkerCtor) {
          throw new Error('Simulated Worker constructor failure for BE-14');
        }
        super(...args);
      }
    },
  };
});

import { AccountManager } from '../src/main/accounts/account-manager';
import { waitForMacQuotaProbe } from '../src/main/accounts/account-quota';
import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { PluginsManager, type CliExecutor } from '../src/main/plugins/plugins-manager';
import { inspectLocalTargets } from '../src/main/services/local-media-inspector';
import { diagnosticDetail } from '../src/main/services/session-diagnostics';
import { SessionMultiplexer } from '../src/main/session/session-multiplexer';
import { ClientStore } from '../src/main/storage/client-store';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { translatorCircuit } from '../src/main/llm/external-llm-transport';
import { testExternalTranslator } from '../src/main/translation/external-translator';
import { readAllSessionMessages } from './helpers/core-bridge';
import { LocalTranslator } from '../src/main/translation/local-translator';
import { GitHubUpdater } from '../src/main/updater/github-updater';
import {
  GRAVITY_ICON_VARIANTS,
  isPlausibleLocalFileCandidate,
  type AcpConfigOption,
  type ConversationTreeState,
  type ExternalTranslatorConfig,
  type ExternalTranslatorUsageRecordInput,
} from '@shared';

/* ============================================================================
 * Shared Helpers & Binary Fixtures
 * ========================================================================== */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (val: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Creates a spec-compliant PNG, optionally padded above 64KB via a valid tEXt metadata chunk. */
function createValidPng(width: number, height: number, extraTextBytes = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((1 + width * 3) * height);
  const chunks: Buffer[] = [sig, pngChunk('IHDR', ihdr)];
  if (extraTextBytes > 0) {
    chunks.push(pngChunk('tEXt', Buffer.from(`Comment\0${'Z'.repeat(extraTextBytes)}`, 'latin1')));
  }
  chunks.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Pure-Node 8-bit RGBA PNG alpha bounding-box analyzer for Apple HIG icon verification (BE-16). */
function analyzeRgbaPngOpaqueBounds(pngBuf: Buffer): {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  ratioW: number;
  ratioH: number;
} {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (pngBuf.length < 33 || !pngBuf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('Invalid PNG signature');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts: Buffer[] = [];
  let pos = 8;
  while (pos + 12 <= pngBuf.length) {
    const length = pngBuf.readUInt32BE(pos);
    const type = pngBuf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBuf.length) break;
    if (type === 'IHDR') {
      width = pngBuf.readUInt32BE(dataStart);
      height = pngBuf.readUInt32BE(dataStart + 4);
      bitDepth = pngBuf[dataStart + 8];
      colorType = pngBuf[dataStart + 9];
    } else if (type === 'IDAT') {
      idatParts.push(pngBuf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`Expected 8-bit RGBA PNG, got bitDepth=${bitDepth}, colorType=${colorType}`);
  }
  const inflated = inflateSync(Buffer.concat(idatParts));
  const bpp = 4;
  const stride = width * bpp;
  const prevRow = new Uint8Array(stride);
  const currRow = new Uint8Array(stride);

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart];
    for (let i = 0; i < stride; i++) {
      const raw = inflated[rowStart + 1 + i];
      const a = i >= bpp ? currRow[i - bpp] : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      let val = raw;
      if (filter === 1) val = (raw + a) & 0xff;
      else if (filter === 2) val = (raw + b) & 0xff;
      else if (filter === 3) val = (raw + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (raw + paethPredictor(a, b, c)) & 0xff;
      currRow[i] = val;
    }
    for (let x = 0; x < width; x++) {
      const alpha = currRow[x * 4 + 3];
      if (alpha > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    prevRow.set(currRow);
  }

  const ratioW = maxX >= minX ? (maxX - minX + 1) / width : 0;
  const ratioH = maxY >= minY ? (maxY - minY + 1) / height : 0;
  return { width, height, colorType, bitDepth, minX, maxX, minY, maxY, ratioW, ratioH };
}

const tempDirs: string[] = [];
const services: CoreService[] = [];
const telemetries: TelemetryStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  failLocalTranslatorWorkerCtor = false;
  vi.useRealTimers();
  translatorCircuit.reset();
  for (const s of services.splice(0)) await s.dispose().catch(() => {});
  for (const t of telemetries.splice(0)) t.dispose();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  vi.restoreAllMocks();
});

/* ============================================================================
 * BE-02: External Translator Circuit Breaker Resets on Successful Test
 * ========================================================================== */

describe('BE-02: External translator circuit breaker resets immediately after successful test', () => {
  it('clears an open circuit breaker upon recordExternalTranslatorSuccess and testExternalTranslator', async () => {
    const endpoint = 'http://127.0.0.1:19502';
    translatorCircuit.fail(endpoint, 401);
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(true);

    // 1) Direct success callback clears the open circuit
    translatorCircuit.successRecorder(endpoint)();
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(false);

    // 2) Trip again, then pass testExternalTranslator -> circuit MUST be cleared
    translatorCircuit.fail(endpoint, 403);
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(true);

    const okFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: '正在检查配置文件。' }, done: true, done_reason: 'stop' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const cfg: ExternalTranslatorConfig = {
      enabled: true,
      provider: 'local-ollama',
      endpoint,
      model: 'qwen2.5:3b',
      timeoutMs: 2000,
    };
    const probe = await testExternalTranslator(cfg, okFetcher);
    expect(probe.ok).toBe(true);
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(false);
  });

  it('CoreService.testExternalTranslatorConnection resets circuit breaker so subsequent translation uses external API', async () => {
    const dir = makeTempDir('gravity-v032-be02-core-');
    const endpoint = 'http://127.0.0.1:19503';
    translatorCircuit.fail(endpoint, 401);
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(true);

    const fetcherSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '正在检查配置文件。' }, done: true, done_reason: 'stop' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const core = new CoreService({
      dataDir: dir,
      homeDir: path.join(dir, 'home'),
      modelDiscoveryFetcher: fetcherSpy,
      enableAutoUpdateCheck: false,
    });
    services.push(core);

    const testRes = await core.testExternalTranslatorConnection({
      provider: 'local-ollama',
      endpoint,
      model: 'qwen2.5:3b',
    });
    expect(testRes.ok).toBe(true);
    expect(translatorCircuit.remaining(endpoint) > 0).toBe(false);
  });
});

/* ============================================================================
 * BE-03: Cross-Profile External Translation Telemetry Isolation
 * ========================================================================== */

describe('BE-03: External translation telemetry isolates usage by originating profileId', () => {
  it('stores late-arriving translation usage under its originating profileId without polluting the newly active profile', () => {
    const dir = makeTempDir('gravity-v032-be03-');
    const store = new ClientStore(dir);
    const telemetryB = new TelemetryStore({ store, profileId: 'profile-B' });
    telemetries.push(telemetryB);

    const usageInput: ExternalTranslatorUsageRecordInput = {
      sessionId: 'sess-owned-by-A',
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen2.5:3b',
      outcome: 'success',
      latencyMs: 85,
      usage: {
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 60,
        thinkingTokens: 0,
        totalTokens: 180,
        providerReported: true,
      },
    };

    // Pass originating profileId='profile-A' (compatible with Wave 0 1-arg signature & Wave 2 2-arg signature)
    const recordWithProfile = telemetryB.recordExternalTranslationUsage.bind(telemetryB) as (
      input: ExternalTranslatorUsageRecordInput,
      profileId?: string
    ) => void;
    recordWithProfile(usageInput, 'profile-A');

    // Profile B's per-session map MUST NOT be polluted with Profile A's session!
    const snapB = telemetryB.snapshot();
    expect(snapB.externalTranslator?.bySession['sess-owned-by-A']).toBeUndefined();

    // Flushing & loading Profile A MUST recover the isolated session record cleanly
    telemetryB.flush();
    const telemetryA = new TelemetryStore({ store, profileId: 'profile-A' });
    telemetries.push(telemetryA);
    const snapA = telemetryA.snapshot();
    const recordA = snapA.externalTranslator?.bySession['sess-owned-by-A'];
    expect(recordA).toBeDefined();
    expect(recordA?.callCount).toBe(1);
    expect(recordA?.totalTokens).toBe(180);
  });
});

/* ============================================================================
 * BE-04: prepareProfileSwitch Rollback Must Not Kill TelemetryStore Flush Timer
 * ========================================================================== */

describe('BE-04: TelemetryStore.dispose clears timer and prepareProfileSwitch rollback keeps telemetry alive', () => {
  it('TelemetryStore.dispose() clears this.timer so subsequent mutations still trigger scheduled flushes', async () => {
    vi.useFakeTimers();
    const dir = makeTempDir('gravity-v032-be04-unit-');
    const store = new ClientStore(dir);
    const telemetry = new TelemetryStore({ store, profileId: 'default' });
    telemetries.push(telemetry);

    telemetry.ensure('sess-timer-1', 'gemini-4-neon');
    telemetry.beginTurn('sess-timer-1', 'first prompt');
    telemetry.addChunk('sess-timer-1', 'initial reply'); // Arms internal 250ms timer

    // Dispose while timer is armed
    telemetry.dispose();

    const writeSpy = vi.spyOn(store, 'write');
    telemetry.addChunk('sess-timer-1', 'post-dispose chunk');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(writeSpy).toHaveBeenCalled();
  });

  it('CoreService profile switch rollback preserves active telemetry scheduling without killing it before activate()', async () => {
    vi.useFakeTimers();
    const dir = makeTempDir('gravity-v032-be04-core-');
    const client = new AcpClient();
    const initRes = {
      protocolVersion: 1,
      agentInfo: { name: 'stub-be04', version: '1.0.0' },
      agentCapabilities: { sessionCapabilities: { close: {} } },
    };
    client.initializeResult = initRes;
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(initRes);
    vi.spyOn(client, 'stop').mockResolvedValue(undefined);
    vi.spyOn(client, 'request').mockResolvedValue({ sessionId: 'sess-be04' });

    const core = new CoreService({
      acp: client,
      dataDir: dir,
      homeDir: path.join(dir, 'home'),
      enableAutoUpdateCheck: false,
    });
    services.push(core);

    const accounts = await core.createAccountProfile({ name: 'Second Profile' });
    const secondId = accounts.profiles.find((p) => !p.isDefault)!.profileId;

    const origTelemetry = core.telemetry;
    origTelemetry.ensure('sess-be04', 'gemini-4-neon');
    origTelemetry.beginTurn('sess-be04', 'hello');
    origTelemetry.addChunk('sess-be04', 'world'); // Arms timer on original telemetry

    // Inject write failure on profiles.json so AccountManager.switchProfile triggers prepared.discard()
    const origWrite = core.store.write.bind(core.store);
    const failProfilesSpy = vi.spyOn(core.store, 'write').mockImplementation((name, value) => {
      if (name === 'profiles.json') throw new Error('Simulated profiles.json write failure');
      return origWrite(name, value);
    });

    await expect(core.switchAccountProfile(secondId)).rejects.toThrow('Simulated profiles.json write failure');
    expect(core.accounts.activeProfileId).toBe('default');
    expect(core.telemetry).toBe(origTelemetry);

    failProfilesSpy.mockRestore();
    const writeSpy = vi.spyOn(core.store, 'write');
    origTelemetry.addChunk('sess-be04', 'after rollback');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(writeSpy).toHaveBeenCalled();
  });
});

/* ============================================================================
 * BE-05: AccountManager.logout() Per-Session Resilience & login() Switching Fault Tolerance
 * ========================================================================== */

describe('BE-05: AccountManager.logout() and login() fault tolerance', () => {
  it('logout() isolates per-session closeSession errors and still completes auth/logout', async () => {
    const dir = makeTempDir('gravity-v032-be05-logout-');
    const store = new ClientStore(dir);
    const client = new AcpClient();
    const initRes = {
      protocolVersion: 1,
      agentInfo: { name: 'stub-be05', version: '1.0.0' },
      agentCapabilities: {
        auth: { logout: {} },
        sessionCapabilities: { close: {} },
      },
    };
    client.initializeResult = initRes;
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(initRes);
    const stopSpy = vi.spyOn(client, 'stop').mockResolvedValue(undefined);
    let seq = 0;
    const requestSpy = vi.spyOn(client, 'request').mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: `sess-out-${++seq}` };
      return {};
    });

    const sessions = new SessionMultiplexer(client, store);
    const accounts = new AccountManager({ store, client, sessions });

    const s1 = await sessions.createSession({ cwd: dir });
    const s2 = await sessions.createSession({ cwd: dir });

    const origClose = sessions.closeSession.bind(sessions);
    const closeSpy = vi.spyOn(sessions, 'closeSession').mockImplementation(async (id) => {
      if (id === s1.sessionId) throw new Error('Simulated closeSession timeout for s1');
      return origClose(id);
    });

    const result = await accounts.logout();
    expect(result.loggedOut).toBe(true);
    expect(closeSpy).toHaveBeenCalledWith(s1.sessionId);
    expect(closeSpy).toHaveBeenCalledWith(s2.sessionId);
    expect(requestSpy).toHaveBeenCalledWith('auth/logout', {});
    expect(stopSpy).toHaveBeenCalled();
  });

  it('login(otherProfileId) still launches official login even when switching to an unauthenticated profile causes client.start() to fail', async () => {
    const dir = makeTempDir('gravity-v032-be05-login-');
    const store = new ClientStore(dir);
    const client = new AcpClient();
    vi.spyOn(client, 'stop').mockResolvedValue(undefined);
    vi.spyOn(client, 'start').mockRejectedValue(new Error('401 UNAUTHENTICATED: new profile not logged in'));
    const launchSpy = vi
      .spyOn(client, 'launchOfficialLogin')
      .mockResolvedValue({ launched: true, message: 'official login launched' });

    const sessions = new SessionMultiplexer(client, store);
    const accounts = new AccountManager({ store, client, sessions });
    const created = accounts.createProfile({ name: 'Fresh Unauthenticated Profile' });
    const secondId = created.profiles.find((p) => !p.isDefault)!.profileId;

    const res = await accounts.login(secondId);
    expect(res.launched).toBe(true);
    expect(accounts.activeProfileId).toBe(secondId);
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });
});

/* ============================================================================
 * BE-06: PluginsManager Concurrent getSnapshot & Text MCP List Parsing
 * ========================================================================== */

describe('BE-06: PluginsManager concurrent getSnapshot serialization & parseMcpList fixes', () => {
  it('handles concurrent getSnapshot calls across different workspaces cleanly without exclusive() race errors', async () => {
    const root = makeTempDir('gravity-v032-be06-conc-');
    const wsA = path.join(root, 'ws-a');
    const wsB = path.join(root, 'ws-b');
    const wsC = path.join(root, 'ws-c');
    for (const [ws, name] of [
      [wsA, 'Skill-A'],
      [wsB, 'Skill-B'],
      [wsC, 'Skill-C'],
    ] as const) {
      const skillFile = path.join(ws, '.agents', 'skills', name.toLowerCase(), 'SKILL.md');
      mkdirSync(path.dirname(skillFile), { recursive: true });
      writeFileSync(skillFile, `---\nname: ${name}\ndescription: desc\n---\nbody`, 'utf8');
    }

    const executor: CliExecutor = vi.fn(async (_bin, args) => {
      await new Promise((r) => setTimeout(r, 15));
      if (args[0] === 'plugin') return { stdout: JSON.stringify({ plugins: [] }) };
      return { stdout: JSON.stringify({ mcpServers: {} }) };
    });

    const mgr = new PluginsManager({
      store: new ClientStore(path.join(root, 'store')),
      executor,
      homeDir: path.join(root, 'home'),
    });

    const [snapA, snapB, snapC] = await Promise.all([
      mgr.getSnapshot(wsA),
      mgr.getSnapshot(wsB),
      mgr.getSnapshot(wsC),
    ]);

    expect(snapA.skills.map((s) => s.name)).toContain('Skill-A');
    expect(snapB.skills.map((s) => s.name)).toContain('Skill-B');
    expect(snapC.skills.map((s) => s.name)).toContain('Skill-C');
  });

  it('parseMcpList trims destination, handles uppercase HTTPS://, and does not misclassify paths containing "disabled"', () => {
    const dir = makeTempDir('gravity-v032-be06-mcp-');
    const mgr = new PluginsManager({
      store: new ClientStore(path.join(dir, 'store')),
      executor: vi.fn<CliExecutor>(async () => ({ stdout: '[]' })),
      homeDir: path.join(dir, 'home'),
    });

    const textOutput = [
      'docs-upper:   HTTPS://docs.example.com/mcp   ',
      'user-svc: node /opt/disabled-users-service/server.js',
      'http-disabled-path: https://api.example.com/disabled-items/mcp',
      'legacy-off: node server.js (disabled)',
    ].join('\n');

    const parsed = mgr.parseMcpList(textOutput);
    const byName = Object.fromEntries(parsed.map((item) => [item.name, item]));

    expect(byName['docs-upper']).toMatchObject({
      type: 'http',
      commandOrUrl: 'HTTPS://docs.example.com/mcp',
      enabled: true,
    });
    expect(byName['user-svc']).toMatchObject({
      type: 'stdio',
      enabled: true,
    });
    expect(byName['http-disabled-path']).toMatchObject({
      type: 'http',
      enabled: true,
    });
    expect(byName['legacy-off']).toMatchObject({
      type: 'stdio',
      enabled: false,
    });
  });
});

/* ============================================================================
 * BE-07: TitleOrganizer Syncs Child Branch Titles & Emits Tree Update
 * ========================================================================== */

describe('BE-07: organizeTitles synchronizes child branch titles and emits tree-updated', () => {
  it('updates both root and child branch live titles and pushes tree-updated event', async () => {
    const dir = makeTempDir('gravity-v032-be07-');
    const client = new AcpClient();
    const initRes = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity CLI', version: '1.0.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } },
    };
    client.initializeResult = initRes;
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(initRes);
    vi.spyOn(client, 'notify').mockImplementation(() => {});

    let seq = 0;
    const hydrogenOptions = (model = 'gemini-4-hydrogen', mode = 'plan', effort = 'medium'): AcpConfigOption[] => [
      {
        id: 'model',
        name: 'Model',
        currentValue: model,
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'gemini-4-hydrogen', name: 'Hydrogen' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        currentValue: mode,
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Effort',
        currentValue: effort,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ];

    let currentRootId = '';
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      const rec = (params || {}) as Record<string, unknown>;
      if (method === 'session/new') {
        const sid = `sess-be07-${++seq}`;
        return { sessionId: sid, configOptions: hydrogenOptions('gemini-4-neon', 'default', 'high') };
      }
      if (method === 'session/set_config_option') {
        const cfgId = String(rec.configId);
        const val = String(rec.value);
        return {
          configOptions: hydrogenOptions(
            cfgId === 'model' ? val : 'gemini-4-hydrogen',
            cfgId === 'mode' ? val : 'plan',
            cfgId === 'thought_level' ? val : 'medium'
          ),
        };
      }
      if (method === 'session/prompt') {
        const sid = String(rec.sessionId);
        const promptBlocks = (rec.prompt as Array<{ type: string; text?: string }>) || [];
        const text = promptBlocks.map((b) => b.text || '').join('\n');
        if (text.includes('[Gravity Title Organizer]')) {
          const organizedJson = JSON.stringify([
            {
              sessionId: currentRootId,
              categoryTag: 'Auth',
              organizedTitle: 'Auth｜排查登录超时与令牌刷新',
            },
          ]);
          client.emit('session/update', {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: organizedJson } },
          });
        } else {
          client.emit('session/update', {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到，开始排查。' } },
          });
        }
        return { stopReason: 'end_turn' };
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

    const root = await core.createSession({ cwd: dir, title: '新建对话' });
    currentRootId = root.sessionId;
    await core.sendPrompt({ sessionId: root.sessionId, text: '帮我排查一下登录超时问题' });
    const rootMsgs = await readAllSessionMessages(core, root.sessionId);
    const firstUser = rootMsgs.find((m) => m.role === 'user')!;

    // Fork a child branch so a conversation tree exists
    const branch = await core.reviseMessage({
      sessionId: root.sessionId,
      messageId: firstUser.id,
      text: '改为排查 OAuth 令牌刷新超时问题',
    });
    expect(core.trees.hasTree(root.sessionId)).toBe(true);

    const treeEvents: ConversationTreeState[] = [];
    core.on('tree-updated', (tree: ConversationTreeState) => treeEvents.push(tree));

    const organized = await core.organizeTitles({
      scope: 'session',
      sessionIds: [root.sessionId],
    });
    expect(organized.updatedCount).toBe(1);

    // Root and child branch live titles must BOTH be synchronized
    expect(core.sessions.get(root.sessionId).title).toBe('Auth｜排查登录超时与令牌刷新');
    expect(core.sessions.get(branch.sessionId).title).toBe('Auth｜排查登录超时与令牌刷新');
    // Tree update event must be emitted with the updated root title
    expect(treeEvents.some((t) => t.rootSessionId === root.sessionId && t.rootTitle === 'Auth｜排查登录超时与令牌刷新')).toBe(true);
  });
});

/* ============================================================================
 * BE-08: isPlausibleLocalFileCandidate POSIX Spaces Support (Wave 0 GREEN)
 * ========================================================================== */

describe('BE-08: isPlausibleLocalFileCandidate allows POSIX paths with spaces while rejecting slash commands', () => {
  it('accepts macOS/POSIX absolute paths containing spaces and rejects /compact now & fragments', () => {
    expect(isPlausibleLocalFileCandidate('/Users/Alice/My Project/Screenshot 2026.png')).toBe(true);
    expect(isPlausibleLocalFileCandidate('/Users/Alice/Desktop/Screen Shot 2026-11-25 at 10.00.00.png')).toBe(true);
    expect(isPlausibleLocalFileCandidate('/compact now')).toBe(false);
    expect(isPlausibleLocalFileCandidate('/help me')).toBe(false);
    expect(isPlausibleLocalFileCandidate('-mac.png')).toBe(false);
    expect(isPlausibleLocalFileCandidate('.png')).toBe(false);
  });
});

/* ============================================================================
 * BE-09: LocalMediaInspector Case-Insensitive artifact.root & >64KB Full Image Read
 * ========================================================================== */

describe('BE-09: LocalMediaInspector case-insensitive ancestor vs exact sessionId & >64KB offset-0 image preview', () => {
  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'tolerates ancestor directory casing while rejecting mismatched sessionId directory casing (DEF-BE-IP-01)',
    async () => {
      const root = makeTempDir('gravity-v032-be09-case-');
      const homeDirOnDisk = path.join(root, 'HomeMixed');
      const homeDirLower = path.join(root, 'homemixed');
      const ownBrainDir = path.join(homeDirOnDisk, '.gemini', 'antigravity-cli', 'brain', 'sess-mixed-99');
      mkdirSync(ownBrainDir, { recursive: true });
      const imgPath = path.join(ownBrainDir, 'preview.png');
      writeFileSync(imgPath, createValidPng(32, 24));

      // Ancestor directory casing differs (HomeMixed vs homemixed) while sessionId dir matches exact case -> allowed
      const result = await inspectLocalTargets(
        { targets: ['preview.png'], sessionId: 'sess-mixed-99', includePreviewData: true },
        { homeDir: homeDirLower, profileId: 'default', owns: (o) => o.profileId === 'default' && o.sessionId === 'sess-mixed-99' }
      );

      expect(result.items['preview.png']).toMatchObject({
        kind: 'image',
        exists: true,
        width: 32,
        height: 24,
      });

      // DEF-BE-IP-01: sibling session directory whose casing differs from sessionId MUST be rejected as forbidden
      const siblingBrainDir = path.join(homeDirOnDisk, '.gemini', 'antigravity-cli', 'brain', 'SESS-SIBLING-99');
      mkdirSync(siblingBrainDir, { recursive: true });
      const siblingImg = path.join(siblingBrainDir, 'preview.png');
      writeFileSync(siblingImg, createValidPng(32, 24));
      const mismatchedSession = await inspectLocalTargets(
        { targets: ['preview.png', siblingImg], sessionId: 'sess-sibling-99', includePreviewData: true },
        { homeDir: homeDirOnDisk, profileId: 'default', owns: (o) => o.profileId === 'default' && o.sessionId === 'sess-sibling-99' }
      );
      expect(mismatchedSession.items['preview.png']).toMatchObject({ kind: 'forbidden', exists: false });
      expect(mismatchedSession.items['preview.png'].previewDataUrl).toBeUndefined();
      expect(mismatchedSession.items[siblingImg]).toMatchObject({ kind: 'forbidden', exists: false });
      expect(mismatchedSession.items[siblingImg].previewDataUrl).toBeUndefined();

      // v0.3.6 security guard: brain access MUST be denied when `owns` is absent or denies ownership
      const withoutOwns = await inspectLocalTargets(
        { targets: ['preview.png', imgPath], sessionId: 'sess-mixed-99', includePreviewData: true },
        { homeDir: homeDirOnDisk }
      );
      expect(withoutOwns.items['preview.png'].exists).toBe(false);
      expect(withoutOwns.items[imgPath].exists).toBe(false);
      expect(withoutOwns.items[imgPath].previewDataUrl).toBeUndefined();

      const foreignOwns = await inspectLocalTargets(
        { targets: ['preview.png', imgPath], sessionId: 'sess-mixed-99', includePreviewData: true },
        { homeDir: homeDirOnDisk, profileId: 'default', owns: (o) => o.sessionId === 'other-session' }
      );
      expect(foreignOwns.items['preview.png'].exists).toBe(false);
      expect(foreignOwns.items[imgPath].exists).toBe(false);
      expect(foreignOwns.items[imgPath].previewDataUrl).toBeUndefined();

      // On macOS (case-insensitive APFS), path.posix.relative is case-sensitive, so raw
      // `relative(expected, realpathSync(artifact.root)) !== ''` falsely returns 'forbidden'.
      const inspectorSrc = readFileSync(
        path.resolve(process.cwd(), 'src', 'main', 'services', 'local-media-inspector.ts'),
        'utf8'
      );
      expect(inspectorSrc).not.toContain("relative(expected, realpathSync(artifact.root)) !== ''");
    }
  );

  it('reads >64KB image completely from offset 0 without header/tail truncation', async () => {
    const workspace = makeTempDir('gravity-v032-be09-large-');
    const largePng = createValidPng(48, 36, 75 * 1024); // > 75 KB (> 64 KB header sniff buffer)
    expect(largePng.length).toBeGreaterThan(64 * 1024);
    const imgPath = path.join(workspace, 'large-screenshot.png');
    writeFileSync(imgPath, largePng);

    const res = await inspectLocalTargets(
      { targets: [imgPath], cwd: workspace, includePreviewData: true },
      {}
    );
    const item = res.items[imgPath];
    expect(item).toMatchObject({
      kind: 'image',
      exists: true,
      width: 48,
      height: 36,
      sizeBytes: largePng.length,
    });
    expect(item.previewDataUrl).toBeDefined();
    const prefix = 'data:image/png;base64,';
    expect(item.previewDataUrl!.startsWith(prefix)).toBe(true);
    const decoded = Buffer.from(item.previewDataUrl!.slice(prefix.length), 'base64');
    expect(decoded.equals(largePng)).toBe(true);
  });
});

/* ============================================================================
 * BE-10: SessionMultiplexer.resumeSession No Double-Counting of Active Slot
 * ========================================================================== */

describe('BE-10: SessionMultiplexer concurrent resumeSession does not double-count active + reservation slots', () => {
  it('allows resuming the 4th session while the 3rd session is finishing post-resume setSessionMode', async () => {
    const dir = makeTempDir('gravity-v032-be10-');
    const store = new ClientStore(dir);
    const client = new AcpClient();
    const initRes = {
      protocolVersion: 1,
      agentInfo: { name: 'stub-be10', version: '1.0.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
    };
    client.initializeResult = initRes;
    vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(client, 'start').mockResolvedValue(initRes);

    const modeGate = createDeferred<Record<string, unknown>>();
    const modeStarted = createDeferred<void>();

    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      const rec = (params || {}) as Record<string, unknown>;
      if (method === 'session/resume') {
        return {
          sessionId: String(rec.sessionId),
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'plan', name: 'Plan' },
            ],
          },
        };
      }
      if (method === 'session/set_mode') {
        modeStarted.resolve();
        return modeGate.promise;
      }
      return {};
    });

    // Persist desiredMode='plan' for s3 so resumeSession('s3') awaits setSessionMode AFTER active.add('s3')
    store.write('session-settings.json', {
      'default:s3': { executionMode: 'plan', reasoningEffort: 'high' },
    });

    const mux = new SessionMultiplexer(client, store);
    await mux.resumeSession('s1', dir);
    await mux.resumeSession('s2', dir);
    expect(mux.activeSessionCount).toBe(2);

    // Start resuming s3; pause inside setSessionMode (s3 is now in active set!)
    const resume3 = mux.resumeSession('s3', dir);
    await modeStarted.promise;

    // Resuming s4 (4th of 4 allowed slots) MUST succeed rather than hitting phantom double-count cap!
    const s4Promise = mux.resumeSession('s4', dir);
    try {
      const s4 = await s4Promise;
      expect(s4.sessionId).toBe('s4');
      modeGate.resolve({});
      const s3 = await resume3;
      expect(s3.sessionId).toBe('s3');
      expect(mux.activeSessionCount).toBe(4);
    } finally {
      modeGate.resolve({});
      await resume3.catch(() => {});
    }
  });
});

/* ============================================================================
 * BE-11: GitHubUpdater 3xx Body Cancel, Empty content-length & macOS apply-update.sh Safety
 * ========================================================================== */

describe('BE-11: GitHubUpdater 3xx redirect body cancellation, empty content-length & macOS update script', () => {
  it('cancels response body on 3xx redirects in fetchGitHubSafe and handles missing/empty content-length cleanly', async () => {
    const dir = makeTempDir('gravity-v032-be11-');
    let redirectBodyCancelled = false;

    const payloadBytes = Buffer.from('FAKE_GRAVITY_EXE_PAYLOAD');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.3.2',
            name: 'Gravity v0.3.2',
            body: 'Release notes',
            html_url: 'https://github.com/Mikotou/G-Gravity/releases/tag/v0.3.2',
            assets: [
              {
                name: 'Gravity.exe',
                browser_download_url: 'https://github.com/Mikotou/G-Gravity/releases/download/v0.3.2/Gravity.exe',
                size: 0,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.startsWith('https://github.com/Mikotou/G-Gravity/releases/download/')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel() {
            redirectBodyCancelled = true;
          },
        });
        return new Response(stream, {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/pkg/Gravity.exe' },
        });
      }
      // Final 200 response with empty content-length header
      return new Response(payloadBytes, {
        status: 200,
        headers: { 'content-length': '' },
      });
    });

    const updater = new GitHubUpdater({
      currentVersion: '0.3.1',
      updatesDir: dir,
      platform: 'win32',
      arch: 'x64',
      fetcher,
    });

    const checked = await updater.checkForUpdates();
    expect(checked.status).toBe('available');
    const downloaded = await updater.downloadUpdate();
    expect(downloaded.status).toBe('downloaded');
    expect(downloaded.downloadedBytes).toBe(payloadBytes.length);
    expect(redirectBodyCancelled).toBe(true);
  });

  it('macOS apply-update.sh verifies target PID exited after wait loop and cleans up staging dir on failure', () => {
    const candidates = [
      path.resolve(process.cwd(), 'src', 'main', 'index.ts'),
      path.resolve(process.cwd(), 'src', 'main', 'updater', 'platform-installer.ts'),
      path.resolve(process.cwd(), 'src', 'main', 'updater', 'macos-installer.ts'),
      path.resolve(process.cwd(), 'src', 'main', 'desktop', 'window-manager.ts'),
    ].filter((p) => existsSync(p));
    const combinedSrc = candidates.map((p) => readFileSync(p, 'utf8')).join('\n');
    const scriptStart = combinedSrc.indexOf('apply-update.sh');
    expect(scriptStart).toBeGreaterThan(0);
    const scriptBlock = combinedSrc.slice(scriptStart, scriptStart + 2500);

    // Must check kill -0 "$TARGET_PID" AFTER the wait loop (at least 2 kill -0 checks total) so it never moves over a live process
    const killChecks = scriptBlock.match(/kill\s+-0\s+"\$TARGET_PID"/g) || [];
    expect(killChecks.length).toBeGreaterThanOrEqual(2);
    // Must clean up STAGING_DIR on failure (via trap or explicit cleanup)
    expect(scriptBlock).toMatch(/trap\b.*STAGING_DIR|rm\s+-rf[^;\n]*STAGING_DIR[\s\S]*exit\s+1/);
  });
});

/* ============================================================================
 * BE-12: AccountQuota waitForMacQuotaProbe Error Settlement & Timer Unref
 * ========================================================================== */

describe('BE-12: waitForMacQuotaProbe settles promptly on error without close and unrefs force timer', () => {
  it('rejects promptly when child emits "error" without emitting "close" and detaches abort listener', async () => {
    const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    proc.kill = vi.fn(() => true);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const probePromise = waitForMacQuotaProbe(proc as unknown as ChildProcess, 10, controller.signal);
    proc.emit('error', new Error('spawn /bin/sh ENOENT'));

    const outcome = await Promise.race([
      probePromise.then(
        () => ({ settled: true as const, rejected: false }),
        (err: unknown) => ({ settled: true as const, rejected: true, err })
      ),
      new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), 300)),
    ]);

    expect(outcome.settled).toBe(true);
    if (outcome.settled) {
      expect(outcome.rejected).toBe(true);
    }
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('calls .unref() on the SIGKILL force timeout when aborted', async () => {
    const unrefSpy = vi.fn();
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = origSetTimeout(fn, ms, ...args);
      if (ms === 3_000) {
        const origUnref = handle.unref.bind(handle);
        handle.unref = () => {
          unrefSpy();
          return origUnref();
        };
      }
      return handle;
    }) as typeof setTimeout);

    const proc = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    proc.kill = vi.fn(() => true);
    const controller = new AbortController();

    const p = waitForMacQuotaProbe(proc as unknown as ChildProcess, 10, controller.signal);
    controller.abort();
    expect(unrefSpy).toHaveBeenCalled();

    proc.emit('close', null);
    await expect(p).rejects.toThrow(/取消/);
  });
});

/* ============================================================================
 * BE-13: TelemetryStore 32-Day Timezone Buffer for Ledger Pruning
 * ========================================================================== */

describe('BE-13: TelemetryStore retains 32-day timezone buffer on flush()', () => {
  it('keeps ledger records from 30d+10h ago (local timezone boundary) while pruning records >32d old', () => {
    const dir = makeTempDir('gravity-v032-be13-');
    const store = new ClientStore(dir);
    const fixedNow = Date.UTC(2026, 10, 25, 16, 0, 0); // 2026-11-25T16:00:00Z

    const boundaryHourKey = new Date(fixedNow - (30 * 86_400_000 + 10 * 3_600_000))
      .toISOString()
      .slice(0, 13);
    const expiredHourKey = new Date(fixedNow - 33 * 86_400_000)
      .toISOString()
      .slice(0, 13);

    store.write('v2-token-hours.json', [
      {
        hourKey: boundaryHourKey,
        modelId: 'gemini-4-neon',
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 200,
        thinkingTokens: 0,
        sessions: ['sess-boundary'],
      },
      {
        hourKey: expiredHourKey,
        modelId: 'gemini-4-neon',
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 100,
        thinkingTokens: 0,
        sessions: ['sess-expired'],
      },
    ]);

    const telemetry = new TelemetryStore({ store, profileId: 'default', now: () => fixedNow });
    telemetries.push(telemetry);
    telemetry.flush(true);

    const persisted = store.read<Array<{ hourKey: string }>>('v2-token-hours.json', []);
    expect(persisted.some((r) => r.hourKey === boundaryHourKey)).toBe(true);
    expect(persisted.some((r) => r.hourKey === expiredHourKey)).toBe(false);
  });
});

/* ============================================================================
 * BE-14: LocalTranslator ensureWorker Synchronous Throw Releases Abort Listener
 * ========================================================================== */

describe('BE-14: LocalTranslator catches ensureWorker throw, rejects cleanly, and releases AbortSignal listener', () => {
  it('detaches abort listener and rejects when Worker constructor throws synchronously inside pump()', async () => {
    failLocalTranslatorWorkerCtor = true;
    const translator = new LocalTranslator();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(
      translator.translate('Checking the workspace configuration.', controller.signal)
    ).rejects.toThrow('Simulated Worker constructor failure for BE-14');

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    translator.dispose();
  });
});

/* ============================================================================
 * BE-15: diagnosticDetail Preserves /compact & HTTP/1.1 While Redacting Real OS Paths & Secrets
 * ========================================================================== */

describe('BE-15: diagnosticDetail does not falsely redact /compact or HTTP/1.1', () => {
  it('preserves benign slash commands and HTTP protocol versions', () => {
    const compactMsg = '当前官方会话未声明支持 /compact，不能保证压缩可用';
    expect(diagnosticDetail(compactMsg)).toBe(compactMsg);
    expect(diagnosticDetail(compactMsg)).not.toBe('[redacted]');

    const httpMsg = 'Upstream gateway returned HTTP/1.1 502 Bad Gateway';
    expect(diagnosticDetail(httpMsg)).toBe(httpMsg);

    const apiMsg = 'POST /v1/models failed with HTTP/1.1 503';
    expect(diagnosticDetail(apiMsg)).not.toBe('[redacted]');
  });

  it('continues to strictly redact real OS filesystem paths and credentials', () => {
    expect(diagnosticDetail('ENOENT: open /Users/alice/.gemini/oauth_creds.json')).toBe('[redacted]');
    expect(diagnosticDetail('Permission denied: /home/bob/.ssh/id_rsa')).toBe('[redacted]');
    expect(diagnosticDetail('Cannot read /etc/passwd')).toBe('[redacted]');
    expect(diagnosticDetail('Failed at /var/folders/ab/tmp/x')).toBe('[redacted]');
    expect(diagnosticDetail('Failed at /tmp/secret-socket')).toBe('[redacted]');
    expect(diagnosticDetail('Failed at /private/var/tmp/key')).toBe('[redacted]');
    expect(diagnosticDetail('Failed at C:\\Users\\Alice\\secret.txt')).toBe('[redacted]');
    expect(diagnosticDetail('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe('[redacted]');
    expect(diagnosticDetail('Error with sk-proj-AbCdEfGhIjKlMnOpQrStUv1234')).not.toContain('sk-proj-');
  });
});

/* ============================================================================
 * BE-16: 6 macOS HIG Icons (1024x1024, ratioW in [0.78, 0.83]) & Main Process iconPath()
 * ========================================================================== */

describe('BE-16: 6 macOS HIG 1024x1024 -mac.png assets & darwin iconPath() fallback', () => {
  it('all 6 GRAVITY_ICON_VARIANTS assetMacPngRelPath files exist, are 1024x1024 RGBA PNGs, and satisfy Apple HIG ratioW/ratioH in [0.78, 0.83]', () => {
    expect(GRAVITY_ICON_VARIANTS).toHaveLength(6);

    for (const variant of GRAVITY_ICON_VARIANTS) {
      expect(variant.assetMacPngRelPath, variant.id).toMatch(/^assets\/icons\/gravity-.*-mac\.png$/);
      const absPath = path.resolve(process.cwd(), variant.assetMacPngRelPath);
      expect(existsSync(absPath), `missing macOS HIG icon: ${variant.assetMacPngRelPath}`).toBe(true);

      const bounds = analyzeRgbaPngOpaqueBounds(readFileSync(absPath));
      expect(bounds.width, variant.id).toBe(1024);
      expect(bounds.height, variant.id).toBe(1024);
      expect(
        bounds.ratioW,
        `${variant.id} ratioW=${bounds.ratioW.toFixed(4)} must be in [0.78, 0.83] (Apple HIG)`
      ).toBeGreaterThanOrEqual(0.78);
      expect(
        bounds.ratioW,
        `${variant.id} ratioW=${bounds.ratioW.toFixed(4)} must be in [0.78, 0.83] (Apple HIG)`
      ).toBeLessThanOrEqual(0.83);
      expect(
        bounds.ratioH,
        `${variant.id} ratioH=${bounds.ratioH.toFixed(4)} must be in [0.78, 0.83] (Apple HIG)`
      ).toBeGreaterThanOrEqual(0.78);
      expect(
        bounds.ratioH,
        `${variant.id} ratioH=${bounds.ratioH.toFixed(4)} must be in [0.78, 0.83] (Apple HIG)`
      ).toBeLessThanOrEqual(0.83);
    }
  });

  it('main entry / window-manager iconPath() uses assetMacPngRelPath on darwin and safely falls back on unknown appIcon id', () => {
    const candidates = [
      path.resolve(process.cwd(), 'src', 'main', 'index.ts'),
      path.resolve(process.cwd(), 'src', 'main', 'desktop', 'window-manager.ts'),
    ].filter((p) => existsSync(p));
    const combinedSrc = candidates.map((p) => readFileSync(p, 'utf8')).join('\n');
    const fnMatch = /(?:export\s+)?function\s+iconPath\s*\([^)]*\)[^{]*\{[\s\S]*?\n\}/.exec(combinedSrc);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).toContain('assetMacPngRelPath');
    expect(body).toMatch(/darwin/);
    // Should fall back to default variant instead of throwing on stale/invalid appIcon preference
    expect(body).not.toContain('throw new Error');
  });
});

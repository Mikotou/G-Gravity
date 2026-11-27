// @vitest-environment node
/**
 * Gravity v0.3.6 — 后端语音听写与安全边界全量测试套件
 * 覆盖总测试计划 V01–V05 基线 + V01-ADD-1 / V02-ADD-1 / V03-ADD-1 / V04-ADD-1 / V05-ADD-1
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const ipcHandlers = new Map<string, Function>();
  let lastWindow: FakeWindow | undefined;

  class FakeEmitter {
    private map = new Map<string, Set<Listener>>();
    on(event: string, fn: Listener) { (this.map.get(event) ?? this.map.set(event, new Set()).get(event)!).add(fn); return this; }
    once(event: string, fn: Listener) {
      const wrap: Listener = (...args) => { this.off(event, wrap); fn(...args); };
      return this.on(event, wrap);
    }
    off(event: string, fn: Listener) { this.map.get(event)?.delete(fn); return this; }
    emit(event: string, ...args: unknown[]) { for (const fn of [...(this.map.get(event) ?? [])]) fn(...args); }
  }

  class FakeSession {
    permReqHandler?: (sender: unknown, permission: string, callback: (allowed: boolean) => void, details: Record<string, unknown>) => void;
    permCheckHandler?: (sender: unknown, permission: string, origin: string, details: Record<string, unknown>) => boolean;
    displayMediaHandler?: (request: unknown, callback: (streams: Record<string, unknown>) => void) => void;
    setPermissionRequestHandler(fn: FakeSession['permReqHandler']) { this.permReqHandler = fn; }
    setPermissionCheckHandler(fn: FakeSession['permCheckHandler']) { this.permCheckHandler = fn; }
    setDisplayMediaRequestHandler(fn: FakeSession['displayMediaHandler']) { this.displayMediaHandler = fn; }
  }

  class FakeWebContents extends FakeEmitter {
    session = new FakeSession();
    mainFrame = { url: '' };
    destroyed = false;
    sent: Array<{ channel: string; payload: unknown }> = [];
    forcefullyCrashRenderer = vi.fn();
    setZoomFactor = vi.fn();
    setWindowOpenHandler = vi.fn();
    getURL() { return this.mainFrame.url; }
    isDestroyed() { return this.destroyed; }
    send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
  }

  class FakeWindow extends FakeEmitter {
    webContents = new FakeWebContents();
    destroyed = false;
    setBackgroundColor = vi.fn();
    setTitleBarOverlay = vi.fn();
    setWindowButtonPosition = vi.fn();
    setIcon = vi.fn();
    maximize = vi.fn();
    isMaximized = () => false;
    isDestroyed = () => this.destroyed;
    getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
    getNormalBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
    async loadFile(filePath: string) { this.webContents.mainFrame.url = pathToFileURL(filePath).href; }
    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
    constructor(_opts: unknown) {
      super();
      lastWindow = this;
    }
  }

  return {
    ipcHandlers,
    getLastWindow: () => lastWindow,
    reset: () => { ipcHandlers.clear(); lastWindow = undefined; },
    app: { isPackaged: false, quit: vi.fn(), dock: { setIcon: vi.fn() } },
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (ch: string, fn: Function) => ipcHandlers.set(ch, fn),
      removeHandler: (ch: string) => ipcHandlers.delete(ch),
    },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
    nativeTheme: Object.assign(new FakeEmitter(), { shouldUseDarkColors: true }),
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    },
    shell: { openExternal: vi.fn(), showItemInFolder: vi.fn(), openPath: vi.fn() },
    systemPreferences: { askForMediaAccess: vi.fn(async () => true) },
  };
});

vi.mock('electron', () => ({
  app: electronMocks.app,
  BrowserWindow: electronMocks.BrowserWindow,
  ipcMain: electronMocks.ipcMain,
  Menu: electronMocks.Menu,
  nativeTheme: electronMocks.nativeTheme,
  screen: electronMocks.screen,
  shell: electronMocks.shell,
  systemPreferences: electronMocks.systemPreferences,
}));

import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { detachRouter, openWindow } from '../src/main/desktop/window-manager';
import { registerIpcRouter } from '../src/main/ipc-router';
import { reviewerCircuit, translatorCircuit } from '../src/main/llm/external-llm-transport';
import type { SecretCipher } from '../src/main/services/secret-vault';
import { ClientStore } from '../src/main/storage/client-store';
import { ExternalVoice, voiceCircuit } from '../src/main/voice/external-voice';
import { LocalVoice } from '../src/main/voice/local-voice';
import { VoiceCapture } from '../src/main/voice/voice-capture';
import { VoiceLedger } from '../src/main/voice/voice-ledger';
import {
  COST_DISCLAIMER,
  DEFAULT_VOICE_CONFIG,
  hasExternalVoiceSettings,
  IPC_CHANNELS,
  isValidVoicePcm16Buffer,
  normalizeDictationText,
  VOICE_LOCAL_MODEL_SPEC,
  VOICE_MAX_DURATION_MS,
  VOICE_MIC_TEST_MAX_BYTES,
  VOICE_MIC_TEST_MAX_DURATION_MS,
  type VoiceCaptureRevokedEvent,
  type VoiceSegmentEvent,
  type VoiceSettledEvent,
} from '../src/shared';

const modelIO: {
  readVerified(file: string): Promise<Buffer<ArrayBuffer>>;
  install(dir: string, signal: AbortSignal, progress?: (bytes: number) => void, fetcher?: typeof fetch): Promise<void>;
} = require('../assets/local-voice/model.cjs');

const REPO_ROOT = process.cwd();
const REAL_MODEL_PATH = path.join(REPO_ROOT, 'assets', 'local-voice', VOICE_LOCAL_MODEL_SPEC.fileName);
const REAL_TEST_PCM_PATH = path.join(REPO_ROOT, 'assets', 'local-voice', 'test-clip.pcm');
const HAS_REAL_MODEL = existsSync(REAL_MODEL_PATH);

const cleanups: Array<() => Promise<unknown> | unknown> = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function makeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`V036ENC:${plain}`, 'utf8'),
    decrypt: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('V036ENC:')) throw new Error('corrupted ciphertext');
      return s.slice('V036ENC:'.length);
    },
  };
}

function makeCoreFixture(opts: {
  dataDir?: string;
  appRoot?: string;
  secretCipher?: SecretCipher;
  voiceFetcher?: typeof fetch;
  voiceModelFetcher?: typeof fetch;
  requestMicrophone?: () => Promise<boolean>;
  now?: () => number;
} = {}) {
  const dir = opts.dataDir ?? makeTempDir('gravity-v036-voice-');
  const cwd = path.join(dir, 'ws');
  mkdirSync(cwd, { recursive: true });
  const client = new AcpClient();
  client.initializeResult = {
    protocolVersion: 1,
    agentInfo: { name: 'fixture', version: '1.5.18' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
  };
  vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(client, 'start').mockResolvedValue(client.initializeResult);
  vi.spyOn(client, 'stop').mockResolvedValue(undefined);
  vi.spyOn(client, 'notify').mockImplementation(() => {});
  let seq = 0;
  vi.spyOn(client, 'request').mockImplementation(async (method) => {
    if (method === 'session/new') return { sessionId: `voice-sess-${++seq}` };
    if (method === 'session/list') return { sessions: [] };
    if (method === 'session/close') return {};
    return {};
  });
  const core = new CoreService({
    acp: client,
    dataDir: dir,
    homeDir: path.join(dir, 'home'),
    appRoot: opts.appRoot ?? REPO_ROOT,
    secretCipher: opts.secretCipher ?? makeCipher(true),
    voiceFetcher: opts.voiceFetcher,
    voiceModelFetcher: opts.voiceModelFetcher,
    requestMicrophone: opts.requestMicrophone,
    now: opts.now,
    enableAutoUpdateCheck: false,
  });
  cleanups.push(() => core.dispose().catch(() => {}));
  return { dir, cwd, client, core };
}

afterEach(async () => {
  vi.useRealTimers();
  detachRouter();
  electronMocks.reset();
  voiceCircuit.reset();
  reviewerCircuit.reset();
  translatorCircuit.reset();
  while (cleanups.length) {
    await cleanups.pop()!();
  }
  vi.restoreAllMocks();
});

/* ============================================================================
 * V01 & V01-ADD-1: Dual Permission Handlers (file://), Lease Matrix & Crash/Nav Revocation
 * ========================================================================== */
describe('V01 & V01-ADD-1: 麦克风双 Handler 权限矩阵、file:// 打包态、armed 释放与导航/无响应回收', () => {
  it('enforces idle zero-permission, lease-scoped file:// audio-only matrix, media-ready closeout, and nav/unresponsive/crash revocation', async () => {
    const { core, cwd } = makeCoreFixture();
    const sess = await core.createSession({ cwd });
    await openWindow(core, { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }, () => undefined, () => {});
    const win = electronMocks.getLastWindow()!;
    const wc = win.webContents;
    const sessObj = wc.session;
    const trustedUrl = wc.getURL();
    expect(trustedUrl.startsWith('file://')).toBe(true);

    const askPerm = (sender: unknown, permission: string, details: Record<string, unknown>) => {
      let result: boolean | undefined;
      sessObj.permReqHandler!(sender, permission, (allowed) => { result = allowed; }, details);
      return result;
    };
    const checkPerm = (sender: unknown, permission: string, origin: string, details: Record<string, unknown>) =>
      sessObj.permCheckHandler!(sender, permission, origin, details);

    // 1. Idle state: 0 permissions allowed (getUserMedia, permissions check, displayMedia)
    expect(core.voice.captures.hasLease).toBe(false);
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);
    expect(checkPerm(wc, 'media', 'file://', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio' })).toBe(false);
    let displayResult: unknown;
    sessObj.displayMediaHandler!({}, (streams) => { displayResult = streams; });
    expect(displayResult).toEqual({});

    // 2. device-list lease: audio-only on main window main frame trustedUrl allowed; video / audio+video / iframe / foreign denied
    const deviceLease = await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'device-list' });
    expect(deviceLease.state).toBe('armed');
    expect(core.voice.captures.hasLease).toBe(true);

    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(true);
    expect(checkPerm(wc, 'media', 'file://', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio' })).toBe(true);
    expect(checkPerm(wc, 'media', 'file:///', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio' })).toBe(true);
    expect(checkPerm(wc, 'media', trustedUrl, { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio' })).toBe(true);

    // Deny video, audio+video, non-media, subframe, foreign sender, foreign URL, embeddingOrigin, foreign securityOrigin
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['video'] })).toBe(false);
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(askPerm(wc, 'geolocation', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);
    expect(askPerm(wc, 'media', { isMainFrame: false, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);
    expect(askPerm({}, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: 'https://evil.example/', mediaTypes: ['audio'] })).toBe(false);
    expect(checkPerm(wc, 'media', 'file://', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'video' })).toBe(false);
    expect(checkPerm(wc, 'media', 'file://', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio', embeddingOrigin: 'https://embed.example' })).toBe(false);
    expect(checkPerm(wc, 'media', 'https://evil.example', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio' })).toBe(false);
    expect(checkPerm(wc, 'media', 'file://', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio', securityOrigin: 'https://evil.example' })).toBe(false);

    // Release device-list lease immediately clears lease and activeCapture
    const releasedDevice = await core.voiceArmCapture({ op: 'release-media', captureId: deviceLease.captureId });
    expect(releasedDevice.state).toBe('released');
    expect(core.voice.captures.hasLease).toBe(false);
    expect((await core.getVoiceState()).activeCapture).toBeUndefined();
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);

    // 3. DEF-BE-10 regression: armed dictation receiving release-media (no hold) immediately clears activeCapture (no 60s sealed leak)
    const armedEvents: VoiceSettledEvent[] = [];
    core.on('voice-settled', (e: VoiceSettledEvent) => armedEvents.push(e));
    const micTestArmed = await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    expect(core.voice.captures.hasLease).toBe(true);
    const micTestReleased = await core.voiceArmCapture({ op: 'release-media', captureId: micTestArmed.captureId });
    expect(micTestReleased.state).toBe('released');
    expect(core.voice.captures.hasLease).toBe(false);
    expect((await core.getVoiceState()).activeCapture).toBeUndefined();
    expect(armedEvents.at(-1)?.outcome).toBe('aborted');

    // If real model is present, test dictation armed -> release-media (no hold) as well
    if (HAS_REAL_MODEL) {
      const dictArmed = await core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sess.sessionId }, purpose: 'dictation' });
      const dictRel = await core.voiceArmCapture({ op: 'release-media', captureId: dictArmed.captureId });
      expect(dictRel.state).toBe('released');
      expect((await core.getVoiceState()).activeCapture).toBeUndefined();
      expect(core.voice.captures.hasLease).toBe(false);
    }

    // 4. media-ready closes permission window immediately (second getUserMedia denied)
    const testCap = await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(true);
    const capturing = await core.voiceArmCapture({ op: 'media-ready', captureId: testCap.captureId });
    expect(capturing.state).toBe('capturing');
    expect(core.voice.captures.hasLease).toBe(false);
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);

    // 5. Subframe navigation does NOT revoke, main-frame navigation DOES revoke
    const revoked: VoiceCaptureRevokedEvent[] = [];
    core.on('voice-capture-revoked', (e: VoiceCaptureRevokedEvent) => revoked.push(e));
    wc.emit('did-start-navigation', { isMainFrame: false });
    expect(revoked).toHaveLength(0);
    wc.emit('did-start-navigation', { isMainFrame: true });
    expect(revoked.at(-1)?.reason).toBe('window-closed');
    expect((await core.getVoiceState()).activeCapture).toBeUndefined();

    // 6. unresponsive while idle does NOT crash renderer; unresponsive while armed/capturing revokes + forcefullyCrashRenderer
    win.emit('unresponsive');
    expect(wc.forcefullyCrashRenderer).not.toHaveBeenCalled();

    await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    win.emit('unresponsive');
    expect(revoked.at(-1)?.reason).toBe('device-error');
    expect(wc.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(core.voice.captures.hasLease).toBe(false);

    // 7. render-process-gone revokes active capture
    await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    wc.emit('render-process-gone');
    expect(revoked.at(-1)?.reason).toBe('window-closed');
    expect(core.voice.captures.hasLease).toBe(false);

    // 8. detachRouter resets both permission handlers to constant false even if a lease were armed later
    detachRouter();
    await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    expect(askPerm(wc, 'media', { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] })).toBe(false);
    expect(checkPerm(wc, 'media', 'file://', { isMainFrame: true, requestingUrl: trustedUrl, mediaType: 'audio' })).toBe(false);
  });
});

/* ============================================================================
 * V02 & V02-ADD-1: VOICE_APPEND Bypass Guards, 210s/3s Wall-Clock Seal, Event Order & Tail Failure
 * ========================================================================== */
describe('V02 & V02-ADD-1: VOICE_APPEND 二进制边界反绕过、210s/3s 墙钟封存、revokeOne 顺序与多段尾块失败', () => {
  it('blocks every forged/oversized/shared/resizable/detached/subview/getter buffer at IPC boundary', async () => {
    const handlers = new Map<string, Function>();
    const ipcMain = {
      handle: (ch: string, cb: Function) => handlers.set(ch, cb),
      removeHandler: (ch: string) => handlers.delete(ch),
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const appendSpy = vi.fn().mockResolvedValue({ captureId: 'c1', accepted: true, seq: 1, acceptedBytes: 16, remainingBytes: 100 });
    const fakeService = Object.assign(new EventEmitter(), {
      savingForQuit: false,
      voiceAppend: appendSpy,
      voice: { revoke: vi.fn() },
    }) as unknown as CoreService;

    const dispose = registerIpcRouter(ipcMain, fakeService, trusted);
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    try {
      const voiceAppend = handlers.get(IPC_CHANNELS.VOICE_APPEND)!;

      // Valid zero-offset Uint8Array and fixed ArrayBuffer pass
      await voiceAppend(event, { captureId: 'c1', seq: 1, pcm16: new Uint8Array(16) });
      await voiceAppend(event, { captureId: 'c1', seq: 2, pcm16: new ArrayBuffer(32_768) });
      expect(appendSpy).toHaveBeenCalledTimes(2);

      // Construct adversarial binary variants
      const sab = new SharedArrayBuffer(16);
      const sabView = new Uint8Array(sab);
      const ResizableAB = ArrayBuffer as unknown as new (len: number, opts?: { maxByteLength?: number }) => ArrayBuffer;
      const resizableAb = new ResizableAB(16, { maxByteLength: 64 });
      const resizableView = new Uint8Array(resizableAb);
      const detachedAb = new ArrayBuffer(16);
      structuredClone(detachedAb, { transfer: [detachedAb] });
      const subview = new Uint8Array(new ArrayBuffer(32), 4, 16);
      const getterObj = { captureId: 'c1', seq: 3 };
      Object.defineProperty(getterObj, 'pcm16', { enumerable: true, get: () => new Uint8Array(16) });

      for (const bad of [
        { captureId: 'c1', seq: 3, pcm16: Buffer.alloc(16) },
        { captureId: 'c1', seq: 3, pcm16: new DataView(new ArrayBuffer(16)) },
        { captureId: 'c1', seq: 3, pcm16: new Int16Array(8) },
        { captureId: 'c1', seq: 3, pcm16: sab },
        { captureId: 'c1', seq: 3, pcm16: sabView },
        { captureId: 'c1', seq: 3, pcm16: resizableAb },
        { captureId: 'c1', seq: 3, pcm16: resizableView },
        { captureId: 'c1', seq: 3, pcm16: detachedAb },
        { captureId: 'c1', seq: 3, pcm16: subview },
        { captureId: 'c1', seq: 3, pcm16: new Uint8Array(0) },
        { captureId: 'c1', seq: 3, pcm16: new Uint8Array(1) },
        { captureId: 'c1', seq: 3, pcm16: new Uint8Array(3) },
        { captureId: 'c1', seq: 3, pcm16: new Uint8Array(32_770) },
        { captureId: 'c1', seq: 3, pcm16: new ArrayBuffer(32_770) },
        { captureId: 'c1', seq: 3, pcm16: new Uint8Array(16), extra: true },
        { captureId: 'c1', seq: 0, pcm16: new Uint8Array(16) },
        { captureId: 'c1', seq: 1.5, pcm16: new Uint8Array(16) },
        { captureId: '', seq: 3, pcm16: new Uint8Array(16) },
        { captureId: 'x'.repeat(129), seq: 3, pcm16: new Uint8Array(16) },
        getterObj,
      ]) {
        expect(() => voiceAppend(event, bad)).toThrow(/语音分片格式无效|incompatible receiver|ArrayBuffer/);
      }

      // Wrong arg count (0 args, 2 args)
      expect(() => voiceAppend(event)).toThrow(/参数数量无效/);
      expect(() => voiceAppend(event, { captureId: 'c1', seq: 3, pcm16: new Uint8Array(16) }, 'extra')).toThrow(/参数数量无效/);
      expect(appendSpy).toHaveBeenCalledTimes(2);

      // Shared validator agrees with IPC boundary
      expect(isValidVoicePcm16Buffer(new Uint8Array(16))).toBe(true);
      expect(isValidVoicePcm16Buffer(new ArrayBuffer(16))).toBe(true);
      expect(isValidVoicePcm16Buffer(Buffer.alloc(16))).toBe(false);
      expect(isValidVoicePcm16Buffer(sabView)).toBe(false);
      expect(isValidVoicePcm16Buffer(resizableAb)).toBe(false);
      expect(isValidVoicePcm16Buffer(detachedAb)).toBe(false);
      expect(isValidVoicePcm16Buffer(subview)).toBe(false);
    } finally {
      dispose();
    }
  });

  it('DEF-BE-02 & DEC-06: returns capped:true on 210s/3s wall-clock seal, emits revoked before settled(aborted), and reports tail-segment error honestly', async () => {
    vi.useFakeTimers();
    const events: Array<{ name: string; payload: unknown }> = [];
    let failOnFinish = false;
    let publishRef: ((text: string) => void) | undefined;
    const closedStreams: number[] = [];

    const stableCfg = { ...DEFAULT_VOICE_CONFIG, engine: 'local' as const, locale: 'en-US' as const };
    const capture = new VoiceCapture({
      epoch: (o) => (o.profileId === 'default' ? 1 : undefined),
      config: () => stableCfg,
      ready: async () => {},
      requestMicrophone: async () => true,
      stream: (_locale, _signal, publish) => {
        publishRef = publish;
        const idx = closedStreams.length + 1;
        return {
          append: () => {},
          finish: async () => {
            if (failOnFinish) throw new Error('tail worker crash');
          },
          close: async () => { closedStreams.push(idx); },
        };
      },
      transcribe: async () => 'unused',
      cooldown: () => ({}),
      emit: (name, payload) => events.push({ name, payload }),
    });

    // 1. Dictation wall-clock 210s seal when acceptedBytes < 6,720,000
    const dict = await capture.arm({ owner: { profileId: 'default', sessionId: 's1' }, purpose: 'dictation' });
    // Appending while armed returns not-capturing
    expect(capture.append({ captureId: dict.captureId, seq: 1, pcm16: new Uint8Array(16_000) })).toMatchObject({
      accepted: false,
      capped: false,
      reason: 'not-capturing',
    });
    await capture.arm({ op: 'media-ready', captureId: dict.captureId });
    expect(capture.append({ captureId: dict.captureId, seq: 1, pcm16: new Uint8Array(16_000) })).toMatchObject({
      accepted: true,
      capped: false,
      acceptedBytes: 16_000,
    });
    // Seq mismatch returns seq-mismatch
    expect(capture.append({ captureId: dict.captureId, seq: 5, pcm16: new Uint8Array(16_000) })).toMatchObject({
      accepted: false,
      reason: 'seq-mismatch',
      expectedSeq: 2,
    });
    // Advance full 210s wall clock -> sealed automatically, next append MUST report capped: true, reason: 'capped'
    await vi.advanceTimersByTimeAsync(VOICE_MAX_DURATION_MS);
    expect(capture.append({ captureId: dict.captureId, seq: 2, pcm16: new Uint8Array(16_000) })).toMatchObject({
      accepted: false,
      capped: true,
      reason: 'capped',
      acceptedBytes: 16_000,
    });

    // 2. DEC-06 / QA1-FE-01: preempt/revokeOne MUST emit voice-capture-revoked BEFORE voice-settled(aborted)
    events.length = 0;
    const micTest = await capture.arm({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    expect(events.map((e) => e.name)).toEqual(['voice-capture-revoked', 'voice-settled']);
    expect((events[0].payload as VoiceCaptureRevokedEvent).reason).toBe('preempted');
    expect((events[1].payload as VoiceSettledEvent).outcome).toBe('aborted');

    // 3. mic-test 3s wall-clock seal when acceptedBytes < 96,000
    await capture.arm({ op: 'media-ready', captureId: micTest.captureId });
    expect(capture.append({ captureId: micTest.captureId, seq: 1, pcm16: new Uint8Array(16_000) })).toMatchObject({
      accepted: true,
      capped: false,
    });
    await vi.advanceTimersByTimeAsync(VOICE_MIC_TEST_MAX_DURATION_MS);
    expect(capture.append({ captureId: micTest.captureId, seq: 2, pcm16: new Uint8Array(16_000) })).toMatchObject({
      accepted: false,
      capped: true,
      reason: 'capped',
    });
    capture.abort(micTest.captureId);
    // Exact byte cap on mic-test (96,000 B)
    const micCap = await capture.arm({ owner: { profileId: 'default' }, purpose: 'mic-test' });
    await capture.arm({ op: 'media-ready', captureId: micCap.captureId });
    for (let seq = 1; seq <= 3; seq++) {
      const res = capture.append({ captureId: micCap.captureId, seq, pcm16: new Uint8Array(VOICE_MIC_TEST_MAX_BYTES / 3) });
      expect(res.accepted).toBe(true);
      expect(res.capped).toBe(seq === 3);
    }
    expect(capture.append({ captureId: micCap.captureId, seq: 4, pcm16: new Uint8Array(2) })).toMatchObject({
      accepted: false,
      capped: true,
      reason: 'capped',
      remainingBytes: 0,
    });
    capture.abort(micCap.captureId);

    // 4. Multi-segment tail failure: segment 1 succeeds, tail finish throws -> outcome: 'error', finalSeq: 1 (not 'completed')
    events.length = 0;
    failOnFinish = true;
    const capFail = await capture.arm({ owner: { profileId: 'default', sessionId: 's1' }, purpose: 'dictation' });
    await capture.arm({ op: 'media-ready', captureId: capFail.captureId });
    capture.append({ captureId: capFail.captureId, seq: 1, pcm16: new Uint8Array(16_000) });
    publishRef!('First segment works.');
    const finishRes = await capture.finish({ captureId: capFail.captureId, finalChunkSeq: 1 });
    expect(finishRes).toMatchObject({ status: 'settled', finalSeq: 1, text: 'First segment works.', error: '语音转写失败' });
    const settledEv = events.find((e) => e.name === 'voice-settled')?.payload as VoiceSettledEvent;
    expect(settledEv).toMatchObject({ outcome: 'error', finalSeq: 1, text: 'First segment works.', error: '语音转写失败' });
    // Idempotent second finish
    const secondFinish = await capture.finish({ captureId: capFail.captureId });
    expect(secondFinish.status).toBe('already-settled');
    expect(closedStreams.length).toBeGreaterThanOrEqual(1);
  });
});

/* ============================================================================
 * V03 & V03-ADD-1: Single-Slot Preemption, Profile Isolation, External Held 60s Expiry & Quit-Save Gates
 * ========================================================================== */
describe('V03 & V03-ADD-1: 跨会话抢占、切 Profile 隔离、外部 held 60s 过期 0 上传与退出保存期门禁', () => {
  it('enforces single-slot preemption, external held 60s timeout with 0 HTTP, profile-switch isolation, and savingForQuit IPC gates', async () => {
    vi.useFakeTimers();
    const httpCalls: string[] = [];
    const voiceFetcher: typeof fetch = vi.fn(async (url) => {
      httpCalls.push(String(url));
      return Response.json({ text: 'The library opens at nine in the morning.' });
    });
    const { core, cwd, dir } = makeCoreFixture({ voiceFetcher });
    const sA = await core.createSession({ cwd, title: 'Session A' });
    const sB = await core.createSession({ cwd, title: 'Session B' });

    // Verify & enable external-api
    const extCfg = {
      enabled: true,
      provider: 'openai-compatible' as const,
      endpoint: 'http://127.0.0.1:41999/v1',
      model: 'whisper-1',
      timeoutMs: 5000,
    };
    const testRes = await core.testVoiceConnection(extCfg);
    expect(testRes.ok).toBe(true);
    await core.updateVoiceConfig({ engine: 'external-api', externalProvider: extCfg });
    httpCalls.length = 0;

    // 1. Preemption across sessions A -> B
    const events: Array<{ type: string; payload: unknown }> = [];
    core.on('voice-capture-revoked', (p) => events.push({ type: 'revoked', payload: p }));
    core.on('voice-settled', (p) => events.push({ type: 'settled', payload: p }));
    const capA = await core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sA.sessionId }, purpose: 'dictation' });
    await core.voiceArmCapture({ op: 'media-ready', captureId: capA.captureId });
    const capB = await core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sB.sessionId }, purpose: 'dictation' });
    expect(events.map((e) => e.type)).toEqual(['revoked', 'settled']);
    expect((events[0].payload as VoiceCaptureRevokedEvent)).toMatchObject({ captureId: capA.captureId, reason: 'preempted' });
    expect((await core.getVoiceState()).activeCapture?.captureId).toBe(capB.captureId);

    // 2. External mode hold (e.g. entering Settings): 0 HTTP requests, heldCapture present, expires after 60s with 0 upload
    events.length = 0;
    await core.voiceArmCapture({ op: 'media-ready', captureId: capB.captureId });
    await core.voiceAppend({ captureId: capB.captureId, seq: 1, pcm16: new Uint8Array(16_000) });
    expect(httpCalls).toEqual([]);
    const heldRes = await core.voiceArmCapture({ op: 'release-media', captureId: capB.captureId, hold: true });
    expect(heldRes.state).toBe('sealed');
    expect(httpCalls).toEqual([]);
    expect((events[0].payload as VoiceCaptureRevokedEvent)).toMatchObject({ captureId: capB.captureId, held: true });
    expect((await core.getVoiceState()).heldCapture?.captureId).toBe(capB.captureId);
    expect((await core.getVoiceState()).activeCapture).toBeUndefined();

    // Advance 61s -> held expires without any upload
    await vi.advanceTimersByTimeAsync(61_000);
    expect(httpCalls).toEqual([]);
    const afterExpiryFinish = await core.voiceFinish({ captureId: capB.captureId });
    expect(afterExpiryFinish.status).toBe('aborted');
    expect(httpCalls).toEqual([]);

    // 3. Profile switch revokes active capture and blocks stale captureId/epoch
    const accs = await core.createAccountProfile({ name: 'Isolated Voice Profile' });
    const profB = accs.profiles.find((p) => !p.isDefault)!;
    const capBeforeSwitch = await core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sA.sessionId }, purpose: 'dictation' });
    await core.voiceArmCapture({ op: 'media-ready', captureId: capBeforeSwitch.captureId });
    events.length = 0;
    await core.switchAccountProfile(profB.profileId);
    expect(events.some((e) => e.type === 'revoked' && (e.payload as VoiceCaptureRevokedEvent).reason === 'profile-switched')).toBe(true);
    await expect(core.voiceAppend({ captureId: capBeforeSwitch.captureId, seq: 1, pcm16: new Uint8Array(16_000) })).rejects.toThrow(/失效|无效/);
    await expect(core.voiceFinish({ captureId: capBeforeSwitch.captureId })).rejects.toThrow(/失效/);
    await expect(core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sA.sessionId, epoch: capBeforeSwitch.epoch }, purpose: 'dictation' })).rejects.toThrow(/归属/);
    await core.switchAccountProfile('default');

    // 4. savingForQuit IPC gating: blocks arm/append/finish, allows voiceAbort / release-media / install cancel / getVoiceState
    const handlers = new Map<string, Function>();
    const ipcMain = { handle: (ch: string, cb: Function) => handlers.set(ch, cb), removeHandler: (ch: string) => handlers.delete(ch) } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const unbind = registerIpcRouter(ipcMain, core, trusted);
    const ev = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    try {
      const capQuit = await core.voiceArmCapture({ owner: { profileId: 'default' }, purpose: 'mic-test' });
      vi.spyOn(core, 'savingForQuit', 'get').mockReturnValue(true);

      expect(() => handlers.get(IPC_CHANNELS.VOICE_ARM_CAPTURE)!(ev, { owner: { profileId: 'default' }, purpose: 'mic-test' })).toThrow(/正在保存退出/);
      expect(() => handlers.get(IPC_CHANNELS.VOICE_APPEND)!(ev, { captureId: capQuit.captureId, seq: 1, pcm16: new Uint8Array(16) })).toThrow(/正在保存退出/);
      expect(() => handlers.get(IPC_CHANNELS.VOICE_FINISH)!(ev, { captureId: capQuit.captureId })).toThrow(/正在保存退出/);
      expect(() => handlers.get(IPC_CHANNELS.VOICE_INSTALL_MODEL)!(ev, { action: 'start' })).toThrow(/正在保存退出/);

      // Allowed during savingForQuit: getVoiceState, release-media, voiceAbort, install cancel
      expect(await handlers.get(IPC_CHANNELS.VOICE_GET_STATE)!(ev)).toBeDefined();
      expect(await handlers.get(IPC_CHANNELS.VOICE_ARM_CAPTURE)!(ev, { op: 'release-media', captureId: capQuit.captureId })).toMatchObject({ state: 'released' });
      expect(await handlers.get(IPC_CHANNELS.VOICE_ABORT)!(ev, { captureId: capQuit.captureId })).toMatchObject({ captureId: capQuit.captureId });
      expect(await handlers.get(IPC_CHANNELS.VOICE_INSTALL_MODEL)!(ev, { action: 'cancel' })).toMatchObject({ started: false });
    } finally {
      unbind();
    }

    // 0 temporary audio files written into dataDir
    const allFiles = readdirSync(dir, { recursive: true, encoding: 'utf8' });
    expect(allFiles.filter((f) => /\.(?:wav|pcm|mp3|ogg|webm)$/i.test(f))).toEqual([]);
  });
});

/* ============================================================================
 * V04 & V04-ADD-1: Offline Whisper Safety Loader (8.3 Short Path / Hardlink / Symlink / Cancel) & Real Offline Transcription
 * ========================================================================== */
describe('V04 & V04-ADD-1: 离线 Whisper 安全加载（8.3 短路径/硬链/软链/取消恢复）与真实断网转写', () => {
  it('enforces hardlink/symlink/corruption rejection, DEF-BE-08 cancel recovery, and DEF-BE-03 Windows 8.3 short-path install/verify', async () => {
    const root = makeTempDir('gravity-v036-model-sec-');
    const emptyAppRoot = path.join(root, 'app');
    const dataDir = path.join(root, 'Long Voice Data Dir');
    mkdirSync(path.join(emptyAppRoot, 'assets', 'local-voice'), { recursive: true });
    mkdirSync(path.join(dataDir, 'voice-models'), { recursive: true });

    // 1. Corrupted file -> state() is 'error'; start install then cancel -> state() MUST revert to 'error' (DEF-BE-08), 0 .tmp files left
    const userModelFile = path.join(dataDir, 'voice-models', VOICE_LOCAL_MODEL_SPEC.fileName);
    writeFileSync(userModelFile, Buffer.from('corrupt-10b'));
    let abortObserved = false;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((res) => { markFetchStarted = res; });
    const stallFetcher: typeof fetch = vi.fn(async (_url, init) => {
      markFetchStarted();
      if (init?.signal?.aborted) {
        abortObserved = true;
        throw new Error('aborted');
      }
      await new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          abortObserved = true;
          rej(new Error('aborted'));
        }, { once: true });
      });
      throw new Error('unreachable');
    });
    const localCorrupt = new LocalVoice(emptyAppRoot, dataDir, stallFetcher);
    expect((await localCorrupt.state()).status).toBe('error');
    const started = await localCorrupt.install({ action: 'start' });
    expect(started.started).toBe(true);
    await fetchStarted;
    const cancelled = await localCorrupt.install({ action: 'cancel' });
    expect(abortObserved).toBe(true);
    expect(cancelled.state.status).toBe('error');
    expect(readdirSync(path.join(dataDir, 'voice-models')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await localCorrupt.stop();

    // 2. Hardlink rejection (nlink > 1)
    if (HAS_REAL_MODEL) {
      const realBytes = readFileSync(REAL_MODEL_PATH);
      const outside = path.join(root, 'outside-model.bin');
      writeFileSync(outside, realBytes);
      rmSync(userModelFile, { force: true });
      linkSync(outside, userModelFile);
      await expect(modelIO.readVerified(userModelFile)).rejects.toThrow(/Invalid voice model file/);
      rmSync(userModelFile, { force: true });

      // 3. Symlink directory rejection
      const symParent = path.join(root, 'sym-models');
      const realTargetDir = path.join(root, 'real-target');
      mkdirSync(realTargetDir, { recursive: true });
      writeFileSync(path.join(realTargetDir, VOICE_LOCAL_MODEL_SPEC.fileName), realBytes);
      symlinkSync(realTargetDir, symParent, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(modelIO.readVerified(path.join(symParent, VOICE_LOCAL_MODEL_SPEC.fileName))).rejects.toThrow(/Redirected voice model path/);

      // 4. DEF-BE-03: Windows 8.3 short path & case-variant install + readVerified succeed without false redirection error
      const shortDataRoot = path.join(root, 'Space Named Model Target');
      const shortInstallDir = path.join(shortDataRoot, 'voice-models');
      mkdirSync(shortInstallDir, { recursive: true });
      let testDir = shortInstallDir;
      if (process.platform === 'win32') {
        const res = spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("%GRAVITY_TEST_VOICE_DIR%") do @echo %~sI'], {
          env: { ...process.env, GRAVITY_TEST_VOICE_DIR: shortInstallDir },
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        expect(res.status).toBe(0);
        testDir = res.stdout.trim();
        expect(existsSync(testDir)).toBe(true);
      }
      // Stream in large 4 MiB chunks to avoid thousands of tiny syscalls while exercising full streaming hash + atomic rename
      const makeStreamResponse = () => {
        const chunkSize = 4 * 1024 * 1024;
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= realBytes.byteLength) { controller.close(); return; }
            const end = Math.min(offset + chunkSize, realBytes.byteLength);
            controller.enqueue(realBytes.subarray(offset, end));
            offset = end;
          },
        });
        return new Response(body, { status: 200 });
      };
      const streamFetcher: typeof fetch = vi.fn(async () => makeStreamResponse());
      await modelIO.install(testDir, new AbortController().signal, () => {}, streamFetcher);
      const installedFile = path.join(testDir, VOICE_LOCAL_MODEL_SPEC.fileName);
      const verified = await modelIO.readVerified(installedFile);
      expect(verified.byteLength).toBe(VOICE_LOCAL_MODEL_SPEC.sizeBytes);
      expect(createHash('sha256').update(verified).digest('hex')).toBe(VOICE_LOCAL_MODEL_SPEC.sha256);

      // Bundled preferred over user-data, falls back to user-data when bundled absent
      const localUserData = new LocalVoice(emptyAppRoot, shortDataRoot);
      expect(await localUserData.state()).toMatchObject({ status: 'ready', source: 'user-data', sha256Verified: true });
      await localUserData.stop();

      const localBundled = new LocalVoice(REPO_ROOT, shortDataRoot);
      expect(await localBundled.state()).toMatchObject({ status: 'ready', source: 'bundled', sha256Verified: true });
      await localBundled.stop();
    }
  }, 60_000);

  it.runIf(HAS_REAL_MODEL)('transcribes bundled test-clip.pcm offline with zero network calls and validates OpenCC & CJK spacing normalization', async () => {
    const networkSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('OFFLINE_VIOLATION: network access attempted during offline Whisper inference');
    });
    const { core } = makeCoreFixture();

    // 1. CoreService local testVoiceConnection runs real Whisper WASM in worker_threads strictly offline
    const t0 = Date.now();
    const res = await core.testVoiceConnection();
    const elapsedMs = Date.now() - t0;
    expect(res.ok).toBe(true);
    expect(res.transcriptPreview?.toLowerCase()).toMatch(/library opens at (?:9|nine)/);
    expect(networkSpy).not.toHaveBeenCalled();

    // 2. Direct LocalVoice.transcribe with en-US & auto on test-clip.pcm
    const pcm = readFileSync(REAL_TEST_PCM_PATH);
    const enText = await core.voice.local.transcribe(pcm, 'en-US', new AbortController().signal);
    expect(enText.toLowerCase()).toMatch(/library opens at (?:9|nine)/);
    const autoText = await core.voice.local.transcribe(pcm, 'auto', new AbortController().signal);
    expect(autoText.toLowerCase()).toMatch(/library opens at (?:9|nine)/);
    expect(networkSpy).not.toHaveBeenCalled();

    // 3. Verify OpenCC TSCharacters.txt + TSPhrases.txt map traditional phrases -> simplified (same algorithm as worker.cjs)
    const voiceRoot = path.join(REPO_ROOT, 'assets', 'local-voice');
    const entries = new Map<string, string>();
    let longest = 1;
    for (const dictName of ['TSCharacters.txt', 'TSPhrases.txt']) {
      for (const line of readFileSync(path.join(voiceRoot, dictName), 'utf8').split(/\r?\n/)) {
        const [source, alts] = line.split('\t');
        if (!alts || source.startsWith('#')) continue;
        entries.set(source, alts.split(' ')[0]);
        longest = Math.max(longest, Array.from(source).length);
      }
    }
    const toSimplified = (text: string) => {
      const chars = Array.from(text);
      let out = '';
      for (let i = 0; i < chars.length;) {
        let size = Math.min(longest, chars.length - i);
        let rep: string | undefined;
        while (size > 0) {
          rep = entries.get(chars.slice(i, i + size).join(''));
          if (rep !== undefined) break;
          size--;
        }
        out += rep ?? chars[i];
        i += size || 1;
      }
      return out;
    };
    expect(toSimplified('語音轉寫軟體與網路連線測試')).toBe('语音转写软体与网路连线测试');
    expect(toSimplified('這個檔案應該沒有問題')).toBe('这个档案应该没有问题');

    // 4. normalizeDictationText: collapses CJK inner spaces while preserving English, Latin-CJK boundary, URLs, and code tokens
    expect(normalizeDictationText('', '你 好 世 界 ， 測 試 完 成 。', 'zh-CN')).toBe('你好世界，測試完成。');
    expect(normalizeDictationText('', 'Professional / Elite 门 槛 是 什 么 ？', 'zh-CN')).toBe('Professional / Elite 门槛是什么？');
    expect(normalizeDictationText('Check', 'https://example.invalid/a/b `const x = 1`', 'en-US')).toBe(' https://example.invalid/a/b `const x = 1`');
    expect(elapsedMs).toBeLessThan(30_000);
  }, 60_000);

  it('model.cjs sameIdentity allows Electron 35 win32 lstat dev=0n vs fstat dev!=0n with matching ino, and strictly rejects ino/dev mismatches', async () => {
    const modelSource = readFileSync(path.join(REPO_ROOT, 'assets', 'local-voice', 'model.cjs'), 'utf8');
    const payload = Buffer.from('synthetic-ggml-model-bytes-v036!');
    const payloadHash = createHash('sha256').update(payload).digest('hex');

    const loadModelWithFakeFs = (opts: {
      platform: NodeJS.Platform;
      lstatDev: bigint;
      lstatIno: bigint;
      fstatDev: bigint;
      fstatIno: bigint;
    }) => {
      const targetPath = opts.platform === 'win32' ? 'C:\\voice\\ggml-base-q5_1.bin' : '/voice/ggml-base-q5_1.bin';
      const pathMod = opts.platform === 'win32' ? path.win32 : path.posix;
      const makeStat = (dev: bigint, ino: bigint, isDir: boolean) => ({
        dev,
        ino,
        nlink: 1n,
        size: isDir ? 0n : BigInt(payload.byteLength),
        ctimeNs: 123456789n,
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
      });
      const fakeFs = {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
        lstatSync: (p: string) => {
          const isFile = pathMod.resolve(p) === targetPath;
          return makeStat(isFile ? opts.lstatDev : 1n, isFile ? opts.lstatIno : 10n, !isFile);
        },
        realpathSync: Object.assign((p: string) => pathMod.resolve(p), { native: (p: string) => pathMod.resolve(p) }),
      };
      const fakeFsPromises = {
        mkdir: async () => {},
        rename: async () => {},
        unlink: async () => {},
        open: async () => ({
          stat: async () => makeStat(opts.fstatDev, opts.fstatIno, false),
          read: async (buf: Buffer, offset: number, length: number, pos: number) => {
            const slice = payload.subarray(pos, pos + length);
            slice.copy(buf, offset);
            return { bytesRead: slice.byteLength };
          },
          close: async () => {},
        }),
      };
      const mod: { exports: { readVerified?: (file: string) => Promise<Buffer> } } = { exports: {} };
      const fakeRequire = (spec: string) => {
        if (spec === 'node:crypto') return { createHash, randomUUID: () => '00000000-0000-4000-8000-000000000000' };
        if (spec === 'node:fs') return fakeFs;
        if (spec === 'node:fs/promises') return fakeFsPromises;
        if (spec === 'node:path') return pathMod;
        if (spec === './sources.json') return { model: { fileName: 'ggml-base-q5_1.bin', sizeBytes: payload.byteLength, sha256: payloadHash } };
        throw new Error(`Unexpected require in model.cjs test: ${spec}`);
      };
      const fn = runInNewContext('(function(require, module, exports, process, Buffer) {' + modelSource + '\n})', {
        BigInt,
        Error,
      });
      fn(fakeRequire, mod, mod.exports, { platform: opts.platform }, Buffer);
      return { readVerified: mod.exports.readVerified!, targetPath };
    };

    // 1. Electron 35 win32: lstat dev=0n, fstat dev!=0n, identical non-zero ino -> MUST PASS
    const winOk = loadModelWithFakeFs({
      platform: 'win32',
      lstatDev: 0n,
      lstatIno: 1407374884314351n,
      fstatDev: 2195232986n,
      fstatIno: 1407374884314351n,
    });
    expect(await winOk.readVerified(winOk.targetPath)).toEqual(payload);

    // 2. Reverse win32: lstat dev!=0n, fstat dev=0n, identical non-zero ino -> MUST PASS
    const winReverseOk = loadModelWithFakeFs({
      platform: 'win32',
      lstatDev: 2195232986n,
      lstatIno: 1407374884314351n,
      fstatDev: 0n,
      fstatIno: 1407374884314351n,
    });
    expect(await winReverseOk.readVerified(winReverseOk.targetPath)).toEqual(payload);

    // 3. Different ino even when dev=0n on win32 -> MUST REJECT
    const diffIno = loadModelWithFakeFs({
      platform: 'win32',
      lstatDev: 0n,
      lstatIno: 1407374884314351n,
      fstatDev: 2195232986n,
      fstatIno: 1407374884314352n,
    });
    await expect(diffIno.readVerified(diffIno.targetPath)).rejects.toThrow(/Voice model changed/);

    // 4. Distinct non-zero dev values on win32 even with matching ino -> MUST REJECT
    const diffNonZeroDev = loadModelWithFakeFs({
      platform: 'win32',
      lstatDev: 111n,
      lstatIno: 1407374884314351n,
      fstatDev: 222n,
      fstatIno: 1407374884314351n,
    });
    await expect(diffNonZeroDev.readVerified(diffNonZeroDev.targetPath)).rejects.toThrow(/Voice model changed/);

    // 5. Zero ino -> MUST REJECT
    const zeroIno = loadModelWithFakeFs({
      platform: 'win32',
      lstatDev: 0n,
      lstatIno: 0n,
      fstatDev: 0n,
      fstatIno: 0n,
    });
    await expect(zeroIno.readVerified(zeroIno.targetPath)).rejects.toThrow(/Voice model changed/);

    // 6. Non-win32 (linux): dev=0n vs dev!=0n is NOT relaxed -> MUST REJECT
    const linuxDevZero = loadModelWithFakeFs({
      platform: 'linux',
      lstatDev: 0n,
      lstatIno: 42n,
      fstatDev: 2195232986n,
      fstatIno: 42n,
    });
    await expect(linuxDevZero.readVerified(linuxDevZero.targetPath)).rejects.toThrow(/Voice model changed/);
  });
});

/* ============================================================================
 * V05 & V05-ADD-1: External STT Security, No-Encryption Fail-Closed, Event Protocol, Rate Clearing, 401/403/429 & Ledger
 * ========================================================================== */
describe('V05 & V05-ADD-1: 外部转写安全边界、不可加密拒落明文、单次回传协议、清空单价、401/403/429 双序熔断与独立账本', () => {
  it('enforces no-encryption refusal, strict Gemini/OpenAI validation, test-before-enable, no-redirect, secret masking, external settled(finalSeq:0), and rate clearing', async () => {
    const secret = 'sk-v036-synth-voice-secret-998877';

    // 1. Encryption unavailable -> hard refusal and 0 plaintext persisted
    {
      const { core, dir } = makeCoreFixture({ secretCipher: makeCipher(false) });
      await expect(core.updateVoiceConfig({
        externalProvider: { provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', model: 'whisper-1', apiKey: secret },
      })).rejects.toThrow(/加密不可用/);
      const cfgPath = path.join(dir, 'voice-config.json');
      if (existsSync(cfgPath)) expect(readFileSync(cfgPath, 'utf8')).not.toContain(secret);
    }

    // 2. DEF-BE-07: Shared & main Gemini validation strictly aligned
    expect(hasExternalVoiceSettings({ provider: 'gemini-api-key', endpoint: 'http://127.0.0.1:8080', model: 'gemini-2.5-flash', apiKey: 'AIza-demo' })).toBe(false);
    expect(hasExternalVoiceSettings({ provider: 'gemini-api-key', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', apiKey: 'AIza-demo' })).toBe(false);
    expect(hasExternalVoiceSettings({ provider: 'gemini-api-key', endpoint: 'https://generativelanguage.googleapis.com', model: 'bad/model:name', apiKey: 'AIza-demo' })).toBe(false);
    expect(hasExternalVoiceSettings({ provider: 'gemini-api-key', endpoint: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', apiKey: 'AIza-demo' })).toBe(true);

    // 3. Real loopback OpenAI-compatible HTTP server
    let mode: 'empty' | 'wrong' | 'redirect' | 'ok' | 'echo-secret' | '401' = 'ok';
    let transcriptionPosts = 0;
    const server = createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini-transcribe' }, { id: 'whisper-1' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
        transcriptionPosts++;
        for await (const _chunk of req) { /* drain */ }
        if (mode === 'redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1/redirected' }).end();
          return;
        }
        if (mode === '401') {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `bad key ${secret}` }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        if (mode === 'empty') { res.end(JSON.stringify({ text: '   ' })); return; }
        if (mode === 'wrong') { res.end(JSON.stringify({ text: 'completely unrelated phrase' })); return; }
        if (mode === 'echo-secret') {
          res.end(JSON.stringify({ text: `External dictation echoing ${secret} safely.`, usage: { cost: 0.0025 } }));
          return;
        }
        res.end(JSON.stringify({ text: 'The library opens at nine in the morning.' }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

    const { core, cwd, dir } = makeCoreFixture();
    const sess = await core.createSession({ cwd });
    const baseExt = { enabled: true, provider: 'openai-compatible' as const, endpoint, model: 'gpt-4o-mini-transcribe', apiKey: secret, timeoutMs: 5000 };

    // Discover alone cannot enable external-api
    const discovered = await core.discoverVoiceModels({ provider: 'openai-compatible', endpoint, apiKey: secret });
    expect(discovered.models.map((m) => m.id)).toEqual(['gpt-4o-mini-transcribe', 'whisper-1']);
    await expect(core.updateVoiceConfig({ engine: 'external-api', externalProvider: baseExt })).rejects.toThrow(/短语音验证/);

    // Empty, wrong phrase, and 302 redirect all fail verification and never enable
    for (const badMode of ['empty', 'wrong', 'redirect'] as const) {
      mode = badMode;
      const failRes = await core.testVoiceConnection(baseExt);
      expect(failRes.ok, `mode=${badMode}`).toBe(false);
      expect(JSON.stringify(failRes)).not.toContain(secret);
      await expect(core.updateVoiceConfig({ engine: 'external-api', externalProvider: baseExt })).rejects.toThrow(/短语音验证/);
    }

    // Valid test phrase verifies and enables
    mode = 'ok';
    const passRes = await core.testVoiceConnection(baseExt);
    expect(passRes.ok).toBe(true);
    const savedState = await core.updateVoiceConfig({
      engine: 'external-api',
      externalProvider: { ...baseExt, ratePerMinuteUsd: 0.006 },
    });
    expect(savedState.config.engine).toBe('external-api');
    expect(savedState.config.externalProvider.hasApiKey).toBe(true);
    expect(savedState.config.externalProvider.apiKey).toBeUndefined();
    expect(savedState.config.externalProvider.ratePerMinuteUsd).toBe(0.006);

    // Zero plaintext API key across getVoiceState, getBootstrap, and voice-config.json on disk
    const bootstrap = await core.getBootstrap();
    expect(bootstrap.voiceState?.config.externalProvider.apiKey).toBeUndefined();
    expect(bootstrap.voiceState?.config.externalProvider.hasApiKey).toBe(true);
    expect(JSON.stringify({ savedState, bootstrap })).not.toContain(secret);
    expect(readFileSync(path.join(dir, 'voice-config.json'), 'utf8')).not.toContain(secret);

    // QA1-FE-09: clearing ratePerMinuteUsd with null, empty string '', and explicit undefined; omitting preserves it
    const keptRate = await core.updateVoiceConfig({ locale: 'en-US' });
    expect(keptRate.config.externalProvider.ratePerMinuteUsd).toBe(0.006);
    const clearedNull = await core.updateVoiceConfig({ externalProvider: { ratePerMinuteUsd: null } });
    expect(clearedNull.config.externalProvider.ratePerMinuteUsd).toBeUndefined();
    await core.updateVoiceConfig({ externalProvider: { ratePerMinuteUsd: 0.01 } });
    const clearedEmptyStr = await core.updateVoiceConfig({ externalProvider: { ratePerMinuteUsd: '' as unknown as null } });
    expect(clearedEmptyStr.config.externalProvider.ratePerMinuteUsd).toBeUndefined();
    await core.updateVoiceConfig({ externalProvider: { ratePerMinuteUsd: 0.02 } });
    const clearedUndef = await core.updateVoiceConfig({ externalProvider: { ratePerMinuteUsd: undefined } });
    expect(clearedUndef.config.externalProvider.ratePerMinuteUsd).toBeUndefined();

    // DEC-03 / DEF-BE-06: External dictation emits 0 voice-segment events and 1 voice-settled(finalSeq: 0, text) + masks echoed secret
    const segs: VoiceSegmentEvent[] = [];
    const settled: VoiceSettledEvent[] = [];
    core.on('voice-segment', (e: VoiceSegmentEvent) => segs.push(e));
    core.on('voice-settled', (e: VoiceSettledEvent) => settled.push(e));
    const postsBefore = transcriptionPosts;
    mode = 'echo-secret';
    const cap = await core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sess.sessionId }, purpose: 'dictation' });
    await core.voiceArmCapture({ op: 'media-ready', captureId: cap.captureId });
    await core.voiceAppend({ captureId: cap.captureId, seq: 1, pcm16: new Uint8Array(16_000) });
    expect(transcriptionPosts).toBe(postsBefore); // 0 HTTP during active recording
    await core.voiceArmCapture({ op: 'release-media', captureId: cap.captureId });
    const finished = await core.voiceFinish({ captureId: cap.captureId, finalChunkSeq: 1 });
    expect(transcriptionPosts).toBe(postsBefore + 1);
    expect(segs).toEqual([]);
    expect(finished).toMatchObject({ status: 'settled', finalSeq: 0 });
    expect(settled.at(-1)).toMatchObject({ finalSeq: 0, outcome: 'completed', engine: 'external-api' });
    expect(settled.at(-1)!.text).toContain('[已隐藏]');
    expect(settled.at(-1)!.text).not.toContain(secret);

    // 401 during dictation invalidates verified status and falls back to local
    mode = '401';
    const cap401 = await core.voiceArmCapture({ owner: { profileId: 'default', sessionId: sess.sessionId }, purpose: 'dictation' });
    await core.voiceArmCapture({ op: 'media-ready', captureId: cap401.captureId });
    await core.voiceAppend({ captureId: cap401.captureId, seq: 1, pcm16: new Uint8Array(16_000) });
    await core.voiceArmCapture({ op: 'release-media', captureId: cap401.captureId });
    await core.voiceFinish({ captureId: cap401.captureId, finalChunkSeq: 1 });
    const after401 = await core.getVoiceState();
    expect(after401.config.engine).toBe('local');
    expect(after401.config.externalProvider.connectionStatus).toBe('failed');
    expect(after401.config.externalProvider.enabled).toBe(false);
  });

  it('enforces dual-order 403/429 independent voiceCircuit cooldown and accurate crash-recoverable VoiceLedger isolated from ACP heatmaps', async () => {
    const now = Date.parse('2026-11-28T10:00:00.000Z');
    const dir = makeTempDir('gravity-v036-ledger-');
    const store = new ClientStore(dir);

    // 1. 403 -> 429 and 429 -> 403 both retain 300s 403 cooldown on voiceCircuit without touching reviewerCircuit/translatorCircuit
    const ep1 = 'https://generativelanguage.googleapis.com';
    const ep2 = 'https://api.openai.com/v1';

    voiceCircuit.fail(ep1, 403, now);
    voiceCircuit.fail(ep1, 429, now + 100);
    expect(voiceCircuit.cooldownStatus(ep1)).toBe(403);
    expect(voiceCircuit.remaining(ep1, now + 100)).toBeGreaterThanOrEqual(299_000);

    voiceCircuit.fail(ep2, 429, now);
    voiceCircuit.fail(ep2, 403, now + 100);
    expect(voiceCircuit.cooldownStatus(ep2)).toBe(403);
    expect(voiceCircuit.remaining(ep2, now + 100)).toBeGreaterThanOrEqual(299_900);

    expect(reviewerCircuit.remaining(ep1, now)).toBe(0);
    expect(reviewerCircuit.remaining(ep2, now)).toBe(0);
    expect(translatorCircuit.remaining(ep1, now)).toBe(0);
    expect(translatorCircuit.remaining(ep2, now)).toBe(0);

    // Also test Gemini Developer API real request shape via injected voiceFetcher
    voiceCircuit.reset();
    let capturedUrl = '';
    let capturedKeyHeader = '';
    const geminiFetcher: typeof fetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedKeyHeader = (init?.headers as Record<string, string>)['x-goog-api-key'];
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Gemini transcript ok.' }] } }],
        usageMetadata: { costUsd: 0.0012 },
      });
    });
    const ledger = new VoiceLedger(store, () => now, () => {}, () => 'default');
    const external = new ExternalVoice(ledger, geminiFetcher);
    const geminiCfg = {
      enabled: true,
      provider: 'gemini-api-key' as const,
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
      apiKey: 'AIzaSySynthGeminiKey12345',
      timeoutMs: 5000,
    };
    const out = await external.transcribe(geminiCfg, new Uint8Array(32_000), 'en-US', new AbortController().signal, { profileId: 'default' }, 'dictation');
    expect(out).toBe('Gemini transcript ok.');
    expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(capturedKeyHeader).toBe('AIzaSySynthGeminiKey12345');

    // 2. VoiceLedger three cost bases (provider-direct / estimated-per-minute / unknown), mixed direct+estimate consistency, late direct dedup, crash recovery
    const openaiCfg = {
      enabled: true,
      provider: 'openai-compatible' as const,
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      timeoutMs: 5000,
      ratePerMinuteUsd: 0.006,
    };
    // Call 1: provider-direct ($0.002)
    const r1 = ledger.begin(openaiCfg, 30_000, { profileId: 'default' }, 'dictation');
    ledger.complete(r1, 'completed', 0.002);
    // Call 2: estimated-per-minute (30s * 0.006/min = 0.003)
    const r2 = ledger.begin(openaiCfg, 30_000, { profileId: 'default' }, 'dictation');
    ledger.complete(r2, 'completed');
    // Mixed direct + estimate with 0 unknown -> costBasis MUST be 'estimated-per-minute' and hasUnknownCost MUST be false
    let snap = ledger.snapshot();
    let openaiRow = snap.providers.find((p) => p.modelId === 'gpt-4o-mini-transcribe')!;
    expect(openaiRow.costBasis).toBe('estimated-per-minute');
    expect(openaiRow.hasUnknownCost).toBe(false);
    expect(openaiRow.knownCostUsd).toBeCloseTo(0.005, 6);
    expect(openaiRow.callCount).toBe(2);

    // Late direct cost upgrade on r2 replaces estimate without double-counting calls
    ledger.complete(r2, 'completed', 0.004);
    snap = ledger.snapshot();
    openaiRow = snap.providers.find((p) => p.modelId === 'gpt-4o-mini-transcribe')!;
    expect(openaiRow.callCount).toBe(2);
    expect(openaiRow.knownCostUsd).toBeCloseTo(0.006, 6);
    expect(openaiRow.costBasis).toBe('provider-direct');

    // Call 3: unknown cost (no ratePerMinuteUsd, no direct cost) + crash recovery (unfinished attempt persisted on disk)
    const unknownCfg = { ...openaiCfg, model: 'whisper-unknown', ratePerMinuteUsd: undefined };
    const r3 = ledger.begin(unknownCfg, 15_000, { profileId: 'default' }, 'dictation');
    expect(r3.requestId).toBeTruthy();
    // Simulate process restart without calling ledger.complete(r3, ...)
    const restartedLedger = new VoiceLedger(new ClientStore(dir), () => now + 1000, () => {}, () => 'default');
    const recoveredSnap = restartedLedger.snapshot();
    const unknownRow = recoveredSnap.providers.find((p) => p.modelId === 'whisper-unknown')!;
    expect(unknownRow).toMatchObject({ callCount: 1, completedCount: 0, errorCount: 0, totalDurationMs: 15_000, knownCostUsd: 0, hasUnknownCost: true, costBasis: 'unknown' });

    // 3. ACP heatmap isolation & COST_DISCLAIMER intact
    const { core } = makeCoreFixture({ dataDir: dir });
    const dash = await core.getTelemetryDashboard();
    expect(dash.externalVoice?.cumulativeCalls).toBeGreaterThanOrEqual(4);
    expect(dash.hourly24h.every((b) => b.totalTokens === 0 && b.costUsd === 0)).toBe(true);
    expect((dash.daily7d ?? []).every((b) => b.totalTokens === 0 && b.costUsd === 0)).toBe(true);
    expect(dash.calendar30d.every((b) => b.totalTokens === 0 && b.costUsd === 0)).toBe(true);
    expect(COST_DISCLAIMER['zh-CN'].length).toBeGreaterThan(5);
    expect(COST_DISCLAIMER['en-US'].length).toBeGreaterThan(5);
  });
});

// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/renderer/App';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { SessionPane } from '../src/renderer/components/SessionPane';
import { Composer } from '../src/renderer/components/Composer';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { VoiceSettingsCard } from '../src/renderer/components/settings/VoiceSettingsCard';
import { ApprovalsPanel, PluginsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { IconsPanel } from '../src/renderer/components/settings/AppearancePanels';
import { ComposerDrafts } from '../src/renderer/lib/composer-draft';
import { CHUNK_SAMPLES, Pcm16Chunker, TARGET_RATE } from '../src/renderer/lib/voice/pcm-encoder';
import { applyUserEdit, insertDictation, rollbackCapture, sealCapture, type DictationState } from '../src/renderer/lib/voice/dictation-ranges';
import {
  MAX_INFLIGHT_APPENDS,
  VoiceCaptureController,
  holdActiveVoiceCaptures,
  listInputDevicesWithLease,
} from '../src/renderer/lib/voice/controller';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge, type VoiceBridge } from '../src/renderer/services/desktop-bridge';
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_TRANSLATION_CONFIG,
  DEFAULT_VOICE_CONFIG,
  VOICE_LOCAL_MODEL_SPEC,
  VOICE_MAX_DURATION_MS,
  VOICE_MAX_PCM_BYTES,
  VOICE_SAMPLE_RATE,
  isVoiceCaptureControlRequest,
  type ChatMessageItem,
  type ClientLocale,
  type ClientPreferences,
  type GravityDesktopBridge,
  type ManagedSessionSummary,
  type PluginsManagerSnapshot,
  type TelemetryDashboardSnapshot,
  type VoiceAppendResult,
  type VoiceCaptureRevokedEvent,
  type VoiceSegmentEvent,
  type VoiceSettledEvent,
  type VoiceStateSnapshot,
} from '../src/shared';

const ROOT = path.resolve(__dirname, '..');

function wrap(ui: React.ReactElement, locale: ClientLocale = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {ui}
    </I18nProvider>
  );
}

function makeTelemetry(): TelemetryDashboardSnapshot {
  return {
    generatedAt: '2026-11-28T00:00:00.000Z',
    pricingSource: 'reference-api-estimate',
    activeSessions: {
      'sess-a': {
        sessionId: 'sess-a',
        modelId: 'gemini-4-carbon',
        usedContextTokens: 12_000,
        maxContextTokens: 1_000_000,
        usageRatio: 0.012,
        pressureLevel: 'healthy',
        breakdown: {
          systemAndRulesTokens: 2000,
          userMessagesTokens: 3000,
          agentMessagesTokens: 4000,
          thoughtTokens: 1000,
          toolCallsTokens: 1000,
          attachmentsTokens: 1000,
        },
        attachments: [],
        compactions: [],
        currentTokensPerSecond: 40,
        averageTokensPerSecond: 35,
        peakTokensPerSecond: 50,
        averageCacheHitRate: 0.2,
        costSummary: { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
        usageSource: 'acp-reported',
        pricingSource: 'reference-api-estimate',
        updatedAt: '2026-11-28T00:00:00.000Z',
      },
    },
    today: { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
    last7Days: { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
    last30Days: { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
    hourly24h: [],
    daily7d: [],
    calendar30d: [],
    costByRange: {
      today: { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
      '7d': { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
      '30d': { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
      all: { totalInputTokens: 1000, totalOutputTokens: 500, totalCachedTokens: 0, totalTokens: 1500, totalCostUsd: 0.01, byModel: [] },
    },
    sessionModelBreakdowns: { 'sess-a': [] },
    modelBreakdownByRange: { today: [], '7d': [], '30d': [], all: [] },
    rateCards: [{ modelId: 'gemini-4-carbon', inputUsdPer1M: 1, outputUsdPer1M: 2, cachedInputUsdPer1M: 0.2 }],
  } as unknown as TelemetryDashboardSnapshot;
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-voice-1',
    profileId: 'p-default',
    title: 'Voice QA',
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
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeFakeAudioEnv(opts: { initialState?: 'running' | 'suspended'; withWorklet?: boolean; emitAudioSamples?: number } = {}) {
  const track = { readyState: 'live', stop: vi.fn(() => { track.readyState = 'ended'; }) };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const resumeSpy = vi.fn().mockImplementation(async () => { ctx.state = 'running'; });
  const closeSpy = vi.fn().mockResolvedValue(undefined);
  const muteNode = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  let workletPortMsg: ((e: MessageEvent) => void) | null = null;
  const workletPostMessage = vi.fn((msg: unknown) => {
    if (msg === 'flush' && workletPortMsg) {
      if (opts.emitAudioSamples) {
        const buf = new ArrayBuffer(opts.emitAudioSamples * 2);
        const view = new Int16Array(buf);
        view.fill(4200);
        workletPortMsg({ data: buf } as MessageEvent);
      }
      workletPortMsg({ data: 'flushed' } as MessageEvent);
    }
  });
  let scriptProcessorCb: ((ev: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  const scriptNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    set onaudioprocess(fn: typeof scriptProcessorCb) {
      scriptProcessorCb = fn;
    },
    get onaudioprocess() {
      return scriptProcessorCb;
    },
  };
  const workletNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: {
      postMessage: workletPostMessage,
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        workletPortMsg = fn;
      },
      get onmessage() {
        return workletPortMsg;
      },
    },
  };
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  const addModuleSpy = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    state: opts.initialState ?? 'running',
    sampleRate: 16_000,
    destination: { kind: 'dest' },
    resume: resumeSpy,
    close: closeSpy,
    createGain: vi.fn(() => muteNode),
    createMediaStreamSource: vi.fn(() => sourceNode),
    createScriptProcessor: vi.fn(() => scriptNode),
    ...(opts.withWorklet ? { audioWorklet: { addModule: addModuleSpy } } : {}),
  };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const origAudioWorkletNode = (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  if (opts.withWorklet) {
    Object.defineProperty(globalThis, 'AudioWorkletNode', {
      configurable: true,
      value: class {
        connect = workletNode.connect;
        disconnect = workletNode.disconnect;
        port = workletNode.port;
      },
    });
  }
  return {
    track,
    stream,
    ctx: ctx as unknown as AudioContext,
    resumeSpy,
    closeSpy,
    muteNode,
    sourceNode,
    workletNode,
    workletPostMessage,
    addModuleSpy,
    getUserMedia,
    emitWorkletChunk(buf: ArrayBuffer) {
      workletPortMsg?.({ data: buf } as MessageEvent);
    },
    emitScriptAudio(samples: Float32Array) {
      scriptProcessorCb?.({ inputBuffer: { getChannelData: () => samples } });
    },
    restore() {
      Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: origAudioWorkletNode });
    },
  };
}

function makeVoiceBridgeMock(overrides: Partial<GravityDesktopBridge> = {}) {
  const segListeners = new Set<(e: VoiceSegmentEvent) => void>();
  const settledListeners = new Set<(e: VoiceSettledEvent) => void>();
  const revokedListeners = new Set<(e: VoiceCaptureRevokedEvent) => void>();
  const base = getFallbackDesktopBridge();
  const bridge = {
    ...base,
    onVoiceSegment: (fn: (e: VoiceSegmentEvent) => void) => {
      segListeners.add(fn);
      return () => segListeners.delete(fn);
    },
    onVoiceSettled: (fn: (e: VoiceSettledEvent) => void) => {
      settledListeners.add(fn);
      return () => settledListeners.delete(fn);
    },
    onVoiceCaptureRevoked: (fn: (e: VoiceCaptureRevokedEvent) => void) => {
      revokedListeners.add(fn);
      return () => revokedListeners.delete(fn);
    },
    ...overrides,
  } as GravityDesktopBridge & VoiceBridge;
  return {
    bridge,
    emitSegment: (e: VoiceSegmentEvent) => segListeners.forEach((fn) => fn(e)),
    emitSettled: (e: VoiceSettledEvent) => settledListeners.forEach((fn) => fn(e)),
    emitRevoked: (e: VoiceCaptureRevokedEvent) => revokedListeners.forEach((fn) => fn(e)),
  };
}

function makeVoiceState(overrides: Partial<VoiceStateSnapshot> = {}): VoiceStateSnapshot {
  return {
    config: structuredClone(DEFAULT_VOICE_CONFIG),
    model: {
      status: 'ready',
      modelId: VOICE_LOCAL_MODEL_SPEC.id,
      fileName: VOICE_LOCAL_MODEL_SPEC.fileName,
      source: 'bundled',
      expectedBytes: VOICE_LOCAL_MODEL_SPEC.sizeBytes,
      sha256Verified: true,
    },
    external: { ready: false, encryptionAvailable: true },
    activeCapture: null,
    heldCapture: null,
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetFallbackDesktopBridge();
  window.gravityDesktop = { ...getFallbackDesktopBridge() };
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  vi.restoreAllMocks();
});

/* ============================================================================
 * PART A · 语音听写纯逻辑、状态机、跨端时序与设置页（TC-VOICE-01 .. TC-VOICE-31）
 * ========================================================================== */

describe('Gravity v0.3.6 语音听写全链路与设置页 (TC-VOICE-01..31)', () => {
  it('TC-VOICE-01..03：Pcm16Chunker 48kHz→16kHz 降采样、定长 16000B 小端 PCM16 切片与 flush 尾片', () => {
    const chunks: ArrayBuffer[] = [];
    const chunker = new Pcm16Chunker(48_000, (buf) => chunks.push(buf));
    // 0.75 秒 48kHz = 36,000 samples → 16kHz 下为 12,000 samples = 1 满片 (8,000) + 尾片 (4,000)
    const input = new Float32Array(36_000);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5;
    chunker.push(input);
    expect(TARGET_RATE).toBe(16_000);
    expect(CHUNK_SAMPLES).toBe(8_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].byteLength).toBe(16_000);
    chunker.flush();
    expect(chunks).toHaveLength(2);
    expect(chunks[1].byteLength).toBe(8_000);
    // 验证非全零小端 Int16 编码
    const view = new Int16Array(chunks[0]);
    expect(Math.max(...Array.from(view, (n) => Math.abs(n)))).toBeGreaterThan(1000);
  });

  it('TC-VOICE-04..05：dictation-ranges 受控插入段、手动编辑保护、Esc 精准回滚未编辑段不误删手打同文、sealCapture', () => {
    let state: DictationState = { text: '你好世界', ranges: [] };
    // 手打相同文案后，在末尾插入两段语音
    ({ state } = insertDictation(state, { segId: 's1', captureId: 'c1', text: '你好世界', at: state.text.length, locale: 'zh-CN' }));
    ({ state } = insertDictation(state, { segId: 's2', captureId: 'c1', text: '测试语音', at: state.text.length, locale: 'zh-CN' }));
    expect(state.text).toBe('你好世界你好世界测试语音');
    // 用户编辑了第 2 段（「测试语音」→「测试已改」）
    state = applyUserEdit(state, '你好世界你好世界测试已改');
    expect(state.ranges.find((r) => r.segId === 's1')?.edited).toBeFalsy();
    expect(state.ranges.find((r) => r.segId === 's2')?.edited).toBe(true);
    // Esc 回滚：只撤销未编辑的 s1，绝不误删开头手打的「你好世界」，也保留用户编辑过的「测试已改」
    const rolled = rollbackCapture(state, 'c1');
    expect(rolled.state.text).toBe('你好世界测试已改');
    expect(sealCapture(state, 'c1').ranges).toEqual([]);
  });

  it('TC-VOICE-09..12 & TC-VOICE-23..24（QA1-FE-01/02/15）：AudioContext.resume + 静音输出图、背压≤2、stop 严格排水顺序、revokeOne 双向零麦克风泄漏', async () => {
    // 1) QA1-FE-02 + QA1-FE-15：验证 AudioContext.resume()、GainNode(0) 连接、MAX_INFLIGHT=2 背压与 stop() 严格顺序
    const order: string[] = [];
    const pendingAppends: Array<() => void> = [];
    const env = makeFakeAudioEnv({ initialState: 'suspended', withWorklet: true, emitAudioSamples: 4000 });
    try {
      const { bridge, emitSettled } = makeVoiceBridgeMock({
        voiceArmCapture: vi.fn(async (input) => {
          if (isVoiceCaptureControlRequest(input)) {
            order.push(`arm:${input.op}`);
            return {
              captureId: input.captureId,
              owner: { profileId: 'p1', sessionId: 's1' },
              epoch: 0,
              purpose: 'dictation' as const,
              engine: 'external-api' as const,
              sampleRate: VOICE_SAMPLE_RATE,
              maxDurationMs: VOICE_MAX_DURATION_MS,
              maxPcmBytes: VOICE_MAX_PCM_BYTES,
              state: (input.op === 'media-ready' ? 'capturing' : 'released') as 'capturing' | 'released',
            };
          }
          order.push('arm:start');
          return {
            captureId: 'cap-order',
            owner: input.owner,
            epoch: 0,
            purpose: 'dictation' as const,
            engine: 'external-api' as const,
            sampleRate: VOICE_SAMPLE_RATE,
            maxDurationMs: VOICE_MAX_DURATION_MS,
            maxPcmBytes: VOICE_MAX_PCM_BYTES,
            state: 'armed' as const,
          };
        }),
        voiceAppend: vi.fn(async (input): Promise<VoiceAppendResult> => {
          order.push(`append-start:${input.seq}`);
          await new Promise<void>((resolve) => pendingAppends.push(resolve));
          order.push(`append-done:${input.seq}`);
          return {
            captureId: input.captureId,
            accepted: true,
            seq: input.seq,
            acceptedBytes: input.seq * input.pcm16.byteLength,
            remainingBytes: VOICE_MAX_PCM_BYTES,
          };
        }),
        voiceFinish: vi.fn(async (input) => {
          order.push(`finish:${input.finalChunkSeq}`);
          return { captureId: input.captureId, status: 'finishing' as const, acceptedSeq: input.finalChunkSeq ?? 0, acceptedBytes: 100 };
        }),
      });

      const backpressures: boolean[] = [];
      const controller = new VoiceCaptureController(
        bridge,
        {
          onPhase: (_p, info) => {
            if (info.backpressure) backpressures.push(true);
          },
        },
        { getUserMedia: env.getUserMedia, createAudioContext: () => env.ctx, workletUrl: '/assets/pcm-worklet.js' }
      );

      const started = await controller.start({ owner: { profileId: 'p1', sessionId: 's1' } });
      expect(started).toBe(true);
      expect(controller.captureMode).toBe('worklet');
      expect(env.resumeSpy).toHaveBeenCalledTimes(1);
      expect(env.workletNode.connect).toHaveBeenCalledWith(env.muteNode);
      expect(env.muteNode.gain.value).toBe(0);
      expect(env.muteNode.connect).toHaveBeenCalledWith(env.ctx.destination);
      expect(order.slice(0, 2)).toEqual(['arm:start', 'arm:media-ready']);

      // 连续推 3 片：仅前 2 片（MAX_INFLIGHT_APPENDS）在途，第 3 片排队并触发背压
      expect(MAX_INFLIGHT_APPENDS).toBe(2);
      env.emitWorkletChunk(new ArrayBuffer(16_000));
      env.emitWorkletChunk(new ArrayBuffer(16_000));
      env.emitWorkletChunk(new ArrayBuffer(16_000));
      expect(pendingAppends).toHaveLength(2);
      expect(backpressures.length).toBeGreaterThan(0);

      // 调用 stop()：必须等待所有在途 + 排队 + flushTail 的尾片全部 append-done，之后才 await release-media，最后才 voiceFinish
      const stopPromise = controller.stop();
      await act(async () => { await Promise.resolve(); });
      expect(order).not.toContain('arm:release-media');
      expect(env.track.stop).toHaveBeenCalledTimes(1);

      while (pendingAppends.length > 0) {
        pendingAppends.shift()!();
        await Promise.resolve();
        await Promise.resolve();
      }
      await stopPromise;

      const lastAppendDone = Math.max(...order.map((e, i) => (e.startsWith('append-done:') ? i : -1)));
      const releaseIdx = order.indexOf('arm:release-media');
      const finishIdx = order.findIndex((e) => e.startsWith('finish:'));
      expect(lastAppendDone).toBeGreaterThan(-1);
      expect(releaseIdx).toBeGreaterThan(lastAppendDone);
      expect(finishIdx).toBeGreaterThan(releaseIdx);

      // DEC-03 外部引擎 0 segment + finalSeq: 0 正常结案
      emitSettled({
        owner: { profileId: 'p1', sessionId: 's1' },
        epoch: 0,
        captureId: 'cap-order',
        finalSeq: 0,
        text: '外部转写全文',
        durationMs: 2000,
        engine: 'external-api',
        outcome: 'completed',
      });
      expect(controller.phase).toBe('idle');
      controller.dispose();
    } finally {
      env.restore();
    }

    // 2) TC-VOICE-23（QA1-FE-01 / DEC-06）：两种事件顺序下 revokeOne 均 0 麦克风泄漏且上报 revoked
    for (const sequence of ['settled-first', 'revoked-first'] as const) {
      const env2 = makeFakeAudioEnv({ withWorklet: false });
      const notices: string[] = [];
      const onSettled = vi.fn();
      const onAborted = vi.fn();
      const { bridge, emitSettled, emitRevoked } = makeVoiceBridgeMock({
        voiceArmCapture: vi.fn(async (input) => ({
          captureId: isVoiceCaptureControlRequest(input) ? input.captureId : `cap-${sequence}`,
          owner: { profileId: 'p1', sessionId: 's1' },
          epoch: 0,
          purpose: 'dictation' as const,
          engine: 'local' as const,
          sampleRate: VOICE_SAMPLE_RATE,
          maxDurationMs: VOICE_MAX_DURATION_MS,
          maxPcmBytes: VOICE_MAX_PCM_BYTES,
          state: (isVoiceCaptureControlRequest(input) ? 'capturing' : 'armed') as 'capturing' | 'armed',
        })),
      });
      const ctrl = new VoiceCaptureController(
        bridge,
        {
          onNotice: (k) => notices.push(k),
          onSettled,
          onAborted,
        },
        { getUserMedia: env2.getUserMedia, createAudioContext: () => env2.ctx }
      );
      await ctrl.start({ owner: { profileId: 'p1', sessionId: 's1' } });
      expect(ctrl.captureMode).toBe('script-processor');
      expect(env2.track.readyState).toBe('live');

      const settledEv: VoiceSettledEvent = {
        owner: { profileId: 'p1', sessionId: 's1' },
        epoch: 0,
        captureId: `cap-${sequence}`,
        finalSeq: 0,
        text: '',
        durationMs: 300,
        engine: 'local',
        outcome: 'aborted',
      };
      const revokedEv: VoiceCaptureRevokedEvent = {
        owner: { profileId: 'p1', sessionId: 's1' },
        epoch: 0,
        captureId: `cap-${sequence}`,
        reason: 'permission-revoked',
        message: '采音权限已收回',
      };
      if (sequence === 'settled-first') {
        emitSettled(settledEv);
        emitRevoked(revokedEv);
      } else {
        emitRevoked(revokedEv);
        emitSettled(settledEv);
      }
      expect(env2.track.stop).toHaveBeenCalled();
      expect(env2.track.readyState).toBe('ended');
      expect(env2.closeSpy).toHaveBeenCalled();
      expect(ctrl.phase).toBe('idle');
      expect(notices).toContain('revoked');
      expect(onSettled).not.toHaveBeenCalled();
      expect(onAborted).toHaveBeenCalledWith(`cap-${sequence}`);
      ctrl.dispose();
    }

    // 3) TC-VOICE-14：切入设置页时外部引擎 hold: true（0 finish / 0 HTTP），本地引擎正常停录
    const envExt = makeFakeAudioEnv({ withWorklet: false });
    const armSpy = vi.fn(async (input) => ({
      captureId: isVoiceCaptureControlRequest(input) ? input.captureId : 'cap-hold',
      owner: { profileId: 'p1', sessionId: 's1' },
      epoch: 0,
      purpose: 'dictation' as const,
      engine: 'external-api' as const,
      sampleRate: VOICE_SAMPLE_RATE,
      maxDurationMs: VOICE_MAX_DURATION_MS,
      maxPcmBytes: VOICE_MAX_PCM_BYTES,
      state: 'capturing' as const,
    }));
    const finishSpy = vi.fn();
    const { bridge: holdBridge } = makeVoiceBridgeMock({ voiceArmCapture: armSpy, voiceFinish: finishSpy });
    const holdCtrl = new VoiceCaptureController(holdBridge, {}, { getUserMedia: envExt.getUserMedia, createAudioContext: () => envExt.ctx });
    try {
      await holdCtrl.start({ owner: { profileId: 'p1', sessionId: 's1' } });
      holdActiveVoiceCaptures();
      await Promise.resolve();
      expect(armSpy).toHaveBeenCalledWith({ op: 'release-media', captureId: 'cap-hold', hold: true });
      expect(finishSpy).not.toHaveBeenCalled();
      expect(envExt.track.readyState).toBe('ended');
    } finally {
      holdCtrl.dispose();
    }
  });

  it('TC-VOICE-06..08 & TC-VOICE-25..27 & TC-VOICE-31：IME 分段缓冲、缺失序号补齐 0 重复、点按钮后 Esc 不停 AI、流式 /voice 与 /record 可用', async () => {
    const env = makeFakeAudioEnv({ withWorklet: false });
    const origMediaDevices = navigator.mediaDevices;
    const origAudioCtx = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: env.getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: vi.fn(() => env.ctx) });

    try {
      let capSeq = 0;
      const { bridge, emitSegment, emitSettled } = makeVoiceBridgeMock({
        voiceArmCapture: vi.fn(async (input) => {
          if (isVoiceCaptureControlRequest(input)) {
            return {
              captureId: input.captureId,
              owner: { profileId: 'p-default', sessionId: 'sess-voice-1' },
              epoch: 0,
              purpose: 'dictation' as const,
              engine: 'local' as const,
              sampleRate: VOICE_SAMPLE_RATE,
              maxDurationMs: VOICE_MAX_DURATION_MS,
              maxPcmBytes: VOICE_MAX_PCM_BYTES,
              state: (input.op === 'media-ready' ? 'capturing' : 'released') as 'capturing' | 'released',
            };
          }
          const cid = `cap-ui-${++capSeq}`;
          return {
            captureId: cid,
            owner: input.owner,
            epoch: 0,
            purpose: 'dictation' as const,
            engine: 'local' as const,
            sampleRate: VOICE_SAMPLE_RATE,
            maxDurationMs: VOICE_MAX_DURATION_MS,
            maxPcmBytes: VOICE_MAX_PCM_BYTES,
            state: 'armed' as const,
          };
        }),
        voiceFinish: vi.fn(async (input) => ({ captureId: input.captureId, status: 'finishing' as const, acceptedSeq: input.finalChunkSeq ?? 0, acceptedBytes: 0 })),
        voiceAbort: vi.fn(async (input) => ({ captureId: input.captureId, aborted: true })),
      });
      window.gravityDesktop = bridge;

      const onSend = vi.fn().mockResolvedValue(undefined);
      const onCancel = vi.fn().mockResolvedValue(undefined);
      const session = makeSession({ sessionId: 'sess-voice-1', status: 'streaming' });
      const drafts = new Map();

      render(
        wrap(
          <ComposerDrafts.Provider value={drafts}>
            <SessionPane
              slotIndex={0}
              layoutMode="single"
              isFocused
              session={session}
              availableSessions={[session]}
              availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
              messages={[]}
              pendingApprovals={[]}
              approvalConfig={DEFAULT_APPROVAL_CONFIG}
              defaultThoughtTrack="zh"
              telemetryDashboard={makeTelemetry()}
              scrollMemoryRef={{ current: {} }}
              canTriggerDemoApproval={false}
              appIcon="gravity-claude-dark"
              onFocusPane={() => {}}
              onBindSlotSession={() => {}}
              onOpenNewSession={() => {}}
              onSendPrompt={onSend}
              onCancelPrompt={onCancel}
              onCompactContext={async () => {}}
              onSetSessionMode={async () => {}}
              onSetSessionEffort={async () => {}}
              onSetSessionModel={async () => {}}
              onQueryWorkspaceFiles={async () => []}
              onSubmitApproval={async () => {}}
              onCycleApprovalMode={async () => {}}
              onOpenApprovalSettings={() => {}}
              onOpenSwarmInspector={() => {}}
              onOpenContextInspector={() => {}}
              onInspectDiffFile={() => {}}
              onTriggerDemoApproval={() => {}}
            />
          </ComposerDrafts.Provider>
        )
      );

      const input = screen.getByTestId('composer-input-sess-voice-1') as HTMLTextAreaElement;
      const micBtn = screen.getByTestId('voice-toggle-sess-voice-1');

      // 1) TC-VOICE-27（QA1-FE-08）：AI 流式生成中，鼠标点击麦克风按钮（焦点停在按钮上）后按 Esc -> 仅中止语音，绝不调用 onCancel
      micBtn.focus();
      await act(async () => {
        fireEvent.click(micBtn);
      });
      await waitFor(() => expect(micBtn.getAttribute('aria-pressed')).toBe('true'));
      expect(document.activeElement).toBe(micBtn);

      await act(async () => {
        fireEvent.keyDown(micBtn, { key: 'Escape' });
      });
      await waitFor(() => expect(micBtn.getAttribute('aria-pressed')).toBe('false'));
      expect(onCancel).not.toHaveBeenCalled();

      // 2) TC-VOICE-31（QA1-FE-18）：AI 流式生成中输入 /voice 与 /record 按 Enter 可启动与停录语音，0 发送
      fireEvent.change(input, { target: { value: '/voice' } });
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      await waitFor(() => expect(micBtn.getAttribute('aria-pressed')).toBe('true'));
      expect(input.value).toBe('');
      expect(onSend).not.toHaveBeenCalled();

      // 3) TC-VOICE-26（QA1-FE-07）+ TC-VOICE-25（QA1-FE-03）：
      // 先手打前缀，随后在中文 IME 组合态期间推送缺失序号的分段（seq=1, seq=3 缺 seq=2）与 settled(finalSeq=3)
      fireEvent.change(input, { target: { value: '前缀 ' } });
      fireEvent.compositionStart(input);
      await act(async () => {
        emitSegment({ owner: { profileId: 'p-default', sessionId: 'sess-voice-1' }, epoch: 0, captureId: 'cap-ui-2', seq: 1, text: '第一段', isFinal: false });
        emitSegment({ owner: { profileId: 'p-default', sessionId: 'sess-voice-1' }, epoch: 0, captureId: 'cap-ui-2', seq: 3, text: '第三段', isFinal: false });
      });
      // 组合态期间 textarea.value 绝不被语音改写
      expect(input.value).toBe('前缀 ');

      // 结束组合态 -> 刷入缓冲分段，再下发 settled(finalSeq=3, full text) 触发 missing === true 补齐 -> 0 重复！
      await act(async () => {
        fireEvent.compositionEnd(input);
        await Promise.resolve();
      });
      expect(input.value).toBe('前缀 第一段第三段');

      await act(async () => {
        emitSettled({
          owner: { profileId: 'p-default', sessionId: 'sess-voice-1' },
          epoch: 0,
          captureId: 'cap-ui-2',
          finalSeq: 3,
          text: '第一段第二段第三段',
          durationMs: 1800,
          engine: 'local',
          outcome: 'completed',
        });
        await Promise.resolve();
      });
      expect(input.value).toBe('前缀 第一段第二段第三段');
      expect(onSend).not.toHaveBeenCalled();

      // 同样验证 /record 在流式态也能触发
      fireEvent.change(input, { target: { value: '/record' } });
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      await waitFor(() => expect(micBtn.getAttribute('aria-pressed')).toBe('true'));
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: origMediaDevices });
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: origAudioCtx });
    }
  });

  it('TC-VOICE-19..22 & TC-VOICE-28..29（QA1-FE-09/10 / DEC-05）：VoiceSettingsCard 静息 0 权限、3s 试录正确反馈 0 voiceFinish、测通与轮询不冲表单、清空单价与加密/冷却警示', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const env = makeFakeAudioEnv({ withWorklet: false });
    const enumerateDevices = vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId: 'mic-usb', label: 'USB Mic' }]);
    const origMediaDevices = navigator.mediaDevices;
    const origAudioCtx = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: env.getUserMedia, enumerateDevices },
    });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: vi.fn(() => env.ctx) });

    try {
      let currentState = makeVoiceState({
        config: {
          ...structuredClone(DEFAULT_VOICE_CONFIG),
          externalProvider: {
            enabled: false,
            timeoutMs: 25_000,
            provider: 'openai-compatible',
            endpoint: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini-transcribe',
            hasApiKey: true,
            ratePerMinuteUsd: 0.006,
          },
        },
        model: {
          status: 'downloading',
          modelId: VOICE_LOCAL_MODEL_SPEC.id,
          fileName: VOICE_LOCAL_MODEL_SPEC.fileName,
          expectedBytes: VOICE_LOCAL_MODEL_SPEC.sizeBytes,
          progressPercent: 40,
          sha256Verified: false,
        },
        external: {
          ready: false,
          encryptionAvailable: false,
          cooldownUntil: new Date(Date.now() + 180_000).toISOString(),
          cooldownKind: 'rate_limit_429',
        },
      });

      const voiceFinishSpy = vi.fn();
      const updateVoiceConfigSpy = vi.fn(async (patch) => {
        const rate = patch.externalProvider?.ratePerMinuteUsd;
        currentState = {
          ...currentState,
          config: {
            ...currentState.config,
            ...(patch.engine ? { engine: patch.engine } : {}),
            ...(patch.preferredDeviceId !== undefined ? { preferredDeviceId: patch.preferredDeviceId ?? undefined } : {}),
            ...(patch.preferredDeviceLabel !== undefined ? { preferredDeviceLabel: patch.preferredDeviceLabel ?? undefined } : {}),
            externalProvider: {
              ...currentState.config.externalProvider,
              ...(patch.externalProvider ?? {}),
              ratePerMinuteUsd: rate === null ? undefined : rate ?? currentState.config.externalProvider.ratePerMinuteUsd,
              hasApiKey: Boolean(patch.externalProvider?.apiKey || currentState.config.externalProvider.hasApiKey),
            },
          },
        };
        return structuredClone(currentState);
      });
      const testVoiceConnectionSpy = vi.fn().mockResolvedValue({ ok: true, latencyMs: 88 });
      const discoverVoiceModelsSpy = vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        endpoint: 'https://custom.voice.example/v1',
        fetchedAt: '2026-11-28T00:00:00.000Z',
        models: [{ id: 'whisper-large-v3', displayName: 'Whisper v3', supportsThinking: false, supportedThinkingLevels: [] }],
      });
      const { bridge } = makeVoiceBridgeMock({
        getVoiceState: vi.fn(async () => structuredClone(currentState)),
        updateVoiceConfig: updateVoiceConfigSpy,
        testVoiceConnection: testVoiceConnectionSpy,
        discoverVoiceModels: discoverVoiceModelsSpy,
        voiceFinish: voiceFinishSpy,
        voiceArmCapture: vi.fn(async (input) => ({
          captureId: isVoiceCaptureControlRequest(input) ? input.captureId : 'cap-mictest',
          owner: { profileId: 'p1' },
          epoch: 0,
          purpose: 'mic-test' as const,
          engine: 'local' as const,
          sampleRate: VOICE_SAMPLE_RATE,
          maxDurationMs: 3000,
          maxPcmBytes: 96_000,
          state: (isVoiceCaptureControlRequest(input) ? (input.op === 'media-ready' ? 'capturing' : 'released') : 'armed') as 'capturing' | 'released' | 'armed',
        })),
        voiceAppend: vi.fn(async (input) => ({
          captureId: input.captureId,
          accepted: true,
          seq: input.seq,
          acceptedBytes: input.pcm16.byteLength,
          remainingBytes: 80_000,
        })),
      });
      window.gravityDesktop = bridge;

      const zeroRange = { callCount: 0, totalDurationMs: 0, knownCostUsd: 0, hasUnknownCost: false };
      render(
        wrap(
          <VoiceSettingsCard
            profileId="p1"
            telemetry={{
              cumulativeCalls: 2,
              completedCalls: 2,
              errorCalls: 0,
              totalDurationMs: 90_000,
              knownCostUsd: 0.009,
              hasUnknownCost: true,
              byRange: { today: zeroRange, '7d': zeroRange, '30d': zeroRange },
              providers: [],
              updatedAt: '2026-11-28T00:00:00Z',
            }}
          />
        )
      );

      // 1) 静息态 0 权限调用；正确渲染加密不可用与 429 冷却警示
      await screen.findByTestId('voice-encryption-unavailable');
      expect(screen.getByTestId('voice-cooldown-banner').textContent).toContain('429');
      expect(env.getUserMedia).not.toHaveBeenCalled();
      expect(enumerateDevices).not.toHaveBeenCalled();

      // 2) 编辑外部语音表单后触发 1s 下载轮询 & 点击「测试连接」-> 均绝不覆盖未保存草稿
      const endpointInput = screen.getByTestId('voice-ext-endpoint') as HTMLInputElement;
      const keyInput = screen.getByTestId('voice-ext-key') as HTMLInputElement;
      const rateInput = screen.getByTestId('voice-ext-rate') as HTMLInputElement;
      fireEvent.change(endpointInput, { target: { value: 'https://custom.voice.example/v1' } });
      fireEvent.change(keyInput, { target: { value: 'sk-voice-secret-123' } });
      fireEvent.change(rateInput, { target: { value: '' } }); // 清空单价

      // 触发 1s 下载进度轮询
      await act(async () => {
        vi.advanceTimersByTime(1100);
        await Promise.resolve();
      });
      expect(endpointInput.value).toBe('https://custom.voice.example/v1');
      expect(keyInput.value).toBe('sk-voice-secret-123');
      expect(rateInput.value).toBe('');

      // 点「测试连接」成功 -> 不冲刷表单
      await act(async () => {
        fireEvent.click(screen.getByTestId('voice-ext-test'));
        await Promise.resolve();
      });
      expect(testVoiceConnectionSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('voice-ext-status').textContent).toContain('88');
      expect(endpointInput.value).toBe('https://custom.voice.example/v1');
      expect(keyInput.value).toBe('sk-voice-secret-123');

      // 发现模型后 <select> 保留 data-testid="voice-ext-model"
      await act(async () => {
        fireEvent.click(screen.getByTestId('voice-ext-discover'));
        await Promise.resolve();
      });
      expect(screen.getByTestId('voice-ext-model').tagName).toBe('SELECT');

      // 保存外部配置 -> 清空单价显式传 null，且保存成功后 DOM 中的明文 apiKey 清零
      await act(async () => {
        fireEvent.click(screen.getByTestId('voice-ext-save'));
        await Promise.resolve();
      });
      expect(updateVoiceConfigSpy).toHaveBeenLastCalledWith({
        externalProvider: expect.objectContaining({
          endpoint: 'https://custom.voice.example/v1',
          ratePerMinuteUsd: null,
        }),
      });
      expect((screen.getByTestId('voice-ext-key') as HTMLInputElement).value).toBe('');

      // 3) 显式选择设备经租约枚举
      await act(async () => {
        fireEvent.click(screen.getByTestId('voice-pick-device'));
        await Promise.resolve();
      });
      expect(enumerateDevices).toHaveBeenCalledTimes(1);
      expect(await screen.findByTestId('voice-device-select')).toBeTruthy();

      // 4) TC-VOICE-29（DEC-05 方案 A）：3 秒试录有声输入 -> 0 voiceFinish、提示「麦克风工作正常」而非「未识别到语音」
      const testPromise = act(async () => {
        fireEvent.click(screen.getByTestId('voice-mic-test'));
        await Promise.resolve();
        await Promise.resolve();
      });
      await testPromise;
      // 注入 0.5 秒非零振幅音频样本并推进 3s cap timer
      const tone = new Float32Array(8000).fill(0.4);
      env.emitScriptAudio(tone);
      await act(async () => {
        vi.advanceTimersByTime(3100);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(voiceFinishSpy).not.toHaveBeenCalled();
      const micResult = (await screen.findByTestId('voice-mic-test-result')).textContent || '';
      expect(micResult).toContain('麦克风工作正常');
      expect(micResult).not.toContain('未识别到语音');
      expect(env.track.readyState).toBe('ended');

      // listInputDevicesWithLease 辅助函数验证
      const listed = await listInputDevicesWithLease(bridge, { profileId: 'p1' }, { getUserMedia: env.getUserMedia });
      expect(listed[0]?.label).toBe('USB Mic');
    } finally {
      vi.useRealTimers();
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: origMediaDevices });
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: origAudioCtx });
    }
  });

  it('TC-VOICE-15 & TC-VOICE-30（QA1-FE-11）：完整 <App /> 切换 Profile 后切回原 Profile，原会话听写草稿完好保留且 0 串号', async () => {
    const base = getFallbackDesktopBridge();
    const bootBase = await base.getBootstrap();
    let activeProfile = 'default';
    const profiles = [
      { profileId: 'default', name: 'Profile A', isDefault: true, isolatedAppDataDir: 'C:\\qa\\a', createdAt: '2026-11-28T00:00:00Z', lastActivatedAt: '2026-11-28T00:00:00Z' },
      { profileId: 'profile-b', name: 'Profile B', isDefault: false, isolatedAppDataDir: 'C:\\qa\\b', createdAt: '2026-11-28T00:00:00Z', lastActivatedAt: '2026-11-28T00:00:00Z' },
    ];
    const sessA = { ...bootBase.sessions[0], sessionId: 'sess-prof-a', profileId: 'default', title: 'Session A', status: 'idle' as const };
    const sessB = { ...bootBase.sessions[0], sessionId: 'sess-prof-b', profileId: 'profile-b', title: 'Session B', status: 'idle' as const };

    const accountsSnapshot = (pid: string) => ({
      ...bootBase.accounts,
      activeProfileId: pid,
      profiles,
    });
    const { bridge, emitSegment, emitSettled } = makeVoiceBridgeMock({
      getBootstrap: vi.fn(async () => ({
        ...bootBase,
        preferences: { ...bootBase.preferences, activeProfileId: activeProfile },
        accounts: accountsSnapshot(activeProfile),
        sessions: activeProfile === 'default' ? [sessA] : [sessB],
        layout: {
          ...bootBase.layout,
          layoutMode: 'single' as const,
          activePrimarySessionId: activeProfile === 'default' ? 'sess-prof-a' : 'sess-prof-b',
          splitSecondarySessionId: null,
          openTabSessionIds: [activeProfile === 'default' ? 'sess-prof-a' : 'sess-prof-b'],
          rightInspectorCollapsed: true,
          activeInspectorTab: 'plan' as const,
          leftSidebarCollapsed: false,
        },
        pendingApprovals: [],
      })),
      switchAccountProfile: vi.fn(async (id: string) => {
        activeProfile = id;
        return accountsSnapshot(activeProfile);
      }),
      getSessionMessagePage: vi.fn(async () => ({
        earlierCount: 0,
        earlierUserCount: 0,
        earlierVisibleCount: 0,
        precedingOriginId: null,
        messages: [],
      })),
      voiceArmCapture: vi.fn(async (input) => ({
        captureId: isVoiceCaptureControlRequest(input) ? input.captureId : 'cap-prof-a',
        owner: { profileId: 'default', sessionId: 'sess-prof-a' },
        epoch: 0,
        purpose: 'dictation' as const,
        engine: 'local' as const,
        sampleRate: VOICE_SAMPLE_RATE,
        maxDurationMs: VOICE_MAX_DURATION_MS,
        maxPcmBytes: VOICE_MAX_PCM_BYTES,
        state: (isVoiceCaptureControlRequest(input) ? 'capturing' : 'armed') as 'capturing' | 'armed',
      })),
    });

    const env = makeFakeAudioEnv({ withWorklet: false });
    const origMediaDevices = navigator.mediaDevices;
    const origAudioCtx = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: env.getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: vi.fn(() => env.ctx) });
    window.gravityDesktop = bridge;

    try {
      render(<App />);
      const inputA = (await screen.findByTestId('composer-input-sess-prof-a')) as HTMLTextAreaElement;
      // 在 Profile A 听写并落盘一段文本
      await act(async () => {
        fireEvent.click(screen.getByTestId('voice-toggle-sess-prof-a'));
      });
      await waitFor(() => expect(screen.getByTestId('voice-toggle-sess-prof-a').getAttribute('aria-pressed')).toBe('true'));
      await act(async () => {
        emitSegment({ owner: { profileId: 'default', sessionId: 'sess-prof-a' }, epoch: 0, captureId: 'cap-prof-a', seq: 1, text: '账号甲的听写草稿', isFinal: true });
        emitSettled({ owner: { profileId: 'default', sessionId: 'sess-prof-a' }, epoch: 0, captureId: 'cap-prof-a', finalSeq: 1, text: '账号甲的听写草稿', durationMs: 900, engine: 'local', outcome: 'completed' });
      });
      expect(inputA.value).toBe('账号甲的听写草稿');

      // 打开账号设置切到 Profile B -> Profile B 不串台
      fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
      fireEvent.click(await screen.findByTestId('settings-tab-accounts'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-profile-profile-b'));
      });
      const inputB = (await screen.findByTestId('composer-input-sess-prof-b')) as HTMLTextAreaElement;
      expect(inputB.value).toBe('');

      // 再切回 Profile A -> 原会话输入框仍保留「账号甲的听写草稿」
      const accountsTab = screen.queryByTestId('settings-tab-accounts') ?? (fireEvent.click(screen.getByTestId('open-theme-modal-btn')), await screen.findByTestId('settings-tab-accounts'));
      fireEvent.click(accountsTab);
      await act(async () => {
        fireEvent.click(screen.getByTestId('switch-profile-default'));
      });
      const restoredA = (await screen.findByTestId('composer-input-sess-prof-a')) as HTMLTextAreaElement;
      expect(restoredA.value).toBe('账号甲的听写草稿');
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: origMediaDevices });
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: origAudioCtx });
    }
  });
});

/* ============================================================================
 * PART B · UI 缺陷清零与交互守卫（TC-UI-01 .. TC-UI-17）
 * ========================================================================== */

describe('Gravity v0.3.6 UI 缺陷清零与交互细节 (TC-UI-01..17)', () => {
  it('TC-UI-01..03：CSS 源码总量/Token 守卫（U1 无自引用、U2 0 --pal-*、base.css reduced-motion 含 .voice-dot、340/460/560/720 断点）', () => {
    const stylesDir = path.join(ROOT, 'src/renderer/styles');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.css')) files.push(full);
      }
    };
    walk(stylesDir);
    let totalBytes = 0;
    let allCss = '';
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      totalBytes += Buffer.byteLength(text, 'utf8');
      allCss += `\n${text}`;
    }
    expect(totalBytes).toBeLessThanOrEqual(235_520); // <= 230 KiB
    expect(allCss).not.toMatch(/--pal-/);
    const composerCss = fs.readFileSync(path.join(stylesDir, 'components/composer.css'), 'utf8');
    expect(composerCss).not.toMatch(/--turbo:\s*var\(--turbo\)/);
    for (const bp of ['340px', '460px', '560px', '720px']) {
      expect(composerCss).toContain(`max-width: ${bp}`);
    }
    const baseCss = fs.readFileSync(path.join(stylesDir, 'base.css'), 'utf8');
    expect(baseCss).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.voice-dot/);
  });

  it('TC-UI-04 & TC-UI-12（QA1-FE-06 U5）：Split-2 窗格 B 展开 .popover 时，聚焦窗格 A 按 Esc 正常停止 A；窗格 A 自开菜单则不误停', async () => {
    const cancelA = vi.fn().mockResolvedValue(undefined);
    const cancelB = vi.fn().mockResolvedValue(undefined);
    const sessA = makeSession({ sessionId: 'sess-u5-a', status: 'streaming' });
    const sessB = makeSession({ sessionId: 'sess-u5-b', status: 'idle' });
    const sharedProps = {
      layoutMode: 'split-2' as const,
      availableSessions: [sessA, sessB],
      availableModels: [{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }],
      messages: [] as ChatMessageItem[],
      pendingApprovals: [],
      approvalConfig: DEFAULT_APPROVAL_CONFIG,
      defaultThoughtTrack: 'zh' as const,
      telemetryDashboard: makeTelemetry(),
      scrollMemoryRef: { current: {} },
      canTriggerDemoApproval: false,
      appIcon: 'gravity-claude-dark' as const,
      onFocusPane: () => {},
      onBindSlotSession: () => {},
      onOpenNewSession: () => {},
      onSendPrompt: async () => {},
      onCompactContext: async () => {},
      onSetSessionMode: async () => {},
      onSetSessionEffort: async () => {},
      onSetSessionModel: async () => {},
      onQueryWorkspaceFiles: async () => [],
      onSubmitApproval: async () => {},
      onCycleApprovalMode: async () => {},
      onOpenApprovalSettings: () => {},
      onOpenSwarmInspector: () => {},
      onOpenContextInspector: () => {},
      onInspectDiffFile: () => {},
      onTriggerDemoApproval: () => {},
    };

    render(
      wrap(
        <div>
          <SessionPane {...sharedProps} slotIndex={0} isFocused={true} session={sessA} onCancelPrompt={cancelA} />
          <SessionPane {...sharedProps} slotIndex={1} isFocused={false} session={sessB} onCancelPrompt={cancelB} />
        </div>
      )
    );

    // 展开窗格 B 的审批菜单 .popover
    fireEvent.click(screen.getByTestId('approval-mode-pill-sess-u5-b'));
    expect(screen.getByTestId('approval-menu-sess-u5-b')).toBeTruthy();

    // 在窗格 A 内按 Esc -> 窗格 B 的菜单绝不能阻断窗格 A 停止生成！
    const paneA = screen.getByTestId('session-pane-sess-u5-a');
    await act(async () => {
      fireEvent.keyDown(paneA, { key: 'Escape' });
      await Promise.resolve();
    });
    expect(cancelA).toHaveBeenCalledWith('sess-u5-a');
    expect(cancelB).not.toHaveBeenCalled();

    // 若窗格 A 自身展开审批菜单，按 Esc 仅收起菜单不调用 cancelA
    cancelA.mockClear();
    fireEvent.click(screen.getByTestId('approval-mode-pill-sess-u5-a'));
    expect(screen.getByTestId('approval-menu-sess-u5-a')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(paneA, { key: 'Escape' });
      await Promise.resolve();
    });
    expect(cancelA).not.toHaveBeenCalled();
  });

  it('TC-UI-05（U4）：AccountQuotaFooter 仅悬停预览不拦截中断 Esc，点击固定后 Esc 仅关闭弹层', () => {
    const bubbleEsc = vi.fn();
    window.addEventListener('keydown', bubbleEsc);
    try {
      render(wrap(<AccountQuotaFooter profileId="p-u4" />));
      const trigger = screen.getByTestId('quota-weekly');
      // 悬停预览（非 pinned、焦点不在弹层内）-> Esc 不应被阻止冒泡或拦截
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
      expect(screen.getByTestId('quota-details')).toBeTruthy();
      const previewEv = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      window.dispatchEvent(previewEv);
      expect(previewEv.defaultPrevented).toBe(false);
      expect(bubbleEsc).toHaveBeenCalled();

      // 点击固定（pinned）后再按 Esc -> 弹层关闭且不再泄漏
      fireEvent.click(trigger);
      expect(screen.getByTestId('quota-details')).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('quota-details')).toBeNull();
    } finally {
      window.removeEventListener('keydown', bubbleEsc);
    }
  });

  it('TC-UI-06..08 & TC-UI-14..16（U3 / B1 / B3）：语言切换非 hack 类名、B1 全入口脏守卫、B3 内联删除确认按 Esc 不关设置弹窗', async () => {
    const onClose = vi.fn();
    const basePrefs: ClientPreferences = {
      locale: 'en-US',
      theme: 'claude-code-dark',
      appIcon: 'auto',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };
    const pluginsSnap: PluginsManagerSnapshot = {
      builtins: [],
      plugins: [{ name: 'demo-plugin', enabled: true }],
      mcpServers: [{ name: 'demo-mcp', type: 'stdio', commandOrUrl: 'node', args: [], enabled: true }],
      skills: [],
      refreshedAt: '2026-11-28T00:00:00Z',
    };

    function SettingsHost({ initialLocale }: { initialLocale: ClientLocale }) {
      const [section, setSection] = useState<'general' | 'themes' | 'tokens' | 'icons' | 'projects' | 'accounts' | 'approvals' | 'plugins' | 'rates' | 'about'>('general');
      return (
        <I18nProvider locale={initialLocale} onChangeLocale={() => {}}>
          <SettingsView
            section={section}
            onSectionChange={setSection}
            onClose={onClose}
            preferences={{ ...basePrefs, locale: initialLocale }}
            connection={{
              connected: true,
              agyBinaryPath: 'agy',
              agyVersion: '0.3.6',
              activeSessionCount: 0,
              maxParallelSessions: 4,
              activeProfileId: 'default',
              availableModels: [],
            }}
            accounts={{
              activeProfileId: 'default',
              acpIdentity: { connected: true, agentName: 'agy acp', agentVersion: '0.3.6', authMethods: [], supportsLogout: false },
              profiles: [
                { profileId: 'default', name: 'Default', isDefault: true, isolatedAppDataDir: 'C:\\qa\\def', createdAt: '', lastActivatedAt: '' },
                { profileId: 'p2', name: 'Work', isDefault: false, isolatedAppDataDir: 'C:\\qa\\p2', createdAt: '', lastActivatedAt: '' },
              ],
            }}
            approvalConfig={DEFAULT_APPROVAL_CONFIG}
            translationConfig={DEFAULT_TRANSLATION_CONFIG}
            auditEntries={[]}
            plugins={pluginsSnap}
            rateCards={[
              {
                modelId: 'gemini-4-carbon',
                displayName: 'Gemini 4 Carbon',
                inputPerMillionUsd: 1.5,
                cachedInputPerMillionUsd: 0.3,
                outputPerMillionUsd: 6,
                thinkingPerMillionUsd: 6,
              },
            ]}
            updateState={{ status: 'up-to-date', currentVersion: '0.3.6', repoUrl: '', canInstallDirectly: false }}
            onUpdatePreferences={async () => {}}
            onSetAppIcon={async () => {}}
            onImportCustomTheme={async () => {}}
            onExportCustomTheme={async () => '{}'}
            onCreateProfile={async () => {}}
            onSwitchProfile={async () => {}}
            onDeleteProfile={async () => {}}
            onLaunchLogin={async () => {}}
            onLogout={async () => {}}
            onUpdateApprovalConfig={async () => {}}
            onUpdateTranslationConfig={async () => {}}
            onUpdateRateCards={async () => {}}
            onRefreshPlugins={async () => {}}
            onRunPluginAction={async () => {}}
            onRunMcpAction={async () => {}}
            onToggleSkill={async () => {}}
            onCheckUpdates={async () => {}}
            onDownloadUpdate={async () => {}}
            onInstallUpdate={async () => {}}
            onQuickCreateInProject={async () => {}}
          />
        </I18nProvider>
      );
    }

    // 1) U3：en-US 下界面语言「中文」按钮不得带 is-active，「English」按钮带 is-active
    render(<SettingsHost initialLocale="en-US" />);
    await screen.findByTestId('voice-settings-card');
    const enBtn = screen.getByRole('button', { name: 'English' });
    const zhBtn = within(enBtn.parentElement!).getByRole('button', { name: '中文' });
    expect(zhBtn.className).not.toContain('is-active');
    expect(enBtn.className).toContain('is-active');

    // 2) B1（QA1-FE-09/14）：改动 VoiceSettingsCard 外部表单 -> 点击其他分组弹出脏守卫
    fireEvent.change(screen.getByTestId('voice-ext-endpoint'), { target: { value: 'https://dirty.example/v1' } });
    fireEvent.click(screen.getByTestId('settings-tab-accounts'));
    expect(screen.getByTestId('settings-section-dirty-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-section-dirty-discard'));
    await screen.findByTestId('delete-profile-p2');

    // 3) B3（QA1-FE-14）：点击删除弹出 .inline-confirm -> 按 Esc 仅取消行内确认，绝不关闭整个设置弹窗！
    fireEvent.click(screen.getByTestId('delete-profile-p2'));
    const confirmBtn = screen.getByTestId('delete-profile-p2-confirm');
    expect(document.activeElement).toBe(confirmBtn);
    fireEvent.keyDown(confirmBtn, { key: 'Escape' });
    expect(screen.queryByTestId('delete-profile-p2-confirm')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('theme-settings-modal')).toBeTruthy();

    // 4) B1：RatesPanel 修改单价后切组触发脏守卫；按 Esc 仅收回确认条（「继续编辑」），点「放弃修改」才切换
    fireEvent.click(screen.getByTestId('settings-tab-rates'));
    const rateInput = screen.getByTestId('rate-gemini-4-carbon-inputPerMillionUsd');
    fireEvent.change(rateInput, { target: { value: '9.99' } });
    fireEvent.click(screen.getByTestId('settings-tab-about'));
    expect(screen.getByTestId('settings-section-dirty-confirm')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('settings-section-dirty-confirm')).toBeNull();
    expect(screen.getByTestId('rate-cards-editor')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-tab-about'));
    fireEvent.click(screen.getByTestId('settings-section-dirty-discard'));
    expect(screen.queryByTestId('rate-cards-editor')).toBeNull();
  });

  it('TC-UI-09 & TC-UI-13（QA1-FE-14 B5）：ApprovalsPanel 与 PluginsPanel 错误按子页签 key 隔离不跨页串显', async () => {
    const failApproval = vi.fn().mockRejectedValue(new Error('规则写入失败'));
    const { unmount } = render(
      wrap(<ApprovalsPanel config={DEFAULT_APPROVAL_CONFIG} auditEntries={[]} initialTab="rules" onUpdateConfig={failApproval} />)
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('approval-mode-option-manual'));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('规则写入失败');
    // 切到 audit 子页签 -> rules 的报错不得串显
    fireEvent.click(screen.getByTestId('drawer-tab-audit'));
    expect(screen.queryByRole('alert')).toBeNull();
    // 切回 rules -> 仍可见
    fireEvent.click(screen.getByTestId('drawer-tab-rules'));
    expect(screen.getByRole('alert').textContent).toContain('规则写入失败');
    unmount();

    const failPlugin = vi.fn().mockRejectedValue(new Error('插件卸载失败'));
    const snap: PluginsManagerSnapshot = {
      builtins: [],
      plugins: [{ name: 'bad-plug', enabled: true }],
      mcpServers: [],
      skills: [],
      refreshedAt: '2026-11-28T00:00:00Z',
    };
    render(
      wrap(
        <PluginsPanel
          snapshot={snap}
          onRefresh={async () => {}}
          onRunPluginAction={failPlugin}
          onRunMcpAction={async () => {}}
          onToggleSkill={async () => {}}
        />
      )
    );
    fireEvent.click(screen.getByTestId('plugins-tab-plugins'));
    fireEvent.click(screen.getByTestId('uninstall-plugin-bad-plug'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('uninstall-plugin-bad-plug-confirm'));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('插件卸载失败');
    fireEvent.click(screen.getByTestId('plugins-tab-mcp'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('TC-UI-10..11（B6 & 图标/斜杠命令）：Split-2 切窗格保留 costScope、IconsPanel 6 套 3×2、/clear 透传官方 agy', async () => {
    // B6：切换 sessionId 时保留 ContextCostInspectorView 用户已选 costScope
    const view = render(
      wrap(<ContextCostInspectorView sessionId="sess-a" dashboard={makeTelemetry()} onOpenRateCardsSettings={() => {}} />)
    );
    const all30Btn = screen.getByTestId('cost-scope-30d');
    fireEvent.click(all30Btn);
    expect(all30Btn.className).toContain('is-active');
    expect(screen.getByTestId('cost-total-usd').textContent).toContain('$0.010');
    view.rerender(wrap(<ContextCostInspectorView sessionId="sess-b" dashboard={makeTelemetry()} onOpenRateCardsSettings={() => {}} />));
    expect(screen.getByTestId('cost-scope-30d').className).toContain('is-active');
    expect(screen.getByTestId('cost-total-usd').textContent).toContain('$0.010');
    view.unmount();

    // IconsPanel：顶部独立开关 + 下方 6 卡网格
    const prefs: ClientPreferences = {
      locale: 'zh-CN',
      theme: 'claude-code-dark',
      appIcon: 'auto',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };
    const iconView = render(wrap(<IconsPanel preferences={prefs} onSetAppIcon={async () => {}} />));
    expect(screen.getByTestId('app-icons-grid').children).toHaveLength(6);
    expect((screen.getByTestId('icon-variant-auto') as HTMLInputElement).checked).toBe(true);
    iconView.unmount();

    // /clear 透传至 onSendPrompt（官方 agy）而不被前端拦截吞掉
    const onSend = vi.fn().mockResolvedValue(undefined);
    const sess = makeSession({ sessionId: 'sess-clear' });
    render(
      wrap(
        <Composer
          session={sess}
          availableSessions={[sess]}
          availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          canTriggerDemoApproval={false}
          onSendPrompt={onSend}
          onCancelPrompt={async () => {}}
          onCompactContext={async () => {}}
          onSetSessionMode={async () => {}}
          onSetSessionEffort={async () => {}}
          onSetSessionModel={async () => {}}
          onQueryWorkspaceFiles={async () => []}
          onCycleApprovalMode={async () => {}}
          onOpenApprovalSettings={() => {}}
          onOpenContextInspector={() => {}}
          onTriggerDemoApproval={() => {}}
        />
      )
    );
    const box = screen.getByTestId('composer-input-sess-clear');
    fireEvent.change(box, { target: { value: '/clear' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: '/clear' }));
    // Composer 窄窗格「+」溢出菜单结构存在
    const moreBtn = screen.getByTestId('composer-more-sess-clear');
    fireEvent.click(moreBtn);
    expect(screen.getByTestId('composer-more-voice-sess-clear')).toBeTruthy();
  });
});

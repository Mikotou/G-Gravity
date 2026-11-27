/**
 * v0.3.6 语音听写控制器（与 React 解耦的状态机）。
 *
 *   idle → arming → probing → recording → finishing → (settled，按 finalSeq 补齐) → idle
 *   任意非 idle 态 —Esc→ aborting → idle；主进程 REVOKED → idle；切入设置页（外部引擎）→ release-media(hold) → idle
 *
 * 合规与鲁棒性：
 * - 权限严格收口：先 `voiceArmCapture` 申请短时租约，再 `getUserMedia`，随后 `media-ready`；结束必 `release-media`；
 * - 幂等防重：非 idle 时 start 忽略；stop/abort 重入忽略；所有异步回调按 token 丢弃过期结果；
 * - 背压：在途 `voiceAppend` 最多 2 片，其余排队并上报 `backpressure`；
 * - 停录（F5 / Enter / 按钮 / 3:30 上限）只转写保留文本，绝不自动发送。
 */
import {
  VOICE_MAX_DURATION_MS,
  type VoiceArmCaptureResult,
  type VoiceCapturePurpose,
  type VoiceEngineMode,
  type VoiceLocale,
  type VoiceOwner,
  type VoiceSettledEvent,
} from '@shared';
import type { VoiceBridge } from '../../services/desktop-bridge';
import { Pcm16Chunker } from './pcm-encoder';

export type VoicePhase = 'idle' | 'arming' | 'probing' | 'recording' | 'finishing' | 'aborting';

export interface VoiceControllerEvents {
  onPhase?: (phase: VoicePhase, info: { captureId?: string; startedAt?: number; backpressure?: boolean }) => void;
  onSegment?: (captureId: string, seq: number, text: string) => void;
  onSettled?: (captureId: string, event: VoiceSettledEvent, missingSegments: boolean) => void;
  onAborted?: (captureId: string) => void;
  onNotice?: (kind: 'cap' | 'revoked' | 'error' | 'held', message?: string) => void;
}

export interface VoiceControllerDeps {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  workletUrl?: string;
  now?: () => number;
}

export const MAX_INFLIGHT_APPENDS = 2;

const active = new Set<VoiceCaptureController>();
/** 切入设置页等被动场景：外部引擎封存（hold，0 finish / 0 HTTP），本地引擎正常停录转写。 */
export function holdActiveVoiceCaptures(): void {
  for (const c of [...active]) c.passiveStop();
}

export class VoiceCaptureController {
  phase: VoicePhase = 'idle';
  captureId: string | null = null;
  engine: VoiceEngineMode = 'local';
  private token = 0;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private chunker: Pcm16Chunker | null = null;
  private flushWaiter: (() => void) | null = null;
  private queue: ArrayBuffer[] = [];
  private inflight = 0;
  private seq = 0;
  private bytes = 0;
  private peakLevel = 0;
  private maxBytes = Infinity;
  private purpose: VoiceCapturePurpose = 'dictation';
  private lastAbortedCaptureId: string | null = null;
  captureMode: 'worklet' | 'script-processor' | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];
  private seenSegments = new Set<number>();
  private startedAt = 0;
  private backpressure = false;
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly bridge: VoiceBridge,
    private readonly events: VoiceControllerEvents = {},
    private readonly deps: VoiceControllerDeps = {}
  ) {
    this.unsubs.push(
      bridge.onVoiceSegment((e) => {
        if (e.captureId !== this.captureId || this.seenSegments.has(e.seq)) return;
        this.seenSegments.add(e.seq);
        this.events.onSegment?.(e.captureId, e.seq, e.text);
      }),
      bridge.onVoiceSettled((e) => {
        if (e.captureId !== this.captureId) return;
        if (e.outcome === 'aborted') {
          // QA1-FE-01：先收到 aborted settled 时也立即释放媒体轨道，并记住 ID 以便紧随其后的 revoked 补充原因提示
          const id = e.captureId;
          this.lastAbortedCaptureId = id;
          this.teardownMedia();
          this.reset();
          this.events.onNotice?.('revoked', e.error);
          this.events.onAborted?.(id);
          return;
        }
        if (this.phase === 'finishing' || this.phase === 'recording') this.settle(e);
      }),
      bridge.onVoiceCaptureRevoked((e) => {
        if (e.captureId === this.lastAbortedCaptureId) {
          this.lastAbortedCaptureId = null;
          if (e.held || e.message) this.events.onNotice?.(e.held ? 'held' : 'revoked', e.message);
          return;
        }
        if (e.captureId !== this.captureId) return;
        const id = e.captureId;
        this.teardownMedia();
        this.reset();
        this.events.onNotice?.(e.held ? 'held' : 'revoked', e.message);
        this.events.onAborted?.(id);
      })
    );
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  private setPhase(phase: VoicePhase): void {
    this.phase = phase;
    this.events.onPhase?.(phase, {
      ...(this.captureId ? { captureId: this.captureId } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      backpressure: this.backpressure,
    });
  }

  async start(input: {
    owner: VoiceOwner;
    locale?: VoiceLocale;
    deviceId?: string;
    purpose?: VoiceCapturePurpose;
    maxDurationMs?: number;
  }): Promise<boolean> {
    if (this.phase !== 'idle') return false;
    const token = ++this.token;
    this.setPhase('arming');
    active.add(this);
    let armed: VoiceArmCaptureResult;
    try {
      armed = await this.bridge.voiceArmCapture({
        op: 'arm',
        owner: input.owner,
        purpose: input.purpose ?? 'dictation',
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      });
    } catch (err) {
      if (token === this.token) this.fail(err);
      return false;
    }
    if (token !== this.token) {
      void this.bridge.voiceAbort({ captureId: armed.captureId, reason: 'superseded' }).catch(() => undefined);
      return false;
    }
    this.captureId = armed.captureId;
    this.engine = armed.engine;
    this.purpose = armed.purpose ?? input.purpose ?? 'dictation';
    this.maxBytes = armed.maxPcmBytes;
    this.peakLevel = 0;
    this.lastAbortedCaptureId = null;
    this.setPhase('probing');
    try {
      const gum = this.deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
      const stream = await gum({
        audio: {
          ...(input.deviceId ? { deviceId: { exact: input.deviceId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (token !== this.token) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;
      await this.bridge.voiceArmCapture({ op: 'media-ready', captureId: armed.captureId });
      if (token !== this.token) return false;
      await this.startGraph(stream);
    } catch (err) {
      if (token === this.token) await this.abort(err);
      return false;
    }
    if (token !== this.token) return false;
    this.startedAt = (this.deps.now ?? Date.now)();
    const limit = Math.min(input.maxDurationMs ?? armed.maxDurationMs ?? VOICE_MAX_DURATION_MS, VOICE_MAX_DURATION_MS);
    this.capTimer = setTimeout(() => {
      if (this.phase === 'recording') {
        this.events.onNotice?.('cap');
        void this.stop();
      }
    }, limit);
    this.setPhase('recording');
    return true;
  }

  private async startGraph(stream: MediaStream): Promise<void> {
    const ctx = this.deps.createAudioContext ? this.deps.createAudioContext() : new AudioContext();
    this.ctx = ctx;
    // QA1-FE-15：确保挂起的 AudioContext 恢复拉流，并经静音 GainNode(0) 接入输出图防止 Chromium 悬空回收
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      await ctx.resume().catch(() => undefined);
    }
    const source = ctx.createMediaStreamSource(stream);
    const mute = typeof ctx.createGain === 'function' ? ctx.createGain() : null;
    if (mute) {
      mute.gain.value = 0;
      mute.connect(ctx.destination);
    }
    const onChunk = (chunk: ArrayBuffer) => this.enqueue(chunk);
    try {
      if (!this.deps.workletUrl || !ctx.audioWorklet) throw new Error('no-worklet');
      await ctx.audioWorklet.addModule(this.deps.workletUrl);
      const node = new AudioWorkletNode(ctx, 'gravity-pcm16');
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data === 'flushed') {
          this.flushWaiter?.();
          this.flushWaiter = null;
        } else if (event.data instanceof ArrayBuffer) onChunk(event.data);
      };
      source.connect(node);
      if (mute) node.connect(mute);
      this.node = node;
      this.captureMode = 'worklet';
    } catch {
      // 降级：ScriptProcessorNode（已弃用但 Chromium 仍支持），经静音增益节点驱动回调
      const node = ctx.createScriptProcessor(4096, 1, 1);
      this.chunker = new Pcm16Chunker(ctx.sampleRate, onChunk);
      node.onaudioprocess = (ev) => this.chunker?.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      source.connect(node);
      if (mute) node.connect(mute);
      else node.connect(ctx.destination);
      this.node = node;
      this.captureMode = 'script-processor';
    }
  }

  get capturedBytes(): number {
    return this.bytes;
  }

  get peakAmplitude(): number {
    return this.peakLevel;
  }

  private enqueue(chunk: ArrayBuffer): void {
    if (!this.captureId || (this.phase !== 'recording' && this.phase !== 'finishing')) return;
    const view = new Int16Array(chunk);
    for (let i = 0; i < view.length; i += 8) {
      const mag = Math.abs(view[i]);
      if (mag > this.peakLevel) this.peakLevel = mag;
    }
    if (this.bytes + chunk.byteLength > this.maxBytes) {
      if (this.phase === 'recording') {
        this.events.onNotice?.('cap');
        void this.stop();
      }
      return;
    }
    this.bytes += chunk.byteLength;
    this.queue.push(chunk);
    this.pump();
  }

  private pump(): void {
    const captureId = this.captureId;
    while (captureId && this.inflight < MAX_INFLIGHT_APPENDS && this.queue.length) {
      const pcm16 = this.queue.shift()!;
      const seq = ++this.seq;
      this.inflight++;
      void this.bridge
        .voiceAppend({ captureId, seq, pcm16 })
        .then((res) => {
          if (res.capped && this.phase === 'recording' && captureId === this.captureId) {
            this.events.onNotice?.('cap');
            void this.stop();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.inflight--;
          this.pump();
        });
    }
    const pressured = this.queue.length > 0;
    if (pressured !== this.backpressure) {
      this.backpressure = pressured;
      this.setPhase(this.phase);
    }
    if (!this.inflight && !this.queue.length) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      waiters.forEach((fn) => fn());
    }
  }

  private drained(): Promise<void> {
    if (!this.inflight && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private async flushTail(): Promise<void> {
    if (this.node && 'port' in this.node) {
      const node = this.node;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 300);
        this.flushWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
        node.port.postMessage('flush');
      });
    } else {
      this.chunker?.flush();
    }
  }

  /** 停录并转写（F5 / Enter / 按钮 / 上限）；绝不自动发送。 */
  async stop(): Promise<void> {
    if (this.phase !== 'recording') return;
    const token = this.token;
    const captureId = this.captureId!;
    const purpose = this.purpose;
    const capturedBytes = this.bytes;
    this.setPhase('finishing');
    if (this.capTimer) clearTimeout(this.capTimer);
    // QA1-FE-02：严格按序 flushTail → teardownMedia → await drained → await release-media → voiceFinish
    await this.flushTail();
    this.teardownMedia();
    await this.drained();
    if (token !== this.token) return;
    await this.bridge.voiceArmCapture({ op: 'release-media', captureId }).catch(() => undefined);
    if (token !== this.token) return;
    if (purpose === 'mic-test') {
      // QA1-FE-10：3 秒试录仅做本机采音通路验证，0 外联 0 voiceFinish
      if ((this.phase as VoicePhase) === 'finishing') {
        this.settle({
          owner: { profileId: '' },
          epoch: 0,
          captureId,
          finalSeq: 0,
          text: '',
          durationMs: Math.round((Math.max(capturedBytes, this.bytes) / 32000) * 1000),
          engine: this.engine === 'external-api' ? 'external-api' : 'local',
          outcome: 'completed',
        });
      }
      return;
    }
    try {
      const res = await this.bridge.voiceFinish({ captureId, finalChunkSeq: this.seq });
      if (token !== this.token) return;
      if ((res.status === 'settled' || res.status === 'already-settled') && (this.phase as VoicePhase) === 'finishing') {
        this.settle({
          owner: { profileId: '' },
          epoch: 0,
          captureId,
          finalSeq: res.finalSeq ?? 0,
          text: res.text ?? '',
          durationMs: 0,
          engine: this.engine === 'external-api' ? 'external-api' : 'local',
          outcome: res.error ? 'error' : 'completed',
          ...(res.error ? { error: res.error } : {}),
        });
      } else if (res.status === 'aborted') {
        this.reset();
        this.events.onAborted?.(captureId);
      }
    } catch (err) {
      if (token === this.token) this.fail(err);
    }
  }

  /** Esc：中止本次听写（调用方回滚未编辑的插入段）；不影响 AI 生成。 */
  async abort(reason?: unknown): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'aborting') return;
    const captureId = this.captureId;
    ++this.token;
    this.setPhase('aborting');
    if (this.capTimer) clearTimeout(this.capTimer);
    this.teardownMedia();
    if (captureId) {
      await Promise.allSettled([
        this.bridge.voiceArmCapture({ op: 'release-media', captureId }),
        this.bridge.voiceAbort({ captureId, reason: reason instanceof Error ? reason.message : 'user-abort' }),
      ]);
    }
    this.reset();
    if (reason) this.events.onNotice?.('error', reason instanceof Error ? reason.message : String(reason));
    if (captureId) this.events.onAborted?.(captureId);
  }

  /** 被动停录：外部引擎 release-media(hold) 封存，0 次 finish / 0 次 HTTP；本地引擎正常转写。 */
  passiveStop(): void {
    if (this.phase === 'arming' || this.phase === 'probing') {
      void this.abort();
      return;
    }
    if (this.phase !== 'recording') return;
    if (this.engine !== 'external-api') {
      void this.stop();
      return;
    }
    const captureId = this.captureId!;
    ++this.token;
    if (this.capTimer) clearTimeout(this.capTimer);
    this.teardownMedia();
    void this.bridge.voiceArmCapture({ op: 'release-media', captureId, hold: true }).catch(() => undefined);
    this.reset();
    this.events.onNotice?.('held');
    this.events.onAborted?.(captureId);
  }

  private settle(event: VoiceSettledEvent): void {
    const missing = event.finalSeq > 0 && Array.from({ length: event.finalSeq }, (_, i) => i + 1).some((s) => !this.seenSegments.has(s));
    const captureId = event.captureId;
    this.reset();
    if (event.outcome === 'error') this.events.onNotice?.('error', event.error);
    this.events.onSettled?.(captureId, event, missing);
  }

  private fail(err: unknown): void {
    this.teardownMedia();
    const captureId = this.captureId;
    if (captureId) void this.bridge.voiceArmCapture({ op: 'release-media', captureId }).catch(() => undefined);
    this.reset();
    this.events.onNotice?.('error', err instanceof Error ? err.message : String(err));
  }

  private teardownMedia(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.node = null;
    this.chunker = null;
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }

  private reset(): void {
    // QA1-FE-01：任意状态归零前无条件释放媒体轨道与 AudioContext，杜绝麦克风泄漏
    this.teardownMedia();
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    this.captureId = null;
    this.queue = [];
    this.seq = 0;
    this.bytes = 0;
    this.startedAt = 0;
    this.backpressure = false;
    this.seenSegments = new Set();
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    waiters.forEach((fn) => fn());
    active.delete(this);
    this.setPhase('idle');
  }

  dispose(): void {
    if (this.phase !== 'idle') void this.abort();
    this.unsubs.forEach((fn) => fn());
    this.unsubs = [];
    active.delete(this);
  }
}

/**
 * 设置页「选择输入设备」：申请 `device-list` 租约 → getUserMedia → enumerateDevices → 立即释放。
 * 静息态绝不调用 getUserMedia / enumerateDevices / permissions.query。
 */
export async function listInputDevicesWithLease(
  bridge: VoiceBridge,
  owner: VoiceOwner,
  deps: Pick<VoiceControllerDeps, 'getUserMedia'> & { enumerateDevices?: () => Promise<MediaDeviceInfo[]> } = {}
): Promise<Array<{ deviceId: string; label: string }>> {
  const armed = await bridge.voiceArmCapture({ op: 'arm', owner, purpose: 'device-list' });
  let stream: MediaStream | null = null;
  try {
    const gum = deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
    stream = await gum({ audio: true, video: false });
    await bridge.voiceArmCapture({ op: 'media-ready', captureId: armed.captureId });
    const enumerate = deps.enumerateDevices ?? (() => navigator.mediaDevices.enumerateDevices());
    const devices = await enumerate();
    return devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    await bridge.voiceArmCapture({ op: 'release-media', captureId: armed.captureId }).catch(() => undefined);
  }
}

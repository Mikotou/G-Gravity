import { randomUUID } from 'node:crypto';
import { isValidVoiceOwner, type VoiceOwner } from '../../shared/session-owner';
import {
  VOICE_SAMPLE_RATE, VOICE_MAX_PCM_BYTES, VOICE_MAX_DURATION_MS, VOICE_MIC_TEST_MAX_BYTES, VOICE_MIC_TEST_MAX_DURATION_MS,
  isValidVoicePcm16Buffer, isVoiceCaptureControlRequest, normalizeDictationText,
  type VoiceAbortResult, type VoiceActiveCaptureSummary, type VoiceAppendInput, type VoiceAppendResult,
  type VoiceArmCaptureInput, type VoiceArmCaptureResult, type VoiceFinishInput, type VoiceFinishResult,
  type VoiceHeldCaptureSummary, type VoiceLocale, type VoiceRevokeReason, type VoiceSettledEvent,
  type VoiceConfig, type ExternalVoiceProviderConfig,
} from '../../shared/voice-contract';

const LEASE_MS = 10_000;
const HELD_MS = 60_000;
interface LocalStream { append(pcm: Buffer): void; finish(): Promise<void>; close(): Promise<void> }
interface Capture extends VoiceActiveCaptureSummary {
  chunks: Buffer[];
  stream?: LocalStream;
  localTail?: Promise<void>;
  text: string;
  finalSeq: number;
  maxBytes: number;
  durationLimit: number;
  expires: number;
  timer?: NodeJS.Timeout;
  controller: AbortController;
  locale: VoiceLocale;
  external?: ExternalVoiceProviderConfig;
  finishing?: Promise<VoiceFinishResult>;
}
interface CaptureHost {
  epoch(owner: VoiceOwner): number | undefined;
  config(): Readonly<VoiceConfig>;
  ready(engine: Capture['engine']): Promise<void>;
  requestMicrophone(): Promise<boolean>;
  stream(locale: VoiceLocale, signal: AbortSignal, publish: (text: string) => void): LocalStream;
  transcribe(owner: VoiceOwner, pcm: Uint8Array, locale: VoiceLocale, signal: AbortSignal, external?: ExternalVoiceProviderConfig): Promise<string>;
  cooldown(endpoint: string): Pick<VoiceSettledEvent, 'cooldownKind' | 'cooldownUntil'>;
  emit(event: string, value: unknown): void;
}
export class VoiceCapture {
  private active?: Capture;
  private held?: Capture;
  private ticket = 0;
  private settled = new Map<string, { result: VoiceFinishResult; owner: VoiceOwner }>();
  private pending = new Set<Promise<VoiceFinishResult>>();
  constructor(private host: CaptureHost) {}
  private owned(c: Capture) { return !c.controller.signal.aborted && this.host.epoch(c.owner) === c.epoch; }
  get hasLease(): boolean {
    const c = this.active;
    return !!c && c.state === 'armed' && c.expires > Date.now() && this.owned(c);
  }
  private setDeadline(c: Capture, delay: number): void {
    clearTimeout(c.timer);
    c.expires = Date.now() + delay;
    c.timer = setTimeout(() => {
      if (c.state === 'capturing' && c.purpose !== 'device-list') {
        this.seal(c);
      } else this.revokeOne(c, 'timeout');
    }, delay);
    c.timer.unref();
  }
  private armResult(c: Capture, state: VoiceArmCaptureResult['state']): VoiceArmCaptureResult {
    return { captureId: c.captureId, owner: { ...c.owner }, epoch: c.epoch, purpose: c.purpose, engine: c.engine,
      state, sampleRate: VOICE_SAMPLE_RATE, maxDurationMs: c.durationLimit, maxPcmBytes: c.maxBytes,
      expiresAt: new Date(c.expires).toISOString() };
  }
  summaries(): { activeCapture?: VoiceActiveCaptureSummary; heldCapture?: VoiceHeldCaptureSummary } {
    const a = this.active, h = this.held;
    return {
      ...(a && this.owned(a) && { activeCapture: { captureId: a.captureId, owner: { ...a.owner }, epoch: a.epoch,
        purpose: a.purpose, engine: a.engine, state: a.state, acceptedBytes: a.acceptedBytes, acceptedSeq: a.acceptedSeq } }),
      ...(h && this.owned(h) && { heldCapture: { captureId: h.captureId, owner: { ...h.owner }, epoch: h.epoch,
        durationMs: h.acceptedBytes / 32, acceptedBytes: h.acceptedBytes, expiresAt: new Date(h.expires).toISOString() } }),
    };
  }
  private find(id: string): Capture | undefined {
    const c = this.active?.captureId === id ? this.active : this.held?.captureId === id ? this.held : undefined;
    return c && this.owned(c) ? c : undefined;
  }
  async arm(input: VoiceArmCaptureInput): Promise<VoiceArmCaptureResult> {
    if (isVoiceCaptureControlRequest(input)) {
      if (Object.keys(input).some(key => !['op', 'captureId', 'hold'].includes(key)) ||
          (input.hold !== undefined && (typeof input.hold !== 'boolean' || input.op !== 'release-media'))) throw Error('语音租约控制参数无效');
      const c = this.find(input.captureId);
      if (!c) throw Error('语音采集已失效');
      if (input.op === 'media-ready') {
        if (this.active !== c || c.state !== 'armed' || !this.hasLease) throw Error('麦克风租约已失效');
        c.state = 'capturing';
        if (c.engine === 'local' && c.purpose === 'dictation') {
          c.stream = this.host.stream(c.locale, c.controller.signal, text => this.publish(c, text));
        }
        this.setDeadline(c, c.durationLimit);
        return this.armResult(c, 'capturing');
      }
      if (c.state === 'finishing' || c === this.held) return this.armResult(c, 'released');
      if (input.hold && c.engine === 'external-api' && c.purpose === 'dictation' && c.acceptedBytes) {
        if (this.held) this.revokeOne(this.held, 'preempted');
        this.active = undefined;
        this.held = c;
        c.state = 'sealed';
        this.setDeadline(c, HELD_MS);
        this.host.emit('voice-capture-revoked', { captureId: c.captureId, epoch: c.epoch, owner: c.owner, reason: 'preempted', held: true });
      } else if (c.purpose !== 'dictation' || (c.state === 'armed' && !input.hold)) {
        this.settle(c, c.state === 'armed' ? 'aborted' : 'completed');
        return this.armResult(c, 'released');
      } else if (input.hold) this.revokeOne(c, 'permission-revoked');
      else if (c.state !== 'sealed') this.seal(c);
      return this.armResult(c, c.state === 'sealed' ? 'sealed' : 'released');
    }
    const purpose = input.purpose ?? 'dictation';
    if ((input.op !== undefined && input.op !== 'arm') || !['dictation', 'mic-test', 'device-list'].includes(purpose) ||
        !isValidVoiceOwner(input.owner) || (purpose === 'dictation' && !input.owner.sessionId)) throw Error('语音采集归属或用途无效');
    const owner = { profileId: input.owner.profileId, sessionId: input.owner.sessionId, epoch: input.owner.epoch };
    const epoch = this.host.epoch(owner);
    if (epoch === undefined) throw Error('语音采集归属已改变');
    owner.epoch = epoch;
    const config = this.host.config();
    const engine = purpose === 'dictation' ? config.engine : 'local';
    if (engine === 'off') throw Error('语音输入已关闭');
    const locale = input.locale ?? config.locale;
    if (!['auto', 'zh-CN', 'en-US'].includes(locale)) throw Error('无效的语音语言');
    const ticket = ++this.ticket;
    if (this.active) this.revokeOne(this.active, 'preempted');
    if (purpose === 'dictation') await this.host.ready(engine);
    const current = () => ticket === this.ticket && this.host.epoch(owner) === epoch && config === this.host.config();
    if (!current() || !await this.host.requestMicrophone() || !current()) throw Error('麦克风权限不可用或采集归属已改变');
    const c: Capture = { captureId: randomUUID(), owner, epoch, purpose, engine, locale, chunks: [], text: '', finalSeq: 0, state: 'armed',
      controller: new AbortController(), acceptedBytes: 0, acceptedSeq: 0, expires: 0,
      external: engine === 'external-api' ? { ...config.externalProvider } : undefined,
      maxBytes: purpose === 'dictation' ? VOICE_MAX_PCM_BYTES : VOICE_MIC_TEST_MAX_BYTES,
      durationLimit: purpose === 'dictation' ? VOICE_MAX_DURATION_MS : VOICE_MIC_TEST_MAX_DURATION_MS };
    this.active = c;
    this.setDeadline(c, LEASE_MS);
    return this.armResult(c, 'armed');
  }
  append(input: VoiceAppendInput): VoiceAppendResult {
    const c = this.find(input.captureId);
    if (!c || c !== this.active || c.purpose === 'device-list' || !isValidVoicePcm16Buffer(input.pcm16)) throw Error('语音分片无效');
    const ack = (reason?: 'capped' | 'seq-mismatch' | 'not-capturing'): VoiceAppendResult => ({
      captureId: c.captureId, accepted: reason === undefined, seq: input.seq, expectedSeq: c.acceptedSeq + 1,
      acceptedBytes: c.acceptedBytes, remainingBytes: c.maxBytes - c.acceptedBytes,
      capped: c.acceptedBytes === c.maxBytes || c.state === 'sealed' || c.expires <= Date.now(), ...(reason && { reason }),
    });
    if (c.expires <= Date.now() && c.state === 'capturing') this.seal(c);
    if (c.state === 'sealed' || c.expires <= Date.now()) return ack('capped');
    if (c.state !== 'capturing') return ack('not-capturing');
    if (input.seq !== c.acceptedSeq + 1) return ack('seq-mismatch');
    const source = input.pcm16 instanceof Uint8Array ? input.pcm16 : new Uint8Array(input.pcm16);
    const bytes = Buffer.from(source.subarray(0, c.maxBytes - c.acceptedBytes));
    if (c.stream) c.stream.append(bytes);
    else if (c.purpose === 'dictation') c.chunks.push(bytes);
    c.acceptedBytes += bytes.length;
    c.acceptedSeq = input.seq;
    if (c.acceptedBytes === c.maxBytes) this.seal(c);
    return ack();
  }
  private seal(c: Capture): void {
    c.state = 'sealed';
    this.setDeadline(c, HELD_MS);
    if (c.stream && !c.localTail) {
      const stream = c.stream;
      c.localTail = stream.finish().finally(() => stream.close());
      void c.localTail.catch(() => {});
    }
  }
  private forget(c: Capture): void {
    clearTimeout(c.timer);
    if (this.active === c) this.active = undefined;
    if (this.held === c) this.held = undefined;
    for (const chunk of c.chunks) chunk.fill(0);
    c.chunks = [];
    void c.stream?.close().catch(() => {});
  }
  private publish(c: Capture, raw: string): void {
    if (!this.owned(c)) return;
    const text = normalizeDictationText(c.text, raw, c.locale);
    if (!text) return;
    c.text += text;
    this.host.emit('voice-segment', { captureId: c.captureId, owner: c.owner, epoch: c.epoch, seq: ++c.finalSeq, text, isFinal: true });
  }
  private settle(c: Capture, outcome: VoiceSettledEvent['outcome'], incompleteTail?: boolean, error?: string): VoiceFinishResult {
    const { finalSeq, text } = c;
    const result: VoiceFinishResult = { captureId: c.captureId, status: outcome === 'aborted' ? 'aborted' : 'settled',
      acceptedBytes: c.acceptedBytes, acceptedSeq: c.acceptedSeq, finalSeq, text, incompleteTail, error };
    const event: VoiceSettledEvent = { captureId: c.captureId, epoch: c.epoch, owner: c.owner, outcome, finalSeq, text,
      durationMs: c.acceptedBytes / 32, engine: c.engine, incompleteTail, error, ...(c.external && this.host.cooldown(c.external.endpoint)) };
    this.forget(c);
    this.settled.set(c.captureId, { owner: c.owner, result });
    if (this.settled.size > 64) this.settled.delete(this.settled.keys().next().value!);
    this.host.emit('voice-settled', event);
    return result;
  }
  private revokeOne(c: Capture, reason: VoiceRevokeReason): void {
    if (c.controller.signal.aborted) return;
    c.controller.abort();
    try {
      this.host.emit('voice-capture-revoked', { captureId: c.captureId, owner: c.owner, epoch: c.epoch, reason });
    } finally {
      this.settle(c, 'aborted');
    }
  }
  revoke(reason: VoiceRevokeReason, sessionId?: string): void {
    this.ticket++;
    for (const c of [this.active, this.held]) if (c && (!sessionId || c.owner.sessionId === sessionId)) this.revokeOne(c, reason);
    for (const [id, old] of this.settled) if (!sessionId || old.owner.sessionId === sessionId) this.settled.delete(id);
  }
  async finish(input: VoiceFinishInput): Promise<VoiceFinishResult> {
    const old = this.settled.get(input.captureId);
    if (old && this.host.epoch(old.owner) === old.owner.epoch) {
      return { ...old.result, status: old.result.status === 'aborted' ? 'aborted' : 'already-settled' };
    }
    const c = this.find(input.captureId);
    if (!c) throw Error('语音采集已失效');
    if (c.finishing) return c.finishing;
    if (c.purpose === 'dictation' && c.external && c.state !== 'sealed') throw Error('提交前请先停止录音');
    if (input.finalChunkSeq !== undefined && (!Number.isSafeInteger(input.finalChunkSeq) || input.finalChunkSeq < 0)) throw Error('末尾分片序号无效');
    if (c.expires <= Date.now()) { this.revokeOne(c, 'timeout'); return this.settled.get(c.captureId)!.result; }
    clearTimeout(c.timer);
    c.state = 'finishing';
    const incomplete = input.finalChunkSeq !== undefined && input.finalChunkSeq !== c.acceptedSeq;
    const pcm = Buffer.concat(c.chunks);
    c.finishing = (async () => {
      try {
        let finalText: string | undefined;
        if (c.stream) {
          await (c.localTail ?? c.stream.finish());
          await c.stream.close();
        } else if (pcm.length && c.external) {
          finalText = await this.host.transcribe(c.owner, pcm, c.locale, c.controller.signal, c.external);
        }
        if (this.owned(c)) {
          if (finalText !== undefined) c.text = normalizeDictationText('', finalText, c.locale);
          return this.settle(c, 'completed', incomplete);
        }
      } catch {
        if (this.owned(c)) return this.settle(c, 'error', incomplete, '语音转写失败');
      } finally { pcm.fill(0); }
      return { status: 'aborted' as const, captureId: c.captureId, acceptedBytes: c.acceptedBytes, acceptedSeq: c.acceptedSeq, finalSeq: c.finalSeq };
    })();
    this.pending.add(c.finishing);
    try { return await c.finishing; } finally { this.pending.delete(c.finishing); }
  }
  abort(id: string): VoiceAbortResult {
    const c = this.find(id);
    const inFlight = !!c?.external && c.state === 'finishing';
    if (c) { c.controller.abort(); this.settle(c, 'aborted'); }
    return { captureId: id, aborted: !!c || this.settled.get(id)?.result.status === 'aborted', remoteRequestInFlight: inFlight };
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }
}

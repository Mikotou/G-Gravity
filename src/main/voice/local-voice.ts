import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { WhisperThread } from './whisper-thread';
import { UtteranceStream } from './utterance-stream';
import {
  VOICE_LOCAL_MODEL_SPEC as spec, type VoiceInstallModelInput, type VoiceInstallModelResult,
  type VoiceLocale, type VoiceModelState,
} from '../../shared/voice-contract';

// The CLI and the application use the same descriptor-based verifier and atomic installer.
const modelIO: {
  readVerified(file: string): Promise<Buffer<ArrayBuffer>>;
  install(dir: string, signal: AbortSignal, progress: (bytes: number) => void, fetcher?: typeof fetch): Promise<void>;
} = require('../../../assets/local-voice/model.cjs');

type ModelSource = 'bundled' | 'user-data';
export class LocalVoice {
  readonly root: string;
  private readonly modelDir: string;
  private download?: { controller: AbortController; done: Promise<void> };
  private check?: Promise<void>;
  private stamp?: string;
  private generation = 0;
  private running = new Set<Promise<WhisperThread>>();
  private model: VoiceModelState = { status: 'missing', modelId: spec.id, fileName: spec.fileName,
    expectedBytes: spec.sizeBytes, sha256Verified: false };
  constructor(appRoot: string, dataDir: string, private fetcher?: typeof fetch) {
    this.root = join(appRoot, 'assets', 'local-voice');
    this.modelDir = join(dataDir, 'voice-models');
  }

  private paths(): [ModelSource, string][] {
    return [['bundled', join(this.root, spec.fileName)], ['user-data', join(this.modelDir, spec.fileName)]];
  }
  private async inspectFiles() {
    return Promise.all(this.paths().map(async ([, file]) => {
      try {
        const stat = await lstat(file, { bigint: true });
        return [await realpath(file).catch(() => ''), stat.dev, stat.ino, stat.nlink, stat.size, stat.ctimeNs].join(':');
      } catch { return ''; }
    }));
  }
  private async load() {
    let invalid = false;
    for (const [source, path] of this.paths()) {
      try { return { bytes: await modelIO.readVerified(path), source }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = true; }
    }
    if (invalid) throw Error('语音模型完整性校验失败');
    return undefined;
  }
  private async refresh(): Promise<void> {
    const stamp = (await this.inspectFiles()).join('|');
    if (stamp === this.stamp || this.download) return;
    try {
      const loaded = await this.load();
      if (this.download) return;
      this.model = { ...this.model, status: loaded ? 'ready' : 'missing', sha256Verified: !!loaded,
        source: loaded?.source, progressPercent: loaded ? 100 : undefined, error: undefined };
    } catch {
      if (this.download) return;
      this.model = { ...this.model, status: 'error', sha256Verified: false, source: undefined, error: '语音模型校验失败' };
    }
    this.stamp = stamp;
  }
  async state(): Promise<VoiceModelState> {
    if (!this.download) {
      this.check ??= this.refresh().finally(() => { this.check = undefined; });
      await this.check;
    }
    return { ...this.model };
  }
  async install(input: VoiceInstallModelInput = {}): Promise<VoiceInstallModelResult> {
    if (input.action === 'cancel') {
      this.generation++;
      this.download?.controller.abort();
      await this.download?.done;
      return { started: false, state: await this.state() };
    }
    if (input.action !== undefined && input.action !== 'start') throw Error('无效的安装操作');
    const generation = this.generation;
    const state = await this.state();
    if (generation !== this.generation || this.download || state.status === 'ready') return { started: false, state };
    const controller = new AbortController();
    this.model = { ...this.model, status: 'downloading', downloadedBytes: 0, progressPercent: 0, error: undefined };
    const done = modelIO.install(this.modelDir, controller.signal, bytes => {
      this.model = { ...this.model, downloadedBytes: bytes, progressPercent: Math.floor(bytes * 100 / spec.sizeBytes),
        status: bytes === spec.sizeBytes ? 'verifying' : 'downloading' };
    }, this.fetcher).then(() => {
      this.model = { ...this.model, status: 'ready', sha256Verified: true, source: 'user-data' };
    }).catch(() => {
      if (controller.signal.aborted) this.stamp = undefined;
      this.model = { ...this.model, status: controller.signal.aborted ? 'missing' : 'error', downloadedBytes: 0, progressPercent: 0,
        sha256Verified: false, error: controller.signal.aborted ? undefined : '语音模型下载或完整性校验失败' };
    }).finally(() => { this.download = undefined; });
    this.download = { controller, done };
    return { started: true, state: { ...this.model } };
  }
  fixture(): Promise<Buffer> { return readFile(join(this.root, 'test-clip.pcm')); }
  private open(locale: VoiceLocale, signal: AbortSignal) {
    const ready = this.load().then(loaded => {
      signal.throwIfAborted();
      if (!loaded) throw Error('离线语音模型尚未安装');
      return new WhisperThread(this.root, loaded.bytes.buffer, locale, signal);
    });
    this.running.add(ready);
    void ready.catch(() => {});
    const close = async () => {
      await ready.then(worker => worker.close(), () => {});
      this.running.delete(ready);
    };
    return { infer: async (pcm: Uint8Array) => (await ready).run(pcm), close };
  }
  stream(locale: VoiceLocale, signal: AbortSignal, publish: (text: string) => void) {
    const thread = this.open(locale, signal);
    const stream = new UtteranceStream(thread.infer, publish, signal);
    return { append: (pcm: Buffer) => stream.append(pcm), finish: () => stream.finish(), close: thread.close };
  }
  async transcribe(pcm: Uint8Array, locale: VoiceLocale, signal: AbortSignal): Promise<string> {
    const thread = this.open(locale, AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
    try { return await thread.infer(pcm); } finally { await thread.close(); }
  }
  async stop(): Promise<void> {
    this.generation++;
    this.download?.controller.abort();
    await this.download?.done;
    await Promise.allSettled([...this.running].map(async run => (await run).close()));
  }
}

import { join } from 'node:path';
import { isExternalVoiceConnected, sameExternalVoiceSettings, type VoiceConfigPatch,
  type VoiceDiscoverModelsInput, type VoiceDiscoverModelsResult, type VoiceStateSnapshot, type VoiceTestConnectionInput,
  type VoiceTestConnectionResult, type VoiceRevokeReason, type ExternalVoiceProviderConfig, type VoiceLocale } from '../../shared/voice-contract';
import type { VoiceOwner } from '../../shared/session-owner';
import type { CoreServiceOptions } from '../core-contracts';
import type { SecretVault } from '../services/secret-vault';
import type { ClientStore } from '../storage/client-store';
import { ExternalVoice, VoiceHttpError, cooldown } from './external-voice';
import { LocalVoice } from './local-voice';
import { VoiceCapture } from './voice-capture';
import { VoiceLedger } from './voice-ledger';
import { VoiceSettings } from './voice-settings';

export class VoiceService {
  readonly ledger: VoiceLedger;
  readonly local: LocalVoice;
  readonly captures: VoiceCapture;
  private settings: VoiceSettings;
  private remote: ExternalVoice;
  private generation = new AbortController();
  private probes = new Set<Promise<unknown>>();

  constructor(store: ClientStore, vault: SecretVault, options: CoreServiceOptions, epoch: (owner: VoiceOwner) => number | undefined,
    emit: (event: string, payload: unknown) => void, usageChanged: () => void, private profile: () => string) {
    this.settings = new VoiceSettings(vault);
    this.ledger = new VoiceLedger(store, options.now ?? Date.now, usageChanged, profile);
    this.local = new LocalVoice(options.appRoot ?? join(__dirname, '../../..'), options.dataDir, options.voiceModelFetcher);
    this.remote = new ExternalVoice(this.ledger, options.voiceFetcher ?? options.modelDiscoveryFetcher);
    this.captures = new VoiceCapture({
      epoch, config: () => this.settings.current, emit, cooldown,
      ready: async engine => {
        if (engine === 'local') {
          if ((await this.local.state()).status !== 'ready') throw Error('离线语音模型尚不可用');
        } else {
          const ext = this.settings.current.externalProvider;
          if (!isExternalVoiceConnected(ext) || !this.settings.encryptionAvailable() || cooldown(ext.endpoint).cooldownUntil) throw Error('外部语音服务未就绪');
        }
      },
      requestMicrophone: options.requestMicrophone ?? (async () => true),
      stream: (locale, signal, publish) => this.local.stream(locale, signal, publish),
      transcribe: (owner, pcm, locale, signal, ext) => this.transcribe(ext!, pcm, locale, signal, owner, 'dictation'),
    });
  }
  async state(): Promise<VoiceStateSnapshot> {
    const model = await this.local.state();
    const config = this.settings.publicConfig();
    const circuit = cooldown(config.externalProvider.endpoint);
    const encryptionAvailable = this.settings.encryptionAvailable();
    return { config, model, external: { ready: encryptionAvailable && isExternalVoiceConnected(config.externalProvider) &&
      !circuit.cooldownUntil, encryptionAvailable, ...circuit }, ...this.captures.summaries(), updatedAt: new Date().toISOString() };
  }
  async update(patch: VoiceConfigPatch) {
    const previous = this.settings.current;
    this.settings.update(patch);
    if (previous.engine !== this.settings.current.engine || !sameExternalVoiceSettings(previous.externalProvider, this.settings.current.externalProvider)) {
      this.revoke('permission-revoked');
    }
    return this.state();
  }
  private async transcribe(ext: ExternalVoiceProviderConfig, pcm: Uint8Array, locale: VoiceLocale, signal: AbortSignal,
    owner: VoiceOwner, scope: 'dictation' | 'connection-test') {
    if (scope === 'dictation') {
      const current = this.settings.current.externalProvider;
      if (!sameExternalVoiceSettings(current, ext) || !isExternalVoiceConnected(current) || !this.settings.encryptionAvailable()) {
        throw Error('语音服务配置已失验');
      }
    }
    try { return await this.remote.transcribe(ext, pcm, locale, signal, owner, scope); }
    catch (error) {
      if (error instanceof VoiceHttpError && error.status === 401) this.settings.invalidate(ext);
      throw error;
    }
  }
  discover(input: VoiceDiscoverModelsInput): Promise<VoiceDiscoverModelsResult> {
    const original = this.settings.external(input);
    return this.track(this.remote.discover(original, this.generation.signal)).catch(error => {
      if (error instanceof VoiceHttpError && error.status === 401) this.settings.invalidate(original);
      throw Error('无法读取语音模型列表');
    });
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.probes.add(task);
    return task.finally(() => this.probes.delete(task));
  }
  test(input?: VoiceTestConnectionInput): Promise<VoiceTestConnectionResult> { return this.track(this.probe(input)); }
  private async probe(input?: VoiceTestConnectionInput): Promise<VoiceTestConnectionResult> {
    const started = Date.now();
    const owner = { profileId: this.profile() };
    const signal = this.generation.signal;
    const remote = input !== undefined || this.settings.current.engine === 'external-api';
    const ext = this.settings.external(input);
    const verifier = this.settings.verifier;
    if (remote) verifier.begin(ext);
    try {
      const pcm = await this.local.fixture();
      signal.throwIfAborted();
      const text = remote ? await this.transcribe(ext, pcm, 'en-US', signal, owner, 'connection-test') : await this.local.transcribe(pcm, 'en-US', signal);
      signal.throwIfAborted();
      // The expected words are checked locally, never included in a request to the provider.
      const words = text.toLowerCase().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ').trim();
      if (!/^(?:the )?library opens at (?:9|nine)(?: o'clock)? in the morning$/.test(words)) throw Error('测试语音未被正确转写');
      if (remote && !verifier.current(ext)) throw Error('测试期间配置已改变');
      const verifiedAt = remote ? verifier.accept(ext) : new Date().toISOString();
      if (remote && sameExternalVoiceSettings(ext, this.settings.current.externalProvider)) this.settings.update({});
      return { ok: true, latencyMs: Date.now() - started, verifiedAt, transcriptPreview: text.slice(0, 160) };
    } catch {
      if (remote && verifier.current(ext) && !signal.aborted && !cooldown(ext.endpoint).cooldownUntil) this.settings.invalidate(ext);
      return { ok: false, latencyMs: Date.now() - started, error: '测试语音转写未通过', ...cooldown(ext.endpoint) };
    } finally { if (remote) verifier.finish(ext); }
  }
  revoke(reason: VoiceRevokeReason, sessionId?: string): void {
    this.captures.revoke(reason, sessionId);
    if (!sessionId) {
      this.generation.abort();
      this.generation = new AbortController();
    }
  }
  async dispose(): Promise<void> {
    this.revoke('shutdown');
    await Promise.all([this.local.stop(), this.captures.drain(), Promise.allSettled([...this.probes])]);
  }
}

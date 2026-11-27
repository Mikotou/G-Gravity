import { sameExternalService } from '../../shared/approval-contract';
import { DEFAULT_VOICE_CONFIG, EXTERNAL_VOICE_DEFAULTS, isExternalVoiceConnected, sameExternalVoiceSettings,
  type ExternalVoiceProviderConfig, type VoiceConfig, type VoiceConfigPatch } from '../../shared/voice-contract';
import { ServiceVerifier } from '../llm/service-verifier';
import type { SecretVault } from '../services/secret-vault';

export class VoiceSettings {
  private config = structuredClone(DEFAULT_VOICE_CONFIG);
  readonly verifier = new ServiceVerifier(sameExternalVoiceSettings);

  constructor(private vault: SecretVault) {
    const stored = vault.loadVoiceConfig();
    try {
      const config = this.apply(stored);
      const ext = config.externalProvider;
      if (stored.externalProvider?.verifiedBy === 'transcription-call' && stored.externalProvider.connectionStatus === 'connected' &&
          vault.encryptionAvailable() && isExternalVoiceConnected({ ...ext, ...{
            enabled: true, connectionStatus: 'connected', verifiedBy: 'transcription-call', lastVerifiedAt: stored.externalProvider.lastVerifiedAt } })) {
        ext.connectionStatus = 'connected';
        ext.verifiedBy = 'transcription-call';
        ext.lastVerifiedAt = stored.externalProvider.lastVerifiedAt;
      } else ext.enabled = false;
      if (config.engine === 'external-api' && !isExternalVoiceConnected(ext)) config.engine = 'local';
      this.config = config;
    } catch { /* Invalid legacy or interrupted configuration starts with local defaults. */ }
  }

  external(patch: NonNullable<VoiceConfigPatch['externalProvider']> = {}): ExternalVoiceProviderConfig {
    const cur = this.config.externalProvider;
    const provider = patch.provider ?? cur.provider;
    if (provider !== 'gemini-api-key' && provider !== 'openai-compatible') throw Error('无效的语音服务商');
    const google = provider === 'gemini-api-key';
    const changed = provider !== cur.provider;
    const endpoint = (patch.endpoint ?? (changed ? google ? EXTERNAL_VOICE_DEFAULTS.geminiEndpoint : EXTERNAL_VOICE_DEFAULTS.openaiEndpoint : cur.endpoint)).trim();
    const model = (patch.model ?? (changed ? google ? EXTERNAL_VOICE_DEFAULTS.geminiModel : EXTERNAL_VOICE_DEFAULTS.openaiModel : cur.model)).trim();
    if (endpoint.length > 2048 || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(model)) throw Error('无效的语音服务配置');
    const apiKey = (patch.apiKey ?? (sameExternalService(cur, { provider, endpoint }) ? cur.apiKey : undefined))?.trim();
    if (apiKey && (apiKey.length > 8192 || /[\r\n]/.test(apiKey))) throw Error('无效的语音密钥');
    const timeoutMs = patch.timeoutMs ?? cur.timeoutMs;
    // An omitted field keeps the saved rate. A present empty field clears it, including over IPC.
    const suppliedRate: unknown = Object.hasOwn(patch, 'ratePerMinuteUsd') ? patch.ratePerMinuteUsd : cur.ratePerMinuteUsd;
    const rate = typeof suppliedRate === 'string' && suppliedRate.trim() === '' ? undefined : suppliedRate;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
        (rate != null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0))) throw Error('语音超时或费率无效');
    return { provider, endpoint, model, timeoutMs, apiKey, enabled: (patch.enabled ?? cur.enabled) === true,
      connectionStatus: 'untested', ...(rate != null && { ratePerMinuteUsd: rate }) };
  }
  private apply(patch: VoiceConfigPatch): VoiceConfig {
    const current = this.config;
    const engine = patch.engine ?? current.engine;
    const locale = patch.locale ?? current.locale;
    if (!['local', 'off', 'external-api'].includes(engine) || !['auto', 'zh-CN', 'en-US'].includes(locale)) throw Error('无效的语音设置');
    const device = (value: string | null | undefined, fallback?: string) => {
      if (value === undefined) return fallback;
      if (value === null) return undefined;
      if (typeof value !== 'string' || value.length > 1024) throw Error('无效的麦克风设备');
      return value;
    };
    return { engine, locale, externalProvider: this.external(patch.externalProvider),
      preferredDeviceId: device(patch.preferredDeviceId, current.preferredDeviceId),
      preferredDeviceLabel: device(patch.preferredDeviceLabel, current.preferredDeviceLabel) };
  }
  update(patch: VoiceConfigPatch): void {
    const next = this.apply(patch);
    const ext = next.externalProvider;
    const cur = this.config.externalProvider;
    const verified = this.verifier.verifiedAt(ext) || (sameExternalVoiceSettings(cur, ext) && cur.verifiedBy === 'transcription-call' && cur.lastVerifiedAt);
    if (verified) {
      ext.connectionStatus = 'connected'; ext.verifiedBy = 'transcription-call'; ext.lastVerifiedAt = verified;
    } else ext.enabled = false;
    if (next.engine === 'external-api') {
      if (verified && patch.externalProvider?.enabled !== false) ext.enabled = true;
      if (!isExternalVoiceConnected(ext)) {
        if (patch.engine === 'external-api') throw Error('请先使用短语音验证当前模型和密钥');
        next.engine = 'local';
      }
    }
    this.vault.persistVoiceConfig(next);
    this.verifier.changed(ext, false);
    this.config = next;
  }
  invalidate(candidate: ExternalVoiceProviderConfig): void {
    if (this.verifier.verifiedAt(candidate)) this.verifier.reject();
    if (!sameExternalVoiceSettings(this.config.externalProvider, candidate)) return;
    const ext = { ...this.config.externalProvider, enabled: false, connectionStatus: 'failed' as const,
      lastVerifiedAt: undefined, verifiedBy: undefined };
    this.config = { ...this.config, engine: this.config.engine === 'external-api' ? 'local' : this.config.engine, externalProvider: ext };
    this.vault.persistVoiceConfig(this.config);
  }
  get current(): Readonly<VoiceConfig> { return this.config; }
  publicConfig(): VoiceConfig {
    const info = structuredClone(this.config);
    info.externalProvider.hasApiKey = !!info.externalProvider.apiKey;
    delete info.externalProvider.apiKey;
    return info;
  }
  encryptionAvailable(passive = false): boolean { return this.vault.encryptionAvailable(passive); }
}

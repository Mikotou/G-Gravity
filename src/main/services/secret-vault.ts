import type { VoiceConfig } from '../../shared/voice-contract';
import { validateExternalEndpoint } from '../llm/external-llm-transport';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_APPROVAL_CONFIG, MAX_APPROVAL_PATTERNS_PER_KIND } from '../../shared/approval-contract';
import { compileSafePattern } from '../approval/shell-screening';
import { alignedRiskCeiling } from '../approval/external-reviewer';
import type { ClientStore } from '../storage/client-store';
import {
  hasReviewerConnectionSettings, isExternalReviewerConnected, sameExternalService,
  EXTERNAL_REVIEWER_DEFAULTS, type ExternalReviewerThinkingLevel, type ExternalReviewerConnectionStatus,
  type ApproveForMeConfig,
} from '../../shared/approval-contract';
import {
  DEFAULT_TRANSLATION_CONFIG, EXTERNAL_TRANSLATOR_DEFAULTS, isExternalTranslatorConnected,
  type ExternalTranslatorConfig, type TranslationConfig,
} from '../../shared/translation-contract';

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

const REVIEWER_SECRET_FILE = 'reviewer-secret.enc';
const TRANSLATION_CONFIG_FILE = 'translation-config.json';
const TRANSLATOR_SECRET_FILE = 'translator-secret.enc';
export const VALID_THINKING_LEVELS = new Set<ExternalReviewerThinkingLevel>(['auto', 'off', 'minimal', 'low', 'medium', 'high']);

function sanitizeStoredApprovalConfig(raw: unknown, restoredApiKey?: string): ApproveForMeConfig {
  const base = structuredClone(DEFAULT_APPROVAL_CONFIG);
  if (!raw || typeof raw !== 'object') {
    if (restoredApiKey) base.externalReviewer.apiKey = restoredApiKey;
    return base;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.mode === 'manual' || rec.mode === 'rules-only' || rec.mode === 'hybrid') base.mode = rec.mode;
  if (typeof rec.enableSafeDownloadAutoApprove === 'boolean') base.enableSafeDownloadAutoApprove = rec.enableSafeDownloadAutoApprove;
  for (const key of ['allowAlignedHighRiskPass', 'fastPassLowRiskDev'] as const) {
    if (typeof rec[key] === 'boolean') base[key] = rec[key];
  }
  if (typeof rec.alignedHighRiskMaxScore === 'number') base.alignedHighRiskMaxScore = alignedRiskCeiling(rec.alignedHighRiskMaxScore);
  if (typeof rec.maxDownloadSizeMB === 'number' && Number.isFinite(rec.maxDownloadSizeMB) && rec.maxDownloadSizeMB >= 0) {
    base.maxDownloadSizeMB = rec.maxDownloadSizeMB;
  }
  if (typeof rec.cacheTtlHours === 'number' && Number.isFinite(rec.cacheTtlHours)) {
    base.cacheTtlHours = Math.min(168, Math.max(0, rec.cacheTtlHours));
  }
  for (const field of ['allowPatterns', 'askPatterns', 'denyPatterns'] as const) {
    if (Array.isArray(rec[field])) {
      const valid: string[] = [];
      for (const item of rec[field] as unknown[]) {
        if (typeof item !== 'string' || valid.length >= MAX_APPROVAL_PATTERNS_PER_KIND) continue;
        try { compileSafePattern(item); valid.push(item); } catch { /* 跳过损坏的旧正则，保留其余全部规则 */ }
      }
      base[field] = valid;
    }
  }
  if (rec.externalReviewer && typeof rec.externalReviewer === 'object') {
    const ext = rec.externalReviewer as Record<string, unknown>;
    if (ext.provider === 'gemini-api-key' || ext.provider === 'openai-compatible' || ext.provider === 'local-ollama') {
      base.externalReviewer.provider = ext.provider;
    }
    if (typeof ext.endpoint === 'string' && ext.endpoint.trim()) base.externalReviewer.endpoint = ext.endpoint.trim();
    if (typeof ext.model === 'string' && ext.model.trim()) base.externalReviewer.model = ext.model.trim();
    if (typeof ext.timeoutMs === 'number' && Number.isFinite(ext.timeoutMs)) {
      base.externalReviewer.timeoutMs = Math.min(60_000, Math.max(100, Math.round(ext.timeoutMs)));
    }
    if (typeof ext.maxOutputTokens === 'number' && Number.isFinite(ext.maxOutputTokens)) {
      base.externalReviewer.maxOutputTokens = Math.min(65_536, Math.max(64, Math.round(ext.maxOutputTokens)));
    } else {
      base.externalReviewer.maxOutputTokens = EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens;
    }
    // 兼容旧版保存的 reasoningEffort 字段，平滑迁移到 thinkingLevel
    const rawLevel = typeof ext.thinkingLevel === 'string'
      ? ext.thinkingLevel
      : typeof ext.reasoningEffort === 'string'
        ? ext.reasoningEffort
        : undefined;
    if (rawLevel && VALID_THINKING_LEVELS.has(rawLevel.toLowerCase() as ExternalReviewerThinkingLevel)) {
      base.externalReviewer.thinkingLevel = rawLevel.toLowerCase() as ExternalReviewerThinkingLevel;
    }
    if (ext.connectionStatus === 'untested' || ext.connectionStatus === 'connected' || ext.connectionStatus === 'failed') {
      base.externalReviewer.connectionStatus = ext.connectionStatus as ExternalReviewerConnectionStatus;
    }
    if (typeof ext.lastVerifiedAt === 'string' && ext.lastVerifiedAt.trim()) {
      base.externalReviewer.lastVerifiedAt = ext.lastVerifiedAt.trim();
    }
    if (ext.verificationMethod === 'review-call' && (!(rec.requiresStoredCredential || rec.storedCredential) || restoredApiKey)) {
      base.externalReviewer.verificationMethod = 'review-call';
    }
    else {
      base.externalReviewer.connectionStatus = 'untested';
      delete base.externalReviewer.lastVerifiedAt;
    }
    const effectiveKey = restoredApiKey || (typeof ext.apiKey === 'string' && ext.apiKey.trim() ? ext.apiKey.trim() : undefined);
    if (effectiveKey) base.externalReviewer.apiKey = effectiveKey;
    const wantsEnabled = Boolean(ext.enabled);
    if (wantsEnabled) {
      try {
        validateExternalEndpoint({ ...base.externalReviewer, enabled: true });
        base.externalReviewer.enabled = isExternalReviewerConnected({ ...base.externalReviewer, enabled: true });
      } catch {
        // 仅当远端服务缺少可恢复密钥或地址无效时自动回落关闭，其余字段原样保留
        base.externalReviewer.enabled = false;
      }
    }
  }
  // 严格遵循：未正常连接外部复核时不允许处于 AI 代审（hybrid），自动降级为基础规则通过机制（rules-only）
  if (base.mode === 'hybrid' && !isExternalReviewerConnected(base.externalReviewer)) {
    base.mode = 'rules-only';
  }
  return base;
}

/**
 * 启动期单键容错恢复独立外部翻译配置：
 * - 完整保留跨版本更新与重启后的已填字段（服务商/端点/模型/思考强度/超时/上限）与密文恢复后的 API Key；
 * - 若 `engine === 'external-api'` 但密钥缺失或未满足连通条件，安全回退 `engine = 'local'` 且不丢弃已保存字段。
 */
export function sanitizeStoredTranslationConfig(raw: unknown, restoredApiKey?: string): TranslationConfig {
  const base = structuredClone(DEFAULT_TRANSLATION_CONFIG);
  if (!raw || typeof raw !== 'object') {
    if (restoredApiKey) base.externalTranslator.apiKey = restoredApiKey;
    return base;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.engine === 'local' || rec.engine === 'external-api') {
    base.engine = rec.engine;
  }
  if (rec.externalTranslator && typeof rec.externalTranslator === 'object') {
    const ext = rec.externalTranslator as Record<string, unknown>;
    if (ext.provider === 'gemini-api-key' || ext.provider === 'openai-compatible' || ext.provider === 'local-ollama') {
      base.externalTranslator.provider = ext.provider;
    }
    if (typeof ext.endpoint === 'string' && ext.endpoint.trim()) {
      base.externalTranslator.endpoint = ext.endpoint.trim();
    }
    if (typeof ext.model === 'string' && ext.model.trim()) {
      base.externalTranslator.model = ext.model.trim();
    }
    if (typeof ext.timeoutMs === 'number' && Number.isFinite(ext.timeoutMs)) {
      base.externalTranslator.timeoutMs = Math.min(60_000, Math.max(100, Math.round(ext.timeoutMs)));
    }
    if (typeof ext.maxOutputTokens === 'number' && Number.isFinite(ext.maxOutputTokens)) {
      base.externalTranslator.maxOutputTokens = Math.min(65_536, Math.max(64, Math.round(ext.maxOutputTokens)));
    } else {
      base.externalTranslator.maxOutputTokens = EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens;
    }
    if (typeof ext.thinkingLevel === 'string' && VALID_THINKING_LEVELS.has(ext.thinkingLevel.toLowerCase() as ExternalReviewerThinkingLevel)) {
      base.externalTranslator.thinkingLevel = ext.thinkingLevel.toLowerCase() as ExternalReviewerThinkingLevel;
    }
    if (ext.connectionStatus === 'untested' || ext.connectionStatus === 'connected' || ext.connectionStatus === 'failed') {
      base.externalTranslator.connectionStatus = ext.connectionStatus as ExternalReviewerConnectionStatus;
    }
    if (typeof ext.lastVerifiedAt === 'string' && ext.lastVerifiedAt.trim()) {
      base.externalTranslator.lastVerifiedAt = ext.lastVerifiedAt.trim();
    }
    const effectiveKey =
      restoredApiKey || (typeof ext.apiKey === 'string' && ext.apiKey.trim() ? ext.apiKey.trim() : undefined);
    if (effectiveKey) base.externalTranslator.apiKey = effectiveKey;
    if (ext.verifiedBy === 'translation-call' && (!(rec.requiresStoredCredential || rec.storedCredential) || restoredApiKey) &&
      base.externalTranslator.connectionStatus === 'connected' &&
        base.externalTranslator.lastVerifiedAt && hasReviewerConnectionSettings(base.externalTranslator)) {
      base.externalTranslator.verifiedBy = 'translation-call';
    } else {
      base.externalTranslator.connectionStatus = ext.connectionStatus === 'failed' ? 'failed' : 'untested';
      delete base.externalTranslator.lastVerifiedAt;
    }
    const wantsEnabled = ext.enabled && base.externalTranslator.verifiedBy === 'translation-call';
    if (wantsEnabled) {
      try {
        validateExternalEndpoint({ ...base.externalTranslator, enabled: true });
        base.externalTranslator.enabled = true;
      } catch {
        // 远端服务缺少可恢复密钥或地址无效时自动回落关闭，保留其余全部已保存字段
        base.externalTranslator.enabled = false;
      }
    }
  } else if (restoredApiKey) {
    base.externalTranslator.apiKey = restoredApiKey;
  }
  if (base.engine === 'external-api' && !isExternalTranslatorConnected(base.externalTranslator)) {
    base.engine = 'local';
  }
  return base;
}


export function publicApprovalConfig(config: ApproveForMeConfig): ApproveForMeConfig {
  const snapshot = structuredClone(config);
  snapshot.externalReviewer.hasApiKey = Boolean(snapshot.externalReviewer.apiKey?.trim());
  delete snapshot.externalReviewer.apiKey;
  return snapshot;
}

export function publicTranslationConfig(config: TranslationConfig): TranslationConfig {
  const snapshot = structuredClone(config);
  snapshot.externalTranslator.hasApiKey = Boolean(snapshot.externalTranslator.apiKey?.trim());
  delete snapshot.externalTranslator.apiKey;
  return snapshot;
}

type SecretField = 'externalReviewer' | 'externalTranslator' | 'externalProvider';
type ServiceCredential = Pick<ExternalTranslatorConfig, 'provider' | 'endpoint' | 'apiKey'>;
function voiceProof(value: Partial<VoiceConfig['externalProvider']>, id?: string): string {
  return createHash('sha256').update(JSON.stringify([value.provider, value.endpoint, value.model, value.timeoutMs, id])).digest('hex');
}
export class SecretVault {
  constructor(private store: ClientStore, private cipher?: SecretCipher) {}

  loadApprovalConfig(): ApproveForMeConfig {
    const raw = this.store.read<unknown>('approval-config.json', null);
    return sanitizeStoredApprovalConfig(raw, this.loadStoredServiceKey(REVIEWER_SECRET_FILE, raw, 'externalReviewer'));
  }

  loadTranslationConfig(): TranslationConfig {
    const raw = this.store.read<unknown>(TRANSLATION_CONFIG_FILE, null);
    return sanitizeStoredTranslationConfig(raw, this.loadStoredServiceKey(TRANSLATOR_SECRET_FILE, raw, 'externalTranslator'));
  }
  private loadStoredServiceKey(file: string, raw: unknown, field: SecretField): string | undefined {
    const saved = raw as { storedCredential?: boolean; credentialId?: string; externalTranslator?: ExternalTranslatorConfig; externalReviewer?: ServiceCredential; externalProvider?: ServiceCredential } | null;
    const service = saved?.[field];
    if (!service || saved?.storedCredential === false) return undefined;
    const cipher = this.cipher;
    if (!cipher?.isAvailable()) return undefined;
    const blob = this.store.readEncryptedBlob(file);
    if (!blob || blob.length === 0) return undefined;
    try {
      const plain = cipher.decrypt(blob).trim();
      if (!plain.startsWith('gravity-key-v1:')) return field === 'externalProvider' || saved?.credentialId ? undefined : plain || undefined;
      const envelope = JSON.parse(plain.slice('gravity-key-v1:'.length));
      if (saved?.credentialId !== envelope.credentialId) return undefined;
      return typeof envelope.key === 'string' && sameExternalService(envelope, service) ? envelope.key : undefined;
    } catch {
      return undefined;
    }
  }
  private saveServiceConfig(
    file: string, secretFile: string, persisted: object, field: SecretField,
    service: ServiceCredential, clear: boolean
  ): void {
    const previous = this.store.read<Partial<Record<typeof field, ServiceCredential>> & { storedCredential?: boolean; credentialId?: string }>(file, {});
    const previousService = previous?.[field];
    let storedCredential = !clear && previousService && sameExternalService(previousService, service)
      ? previous.storedCredential : false;
    let credentialId = storedCredential ? previous.credentialId : undefined;
    let replaced: { previous: Buffer | null } | undefined;
    const key = service.apiKey?.trim();
    if (key && !(credentialId && key === this.loadStoredServiceKey(secretFile, previous, field))) {
      storedCredential = false;
      credentialId = undefined;
      const cipher = this.cipher;
      if (cipher?.isAvailable()) {
        const id = randomUUID();
        let encrypted: Buffer | undefined;
        try {
          const envelope = { provider: service.provider, endpoint: service.endpoint, key, credentialId: id };
          encrypted = cipher.encrypt('gravity-key-v1:' + JSON.stringify(envelope));
        } catch { /* The key can still be used for this run. */ }
        if (encrypted) {
          replaced = { previous: this.store.readEncryptedBlob(secretFile) };
          this.store.writeEncryptedBlob(secretFile, encrypted);
          credentialId = id;
          storedCredential = true;
        }
      }
    }
    if (field === 'externalProvider' && key && !storedCredential) throw Error('系统安全加密不可用，无法保存语音密钥');
    try {
      const voice = field === 'externalProvider' ? (persisted as VoiceConfig).externalProvider : undefined;
      const verified = voice?.verifiedBy === 'transcription-call' ? voiceProof(voice, credentialId) : undefined;
      this.store.write(file, { ...persisted, storedCredential, credentialId, requiresStoredCredential: Boolean(key || storedCredential),
        ...(verified && { voiceProof: verified }) });
    } catch (error) {
      if (replaced) {
        try {
          if (replaced.previous) this.store.writeEncryptedBlob(secretFile, replaced.previous);
          else this.store.deleteEncryptedBlob(secretFile);
        } catch { /* Preserve the commit error. Mismatched credential IDs fail closed on load. */ }
      }
      throw error;
    }
    if (storedCredential === false) this.store.deleteEncryptedBlob(secretFile);
  }
  encryptionAvailable(): boolean { return this.cipher?.isAvailable() === true; }
  loadVoiceConfig(): Partial<VoiceConfig> {
    const raw = this.store.read<Partial<VoiceConfig> & { requiresStoredCredential?: boolean; storedCredential?: boolean; voiceProof?: string; credentialId?: string }>('voice-config.json', {});
    if (!raw?.externalProvider || typeof raw.externalProvider.endpoint !== 'string') return {};
    const apiKey = this.loadStoredServiceKey('voice-secret.enc', raw, 'externalProvider');
    const service = { ...raw.externalProvider, hasApiKey: undefined, apiKey };
    if ((!apiKey && (raw.requiresStoredCredential || raw.storedCredential)) || raw.voiceProof !== voiceProof(service, raw.credentialId)) {
      service.enabled = false;
      service.connectionStatus = 'untested';
      delete service.verifiedBy;
      delete service.lastVerifiedAt;
    }
    return { ...raw, externalProvider: service };
  }
  persistVoiceConfig(config: VoiceConfig): void {
    const persisted = structuredClone(config);
    delete persisted.externalProvider.apiKey;
    delete persisted.externalProvider.hasApiKey;
    if (config.externalProvider.enabled && !this.encryptionAvailable()) throw Error('启用外部转写需要系统安全存储');
    this.saveServiceConfig('voice-config.json', 'voice-secret.enc', persisted, 'externalProvider', config.externalProvider,
      !config.externalProvider.apiKey);
  }
  persistApprovalConfig(config: ApproveForMeConfig): void {
    // approval-config.json 永不存明文密钥；系统支持 safeStorage 时将密文单独存入 reviewer-secret.enc，更新重启自动恢复。
    const persisted = structuredClone(config);
    delete persisted.externalReviewer.apiKey;
    delete persisted.externalReviewer.hasApiKey;
    this.saveServiceConfig('approval-config.json', REVIEWER_SECRET_FILE, persisted, 'externalReviewer',
      config.externalReviewer, config.externalReviewer.apiKey === '');
  }
  persistTranslationConfig(config: TranslationConfig, clearedApiKey = false): void {
    // translation-config.json 永不存明文密钥；系统支持 safeStorage 时将密文单独存入 translator-secret.enc，更新重启自动恢复。
    const persisted = structuredClone(config);
    delete persisted.externalTranslator.apiKey;
    delete persisted.externalTranslator.hasApiKey;
    this.saveServiceConfig(TRANSLATION_CONFIG_FILE, TRANSLATOR_SECRET_FILE, persisted, 'externalTranslator',
      config.externalTranslator, clearedApiKey);
  }
}

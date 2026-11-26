/**
 * Gravity v0.2.4 — 思考翻译引擎配置契约（默认内置离线 Bergamot 44MB，可选独立外部翻译 API）
 *
 * 与外部复核（AI 代审 `ApproveForMeConfig.externalReviewer`）完全独立配置、独立加密持久化。
 */

import { hasReviewerConnectionSettings } from './approval-contract';
import type {
  ExternalReviewerConnectionStatus,
  ExternalReviewerThinkingLevel,
} from './approval-contract';
import type {
  ExternalReviewerProviderId,
  FourDimTokenCounts,
} from './telemetry-contract';

export type TranslationEngineMode = 'local' | 'external-api';

export const EXTERNAL_TRANSLATOR_DEFAULTS = {
  provider: 'gemini-api-key' as ExternalReviewerProviderId,
  endpoint: 'https://generativelanguage.googleapis.com',
  model: 'gemini-2.5-flash-lite',
  thinkingLevel: 'off' as ExternalReviewerThinkingLevel,
  maxOutputTokens: 2048,
  timeoutMs: 8000,
} as const;

export interface ExternalTranslatorConfig {
  enabled: boolean;
  provider: ExternalReviewerProviderId;
  endpoint: string;
  model: string;
  apiKey?: string;
  /** 思考强度（翻译场景默认 'off'，可按服务端模型能力调整） */
  thinkingLevel?: ExternalReviewerThinkingLevel;
  /** 单次翻译最大输出 token 上限，默认 2048 */
  maxOutputTokens?: number;
  /** 单次翻译请求超时（ms），默认 8000 */
  timeoutMs: number;
  /** 外部翻译连接探测状态 */
  connectionStatus?: ExternalReviewerConnectionStatus;
  /** 最近一次验证连通的时间（ISO 字符串） */
  lastVerifiedAt?: string;
  verifiedBy?: 'translation-call';
  /** 主进程安全投影标记：是否已保存该服务商/源的密钥（永不向渲染层回传明文 Key） */
  hasApiKey?: boolean;
}

export interface TranslationConfig {
  engine: TranslationEngineMode;
  externalTranslator: ExternalTranslatorConfig;
}

export interface TranslationConfigPatch {
  engine?: TranslationEngineMode;
  externalTranslator?: Partial<ExternalTranslatorConfig>;
}

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  engine: 'local',
  externalTranslator: {
    enabled: false,
    provider: EXTERNAL_TRANSLATOR_DEFAULTS.provider,
    endpoint: EXTERNAL_TRANSLATOR_DEFAULTS.endpoint,
    model: EXTERNAL_TRANSLATOR_DEFAULTS.model,
    thinkingLevel: EXTERNAL_TRANSLATOR_DEFAULTS.thinkingLevel,
    maxOutputTokens: EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens,
    timeoutMs: EXTERNAL_TRANSLATOR_DEFAULTS.timeoutMs,
    connectionStatus: 'untested',
  },
};

export interface ExternalTranslatorTestResult {
  ok: boolean;
  latencyMs: number;
  verifiedAt?: string;
  sampleTranslation?: string;
  error?: string;
  usage?: FourDimTokenCounts & { totalTokens?: number };
}

export function sameTranslatorSettings(a: ExternalTranslatorConfig, b: ExternalTranslatorConfig): boolean {
  return a.provider === b.provider && a.endpoint.trim() === b.endpoint.trim() &&
    a.model.trim() === b.model.trim() && (a.apiKey?.trim() || '') === (b.apiKey?.trim() || '') &&
    a.timeoutMs === b.timeoutMs &&
    (a.maxOutputTokens ?? EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens) === (b.maxOutputTokens ?? EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens) &&
    (a.thinkingLevel ?? EXTERNAL_TRANSLATOR_DEFAULTS.thinkingLevel) === (b.thinkingLevel ?? EXTERNAL_TRANSLATOR_DEFAULTS.thinkingLevel);
}

export function isExternalTranslatorConnected(cfg?: Partial<ExternalTranslatorConfig> | null): boolean {
  return Boolean(cfg?.enabled && cfg.connectionStatus === 'connected' && cfg.verifiedBy === 'translation-call' &&
    cfg.lastVerifiedAt && Number.isFinite(Date.parse(cfg.lastVerifiedAt)) && hasReviewerConnectionSettings(cfg));
}

/** Some services echo an enclosing source element. Preserve literal tags in the user's text. */
export function cleanTranslationEnvelope(translated: string, original: string): string {
  const trimmed = translated.trim();
  if (/^<source>[\s\S]*<\/source>$/i.test(original.trim())) return trimmed;
  return /^<source>([\s\S]*)<\/source>$/i.exec(trimmed)?.[1].trim() ?? trimmed;
}

/**
 * Gravity v0.3.6 — 100% 合规语音听写契约（本地离线 Whisper WASM + 可选外部兼容转写 API）
 *
 * 合规红线：
 * 1. 严禁向官方 `agy acp` 发送音频或伪造官方语音 RPC，严禁使用 Chromium Web Speech；
 * 2. Whisper WASM 仅运行在主进程 `worker_threads`，渲染层保持 `script-src 'self'` 无放宽；
 * 3. 麦克风权限静息态恒拒绝，仅在 `VOICE_ARM_CAPTURE` 短时音频租约内放行纯音频；
 * 4. `VOICE_APPEND` 为唯一二进制白名单切口（`args[0].pcm16` 定长正偶数 1..32768 字节）。
 */

import {
  isAllowedOpenAiCompatibleEndpoint,
  type ExternalReviewerConnectionStatus,
  type ExternalReviewerModelOption,
} from './approval-contract';
import type { VoiceOwner } from './session-owner';

export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_CHANNELS = 1;
export const VOICE_BYTES_PER_SAMPLE = 2;
/** 单次听写硬上限：3 分 30 秒（210 秒） */
export const VOICE_MAX_DURATION_MS = 210_000;
/** 210 秒 × 16,000 Hz × 2 字节 = 6,720,000 字节 */
export const VOICE_MAX_PCM_BYTES = 6_720_000;
/** PCM 上限 + 44 字节内存 RIFF/WAV 头 */
export const VOICE_MAX_WAV_BYTES = 6_720_044;
/** `VOICE_APPEND` 单块最大字节数（32 KiB，必须为正偶数） */
export const VOICE_APPEND_MAX_BYTES = 32_768;
/** 默认每 0.5 秒分片字节数（8,000 样本 × 2 字节） */
export const VOICE_DEFAULT_CHUNK_BYTES = 16_000;
/** 设置页 3 秒本地试录上限（0 外联、0 计费） */
export const VOICE_MIC_TEST_MAX_DURATION_MS = 3_000;
export const VOICE_MIC_TEST_MAX_BYTES = 96_000;

/** 固定上游版本与强 SHA-256 校验的离线多语 Whisper 权重元数据（MIT 许可） */
export const VOICE_LOCAL_MODEL_SPEC = {
  id: 'ggml-base-q5_1',
  fileName: 'ggml-base-q5_1.bin',
  repo: 'ggerganov/whisper.cpp',
  commit: '5359861c739e955e79d9a303bcbc70fb988958b1',
  sizeBytes: 59_707_625,
  sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  license: 'MIT',
  downloadUrl:
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin',
} as const;

export type VoiceEngineMode = 'off' | 'local' | 'external-api';
export type VoiceExternalProviderId = 'openai-compatible' | 'gemini-api-key';
export type VoiceLocale = 'auto' | 'zh-CN' | 'en-US';
export type VoiceCapturePurpose = 'dictation' | 'device-list' | 'mic-test';
export type VoiceCaptureControlOp = 'media-ready' | 'release-media';
export type VoiceLocalModelStatus = 'ready' | 'missing' | 'downloading' | 'verifying' | 'loading' | 'error';

export const EXTERNAL_VOICE_DEFAULTS = {
  provider: 'openai-compatible' as VoiceExternalProviderId,
  openaiEndpoint: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini-transcribe',
  geminiEndpoint: 'https://generativelanguage.googleapis.com',
  geminiModel: 'gemini-2.5-flash',
  timeoutMs: 25_000,
} as const;

export interface ExternalVoiceProviderConfig {
  enabled: boolean;
  provider: VoiceExternalProviderId;
  endpoint: string;
  model: string;
  /** 仅用于从渲染层提交新密钥；主进程永不回传明文 */
  apiKey?: string;
  /** 主进程安全投影标记：是否已在 SecretVault 保存该服务商/源密钥 */
  hasApiKey?: boolean;
  timeoutMs: number;
  /** 可选：用户配置的参考每分钟单价（USD/min）；未设置时计费依据标为 unknown */
  ratePerMinuteUsd?: number;
  connectionStatus?: ExternalReviewerConnectionStatus;
  lastVerifiedAt?: string;
  verifiedBy?: 'transcription-call';
}

export interface VoiceConfig {
  engine: VoiceEngineMode;
  locale: VoiceLocale;
  preferredDeviceId?: string;
  preferredDeviceLabel?: string;
  externalProvider: ExternalVoiceProviderConfig;
}

export interface VoiceConfigPatch {
  engine?: VoiceEngineMode;
  locale?: VoiceLocale;
  preferredDeviceId?: string | null;
  preferredDeviceLabel?: string | null;
  externalProvider?: Partial<ExternalVoiceProviderConfig>;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  engine: 'local',
  locale: 'auto',
  externalProvider: {
    enabled: false,
    provider: EXTERNAL_VOICE_DEFAULTS.provider,
    endpoint: EXTERNAL_VOICE_DEFAULTS.openaiEndpoint,
    model: EXTERNAL_VOICE_DEFAULTS.openaiModel,
    timeoutMs: EXTERNAL_VOICE_DEFAULTS.timeoutMs,
    connectionStatus: 'untested',
  },
};

export interface VoiceModelState {
  status: VoiceLocalModelStatus;
  modelId: string;
  fileName: string;
  source?: 'bundled' | 'user-data';
  expectedBytes: number;
  downloadedBytes?: number;
  progressPercent?: number;
  sha256Verified: boolean;
  error?: string;
}

export interface VoiceExternalRuntimeState {
  ready: boolean;
  encryptionAvailable: boolean;
  cooldownUntil?: string;
  cooldownKind?: 'rate_limit_429' | 'permission_403';
  lastError?: string;
}

export interface VoiceActiveCaptureSummary {
  captureId: string;
  owner: VoiceOwner;
  epoch: number;
  purpose: VoiceCapturePurpose;
  engine: Exclude<VoiceEngineMode, 'off'>;
  state: 'armed' | 'capturing' | 'sealed' | 'finishing';
  acceptedBytes: number;
  acceptedSeq: number;
}

export interface VoiceHeldCaptureSummary {
  captureId: string;
  owner: VoiceOwner;
  epoch: number;
  durationMs: number;
  acceptedBytes: number;
  expiresAt: string;
}

export interface VoiceStateSnapshot {
  config: VoiceConfig;
  model: VoiceModelState;
  external: VoiceExternalRuntimeState;
  activeCapture?: VoiceActiveCaptureSummary | null;
  heldCapture?: VoiceHeldCaptureSummary | null;
  updatedAt: string;
}

export interface VoiceDiscoverModelsInput {
  provider: VoiceExternalProviderId;
  endpoint: string;
  apiKey?: string;
}

export interface VoiceDiscoverModelsResult {
  provider: VoiceExternalProviderId;
  endpoint: string;
  models: ExternalReviewerModelOption[];
  fetchedAt: string;
}

export type VoiceTestConnectionInput = Partial<ExternalVoiceProviderConfig>;

export interface VoiceTestConnectionResult {
  ok: boolean;
  latencyMs: number;
  verifiedAt?: string;
  transcriptPreview?: string;
  error?: string;
  cooldownUntil?: string;
  cooldownKind?: 'rate_limit_429' | 'permission_403';
}

export interface VoiceInstallModelInput {
  action?: 'start' | 'cancel';
}

export interface VoiceInstallModelResult {
  started: boolean;
  state: VoiceModelState;
  message?: string;
}

export interface VoiceArmCaptureRequest {
  op?: 'arm';
  owner: VoiceOwner;
  locale?: VoiceLocale;
  purpose?: VoiceCapturePurpose;
  deviceId?: string;
}

/** 复用 `VOICE_ARM_CAPTURE` 的两个窄控制操作（绝不签发新权限租约） */
export interface VoiceCaptureControlRequest {
  op: VoiceCaptureControlOp;
  captureId: string;
  /** 外部模式被动切入设置等场景仅封存至 held，不触发 finish/上传 */
  hold?: boolean;
}

export type VoiceArmCaptureInput = VoiceArmCaptureRequest | VoiceCaptureControlRequest;

export function isVoiceCaptureControlRequest(
  input: VoiceArmCaptureInput
): input is VoiceCaptureControlRequest {
  return input.op === 'media-ready' || input.op === 'release-media';
}

export interface VoiceArmCaptureResult {
  captureId: string;
  owner: VoiceOwner;
  epoch: number;
  purpose: VoiceCapturePurpose;
  engine: VoiceEngineMode;
  sampleRate: number;
  maxDurationMs: number;
  maxPcmBytes: number;
  state: 'armed' | 'capturing' | 'sealed' | 'released';
  expiresAt?: string;
}

export interface VoiceAppendInput {
  captureId: string;
  seq: number;
  /** 唯一二进制白名单字段：定长非共享 ArrayBuffer 或零偏移整段 Uint8Array（1..32768 偶数字节） */
  pcm16: Uint8Array | ArrayBuffer;
}

export interface VoiceAppendResult {
  captureId: string;
  accepted: boolean;
  seq: number;
  expectedSeq?: number;
  acceptedBytes: number;
  remainingBytes: number;
  capped?: boolean;
  reason?: string;
}

export interface VoiceFinishInput {
  captureId: string;
  finalChunkSeq?: number;
}

export interface VoiceFinishResult {
  captureId: string;
  status: 'finishing' | 'settled' | 'already-settled' | 'aborted';
  acceptedSeq: number;
  acceptedBytes: number;
  incompleteTail?: boolean;
  finalSeq?: number;
  text?: string;
  error?: string;
}

export interface VoiceAbortInput {
  captureId: string;
  reason?: string;
}

export interface VoiceAbortResult {
  captureId: string;
  aborted: boolean;
  remoteRequestInFlight?: boolean;
}

export interface VoiceSegmentEvent {
  owner: VoiceOwner;
  epoch: number;
  captureId: string;
  /** 文本段单调序号（1-based，独立于 PCM 块序号） */
  seq: number;
  text: string;
  isFinal?: boolean;
  language?: string;
}

export interface VoiceSettledEvent {
  owner: VoiceOwner;
  epoch: number;
  captureId: string;
  /** 最后一个已发文本段号（0 表示无分段增量，由 `text` 承载最终文本或空串） */
  finalSeq: number;
  text: string;
  durationMs: number;
  engine: Exclude<VoiceEngineMode, 'off'>;
  outcome: 'completed' | 'aborted' | 'error';
  incompleteTail?: boolean;
  error?: string;
  cooldownUntil?: string;
  cooldownKind?: 'rate_limit_429' | 'permission_403';
}

export type VoiceRevokeReason =
  | 'preempted'
  | 'profile-switched'
  | 'session-closed'
  | 'window-closed'
  | 'timeout'
  | 'permission-revoked'
  | 'shutdown'
  | 'device-error';

export interface VoiceCaptureRevokedEvent {
  owner: VoiceOwner;
  epoch: number;
  captureId: string;
  reason: VoiceRevokeReason;
  message?: string;
  held?: boolean;
}

/** 独立外部语音转写用量与费用账本（按时长计量，绝不混入 ACP Token 热力图） */
export type VoiceCostBasis = 'provider-direct' | 'estimated-per-minute' | 'unknown';
export type VoiceUsageOutcome = 'completed' | 'aborted' | 'error';

export interface VoiceProviderUsageBreakdown {
  key: string;
  provider: VoiceExternalProviderId;
  endpointHost: string;
  modelId: string;
  callCount: number;
  completedCount: number;
  errorCount: number;
  totalDurationMs: number;
  knownCostUsd: number;
  hasUnknownCost: boolean;
  costBasis: VoiceCostBasis;
}

export interface VoiceRangeUsageSummary {
  callCount: number;
  totalDurationMs: number;
  knownCostUsd: number;
  hasUnknownCost: boolean;
}

export interface VoiceExternalTelemetrySnapshot {
  cumulativeCalls: number;
  completedCalls: number;
  errorCalls: number;
  totalDurationMs: number;
  knownCostUsd: number;
  hasUnknownCost: boolean;
  byRange: Record<'today' | '7d' | '30d', VoiceRangeUsageSummary>;
  providers: VoiceProviderUsageBreakdown[];
  updatedAt: string;
}

export function hasExternalVoiceSettings(cfg?: Partial<ExternalVoiceProviderConfig> | null): boolean {
  if (!cfg) return false;
  const model = typeof cfg.model === 'string' ? cfg.model.trim() : '';
  if (!model || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(model)) return false;
  const rawEndpoint = typeof cfg.endpoint === 'string' ? cfg.endpoint.trim() : '';
  if (!rawEndpoint) return false;
  try {
    const url = new URL(rawEndpoint);
    if (url.username || url.password || url.search || url.hash) return false;
    const isLoopbackHttp = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!isLoopbackHttp && !key && !cfg.hasApiKey) return false;
    if (cfg.provider === 'gemini-api-key') {
      if (isLoopbackHttp) return true;
      return (
        url.hostname === 'generativelanguage.googleapis.com' &&
        url.protocol === 'https:' &&
        (!url.port || url.port === '443')
      );
    }
    if (cfg.provider === 'openai-compatible') {
      return isAllowedOpenAiCompatibleEndpoint(url);
    }
    return false;
  } catch {
    return false;
  }
}

export function isExternalVoiceConnected(cfg?: Partial<ExternalVoiceProviderConfig> | null): boolean {
  return Boolean(
    cfg?.enabled &&
      cfg.connectionStatus === 'connected' &&
      cfg.verifiedBy === 'transcription-call' &&
      cfg.lastVerifiedAt &&
      Number.isFinite(Date.parse(cfg.lastVerifiedAt)) &&
      hasExternalVoiceSettings(cfg)
  );
}

export function sameExternalVoiceSettings(
  a: ExternalVoiceProviderConfig,
  b: ExternalVoiceProviderConfig
): boolean {
  return (
    a.provider === b.provider &&
    a.endpoint.trim() === b.endpoint.trim() &&
    a.model.trim() === b.model.trim() &&
    (a.apiKey?.trim() || '') === (b.apiKey?.trim() || '') &&
    a.timeoutMs === b.timeoutMs
  );
}

/** 校验 `VOICE_APPEND` 唯一二进制参数：定长非共享 ArrayBuffer 或零偏移整段 Uint8Array，1..32768 偶数字节。 */
export function isValidVoicePcm16Buffer(value: unknown): value is Uint8Array | ArrayBuffer {
  let byteLength = 0;
  let backing: unknown;
  if (value instanceof ArrayBuffer) {
    backing = value;
    byteLength = value.byteLength;
  } else if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype) {
    backing = value.buffer;
    if (!(backing instanceof ArrayBuffer)) return false;
    if (value.byteOffset !== 0 || value.byteLength !== backing.byteLength) return false;
    byteLength = value.byteLength;
  } else {
    return false;
  }
  if (!(backing instanceof ArrayBuffer)) return false;
  const resizable = (backing as { resizable?: boolean }).resizable;
  const detached = (backing as { detached?: boolean }).detached;
  if (resizable === true || detached === true) return false;
  return byteLength > 0 && byteLength <= VOICE_APPEND_MAX_BYTES && byteLength % 2 === 0;
}

const CJK_CHAR = '[\\u3400-\\u9fff\\uf900-\\ufaff]';
const CJK_PUNCT = '[，。！？；：、（）【】《》「」『』]';
const CJK_INNER_SPACE_RE = new RegExp(`(${CJK_CHAR})[ \\t]+(?=${CJK_CHAR})`, 'g');
const CJK_BEFORE_PUNCT_RE = new RegExp(`(${CJK_CHAR})[ \\t]+(?=${CJK_PUNCT})`, 'g');
const CJK_AFTER_PUNCT_RE = new RegExp(`(${CJK_PUNCT})[ \\t]+(?=${CJK_CHAR})`, 'g');

/**
 * 语音转写文本拼接清洗：
 * - 消除 Whisper 中文输出里常见的汉字间多余空格（如 `你 好 世 界` → `你好世界`）；
 * - 严格保留英文词组与符号间空格（如 `Professional / Elite`）、URL、路径与行内代码；
 * - 衔接前段与新段时按边界字符类型自动补/去单个空格。
 */
export function normalizeDictationText(
  previous: string,
  incoming: string,
  _locale: VoiceLocale = 'auto'
): string {
  const cleanedIncoming = (incoming || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .replace(CJK_INNER_SPACE_RE, '$1')
    .replace(CJK_BEFORE_PUNCT_RE, '$1')
    .replace(CJK_AFTER_PUNCT_RE, '$1');

  if (!cleanedIncoming) return '';
  if (!previous) return cleanedIncoming;

  const prevLast = previous.slice(-1);
  const nextFirst = cleanedIncoming[0];
  const isCjkOrPunct = (ch: string) => /[\u3400-\u9fff\uf900-\ufaff，。！？；：、（）【】《》「」『』]/.test(ch);
  if (/\s/.test(prevLast) || isCjkOrPunct(prevLast) || isCjkOrPunct(nextFirst) || /^[,.;:!?)]/.test(nextFirst)) {
    return cleanedIncoming;
  }
  return ` ${cleanedIncoming}`;
}

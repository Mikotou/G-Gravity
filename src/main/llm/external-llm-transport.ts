import {
  EXTERNAL_REVIEWER_DEFAULTS, inferSupportedThinkingLevels, isAllowedOpenAiCompatibleEndpoint,
  normalizeOpenAiCompatibleV1Base, isGemini25Model, isGemini3OrLaterModel, type ExternalAiReviewerConfig,
  type ExternalReviewerModelOption, type ExternalReviewerModelsDiscoveryInput,
  type ExternalReviewerModelsDiscoveryResult, type ExternalReviewerThinkingLevel,
} from '../../shared/approval-contract';
import { redactSecretsForReviewer, maskKnownSecret } from '../security/redaction';
import { extractProviderTokenUsage, type ExternalModelTokenUsage } from './provider-usage';
export { extractProviderTokenUsage, type ExternalModelTokenUsage } from './provider-usage';


export class OriginCircuitBreaker {
  private entries = new Map<string, { failures: number; until: number; status?: number }>();
  constructor(private readonly options: { tripOn401?: boolean } = {}) {}

  private origin(endpoint: string) {
    try { return new URL(endpoint).origin; } catch { return endpoint.trim(); }
  }
  remaining(endpoint: string, now = Date.now()): number {
    const key = this.origin(endpoint);
    const entry = this.entries.get(key);
    if (entry?.until && entry.until <= now) this.entries.delete(key);
    return Math.max(0, (entry?.until ?? 0) - now);
  }
  cooldownStatus(endpoint: string): number | undefined { return this.entries.get(this.origin(endpoint))?.status; }
  fail(endpoint: string, status?: number, now = Date.now()): number {
    const key = this.origin(endpoint);
    const wait = this.remaining(key, now);
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    const authCooldown = status === 403 || (status === 401 && this.options.tripOn401);
    const delay = authCooldown ? 300_000 : status === 429 ? 60_000 : failures >= 3 ? 30_000 : 0;
    const next = Math.max(wait, delay);
    const cause = wait > delay ? this.entries.get(key)?.status : status;
    this.entries.set(key, { failures, until: next ? now + next : 0, status: cause });
    return next;
  }
  successRecorder(endpoint: string): () => void {
    const key = this.origin(endpoint);
    const entry = this.entries.get(key);
    return () => { if (this.entries.get(key) === entry) this.entries.delete(key); };
  }
  reset(endpoint?: string): void {
    if (endpoint === undefined) this.entries.clear();
    else this.entries.delete(this.origin(endpoint));
  }
}
export const reviewerCircuit = new OriginCircuitBreaker({ tripOn401: false });
export const translatorCircuit = new OriginCircuitBreaker({ tripOn401: true });

export class IndependentModelLimitError extends Error {
  constructor(message: string, readonly cooldownRemainingMs = 0) { super(message); }
}
export class IndependentModelCallError extends Error {
  readonly usage?: ExternalModelTokenUsage;
  constructor(message: string, usage?: ExternalModelTokenUsage) {
    super(message);
    this.usage = usage;
  }
}

interface ModelCompletion {
  candidates?: Array<{ finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  choices?: Array<{ finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }>;
  done?: boolean;
  done_reason?: string;
}

function assertModelResponseComplete(
  provider: ExternalAiReviewerConfig['provider'], data: ModelCompletion, usage?: ExternalModelTokenUsage
): void {
  const reason = provider === 'gemini-api-key' ? data.candidates?.[0]?.finishReason :
    provider === 'openai-compatible' ? data.choices?.[0]?.finish_reason : data.done_reason;
  const stop = typeof reason === 'string' ? reason.toLowerCase() : '';
  if (stop === 'max_tokens' || stop === 'length') {
    throw new IndependentModelCallError('模型输出达到 maxOutputTokens 上限被截断', usage);
  }
  const block = data.promptFeedback?.blockReason;
  const blocked = (provider === 'gemini-api-key' && block && block !== 'BLOCK_REASON_UNSPECIFIED') ||
    (provider === 'openai-compatible' && data.choices?.[0]?.message?.refusal) ||
    (provider === 'local-ollama' && data.done === false);
  if (blocked || (stop && !['stop', 'end_turn', 'eos', 'eos_token'].includes(stop))) {
    throw new IndependentModelCallError('模型未返回完整结果，服务端已拦截或中止本次请求', usage);
  }
}

const MAX_REVIEW_RESPONSE_BYTES = 262_144;
const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

function clampTimeoutMs(raw?: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : EXTERNAL_REVIEWER_DEFAULTS.timeoutMs;
  return Math.min(Math.max(Math.round(value), 100), 60_000);
}

function clampMaxOutputTokens(raw?: number): number {
  const value =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens;
  return Math.min(Math.max(Math.round(value), 64), 65_536);
}

function isOpenAiReasoningModel(modelId: string): boolean {
  return /^(?:o[134](?:[-.]|$)|gpt-[56](?:[-.]|$))/i.test(modelId.trim());
}

/**
 * 为 Gemini generateContent 请求构造兼容各代机型的 thinkingConfig：
 * - Gemini 3/4 使用 thinkingLevel 枚举（MINIMAL / LOW / MEDIUM / HIGH）
 * - Gemini 2.5 使用 thinkingBudget（向 2.5 发送 thinkingLevel 会导致 400）
 * - 'auto' 或非思考模型不发送，完全遵循服务端默认行为
 */
export function buildGeminiThinkingConfig(
  modelId: string,
  level?: ExternalReviewerThinkingLevel
): Record<string, unknown> | undefined {
  if (!level || level === 'auto') return undefined;
  const id = modelId.trim();
  if (isGemini3OrLaterModel(id)) {
    if (level === 'off') {
      return { thinkingLevel: /flash-lite|gemini-3\.6-flash|gemini-3-flash/i.test(id) ? 'MINIMAL' : 'LOW' };
    }
    return { thinkingLevel: level.toUpperCase() };
  }
  if (isGemini25Model(id)) {
    const budgetMap: Record<Exclude<ExternalReviewerThinkingLevel, 'auto'>, number> = {
      off: /pro/i.test(id) ? 128 : 0,
      minimal: 256,
      low: 1024,
      medium: 8192,
      high: 24576,
    };
    return { thinkingBudget: budgetMap[level] };
  }
  return undefined;
}

export async function withModelDeadline<T>(timeoutMs: number, label: string, parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error(label + '超时（超过 ' + timeoutMs + 'ms）')), timeoutMs);
  timer.unref?.();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal), aborted]);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort!);
  }
}

async function readBoundedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (!response.body) return '';
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        throw new Error('独立模型响应超限');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function readSafeErrorDetail(response: Response, apiKey?: string, signal?: AbortSignal): Promise<string> {
  try {
    const raw = await readBoundedText(response, 4096, signal);
    let detail = '';
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
      if (typeof parsed.error === 'string') detail = parsed.error;
      else if (parsed.error && typeof parsed.error.message === 'string') detail = parsed.error.message;
      else if (typeof parsed.message === 'string') detail = parsed.message;
    } catch {
      detail = raw.trim();
    }
    detail = redactSecretsForReviewer(maskKnownSecret(detail, apiKey));
    return detail.replace(/\s+/g, ' ').trim().slice(0, 180);
  } catch {
    signal?.throwIfAborted();
    return '';
  }
}

/** 验证复审服务的来源和凭据要求。后续按验证后的 origin 与服务类型组装实际请求路径。 */
export function validateExternalEndpoint(config: ExternalAiReviewerConfig): URL {
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error('外部复核地址不能包含凭据或查询参数');
  const local = url.hostname === '127.0.0.1' && url.protocol === 'http:';
  const allowed = config.provider === 'openai-compatible'
    ? isAllowedOpenAiCompatibleEndpoint(url)
    : config.provider === 'gemini-api-key'
      ? local || url.origin === 'https://generativelanguage.googleapis.com'
      : config.provider === 'local-ollama' && local;
  if (!allowed || (!local && !config.apiKey?.trim())) {
    throw new Error('复核仅允许配置独立密钥的公开 API 或 127.0.0.1 本地模型');
  }
  return url;
}

function rankDiscoveredModel(provider: ExternalAiReviewerConfig['provider'], id: string): number {
  const lower = id.toLowerCase();
  if (provider === 'gemini-api-key') {
    if (lower.startsWith('gemini-4-')) return 10;
    if (lower.startsWith('gemini-3.8-')) return 20;
    if (lower.startsWith('gemini-3.6-')) return 25;
    if (lower.startsWith('gemini-3.5-')) return 30;
    if (lower.startsWith('gemini-3.')) return 35;
    if (lower.startsWith('gemini-3-')) return 40;
    if (lower.startsWith('gemini-2.5-flash-lite')) return 45;
    if (lower.startsWith('gemini-2.5-')) return 50;
    return 80;
  }
  if (provider === 'openai-compatible') {
    if (/^gpt-[56]/i.test(lower)) return 10;
    if (/^o[34]\b/i.test(lower)) return 20;
    if (/^gpt-4\.1/i.test(lower)) return 30;
    if (/^gpt-4o-mini/i.test(lower)) return 35;
    if (/^gpt-4o/i.test(lower)) return 40;
    return 70;
  }
  return 50;
}

/**
 * 使用用户填写的公开 API Key 或本机 Ollama 地址查询服务端允许调用的模型列表及其支持的思考强度。
 * 密钥仅通过请求头发送、绝不落盘、绝不拼入 URL、禁止重定向。
 */
export async function discoverExternalModels(
  input: ExternalReviewerModelsDiscoveryInput,
  fetcher: typeof fetch = fetch
): Promise<ExternalReviewerModelsDiscoveryResult> {
  const endpoint = validateExternalEndpoint({
    enabled: true,
    provider: input.provider,
    endpoint: input.endpoint,
    model: 'probe',
    apiKey: input.apiKey,
    timeoutMs: EXTERNAL_REVIEWER_DEFAULTS.timeoutMs,
  });


  const models: ExternalReviewerModelOption[] = [];
  const seen = new Set<string>();

  await withModelDeadline(12_000, '查询模型列表', undefined, async signal => {
    if (input.provider === 'gemini-api-key') {
      const headers: Record<string, string> = {};
      if (input.apiKey) headers['x-goog-api-key'] = input.apiKey;
      let pageToken = '';
      for (let page = 0; page < 3; page += 1) {
        const query = pageToken
          ? `?pageSize=200&pageToken=${encodeURIComponent(pageToken)}`
          : '?pageSize=200';
        const url = `${endpoint.origin}/v1beta/models${query}`;
        const response = await fetcher(url, {
          method: 'GET',
          headers,
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          const detail = await readSafeErrorDetail(response, input.apiKey, signal);
          throw new Error(`查询可用模型失败（HTTP ${response.status}${detail ? `: ${detail}` : ''}）`);
        }
        const payload = JSON.parse(await readBoundedText(response, MAX_DISCOVERY_RESPONSE_BYTES, signal)) as {
          models?: Array<{
            name?: string;
            baseModelId?: string;
            displayName?: string;
            description?: string;
            inputTokenLimit?: number;
            outputTokenLimit?: number;
            supportedGenerationMethods?: string[];
            thinking?: boolean;
            supportedThinkingLevels?: string[];
          }>;
          nextPageToken?: string;
        };
        for (const item of payload.models || []) {
          const rawName = String(item.name || item.baseModelId || '').trim();
          const id = rawName.replace(/^models\//i, '');
          if (!id || seen.has(id)) continue;
          const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
          if (methods.length > 0 && !methods.includes('generateContent')) continue;
          if (/(?:embedding|imagen|veo|lyria|tts|transcribe|live|image|aqa|robotics|learnlm|gemma-3n-e)/i.test(id)) {
            continue;
          }
          seen.add(id);
          const thinkingInfo = inferSupportedThinkingLevels(
            'gemini-api-key',
            id,
            typeof item.thinking === 'boolean' ? item.thinking : undefined,
            item.supportedThinkingLevels
          );
          models.push({
            id,
            displayName: (item.displayName || id).trim(),
            description: item.description?.trim().slice(0, 160),
            inputTokenLimit: typeof item.inputTokenLimit === 'number' ? item.inputTokenLimit : undefined,
            outputTokenLimit: typeof item.outputTokenLimit === 'number' ? item.outputTokenLimit : undefined,
            ...thinkingInfo,
          });
        }
        pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : '';
        if (!pageToken) break;
      }
    } else if (input.provider === 'openai-compatible') {
      const headers: Record<string, string> = {};
      if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
      const response = await fetcher(`${normalizeOpenAiCompatibleV1Base(endpoint)}/models`, {
        method: 'GET',
        headers,
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        const detail = await readSafeErrorDetail(response, input.apiKey, signal);
        throw new Error(`查询可用模型失败（HTTP ${response.status}${detail ? `: ${detail}` : ''}）`);
      }
      const payload = JSON.parse(await readBoundedText(response, MAX_DISCOVERY_RESPONSE_BYTES, signal)) as {
        data?: Array<{ id?: string }>;
      };
      for (const item of payload.data || []) {
        const id = String(item.id || '').trim();
        if (!id || seen.has(id)) continue;
        if (/(?:whisper|tts|dall-e|embedding|moderation|sora|audio|realtime|transcribe|image|babbage|davinci|omni-moderation)/i.test(id)) {
          continue;
        }
        seen.add(id);
        const thinkingInfo = inferSupportedThinkingLevels('openai-compatible', id);
        models.push({
          id,
          displayName: id,
          ...thinkingInfo,
        });
      }
    } else {
      const response = await fetcher(`${endpoint.origin}/api/tags`, {
        method: 'GET',
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        const detail = await readSafeErrorDetail(response, undefined, signal);
        throw new Error(`查询本机 Ollama 模型失败（HTTP ${response.status}${detail ? `: ${detail}` : ''}）`);
      }
      const payload = JSON.parse(await readBoundedText(response, MAX_DISCOVERY_RESPONSE_BYTES, signal)) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      for (const item of payload.models || []) {
        const id = String(item.name || item.model || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const thinkingInfo = inferSupportedThinkingLevels('local-ollama', id);
        models.push({
          id,
          displayName: id,
          ...thinkingInfo,
        });
      }
    }
  });

  models.sort((a, b) => {
    const rankDiff = rankDiscoveredModel(input.provider, a.id) - rankDiscoveredModel(input.provider, b.id);
    if (rankDiff !== 0) return rankDiff;
    return a.id.localeCompare(b.id);
  });

  return {
    provider: input.provider,
    endpoint: input.provider === 'openai-compatible' ? endpoint.href.replace(/\/$/, '') : endpoint.origin,
    models,
    fetchedAt: new Date().toISOString(),
  };
}

/** Node fetch 复用进程内连接池；禁止重定向，密钥仅留内存，不写日志。同时返回服务端上报的精确 Token 用量。 */
export async function callIndependentModelWithUsage(
  config: ExternalAiReviewerConfig,
  instruction: string,
  input: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  options: { circuit?: OriginCircuitBreaker; skipCircuitCheck?: boolean; plainText?: boolean } = {},
): Promise<{ text: string; usage?: ExternalModelTokenUsage }> {
  if (!config.enabled) throw new Error('独立模型未开启');
  const endpoint = validateExternalEndpoint(config);
  // 冷却时间按服务来源共享。同一端点的其他会话也会在发出网络请求前看到限制。
  const circuit = options.circuit ?? reviewerCircuit;
  const remaining = circuit.remaining(endpoint.origin);
  if (!options.skipCircuitCheck && remaining) throw new IndependentModelLimitError(
    '独立模型处于熔断冷却中' + (circuit.cooldownStatus(endpoint.origin) ? '（HTTP ' + circuit.cooldownStatus(endpoint.origin) + '）' : '') + '，已暂停请求 ' + Math.ceil(remaining / 1000) + ' 秒，请人工确认', remaining);
  const onSuccess = circuit.successRecorder(endpoint.origin);
  if (!config.model || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(config.model)) throw new Error('模型名称无效');
  const timeout = clampTimeoutMs(config.timeoutMs);
  const maxOutputTokens = clampMaxOutputTokens(config.maxOutputTokens);
  let readingResponse = false;
  return withModelDeadline(timeout, '独立模型请求', signal, async requestSignal => {
    let url: string;
    let body: unknown;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.provider === 'gemini-api-key') {
      url = `${endpoint.origin}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
      if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
      const generationConfig: Record<string, unknown> = {
        maxOutputTokens,
        ...(!options.plainText && { responseMimeType: 'application/json' }),
      };
      if (!isGemini3OrLaterModel(config.model)) {
        generationConfig.temperature = 0;
      }
      const thinkingConfig = buildGeminiThinkingConfig(config.model, config.thinkingLevel);
      if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
      }
      body = {
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig,
      };
    } else if (config.provider === 'local-ollama') {
      url = `${endpoint.origin}/api/chat`;
      const ollamaBody: Record<string, unknown> = {
        model: config.model,
        stream: false,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: input },
        ],
        options: { temperature: 0, num_predict: maxOutputTokens },
      };
      if (config.thinkingLevel === 'off') ollamaBody.think = false;
      else if (config.thinkingLevel && config.thinkingLevel !== 'auto') {
        ollamaBody.think = config.thinkingLevel === 'minimal' ? 'low' : config.thinkingLevel;
      }
      body = ollamaBody;
    } else {
      url = `${normalizeOpenAiCompatibleV1Base(endpoint)}/chat/completions`;
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const messages = [
        { role: 'system', content: instruction },
        { role: 'user', content: input },
      ];
      if (isOpenAiReasoningModel(config.model)) {
        const reasoningBody: Record<string, unknown> = {
          model: config.model,
          max_completion_tokens: maxOutputTokens,
          messages,
        };
        if (config.thinkingLevel && config.thinkingLevel !== 'auto' && config.thinkingLevel !== 'off') {
          reasoningBody.reasoning_effort = config.thinkingLevel;
        }
        body = reasoningBody;
      } else {
        body = {
          model: config.model,
          temperature: 0,
          max_tokens: maxOutputTokens,
          ...(!options.plainText && { response_format: { type: 'json_object' } }),
          messages,
        };
      }
    }
    const response = await fetcher(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'error',
    });
    requestSignal.throwIfAborted();
    if (!response.ok) {
      const status = response.status;
      const limited = status === 429 || status === 403 || status === 401;
      // Publish cooldown before consuming a slow response body.
      const wait = limited ? circuit.fail(endpoint.origin, status) : 0;
      const detail = await readSafeErrorDetail(response, config.apiKey, requestSignal);
      const message = '独立模型请求失败（HTTP ' + status + (detail ? ': ' + detail : '') + '）';
      if (limited) throw new IndependentModelLimitError(message + '，已暂停连续请求 ' + Math.ceil(wait / 1000) + ' 秒，已回退人工确认', wait);
      throw new Error(message);
    }
    // 限制响应长度，避免服务返回巨量数据占用主进程内存。
    readingResponse = true;
    if (!response.body) throw new Error('独立模型未返回内容');
    const data = JSON.parse(await readBoundedText(response, MAX_REVIEW_RESPONSE_BYTES, requestSignal)) as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        cachedContentTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
        total_cost?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const usage = extractProviderTokenUsage(config.provider, data);
    assertModelResponseComplete(config.provider, data, usage);
    const geminiParts = data.candidates?.[0]?.content?.parts;
    const geminiText = Array.isArray(geminiParts)
      ? geminiParts
          .filter((part) => !part?.thought && typeof part?.text === 'string')
          .map((part) => part.text || '')
          .join('')
      : undefined;
    const text =
      (geminiText !== undefined && geminiText !== '' ? geminiText : undefined) ??
      data.choices?.[0]?.message?.content ??
      data.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new IndependentModelCallError('独立模型响应格式无效', usage);
    }
    requestSignal.throwIfAborted();
    if (!options.skipCircuitCheck) onSuccess();
    return { text, usage };
  }).catch(error => {
    if (!signal?.aborted && !(error instanceof IndependentModelLimitError) && (readingResponse || options.plainText)) circuit.fail(endpoint.origin);
    throw error;
  });
}

import type { ExternalAiReviewerConfig } from '../../shared/approval-contract';
export interface ExternalModelTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  providerReported: boolean;
  directCostUsd?: number;
}

interface GeminiUsageMetadataRaw {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

interface OpenAiUsageRaw {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  total_cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OllamaUsageRaw {
  prompt_eval_count?: number;
  eval_count?: number;
}

const safeUsageInt = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

const safeUsageFloat = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

function extractGeminiUsage(um?: GeminiUsageMetadataRaw): ExternalModelTokenUsage | undefined {
  if (!um) return undefined;
  const promptTotal = safeUsageInt(um.promptTokenCount);
  const cachedInputTokens = Math.min(promptTotal, safeUsageInt(um.cachedContentTokenCount));
  const inputTokens = Math.max(0, promptTotal - cachedInputTokens);
  const thinkingTokens = safeUsageInt(um.thoughtsTokenCount);
  const candidatesTokens = safeUsageInt(um.candidatesTokenCount);
  const rawTotal = safeUsageInt(um.totalTokenCount);
  const outputTokens =
    candidatesTokens > 0
      ? candidatesTokens
      : rawTotal > 0
        ? Math.max(0, rawTotal - promptTotal - thinkingTokens)
        : 0;
  const totalTokens = inputTokens + cachedInputTokens + outputTokens + thinkingTokens;
  if (totalTokens <= 0) return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    thinkingTokens,
    totalTokens,
    providerReported: true,
  };
}

function extractOpenAiUsage(u?: OpenAiUsageRaw): ExternalModelTokenUsage | undefined {
  if (!u) return undefined;
  const promptTotal = safeUsageInt(u.prompt_tokens);
  const cachedInputTokens = Math.min(promptTotal, safeUsageInt(u.prompt_tokens_details?.cached_tokens));
  const inputTokens = Math.max(0, promptTotal - cachedInputTokens);
  const completionTotal = safeUsageInt(u.completion_tokens);
  const thinkingTokens = Math.min(completionTotal, safeUsageInt(u.completion_tokens_details?.reasoning_tokens));
  const outputTokens = Math.max(0, completionTotal - thinkingTokens);
  const totalTokens = inputTokens + cachedInputTokens + outputTokens + thinkingTokens;
  const directCostUsd = safeUsageFloat(u.cost) ?? safeUsageFloat(u.total_cost);
  if (totalTokens <= 0 && directCostUsd === undefined) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens, thinkingTokens, totalTokens, providerReported: true, directCostUsd };
}

function extractOllamaUsage(data?: OllamaUsageRaw): ExternalModelTokenUsage | undefined {
  if (!data || (data.prompt_eval_count === undefined && data.eval_count === undefined)) return undefined;
  const inputTokens = safeUsageInt(data.prompt_eval_count);
  const outputTokens = safeUsageInt(data.eval_count);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens <= 0) return undefined;
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    thinkingTokens: 0,
    totalTokens,
    providerReported: true,
    directCostUsd: 0,
  };
}

export function extractProviderTokenUsage(
  provider: ExternalAiReviewerConfig['provider'],
  data: {
    usageMetadata?: GeminiUsageMetadataRaw;
    usage?: OpenAiUsageRaw;
    prompt_eval_count?: number;
    eval_count?: number;
  }
): ExternalModelTokenUsage | undefined {
  if (provider === 'gemini-api-key') return extractGeminiUsage(data.usageMetadata);
  if (provider === 'openai-compatible') return extractOpenAiUsage(data.usage);
  if (provider === 'local-ollama') return extractOllamaUsage(data);
  return undefined;
}

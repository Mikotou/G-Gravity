/**
 * Gravity v0.3.6 — 分模型四维 Token 参考单价表与解析函数（纯叶模块，零内部依赖）
 */

/**
 * 分模型四维 Token 参考单价配置（单位：USD / 1M Tokens，可在设置中编辑）
 */
export interface ModelRateCard {
  modelId: string;
  displayName: string;
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
  thinkingPerMillionUsd: number;
}

export const DEFAULT_MODEL_RATE_CARDS: readonly ModelRateCard[] = [
  {
    modelId: 'default',
    displayName: 'Default Reference (Gemini Pro Tier)',
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.31,
    outputPerMillionUsd: 10.0,
    thinkingPerMillionUsd: 10.0,
  },
  {
    modelId: 'gemini-4-carbon',
    displayName: 'Gemini 4 Carbon',
    inputPerMillionUsd: 2.0,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 12.0,
    thinkingPerMillionUsd: 12.0,
  },
  {
    modelId: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    inputPerMillionUsd: 1.5,
    cachedInputPerMillionUsd: 0.375,
    outputPerMillionUsd: 10.0,
    thinkingPerMillionUsd: 10.0,
  },
  {
    modelId: 'gemini-4-hydrogen',
    displayName: 'Gemini 4 Hydrogen',
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.31,
    outputPerMillionUsd: 8.0,
    thinkingPerMillionUsd: 8.0,
  },
  {
    modelId: 'gemini-4-neon',
    displayName: 'Gemini 4 Neon',
    inputPerMillionUsd: 1.5,
    cachedInputPerMillionUsd: 0.375,
    outputPerMillionUsd: 10.0,
    thinkingPerMillionUsd: 10.0,
  },
  {
    modelId: 'gemini-pro-orchestrator',
    displayName: 'Orchestrator (Carbon / Argon)',
    inputPerMillionUsd: 2.0,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 12.0,
    thinkingPerMillionUsd: 12.0,
  },
  {
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    inputPerMillionUsd: 0.3,
    cachedInputPerMillionUsd: 0.075,
    outputPerMillionUsd: 2.5,
    thinkingPerMillionUsd: 2.5,
  },
  {
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    inputPerMillionUsd: 3.0,
    cachedInputPerMillionUsd: 0.3,
    outputPerMillionUsd: 15.0,
    thinkingPerMillionUsd: 15.0,
  },
  {
    modelId: 'claude-opus-4-6-thinking',
    displayName: 'Claude Opus 4.6',
    inputPerMillionUsd: 5.0,
    cachedInputPerMillionUsd: 0.5,
    outputPerMillionUsd: 25.0,
    thinkingPerMillionUsd: 25.0,
  },
  {
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    inputPerMillionUsd: 1.25,
    cachedInputPerMillionUsd: 0.31,
    outputPerMillionUsd: 10.0,
    thinkingPerMillionUsd: 10.0,
  },
  {
    modelId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    inputPerMillionUsd: 0.3,
    cachedInputPerMillionUsd: 0.075,
    outputPerMillionUsd: 2.5,
    thinkingPerMillionUsd: 2.5,
  },
  {
    modelId: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash-Lite',
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.025,
    outputPerMillionUsd: 0.4,
    thinkingPerMillionUsd: 0.4,
  },
  {
    modelId: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash-Lite',
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.025,
    outputPerMillionUsd: 0.4,
    thinkingPerMillionUsd: 0.4,
  },
  {
    modelId: 'gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    inputPerMillionUsd: 0.3,
    cachedInputPerMillionUsd: 0.075,
    outputPerMillionUsd: 2.5,
    thinkingPerMillionUsd: 2.5,
  },
  {
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    inputPerMillionUsd: 0.15,
    cachedInputPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.6,
    thinkingPerMillionUsd: 0.6,
  },
  {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    inputPerMillionUsd: 2.5,
    cachedInputPerMillionUsd: 1.25,
    outputPerMillionUsd: 10.0,
    thinkingPerMillionUsd: 10.0,
  },
  {
    modelId: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    inputPerMillionUsd: 0.4,
    cachedInputPerMillionUsd: 0.1,
    outputPerMillionUsd: 1.6,
    thinkingPerMillionUsd: 1.6,
  },
  {
    modelId: 'gpt-4.1-nano',
    displayName: 'GPT-4.1 nano',
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.025,
    outputPerMillionUsd: 0.4,
    thinkingPerMillionUsd: 0.4,
  },
  {
    modelId: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    inputPerMillionUsd: 0.25,
    cachedInputPerMillionUsd: 0.025,
    outputPerMillionUsd: 2.0,
    thinkingPerMillionUsd: 2.0,
  },
  {
    modelId: 'o4-mini',
    displayName: 'o4-mini',
    inputPerMillionUsd: 1.1,
    cachedInputPerMillionUsd: 0.275,
    outputPerMillionUsd: 4.4,
    thinkingPerMillionUsd: 4.4,
  },
  {
    modelId: 'gpt-oss-120b-medium',
    displayName: 'GPT-OSS 120B (Medium)',
    inputPerMillionUsd: 0.15,
    cachedInputPerMillionUsd: 0.04,
    outputPerMillionUsd: 0.6,
    thinkingPerMillionUsd: 0.6,
  },
] as const;

/** 完整模型名优先。带版本后缀或省略 `-thinking` 后缀时匹配对应型号，未知模型使用默认价卡。 */
export function resolveModelRateCard(
  modelId: string,
  rateCards: readonly ModelRateCard[]
): ModelRateCard {
  const normalized = (modelId || '').trim().toLowerCase();
  const exact = rateCards.find((r) => r.modelId.toLowerCase() === normalized);
  if (exact) return exact;
  const baseExact = rateCards.find(
    (r) => r.modelId !== 'default' && r.modelId.toLowerCase().replace(/-thinking$/, '') === normalized
  );
  if (baseExact) return baseExact;
  const fuzzy = rateCards.reduce<ModelRateCard | undefined>((best, card) => {
    if (card.modelId === 'default') return best;
    const candidate = card.modelId.toLowerCase();
    const candidateBase = candidate.replace(/-thinking$/, '');
    const matchedLen = normalized.includes(candidate)
      ? candidate.length
      : candidateBase !== candidate && normalized.includes(candidateBase)
        ? candidateBase.length
        : 0;
    const bestLen = best
      ? best.modelId.toLowerCase().replace(/-thinking$/, '').length
      : 0;
    return matchedLen > 0 && matchedLen > bestLen ? card : best;
  }, undefined);
  if (fuzzy) return fuzzy;
  return (
    rateCards.find((r) => r.modelId === 'default') ?? DEFAULT_MODEL_RATE_CARDS[0]
  );
}

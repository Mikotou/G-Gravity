/**
 * Gravity v0.2 — Context 遥测、三档 Token 热力图（24h / 7d / 30d）与分模型 Cost 构成契约
 *
 * 变更要点（v0.2）：
 * 1. 移除 52 周热力图，升级为 `24h`（按小时柱状）、`7d`（7×24 天×小时热力格）、`30d`（按天日历热力格）；
 * 2. 移除“订阅性价比对比”，升级为按 会话 / 今日 / 7d / 30d 四维度的精确 Cost（input / cachedInput / output / thinking × 单价），
 *    并提供分模型费用构成数据（堆叠柱状图 + 环形占比图）；
 * 3. 单价表支持在设置页自定义编辑，界面固定标注“参考 API 价格估算，非实际账单”。
 */

export type TelemetryUsageSource = 'acp-reported' | 'estimated' | 'mixed';

export type TelemetryPricingSource =
  | 'reference-api-estimate'
  | 'user-custom-rate';

export type TokenHeatmapRange = '24h' | '7d' | '30d';

export type CostTimeScope = 'session' | 'today' | '7d' | '30d';

export const COST_DISCLAIMER = {
  'zh-CN': '参考 API 价格估算，非实际账单',
  'en-US': 'Estimated at reference API rates, not an actual bill',
} as const;

export interface AttachmentAuditItem {
  id: string;
  name: string;
  kind: 'image' | 'file' | 'resource' | 'tool-output';
  sizeBytes: number;
  estimatedTokens: number;
}

export interface ContextTokenBreakdown {
  systemAndRulesTokens: number;
  userMessagesTokens: number;
  agentMessagesTokens: number;
  thoughtTokens: number;
  toolCallsTokens: number;
  attachmentsTokens: number;
}

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
] as const;

/** 这四类用量互斥。计费前已从普通输入中扣除缓存输入、从普通输出中扣除思考，四项可以直接相加。 */
export interface FourDimTokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface TokenCostSummary extends FourDimTokenCounts {
  totalTokens: number;
  inputCostUsd: number;
  cachedInputCostUsd: number;
  outputCostUsd: number;
  thinkingCostUsd: number;
  totalCostUsd: number;
}

/**
 * 纯函数：根据四维 Token 数量与单价卡计算精确 Cost
 */
export function calculateTokenCost(
  counts: FourDimTokenCounts,
  rate: Pick<
    ModelRateCard,
    | 'inputPerMillionUsd'
    | 'cachedInputPerMillionUsd'
    | 'outputPerMillionUsd'
    | 'thinkingPerMillionUsd'
  >
): TokenCostSummary {
  // 无效计数或单价按零处理，避免单项异常将整个看板的金额变为 NaN。
  const safeVal = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

  const inputTokens = safeVal(counts.inputTokens);
  const cachedInputTokens = safeVal(counts.cachedInputTokens);
  const outputTokens = safeVal(counts.outputTokens);
  const thinkingTokens = safeVal(counts.thinkingTokens);

  const inputCostUsd = (inputTokens / 1_000_000) * safeVal(rate.inputPerMillionUsd);
  const cachedInputCostUsd =
    (cachedInputTokens / 1_000_000) * safeVal(rate.cachedInputPerMillionUsd);
  const outputCostUsd = (outputTokens / 1_000_000) * safeVal(rate.outputPerMillionUsd);
  const thinkingCostUsd =
    (thinkingTokens / 1_000_000) * safeVal(rate.thinkingPerMillionUsd);
  const totalCostUsd =
    inputCostUsd + cachedInputCostUsd + outputCostUsd + thinkingCostUsd;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    thinkingTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens + thinkingTokens,
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    thinkingCostUsd,
    totalCostUsd,
  };
}

/**
 * 解析各模型在 Antigravity / `agy` 中的实际 Checkpointer 压缩触发窗口上限：
 * - Carbon / Hydrogen / Orchestrator 经服务端 `CASCADE_USE_EXPERIMENT_CHECKPOINTER` 下发 `max_token_limit = 512000`
 * - 其余模型沿用本地 `GetCheckpointConfig` 默认压缩阈值 `256000`（若会话库 `executor_metadata` 存在实测覆盖值则进一步以实测为准）
 */
export function resolveModelCompactionLimit(modelId?: string): number {
  const normalized = (modelId || '').trim().toLowerCase();
  if (
    normalized.includes('gemini-4-carbon') ||
    normalized.includes('gemini-4-hydrogen') ||
    normalized.includes('gemini-pro-orchestrator') ||
    normalized.includes('orchestrator')
  ) {
    return 512_000;
  }
  return 256_000;
}

/** 先匹配完整模型名，再按费率表顺序寻找包含关系。仍无法识别时使用默认价卡，以便新模型也能显示估算。 */
export function resolveModelRateCard(
  modelId: string,
  rateCards: readonly ModelRateCard[]
): ModelRateCard {
  const normalized = (modelId || '').trim().toLowerCase();
  const exact = rateCards.find((r) => r.modelId.toLowerCase() === normalized);
  if (exact) return exact;
  const fuzzy = rateCards.find(
    (r) => r.modelId !== 'default' && normalized.includes(r.modelId.toLowerCase())
  );
  if (fuzzy) return fuzzy;
  return (
    rateCards.find((r) => r.modelId === 'default') ?? DEFAULT_MODEL_RATE_CARDS[0]
  );
}

export interface ContextCompactionRecord {
  id: string;
  timestamp: string;
  trigger: 'manual' | 'auto';
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  maxContextTokens: number;
}

/**
 * 单个活跃会话的实时 Context 与速率遥测（驱动输入框上方 Status Line）
 */
export interface SessionContextTelemetry {
  sessionId: string;
  modelId: string;
  maxContextTokens: number;
  usedContextTokens: number;
  usageRatio: number;
  pressureLevel: 'healthy' | 'moderate' | 'warning' | 'critical';
  breakdown: ContextTokenBreakdown;
  attachments: AttachmentAuditItem[];
  compactions?: ContextCompactionRecord[];
  currentTokensPerSecond: number;
  peakTokensPerSecond: number;
  costSummary: TokenCostSummary;
  usageSource: TelemetryUsageSource;
  pricingSource: TelemetryPricingSource;
  updatedAt: string;
}

/**
 * 1) `24h` 视图：过去 24 小时按小时柱状图数据（24 个桶）
 */
export interface HourlyTokenBarBucket extends FourDimTokenCounts {
  /** 格式 YYYY-MM-DDTHH */
  hourKey: string;
  /** 展示标签如 "14:00" */
  hourLabel: string;
  totalTokens: number;
  costUsd: number;
}

/**
 * 2) `7d` 视图：7 天 × 24 小时矩阵热力格（168 个单元格）
 */
export interface DayHourHeatmapCell {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 小时 0 ~ 23 */
  hour: number;
  totalTokens: number;
  costUsd: number;
  intensity: 0 | 1 | 2 | 3 | 4;
}

/**
 * 3) `30d` 视图：过去 30 天按天日历热力格（30 个单元格）
 */
export interface DailyCalendarHeatmapCell extends FourDimTokenCounts {
  /** 日期 YYYY-MM-DD */
  date: string;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
  intensity: 0 | 1 | 2 | 3 | 4;
}

/**
 * 分模型费用构成项（同时驱动堆叠柱状图与环形占比图）
 */
export interface ModelCostBreakdownItem extends TokenCostSummary {
  modelId: string;
  displayName: string;
  /** 占当前时间维度总费用的比例 0 ~ 1 */
  shareRatio: number;
}

/**
 * Context & Cost 看板全量快照
 */
export interface TelemetryDashboardSnapshot {
  // 以 sessionId 索引单会话的上下文占用和速度，跨会话的时段费用则保存在下方各范围汇总中。
  activeSessions: Record<string, SessionContextTelemetry>;
  /** 24h 按小时柱状序列（长度 24） */
  hourly24h: HourlyTokenBarBucket[];
  /** 7d 7×24 天×小时热力矩阵（长度 168） */
  matrix7d: DayHourHeatmapCell[];
  /** 30d 按日历天热力序列（长度 30） */
  calendar30d: DailyCalendarHeatmapCell[];
  /** 今日 / 7d / 30d 总计费用摘要 */
  costByRange: Record<'today' | '7d' | '30d', TokenCostSummary>;
  /** 今日 / 7d / 30d 分模型费用构成 */
  modelBreakdownByRange: Record<'today' | '7d' | '30d', ModelCostBreakdownItem[]>;
  /** 各会话内分模型费用构成 */
  sessionModelBreakdowns: Record<string, ModelCostBreakdownItem[]>;
  /** 当前生效的模型单价表 */
  rateCards: ModelRateCard[];
  pricingSource: TelemetryPricingSource;
  generatedAt: string;
}

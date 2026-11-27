/**
 * Gravity v0.2 — Context 遥测、三档 Token 热力图（24h / 7d / 30d）与分模型 Cost 构成契约
 *
 * 变更要点（v0.2）：
 * 1. 移除 52 周热力图，升级为 `24h`（按小时柱状）、`7d`（7×24 天×小时热力格）、`30d`（按天日历热力格）；
 * 2. 移除“订阅性价比对比”，升级为按 会话 / 今日 / 7d / 30d 四维度的精确 Cost（input / cachedInput / output / thinking × 单价），
 *    并提供分模型费用构成数据（堆叠柱状图 + 环形占比图）；
 * 3. 单价表支持在设置页自定义编辑，界面固定标注“参考 API 价格估算，非实际账单”。
 */

import type { ConversationTreeState } from './conversation-tree';
import {
  DEFAULT_MODEL_RATE_CARDS,
  resolveModelRateCard,
  type ModelRateCard,
} from './model-rate-cards';
import type { VoiceExternalTelemetrySnapshot } from './voice-contract';

export {
  DEFAULT_MODEL_RATE_CARDS,
  resolveModelRateCard,
  type ModelRateCard,
};

export type TelemetryUsageSource = 'acp-reported' | 'estimated' | 'mixed';

export type TelemetryPricingSource =
  | 'reference-api-estimate'
  | 'user-custom-rate';

export type TokenHeatmapRange = '24h' | '7d' | '30d';

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export const HEAT_LEVEL_THRESHOLDS = [0.12, 0.36, 0.67] as const;

/**
 * 统一双轴热力强度算法（单一共享来源，覆盖 24h / 7d / 30d 与主/外部复核/外部翻译三套看板）：
 * 同时参考当前格的绝对用量 A（对数饱和至 B）、同窗口总量相对份额 R、以及窗口峰值占比 x/P，
 * 价格与费用不参与着色。
 */
export function computeHeatLevel(
  x: number,
  windowTotal: number,
  windowPeak: number,
  bucketCount: 24 | 7 | 30
): HeatLevel {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(windowTotal) ||
    !Number.isFinite(windowPeak) ||
    x <= 0 ||
    windowTotal <= 0 ||
    windowPeak <= 0
  ) {
    return 0;
  }
  const benchmark = bucketCount === 24 ? 250_000 : 2_500_000;
  const abs = Math.min(1, Math.log1p(x / 1000) / Math.log1p(benchmark / 1000));
  const rel = Math.log1p((bucketCount * x) / windowTotal) / Math.log1p(bucketCount);
  const peakRatio = Math.min(1, x / windowPeak);
  const z = abs * (0.4 + 0.25 * rel + 0.35 * peakRatio);
  if (z < HEAT_LEVEL_THRESHOLDS[0]) return 1;
  if (z < HEAT_LEVEL_THRESHOLDS[1]) return 2;
  if (z < HEAT_LEVEL_THRESHOLDS[2]) return 3;
  return 4;
}

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

/** 这四类用量互斥。计费前已从普通输入中扣除缓存输入、从普通输出中扣除思考，四项可以直接相加。 */
export interface FourDimTokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Provider reports a total without identifying this portion's token category. */
  unclassifiedTokens?: number;
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
  const unclassifiedTokens = safeVal(counts.unclassifiedTokens);

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
    unclassifiedTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens + thinkingTokens + unclassifiedTokens,
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    thinkingCostUsd,
    totalCostUsd,
  };
}

/**
 * 解析各模型在 Antigravity / `agy` 中的实际 Checkpointer 压缩触发窗口上限：
 * - Gemini 4 系列（Carbon / Hydrogen / Neon / Argon）与 Orchestrator 经服务端 `CASCADE_USE_EXPERIMENT_CHECKPOINTER` 下发 `max_token_limit = 512000`
 * - 其余模型沿用本地 `GetCheckpointConfig` 默认压缩阈值 `256000`（若会话库 `executor_metadata` 存在实测覆盖值或已学习到的同模型实测值，始终以实测为准）
 */
export function resolveModelCompactionLimit(modelId?: string): number {
  const normalized = (modelId || '').trim().toLowerCase();
  if (
    normalized.includes('gemini-4-') ||
    normalized.includes('gemini-4') ||
    normalized.includes('gemini-pro-orchestrator') ||
    normalized.includes('orchestrator')
  ) {
    return 512_000;
  }
  return 256_000;
}

export interface ContextCompactionRecord {
  id: string;
  timestamp: string;
  trigger: 'manual' | 'auto';
  estimated?: boolean;
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
  compactionCount?: number;
  compactionCountIsMinimum?: boolean;
  /** Estimated breakdown at the last official window report. */
  reportedBreakdownTokens?: number;
  /** 对话框底栏显示的实时输出速率（滑动时间窗 / 最近回合） */
  currentTokensPerSecond: number;
  /** 当前会话累计平均输出速率（供 Context 检视器展示） */
  averageTokensPerSecond?: number;
  peakTokensPerSecond: number;
  /** Actual cache reads and total prompt input across the session. Missing reports cannot be reconstructed from local estimates. */
  reportedCacheUsage?: { cachedReadTokens: number; inputTokens: number | null };
  /** Weighted session cache read rate (0–1). Absent when the provider's reports do not establish it. */
  averageCacheHitRate?: number;
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
  /** 该小时起点的本地 ISO-8601 时间戳（含数值 UTC 偏移如 +08:00 / -04:00 / +05:45，供精确区分 DST 回拨） */
  startIso?: string;
  totalTokens: number;
  costUsd: number;
  /** 由统一双轴公式计算的热力等级（0–4）；旧快照缺省时由渲染层按 24h 窗口回退计算 */
  intensity?: HeatLevel;
}

/**
 * 2) `7d` 历史兼容视图：7 天 × 24 小时矩阵热力格（168 个单元格，v0.3.5 起保留一版兼容，新 UI 改消费 `daily7d`）
 */
export interface DayHourHeatmapCell {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 小时 0 ~ 23 */
  hour: number;
  totalTokens: number;
  costUsd: number;
  intensity: HeatLevel;
}

/**
 * 3) 按天热力格（驱动 `daily7d` 7 天按日热力卡与 `calendar30d` 30 天 Codex 周行日历）
 */
export interface DailyCalendarHeatmapCell extends FourDimTokenCounts {
  /** 日期 YYYY-MM-DD */
  date: string;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
  intensity: HeatLevel;
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

export type ExternalReviewerProviderId = 'gemini-api-key' | 'openai-compatible' | 'local-ollama';

export type ExternalReviewerCostScope = 'session' | 'today' | '7d' | '30d' | 'all';

export function formatExternalReviewerProviderLabel(
  provider: ExternalReviewerProviderId,
  locale: 'zh-CN' | 'en-US' = 'zh-CN'
): string {
  if (provider === 'gemini-api-key') return 'Google AI Studio';
  if (provider === 'openai-compatible') return 'OpenAI API';
  return locale === 'zh-CN' ? '本地 Ollama' : 'Local Ollama';
}

export interface ExternalReviewerUsageRecordInput {
  sessionId: string;
  provider: ExternalReviewerProviderId;
  endpoint: string;
  modelId: string;
  outcome: 'approve' | 'ask' | 'deny' | 'error';
  latencyMs: number;
  usage?: FourDimTokenCounts & { totalTokens?: number; providerReported?: boolean; directCostUsd?: number };
  timestamp?: number;
}

/**
 * 外部复核多 API Provider × 模型维度汇总项（支持历史多个服务商共同汇总计算）
 */
export interface ExternalReviewerProviderBreakdownItem extends TokenCostSummary {
  /** 唯一键：`${provider}:${endpointHost}:${modelId}` */
  key: string;
  provider: ExternalReviewerProviderId;
  endpointHost: string;
  modelId: string;
  displayName: string;
  callCount: number;
  approvedCount: number;
  askCount: number;
  denyCount: number;
  errorCount: number;
  /** 占当前范围总费用（若总费用为 0 则按总 Token）的比例 0 ~ 1 */
  shareRatio: number;
}

export interface ExternalReviewerSessionSummary extends TokenCostSummary {
  sessionId: string;
  callCount: number;
  approvedCount: number;
  askCount: number;
  denyCount: number;
  errorCount: number;
  avgLatencyMs: number;
  providers: ExternalReviewerProviderBreakdownItem[];
  updatedAt: string;
}

export interface ExternalReviewerCumulativeTotals extends TokenCostSummary {
  callCount: number;
  approvedCount: number;
  askCount: number;
  denyCount: number;
  errorCount: number;
  providerCount: number;
}

/**
 * 外部复核（AI 代审）独立用量与花费遥测快照（多 API Provider 联合统计，含客户端累计、当前会话与 24h/7d/30d 分布）
 */
export interface ExternalReviewerTelemetrySnapshot {
  /** 本客户端历史全部 API Provider 累计总消耗（永久累计，不随 30 天窗口裁剪丢失） */
  cumulativeAllTime: ExternalReviewerCumulativeTotals;
  /** 本客户端历史全部 API Provider × 模型联合明细 */
  cumulativeProviders: ExternalReviewerProviderBreakdownItem[];
  /** 按会话统计的外部复核消耗（当前会话视图） */
  bySession: Record<string, ExternalReviewerSessionSummary>;
  /** 24h 按小时柱状序列（长度 24） */
  hourly24h: HourlyTokenBarBucket[];
  /** 7d 按自然日热力序列（长度 7，按 7d 窗口独立计算强度；旧快照可缺省） */
  daily7d?: DailyCalendarHeatmapCell[];
  /** 7d 7×24 天×小时热力矩阵（长度 168，v0.3.5 保留一版向后兼容） */
  matrix7d: DayHourHeatmapCell[];
  /** 30d 按日历天热力序列（长度 30） */
  calendar30d: DailyCalendarHeatmapCell[];
  /** 今日 / 7d / 30d 总计消耗与花费 */
  costByRange: Record<'today' | '7d' | '30d', TokenCostSummary & { callCount: number }>;
  /** 今日 / 7d / 30d 多 API Provider × 模型费用构成 */
  providerBreakdownByRange: Record<'today' | '7d' | '30d', ExternalReviewerProviderBreakdownItem[]>;
  updatedAt: string;
}

export interface ExternalTranslatorUsageRecordInput {
  sessionId: string;
  provider: ExternalReviewerProviderId;
  endpoint: string;
  modelId: string;
  outcome: 'success' | 'fallback' | 'error';
  latencyMs: number;
  usage?: FourDimTokenCounts & { totalTokens?: number; providerReported?: boolean; directCostUsd?: number };
  timestamp?: number;
}

/**
 * 外部翻译 API 多 Provider × 模型维度汇总项（支持历史多个服务商共同汇总计算）
 */
export interface ExternalTranslatorProviderBreakdownItem extends TokenCostSummary {
  /** 唯一键：`${provider}:${endpointHost}:${modelId}` */
  key: string;
  provider: ExternalReviewerProviderId;
  endpointHost: string;
  modelId: string;
  displayName: string;
  callCount: number;
  successCount: number;
  fallbackCount: number;
  errorCount: number;
  /** 占当前范围总费用（若总费用为 0 则按总 Token / 调用次数）的比例 0 ~ 1 */
  shareRatio: number;
}

export interface ExternalTranslatorSessionSummary extends TokenCostSummary {
  sessionId: string;
  callCount: number;
  successCount: number;
  fallbackCount: number;
  errorCount: number;
  avgLatencyMs: number;
  providers: ExternalTranslatorProviderBreakdownItem[];
  updatedAt: string;
}

export interface ExternalTranslatorCumulativeTotals extends TokenCostSummary {
  callCount: number;
  successCount: number;
  fallbackCount: number;
  errorCount: number;
  providerCount: number;
}

/**
 * 外部翻译 API 独立用量与花费遥测快照（多 API Provider 联合统计，含客户端累计、当前会话与 24h/7d/30d 分布）
 */
export interface ExternalTranslatorTelemetrySnapshot {
  /** 本客户端历史全部外部翻译 API Provider 累计总消耗（永久累计，不随 30 天窗口裁剪丢失） */
  cumulativeAllTime: ExternalTranslatorCumulativeTotals;
  /** 本客户端历史全部外部翻译 API Provider × 模型联合明细 */
  cumulativeProviders: ExternalTranslatorProviderBreakdownItem[];
  /** 按会话统计的外部翻译消耗（当前会话 / 对话树视图） */
  bySession: Record<string, ExternalTranslatorSessionSummary>;
  /** 24h 按小时柱状序列（长度 24） */
  hourly24h: HourlyTokenBarBucket[];
  /** 7d 按自然日热力序列（长度 7，按 7d 窗口独立计算强度；旧快照可缺省） */
  daily7d?: DailyCalendarHeatmapCell[];
  /** 7d 7×24 天×小时热力矩阵（长度 168，v0.3.5 保留一版向后兼容） */
  matrix7d: DayHourHeatmapCell[];
  /** 30d 按日历天热力序列（长度 30） */
  calendar30d: DailyCalendarHeatmapCell[];
  /** 今日 / 7d / 30d 总计消耗与花费 */
  costByRange: Record<'today' | '7d' | '30d', TokenCostSummary & { callCount: number }>;
  /** 今日 / 7d / 30d 多 API Provider × 模型费用构成 */
  providerBreakdownByRange: Record<'today' | '7d' | '30d', ExternalTranslatorProviderBreakdownItem[]>;
  updatedAt: string;
}

/**
 * Context & Cost 看板全量快照
 */
export interface TelemetryDashboardSnapshot {
  profileId?: string;
  sequence?: number;
  /** On a push, only these session maps are replaced. Other session details remain valid. */
  changedSessionIds?: string[];
  // 以 sessionId 索引单会话的上下文占用和速度，跨会话的时段费用则保存在下方各范围汇总中。
  activeSessions: Record<string, SessionContextTelemetry>;
  /** 24h 按小时柱状序列（长度 24） */
  hourly24h: HourlyTokenBarBucket[];
  /** 7d 按自然日热力序列（长度 7，按 7d 窗口独立计算强度；旧快照可缺省） */
  daily7d?: DailyCalendarHeatmapCell[];
  /** 7d 7×24 天×小时热力矩阵（长度 168，v0.3.5 保留一版向后兼容） */
  matrix7d: DayHourHeatmapCell[];
  /** 30d 按日历天热力序列（长度 30） */
  calendar30d: DailyCalendarHeatmapCell[];
  /** 今日 / 7d / 30d 总计费用摘要 */
  costByRange: Record<'today' | '7d' | '30d', TokenCostSummary>;
  /** 今日 / 7d / 30d 分模型费用构成 */
  modelBreakdownByRange: Record<'today' | '7d' | '30d', ModelCostBreakdownItem[]>;
  /** 各会话内分模型费用构成 */
  sessionModelBreakdowns: Record<string, ModelCostBreakdownItem[]>;
  /** 外部复核（AI 代审）API 累计与分时段用量统计（多服务商联合计算） */
  externalReviewer?: ExternalReviewerTelemetrySnapshot;
  /** 外部翻译 API 累计与分时段用量统计（多服务商联合计算） */
  externalTranslator?: ExternalTranslatorTelemetrySnapshot;
  /** 外部语音转写 API 独立用量与时长账本（单列展示，不混入 ACP Token 热力图） */
  externalVoice?: VoiceExternalTelemetrySnapshot;
  /** 当前生效的模型单价表 */
  rateCards: ModelRateCard[];
  pricingSource: TelemetryPricingSource;
  generatedAt: string;
}

export function mergeTelemetryDashboard(previous: TelemetryDashboardSnapshot, incoming: TelemetryDashboardSnapshot): TelemetryDashboardSnapshot {
  const ids = incoming.changedSessionIds;
  if (incoming.sequence !== undefined && previous.sequence !== undefined && previous.sequence > incoming.sequence) {
    // A push can arrive while startup is still waiting for the rest of the full desktop bundle.
    if (!ids && previous.changedSessionIds && previous.profileId === incoming.profileId) return mergeTelemetryDashboard(incoming, previous);
    return previous;
  }
  if (!ids || previous.profileId !== incoming.profileId) return incoming;
  const merge = <T>(old: Record<string, T>, next: Record<string, T>) => {
    const result = { ...old };
    for (const id of ids) delete result[id];
    return Object.assign(result, next);
  };
  return {
    ...incoming,
    changedSessionIds: previous.changedSessionIds ? [...new Set([...previous.changedSessionIds, ...ids])] : undefined,
    activeSessions: merge(previous.activeSessions, incoming.activeSessions),
    sessionModelBreakdowns: merge(previous.sessionModelBreakdowns, incoming.sessionModelBreakdowns),
    externalReviewer: incoming.externalReviewer
      ? {
          ...incoming.externalReviewer,
          bySession: merge(previous.externalReviewer?.bySession ?? {}, incoming.externalReviewer.bySession),
        }
      : previous.externalReviewer,
    externalTranslator: incoming.externalTranslator
      ? {
          ...incoming.externalTranslator,
          bySession: merge(previous.externalTranslator?.bySession ?? {}, incoming.externalTranslator.bySession),
        }
      : previous.externalTranslator,
    externalVoice: incoming.externalVoice ?? previous.externalVoice,
  };
}

export interface ConversationTreeTotalCost {
  totalCostUsd: number;
  modelCostUsd: number;
  reviewerCostUsd: number;
  translatorCostUsd: number;
  branchCount: number;
}

/**
 * 纯函数：汇总当前整棵对话树全部去重分支（主对话 + 全部兄弟/嵌套子分支）的总花费，
 * 覆盖主模型花费 + 外部代审花费 + 外部翻译 API 花费。
 */
export function computeConversationTreeTotalCost(
  sessionId: string | null,
  conversationTree: ConversationTreeState | undefined,
  dashboard: TelemetryDashboardSnapshot | undefined | null
): ConversationTreeTotalCost {
  const branchIds = new Set<string>();
  if (conversationTree) {
    if (typeof conversationTree.rootSessionId === 'string' && conversationTree.rootSessionId.trim()) {
      branchIds.add(conversationTree.rootSessionId.trim());
    }
    if (typeof conversationTree.activeBranchId === 'string' && conversationTree.activeBranchId.trim()) {
      branchIds.add(conversationTree.activeBranchId.trim());
    }
    if (Array.isArray(conversationTree.nodes)) {
      for (const node of conversationTree.nodes) {
        if (node && typeof node.branchId === 'string' && node.branchId.trim()) {
          branchIds.add(node.branchId.trim());
        }
      }
    }
    if (conversationTree.nodesById && typeof conversationTree.nodesById === 'object') {
      for (const key of Object.keys(conversationTree.nodesById)) {
        if (key.trim()) branchIds.add(key.trim());
      }
    }
  }
  if (typeof sessionId === 'string' && sessionId.trim()) {
    branchIds.add(sessionId.trim());
  }

  const safeCost = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

  let modelCostUsd = 0;
  let reviewerCostUsd = 0;
  let translatorCostUsd = 0;

  if (dashboard) {
    for (const id of branchIds) {
      modelCostUsd += safeCost(dashboard.activeSessions?.[id]?.costSummary?.totalCostUsd);
      reviewerCostUsd += safeCost(dashboard.externalReviewer?.bySession?.[id]?.totalCostUsd);
      translatorCostUsd += safeCost(dashboard.externalTranslator?.bySession?.[id]?.totalCostUsd);
    }
  }

  return {
    totalCostUsd: modelCostUsd + reviewerCostUsd + translatorCostUsd,
    modelCostUsd,
    reviewerCostUsd,
    translatorCostUsd,
    branchCount: branchIds.size,
  };
}

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AcpTokenUsage } from '../../shared/acp-protocol';
import type { ChatMessageItem } from '../../shared/session-contract';
import {
  calculateTokenCost,
  resolveModelCompactionLimit,
  resolveModelRateCard,
  DEFAULT_MODEL_RATE_CARDS,
} from '../../shared/telemetry-contract';
import type {
  AttachmentAuditItem,
  ContextCompactionRecord,
  ContextTokenBreakdown,
  ExternalReviewerProviderBreakdownItem,
  ExternalReviewerProviderId,
  ExternalReviewerSessionSummary,
  ExternalReviewerTelemetrySnapshot,
  ExternalReviewerUsageRecordInput,
  FourDimTokenCounts,
  ModelCostBreakdownItem,
  ModelRateCard,
  SessionContextTelemetry,
  TelemetryDashboardSnapshot,
  TokenCostSummary,
} from '../../shared/telemetry-contract';
import { ClientStore } from '../storage/client-store';

export function estimateTokens(text: string): number {
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.ceil(han + (text.length - han) / 4);
}

const KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'thinkingTokens'] as const;
const zero = (): FourDimTokenCounts => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
});

function add(a: FourDimTokenCounts, b: FourDimTokenCounts): FourDimTokenCounts {
  return Object.fromEntries(KEYS.map((key) => [key, a[key] + b[key]])) as unknown as FourDimTokenCounts;
}

const intensity = (n: number): 0 | 1 | 2 | 3 | 4 =>
  n === 0 ? 0 : n < 1000 ? 1 : n < 10000 ? 2 : n < 100000 ? 3 : 4;

interface HourRecord extends FourDimTokenCounts {
  hourKey: string;
  modelId: string;
  sessions: string[];
}

interface ExternalReviewerBucket extends FourDimTokenCounts {
  provider: ExternalReviewerProviderId;
  endpointHost: string;
  modelId: string;
  callCount: number;
  approvedCount: number;
  askCount: number;
  denyCount: number;
  errorCount: number;
  directCostUsd: number;
  hasDirectCost: boolean;
  totalLatencyMs: number;
}

interface ExternalReviewerHourRecord extends ExternalReviewerBucket {
  hourKey: string;
  sessions: string[];
}

interface ExternalReviewerSessionBucketStore {
  buckets: Map<string, ExternalReviewerBucket>;
  updatedAt: string;
}

function extractSafeEndpointHost(endpoint: string, provider: ExternalReviewerProviderId): string {
  try {
    const parsed = new URL(endpoint);
    return parsed.host || parsed.hostname || provider;
  } catch {
    return provider;
  }
}

function isValidExtProvider(val: unknown): val is ExternalReviewerProviderId {
  return val === 'gemini-api-key' || val === 'openai-compatible' || val === 'local-ollama';
}

function sanitizeExternalBucket(raw: unknown): ExternalReviewerBucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidExtProvider(r.provider) || typeof r.modelId !== 'string' || !r.modelId.trim()) return null;
  const safeInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const safeFloat = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    provider: r.provider,
    endpointHost: typeof r.endpointHost === 'string' && r.endpointHost.trim() ? r.endpointHost.trim() : r.provider,
    modelId: r.modelId.trim(),
    inputTokens: safeInt(r.inputTokens),
    cachedInputTokens: safeInt(r.cachedInputTokens),
    outputTokens: safeInt(r.outputTokens),
    thinkingTokens: safeInt(r.thinkingTokens),
    callCount: safeInt(r.callCount),
    approvedCount: safeInt(r.approvedCount),
    askCount: safeInt(r.askCount),
    denyCount: safeInt(r.denyCount),
    errorCount: safeInt(r.errorCount),
    directCostUsd: safeFloat(r.directCostUsd),
    hasDirectCost: Boolean(r.hasDirectCost),
    totalLatencyMs: safeInt(r.totalLatencyMs),
  };
}

function mergeExternalBucket(target: ExternalReviewerBucket, src: ExternalReviewerBucket): ExternalReviewerBucket {
  return {
    ...target,
    inputTokens: target.inputTokens + src.inputTokens,
    cachedInputTokens: target.cachedInputTokens + src.cachedInputTokens,
    outputTokens: target.outputTokens + src.outputTokens,
    thinkingTokens: target.thinkingTokens + src.thinkingTokens,
    callCount: target.callCount + src.callCount,
    approvedCount: target.approvedCount + src.approvedCount,
    askCount: target.askCount + src.askCount,
    denyCount: target.denyCount + src.denyCount,
    errorCount: target.errorCount + src.errorCount,
    directCostUsd: target.directCostUsd + src.directCostUsd,
    hasDirectCost: target.hasDirectCost || src.hasDirectCost,
    totalLatencyMs: target.totalLatencyMs + src.totalLatencyMs,
  };
}

interface Turn {
  counts: FourDimTokenCounts;
  modelId: string;
  hourKey: string;
  startedAt: number;
  firstChunkAt?: number;
  lastChunkAt?: number;
  streamedTokens: number;
  text: Partial<Record<keyof ContextTokenBreakdown, string>>;
}

export interface TelemetryOptions {
  store: ClientStore;
  now?: () => number;
  maxContextTokens?: number;
  rateCards?: ModelRateCard[];
}

export class TelemetryStore extends EventEmitter {
  private states = new Map<string, SessionContextTelemetry>();
  private ledger = new Map<string, HourRecord>();
  private sessionCounts = new Map<string, Map<string, FourDimTokenCounts>>();
  private sessionSpeedStats = new Map<string, { totalGeneratedTokens: number; totalDurationSec: number; completedTurns: number }>();
  private samples = new Map<string, Array<{ time: number; tokens: number }>>();
  private turns = new Map<string, Turn>();
  private reportedUsed = new Map<string, number>();
  private checkpointLimits = new Map<string, number>();
  private learnedModelLimits = new Map<string, number>();
  private compactionsBySession = new Map<string, ContextCompactionRecord[]>();
  private pendingCompaction = new Map<string, number>();
  private extLedger = new Map<string, ExternalReviewerHourRecord>();
  private extCumulative = new Map<string, ExternalReviewerBucket>();
  private extBySession = new Map<string, ExternalReviewerSessionBucketStore>();
  private extUpdatedAt = '';
  private rateCards: ModelRateCard[];
  private customRates: boolean;
  private timer?: NodeJS.Timeout;
  private now: () => number;

  constructor(private options: TelemetryOptions) {
    super();
    this.now = options.now || Date.now;
    const saved = options.store.read<ModelRateCard[] | null>('model-rate-cards.json', null);
    this.customRates = !!(options.rateCards || saved);
    this.rateCards = structuredClone(options.rateCards || saved || [...DEFAULT_MODEL_RATE_CARDS]);
    try {
      this.validateRates(this.rateCards);
    } catch {
      this.rateCards = structuredClone([...DEFAULT_MODEL_RATE_CARDS]);
      this.customRates = false;
    }

    const records = options.store.read<HourRecord[]>('token-hours.json', []);
    for (const record of Array.isArray(records) ? records : []) {
      if (
        /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(record.hourKey) &&
        typeof record.modelId === 'string' &&
        KEYS.every((key) => Number.isFinite(record[key]) && record[key] >= 0) &&
        Array.isArray(record.sessions)
      ) {
        this.ledger.set(`${record.hourKey}\0${record.modelId}`, record);
      }
    }

    const savedCompactions = options.store.read<Record<string, ContextCompactionRecord[]>>('compactions.json', {});
    if (savedCompactions && typeof savedCompactions === 'object') {
      for (const [sid, list] of Object.entries(savedCompactions)) {
        if (Array.isArray(list)) this.compactionsBySession.set(sid, list.slice(-50));
      }
    }

    const savedExtHours = options.store.read<ExternalReviewerHourRecord[]>('external-reviewer-hours.json', []);
    for (const rawRec of Array.isArray(savedExtHours) ? savedExtHours : []) {
      if (!rawRec || typeof rawRec.hourKey !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(rawRec.hourKey)) continue;
      const clean = sanitizeExternalBucket(rawRec);
      if (!clean) continue;
      const sessions = Array.isArray(rawRec.sessions)
        ? rawRec.sessions.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      const bKey = `${clean.provider}\0${clean.endpointHost}\0${clean.modelId}`;
      this.extLedger.set(`${rawRec.hourKey}\0${bKey}`, { ...clean, hourKey: rawRec.hourKey, sessions });
    }

    const savedExtTotals = options.store.read<{
      cumulative?: Record<string, ExternalReviewerBucket>;
      sessions?: Record<string, { buckets?: Record<string, ExternalReviewerBucket>; updatedAt?: string }>;
      updatedAt?: string;
    }>('external-reviewer-totals.json', {});
    if (savedExtTotals?.cumulative && typeof savedExtTotals.cumulative === 'object') {
      for (const rawBucket of Object.values(savedExtTotals.cumulative)) {
        const clean = sanitizeExternalBucket(rawBucket);
        if (!clean) continue;
        const bKey = `${clean.provider}\0${clean.endpointHost}\0${clean.modelId}`;
        const prev = this.extCumulative.get(bKey);
        this.extCumulative.set(bKey, prev ? mergeExternalBucket(prev, clean) : clean);
      }
    }
    if (savedExtTotals?.sessions && typeof savedExtTotals.sessions === 'object') {
      for (const [sid, sessData] of Object.entries(savedExtTotals.sessions)) {
        if (!sessData || typeof sessData !== 'object' || !sessData.buckets) continue;
        const inner = new Map<string, ExternalReviewerBucket>();
        for (const rawBucket of Object.values(sessData.buckets)) {
          const clean = sanitizeExternalBucket(rawBucket);
          if (!clean) continue;
          const bKey = `${clean.provider}\0${clean.endpointHost}\0${clean.modelId}`;
          const prev = inner.get(bKey);
          inner.set(bKey, prev ? mergeExternalBucket(prev, clean) : clean);
        }
        if (inner.size > 0) {
          this.extBySession.set(sid, {
            buckets: inner,
            updatedAt: typeof sessData.updatedAt === 'string' ? sessData.updatedAt : new Date(this.now()).toISOString(),
          });
        }
      }
    }
    if (typeof savedExtTotals?.updatedAt === 'string') {
      this.extUpdatedAt = savedExtTotals.updatedAt;
    }

    const savedSessions = options.store.read<{
      states?: Record<string, SessionContextTelemetry>;
      sessionCounts?: Record<string, Record<string, FourDimTokenCounts>>;
      sessionSpeedStats?: Record<string, { totalGeneratedTokens: number; totalDurationSec: number; completedTurns: number }>;
      reportedUsed?: Record<string, number>;
      checkpointLimits?: Record<string, number>;
      learnedModelLimits?: Record<string, number>;
    }>('session-telemetry.json', {});
    if (savedSessions?.sessionSpeedStats && typeof savedSessions.sessionSpeedStats === 'object') {
      for (const [sid, stat] of Object.entries(savedSessions.sessionSpeedStats)) {
        if (
          stat &&
          typeof stat === 'object' &&
          Number.isFinite(stat.totalGeneratedTokens) &&
          stat.totalGeneratedTokens >= 0 &&
          Number.isFinite(stat.totalDurationSec) &&
          stat.totalDurationSec >= 0 &&
          Number.isFinite(stat.completedTurns) &&
          stat.completedTurns >= 0
        ) {
          this.sessionSpeedStats.set(sid, {
            totalGeneratedTokens: stat.totalGeneratedTokens,
            totalDurationSec: stat.totalDurationSec,
            completedTurns: stat.completedTurns,
          });
        }
      }
    }
    if (savedSessions?.checkpointLimits && typeof savedSessions.checkpointLimits === 'object') {
      for (const [sid, lim] of Object.entries(savedSessions.checkpointLimits)) {
        if (typeof lim === 'number' && lim >= 16_000 && lim <= 2_000_000) {
          this.checkpointLimits.set(sid, lim);
        }
      }
    }
    if (savedSessions?.learnedModelLimits && typeof savedSessions.learnedModelLimits === 'object') {
      for (const [mid, lim] of Object.entries(savedSessions.learnedModelLimits)) {
        const key = mid.trim().toLowerCase();
        if (key && key !== 'default' && typeof lim === 'number' && lim >= 16_000 && lim <= 2_000_000) {
          this.learnedModelLimits.set(key, Math.round(lim));
        }
      }
    }
    if (savedSessions?.reportedUsed && typeof savedSessions.reportedUsed === 'object') {
      for (const [sid, val] of Object.entries(savedSessions.reportedUsed)) {
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) this.reportedUsed.set(sid, val);
      }
    }
    if (savedSessions?.sessionCounts && typeof savedSessions.sessionCounts === 'object') {
      for (const [sid, modelMap] of Object.entries(savedSessions.sessionCounts)) {
        if (modelMap && typeof modelMap === 'object') {
          const inner = new Map<string, FourDimTokenCounts>();
          for (const [mid, counts] of Object.entries(modelMap)) {
            if (counts && KEYS.every((k) => Number.isFinite(counts[k]) && counts[k] >= 0)) {
              inner.set(mid, { ...counts });
            }
          }
          if (inner.size > 0) this.sessionCounts.set(sid, inner);
        }
      }
    }
    if (savedSessions?.states && typeof savedSessions.states === 'object') {
      for (const [sid, st] of Object.entries(savedSessions.states)) {
        if (st && typeof st === 'object' && st.sessionId === sid && st.breakdown) {
          const copy = structuredClone(st);
          // 将旧版落盘的 1,048,576 原始输入容量统一迁移为实际模型压缩窗口上限
          copy.maxContextTokens = this.resolveMaxWindow(sid, copy.modelId);
          copy.usageRatio = Math.min(1, copy.usedContextTokens / Math.max(1, copy.maxContextTokens));
          const speedStat = this.sessionSpeedStats.get(sid);
          if (speedStat && speedStat.totalGeneratedTokens > 0 && speedStat.totalDurationSec > 0) {
            copy.averageTokensPerSecond = Math.round((speedStat.totalGeneratedTokens / speedStat.totalDurationSec) * 10) / 10;
          } else if (copy.averageTokensPerSecond === undefined) {
            copy.averageTokensPerSecond = copy.currentTokensPerSecond || 0;
          }
          const promptTotal = (copy.costSummary?.inputTokens || 0) + (copy.costSummary?.cachedInputTokens || 0);
          copy.averageCacheHitRate = promptTotal > 0
            ? Math.min(1, Math.max(0, (copy.costSummary?.cachedInputTokens || 0) / promptTotal))
            : 0;
          this.states.set(sid, copy);
        }
      }
    }
  }

  /** 选择压缩窗口时：显式上限 > 本会话实测阈值 > 同模型历史实测学习值 > 内置默认估计。 */
  private resolveMaxWindow(sessionId: string, modelId?: string): number {
    if (this.options.maxContextTokens) return this.options.maxContextTokens;
    const direct = this.checkpointLimits.get(sessionId);
    if (direct) return direct;
    const modelKey = (modelId || '').trim().toLowerCase();
    if (modelKey && modelKey !== 'default') {
      const learned = this.learnedModelLimits.get(modelKey);
      if (learned) return learned;
    }
    return resolveModelCompactionLimit(modelId);
  }

  /**
   * 写入从会话库 `executor_metadata -> cascade_config.checkpoint_config.max_token_limit` 实测读出的压缩阈值，
   * 并按模型 ID 持久化学习结果，让新模型（如 Neon 或未来新发布模型）在后续新会话首秒即可获得准确上限。
   */
  setCheckpointWindowLimit(sessionId: string, limitTokens: number, modelId?: string): void {
    if (!Number.isFinite(limitTokens) || limitTokens < 16_000 || limitTokens > 2_000_000) return;
    const rounded = Math.round(limitTokens);
    const resolvedModel = (modelId || this.states.get(sessionId)?.modelId || '').trim().toLowerCase();
    const learnedChanged = Boolean(resolvedModel && resolvedModel !== 'default' && this.learnedModelLimits.get(resolvedModel) !== rounded);
    const sessionChanged = this.checkpointLimits.get(sessionId) !== rounded;
    if (!sessionChanged && !learnedChanged) return;

    this.checkpointLimits.set(sessionId, rounded);
    if (resolvedModel && resolvedModel !== 'default') {
      this.learnedModelLimits.set(resolvedModel, rounded);
    }

    let updatedAny = false;
    const state = this.states.get(sessionId);
    if (state && !this.options.maxContextTokens) {
      state.maxContextTokens = rounded;
      this.refresh(state, true);
      updatedAny = true;
    }
    // 同步刷新使用同一新模型且尚未写入独立实测值的其他活跃会话
    if (resolvedModel && resolvedModel !== 'default' && !this.options.maxContextTokens) {
      for (const [sid, other] of this.states) {
        if (sid === sessionId || this.checkpointLimits.has(sid)) continue;
        if ((other.modelId || '').trim().toLowerCase() === resolvedModel && other.maxContextTokens !== rounded) {
          other.maxContextTokens = rounded;
          this.refresh(other, true);
          updatedAny = true;
        }
      }
    }
    if (updatedAny || learnedChanged) {
      this.scheduleFlush();
    }
  }

  /** 切换会话模型时清除旧会话缓存阈值并立即按新模型的实测学习值/默认阈值更新显示窗口。 */
  clearSessionCheckpointLimit(sessionId: string, nextModelId?: string): void {
    this.checkpointLimits.delete(sessionId);
    const state = this.states.get(sessionId);
    if (!state) return;
    if (nextModelId) state.modelId = nextModelId;
    if (!this.options.maxContextTokens) {
      state.maxContextTokens = this.resolveMaxWindow(sessionId, state.modelId);
      this.refresh(state, true);
      this.scheduleFlush();
    }
  }

  private validateRates(rates: ModelRateCard[]): void {
    if (!Array.isArray(rates) || !rates.length || rates.length > 100) {
      throw new Error('模型单价表须包含 1 至 100 项');
    }
    const ids = new Set<string>();
    for (const rate of rates) {
      if (
        typeof rate.modelId !== 'string' ||
        !rate.modelId.trim() ||
        rate.modelId.length > 160 ||
        ids.has(rate.modelId.toLowerCase()) ||
        typeof rate.displayName !== 'string'
      ) {
        throw new Error('模型单价 ID 无效或重复');
      }
      ids.add(rate.modelId.toLowerCase());
      for (const key of [
        'inputPerMillionUsd',
        'cachedInputPerMillionUsd',
        'outputPerMillionUsd',
        'thinkingPerMillionUsd',
      ] as const) {
        if (!Number.isFinite(rate[key]) || rate[key] < 0 || rate[key] > 1000000) {
          throw new Error('Token 单价必须是有限非负数');
        }
      }
    }
    if (!ids.has('default')) throw new Error('单价表须保留 default 参考项');
  }

  updateModelRateCards(rates: ModelRateCard[]): TelemetryDashboardSnapshot {
    this.validateRates(rates);
    this.rateCards = structuredClone(rates);
    this.customRates = true;
    this.options.store.write('model-rate-cards.json', this.rateCards);
    for (const state of this.states.values()) this.refresh(state, false);
    const snapshot = this.snapshot();
    this.emit('updated', snapshot);
    return snapshot;
  }

  ensure(sessionId: string, modelId = ''): SessionContextTelemetry {
    let state = this.states.get(sessionId);
    let createdOrChanged = false;
    if (!state) {
      createdOrChanged = true;
      state = {
        sessionId,
        modelId,
        maxContextTokens: this.resolveMaxWindow(sessionId, modelId),
        usedContextTokens: 0,
        usageRatio: 0,
        pressureLevel: 'healthy',
        breakdown: {
          systemAndRulesTokens: 0,
          userMessagesTokens: 0,
          agentMessagesTokens: 0,
          thoughtTokens: 0,
          toolCallsTokens: 0,
          attachmentsTokens: 0,
        },
        attachments: [],
        compactions: structuredClone(this.compactionsBySession.get(sessionId) || []),
        currentTokensPerSecond: 0,
        averageTokensPerSecond: 0,
        peakTokensPerSecond: 0,
        averageCacheHitRate: 0,
        costSummary: calculateTokenCost(zero(), resolveModelRateCard(modelId, this.rateCards)),
        usageSource: 'estimated',
        pricingSource: this.customRates ? 'user-custom-rate' : 'reference-api-estimate',
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.states.set(sessionId, state);
    }
    if (modelId && state.modelId !== modelId) {
      state.modelId = modelId;
      createdOrChanged = true;
    }
    const targetWindow = this.resolveMaxWindow(sessionId, state.modelId);
    if (state.maxContextTokens !== targetWindow) {
      state.maxContextTokens = targetWindow;
      state.usageRatio = Math.min(1, state.usedContextTokens / Math.max(1, state.maxContextTokens));
      createdOrChanged = true;
    }
    if (createdOrChanged) {
      this.emit('updated', this.snapshot());
    }
    return state;
  }

  /**
   * 根据本地持久化的会话消息回填 Context 构成与会话费用（用于历史已保存对话恢复展示）。
   */
  hydrateFromMessages(sessionId: string, modelId: string, messages: ChatMessageItem[]): SessionContextTelemetry {
    const state = this.ensure(sessionId, modelId);
    // 只有尚无占用统计的会话才由历史消息回填，反复打开同一会话时沿用已有统计。
    if (!messages.length || state.usedContextTokens > 0) return state;

    let userTokens = 0;
    let agentTokens = 0;
    let thoughtTokens = 0;
    let toolTokens = 0;
    let attachmentTokens = 0;

    for (const msg of messages) {
      if (msg.role === 'user') {
        userTokens += estimateTokens(msg.content || '');
        for (const att of msg.attachments || []) {
          attachmentTokens += Math.ceil(Math.max(0, att.sizeBytes || 0) / 4);
        }
      } else if (msg.role === 'assistant') {
        agentTokens += estimateTokens(msg.content || '');
        for (const th of msg.thoughts || []) {
          thoughtTokens += estimateTokens(th.originalText || '');
        }
        for (const tc of msg.toolCalls || []) {
          toolTokens += estimateTokens(`${tc.argsSummary || ''}\n${tc.outputPreview || ''}`);
        }
      } else if (msg.role === 'system') {
        state.breakdown.systemAndRulesTokens += estimateTokens(msg.content || '');
      }
    }

    if (userTokens + agentTokens + thoughtTokens + toolTokens + attachmentTokens === 0) {
      return state;
    }

    state.breakdown.userMessagesTokens = userTokens;
    state.breakdown.agentMessagesTokens = agentTokens;
    state.breakdown.thoughtTokens = thoughtTokens;
    state.breakdown.toolCallsTokens = toolTokens;
    state.breakdown.attachmentsTokens = attachmentTokens;

    if (!this.sessionCounts.has(sessionId)) {
      const mId = state.modelId || modelId || 'default';
      const inner = new Map<string, FourDimTokenCounts>();
      inner.set(mId, {
        inputTokens: userTokens + attachmentTokens + state.breakdown.systemAndRulesTokens,
        cachedInputTokens: 0,
        outputTokens: agentTokens + toolTokens,
        thinkingTokens: thoughtTokens,
      });
      this.sessionCounts.set(sessionId, inner);
    }

    this.refresh(state, true);
    this.scheduleFlush();
    return state;
  }

  /** 把短时间内的账本更新合并为一次落盘，定时器执行完清空引用，下一批分片可重新排队。 */
  private scheduleFlush(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch {
          this.emit('storageError', 'Token 历史账本保存失败');
        }
      }, 250);
      this.timer.unref();
    }
  }

  beginTurn(sessionId: string, text: string, attachments: AttachmentAuditItem[] = []): void {
    const state = this.ensure(sessionId);
    if (this.turns.has(sessionId)) throw new Error('同一会话不能重复开启遥测回合');
    const input = estimateTokens(text);
    const attachmentsTokens = attachments.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens), 0);
    this.turns.set(sessionId, {
      counts: zero(),
      modelId: state.modelId || 'default',
      hourKey: this.hourKey(),
      startedAt: this.now(),
      streamedTokens: 0,
      text: {},
    });
    this.samples.set(sessionId, []);
    state.breakdown.userMessagesTokens += input;
    state.breakdown.attachmentsTokens += attachmentsTokens;
    state.attachments = [...state.attachments, ...attachments].slice(-200);
    this.account(sessionId, { ...zero(), inputTokens: input + attachmentsTokens });
    this.refresh(state);
  }

  addChunk(sessionId: string, text: string, category: keyof ContextTokenBreakdown = 'agentMessagesTokens'): void {
    const state = this.ensure(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) {
      state.breakdown[category] += estimateTokens(text);
      this.refresh(state);
      return;
    }
    // 估算整段文本后只计入与上一版本的差额，避免同一段文字因网络分片更碎而被多次向上取整。
    const previous = turn.text[category] || '';
    turn.text[category] = previous + text;
    const tokens = estimateTokens(turn.text[category]!) - estimateTokens(previous);
    state.breakdown[category] += tokens;
    const field = category === 'thoughtTokens' ? 'thinkingTokens' : 'outputTokens';
    this.account(sessionId, { ...turn.counts, [field]: turn.counts[field] + tokens });

    const now = this.now();
    if (tokens > 0) {
      turn.firstChunkAt ??= now;
      turn.lastChunkAt = now;
      turn.streamedTokens += tokens;
    }
    const samples = this.samples.get(sessionId) || [];
    samples.push({ time: now, tokens });
    this.samples.set(sessionId, samples);
    this.refresh(state);
  }

  /**
   * 消费官方 `agy acp` 的 `usage_update` 通知（`{ used, size }`），同步真实上下文窗口占用，
   * 并自动识别上下文窗口压缩事件。
   */
  applyContextWindow(sessionId: string, used?: number, size?: number): void {
    const state = this.ensure(sessionId);
    // 注意：ACP usage_update 的 size=1048576 为原始输入容量上限，并非实际 Checkpointer 压缩窗口（如 512k/256k）；
    // 仅当未固定测试阈值且服务端返回了 <= 800k 的专门压缩窗口值时才采纳 size，否则维持当前模型的真实压缩窗口上限。
    if (
      typeof size === 'number' &&
      Number.isFinite(size) &&
      size > 0 &&
      size <= 800_000 &&
      !this.options.maxContextTokens &&
      !this.checkpointLimits.has(sessionId)
    ) {
      state.maxContextTokens = size;
    } else {
      state.maxContextTokens = this.resolveMaxWindow(sessionId, state.modelId);
    }
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) {
      const prevReported = this.reportedUsed.get(sessionId);
      // 手动压缩与自动压缩分开记账。自动记录由两次已上报用量的显著回落推断，并非服务端的显式完成事件。
      if (this.pendingCompaction.has(sessionId)) {
        const before = this.pendingCompaction.get(sessionId)!;
        if (used < before || !this.turns.has(sessionId)) {
          this.pendingCompaction.delete(sessionId);
          this.recordCompaction(sessionId, before, used, state.maxContextTokens, 'manual');
        }
      } else if (prevReported !== undefined && prevReported >= 2000 && used > 0 && used <= Math.floor(prevReported * 0.75)) {
        this.recordCompaction(sessionId, prevReported, used, state.maxContextTokens, 'auto');
      }
      this.reportedUsed.set(sessionId, used);
      state.usageSource = 'acp-reported';
    }
    this.refresh(state);
  }

  beginManualCompaction(sessionId: string): number {
    const state = this.ensure(sessionId);
    const before = state.usedContextTokens;
    this.pendingCompaction.set(sessionId, before);
    return before;
  }

  finishManualCompaction(sessionId: string): ContextCompactionRecord | undefined {
    const state = this.ensure(sessionId);
    // 用量通知可能已先行记录本次手动压缩。此时直接取最近记录，避免发送完成回调再记一条。
    if (!this.pendingCompaction.has(sessionId)) {
      return state.compactions?.at(-1);
    }
    const before = this.pendingCompaction.get(sessionId)!;
    this.pendingCompaction.delete(sessionId);

    let after = state.usedContextTokens;
    if (!this.reportedUsed.has(sessionId)) {
      // 未收到服务端 usage_update 时，对估算上下文执行摘要折算
      const ratio = 0.28;
      state.breakdown = {
        systemAndRulesTokens: state.breakdown.systemAndRulesTokens,
        userMessagesTokens: Math.round(state.breakdown.userMessagesTokens * ratio),
        agentMessagesTokens: Math.round(state.breakdown.agentMessagesTokens * ratio),
        thoughtTokens: Math.round(state.breakdown.thoughtTokens * 0.15),
        toolCallsTokens: Math.round(state.breakdown.toolCallsTokens * 0.15),
        attachmentsTokens: Math.round(state.breakdown.attachmentsTokens * 0.5),
      };
      after = Object.values(state.breakdown).reduce((sum, count) => sum + count, 0);
    }
    const rec = this.recordCompaction(sessionId, before, after, state.maxContextTokens, 'manual');
    this.refresh(state);
    return rec;
  }

  private recordCompaction(
    sessionId: string,
    beforeTokens: number,
    afterTokens: number,
    maxContextTokens: number,
    trigger: 'manual' | 'auto'
  ): ContextCompactionRecord {
    const state = this.ensure(sessionId);
    const record: ContextCompactionRecord = {
      id: randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
      trigger,
      beforeTokens: Math.max(0, Math.round(beforeTokens)),
      afterTokens: Math.max(0, Math.round(afterTokens)),
      savedTokens: Math.max(0, Math.round(beforeTokens - afterTokens)),
      maxContextTokens,
    };
    const next = [...(this.compactionsBySession.get(sessionId) || []), record].slice(-50);
    this.compactionsBySession.set(sessionId, next);
    state.compactions = structuredClone(next);
    try {
      this.options.store.write('compactions.json', Object.fromEntries(this.compactionsBySession));
    } catch {
      /* 忽略只读环境保存异常 */
    }
    return record;
  }

  /** 用 ACP 返回的累计量修正本轮估算。缓存输入和思考是对应总量的子集，拆成四项后才可独立计价。 */
  applyUsage(sessionId: string, usage: AcpTokenUsage): void {
    const state = this.ensure(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const valid = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const inputTotal = valid(usage.inputTokens)
      ? usage.inputTokens
      : turn.counts.inputTokens + turn.counts.cachedInputTokens;
    const outputTotal = valid(usage.outputTokens)
      ? usage.outputTokens
      : turn.counts.outputTokens + turn.counts.thinkingTokens;
    const cached = Math.min(
      inputTotal,
      valid(usage.cachedInputTokens) ? usage.cachedInputTokens : turn.counts.cachedInputTokens
    );
    const thinking = Math.min(
      outputTotal,
      valid(usage.thoughtTokens) ? usage.thoughtTokens : turn.counts.thinkingTokens
    );
    this.account(sessionId, {
      inputTokens: inputTotal - cached,
      cachedInputTokens: cached,
      outputTokens: outputTotal - thinking,
      thinkingTokens: thinking,
    });
    if (valid(usage.inputTokens) || valid(usage.outputTokens)) state.usageSource = 'mixed';
    this.refresh(state);
  }

  /** 接收本回合的新累计值，以差额更新会话和小时账本。服务端重复回报同一用量时，账本增量为零。 */
  private account(sessionId: string, counts: FourDimTokenCounts): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const delta = Object.fromEntries(
      KEYS.map((key) => [key, counts[key] - turn.counts[key]])
    ) as unknown as FourDimTokenCounts;
    turn.counts = { ...counts };
    const models = this.sessionCounts.get(sessionId) || new Map<string, FourDimTokenCounts>();
    models.set(turn.modelId, add(models.get(turn.modelId) || zero(), delta));
    this.sessionCounts.set(sessionId, models);
    const key = `${turn.hourKey}\0${turn.modelId}`;
    const record = this.ledger.get(key) || { ...zero(), hourKey: turn.hourKey, modelId: turn.modelId, sessions: [] };
    for (const dimension of KEYS) record[dimension] = Math.max(0, record[dimension] + delta[dimension]);
    if (!record.sessions.includes(sessionId)) record.sessions.push(sessionId);
    this.ledger.set(key, record);
    this.scheduleFlush();
  }

  endTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    const state = this.states.get(sessionId);
    if (!state) return;
    if (turn) {
      // 回合结束时取流式估算与已记账生成量的较大值。若有首末分片时间，速度只计生成区间。
      const totalGenerated = Math.max(
        turn.streamedTokens,
        turn.counts.outputTokens + turn.counts.thinkingTokens
      );
      if (totalGenerated > 0) {
        const now = this.now();
        const spanSec =
          turn.firstChunkAt !== undefined &&
          turn.lastChunkAt !== undefined &&
          turn.lastChunkAt > turn.firstChunkAt
            ? (turn.lastChunkAt - turn.firstChunkAt) / 1000
            : Math.max(0.4, (now - turn.startedAt) / 1000);
        const clampedSpan = Math.max(0.2, spanSec);
        state.currentTokensPerSecond = Math.round((totalGenerated / clampedSpan) * 10) / 10;
        state.peakTokensPerSecond = Math.max(state.peakTokensPerSecond, state.currentTokensPerSecond);
        const prev = this.sessionSpeedStats.get(sessionId) || {
          totalGeneratedTokens: 0,
          totalDurationSec: 0,
          completedTurns: 0,
        };
        prev.totalGeneratedTokens += totalGenerated;
        prev.totalDurationSec += clampedSpan;
        prev.completedTurns += 1;
        this.sessionSpeedStats.set(sessionId, prev);
        state.averageTokensPerSecond = Math.round((prev.totalGeneratedTokens / prev.totalDurationSec) * 10) / 10;
      }
    }
    this.scheduleFlush();
    this.emit('updated', this.snapshot());
  }

  cancelTurn(sessionId: string): void {
    this.turns.delete(sessionId);
    this.samples.delete(sessionId);
    this.pendingCompaction.delete(sessionId);
  }

  remove(sessionId: string): void {
    this.states.delete(sessionId);
    this.turns.delete(sessionId);
    this.samples.delete(sessionId);
    this.sessionCounts.delete(sessionId);
    this.sessionSpeedStats.delete(sessionId);
    this.reportedUsed.delete(sessionId);
    this.pendingCompaction.delete(sessionId);
    this.extBySession.delete(sessionId);
    this.scheduleFlush();
  }

  /**
   * 记录一次外部复核（AI 代审）API 调用的真实用量与结果，同步累加到：
   * 1) 本客户端历史永久累计（跨所有历史 API Provider）；
   * 2) 当前会话明细；
   * 3) 24h / 7d / 30d UTC 小时分布账本。
   */
  recordExternalReviewUsage(input: ExternalReviewerUsageRecordInput): void {
    if (!input || !isValidExtProvider(input.provider) || !input.modelId?.trim()) return;
    const ts = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) ? input.timestamp : this.now();
    const hourKey = this.hourKey(ts);
    const endpointHost = extractSafeEndpointHost(input.endpoint || '', input.provider);
    const modelId = input.modelId.trim();
    const bKey = `${input.provider}\0${endpointHost}\0${modelId}`;

    const safePos = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const directCost =
      input.provider === 'local-ollama'
        ? 0
        : typeof input.usage?.directCostUsd === 'number' && Number.isFinite(input.usage.directCostUsd) && input.usage.directCostUsd >= 0
          ? input.usage.directCostUsd
          : undefined;

    const delta: ExternalReviewerBucket = {
      provider: input.provider,
      endpointHost,
      modelId,
      inputTokens: safePos(input.usage?.inputTokens),
      cachedInputTokens: safePos(input.usage?.cachedInputTokens),
      outputTokens: safePos(input.usage?.outputTokens),
      thinkingTokens: safePos(input.usage?.thinkingTokens),
      callCount: 1,
      approvedCount: input.outcome === 'approve' ? 1 : 0,
      askCount: input.outcome === 'ask' ? 1 : 0,
      denyCount: input.outcome === 'deny' ? 1 : 0,
      errorCount: input.outcome === 'error' ? 1 : 0,
      directCostUsd: directCost ?? 0,
      hasDirectCost: directCost !== undefined,
      totalLatencyMs: safePos(input.latencyMs),
    };

    // 1. 永久客户端累计（不因 30 天滚动窗口裁剪丢失）
    const prevCum = this.extCumulative.get(bKey);
    this.extCumulative.set(bKey, prevCum ? mergeExternalBucket(prevCum, delta) : { ...delta });

    // 2. 当前会话明细
    if (input.sessionId) {
      const sessStore = this.extBySession.get(input.sessionId) || {
        buckets: new Map<string, ExternalReviewerBucket>(),
        updatedAt: new Date(ts).toISOString(),
      };
      const prevSess = sessStore.buckets.get(bKey);
      sessStore.buckets.set(bKey, prevSess ? mergeExternalBucket(prevSess, delta) : { ...delta });
      sessStore.updatedAt = new Date(ts).toISOString();
      this.extBySession.set(input.sessionId, sessStore);
    }

    // 3. 小时级分布账本（驱动 24h / 7d / 30d 热力图与时段费用）
    const hKey = `${hourKey}\0${bKey}`;
    const prevHour = this.extLedger.get(hKey);
    if (prevHour) {
      const merged = mergeExternalBucket(prevHour, delta);
      const sessions = prevHour.sessions.includes(input.sessionId) || !input.sessionId
        ? prevHour.sessions
        : [...prevHour.sessions, input.sessionId];
      this.extLedger.set(hKey, { ...merged, hourKey, sessions });
    } else {
      this.extLedger.set(hKey, {
        ...delta,
        hourKey,
        sessions: input.sessionId ? [input.sessionId] : [],
      });
    }

    this.extUpdatedAt = new Date(ts).toISOString();
    this.scheduleFlush();
    this.emit('updated', this.snapshot());
  }

  private hourKey(time = this.now()): string {
    return new Date(time).toISOString().slice(0, 13);
  }

  private refresh(state: SessionContextTelemetry, emit = true): void {
    const estimatedSum = Object.values(state.breakdown).reduce((sum, count) => sum + count, 0);
    const reported = this.reportedUsed.get(state.sessionId);
    state.usedContextTokens = reported !== undefined ? Math.max(reported, 0) : estimatedSum;
    state.usageRatio = Math.min(1, state.usedContextTokens / Math.max(1, state.maxContextTokens));
    state.pressureLevel =
      state.usageRatio >= 0.95
        ? 'critical'
        : state.usageRatio >= 0.8
          ? 'warning'
          : state.usageRatio >= 0.6
            ? 'moderate'
            : 'healthy';

    // 实时速度采用最近 3.5 秒滑动窗口（供对话框底栏展示实时 tok/s）；同时累积会话平均速度（供 Context 检视器展示）。
    const now = this.now();
    const samples = (this.samples.get(state.sessionId) || []).filter((sample) => sample.time >= now - 3500);
    this.samples.set(state.sessionId, samples);
    const turn = this.turns.get(state.sessionId);
    if (turn && samples.length > 0) {
      const sumTokens = samples.reduce((sum, sample) => sum + sample.tokens, 0);
      if (sumTokens > 0) {
        const elapsedSec =
          samples.length >= 2 && now > samples[0].time
            ? Math.max(0.25, (now - samples[0].time) / 1000)
            : Math.max(0.5, (now - turn.startedAt) / 1000);
        state.currentTokensPerSecond = Math.round((sumTokens / elapsedSec) * 10) / 10;
      }
    }
    const prevSpeed = this.sessionSpeedStats.get(state.sessionId);
    let accTokens = prevSpeed?.totalGeneratedTokens ?? 0;
    let accSec = prevSpeed?.totalDurationSec ?? 0;
    if (turn) {
      const liveGenerated = Math.max(
        turn.streamedTokens,
        turn.counts.outputTokens + turn.counts.thinkingTokens
      );
      if (liveGenerated > 0) {
        const liveSpan =
          turn.firstChunkAt !== undefined && now > turn.firstChunkAt
            ? Math.max(0.25, (now - turn.firstChunkAt) / 1000)
            : Math.max(0.5, (now - turn.startedAt) / 1000);
        accTokens += liveGenerated;
        accSec += liveSpan;
      }
    }
    if (accTokens > 0 && accSec > 0) {
      state.averageTokensPerSecond = Math.round((accTokens / accSec) * 10) / 10;
    } else if (state.averageTokensPerSecond === undefined) {
      state.averageTokensPerSecond = state.currentTokensPerSecond || 0;
    }
    state.peakTokensPerSecond = Math.max(state.peakTokensPerSecond, state.currentTokensPerSecond);
    state.compactions = structuredClone(this.compactionsBySession.get(state.sessionId) || []);
    state.costSummary = this.sumCosts(
      this.modelBreakdowns(this.sessionCounts.get(state.sessionId) || new Map())
    );
    const promptInputTotal = state.costSummary.inputTokens + state.costSummary.cachedInputTokens;
    state.averageCacheHitRate = promptInputTotal > 0
      ? Math.min(1, Math.max(0, state.costSummary.cachedInputTokens / promptInputTotal))
      : 0;
    state.pricingSource = this.customRates ? 'user-custom-rate' : 'reference-api-estimate';
    state.updatedAt = new Date(now).toISOString();
    if (emit) this.emit('updated', this.snapshot());
  }

  private modelBreakdowns(counts: Map<string, FourDimTokenCounts>): ModelCostBreakdownItem[] {
    const rows = [...counts].map(([modelId, value]) => {
      const rate = resolveModelRateCard(modelId, this.rateCards);
      return {
        modelId,
        displayName: rate.modelId === 'default' && modelId !== 'default' ? modelId : rate.displayName,
        ...calculateTokenCost(value, rate),
        shareRatio: 0,
      };
    });
    const total = rows.reduce((sum, row) => sum + row.totalCostUsd, 0);
    return rows
      .map((row) => ({ ...row, shareRatio: total > 0 ? row.totalCostUsd / total : 0 }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  private sumCosts(rows: TokenCostSummary[]): TokenCostSummary {
    const result = calculateTokenCost(zero(), resolveModelRateCard('default', this.rateCards));
    for (const row of rows) {
      for (const key of Object.keys(result) as Array<keyof TokenCostSummary>) result[key] += row[key];
    }
    return result;
  }

  private aggregate(records: HourRecord[]): {
    total: TokenCostSummary;
    models: ModelCostBreakdownItem[];
    sessions: Set<string>;
  } {
    const counts = new Map<string, FourDimTokenCounts>();
    const sessions = new Set<string>();
    for (const record of records) {
      counts.set(record.modelId, add(counts.get(record.modelId) || zero(), record));
      record.sessions.forEach((id) => sessions.add(id));
    }
    const models = this.modelBreakdowns(counts);
    return { total: this.sumCosts(models), models, sessions };
  }

  private externalBucketCost(bucket: ExternalReviewerBucket): TokenCostSummary {
    if (bucket.provider === 'local-ollama') {
      return calculateTokenCost(bucket, {
        inputPerMillionUsd: 0,
        cachedInputPerMillionUsd: 0,
        outputPerMillionUsd: 0,
        thinkingPerMillionUsd: 0,
      });
    }
    const rate = resolveModelRateCard(bucket.modelId, this.rateCards);
    const computed = calculateTokenCost(bucket, rate);
    if (bucket.hasDirectCost && bucket.directCostUsd > 0) {
      // 当 API Provider 直接返回账单费用时，总费用严格采用 Provider 汇报值，并按估算占比拆入四维展示
      const ratio = computed.totalCostUsd > 0 ? bucket.directCostUsd / computed.totalCostUsd : 0;
      if (ratio > 0) {
        return {
          ...computed,
          inputCostUsd: computed.inputCostUsd * ratio,
          cachedInputCostUsd: computed.cachedInputCostUsd * ratio,
          outputCostUsd: computed.outputCostUsd * ratio,
          thinkingCostUsd: computed.thinkingCostUsd * ratio,
          totalCostUsd: bucket.directCostUsd,
        };
      }
      return {
        ...computed,
        inputCostUsd: bucket.directCostUsd,
        totalCostUsd: bucket.directCostUsd,
      };
    }
    return computed;
  }

  private externalBreakdowns(buckets: Iterable<ExternalReviewerBucket>): {
    total: TokenCostSummary & {
      callCount: number;
      approvedCount: number;
      askCount: number;
      denyCount: number;
      errorCount: number;
      totalLatencyMs: number;
    };
    items: ExternalReviewerProviderBreakdownItem[];
  } {
    const merged = new Map<string, ExternalReviewerBucket>();
    for (const b of buckets) {
      const bKey = `${b.provider}\0${b.endpointHost}\0${b.modelId}`;
      const prev = merged.get(bKey);
      merged.set(bKey, prev ? mergeExternalBucket(prev, b) : { ...b });
    }
    const rawItems = [...merged.values()].map((b) => {
      const rate = resolveModelRateCard(b.modelId, this.rateCards);
      const cost = this.externalBucketCost(b);
      return {
        key: `${b.provider}:${b.endpointHost}:${b.modelId}`,
        provider: b.provider,
        endpointHost: b.endpointHost,
        modelId: b.modelId,
        displayName: rate.modelId === 'default' && b.modelId !== 'default' ? b.modelId : rate.displayName,
        ...cost,
        callCount: b.callCount,
        approvedCount: b.approvedCount,
        askCount: b.askCount,
        denyCount: b.denyCount,
        errorCount: b.errorCount,
        shareRatio: 0,
      };
    });
    const totalCost = this.sumCosts(rawItems);
    let callCount = 0;
    let approvedCount = 0;
    let askCount = 0;
    let denyCount = 0;
    let errorCount = 0;
    let totalLatencyMs = 0;
    for (const b of merged.values()) {
      callCount += b.callCount;
      approvedCount += b.approvedCount;
      askCount += b.askCount;
      denyCount += b.denyCount;
      errorCount += b.errorCount;
      totalLatencyMs += b.totalLatencyMs;
    }
    const items = rawItems
      .map((item) => ({
        ...item,
        shareRatio:
          totalCost.totalCostUsd > 0
            ? item.totalCostUsd / totalCost.totalCostUsd
            : totalCost.totalTokens > 0
              ? item.totalTokens / totalCost.totalTokens
              : callCount > 0
                ? item.callCount / callCount
                : 0,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens || b.callCount - a.callCount);

    return {
      total: { ...totalCost, callCount, approvedCount, askCount, denyCount, errorCount, totalLatencyMs },
      items,
    };
  }

  private buildExternalReviewerSnapshot(today: string, todayMs: number, hourMs: number): ExternalReviewerTelemetrySnapshot {
    const extRecords = [...this.extLedger.values()];
    const daily = (offset: number) => new Date(todayMs - offset * 86400000).toISOString().slice(0, 10);

    const hourly24h = Array.from({ length: 24 }, (_, index) => {
      const hourKey = this.hourKey(hourMs - (23 - index) * 3600000);
      const { total } = this.externalBreakdowns(extRecords.filter((r) => r.hourKey === hourKey));
      return {
        hourKey,
        hourLabel: `${hourKey.slice(-2)}:00`,
        inputTokens: total.inputTokens,
        cachedInputTokens: total.cachedInputTokens,
        outputTokens: total.outputTokens,
        thinkingTokens: total.thinkingTokens,
        totalTokens: total.totalTokens,
        costUsd: total.totalCostUsd,
      };
    });

    const matrix7d = Array.from({ length: 168 }, (_, index) => {
      const date = daily(6 - Math.floor(index / 24));
      const hour = index % 24;
      const key = `${date}T${String(hour).padStart(2, '0')}`;
      const { total } = this.externalBreakdowns(extRecords.filter((r) => r.hourKey === key));
      return {
        date,
        hour,
        totalTokens: total.totalTokens,
        costUsd: total.totalCostUsd,
        intensity: intensity(total.totalTokens),
      };
    });

    const calendar30d = Array.from({ length: 30 }, (_, index) => {
      const date = daily(29 - index);
      const matched = extRecords.filter((r) => r.hourKey.startsWith(date));
      const { total } = this.externalBreakdowns(matched);
      const sessions = new Set<string>();
      for (const r of matched) r.sessions.forEach((id) => sessions.add(id));
      return {
        date,
        inputTokens: total.inputTokens,
        cachedInputTokens: total.cachedInputTokens,
        outputTokens: total.outputTokens,
        thinkingTokens: total.thinkingTokens,
        totalTokens: total.totalTokens,
        costUsd: total.totalCostUsd,
        sessionCount: sessions.size,
        intensity: intensity(total.totalTokens),
      };
    });

    const ranges = { today, '7d': daily(6), '30d': daily(29) };
    const costByRange = {} as ExternalReviewerTelemetrySnapshot['costByRange'];
    const providerBreakdownByRange = {} as ExternalReviewerTelemetrySnapshot['providerBreakdownByRange'];
    for (const scope of ['today', '7d', '30d'] as const) {
      const matched = extRecords.filter(
        (r) => r.hourKey >= `${ranges[scope]}T00` && r.hourKey <= this.hourKey()
      );
      const { total, items } = this.externalBreakdowns(matched);
      costByRange[scope] = {
        inputTokens: total.inputTokens,
        cachedInputTokens: total.cachedInputTokens,
        outputTokens: total.outputTokens,
        thinkingTokens: total.thinkingTokens,
        totalTokens: total.totalTokens,
        inputCostUsd: total.inputCostUsd,
        cachedInputCostUsd: total.cachedInputCostUsd,
        outputCostUsd: total.outputCostUsd,
        thinkingCostUsd: total.thinkingCostUsd,
        totalCostUsd: total.totalCostUsd,
        callCount: total.callCount,
      };
      providerBreakdownByRange[scope] = items;
    }

    const cumResult = this.externalBreakdowns(this.extCumulative.values());
    const distinctProviders = new Set<string>();
    for (const item of cumResult.items) distinctProviders.add(`${item.provider}:${item.endpointHost}`);

    const bySession: Record<string, ExternalReviewerSessionSummary> = {};
    for (const [sid, sessStore] of this.extBySession) {
      const sRes = this.externalBreakdowns(sessStore.buckets.values());
      bySession[sid] = {
        sessionId: sid,
        inputTokens: sRes.total.inputTokens,
        cachedInputTokens: sRes.total.cachedInputTokens,
        outputTokens: sRes.total.outputTokens,
        thinkingTokens: sRes.total.thinkingTokens,
        totalTokens: sRes.total.totalTokens,
        inputCostUsd: sRes.total.inputCostUsd,
        cachedInputCostUsd: sRes.total.cachedInputCostUsd,
        outputCostUsd: sRes.total.outputCostUsd,
        thinkingCostUsd: sRes.total.thinkingCostUsd,
        totalCostUsd: sRes.total.totalCostUsd,
        callCount: sRes.total.callCount,
        approvedCount: sRes.total.approvedCount,
        askCount: sRes.total.askCount,
        denyCount: sRes.total.denyCount,
        errorCount: sRes.total.errorCount,
        avgLatencyMs: sRes.total.callCount > 0 ? Math.round(sRes.total.totalLatencyMs / sRes.total.callCount) : 0,
        providers: sRes.items,
        updatedAt: sessStore.updatedAt,
      };
    }

    return {
      cumulativeAllTime: {
        inputTokens: cumResult.total.inputTokens,
        cachedInputTokens: cumResult.total.cachedInputTokens,
        outputTokens: cumResult.total.outputTokens,
        thinkingTokens: cumResult.total.thinkingTokens,
        totalTokens: cumResult.total.totalTokens,
        inputCostUsd: cumResult.total.inputCostUsd,
        cachedInputCostUsd: cumResult.total.cachedInputCostUsd,
        outputCostUsd: cumResult.total.outputCostUsd,
        thinkingCostUsd: cumResult.total.thinkingCostUsd,
        totalCostUsd: cumResult.total.totalCostUsd,
        callCount: cumResult.total.callCount,
        approvedCount: cumResult.total.approvedCount,
        askCount: cumResult.total.askCount,
        denyCount: cumResult.total.denyCount,
        errorCount: cumResult.total.errorCount,
        providerCount: distinctProviders.size,
      },
      cumulativeProviders: cumResult.items,
      bySession,
      hourly24h,
      matrix7d,
      calendar30d,
      costByRange,
      providerBreakdownByRange,
      updatedAt: this.extUpdatedAt || new Date(this.now()).toISOString(),
    };
  }

  /** 以 UTC 的日界和小时键建立 24 小时、7 天和 30 天视图。无活动的时间段也会生成图表格子。 */
  snapshot(): TelemetryDashboardSnapshot {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00Z`);
    const hourMs = Date.parse(`${this.hourKey()}:00:00Z`);
    const records = [...this.ledger.values()];
    const daily = (offset: number) => new Date(todayMs - offset * 86400000).toISOString().slice(0, 10);

    const hourly24h = Array.from({ length: 24 }, (_, index) => {
      const hourKey = this.hourKey(hourMs - (23 - index) * 3600000);
      const { total } = this.aggregate(records.filter((record) => record.hourKey === hourKey));
      return { hourKey, hourLabel: `${hourKey.slice(-2)}:00`, ...total, costUsd: total.totalCostUsd };
    });

    const matrix7d = Array.from({ length: 168 }, (_, index) => {
      const date = daily(6 - Math.floor(index / 24));
      const hour = index % 24;
      const key = `${date}T${String(hour).padStart(2, '0')}`;
      const { total } = this.aggregate(records.filter((record) => record.hourKey === key));
      return {
        date,
        hour,
        totalTokens: total.totalTokens,
        costUsd: total.totalCostUsd,
        intensity: intensity(total.totalTokens),
      };
    });

    const calendar30d = Array.from({ length: 30 }, (_, index) => {
      const date = daily(29 - index);
      const { total, sessions } = this.aggregate(records.filter((record) => record.hourKey.startsWith(date)));
      return {
        date,
        ...total,
        costUsd: total.totalCostUsd,
        sessionCount: sessions.size,
        intensity: intensity(total.totalTokens),
      };
    });

    const ranges = { today, '7d': daily(6), '30d': daily(29) };
    const costByRange = {} as TelemetryDashboardSnapshot['costByRange'];
    const modelBreakdownByRange = {} as TelemetryDashboardSnapshot['modelBreakdownByRange'];
    for (const scope of ['today', '7d', '30d'] as const) {
      const result = this.aggregate(
        records.filter(
          (record) => record.hourKey >= `${ranges[scope]}T00` && record.hourKey <= this.hourKey()
        )
      );
      costByRange[scope] = result.total;
      modelBreakdownByRange[scope] = result.models;
    }

    return {
      activeSessions: structuredClone(Object.fromEntries(this.states)),
      hourly24h,
      matrix7d,
      calendar30d,
      costByRange,
      modelBreakdownByRange,
      sessionModelBreakdowns: Object.fromEntries(
        [...this.sessionCounts].map(([id, counts]) => [id, this.modelBreakdowns(counts)])
      ),
      externalReviewer: this.buildExternalReviewerSnapshot(today, todayMs, hourMs),
      rateCards: structuredClone(this.rateCards),
      pricingSource: this.customRates ? 'user-custom-rate' : 'reference-api-estimate',
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  flush(): void {
    // 小时账本按 UTC 小时键裁剪至近 30 天。会话详情和已报告的窗口数据另存，供下次恢复会话时使用。
    const cutoff = new Date(this.now() - 30 * 86400000).toISOString().slice(0, 13);
    for (const [key, record] of this.ledger) {
      if (record.hourKey < cutoff) this.ledger.delete(key);
    }
    this.options.store.write('token-hours.json', [...this.ledger.values()]);

    for (const [key, record] of this.extLedger) {
      if (record.hourKey < cutoff) this.extLedger.delete(key);
    }
    this.options.store.write('external-reviewer-hours.json', [...this.extLedger.values()]);

    const serializedExtSessions: Record<string, { buckets: Record<string, ExternalReviewerBucket>; updatedAt: string }> = {};
    for (const [sid, sessStore] of [...this.extBySession.entries()].slice(-300)) {
      serializedExtSessions[sid] = {
        buckets: Object.fromEntries(sessStore.buckets),
        updatedAt: sessStore.updatedAt,
      };
    }
    this.options.store.write('external-reviewer-totals.json', {
      cumulative: Object.fromEntries(this.extCumulative),
      sessions: serializedExtSessions,
      updatedAt: this.extUpdatedAt || new Date(this.now()).toISOString(),
    });

    const serializedCounts: Record<string, Record<string, FourDimTokenCounts>> = {};
    for (const [sid, inner] of this.sessionCounts) {
      serializedCounts[sid] = Object.fromEntries(inner);
    }
    const recentStates = Object.fromEntries([...this.states.entries()].slice(-300));
    this.options.store.write('session-telemetry.json', {
      states: recentStates,
      sessionCounts: serializedCounts,
      sessionSpeedStats: Object.fromEntries(this.sessionSpeedStats),
      reportedUsed: Object.fromEntries(this.reportedUsed),
      checkpointLimits: Object.fromEntries(this.checkpointLimits),
      learnedModelLimits: Object.fromEntries(this.learnedModelLimits),
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }
}

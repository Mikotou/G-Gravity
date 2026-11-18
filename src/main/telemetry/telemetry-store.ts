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
  private samples = new Map<string, Array<{ time: number; tokens: number }>>();
  private turns = new Map<string, Turn>();
  private reportedUsed = new Map<string, number>();
  private checkpointLimits = new Map<string, number>();
  private compactionsBySession = new Map<string, ContextCompactionRecord[]>();
  private pendingCompaction = new Map<string, number>();
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

    const savedSessions = options.store.read<{
      states?: Record<string, SessionContextTelemetry>;
      sessionCounts?: Record<string, Record<string, FourDimTokenCounts>>;
      reportedUsed?: Record<string, number>;
      checkpointLimits?: Record<string, number>;
    }>('session-telemetry.json', {});
    if (savedSessions?.checkpointLimits && typeof savedSessions.checkpointLimits === 'object') {
      for (const [sid, lim] of Object.entries(savedSessions.checkpointLimits)) {
        if (typeof lim === 'number' && lim >= 16_000 && lim <= 2_000_000) {
          this.checkpointLimits.set(sid, lim);
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
          this.states.set(sid, copy);
        }
      }
    }
  }

  /** 选择压缩窗口时，显式传入的上限优先，其次为本会话读到的阈值，最后才按模型估算。 */
  private resolveMaxWindow(sessionId: string, modelId?: string): number {
    if (this.options.maxContextTokens) return this.options.maxContextTokens;
    return this.checkpointLimits.get(sessionId) || resolveModelCompactionLimit(modelId);
  }

  /**
   * 写入从会话库 `executor_metadata -> cascade_config.checkpoint_config.max_token_limit` 实测读出的压缩阈值。
   */
  setCheckpointWindowLimit(sessionId: string, limitTokens: number): void {
    if (!Number.isFinite(limitTokens) || limitTokens < 16_000 || limitTokens > 2_000_000) return;
    if (this.checkpointLimits.get(sessionId) === limitTokens) return;
    this.checkpointLimits.set(sessionId, Math.round(limitTokens));
    const state = this.states.get(sessionId);
    if (state && !this.options.maxContextTokens) {
      state.maxContextTokens = Math.round(limitTokens);
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
        peakTokensPerSecond: 0,
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
        state.currentTokensPerSecond = Math.round((totalGenerated / Math.max(0.2, spanSec)) * 10) / 10;
        state.peakTokensPerSecond = Math.max(state.peakTokensPerSecond, state.currentTokensPerSecond);
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
    this.reportedUsed.delete(sessionId);
    this.pendingCompaction.delete(sessionId);
    this.scheduleFlush();
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

    // 速度只采样最近五秒的增量。短时间窗口设置最小分母，避免首个分片使瞬时速度异常放大。
    const now = this.now();
    const samples = (this.samples.get(state.sessionId) || []).filter((sample) => sample.time >= now - 5000);
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
    state.peakTokensPerSecond = Math.max(state.peakTokensPerSecond, state.currentTokensPerSecond);
    state.compactions = structuredClone(this.compactionsBySession.get(state.sessionId) || []);
    state.costSummary = this.sumCosts(
      this.modelBreakdowns(this.sessionCounts.get(state.sessionId) || new Map())
    );
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

    const serializedCounts: Record<string, Record<string, FourDimTokenCounts>> = {};
    for (const [sid, inner] of this.sessionCounts) {
      serializedCounts[sid] = Object.fromEntries(inner);
    }
    const recentStates = Object.fromEntries([...this.states.entries()].slice(-300));
    this.options.store.write('session-telemetry.json', {
      states: recentStates,
      sessionCounts: serializedCounts,
      reportedUsed: Object.fromEntries(this.reportedUsed),
      checkpointLimits: Object.fromEntries(this.checkpointLimits),
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }
}

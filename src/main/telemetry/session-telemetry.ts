import type { ChatMessageItem } from '../../shared/session-contract';
import { calculateTokenCost, resolveModelCompactionLimit, resolveModelRateCard } from '../../shared/telemetry-contract';
import type {
  FourDimTokenCounts, ModelRateCard, SessionContextTelemetry, TelemetryDashboardSnapshot,
} from '../../shared/telemetry-contract';
import { ledgerHour } from './calendar';
import { cacheHitRate } from './acp-usage';
import { zero, KEYS, estimateTokens, toolTextTokens, pressureLevel } from './telemetry-data';
import { modelBreakdowns, sumCosts } from './telemetry-aggregator';
import { TelemetryPersistence } from './telemetry-persistence';

export abstract class SessionTelemetry extends TelemetryPersistence {
  /** 选择压缩窗口时：显式上限 > 本会话实测阈值 > 同模型历史实测学习值 > 内置默认估计。 */
  protected resolveMaxWindow(sessionId: string, modelId?: string): number {
    if (this.options.maxContextTokens) return this.options.maxContextTokens;
    const direct = this.checkpointLimits.get(sessionId);
    if (direct) return direct;
    const reported = this.reportedWindowLimits.get(sessionId);
    if (reported) return reported;
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
        if (sid === sessionId || this.checkpointLimits.has(sid) || this.reportedWindowLimits.has(sid)) continue;
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
    this.reportedWindowLimits.delete(sessionId);
    const state = this.states.get(sessionId);
    if (!state) return;
    if (nextModelId) state.modelId = nextModelId;
    if (!this.options.maxContextTokens) {
      state.maxContextTokens = this.resolveMaxWindow(sessionId, state.modelId);
      this.refresh(state, true);
      this.scheduleFlush();
    }
  }

  updateModelRateCards(rates: ModelRateCard[]): TelemetryDashboardSnapshot {
    this.validateRates(rates);
    this.options.store.write('model-rate-cards.json', rates);
    this.rateCards = structuredClone(rates);
    this.customRates = true;
    for (const state of this.states.values()) this.refresh(state, false);
    const snapshot = this.snapshot();
    this.notifyUpdated(undefined, snapshot);
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
        compactionCount: this.compactionsBySession.get(sessionId)?.length ?? 0,
        compactionCountIsMinimum: (this.compactionsBySession.get(sessionId)?.length ?? 0) >= 50,
        currentTokensPerSecond: 0,
        averageTokensPerSecond: 0,
        peakTokensPerSecond: 0,
        reportedCacheUsage: this.sessionCounts.has(sessionId) ? undefined : { inputTokens: 0, cachedReadTokens: 0 },
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
      state.pressureLevel = pressureLevel(state.usageRatio);
      createdOrChanged = true;
    }
    if (createdOrChanged) {
      this.notifyUpdated(sessionId);
    }
    return state;
  }

  /**
   * 根据本地持久化的会话消息回填 Context 构成与会话费用（用于历史已保存对话恢复展示）。
   */
  hydrateFromMessages(sessionId: string, modelId: string, source: ChatMessageItem[] | (() => ChatMessageItem[])): SessionContextTelemetry {
    const state = this.ensure(sessionId, modelId);
    // 只有尚无占用统计的会话才由历史消息回填，反复打开同一会话时沿用已有统计。
    if (state.usedContextTokens > 0 && (this.sessionCounts.has(sessionId) || state.costSummary?.totalTokens > 0)) return state;
    const messages = typeof source === 'function' ? source() : source;
    if (!messages.length) return state;

    let userTokens = 0;
    let agentTokens = 0;
    let thoughtTokens = 0;
    let toolTokens = 0;
    let attachmentTokens = 0;
    let systemTokens = 0;
    const billable = zero();

    for (const msg of messages) {
      if (msg.sendFailed) continue;
      const bill = !msg.revisionHistory;
      if (msg.role === 'user') {
        const input = estimateTokens(msg.content || '');
        userTokens += input;
        if (bill) billable.inputTokens += input;
        for (const att of msg.attachments || []) {
          const size = Math.ceil(Math.max(0, att.sizeBytes || 0) / 4);
          attachmentTokens += size;
          if (bill) billable.inputTokens += size;
        }
      } else if (msg.role === 'assistant') {
        const output = estimateTokens(msg.content || '');
        agentTokens += output;
        if (bill) billable.outputTokens += output;
        for (const th of msg.thoughts || []) {
          const count = estimateTokens(th.originalText || '');
          thoughtTokens += count;
          if (bill) billable.thinkingTokens += count;
        }
        for (const tc of msg.toolCalls || []) {
          const args = toolTextTokens(tc.argsSummary || ''), result = toolTextTokens(tc.outputPreview || '');
          toolTokens += args + result;
          if (bill) { billable.outputTokens += args; billable.inputTokens += result; }
        }
      } else if (msg.role === 'system') {
        const count = estimateTokens(msg.content || '');
        systemTokens += count;
        if (bill) billable.inputTokens += count;
      }
    }

    if (userTokens + agentTokens + thoughtTokens + toolTokens + attachmentTokens + systemTokens === 0) {
      return state;
    }

    state.breakdown.userMessagesTokens = userTokens;
    state.breakdown.systemAndRulesTokens = systemTokens;
    state.breakdown.agentMessagesTokens = agentTokens;
    state.breakdown.thoughtTokens = thoughtTokens;
    state.breakdown.toolCallsTokens = toolTokens;
    state.breakdown.attachmentsTokens = attachmentTokens;

    if (!this.sessionCounts.has(sessionId)) {
      const mId = state.modelId || modelId || 'default';
      const inner = new Map<string, FourDimTokenCounts>();
      inner.set(mId, billable);
      this.sessionCounts.set(sessionId, inner);
      if (KEYS.some(key => billable[key] > 0)) state.reportedCacheUsage = undefined;
    }

    this.refresh(state, true);
    this.scheduleFlush();
    return state;
  }

  protected hourKey(time = this.now()): string {
    return ledgerHour(time);
  }

  protected refresh(state: SessionContextTelemetry, emit = true): void {
    this.pendingSessions.add(state.sessionId);
    const estimatedSum = Object.values(state.breakdown).reduce((sum, count) => sum + count, 0);
    const reported = this.reportedUsed.get(state.sessionId);
    const sinceReport = Math.max(0, estimatedSum - (state.reportedBreakdownTokens ?? estimatedSum));
    state.usedContextTokens = reported !== undefined ? Math.max(reported, 0) + sinceReport : estimatedSum;
    if (reported !== undefined && sinceReport > 0) state.usageSource = 'mixed';
    state.usageRatio = Math.min(1, state.usedContextTokens / Math.max(1, state.maxContextTokens));
    state.pressureLevel = pressureLevel(state.usageRatio);

    // 实时速度采用最近 3.5 秒滑动窗口（供对话框底栏展示实时 tok/s）；同时累积会话平均速度（供 Context 检视器展示）。
    const now = this.now();
    const samples = (this.samples.get(state.sessionId) || []).filter((sample) => sample.time >= now - 3500);
    this.samples.set(state.sessionId, samples);
    const turn = this.turns.get(state.sessionId);
    if (turn) state.currentTokensPerSecond = 0;
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
        turn.counts.outputTokens + turn.counts.thinkingTokens - turn.toolArgumentTokens
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
    const compactions = this.compactionsBySession.get(state.sessionId);
    if (compactions && state.compactions?.at(-1)?.id !== compactions.at(-1)?.id) state.compactions = structuredClone(compactions);
    state.costSummary = sumCosts(
      modelBreakdowns(this.sessionCounts.get(state.sessionId) || new Map(), this.rateCards)
    );
    state.averageCacheHitRate = cacheHitRate(state.reportedCacheUsage);
    state.pricingSource = this.customRates ? 'user-custom-rate' : 'reference-api-estimate';
    state.updatedAt = new Date(now).toISOString();
    if (emit) this.notifyUpdated(state.sessionId);
  }

}

import { randomUUID } from 'node:crypto';
import type { AcpTokenUsage } from '../../shared/acp-protocol';
import type {
  AttachmentAuditItem, ContextCompactionRecord, ContextTokenBreakdown, ExternalReviewerUsageRecordInput,
  ExternalTranslatorUsageRecordInput, FourDimTokenCounts, SessionContextTelemetry,
  TelemetryDashboardSnapshot,
} from '../../shared/telemetry-contract';
import { combineCacheUsage, mergeUsage, reconcileUsage, samePromptCounters } from './acp-usage';
import { zero, add, KEYS, estimateTokens, tokenUnits, toolTextTokens, selectedEntries } from './telemetry-data';
import { modelBreakdowns, nativeCalendar } from './telemetry-aggregator';
import type { TelemetryCharts, TelemetryDelta } from './telemetry-update';
import { SessionTelemetry } from './session-telemetry';
export { estimateTokens } from './telemetry-data';

let snapshotSequence = 0;

export class TelemetryStore extends SessionTelemetry {
  beginTurn(sessionId: string, text: string, attachments: AttachmentAuditItem[] = [], historyTokens = 0, referenceTokens = 0, hints = 0): void {
    const state = this.ensure(sessionId);
    if (this.turns.has(sessionId)) throw new Error('同一会话不能重复开启遥测回合');
    if (this.pendingCompaction.get(sessionId)?.completed) this.pendingCompaction.delete(sessionId);
    const input = estimateTokens(text);
    const attachmentsTokens = referenceTokens + attachments.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens), 0);
    const modelId = state.modelId || 'default';
    const hourKey = this.hourKey();
    this.turns.set(sessionId, {
      counts: zero(), reportedUsage: {},
      modelId, hourKey,
      startedAt: this.now(),
      streamedTokens: 0,
      toolArgumentTokens: 0,
      units: {}, tools: new Map(), original: structuredClone(state),
      existingHourSession: this.ledger.get(`${hourKey}\0${modelId}`)?.sessions.includes(this.hourSessionId(sessionId)) ?? false,
      existingModel: this.sessionCounts.get(sessionId)?.has(modelId) ?? false,
    });
    this.samples.set(sessionId, []);
    state.reportedCacheUsage = undefined;
    state.breakdown.userMessagesTokens += input;
    state.breakdown.attachmentsTokens += attachmentsTokens;
    state.breakdown.systemAndRulesTokens += hints;
    state.attachments = [...state.attachments, ...attachments].slice(-200);
    this.account(sessionId, { ...zero(), inputTokens: input + attachmentsTokens + historyTokens + hints });
    this.refresh(state);
  }

  addChunk(sessionId: string, text: string, category: keyof ContextTokenBreakdown = 'agentMessagesTokens', syncReply = false): void {
    const state = this.ensure(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) {
      if (!syncReply) state.breakdown[category] += estimateTokens(text);
      this.refresh(state);
      return;
    }
    // 估算整段文本后只计入与上一版本的差额，避免同一段文字因网络分片更碎而被多次向上取整。
    const previous = turn.units[category] ?? 0;
    const next = (syncReply ? 0 : previous) + tokenUnits(text);
    turn.units[category] = next;
    const tokens = Math.ceil(next / 4) - Math.ceil(previous / 4);
    state.breakdown[category] = Math.max(0, state.breakdown[category] + tokens);
    const field = category === 'thoughtTokens' ? 'thinkingTokens' : 'outputTokens';
    let billedDelta = tokens;
    let reclassified = 0;
    if (category === 'agentMessagesTokens') {
      const unreported = turn.unreportedReplyTokens ?? 0;
      billedDelta = Math.max(-Math.min(unreported, turn.counts.outputTokens), tokens);
      turn.unreportedReplyTokens = unreported + billedDelta;
      if (turn.replyTokensAfterTotal !== undefined) {
        const afterTotal = turn.replyTokensAfterTotal + billedDelta;
        reclassified = Math.max(0, -afterTotal);
        turn.replyTokensAfterTotal = Math.max(0, afterTotal);
      }
    }
    if (tokens > 0) {
      delete turn.reportedUsage.totalTokens;
      delete turn.reportedUsage.outputTokens;
      if (field === 'thinkingTokens') delete turn.reportedUsage.thoughtTokens;
    }
    this.account(sessionId, { ...turn.counts, [field]: Math.max(0, turn.counts[field] + billedDelta),
      ...(reclassified && { unclassifiedTokens: (turn.counts.unclassifiedTokens ?? 0) + reclassified }) });

    const now = this.now();
    turn.streamedTokens = Math.max(0, turn.streamedTokens + tokens);
    if (tokens > 0) {
      turn.firstChunkAt ??= now;
      turn.lastChunkAt = now;
    }
    const samples = this.samples.get(sessionId) || [];
    const last = samples.at(-1);
    if (tokens < 0) {
      let removed = -tokens;
      for (let i = samples.length - 1; i >= 0 && removed > 0; i--) {
        const fromSample = Math.min(samples[i].tokens, removed);
        samples[i].tokens -= fromSample;
        removed -= fromSample;
      }
    } else if (tokens > 0) {
      if (last && now - last.time < 100) last.tokens += tokens;
      else samples.push({ time: now, tokens });
    }
    this.samples.set(sessionId, samples);
    this.refresh(state);
  }

  updateTool(sessionId: string, toolId: string, args: string, result: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const previous = turn.tools.get(toolId) ?? { args: 0, result: 0 };
    const next = { args: toolTextTokens(args), result: toolTextTokens(result) };
    const argDelta = next.args - previous.args, resultDelta = next.result - previous.result;
    if (!argDelta && !resultDelta) return;
    turn.tools.set(toolId, next);
    turn.toolArgumentTokens += argDelta;
    const state = this.ensure(sessionId);
    state.breakdown.toolCallsTokens += argDelta + resultDelta;
    delete turn.reportedUsage.totalTokens;
    if (argDelta !== 0) delete turn.reportedUsage.outputTokens;
    if (resultDelta !== 0) {
      delete turn.reportedUsage.inputTokens;
      delete turn.reportedUsage.cachedReadTokens;
      delete turn.reportedUsage.cachedInputTokens;
      delete turn.reportedUsage.cachedWriteTokens;
      delete turn.reportedPromptTotal;
      state.reportedCacheUsage = undefined;
    }
    this.account(sessionId, { ...turn.counts, outputTokens: Math.max(0, turn.counts.outputTokens + argDelta),
      inputTokens: Math.max(0, turn.counts.inputTokens + resultDelta) });
    this.refresh(state);
  }

  discardUnsentTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.account(sessionId, zero());
    const models = this.sessionCounts.get(sessionId);
    if (!turn.existingModel) models?.delete(turn.modelId);
    if (!models?.size) this.sessionCounts.delete(sessionId);
    const key = `${turn.hourKey}\0${turn.modelId}`;
    const hour = this.ledger.get(key);
    if (hour && !turn.existingHourSession) {
      hour.sessions = hour.sessions.filter(id => id !== this.hourSessionId(sessionId));
      if (!hour.sessions.length && !KEYS.some(field => hour[field]) && !hour.unclassifiedTokens) this.ledger.delete(key);
    }
    this.states.set(sessionId, turn.original);
    this.cancelTurn(sessionId);
    this.notifyUpdated(sessionId);
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
      this.reportedWindowLimits.set(sessionId, size);
      state.maxContextTokens = size;
    } else {
      state.maxContextTokens = this.resolveMaxWindow(sessionId, state.modelId);
    }
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) {
      const prevReported = this.reportedUsed.get(sessionId);
      // 手动压缩与自动压缩分开记账。自动记录由两次已上报用量的显著回落推断，并非服务端的显式完成事件。
      const pending = this.pendingCompaction.get(sessionId);
      if (pending?.estimatedRecord) {
        const record = pending.estimatedRecord;
        // The ACP result supersedes the provisional compaction result in the saved record.
        delete record.estimated;
        record.afterTokens = Math.round(used);
        record.savedTokens = Math.max(0, record.beforeTokens - record.afterTokens);
        state.compactions = structuredClone(this.compactionsBySession.get(sessionId) || []);
        try { this.saveCompactions(); } catch { /* A later flush retries the in-memory history. */ }
        this.pendingCompaction.delete(sessionId);
      } else if (pending && used < pending.before) {
        pending.after = used;
        if (pending.completed) {
          this.recordCompaction(sessionId, pending.before, used, state.maxContextTokens, 'manual', pending.beforeEstimated);
          this.pendingCompaction.delete(sessionId);
        }
      } else if (!pending && prevReported !== undefined && prevReported >= 2000 && used >= 0 && used <= Math.floor(prevReported * 0.75)) {
        this.recordCompaction(sessionId, prevReported, used, state.maxContextTokens, 'auto');
      }
      this.reportedUsed.set(sessionId, used);
      state.reportedBreakdownTokens = Object.values(state.breakdown).reduce((sum, value) => sum + value, 0);
      state.usageSource = 'acp-reported';
    }
    this.refresh(state);
    this.scheduleFlush();
  }

  beginManualCompaction(sessionId: string): number {
    const state = this.ensure(sessionId);
    const before = state.usedContextTokens;
    this.pendingCompaction.set(sessionId, { before, beforeEstimated: this.reportedUsed.get(sessionId) !== before });
    return before;
  }

  cancelManualCompaction(sessionId: string): void { this.pendingCompaction.delete(sessionId); }

  finishManualCompaction(sessionId: string): ContextCompactionRecord | undefined {
    const state = this.ensure(sessionId);
    // 用量通知可能已先行记录本次手动压缩。此时直接取最近记录，避免发送完成回调再记一条。
    if (!this.pendingCompaction.has(sessionId)) {
      return state.compactions?.at(-1);
    }
    const pending = this.pendingCompaction.get(sessionId)!;
    if (pending.completed) return pending.estimatedRecord;
    const before = pending.before;
    let after = pending.after;
    if (after === undefined && this.reportedUsed.has(sessionId)) {
      pending.completed = true;
      return undefined;
    }
    const estimatedAfter = after === undefined;
    this.pendingCompaction.delete(sessionId);
    if (after === undefined) {
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
    const rec = this.recordCompaction(sessionId, before, after ?? state.usedContextTokens, state.maxContextTokens, 'manual', estimatedAfter || pending.beforeEstimated);
    if (estimatedAfter) this.pendingCompaction.set(sessionId, { ...pending, completed: true, estimatedRecord: rec });
    this.refresh(state);
    return rec;
  }

  private recordCompaction(
    sessionId: string,
    beforeTokens: number,
    afterTokens: number,
    maxContextTokens: number,
    trigger: 'manual' | 'auto',
    estimated = false
  ): ContextCompactionRecord {
    const state = this.ensure(sessionId);
    const record: ContextCompactionRecord = {
      id: randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
      trigger,
      ...(estimated && { estimated: true }),
      beforeTokens: Math.max(0, Math.round(beforeTokens)),
      afterTokens: Math.max(0, Math.round(afterTokens)),
      savedTokens: Math.max(0, Math.round(beforeTokens - afterTokens)),
      maxContextTokens,
    };
    const next = [...(this.compactionsBySession.get(sessionId) || []), record].slice(-50);
    state.compactionCount = Math.max(state.compactionCount ?? 0, this.compactionsBySession.get(sessionId)?.length ?? 0) + 1;
    this.compactionsBySession.set(sessionId, next);
    state.compactions = structuredClone(next);
    try {
      this.saveCompactions();
    } catch {
      /* 忽略只读环境保存异常 */
    }
    return record;
  }

  /** Apply cumulative counts for this turn. Complementary updates and repeated final reports are idempotent. */
  applyUsage(sessionId: string, usage: AcpTokenUsage): void {
    const state = this.ensure(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const reported = mergeUsage(turn.reportedUsage, usage);
    if (reported === turn.reportedUsage) return;
    const previousPrompt = samePromptCounters(reported, turn.reportedUsage) ? turn.reportedPromptTotal : undefined;
    const { counts, cacheUsage } = reconcileUsage(reported, turn.counts, previousPrompt);
    if (usage.outputTokens != null && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0) turn.unreportedReplyTokens = 0;
    if (usage.totalTokens != null && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) turn.replyTokensAfterTotal = 0;
    turn.reportedUsage = reported;
    turn.reportedPromptTotal = cacheUsage?.inputTokens ?? undefined;
    state.reportedCacheUsage = combineCacheUsage(turn.original.reportedCacheUsage, cacheUsage);
    this.account(sessionId, counts);
    state.usageSource = 'mixed';
    this.refresh(state);
  }

  /** 接收本回合的新累计值，以差额更新会话和小时账本。服务端重复回报同一用量时，账本增量为零。 */
  private account(sessionId: string, counts: FourDimTokenCounts): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const delta = Object.fromEntries(
      KEYS.map((key) => [key, counts[key] - turn.counts[key]])
    ) as unknown as FourDimTokenCounts;
    delta.unclassifiedTokens = (counts.unclassifiedTokens ?? 0) - (turn.counts.unclassifiedTokens ?? 0);
    turn.counts = { ...counts };
    const models = this.sessionCounts.get(sessionId) || new Map<string, FourDimTokenCounts>();
    models.set(turn.modelId, add(models.get(turn.modelId) || zero(), delta));
    this.sessionCounts.set(sessionId, models);
    const key = `${turn.hourKey}\0${turn.modelId}`;
    const record = this.ledger.get(key) || { ...zero(), hourKey: turn.hourKey, modelId: turn.modelId, sessions: [] };
    for (const dimension of KEYS) record[dimension] = Math.max(0, record[dimension] + delta[dimension]);
    record.unclassifiedTokens = Math.max(0, (record.unclassifiedTokens ?? 0) + delta.unclassifiedTokens);
    const ledgerId = this.hourSessionId(sessionId);
    if (!record.sessions.includes(ledgerId)) record.sessions.push(ledgerId);
    this.ledger.set(key, record);
    this.nativeCache.invalidate();
    this.pendingHours.add(key);
    this.pendingSessions.add(sessionId);
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
        turn.counts.outputTokens + turn.counts.thinkingTokens - turn.toolArgumentTokens
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
    this.notifyUpdated(sessionId);
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
    this.checkpointLimits.delete(sessionId);
    this.reportedWindowLimits.delete(sessionId);
    this.compactionsBySession.delete(sessionId);
    this.reviewer.remove(sessionId);
    this.translator.remove(sessionId);
    this.removeLegacySession(sessionId);
    this.saveCompactions();
    this.flush();
    this.notifyUpdated(sessionId, undefined, 'all');
  }


  recordExternalReviewUsage(input: ExternalReviewerUsageRecordInput, profileId = this.options.profileId || 'default'): void {
    if (this.reviewer.record(input, profileId)) { this.scheduleFlush(); this.notifyUpdated(input.sessionId, undefined, 'reviewer'); }
  }

  recordExternalTranslationUsage(input: ExternalTranslatorUsageRecordInput, profileId = this.options.profileId || 'default'): void {
    if (this.translator.record(input, profileId)) { this.scheduleFlush(); this.notifyUpdated(input.sessionId, undefined, 'translator'); }
  }

  private charts(now: number): TelemetryCharts {
    const charts = this.nativeCache.get(now, this.rateCards, calendar => nativeCalendar(this.ledger.values(), calendar, this.rateCards));
    const { breakdownByRange: modelBreakdownByRange, ...series } = structuredClone(charts);
    return { ...series, modelBreakdownByRange };
  }
  private sessionMaps(ids?: ReadonlySet<string>) {
    return {
      activeSessions: structuredClone(Object.fromEntries(selectedEntries(this.states, ids))),
      sessionModelBreakdowns: Object.fromEntries([...selectedEntries(this.sessionCounts, ids)]
        .map(([id, counts]) => [id, modelBreakdowns(counts, this.rateCards)])),
    };
  }
  voiceUsage?: () => TelemetryDashboardSnapshot['externalVoice'];
  delta(ids: ReadonlySet<string>, native: ReadonlySet<string>, partitions: ReadonlySet<string>): TelemetryDelta {
    const now = this.now();
    return {
      profileId: this.options.profileId || 'default', sequence: ++snapshotSequence, generatedAt: new Date(now).toISOString(),
      changedSessionIds: [...native], ...this.sessionMaps(native),
      ...(partitions.has('native') ? { nativeCharts: this.charts(now) } : {}),
      ...(partitions.has('voice') && { externalVoice: this.voiceUsage?.() }),
      ...(partitions.has('reviewer') ? { externalReviewer: this.reviewer.snapshot(ids) } : {}),
      ...(partitions.has('translator') ? { externalTranslator: this.translator.snapshot(ids) } : {}),
    };
  }
  snapshot(sessionIds?: ReadonlySet<string>): TelemetryDashboardSnapshot {
    const now = this.now();
    return {
      profileId: this.options.profileId || 'default', sequence: ++snapshotSequence, generatedAt: new Date(now).toISOString(),
      ...(sessionIds && { changedSessionIds: [...sessionIds] }), ...this.sessionMaps(sessionIds), ...this.charts(now),
      externalVoice: this.voiceUsage?.(), externalReviewer: this.reviewer.snapshot(sessionIds), externalTranslator: this.translator.snapshot(sessionIds),
      rateCards: structuredClone(this.rateCards), pricingSource: this.customRates ? 'user-custom-rate' : 'reference-api-estimate',
    };
  }

  hasSessionTelemetry(id: string): boolean { return this.states.has(id); }
  getSessionTelemetry(sessionId: string): SessionContextTelemetry | undefined {
    const state = this.states.get(sessionId);
    return state ? structuredClone(state) : undefined;
  }

}

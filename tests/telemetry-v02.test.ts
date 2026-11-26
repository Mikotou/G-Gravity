// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { ClientStore } from '../src/main/storage/client-store';
import type { ModelRateCard } from '../src/shared';

const directories: string[] = []; const stores: TelemetryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const rates: ModelRateCard[] = [ { modelId: 'default', displayName: 'Default', inputPerMillionUsd: 1, cachedInputPerMillionUsd: .2, outputPerMillionUsd: 2, thinkingPerMillionUsd: 3 }, { modelId: 'model-b', displayName: 'Model B', inputPerMillionUsd: 2, cachedInputPerMillionUsd: .4, outputPerMillionUsd: 4, thinkingPerMillionUsd: 6 } ];
function setup(options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gravity-qa-telemetry-')); directories.push(directory);
  const disk = new ClientStore(directory); const store = new TelemetryStore({ store: disk, now: () => Date.UTC(2026, 10, 17, 12), ...options }); stores.push(store);
  return { store, disk };
}

describe('reported session cache usage', () => {
  it('recognizes inclusive and separately reported cache, including mixed aliases and cache writes', () => {
    const { store } = setup({ rateCards: rates });
    const run = (id: string, usage: Parameters<TelemetryStore['applyUsage']>[1]) => {
      store.beginTurn(id, 'prompt');
      store.applyUsage(id, usage);
      store.applyUsage(id, usage);
      store.endTurn(id);
      return store.getSessionTelemetry(id)!;
    };
    const inclusive = run('subset', { inputTokens: 1000, outputTokens: 100, cachedReadTokens: 600, cachedInputTokens: 600, totalTokens: 1100 });
    expect(inclusive.averageCacheHitRate).toBe(0.6);
    expect(inclusive.costSummary).toMatchObject({ inputTokens: 400, cachedInputTokens: 600, totalTokens: 1100 });
    const separate = run('separate', { inputTokens: 100, cachedReadTokens: 720, cachedWriteTokens: 80, outputTokens: 40, thoughtTokens: 10, totalTokens: 950 });
    expect(separate.averageCacheHitRate).toBe(0.8);
    expect(separate.costSummary).toMatchObject({ inputTokens: 180, cachedInputTokens: 720, outputTokens: 40, thinkingTokens: 10, totalTokens: 950 });
    const ambiguous = run('ambiguous', { inputTokens: 100, cachedReadTokens: 60, outputTokens: 20 });
    expect(ambiguous.averageCacheHitRate).toBeUndefined();
    expect(ambiguous.costSummary.cachedInputTokens).toBe(60);
    expect(run('zero-only', { cachedReadTokens: 0 }).averageCacheHitRate).toBe(0);
    expect(run('no-input', { inputTokens: 0, cachedReadTokens: 0 }).averageCacheHitRate).toBeUndefined();
    const conflict = run('conflict', { inputTokens: 100, cachedReadTokens: 30, cachedInputTokens: 20, outputTokens: 0, totalTokens: 100 });
    expect(conflict.averageCacheHitRate).toBeUndefined();
    const malformed = run('malformed', { inputTokens: 5, cachedReadTokens: 720, outputTokens: 40, totalTokens: 9 });
    expect(malformed.averageCacheHitRate).toBeUndefined();
    expect(malformed.costSummary).toMatchObject({ totalTokens: 9, unclassifiedTokens: 9 });
    const ambiguousTotal = run('equal-components', { inputTokens: 100, outputTokens: 40, thoughtTokens: 20, cachedReadTokens: 20, totalTokens: 160 });
    expect(ambiguousTotal.averageCacheHitRate).toBeUndefined();
    expect(ambiguousTotal.costSummary).toMatchObject({ inputTokens: 80, cachedInputTokens: 20, outputTokens: 20, thinkingTokens: 20, unclassifiedTokens: 20, totalTokens: 160 });
  });

  it('keeps a proven input convention through output streaming and does not certify later input with stale cache data', () => {
    const { store } = setup();
    store.beginTurn('s', 'start');
    store.applyUsage('s', { inputTokens: 100, cachedReadTokens: 60, outputTokens: 20, totalTokens: 180 });
    store.addChunk('s', 'more');
    store.applyUsage('s', { cachedReadTokens: null });
    expect(store.getSessionTelemetry('s')?.costSummary).toMatchObject({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 21 });
    store.applyUsage('s', { outputTokens: 21 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBe(60 / 160);
    expect(store.getSessionTelemetry('s')?.costSummary.inputTokens).toBe(100);
    store.applyUsage('s', { inputTokens: 100, cachedReadTokens: 60, outputTokens: 21, totalTokens: 181 });
    store.applyUsage('s', { totalTokens: 201 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
    store.applyUsage('s', { inputTokens: 110, cachedReadTokens: 70, outputTokens: 21 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBe(70 / 180);
    store.updateTool('s', 't', 'read', 'new input');
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
    store.endTurn('s');
  });

  it('preserves the last reported total when a later partial result only identifies additional categories', () => {
    const { store } = setup();
    store.beginTurn('s', 'prompt');
    store.applyUsage('s', { inputTokens: 100, outputTokens: 20, totalTokens: 1000 });
    store.applyUsage('s', { outputTokens: 25 });
    expect(store.getSessionTelemetry('s')?.costSummary).toMatchObject({
      totalTokens: 1000, inputTokens: 100, outputTokens: 25, unclassifiedTokens: 875,
    });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
  });

  it('uses cumulative reported input as the weight, merges partial reports and invalidates stale cache counts', () => {
    const { store } = setup();
    store.beginTurn('s', 'first');
    store.applyUsage('s', { cachedReadTokens: 70 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
    store.applyUsage('s', { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    store.applyUsage('s', { outputTokens: 20 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBe(0.7);
    store.endTurn('s');
    store.beginTurn('s', 'second');
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
    store.applyUsage('s', { inputTokens: 300, cachedInputTokens: 30 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBe(0.25);
    store.applyUsage('s', { inputTokens: 400 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
    store.applyUsage('s', { cachedInputTokens: 0 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBe(0.14);
    store.endTurn('s');
    store.beginTurn('s', 'service did not supply cache data');
    store.applyUsage('s', { inputTokens: 10, outputTokens: 0 });
    store.endTurn('s');
    store.beginTurn('s', 'service confirmed zero this time');
    store.applyUsage('s', { inputTokens: 10, cachedReadTokens: 0 });
    expect(store.getSessionTelemetry('s')?.averageCacheHitRate).toBeUndefined();
  });

  it('retains confirmed zero, small positive rates and unknowns across checkpoints, restarts and rejected sends', async () => {
    const { store, disk } = setup();
    expect(store.ensure('empty').averageCacheHitRate).toBeUndefined();
    store.beginTurn('zero', 'prompt');
    store.applyUsage('zero', { inputTokens: 600, cachedReadTokens: 0 });
    expect(store.getSessionTelemetry('zero')?.averageCacheHitRate).toBe(0);
    store.endTurn('zero');
    store.beginTurn('unknown', 'prompt');
    store.applyUsage('unknown', { inputTokens: 600, cachedReadTokens: null });
    store.endTurn('unknown');
    store.beginTurn('small', 'prompt');
    store.applyUsage('small', { inputTokens: 1000000, cachedReadTokens: 1, outputTokens: 0, totalTokens: 1000000 });
    store.endTurn('small');
    store.flush();
    store.beginTurn('small', 'another prompt');
    store.discardUnsentTurn('small');
    expect(store.getSessionTelemetry('small')?.averageCacheHitRate).toBe(0.000001);
    store.beginTurn('live', 'prompt');
    store.applyUsage('live', { inputTokens: 20, cachedReadTokens: 5, totalTokens: 23, outputTokens: 3 });
    const checkpoint = 'telemetry-stream-' + createHash('sha256').update('default').digest('hex') + '.json';
    await vi.waitFor(() => expect(disk.read(checkpoint, null)).not.toBeNull());
    const reopened = new TelemetryStore({ store: disk }); stores.push(reopened);
    expect(reopened.getSessionTelemetry('live')?.averageCacheHitRate).toBe(0.25);
    expect(reopened.getSessionTelemetry('zero')?.averageCacheHitRate).toBe(0);
    expect(reopened.getSessionTelemetry('unknown')?.averageCacheHitRate).toBeUndefined();
    expect(reopened.getSessionTelemetry('small')?.averageCacheHitRate).toBe(0.000001);
  });

  it('treats legacy cache percentages and message-only history as unverified while preserving costs', () => {
    const { store, disk } = setup();
    store.beginTurn('legacy', 'old prompt');
    store.applyUsage('legacy', { inputTokens: 90, cachedInputTokens: 30 });
    store.endTurn('legacy'); store.flush();
    type Legacy = { profiles: { default: { states: Record<string, ReturnType<TelemetryStore['ensure']>> } } };
    const saved = disk.read<Legacy>('v2-session-telemetry.json', {} as Legacy);
    delete saved.profiles.default.states.legacy.reportedCacheUsage;
    disk.write('v2-session-telemetry.json', saved);
    const reopened = new TelemetryStore({ store: disk }); stores.push(reopened);
    expect(reopened.getSessionTelemetry('legacy')?.averageCacheHitRate).toBeUndefined();
    expect(reopened.getSessionTelemetry('legacy')?.costSummary.cachedInputTokens).toBe(30);
    reopened.hydrateFromMessages('history', 'default', [{ id: 'm', sessionId: 'history', role: 'user', content: 'old', createdAt: '2026-11-21' }]);
    reopened.beginTurn('history', 'new');
    reopened.applyUsage('history', { inputTokens: 100, cachedInputTokens: 50 });
    expect(reopened.getSessionTelemetry('history')?.averageCacheHitRate).toBeUndefined();
    reopened.hydrateFromMessages('fork', 'default', [{ id: 'm', sessionId: 'fork', role: 'user', content: 'inherited', revisionHistory: true, createdAt: '2026-11-21' }]);
    reopened.beginTurn('fork', 'own request');
    reopened.applyUsage('fork', { inputTokens: 100, cachedInputTokens: 50 });
    expect(reopened.getSessionTelemetry('fork')?.averageCacheHitRate).toBe(0.5);
  });
});

describe('24h/7d/30d 与四维 Cost 业务聚合', () => {
  it('空历史维度24/168/30，时间键唯一、小时合法，全部数值为零', () => {
    const { store } = setup(); const snapshot = store.snapshot();
    expect(snapshot.hourly24h).toHaveLength(24); expect(snapshot.matrix7d).toHaveLength(168); expect(snapshot.calendar30d).toHaveLength(30);
    expect(new Set(snapshot.hourly24h.map((bucket) => bucket.hourKey)).size).toBe(24);
    expect(new Set(snapshot.matrix7d.map((cell) => `${cell.date}T${cell.hour}`)).size).toBe(168);
    expect(snapshot.matrix7d.every((cell) => cell.hour >= 0 && cell.hour <= 23 && cell.totalTokens === 0)).toBe(true);
    expect(snapshot.calendar30d.at(-1)!.date).toBe('2026-11-17');
    expect(snapshot.costByRange.today.totalCostUsd).toBe(0); expect(snapshot.pricingSource).toBe('reference-api-estimate');
  });
  it('官方总量减cached/thought子集，四维互斥、重复usage幂等且Cost精确', () => {
    const { store } = setup({ rateCards: rates }); store.ensure('a', 'default'); store.beginTurn('a', '提示');
    store.applyUsage('a', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, thoughtTokens: 50 });
    store.applyUsage('a', { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, thoughtTokens: 50 }); store.endTurn('a');
    const snapshot = store.snapshot(); const cost = snapshot.activeSessions.a.costSummary;
    expect(cost).toMatchObject({ inputTokens: 600, cachedInputTokens: 400, outputTokens: 150, thinkingTokens: 50, totalTokens: 1200 });
    expect(cost.totalCostUsd).toBeCloseTo(.00113, 12);
    expect(snapshot.costByRange.today.totalCostUsd).toBeCloseTo(cost.totalCostUsd, 12);
    expect(snapshot.hourly24h.at(-1)!.totalTokens).toBe(1200);
    expect(snapshot.calendar30d.at(-1)!.sessionCount).toBe(1);
    expect(snapshot.activeSessions.a.usageSource).toBe('mixed');
  });
  it('模型堆叠占比与会话费用独立，切换单价重新估算并持久化', () => {
    const { store, disk } = setup({ rateCards: rates });
    for (const [id, model] of [['a', 'default'], ['b', 'model-b']]) { store.ensure(id, model); store.beginTurn(id, 'x'); store.applyUsage(id, { inputTokens: 1_000_000, outputTokens: 0 }); store.endTurn(id); }
    let snapshot = store.snapshot();
    expect(snapshot.costByRange.today.totalCostUsd).toBe(3);
    expect(snapshot.modelBreakdownByRange.today.map((model) => model.shareRatio).reduce((a, b) => a + b)).toBeCloseTo(1, 12);
    expect(snapshot.activeSessions.a.costSummary.totalCostUsd).toBe(1); expect(snapshot.activeSessions.b.costSummary.totalCostUsd).toBe(2);
    snapshot = store.updateModelRateCards(rates.map((rate) => ({ ...rate, inputPerMillionUsd: rate.inputPerMillionUsd * 2 })));
    expect(snapshot.costByRange.today.totalCostUsd).toBe(6); expect(snapshot.pricingSource).toBe('user-custom-rate');
    expect(disk.read<ModelRateCard[]>('model-rate-cards.json', [])[0].inputPerMillionUsd).toBe(2);
  });
  it('跨本地日界、7 日和 30 日边界时，按当地日历归类', () => {
    const midnight = (month: number, day: number) => new Date(2026, month, day, 0).getTime();
    let now = midnight(9, 18); const { store } = setup({ now: () => now });
    const record = (id: string) => { store.beginTurn(id, '中文'); store.endTurn(id); };
    record('outside'); now = midnight(9, 19); record('day30');
    now = midnight(10, 11); record('day7'); now = midnight(10, 17); record('today');
    const snapshot = store.snapshot();
    expect(snapshot.costByRange.today.totalTokens).toBe(2); expect(snapshot.costByRange['7d'].totalTokens).toBe(4); expect(snapshot.costByRange['30d'].totalTokens).toBe(6);
    expect(snapshot.hourly24h.at(-1)!.hourLabel).toBe('00:00');
  });
  it('大附件进度封顶、增量不膨胀、回合结束后保留真实 tok/s 且记录每次上下文压缩', () => {
    const { store } = setup({ maxContextTokens: 100 });
    store.beginTurn('a', 'x', [{ id: 'large', name: 'large.txt', kind: 'file', sizeBytes: 1000000, estimatedTokens: 250000 }]);
    store.addChunk('a', 'a'); store.addChunk('a', 'bcd');
    expect(store.snapshot().activeSessions.a.costSummary.outputTokens).toBe(1);
    expect(store.snapshot().activeSessions.a.usageRatio).toBe(1); store.endTurn('a');
    expect(store.snapshot().activeSessions.a.currentTokensPerSecond).toBeGreaterThan(0);

    // 验证官方 usage_update 上下文窗口同步与手动/自动压缩监控记录
    store.applyContextWindow('a', 120_000, 1_048_576);
    expect(store.snapshot().activeSessions.a.usedContextTokens).toBe(120_000);
    store.beginManualCompaction('a');
    store.applyContextWindow('a', 28_000, 1_048_576);
    store.finishManualCompaction('a');
    // 再触发一次服务端自动压缩（从 28k 降至 9k）
    store.applyContextWindow('a', 9_000, 1_048_576);
    const compactions = store.snapshot().activeSessions.a.compactions || [];
    expect(compactions).toHaveLength(2);
    expect(compactions[0]).toMatchObject({ trigger: 'manual', beforeTokens: 120_000, afterTokens: 28_000, savedTokens: 92_000 });
    expect(compactions[1]).toMatchObject({ trigger: 'auto', beforeTokens: 28_000, afterTokens: 9_000, savedTokens: 19_000 });
  });
  it('无效价格、重复模型、丢失default均拒绝且不污染有效表', () => {
    const { store } = setup({ rateCards: rates });
    expect(() => store.updateModelRateCards([{ ...rates[0], inputPerMillionUsd: NaN }])).toThrow('有限');
    expect(() => store.updateModelRateCards([rates[0], rates[0]])).toThrow('重复');
    expect(() => store.updateModelRateCards([rates[1]])).toThrow('default');
    expect(store.snapshot().rateCards).toEqual(rates);
  });

  it('retains confirmed zero prices and estimates only unpriced calls for the same model', () => {
    const { store, disk } = setup({ rateCards: rates });
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    const common = { sessionId: 's', provider: 'openai-compatible' as const, modelId: 'default', endpoint: 'http://127.0.0.1', latencyMs: 1 };
    for (const price of [0, 2, undefined]) {
      store.recordExternalTranslationUsage({ ...common, outcome: 'success', usage: { ...usage, directCostUsd: price } });
      store.recordExternalReviewUsage({ ...common, outcome: 'ask', usage: { ...usage, directCostUsd: price } });
      for (const stats of [store.snapshot().externalTranslator!, store.snapshot().externalReviewer!]) {
        const expected = price === undefined ? 3 : price;
        expect(stats.bySession.s.totalCostUsd).toBe(expected);
        expect(stats.costByRange.today.totalCostUsd).toBe(expected);
      }
    }
    store.flush();
    const reopened = new TelemetryStore({ store: disk, rateCards: rates });
    stores.push(reopened);
    const repriced = reopened.updateModelRateCards(rates.map(rate => ({ ...rate, inputPerMillionUsd: 5 })));
    expect(repriced.externalTranslator?.cumulativeAllTime.totalCostUsd).toBe(7);
    expect(repriced.externalReviewer?.cumulativeAllTime.inputCostUsd).toBe(7);
  });

  it('keeps older branch ledgers beyond 300 and clears only the requested session', () => {
    const { store, disk } = setup();
    for (let i = 0; i < 305; i++) {
      const sessionId = 'b' + i;
      store.ensure(sessionId);
      const base = { sessionId, provider: 'local-ollama' as const, endpoint: 'http://127.0.0.1', modelId: 'local', latencyMs: 1 };
      store.recordExternalTranslationUsage({ ...base, outcome: 'success' });
      store.recordExternalReviewUsage({ ...base, outcome: 'ask' });
    }
    store.flush();
    const next = new TelemetryStore({ store: disk });
    stores.push(next);
    const before = next.snapshot();
    expect(before.activeSessions.b0).toBeDefined();
    expect(before.externalTranslator?.bySession.b0.callCount).toBe(1);
    expect(before.externalReviewer?.bySession.b0.callCount).toBe(1);
    next.remove('b0');
    const after = next.snapshot();
    expect(after.externalReviewer?.bySession.b0).toBeUndefined();
    expect(after.externalTranslator?.bySession.b1.callCount).toBe(1);
    expect(after.externalTranslator?.cumulativeAllTime.callCount).toBe(305);
  });

  it('migrates old ledgers once, survives an old executable rewriting them, and deletes only the owning session', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gravity-ledger-upgrade-'));
    directories.push(directory);
    const disk = new ClientStore(directory);
    const now = () => Date.UTC(2026, 10, 17, 12);
    const open = (profileId: string) => new TelemetryStore({ store: disk, now, rateCards: rates, profileId });
    const counts = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
    const compaction = { id: 'old', timestamp: new Date(now()).toISOString(), trigger: 'manual' as const, beforeTokens: 80000, afterTokens: 20000, savedTokens: 60000, maxContextTokens: 256000 };
    const template = setup().store.ensure('shared', 'default');
    const legacySession = {
      states: { shared: { ...template, compactions: [compaction] }, kept: { ...template, sessionId: 'kept' } },
      sessionCounts: { shared: { default: counts } }, reportedUsed: { shared: 20000 },
      checkpointLimits: { shared: 256000 }, learnedModelLimits: { 'model-b': 256000 },
    };
    const bucket = { ...counts, provider: 'openai-compatible' as const, endpointHost: 'localhost', modelId: 'default', callCount: 1, directCostUsd: 2, hasDirectCost: true };
    const external = { cumulative: { model: { ...bucket, callCount: 2, directCostUsd: 4 } }, sessions: { shared: { buckets: { model: bucket } }, kept: { buckets: { model: bucket } } } };
    const hour = { hourKey: '2026-11-17T12', sessions: ['shared', 'kept'] };
    const writeOldFiles = () => {
      disk.write('session-telemetry.json', legacySession);
      disk.write('compactions.json', { shared: [compaction], kept: [compaction] });
      disk.write('token-hours.json', [{ ...hour, ...counts, modelId: 'default' }]);
      for (const kind of ['reviewer', 'translator']) {
        disk.write(`external-${kind}-totals.json`, external);
        disk.write(`external-${kind}-hours.json`, [{ ...hour, ...bucket }]);
      }
    };
    writeOldFiles();
    const upgraded = open('default');
    expect(upgraded.getSessionTelemetry('shared')?.costSummary.inputTokens).toBe(100);
    expect(upgraded.snapshot().externalReviewer?.bySession.shared.totalCostUsd).toBe(2);
    upgraded.beginTurn('shared', 'a');
    upgraded.applyUsage('shared', { inputTokens: 50, outputTokens: 0 });
    upgraded.endTurn('shared');
    upgraded.applyContextWindow('shared', 120000, 256000);
    upgraded.applyContextWindow('shared', 28000, 256000);
    const common = { sessionId: 'shared', provider: bucket.provider, endpoint: 'http://localhost', modelId: 'default', latencyMs: 1 };
    const usage = { ...counts, inputTokens: 1_000_000 };
    upgraded.recordExternalTranslationUsage({ ...common, outcome: 'success', usage });
    upgraded.recordExternalReviewUsage({ ...common, outcome: 'ask', usage });
    upgraded.dispose();
    const other = open('personal');
    expect(other.getSessionTelemetry('shared')).toBeUndefined();
    other.ensure('shared', 'model-b');
    other.recordExternalTranslationUsage({ ...common, outcome: 'success', usage: { ...counts, directCostUsd: 9 } });
    other.recordExternalReviewUsage({ ...common, outcome: 'ask', usage: { ...counts, directCostUsd: 9 } });
    other.remove('kept');
    expect(disk.read('compactions.json', { kept: [] }).kept).toHaveLength(1);
    other.dispose();

    // The old executable ignores the new fields and saves its own pre-upgrade snapshots on exit.
    writeOldFiles();
    const reopened = open('default');
    const restored = reopened.snapshot();
    expect(restored.activeSessions.shared.costSummary.inputTokens).toBe(150);
    expect(restored.activeSessions.shared.compactions).toHaveLength(2);
    expect(restored.costByRange.today.inputTokens).toBe(150);
    for (const stats of [restored.externalReviewer!, restored.externalTranslator!]) {
      expect(stats.bySession.shared.totalCostUsd).toBe(3);
      expect(stats.costByRange.today.totalCostUsd).toBe(12);
      expect(stats.cumulativeAllTime.totalCostUsd).toBe(14);
    }
    reopened.remove('shared');
    const flat = disk.read('session-telemetry.json', legacySession);
    expect(flat.states.shared).toBeUndefined();
    expect(flat.states.kept).toBeDefined();
    expect(flat.sessionCounts.shared).toBeUndefined();
    expect(flat.reportedUsed.shared).toBeUndefined();
    expect(flat.checkpointLimits.shared).toBeUndefined();
    expect(flat.learnedModelLimits).toEqual(legacySession.learnedModelLimits);
    expect(disk.read('compactions.json', {})).toEqual({ kept: [compaction] });
    for (const kind of ['reviewer', 'translator']) {
      const legacy = disk.read(`external-${kind}-totals.json`, external);
      expect(legacy.sessions.shared).toBeUndefined();
      expect(legacy.sessions.kept).toEqual(external.sessions.kept);
      expect(legacy.cumulative).toEqual(external.cumulative);
    }
    reopened.dispose();
    const deleted = open('default');
    expect(deleted.getSessionTelemetry('shared')).toBeUndefined();
    expect(deleted.snapshot().externalTranslator?.bySession.shared).toBeUndefined();
    deleted.dispose();
    const preserved = open('personal');
    expect(preserved.getSessionTelemetry('shared')?.modelId).toBe('model-b');
    for (const stats of [preserved.snapshot().externalReviewer!, preserved.snapshot().externalTranslator!]) {
      expect(stats.bySession.shared.totalCostUsd).toBe(9);
      expect(stats.cumulativeAllTime.totalCostUsd).toBe(14);
    }
    preserved.dispose();
  });

  it('does not bill copied output, preserves a reported window, and skips malformed hour rows', () => {
    const { store, disk } = setup();
    const old = { sessionId: 'branch', content: 'copied reply', id: 'copy', role: 'assistant' as const, revisionHistory: true, createdAt: 'now' };
    const state = store.hydrateFromMessages('branch', 'default', [old]);
    expect(state.breakdown.agentMessagesTokens).toBeGreaterThan(0);
    expect(state.costSummary.totalTokens).toBe(0);
    const snap = vi.spyOn(store, 'snapshot');
    store.on('changed', () => {});
    store.applyContextWindow('branch', 2000, 345678);
    store.addChunk('branch', 'new text');
    expect(store.getSessionTelemetry('branch')?.maxContextTokens).toBe(345678);
    expect(snap).not.toHaveBeenCalled();
    store.flush();
    disk.write('v2-token-hours.json', [null]);
    const next = new TelemetryStore({ store: disk });
    stores.push(next);
    expect(next.getSessionTelemetry('branch')?.maxContextTokens).toBe(345678);
    next.clearSessionCheckpointLimit('branch', 'next-model');
    expect(next.getSessionTelemetry('branch')?.maxContextTokens).toBe(256000);
  });
});

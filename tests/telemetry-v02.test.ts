// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('跨日/7日/30日边界与UTC小时归属不串范围', () => {
    let now = Date.UTC(2026, 9, 18, 0); const { store } = setup({ now: () => now });
    const record = (id: string) => { store.beginTurn(id, '中文'); store.endTurn(id); };
    record('outside'); now = Date.UTC(2026, 9, 19, 0); record('day30');
    now = Date.UTC(2026, 10, 11, 0); record('day7'); now = Date.UTC(2026, 10, 17, 0); record('today');
    const snapshot = store.snapshot();
    expect(snapshot.costByRange.today.totalTokens).toBe(2); expect(snapshot.costByRange['7d'].totalTokens).toBe(4); expect(snapshot.costByRange['30d'].totalTokens).toBe(6);
    expect(snapshot.hourly24h.at(-1)!.hourKey).toBe('2026-11-17T00');
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
});

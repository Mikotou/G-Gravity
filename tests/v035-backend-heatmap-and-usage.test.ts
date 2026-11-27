// @vitest-environment node
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeHeatLevel, mergeTelemetryDashboard, type TelemetryDashboardSnapshot } from '../src/shared/telemetry-contract';
import type { GravityDesktopBridge } from '../src/shared/ipc-channels';
import { ClientStore } from '../src/main/storage/client-store';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { extractProviderTokenUsage } from '../src/main/llm/provider-usage';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gravity-v035-heat-'));
  const disk = new ClientStore(dir);
  let now = new Date(2026, 10, 17, 12, 15).getTime();
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  function open() {
    const store = new TelemetryStore({ store: disk, profileId: 'default', now: () => now });
    cleanup.push(() => store.dispose());
    return store;
  }
  return { disk, store: open(), open, day: (day: number, hour = 12) => { now = new Date(2026, 10, day, hour, 15).getTime(); } };
}
function intensity(value: number, values: number[], n: 24 | 7 | 30) {
  if (!value) return 0;
  const sum = values.reduce((a, b) => a + b);
  const absolute = Math.min(1, Math.log1p(value / 1000) / Math.log1p(n === 24 ? 250 : 2500));
  const relative = Math.log1p(n * value / sum) / Math.log1p(n);
  const score = absolute * (0.4 + 0.25 * relative + 0.35 * value / Math.max(...values));
  return 1 + [0.12, 0.36, 0.67].filter(threshold => score >= threshold).length;
}

describe('window-local heat and independent ledgers', () => {
  it('covers zero, invalid input, all five levels, skewed windows and absolute saturation', () => {
    for (const n of [24, 7, 30] as const) {
      const levels = new Set<number>();
      for (const peak of [0, 1, 1000, 10_000, 250_000, 2_500_000, 1e9]) {
        for (const ratio of [0, .01, .1, .35, .67, 1]) {
          const rows = Array.from({ length: n }, (_, i) => i === 0 ? peak : i % 3 ? Math.round(peak * ratio) : 0);
          for (const x of rows) {
            const level = computeHeatLevel(x, rows.reduce((a, b) => a + b), peak, n);
            expect(level).toBe(intensity(x, rows, n));
            levels.add(level);
          }
        }
      }
      expect([...levels].sort()).toEqual([0, 1, 2, 3, 4]);
      for (const invalid of [-1, NaN, Infinity]) {
        expect(computeHeatLevel(invalid, 1, 1, n)).toBe(0);
        expect(computeHeatLevel(1, invalid, 1, n)).toBe(0);
        expect(computeHeatLevel(1, 1, invalid, n)).toBe(0);
      }
    }
  });

  it('colors every native/reviewer/translator bucket against its own window and deduplicates daily sessions', () => {
    const { store, day } = fixture();
    for (const [date, hour, sid, n] of [
      [1, 0, 'early', 80_000_000], [12, 6, 'a', 24_000], [17, 8, 'a', 2000], [17, 10, 'a', 6000], [17, 12, 'b', 55_000],
    ] as const) {
      day(date, hour);
      store.beginTurn(sid, 'x');
      store.applyUsage(sid, { inputTokens: n, outputTokens: 0 });
      store.endTurn(sid);
      const call = { sessionId: sid, provider: 'openai-compatible' as const, modelId: 'fixture', endpoint: 'https://fixture.invalid', latencyMs: 1 };
      const counts = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
      store.recordExternalReviewUsage({ ...call, outcome: 'approve', usage: { ...counts, totalTokens: n / 2, directCostUsd: 200 } });
      store.recordExternalTranslationUsage({ ...call, outcome: 'success', usage: { ...counts, totalTokens: n * 4, directCostUsd: 0 } });
    }
    const full = store.snapshot();
    for (const dashboard of [full, full.externalReviewer!, full.externalTranslator!]) {
      expect(dashboard.daily7d?.map(d => d.date)).toEqual(dashboard.calendar30d.slice(-7).map(d => d.date));
      expect(dashboard.daily7d?.at(-1)?.sessionCount).toBe(2);
      expect(dashboard.matrix7d).toHaveLength(168);
      for (const [n, rows] of [[24, dashboard.hourly24h], [7, dashboard.daily7d!], [30, dashboard.calendar30d]] as const) {
        expect(rows).toHaveLength(n);
        const values = rows.map(r => r.totalTokens);
        for (const row of rows) expect(row.intensity).toBe(intensity(row.totalTokens, values, n));
      }
    }
    const ids = new Set(['a', 'b']);
    const delta = store.delta(ids, ids, new Set(['native', 'reviewer', 'translator']));
    expect(delta.nativeCharts?.daily7d).toEqual(full.daily7d);
    expect(delta.externalReviewer?.daily7d).toEqual(full.externalReviewer?.daily7d);
    expect(delta.externalTranslator?.daily7d).toEqual(full.externalTranslator?.daily7d);

    // Execute the compiled, sandboxed preload with only its Electron capabilities.
    const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(async () => full) });
    let bridge!: GravityDesktopBridge;
    runInNewContext(readFileSync(resolve('dist/main/preload.js'), 'utf8'), {
      exports: {}, require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_key: string, value: GravityDesktopBridge) => { bridge = value; } } }),
    });
    const events: TelemetryDashboardSnapshot[] = [];
    const off = bridge.onTelemetryUpdated(snapshot => events.push(snapshot));
    ipc.emit('gravity:event:telemetry-updated', {}, full);
    ipc.emit('gravity:event:telemetry-updated', {}, delta);
    ipc.emit('gravity:event:telemetry-updated', {}, store.delta(ids, new Set(), new Set(['reviewer'])));
    off();
    expect(events.map(e => e.daily7d)).toEqual([full.daily7d, full.daily7d, full.daily7d]);
    expect(events[1].externalTranslator?.daily7d).toEqual(full.externalTranslator?.daily7d);
    expect(events[2].externalReviewer?.daily7d).toEqual(full.externalReviewer?.daily7d);
    const merged = events.reduce(mergeTelemetryDashboard);
    expect(merged.externalReviewer?.daily7d).toEqual(full.externalReviewer?.daily7d);
    expect(merged.externalTranslator?.daily7d).toEqual(full.externalTranslator?.daily7d);
  });

  it.each([
    ['America/New_York', '2026-03-08T12:00Z', ['01:00:00-05:00', '03:00:00-04:00'], '2026-03-08T02:'],
    ['America/New_York', '2026-11-01T12:00Z', ['01:00:00-04:00', '01:00:00-05:00'], 'never'],
    ['Asia/Kathmandu', '2026-11-01T12:00Z', ['17:00:00+05:45'], 'never'],
    ['Australia/Lord_Howe', '2026-04-05T02:00Z', ['01:00:00+11:00', '01:30:00+10:30'], 'never'],
    ['Australia/Lord_Howe', '2026-10-04T02:00Z', ['02:30:00+11:00', '03:00:00+11:00'], '2026-10-04T02:00'],
  ] as const)('uses exact numeric offsets for %s at %s', (zone, at, expected, absent) => {
    // Set TZ before starting Node, including on Windows where worker env changes cannot set the host zone.
    const script = "const {calendarFor}=require('./dist/main/telemetry/calendar'); console.log(JSON.stringify(calendarFor(Date.parse(process.argv[1])).hours));";
    const rows: Array<{ startIso: string; hourKey: string }> = JSON.parse(execFileSync(process.execPath, ['-e', script, at], {
      env: { ...process.env, TZ: zone }, encoding: 'utf8',
    }));
    expect(rows).toHaveLength(24);
    const instants = rows.map(row => Date.parse(row.startIso));
    expect(new Set(instants).size).toBe(24);
    expect(instants).toEqual([...instants].sort((a, b) => a - b));
    for (const part of expected) expect(rows.some(row => row.startIso.endsWith('T' + part))).toBe(true);
    expect(rows.some(row => row.startIso.includes(absent))).toBe(false);
    for (const [i, row] of rows.entries()) expect(new Date(instants[i]).toISOString().slice(0, 16).replace(/:00$/, '')).toBe(row.hourKey);
  });

  it('invalidates the cache for two IANA zones sharing their current offset', () => {
    const script = "const {TelemetryAggregator}=require('./dist/main/telemetry/telemetry-aggregator'); const c=new TelemetryAggregator(),r=[]; let n=0; const hits=[]; for(const z of ['America/New_York','America/Lima','America/Lima']) {process.env.TZ=z; hits.push(c.get(Date.parse('2026-11-12T14:00Z'),r,()=>++n));} console.log(JSON.stringify(hits));";
    expect(JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }))).toEqual([1, 2, 2]);
  });
});

it('persists positive total_tokens remainders and absolute fees through ledger merging and reload', () => {
  const { store, open } = fixture();
  const provider = 'openai-compatible' as const;
  const only = extractProviderTokenUsage(provider, { usage: { total_tokens: 900, total_cost: 1.5 } })!;
  const partial = extractProviderTokenUsage(provider, { usage: { total_tokens: 90, prompt_tokens: 20, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 10 } } })!;
  expect(only).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 900, unclassifiedTokens: 900, directCostUsd: 1.5 });
  expect(partial).toMatchObject({ inputTokens: 15, cachedInputTokens: 5, outputTokens: 40, thinkingTokens: 10, totalTokens: 90, unclassifiedTokens: 20 });
  expect(extractProviderTokenUsage(provider, { usage: { total_tokens: 10, prompt_tokens: 12 } })?.totalTokens).toBe(12);
  const call = { sessionId: 'one', provider, modelId: 'default', endpoint: 'https://fixture.invalid', latencyMs: 0 };
  for (const usage of [only, partial]) {
    store.recordExternalReviewUsage({ ...call, outcome: 'ask', usage });
    store.recordExternalTranslationUsage({ ...call, outcome: 'success', usage });
  }
  store.flush();
  for (const dashboard of [store.snapshot(), open().snapshot()]) {
    for (const ext of [dashboard.externalReviewer!, dashboard.externalTranslator!]) {
      const total = ext.cumulativeAllTime;
      expect(total).toMatchObject({ totalTokens: 990, unclassifiedTokens: 920, callCount: 2 });
      expect(ext.bySession.one.totalCostUsd).toBe(total.totalCostUsd);
      expect(ext.daily7d!.at(-1)).toMatchObject({ totalTokens: 990, unclassifiedTokens: 920 });
      expect(total.totalCostUsd).toBeCloseTo(1.5 + total.inputCostUsd + total.cachedInputCostUsd + total.outputCostUsd + total.thinkingCostUsd, 10);
    }
  }
});

it('keeps a legacy aggregate with a total-only charge out of future per-category prices', () => {
  const { disk, open } = fixture();
  disk.write('external-reviewer-totals.json', { cumulative: { old: {
    provider: 'openai-compatible', modelId: 'default', endpointHost: 'fixture.invalid', callCount: 1,
    totalTokens: 80, hasDirectCost: true, directCostUsd: 2,
  } } });
  const restored = open();
  restored.recordExternalReviewUsage({ sessionId: 's', provider: 'openai-compatible', modelId: 'default',
    endpoint: 'https://fixture.invalid', latencyMs: 1, outcome: 'approve',
    usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 20, directCostUsd: 0.25 } });
  const total = restored.snapshot().externalReviewer!.cumulativeAllTime;
  expect(total).toMatchObject({ totalTokens: 100, inputTokens: 20, unclassifiedTokens: 80, totalCostUsd: 2.25 });
  expect(total.inputCostUsd).toBeCloseTo(0.25);
});

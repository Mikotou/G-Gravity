import {
  calculateTokenCost, resolveModelRateCard, type ModelRateCard, type TokenCostSummary,
  type FourDimTokenCounts,
} from '../../shared/telemetry-contract';
import { calendarBuckets, calendarFor, ledgerHour } from './calendar';
import { add, intensity, zero, type HourRecord } from './telemetry-data';

export class TelemetryAggregator<T> {
  private version = 0;
  private cached?: { version: number; boundary: string; rates: ModelRateCard[]; result: T };

  invalidate(): void { this.version++; }

  get(now: number, rates: ModelRateCard[], compute: (calendar: ReturnType<typeof calendarFor>) => T): T {
    const boundary = ledgerHour(now) + '/' + new Date(now).getTimezoneOffset();
    const cached = this.cached;
    if (cached && cached.version === this.version && cached.rates === rates && cached.boundary === boundary) return cached.result;
    const result = compute(calendarFor(now));
    this.cached = { version: this.version, rates, boundary, result };
    return result;
  }
}

export function summarizeCalendar<T extends { hourKey: string; sessions: string[] }, S extends TokenCostSummary, I>(
  records: Iterable<T>, calendar: ReturnType<typeof calendarFor>, summarize: (rows: T[]) => { total: S; items: I[] }
) {
  const buckets = calendarBuckets(records, calendar);
  const empty = summarize([]);
  const group = (rows: T[]) => rows.length ? summarize(rows) : empty;
  const hourly24h = calendar.hours.map(({ hourKey, hourLabel }) => {
    const { total } = group(buckets.hour(hourKey));
    return { hourKey, hourLabel, ...total, costUsd: total.totalCostUsd };
  });
  const matrix7d = Array.from({ length: 168 }, (_, i) => {
    const date = calendar.days[23 + Math.floor(i / 24)], hour = i % 24;
    const { total } = group(buckets.slot(date, hour));
    return { date, hour, totalTokens: total.totalTokens, costUsd: total.totalCostUsd, intensity: intensity(total.totalTokens) };
  });
  const calendar30d = calendar.days.map(date => {
    const rows = buckets.day(date);
    const { total } = group(rows);
    return { date, ...total, costUsd: total.totalCostUsd, sessionCount: new Set(rows.flatMap(row => row.sessions)).size, intensity: intensity(total.totalTokens) };
  });
  const today = group(buckets.range('today')), week = group(buckets.range('7d')), month = group(buckets.range('30d'));
  return { hourly24h, matrix7d, calendar30d, costByRange: { today: today.total, '7d': week.total, '30d': month.total },
    breakdownByRange: { today: today.items, '7d': week.items, '30d': month.items } };
}
export function modelBreakdowns(counts: Map<string, FourDimTokenCounts>, rates: ModelRateCard[]) {
  const rows = [...counts].map(([modelId, value]) => {
    const rate = resolveModelRateCard(modelId, rates);
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

export function sumCosts(rows: TokenCostSummary[]): TokenCostSummary {
  const result = calculateTokenCost(zero(), { inputPerMillionUsd: 0, cachedInputPerMillionUsd: 0, outputPerMillionUsd: 0, thinkingPerMillionUsd: 0 });
  for (const row of rows) {
    for (const key of Object.keys(result) as Array<keyof TokenCostSummary>) result[key] = (result[key] ?? 0) + (row[key] ?? 0);
  }
  return result;
}


export function nativeCalendar(records: Iterable<HourRecord>, calendar: ReturnType<typeof calendarFor>, rates: ModelRateCard[]) {
  return summarizeCalendar(records, calendar, rows => {
    const counts = new Map<string, FourDimTokenCounts>();
    for (const row of rows) counts.set(row.modelId, add(counts.get(row.modelId) ?? zero(), row));
    const items = modelBreakdowns(counts, rates);
    return { total: sumCosts(items), items };
  });
}

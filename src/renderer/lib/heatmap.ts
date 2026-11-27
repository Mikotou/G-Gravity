import {
  computeHeatLevel,
  type DailyCalendarHeatmapCell,
  type HeatLevel,
  type HourlyTokenBarBucket,
} from '../../shared/telemetry-contract';

/**
 * v0.3.5 热力图纯函数：唯一强度来源为共享层 `computeHeatLevel`，渲染层只负责旧快照兼容回退。
 */

/** 紧凑 Token 读数，保证 ≤ 4 个字符（如 `0`、`999`、`1.2k`、`12k`、`123k`、`1.2M`、`12M`、`999B`）。 */
export function formatTokenCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 999.5) return String(Math.round(tokens));
  const units: Array<[string, number]> = [
    ['k', 1e3],
    ['M', 1e6],
    ['B', 1e9],
    ['T', 1e12],
  ];
  for (const [unit, base] of units) {
    const v = tokens / base;
    if (v < 9.95) return v.toFixed(1).replace(/\.0$/, '') + unit;
    if (v < 999.5) return Math.round(v) + unit;
  }
  return '999T';
}

export function sumTokens(cells: ReadonlyArray<{ totalTokens: number }>): number {
  return cells.reduce((acc, c) => acc + (Number.isFinite(c.totalTokens) && c.totalTokens > 0 ? c.totalTokens : 0), 0);
}

export function peakTokens(cells: ReadonlyArray<{ totalTokens: number }>): number {
  return cells.reduce((acc, c) => (Number.isFinite(c.totalTokens) && c.totalTokens > acc ? c.totalTokens : acc), 0);
}

/** 24h：优先后端 `intensity`，缺省时按 24 桶窗口回退 `computeHeatLevel`。 */
export function resolveHourlyLevels(hourly: readonly HourlyTokenBarBucket[]): HeatLevel[] {
  const total = sumTokens(hourly);
  const peak = peakTokens(hourly);
  return hourly.map((b) =>
    b.intensity !== undefined && b.intensity !== null
      ? b.intensity
      : computeHeatLevel(b.totalTokens, total, peak, 24)
  );
}

/**
 * 7d：新快照直接消费 `daily7d`（后端按 7 日窗口计算强度）；
 * 旧快照缺 `daily7d` 时取 `calendar30d.slice(-7)`，以 7 日窗口总量 S 与峰值 P 重新计算强度（不沿用 30d 窗口强度）。
 */
export function resolveDaily7d(
  daily7d: readonly DailyCalendarHeatmapCell[] | undefined,
  calendar30d: readonly DailyCalendarHeatmapCell[]
): DailyCalendarHeatmapCell[] {
  if (daily7d && daily7d.length > 0) return daily7d.slice(-7);
  const last7 = calendar30d.slice(-7);
  const total = sumTokens(last7);
  const peak = peakTokens(last7);
  return last7.map((d) => ({ ...d, intensity: computeHeatLevel(d.totalTokens, total, peak, 7) }));
}

export function parseLocalDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 周一为 0 的星期索引 */
export function mondayIndex(date: string): number {
  const d = parseLocalDate(date);
  return d ? (d.getDay() + 6) % 7 : 0;
}

export function localDateKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * FE-BUG-05：优先解析 `HourlyTokenBarBucket.startIso` 中的本地日期/时间与数值 UTC 偏移
 * （如 `-04:00` / `-05:00` / `+05:45`），让夏令时回拨产生的两个 `01:00` 桶可精准区分；缺省回退 `hourLabel`。
 */
export function formatHourBucketLabel(bucket: Pick<HourlyTokenBarBucket, 'hourLabel' | 'startIso'>): string {
  const iso = bucket.startIso?.trim();
  if (iso) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.exec(iso);
    if (m) {
      const offset = m[3].toUpperCase() === 'Z' ? '+00:00' : m[3];
      return `${m[1]} ${m[2]} (${offset})`;
    }
  }
  return bucket.hourLabel;
}

export interface CalendarWeek {
  /** 周一日期（可能早于数据首日） */
  key: string;
  /** 7 个槽位，周一至周日；不在窗口内的为 null */
  slots: Array<{ day: DailyCalendarHeatmapCell; index: number } | null>;
  totalTokens: number;
  costUsd: number;
  /** 该周第一个有效日期（用于周起始标签） */
  firstDate: string;
}

/** 30d：按周一至周日对齐分周（Codex 周行），前后不足一周的槽位留空。 */
export function groupCalendarWeeks(calendar: readonly DailyCalendarHeatmapCell[]): CalendarWeek[] {
  const weeks: CalendarWeek[] = [];
  let current: CalendarWeek | null = null;
  calendar.forEach((day, index) => {
    const col = mondayIndex(day.date);
    if (!current || col === 0) {
      current = { key: day.date, slots: Array(7).fill(null), totalTokens: 0, costUsd: 0, firstDate: day.date };
      weeks.push(current);
    }
    current.slots[col] = { day, index };
    current.totalTokens += Number.isFinite(day.totalTokens) ? Math.max(0, day.totalTokens) : 0;
    current.costUsd += Number.isFinite(day.costUsd) ? Math.max(0, day.costUsd) : 0;
  });
  return weeks;
}

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type {
  DailyCalendarHeatmapCell,
  DayHourHeatmapCell,
  HourlyTokenBarBucket,
  TokenHeatmapRange,
} from '@shared';
import { useI18n } from '../../i18n/I18nContext';
import { formatTokenShort, formatUsd } from '../ContextStatusBar';

/**
 * U-04：主 Context & Cost 看板与外部复核 / 翻译看板共用的 Token 热力图。
 *
 * - 顶部 3 格 KPI 洞察条（活跃时段/天数 · 时均/日均 · 峰值）；
 * - `24h`：保留柱状图 + 左侧 Token 刻度；
 * - `7d`：00/06/12/18/24 小时标尺、左侧「星期 + 短日期」、右侧每日 Token 汇总胶囊、7×24 圆角热力格；
 * - `30d`：Mon–Sun 列头 + 对齐日历网格（格内日期数字、跨月首日短月标、今日描边），不再有误导性的 `$max/$0` 纵轴；
 * - 色阶全部来自主题派生变量（`.heatmap-cell.i-0..4`），悬停 / 键盘聚焦显示完整读数，移出复位。
 *
 * 关键 testid（`${prefix}heatmap-*`）与 `.heatmap-cell` / `.hm-bar` / `.hm-hover` / `.hm-y-scale` 类名保持不变。
 */
export interface TokenHeatmapViewProps {
  /** testid 前缀：主看板为 ''，外部服务为 'reviewer-' / 'translator-' */
  testIdPrefix: string;
  sectionTestId: string;
  title: string;
  hourly24h: readonly HourlyTokenBarBucket[];
  matrix7d: readonly DayHourHeatmapCell[];
  calendar30d: readonly DailyCalendarHeatmapCell[];
}

const HOUR_TICKS = [0, 6, 12, 18, 24] as const;

function parseLocalDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 周一为 0 的星期索引 */
function mondayIndex(date: string): number {
  const d = parseLocalDate(date);
  return d ? (d.getDay() + 6) % 7 : 0;
}

function localDateKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function computeBarTier(ratio: number, hasData: boolean): 0 | 1 | 2 | 3 | 4 {
  if (!hasData || ratio <= 0) return 0;
  if (ratio < 0.22) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.8) return 3;
  return 4;
}

interface Kpi {
  label: string;
  value: string;
  sub?: string;
}

/** 网格内的漫游焦点（roving tabindex）：方向键移动，Home/End 跳到行首/行尾，只有一个 Tab 停靠点。 */
function useRovingGrid(count: number, columns: number, onFocusIndex: (index: number) => void) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLElement | null>>([]);
  const move = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(count - 1, next));
      setActive(clamped);
      refs.current[clamped]?.focus();
      onFocusIndex(clamped);
    },
    [count, onFocusIndex]
  );
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      let next: number | null = null;
      if (e.key === 'ArrowRight') next = index + 1;
      else if (e.key === 'ArrowLeft') next = index - 1;
      else if (e.key === 'ArrowDown') next = index + columns;
      else if (e.key === 'ArrowUp') next = index - columns;
      else if (e.key === 'Home') next = index - (index % columns);
      else if (e.key === 'End') next = index - (index % columns) + columns - 1;
      if (next === null) return;
      e.preventDefault();
      move(next);
    },
    [columns, move]
  );
  return { active: Math.min(active, Math.max(0, count - 1)), refs, onKeyDown, setActive };
}

export function TokenHeatmapView({
  testIdPrefix,
  sectionTestId,
  title,
  hourly24h,
  matrix7d,
  calendar30d,
}: TokenHeatmapViewProps): React.ReactElement {
  const { dict } = useI18n();
  const v034 = dict.ui.v034;
  const [range, setRange] = useState<TokenHeatmapRange>('24h');
  const [hover, setHover] = useState('');
  const clearHover = useCallback(() => setHover(''), []);
  const today = localDateKey();

  const max24Tokens = Math.max(0, ...hourly24h.map((b) => b.totalTokens));
  const max24Scale = Math.max(1, max24Tokens);

  const rows7d = useMemo(() => {
    const map = new Map<string, DayHourHeatmapCell[]>();
    for (const cell of matrix7d) {
      const list = map.get(cell.date) ?? [];
      list.push(cell);
      map.set(cell.date, list);
    }
    return Array.from(map.entries()).map(([date, cells]) => ({
      date,
      cells: [...cells].sort((a, b) => a.hour - b.hour),
      tokens: cells.reduce((acc, c) => acc + c.totalTokens, 0),
      cost: cells.reduce((acc, c) => acc + c.costUsd, 0),
    }));
  }, [matrix7d]);

  const dayLabel = useCallback(
    (date: string) => {
      const d = parseLocalDate(date);
      if (!d) return date;
      return v034.heatmapDayLabel(v034.heatmapWeekdaysShort[(d.getDay() + 6) % 7], d.getMonth() + 1, d.getDate());
    },
    [v034]
  );

  const rangeCells: ReadonlyArray<{ totalTokens: number; costUsd: number }> =
    range === '24h' ? hourly24h : range === '7d' ? matrix7d : calendar30d;
  const rangeTotal = rangeCells.reduce((acc, b) => acc + b.totalTokens, 0);
  const rangeCostUsd = rangeCells.reduce((acc, b) => acc + b.costUsd, 0);

  const kpis = useMemo<Kpi[]>(() => {
    if (range === '24h') {
      const active = hourly24h.filter((b) => b.totalTokens > 0).length;
      const peak = hourly24h.reduce<HourlyTokenBarBucket | null>(
        (best, b) => (b.totalTokens > (best?.totalTokens ?? 0) ? b : best),
        null
      );
      return [
        { label: v034.heatmapKpiActiveHours, value: `${active}/${hourly24h.length || 24}` },
        { label: v034.heatmapKpiHourlyAvg, value: formatTokenShort(Math.round(rangeTotal / Math.max(1, hourly24h.length || 24))) },
        {
          label: v034.heatmapKpiPeakHour,
          value: peak ? peak.hourLabel : '—',
          sub: peak ? formatTokenShort(peak.totalTokens) : undefined,
        },
      ];
    }
    const days =
      range === '7d'
        ? rows7d.map((r) => ({ date: r.date, tokens: r.tokens }))
        : calendar30d.map((d) => ({ date: d.date, tokens: d.totalTokens }));
    const active = days.filter((d) => d.tokens > 0).length;
    const peak = days.reduce<{ date: string; tokens: number } | null>(
      (best, d) => (d.tokens > (best?.tokens ?? 0) ? d : best),
      null
    );
    const span = range === '7d' ? 7 : 30;
    return [
      { label: v034.heatmapKpiActiveDays, value: `${active}/${days.length || span}` },
      { label: v034.heatmapKpiDailyAvg, value: formatTokenShort(Math.round(rangeTotal / Math.max(1, days.length || span))) },
      {
        label: v034.heatmapKpiPeakDay,
        value: peak ? dayLabel(peak.date) : '—',
        sub: peak ? formatTokenShort(peak.tokens) : undefined,
      },
    ];
  }, [calendar30d, dayLabel, hourly24h, range, rangeTotal, rows7d, v034]);

  /* ---------------------------------------------------------------- 7d 漫游焦点 */
  const flat7d = useMemo(() => rows7d.flatMap((r) => r.cells), [rows7d]);
  const describe7d = useCallback(
    (cell: DayHourHeatmapCell) =>
      `${v034.heatmapHourCellTitle(`${dayLabel(cell.date)}`, cell.hour, formatTokenShort(cell.totalTokens))} · ${formatUsd(cell.costUsd)}`,
    [dayLabel, v034]
  );
  const grid7d = useRovingGrid(flat7d.length, 24, (i) => flat7d[i] && setHover(describe7d(flat7d[i])));

  /* ---------------------------------------------------------------- 30d 日历 */
  const describe30d = useCallback(
    (day: DailyCalendarHeatmapCell) =>
      `${day.date} · ${formatTokenShort(day.totalTokens)} Tokens · ${v034.heatmapThreads(day.sessionCount)} · ${formatUsd(day.costUsd)}`,
    [v034]
  );
  const grid30d = useRovingGrid(calendar30d.length, 7, (i) => calendar30d[i] && setHover(describe30d(calendar30d[i])));
  const firstOffset = calendar30d.length > 0 ? mondayIndex(calendar30d[0].date) : 0;

  return (
    <section className="card hm-card" data-testid={sectionTestId}>
      <div className="card-head">
        <span className="card-title">{title}</span>
        <div className="segmented segmented-sm" role="tablist" aria-label={title}>
          {(['24h', '7d', '30d'] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              className={`segmented-btn ${range === r ? 'is-active' : ''}`}
              onClick={() => {
                setRange(r);
                setHover('');
              }}
              data-testid={`${testIdPrefix}heatmap-range-${r}`}
            >
              {dict.heatmapRanges[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="hm-total">
        <span className="stat-big">{formatTokenShort(rangeTotal)}</span>
        <span className="stat-sub">Tokens</span>
        <span className="stat-sub mono hm-total-cost">{formatUsd(rangeCostUsd)}</span>
      </div>

      <div className="hm-kpis" data-testid={`${testIdPrefix}heatmap-kpis`}>
        {kpis.map((k) => (
          <div key={k.label} className="hm-kpi">
            <span className="hm-kpi-label">{k.label}</span>
            <strong className="hm-kpi-value mono">{k.value}</strong>
            {k.sub && <span className="hm-kpi-sub mono">{k.sub}</span>}
          </div>
        ))}
      </div>

      {range === '24h' && (
        <>
          <div className="hm-chart-with-scale">
            <div className="hm-y-scale" data-testid={`${testIdPrefix}heatmap-y-scale`}>
              <span title={`${max24Tokens.toLocaleString()} Tokens`}>{formatTokenShort(max24Tokens)}</span>
              <span title={`${Math.round(max24Tokens / 2).toLocaleString()} Tokens`}>
                {formatTokenShort(Math.round(max24Tokens / 2))}
              </span>
              <span title="0 Tokens">0</span>
            </div>
            <div className="hm-bars-stage">
              <div className="hm-grid-lines" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="hm-bars" data-testid={`${testIdPrefix}heatmap-24h-bars`} onMouseLeave={clearHover}>
                {hourly24h.map((b) => {
                  const ratio = b.totalTokens / max24Scale;
                  const tier = computeBarTier(ratio, b.totalTokens > 0);
                  return (
                    <div
                      key={b.hourKey}
                      className={`hm-bar ${b.totalTokens > 0 ? `has-data tier-${tier}` : ''}`}
                      style={{ height: `${b.totalTokens > 0 ? Math.round(ratio * 10000) / 100 : 0}%` }}
                      onMouseEnter={() =>
                        setHover(`${b.hourLabel} · ${formatTokenShort(b.totalTokens)} Tokens · ${formatUsd(b.costUsd)}`)
                      }
                      title={`${b.hourLabel}: ${formatTokenShort(b.totalTokens)} (${formatUsd(b.costUsd)})`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <div className="hm-axis hm-axis-indented">
            <span>{hourly24h[0]?.hourLabel ?? ''}</span>
            <span>{hourly24h[12]?.hourLabel ?? ''}</span>
            <span>{hourly24h[hourly24h.length - 1]?.hourLabel ?? ''}</span>
          </div>
        </>
      )}

      {range === '7d' && (
        <div className="hm-7d">
          <div className="hm-7d-ruler" aria-hidden="true">
            {HOUR_TICKS.map((h) => (
              <span key={h} style={{ '--tick': h / 24 } as React.CSSProperties}>
                {String(h).padStart(2, '0')}
              </span>
            ))}
          </div>
          <div
            className="hm-matrix"
            role="grid"
            aria-label={`${title} · 7d`}
            data-testid={`${testIdPrefix}heatmap-7d-matrix`}
            onMouseLeave={clearHover}
          >
            {rows7d.map((row, rowIndex) => (
              <div
                key={row.date}
                role="row"
                className={`hm-7d-row${row.date === today ? ' is-today' : ''}`}
              >
                <span className="hm-row-label" role="rowheader" title={dict.ui.heatmapRowCostTitle(row.date, formatUsd(row.cost))}>
                  {dayLabel(row.date)}
                </span>
                <div className="hm-7d-cells">
                  {row.cells.map((cell, cellIndex) => {
                    const index = rowIndex * 24 + cellIndex;
                    const label = describe7d(cell);
                    return (
                      <div
                        key={`${cell.date}-${cell.hour}`}
                        ref={(el) => {
                          grid7d.refs.current[index] = el;
                        }}
                        role="gridcell"
                        tabIndex={index === grid7d.active ? 0 : -1}
                        aria-label={label}
                        className={`heatmap-cell i-${cell.intensity}`}
                        onMouseEnter={() => setHover(label)}
                        onFocus={() => {
                          grid7d.setActive(index);
                          setHover(label);
                        }}
                        onKeyDown={(e) => grid7d.onKeyDown(e, index)}
                      />
                    );
                  })}
                </div>
                <span
                  className={`hm-day-pill mono${row.tokens > 0 ? ' has-data' : ''}`}
                  title={`${v034.heatmapDayTotal} · ${formatTokenShort(row.tokens)} Tokens · ${formatUsd(row.cost)}`}
                >
                  {row.tokens > 0 ? formatTokenShort(row.tokens) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {range === '30d' && (
        <div className="hm-30d">
          <div className="hm-weekdays" aria-hidden="true">
            {v034.heatmapWeekdaysShort.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div
            className="hm-calendar"
            role="grid"
            aria-label={`${title} · 30d`}
            data-testid={`${testIdPrefix}heatmap-30d-calendar`}
            onMouseLeave={clearHover}
          >
            {calendar30d.map((day, index) => {
              const d = parseLocalDate(day.date);
              const dayNum = d?.getDate() ?? 0;
              const monthStart = Boolean(d) && (dayNum === 1 || index === 0);
              const isToday = day.date === today;
              const label = describe30d(day);
              return (
                <div
                  key={day.date}
                  ref={(el) => {
                    grid30d.refs.current[index] = el;
                  }}
                  role="gridcell"
                  tabIndex={index === grid30d.active ? 0 : -1}
                  aria-label={label}
                  aria-current={isToday ? 'date' : undefined}
                  className={`heatmap-cell hm-day i-${day.intensity}${isToday ? ' is-today' : ''}${monthStart ? ' is-month-start' : ''}`}
                  style={index === 0 && firstOffset > 0 ? { gridColumnStart: firstOffset + 1 } : undefined}
                  onMouseEnter={() => setHover(label)}
                  onFocus={() => {
                    grid30d.setActive(index);
                    setHover(label);
                  }}
                  onKeyDown={(e) => grid30d.onKeyDown(e, index)}
                  title={label}
                >
                  <span className="hm-day-num">
                    {monthStart && d ? v034.heatmapMonthShort(d.getMonth() + 1) : dayNum}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="hm-foot">
        <span className="hm-hover truncate" aria-live="polite">
          {hover}
        </span>
        {!hover && <span className="hm-hint truncate">{v034.heatmapHint}</span>}
        <span className="hm-legend" aria-hidden="true">
          <span>{dict.heatmapLess}</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`hm-legend-swatch i-${i}`} />
          ))}
          <span>{dict.heatmapMore}</span>
        </span>
      </div>
    </section>
  );
}

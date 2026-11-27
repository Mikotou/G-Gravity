import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Icon } from '../ui/Icon';
import type {
  DailyCalendarHeatmapCell,
  DayHourHeatmapCell,
  HeatLevel,
  HourlyTokenBarBucket,
  TokenHeatmapRange,
} from '@shared';
import { useI18n } from '../../i18n/I18nContext';
import { formatTokenShort, formatUsd } from '../ContextStatusBar';
import { handleTablistKeyDown } from '../../hooks/useRovingTabs';
import {
  formatHourBucketLabel,
  formatTokenCompact,
  groupCalendarWeeks,
  localDateKey,
  mondayIndex,
  parseLocalDate,
  resolveDaily7d,
  resolveHourlyLevels,
  sumTokens,
} from '../../lib/heatmap';

/**
 * v0.3.5：主 Context & Cost 看板与外部复核 / 翻译看板共用的 Token 热力图（三账本同一体验）。
 *
 * - 唯一强度来源为共享层 `computeHeatLevel`：24h 消费后端 `intensity`（缺省回退计算），7d 消费 `daily7d`
 *   （旧快照缺省时从 `calendar30d.slice(-7)` 以 7 日窗口重算），30d 消费 `calendar30d.intensity`；
 * - `.hm-card` 自身为 `container: hm / inline-size`，按 Windows 280px 最小检视器扣滚动条后 219px 净宽设三档：
 *   `<300px` 紧凑 / `300–439px` 常规 / `>=440px` 宽松；
 * - 24h / 7d：柱图共用同款左侧 Token 用量 Y 轴刻度与虚线网格，按强度着色并为低柱加封顶；30d：周一至周日对齐的 Codex 周行方格；
 * - 悬停只更新可见读数，不触发读屏播报；键盘聚焦时才经独立 `aria-live` 区域播报。
 *
 * 关键 testid（`${prefix}heatmap-*`）与 `.heatmap-cell` / `.hm-bar` / `.hm-hover` / `.hm-y-scale` 类名保持不变。
 */
export interface TokenHeatmapViewProps {
  /** testid 前缀：主看板为 ''，外部服务为 'reviewer-' / 'translator-' */
  testIdPrefix: string;
  sectionTestId: string;
  title: string;
  hourly24h: readonly HourlyTokenBarBucket[];
  /** v0.3.5 按日 7d 序列；旧快照缺省时由 calendar30d 末 7 天回退 */
  daily7d?: readonly DailyCalendarHeatmapCell[];
  /** @deprecated v0.3.5 起 7d 不再渲染小时格，仅为旧调用方保留 */
  matrix7d?: readonly DayHourHeatmapCell[];
  calendar30d: readonly DailyCalendarHeatmapCell[];
  /** I2：主 Context 页可折叠；外部服务看板不传则不显示折叠按钮 */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** 24h 柱图基准高度（px），用于判断低柱封顶线粗细 */
const BAR_STAGE_PX = 84;

interface Kpi {
  label: string;
  value: string;
  sub?: string;
}

/** 网格内的漫游焦点（roving tabindex）：方向键移动，Home/End 跳到行首/行尾，只有一个 Tab 停靠点。 */
function useRovingGrid(count: number, columns: number, onFocusIndex: (index: number) => void, rowOffset = 0) {
  const [active, setActiveState] = useState(Math.max(0, count - 1));
  const userSelectedRef = useRef(false);
  const prevCountRef = useRef(count);
  const refs = useRef<Array<HTMLElement | null>>([]);
  // FE-BUG-09：空数据先挂载、后异步到达时，若用户尚未手动选择，自动定位到最新一格（count - 1）
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = count;
    if (count > 0 && !userSelectedRef.current && (prev === 0 || active >= count)) {
      setActiveState(count - 1);
    }
  }, [active, count]);
  const setActive = useCallback((index: number) => {
    userSelectedRef.current = true;
    setActiveState(index);
  }, []);
  const move = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(count - 1, next));
      userSelectedRef.current = true;
      setActiveState(clamped);
      refs.current[clamped]?.focus();
      onFocusIndex(clamped);
    },
    [count, onFocusIndex]
  );
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      let next: number | null = null;
      const col = (index + rowOffset) % columns;
      if (e.key === 'ArrowRight') next = index + 1;
      else if (e.key === 'ArrowLeft') next = index - 1;
      else if (e.key === 'ArrowDown') next = index + columns;
      else if (e.key === 'ArrowUp') next = index - columns;
      else if (e.key === 'Home') next = index - col;
      else if (e.key === 'End') next = index - col + columns - 1;
      if (next === null) return;
      e.preventDefault();
      move(next);
    },
    [columns, move, rowOffset]
  );
  return { active: Math.min(active, Math.max(0, count - 1)), refs, onKeyDown, setActive };
}

export function TokenHeatmapView({
  testIdPrefix,
  sectionTestId,
  title,
  hourly24h,
  daily7d,
  calendar30d,
  collapsed = false,
  onToggleCollapsed,
}: TokenHeatmapViewProps): React.ReactElement {
  const { dict } = useI18n();
  const v034 = dict.ui.v034;
  const v035 = dict.ui.v035;
  const uid = useId();
  const [range, setRange] = useState<TokenHeatmapRange>('24h');
  /** 可见读数（悬停 + 聚焦） */
  const [hover, setHover] = useState('');
  /** 仅键盘聚焦时写入的读屏播报 */
  const [live, setLive] = useState('');
  const clearHover = useCallback(() => setHover(''), []);
  const today = localDateKey();

  const max24Tokens = Math.max(0, ...hourly24h.map((b) => b.totalTokens));
  const max24Scale = Math.max(1, max24Tokens);
  const hourlyLevels = useMemo(() => resolveHourlyLevels(hourly24h), [hourly24h]);
  const days7 = useMemo(() => resolveDaily7d(daily7d, calendar30d), [daily7d, calendar30d]);
  const max7Tokens = Math.max(0, ...days7.map((d) => d.totalTokens));
  const max7Scale = Math.max(1, max7Tokens);
  const weeks = useMemo(() => groupCalendarWeeks(calendar30d), [calendar30d]);

  /** 日卡星期：取本地化日标签的星期部分（中文「周一」、英文「Mon」） */
  const weekdayOf = useCallback(
    (date: string) => {
      const d = parseLocalDate(date);
      if (!d) return '';
      return v034.heatmapDayLabel(v034.heatmapWeekdaysShort[(d.getDay() + 6) % 7], d.getMonth() + 1, d.getDate()).split(' ')[0];
    },
    [v034]
  );
  const dayLabel = useCallback(
    (date: string) => {
      const d = parseLocalDate(date);
      if (!d) return date;
      return v034.heatmapDayLabel(v034.heatmapWeekdaysShort[(d.getDay() + 6) % 7], d.getMonth() + 1, d.getDate());
    },
    [v034]
  );
  const shortDate = (date: string) => {
    const d = parseLocalDate(date);
    return d ? `${d.getMonth() + 1}/${d.getDate()}` : date;
  };

  const rangeCells: ReadonlyArray<{ totalTokens: number; costUsd: number }> =
    range === '24h' ? hourly24h : range === '7d' ? days7 : calendar30d;
  const rangeTotal = sumTokens(rangeCells);
  const rangeCostUsd = rangeCells.reduce((acc, b) => acc + (Number.isFinite(b.costUsd) ? b.costUsd : 0), 0);

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
    const days = (range === '7d' ? days7 : calendar30d).map((d) => ({ date: d.date, tokens: d.totalTokens }));
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
  }, [calendar30d, dayLabel, days7, hourly24h, range, rangeTotal, v034]);

  /* ---------------------------------------------------------------- 24h 柱图 */
  const describe24h = useCallback(
    (b: HourlyTokenBarBucket) =>
      v035.heatmapHourBar(formatHourBucketLabel(b), formatTokenShort(b.totalTokens), formatUsd(b.costUsd)),
    [v035]
  );
  const grid24h = useRovingGrid(hourly24h.length, Math.max(1, hourly24h.length), (i) => {
    if (!hourly24h[i]) return;
    const text = describe24h(hourly24h[i]);
    setHover(text);
    setLive(text);
  });

  /* ---------------------------------------------------------------- 7d 柱图 */
  const describe7d = useCallback(
    (day: DailyCalendarHeatmapCell) =>
      v035.heatmapDayCard(dayLabel(day.date), formatTokenShort(day.totalTokens), formatUsd(day.costUsd)),
    [dayLabel, v035]
  );
  const grid7d = useRovingGrid(days7.length, 7, (i) => {
    if (!days7[i]) return;
    const text = describe7d(days7[i]);
    setHover(text);
    setLive(text);
  });

  /* ---------------------------------------------------------------- 30d 周行 */
  const describe30d = useCallback(
    (day: DailyCalendarHeatmapCell) =>
      `${day.date} · ${formatTokenShort(day.totalTokens)} Tokens · ${v034.heatmapThreads(day.sessionCount)} · ${formatUsd(day.costUsd)}`,
    [v034]
  );
  const firstOffset = calendar30d.length > 0 ? weeks[0]?.slots.findIndex((s) => s !== null) ?? 0 : 0;
  const grid30d = useRovingGrid(
    calendar30d.length,
    7,
    (i) => {
      if (!calendar30d[i]) return;
      const text = describe30d(calendar30d[i]);
      setHover(text);
      setLive(text);
    },
    Math.max(0, firstOffset)
  );

  const tabId = (r: TokenHeatmapRange) => `${uid}-tab-${r}`;
  const panelId = `${uid}-panel`;
  const focusAnnounce = (text: string) => {
    setHover(text);
    setLive(text);
  };

  return (
    <section className="card hm-card" data-testid={sectionTestId} data-range={range}>
      <div className="card-head">
        <span className="card-title">{title}</span>
        <div
          className="segmented segmented-sm"
          role="tablist"
          aria-label={title}
          onKeyDown={(e) => handleTablistKeyDown(e)}
        >
          {(['24h', '7d', '30d'] as const).map((r) => (
            <button
              key={r}
              id={tabId(r)}
              type="button"
              role="tab"
              aria-selected={range === r}
              aria-controls={panelId}
              tabIndex={range === r ? 0 : -1}
              className={`segmented-btn ${range === r ? 'is-active' : ''}`}
              onClick={() => {
                setRange(r);
                setHover('');
                setLive('');
              }}
              data-testid={`${testIdPrefix}heatmap-range-${r}`}
            >
              {dict.heatmapRanges[r]}
            </button>
          ))}
        </div>
        {onToggleCollapsed && (
          <button
            type="button"
            className={`icon-btn icon-btn-sm ctx-section-toggle${collapsed ? ' is-collapsed' : ''}`}
            aria-expanded={!collapsed}
            aria-controls={`${uid}-body`}
            aria-label={collapsed ? v035.sectionExpand(title) : v035.sectionCollapse(title)}
            title={collapsed ? v035.sectionExpand(title) : v035.sectionCollapse(title)}
            onClick={onToggleCollapsed}
            data-testid={`${testIdPrefix}heatmap-section-toggle`}
          >
            <Icon icon={ChevronDown} size="xs" />
          </button>
        )}
      </div>

      <div className="hm-body" id={`${uid}-body`} hidden={collapsed}>
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

      <div
        className="hm-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(range)}
        data-testid={`${testIdPrefix}heatmap-panel`}
      >
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
              <div
                className="hm-bars-stage"
                role="grid"
                aria-label={v035.heatmapRangePanel(title, dict.heatmapRanges['24h'])}
              >
                <div className="hm-grid-lines" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="hm-bars" role="row" data-testid={`${testIdPrefix}heatmap-24h-bars`} onMouseLeave={clearHover}>
                  {hourly24h.map((b, i) => {
                    const ratio = b.totalTokens / max24Scale;
                    const hasData = b.totalTokens > 0;
                    const level: HeatLevel = hasData ? (hourlyLevels[i] || 1) as HeatLevel : 0;
                    const capped = hasData && level <= 2;
                    const capPx = ratio * BAR_STAGE_PX < 12 ? 1 : 2;
                    const text = describe24h(b);
                    return (
                      <div
                        key={b.startIso || `${b.hourKey}-${i}`}
                        ref={(el) => {
                          grid24h.refs.current[i] = el;
                        }}
                        role="gridcell"
                        tabIndex={i === grid24h.active ? 0 : -1}
                        aria-label={`${text} · ${v035.heatmapLevel(level)}`}
                        className={`hm-bar ${hasData ? `has-data tier-${level}` : ''}${capped ? ' has-cap' : ''}`}
                        data-level={level}
                        data-cap={capped ? capPx : undefined}
                        style={{ height: `${hasData ? Math.round(ratio * 10000) / 100 : 0}%` }}
                        onMouseEnter={() => setHover(text)}
                        onFocus={() => {
                          grid24h.setActive(i);
                          focusAnnounce(text);
                        }}
                        onKeyDown={(e) => grid24h.onKeyDown(e, i)}
                        title={text}
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
            <div className="hm-chart-with-scale">
              <div className="hm-y-scale" data-testid={`${testIdPrefix}heatmap-y-scale`}>
                <span title={`${max7Tokens.toLocaleString()} Tokens`}>{formatTokenShort(max7Tokens)}</span>
                <span title={`${Math.round(max7Tokens / 2).toLocaleString()} Tokens`}>
                  {formatTokenShort(Math.round(max7Tokens / 2))}
                </span>
                <span title="0 Tokens">0</span>
              </div>
              <div
                className="hm-bars-stage"
                role="grid"
                aria-label={v035.heatmapRangePanel(title, dict.heatmapRanges['7d'])}
                data-testid={`${testIdPrefix}heatmap-7d-matrix`}
              >
                <div className="hm-grid-lines" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="hm-bars hm-bars-7d" role="row" onMouseLeave={clearHover}>
                  {days7.map((day, index) => {
                    const ratio = day.totalTokens / max7Scale;
                    const hasData = day.totalTokens > 0;
                    const level: HeatLevel = day.intensity;
                    const barTier: HeatLevel = hasData ? ((level || 1) as HeatLevel) : 0;
                    const capped = hasData && barTier <= 2;
                    const capPx = ratio * BAR_STAGE_PX < 12 ? 1 : 2;
                    const isToday = day.date === today;
                    const label = describe7d(day);
                    return (
                      <div
                        key={day.date}
                        ref={(el) => {
                          grid7d.refs.current[index] = el;
                        }}
                        role="gridcell"
                        tabIndex={index === grid7d.active ? 0 : -1}
                        aria-label={`${label} · ${v035.heatmapLevel(level)}`}
                        aria-current={isToday ? 'date' : undefined}
                        className={`heatmap-cell hm-7d-col i-${level}${isToday ? ' is-today' : ''}`}
                        data-level={level}
                        data-testid={`${testIdPrefix}heatmap-7d-day-${day.date}`}
                        onMouseEnter={() => setHover(label)}
                        onFocus={() => {
                          grid7d.setActive(index);
                          focusAnnounce(label);
                        }}
                        onKeyDown={(e) => grid7d.onKeyDown(e, index)}
                        title={label}
                      >
                        <span
                          className={`hm-bar hm-bar-7d${hasData ? ` has-data tier-${barTier}` : ' is-empty'}${capped ? ' has-cap' : ''}`}
                          data-level={barTier}
                          data-cap={capped ? capPx : undefined}
                          style={hasData ? { height: `${Math.round(ratio * 10000) / 100}%` } : undefined}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="hm-7d-axis" aria-hidden="true">
              {days7.map((day) => {
                const isToday = day.date === today;
                return (
                  <span key={day.date} className={`hm-7d-axis-item${isToday ? ' is-today' : ''}`}>
                    <span className="hm-7d-axis-short">{v034.heatmapWeekdaysShort[mondayIndex(day.date)]}</span>
                    <span className="hm-7d-axis-wd">{weekdayOf(day.date)}</span>
                    <span className="hm-7d-axis-date mono">{shortDate(day.date)}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {range === '30d' && (
          <div className="hm-30d">
            <div className="hm-week hm-week-head" aria-hidden="true">
              <span className="hm-week-label" />
              {v034.heatmapWeekdaysShort.map((w) => (
                <span key={w} className="hm-weekday">
                  {w}
                </span>
              ))}
              <span className="hm-week-total">{v035.heatmapWeekTotal}</span>
            </div>
            <div
              className="hm-calendar"
              role="grid"
              aria-label={v035.heatmapRangePanel(title, dict.heatmapRanges['30d'])}
              data-testid={`${testIdPrefix}heatmap-30d-calendar`}
              onMouseLeave={clearHover}
            >
              {weeks.map((week) => (
                <div key={week.key} className="hm-week" role="row">
                  <span className="hm-week-label mono" role="rowheader" title={v035.heatmapWeekOf(week.firstDate)}>
                    {shortDate(week.firstDate)}
                  </span>
                  {week.slots.map((slot, col) => {
                    if (!slot) return <span key={`blank-${col}`} className="hm-day-blank" aria-hidden="true" />;
                    const { day, index } = slot;
                    const d = parseLocalDate(day.date);
                    const dayNum = d?.getDate() ?? 0;
                    const monthStart = Boolean(d) && dayNum === 1;
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
                        aria-label={`${label} · ${v035.heatmapLevel(day.intensity)}`}
                        aria-current={isToday ? 'date' : undefined}
                        className={`heatmap-cell hm-day i-${day.intensity}${isToday ? ' is-today' : ''}${monthStart ? ' is-month-start' : ''}`}
                        onMouseEnter={() => setHover(label)}
                        onFocus={() => {
                          grid30d.setActive(index);
                          focusAnnounce(label);
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
                  <span
                    className="hm-week-total mono"
                    title={`${v035.heatmapWeekOf(week.firstDate)} · ${formatTokenShort(week.totalTokens)} Tokens · ${formatUsd(week.costUsd)}`}
                  >
                    {week.totalTokens > 0 ? formatTokenCompact(week.totalTokens) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="hm-foot">
        <span className="hm-hover truncate">{hover}</span>
        {!hover && <span className="hm-hint truncate">{v034.heatmapHint}</span>}
      </div>
      <div className="hm-legend-row" title={v035.heatmapLegendDetail}>
        <span className="hm-legend-caption">{v035.heatmapLegendCaption}</span>
        <span className="hm-legend" aria-hidden="true">
          <span>{dict.heatmapLess}</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`hm-legend-swatch i-${i}`} />
          ))}
          <span>{dict.heatmapMore}</span>
        </span>
      </div>
      </div>
      <span className="sr-only" aria-live="polite" data-testid={`${testIdPrefix}heatmap-live`}>
        {live}
      </span>
    </section>
  );
}

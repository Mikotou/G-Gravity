import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Info, Minimize2, Paperclip, Settings2 } from 'lucide-react';
import {
  COST_DISCLAIMER,
  resolveModelCompactionLimit,
  type CostTimeScope,
  type ModelCostBreakdownItem,
  type SessionContextTelemetry,
  type TelemetryDashboardSnapshot,
  type TokenCostSummary,
  type TokenHeatmapRange,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatTokenShort, formatUsd } from './ContextStatusBar';

export interface ContextCostInspectorViewProps {
  sessionId: string | null;
  dashboard: TelemetryDashboardSnapshot;
  onOpenRateCardsSettings: () => void;
}

const ZERO: TokenCostSummary = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  totalTokens: 0,
  inputCostUsd: 0,
  cachedInputCostUsd: 0,
  outputCostUsd: 0,
  thinkingCostUsd: 0,
  totalCostUsd: 0,
};

const DIM_COLORS = {
  input: 'var(--accent-primary)',
  cached: '#38bdf8',
  output: 'var(--syntax-function)',
  thinking: 'var(--syntax-string)',
};

const MODEL_COLORS = [
  'var(--accent-primary)',
  'var(--syntax-function)',
  'var(--syntax-string)',
  '#38bdf8',
  'var(--status-warning)',
  'var(--text-secondary)',
];

/**
 * 直观表示当前 Context 占压缩窗口比例的小圆环指示器。
 */
function ContextUsageMiniRing({
  ratio,
  level,
}: {
  ratio: number;
  level: SessionContextTelemetry['pressureLevel'];
}): React.ReactElement {
  const clamped = Math.min(1, Math.max(0, ratio));
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const dash = clamped * c;
  const strokeColor =
    level === 'critical'
      ? 'var(--status-danger)'
      : level === 'warning'
        ? 'var(--status-warning)'
        : level === 'moderate'
          ? 'var(--accent-primary)'
          : 'var(--status-success)';

  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className="ctx-mini-ring"
      aria-hidden="true"
      data-testid="context-usage-mini-ring"
    >
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        strokeWidth="2.4"
        style={{ stroke: 'var(--bg-code)' }}
      />
      {clamped > 0 && (
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(1.2, dash)} ${c}`}
          transform="rotate(-90 9 9)"
          style={{ stroke: strokeColor, transition: 'stroke-dasharray 0.3s ease, stroke 0.25s ease' }}
        />
      )}
    </svg>
  );
}

function Donut({ items }: { items: ModelCostBreakdownItem[] }): React.ReactElement {
  const r = 34;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width="92" height="92" viewBox="0 0 92 92" data-testid="cost-donut-svg" style={{ flexShrink: 0 }}>
      <circle cx="46" cy="46" r={r} fill="none" strokeWidth="11" style={{ stroke: 'var(--bg-code)' }} />
      {items.map((m, idx) => {
        const len = Math.max(0, m.shareRatio) * c;
        const el = (
          <circle
            key={m.modelId}
            cx="46"
            cy="46"
            r={r}
            fill="none"
            strokeWidth="11"
            strokeDasharray={`${len} ${c}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 46 46)"
            style={{ stroke: MODEL_COLORS[idx % MODEL_COLORS.length] }}
          />
        );
        offset += len;
        return el;
      })}
      <text x="46" y="50" textAnchor="middle" className="donut-center">
        {items.length}
      </text>
    </svg>
  );
}

function computeBarTier(ratio: number, hasData: boolean): 0 | 1 | 2 | 3 | 4 {
  if (!hasData || ratio <= 0) return 0;
  if (ratio < 0.22) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.8) return 3;
  return 4;
}

export function ContextCostInspectorView({
  sessionId,
  dashboard,
  onOpenRateCardsSettings,
}: ContextCostInspectorViewProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [range, setRange] = useState<TokenHeatmapRange>('24h');
  const [scope, setScope] = useState<CostTimeScope>(sessionId ? 'session' : 'today');
  const [hover, setHover] = useState('');

  useEffect(() => {
    if (sessionId) {
      setScope('session');
    }
  }, [sessionId]);

  // 选中会话但首份用量尚未到达时，用零值绘制该会话的看板，防止短暂显示上一个会话的数字。
  const tele: SessionContextTelemetry | undefined = useMemo(() => {
    if (!sessionId) return undefined;
    return (
      dashboard.activeSessions[sessionId] ?? {
        sessionId,
        modelId: '',
        maxContextTokens: resolveModelCompactionLimit(''),
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
        compactions: [],
        currentTokensPerSecond: 0,
        averageTokensPerSecond: 0,
        peakTokensPerSecond: 0,
        averageCacheHitRate: 0,
        costSummary: ZERO,
        usageSource: 'estimated',
        pricingSource: dashboard.pricingSource,
        updatedAt: dashboard.generatedAt,
      }
    );
  }, [dashboard.activeSessions, dashboard.generatedAt, dashboard.pricingSource, sessionId]);

  // 切换范围时，费用合计和分模型数据必须一起切换。会话范围用当前 ID，时间范围用跨会话汇总。
  const cost: TokenCostSummary =
    scope === 'session' ? tele?.costSummary ?? ZERO : dashboard.costByRange[scope] ?? ZERO;
  const rawModels: ModelCostBreakdownItem[] =
    scope === 'session'
      ? (sessionId ? dashboard.sessionModelBreakdowns[sessionId] : undefined) ?? []
      : dashboard.modelBreakdownByRange[scope] ?? [];
  const models = useMemo(
    () => [...rawModels].sort((a, b) => b.totalCostUsd - a.totalCostUsd),
    [rawModels]
  );

  // 把一维小时格按日期分组，每行对应一天，保留快照中格子的小时顺序。
  const rows7d = useMemo(() => {
    const map = new Map<string, typeof dashboard.matrix7d>();
    for (const cell of dashboard.matrix7d) {
      const list = map.get(cell.date) ?? [];
      list.push(cell);
      map.set(cell.date, list);
    }
    return Array.from(map.entries());
  }, [dashboard.matrix7d]);

  const max24Tokens = Math.max(0, ...dashboard.hourly24h.map((b) => b.totalTokens));
  const max24Scale = Math.max(1, max24Tokens);
  const max24CostUsd = Math.max(0, ...dashboard.hourly24h.map((b) => b.costUsd));
  const max7dRowCost = useMemo(() => {
    let m = 0;
    for (const [, cells] of rows7d) {
      const sum = cells.reduce((acc, c) => acc + c.costUsd, 0);
      if (sum > m) m = sum;
    }
    return m;
  }, [rows7d]);

  const rangeTotal =
    range === '24h'
      ? dashboard.hourly24h.reduce((acc, b) => acc + b.totalTokens, 0)
      : range === '7d'
        ? dashboard.matrix7d.reduce((acc, b) => acc + b.totalTokens, 0)
        : dashboard.calendar30d.reduce((acc, b) => acc + b.totalTokens, 0);

  const rangeCostUsd =
    range === '24h'
      ? dashboard.hourly24h.reduce((acc, b) => acc + b.costUsd, 0)
      : range === '7d'
        ? dashboard.matrix7d.reduce((acc, b) => acc + b.costUsd, 0)
        : dashboard.calendar30d.reduce((acc, b) => acc + b.costUsd, 0);

  // Context 细分按占比从大到小排列（越多越靠左），总填充宽度严格映射已用压缩窗口比例，右侧保留未使用背景色
  const breakdown = useMemo(() => {
    if (!tele) return [];
    const items = [
      { label: dict.breakdownSystem, val: tele.breakdown.systemAndRulesTokens, c: '#94a3b8' },
      { label: dict.breakdownUser, val: tele.breakdown.userMessagesTokens, c: 'var(--syntax-function)' },
      { label: dict.breakdownAssistant, val: tele.breakdown.agentMessagesTokens, c: 'var(--accent-primary)' },
      { label: dict.breakdownThought, val: tele.breakdown.thoughtTokens, c: 'var(--syntax-string)' },
      { label: dict.breakdownTools, val: tele.breakdown.toolCallsTokens, c: '#38bdf8' },
      { label: dict.breakdownAttachments, val: tele.breakdown.attachmentsTokens, c: 'var(--status-warning)' },
    ];
    return items.sort((a, b) => b.val - a.val);
  }, [dict, tele]);

  // 组成比例按各分类之和计算，窗口占用按当前用量与上限计算。
  // 两处分母不同，使估算分类也可以配合上报的总量显示。
  const breakdownSum = Math.max(1, breakdown.reduce((acc, b) => acc + b.val, 0));
  const usedWindowRatio = tele
    ? Math.min(1, Math.max(0, tele.usedContextTokens / Math.max(1, tele.maxContextTokens)))
    : 0;
  // 若有实际占用但极小（如 0.3%），保证至少 1.5% 可见色条，其余全部展示未使用的轨道背景色
  const effectiveFillPct =
    tele && tele.usedContextTokens > 0 ? Math.min(100, Math.max(1.5, usedWindowRatio * 100)) : 0;
  const pct = Math.min(100, Math.max(0, (tele?.usageRatio ?? usedWindowRatio) * 100));

  // Cost 维度同样按金额从多到少排列（越多越靠左），右侧留出未使用参考预算背景色
  const sortedDims = useMemo(() => {
    const raw = [
      { key: 'input', label: dict.costDimInput, usd: cost.inputCostUsd, tokens: cost.inputTokens, c: DIM_COLORS.input },
      { key: 'cached', label: dict.costDimCached, usd: cost.cachedInputCostUsd, tokens: cost.cachedInputTokens, c: DIM_COLORS.cached },
      { key: 'output', label: dict.costDimOutput, usd: cost.outputCostUsd, tokens: cost.outputTokens, c: DIM_COLORS.output },
      { key: 'thinking', label: dict.costDimThinking, usd: cost.thinkingCostUsd, tokens: cost.thinkingTokens, c: DIM_COLORS.thinking },
    ];
    return raw.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  }, [cost, dict]);

  // Cost 参考刻度上限：低于 $0.10 时以 $0.10 为底尺，超出时自适应留出右侧余量背景，直观反映已用占比
  const costBarReferenceCap = Math.max(0.1, cost.totalCostUsd * 1.25);
  const modelBarReferenceCap = Math.max(
    0.05,
    cost.totalCostUsd > 0 ? cost.totalCostUsd * 1.15 : Math.max(0.05, ...models.map((m) => m.totalCostUsd * 1.25))
  );

  const avgTps = tele ? (tele.averageTokensPerSecond ?? tele.currentTokensPerSecond) : 0;
  const sessionPromptInputTotal = tele
    ? tele.costSummary.inputTokens + tele.costSummary.cachedInputTokens
    : 0;
  const cacheHitRate = tele
    ? (tele.averageCacheHitRate !== undefined
        ? tele.averageCacheHitRate
        : sessionPromptInputTotal > 0
          ? tele.costSummary.cachedInputTokens / sessionPromptInputTotal
          : 0)
    : 0;
  const cacheHitPct = Math.min(100, Math.max(0, cacheHitRate * 100));

  return (
    <div className="inspector-stack" data-testid="context-cost-inspector">
      {/* Context 窗口 */}
      <section className="card">
        <div className="card-head">
          <span className="card-title">{dict.contextWindowTitle}</span>
        </div>
        {tele ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }} title={dict.usageSources[tele.usageSource]}>
              <span className="stat-big">{formatTokenShort(tele.usedContextTokens)}</span>
              <span className="stat-sub">
                / {formatTokenShort(tele.maxContextTokens)} · {pct.toFixed(1)}%
              </span>
              <ContextUsageMiniRing ratio={pct / 100} level={tele.pressureLevel} />
            </div>
            <div className="ctx-session-metrics" data-testid="context-session-metrics">
              <div className="ctx-metric-tile" data-testid="context-avg-tps">
                <span className="ctx-metric-label">{dict.ui.sessionAvgTpsLabel}</span>
                <strong className="ctx-metric-val mono">{avgTps.toFixed(1)} tok/s</strong>
              </div>
              <div className="ctx-metric-tile" data-testid="context-cache-hit-rate">
                <span className="ctx-metric-label">
                  <span className="ctx-metric-dot" style={{ background: DIM_COLORS.cached }} />
                  {dict.ui.sessionCacheHitLabel}
                </span>
                <strong className="ctx-metric-val mono">{cacheHitPct.toFixed(1)}%</strong>
              </div>
            </div>
            <div className="stack-bar stack-bar-unused-bg" data-testid="context-sorted-stack-bar">
              {breakdown
                .filter((b) => b.val > 0)
                .map((b) => (
                  <span
                    key={b.label}
                    data-segment-label={b.label}
                    style={{
                      width: `${(b.val / breakdownSum) * effectiveFillPct}%`,
                      background: b.c,
                    }}
                    title={`${b.label}: ${formatTokenShort(b.val)}`}
                  />
                ))}
            </div>
            <div className="legend">
              {breakdown.map((b) => (
                <div key={b.label} className="legend-item">
                  <span className="legend-swatch" style={{ background: b.c }} />
                  <span className="legend-label truncate">{b.label}</span>
                  <span className="legend-val">{formatTokenShort(b.val)}</span>
                </div>
              ))}
            </div>
            {tele.attachments.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="sub-head">
                  <Paperclip size={11} />
                  <span>{dict.attachmentAuditTitle}</span>
                </div>
                {tele.attachments.map((att) => (
                  <div key={att.id} className="legend-item" style={{ fontSize: 11.5 }}>
                    <span className="legend-label truncate mono">{att.name}</span>
                    <span className="legend-val">{formatTokenShort(att.estimatedTokens)}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }} data-testid="compaction-monitor-section">
              <div className="sub-head">
                <Minimize2 size={11} />
                <span>{dict.compactionMonitorTitle}</span>
                <span className="badge badge-mono" style={{ marginLeft: 'auto', textTransform: 'none' }}>
                  {dict.compactionCountBadge(tele.compactions?.length ?? 0)}
                </span>
              </div>
              {!tele.compactions || tele.compactions.length === 0 ? (
                <div className="stat-sub" style={{ fontSize: 11.5 }}>
                  {dict.compactionEmpty}
                </div>
              ) : (
                [...tele.compactions].reverse().map((comp) => (
                  <div
                    key={comp.id}
                    className="legend-item"
                    style={{ fontSize: 11.5, gap: 6 }}
                    data-testid={`compaction-record-${comp.id}`}
                  >
                    <span className="legend-label mono">
                      {dict.compactionBeforeLabel} <strong>{formatTokenShort(comp.beforeTokens)}</strong>
                    </span>
                    <ArrowRight size={10} className="muted" />
                    <span className="mono">{formatTokenShort(comp.afterTokens)}</span>
                    {comp.savedTokens > 0 && (
                      <span className="badge badge-success badge-mono">-{formatTokenShort(comp.savedTokens)}</span>
                    )}
                    <span className="legend-val muted" style={{ fontSize: 11 }}>
                      {comp.trigger === 'manual' ? dict.compactionManualLabel : dict.compactionAutoLabel}
                      {comp.timestamp ? ` · ${comp.timestamp.slice(11, 16)}` : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="stat-sub">{dict.contextEmpty}</div>
        )}
      </section>

      {/* Token 热力图（带左侧花费与用量刻度条 + 高辨识度五档色彩梯度） */}
      <section className="card" data-testid="token-heatmap-section">
        <div className="card-head">
          <span className="card-title">{dict.heatmapSectionTitle}</span>
          <div className="segmented segmented-sm">
            {(['24h', '7d', '30d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={`segmented-btn ${range === r ? 'is-active' : ''}`}
                onClick={() => setRange(r)}
                data-testid={`heatmap-range-${r}`}
              >
                {dict.heatmapRanges[r]}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="stat-big" style={{ fontSize: 17 }}>{formatTokenShort(rangeTotal)}</span>
          <span className="stat-sub">Tokens</span>
          <span className="stat-sub mono" style={{ marginLeft: 'auto' }}>
            {formatUsd(rangeCostUsd)}
          </span>
        </div>

        {range === '24h' && (
          <>
            <div className="hm-chart-with-scale">
              <div className="hm-y-scale" data-testid="heatmap-y-scale">
                <span title="峰值小时花费 / 用量">
                  {max24CostUsd > 0 ? formatUsd(max24CostUsd) : formatTokenShort(max24Tokens)}
                </span>
                <span>
                  {max24CostUsd > 0 ? formatUsd(max24CostUsd / 2) : formatTokenShort(Math.round(max24Tokens / 2))}
                </span>
                <span>{max24CostUsd > 0 ? '$0' : '0'}</span>
              </div>
              <div className="hm-bars-stage">
                <div className="hm-grid-lines" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="hm-bars" data-testid="heatmap-24h-bars">
                  {dashboard.hourly24h.map((b) => {
                    const ratio = b.totalTokens / max24Scale;
                    const tier = computeBarTier(ratio, b.totalTokens > 0);
                    return (
                      <div
                        key={b.hourKey}
                        className={`hm-bar ${b.totalTokens > 0 ? `has-data tier-${tier}` : ''}`}
                        style={{ height: `${b.totalTokens > 0 ? Math.max(8, Math.round(ratio * 100)) : 4}%` }}
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
              <span>{dashboard.hourly24h[0]?.hourLabel ?? ''}</span>
              <span>{dashboard.hourly24h[12]?.hourLabel ?? ''}</span>
              <span>{dashboard.hourly24h[dashboard.hourly24h.length - 1]?.hourLabel ?? ''}</span>
            </div>
          </>
        )}

        {range === '7d' && (
          <div className="hm-matrix" data-testid="heatmap-7d-matrix">
            {rows7d.map(([date, cells]) => {
              const rowCost = cells.reduce((acc, c) => acc + c.costUsd, 0);
              return (
                <div key={date} className="heatmap-7d-matrix heatmap-7d-with-cost">
                  <span className="hm-row-label" title={`${date} 合计花费 ${formatUsd(rowCost)}`}>
                    <span>{date.slice(5)}</span>
                    <em className="hm-row-cost">{rowCost > 0 ? formatUsd(rowCost) : max7dRowCost > 0 ? '$0' : ''}</em>
                  </span>
                  {cells.map((cell) => (
                    <div
                      key={`${cell.date}-${cell.hour}`}
                      className={`heatmap-cell i-${cell.intensity}`}
                      onMouseEnter={() =>
                        setHover(
                          `${cell.date} ${String(cell.hour).padStart(2, '0')}:00 · ${formatTokenShort(cell.totalTokens)} · ${formatUsd(cell.costUsd)}`
                        )
                      }
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {range === '30d' && (
          <div className="hm-30d-with-scale">
            <div className="hm-y-scale hm-y-scale-compact">
              <span>{formatUsd(Math.max(0, ...dashboard.calendar30d.map((d) => d.costUsd)))}</span>
              <span>$0</span>
            </div>
            <div className="hm-calendar" data-testid="heatmap-30d-calendar" style={{ flex: 1 }}>
              {dashboard.calendar30d.map((day) => (
                <div
                  key={day.date}
                  className={`heatmap-cell i-${day.intensity}`}
                  onMouseEnter={() =>
                    setHover(
                      `${day.date} · ${formatTokenShort(day.totalTokens)} Tokens · ${day.sessionCount} threads · ${formatUsd(day.costUsd)}`
                    )
                  }
                  title={`${day.date}: ${formatUsd(day.costUsd)}`}
                />
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="hm-hover truncate">{hover}</span>
          <span className="spacer" />
          <span className="hm-legend">
            <span>{dict.heatmapLess}</span>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={`heatmap-cell i-${i}`} />
            ))}
            <span>{dict.heatmapMore}</span>
          </span>
        </div>
      </section>

      {/* Cost */}
      <section className="card" data-testid="cost-breakdown-section">
        <div className="card-head">
          <span className="card-title">{dict.costSectionTitle}</span>
          <div className="segmented segmented-sm">
            {(['session', 'today', '7d', '30d'] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                className={`segmented-btn ${scope === sc ? 'is-active' : ''}`}
                onClick={() => setScope(sc)}
                data-testid={`cost-scope-${sc}`}
              >
                {dict.costScopes[sc]}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="stat-big" style={{ color: 'var(--accent-primary)' }} data-testid="cost-total-usd">
            {formatUsd(cost.totalCostUsd)}
          </span>
          <span className="stat-sub">{formatTokenShort(cost.totalTokens)} Tokens</span>
        </div>

        {/* Cost 总体构成进度条：按占比从大到小靠左排列，未使用部分展示背景轨道色 */}
        <div className="stack-bar stack-bar-unused-bg" data-testid="cost-sorted-stack-bar">
          {sortedDims
            .filter((d) => d.usd > 0)
            .map((d) => (
              <span
                key={d.key}
                data-cost-dim={d.key}
                style={{
                  width: `${Math.min(100, (d.usd / costBarReferenceCap) * 100)}%`,
                  background: d.c,
                }}
                title={`${d.label}: ${formatUsd(d.usd)}`}
              />
            ))}
        </div>

        <div className="cost-grid">
          {sortedDims.map((d) => (
            <div key={d.key} className="cost-cell" title={`${formatTokenShort(d.tokens)} Tokens`}>
              <span className="cost-cell-label">
                <span className="legend-swatch" style={{ background: d.c }} />
                {d.label}
              </span>
              <span className="cost-cell-val">{formatUsd(d.usd)}</span>
            </div>
          ))}
        </div>

        <div className="sub-head">{dict.stackedBarChartTitle}</div>
        {models.length === 0 ? (
          <div className="stat-sub">{dict.costEmpty}</div>
        ) : (
          <div className="model-bars" data-testid="cost-stacked-bar-svg">
            {models.map((m) => {
              const scale = 100 / modelBarReferenceCap;
              const sortedModelSegs = [
                { key: 'input', usd: m.inputCostUsd, c: DIM_COLORS.input },
                { key: 'cached', usd: m.cachedInputCostUsd, c: DIM_COLORS.cached },
                { key: 'output', usd: m.outputCostUsd, c: DIM_COLORS.output },
                { key: 'thinking', usd: m.thinkingCostUsd, c: DIM_COLORS.thinking },
              ]
                .filter((s) => s.usd > 0)
                .sort((a, b) => b.usd - a.usd);

              return (
                <div key={m.modelId} className="model-bar-row">
                  <div className="model-bar-head">
                    <span className="mono truncate" title={m.displayName}>
                      {m.modelId}
                    </span>
                    <span className="spacer" />
                    <span className="mono">{formatUsd(m.totalCostUsd)}</span>
                  </div>
                  <div className="model-bar-track stack-bar-unused-bg">
                    {sortedModelSegs.map((seg) => (
                      <span
                        key={seg.key}
                        data-model-seg={seg.key}
                        style={{ width: `${Math.min(100, seg.usd * scale)}%`, background: seg.c }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {models.length > 0 && (
          <>
            <div className="sub-head">{dict.donutChartTitle}</div>
            <div className="donut-wrap">
              <Donut items={models} />
              <div className="legend" style={{ gridTemplateColumns: '1fr', flex: 1 }}>
                {models.map((m, idx) => (
                  <div key={m.modelId} className="legend-item">
                    <span className="legend-swatch" style={{ background: MODEL_COLORS[idx % MODEL_COLORS.length] }} />
                    <span className="legend-label truncate mono">{m.modelId}</span>
                    <span className="legend-val">{(m.shareRatio * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="disclaimer" data-testid="cost-disclaimer-banner">
            <Info size={11} />
            {COST_DISCLAIMER[locale]}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRateCardsSettings} data-testid="open-rate-cards-btn">
            <Settings2 size={12} />
            <span>{dict.editRateCardsBtn}</span>
          </button>
        </div>
      </section>
    </div>
  );
}

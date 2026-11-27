import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Info, Languages, Minimize2, Paperclip, Settings2, ShieldCheck } from 'lucide-react';
import {
  COST_DISCLAIMER,
  formatExternalReviewerProviderLabel,
  resolveModelCompactionLimit,
  type ConversationTreeState,
  type CostTimeScope,
  type DailyCalendarHeatmapCell,
  type DayHourHeatmapCell,
  type ExternalReviewerCostScope,
  type ExternalReviewerProviderId,
  type ExternalReviewerTelemetrySnapshot,
  type ExternalTranslatorTelemetrySnapshot,
  type HourlyTokenBarBucket,
  type ModelCostBreakdownItem,
  type SessionContextTelemetry,
  type TelemetryDashboardSnapshot,
  type TokenCostSummary,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatTokenShort, formatUsd } from './ContextStatusBar';
import { Icon } from './ui/Icon';
import { TokenHeatmapView } from './context/TokenHeatmapView';
import { handleTablistKeyDown } from '../hooks/useRovingTabs';
import { scrollBehavior } from '../lib/motion';

export type ContextInspectorViewMode = 'context' | 'reviewer' | 'translator';

function formatCacheHitRate(rate: number | undefined): string | undefined {
  if (rate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 1) return undefined;
  if (rate === 0 || rate === 1) return `${rate * 100}%`;
  if (rate < 0.001) return '<0.1%';
  if (rate > 0.999) return '>99.9%';
  return `${(rate * 100).toFixed(1)}%`;
}

export interface ContextCostInspectorViewProps {
  sessionId: string | null;
  dashboard: TelemetryDashboardSnapshot;
  conversationTree?: ConversationTreeState;
  viewMode?: ContextInspectorViewMode;
  onChangeViewMode?: (mode: ContextInspectorViewMode) => void;
  reviewerConnected?: boolean;
  onOpenExternalReviewerSettings?: () => void;
  translatorConnected?: boolean;
  onOpenExternalTranslatorSettings?: () => void;
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
  cached: 'var(--info)',
  output: 'var(--syntax-function)',
  thinking: 'var(--syntax-string)',
};

const MODEL_COLORS = [
  'var(--accent-primary)',
  'var(--syntax-function)',
  'var(--syntax-string)',
  'var(--info)',
  'var(--status-warning)',
  'var(--text-secondary)',
];

/** 数据驱动的分段宽度 / 颜色（静态排版全部走 context.css 类名，仅保留无法静态表达的数据值）。 */
function segStyle(widthPct: number, color: string): React.CSSProperties {
  return { width: `${widthPct}%`, ['--seg-c' as string]: color } as React.CSSProperties;
}
function colorVar(color: string): React.CSSProperties {
  return { ['--seg-c' as string]: color } as React.CSSProperties;
}

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
        className="ctx-ring-track"
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
          className={`ctx-ring-fill is-${level}`}
        />
      )}
    </svg>
  );
}

function Donut({
  items,
  testId = 'cost-donut-svg',
}: {
  items: Array<{ key?: string; modelId: string; shareRatio: number }>;
  testId?: string;
}): React.ReactElement {
  const r = 34;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width="92" height="92" viewBox="0 0 92 92" data-testid={testId} className="ccv-donut">
      <circle cx="46" cy="46" r={r} fill="none" strokeWidth="11" className="ctx-ring-track" />
      {items.map((m, idx) => {
        const len = Math.max(0, m.shareRatio) * c;
        const el = (
          <circle
            key={m.key || m.modelId}
            cx="46"
            cy="46"
            r={r}
            fill="none"
            strokeWidth="11"
            strokeDasharray={`${len} ${c}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 46 46)"
            className="ccv-donut-seg"
            style={colorVar(MODEL_COLORS[idx % MODEL_COLORS.length])}
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

const EMPTY_EXT_REVIEWER: ExternalReviewerTelemetrySnapshot = {
  cumulativeAllTime: {
    ...ZERO,
    callCount: 0,
    approvedCount: 0,
    askCount: 0,
    denyCount: 0,
    errorCount: 0,
    providerCount: 0,
  },
  cumulativeProviders: [],
  bySession: {},
  hourly24h: [],
  matrix7d: [],
  calendar30d: [],
  costByRange: {
    today: { ...ZERO, callCount: 0 },
    '7d': { ...ZERO, callCount: 0 },
    '30d': { ...ZERO, callCount: 0 },
  },
  providerBreakdownByRange: {
    today: [],
    '7d': [],
    '30d': [],
  },
  updatedAt: '',
};

const EMPTY_EXT_TRANSLATOR: ExternalTranslatorTelemetrySnapshot = {
  cumulativeAllTime: {
    ...ZERO,
    callCount: 0,
    successCount: 0,
    fallbackCount: 0,
    errorCount: 0,
    providerCount: 0,
  },
  cumulativeProviders: [],
  bySession: {},
  hourly24h: [],
  matrix7d: [],
  calendar30d: [],
  costByRange: {
    today: { ...ZERO, callCount: 0 },
    '7d': { ...ZERO, callCount: 0 },
    '30d': { ...ZERO, callCount: 0 },
  },
  providerBreakdownByRange: {
    today: [],
    '7d': [],
    '30d': [],
  },
  updatedAt: '',
};

interface BranchUsageLike {
  totalCostUsd: number;
  totalTokens: number;
  callCount: number;
  avgLatencyMs?: number;
}

/**
 * 外部复核与外部翻译共用的对话树口径：存在多分支时汇总主对话与全部去重分支，
 * 否则返回 null（仅显示当前会话），两个插件视图的“当前对话”卡片统计口径一致。
 */
function useConversationTreeUsage(
  conversationTree: ConversationTreeState | undefined,
  bySession: Record<string, BranchUsageLike>,
  sessionId: string | null
) {
  return useMemo(() => {
    if (!conversationTree || conversationTree.totalBranches <= 1) return null;
    const ids = new Set<string>();
    if (conversationTree.rootSessionId) ids.add(conversationTree.rootSessionId);
    if (conversationTree.activeBranchId) ids.add(conversationTree.activeBranchId);
    for (const node of conversationTree.nodes) {
      if (node.branchId) ids.add(node.branchId);
    }
    if (sessionId) ids.add(sessionId);
    let totalCostUsd = 0;
    let totalTokens = 0;
    let callCount = 0;
    let weightedLatency = 0;
    for (const id of ids) {
      const s = bySession[id];
      if (!s) continue;
      totalCostUsd += s.totalCostUsd;
      totalTokens += s.totalTokens;
      callCount += s.callCount;
      weightedLatency += (s.avgLatencyMs || 0) * s.callCount;
    }
    return {
      branchCount: ids.size,
      totalCostUsd,
      totalTokens,
      callCount,
      avgLatencyMs: callCount > 0 ? Math.round(weightedLatency / callCount) : 0,
    };
  }, [conversationTree, bySession, sessionId]);
}

type ExternalServiceProviderItem = TokenCostSummary & {
  key: string;
  provider: ExternalReviewerProviderId;
  endpointHost: string;
  modelId: string;
  callCount: number;
  shareRatio: number;
};

/** 外部复核与外部翻译遥测快照的公共结构（两者字段一一对应，仅结果计数不同）。 */
interface ExternalServiceSnapshot {
  cumulativeAllTime: TokenCostSummary & { callCount: number; providerCount: number };
  cumulativeProviders: ExternalServiceProviderItem[];
  bySession: Record<string, TokenCostSummary & { callCount: number; avgLatencyMs: number; providers: ExternalServiceProviderItem[] }>;
  hourly24h: HourlyTokenBarBucket[];
  daily7d?: DailyCalendarHeatmapCell[];
  matrix7d: DayHourHeatmapCell[];
  calendar30d: DailyCalendarHeatmapCell[];
  costByRange: Record<'today' | '7d' | '30d', TokenCostSummary & { callCount: number }>;
  providerBreakdownByRange: Record<'today' | '7d' | '30d', ExternalServiceProviderItem[]>;
}

interface ExternalServiceOutcome {
  key: string;
  label: string;
  count: number;
  c: string;
}

interface ExternalServiceStatsSectionProps {
  /** data-testid 前缀：`reviewer` / `translator`（保持既有测试锚点不变） */
  kind: 'reviewer' | 'translator';
  sessionId: string | null;
  conversationTree?: ConversationTreeState;
  ext: ExternalServiceSnapshot;
  connected?: boolean;
  onOpenSettings?: () => void;
  statusIcon: React.ReactNode;
  outcomes: ExternalServiceOutcome[];
  labels: {
    overviewTitle: string;
    heatmapTitle: string;
    costTitle: string;
    emptyProviders: string;
    disclaimer: string;
    scopeAll: string;
  };
  onOpenRateCardsSettings: () => void;
}

/**
 * 外部复核 / 外部翻译共用的用量统计视图：总览（客户端累计 vs 当前会话 / 对话树）、
 * 24h / 7d / 30d Token 分布、多服务商 × 模型四维费用构成与占比环形图。
 */
function ExternalServiceStatsSection({
  kind,
  sessionId,
  conversationTree,
  ext,
  connected,
  onOpenSettings,
  statusIcon,
  outcomes,
  labels,
  onOpenRateCardsSettings,
}: ExternalServiceStatsSectionProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const isZh = locale === 'zh-CN';
  const [scope, setScope] = useState<ExternalReviewerCostScope>('all');

  const sessionStats = sessionId ? ext.bySession[sessionId] : undefined;
  const cum = ext.cumulativeAllTime;
  // 存在多分支时汇总整棵对话树下全部去重分支的消耗（复核与翻译同一口径）。
  const treeStats = useConversationTreeUsage(conversationTree, ext.bySession, sessionId);
  // 最后一个会话关闭后不再停留在空的「本会话」范围。
  useEffect(() => {
    if (!sessionId) setScope((prev) => (prev === 'session' ? 'all' : prev));
  }, [sessionId]);

  const cost: TokenCostSummary & { callCount: number } = useMemo(() => {
    if (scope === 'session') {
      return sessionStats
        ? { ...sessionStats, callCount: sessionStats.callCount }
        : { ...ZERO, callCount: 0 };
    }
    if (scope === 'all') {
      return { ...cum, callCount: cum.callCount };
    }
    return ext.costByRange[scope] ?? { ...ZERO, callCount: 0 };
  }, [cum, ext.costByRange, scope, sessionStats]);

  const providers: ExternalServiceProviderItem[] = useMemo(() => {
    const raw =
      scope === 'session'
        ? sessionStats?.providers ?? []
        : scope === 'all'
          ? ext.cumulativeProviders
          : ext.providerBreakdownByRange[scope] ?? [];
    return [...raw].sort(
      (a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens || b.callCount - a.callCount
    );
  }, [ext.cumulativeProviders, ext.providerBreakdownByRange, scope, sessionStats]);


  const sortedDims = useMemo(() => {
    const raw = [
      { key: 'input', label: dict.costDimInput, usd: cost.inputCostUsd, tokens: cost.inputTokens, c: DIM_COLORS.input },
      { key: 'cached', label: dict.costDimCached, usd: cost.cachedInputCostUsd, tokens: cost.cachedInputTokens, c: DIM_COLORS.cached },
      { key: 'output', label: dict.costDimOutput, usd: cost.outputCostUsd, tokens: cost.outputTokens, c: DIM_COLORS.output },
      { key: 'thinking', label: dict.costDimThinking, usd: cost.thinkingCostUsd, tokens: cost.thinkingTokens, c: DIM_COLORS.thinking },
    ];
    return raw.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  }, [cost, dict]);

  const costBarReferenceCap = Math.max(0.01, cost.totalCostUsd * 1.25);
  const providerBarReferenceCap = Math.max(
    0.01,
    cost.totalCostUsd > 0
      ? cost.totalCostUsd * 1.15
      : Math.max(0.01, ...providers.map((m) => m.totalCostUsd * 1.25))
  );

  const outcomeTotal = Math.max(1, cum.callCount);
  const scopeLabels: Record<ExternalReviewerCostScope, string> = isZh
    ? { session: '本会话', today: '今日', '7d': '7d', '30d': '30d', all: labels.scopeAll }
    : { session: 'Session', today: 'Today', '7d': '7d', '30d': '30d', all: 'All' };
  const callsUnit = dict.ui.copy.calls;
  const usageLine = (s: { totalTokens: number; callCount: number; avgLatencyMs?: number }) =>
    `${formatTokenShort(s.totalTokens)} tok · ${s.callCount}${callsUnit}${s.avgLatencyMs ? ` · ${s.avgLatencyMs}ms` : ''}`;

  return (
    <div className="inspector-stack" data-testid={`external-${kind}-telemetry-view`}>
      {/* 1. 总览：客户端累计（全服务商联合） vs 当前会话 / 对话树 */}
      <section className="card" data-testid={`${kind}-overview-card`}>
        <div className="card-head">
          <span className="card-title">{labels.overviewTitle}</span>
          {onOpenSettings ? (
            <button
              type="button"
              className={`badge ${connected ? 'badge-success' : 'badge-warning'}`}
              data-variant="shortcut"
              onClick={onOpenSettings}
              data-testid={`${kind}-status-shortcut-btn`}
            >
              {statusIcon}
              <span>
                {connected
                  ? dict.ui.copy.connected
                  : dict.ui.copy.notConnected}
              </span>
            </button>
          ) : null}
        </div>

        <div className="ctx-session-metrics">
          <div className="ctx-metric-tile" data-testid={`${kind}-alltime-summary`}>
            <span className="ctx-metric-label">{dict.ui.copy.clientAllTime}</span>
            <strong className="ctx-metric-val mono is-accent">
              {formatUsd(cum.totalCostUsd)}
            </strong>
            <span className="stat-sub is-xs">
              {formatTokenShort(cum.totalTokens)} tok · {cum.callCount}
              {dict.ui.copy.fmtCallsProviders(cum.providerCount)}
            </span>
          </div>
          <div className="ctx-metric-tile" data-testid={`${kind}-session-summary`}>
            <span className="ctx-metric-label">
              {treeStats
                ? dict.ui.copy.fmtConversationTree(treeStats.branchCount)
                : dict.ui.copy.currentSession}
            </span>
            <strong className="ctx-metric-val mono">
              {formatUsd(treeStats ? treeStats.totalCostUsd : (sessionStats?.totalCostUsd ?? 0))}
            </strong>
            <span className="stat-sub is-xs">
              {treeStats
                ? treeStats.callCount > 0
                  ? usageLine(treeStats)
                  : dict.ui.copy.noCallsInTree
                : sessionStats
                  ? usageLine(sessionStats)
                  : dict.ui.copy.noCallsInSession}
            </span>
          </div>
        </div>

        <div className="stack-bar stack-bar-unused-bg" data-testid={kind === 'reviewer' ? 'reviewer-verdict-bar' : 'translator-outcome-bar'}>
          {outcomes
            .filter((o) => o.count > 0)
            .map((o) => (
              <span
                key={o.key}
                style={segStyle((o.count / outcomeTotal) * 100, o.c)}
                title={`${o.label}: ${o.count}`}
              />
            ))}
        </div>
        <div className="legend">
          {outcomes.map((o) => (
            <div key={o.key} className="legend-item">
              <span className="legend-swatch" style={colorVar(o.c)} />
              <span className="legend-label truncate">{o.label}</span>
              <span className="legend-val">{o.count}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Token 用量分布（24h / 7d / 30d）—— U-04 共享热力图 */}
      <TokenHeatmapView
        testIdPrefix={`${kind}-`}
        sectionTestId={`${kind}-heatmap-section`}
        title={labels.heatmapTitle}
        hourly24h={ext.hourly24h}
        daily7d={ext.daily7d}
        calendar30d={ext.calendar30d}
      />

      {/* 3. 多服务商联合费用构成 */}
      <section className="card" data-testid={`${kind}-cost-section`}>
        <div className="card-head">
          <span className="card-title">{labels.costTitle}</span>
          <div className="segmented segmented-sm">
            {(['session', 'today', '7d', '30d', 'all'] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                className={`segmented-btn ${scope === sc ? 'is-active' : ''}`}
                onClick={() => setScope(sc)}
                data-testid={`${kind}-cost-scope-${sc}`}
              >
                {scopeLabels[sc]}
              </button>
            ))}
          </div>
        </div>

        <div className="ccv-total-row">
          <span className="stat-big is-accent" data-testid={`${kind}-cost-total-usd`}>
            {formatUsd(cost.totalCostUsd)}
          </span>
          <span className="stat-sub">
            {formatTokenShort(cost.totalTokens)} Tokens · {cost.callCount}
            {callsUnit}
          </span>
        </div>

        <div className="stack-bar stack-bar-unused-bg">
          {sortedDims
            .filter((d) => d.usd > 0)
            .map((d) => (
              <span
                key={d.key}
                style={segStyle(Math.min(100, (d.usd / costBarReferenceCap) * 100), d.c)}
                title={`${d.label}: ${formatUsd(d.usd)}`}
              />
            ))}
        </div>

        <div className="cost-grid">
          {sortedDims.map((d) => (
            <div key={d.key} className="cost-cell" title={`${formatTokenShort(d.tokens)} Tokens`}>
              <span className="cost-cell-label">
                <span className="legend-swatch" style={colorVar(d.c)} />
                {d.label}
              </span>
              <span className="cost-cell-val">{formatUsd(d.usd)}</span>
            </div>
          ))}
        </div>

        <div className="sub-head">{dict.ui.copy.providerModelBreakdown}</div>
        {providers.length === 0 ? (
          <div className="stat-sub">{labels.emptyProviders}</div>
        ) : (
          <div className="model-bars" data-testid={`${kind}-provider-breakdown`}>
            {providers.map((item) => {
              const scale = 100 / providerBarReferenceCap;
              const segs = [
                { key: 'input', usd: item.inputCostUsd, c: DIM_COLORS.input },
                { key: 'cached', usd: item.cachedInputCostUsd, c: DIM_COLORS.cached },
                { key: 'output', usd: item.outputCostUsd, c: DIM_COLORS.output },
                { key: 'thinking', usd: item.thinkingCostUsd, c: DIM_COLORS.thinking },
              ]
                .filter((s) => s.usd > 0)
                .sort((a, b) => b.usd - a.usd);
              const providerLabel = formatExternalReviewerProviderLabel(item.provider, locale);

              return (
                <div key={item.key} className="model-bar-row">
                  <div className="model-bar-head">
                    <span className="badge badge-mono ccv-provider-badge">
                      {providerLabel}
                    </span>
                    <span className="mono truncate" title={`${providerLabel} · ${item.modelId} (${item.endpointHost})`}>
                      {item.modelId}
                    </span>
                    <span className="spacer" />
                    <span className="muted mono is-xs">
                      {item.callCount}×
                    </span>
                    <span className="mono">{formatUsd(item.totalCostUsd)}</span>
                  </div>
                  <div className="model-bar-track stack-bar-unused-bg">
                    {segs.map((seg) => (
                      <span
                        key={seg.key}
                        style={segStyle(Math.min(100, seg.usd * scale), seg.c)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {providers.length > 0 && (
          <>
            <div className="sub-head">{dict.ui.copy.providerShare}</div>
            <div className="donut-wrap">
              <Donut items={providers} testId={`${kind}-cost-donut-svg`} />
              <div className="legend legend-single">
                {providers.map((item, idx) => (
                  <div key={item.key} className="legend-item">
                    <span className="legend-swatch" style={colorVar(MODEL_COLORS[idx % MODEL_COLORS.length])} />
                    <span className="legend-label truncate mono" title={`${formatExternalReviewerProviderLabel(item.provider, locale)} · ${item.modelId}`}>
                      {item.modelId}
                    </span>
                    <span className="legend-val">{(item.shareRatio * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="ccv-foot-row">
          <span className="disclaimer">
            <Icon icon={Info} size="xs" />
            {labels.disclaimer}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRateCardsSettings}>
            <Icon icon={Settings2} size="xs" />
            <span>{dict.editRateCardsBtn}</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function ExternalReviewerStatsView({
  ext,
  reviewerConnected,
  onOpenExternalReviewerSettings,
  ...rest
}: {
  sessionId: string | null;
  conversationTree?: ConversationTreeState;
  ext: ExternalReviewerTelemetrySnapshot;
  reviewerConnected?: boolean;
  onOpenExternalReviewerSettings?: () => void;
  onOpenRateCardsSettings: () => void;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const cum = ext.cumulativeAllTime;
  return (
    <ExternalServiceStatsSection
      {...rest}
      kind="reviewer"
      ext={ext}
      connected={reviewerConnected}
      onOpenSettings={onOpenExternalReviewerSettings}
      statusIcon={<Icon icon={ShieldCheck} size="xs" />}
      outcomes={[
        { key: 'approve', label: dict.ui.copy.approved, count: cum.approvedCount, c: 'var(--status-success)' },
        { key: 'ask', label: dict.ui.copy.asked, count: cum.askCount, c: 'var(--status-warning)' },
        { key: 'deny', label: dict.ui.copy.denied, count: cum.denyCount, c: 'var(--status-danger)' },
        { key: 'error', label: dict.ui.copy.error, count: cum.errorCount, c: 'var(--text-muted)' },
      ]}
      labels={{
        overviewTitle: dict.ui.copy.externalReviewerApi,
        heatmapTitle: dict.ui.copy.reviewerTokenUsage,
        costTitle: dict.ui.copy.reviewerApiCost,
        emptyProviders: dict.ui.copy.noExternalReviewerApiCalls,
        // F-05：外部复核花费区同样必须展示统一的 Cost 免责声明。
        disclaimer: COST_DISCLAIMER[locale],
        scopeAll: '累计',
      }}
    />
  );
}

function ExternalTranslatorInspectorView({
  ext,
  translatorConnected,
  onOpenExternalTranslatorSettings,
  ...rest
}: {
  sessionId: string | null;
  conversationTree?: ConversationTreeState;
  ext: ExternalTranslatorTelemetrySnapshot;
  translatorConnected?: boolean;
  onOpenExternalTranslatorSettings?: () => void;
  onOpenRateCardsSettings: () => void;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const cum = ext.cumulativeAllTime;
  return (
    <ExternalServiceStatsSection
      {...rest}
      kind="translator"
      ext={ext}
      connected={translatorConnected}
      onOpenSettings={onOpenExternalTranslatorSettings}
      statusIcon={<Icon icon={Languages} size="xs" />}
      outcomes={[
        { key: 'success', label: dict.ui.copy.success, count: cum.successCount, c: 'var(--status-success)' },
        { key: 'fallback', label: dict.ui.copy.localFallback, count: cum.fallbackCount, c: 'var(--status-warning)' },
        { key: 'error', label: dict.ui.copy.error2, count: cum.errorCount, c: 'var(--status-danger)' },
      ]}
      labels={{
        overviewTitle: dict.ui.copy.translationApiUsage,
        heatmapTitle: dict.ui.copy.translationTokenUsage,
        costTitle: dict.ui.copy.translationApiCost,
        emptyProviders: dict.ui.copy.noExternalTranslationApiCalls,
        disclaimer: COST_DISCLAIMER[locale],
        scopeAll: '累计全部',
      }}
    />
  );
}


type ContextSectionKey = 'usage' | 'heatmap' | 'cost';
const CONTEXT_COLLAPSE_KEY = 'gravity.context.collapsed';

function readCollapsed(): Record<ContextSectionKey, boolean> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CONTEXT_COLLAPSE_KEY) || '{}');
    return { usage: raw?.usage === true, heatmap: raw?.heatmap === true, cost: raw?.cost === true };
  } catch {
    return { usage: false, heatmap: false, cost: false };
  }
}

/** I2：Context 页分区折叠按钮（`aria-expanded` + `aria-controls`），状态持久化到本机。 */
function SectionToggle({
  name,
  collapsed,
  controls,
  onToggle,
  testId,
}: {
  name: string;
  collapsed: boolean;
  controls: string;
  onToggle: () => void;
  testId: string;
}): React.ReactElement {
  const { dict } = useI18n();
  const label = collapsed ? dict.ui.v035.sectionExpand(name) : dict.ui.v035.sectionCollapse(name);
  return (
    <button
      type="button"
      className={`icon-btn icon-btn-sm ctx-section-toggle${collapsed ? ' is-collapsed' : ''}`}
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      title={label}
      onClick={onToggle}
      data-testid={testId}
    >
      <Icon icon={ChevronDown} size="xs" />
    </button>
  );
}

export function ContextCostInspectorView({
  sessionId,
  dashboard,
  conversationTree,
  viewMode: controlledViewMode,
  onChangeViewMode,
  reviewerConnected,
  onOpenExternalReviewerSettings,
  translatorConnected,
  onOpenExternalTranslatorSettings,
  onOpenRateCardsSettings,
}: ContextCostInspectorViewProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [internalViewMode, setInternalViewMode] = useState<ContextInspectorViewMode>('context');
  const activeView = controlledViewMode ?? internalViewMode;
  const setActiveView = (next: ContextInspectorViewMode) => {
    setInternalViewMode(next);
    onChangeViewMode?.(next);
  };
  const [scope, setScope] = useState<CostTimeScope>(sessionId ? 'session' : 'today');
  const [collapsed, setCollapsed] = useState<Record<ContextSectionKey, boolean>>(readCollapsed);
  const toggleSection = useCallback((key: ContextSectionKey) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(CONTEXT_COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* 仅本次会话保持 */
      }
      return next;
    });
  }, []);
  const jumpTo = useCallback((key: ContextSectionKey) => {
    setCollapsed((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev, [key]: false };
      try {
        window.localStorage.setItem(CONTEXT_COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* 仅本次会话保持 */
      }
      return next;
    });
    const scrollTarget = () => {
      const el = typeof document !== 'undefined' ? document.getElementById(`ctx-section-${key}`) : null;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
      }
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(scrollTarget);
    } else {
      scrollTarget();
    }
  }, []);
  const extSnap = dashboard.externalReviewer ?? EMPTY_EXT_REVIEWER;
  const transSnap = dashboard.externalTranslator ?? EMPTY_EXT_TRANSLATOR;

  useEffect(() => {
    if (sessionId) {
      setScope('session');
    } else {
      // 关闭最后一个会话后回落到「今日」，不再卡在空的会话视图。
      setScope((prev) => (prev === 'session' ? 'today' : prev));
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


  // Context 细分按占比从大到小排列（越多越靠左），总填充宽度严格映射已用压缩窗口比例，右侧保留未使用背景色
  const breakdown = useMemo(() => {
    if (!tele) return [];
    const items = [
      { label: dict.breakdownSystem, val: tele.breakdown.systemAndRulesTokens, c: 'var(--text-muted)' },
      { label: dict.breakdownUser, val: tele.breakdown.userMessagesTokens, c: 'var(--syntax-function)' },
      { label: dict.breakdownAssistant, val: tele.breakdown.agentMessagesTokens, c: 'var(--accent-primary)' },
      { label: dict.breakdownThought, val: tele.breakdown.thoughtTokens, c: 'var(--syntax-string)' },
      { label: dict.breakdownTools, val: tele.breakdown.toolCallsTokens, c: 'var(--info)' },
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
  const cacheHitLabel = formatCacheHitRate(tele?.averageCacheHitRate);

  return (
    <div className="inspector-stack" data-testid="context-cost-inspector">
      {/* 顶部三视图切换：Context 窗口 | 外部复核统计 | 翻译 API 统计 */}
      <div className="inspector-toolbar">
        <div
          className="segmented segmented-sm ctx-view-switch"
          role="tablist"
          aria-label={dict.ui.v034.contextViewSwitch}
          onKeyDown={(e) => handleTablistKeyDown(e)}
          data-testid="context-inspector-mode-switch"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'context'}
            tabIndex={activeView === 'context' ? 0 : -1}
            className={`segmented-btn ${activeView === 'context' ? 'is-active' : ''}`}
            onClick={() => setActiveView('context')}
            title={dict.ctxViewContext}
            data-testid="ctx-view-switch-context"
          >
            <span className="truncate" data-testid="context-mode-tab-context">
              {dict.ctxViewContext}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'reviewer'}
            tabIndex={activeView === 'reviewer' ? 0 : -1}
            className={`segmented-btn ${activeView === 'reviewer' ? 'is-active' : ''}`}
            onClick={() => setActiveView('reviewer')}
            title={dict.ctxViewReviewer}
            data-testid="ctx-view-switch-reviewer"
          >
            <span className="truncate" data-testid="context-mode-tab-reviewer">
              {dict.ctxViewReviewer}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'translator'}
            tabIndex={activeView === 'translator' ? 0 : -1}
            className={`segmented-btn ${activeView === 'translator' ? 'is-active' : ''}`}
            onClick={() => setActiveView('translator')}
            title={dict.ctxViewTranslator}
            data-testid="ctx-view-switch-translator"
          >
            <span className="truncate" data-testid="context-mode-tab-translator">
              {dict.ctxViewTranslator}
            </span>
          </button>
        </div>
      </div>

      <p className="stat-sub">{dict.ui.copy.includesChatAndItsTranslation}</p>
      {activeView === 'reviewer' ? (
        <ExternalReviewerStatsView
          sessionId={sessionId}
          conversationTree={conversationTree}
          ext={extSnap}
          reviewerConnected={reviewerConnected}
          onOpenExternalReviewerSettings={onOpenExternalReviewerSettings}
          onOpenRateCardsSettings={onOpenRateCardsSettings}
        />
      ) : activeView === 'translator' ? (
        <ExternalTranslatorInspectorView
          sessionId={sessionId}
          conversationTree={conversationTree}
          ext={transSnap}
          translatorConnected={translatorConnected}
          onOpenExternalTranslatorSettings={onOpenExternalTranslatorSettings}
          onOpenRateCardsSettings={onOpenRateCardsSettings}
        />
      ) : (
        <>
          <nav className="ctx-anchors" aria-label={dict.ui.v035.contextAnchorsLabel} data-testid="context-section-anchors">
            {(['usage', 'heatmap', 'cost'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className="ctx-anchor"
                onClick={() => jumpTo(key)}
                data-testid={`context-anchor-${key}`}
              >
                {key === 'usage'
                  ? dict.ui.v035.contextAnchorUsage
                  : key === 'heatmap'
                    ? dict.ui.v035.contextAnchorHeatmap
                    : dict.ui.v035.contextAnchorCost}
              </button>
            ))}
          </nav>
          {/* Context 窗口 */}
      <section className="card ctx-section" id="ctx-section-usage" data-collapsed={collapsed.usage || undefined}>
        <div className="card-head">
          <span className="card-title">{dict.contextWindowTitle}</span>
          <SectionToggle
            name={dict.contextWindowTitle}
            collapsed={collapsed.usage}
            controls="ctx-section-usage-body"
            onToggle={() => toggleSection('usage')}
            testId="context-section-toggle-usage"
          />
        </div>
        <div className="ctx-section-body" id="ctx-section-usage-body" hidden={collapsed.usage}>
        {tele ? (
          <>
            <div className="ccv-ctx-head" title={dict.usageSources[tele.usageSource]}>
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
              <div className="ctx-metric-tile" data-testid="context-cache-hit-rate"
                title={cacheHitLabel === undefined ? dict.ui.sessionCacheHitUnknownDetail : undefined}>
                <span className="ctx-metric-label">
                  <span className="ctx-metric-dot" style={colorVar(DIM_COLORS.cached)} />
                  {dict.ui.sessionCacheHitLabel}
                </span>
                <strong className="ctx-metric-val mono">{cacheHitLabel ?? dict.ui.sessionCacheHitUnknown}</strong>
              </div>
            </div>
            <div className="stack-bar stack-bar-unused-bg" data-testid="context-sorted-stack-bar">
              {breakdown
                .filter((b) => b.val > 0)
                .map((b) => (
                  <span
                    key={b.label}
                    data-segment-label={b.label}
                    style={segStyle((b.val / breakdownSum) * effectiveFillPct, b.c)}
                    title={`${b.label}: ${formatTokenShort(b.val)}`}
                  />
                ))}
            </div>
            <div className="legend">
              {breakdown.map((b) => (
                <div key={b.label} className="legend-item">
                  <span className="legend-swatch" style={colorVar(b.c)} />
                  <span className="legend-label truncate">{b.label}</span>
                  <span className="legend-val">{formatTokenShort(b.val)}</span>
                </div>
              ))}
            </div>
            {tele.attachments.length > 0 && (
              <div className="ccv-col ccv-col-4">
                <div className="sub-head">
                  <Icon icon={Paperclip} size="xs" />
                  <span>{dict.attachmentAuditTitle}</span>
                </div>
                {tele.attachments.map((att) => (
                  <div key={att.id} className="legend-item is-sm">
                    <span className="legend-label truncate mono">{att.name}</span>
                    <span className="legend-val">{formatTokenShort(att.estimatedTokens)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="ccv-col ccv-col-5" data-testid="compaction-monitor-section">
              <div className="sub-head">
                <Icon icon={Minimize2} size="xs" />
                <span>{dict.compactionMonitorTitle}</span>
                <span className="badge badge-mono ccv-count-badge">
                  {tele.compactionCountIsMinimum && '≥'}{dict.compactionCountBadge(tele.compactionCount ?? tele.compactions?.length ?? 0)}
                </span>
              </div>
              {(tele.compactionCount ?? 0) >= 50 && <span className="stat-sub">{dict.ui.copy.showingTheLatest50}</span>}
              {!tele.compactions || tele.compactions.length === 0 ? (
                <div className="stat-sub is-sm">
                  {dict.compactionEmpty}
                </div>
              ) : (
                [...tele.compactions].reverse().map((comp) => (
                  <div
                    key={comp.id}
                    className="legend-item is-sm ccv-compaction-row"
                    data-testid={`compaction-record-${comp.id}`}
                  >
                    <span className="legend-label mono">
                      {dict.compactionBeforeLabel} <strong>{formatTokenShort(comp.beforeTokens)}</strong>
                    </span>
                    <Icon icon={ArrowRight} size="xs" className="muted" />
                    <span className="mono">{formatTokenShort(comp.afterTokens)}</span>
                    {comp.savedTokens > 0 && (
                      <span className="badge badge-success badge-mono">-{formatTokenShort(comp.savedTokens)}</span>
                    )}
                    <span className="legend-val muted is-xs">
                      {comp.trigger === 'manual' ? dict.compactionManualLabel : dict.compactionAutoLabel}
                      {comp.estimated && (dict.ui.copy.estimated)}
                      {comp.timestamp && Number.isFinite(Date.parse(comp.timestamp)) ? ` · ${new Date(comp.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="stat-sub">{dict.contextEmpty}</div>
        )}
        </div>
      </section>

      {/* Token 热力图 —— U-04 共享热力图（KPI 洞察条 + 7d 小时标尺矩阵 + 30d Mon–Sun 日历） */}
      <div className="ctx-section" id="ctx-section-heatmap">
        <TokenHeatmapView
          testIdPrefix=""
          sectionTestId="token-heatmap-section"
          title={dict.heatmapSectionTitle}
          hourly24h={dashboard.hourly24h}
          daily7d={dashboard.daily7d}
          calendar30d={dashboard.calendar30d}
          collapsed={collapsed.heatmap}
          onToggleCollapsed={() => toggleSection('heatmap')}
        />
      </div>

      {/* Cost */}
      <section className="card ctx-section" id="ctx-section-cost" data-testid="cost-breakdown-section">
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
          <SectionToggle
            name={dict.costSectionTitle}
            collapsed={collapsed.cost}
            controls="ctx-section-cost-body"
            onToggle={() => toggleSection('cost')}
            testId="context-section-toggle-cost"
          />
        </div>

        <div className="ctx-section-body" id="ctx-section-cost-body" hidden={collapsed.cost}>
        <div className="ccv-total-row">
          <span className="stat-big is-accent" data-testid="cost-total-usd">
            {formatUsd(cost.totalCostUsd)}
          </span>
          <span className="stat-sub">{formatTokenShort(cost.totalTokens)} Tokens</span>
          {!!cost.unclassifiedTokens && <span className="stat-sub">{dict.ui.copy.unclassifiedUnpriced} · {formatTokenShort(cost.unclassifiedTokens)}</span>}
        </div>

        {/* Cost 总体构成进度条：按占比从大到小靠左排列，未使用部分展示背景轨道色 */}
        <div className="stack-bar stack-bar-unused-bg" data-testid="cost-sorted-stack-bar">
          {sortedDims
            .filter((d) => d.usd > 0)
            .map((d) => (
              <span
                key={d.key}
                data-cost-dim={d.key}
                style={segStyle(Math.min(100, (d.usd / costBarReferenceCap) * 100), d.c)}
                title={`${d.label}: ${formatUsd(d.usd)}`}
              />
            ))}
        </div>

        <div className="cost-grid">
          {sortedDims.map((d) => (
            <div key={d.key} className="cost-cell" title={`${formatTokenShort(d.tokens)} Tokens`}>
              <span className="cost-cell-label">
                <span className="legend-swatch" style={colorVar(d.c)} />
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
                        style={segStyle(Math.min(100, seg.usd * scale), seg.c)}
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
              <div className="legend legend-single">
                {models.map((m, idx) => (
                  <div key={m.modelId} className="legend-item">
                    <span className="legend-swatch" style={colorVar(MODEL_COLORS[idx % MODEL_COLORS.length])} />
                    <span className="legend-label truncate mono">{m.modelId}</span>
                    <span className="legend-val">{(m.shareRatio * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="ccv-foot-row">
          <span className="disclaimer" data-testid="cost-disclaimer-banner">
            <Icon icon={Info} size="xs" />
            {COST_DISCLAIMER[locale]}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRateCardsSettings} data-testid="open-rate-cards-btn">
            <Icon icon={Settings2} size="xs" />
            <span>{dict.editRateCardsBtn}</span>
          </button>
        </div>
        </div>
      </section>
        </>
      )}
    </div>
  );
}

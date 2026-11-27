import React, { useState } from 'react';
import { Minimize2, X } from 'lucide-react';
import {
  COST_DISCLAIMER,
  resolveModelCompactionLimit,
  type ConversationTreeTotalCost,
  type SessionContextTelemetry,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { Icon } from './ui/Icon';

export function formatTokenShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 10_000 && Math.round(tokens) % 1_000 === 0) return `${Math.round(tokens / 1_000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens)}`;
}

/** 按金额数量级选择小数位，使一次回复的低额估算可见。此处只负责格式化，不改动统计账本。 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export interface ContextStatusBarProps {
  sessionId: string;
  modelId?: string;
  sessionTelemetry?: SessionContextTelemetry;
  treeCost?: ConversationTreeTotalCost;
  hint?: string;
  onCompactContext: (sessionId: string) => Promise<void>;
  onOpenContextInspector: () => void;
}

/** Claude Code 风格 status line：Context 实际压缩窗口 · tok/s · 对话树总 Cost · 压缩 */
export function ContextStatusBar({
  sessionId,
  modelId,
  sessionTelemetry,
  treeCost,
  hint,
  onCompactContext,
  onOpenContextInspector,
}: ContextStatusBarProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);

  // 看板尚未返回时用当前模型的后备窗口显示分母，已经上报的会话窗口优先于模型估计。
  const used = sessionTelemetry?.usedContextTokens ?? 0;
  const max = sessionTelemetry?.maxContextTokens ?? resolveModelCompactionLimit(sessionTelemetry?.modelId || modelId);
  const pct = Math.min(100, Math.max(0, (sessionTelemetry?.usageRatio ?? 0) * 100));
  const rate = sessionTelemetry?.currentTokensPerSecond ?? 0;
  const cost = treeCost?.totalCostUsd ?? sessionTelemetry?.costSummary?.totalCostUsd ?? 0;
  const costTooltip = treeCost
    ? `${dict.treeCostTooltip(
        Math.max(1, treeCost.branchCount),
        formatUsd(treeCost.totalCostUsd),
        formatUsd(treeCost.modelCostUsd),
        formatUsd(treeCost.reviewerCostUsd),
        formatUsd(treeCost.translatorCostUsd)
      )} · ${COST_DISCLAIMER[locale]}`
    : COST_DISCLAIMER[locale];
  const level = sessionTelemetry?.pressureLevel ?? 'healthy';
  const compactions = sessionTelemetry?.compactions ?? [];
  const lastCompact = compactions.at(-1);
  const compactTooltip = lastCompact
    ? `${dict.compactionBeforeLabel} ${formatTokenShort(lastCompact.beforeTokens)} → ${formatTokenShort(lastCompact.afterTokens)}`
    : undefined;

  /** 压缩进行中暂时禁用重复提交。效果由后续遥测更新呈现，失败信息就地保留在状态栏。 */
  async function handleCompact(): Promise<void> {
    if (compacting) return;
    setCompacting(true);
    setCompactError(null);
    try {
      await onCompactContext(sessionId);
    } catch (err) {
      setCompactError(formatActionError(err, dict));
    } finally {
      setCompacting(false);
    }
  }

  return (
    <div className={`status-line${compactError ? ' has-error' : ''}`} data-testid={`context-status-bar-${sessionId}`}>
      <button
        type="button"
        className="status-line-trigger"
        onClick={onOpenContextInspector}
        title={costTooltip}
        data-testid={`context-inspector-trigger-${sessionId}`}
      >
        <span className="status-seg">
          <span>ctx</span>
          <span className={`gauge level-${level}`}>
            <span style={{ '--fill': Math.max(2, pct) / 100 } as React.CSSProperties} />
          </span>
          <span>
            {formatTokenShort(used)}/{max > 0 ? formatTokenShort(max) : '—'}
          </span>
        </span>
        {/* 空闲（实时速率为 0）时隐藏，避免常驻「0.0 tok/s」噪音 */}
        {rate > 0 && (
          <span
            className="status-seg status-seg-rate"
            title={dict.ui.realtimeTpsLabel}
            data-testid={`composer-realtime-tps-${sessionId}`}
          >
            {rate.toFixed(1)} tok/s
          </span>
        )}
        <span
          className="status-seg"
          title={costTooltip}
        >
          {treeCost && <span>{dict.ui.copy.tree}</span>}
          <span title={costTooltip} data-testid={`composer-tree-cost-${sessionId}`}>{formatUsd(cost)}</span>
        </span>
      </button>
      <button
        type="button"
        className="status-link"
        disabled={compacting}
        title={compactTooltip}
        onClick={() => void handleCompact()}
        data-testid={`btn-compact-context-${sessionId}`}
      >
        <Icon icon={Minimize2} size="xs" />
        <span>
          {compacting ? dict.compactingContext : dict.compactContextBtn}
          {!compacting && compactions.length > 0 ? ` · ${sessionTelemetry?.compactionCountIsMinimum ? '≥' : ''}${sessionTelemetry?.compactionCount ?? compactions.length}` : ''}
        </span>
      </button>
      {compactError ? (
        // 压缩失败提示独占一行完整换行显示，可关闭，不再被 19px 状态行截断。
        <span role="alert" className="status-error-row" data-testid={`compact-error-${sessionId}`} title={compactError}>
          <strong>{dict.ui.v031.compactErrorTitle}</strong>
          <span className="status-error-text">{compactError}</span>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label={dict.ui.v031.dismissAction}
            title={dict.ui.v031.dismissAction}
            onClick={() => setCompactError(null)}
            data-testid={`compact-error-dismiss-${sessionId}`}
          >
            <Icon icon={X} size="xs" />
          </button>
        </span>
      ) : (
        hint && <span className="status-hint">{hint}</span>
      )}
    </div>
  );
}

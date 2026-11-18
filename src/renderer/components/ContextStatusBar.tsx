import React, { useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { COST_DISCLAIMER, resolveModelCompactionLimit, type SessionContextTelemetry } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';

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
  hint?: string;
  onCompactContext: (sessionId: string) => Promise<void>;
  onOpenContextInspector: () => void;
}

/** Claude Code 风格 status line：Context 实际压缩窗口 · tok/s · Cost · 压缩 */
export function ContextStatusBar({
  sessionId,
  modelId,
  sessionTelemetry,
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
  const cost = sessionTelemetry?.costSummary?.totalCostUsd ?? 0;
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
    <div className="status-line" data-testid={`context-status-bar-${sessionId}`}>
      <button
        type="button"
        className="status-line-trigger"
        onClick={onOpenContextInspector}
        title={COST_DISCLAIMER[locale]}
        data-testid={`context-inspector-trigger-${sessionId}`}
      >
        <span className="status-seg">
          <span>ctx</span>
          <span className={`gauge level-${level}`}>
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </span>
          <span>
            {formatTokenShort(used)}/{formatTokenShort(max)}
          </span>
        </span>
        <span className="status-seg status-seg-rate">{rate.toFixed(1)} tok/s</span>
        <span className="status-seg">{formatUsd(cost)}</span>
      </button>
      <button
        type="button"
        className="status-link"
        disabled={compacting}
        title={compactTooltip}
        onClick={() => void handleCompact()}
        data-testid={`btn-compact-context-${sessionId}`}
      >
        <Minimize2 size={11} />
        <span>
          {compacting ? dict.compactingContext : dict.compactContextBtn}
          {!compacting && compactions.length > 0 ? ` · ${compactions.length}` : ''}
        </span>
      </button>
      {compactError ? (
        <span role="alert" className="badge badge-danger" data-testid={`compact-error-${sessionId}`} title={compactError}>
          {compactError}
        </span>
      ) : (
        hint && <span className="status-hint">{hint}</span>
      )}
    </div>
  );
}

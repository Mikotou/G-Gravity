import React, { useState } from 'react';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import {
  TITLE_ORGANIZE_MODEL_LABEL,
  TITLE_ORGANIZE_RATE_LIMIT,
  type TitleOrganizeRequest,
  type TitleOrganizeResult,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';

export interface TitleOrganizerModalProps {
  open: boolean;
  result: TitleOrganizeResult | null;
  cooldownSec?: number;
  onClose: () => void;
  onRunOrganize: (request?: TitleOrganizeRequest) => Promise<void>;
}

export function TitleOrganizerModal({
  open,
  result,
  cooldownSec = 0,
  onClose,
  onRunOrganize,
}: TitleOrganizerModalProps): React.ReactElement | null {
  const { dict } = useI18n();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 由上层先执行整理，再把本次结果传入。列表展示已处理条目的前后标题，空建议列表也可显示汇总。
  if (!open || !result) return null;

  const modelLabel = result.modelUsed || TITLE_ORGANIZE_MODEL_LABEL;
  const remaining = result.remainingQuotaInWindow ?? TITLE_ORGANIZE_RATE_LIMIT.maxCalls;

  async function rerun(): Promise<void> {
    if (running || cooldownSec > 0) return;
    setRunning(true);
    setError(null);
    try {
      await onRunOrganize({ scope: 'all' });
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose} data-testid="organize-modal-backdrop">
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()} data-testid="title-organizer-modal">
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2>{dict.organizeModalTitle}</h2>
            <span className="badge badge-accent badge-mono" data-testid="organize-model-badge">
              <Sparkles size={11} />
              <span>{dict.ui.organizeModelBadge(modelLabel)}</span>
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={dict.closeAction}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="notice" data-testid="organize-summary-banner">
            <span>{dict.organizeSummaryText(result.updatedCount, result.hiddenPollutionCount)}</span>
            {Boolean(result.skippedOrganizedCount) && (
              <span className="muted"> · {dict.ui.organizeSkippedNote(result.skippedOrganizedCount!)}</span>
            )}
          </div>
          {result.suggestions.length === 0 ? (
            <div className="muted">{dict.organizeNoChanges}</div>
          ) : (
            result.suggestions.map((item) => (
              <div key={item.sessionId} className="organize-row" data-testid={`organize-diff-${item.sessionId}`}>
                <div>
                  <div className="token-key">{dict.organizeBeforeCol}</div>
                  <div className="muted">{item.previousTitle}</div>
                </div>
                <ArrowRight size={14} />
                <div>
                  <div className="token-key">{dict.organizeAfterCol}</div>
                  <div style={{ fontWeight: 600 }}>{item.organizedTitle}</div>
                </div>
              </div>
            ))
          )}
          {error && (
            <div role="alert" className="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="muted mono" style={{ fontSize: 11.5, marginRight: 'auto' }} data-testid="organize-quota-status">
            {cooldownSec > 0
              ? dict.ui.organizeCooldownBanner(cooldownSec)
              : dict.ui.organizeWindowQuota(remaining, TITLE_ORGANIZE_RATE_LIMIT.maxCalls)}
          </span>
          <button type="button" className="btn" disabled={running || cooldownSec > 0} onClick={() => void rerun()}>
            {running ? dict.organizingTitles : dict.reOrganizeBtn}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {dict.closeAction}
          </button>
        </div>
      </div>
    </div>
  );
}

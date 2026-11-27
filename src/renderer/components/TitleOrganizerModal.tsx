import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import {
  TITLE_ORGANIZE_RATE_LIMIT,
  type TitleOrganizeRequest,
  type TitleOrganizeResult,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { Icon } from './ui/Icon';
import { useFocusTrap } from '../hooks/useFocusTrap';

export interface TitleOrganizerModalProps {
  open: boolean;
  result: TitleOrganizeResult | null;
  cooldownSec?: number;
  repeatRequest?: TitleOrganizeRequest;
  onClose: () => void;
  onRunOrganize: (request?: TitleOrganizeRequest) => Promise<void>;
}

export function TitleOrganizerModal({
  open,
  result,
  cooldownSec = 0,
  repeatRequest = { scope: 'all' },
  onClose,
  onRunOrganize,
}: TitleOrganizerModalProps): React.ReactElement | null {
  const { dict } = useI18n();
  const [running, setRunning] = useState(false);
  // F-13：焦点陷阱与关闭后归还触发按钮
  const trapRef = useFocusTrap<HTMLDivElement>(Boolean(open && result));
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  runningRef.current = running;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const visible = open && Boolean(result);

  // FE-08：每次重新打开弹窗时清空上一次的报错信息。
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  // Esc 关闭弹窗；整理请求进行中时保持打开，避免结果回来时找不到展示位置。
  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || runningRef.current) return;
      e.preventDefault();
      onCloseRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  // 由上层先执行整理，再把本次结果传入。列表展示已处理条目的前后标题，空建议列表也可显示汇总。
  if (!open || !result) return null;

  const modelLabel = result.modelUsed;
  const remaining = result.remainingQuotaInWindow ?? TITLE_ORGANIZE_RATE_LIMIT.maxCalls;
  const nextBatch = result.nextBatch;
  const pending = nextBatch?.sessionIds.length ?? 0;

  async function rerun(): Promise<void> {
    if (running || cooldownSec > 0) return;
    setRunning(true);
    setError(null);
    try {
      await onRunOrganize(nextBatch ?? repeatRequest);
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={() => { if (!running) onClose(); }} data-testid="organize-modal-backdrop">
      <div className="modal modal-wide" ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="organize-titles-heading"
        onMouseDown={(e) => e.stopPropagation()} data-testid="title-organizer-modal">
        <div className="modal-head">
          <div className="title-org-row">
            <h2 id="organize-titles-heading">{dict.organizeModalTitle}</h2>
            {modelLabel && <span className="badge badge-accent badge-mono" data-testid="organize-model-badge">
              <Icon icon={Sparkles} size="xs" />
              <span>{dict.ui.organizeModelBadge(modelLabel)}</span>
            </span>}
          </div>
          <button type="button" className="icon-btn" onClick={() => { if (!runningRef.current) onClose(); }} disabled={running} aria-label={dict.closeAction}>
            <Icon icon={X} size="md" />
          </button>
        </div>
        <div className="modal-body">
          <div className="notice" data-testid="organize-summary-banner">
            <span>{dict.organizeSummaryText(result.updatedCount, result.hiddenPollutionCount)}</span>
            {Boolean(result.skippedChangedCount) && <span> · {dict.ui.copy.fmtSkippedChangedSessions(result.skippedChangedCount ?? 0)}</span>}
            {pending > 0 && <span> · {dict.ui.copy.fmtRemaining(pending)}</span>}
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
                <Icon icon={ArrowRight} size="sm" />
                <div>
                  <div className="token-key">{dict.organizeAfterCol}</div>
                  <div className="title-org-new">{item.organizedTitle}</div>
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
          <span className="muted mono title-org-quota" data-testid="organize-quota-status">
            {cooldownSec > 0
              ? dict.ui.organizeCooldownBanner(cooldownSec)
              : dict.ui.organizeWindowQuota(remaining, TITLE_ORGANIZE_RATE_LIMIT.maxCalls)}
          </span>
          <button type="button" className="btn" disabled={running || cooldownSec > 0} onClick={() => void rerun()}>
            {running ? dict.organizingTitles : pending > 0 ? (dict.ui.copy.continue2) : dict.reOrganizeBtn}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { if (!runningRef.current) onClose(); }}
            disabled={running}
            data-testid="organize-close-btn"
          >
            {dict.closeAction}
          </button>
        </div>
      </div>
    </div>
  );
}

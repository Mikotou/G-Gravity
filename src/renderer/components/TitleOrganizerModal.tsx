import React, { useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { TitleOrganizeResult } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';

export interface TitleOrganizerModalProps {
  open: boolean;
  result: TitleOrganizeResult | null;
  onClose: () => void;
  onRunOrganize: (useExternalPolish: boolean) => Promise<void>;
}

export function TitleOrganizerModal({
  open,
  result,
  onClose,
  onRunOrganize,
}: TitleOrganizerModalProps): React.ReactElement | null {
  const { dict } = useI18n();
  const [external, setExternal] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 由上层先执行整理，再把本次结果传入。列表展示已处理条目的前后标题，空建议列表也可显示汇总。
  if (!open || !result) return null;

  /** 再次整理时将复核偏好随回调提交，运行期间锁住按钮。结果由父组件更新，错误留在弹窗内。 */
  async function rerun(): Promise<void> {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      await onRunOrganize(external);
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
          <h2>{dict.organizeModalTitle}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={dict.closeAction}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="notice" data-testid="organize-summary-banner">
            {dict.organizeSummaryText(result.updatedCount, result.hiddenPollutionCount)}
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginRight: 'auto' }}>
            <span className="switch">
              <input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />
              <span className="switch-track" />
            </span>
            <span className="muted">{dict.organizeExternalToggle}</span>
          </label>
          <button type="button" className="btn" disabled={running} onClick={() => void rerun()}>
            {dict.reOrganizeBtn}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {dict.closeAction}
          </button>
        </div>
      </div>
    </div>
  );
}

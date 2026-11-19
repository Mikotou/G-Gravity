import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, FolderGit2, ShieldAlert, Sparkles } from 'lucide-react';
import {
  buildClaudeStyleApprovalOptions,
  getCanonicalToolName,
  type ApprovalDecisionSubmission,
  type ClaudeStyleApprovalOptionItem,
  type PendingApprovalRequest,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';

export interface InlineRequestViewProps {
  request: PendingApprovalRequest;
  enableNumericShortcuts?: boolean;
  onSubmitDecision: (submission: ApprovalDecisionSubmission) => Promise<void>;
}

const TEST_ID_BY_INDEX: Record<1 | 2 | 3 | 4, string> = {
  1: 'btn-allow-once',
  2: 'btn-allow-prefix',
  3: 'btn-approve-for-me',
  4: 'btn-reject-feedback',
};

export function InlineRequestView({
  request,
  enableNumericShortcuts = false,
  onSubmitDecision,
}: InlineRequestViewProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const feedbackInputRef = useRef<HTMLTextAreaElement | null>(null);

  const options = buildClaudeStyleApprovalOptions(request, locale);
  const prefixCandidate = request.commandPrefix?.trim() || undefined;
  const canonicalTool = getCanonicalToolName(request.toolName);

  const riskBadgeClass =
    request.riskLevel === 'high' || request.riskLevel === 'critical'
      ? 'badge badge-danger'
      : request.riskLevel === 'medium'
        ? 'badge badge-warning'
        : 'badge badge-success';

  const screeningLabel =
    request.screeningSource === 'local-ast'
      ? dict.screeningLocalAst
      : request.screeningSource === 'regex-rule'
        ? dict.screeningRegexRule
        : request.screeningSource === 'ai-reviewer-fallback'
          ? dict.screeningAiFallback
          : dict.screeningManualMode;

  async function handleAction(submission: ApprovalDecisionSubmission): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await onSubmitDecision(submission);
    } catch (err) {
      setActionError(formatActionError(err, dict));
    } finally {
      setSubmitting(false);
    }
  }

  /** 鼠标和数字快捷键共用同一入口。选择反馈先展开输入区，选择记忆前缀则连同主进程给出的原前缀提交。 */
  function triggerOption(opt: ClaudeStyleApprovalOptionItem): void {
    if (submitting || opt.disabled) return;
    if (opt.decision === 'reject_with_feedback') {
      setFeedbackOpen((prev) => !prev);
      setTimeout(() => feedbackInputRef.current?.focus(), 0);
      return;
    }
    if (opt.decision === 'allow_session_prefix') {
      if (!prefixCandidate) return;
      void handleAction({
        requestId: request.requestId,
        sessionId: request.sessionId,
        decision: 'allow_session_prefix',
        allowedPrefix: prefixCandidate,
      });
      return;
    }
    void handleAction({ requestId: request.requestId, sessionId: request.sessionId, decision: opt.decision });
  }

  // Claude Code 风格：数字 1-4 直接选择（输入框聚焦时不响应）
  useEffect(() => {
    // 快捷键由父窗格分配给当前卡片。各卡片仍可用鼠标选择，未获焦点的卡片不会注册全局数字键处理器。
    if (!enableNumericShortcuts) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
        const matched = options.find((o) => o.index === Number(e.key));
        if (matched && !matched.disabled) {
          e.preventDefault();
          // 当前卡片接手本次数字键后，阻止同一事件继续送到其他窗口监听器，避免一次按键处理多张卡片。
          e.stopImmediatePropagation();
          triggerOption(matched);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <section
      className={`request-view risk-${request.riskLevel}`}
      data-testid={`inline-request-view-${request.requestId}`}
    >
      <div className="request-head">
        <ShieldAlert size={14} className="request-head-icon" />
        <span className="request-title mono">{canonicalTool}</span>
        <span className={riskBadgeClass} data-testid={`risk-badge-${request.requestId}`}>
          {dict.riskLevels[request.riskLevel]}
        </span>
        <span className="spacer" />
        <span className="request-cwd-inline truncate" title={request.cwd}>
          <FolderGit2 size={11} />
          <span className="truncate">{request.cwd}</span>
        </span>
      </div>

      <div className="request-cmd" data-testid={`request-cmd-${request.requestId}`}>
        <span className="request-cmd-prompt">$</span>
        <code>{request.commandOrSummary}</code>
      </div>

      {/* 一级只展示用意一句话；作用范围、转交原因、AI 说明等二级信息收进“详情”。 */}
      <details className="request-intent-box" data-testid={`request-explanation-${request.requestId}`}>
        <summary className="request-intent-row" data-testid={`request-code-intent-${request.requestId}`}>
          <span className="request-intent-main">{request.explanation.meaning}</span>
          {request.aiSuggestion?.reason && <Sparkles size={11} className="request-intent-ai" />}
          {!prefixCandidate && <AlertTriangle size={11} className="request-intent-warn" />}
          <span className="request-intent-more">
            {dict.ui.detailsAction}
            <ChevronRight size={12} className="request-intent-chev" />
          </span>
        </summary>
        <div className="request-intent-detail">
          <div className="request-intent-subrow">
            <span className="muted">{dict.expTargetLabel}：{request.explanation.target}</span>
            {request.explanation.risk && (
              <span className="request-risk-inline">
                {locale === 'zh-CN' ? '转交原因' : 'Why manual'}：{request.explanation.risk}
              </span>
            )}
            <span className="muted">{screeningLabel}</span>
          </div>
          {request.aiSuggestion?.reason && (
            <div className="request-ai-reason" data-testid={`request-ai-reason-${request.requestId}`}>
              <Sparkles size={11} />
              <span>
                {locale === 'zh-CN' ? 'AI 代审说明：' : 'AI Review Note: '}
                {request.aiSuggestion.reason}
              </span>
            </div>
          )}
          {!prefixCandidate && (
            <div className="request-warn" data-testid={`prefix-disabled-reason-${request.requestId}`}>
              <AlertTriangle size={12} />
              <span>{dict.prefixUnavailableReason}</span>
            </div>
          )}
        </div>
      </details>

      {actionError && (
        <div role="alert" className="alert" data-testid={`request-error-${request.requestId}`}>
          {actionError}
        </div>
      )}

      <div className="option-list">
        {options.map((opt) => {
          const split = /^(\d+\.\s*)(.*)$/.exec(opt.primaryText);
          return (
            <button
              key={opt.index}
              type="button"
              className={`option-btn option-index-${opt.index}`}
              disabled={submitting || Boolean(opt.disabled)}
              title={opt.disabledReason ?? opt.descriptionText}
              data-testid={`${TEST_ID_BY_INDEX[opt.index]}-${request.requestId}`}
              onClick={() => triggerOption(opt)}
            >
              <span className="option-primary">
                {split ? (
                  <>
                    <span className="option-num">{split[1]}</span>
                    <span className="option-label-text">{split[2]}</span>
                  </>
                ) : (
                  opt.primaryText
                )}
              </span>
              <span className="option-desc">{opt.descriptionText}</span>
            </button>
          );
        })}
      </div>

      {feedbackOpen && (
        <div className="feedback-box" data-testid={`reject-feedback-box-${request.requestId}`}>
          <textarea
            ref={feedbackInputRef}
            className="input"
            rows={3}
            placeholder={dict.feedbackPlaceholder}
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            data-testid={`reject-feedback-input-${request.requestId}`}
          />
          <div className="feedback-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFeedbackOpen(false)}>
              {dict.cancelAction}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={submitting}
              data-testid={`confirm-reject-btn-${request.requestId}`}
              onClick={() =>
                void handleAction({
                  requestId: request.requestId,
                  sessionId: request.sessionId,
                  decision: 'reject_with_feedback',
                  feedbackText: feedbackText.trim() || 'Rejected by user',
                })
              }
            >
              {dict.confirmRejectBtn}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

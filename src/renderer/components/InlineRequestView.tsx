import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, FolderGit2, Hand, ShieldAlert, ShieldCheck, Sparkles, Target } from 'lucide-react';
import {
  buildClaudeStyleApprovalOptions,
  formatExternalReviewerProviderLabel,
  getCanonicalToolName,
  type ApprovalDecisionSubmission,
  type ApprovalReviewingEvent,
  type ClaudeStyleApprovalOptionItem,
  type PendingApprovalRequest,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { isImeComposing, isPrimaryModifier } from '../lib/platform-keys';
import { formatActionError } from '../i18n/locales';
import { Icon } from './ui/Icon';

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

/** 超过该长度或含多行的命令默认折叠，展开后显示完整内容。 */
const COMMAND_PREVIEW_CHARS = 220;

function isShellTool(toolName: string, canonicalTool: string): boolean {
  return /^(?:execute|run_command|bash|zsh|sh|powershell|pwsh|command|terminal)$/i.test(toolName) || canonicalTool === 'Bash';
}

/** ACP 中终端执行类工具的原始名称。它们在审批卡片上统一显示为 Bash，与工具流、检视器保持同一称呼。 */
const SHELL_DISPLAY_ALIASES = /^(?:execute|zsh|pwsh)$/i;

/**
 * 审批卡片（Stage 2 复核中 / Stage 3 人工审批）上展示的工具名。
 * 仅影响渲染层文案：在共享层规范名基础上，把 ACP 的 `execute` 等终端别名显示为 `Bash`。
 */
function getApprovalToolDisplayName(rawToolName: string): string {
  const canonical = getCanonicalToolName(rawToolName);
  return SHELL_DISPLAY_ALIASES.test(canonical.trim()) ? 'Bash' : canonical;
}

/** 0–100 风险分映射到与风险徽章一致的语义色档位。 */
function riskScoreTone(score: number): 'low' | 'medium' | 'high' {
  if (score >= 70) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}

/* ------------------------------------------------------------------ Stage 2：Guardian 实时复核卡片 */

export interface GuardianReviewingCardProps {
  event: ApprovalReviewingEvent;
  /** 中止外部复核并转为人工审批；缺省时隐藏接管按钮（例如旧版主进程未提供该通道）。 */
  onTakeOver?: (requestId: string) => Promise<void>;
}

/** Stage 2 外部 AI 复核进行中：展示工具、命令摘要、复核模型与实时耗时，并允许一键转为人工审批。 */
export function GuardianReviewingCard({ event, onTakeOver }: GuardianReviewingCardProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const ui = dict.ui;
  const startedAt = Date.parse(event.startedAt);
  // 起始时间无效时以首次挂载时刻为基准，而不是每次重渲染都取 Date.now()（否则计时永远停在 0.0s）。
  const fallbackStartRef = useRef<number>(Date.now());
  const base = Number.isFinite(startedAt) ? startedAt : fallbackStartRef.current;
  const [now, setNow] = useState(() => Date.now());
  const [takingOver, setTakingOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const canonicalTool = getApprovalToolDisplayName(event.toolName);
  const shell = isShellTool(event.toolName, canonicalTool);
  const elapsed = Math.max(event.elapsedMs ?? 0, now - base);

  async function takeOver(): Promise<void> {
    if (!onTakeOver || takingOver) return;
    setTakingOver(true);
    setError(null);
    try {
      await onTakeOver(event.requestId);
    } catch (err) {
      setError(formatActionError(err, dict) || ui.guardianTakeOverFailed);
    } finally {
      setTakingOver(false);
    }
  }

  return (
    <section
      className="guardian-review-card"
      data-testid={`approval-reviewing-card-${event.requestId}`}
    >
      <div className="guardian-review-head">
        <span className="guardian-review-orb" aria-hidden="true">
          <Icon icon={ShieldCheck} size="sm" />
        </span>
        <span
          className="guardian-review-title"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid={`approval-reviewing-status-${event.requestId}`}
        >
          {ui.guardianReviewingTitle}
        </span>
        <span className="guardian-review-tool mono">{canonicalTool}</span>
        <span className="spacer" />
        <span className="guardian-review-model mono" title={event.model}>
          {ui.guardianModelPill(formatExternalReviewerProviderLabel(event.provider, locale), event.model)}
        </span>
        <span className="guardian-review-elapsed mono" data-testid={`approval-reviewing-elapsed-${event.requestId}`}>
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div className="guardian-review-cmd mono" title={event.commandPreview}>
        <span className="request-cmd-prompt">{shell ? '$' : '›'}</span>
        <span className="truncate">{event.commandPreview}</span>
      </div>
      <div className="guardian-review-foot">
        <span className="guardian-review-desc">{event.summary || ui.guardianReviewingDesc}</span>
        {onTakeOver && (
          <button
            type="button"
            className="btn btn-sm guardian-review-takeover"
            disabled={takingOver}
            onClick={() => void takeOver()}
            data-testid={`btn-cancel-stage2-${event.requestId}`}
          >
            <Icon icon={Hand} size="xs" />
            <span>{takingOver ? ui.guardianTakingOver : ui.guardianTakeOver}</span>
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="alert guardian-review-error">
          {error}
        </div>
      )}
      <span className="guardian-review-shimmer" aria-hidden="true" />
    </section>
  );
}

/* ------------------------------------------------------------------ Stage 3：人工审批卡片 */

export function InlineRequestView({
  request,
  enableNumericShortcuts = false,
  onSubmitDecision,
}: InlineRequestViewProps): React.ReactElement {
  const { locale, dict, mac } = useI18n();
  const ui = dict.ui;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [commandExpanded, setCommandExpanded] = useState(false);
  const feedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, []);

  const options = buildClaudeStyleApprovalOptions(request, locale);
  const prefixCandidate = request.commandPrefix?.trim() || undefined;
  const canonicalTool = getApprovalToolDisplayName(request.toolName);
  const isShellCommand = isShellTool(request.toolName, canonicalTool);
  const ai = request.aiSuggestion;
  const longCommand =
    request.commandOrSummary.length > COMMAND_PREVIEW_CHARS || request.commandOrSummary.includes('\n');

  const riskBadgeClass =
    request.riskLevel === 'high' || request.riskLevel === 'critical'
      ? 'badge badge-danger'
      : request.riskLevel === 'medium'
        ? 'badge badge-warning'
        : 'badge badge-success';

  // v0.3.2：规则预筛地板层级，向用户说明「为何仍需你确认」。standard 不额外提示。
  const floorTier = request.floorTier;
  const isTierA = floorTier === 'tier_a_immutable';
  const showFloorTier = isTierA || floorTier === 'tier_b_intent_gated';
  const hasAiReference = isTierA && Boolean(ai && !ai.isError && ai.recommended !== 'deny');
  const tierAReason = isTierA ? request.explanation.risk?.trim().replace(/[。.]+\s*$/, '') : undefined;
  const aiBannerText = (() => {
    const raw = ai?.reason?.trim();
    if (!raw) return '';
    if (!isTierA) return raw;
    const marker = '。外部 AI 评估：';
    const idx = raw.indexOf(marker);
    return idx >= 0 ? raw.slice(idx + marker.length).trim() || raw : raw;
  })();

  const screeningLabel =
    request.screeningSource === 'local-ast'
      ? dict.screeningLocalAst
      : request.screeningSource === 'regex-rule'
        ? dict.screeningRegexRule
        : request.screeningSource === 'ai-reviewer-fallback'
          ? ai?.isError
            ? dict.screeningAiFallback
            : isTierA
              ? ui.v032.screeningFloorForcedManual
              : ui.screeningAiRequestedReview
          : dict.screeningManualMode;

  const aiBannerMeta = (() => {
    if (!ai) return '';
    const parts: string[] = [];
    if (ai.model) parts.push(ai.model);
    if (typeof ai.latencyMs === 'number' && Number.isFinite(ai.latencyMs) && ai.latencyMs > 0) {
      parts.push(`${Math.round(ai.latencyMs)}ms`);
    }
    return parts.join(' · ');
  })();

  const riskScore =
    typeof ai?.riskScore === 'number' && Number.isFinite(ai.riskScore)
      ? Math.max(0, Math.min(100, Math.round(ai.riskScore)))
      : undefined;
  const alignment = ai?.intentAlignment;
  const labelSep = dict.ui.copy.labelItem2;

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
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        feedbackInputRef.current?.focus();
      }, 0);
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

  function submitRejection(): void {
    void handleAction({
      requestId: request.requestId,
      sessionId: request.sessionId,
      decision: 'reject_with_feedback',
      feedbackText: feedbackText.trim() || 'Rejected by user',
    });
  }

  // 最新的选项与触发函数放在 ref 中，全局监听只随快捷键开关注册一次，不在每次渲染时重绑。
  const shortcutStateRef = useRef({ options, triggerOption });
  shortcutStateRef.current = { options, triggerOption };

  // Claude Code 风格：数字 1-4 直接选择（输入框聚焦时不响应）
  useLayoutEffect(() => {
    // 快捷键由父窗格分配给当前卡片。各卡片仍可用鼠标选择，未获焦点的卡片不会注册全局数字键处理器。
    if (!enableNumericShortcuts) return;
    function onKeyDown(e: KeyboardEvent): void {
      // FE-15：统一使用 isImeComposing，覆盖 Chromium 输入法组合态下 keyCode === 229 的情况。
      if (e.defaultPrevented || e.repeat || isImeComposing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
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
        const { options: currentOptions, triggerOption: trigger } = shortcutStateRef.current;
        const matched = currentOptions.find((o) => o.index === Number(e.key));
        if (matched && !matched.disabled) {
          e.preventDefault();
          // 当前卡片接手本次数字键后，阻止同一事件继续送到其他窗口监听器，避免一次按键处理多张卡片。
          e.stopImmediatePropagation();
          trigger(matched);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enableNumericShortcuts]);

  return (
    <section
      className={`request-view risk-${request.riskLevel}${enableNumericShortcuts ? ' has-shortcuts' : ''}${
        floorTier ? ` floor-${floorTier}` : ''
      }`}
      data-testid={`inline-request-view-${request.requestId}`}
      data-floor-tier={floorTier}
    >
      <div className="request-head">
        <Icon icon={ShieldAlert} size="sm" className="request-head-icon" />
        <span className="request-title mono">{canonicalTool}</span>
        <span className={riskBadgeClass} data-testid={`risk-badge-${request.requestId}`}>
          {dict.riskLevels[request.riskLevel]}
        </span>
        {riskScore !== undefined && (
          <span
            className={`request-score-pill tone-${riskScoreTone(riskScore)}`}
            title={isTierA ? ui.v032.floorTierAReferenceHint : ui.riskScoreTitle}
            data-testid={`risk-score-${request.requestId}`}
          >
            <span className="request-score-meter" aria-hidden="true">
              <span style={{ '--fill': riskScore / 100 } as React.CSSProperties} />
            </span>
            <span className="mono">{ui.riskScoreLabel(riskScore)}</span>
          </span>
        )}
        {alignment && (
          <span
            className={`request-intent-pill is-${alignment}`}
            title={isTierA ? ui.v032.floorTierAReferenceHint : ui.intentAlignmentTitle}
            data-testid={`intent-alignment-${request.requestId}`}
          >
            <Icon icon={Target} size="xs" />
            <span>{ui.intentAlignmentLabels[alignment]}</span>
          </span>
        )}
        <span className="spacer" />
        <span className="request-cwd-inline truncate" title={request.cwd}>
          <Icon icon={FolderGit2} size="xs" />
          <span className="truncate">{request.cwd}</span>
        </span>
      </div>

      <div className="request-action-title">{ui.guardianActionTitle(canonicalTool)}</div>

      {showFloorTier && (
        <div
          className={`request-floor-banner ${isTierA ? 'is-tier-a' : 'is-tier-b'}`}
          role="note"
          data-testid={`request-floor-tier-${request.requestId}`}
        >
          {isTierA ? <Icon icon={ShieldAlert} size="sm" /> : <Icon icon={Target} size="sm" />}
          <span className="request-floor-text">
            <strong>
              {isTierA
                ? hasAiReference
                  ? ui.v032.floorTierAWithAiLabel
                  : ui.v032.floorTierALabel
                : ui.v032.floorTierBLabel}
            </strong>
            <span>
              {isTierA
                ? hasAiReference
                  ? ui.v032.floorTierAWithAiDesc(tierAReason)
                  : ui.v032.floorTierADesc
                : ui.v032.floorTierBDesc(ai && !ai.isError ? alignment : undefined)}
            </span>
          </span>
        </div>
      )}

      <div
        className={`request-cmd${longCommand ? ' is-collapsible' : ''}${longCommand && !commandExpanded ? ' is-clamped' : ''}`}
        data-testid={`request-cmd-${request.requestId}`}
      >
        <span className={`request-cmd-prompt${isShellCommand ? '' : ' is-tool'}`}>
          {isShellCommand ? '$' : '›'}
        </span>
        <code>{request.commandOrSummary}</code>
        {longCommand && (
          <button
            type="button"
            className="request-cmd-toggle"
            aria-expanded={commandExpanded}
            onClick={() => setCommandExpanded((v) => !v)}
            data-testid={`request-cmd-toggle-${request.requestId}`}
          >
            {commandExpanded ? ui.commandCollapse : ui.commandExpand}
          </button>
        )}
      </div>

      {/* 一级展示用意一句话；外部复核结论/异常直接可见，作用范围与规则来源收进“详情”。 */}
      <details className="request-intent-box" data-testid={`request-explanation-${request.requestId}`}>
        <summary className="request-intent-row" data-testid={`request-code-intent-${request.requestId}`}>
          <span className="request-intent-main">{request.explanation.meaning}</span>
          {ai?.reason && <Icon icon={Sparkles} size="xs" className="request-intent-ai" />}
          {!prefixCandidate && <Icon icon={AlertTriangle} size="xs" className="request-intent-warn" />}
          <span className="request-intent-more">
            {ui.detailsAction}
            <Icon icon={ChevronRight} size="xs" className="request-intent-chev" />
          </span>
        </summary>
        <div className="request-intent-detail">
          <div className="request-intent-subrow">
            <span className="muted">{dict.expTargetLabel}{labelSep}{request.explanation.target}</span>
            {request.explanation.risk && (
              <span className="request-risk-inline">
                {ui.requestWhyManual}{labelSep}{request.explanation.risk}
              </span>
            )}
            <span className="muted">{screeningLabel}</span>
          </div>
          {!prefixCandidate && (
            <div className="request-warn" data-testid={`prefix-disabled-reason-${request.requestId}`}>
              <Icon icon={AlertTriangle} size="xs" />
              <span>{dict.prefixUnavailableReason}</span>
            </div>
          )}
        </div>
      </details>

      {aiBannerText && (
        <div
          className={`request-ai-reason request-ai-banner${
            ai?.isError ? ' is-error' : ai?.recommended === 'deny' ? ' is-deny' : ''
          }`}
          data-testid={`request-ai-reason-${request.requestId}`}
        >
          {ai?.isError ? (
            <Icon icon={AlertTriangle} size="xs" />
          ) : ai?.recommended === 'deny' ? (
            <Icon icon={ShieldAlert} size="xs" />
          ) : (
            <Icon icon={Sparkles} size="xs" />
          )}
          <span className="request-ai-banner-text">
            <strong>
              {ai?.isError
                ? ui.aiReviewErrorLabel
                : ai?.recommended === 'deny'
                  ? ui.aiReviewDenyLabel
                  : isTierA
                    ? ui.aiReviewReferenceLabel
                    : ui.aiReviewNoteLabel}
              {labelSep}
            </strong>
            {aiBannerText}
          </span>
          {aiBannerMeta && <span className="request-ai-banner-meta mono">{aiBannerMeta}</span>}
        </div>
      )}

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
              className={`option-btn option-index-${opt.index}${
                opt.decision === 'reject_with_feedback' && feedbackOpen ? ' is-active' : ''
              }`}
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
          <div className="feedback-hint">{ui.feedbackHint}</div>
          <textarea
            ref={feedbackInputRef}
            className="input"
            rows={3}
            placeholder={dict.feedbackPlaceholder}
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === 'Enter' && isPrimaryModifier(e, mac)) {
                e.preventDefault();
                submitRejection();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setFeedbackOpen(false);
              }
            }}
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
              onClick={submitRejection}
            >
              {dict.confirmRejectBtn}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

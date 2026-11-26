import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  CirclePause,
  Clock3,
  Loader2,
  OctagonAlert,
  X,
} from 'lucide-react';
import type { DiagnosticActionId, SessionDiagnosticBanner, TurnStopState } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { Icon as UiIcon } from './ui/Icon';

export type DiagnosticHandlers = Partial<Record<DiagnosticActionId, () => Promise<unknown> | unknown>>;

export interface TurnDiagnosticCardProps {
  banner: TurnStopState | SessionDiagnosticBanner;
  /** 可执行的恢复动作；缺少处理函数的动作不会显示 */
  handlers: DiagnosticHandlers;
  /** 会话忙碌（生成中或待审批）时禁用继续 / 重试 */
  busy?: boolean;
  /** 折叠为仅标题与说明（历史回合） */
  compact?: boolean;
  /** 兼容旧版流式中断横幅：首行文字与继续按钮文案、测试标识 */
  legacyLead?: string;
  continueLabel?: string;
  continueTestId?: string;
  className?: string;
}

const COOLDOWN_GATED: ReadonlySet<DiagnosticActionId> = new Set(['retry_turn', 'continue_turn']);
const BUSY_GATED: ReadonlySet<DiagnosticActionId> = new Set(['retry_turn', 'continue_turn', 'compact_context', 'edit_last_message']);
const PRIMARY_ORDER: DiagnosticActionId[] = [
  'continue_turn',
  'retry_turn',
  'reconnect_session',
  'launch_official_login',
  'compact_context',
  'scroll_to_approval',
  'focus_question_bar',
  'edit_last_message',
  'new_session',
  'open_accounts_settings',
  'open_approval_settings',
];

/** 冷却剩余秒数（每秒刷新，到点自动停止计时器）。 */
export function useCooldownSeconds(cooldownUntil?: string): number {
  const until = cooldownUntil ? Date.parse(cooldownUntil) : NaN;
  // FE-07：时钟快照与其对应的截止时间绑定。已挂载卡片收到新的 cooldownUntil 时，
  // 当次渲染立即改用当前时间计算，而不是沿用上一次计时器留下的旧 now（否则首秒倒计时偏大）。
  const [tick, setTick] = useState(() => ({ until, now: Date.now() }));
  const now = Object.is(tick.until, until) ? tick.now : Date.now();
  const active = Number.isFinite(until) && until > now;
  useEffect(() => {
    setTick({ until, now: Date.now() });
    if (!active) return;
    const timer = window.setInterval(() => setTick({ until, now: Date.now() }), 1000);
    return () => window.clearInterval(timer);
  }, [active, until]);
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

/**
 * 对话暂停 / 截断 / 断连 / 错误停止的结构化诊断卡片：
 * 图标与标题、原因说明、可执行建议、可折叠技术详情、429/403 实时冷却倒计时与一键恢复按钮。
 * 冷却期间禁用继续 / 重试，且从不提供自动切换账号。
 */
export function TurnDiagnosticCard({
  banner,
  handlers,
  busy = false,
  compact = false,
  legacyLead,
  continueLabel,
  continueTestId,
  className,
}: TurnDiagnosticCardProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const strings = dict.ui.v031;
  const zh = locale === 'zh-CN';
  const [pending, setPending] = useState<DiagnosticActionId | null>(null);
  const [actionError, setActionError] = useState('');
  const remaining = useCooldownSeconds(banner.cooldownUntil);
  const cooling = remaining > 0;
  const hadCooldown = Boolean(banner.cooldownUntil);

  const title = zh ? banner.titleZh : banner.titleEn;
  const message = zh ? banner.messageZh : banner.messageEn;
  const suggestions = (zh ? banner.suggestionsZh : banner.suggestionsEn) || [];
  const Icon = banner.severity === 'paused' ? CirclePause : banner.severity === 'error' ? OctagonAlert : AlertTriangle;

  const actions = PRIMARY_ORDER.filter((id) => banner.actions.includes(id) && typeof handlers[id] === 'function');
  const canDismiss = banner.actions.includes('dismiss') && typeof handlers.dismiss === 'function' &&
    ('dismissible' in banner ? banner.dismissible !== false : true);

  async function run(id: DiagnosticActionId): Promise<void> {
    const handler = handlers[id];
    if (!handler || pending) return;
    setActionError('');
    setPending(id);
    try {
      await handler();
    } catch (err) {
      setActionError(strings.diagActionFailed(formatActionError(err, dict)));
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className={`turn-diagnostic-card is-${banner.severity}${compact ? ' is-compact' : ''}${className ? ' ' + className : ''}`}
      data-testid="turn-diagnostic-card"
      data-diagnostic-code={banner.code}
      data-diagnostic-severity={banner.severity}
      role={banner.severity === 'error' ? 'alert' : 'status'}
      aria-label={title}
    >
      <div className="diag-head">
        <span className="diag-icon" aria-hidden="true"><UiIcon icon={Icon} size="md" /></span>
        <div className="diag-heading">
          <strong className="diag-title">{title}</strong>
          {legacyLead && <span className="diag-lead">{legacyLead}</span>}
        </div>
        {canDismiss && (
          <button
            type="button"
            className="icon-btn icon-btn-sm diag-dismiss"
            aria-label={strings.dismissAction}
            title={strings.dismissAction}
            onClick={() => void run('dismiss')}
            data-testid="diagnostic-action-dismiss"
          >
            <UiIcon icon={X} size="xs" />
          </button>
        )}
      </div>

      {!compact && message && <p className="diag-message">{message}</p>}

      {!compact && suggestions.length > 0 && (
        <div className="diag-suggestions">
          <span className="diag-section-label">{strings.diagSuggestions}</span>
          <ul>
            {suggestions.map((tip) => <li key={tip}>{tip}</li>)}
          </ul>
        </div>
      )}

      {hadCooldown && (cooling ? (
        <div className="diag-cooldown" data-testid="diagnostic-cooldown-timer" aria-live="polite">
          <UiIcon icon={Clock3} size="xs" />
          <span>{strings.diagCooldown(remaining)}</span>
        </div>
      ) : (
        <div className="diag-cooldown is-done" data-testid="diagnostic-cooldown-timer">
          <UiIcon icon={Clock3} size="xs" />
          <span>{strings.diagCooldownDone}</span>
        </div>
      ))}

      {!compact && actions.length > 0 && (
        <div className="diag-actions">
          {actions.map((id, index) => {
            const disabled = Boolean(pending) || (cooling && COOLDOWN_GATED.has(id)) || (busy && BUSY_GATED.has(id));
            const isContinue = id === 'continue_turn';
            return (
              <button
                key={id}
                type="button"
                className={`btn btn-sm ${index === 0 ? 'diag-action-primary' : 'diag-action'}`}
                disabled={disabled}
                onClick={() => void run(id)}
                data-testid={isContinue && continueTestId ? continueTestId : `diagnostic-action-${id}`}
                data-action-id={id}
              >
                {pending === id && <UiIcon icon={Loader2} size="xs" className="spin" />}
                <span>{isContinue && continueLabel ? continueLabel : strings.diagActionLabels[id]}</span>
              </button>
            );
          })}
        </div>
      )}

      {actionError && <div role="alert" className="diag-action-error">{actionError}</div>}

      {!compact && banner.technicalDetail && (
        <details className="diag-detail">
          <summary>
            <UiIcon icon={ChevronRight} size="xs" className="diag-detail-chev" />
            <span>{strings.diagTechnical}</span>
          </summary>
          <pre>{banner.technicalDetail}</pre>
        </details>
      )}
    </section>
  );
}

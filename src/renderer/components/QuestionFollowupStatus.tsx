import React, { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RotateCcw } from 'lucide-react';
import type { QuestionFollowupMetadata } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { getDesktopBridge } from '../services/desktop-bridge';
import { Icon } from './ui/Icon';

/**
 * v0.3.5：原生提问以普通消息跟进（`delivery: 'followup'`）时的投递状态投影。
 *
 * - 仅 `failed-unsent`（确认未送达）提供唯一的「重新发送」按钮，并携带 `retryUnsentFollowup: true` 与原 `submissionId`；
 * - `unknown` 绝不自动重发，只提示用户在对话中核对，避免重复投递；
 * - `queued` / `sending` / `sent` 仅展示状态。
 */
export function QuestionFollowupStatus({
  sessionId,
  followup,
}: {
  sessionId: string;
  followup: QuestionFollowupMetadata;
}): React.ReactElement {
  const { dict } = useI18n();
  const t = dict.ui.v035;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const state = followup.state;
  const icon = state === 'sent' ? CheckCircle2 : state === 'failed-unsent' || state === 'unknown' ? AlertTriangle : Clock3;

  async function retry(): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await getDesktopBridge().answerQuestion({
        sessionId,
        messageId: followup.questionMessageId,
        action: 'accept',
        delivery: 'followup',
        submissionId: followup.submissionId,
        retryUnsentFollowup: true,
      });
    } catch (reason) {
      setError(stripIpcErrorPrefix(reason));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className={`question-followup is-${state}`}
      data-testid={`question-followup-${followup.questionMessageId}`}
      data-state={state}
      role={state === 'failed-unsent' || state === 'unknown' ? 'status' : undefined}
    >
      <Icon icon={icon} size="xs" />
      <span className="question-followup-text">{t.qFollowupState[state]}</span>
      {followup.detail && <span className="question-followup-detail">{followup.detail}</span>}
      {state === 'failed-unsent' && (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void retry()}
          data-testid={`question-followup-retry-${followup.questionMessageId}`}
        >
          <Icon icon={RotateCcw} size="xs" />
          <span>{t.qFollowupRetry}</span>
        </button>
      )}
      {error && (
        <span role="alert" className="question-followup-error">
          {error}
        </span>
      )}
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, Paperclip, Plus } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { formatVoiceElapsed, type UseVoiceCaptureResult } from '../hooks/useVoiceCapture';
import { Icon } from './ui/Icon';

/**
 * v0.3.6 Composer 底栏输入工具：附件 + 麦克风。
 * 窗格 ≤ 460px 时两者合并进 `+` 溢出菜单（容器查询切换，零布局位移）；听写状态以定宽 chip 显示。
 */
export function VoiceControls({
  sessionId,
  voice,
  onAttach,
  attachLabel,
  attachTitle,
}: {
  sessionId: string;
  voice: UseVoiceCaptureResult;
  onAttach: () => void;
  attachLabel: string;
  attachTitle: string;
}): React.ReactElement {
  const { dict, mac } = useI18n();
  const t6 = dict.ui.v036;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const recording = voice.phase === 'recording';
  const busy = voice.phase !== 'idle';
  const micLabel = busy ? t6.voiceStop : t6.voiceShortcutHint(mac);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [moreOpen]);

  const status =
    voice.phase === 'recording'
      ? t6.voiceRecording(formatVoiceElapsed(voice.elapsedMs))
      : voice.phase === 'finishing'
        ? t6.voiceFinishing
        : voice.phase === 'arming' || voice.phase === 'probing'
          ? t6.voiceProbing
          : '';

  return (
    <>
      {(status || voice.notice) && (
        <span
          className={`voice-status${recording ? ' is-recording' : ''}`}
          role="status"
          aria-live="polite"
          data-testid={`voice-status-${sessionId}`}
          title={voice.backpressure ? t6.voiceBackpressure : undefined}
        >
          {recording && <span className="voice-dot" aria-hidden="true" />}
          {voice.phase === 'finishing' && <Icon icon={Loader2} size="xs" className="spin" />}
          <span className="truncate">{status || voice.notice}</span>
          {voice.backpressure && <span className="sr-only">{t6.voiceBackpressure}</span>}
        </span>
      )}
      <span className="composer-inline-tools">
        <button
          type="button"
          className="icon-btn attach-btn"
          title={attachTitle}
          aria-label={attachLabel}
          onClick={onAttach}
          data-testid={`attach-file-btn-${sessionId}`}
        >
          <Icon icon={Paperclip} size="md" />
        </button>
        <button
          type="button"
          className={`icon-btn voice-btn${busy ? ' is-active' : ''}`}
          title={micLabel}
          aria-label={micLabel}
          aria-pressed={busy}
          disabled={!voice.supported}
          onClick={voice.toggle}
          data-testid={`voice-toggle-${sessionId}`}
        >
          <Icon icon={voice.supported ? Mic : MicOff} size="md" />
        </button>
      </span>
      <div className="menu-anchor composer-more" ref={moreRef}>
        <button
          type="button"
          className={`icon-btn${busy ? ' is-active' : ''}`}
          aria-label={t6.voiceMore}
          title={t6.voiceMore}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
          data-testid={`composer-more-${sessionId}`}
        >
          <Icon icon={Plus} size="md" />
        </button>
        {moreOpen && (
          <div className="popover menu-up composer-more-menu" role="menu" aria-label={t6.voiceMore}>
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setMoreOpen(false); onAttach(); }}>
              <Icon icon={Paperclip} size="sm" />
              <span>{t6.voiceAttach}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={!voice.supported}
              onClick={() => { setMoreOpen(false); voice.toggle(); }}
              data-testid={`composer-more-voice-${sessionId}`}
            >
              <Icon icon={Mic} size="sm" />
              <span>{micLabel}</span>
            </button>
          </div>
        )}
      </div>
    </>
  );
}

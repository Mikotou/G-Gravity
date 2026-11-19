import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { formatDuration } from '../lib/turn-insights';

/**
 * Claude Code 风格的等待行：旋转星芒 + 流光标题 + 本轮计时 + Esc 中断提示。
 * 只在助手尚未吐出任何内容时显示，首个分片到达后由消息本身接管反馈。
 */
export function WorkingIndicator({ startedAt }: { startedAt?: string }): React.ReactElement {
  const { dict } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const elapsed = Number.isFinite(start) ? Math.max(0, now - start) : 0;
  return (
    <div className="cc-thinking-head working-indicator" style={{ cursor: 'default' }} role="status" data-testid="working-indicator">
      <span className="cc-thinking-glyph is-streaming">✻</span>
      <span className="cc-thinking-title is-streaming">{dict.thinkingStreamingTitle}</span>
      <span className="working-meta">
        {elapsed >= 1000 && <span className="working-time">{formatDuration(elapsed)}</span>}
        <span className="working-hint">{dict.ui.interruptHint}</span>
      </span>
    </div>
  );
}

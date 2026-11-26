import { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../lib/clipboard';

export type CopyFeedbackState = 'idle' | 'copied' | 'failed';

/**
 * U-01：复制按钮的统一状态机。成功/失败后在 `resetMs` 内复位，卸载时清理定时器，避免对已卸载组件 setState。
 */
export function useCopyFeedback(resetMs = 1400): {
  state: CopyFeedbackState;
  copy: (text: string) => Promise<boolean>;
} {
  const [state, setState] = useState<CopyFeedbackState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyTextToClipboard(text);
      if (!mountedRef.current) return ok;
      setState(ok ? 'copied' : 'failed');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (mountedRef.current) setState('idle');
      }, resetMs);
      return ok;
    },
    [resetMs]
  );

  return { state, copy };
}

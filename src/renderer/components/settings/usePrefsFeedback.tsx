import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientPreferences } from '@shared';
import { useI18n } from '../../i18n/I18nContext';
import { formatActionError } from '../../i18n/locales';

/**
 * v0.3.5 SV2：设置页偏好写入统一错误处理与反馈。
 * `save(patch)` 捕获失败并以 `role="alert"` 呈现原因，成功时短暂显示 `role="status"` 提示；返回是否成功。
 */
export function usePrefsFeedback(onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>) {
  const { dict } = useI18n();
  const [state, setState] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const save = useCallback(
    async (patch: Partial<ClientPreferences>): Promise<boolean> => {
      const id = ++seq.current;
      if (timer.current) clearTimeout(timer.current);
      try {
        await onUpdatePreferences(patch);
        if (id !== seq.current) return true;
        setState({ kind: 'saved', text: dict.ui.v035.prefsSaved });
        timer.current = setTimeout(() => setState((s) => (s?.kind === 'saved' ? null : s)), 1600);
        return true;
      } catch (err) {
        if (id === seq.current) setState({ kind: 'error', text: dict.ui.v035.prefsSaveFailed(formatActionError(err, dict)) });
        return false;
      }
    },
    [dict, onUpdatePreferences]
  );

  const feedback = state ? (
    state.kind === 'error' ? (
      <p role="alert" className="settings-feedback is-error" data-testid="settings-prefs-error">
        {state.text}
      </p>
    ) : (
      <p role="status" className="settings-feedback is-saved" data-testid="settings-prefs-saved">
        {state.text}
      </p>
    )
  ) : null;

  return { save, feedback };
}

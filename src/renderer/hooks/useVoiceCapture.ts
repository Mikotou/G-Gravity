/**
 * v0.3.6 Composer 语音听写 Hook：把 `VoiceCaptureController` 状态机接到会话草稿。
 *
 * - 开始时捕获「草稿表 + 会话 ID」作为写回目标：Split-2 切换焦点、窗格换绑或切 Profile 后，文本仍写回原会话草稿（纯本地）；
 * - 插入走受控段（`dictation-ranges`）：用户手改后偏移自动变换；Esc 只回滚本次未编辑的听写段；
 * - settled 按 finalSeq 补齐：分段缺失时以 settled 全文为准替换本次未编辑段；
 * - 静息态不触碰任何媒体 API；引擎关闭 / 模型缺失时只给出提示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoiceLocale, VoiceStateSnapshot } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import {
  readComposerDraftText,
  useComposerDraftRegistry,
  writeComposerDraftText,
} from '../lib/composer-draft';
import { VoiceCaptureController, type VoicePhase } from '../lib/voice/controller';
import {
  applyUserEdit,
  insertDictation,
  rollbackCapture,
  sealCapture,
  type DictationState,
} from '../lib/voice/dictation-ranges';
import { getVoiceBridge } from '../services/desktop-bridge';
import workletUrl from '../lib/voice/pcm-worklet.ts?worker&url';

export interface UseVoiceCaptureResult {
  supported: boolean;
  phase: VoicePhase;
  elapsedMs: number;
  backpressure: boolean;
  notice: string;
  toggle: () => void;
  stop: () => void;
  abort: () => void;
  flushImeBuffer: () => void;
}

interface Target {
  drafts: ReturnType<typeof useComposerDraftRegistry>;
  id: string;
  locale: VoiceLocale;
}

export function useVoiceCapture({
  profileId,
  sessionId,
  textareaRef,
  composingRef,
}: {
  profileId: string;
  sessionId: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  composingRef?: React.RefObject<boolean>;
}): UseVoiceCaptureResult {
  const { dict } = useI18n();
  const t6 = dict.ui.v036;
  const drafts = useComposerDraftRegistry();
  const bridge = useMemo(() => getVoiceBridge(), []);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [backpressure, setBackpressure] = useState(false);
  const [notice, setNotice] = useState('');
  const target = useRef<Target | null>(null);
  const dictation = useRef<DictationState>({ text: '', ranges: [] });
  const pendingImeOps = useRef<Array<() => void>>([]);
  const segCounter = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const tRef = useRef(t6);
  tRef.current = t6;

  /** 把用户在两次插入之间的手动编辑同步进受控段偏移 */
  const syncFromDraft = useCallback((tg: Target) => {
    const current = readComposerDraftText(tg.drafts, tg.id);
    if (current !== dictation.current.text) dictation.current = applyUserEdit(dictation.current, current);
  }, []);

  const writeBack = useCallback((tg: Target, next: DictationState, caret?: number) => {
    dictation.current = next;
    writeComposerDraftText(tg.drafts, tg.id, next.text);
    const el = textareaRef.current;
    if (caret !== undefined && el && sessionRef.current === tg.id) {
      requestAnimationFrame(() => {
        if (document.activeElement === el) el.setSelectionRange(caret, caret);
      });
    }
  }, [textareaRef]);

  const insertText = useCallback((captureId: string, text: string) => {
    const tg = target.current;
    if (!tg || !text) return;
    syncFromDraft(tg);
    const el = textareaRef.current;
    const at =
      el && sessionRef.current === tg.id && document.activeElement === el
        ? el.selectionEnd ?? dictation.current.text.length
        : dictation.current.text.length;
    const { state, caret } = insertDictation(dictation.current, {
      segId: `seg-${++segCounter.current}`,
      captureId,
      text,
      at,
      locale: tg.locale,
    });
    writeBack(tg, state, caret);
  }, [syncFromDraft, textareaRef, writeBack]);

  const runOrQueueForIme = useCallback(
    (op: () => void) => {
      if (composingRef?.current && sessionRef.current === target.current?.id) {
        pendingImeOps.current.push(op);
        return;
      }
      op();
    },
    [composingRef]
  );

  const flushImeBuffer = useCallback(() => {
    const ops = pendingImeOps.current.splice(0);
    for (const op of ops) op();
  }, []);

  const controller = useMemo(() => {
    if (!bridge) return null;
    return new VoiceCaptureController(
      bridge,
      {
        onPhase: (p, info) => {
          setPhase(p);
          setBackpressure(Boolean(info.backpressure));
          setStartedAt(info.startedAt ?? 0);
        },
        onSegment: (captureId, _seq, text) => runOrQueueForIme(() => insertText(captureId, text)),
        onSettled: (captureId, event, missing) =>
          runOrQueueForIme(() => {
            const tg = target.current;
            if (!tg) return;
            syncFromDraft(tg);
            const hadSegments = dictation.current.ranges.some((r) => r.captureId === captureId);
            if (missing && event.text) {
              // QA1-FE-03：先回写回滚后的草稿再插入全量 settled 文本，防止 syncFromDraft 读回旧分段导致翻倍
              const rolled = rollbackCapture(dictation.current, captureId);
              dictation.current = rolled.state;
              writeComposerDraftText(tg.drafts, tg.id, rolled.state.text);
              insertText(captureId, event.text);
            } else if (!hadSegments && event.text) {
              insertText(captureId, event.text);
            }
            writeBack(tg, sealCapture(dictation.current, captureId));
            if (!event.text && event.outcome === 'completed') setNotice('');
          }),
        onAborted: () => {
          pendingImeOps.current = [];
        },
        onNotice: (kind, message) => {
          const t = tRef.current;
          setNotice(
            kind === 'cap' ? t.voiceCapReached : kind === 'revoked' || kind === 'held' ? t.voiceRevoked : t.voiceError(message ?? '')
          );
        },
      },
      { workletUrl }
    );
  }, [bridge, insertText, runOrQueueForIme, syncFromDraft, writeBack]);

  useEffect(() => () => controller?.dispose(), [controller]);

  useEffect(() => {
    if (phase !== 'recording' || !startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase, startedAt]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const start = useCallback(async () => {
    if (!controller || !bridge || controller.busy) return;
    let state: VoiceStateSnapshot;
    try {
      state = await bridge.getVoiceState();
    } catch (err) {
      setNotice(t6.voiceError(err instanceof Error ? err.message : ''));
      return;
    }
    if (state.config.engine === 'off') {
      setNotice(t6.voiceUnavailable);
      return;
    }
    if (state.config.engine === 'local' && state.model.status !== 'ready') {
      setNotice(t6.voiceModelMissing);
      return;
    }
    const tg: Target = { drafts, id: sessionId, locale: state.config.locale };
    target.current = tg;
    dictation.current = { text: readComposerDraftText(drafts, sessionId), ranges: [] };
    setNotice('');
    await controller.start({
      owner: { profileId, sessionId },
      locale: state.config.locale,
      ...(state.config.preferredDeviceId ? { deviceId: state.config.preferredDeviceId } : {}),
    });
  }, [bridge, controller, drafts, profileId, sessionId, t6]);

  const stop = useCallback(() => {
    if (!controller) return;
    if (controller.phase === 'recording') void controller.stop();
    else if (controller.phase === 'arming' || controller.phase === 'probing') void controller.abort();
  }, [controller]);

  const abort = useCallback(() => {
    if (!controller || controller.phase === 'idle') return;
    const captureId = controller.captureId;
    void controller.abort().then(() => {
      const tg = target.current;
      if (!tg || !captureId) return;
      syncFromDraft(tg);
      const rolled = rollbackCapture(dictation.current, captureId);
      writeBack(tg, rolled.state, rolled.caret);
    });
  }, [controller, syncFromDraft, writeBack]);

  const toggle = useCallback(() => {
    if (!controller) {
      setNotice(t6.voiceUnavailable);
      return;
    }
    if (controller.phase === 'idle') void start();
    else stop();
  }, [controller, start, stop, t6.voiceUnavailable]);

  return {
    supported: Boolean(controller),
    phase,
    elapsedMs: phase === 'recording' && startedAt ? Math.max(0, now - startedAt) : 0,
    backpressure,
    notice,
    toggle,
    stop,
    abort,
    flushImeBuffer,
  };
}

export function formatVoiceElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

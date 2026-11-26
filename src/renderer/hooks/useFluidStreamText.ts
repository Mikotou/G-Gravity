import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';

export type FluidStreamProfile = 'thought' | 'assistant' | 'morph';

export interface FluidStreamState {
  visibleText: string;
  settledText: string;
  freshTail: string;
  isCatchingUp: boolean;
}

function isJsdomRuntime(): boolean {
  return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
}

/**
 * 避免在 UTF-16 代理对（如 Emoji 或扩展汉字）中间截断字符串。
 */
export function clampToCodePointBoundary(text: string, rawIndex: number): number {
  const idx = Math.max(0, Math.min(text.length, Math.floor(rawIndex)));
  if (idx > 0 && idx < text.length) {
    const code = text.charCodeAt(idx - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      return idx + 1;
    }
  }
  return idx;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return clampToCodePointBoundary(b, i);
}

const PROFILE_PARAMS: Record<
  FluidStreamProfile,
  { baseCps: number; catchupFactor: number; tailChars: number }
> = {
  // 思考流：从容舒缓的雾化显影节奏
  thought: { baseCps: 42, catchupFactor: 3.0, tailChars: 24 },
  // 译文替换：清晰可感知的中文渐进覆盖英文节奏
  morph: { baseCps: 36, catchupFactor: 3.6, tailChars: 18 },
  // 正文输出：优雅稳健的编辑流式滑入节奏
  assistant: { baseCps: 56, catchupFactor: 3.8, tailChars: 20 },
};

/** F-08：打字机提交节流（≤ 30fps）。游标仍按每帧推进，只降低 React 提交频率。 */
const MIN_COMMIT_INTERVAL_MS = 1000 / 30;

/**
 * 将后端离散到达的流式 chunk 平滑插值为连续字符流，消除一卡一卡的顿挫感。
 * - 非流式状态（或无动画单测环境未显式开启 forceAnimation 时）零延迟同步返回完整文本；
 * - F-11：挂载时已有的文本直接视为已显示，只对之后到达的新分片做插值（切回标签不会重播整段）；
 * - F-17：`prefers-reduced-motion: reduce` 时不启动 rAF，直接显示全文；
 * - `enabled = false`（如折叠态思考块）时同样关闭 rAF。
 */
export function useFluidStreamText(
  targetText: string,
  isStreaming: boolean,
  profile: FluidStreamProfile,
  forceAnimation = false,
  enabled = true
): FluidStreamState {
  const shouldAnimate =
    enabled && isStreaming && !prefersReducedMotion() && (forceAnimation || !isJsdomRuntime());
  const params = PROFILE_PARAMS[profile];

  // 保留小数游标来积累不足一个字符的帧间增量。目标文本单独保存在 ref 中，动画帧会读到最新内容。
  // F-11：游标从挂载时的已有文本长度起步（测试显式 forceAnimation 时保留从 0 起的旧语义）。
  const cursorRef = useRef<number>(shouldAnimate && forceAnimation ? 0 : targetText.length);
  const lastCommitRef = useRef(0);
  const targetRef = useRef<string>(targetText);
  const prevTargetRef = useRef<string>(targetText);
  const paramsRef = useRef(params);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  targetRef.current = targetText;
  paramsRef.current = params;

  const [revealedLen, setRevealedLen] = useState<number>(() =>
    shouldAnimate ? Math.min(cursorRef.current, targetText.length) : targetText.length
  );

  // F-P0-1：动画循环只在「有积压且尚未运行」时启动一次，新分片只更新 targetRef，
  // 绝不在每个 chunk 上 cancelAnimationFrame —— 否则分片间隔 < 16ms 时 RAF 永远不会执行，正文冻结。
  const tickRef = useRef<(now: number) => void>(() => {});
  tickRef.current = (now: number) => {
    const target = targetRef.current;
    const { baseCps, catchupFactor } = paramsRef.current;
    // 限制单帧时间差，页面从后台恢复时也按有限步幅追上目标，避免一帧跳过一大段。
    const dtSec = Math.min(0.064, Math.max(0.004, (now - lastTsRef.current) / 1000));
    lastTsRef.current = now;

    const backlog = target.length - cursorRef.current;
    if (backlog <= 0) {
      cursorRef.current = target.length;
      setRevealedLen(target.length);
      rafRef.current = 0;
      return;
    }

    // 自适应追赶速度：积压越多推进越快，既保持丝滑又绝不拖尾卡顿
    const dynamicCps = baseCps + backlog * catchupFactor;
    const nextFloat = Math.min(target.length, cursorRef.current + dynamicCps * dtSec);
    cursorRef.current = nextFloat;

    const aligned = clampToCodePointBoundary(target, nextFloat >= target.length - 0.35 ? target.length : nextFloat);
    // 节流提交：最后一帧（追平目标）总是提交，其余帧至少间隔 MIN_COMMIT_INTERVAL_MS。
    if (aligned >= target.length || now - lastCommitRef.current >= MIN_COMMIT_INTERVAL_MS) {
      lastCommitRef.current = now;
      setRevealedLen((prev) => (prev === aligned ? prev : aligned));
    }

    if (aligned < target.length) {
      rafRef.current = window.requestAnimationFrame(frame);
    } else {
      cursorRef.current = target.length;
      rafRef.current = 0;
    }
  };
  const frameRef = useRef((now: number) => tickRef.current(now));
  const frame = frameRef.current;

  useEffect(() => {
    const prevTarget = prevTargetRef.current;
    prevTargetRef.current = targetText;

    if (!shouldAnimate) {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      cursorRef.current = targetText.length;
      setRevealedLen(targetText.length);
      return;
    }

    // 译文形态（morph）：当英文段落在原地被更短的中文译文替换时，从公共前缀处平滑推进中文，避免瞬时闪切
    if (profile === 'morph' && prevTarget !== targetText) {
      const lcp = commonPrefixLength(prevTarget, targetText);
      if (lcp < targetText.length && lcp < cursorRef.current) {
        cursorRef.current = lcp;
        setRevealedLen(lcp);
      }
    }

    // 若目标文本被重置或回退（例如切换会话或译文重写），立即对齐游标防越界
    if (cursorRef.current > targetText.length) {
      cursorRef.current = targetText.length;
      setRevealedLen(targetText.length);
    }

    if (cursorRef.current >= targetText.length || rafRef.current) {
      return;
    }
    lastTsRef.current = performance.now();
    rafRef.current = window.requestAnimationFrame(frame);
  }, [shouldAnimate, targetText, profile, frame]);

  // 仅在卸载时取消仍在运行的动画帧。
  useEffect(() => () => {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  if (!shouldAnimate) {
    return {
      visibleText: targetText,
      settledText: targetText,
      freshTail: '',
      isCatchingUp: false,
    };
  }

  // 显示长度和尾部样式分界都要对齐 Unicode 码点，防止表情或扩展汉字的两个编码单元被拆开。
  const safeLen = clampToCodePointBoundary(targetText, Math.min(revealedLen, targetText.length));
  const visibleText = targetText.slice(0, safeLen);
  const isCatchingUp = safeLen < targetText.length;
  const tailLen = safeLen > 0 ? Math.min(params.tailChars, safeLen) : 0;
  const splitIdx = clampToCodePointBoundary(visibleText, Math.max(0, visibleText.length - tailLen));

  return {
    visibleText,
    settledText: visibleText.slice(0, splitIdx),
    freshTail: visibleText.slice(splitIdx),
    isCatchingUp,
  };
}

import { useEffect, useRef, useState } from 'react';

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

/**
 * 将后端离散到达的流式 chunk 平滑插值为 60fps 连续字符流，消除一卡一卡的顿挫感。
 * - 非流式状态（或无动画单测环境未显式开启 forceAnimation 时）零延迟同步返回完整文本。
 */
export function useFluidStreamText(
  targetText: string,
  isStreaming: boolean,
  profile: FluidStreamProfile,
  forceAnimation = false
): FluidStreamState {
  const shouldAnimate = isStreaming && (forceAnimation || !isJsdomRuntime());
  const params = PROFILE_PARAMS[profile];

  // 保留小数游标来积累不足一个字符的帧间增量。目标文本单独保存在 ref 中，动画帧会读到最新内容。
  const cursorRef = useRef<number>(shouldAnimate ? 0 : targetText.length);
  const targetRef = useRef<string>(targetText);
  const prevTargetRef = useRef<string>(targetText);
  targetRef.current = targetText;

  const [revealedLen, setRevealedLen] = useState<number>(() =>
    shouldAnimate ? Math.min(cursorRef.current, targetText.length) : targetText.length
  );

  useEffect(() => {
    const prevTarget = prevTargetRef.current;
    prevTargetRef.current = targetText;

    if (!shouldAnimate) {
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

    if (cursorRef.current >= targetText.length) {
      return;
    }

    let rafId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const target = targetRef.current;
      // 限制单帧时间差，页面从后台恢复时也按有限步幅追上目标，避免一帧跳过一大段。
      const dtSec = Math.min(0.064, Math.max(0.004, (now - lastTs) / 1000));
      lastTs = now;

      const backlog = target.length - cursorRef.current;
      if (backlog <= 0) {
        cursorRef.current = target.length;
        setRevealedLen(target.length);
        return;
      }

      // 自适应追赶速度：积压越多推进越快，既保持丝滑又绝不拖尾卡顿
      const dynamicCps = params.baseCps + backlog * params.catchupFactor;
      const nextFloat = Math.min(target.length, cursorRef.current + dynamicCps * dtSec);
      cursorRef.current = nextFloat;

      const aligned = clampToCodePointBoundary(target, nextFloat >= target.length - 0.35 ? target.length : nextFloat);
      setRevealedLen((prev) => (prev === aligned ? prev : aligned));

      if (aligned < target.length) {
        rafId = window.requestAnimationFrame(step);
      } else {
        cursorRef.current = target.length;
      }
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [shouldAnimate, targetText, params.baseCps, params.catchupFactor]);

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

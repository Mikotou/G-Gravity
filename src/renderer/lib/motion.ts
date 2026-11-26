/**
 * F-17：JS 侧动效与 `prefers-reduced-motion` 联动。
 * CSS 层已在 base 中对 reduced-motion 关闭动画；这里供打字机 rAF、平滑滚动等 JS 动效同步遵守。
 */
const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** 减少动效时一律瞬时滚动。 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

export function subscribeReducedMotion(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  try {
    const mq = window.matchMedia(QUERY);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', callback);
      return () => mq.removeEventListener('change', callback);
    }
  } catch {
    // headless 环境忽略
  }
  return () => {};
}

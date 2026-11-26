import type { GravityDesktopBridge } from '@shared';
import { getFallbackDesktopBridge, peekFallbackDesktopBridge } from './fallback-desktop-bridge';

// 测试与 dev 预览专用出口：生产代码不得引用；Rollup 仅保留被实际使用的导出，生产包会整体剔除演示 Mock。
export {
  createFallbackDesktopBridge,
  getFallbackDesktopBridge,
  mockInspectLocalTargets,
  resetFallbackDesktopBridge,
  type FallbackDesktopBridge,
} from './fallback-desktop-bridge';

/**
 * Electron 环境直接返回 preload 暴露的 `window.gravityDesktop`。
 * 测试或布局夹具显式创建过演示实例时沿用该实例；仅非生产构建（`vite dev` / Vitest）才会自动创建内存演示桥接。
 */
export function getDesktopBridge(): GravityDesktopBridge {
  if (typeof window !== 'undefined' && window.gravityDesktop) return window.gravityDesktop;
  const installed = peekFallbackDesktopBridge();
  if (installed) return installed;
  if (!import.meta.env.PROD) return getFallbackDesktopBridge();
  throw new Error('Gravity desktop bridge is unavailable: window.gravityDesktop was not exposed by preload.');
}

export function isUsingNativeDesktopBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.gravityDesktop);
}

/** 演示审批等预览专用入口：仅在非 Electron 且（测试/夹具已建实例或非生产构建）时可用；生产包中整段被剔除。 */
function demoBridge() {
  if (isUsingNativeDesktopBridge()) return null;
  return peekFallbackDesktopBridge() ?? (import.meta.env.PROD ? null : getFallbackDesktopBridge());
}

export function canTriggerDemoApproval(): boolean {
  return demoBridge() !== null;
}

export function triggerDemoApproval(sessionId: string): void {
  demoBridge()?.triggerDemoApproval(sessionId);
}

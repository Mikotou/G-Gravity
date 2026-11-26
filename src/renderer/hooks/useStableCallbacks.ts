import { useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/**
 * F-08：把一组每次渲染都会重建的内联回调收敛为引用永久稳定的函数对象。
 * 稳定函数总是调用最近一次渲染传入的实现，因此不会读到过期闭包；
 * 配合 `React.memo` 让未受影响的窗格 / 侧栏 / 检视器在其它会话流式更新时跳过提交。
 * 键集合必须在组件生命周期内保持不变。
 */
export function useStableCallbacks<T extends Record<string, AnyFn>>(impl: T): T {
  const implRef = useRef(impl);
  implRef.current = impl;
  const stableRef = useRef<T | null>(null);
  if (!stableRef.current) {
    const out: Record<string, AnyFn> = {};
    for (const key of Object.keys(impl)) {
      out[key] = (...args: unknown[]) => implRef.current[key](...args);
    }
    stableRef.current = out as T;
  }
  return stableRef.current;
}

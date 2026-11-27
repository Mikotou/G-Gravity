import type React from 'react';

/**
 * v0.3.5 A11Y-01：`role="tablist"` 统一方向键漫游（自动激活）。
 *
 * - ←/→（垂直列表为 ↑/↓）在同一 tablist 的直接页签间循环移动焦点并激活；Home / End 跳到首 / 末页签；
 * - 只处理属于当前 tablist 的页签（嵌套 tablist 互不干扰），禁用页签跳过；
 * - 组件需自行为选中页签设置 `tabIndex={0}`、其余 `tabIndex={-1}`，以保持单一 Tab 停靠点。
 */
export function handleTablistKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  orientation: 'horizontal' | 'vertical' = 'horizontal'
): void {
  const prevKey = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  if (![prevKey, nextKey, 'Home', 'End'].includes(e.key)) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const list = e.currentTarget;
  const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (tab) => tab.closest('[role="tablist"]') === list && !tab.hasAttribute('disabled') && tab.getAttribute('aria-disabled') !== 'true'
  );
  if (tabs.length === 0) return;
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  let next = current;
  if (e.key === prevKey) next = (current - 1 + tabs.length) % tabs.length;
  else if (e.key === nextKey) next = (current + 1) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  e.preventDefault();
  if (next === current) return;
  tabs[next].focus();
  tabs[next].click();
}

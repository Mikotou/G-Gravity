import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true'
  );
}

/**
 * F-13：模态焦点陷阱与焦点归还。
 * - 激活时记录触发元素；若容器内尚无焦点，聚焦首个可聚焦控件（尊重已有 `autoFocus`）；
 * - `Tab` / `Shift+Tab` 在容器首尾循环，焦点不会逃逸到底层工作台；
 * - 失活或卸载时把焦点归还给仍在文档中的触发元素。
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const wasActiveRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Capture trigger focus during render on false -> true transition before any child autoFocus/useLayoutEffect moves focus.
  if (active && !wasActiveRef.current) {
    previousFocusRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  }
  wasActiveRef.current = active;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const captured = previousFocusRef.current;
    const previous =
      captured && !root.contains(captured)
        ? captured
        : typeof document !== 'undefined' && !root.contains(document.activeElement)
          ? (document.activeElement as HTMLElement | null)
          : null;
    if (!root.contains(document.activeElement)) {
      const first = focusableWithin(root)[0];
      (first ?? root).focus?.({ preventScroll: true });
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || !root) return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    }
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current = null;
      if (previous && previous !== document.body && previous.isConnected) {
        previous.focus?.({ preventScroll: true });
      }
    };
  }, [active]);
  return ref;
}

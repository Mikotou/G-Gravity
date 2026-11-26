import { useEffect } from 'react';

/**
 * F-09：流式粘底跟随。
 *
 * 只靠「消息数组变化」触发滚动会漏掉打字机逐帧显影、图片加载撑高、代码高亮回填等不改变消息的增高。
 * 这里用 ResizeObserver 观察滚动容器内的内容节点，高度变化时在下一帧（rAF 合批）把仍处于粘底状态的视口推到底部；
 * 用户已上滑（stickRef = false）时只回调 `onUnseen`，由窗格显示「回到最新」。
 */
export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
  stickRef: React.MutableRefObject<boolean>,
  options: {
    enabled: boolean;
    /** 内容节点选择器（相对滚动容器），默认第一个子元素 */
    contentSelector?: string;
    /** 返回 true 时暂停跟随（如正在划词） */
    paused?: () => boolean;
    onFollow?: (scrollTop: number) => void;
    onUnseen?: () => void;
  }
): void {
  const { enabled, contentSelector, paused, onFollow, onUnseen } = options;
  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const content =
      (contentSelector ? scroller.querySelector<HTMLElement>(contentSelector) : null) ??
      (scroller.firstElementChild as HTMLElement | null);
    if (!content) return;
    let frame = 0;
    let lastHeight = content.getBoundingClientRect().height;
    let lastScrollHeight = scroller.scrollHeight;
    const applyFollow = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (!stickRef.current || paused?.()) {
        onUnseen?.();
        return;
      }
      el.scrollTop = el.scrollHeight;
      onFollow?.(el.scrollTop);
    };
    const observer = new ResizeObserver((entries) => {
      const el = scrollRef.current;
      const height = entries[entries.length - 1]?.contentRect.height ?? content.getBoundingClientRect().height;
      const scrollHeight = el ? el.scrollHeight : 0;
      const grew = height > lastHeight || scrollHeight > lastScrollHeight;
      lastHeight = height;
      lastScrollHeight = scrollHeight;
      if (!grew) return;
      // ResizeObserver fires post-layout before paint; snap immediately on leading edge and coalesce burst resizes per frame.
      if (!frame) {
        applyFollow();
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          const current = scrollRef.current;
          if (current && current.scrollHeight > lastScrollHeight) {
            lastScrollHeight = current.scrollHeight;
            applyFollow();
          }
        });
      }
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, contentSelector, paused, onFollow, onUnseen, scrollRef, stickRef]);
}

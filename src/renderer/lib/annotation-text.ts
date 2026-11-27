/**
 * v0.3.6 划词标注共享文本遍历器（纯 DOM 读取，无副作用）。
 *
 * - 统一跳过 `[data-annotation-skip]` 子树（项目符号、代码块头、按钮、chips、已发送标注卡等界面装饰），
 *   使「选区 → 偏移」与「偏移 → Range」两个方向使用完全相同的文本视图；
 * - 记录前后各 32 字上下文；偏移失配（流式增量、重渲染）时按摘录 + 上下文回退定位。
 */

export const ANNOTATION_CONTEXT_CHARS = 32;

export interface AnnotationAnchor {
  start: number;
  anchorText: string;
  prefix: string;
  suffix: string;
}

function isSkipped(node: Node, root: Element): boolean {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== root) {
    if (el.hasAttribute('data-annotation-skip') || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return true;
    el = el.parentElement;
  }
  return false;
}

/** 按文档顺序列出可标注文本节点（跳过装饰子树）。 */
export function annotatableTextNodes(root: Element): Text[] {
  const out: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isSkipped(node, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export function annotatableText(root: Element): string {
  return annotatableTextNodes(root)
    .map((n) => n.data)
    .join('');
}

/** 计算边界点 (container, offset) 在可标注文本视图中的绝对偏移（落在跳过子树内时收拢到其后首个文本位置）。 */
function absoluteOffset(root: Element, container: Node, offset: number): number {
  const point = root.ownerDocument.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  let total = 0;
  for (const n of annotatableTextNodes(root)) {
    if (n === container) return total + offset;
    if (point.comparePoint(n, n.data.length) > 0) return total;
    total += n.data.length;
  }
  return total;
}

/** 选区 → 锚点（偏移 + 选中文本 + 上下文）。 */
export function anchorFromRange(root: Element, range: Range): AnnotationAnchor | null {
  const start = absoluteOffset(root, range.startContainer, range.startOffset);
  const end = absoluteOffset(root, range.endContainer, range.endOffset);
  if (end <= start) return null;
  const text = annotatableText(root);
  const anchorText = text.slice(start, end);
  if (!anchorText.trim()) return null;
  return {
    start,
    anchorText,
    prefix: text.slice(Math.max(0, start - ANNOTATION_CONTEXT_CHARS), start),
    suffix: text.slice(end, end + ANNOTATION_CONTEXT_CHARS),
  };
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** 在文本视图中解析锚点位置：先校验原偏移，失配时按摘录 + 前后 32 字上下文择优回退。 */
export function resolveAnchorOffset(text: string, anchor: Partial<AnnotationAnchor> & { anchorText: string }): number | null {
  const { anchorText } = anchor;
  if (!anchorText) return null;
  if (anchor.start !== undefined && text.slice(anchor.start, anchor.start + anchorText.length) === anchorText) {
    return anchor.start;
  }
  let best: number | null = null;
  let bestScore = -1;
  for (let i = text.indexOf(anchorText); i >= 0; i = text.indexOf(anchorText, i + 1)) {
    const before = text.slice(Math.max(0, i - ANNOTATION_CONTEXT_CHARS), i);
    const after = text.slice(i + anchorText.length, i + anchorText.length + ANNOTATION_CONTEXT_CHARS);
    const score = commonSuffixLen(before, anchor.prefix ?? '') + commonPrefixLen(after, anchor.suffix ?? '');
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** 锚点 → DOM Range（不跨越跳过子树）。 */
export function rangeFromAnchor(root: Element, anchor: Partial<AnnotationAnchor> & { anchorText: string }): Range | null {
  const nodes = annotatableTextNodes(root);
  const text = nodes.map((n) => n.data).join('');
  const start = resolveAnchorOffset(text, anchor);
  if (start === null) return null;
  const end = start + anchor.anchorText.length;
  const range = root.ownerDocument.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const next = offset + node.data.length;
    if (!started && start < next) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}

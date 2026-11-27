/**
 * v0.3.6 听写受控插入段（纯函数）。
 *
 * - 每段听写插入记作 `{ segId, captureId, start, end }`；
 * - 用户手动编辑后按「公共前后缀」计算单个编辑区间，对其它段做偏移变换；与编辑区间相交的段标记为 `edited`；
 * - `Esc` 只回滚本次 capture 中**未被编辑**的段，按段自身记录的文本校验后删除，绝不误删手打的相同文字。
 */
import { normalizeDictationText, type VoiceLocale } from '@shared';

export interface DictationRange {
  segId: string;
  captureId: string;
  start: number;
  end: number;
  text: string;
  edited?: boolean;
}

export interface DictationState {
  text: string;
  ranges: DictationRange[];
}

/** 在 `at` 处插入一段听写文本（自动按边界补/去空格），返回新文本与新段列表。 */
export function insertDictation(
  state: DictationState,
  input: { segId: string; captureId: string; text: string; at: number; locale?: VoiceLocale }
): { state: DictationState; caret: number } {
  const at = Math.max(0, Math.min(input.at, state.text.length));
  const piece = normalizeDictationText(state.text.slice(0, at), input.text, input.locale);
  if (!piece) return { state, caret: at };
  const text = state.text.slice(0, at) + piece + state.text.slice(at);
  const shifted = state.ranges.map((r) => (r.start >= at ? { ...r, start: r.start + piece.length, end: r.end + piece.length } : r));
  return {
    state: { text, ranges: [...shifted, { segId: input.segId, captureId: input.captureId, start: at, end: at + piece.length, text: piece }] },
    caret: at + piece.length,
  };
}

/** 用户编辑：由旧/新文本推导单一编辑区间并变换全部段。 */
export function applyUserEdit(state: DictationState, nextText: string): DictationState {
  const prev = state.text;
  if (prev === nextText) return state;
  let prefix = 0;
  const max = Math.min(prev.length, nextText.length);
  while (prefix < max && prev[prefix] === nextText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    prev[prev.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix++;
  const editStart = prefix;
  const editEndOld = prev.length - suffix;
  const delta = nextText.length - prev.length;
  const ranges: DictationRange[] = [];
  for (const r of state.ranges) {
    if (r.end <= editStart) {
      ranges.push(r);
    } else if (r.start >= editEndOld) {
      ranges.push({ ...r, start: r.start + delta, end: r.end + delta });
    } else {
      // 编辑区间与该段相交：该段已被用户改动，不再参与回滚
      const start = Math.min(r.start, editStart);
      const end = Math.max(start, r.end + delta);
      ranges.push({ ...r, start, end, edited: true });
    }
  }
  return { text: nextText, ranges };
}

/** 回滚某次 capture 中未编辑的段（逆序删除，删除前校验文本一致）。 */
export function rollbackCapture(state: DictationState, captureId: string): { state: DictationState; caret?: number } {
  const targets = state.ranges
    .filter((r) => r.captureId === captureId && !r.edited)
    .sort((a, b) => b.start - a.start);
  let text = state.text;
  let ranges = state.ranges.filter((r) => r.captureId !== captureId);
  let caret: number | undefined;
  for (const r of targets) {
    if (text.slice(r.start, r.end) !== r.text) continue;
    text = text.slice(0, r.start) + text.slice(r.end);
    const len = r.end - r.start;
    ranges = ranges.map((o) => (o.start >= r.end ? { ...o, start: o.start - len, end: o.end - len } : o));
    caret = r.start;
  }
  return { state: { text, ranges }, caret };
}

/** 一次 capture 结束（settled）后不再需要回滚：移除其段记录。 */
export function sealCapture(state: DictationState, captureId: string): DictationState {
  return { text: state.text, ranges: state.ranges.filter((r) => r.captureId !== captureId) };
}

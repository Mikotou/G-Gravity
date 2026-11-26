import { EventEmitter } from 'node:events';
import { cleanTranslationEnvelope } from '../../shared/translation-contract';
import type { DualTrackThoughtBlock } from '../../shared/session-contract';
import { detectThoughtLanguage, needsModelTranslation, findNextSegmentEnd, hasBalancedCodeSpans } from './thought-segmenter';
export { detectThoughtLanguage, needsModelTranslation } from './thought-segmenter';
type ThoughtTranslationEngineSource = 'local-model' | 'external-api';

export type ThoughtTranslateResult =
  | string
  | { text: string; source: ThoughtTranslationEngineSource };

type ThoughtTranslateFn = (
  text: string,
  thoughtId: string,
  signal?: AbortSignal
) => Promise<ThoughtTranslateResult>;

interface ParagraphEntry {
  origStart: number;
  origEnd: number;
  zhText: string;
  trailingNewlines: string;
  translatedPieceCount: number;
  closed: boolean;
  refineScheduled: boolean;
}

/**
 * 每个思考块保存原文偏移、已完成译文、逐段记录和正在翻译的区间。
 * epoch 标识该块当前这一轮，供异步回调与整段重译覆写辨认过期结果。
 */
interface ThoughtBlockState {
  block: DualTrackThoughtBlock;
  epoch: number;
  controller: AbortController;
  translatedOffset: number;
  finalizedZh: string;
  paragraphs: ParagraphEntry[];
  inFlightRange?: { start: number; end: number };
  inFlightRefineCount: number;
  hasTranslatedSegment: boolean;
  lastSource?: ThoughtTranslationEngineSource;
  idleTimer?: NodeJS.Timeout;
}

export const STREAM_IDLE_FLUSH_MS = 900;
const MAX_PARAGRAPH_REFINE_CHARS = 1200;

function normalizeTranslateResult(
  result: ThoughtTranslateResult
): { text: string; source: ThoughtTranslationEngineSource } {
  if (typeof result === 'string') {
    return { text: result, source: 'local-model' };
  }
  return {
    text: typeof result?.text === 'string' ? result.text : '',
    source: result?.source === 'external-api' ? 'external-api' : 'local-model',
  };
}

function rebuildFinalizedZh(paragraphs: ParagraphEntry[]): string {
  let out = '';
  for (let i = 0; i < paragraphs.length; i++) {
    out += paragraphs[i].zhText + paragraphs[i].trailingNewlines;
  }
  return out;
}

function splitWhitespace(text: string) {
  const trimmed = text.trimStart();
  const coreText = trimmed.trimEnd();
  return { leadWs: text.slice(0, text.length - trimmed.length), coreText, trailWs: trimmed.slice(coreText.length) };
}

export class ThoughtTranslator extends EventEmitter {
  private states = new Map<string, ThoughtBlockState>();
  private nextEpoch = 0;

  constructor(private translate?: ThoughtTranslateFn) { super(); }

  private clearTimer(state?: ThoughtBlockState): void {
    if (state?.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  private refreshDerivedFields(state: ThoughtBlockState): void {
    const { block } = state;
    block.languageDetected = detectThoughtLanguage(block.originalText);
    block.translatedZhText = state.finalizedZh + block.originalText.slice(state.translatedOffset);

    const remaining = block.originalText.slice(state.inFlightRange?.end ?? state.translatedOffset);
    const tailNeedsTranslation = Boolean(this.translate) && needsModelTranslation(remaining);
    block.isTranslating = Boolean(
      state.inFlightRange || state.inFlightRefineCount > 0 || (tailNeedsTranslation && state.idleTimer)
    );

    if (state.hasTranslatedSegment && state.lastSource) {
      block.translationSource = state.lastSource;
    } else if (block.languageDetected === 'zh' || (!needsModelTranslation(block.originalText) && block.languageDetected !== 'en')) {
      block.translationSource = 'native-zh';
    } else {
      block.translationSource = 'pending';
    }
  }

  /**
   * 将一段已定稿的切片并入逐段账本。返回因换行闭合的段落（供判断是否触发二阶段整段重译）。
   */
  private recordFinalizedSegment(
    state: ThoughtBlockState,
    start: number,
    end: number,
    zhSegment: string,
    wasModelTranslated: boolean
  ): ParagraphEntry | undefined {
    const rawSegment = state.block.originalText.slice(start, end);
    const nlTailMatch = /((?:\r?\n)+)$/.exec(rawSegment);
    const trailingNewlines = nlTailMatch ? nlTailMatch[1] : '';
    const contentEnd = end - trailingNewlines.length;
    const zhContent =
      trailingNewlines && zhSegment.endsWith(trailingNewlines)
        ? zhSegment.slice(0, zhSegment.length - trailingNewlines.length)
        : zhSegment;

    const last = state.paragraphs[state.paragraphs.length - 1];

    // 纯换行切片：闭合上一个未闭合段落
    if (contentEnd === start && trailingNewlines) {
      if (last && !last.closed) {
        last.trailingNewlines += trailingNewlines;
        last.closed = true;
        state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
        return last;
      }
      state.paragraphs.push({
        origStart: start,
        origEnd: start,
        zhText: '',
        trailingNewlines,
        translatedPieceCount: 0,
        closed: true,
        refineScheduled: false,
      });
      state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
      return undefined;
    }

    if (wasModelTranslated) {
      if (last && !last.closed && last.translatedPieceCount >= 1) {
        last.origEnd = contentEnd;
        last.zhText += zhContent;
        last.trailingNewlines += trailingNewlines;
        last.translatedPieceCount += 1;
        if (trailingNewlines) last.closed = true;
        state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
        return last.closed ? last : undefined;
      }
      const entry: ParagraphEntry = {
        origStart: start,
        origEnd: contentEnd,
        zhText: zhContent,
        trailingNewlines,
        translatedPieceCount: 1,
        closed: Boolean(trailingNewlines),
        refineScheduled: false,
      };
      state.paragraphs.push(entry);
      state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
      return entry.closed ? entry : undefined;
    }

    // 无需翻译的片段（如行首空白、中文段、代码块或异常原文保留）
    if (last && !last.closed && last.translatedPieceCount >= 1) {
      last.origEnd = contentEnd;
      last.zhText += zhContent;
      last.trailingNewlines += trailingNewlines;
      if (trailingNewlines) last.closed = true;
      state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
      return last.closed ? last : undefined;
    }

    state.paragraphs.push({
      origStart: start,
      origEnd: contentEnd,
      zhText: zhContent,
      trailingNewlines,
      translatedPieceCount: 0,
      closed: Boolean(trailingNewlines),
      refineScheduled: false,
    });
    state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
    return undefined;
  }

  /**
   * 仅当同一段落在流式阶段确实被拆成 >= 2 段翻译碎片且总长 <= 1200 字符时，
   * 触发一次受 epoch 保护的后台整段重译覆写；一次完整译出的段落绝不重复调用。
   */
  private maybeRefineParagraph(id: string, state: ThoughtBlockState, entry?: ParagraphEntry): void {
    if (!this.translate || !entry) return;
    if (!entry.closed || entry.refineScheduled) return;
    if (entry.translatedPieceCount < 2) return;

    const rawParagraph = state.block.originalText.slice(entry.origStart, entry.origEnd);
    if (!rawParagraph || rawParagraph.length > MAX_PARAGRAPH_REFINE_CHARS) return;
    if (!needsModelTranslation(rawParagraph)) return;

    const { leadWs, coreText, trailWs } = splitWhitespace(rawParagraph);
    if (!coreText) return;

    entry.refineScheduled = true;
    state.inFlightRefineCount += 1;
    void this.refineParagraph(id, state, entry, leadWs, coreText, trailWs, state.epoch);
  }

  private closeOpenParagraphOnComplete(id: string, state: ThoughtBlockState): void {
    if (state.inFlightRange || state.block.isStreaming) return;
    if (state.translatedOffset < state.block.originalText.length) return;
    const last = state.paragraphs[state.paragraphs.length - 1];
    if (last && !last.closed) {
      last.closed = true;
      this.maybeRefineParagraph(id, state, last);
    }
  }

  private async refineParagraph(
    id: string,
    state: ThoughtBlockState,
    entry: ParagraphEntry,
    leadWs: string,
    coreText: string,
    trailWs: string,
    epoch: number
  ): Promise<void> {
    try {
      const rawResult = await this.translate!(coreText, id, state.controller.signal);
      if (this.states.get(id) !== state || state.epoch !== epoch) return;

      state.inFlightRefineCount = Math.max(0, state.inFlightRefineCount - 1);
      const normalized = normalizeTranslateResult(rawResult);
      const cleanFinal = cleanTranslationEnvelope(normalized.text, coreText);
      if (cleanFinal) {
        entry.zhText = `${leadWs}${cleanFinal}${trailWs}`;
        state.finalizedZh = rebuildFinalizedZh(state.paragraphs);
        state.hasTranslatedSegment = true;
        state.lastSource = normalized.source;
      }
      this.refreshDerivedFields(state);
      this.emit('block', { ...state.block });
    } catch {
      if (this.states.get(id) !== state || state.epoch !== epoch) return;
      state.inFlightRefineCount = Math.max(0, state.inFlightRefineCount - 1);
      this.refreshDerivedFields(state);
      this.emit('block', { ...state.block });
    }
  }

  /** 没有出现自然断句时，短暂停顿也能触发一次尾段翻译。每次重新计时都绑定到当前思考块。 */
  private armIdleFlush(id: string, state: ThoughtBlockState): void {
    this.clearTimer(state);
    if (!this.translate || !state.block.isStreaming) return;
    const remaining = state.block.originalText.slice(state.inFlightRange?.end ?? state.translatedOffset);
    if (!needsModelTranslation(remaining) || !hasBalancedCodeSpans(remaining)) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (this.states.get(id) !== state) return;
      this.pump(id, state, true, true);
    }, STREAM_IDLE_FLUSH_MS);
    state.idleTimer.unref?.();
  }

  private pump(id: string, state: ThoughtBlockState, flushAll: boolean, emitIfChanged: boolean): void {
    if (!this.translate) {
      state.finalizedZh = state.block.originalText;
      state.translatedOffset = state.block.originalText.length;
      this.refreshDerivedFields(state);
      return;
    }

    let advancedSync = false;
    // 无需翻译的区段同步推进偏移。遇到需翻译的区段后等其完成再处理下一段，使译文顺序与原文一致。
    while (!state.inFlightRange && state.translatedOffset < state.block.originalText.length) {
      const cut = findNextSegmentEnd(
        state.block.originalText,
        state.translatedOffset,
        flushAll || !state.block.isStreaming
      );
      if (cut === null || cut <= state.translatedOffset) break;

      const segment = state.block.originalText.slice(state.translatedOffset, cut);
      if (!needsModelTranslation(segment)) {
        const closedEntry = this.recordFinalizedSegment(state, state.translatedOffset, cut, segment, false);
        state.translatedOffset = cut;
        advancedSync = true;
        if (closedEntry) {
          this.maybeRefineParagraph(id, state, closedEntry);
        }
        continue;
      }

      this.clearTimer(state);
      void this.translateSegment(id, state, state.translatedOffset, cut, state.epoch);
      break;
    }

    this.closeOpenParagraphOnComplete(id, state);

    if (!state.inFlightRange && state.block.isStreaming) {
      this.armIdleFlush(id, state);
    }

    this.refreshDerivedFields(state);
    if (emitIfChanged && advancedSync) {
      this.emit('block', { ...state.block });
    }
  }

  private async translateSegment(
    id: string,
    state: ThoughtBlockState,
    start: number,
    end: number,
    epoch: number
  ): Promise<void> {
    const rawSegment = state.block.originalText.slice(start, end);
    // 把首尾空白留在本地，翻译完成后原样拼回，避免多段回答的空格和换行随模型输出漂移。
    const { leadWs, coreText, trailWs } = splitWhitespace(rawSegment);

    state.inFlightRange = { start, end };
    state.block.isTranslating = true;

    try {
      const rawResult = await this.translate!(coreText, id, state.controller.signal);

      // 等待译文期间原块可能被清理或重新打开，写回时必须核对对象身份和代次。
      if (this.states.get(id) !== state || state.epoch !== epoch) return;

      const normalized = normalizeTranslateResult(rawResult);
      const cleanFinal = cleanTranslationEnvelope(normalized.text, coreText);
      state.inFlightRange = undefined;

      if (cleanFinal) {
        const closedEntry = this.recordFinalizedSegment(
          state,
          start,
          end,
          `${leadWs}${cleanFinal}${trailWs}`,
          true
        );
        state.translatedOffset = end;
        state.hasTranslatedSegment = true;
        state.lastSource = normalized.source;
        if (closedEntry) {
          this.maybeRefineParagraph(id, state, closedEntry);
        }
        this.pump(id, state, !state.block.isStreaming, false);
        this.refreshDerivedFields(state);
        this.emit('block', { ...state.block });
      } else {
        // 译文为空（如离线兜底）：保留干净原文推进游标，避免死循环重试
        const closedEntry = this.recordFinalizedSegment(state, start, end, rawSegment, false);
        state.translatedOffset = end;
        if (closedEntry) {
          this.maybeRefineParagraph(id, state, closedEntry);
        }
        this.pump(id, state, !state.block.isStreaming, false);
        this.refreshDerivedFields(state);
        this.emit('block', { ...state.block });
      }
    } catch {
      if (this.states.get(id) !== state || state.epoch !== epoch) return;
      state.inFlightRange = undefined;
      const closedEntry = this.recordFinalizedSegment(state, start, end, rawSegment, false);
      state.translatedOffset = end;
      if (closedEntry) {
        this.maybeRefineParagraph(id, state, closedEntry);
      }
      this.pump(id, state, !state.block.isStreaming, false);
      this.refreshDerivedFields(state);
      this.emit('block', { ...state.block });
    }
  }

  append(id: string, chunk: string): DualTrackThoughtBlock {
    let state = this.states.get(id);
    if (!state) {
      const initialLanguage = detectThoughtLanguage(chunk);
      state = {
        block: {
          id,
          originalText: chunk,
          translatedZhText: chunk,
          isStreaming: true,
          isTranslating: false,
          languageDetected: initialLanguage,
          translationSource: initialLanguage === 'zh' ? 'native-zh' : 'pending',
        },
        epoch: ++this.nextEpoch,
        controller: new AbortController(),
        translatedOffset: 0,
        finalizedZh: '',
        paragraphs: [],
        inFlightRefineCount: 0,
        hasTranslatedSegment: false,
      };
      this.states.set(id, state);
    } else {
      if (!state.block.isStreaming) {
        // 已 complete 的思考块被新分片重新打开：失效旧的未决尾部请求与重译回调，已落袋的前序译文保留
        state.block.isStreaming = true;
        state.controller.abort();
        state.controller = new AbortController();
        state.epoch = ++this.nextEpoch;
        state.inFlightRange = undefined;
        state.inFlightRefineCount = 0;
        const last = state.paragraphs[state.paragraphs.length - 1];
        if (last && last.closed && !last.trailingNewlines) {
          last.closed = false;
          last.refineScheduled = false;
        }
      }
      state.block.originalText += chunk;
    }

    this.pump(id, state, false, false);
    this.emit('block', { ...state.block });
    return { ...state.block };
  }

  complete(id: string): DualTrackThoughtBlock | undefined {
    const state = this.states.get(id);
    if (!state) return undefined;
    this.clearTimer(state);
    state.block.isStreaming = false;
    this.pump(id, state, true, false);
    this.emit('block', { ...state.block });
    return { ...state.block };
  }

  clear(id: string): void {
    const state = this.states.get(id);
    if (state) {
      this.clearTimer(state);
      state.controller.abort();
      state.epoch = ++this.nextEpoch;
      this.states.delete(id);
    }
  }

  dispose(): void {
    for (const id of [...this.states.keys()]) {
      this.clear(id);
    }
  }
}

import React, { createContext, useContext, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Copy, FileText, Info, Lightbulb, ShieldAlert, type LucideIcon } from 'lucide-react';
import { ImageSessionContext, ImageWorkspace, MessageImage, resolveImage } from './MessageImage';
import {
  extractLineAnchorBadge,
  extractTargetBaseName,
  isPlausibleLocalFileCandidate,
  isPreviewableImagePath,
  isSupportedPreviewImageExt,
  stripLocalTargetAnchor,
  type MessageAttachmentPreview,
} from '@shared';
import {
  MediaGallery,
  TargetLink,
  classifyPreviewCandidates,
  decodeLocalTarget,
  isAbsoluteLocalPath,
  isLocalTargetSource,
  resolveSafeHref,
  useLocalTargetInspection,
  type LocalTargetInspection,
  type PreviewCandidate,
  type SafeHref,
} from './MediaGallery';
import { useFluidStreamText } from '../hooks/useFluidStreamText';
import { useI18n } from '../i18n/I18nContext';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { Icon as UiIcon } from './ui/Icon';

export { resolveSafeHref };

/**
 * 零 innerHTML、完整 GFM 兼容的安全 Markdown + 数学公式渲染器：
 * 支持：GFM 表格（含对齐、反引号内管道符、单元格 <br>）、超链接（[text](url)、[text][ref]、<url>、裸 URL 自动识别、file:// 本地文件定位）、
 * 图片、h1–h6 标题、多级嵌套有序/无序列表（保留起始序号）、GFM 任务复选框（- [ ] / - [x]）、
 * GitHub Alerts（[!NOTE]/[!TIP]/[!IMPORTANT]/[!WARNING]/[!CAUTION]）、递归引用块、<details> 折叠块、
 * 任意长度 ``` / ~~~ 围栏代码块（含 diff/语法着色与复制）、行内多反引号代码、粗体/斜体/删除线、<kbd>、上下标及 LaTeX 数学公式。
 */

export type TableAlign = 'left' | 'center' | 'right' | null;
export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

interface LinkDef {
  url: string;
  title?: string;
}

interface ListItemNode {
  checked?: boolean;
  blocks: Block[];
}

type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'math-block'; expr: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'table'; headers: string[]; aligns: TableAlign[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; start?: number; items: ListItemNode[] }
  | { kind: 'alert'; alertKind: AlertKind; children: Block[] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'details'; summary: string; children: Block[] }
  | { kind: 'hr' }
  | { kind: 'para'; text: string };

/* ============================================================================
 * GFM 表格行切分（忽略反引号内部与 \| 转义的管道符）
 * ========================================================================== */

export function splitTableRow(rawLine: string): string[] {
  const cells: string[] = [];
  let buf = '';
  let i = 0;
  let tickLen = 0;

  while (i < rawLine.length) {
    const ch = rawLine[i];
    if (ch === '\\' && i + 1 < rawLine.length && tickLen === 0) {
      const next = rawLine[i + 1];
      if (next === '|' || next === '\\') {
        buf += next;
        i += 2;
        continue;
      }
    }
    // 记住打开行内代码时连续反引号的个数，只有相同长度才闭合，因此代码示例中的竖线仍属于同一个单元格。
    if (ch === '`') {
      let run = 1;
      while (i + run < rawLine.length && rawLine[i + run] === '`') run++;
      if (tickLen === 0) tickLen = run;
      else if (run === tickLen) tickLen = 0;
      buf += rawLine.slice(i, i + run);
      i += run;
      continue;
    }
    if (ch === '|' && tickLen === 0) {
      cells.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  cells.push(buf.trim());

  const trimmedLine = rawLine.trim();
  if (trimmedLine.startsWith('|') && cells.length > 0 && cells[0] === '') {
    cells.shift();
  }
  if (trimmedLine.endsWith('|') && !trimmedLine.endsWith('\\|') && cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop();
  }
  return cells;
}

function hasUnescapedPipeOutsideCode(line: string): boolean {
  let i = 0;
  let tickLen = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length && tickLen === 0) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (i + run < line.length && line[i + run] === '`') run++;
      if (tickLen === 0) tickLen = run;
      else if (run === tickLen) tickLen = 0;
      i += run;
      continue;
    }
    if (ch === '|' && tickLen === 0) return true;
    i += 1;
  }
  return false;
}

function parseTableAlignRow(line: string): TableAlign[] | null {
  if (!hasUnescapedPipeOutsideCode(line)) return null;
  const cells = splitTableRow(line);
  const trimmed = line.trim();
  const hasOuterPipe = trimmed.startsWith('|') || trimmed.endsWith('|');
  if (cells.length === 0 || (!hasOuterPipe && cells.length < 2)) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

/* ============================================================================
 * 链接引用定义预处理与块级语法树解析
 * ========================================================================== */

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})\s*([^\n]*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;
const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const LINK_DEF_RE = /^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+["'(]([^"')]+)["')])?\s*$/;
const ALERT_HEAD_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;

function indentColumns(ws: string): number {
  let cols = 0;
  for (const ch of ws) cols += ch === '\t' ? 4 : 1;
  return cols;
}

function stripIndentColumns(line: string, maxCols: number): string {
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < maxCols) {
    if (line[idx] === ' ') {
      cols += 1;
      idx += 1;
    } else if (line[idx] === '\t') {
      cols += 4;
      idx += 1;
    } else {
      break;
    }
  }
  return line.slice(idx);
}

/** 先收集整篇文档的引用式链接，正文可在定义之前引用它。围栏内逐行保留，代码样例中的定义行也原样显示。 */
function extractLinkDefinitions(rawLines: string[]): { lines: string[]; refs: Map<string, LinkDef> } {
  const refs = new Map<string, LinkDef>();
  const kept: string[] = [];
  let inFence: { char: string; len: number } | null = null;

  for (const line of rawLines) {
    if (inFence) {
      kept.push(line);
      const closeRe = new RegExp(`^\\s*${inFence.char}{${inFence.len},}\\s*$`);
      if (closeRe.test(line)) inFence = null;
      continue;
    }
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      inFence = { char: fence[2][0], len: fence[2].length };
      kept.push(line);
      continue;
    }
    const def = LINK_DEF_RE.exec(line);
    if (def && resolveSafeHref(def[2])) {
      refs.set(def[1].trim().toLowerCase(), { url: def[2].trim(), title: def[3]?.trim() });
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, refs };
}

/** 表头和下一行的对齐标记必须同列数。单有竖线的普通文本可以继续按段落解析。 */
function isTableStartAt(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  if (!hasUnescapedPipeOutsideCode(lines[idx])) return false;
  const headerCells = splitTableRow(lines[idx]);
  if (headerCells.length === 0) return false;
  const aligns = parseTableAlignRow(lines[idx + 1]);
  return aligns !== null && aligns.length === headerCells.length;
}

function parseBlocksFromLines(lines: string[], refs: Map<string, LinkDef>, depth = 0): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 1. 围栏代码块（``` / ```` / ~~~）
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const fenceChar = fence[2][0];
      const fenceLen = fence[2].length;
      const lang = (fence[3].trim().split(/\s+/)[0] || '').toLowerCase();
      // 结束围栏必须与开头同字符且长度足够。流式正文暂未给出结束标记时，先把已收到的行作为代码内容。
      const closeRe = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      if (lang === 'math' || lang === 'latex' || lang === 'tex') {
        blocks.push({ kind: 'math-block', expr: body.join('\n').trim() });
      } else {
        blocks.push({ kind: 'code', lang, text: body.join('\n') });
      }
      continue;
    }

    // 2. 块级数学公式 $$...$$ 或 \[...\]
    const singleDollarMath = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
    if (singleDollarMath) {
      blocks.push({ kind: 'math-block', expr: singleDollarMath[1].trim() });
      i += 1;
      continue;
    }
    const singleBracketMath = /^\s*\\\[(.+?)\\\]\s*$/.exec(line);
    if (singleBracketMath) {
      blocks.push({ kind: 'math-block', expr: singleBracketMath[1].trim() });
      i += 1;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line) || /^\s*\\\[\s*$/.test(line)) {
      const isDollar = line.includes('$$');
      const closeRe = isDollar ? /^\s*\$\$\s*$/ : /^\s*\\\]\s*$/;
      const exprLines: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i])) {
        exprLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'math-block', expr: exprLines.join('\n').trim() });
      continue;
    }

    // 3. <details><summary>...</summary>...</details> 折叠块
    if (depth < 5 && /^\s*<details(?:\s[^>]*)?>\s*$/i.test(line)) {
      i += 1;
      // 缺省标题留空，渲染时按界面语言显示「详情 / Details」。
      let summary = '';
      if (i < lines.length) {
        const sumMatch = /^\s*<summary>(.*?)<\/summary>\s*$/i.exec(lines[i]);
        if (sumMatch) {
          summary = sumMatch[1].trim() || summary;
          i += 1;
        }
      }
      const inner: string[] = [];
      let nestedDetails = 0;
      while (i < lines.length) {
        if (/^\s*<details(?:\s[^>]*)?>\s*$/i.test(lines[i])) nestedDetails++;
        if (/^\s*<\/details>\s*$/i.test(lines[i])) {
          if (nestedDetails === 0) {
            i += 1;
            break;
          }
          nestedDetails--;
        }
        inner.push(lines[i]);
        i += 1;
      }
      blocks.push({
        kind: 'details',
        summary,
        children: parseBlocksFromLines(inner, refs, depth + 1),
      });
      continue;
    }

    // 4. ATX 标题 h1–h6
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    // 5. GFM 表格（优先于 HR 检查，避免对齐行干扰）
    if (isTableStartAt(lines, i)) {
      const headers = splitTableRow(lines[i]);
      const aligns = parseTableAlignRow(lines[i + 1])!;
      const rows: string[][] = [];
      i += 2;
      while (
        i < lines.length &&
        lines[i].trim() &&
        hasUnescapedPipeOutsideCode(lines[i]) &&
        !FENCE_OPEN_RE.test(lines[i]) &&
        !HEADING_RE.test(lines[i])
      ) {
        const cells = splitTableRow(lines[i]);
        const normalized = Array.from({ length: headers.length }, (_, col) =>
          col < cells.length
            ? col === headers.length - 1 && cells.length > headers.length
              ? cells.slice(col).join(' | ')
              : cells[col]
            : ''
        );
        rows.push(normalized);
        i += 1;
      }
      blocks.push({ kind: 'table', headers, aligns, rows });
      continue;
    }

    // 6. 水平分隔线
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // 7. GitHub Alerts 与递归引用块
    if (QUOTE_RE.test(line) && depth < 6) {
      const rawQuoteLines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        rawQuoteLines.push(lines[i].replace(QUOTE_RE, '$1'));
        i += 1;
      }
      const alertMatch = rawQuoteLines.length > 0 ? ALERT_HEAD_RE.exec(rawQuoteLines[0]) : null;
      if (alertMatch) {
        const alertKind = alertMatch[1].toLowerCase() as AlertKind;
        const firstRest = alertMatch[2].trim();
        const bodyLines = firstRest ? [firstRest, ...rawQuoteLines.slice(1)] : rawQuoteLines.slice(1);
        blocks.push({
          kind: 'alert',
          alertKind,
          children: parseBlocksFromLines(bodyLines, refs, depth + 1),
        });
      } else {
        blocks.push({
          kind: 'quote',
          children: parseBlocksFromLines(rawQuoteLines, refs, depth + 1),
        });
      }
      continue;
    }

    // 8. 多级有序/无序列表 + GFM 任务列表
    const listMatch = LIST_ITEM_RE.exec(line);
    if (listMatch && depth < 8) {
      const baseIndent = indentColumns(listMatch[1]);
      const ordered = /^\d/.test(listMatch[2]);
      const startNum = ordered ? parseInt(listMatch[2], 10) : undefined;
      const items: ListItemNode[] = [];

      // 以首项缩进和有序类型界定同级列表。更深的续行收集到当前项，再递归解析其中的块。
      while (i < lines.length) {
        const curMatch = LIST_ITEM_RE.exec(lines[i]);
        if (!curMatch) break;
        const curIndent = indentColumns(curMatch[1]);
        const curOrdered = /^\d/.test(curMatch[2]);
        if (curIndent > baseIndent + 1 || curIndent < Math.max(0, baseIndent - 1) || curOrdered !== ordered) {
          break;
        }

        let firstText = curMatch[3];
        let checked: boolean | undefined;
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(firstText);
        if (taskMatch) {
          checked = taskMatch[1].toLowerCase() === 'x';
          firstText = taskMatch[2];
        }

        const itemLines: string[] = [firstText];
        const childIndent = curIndent + 2;
        i += 1;

        while (i < lines.length) {
          const nextLine = lines[i];
          if (!nextLine.trim()) {
            // 空行后仅当后续存在更深缩进内容或同级列表项时继续
            let look = i + 1;
            while (look < lines.length && !lines[look].trim()) look++;
            if (look >= lines.length) break;
            const afterBlank = lines[look];
            const afterIndent = indentColumns((/^(\s*)/.exec(afterBlank) || ['', ''])[1]);
            if (afterIndent >= childIndent) {
              itemLines.push('');
              i += 1;
              continue;
            }
            const nextSibling = LIST_ITEM_RE.exec(afterBlank);
            if (
              nextSibling &&
              indentColumns(nextSibling[1]) <= baseIndent + 1 &&
              indentColumns(nextSibling[1]) >= Math.max(0, baseIndent - 1) &&
              /^\d/.test(nextSibling[2]) === ordered
            ) {
              i = look;
            }
            break;
          }

          const nextIndent = indentColumns((/^(\s*)/.exec(nextLine) || ['', ''])[1]);
          const nextList = LIST_ITEM_RE.exec(nextLine);
          if (nextList && nextIndent <= baseIndent + 1) {
            break;
          }
          if (
            nextIndent <= baseIndent &&
            (FENCE_OPEN_RE.test(nextLine) ||
              HEADING_RE.test(nextLine) ||
              HR_RE.test(nextLine) ||
              QUOTE_RE.test(nextLine) ||
              isTableStartAt(lines, i))
          ) {
            break;
          }
          itemLines.push(nextIndent >= childIndent ? stripIndentColumns(nextLine, childIndent) : nextLine.trimStart());
          i += 1;
        }

        items.push({
          checked,
          blocks: parseBlocksFromLines(itemLines, refs, depth + 1),
        });
      }

      blocks.push({ kind: 'list', ordered, start: startNum, items });
      continue;
    }

    // 9. Setext 标题（段落 + === / ---）与普通段落
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_OPEN_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_ITEM_RE.test(lines[i]) &&
      !isTableStartAt(lines, i) &&
      !/^\s*(?:\$\$|\\\[)/.test(lines[i]) &&
      !/^\s*<details(?:\s[^>]*)?>\s*$/i.test(lines[i])
    ) {
      if (para.length > 0 && /^\s{0,3}(={3,}|-{3,})\s*$/.test(lines[i])) {
        const isH1 = lines[i].trim().startsWith('=');
        blocks.push({ kind: 'heading', level: isH1 ? 1 : 2, text: para.join(' ').trim() });
        para.length = 0;
        i += 1;
        break;
      }
      if (para.length > 0 && HR_RE.test(lines[i])) {
        break;
      }
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) {
      blocks.push({ kind: 'para', text: para.join('\n') });
    }
  }

  return blocks;
}

/** 文档先统一换行并抽出引用定义，再构造块结构。行内强调、链接与代码在渲染对应块时处理。 */
function parseDocument(source: string): { blocks: Block[]; refs: Map<string, LinkDef> } {
  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');
  const { lines, refs } = extractLinkDefinitions(rawLines);
  return { blocks: parseBlocksFromLines(lines, refs, 0), refs };
}

/* ============================================================================
 * 轻量零字体依赖 LaTeX 数学公式渲染（分式、根号、上下标、希腊字母与运算符）
 * ========================================================================== */

const LATEX_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', star: '⋆', ast: '∗',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⟺', mapsto: '↦', implies: '⟹',
  uparrow: '↑', downarrow: '↓',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  infty: '∞', partial: '∂', nabla: '∇', ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ',
  aleph: 'ℵ', wp: '℘', angle: '∠', perp: '⊥', parallel: '∥', triangle: '△',
  dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
  cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  min: 'min', max: 'max', sup: 'sup', inf: 'inf', lim: 'lim', arg: 'arg', det: 'det', dim: 'dim',
  quad: '  ', qquad: '    ',
};

function readBracedGroup(src: string, startIdx: number): { content: string; nextIdx: number } | null {
  let i = startIdx;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (i >= src.length || src[i] !== '{') return null;
  let depth = 1;
  let k = i + 1;
  while (k < src.length && depth > 0) {
    if (src[k] === '\\' && k + 1 < src.length) {
      k += 2;
      continue;
    }
    if (src[k] === '{') depth++;
    else if (src[k] === '}') depth--;
    k++;
  }
  return { content: src.slice(i + 1, Math.max(i + 1, k - 1)), nextIdx: k };
}

/** 用 React 节点表示受支持的数学记号。嵌套超过限制后保留表达式文本，使复杂输入也能显示。 */
function renderMathTokens(expr: string, keyPrefix: string, depth = 0): React.ReactNode[] {
  if (depth > 6) return [expr];
  const out: React.ReactNode[] = [];
  let i = 0;
  let n = 0;

  const readScriptAtom = (pos: number): { node: React.ReactNode; nextIdx: number } => {
    const grp = readBracedGroup(expr, pos);
    if (grp) {
      return {
        node: renderMathTokens(grp.content, `${keyPrefix}-g${n++}`, depth + 1),
        nextIdx: grp.nextIdx,
      };
    }
    let p = pos;
    while (p < expr.length && /\s/.test(expr[p])) p++;
    if (p < expr.length && expr[p] === '\\') {
      const cmd = /^\\([A-Za-z]+)/.exec(expr.slice(p));
      if (cmd) {
        return {
          node: LATEX_SYMBOLS[cmd[1]] ?? cmd[1],
          nextIdx: p + cmd[0].length,
        };
      }
    }
    return { node: expr[p] || '', nextIdx: Math.min(expr.length, p + 1) };
  };

  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '{' || ch === '}') {
      i += 1;
      continue;
    }
    if ((ch === '^' || ch === '_') && i + 1 < expr.length) {
      const { node, nextIdx } = readScriptAtom(i + 1);
      out.push(
        ch === '^' ? (
          <sup key={`${keyPrefix}-sup${n++}`}>{node}</sup>
        ) : (
          <sub key={`${keyPrefix}-sub${n++}`}>{node}</sub>
        )
      );
      i = nextIdx;
      continue;
    }
    if (ch === '\\') {
      const spaceEsc = /^\\([,;!: ])/.exec(expr.slice(i));
      if (spaceEsc) {
        if (spaceEsc[1] !== '!') out.push(' ');
        i += 2;
        continue;
      }
      if (expr.slice(i, i + 2) === '\\\\') {
        out.push(<br key={`${keyPrefix}-mbr${n++}`} />);
        i += 2;
        continue;
      }
      const braceEsc = /^\\([{}%$&_#])/.exec(expr.slice(i));
      if (braceEsc) {
        out.push(braceEsc[1]);
        i += 2;
        continue;
      }
      const cmdMatch = /^\\([A-Za-z]+)/.exec(expr.slice(i));
      if (cmdMatch) {
        const cmd = cmdMatch[1];
        const afterCmd = i + cmdMatch[0].length;
        if (cmd === 'left' || cmd === 'right' || cmd === 'big' || cmd === 'Big' || cmd === 'bigl' || cmd === 'bigr') {
          i = afterCmd;
          if (i < expr.length && expr[i] === '.') i += 1;
          continue;
        }
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
          const num = readBracedGroup(expr, afterCmd);
          const den = num ? readBracedGroup(expr, num.nextIdx) : null;
          if (num && den) {
            out.push(
              <span key={`${keyPrefix}-frac${n++}`} className="md-frac">
                <span className="md-frac-num">{renderMathTokens(num.content, `${keyPrefix}-fn${n}`, depth + 1)}</span>
                <span className="md-frac-den">{renderMathTokens(den.content, `${keyPrefix}-fd${n}`, depth + 1)}</span>
              </span>
            );
            i = den.nextIdx;
            continue;
          }
        }
        if (cmd === 'sqrt') {
          let cursor = afterCmd;
          let rootDeg: string | undefined;
          if (expr[cursor] === '[') {
            const closeBracket = expr.indexOf(']', cursor + 1);
            if (closeBracket > cursor) {
              rootDeg = expr.slice(cursor + 1, closeBracket);
              cursor = closeBracket + 1;
            }
          }
          const rad = readBracedGroup(expr, cursor);
          if (rad) {
            out.push(
              <span key={`${keyPrefix}-sqrt${n++}`} className="md-sqrt">
                {rootDeg && <sup className="md-sqrt-deg">{rootDeg}</sup>}
                <span className="md-sqrt-sign">√</span>
                <span className="md-sqrt-body">{renderMathTokens(rad.content, `${keyPrefix}-sr${n}`, depth + 1)}</span>
              </span>
            );
            i = rad.nextIdx;
            continue;
          }
        }
        if (
          cmd === 'text' ||
          cmd === 'textrm' ||
          cmd === 'mathrm' ||
          cmd === 'mathbf' ||
          cmd === 'textbf' ||
          cmd === 'mathit' ||
          cmd === 'mathcal' ||
          cmd === 'mathbb' ||
          cmd === 'operatorname'
        ) {
          const grp = readBracedGroup(expr, afterCmd);
          if (grp) {
            const isBold = cmd === 'mathbf' || cmd === 'textbf';
            const inner = renderMathTokens(grp.content, `${keyPrefix}-tx${n++}`, depth + 1);
            out.push(
              isBold ? (
                <strong key={`${keyPrefix}-mb${n++}`}>{inner}</strong>
              ) : (
                <span key={`${keyPrefix}-mt${n++}`} className={cmd === 'text' || cmd === 'textrm' ? 'md-math-roman' : undefined}>
                  {inner}
                </span>
              )
            );
            i = grp.nextIdx;
            continue;
          }
        }
        out.push(LATEX_SYMBOLS[cmd] ?? cmd);
        i = afterCmd;
        if (i < expr.length && expr[i] === ' ' && /^[A-Za-z]/.test(expr[i + 1] || '')) {
          i += 1;
        }
        continue;
      }
    }
    if (ch === '-') {
      out.push('−');
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out;
}

/* ============================================================================
 * 行内元素扫描器（代码、公式、图片、超链接、裸 URL、加粗、斜体、删除线、<br>/<kbd>）
 * ========================================================================== */

function parseBracketContent(text: string, openIdx: number): { label: string; closeIdx: number } | null {
  if (text[openIdx] !== '[') return null;
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      let run = 1;
      while (i + run < text.length && text[i + run] === '`') run++;
      const endTick = text.indexOf('`'.repeat(run), i + run);
      if (endTick >= 0) {
        i = endTick + run;
        continue;
      }
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { label: text.slice(openIdx + 1, i - 1), closeIdx: i - 1 };
}

function parseParenDestination(text: string, openParenIdx: number): { url: string; title?: string; closeIdx: number } | null {
  if (text[openParenIdx] !== '(') return null;
  let i = openParenIdx + 1;
  while (i < text.length && /\s/.test(text[i])) i++;

  if (text[i] === '<') {
    const closeAngle = text.indexOf('>', i + 1);
    if (closeAngle < 0) return null;
    const url = text.slice(i + 1, closeAngle);
    let k = closeAngle + 1;
    while (k < text.length && /\s/.test(text[k])) k++;
    let title: string | undefined;
    if (text[k] === '"' || text[k] === "'") {
      const q = text[k];
      const endQ = text.indexOf(q, k + 1);
      if (endQ < 0) return null;
      title = text.slice(k + 1, endQ);
      k = endQ + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
    }
    if (text[k] !== ')') return null;
    return { url, title, closeIdx: k };
  }

  let parenDepth = 0;
  const urlStart = i;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ')') {
      if (parenDepth === 0) break;
      parenDepth--;
      i++;
      continue;
    }
    if (/\s/.test(ch) && parenDepth === 0) {
      // 检查后面是否紧跟引号标题或直接闭合 )
      let k = i;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === ')') {
        return { url: text.slice(urlStart, i), closeIdx: k };
      }
      if (text[k] === '"' || text[k] === "'") {
        const q = text[k];
        const endQ = text.indexOf(q, k + 1);
        if (endQ > k) {
          let afterQ = endQ + 1;
          while (afterQ < text.length && /\s/.test(text[afterQ])) afterQ++;
          if (text[afterQ] === ')') {
            return { url: text.slice(urlStart, i), title: text.slice(k + 1, endQ), closeIdx: afterQ };
          }
        }
      }
    }
    i++;
  }
  if (i >= text.length || text[i] !== ')') return null;
  return { url: text.slice(urlStart, i).trim(), closeIdx: i };
}

/** 在链接节点保留目标类型和路径，右键菜单可复用这两个属性。桌面端的本地链接点击交给系统打开接口。 */
function renderAnchor(
  key: string,
  safe: SafeHref,
  children: React.ReactNode,
  explicitTitle?: string,
  lineBadge?: string
): React.ReactElement {
  return <TargetLink key={key} safe={safe} title={explicitTitle} lineBadge={lineBadge}>{children}</TargetLink>;
}

/** 本条消息的主进程检验结果。行内裸路径在确认不存在后回退为普通文字。 */
const InspectionContext = createContext<LocalTargetInspection | null>(null);

function InlineFileMention({
  safe,
  body,
  lineBadge,
  title,
  source,
  bare,
}: {
  safe: SafeHref | null;
  body: React.ReactNode;
  lineBadge?: string;
  title?: string;
  source: string;
  bare: boolean;
}) {
  const inspection = useContext(InspectionContext);
  const result = inspection && isLocalTargetSource(source) ? inspection.lookup(source) : undefined;
  if (result && typeof result === 'object') {
    if (result.kind === 'forbidden' || (bare && result.kind === 'missing')) {
      return <span className="md-path-text" title={title}>{body}</span>;
    }
  }
  if (!safe) return <span className="md-path-text" title={title}>{body}</span>;
  return <TargetLink safe={safe} title={title} lineBadge={lineBadge}>{body}</TargetLink>;
}

/** 独占一整段的 `![图注](path)`：原位渲染为居中媒体卡片，并从文末画廊去重。 */
function InlineFigure({ source, alt, title, displayUrl }: { source: string; alt: string; title?: string; displayUrl?: string }) {
  const inspection = useContext(InspectionContext);
  const { dict } = useI18n();
  const local = isLocalTargetSource(source) && !/^data:/i.test(source);
  const result = local && inspection ? inspection.lookup(source) : undefined;
  const meta = result && typeof result === 'object' ? result : undefined;
  const caption = alt || title || '';
  if (meta && (meta.kind === 'missing' || meta.kind === 'forbidden')) {
    return (
      <p className="md-figure-missing" data-testid="md-inline-figure-missing">
        <span>{caption || extractTargetBaseName(source)}</span>
        <span className="md-figure-missing-note">{dict.ui.v031.imageUnavailable}</span>
      </p>
    );
  }
  const url = displayUrl || meta?.previewDataUrl || meta?.fileUrl || undefined;
  const ext = meta?.ext || (/\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(source)?.[1] || '');
  const alpha = /^(?:png|svg|webp|gif|ico|avif)$/i.test(ext) || /^data:image\/(?:png|svg|webp|gif)/i.test(source);
  return (
    <figure className="md-inline-figure" data-testid="md-inline-figure">
      <div className={`md-inline-figure-stage ${alpha ? 'is-alpha' : ''}`.trim()}>
        <MessageImage source={source} alt={alt || extractTargetBaseName(source)} title={title} displayUrl={url} />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

function isImageLink(url: string): boolean {
  return isPreviewableImagePath(url);
}

interface FilePreview { source: string; label: string; image: boolean; title?: string; text?: string; origin: 'mention' | 'code' }
interface MarkdownContext {
  links: Map<string, LinkDef>;
  previews: Map<string, FilePreview>;
  workspace: string;
  headingPrefix: string;
  headingSlugs: Set<string>;
  /** 已在原位渲染为独立图卡的图片 key（从文末画廊去重） */
  figureKeys: Set<string>;
  figureSources: string[];
  attachmentsByKey: Map<string, MessageAttachmentPreview>;
}

function inlineText(nodes: React.ReactNode): string {
  return React.Children.toArray(nodes).map(node =>
    React.isValidElement<{ children?: React.ReactNode }>(node) ? inlineText(node.props.children) : String(node)
  ).join('');
}

function headingId(content: React.ReactNode, ctx: MarkdownContext): string {
  const base = inlineText(content).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  let slug = base || 'section';
  for (let suffix = 1; ctx.headingSlugs.has(slug); suffix++) slug = (base || 'section') + '-' + suffix;
  ctx.headingSlugs.add(slug);
  return ctx.headingPrefix + slug;
}

/** 显式链接目标是否为带扩展名的本机绝对路径（允许空格，如 `</Users/alice/My Project/a.png>`）。 */
function isSpacedAbsoluteFile(path: string): boolean {
  return /\s/.test(path) && isAbsoluteLocalPath(path) && /\.[a-z0-9]{1,10}$/i.test(stripLocalTargetAnchor(path));
}

function isFileReference(path: string): boolean {
  if (path.startsWith('#')) return false;
  return isPreviewableImagePath(path) || isPlausibleLocalFileCandidate(path) || isSpacedAbsoluteFile(path) ||
    /^https?:\/\/[^\s]+\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|zip)(?:[?#].*)?$/i.test(path);
}

/** 预览去重 key：可解析时用规范化地址，否则（无工作区的相对路径）用 `unresolved:` 前缀保留文本引用。 */
function previewKey(source: string, workspace: string): string {
  const url = resolveImage(source, workspace);
  return url || (!workspace && !/^[a-z][\w+.-]*:|^[/\\]/i.test(source) ? 'unresolved:' + source : '');
}

function addPreview(ctx: MarkdownContext, item: FilePreview) {
  const url = resolveImage(item.source, ctx.workspace);
  const key = previewKey(item.source, ctx.workspace);
  if (key && !ctx.previews.has(key)) ctx.previews.set(key, item);
  return url;
}

interface FileMentionOptions {
  /** `[label](file)` 中的富文本标签 */
  labelNodes?: React.ReactNode;
  labelText?: string;
  title?: string;
  explicitImage?: boolean;
}

function fileMention(ctx: MarkdownContext, key: string, source: string, options: FileMentionOptions = {}) {
  const { labelNodes, labelText = '', title, explicitImage = false } = options;
  const embedded = /^(?:data|blob):/i.test(source);
  const name = labelText || extractTargetBaseName(source) || source;
  const url = addPreview(ctx, { source, label: name, image: explicitImage || isImageLink(source), title, origin: 'mention' });
  if (embedded) return <span key={key} className="md-path-text">{labelText || <UiIcon icon={FileText} size="xs" />}</span>;
  const hasLabel = Boolean(labelNodes) || Boolean(labelText);
  const body: React.ReactNode = labelNodes ?? (explicitImage ? name : source);
  // 无法解析为预览地址时，仅本机绝对路径（含 macOS `~/Desktop/...`，交给主进程展开主目录）仍可点击；`//host` 网络路径始终不可点击。
  const safe = url
    ? resolveSafeHref(source) || resolveSafeHref(url)
    : isAbsoluteLocalPath(source) ? resolveSafeHref(source) : null;
  const tooltip = title || (isLocalTargetSource(source) ? decodeLocalTarget(source) : source);
  return (
    <InlineFileMention
      key={key}
      safe={safe}
      body={body}
      lineBadge={hasLabel && !explicitImage ? extractLineAnchorBadge(source) : undefined}
      title={tooltip}
      source={source}
      bare={!hasLabel && !explicitImage}
    />
  );
}

/** 判断段落是否只由一张 Markdown 图片构成（允许首尾空白），返回其目标与图注。 */
function parseStandaloneImage(text: string, ctx: MarkdownContext): { alt: string; url: string; title?: string } | null {
  const t = text.trim();
  if (!t.startsWith('![') || /\n/.test(t)) return null;
  const label = parseBracketContent(t, 1);
  if (!label) return null;
  const after = label.closeIdx + 1;
  if (t[after] === '(') {
    const dest = parseParenDestination(t, after);
    if (!dest || dest.closeIdx !== t.length - 1) return null;
    return { alt: label.label, url: dest.url.trim(), title: dest.title };
  }
  const ref = t[after] === '[' ? parseBracketContent(t, after) : undefined;
  const end = ref ? ref.closeIdx + 1 : after;
  if (end !== t.length) return null;
  const def = ctx.links.get((ref?.label || label.label).trim().toLowerCase());
  return def ? { alt: label.label, url: def.url, title: def.title } : null;
}

function isRenderableFigureSource(url: string): boolean {
  if (/^data:image\//i.test(url)) return isPreviewableImagePath(url);
  if (/^(?:javascript|vbscript|mailto|blob):/i.test(url)) return false;
  if (/^https?:\/\//i.test(url)) return true;
  const base = extractTargetBaseName(url);
  const ext = /\.([a-z0-9]{2,5})$/i.exec(base)?.[1];
  return (isPlausibleLocalFileCandidate(url) || isSpacedAbsoluteFile(url)) && isSupportedPreviewImageExt(ext);
}

function renderInline(
  text: string,
  keyPrefix: string,
  refs: MarkdownContext,
  depth = 0
): React.ReactNode[] {
  if (!text) return [];
  if (depth > 6) return [text];
  const path = text.trim();
  if (depth === 0 && /^(?:[a-z]:[\\/]|file:\/\/\/|\.{0,2}[\\/])/i.test(path) &&
      !/[\r\n<>`*"|]/.test(path) && /\.[a-z0-9]{1,10}(?:#L\d+)?$/i.test(path) &&
      (!/\s/.test(path) || !/\.[a-z0-9]{1,10}\s/i.test(path)) && !/[，。；！？]/.test(path)) {
    return [fileMention(refs, keyPrefix + '-file', path)];
  }

  const nodes: React.ReactNode[] = [];
  let plain = '';
  let i = 0;
  let n = 0;

  // 连续普通字符先聚在一个缓冲里，遇到行内语法才输出一个文本节点，避免为逐字输出的内容创建大量节点。
  const flushPlain = () => {
    if (plain) {
      nodes.push(plain);
      plain = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    const closingQuote = ch === '“' ? '”' : ch === '「' ? '」' : ch === '"' || ch === "'" ? ch : '';
    if (closingQuote && depth === 0) {
      const end = text.indexOf(closingQuote, i + 1);
      const target = end > i ? text.slice(i + 1, end) : '';
      if (/^(?:[a-z]:[\\/]|file:\/\/\/|\.{0,2}[\\/])/i.test(target) &&
          !/[\r\n]/.test(target) && /\.[a-z0-9]{1,10}(?:#L\d+(?:-L?\d+)?)?$/i.test(target)) {
        flushPlain();
        nodes.push(ch, fileMention(refs, keyPrefix + n++, target), closingQuote);
        i = end + 1;
        continue;
      }
    }

    // 1. 反斜杠转义
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '(') {
        const closeMath = text.indexOf('\\)', i + 2);
        if (closeMath > i + 2) {
          flushPlain();
          const expr = text.slice(i + 2, closeMath);
          nodes.push(
            <span key={`${keyPrefix}-mi${n++}`} className="md-math-inline">
              {renderMathTokens(expr, `${keyPrefix}-mt${n}`)}
            </span>
          );
          i = closeMath + 2;
          continue;
        }
      }
      if (/^[\\`*_{}[\]()#+\-.!|~$<>]/.test(next)) {
        plain += next;
        i += 2;
        continue;
      }
    }

    // 2. 行内反引号代码（支持 ``code `inner` `` 与 `code`）
    if (ch === '`') {
      let run = 1;
      while (i + run < text.length && text[i + run] === '`') run++;
      const ticks = '`'.repeat(run);
      const closeIdx = text.indexOf(ticks, i + run);
      if (closeIdx >= 0) {
        flushPlain();
        let codeContent = text.slice(i + run, closeIdx);
        if (codeContent.length >= 2 && codeContent.startsWith(' ') && codeContent.endsWith(' ') && codeContent.trim()) {
          codeContent = codeContent.slice(1, -1);
        }
        if (!/[\r\n]/.test(codeContent) && isPlausibleLocalFileCandidate(codeContent)) addPreview(refs, { source: codeContent,
          label: extractTargetBaseName(codeContent) || codeContent, image: isImageLink(codeContent), origin: 'code' });
        nodes.push(
          <code key={`${keyPrefix}-c${n++}`} className="inline" data-inline-code={codeContent}>
            {codeContent}
          </code>
        );
        i = closeIdx + run;
        continue;
      }
      plain += ticks;
      i += run;
      continue;
    }

    // 3. 行内数学公式 $...$（严格禁止首尾空格及后接数字，防止误吞普通金额 $100）
    if (ch === '$' && text[i + 1] && text[i + 1] !== '$' && !/\s/.test(text[i + 1])) {
      let close = i + 2;
      let found = -1;
      while (close < text.length && text[close] !== '\n') {
        if (text[close] === '$' && text[close - 1] !== '\\' && !/\s/.test(text[close - 1])) {
          const after = text[close + 1] || '';
          if (!/[0-9A-Za-z]/.test(after)) {
            found = close;
            break;
          }
        }
        close++;
      }
      if (found > i + 1) {
        const expr = text.slice(i + 1, found);
        // 避免纯数字如 $100 被当作公式，除非包含数学符号/字母/运算符
        if (!/^\d+(?:[.,]\d+)?$/.test(expr)) {
          flushPlain();
          nodes.push(
            <span key={`${keyPrefix}-dm${n++}`} className="md-math-inline">
              {renderMathTokens(expr, `${keyPrefix}-dmt${n}`)}
            </span>
          );
          i = found + 1;
          continue;
        }
      }
    }

    // 4. 安全内联 HTML 标签（<br>、<kbd>、<sup>、<sub>）与尖括号自动链接 <https://...>
    if (ch === '<') {
      const imageTag = /^<img\b([^<>]{1,8192})\/?>/i.exec(text.slice(i));
      if (imageTag) {
        const attrs = new Map<string, string>();
        for (const match of imageTag[1].matchAll(/(?:^|\s)(src|alt|title)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/gi)) {
          attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
        }
        const src = attrs.get('src');
        if (src) {
          flushPlain();
          nodes.push(fileMention(refs, keyPrefix + n++, src, { labelText: attrs.get('alt'), title: attrs.get('title'), explicitImage: true }));
          i += imageTag[0].length;
          continue;
        }
      }
      const brMatch = /^<br\s*\/?>/i.exec(text.slice(i));
      if (brMatch) {
        flushPlain();
        nodes.push(<br key={`${keyPrefix}-br${n++}`} />);
        i += brMatch[0].length;
        continue;
      }
      const kbdMatch = /^<kbd>([^<\n]{1,40})<\/kbd>/i.exec(text.slice(i));
      if (kbdMatch) {
        flushPlain();
        nodes.push(
          <kbd key={`${keyPrefix}-kbd${n++}`} className="kbd">
            {kbdMatch[1]}
          </kbd>
        );
        i += kbdMatch[0].length;
        continue;
      }
      const supMatch = /^<sup>([^<\n]{1,40})<\/sup>/i.exec(text.slice(i));
      if (supMatch) {
        flushPlain();
        nodes.push(<sup key={`${keyPrefix}-sup${n++}`}>{supMatch[1]}</sup>);
        i += supMatch[0].length;
        continue;
      }
      const subMatch = /^<sub>([^<\n]{1,40})<\/sub>/i.exec(text.slice(i));
      if (subMatch) {
        flushPlain();
        nodes.push(<sub key={`${keyPrefix}-sub${n++}`}>{subMatch[1]}</sub>);
        i += subMatch[0].length;
        continue;
      }
      const autoLink = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+|file:\/\/\/[^\s<>]+)>/i.exec(text.slice(i));
      if (autoLink) {
        const safe = resolveSafeHref(autoLink[1]);
        if (safe) {
          flushPlain();
          const label = autoLink[1].replace(/^mailto:/i, '');
          if (isFileReference(autoLink[1])) nodes.push(fileMention(refs, keyPrefix + n++, autoLink[1]));
          else nodes.push(renderAnchor(`${keyPrefix}-al${n++}`, safe, label));
          i += autoLink[0].length;
          continue;
        }
      }
    }

    // Inline and reference-style images share the same workspace-aware viewer.
    if (ch === '!' && text[i + 1] === '[') {
      const label = parseBracketContent(text, i + 1);
      if (label) {
        const after = label.closeIdx + 1;
        let dest: LinkDef | null | undefined;
        let end = after;
        if (text[after] === '(') {
          const inline = parseParenDestination(text, after);
          dest = inline;
          if (inline) end = inline.closeIdx + 1;
        } else {
          const ref = text[after] === '[' ? parseBracketContent(text, after) : undefined;
          dest = refs.links.get((ref?.label || label.label).trim().toLowerCase());
          if (ref) end = ref.closeIdx + 1;
        }
        if (dest) {
          flushPlain();
          nodes.push(fileMention(refs, keyPrefix + n++, dest.url, { labelText: label.label, title: dest.title, explicitImage: true }));
          i = end;
          continue;
        }
      }
    }

    // 6. 超链接 [label](url "title") 与引用链接 [label][ref] / [label]
    if (ch === '[') {
      const bracket = parseBracketContent(text, i);
      if (bracket) {
        const afterBracket = bracket.closeIdx + 1;
        if (text[afterBracket] === '(') {
          const dest = parseParenDestination(text, afterBracket);
          if (dest) {
            const safe = resolveSafeHref(dest.url, refs.headingPrefix);
            flushPlain();
            const children = renderInline(bracket.label || dest.url, `${keyPrefix}-lk${n}`, refs, depth + 1);
            if (isFileReference(dest.url)) {
              nodes.push(fileMention(refs, keyPrefix + n++, dest.url, {
                labelNodes: bracket.label ? children : undefined,
                labelText: bracket.label,
                title: dest.title,
              }));
            } else if (safe) {
              nodes.push(renderAnchor(`${keyPrefix}-a${n++}`, safe, children, dest.title));
            } else {
              nodes.push(<span key={`${keyPrefix}-ua${n++}`}>{children}</span>);
            }
            i = dest.closeIdx + 1;
            continue;
          }
        }
        // 引用式链接 [label][ref] 或 [label]
        let refKey: string | undefined;
        let endIdx = bracket.closeIdx;
        if (text[afterBracket] === '[') {
          const refBracket = parseBracketContent(text, afterBracket);
          if (refBracket) {
            refKey = (refBracket.label || bracket.label).trim().toLowerCase();
            endIdx = refBracket.closeIdx;
          }
        } else {
          refKey = bracket.label.trim().toLowerCase();
        }
        if (refKey && refs.links.has(refKey)) {
          const def = refs.links.get(refKey)!;
          if (isFileReference(def.url)) {
            flushPlain();
            const refChildren = renderInline(bracket.label, `${keyPrefix}-rf${n}`, refs, depth + 1);
            nodes.push(fileMention(refs, keyPrefix + n++, def.url, { labelNodes: refChildren, labelText: bracket.label, title: def.title }));
            i = endIdx + 1;
            continue;
          }
          const safe = resolveSafeHref(def.url, refs.headingPrefix);
          if (safe) {
            flushPlain();
            const children = renderInline(bracket.label, `${keyPrefix}-rl${n}`, refs, depth + 1);
            nodes.push(renderAnchor(`${keyPrefix}-ra${n++}`, safe, children, def.title));
            i = endIdx + 1;
            continue;
          }
        }
      }
    }

    // 7. 裸 URL 自动链接（https://... / http://...，遇到中英文全角标点或空白立即截断）
    if (
      (ch === 'h' || ch === 'H') &&
      /^https?:\/\/[^\s<>]/i.test(text.slice(i)) &&
      (i === 0 || !/[A-Za-z0-9_/-]/.test(text[i - 1]))
    ) {
      const rawMatch = /^https?:\/\/[^\s<>，。；：！？、“”‘’【】（）《》「」『』]+/i.exec(text.slice(i));
      if (rawMatch) {
        let candidate = rawMatch[0];
        // 剥离句末常见的中英文标点，同时保留 URL 内部配对的括号（如 Wikipedia_(markup)）
        while (candidate.length > 8) {
          const last = candidate[candidate.length - 1];
          if (/[.,;:!?。，；：！？'"’”\]}>]/.test(last)) {
            candidate = candidate.slice(0, -1);
            continue;
          }
          if (last === ')') {
            const opens = (candidate.match(/\(/g) || []).length;
            const closes = (candidate.match(/\)/g) || []).length;
            if (closes > opens) {
              candidate = candidate.slice(0, -1);
              continue;
            }
          }
          break;
        }
        const safe = resolveSafeHref(candidate);
        if (safe) {
          flushPlain();
          if (isFileReference(candidate)) nodes.push(fileMention(refs, keyPrefix + n++, candidate));
          else nodes.push(renderAnchor(`${keyPrefix}-bu${n++}`, safe, candidate));
          i += candidate.length;
          continue;
        }
      }
    }

    if (depth === 0 && (i === 0 || /[\s(（「“：:,，"']/u.test(text[i - 1]) ||
        (/[\u3400-\u9fff]/u.test(text[i - 1]) && /^(?:[a-z]:[\\/]|file:\/\/\/|\.{1,2}[\\/]|[\w.-]+[\\/]|\w[\w.-]*\.[a-z\d]{1,10})/i.test(text.slice(i)))) && /[\w.\\/]/.test(ch)) {
      const token = /^(?:[A-Za-z]:[\\/]|file:\/\/\/|\.{1,2}[\\/]|\/(?!\/)|[\w.-]+[\\/])?[^\s<>`*"'|，。；：！？、（）「」【】()[\]]+\.[a-z0-9]{1,10}(?:#L\d+)?/i.exec(text.slice(i));
      if (token && isFileReference(token[0])) {
        flushPlain(); nodes.push(fileMention(refs, keyPrefix + n++, token[0])); i += token[0].length; continue;
      }
    }

    // 8. 粗斜体 ***...***、粗体 **...**、斜体 *...*
    if (ch === '*') {
      if (text.startsWith('***', i)) {
        const m = /^\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/.exec(text.slice(i));
        if (m) {
          flushPlain();
          nodes.push(
            <strong key={`${keyPrefix}-bi${n++}`}>
              <em>{renderInline(m[1], `${keyPrefix}-bi${n}`, refs, depth + 1)}</em>
            </strong>
          );
          i += m[0].length;
          continue;
        }
      }
      if (text.startsWith('**', i)) {
        const m = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(text.slice(i));
        if (m) {
          flushPlain();
          nodes.push(
            <strong key={`${keyPrefix}-b${n++}`}>
              {renderInline(m[1], `${keyPrefix}-b${n}`, refs, depth + 1)}
            </strong>
          );
          i += m[0].length;
          continue;
        }
      }
      if (text[i + 1] && text[i + 1] !== '*') {
        const m = /^\*(?![*\s])((?:[^\s*\n]|[^\s*\n][^*\n]*?[^\s*\n]))\*(?!\*)/.exec(text.slice(i));
        if (m) {
          flushPlain();
          nodes.push(
            <em key={`${keyPrefix}-em${n++}`}>
              {renderInline(m[1], `${keyPrefix}-em${n}`, refs, depth + 1)}
            </em>
          );
          i += m[0].length;
          continue;
        }
      }
    }

    // 9. 下划线粗体 __...__ 与斜体 _..._（仅限非标识符边界，保护 snake_case 与 __init__）
    if (ch === '_' && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      if (text.startsWith('__', i)) {
        const m = /^__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/.exec(text.slice(i));
        if (m) {
          flushPlain();
          nodes.push(
            <strong key={`${keyPrefix}-ub${n++}`}>
              {renderInline(m[1], `${keyPrefix}-ub${n}`, refs, depth + 1)}
            </strong>
          );
          i += m[0].length;
          continue;
        }
      } else {
        const m = /^_(?![_\s])((?:[^\s_\n]|[^\s_\n][^_\n]*?[^\s_\n]))_(?![A-Za-z0-9_])/.exec(text.slice(i));
        if (m) {
          flushPlain();
          nodes.push(
            <em key={`${keyPrefix}-uem${n++}`}>
              {renderInline(m[1], `${keyPrefix}-uem${n}`, refs, depth + 1)}
            </em>
          );
          i += m[0].length;
          continue;
        }
      }
    }

    // 10. 删除线 ~~...~~
    if (ch === '~' && text.startsWith('~~', i)) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(text.slice(i));
      if (m) {
        flushPlain();
        nodes.push(
          <del key={`${keyPrefix}-del${n++}`}>
            {renderInline(m[1], `${keyPrefix}-del${n}`, refs, depth + 1)}
          </del>
        );
        i += m[0].length;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return nodes;
}

/* ============================================================================
 * 代码高亮与块组件渲染
 * ========================================================================== */

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|class|new|async|await|try|catch|finally|throw|interface|type|extends|implements|readonly|def|elif|except|lambda|yield|with|as|pass|self|None|True|False|null|undefined|true|false|public|private|protected|static|void|fn|pub|use|impl|struct|enum|match|mut|package|func|defer|go|select|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INSERT|UPDATE|DELETE|CREATE|TABLE|ORDER|GROUP|BY|LIMIT)\b/;

const HASH_COMMENT_LANGS = new Set([
  'sh', 'bash', 'shell', 'zsh', 'ps1', 'powershell', 'python', 'py', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'dockerfile', 'makefile', 'conf', 'ini',
]);
const DIFF_LANGS = new Set(['diff', 'patch', 'git']);

const TOKEN_RE_SLASH =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
const TOKEN_RE_HASH =
  /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

/** 差异代码块按整行标出增删，普通代码块按语言选择注释规则。未命中的字符直接沿用原文。 */
function highlight(code: string, lang: string): React.ReactNode[] {
  const lower = lang.toLowerCase();
  if (DIFF_LANGS.has(lower)) {
    return code.split('\n').map((line, idx, arr) => {
      const suffix = idx < arr.length - 1 ? '\n' : '';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
        return <span key={idx} className="tok-diff-hunk">{line + suffix}</span>;
      }
      if (line.startsWith('+')) {
        return <span key={idx} className="tok-diff-add">{line + suffix}</span>;
      }
      if (line.startsWith('-')) {
        return <span key={idx} className="tok-diff-del">{line + suffix}</span>;
      }
      return line + suffix;
    });
  }

  const out: React.ReactNode[] = [];
  const pattern = new RegExp(HASH_COMMENT_LANGS.has(lower) ? TOKEN_RE_HASH : TOKEN_RE_SLASH);
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(code))) {
    if (match.index > last) out.push(code.slice(last, match.index));
    const [token, comment, str, num, word] = match;
    if (comment) out.push(<span key={n} className="tok-comment">{token}</span>);
    else if (str) out.push(<span key={n} className="tok-string">{token}</span>);
    else if (num) out.push(<span key={n} className="tok-number">{token}</span>);
    else if (word && KEYWORDS.test(word) && word.length === token.length)
      out.push(<span key={n} className="tok-keyword">{token}</span>);
    else out.push(token);
    n += 1;
    last = match.index + token.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function DetailsDefaultSummary(): React.ReactElement {
  const { dict } = useI18n();
  return <>{dict.ui.detailsAction}</>;
}

const CODE_FOLD_LINE_THRESHOLD = 40;

function CodeBlock({ lang, text }: { lang: string; text: string }): React.ReactElement {
  const { dict } = useI18n();
  const { state, copy } = useCopyFeedback();
  const lines = useMemo(() => text.split('\n'), [text]);
  const collapsible = lines.length > CODE_FOLD_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const visibleText = collapsible && !expanded ? lines.slice(0, CODE_FOLD_LINE_THRESHOLD).join('\n') : text;
  const copied = state === 'copied';
  const failed = state === 'failed';
  const statusText = copied ? dict.copiedAction : failed ? dict.ui.v034.copyFailed : '';
  return (
    <div className={`code-block${collapsible && !expanded ? ' is-collapsed' : ''}`}>
      <div className="code-block-head" data-annotation-skip="">
        <span>{lang || 'text'}</span>
        {statusText && (
          <span className="code-copy-status" role="status">
            {statusText}
          </span>
        )}
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          title={copied ? dict.copiedAction : dict.copyAction}
          aria-label={copied ? dict.copiedAction : dict.copyAction}
          data-state={state}
          data-testid="code-copy-btn"
          onClick={() => {
            void copy(text);
          }}
        >
          {copied ? <UiIcon icon={Check} size="xs" /> : <UiIcon icon={Copy} size="xs" />}
        </button>
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={dict.ui.v035.codeScrollRegion(lang)}
      >
        <code>{visibleText.length > 24000 ? visibleText : highlight(visibleText, lang)}</code>
      </pre>
      {collapsible && (
        <button
          type="button"
          className="code-block-fold"
          aria-expanded={expanded}
          data-testid="code-fold-btn"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? dict.ui.v035.codeCollapse : dict.ui.v035.codeExpand(lines.length)}
        </button>
      )}
    </div>
  );
}

const ALERT_ICON: Record<AlertKind, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: AlertCircle,
  warning: AlertTriangle,
  caution: ShieldAlert,
};

function MarkdownAlertHeading({ kind }: { kind: AlertKind }): React.ReactElement {
  const { dict } = useI18n();
  const Icon = ALERT_ICON[kind];
  return (
    <div className="md-alert-title" data-annotation-skip="">
      <UiIcon icon={Icon} size="sm" />
      <span>{dict.ui.v035.calloutTitle[kind]}</span>
    </div>
  );
}

function MarkdownTableRegion({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}): React.ReactElement {
  const { dict } = useI18n();
  return (
    <div className={className} tabIndex={0} role="region" aria-label={dict.ui.v035.tableScrollRegion}>
      {children}
    </div>
  );
}

function renderBlockList(
  blocks: Block[],
  keyPrefix: string,
  refs: MarkdownContext,
  streamingTail = false
): React.ReactNode[] {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-b${idx}`;
    const isActiveTailBlock = streamingTail && idx === blocks.length - 1;
    const glideClass = isActiveTailBlock ? 'cc-stream-glide-block' : undefined;
    switch (block.kind) {
      case 'code':
        return (
          <div key={key} className={glideClass}>
            <CodeBlock lang={block.lang} text={block.text} />
          </div>
        );
      case 'math-block':
        return (
          <div key={key} className={`md-math-block ${glideClass || ''}`.trim()}>
            {renderMathTokens(block.expr, `${key}-mb`)}
          </div>
        );
      case 'heading': {
        const Tag = (`h${block.level}` as unknown) as keyof React.JSX.IntrinsicElements;
        const content = renderInline(block.text, key, refs);
        return (
          <Tag key={key} id={headingId(content, refs)} className={glideClass}>
            {content}
          </Tag>
        );
      }
      case 'table':
        return (
          <MarkdownTableRegion key={key} className={`md-table-wrap ${glideClass || ''}`.trim()}>
            <table className="md-table">
              <thead>
                <tr>
                  {block.headers.map((header, cIdx) => {
                    const align = block.aligns[cIdx];
                    return (
                      <th key={`${key}-th${cIdx}`} style={align ? { textAlign: align } : undefined}>
                        {renderInline(header, `${key}-th${cIdx}`, refs)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rIdx) => (
                  <tr key={`${key}-tr${rIdx}`}>
                    {row.map((cell, cIdx) => {
                      const align = block.aligns[cIdx];
                      return (
                        <td key={`${key}-td${rIdx}-${cIdx}`} style={align ? { textAlign: align } : undefined}>
                          {renderInline(cell, `${key}-td${rIdx}-${cIdx}`, refs)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </MarkdownTableRegion>
        );
      case 'list': {
        const items = block.items.map((item, j) => {
          const itemKey = `${key}-li${j}`;
          const isTask = typeof item.checked === 'boolean';
          const isLastItem = isActiveTailBlock && j === block.items.length - 1;
          const liClasses = [isTask ? 'md-task-item' : '', isLastItem ? 'cc-stream-glide-block' : '']
            .filter(Boolean)
            .join(' ');
          const firstBlock = item.blocks[0];
          const restBlocks = item.blocks.slice(1);
          return (
            <li key={itemKey} className={liClasses || undefined}>
              {isTask && (
                <input
                  type="checkbox"
                  className="md-task-checkbox"
                  checked={item.checked}
                  readOnly
                  tabIndex={-1}
                  aria-label={item.checked ? 'completed' : 'todo'}
                />
              )}
              <div className="md-li-body">
                {firstBlock?.kind === 'para' ? (
                  <span>{renderInline(firstBlock.text, `${itemKey}-p0`, refs)}</span>
                ) : firstBlock ? (
                  renderBlockList([firstBlock], `${itemKey}-f0`, refs)
                ) : null}
                {restBlocks.length > 0 && renderBlockList(restBlocks, `${itemKey}-rest`, refs)}
              </div>
            </li>
          );
        });
        return block.ordered ? (
          <ol key={key} start={block.start && block.start !== 1 ? block.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case 'alert': {
        return (
          <div key={key} className={`md-alert is-${block.alertKind} ${glideClass || ''}`.trim()} role="note">
            <MarkdownAlertHeading kind={block.alertKind} />
            <div className="md-alert-body">{renderBlockList(block.children, `${key}-al`, refs)}</div>
          </div>
        );
      }
      case 'quote':
        return (
          <blockquote key={key} className={glideClass}>
            {renderBlockList(block.children, `${key}-qt`, refs)}
          </blockquote>
        );
      case 'details':
        return (
          <details key={key} className={`md-details ${glideClass || ''}`.trim()}>
            <summary>{block.summary ? renderInline(block.summary, `${key}-sum`, refs) : <DetailsDefaultSummary />}</summary>
            <div className="md-details-body">{renderBlockList(block.children, `${key}-det`, refs)}</div>
          </details>
        );
      case 'hr':
        return <hr key={key} />;
      default: {
        const standalone = parseStandaloneImage(block.text, refs);
        if (standalone && isRenderableFigureSource(standalone.url)) {
          const figureKey = previewKey(standalone.url, refs.workspace) || 'figure:' + standalone.url;
          refs.figureKeys.add(figureKey);
          refs.figureSources.push(standalone.url);
          const attachment = refs.attachmentsByKey.get(figureKey);
          return (
            <div key={key} className={glideClass}>
              <InlineFigure
                source={standalone.url}
                alt={standalone.alt}
                title={standalone.title}
                displayUrl={attachment?.mimeType.startsWith('image/') ? attachment.dataUrl : undefined}
              />
            </div>
          );
        }
        return (
          <p key={key} className={glideClass}>
            {renderInline(block.text, key, refs)}
          </p>
        );
      }
    }
  });
}

/**
 * F-08：将流式 Markdown 拆分为「已闭合稳定前缀」与「活跃尾部块」。
 * 仅在顶层非围栏/非容器/非数学块空白行边界处切分，保证前缀块只在真正闭合时变化一次，
 * 后续尾分片追加不再重解析或重渲染前面的成千上万字符。
 */
function splitStableMarkdownPrefix(source: string): [string, string] {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length < 3) return ['', normalized];

  let fenceChar = '';
  let fenceLen = 0;
  let alertDepth = 0;
  let detailsDepth = 0;
  let inMathBlock = false;

  // Record character offset at the start of each line.
  const lineOffsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    offset += lines[i].length + 1;
  }

  let lastSafeLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (fenceChar) {
      const closeRe = fenceChar === '`' ? /^`{3,}\s*$/ : /^~{3,}\s*$/;
      if (closeRe.test(trimmed) && trimmed.length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      continue;
    }

    if (trimmed === '$$') {
      inMathBlock = !inMathBlock;
      continue;
    }
    if (inMathBlock) continue;

    if (/^:::\s*\w+/.test(trimmed)) {
      alertDepth += 1;
      continue;
    }
    if (trimmed === ':::' && alertDepth > 0) {
      alertDepth -= 1;
      continue;
    }
    if (/^<details\b/i.test(trimmed)) {
      detailsDepth += 1;
      continue;
    }
    if (/^<\/details>/i.test(trimmed) && detailsDepth > 0) {
      detailsDepth -= 1;
      continue;
    }

    if (alertDepth === 0 && detailsDepth === 0 && trimmed === '' && i > 0 && i + 1 < lines.length) {
      // Find next non-empty line to ensure we do not split before an indented continuation, table, quote, or list item.
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;
      if (nextIdx < lines.length) {
        const nextLine = lines[nextIdx];
        const nextTrim = nextLine.trim();
        const prevLine = lines[i - 1]?.trim() ?? '';
        const looksContinuation =
          /^[ \t]/.test(nextLine) ||
          nextTrim.startsWith('>') ||
          nextTrim.startsWith('|') ||
          /^(?:[-*+]|\d+[.)])\s/.test(nextTrim) ||
          /^\[[^\]]+\]:\s*\S/.test(nextTrim) ||
          /^\[[^\]]+\]:\s*\S/.test(prevLine);
        if (!looksContinuation) {
          lastSafeLine = nextIdx;
        }
      }
    }
  }

  if (lastSafeLine <= 0) return ['', normalized];
  const cut = lineOffsets[lastSafeLine];
  return [normalized.slice(0, cut), normalized.slice(cut)];
}

interface RenderedMarkdownSegment {
  body: React.ReactNode[];
  links: Map<string, LinkDef>;
  previews: Map<string, FilePreview>;
  headingSlugs: Set<string>;
  figureKeys: Set<string>;
  figureSources: string[];
}

function buildMarkdownSegment(
  source: string,
  keyPrefix: string,
  workspace: string,
  headingPrefix: string,
  attachmentsByKey: Map<string, MessageAttachmentPreview>,
  streaming: boolean,
  inheritedLinks?: Map<string, LinkDef>,
  inheritedHeadingSlugs?: Set<string>
): RenderedMarkdownSegment {
  if (!source) {
    return {
      body: [],
      links: inheritedLinks ? new Map(inheritedLinks) : new Map(),
      previews: new Map(),
      headingSlugs: inheritedHeadingSlugs ? new Set(inheritedHeadingSlugs) : new Set(),
      figureKeys: new Set(),
      figureSources: [],
    };
  }
  const { blocks, refs } = parseDocument(source);
  const mergedLinks = inheritedLinks ? new Map([...inheritedLinks, ...refs]) : refs;
  const ctx: MarkdownContext = {
    links: mergedLinks,
    workspace,
    previews: new Map(),
    headingPrefix,
    headingSlugs: inheritedHeadingSlugs ? new Set(inheritedHeadingSlugs) : new Set(),
    figureKeys: new Set(),
    figureSources: [],
    attachmentsByKey,
  };
  const body = renderBlockList(blocks, keyPrefix, ctx, streaming);
  return {
    body,
    links: mergedLinks,
    previews: ctx.previews,
    headingSlugs: ctx.headingSlugs,
    figureKeys: ctx.figureKeys,
    figureSources: ctx.figureSources,
  };
}

const MemoizedMarkdownFragment = React.memo(function MemoizedMarkdownFragment({
  nodes,
}: {
  nodes: React.ReactNode[];
}): React.ReactElement {
  return <>{nodes}</>;
});

export function Markdown({
  text,
  streaming,
  compact,
  forceAnimation,
  attachments,
}: {
  text: string;
  streaming?: boolean;
  compact?: boolean;
  forceAnimation?: boolean;
  attachments?: MessageAttachmentPreview[];
}): React.ReactElement {
  // 动效 3：正文输出连续滑入动画（区别于思考流雾化与译文跨语种覆盖）
  const streamState = useFluidStreamText(text, Boolean(streaming), 'assistant', Boolean(forceAnimation));
  const workspace = useContext(ImageWorkspace);
  const sessionId = useContext(ImageSessionContext);
  const headingPrefix = 'md-' + React.useId() + '-';

  const attachmentsByKey = useMemo(() => {
    const map = new Map<string, MessageAttachmentPreview>();
    for (const file of attachments || []) {
      const key = file.uri ? resolveImage(file.uri, workspace) : undefined;
      if (key && !map.has(key)) map.set(key, file);
    }
    return map;
  }, [attachments, workspace]);

  // F-08：流式阶段将已闭合块与活跃尾块分离；已闭合前缀仅在新增完整块时重算，避免每次分片全量重解析 10,000+ 字文档。
  const [stablePrefix, liveTail] = useMemo(
    () => (streaming ? splitStableMarkdownPrefix(streamState.visibleText) : ['', streamState.visibleText]),
    [streaming, streamState.visibleText]
  );

  const stableSegment = useMemo(
    () => buildMarkdownSegment(stablePrefix, 'root-stable', workspace, headingPrefix, attachmentsByKey, false),
    [stablePrefix, workspace, headingPrefix, attachmentsByKey]
  );

  const tailSegment = useMemo(
    () =>
      buildMarkdownSegment(
        liveTail,
        stablePrefix ? 'root-tail' : 'root',
        workspace,
        headingPrefix,
        attachmentsByKey,
        Boolean(streaming),
        stableSegment.links,
        stableSegment.headingSlugs
      ),
    [liveTail, stablePrefix, workspace, headingPrefix, attachmentsByKey, streaming, stableSegment]
  );

  // 正文提及在前、剩余附件在后；附件与提及指向同一文件时合并，独立成段的图片已在原位展示。
  const candidates: PreviewCandidate[] = [];
  const consumed = new Set<string>();
  const allFigureKeys = new Set<string>([...stableSegment.figureKeys, ...tailSegment.figureKeys]);
  const allFigureSources = [...stableSegment.figureSources, ...tailSegment.figureSources];
  const mergedPreviews = new Map([...stableSegment.previews, ...tailSegment.previews]);

  for (const [key, item] of mergedPreviews) {
    if (allFigureKeys.has(key)) continue;
    const attachment = attachmentsByKey.get(key);
    if (attachment) consumed.add(attachment.id);
    candidates.push({ key, source: item.source, label: item.label, image: item.image, title: item.title, text: item.text, origin: item.origin, attachment });
  }
  for (const file of attachments || []) {
    if (consumed.has(file.id)) continue;
    const uriKey = file.uri ? resolveImage(file.uri, workspace) : undefined;
    if (uriKey && allFigureKeys.has(uriKey) && file.mimeType.startsWith('image/')) continue;
    const source = file.uri || file.dataUrl || '';
    const key = uriKey || 'attachment:' + file.id;
    if (candidates.some(candidate => candidate.key === key)) continue;
    candidates.push({
      key,
      source,
      label: file.name,
      image: file.mimeType.startsWith('image/') && Boolean(file.dataUrl || source),
      text: file.textContent,
      origin: 'attachment',
      attachment: file,
    });
  }
  const inspectTargets = [
    ...candidates.filter(c => !c.attachment && isLocalTargetSource(c.source)).map(c => c.source),
    ...allFigureSources.filter(source => isLocalTargetSource(source)),
  ];
  const inspection = useLocalTargetInspection(inspectTargets, { cwd: workspace, sessionId, deferMs: streaming ? 450 : 0 });
  const items = classifyPreviewCandidates(candidates, inspection);
  return (
    <InspectionContext.Provider value={inspection}>
      <div
        id={headingPrefix}
        className={`md ${compact ? 'md-compact' : ''} ${streaming ? 'cc-body-stream-active cc-streaming-cursor' : ''}`.trim()}
      >
        {stablePrefix ? <MemoizedMarkdownFragment nodes={stableSegment.body} /> : null}
        <MemoizedMarkdownFragment nodes={tailSegment.body} />
        <MediaGallery items={items} />
      </div>
    </InspectionContext.Provider>
  );
}

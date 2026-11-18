import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Copy, ExternalLink, FileCode2, Info, Lightbulb, ShieldAlert } from 'lucide-react';
import { ImageWorkspace, MessageImage, resolveImage } from './MessageImage';
import type { MessageAttachmentPreview } from '@shared';
import { looksLikePlausibleLocalTarget } from './SelectionAnnotationTools';
import { useFluidStreamText } from '../hooks/useFluidStreamText';
import { useI18n } from '../i18n/I18nContext';

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
 * 安全 URL 解析与过滤（拒绝 javascript:/vbscript:/data:text 等危险协议）
 * ========================================================================== */

interface SafeHref {
  href: string;
  kind: 'external' | 'file' | 'anchor';
  tooltip: string;
}

/** 将可交互目标区分为页内锚点、外部地址和本地文件。无法解析或使用未知协议时交由调用方显示普通文字。 */
export function resolveSafeHref(rawUrl: string): SafeHref | null {
  const trimmed = rawUrl.trim().replace(/^<|>$/g, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) {
    return { href: trimmed, kind: 'anchor', tooltip: trimmed };
  }
  // 兼容模型直接输出的 Windows 绝对路径（如 F:/插件-Gemini/src/index.ts#L10）
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const normalized = trimmed.replace(/\\/g, '/');
    return {
      href: `file:///${normalized}`,
      kind: 'file',
      tooltip: normalized,
    };
  }
  try {
    const parsed = new URL(trimmed);
    const proto = parsed.protocol.toLowerCase();
    if (proto === 'https:' || proto === 'http:' || proto === 'mailto:') {
      return { href: parsed.toString(), kind: 'external', tooltip: parsed.toString() };
    }
    if (proto === 'file:') {
      let decoded = trimmed;
      try {
        decoded = decodeURIComponent(trimmed.replace(/^file:\/\/\/?/i, ''));
      } catch {
        /* keep raw */
      }
      return { href: trimmed, kind: 'file', tooltip: decoded };
    }
    return null;
  } catch {
    return null;
  }
}

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
      let summary = '详情';
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
  explicitTitle?: string
): React.ReactElement {
  return <TargetLink key={key} safe={safe} title={explicitTitle}>{children}</TargetLink>;
}

function TargetLink({ safe, title, children }: { safe: SafeHref; title?: string; children: React.ReactNode }) {
  const [error, setError] = useState('');
  return <>
    <a
      className={safe.kind === 'file' ? 'md-link md-link-file' : 'md-link'}
      href={safe.href}
      data-link-href={safe.href}
      data-link-kind={safe.kind}
      target={safe.kind === 'anchor' ? undefined : '_blank'}
      rel={safe.kind === 'anchor' ? undefined : 'noopener noreferrer'}
      title={title || safe.tooltip}
      onClick={
        safe.kind === 'file'
          ? (e) => {
              if (typeof window !== 'undefined' && window.agyDesktop?.openLinkOrFileTarget) {
                e.preventDefault();
                setError('');
                void window.agyDesktop.openLinkOrFileTarget({ target: safe.href, action: 'default-app' })
                  .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
              }
            }
          : undefined
      }
    >
      {children}
      {safe.kind === 'external' && <ExternalLink size={11} className="md-link-icon" aria-hidden="true" />}
      {safe.kind === 'file' && <FileCode2 size={11} className="md-link-icon" aria-hidden="true" />}
    </a>
    {error && <span role="alert" className="muted">{error}</span>}
  </>;
}

function isImageLink(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#][^ ]*)?$/i.test(url) && !/^(?:javascript|data|mailto):/i.test(url);
}

interface FilePreview { source: string; label: string; image: boolean; title?: string; text?: string }
interface MarkdownContext { links: Map<string, LinkDef>; previews: Map<string, FilePreview>; workspace: string }

function isFileReference(path: string): boolean {
  return isImageLink(path) || looksLikePlausibleLocalTarget(path) ||
    /^\/[^/].*\.[a-z0-9]{1,10}(?:#L\d+)?$/i.test(path) ||
    /^https?:\/\/[^\s]+\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|zip)(?:[?#].*)?$/i.test(path);
}
function addPreview(ctx: MarkdownContext, item: FilePreview) {
  const url = resolveImage(item.source, ctx.workspace);
  const key = url || (!ctx.workspace && !/^[a-z][\w+.-]*:|^[/\\]/i.test(item.source) ? 'unresolved:' + item.source : '');
  if (key && !ctx.previews.has(key)) ctx.previews.set(key, item);
  return url;
}
function fileMention(ctx: MarkdownContext, key: string, source: string, label = '', title?: string, explicitImage = false) {
  const embedded = /^(?:data|blob):/i.test(source);
  const name = label || source.split(/[\\\\/]/).at(-1) || source;
  const url = addPreview(ctx, { source, label: name, image: explicitImage || isImageLink(source), title });
  const body = embedded ? (label || '▧') : label && label !== source
    ? <>{label} <code className="md-file-path">{source}</code></> : source;
  const safe = url && !embedded ? resolveSafeHref(source) || resolveSafeHref(url) : null;
  return safe ? renderAnchor(key, safe, body, title) : <span key={key}>{body}</span>;
}

function FilePreviews({ previews }: { previews: Map<string, FilePreview> }) {
  if (!previews.size) return null;
  return <div className="message-images message-previews" data-testid="message-previews">
    {[...previews].map(([url, item]) => {
      if (item.image) return <MessageImage key={url} source={item.source} alt={item.label} title={item.title} />;
      const safe = resolveSafeHref(url);
      return <div key={url} className="message-file">
        {safe ? renderAnchor('file', safe, item.label) : <span>{item.label}</span>}
        {item.text && <details><summary>{item.label}</summary><pre>{item.text.slice(0, 3000)}</pre></details>}
      </div>;
    })}
  </div>;
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
        if (isFileReference(codeContent) && !/[\r\n]/.test(codeContent)) addPreview(refs, { source: codeContent,
          label: codeContent.split(/[\\\\/]/).at(-1) || codeContent, image: isImageLink(codeContent) });
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
          nodes.push(fileMention(refs, keyPrefix + n++, src, attrs.get('alt'), attrs.get('title'), true));
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
          if (isFileReference(autoLink[1])) nodes.push(fileMention(refs, keyPrefix + n++, autoLink[1], label));
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
          nodes.push(fileMention(refs, keyPrefix + n++, dest.url, label.label, dest.title, true));
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
            const safe = resolveSafeHref(dest.url);
            flushPlain();
            const children = renderInline(bracket.label || dest.url, `${keyPrefix}-lk${n}`, refs, depth + 1);
            if (isFileReference(dest.url)) {
              nodes.push(fileMention(refs, keyPrefix + n++, dest.url, bracket.label, dest.title));
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
            nodes.push(fileMention(refs, keyPrefix + n++, def.url, bracket.label, def.title));
            i = endIdx + 1;
            continue;
          }
          const safe = resolveSafeHref(def.url);
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

function CodeBlock({ lang, text }: { lang: string; text: string }): React.ReactElement {
  const { dict } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{lang || 'text'}</span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          title={copied ? dict.copiedAction : dict.copyAction}
          aria-label={dict.copyAction}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              },
              () => {}
            );
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>
        <code>{text.length > 24000 ? text : highlight(text, lang)}</code>
      </pre>
    </div>
  );
}

const ALERT_META: Record<AlertKind, { label: string; Icon: React.ComponentType<{ size?: number }> }> = {
  note: { label: 'Note', Icon: Info },
  tip: { label: 'Tip', Icon: Lightbulb },
  important: { label: 'Important', Icon: AlertCircle },
  warning: { label: 'Warning', Icon: AlertTriangle },
  caution: { label: 'Caution', Icon: ShieldAlert },
};

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
        return (
          <Tag key={key} className={glideClass}>
            {renderInline(block.text, key, refs)}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className={`md-table-wrap ${glideClass || ''}`.trim()}>
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
          </div>
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
        const meta = ALERT_META[block.alertKind];
        const Icon = meta.Icon;
        return (
          <div key={key} className={`md-alert is-${block.alertKind} ${glideClass || ''}`.trim()} role="note">
            <div className="md-alert-title">
              <Icon size={14} />
              <span>{meta.label}</span>
            </div>
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
            <summary>{renderInline(block.summary, `${key}-sum`, refs)}</summary>
            <div className="md-details-body">{renderBlockList(block.children, `${key}-det`, refs)}</div>
          </details>
        );
      case 'hr':
        return <hr key={key} />;
      default:
        return (
          <p key={key} className={glideClass}>
            {renderInline(block.text, key, refs)}
          </p>
        );
    }
  });
}

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
  // 输入流仍在增长时只解析已显示的文本前缀，后续分片到达后再补齐处于半截的 Markdown 结构。
  const { blocks, refs } = parseDocument(streamState.visibleText);
  const workspace = React.useContext(ImageWorkspace);
  const ctx: MarkdownContext = { links: refs, workspace, previews: new Map() };
  const body = renderBlockList(blocks, 'root', ctx, Boolean(streaming));
  for (const file of attachments || []) {
    const image = file.mimeType.startsWith('image/');
    const source = file.dataUrl || file.uri || '';
    const prior = file.uri && resolveImage(file.uri, workspace);
    const mention = prior ? ctx.previews.get(prior) : undefined;
    if (mention) {
      if (image && file.dataUrl) { mention.source = file.dataUrl; mention.image = true; }
      if (file.textContent !== undefined) mention.text = file.textContent;
      continue;
    }
    const key = (source && resolveImage(source, workspace)) || 'attachment:' + file.id;
    if (!ctx.previews.has(key)) ctx.previews.set(key, { source, label: file.name, image: image && Boolean(source), text: file.textContent });
  }
  return (
    <div
      className={`md ${compact ? 'md-compact' : ''} ${streaming ? 'cc-body-stream-active cc-streaming-cursor' : ''}`.trim()}
    >
      {body}
      <FilePreviews previews={ctx.previews} />
    </div>
  );
}

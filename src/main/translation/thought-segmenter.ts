import type { DualTrackThoughtBlock } from '../../shared/session-contract';

export function detectThoughtLanguage(text: string): DualTrackThoughtBlock['languageDetected'] {
  const chinese = /[\u3400-\u9fff]/.test(text);
  const english = /[A-Za-z]{3,}/.test(text);
  return chinese ? (english ? 'mixed' : 'zh') : 'en';
}

/**
 * 判断单个思考片段是否主要由英文撰写、需要在本机翻译：
 * 剥离代码块、内联反引号、URL 与文件路径后统计中英文比例，避免已是中文的句子重复送译，
 * 同时保证中英混合思考流中的英文段落不会被前序中文段落“稀释”而漏翻。
 */
export function needsModelTranslation(text: string): boolean {
  const stripped = inspectCodeSpans(text, true).prose
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z0-9_./\\-]+(?:\.[A-Za-z0-9]{1,6}|\/[A-Za-z0-9_./\\-]+)/g, ' ');
  const hanCount = (stripped.match(/[\u3400-\u9fff]/g) || []).length;
  const enWords = (stripped.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  if (enWords === 0) return false;
  if (hanCount === 0) return true;
  return enWords >= 3 && hanCount < enWords * 0.6;
}

const EMERGENCY_CUT_MIN_CHARS = 280;
const EMERGENCY_CUT_WINDOW = 300;
const EMERGENCY_CUT_SEARCH_START = 160;
const ABBREV_MULTI_DOT_RE = /(?:^|[\s(\[{"'‘“—-])(?:e\.g|i\.e|a\.m|p\.m|u\.s|u\.k)\.$/i;
const ABBREV_SINGLE_RE =
  /(?:^|[\s(\[{"'‘“—-])(?:etc|vs|cf|fig|no|dr|mr|mrs|ms|prof|sr|jr|st|approx|ref|dept|est|inc|ltd|vol|ch|sec|misc)\.$/i;
const LIST_NUM_BEFORE_DOT_RE = /^[ \t]*(?:>[ \t]*)*(?:\d{1,4}|[A-Za-z])\.$/;

/**
 * 判断给定前缀文本是否处于平衡的代码上下文（无未闭合的围栏代码块或内联反引号）。
 */
function inspectCodeSpans(text: string, collectProse = false): { balanced: boolean; prose: string } {
  const prose: string[] = [];
  const lines = text.split(/\r?\n/);
  let openFenceChar: string | null = null;
  let openFenceLen = 0;
  let openInlineTicks = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);

    if (openFenceChar) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === openFenceChar &&
        fenceMatch[1].length >= openFenceLen &&
        fenceMatch[2].trim() === ''
      ) {
        openFenceChar = null;
        openFenceLen = 0;
      }
      continue;
    }

    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      const tail = fenceMatch[2];
      // 单行围栏块（如 ```const x = 1```）在同行闭合
      const closePattern = ch === '`' ? new RegExp(`\`{${len},}[ \\t]*$`) : new RegExp(`~{${len},}[ \\t]*$`);
      if (tail && closePattern.test(tail)) {
        continue;
      }
      openFenceChar = ch;
      openFenceLen = len;
      continue;
    }

    let proseStart = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '`') {
        let run = 0;
        while (i + run < line.length && line[i + run] === '`') run++;
        if (openInlineTicks === 0) {
          if (collectProse) prose.push(line.slice(proseStart, i));
          openInlineTicks = run;
        } else if (run === openInlineTicks) {
          openInlineTicks = 0;
          proseStart = i + run;
        }
        i += run - 1;
      }
    }
    if (collectProse && !openInlineTicks) prose.push(line.slice(proseStart));
  }

  return { balanced: openFenceChar === null && openInlineTicks === 0, prose: prose.join(' ') };
}

export function hasBalancedCodeSpans(text: string): boolean {
  return inspectCodeSpans(text).balanced;
}

/**
 * 在流式 Thinking 阶段（正文首字尚未出现前）寻找安全的分段切点：
 * 1. 换行/段落边界（\n，且代码围栏与反引号平衡）
 * 2. 智能句末标点边界（跳过 e.g. / i.e. / etc. / vs. / v0.2.3 / 3.14 / ... / .ts / 行首 1. 及未闭合反引号）
 * 3. 超长从句应急切分（>= 280 字符时在 300 字符窗口内从 160 起寻从句标点或词界）
 * 4. 空闲停顿（900ms）或思考完成时（flushAll = true）直接冲刷尾部
 */
export function findNextSegmentEnd(originalText: string, fromOffset: number, flushAll: boolean): number | null {
  const rest = originalText.slice(fromOffset);
  if (!rest) return null;
  if (flushAll) return originalText.length;

  const wsPrefix = /^\s+/.exec(rest);
  if (wsPrefix && wsPrefix[0].length > 0 && wsPrefix[0].length < rest.length) {
    return fromOffset + wsPrefix[0].length;
  }

  // 1. 优先寻找代码上下文平衡的换行/段落边界
  const nlRe = /\r?\n(?:[ \t]*\r?\n)*/g;
  let nlMatch: RegExpExecArray | null;
  while ((nlMatch = nlRe.exec(rest)) !== null) {
    const relEnd = nlMatch.index + nlMatch[0].length;
    if (nlMatch.index === 0) continue;
    if (
      hasBalancedCodeSpans(rest.slice(0, relEnd)) &&
      hasBalancedCodeSpans(originalText.slice(0, fromOffset + relEnd))
    ) {
      return fromOffset + relEnd;
    }
  }

  // 2. 智能句界扫描（跳过缩写、版本号、小数、省略号、扩展名、行首序号及代码内标点）
  let openTicks = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '`') {
      let run = 0;
      while (i + run < rest.length && rest[i + run] === '`') run++;
      if (openTicks === 0) openTicks = run;
      else if (run === openTicks) openTicks = 0;
      i += run - 1;
      continue;
    }
    if (openTicks > 0) continue;

    const isCjkPunct = ch === '。' || ch === '！' || ch === '？' || ch === '；';
    const isAsciiPunct = ch === '.' || ch === '!' || ch === '?' || ch === ';';
    if (!isCjkPunct && !isAsciiPunct) continue;

    if (ch === '.') {
      const prev = i > 0 ? rest[i - 1] : fromOffset > 0 ? originalText[fromOffset - 1] : '';
      const next = i + 1 < rest.length ? rest[i + 1] : '';
      // 跳过省略号（.. / ...）、小数/版本号（3.14 / v0.2.3）及紧跟字母数字的扩展名/属性（.ts / .json / foo.bar）
      if (prev === '.' || next === '.') continue;
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      if (/[A-Za-z0-9_/-]/.test(next)) continue;
    }

    let punctEnd = i + 1;
    while (punctEnd < rest.length && /['")\]”’）]/.test(rest[punctEnd])) {
      punctEnd++;
    }

    let wsEnd = punctEnd;
    while (wsEnd < rest.length && /[ \t]/.test(rest[wsEnd])) {
      wsEnd++;
    }

    const hasTrailingWs = wsEnd > punctEnd;
    if (isAsciiPunct && !hasTrailingWs) continue;
    if (isCjkPunct && !hasTrailingWs && punctEnd >= rest.length) continue;

    const minCharsBeforePunct = isCjkPunct ? 4 : 10;
    if (i < minCharsBeforePunct) continue;

    if (ch === '.') {
      const absDotIndex = fromOffset + i;
      const lineStart = originalText.lastIndexOf('\n', absDotIndex) + 1;
      const lineBeforeDot = originalText.slice(lineStart, absDotIndex + 1);
      if (LIST_NUM_BEFORE_DOT_RE.test(lineBeforeDot)) continue;

      const lookbackStart = Math.max(0, absDotIndex - 20);
      const beforeDot = originalText.slice(lookbackStart, absDotIndex + 1);
      if (ABBREV_MULTI_DOT_RE.test(beforeDot) || ABBREV_SINGLE_RE.test(beforeDot)) continue;
    }

    if (
      hasBalancedCodeSpans(rest.slice(0, wsEnd)) &&
      hasBalancedCodeSpans(originalText.slice(0, fromOffset + wsEnd))
    ) {
      return fromOffset + wsEnd;
    }
  }

  // 3. 超长句应急切分（>= 280 字符，窗口 300，自 160 起寻从句标点或词界）
  if (rest.length >= EMERGENCY_CUT_MIN_CHARS) {
    const window = rest.slice(0, EMERGENCY_CUT_WINDOW);
    const clauseMatch = /(?:[,;:—]\s+|[，；：]\s*)/.exec(window.slice(EMERGENCY_CUT_SEARCH_START));
    if (clauseMatch) {
      const cut = EMERGENCY_CUT_SEARCH_START + clauseMatch.index + clauseMatch[0].length;
      if (
        hasBalancedCodeSpans(rest.slice(0, cut)) &&
        hasBalancedCodeSpans(originalText.slice(0, fromOffset + cut))
      ) {
        return fromOffset + cut;
      }
    }
    const lastSpace = window.lastIndexOf(' ');
    if (
      lastSpace >= EMERGENCY_CUT_SEARCH_START &&
      hasBalancedCodeSpans(rest.slice(0, lastSpace + 1)) &&
      hasBalancedCodeSpans(originalText.slice(0, fromOffset + lastSpace + 1))
    ) {
      return fromOffset + lastSpace + 1;
    }
  }

  return null;
}

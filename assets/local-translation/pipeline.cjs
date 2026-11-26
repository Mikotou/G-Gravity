'use strict';

/**
 * Zero-dependency local Bergamot translation pipeline.
 *
 * Responsibilities:
 * 1. Preserve fenced code blocks, exact newlines (\r?\n), line-leading Markdown
 *    markers, and outer bold wrappers.
 * 2. Smart sentence splitting inside paragraphs (skipping abbreviations, versions,
 *    decimals, ellipsis, file extensions, ordered list markers, and inline code).
 * 3. Two-tier XQ00 sentinel protection (conflict-free prefix XQ -> QK -> VX -> ZK,
 *    capped at 6 sentinels per sentence with Tier 1 code/paths/identifiers always
 *    taking priority over Tier 2 curated programming glossary).
 * 4. Strict 1:1 sentinel integrity verification, CJK-adjacent punctuation
 *    normalization, verbatim/glossary restoration, CJK/code spacing tidying, and
 *    automatic clause / segment-by-segment fallback so zero sentinels ever leak
 *    and zero code spans are ever lost.
 */

const MAX_SENTINELS_PER_SENTENCE = 6;
const SENTINEL_PREFIX_CANDIDATES = ['XQ', 'QK', 'VX', 'ZK', 'ZQ', 'XJ', 'KX', 'QZ'];
/**
 * Curated high-impact programming / IDE / agent NOUN glossary (Tier 2).
 * Only pure nouns / noun phrases belong here so substituting an XQ00 sentinel
 * never breaks English verb/predicate grammar in the bundled 44MB Bergamot model.
 */
const RAW_GLOSSARY_ENTRIES = [
  { en: 'fenced code block', zh: '围栏代码块', aliases: ['fenced code blocks'] },
  { en: 'regular expression', zh: '正则表达式', aliases: ['regular expressions'] },
  { en: 'regression test', zh: '回归测试', aliases: ['regression tests'] },
  { en: 'string literal', zh: '字符串字面量', aliases: ['string literals'] },
  { en: 'context window', zh: '上下文窗口', aliases: ['context windows'] },
  { en: 'race condition', zh: '竞态条件', aliases: ['race conditions'] },
  { en: 'merge conflict', zh: '合并冲突', aliases: ['merge conflicts'] },
  { en: 'worker thread', zh: '工作线程', aliases: ['worker threads'] },
  { en: 'infinite loop', zh: '死循环', aliases: ['infinite loops'] },
  { en: 'deserialization', zh: '反序列化' },
  { en: 'deduplication', zh: '去重' },
  { en: 'serialization', zh: '序列化' },
  { en: 'syntax error', zh: '语法错误', aliases: ['syntax errors'] },
  { en: 'rate limiting', zh: '限流', aliases: ['rate limit', 'rate limits'] },
  { en: 'stack trace', zh: '堆栈跟踪', aliases: ['stack traces'] },
  { en: 'memory leak', zh: '内存泄漏', aliases: ['memory leaks'] },
  { en: 'entry point', zh: '入口点', aliases: ['entry points'] },
  { en: 'placeholder', zh: '占位符', aliases: ['placeholders'] },
  { en: 'boilerplate', zh: '样板代码' },
  { en: 'fail-closed', zh: '默认拦截' },
  { en: 'idempotency', zh: '幂等', aliases: ['idempotent'] },
  { en: 'smoke test', zh: '冒烟测试', aliases: ['smoke tests'] },
  { en: 'code block', zh: '代码块', aliases: ['code blocks'] },
  { en: 'hot reload', zh: '热重载' },
  { en: 'middleware', zh: '中间件', aliases: ['middlewares'] },
  { en: 'breakpoint', zh: '断点', aliases: ['breakpoints'] },
  { en: 'whitespace', zh: '空白字符' },
  { en: 'truncation', zh: '截断' },
  { en: 'ciphertext', zh: '密文' },
  { en: 'typecheck', zh: '类型检查', aliases: ['typechecking', 'type-check', 'type check'] },
  { en: 'tool call', zh: '工具调用', aliases: ['tool calls'] },
  { en: 'edge case', zh: '边界情况', aliases: ['edge cases'] },
  { en: 'unit test', zh: '单元测试', aliases: ['unit tests'] },
  { en: 'call site', zh: '调用点', aliases: ['call sites'] },
  { en: 'fail-open', zh: '默认放行' },
  { en: 'handshake', zh: '握手', aliases: ['handshakes'] },
  { en: 'delimiter', zh: '分隔符', aliases: ['delimiters'] },
  { en: 'substring', zh: '子串', aliases: ['substrings'] },
  { en: 'lifecycle', zh: '生命周期' },
  { en: 'singleton', zh: '单例' },
  { en: 'plaintext', zh: '明文' },
  { en: 'allowlist', zh: '白名单' },
  { en: 'telemetry', zh: '遥测' },
  { en: 'backticks', zh: '反引号', aliases: ['backtick'] },
  { en: 'markdown', zh: 'Markdown' },
  { en: 'deadlock', zh: '死锁', aliases: ['deadlocks'] },
  { en: 'rollback', zh: '回滚', aliases: ['rollbacks'] },
  { en: 'codebase', zh: '代码库', aliases: ['codebases'] },
  { en: 'worktree', zh: '工作树', aliases: ['worktrees'] },
  { en: 'subagent', zh: '子智能体', aliases: ['subagents', 'sub-agent', 'sub-agents'] },
  { en: 'endpoint', zh: '端点', aliases: ['endpoints'] },
  { en: 'sentinel', zh: '哨兵占位符', aliases: ['sentinels'] },
  { en: 'dropdown', zh: '下拉菜单', aliases: ['dropdowns'] },
  { en: 'wildcard', zh: '通配符', aliases: ['wildcards'] },
  { en: 'snapshot', zh: '快照', aliases: ['snapshots'] },
  { en: 'fallback', zh: '回退', aliases: ['fallbacks'] },
  { en: 'checkbox', zh: '复选框', aliases: ['checkboxes'] },
  { en: 'denylist', zh: '黑名单' },
  { en: 'payload', zh: '载荷', aliases: ['payloads'] },
  { en: 'callback', zh: '回调', aliases: ['callbacks'] },
  { en: 'sandbox', zh: '沙箱', aliases: ['sandboxes'] },
  { en: 'dry run', zh: '空跑演练', aliases: ['dry runs'] },
  { en: 'tooltip', zh: '悬浮提示', aliases: ['tooltips'] },
  { en: 'popover', zh: '浮层', aliases: ['popovers'] },
  { en: 'sidebar', zh: '侧边栏', aliases: ['sidebars'] },
  { en: 'newline', zh: '换行符', aliases: ['newlines'] },
  { en: 'fixture', zh: '测试夹具', aliases: ['fixtures'] },
  { en: 'hydration', zh: '水合' },
  { en: 'pagination', zh: '分页' },
  { en: 'caller', zh: '调用方', aliases: ['callers'] },
  { en: 'string', zh: '字符串', aliases: ['strings'] },
  { en: 'token', zh: 'Token', aliases: ['tokens'] },
  { en: 'regex', zh: '正则表达式', aliases: ['regexes', 'regexp'] },
  { en: 'mutex', zh: '互斥锁', aliases: ['mutexes'] },
];

const GLOSSARY_ENTRIES = Object.freeze(
  RAW_GLOSSARY_ENTRIES.slice()
    .sort((a, b) => b.en.length - a.en.length)
    .map((entry) => Object.freeze({ ...entry, aliases: entry.aliases ? Object.freeze([...entry.aliases]) : undefined }))
);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build single longest-first glossary regex + lowercase lookup map.
const GLOSSARY_LOOKUP = new Map();
const glossaryTerms = [];
for (const entry of GLOSSARY_ENTRIES) {
  const forms = [entry.en, ...(entry.aliases || [])];
  for (const form of forms) {
    const key = form.toLowerCase();
    if (!GLOSSARY_LOOKUP.has(key)) {
      GLOSSARY_LOOKUP.set(key, entry.zh);
      glossaryTerms.push(form);
    }
  }
}
glossaryTerms.sort((a, b) => b.length - a.length);
const GLOSSARY_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${glossaryTerms.map(escapeRegex).join('|')})(?![A-Za-z0-9_-])`,
  'gi'
);

// Known file extensions for unquoted filenames & relative paths.
const KNOWN_FILE_EXT_PATTERN =
  '(?:d\\.ts|ts|tsx|js|jsx|cjs|mjs|json|jsonc|jsonl|md|mdx|yml|yaml|toml|ini|cfg|conf|env|css|scss|less|html|htm|xml|svg|png|jpg|jpeg|webp|ico|wasm|bin|exe|dll|so|dylib|sh|bash|zsh|ps1|bat|cmd|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|sql|graphql|gql|proto|lock|log|txt|csv|enc|bak|map)';

const KNOWN_REPO_ROOT_DIRS = new Set([
  'src', 'assets', 'tests', 'test', 'dist', 'build', 'scripts', 'docs',
  'lib', 'app', 'packages', 'node_modules', 'config', 'public', 'release',
  'shared', 'main', 'renderer', 'components', 'services', 'utils',
]);

// Tier 1 regexes in strict precedence order (higher specificity first).
const TIER1_MATCHERS = [
  // 0. Bold inline code (**`...`**) kept verbatim so bold code spans never lose styling or leak orphan **
  { re: /\*\*(`{1,3})([^`\r\n]+?)\1\*\*/g },
  // 1. Inline backtick code (`...`, ``...``, ```...``` on a single line)
  { re: /(`{1,3})([^`\r\n]+?)\1/g },
  // 2. URLs (http/https/ws/wss/file)
  { re: /(?:https?|wss?|file):\/\/[^\s<>()[\]"'`,;]+/g, trimTrailingPunct: true },
  // 3. Windows drive paths (C:\foo\bar, D:/workspace/demo/src)
  { re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?:[^\s<>:"|?*`'"()[\],;]|\\)+/g, trimTrailingPunct: true },
  // 4. Explicit Unix/home/relative paths (/etc/hosts, ./foo, ../bar, ~/baz)
  { re: /(?<![A-Za-z0-9_])(?:~\/|\.\.?\/|\/(?:[A-Za-z0-9._-]+\/)+)[A-Za-z0-9._/-]*/g, trimTrailingPunct: true },
  // 5. Unquoted relative code paths (src/main/index.ts, assets/local-translation/worker.cjs)
  {
    re: /(?<![A-Za-z0-9_/@])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?![A-Za-z0-9_/])/g,
    trimTrailingPunct: true,
    validate: (m) => {
      const slashCount = (m.match(/\//g) || []).length;
      if (slashCount >= 2) return true;
      if (new RegExp(`\\.${KNOWN_FILE_EXT_PATTERN}$`, 'i').test(m)) return true;
      const segments = m.split('/');
      if (KNOWN_REPO_ROOT_DIRS.has(segments[0].toLowerCase())) return true;
      // Distinguish from English slash pairs like "and/or", "read/write", "local/external".
      return segments.some((seg) => /[._\d-]/.test(seg));
    },
  },
  // 6. Unquoted standalone filenames with known extensions (approval-engine.ts, package.json, SKILL.md)
  {
    re: new RegExp(
      `(?<![A-Za-z0-9_./\\\\-])\\.?[A-Za-z0-9][A-Za-z0-9._-]*\\.${KNOWN_FILE_EXT_PATTERN}(?![A-Za-z0-9_])`,
      'gi'
    ),
  },
  // 7. CLI flags (--noEmit, --force, --config.directories.output=release/v0.2.4)
  { re: /(?<![A-Za-z0-9_-])--[A-Za-z][A-Za-z0-9._-]*(?:=[^\s,;)[\]"'`]+)?/g },
  // 8. @mentions (@bergamot, @coordinator, @vitest/ui; avoids emails via lookbehind)
  { re: /(?<![A-Za-z0-9_.])@[A-Za-z][A-Za-z0-9_/-]{1,}(?![A-Za-z0-9_])/g },
  // 9. Dot-chain code expressions or function calls (telemetry.snapshot(), state.block.isStreaming, complete())
  {
    re: /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?:\(\))?|\(\))(?![A-Za-z0-9_])/g,
    validate: (m) => {
      if (m.endsWith('()')) return true;
      const parts = m.split('.');
      if (parts.length >= 3) return parts.every((p) => p.length >= 2);
      // 2-segment dot chain: require code-like naming (camelCase, snake_case, PascalCase >= 2 humps, or leading `this.`)
      return (
        parts[0] === 'this' ||
        parts.some(
          (p) =>
            /^[a-z][a-z0-9]*[A-Z]/.test(p) ||
            /_/.test(p) ||
            /^[A-Z][a-z0-9]+[A-Z]/.test(p)
        )
      );
    },
  },
  // 10. Embedded CJK spans inside English sentences (prevents en->zh model from corrupting existing Chinese terms)
  { re: /[\u3400-\u9fff\uF900-\uFAFF]+(?:[·、][\u3400-\u9fff\uF900-\uFAFF]+)*/g },
  // 11. SCREAMING_SNAKE_CASE (STREAM_IDLE_FLUSH_MS, GLOSSARY_ENTRIES)
  { re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?![A-Za-z0-9_])/g },
  // 12. snake_case (run_command, agent_thought_chunk)
  { re: /(?<![A-Za-z0-9_])[a-z][a-z0-9]*_[a-z0-9_]+(?![A-Za-z0-9_])/g },
  // 13. True camelCase (screenCommand, findNextSegmentEnd, batchTranslateFn)
  { re: /(?<![A-Za-z0-9_])[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*(?![A-Za-z0-9_])/g },
  // 14. True PascalCase with >= 2 humps (ThoughtTranslator, CoreService, HTTPClient — NEVER Check/First/Update/APIs)
  { re: /(?<![A-Za-z0-9_])(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}[A-Z][a-z]{2,}[A-Za-z0-9]*)(?![A-Za-z0-9_])/g },
];

const CJK_RE = /[\u3400-\u9fff\uF900-\uFAFF]/;
const ABBREV_MULTI_DOT_RE = /(?:^|[\s(\[{"'‘“—-])(?:e\.g|i\.e|a\.m|p\.m|u\.s|u\.k)\.$/i;
const ABBREV_SINGLE_RE =
  /(?:^|[\s(\[{"'‘“—-])(?:etc|vs|cf|fig|no|dr|mr|mrs|ms|prof|sr|jr|st|approx|ref|dept|est|inc|ltd|vol|ch|sec|misc)\.$/i;
const LIST_NUM_BEFORE_DOT_RE = /^[ \t]*(?:>[ \t]*)*(?:\d{1,4}|[A-Za-z])\.$/;


/**
 * Split a single paragraph/line into sentence parts preserving exact whitespace.
 * @returns {Array<{ text: string, leadWs: string, trailWs: string }>}
 */
function splitSentenceParts(text) {
  if (!text || !text.trim()) return [];
  const parts = [];
  let segStart = 0;
  let openTicks = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Track inline backtick spans so punctuation inside code never splits sentences.
    if (ch === '`') {
      let run = 0;
      while (i + run < text.length && text[i + run] === '`') run++;
      if (openTicks === 0) openTicks = run;
      else if (run === openTicks) openTicks = 0;
      i += run - 1;
      continue;
    }
    if (openTicks > 0) continue;

    const isCjkPunct = ch === '。' || ch === '！' || ch === '？' || ch === '；';
    const isAsciiPunct = ch === '.' || ch === '!' || ch === '?';
    if (!isCjkPunct && !isAsciiPunct) continue;

    // Skip ellipsis (.. / ...), decimals (3.14), version numbers (v0.2.3), file extensions (.ts).
    if (ch === '.') {
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + 1 < text.length ? text[i + 1] : '';
      if (prev === '.' || next === '.') continue;
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      // Dot immediately followed by identifier/word char (e.g. .ts, .json, foo.bar, v0.2.3) is never a sentence end.
      if (/[A-Za-z0-9_/-]/.test(next)) continue;
    }

    // Include optional closing quote/bracket after sentence punctuation.
    let punctEnd = i + 1;
    while (punctEnd < text.length && /['")\]”’）]/.test(text[punctEnd])) {
      punctEnd++;
    }

    // Consume trailing horizontal whitespace after the sentence punctuation.
    let wsEnd = punctEnd;
    while (wsEnd < text.length && (text[wsEnd] === ' ' || text[wsEnd] === '\t')) {
      wsEnd++;
    }

    const hasFollowingWs = wsEnd > punctEnd;
    const atEnd = wsEnd >= text.length;

    // ASCII sentence punctuation must be followed by whitespace (or end of text).
    if (isAsciiPunct && !hasFollowingWs && !atEnd) continue;

    if (ch === '.') {
      const beforeDot = text.slice(segStart, i + 1);
      // Skip line/sentence-leading ordered list numbers (e.g. "1. ", "12. ").
      if (LIST_NUM_BEFORE_DOT_RE.test(beforeDot)) continue;
      // Skip common abbreviations (e.g., i.e., etc., vs., cf., fig., no., dr., mr., ms., st., approx., ref.).
      if (ABBREV_MULTI_DOT_RE.test(beforeDot) || ABBREV_SINGLE_RE.test(beforeDot)) continue;
    }

    const rawSlice = text.slice(segStart, wsEnd);
    const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(rawSlice);
    if (m && m[2]) {
      parts.push({ leadWs: m[1], text: m[2], trailWs: m[3] });
    }
    segStart = wsEnd;
    i = wsEnd - 1;
  }

  if (segStart < text.length) {
    const rawTail = text.slice(segStart);
    const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(rawTail);
    if (m && m[2]) {
      parts.push({ leadWs: m[1], text: m[2], trailWs: m[3] });
    }
  }

  return parts;
}

/**
 * Smart sentence splitter returning trimmed sentence strings.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return splitSentenceParts(text).map((part) => part.text);
}

/**
 * Pick a conflict-free 2-letter sentinel prefix for a sentence.
 */
function pickSentinelPrefix(sentence, preferredPrefix) {
  const upper = String(sentence || '').toUpperCase();
  if (preferredPrefix && !upper.includes(preferredPrefix.toUpperCase())) {
    return preferredPrefix.toUpperCase();
  }
  for (const candidate of SENTINEL_PREFIX_CANDIDATES) {
    if (!upper.includes(candidate)) return candidate;
  }
  // Extreme fallback: find any unused 2-letter ASCII uppercase pair.
  const letters = 'XZQKVJWY';
  for (let a = 0; a < letters.length; a++) {
    for (let b = 0; b < letters.length; b++) {
      if (a === b) continue;
      const pair = letters[a] + letters[b];
      if (!upper.includes(pair)) return pair;
    }
  }
  return 'XQ';
}

function overlapsExisting(spans, start, end) {
  for (let i = 0; i < spans.length; i++) {
    if (start < spans[i].end && end > spans[i].start) return true;
  }
  return false;
}

function collectTier1Spans(sentence) {
  const spans = [];
  for (const matcher of TIER1_MATCHERS) {
    matcher.re.lastIndex = 0;
    let m;
    while ((m = matcher.re.exec(sentence)) !== null) {
      let matched = m[0];
      const start = m.index;
      if (matcher.trimTrailingPunct) {
        matched = matched.replace(/[.,;:!?)]+$/, '');
      }
      if (!matched) continue;
      const end = start + matched.length;
      if (overlapsExisting(spans, start, end)) continue;
      if (matcher.validate && !matcher.validate(matched, sentence, start, end)) continue;
      spans.push({
        start,
        end,
        original: matched,
        replacement: matched,
        tier: 1,
      });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function collectTier2Spans(sentence, tier1Spans) {
  const spans = [];
  GLOSSARY_RE.lastIndex = 0;
  let m;
  while ((m = GLOSSARY_RE.exec(sentence)) !== null) {
    const matched = m[0];
    const start = m.index;
    const end = start + matched.length;
    if (overlapsExisting(tier1Spans, start, end)) continue;
    if (overlapsExisting(spans, start, end)) continue;
    const zh = GLOSSARY_LOOKUP.get(matched.toLowerCase());
    if (!zh) continue;
    spans.push({
      start,
      end,
      original: matched,
      replacement: zh,
      tier: 2,
    });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Protect a single sentence using two-tier XQ00 sentinels (max 6 per sentence,
 * Tier 1 code/paths/identifiers strictly prioritized over Tier 2 glossary).
 */
function protectSentence(sentence, options = {}) {
  const maxSentinels =
    typeof options.maxSentinels === 'number' && options.maxSentinels >= 0
      ? options.maxSentinels
      : MAX_SENTINELS_PER_SENTENCE;
  const prefix = pickSentinelPrefix(sentence, options.prefix);
  const tier1 = collectTier1Spans(sentence);
  const tier2 = collectTier2Spans(sentence, tier1);

  const overflowTier1 = tier1.length > maxSentinels;
  const selectedTier1 = tier1.slice(0, maxSentinels);
  const remainingSlots = Math.max(0, maxSentinels - selectedTier1.length);
  const selectedTier2 = tier2.slice(0, remainingSlots);

  const selected = [...selectedTier1, ...selectedTier2].sort((a, b) => a.start - b.start);
  const allSpans = [...tier1, ...tier2].sort((a, b) => a.start - b.start);

  const placeholders = [];
  let masked = '';
  let cursor = 0;

  for (let i = 0; i < selected.length; i++) {
    const span = selected[i];
    const token = `${prefix}${String(i).padStart(2, '0')}`;
    masked += sentence.slice(cursor, span.start) + token;
    placeholders.push({
      token,
      original: span.original,
      replacement: span.replacement,
      tier: span.tier,
      start: span.start,
      end: span.end,
    });
    cursor = span.end;
  }
  masked += sentence.slice(cursor);

  return {
    text: masked,
    masked,
    prefix,
    placeholders,
    allSpans,
    overflowTier1,
  };
}

/**
 * Normalize ASCII punctuation (, : ; ? !) to full-width Chinese punctuation
 * strictly when adjacent to CJK, never inside code, URLs, paths, times, or versions.
 */
function normalizeZhPunctuation(text) {
  if (!text || !CJK_RE.test(text)) return text;

  // Mask inline code, URLs, and explicit paths so standalone calls never corrupt them.
  const protectedTokens = [];
  const safe = text.replace(
    /(?:(`{1,3})[^`\r\n]+?\1|(?:https?|wss?|file):\/\/[^\s<>()[\]"'`,;]+|[A-Za-z]:[\\/][^\s<>:"|?*`'"()[\],;]+)/g,
    (match) => {
      const key = `\uE000${protectedTokens.length}\uE001`;
      protectedTokens.push(match);
      return key;
    }
  );

  let out = safe;

  // 1. Comma: convert when adjacent to CJK (never between digits like 1,000).
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF》」』）】”’])[ \t]*,[ \t]*/g, '$1，');
  out = out.replace(/,[ \t]*(?=[\u3400-\u9fff\uF900-\uFAFF])/g, '，');

  // 2. Colon: convert when adjacent to CJK (never times like 12:30 or drive/URL colons).
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF》」』）】”’])[ \t]*:(?![\\/])[ \t]*/g, '$1：');
  out = out.replace(/(?<!:):(?![\\/\d])[ \t]*(?=[\u3400-\u9fff\uF900-\uFAFF])/g, '：');

  // 3. Semicolon: convert when adjacent to CJK.
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF》」』）】”’])[ \t]*;[ \t]*/g, '$1；');
  out = out.replace(/;[ \t]*(?=[\u3400-\u9fff\uF900-\uFAFF])/g, '；');

  // 4. Question mark: convert when adjacent to CJK.
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF》」』）】”’])[ \t]*\?/g, '$1？');
  out = out.replace(/\?[ \t]*(?=[\u3400-\u9fff\uF900-\uFAFF])/g, '？');

  // 5. Exclamation mark: convert when adjacent to CJK (never != or !==).
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF》」』）】”’])[ \t]*!(?!=)/g, '$1！');
  out = out.replace(/!(?!=)[ \t]*(?=[\u3400-\u9fff\uF900-\uFAFF])/g, '！');

  // Collapse stray spaces right before or after full-width Chinese punctuation next to CJK.
  out = out.replace(/[ \t]+([，。！？；：、])/g, '$1');
  out = out.replace(/([，。！？；：、])[ \t]+(?=[\u3400-\u9fff\uF900-\uFAFF])/g, '$1');

  // Restore masked spans.
  if (protectedTokens.length > 0) {
    out = out.replace(/\uE000(\d+)\uE001/g, (_, idx) => protectedTokens[Number(idx)]);
  }

  return out;
}

/**
 * Tidy spacing between CJK characters, Chinese punctuation, and inline code / ASCII terms
 * without modifying the interior of any inline code span.
 */
function tidyZhSpacing(text) {
  if (!text || !CJK_RE.test(text)) return text;

  // Apply spacing only outside verbatim code, paths and URLs, including CJK path components.
  const codeSpans = [];
  let out = text.replace(/(`{1,3})[^`\r\n]+?\1|(?:https?|wss?|file):\/\/[^\s<>()[\]"'`,;]+|[A-Za-z]:[\\/][^\s<>:"|?*`'"()[\],;]+/g, (match) => {
    const key = `\uE010${codeSpans.length}\uE011`;
    codeSpans.push(match);
    return key;
  });

  // Remove stray horizontal spaces between adjacent CJK characters (iteratively for chains).
  let prev;
  do {
    prev = out;
    out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF])[ \t]+([\u3400-\u9fff\uF900-\uFAFF])/g, '$1$2');
  } while (out !== prev);

  // Remove stray horizontal spaces adjacent to Chinese punctuation.
  out = out.replace(/[ \t]+([，。！？；：、）】》」』])/g, '$1');
  out = out.replace(/([，。！？；：、（【《「『])[ \t]+/g, '$1');

  // Ensure a clean single space between CJK and inline code markers (unless touching CJK punctuation).
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF])[ \t]*(\uE010\d+\uE011)/g, '$1 $2');
  out = out.replace(/(\uE010\d+\uE011)[ \t]*([\u3400-\u9fff\uF900-\uFAFF])/g, '$1 $2');

  // Ensure a clean single space between CJK and ASCII words/identifiers (e.g. Markdown, screenCommand).
  out = out.replace(/([\u3400-\u9fff\uF900-\uFAFF])[ \t]*([A-Za-z0-9@_/\\-]{2,})/g, '$1 $2');
  out = out.replace(/([A-Za-z0-9_/-]{2,})[ \t]*([\u3400-\u9fff\uF900-\uFAFF])/g, '$1 $2');

  // Collapse multiple horizontal spaces outside code spans.
  out = out.replace(/[ \t]{2,}/g, ' ');

  // Re-strip any space immediately before/after Chinese punctuation that may remain.
  out = out.replace(/[ \t]+([，。！？；：、）】》」』])/g, '$1');
  out = out.replace(/([，。！？；：、（【《「『])[ \t]+/g, '$1');

  if (codeSpans.length > 0) {
    out = out.replace(/\uE010(\d+)\uE011/g, (_, idx) => codeSpans[Number(idx)]);
  }

  return out.trim();
}

/**
 * Strictly verify 1:1 sentinel survival, normalize Chinese punctuation, restore
 * verbatim / glossary spans, and tidy CJK / inline-code spacing.
 *
 * @param {string} translated
 * @param {Array|Object} protectedOrPlaceholders
 * @returns {{ ok: boolean, text: string, missing: string[], duplicated: string[], unexpected: string[] }}
 */
function restoreSentence(translated, protectedOrPlaceholders) {
  const isProtectedObj =
    protectedOrPlaceholders &&
    !Array.isArray(protectedOrPlaceholders) &&
    Array.isArray(protectedOrPlaceholders.placeholders);
  const placeholders = isProtectedObj
    ? protectedOrPlaceholders.placeholders
    : Array.isArray(protectedOrPlaceholders)
      ? protectedOrPlaceholders
      : [];
  const prefix = isProtectedObj
    ? protectedOrPlaceholders.prefix
    : placeholders[0]
      ? placeholders[0].token.slice(0, 2)
      : null;

  const raw = String(translated || '');
  if (placeholders.length === 0) {
    return {
      ok: true,
      text: tidyZhSpacing(normalizeZhPunctuation(raw)),
      missing: [],
      duplicated: [],
      unexpected: [],
    };
  }

  const missing = [];
  const duplicated = [];
  const tokenMap = new Map();

  for (const p of placeholders) {
    tokenMap.set(p.token, p);
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(p.token)}(?![A-Za-z0-9])`, 'g');
    const matches = raw.match(re);
    const count = matches ? matches.length : 0;
    if (count === 0) missing.push(p.token);
    else if (count > 1) duplicated.push(p.token);
  }

  const unexpected = [];
  if (prefix) {
    const anyTokenRe = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(prefix)}\\d{2}(?![A-Za-z0-9])`, 'g');
    const found = raw.match(anyTokenRe) || [];
    for (const tok of found) {
      if (!tokenMap.has(tok) && !unexpected.includes(tok)) {
        unexpected.push(tok);
      }
    }
  }

  if (missing.length > 0 || duplicated.length > 0 || unexpected.length > 0) {
    return { ok: false, text: '', missing, duplicated, unexpected };
  }

  // Normalize Chinese punctuation BEFORE restoring verbatim code/URL/path spans.
  const normalized = normalizeZhPunctuation(raw);

  // Restore all sentinels in a single pass so replacement text can never collide.
  const allTokensRe = new RegExp(
    `(?<![A-Za-z0-9])(?:${placeholders.map((p) => escapeRegex(p.token)).join('|')})(?![A-Za-z0-9])`,
    'g'
  );
  const restored = normalized.replace(allTokensRe, (tok) => {
    const entry = tokenMap.get(tok);
    return entry ? entry.replacement : tok;
  });

  // Final safety check: no sentinel token should remain.
  if (prefix) {
    const leakRe = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(prefix)}\\d{2}(?![A-Za-z0-9])`);
    if (leakRe.test(restored)) {
      return { ok: false, text: '', missing: [], duplicated: [], unexpected: [prefix] };
    }
  }

  return {
    ok: true,
    text: tidyZhSpacing(restored),
    missing: [],
    duplicated: [],
    unexpected: [],
  };
}

/**
 * Determine whether a masked sentence still has English prose that needs translation.
 */
function hasTranslatableEnglish(maskedText, placeholders) {
  let stripped = maskedText;
  if (placeholders && placeholders.length > 0) {
    const re = new RegExp(
      `(?<![A-Za-z0-9])(?:${placeholders.map((p) => escapeRegex(p.token)).join('|')})(?![A-Za-z0-9])`,
      'g'
    );
    stripped = stripped.replace(re, ' ');
  }
  const enWords = (stripped.match(/[A-Za-z]{2,}/g) || []).length;
  if (enWords === 0) return false;
  const hanCount = (stripped.match(/[\u3400-\u9fff]/g) || []).length;
  if (hanCount === 0) return true;
  return enWords >= 2 && hanCount < enWords * 0.8;
}

/**
 * Try to split a failed sentence into 2+ natural clauses (outside backticks)
 * so each clause carries fewer sentinels before dropping to atomic segment fallback.
 */
function splitIntoClauses(sentence) {
  const candidates = [];
  let openTicks = 0;

  for (let i = 0; i < sentence.length; i++) {
    if (sentence[i] === '`') {
      let run = 0;
      while (i + run < sentence.length && sentence[i + run] === '`') run++;
      if (openTicks === 0) openTicks = run;
      else if (run === openTicks) openTicks = 0;
      i += run - 1;
      continue;
    }
    if (openTicks > 0) continue;

    // Clause punctuation (, ; —) followed by space
    if ((sentence[i] === ',' || sentence[i] === ';' || sentence[i] === '—') && /\s/.test(sentence[i + 1] || '')) {
      const cut = i + 1;
      if (cut >= 12 && sentence.length - cut >= 12) {
        candidates.push({ index: cut, joiner: '，' });
      }
      continue;
    }

    // Subordinating conjunctions preceded by whitespace
    if (sentence[i] === ' ' && i >= 12 && sentence.length - i >= 12) {
      const rest = sentence.slice(i + 1);
      if (/^(?:when|while|before|after|because|since|if|unless|although|though|whereas|where)\b/i.test(rest)) {
        candidates.push({ index: i, joiner: '，' });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Pick the split point closest to the middle of the sentence.
  const mid = sentence.length / 2;
  candidates.sort((a, b) => Math.abs(a.index - mid) - Math.abs(b.index - mid));
  const best = candidates[0];
  const left = sentence.slice(0, best.index).trim();
  const right = sentence.slice(best.index).trim();
  if (!left || !right) return null;
  return { clauses: [left, right], joiner: best.joiner };
}

/**
 * Atomic sentinel-free segment-by-segment fallback for a sentence/clause.
 * Splits directly on all Tier 1 (verbatim) + Tier 2 (glossary) spans so ZERO
 * sentinels are sent to the model and ZERO code spans can ever be lost.
 */
function buildAtomicFallbackPlan(sentence, allSpans) {
  const spans = allSpans || (() => {
    const t1 = collectTier1Spans(sentence);
    const t2 = collectTier2Spans(sentence, t1);
    return [...t1, ...t2].sort((a, b) => a.start - b.start);
  })();

  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      pieces.push({ kind: 'prose', text: sentence.slice(cursor, span.start) });
    }
    pieces.push({ kind: 'span', text: span.replacement, tier: span.tier });
    cursor = span.end;
  }
  if (cursor < sentence.length) {
    pieces.push({ kind: 'prose', text: sentence.slice(cursor) });
  }
  return pieces;
}

function splitAtomicProsePiece(raw) {
  const m = /^([\s)\]}'"”’）]*)(.*?)([\s(\[{'“‘（]*)$/.exec(raw);
  if (!m) return { lead: '', core: raw, trail: '' };
  return { lead: m[1], core: m[2], trail: m[3] };
}

function finalizeAtomicFallback(pieces, translatedMap) {
  const parts = pieces.map((piece, idx) => {
    if (piece.kind === 'span') return piece.text;
    const translated = translatedMap.get(idx);
    if (translated === undefined) {
      return piece.text;
    }
    const { lead, trail } = splitAtomicProsePiece(piece.text);
    return lead + normalizeZhPunctuation(translated.trim()) + trail;
  });
  let joined = normalizeZhPunctuation(parts.join(''));
  // Convert trailing ASCII sentence period to Chinese full stop when sentence is Chinese.
  if (CJK_RE.test(joined)) {
    joined = joined.replace(/(?<!\.)\.([ \t]*)$/, '。$1');
  }
  return tidyZhSpacing(joined);
}

// Line-leading Markdown marker regex:
// Matches indentation, optional nested blockquotes, and optional heading / checkbox / list marker.
const MD_LINE_PREFIX_RE =
  /^([ \t]*(?:(?:>[ \t]*)+(?:(?:#{1,6}[ \t]+)|(?:[-*+][ \t]+\[[ xX]\][ \t]+)|(?:[-*+][ \t]+)|(?:\d+[.)][ \t]+))?|(?:(?:#{1,6}[ \t]+)|(?:[-*+][ \t]+\[[ xX]\][ \t]+)|(?:[-*+][ \t]+)|(?:\d+[.)][ \t]+))))/;

function splitMarkdownLine(line) {
  const mdMatch = MD_LINE_PREFIX_RE.exec(line);
  let prefix = mdMatch ? mdMatch[1] : '';
  let rest = line.slice(prefix.length);

  // Preserve any additional leading horizontal whitespace.
  const leadWs = (/^[ \t]+/.exec(rest) || [''])[0];
  prefix += leadWs;
  rest = rest.slice(leadWs.length);

  // Preserve exact trailing horizontal whitespace.
  const trailWs = (/[ \t]+$/.exec(rest) || [''])[0];
  const body = trailWs ? rest.slice(0, rest.length - trailWs.length) : rest;

  return { prefix, body, suffix: trailWs };
}

/**
 * Parse optional outer **bold** wrapper or leading **Bold label:** on a line body.
 */
function parseBoldStructure(body) {
  // Whole-line bold: **Analyzing the translation pipeline** (single balanced outer bold)
  const wholeBold = /^\*\*((?:(?!\*\*).)+)\*\*$/.exec(body);
  if (wholeBold) {
    return { kind: 'whole-bold', inner: wholeBold[1] };
  }
  // Leading bold label: **Note:** Check the file. / **Step 1**: Check the file.
  const leadBold = /^\*\*((?:(?!\*\*).)+?)\*\*([:：]?)([ \t]+)(.+)$/.exec(body);
  if (leadBold) {
    return {
      kind: 'lead-bold',
      label: leadBold[1],
      colon: leadBold[2],
      space: leadBold[3],
      rest: leadBold[4],
    };
  }
  return { kind: 'plain', inner: body };
}

function joinTranslatedSentences(items) {
  if (items.length === 0) return '';
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    if (i === 0) {
      out += cur.leadWs + cur.translated;
      continue;
    }
    const prev = items[i - 1];
    const prevEndsCjkPunct = /[。！？；：，]$/.test(out);
    const curStartsCjk = /^[\u3400-\u9fff\uF900-\uFAFF]/.test(cur.translated);
    if (prevEndsCjkPunct && curStartsCjk) {
      out += cur.translated;
    } else if (prev.trailWs || cur.leadWs) {
      out += (prev.trailWs || cur.leadWs) + cur.translated;
    } else {
      out += ' ' + cur.translated;
    }
  }
  const last = items[items.length - 1];
  return out + (last.trailWs || '');
}

/**
 * Translate text using the full local Bergamot engineering pipeline.
 *
 * @param {string} text
 * @param {(inputs: string[]) => string[]} batchTranslateFn
 * @returns {string}
 */
function translateWithPipeline(text, batchTranslateFn) {
  if (typeof text !== 'string' || !text) return text || '';
  if (!/[A-Za-z]{2}/.test(text)) return text;

  // Split preserving exact line endings (\r\n or \n).
  const rawTokens = text.split(/(\r?\n)/);

  // Track fenced code blocks line by line.
  let openFenceChar = null;
  let openFenceLen = 0;

  // Collect all translatable sentence jobs across the entire input so they execute in ONE batch call.
  const sentenceJobs = [];
  const linePlans = [];

  for (let idx = 0; idx < rawTokens.length; idx++) {
    // Odd indices are exact newline delimiters.
    if (idx % 2 === 1) {
      linePlans.push({ kind: 'raw', text: rawTokens[idx] });
      continue;
    }

    const line = rawTokens[idx];
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);

    if (openFenceChar) {
      linePlans.push({ kind: 'raw', text: line });
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
      // Single-line fenced block (e.g. ```const x = 1```): keep verbatim without opening multi-line fence.
      const singleLineCloseRe = new RegExp(`${escapeRegex(ch)}{${len},}[ \\t]*$`);
      if (tail && singleLineCloseRe.test(tail)) {
        linePlans.push({ kind: 'raw', text: line });
        continue;
      }
      openFenceChar = ch;
      openFenceLen = len;
      linePlans.push({ kind: 'raw', text: line });
      continue;
    }

    if (!line.trim() || !/[A-Za-z]{2}/.test(line)) {
      linePlans.push({ kind: 'raw', text: line });
      continue;
    }

    const { prefix, body, suffix } = splitMarkdownLine(line);
    if (!body || !/[A-Za-z]{2}/.test(body)) {
      linePlans.push({ kind: 'raw', text: line });
      continue;
    }

    const boldStruct = parseBoldStructure(body);
    const enqueueParts = (segmentText) => {
      const parts = splitSentenceParts(segmentText);
      return parts.map((part) => {
        const prot = protectSentence(part.text);
        const job = {
          original: part.text,
          leadWs: part.leadWs,
          trailWs: part.trailWs,
          prot,
          needsModel: hasTranslatableEnglish(prot.masked, prot.placeholders),
          translated: null,
        };
        sentenceJobs.push(job);
        return job;
      });
    };

    if (boldStruct.kind === 'whole-bold') {
      linePlans.push({
        kind: 'line',
        prefix,
        suffix,
        boldKind: 'whole-bold',
        bodyJobs: enqueueParts(boldStruct.inner),
      });
    } else if (boldStruct.kind === 'lead-bold') {
      linePlans.push({
        kind: 'line',
        prefix,
        suffix,
        boldKind: 'lead-bold',
        colon: boldStruct.colon,
        space: boldStruct.space,
        labelJobs: enqueueParts(boldStruct.label),
        bodyJobs: enqueueParts(boldStruct.rest),
      });
    } else {
      linePlans.push({
        kind: 'line',
        prefix,
        suffix,
        boldKind: 'plain',
        bodyJobs: enqueueParts(boldStruct.inner),
      });
    }
  }

  // Pass 1: Batch-translate all sentences without Tier-1 overflow in ONE Bergamot call.
  const primaryBatchJobs = [];
  const primaryBatchInputs = [];
  const failedJobs = [];

  for (const job of sentenceJobs) {
    if (!job.needsModel) {
      // No English prose left outside sentinels; restore Tier 2 glossary if any, keep Tier 1 verbatim.
      const restored = restoreSentence(job.prot.masked, job.prot);
      job.translated = restored.ok ? restored.text : job.original;
      continue;
    }
    if (job.prot.overflowTier1) {
      failedJobs.push(job);
      continue;
    }
    primaryBatchJobs.push(job);
    primaryBatchInputs.push(job.prot.masked);
  }

  if (primaryBatchInputs.length > 0) {
    const primaryOutputs = batchTranslateFn(primaryBatchInputs);
    for (let i = 0; i < primaryBatchJobs.length; i++) {
      const job = primaryBatchJobs[i];
      const rawTranslated = String((primaryOutputs && primaryOutputs[i]) || '');
      const restored = restoreSentence(rawTranslated, job.prot);
      if (restored.ok && restored.text) {
        job.translated = restored.text;
      } else {
        failedJobs.push(job);
      }
    }
  }

  // Fallback Stage 1 (clause split) -> Stage 2 (atomic sentinel-free segment-by-segment).
  if (failedJobs.length > 0) {
    const clausePlans = [];
    const clauseBatchJobs = [];
    const clauseBatchInputs = [];
    const atomicTargets = [];

    for (const job of failedJobs) {
      const split = job.prot.allSpans.length >= 2 ? splitIntoClauses(job.original) : null;
      if (split) {
        const subJobs = split.clauses.map((clauseText) => {
          const prot = protectSentence(clauseText);
          return {
            original: clauseText,
            prot,
            needsModel: hasTranslatableEnglish(prot.masked, prot.placeholders),
            translated: null,
          };
        });
        const strictlySmaller = subJobs.every(
          (sub) => !sub.prot.overflowTier1 && sub.prot.allSpans.length < job.prot.allSpans.length
        );
        if (strictlySmaller) {
          clausePlans.push({ parentJob: job, joiner: split.joiner, subJobs });
          for (const sub of subJobs) {
            if (!sub.needsModel) {
              const restored = restoreSentence(sub.prot.masked, sub.prot);
              sub.translated = restored.ok ? restored.text : sub.original;
            } else {
              clauseBatchJobs.push(sub);
              clauseBatchInputs.push(sub.prot.masked);
            }
          }
          continue;
        }
      }

      atomicTargets.push({ target: job, original: job.original, allSpans: job.prot.allSpans });
    }

    if (clauseBatchInputs.length > 0) {
      const clauseOutputs = batchTranslateFn(clauseBatchInputs);
      for (let i = 0; i < clauseBatchJobs.length; i++) {
        const sub = clauseBatchJobs[i];
        const rawOut = String((clauseOutputs && clauseOutputs[i]) || '');
        const restored = restoreSentence(rawOut, sub.prot);
        if (restored.ok && restored.text) {
          sub.translated = restored.text;
        } else {
          atomicTargets.push({ target: sub, original: sub.original, allSpans: sub.prot.allSpans });
        }
      }
    }

    // Stage 2: Atomic sentinel-free segment-by-segment translation (100% leak-proof).
    if (atomicTargets.length > 0) {
      const atomicPlans = [];
      const atomicInputs = [];
      const atomicRefs = [];

      for (const item of atomicTargets) {
        const pieces = buildAtomicFallbackPlan(item.original, item.allSpans);
        const translatedMap = new Map();
        atomicPlans.push({ target: item.target, pieces, translatedMap });
        pieces.forEach((piece, pieceIdx) => {
          if (piece.kind === 'prose') {
            const { core } = splitAtomicProsePiece(piece.text);
            if (/[A-Za-z]{2}/.test(core)) {
              atomicInputs.push(core);
              atomicRefs.push({ translatedMap, pieceIdx });
            }
          }
        });
      }

      if (atomicInputs.length > 0) {
        const atomicOutputs = batchTranslateFn(atomicInputs);
        for (let i = 0; i < atomicRefs.length; i++) {
          const ref = atomicRefs[i];
          ref.translatedMap.set(ref.pieceIdx, String((atomicOutputs && atomicOutputs[i]) || ''));
        }
      }

      for (const plan of atomicPlans) {
        plan.target.translated = finalizeAtomicFallback(plan.pieces, plan.translatedMap);
      }
    }

    // Recombine successful clause-split jobs.
    for (const plan of clausePlans) {
      const joined = plan.subJobs
        .map((sub) => sub.translated || sub.original)
        .reduce((acc, cur, idx) => {
          if (idx === 0) return cur;
          if (/[，。！？；：,;:]$/.test(acc)) return acc + cur;
          return acc + plan.joiner + cur;
        }, '');
      plan.parentJob.translated = tidyZhSpacing(normalizeZhPunctuation(joined));
    }
  }

  // Reassemble full text preserving exact newlines, Markdown prefixes, and bold wrappers.
  return linePlans
    .map((plan) => {
      if (plan.kind === 'raw') return plan.text;
      if (plan.boldKind === 'whole-bold') {
        const inner = joinTranslatedSentences(plan.bodyJobs);
        return `${plan.prefix}**${inner}**${plan.suffix}`;
      }
      if (plan.boldKind === 'lead-bold') {
        const label = joinTranslatedSentences(plan.labelJobs);
        const rest = joinTranslatedSentences(plan.bodyJobs);
        const colon = plan.colon ? (CJK_RE.test(label) || CJK_RE.test(rest) ? '：' : plan.colon) : '';
        const sep = colon === '：' && CJK_RE.test(rest) ? '' : plan.space;
        return `${plan.prefix}**${label}**${colon}${sep}${rest}${plan.suffix}`;
      }
      const body = joinTranslatedSentences(plan.bodyJobs);
      return `${plan.prefix}${body}${plan.suffix}`;
    })
    .join('');
}

module.exports = {
  MAX_SENTINELS_PER_SENTENCE,
  GLOSSARY_ENTRIES,
  pickSentinelPrefix,
  splitSentences,
  protectSentence,
  restoreSentence,
  normalizeZhPunctuation,
  tidyZhSpacing,
  translateWithPipeline,
};

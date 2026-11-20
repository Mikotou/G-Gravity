import { performance } from 'node:perf_hooks';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import type { ApproveForMeConfig, DeterministicScreeningResult } from '../../shared/approval-contract';

export interface ShellAnalysis {
  segments: string[];
  tokens: string[];
  complex: boolean;
  malformed: boolean;
  hasUnsafeSyntax?: boolean;
  segmentTokens?: string[][];
  operators?: Array<'|' | ';' | '&&'>;
}

function stripMatchingQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

const SAFE_PWSH_EXIT_GUARD_RE = /^if\s*\(\s*\$LASTEXITCODE\s*-eq\s*0\s*\)\s*\{\s*([\s\S]+?)\s*\}\s*$/i;

/** 在单个命令片段内保留引号包住的参数边界，同时记录未闭合引号和需要人工判断的动态语法。 */
function tokenizeSimpleSegment(rawSegment: string): { tokens: string[]; hasUnsafeSyntax: boolean; malformed: boolean } {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let hasUnsafeSyntax = false;
  let malformed = false;

  const flush = () => {
    if (token) {
      tokens.push(stripMatchingQuotes(token));
      token = '';
    }
  };

  for (let i = 0; i < rawSegment.length; i++) {
    const c = rawSegment[i];
    const next = rawSegment[i + 1] || '';
    if (quote) {
      token += c;
      if (c === quote) {
        quote = '';
      } else if (quote === '"' && (c === '`' || c === '$')) {
        hasUnsafeSyntax = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      token += c;
      continue;
    }
    if (c === '\0') {
      malformed = true;
      continue;
    }
    if (c === '$' || c === '`' || c === '>' || c === '<' || c === '(' || c === ')' || c === '{' || c === '}') {
      hasUnsafeSyntax = true;
    }
    if (c === '%' && /%[A-Za-z_][\w]*%/.test(rawSegment.slice(i))) {
      hasUnsafeSyntax = true;
    }
    if (c === '&' && next !== '&') {
      hasUnsafeSyntax = true;
    }
    if (/\s/.test(c)) {
      flush();
    } else {
      token += c;
    }
  }
  flush();
  if (quote) malformed = true;
  return { tokens, hasUnsafeSyntax, malformed };
}

/**
 * 词法与多段管道切分器：
 * - 正确识别单双引号内的管道符 `|`、分号 `;`、反斜杠路径与正则模式（如 `Select-String -Pattern "A|B"`）；
 * - 对命令替换 `$()` / `` ` ``、变量展开 `$VAR`、输出重定向 `>` / `<`、任意脚本块 `{...}` 严格标记 `hasUnsafeSyntax = true` 转交人工。
 */
export function parseShellCommand(command: string): ShellAnalysis {
  const segments: string[] = [];
  const tokens: string[] = [];
  const segmentTokens: string[][] = [];
  const operators: Array<'|' | ';' | '&&'> = [];

  let segment = '';
  let token = '';
  let quote = '';
  let complex = false;
  let hasUnsafeSyntax = false;
  let malformed = false;

  const flushToken = () => {
    if (token) {
      tokens.push(token);
      token = '';
    }
  };
  // 按出现顺序同时保存片段和连接符。后续分类需要知道某段是独立命令还是上一段的管道下游。
  const flushSegment = (op?: '|' | ';' | '&&') => {
    flushToken();
    const trimmed = segment.trim();
    if (trimmed) {
      segments.push(trimmed);
      if (op) operators.push(op);
      const unwrapped = SAFE_PWSH_EXIT_GUARD_RE.exec(trimmed)?.[1]?.trim() ?? trimmed;
      const sub = tokenizeSimpleSegment(unwrapped);
      if (sub.malformed) malformed = true;
      if (sub.hasUnsafeSyntax) hasUnsafeSyntax = true;
      segmentTokens.push(sub.tokens);
    }
    segment = '';
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1] || '';

    if (quote) {
      segment += c;
      token += c;
      if (c === quote) {
        quote = '';
      } else if (quote === '"' && (c === '`' || c === '$')) {
        complex = true;
        hasUnsafeSyntax = true;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      segment += c;
      token += c;
      continue;
    }

    if (c === '\0') {
      malformed = true;
      continue;
    }

    if (c === '&' && next === '&') {
      complex = true;
      flushSegment('&&');
      i++;
      continue;
    }

    if (c === '|' && next === '|') {
      complex = true;
      hasUnsafeSyntax = true;
      flushSegment(';');
      i++;
      continue;
    }

    if (c === '|') {
      complex = true;
      flushSegment('|');
      continue;
    }

    if (c === ';' || c === '\r' || c === '\n') {
      complex = true;
      flushSegment(';');
      continue;
    }

    if (c === '&') {
      complex = true;
      hasUnsafeSyntax = true;
      flushSegment(';');
      continue;
    }

    if ('$`><(){}[]%!*?^'.includes(c)) {
      complex = true;
      if ('`><'.includes(c)) {
        hasUnsafeSyntax = true;
      }
    }

    segment += c;
    if (/\s/.test(c)) flushToken();
    else token += c;
  }

  flushSegment();
  if (quote) malformed = true;

  return { segments, tokens, complex, malformed, hasUnsafeSyntax, segmentTokens, operators };
}

export function compileSafePattern(pattern: string): RegExp {
  // 不在 UI 线程执行可回溯的任意复杂正则；允许锚点、字符类和少量简单量词。
  if (
    typeof pattern !== 'string' ||
    pattern.length > 200 ||
    /[(){}]|\\[1-9]|\(\?/.test(pattern) ||
    (pattern.match(/[+*]/g)?.length || 0) > 1 ||
    (pattern.match(/\?/g)?.length || 0) > 4 ||
    (/[+*]/.test(pattern) && !pattern.startsWith('^'))
  ) {
    throw new Error('审批正则过于复杂：请使用锚点、字符类和简单匹配，避免分组、回溯引用或大量量词');
  }
  try {
    return new RegExp(pattern, 'i');
  } catch {
    throw new Error('审批规则不是有效的正则表达式');
  }
}

/**
 * 绝对禁区判定（Tier 1 — Hard Deny，读写全禁，覆盖 Windows 与 macOS）：
 * 严格遵循 Google / Gemini ToS 与账号安全红线，拦截一切认证凭据、OAuth 令牌、Cookie、密钥、
 * macOS Keychain / 钥匙串导出命令、Antigravity Desktop 认证存储、设备标识（installation_id）、
 * 内部加密状态库（state.vscdb / *.pb / *.pbtxt）及云凭据目录。
 * 不再对 `.gemini` 整体一刀切，而是由 `inspectGeminiPathPolicy()` 对 `.gemini` 与 macOS `Application Support/Antigravity` 各子目录分级治理。
 */
export function sensitiveTarget(value: string): boolean {
  if (!value) return false;
  if (isForbiddenCredentialOrStatePath(value)) return true;
  const normalized = value.replace(/\\\\/g, '/').replace(/\\ /g, ' ').replace(/\\/g, '/');
  if (
    /(?:^|[\/\s"'])(?:\.ssh|\.aws|\.azure|\.gnupg)(?:[\/\s"']|$)/i.test(normalized) ||
    /(?:oauth|refresh[_-]?token|access[_-]?token|id[_-]?token|installation_id|state\.vscdb|\.pbtxt|credentials|cookies?|\.env(?:\.[a-z0-9_-]+)?|id_rsa|id_ed25519|google_accounts\.json|application_default_credentials\.json|user_settings\.pb|antigravity_auth|auth_state)(?:\b|[\/])/i.test(
      normalized
    )
  ) {
    return true;
  }
  // macOS 专属敏感区：系统/用户钥匙串、Safari/系统 Cookies、macOS `security` 密码导出命令、Antigravity Desktop 认证存储及 sudoers
  if (
    /(?:^|[\/\s"'])(?:Library\/Keychains|Library\/Cookies)(?:[\/\s"']|$)/i.test(normalized) ||
    /\.(?:keychain|keychain-db|binarycookies)(?:\b|$)/i.test(normalized) ||
    /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain|export|delete-(?:generic|internet)-password|unlock-keychain)\b/i.test(
      normalized
    ) ||
    /(?:^|\/)(?:private\/)?etc\/sudoers(?:\.d\/|$|[\s"'])|(?:^|\/)private\/var\/db\/dslocal\/nodes\/Default\/users(?:\/|$)/i.test(
      normalized
    ) ||
    /Library\/Application Support\/Antigravity\/(?:Cookies|Network|Local Storage|Session Storage|IndexedDB|DIPS|Trust Tokens|User\/globalStorage\/state\.vscdb)(?:\/|$|[\s"'])/i.test(
      normalized
    )
  ) {
    return true;
  }
  // `.gemini` / `antigravity-cli` 下的任意 `.pb` 二进制状态、官方二进制目录及认证子目录均属于绝对禁区
  if (
    /(?:^|[\/\s"'])(?:\.gemini|antigravity(?:-cli)?)\/[^"'\s]*\.pb(?:txt)?(?:\b|$)/i.test(normalized) ||
    /(?:^|[\/\s"'])(?:\.gemini|antigravity(?:-cli)?)\/(?:antigravity(?:-cli)?\/)?(?:auth|accounts?|credentials?|tokens?|secrets?|keys?|cookies?|daemon|sessions_auth)(?:\/|$|[\s"'])/i.test(
      normalized
    )
  ) {
    return true;
  }
  return false;
}

export type GeminiPathPolicyTier = 'none' | 'user_custom' | 'readonly_official' | 'unknown_gemini' | 'forbidden';

export interface GeminiPathPolicyResult {
  tier: GeminiPathPolicyTier;
  matchedPaths: string[];
  reason?: string;
}

const GEMINI_TIER_PRIORITY: Record<GeminiPathPolicyTier, number> = {
  none: 0,
  user_custom: 1,
  readonly_official: 2,
  unknown_gemini: 3,
  forbidden: 4,
};

/**
 * 判断单个 `.gemini` / `antigravity-cli` / macOS `Library/Application Support/Antigravity` 路径片段所属的安全分级：
 * - `forbidden`（Tier 1，读写全禁）：命中凭据/私钥/Keychain/状态库、含 `..` 穿越、或指向官方 `bin` 可执行目录；
 * - `user_custom`（Tier 3，允许只读，修改需人工确认）：用户全局规则（`GEMINI.md`/`AGENTS.md`）、自定义 `skills`/`plugins`/`rules`/`workflows`/`hooks.json` 及 macOS Antigravity 用户片段；
 * - `readonly_official`（Tier 2，严格只读，严禁写入/修改）：官方会话历史（`brain`/`conversations`/`history`/`conversation_summaries.db`）、内置文档（`builtin`/`mcp`/`knowledge`/`code_tracker`）及官方主配置（`settings.json`/`mcp_config.json`）；
 * - `unknown_gemini`（兜底）：`.gemini` 或 macOS `Application Support/Antigravity` 根目录或未分类子路径（读取需人工确认，写入硬拒绝）。
 */
function classifySingleGeminiPath(rawPath: string): GeminiPathPolicyTier {
  const cleaned = rawPath
    .replace(/\\\\/g, '/')
    .replace(/\\ /g, ' ')
    .replace(/\\/g, '/')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!cleaned) return 'none';
  if (sensitiveTarget(cleaned)) return 'forbidden';

  const lowerCleaned = cleaned.toLowerCase();
  const geminiIdx = lowerCleaned.search(/(?:^|\/)\.gemini(?:\/|$)/);
  const cliIdx = lowerCleaned.search(/(?:^|\/)antigravity-cli(?:\/|$)/);
  const macDesktopIdx = lowerCleaned.search(/(?:^|\/)library\/application support\/antigravity(?:\/|$)/);
  if (geminiIdx < 0 && cliIdx < 0 && macDesktopIdx < 0) return 'none';

  let rel = '';
  let rootKind: 'gemini' | 'cli' | 'mac_desktop' = 'gemini';
  if (geminiIdx >= 0) {
    const after = cleaned.slice(geminiIdx).replace(/^\/?\.gemini\/?/i, '');
    rel = after.replace(/\/+$/, '');
    rootKind = 'gemini';
  } else if (cliIdx >= 0) {
    const after = cleaned.slice(cliIdx).replace(/^\/?antigravity-cli\/?/i, '');
    rel = after.replace(/\/+$/, '');
    rootKind = 'cli';
  } else {
    const after = cleaned.slice(macDesktopIdx).replace(/^\/?library\/application support\/antigravity\/?/i, '');
    rel = after.replace(/\/+$/, '');
    rootKind = 'mac_desktop';
  }

  // 严禁利用 `..` 从白名单子目录穿越到凭据或上级受保护目录
  if (/(?:^|\/)\.\.(?:\/|$)/.test(rel)) return 'forbidden';

  const lower = rel.toLowerCase();
  // 官方二进制/运行时核心目录禁止触碰
  if (/^(?:antigravity(?:-cli)?\/)?bin(?:\/|$)/.test(lower)) return 'forbidden';

  if (rootKind === 'mac_desktop') {
    if (/^user\/(?:snippets|prompts)(?:\/|$)/.test(lower)) {
      return 'user_custom';
    }
    if (/^(?:user\/(?:settings|keybindings)\.json|logs(?:\/|$)|cacheddata(?:\/|$))/.test(lower)) {
      return 'readonly_official';
    }
    return 'unknown_gemini';
  }

  if (rootKind === 'cli') {
    if (
      /^(?:brain|conversations|history|builtin|mcp|knowledge|code_tracker)(?:\/|$)/.test(lower) ||
      /^conversation_summaries\.db(?:-wal)?$/.test(lower) ||
      /^(?:settings|mcp_config|config)\.json$/.test(lower)
    ) {
      return 'readonly_official';
    }
    return 'unknown_gemini';
  }

  // Tier 3：用户自建扩展、规则、技能与插件目录（含插件自身数据日志如 approve-for-me/data/audit.jsonl）
  if (
    /^(?:gemini|agents)\.md$/.test(lower) ||
    /^config\/(?:skills|plugins|rules|workflows)(?:\/|$)/.test(lower) ||
    /^config\/hooks\.json$/.test(lower) ||
    /^(?:skills|plugins|rules|workflows)(?:\/|$)/.test(lower) ||
    /^antigravity\/(?:global_workflows|skills|plugins|rules)(?:\/|$)/.test(lower)
  ) {
    return 'user_custom';
  }

  // Tier 2：官方运行时历史/脑库/内置文档/只读配置（允许查阅，严禁写入篡改）
  if (
    /^antigravity(?:-cli)?\/(?:brain|conversations|history|builtin|mcp|knowledge|code_tracker)(?:\/|$)/.test(lower) ||
    /^antigravity(?:-cli)?\/conversation_summaries\.db(?:-wal)?$/.test(lower) ||
    /^(?:antigravity(?:-cli)?\/|config\/)?(?:settings|mcp_config|config)\.json$/.test(lower)
  ) {
    return 'readonly_official';
  }

  return 'unknown_gemini';
}

const GEMINI_OR_MAC_ANTIGRAVITY_RE = /(?:\.gemini|antigravity-cli|Library\/Application Support\/Antigravity)/i;

/** 从命令文本、路径数组及工作目录中提取全部 `.gemini` / `antigravity-cli` / macOS Antigravity 路径并取最严格分级。 */
export function inspectGeminiPathPolicy(
  rawText: string,
  candidatePaths: readonly string[] = [],
  cwd = ''
): GeminiPathPolicyResult {
  const candidates = new Set<string>();
  const normalized = (rawText || '').replace(/\\\\/g, '/').replace(/\\ /g, ' ').replace(/\\/g, '/');

  for (const p of [...candidatePaths, cwd]) {
    const np = (p || '').replace(/\\\\/g, '/').replace(/\\ /g, ' ').replace(/\\/g, '/');
    if (np && GEMINI_OR_MAC_ANTIGRAVITY_RE.test(np)) candidates.add(np);
  }
  // 1) 提取引号包裹的完整路径（保留含空格路径，如 macOS `~/Library/Application Support/Antigravity/...` 或 Windows `C:/Users/My Name/.gemini/...`）
  for (const m of normalized.matchAll(/["']([^"'\r\n]*(?:\.gemini|antigravity-cli|Library\/Application Support\/Antigravity)[^"'\r\n]*)["']/gi)) {
    if (m[1]) candidates.add(m[1]);
  }
  // 2) 提取未加引号的路径令牌（含 macOS `Application Support/Antigravity` 含空格前缀）
  for (const m of normalized.matchAll(
    /(?:^|[\s"'`(=:,;])([^\s"'`(=:,;]*?(?:Library\/Application Support\/Antigravity|\.gemini|antigravity-cli)(?:\/[^\s"'`,;)}\]]*)?)/gi
  )) {
    if (m[1]) candidates.add(m[1]);
  }

  let worst: GeminiPathPolicyTier = 'none';
  const matchedPaths: string[] = [];
  for (const item of candidates) {
    const tier = classifySingleGeminiPath(item);
    if (tier !== 'none') {
      matchedPaths.push(item);
      if (GEMINI_TIER_PRIORITY[tier] > GEMINI_TIER_PRIORITY[worst]) {
        worst = tier;
      }
    }
  }

  const reasonMap: Partial<Record<GeminiPathPolicyTier, string>> = {
    forbidden: '涉及 .gemini / Antigravity 下的敏感凭据、认证状态、私钥、二进制目录或路径穿越，客户端硬性拒绝',
    readonly_official: '目标位于 .gemini / Antigravity 官方只读数据/历史/受控配置区（只读查阅受保护，严禁直接写入或修改）',
    user_custom: '目标位于 .gemini / Antigravity 用户自定义规则/技能/插件目录（允许只读查阅，修改需人工确认）',
    unknown_gemini: '目标位于 .gemini / Antigravity 根目录或未白名单子目录（读取需人工核对确认，严禁直接写入）',
  };

  return {
    tier: worst,
    matchedPaths,
    reason: reasonMap[worst],
  };
}

/**
 * 检测 Shell / PowerShell / macOS zsh 命令是否包含文件写入、覆盖、删除、重定向、属性修改或数据库写操作意图，
 * 用于在 `.gemini` 与 macOS `Application Support/Antigravity` 只读保护区准确区分“安全查阅”与“禁止篡改”。
 */
export function isMutatingShellCommand(command: string): boolean {
  if (!command) return false;
  // 剥离引号内字面量以检测真实的重定向符号（避开 `->`、`=>` 及字符串内的 `>`）
  const unquoted = command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/(?:^|[^-=!<>])(?:[12*&]?)>{1,2}(?!\s*&)/.test(unquoted)) {
    return true;
  }
  return (
    /(?:^|[\s;|&(])(?:rm|rmdir|rd|del|erase|mv|move|ren|rename|cp|copy|ln|install|rsync|ditto|mkdir|mktemp|touch|truncate|chmod|chown|chflags|icacls|takeown|tee|dd|shred|remove-item|ri|set-content|sc|add-content|ac|out-file|clear-content|clc|new-item|ni|move-item|mi|rename-item|rni|copy-item|cpi)(?=$|[\s;|&)])/i.test(
      unquoted
    ) ||
    /\bxattr\s+(?:-[a-z]*[wdcr]|--(?:write|delete|clear))\b/i.test(unquoted) ||
    /\bplutil\s+-(?:replace|insert|remove|convert|create)\b/i.test(unquoted) ||
    /\bdefaults\s+(?:write|delete|import|rename)\b/i.test(unquoted) ||
    /\blaunchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|remove)\b/i.test(unquoted) ||
    /\bsed\s+-[a-z]*i\b|\bperl\s+-[a-z]*i\b/i.test(unquoted) ||
    /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmSync|rmdirSync|renameSync|truncateSync|copyFile(?:Sync)?)\b/i.test(
      command
    ) ||
    /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|VACUUM)\b/i.test(command)
  );
}

/**
 * 为转交人工审理或审计的命令/工具调用生成清晰的人类可读「代码明确用意」与「作用范围」说明。
 */
export function describeOperationIntent(
  command: string,
  cwd: string,
  toolName = 'run_command',
  rawInput?: unknown,
  segments: string[] = []
): { meaning: string; target: string } {
  const rec = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const declaredSummary =
    typeof rec.toolSummary === 'string' && rec.toolSummary.trim()
      ? rec.toolSummary.trim()
      : typeof rec.description === 'string' && rec.description.trim()
        ? rec.description.trim()
        : '';

  const filePath =
    typeof rec.Path === 'string'
      ? rec.Path
      : typeof rec.path === 'string'
        ? rec.path
        : typeof rec.file_path === 'string'
          ? rec.file_path
          : typeof rec.filePath === 'string'
            ? rec.filePath
            : typeof rec.DirectoryPath === 'string'
              ? rec.DirectoryPath
              : typeof rec.SearchPath === 'string'
                ? rec.SearchPath
                : '';

  // 0. 只读文件读取 / 目录列举 / 代码搜索工具的精确用意解析
  if (/^(read|read_file|view_file|view_file_outline|view_code_item|list_dir|glob|find_by_name|grep|grep_search|search)$/i.test(toolName)) {
    const isSearch = /^(grep|grep_search|search|glob|find_by_name)$/i.test(toolName);
    const queryHint =
      typeof rec.Query === 'string'
        ? `（检索词：\`${rec.Query.slice(0, 48)}\`）`
        : typeof rec.Pattern === 'string'
          ? `（匹配模式：\`${rec.Pattern.slice(0, 48)}\`）`
          : '';
    const targetDisplay = filePath || command.replace(/^\S+\s+/, '').trim() || cwd;
    const summaryPart = declaredSummary ? `（目的：${declaredSummary}）` : '';
    return {
      meaning: isSearch
        ? `只读检索目录或代码内容 \`${targetDisplay}\`${queryHint}${summaryPart}，不修改任何文件`
        : `只读读取本地文件或目录 \`${targetDisplay}\`${summaryPart}，不修改任何文件内容`,
      target: `读取目标：${targetDisplay}`,
    };
  }

  // 1. 文件编辑 / 创建类工具的精确代码用意解析
  if (/^(edit|edit_file|replace)$/i.test(toolName) || (filePath && ('Target' in rec || 'oldText' in rec || 'old_string' in rec))) {
    const oldStr = String(rec.Target ?? rec.oldText ?? rec.old_string ?? '');
    const newStr = String(rec.Replacement ?? rec.newText ?? rec.new_string ?? '');
    const oldLines = oldStr ? oldStr.split(/\r?\n/).length : 0;
    const newLines = newStr ? newStr.split(/\r?\n/).length : 0;
    const symMatch = /(?:function|class|interface|type|const|export\s+(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/.exec(
      `${newStr}\n${oldStr}`
    );
    const symDesc = symMatch ? `（涉及符号 \`${symMatch[1]}\`）` : '';
    const summaryPart = declaredSummary ? `（任务目标：${declaredSummary}）` : '';
    return {
      meaning: `修改源码文件 ${filePath || '目标文件'}：将 ${oldLines} 行旧代码替换为 ${newLines} 行新代码${symDesc}${summaryPart}`,
      target: `目标文件：${filePath || cwd}`,
    };
  }

  if (/^(write|write_file|create_file)$/i.test(toolName) || (filePath && ('Content' in rec || 'content' in rec))) {
    const content = String(rec.Content ?? rec.content ?? '');
    const lineCount = content ? content.split(/\r?\n/).length : 0;
    const modeLabel = rec.Append ? '向文件末尾追加内容' : rec.Overwrite ? '覆写/更新整份文件' : '新建并写入文件';
    return {
      meaning: `${modeLabel} ${filePath || '目标文件'}（共 ${lineCount} 行代码/文本）${declaredSummary ? `，用于：${declaredSummary}` : ''}`,
      target: `目标文件：${filePath || cwd}`,
    };
  }

  // 2. Shell / PowerShell / 脚本命令的分步语义解析
  const parts = segments.length > 0 ? segments : [command.trim()];
  const stepDescriptions: string[] = [];

  for (const seg of parts.slice(0, 4)) {
    const rawClean = seg.trim();
    if (!rawClean) continue;
    const unwrapped = SAFE_PWSH_EXIT_GUARD_RE.exec(rawClean)?.[1]?.trim();
    const clean = unwrapped || rawClean;
    const prefixGuard = unwrapped ? '前序成功后' : '';
    const lower = clean.toLowerCase();

    if (/^(?:pwd|get-location|gl)\s*$/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}查询当前终端所在工作目录路径`);
    } else if (/^git\s+status\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读检查 Git 仓库未提交变更状态`);
    } else if (/^git\s+(?:diff|log|show|branch|rev-parse|ls-files|blame)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读查看 Git 版本库信息（${clean.slice(0, 48)}）`);
    } else if (/^git\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|clean|stash)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}执行 Git 仓库状态修改或远端同步（${clean.slice(0, 60)}）`);
    } else if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|update)\b/i.test(clean) || /^pip3?\s+install\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}安装/变更项目依赖包并更新锁文件（${clean.slice(0, 64)}）`);
    } else if (/^(?:npm|pnpm|yarn|npx)\s+(?:run\s+)?(?:test|vitest|jest|playwright)\b/i.test(clean) || /^(?:pytest|cargo\s+test|go\s+test|dotnet\s+test)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}运行自动化单元测试校验代码逻辑（${clean.slice(0, 60)}）`);
    } else if (/^(?:npm|pnpm|yarn|npx)\s+(?:run\s+)?(?:build|typecheck|tsc|vite|dist|electron-builder|lint|check)\b/i.test(clean) || /^tsc\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}执行类型检查或编译打包构建产物（${clean.slice(0, 64)}）`);
    } else if (/^(?:rm|rmdir|rd|del|erase|remove-item|ri)\b/i.test(clean)) {
      const recursive = /(?:-rf|-r|-recurse|--force|\/s)/i.test(clean);
      stepDescriptions.push(`${prefixGuard}${recursive ? '递归强制删除' : '删除'}本地文件或目录（${clean.slice(0, 72)}）`);
    } else if (/^(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}向外部服务发起 HTTP 网络请求获取或提交数据（${clean.slice(0, 72)}）`);
    } else if (/^(?:node|python|python3)\s+-(?:e|c)\b/i.test(clean)) {
      const capabilities: string[] = [];
      if (/\bfs\b|open\(|writeFile|unlink|rmSync/i.test(clean)) capabilities.push('读写本地文件');
      if (/sqlite|DatabaseSync/i.test(clean)) capabilities.push('访问 SQLite 数据库');
      if (/child_process|spawn|exec|subprocess/i.test(clean)) capabilities.push('拉起外部子进程');
      if (/fetch|http|urllib|requests/i.test(clean)) capabilities.push('发起网络请求');
      const capStr = capabilities.length ? `（脚本内含：${capabilities.join('、')}）` : '';
      stepDescriptions.push(`${prefixGuard}直接执行内联脚本代码${capStr}`);
    } else if (/^(?:node|python|python3|ts-node|tsx)\s+\S+/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}运行本地脚本文件（${clean.slice(0, 72)}）`);
    } else if (/^(?:get-childitem|gci|dir|ls|get-item|gi|test-path|resolve-path|select-string|sls|rg|grep|findstr|cat|get-content|gc|type|head|tail|wc|stat)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}只读枚举本地目录或检索文本内容（${clean.slice(0, 64)}）`);
    } else if (/^(?:select-object|select|where-object|where|sort-object|sort|group-object|measure-object|format-table|format-list|out-string)\b/i.test(clean)) {
      stepDescriptions.push(`${prefixGuard}在内存中筛选/格式化输出字段（${clean.slice(0, 56)}）`);
    } else if (/^(?:get-process|gps|stop-process|taskkill|kill)\b/i.test(clean)) {
      stepDescriptions.push(lower.startsWith('get-process') || lower === 'gps' ? '只读查询当前运行中的系统进程状态' : `终止指定系统进程（${clean.slice(0, 60)}）`);
    } else {
      stepDescriptions.push(`${prefixGuard}在终端执行命令 \`${clean.slice(0, 72)}\``);
    }
  }

  if (parts.length > 4) {
    stepDescriptions.push(`等共 ${parts.length} 步串联操作`);
  }

  const redirectNote = /[12]?>+/.test(command) && !/\$LASTEXITCODE\s*-eq/.test(command) ? '（含输出重定向写入）' : '';
  const pipeNote = parts.length > 1 && command.includes('|') ? '（管道传递处理）' : '';
  const summaryPrefix = declaredSummary ? `【任务目标：${declaredSummary}】` : '';
  const meaning =
    stepDescriptions.length > 0
      ? `${summaryPrefix}${stepDescriptions.join(' → ')}${pipeNote}${redirectNote}`
      : `${summaryPrefix}请求调用 ${toolName}：${command.slice(0, 140)}`;

  return {
    meaning,
    target: `工作目录：${cwd}`,
  };
}

type SegmentTier =
  | { kind: 'read_only'; prefix?: string }
  | { kind: 'low_risk_dev'; prefix?: string }
  | { kind: 'moderate_grey'; prefix?: string }
  | { kind: 'force_ask'; reason: string };

const HIGH_RISK_EXECUTABLES = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri',
  'mv', 'move', 'move-item', 'mi', 'ren', 'rename-item', 'rni',
  'cp', 'copy', 'copy-item', 'cpi',
  'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc',
  'out-file', 'tee-object', 'tee', 'new-item', 'ni',
  'sudo', 'su', 'runas', 'gsudo',
  'format', 'mkfs', 'diskpart', 'bcdedit', 'mountvol',
  'shutdown', 'reboot', 'restart-computer', 'stop-computer', 'logoff',
  'reg', 'regedit', 'chmod', 'chown', 'icacls', 'takeown', 'set-acl', 'set-executionpolicy',
  'kill', 'taskkill', 'stop-process', 'spps', 'pkill', 'killall',
  'curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'certutil', 'bitsadmin',
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'nc', 'ncat', 'netcat', 'telnet',
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl', 'cscript', 'wscript', 'mshta', 'rundll32',
  'iex', 'invoke-expression', 'start-process', 'saps', 'start', 'invoke-command', 'icm', 'xargs',
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua',
]);

const READ_ONLY_FS_OR_TEXT_CMDLETS = new Set([
  'pwd', 'get-location', 'gl', 'whoami', 'hostname', 'uname', 'ver',
  'get-childitem', 'gci', 'dir', 'ls', 'get-item', 'gi',
  'test-path', 'resolve-path', 'split-path', 'join-path', 'get-filehash',
  'get-content', 'gc', 'cat', 'type', 'head', 'tail', 'wc', 'nl', 'stat', 'file',
  'select-string', 'sls', 'rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr',
  'which', 'where.exe', 'get-command', 'gcm', 'get-process', 'gps', 'tasklist',
]);

const READ_ONLY_MEMORY_FILTERS = new Set([
  'select-object', 'select', 'where-object', 'where', 'sort-object', 'sort',
  'group-object', 'group', 'measure-object', 'measure',
  'format-table', 'ft', 'format-list', 'fl', 'out-string',
  'convertto-json', 'convertfrom-json', 'get-unique', 'compare-object',
]);

/** 对一个已分词的片段判定风险。输入是否来自管道会影响允许的类型，结论与可记忆前缀一并返回。 */
function classifySegment(segTokens: string[], isPipeSink: boolean): SegmentTier {
  if (segTokens.length === 0) {
    return { kind: 'force_ask', reason: '存在空命令片段，转交人工确认' };
  }
  const rawExec = segTokens[0];
  const exec = rawExec.toLowerCase().replace(/\.exe$/i, '');
  const args = segTokens.slice(1);

  // 任何目录穿越 `..` 或注册表驱动器（HKLM:/HKCU:）强制人工确认
  if (
    segTokens.some((tok) => /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(tok)) ||
    segTokens.some((tok) => /^hk(?:lm|cu|cr|u|cc):/i.test(tok))
  ) {
    return { kind: 'force_ask', reason: '含跨级相对路径 `..` 或系统注册表路径，转交人工确认作用目标范围' };
  }

  // 允许纯版本号只读查询（如 node -v / python --version / git --version）
  if (
    /^(?:node|npm|pnpm|yarn|npx|python|python3|git|tsc|cargo|go|dotnet|rustc|java)$/.test(exec) &&
    args.length === 1 &&
    /^(?:--version|-v|-V)$/.test(args[0])
  ) {
    return { kind: 'read_only', prefix: `${exec} ${args[0]}` };
  }

  // 管道下游绝不允许接入解释器、Shell 或危险命令
  if (HIGH_RISK_EXECUTABLES.has(exec)) {
    return {
      kind: 'force_ask',
      reason: isPipeSink
        ? '管道下游接入了脚本解释器、Shell 或修改类命令，转交人工确认安全边界'
        : '涉及文件删除/写入、脚本解释器执行、进程控制或网络访问，转交人工确认代码用意',
    };
  }

  // 1. 纯只读本地枚举 / 文本搜索 / 内存对象过滤命令
  if (READ_ONLY_FS_OR_TEXT_CMDLETS.has(exec)) {
    return { kind: 'read_only', prefix: exec };
  }

  if (READ_ONLY_MEMORY_FILTERS.has(exec)) {
    return { kind: 'read_only', prefix: exec };
  }

  if (exec === 'find') {
    const hasExecOrDelete = args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/i.test(a));
    if (hasExecOrDelete) {
      return { kind: 'force_ask', reason: '`find` 带有执行或删除参数，转交人工确认' };
    }
    return { kind: 'read_only', prefix: 'find' };
  }

  // 2. Git 子命令精细分级
  if (exec === 'git') {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) return { kind: 'low_risk_dev', prefix: 'git' };

    if (
      /^(?:push|reset|clean|rebase|merge|cherry-pick|revert|am|apply|bisect|filter-branch|gc|prune|worktree|submodule)$/.test(sub) ||
      args.some((a) => /^(?:--force|-f|--hard|--delete|-D)$/.test(a))
    ) {
      return { kind: 'force_ask', reason: '涉及 Git 远端推送、历史重写或强制清理，转交人工确认' };
    }

    if (sub === 'status') {
      return { kind: 'low_risk_dev', prefix: 'git status' };
    }

    if (/^(?:diff|log|show|rev-parse|ls-files|blame|shortlog|describe)$/.test(sub)) {
      if (args.some((a) => /^--output(?:=|$)/i.test(a))) {
        return { kind: 'force_ask', reason: 'Git 命令含文件输出参数 `--output`，转交人工确认' };
      }
      return { kind: 'read_only', prefix: `git ${sub}` };
    }

    if (sub === 'branch') {
      const readOnlyBranchFlags = args.slice(1).every((a) => /^(?:-a|--all|-r|--remotes|-v|-vv|--list|--show-current|--contains)$/.test(a));
      if (readOnlyBranchFlags) return { kind: 'read_only', prefix: 'git branch' };
      return { kind: 'moderate_grey', prefix: 'git branch' };
    }

    if (sub === 'remote' && args.length === 2 && args[1] === '-v') {
      return { kind: 'read_only', prefix: 'git remote' };
    }

    if (/^(?:add|commit|stash|checkout|switch|tag|fetch|pull)$/.test(sub)) {
      return { kind: 'moderate_grey', prefix: `git ${sub}` };
    }

    return { kind: 'moderate_grey', prefix: /^[a-z][a-z-]*$/.test(sub) ? `git ${sub}` : undefined };
  }

  // 3. 前端 / 多语言包管理器与自动化测试、类型检查（无安装/发布副作用）
  if (/^(?:npm|pnpm|yarn)$/.test(exec)) {
    const sub = (args[0] || '').toLowerCase();
    if (/^(?:install|i|ci|add|remove|rm|uninstall|un|update|up|publish|link|unlink|exec|dlx|init|create)$/.test(sub)) {
      return { kind: 'force_ask', reason: '涉及依赖包安装、移除、发布或动态拉取执行，转交人工确认' };
    }
    if (sub === 'test' || sub === 't') {
      return { kind: 'low_risk_dev', prefix: `${exec} test` };
    }
    if (sub === 'run' && args[1]) {
      const script = args[1].toLowerCase();
      if (/^(?:test|unit|typecheck|tsc|check|lint|build|compile)(?::[a-z0-9_-]+)?$/.test(script)) {
        return { kind: 'low_risk_dev', prefix: `${exec} run ${script}` };
      }
      if (/^[a-z0-9:_-]+$/i.test(script)) {
        return { kind: 'moderate_grey', prefix: `${exec} run ${script}` };
      }
    }
    if (/^(?:typecheck|lint|build|check)$/.test(sub)) {
      return { kind: 'low_risk_dev', prefix: `${exec} ${sub}` };
    }
    return { kind: 'moderate_grey', prefix: /^[a-z][a-z-]*$/.test(sub) ? `${exec} ${sub}` : undefined };
  }

  if (exec === 'npx') {
    const tool = (args[0] || '').toLowerCase();
    if (args.some((a) => /^(?:-y|--yes|-p|--package)$/.test(a))) {
      return { kind: 'force_ask', reason: '`npx` 带有自动拉取远程包参数，转交人工确认' };
    }
    if (/^(?:vitest|tsc|eslint|biome)$/.test(tool)) {
      return { kind: 'low_risk_dev', prefix: `npx ${tool}` };
    }
    if (tool === 'prettier' && !args.some((a) => /^(?:-w|--write)$/.test(a))) {
      return { kind: 'low_risk_dev', prefix: 'npx prettier' };
    }
    return { kind: 'force_ask', reason: '`npx` 执行未知外部命令包，转交人工确认' };
  }

  if (exec === 'tsc') {
    return { kind: 'low_risk_dev', prefix: 'tsc' };
  }

  if (exec === 'pytest') {
    return { kind: 'low_risk_dev', prefix: 'pytest' };
  }

  if (/^(?:cargo|dotnet|go)$/.test(exec)) {
    const sub = (args[0] || '').toLowerCase();
    if (/^(?:install|publish|clean)$/.test(sub)) {
      return { kind: 'force_ask', reason: '涉及全局包安装、清理或发布，转交人工确认' };
    }
    if (/^(?:test|check|clippy|vet|build)$/.test(sub)) {
      return { kind: 'low_risk_dev', prefix: `${exec} ${sub}` };
    }
    return { kind: 'moderate_grey', prefix: /^[a-z][a-z-]*$/.test(sub) ? `${exec} ${sub}` : undefined };
  }

  // 4. 其余未包含高危语法但不在白名单中的普通命令：若带有具体路径参数则保守要求人工确认
  if (segTokens.some((tok) => /[\\/]/.test(tok))) {
    return { kind: 'force_ask', reason: '未知命令包含具体文件路径参数，转交人工确认作用目标范围' };
  }

  return {
    kind: 'moderate_grey',
    prefix: /^[a-z][a-z0-9_-]*$/i.test(exec) ? exec : undefined,
  };
}

export function screenCommand(
  command: string,
  cwd: string,
  config: ApproveForMeConfig,
  toolName = 'run_command',
  rawInput?: unknown
): DeterministicScreeningResult {
  const start = performance.now();
  // 解析、规则匹配和界面说明使用不同长度的输入。原命令超过解析上限时直接要求人工确认。
  const sliced = command.slice(0, 32768);
  const parsed = parseShellCommand(sliced);
  const intent = describeOperationIntent(sliced.slice(0, 4096), cwd, toolName, rawInput, parsed.segments);

  const result: DeterministicScreeningResult = {
    verdict: 'grey_zone',
    riskLevel: 'medium',
    extractedSegments: parsed.segments,
    explanation: {
      meaning: intent.meaning,
      target: intent.target,
      risk: '未命中自动放行白名单，转交人工核对该代码/命令用意后确认执行',
    },
    latencyMs: 0,
  };
  const finish = () => {
    result.latencyMs = performance.now() - start;
    return result;
  };
  const match = (rules: string[]) => rules.find((rule) => compileSafePattern(rule).test(sliced.slice(0, 8192)));

  if (command.length > 32768 || parsed.malformed || !command.trim()) {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = '命令为空、过长或引号未闭合，转交人工核对完整代码用意';
    return finish();
  }

  // 先检查绝对禁区与用户拒绝规则，再对 .gemini 路径做分级保护（只读区禁写、未分类区禁写+读前询问、用户自定义区修改前询问）。
  const deny = match(config.denyPatterns);
  const anyTokenSensitive = (parsed.segmentTokens || []).some((seg) => seg.some((tok) => sensitiveTarget(tok)));
  const geminiPolicy = inspectGeminiPathPolicy(sliced, (parsed.segmentTokens || []).flat(), cwd);
  const mutatingShell = isMutatingShellCommand(sliced);

  if (sensitiveTarget(sliced) || sensitiveTarget(cwd) || anyTokenSensitive || geminiPolicy.tier === 'forbidden' || deny) {
    result.verdict = 'deny';
    result.riskLevel = 'critical';
    result.matchedRule = deny;
    result.explanation.risk = deny
      ? '命中用户拒绝规则'
      : geminiPolicy.tier === 'forbidden' && geminiPolicy.reason
        ? geminiPolicy.reason
        : '涉及凭据、密钥或私有认证状态，客户端拒绝自动授权';
    return finish();
  }

  if ((geminiPolicy.tier === 'readonly_official' || geminiPolicy.tier === 'unknown_gemini') && mutatingShell) {
    result.verdict = 'deny';
    result.riskLevel = 'critical';
    result.explanation.risk =
      geminiPolicy.tier === 'readonly_official'
        ? '该命令尝试修改 .gemini 官方只读数据/历史或受控配置（请通过官方 agy CLI 管理），客户端禁止直接写入'
        : '该命令尝试修改 .gemini 根目录或未白名单内部目录，客户端禁止直接写入';
    return finish();
  }

  const ask = match(config.askPatterns);
  if (ask) {
    result.verdict = 'force_ask';
    result.matchedRule = ask;
    result.explanation.risk = '命中用户要求人工确认的规则';
    return finish();
  }

  if (geminiPolicy.tier === 'unknown_gemini') {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = geminiPolicy.reason || '目标位于 .gemini 未白名单目录，转交人工核对确认';
    return finish();
  }

  if (geminiPolicy.tier === 'user_custom' && mutatingShell) {
    result.verdict = 'force_ask';
    result.riskLevel = 'medium';
    result.explanation.risk = '正在修改 .gemini 用户自定义规则/技能/插件文件，转交人工确认改动用意';
    return finish();
  }

  if (parsed.hasUnsafeSyntax || !parsed.segmentTokens?.length) {
    result.verdict = 'force_ask';
    result.riskLevel = 'high';
    result.explanation.risk = '含命令替换、变量展开、输出重定向或动态脚本块，AI 代审转交人工核对上述分步用意';
    return finish();
  }

  // 逐段校验多命令串联与管道（如 `Get-ChildItem ... | Select-String ... | Select-Object ...`）
  const segmentTiers: Array<Exclude<SegmentTier, { kind: 'force_ask' }>> = [];
  for (let idx = 0; idx < parsed.segmentTokens.length; idx++) {
    const isPipeSink = idx > 0 && parsed.operators?.[idx - 1] === '|';
    const tier = classifySegment(parsed.segmentTokens[idx], isPipeSink);
    if (tier.kind === 'force_ask') {
      result.verdict = 'force_ask';
      result.riskLevel = 'high';
      result.explanation.risk = tier.reason;
      return finish();
    }
    segmentTiers.push(tier);
  }

  // 生成可复用的会话级命令前缀（多段命令仅在同前缀或单段安全命令时授予）
  const firstPrefix = segmentTiers[0]?.prefix;
  if (firstPrefix && (segmentTiers.length === 1 || segmentTiers.every((t) => t.kind === 'read_only' || t.kind === 'low_risk_dev'))) {
    result.commandPrefix = firstPrefix;
  }

  const allow = match(config.allowPatterns);
  if (allow) {
    result.verdict = 'auto_approve';
    result.riskLevel = 'low';
    result.matchedRule = allow;
    result.explanation.risk = '命中用户允许规则，且未出现已识别危险结构';
    return finish();
  }

  // 所有分段均为纯只读目录枚举/文本检索/内存筛选（覆盖单条及管道组合） -> 直接本地快筛自动放行
  if (segmentTiers.every((t) => t.kind === 'read_only')) {
    result.verdict = 'auto_approve';
    result.riskLevel = segmentTiers.length === 1 && /^(?:pwd|get-location|gl)\s*$/i.test(command) ? 'safe' : 'low';
    if (/^(?:pwd|Get-Location)\s*$/i.test(command)) {
      result.explanation.meaning = '查看当前工作目录';
    }
    result.explanation.risk =
      segmentTiers.length > 1
        ? '多段管道全部为纯只读检索与内存筛选操作，不修改任何文件'
        : '纯只读本地查看/检索操作，不修改任何文件';
    return finish();
  }

  // 所有分段均为低风险开发校验（如 `git status`、`npm run typecheck`、`npx vitest run`） -> 标记为 low 风险灰区，供独立模型或智能托付自动放行
  if (segmentTiers.every((t) => t.kind === 'read_only' || t.kind === 'low_risk_dev')) {
    result.verdict = 'grey_zone';
    result.riskLevel = 'low';
    result.explanation.risk = '本地仓库状态或构建测试校验命令，支持 AI 代审批量托管或会话前缀放行';
    return finish();
  }

  return finish();
}

import { validateApprovalPattern } from '../../shared/approval-contract';
import { tmpdir } from 'node:os';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';


export function compileSafePattern(pattern: string): RegExp {
  const validation = validateApprovalPattern(pattern);
  if (validation.code === 'empty') return /(?!)/;
  if (!validation.valid && !(validation.code === 'whitespace_only' && pattern.length <= 200)) {
    throw new Error('审批正则无效或过于复杂：' + validation.code);
  }
  return new RegExp(pattern, 'i');
}

const escapedTemp = tmpdir().replace(/\\/g, '/').replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
const windowsTempPrefix = new RegExp('(^|[\\s"\\x27=])' + escapedTemp + '/', 'gi');

/**
 * 绝对禁区判定（Tier 1 — Hard Deny，读写全禁，覆盖 Windows 与 macOS）：
 * 严格遵循 Google / Gemini ToS 与账号安全红线，拦截一切认证凭据、OAuth 令牌、Cookie、密钥、
 * macOS Keychain / 钥匙串导出命令、Antigravity Desktop 认证存储、设备标识（installation_id）、
 * 内部加密状态库（state.vscdb / *.pb / *.pbtxt）及云凭据目录。
 * 不再对 `.gemini` 整体一刀切，而是由 `inspectGeminiPathPolicy()` 对 `.gemini` 与 macOS `Application Support/Antigravity` 各子目录分级治理。
 */
export function sensitiveTarget(value: string): boolean {
  if (!value) return false;
  const normalized = value.replace(/\\\\/g, '/').replace(/\\ /g, ' ').replace(/\\/g, '/');
  // A normal Windows workspace may be under AppData/Local/Temp. Retain all nested path checks.
  const displayPath = process.platform === 'win32' && /[\\/]AppData[\\/]Local[\\/]Temp$/i.test(tmpdir())
    ? normalized.replace(windowsTempPrefix, '$1/temp/') : normalized;
  // Metadata URLs have an immutable SSRF floor. Their URL path is not a local credential file.
  const localTargets = displayPath
    .replace(/https?:\/\/(?:169\.254\.(?:169\.254|170\.2)|metadata\.goog(?:le\.internal)?)(?=[:/?#\s]|$)[^\s"']*/gi, '')
    // curl may prefix a local file operand with @, including in attached short options.
    .replace(/(^|[\s"'=])(?:-[dFT])?@(?=[^@\s])/g, '$1/');
  if (localTargets.trim() && isForbiddenCredentialOrStatePath(localTargets)) return true;
  if (
    /(?:^|[\/\s"'])(?:\.ssh|\.aws|\.azure|\.gnupg|\.netrc|_netrc)(?:[\/\s"']|$)/i.test(normalized) ||
    /(?:^|[\/\s"'=:,])\.env(?:\.[a-z0-9_-]+)?(?=$|[\/\s"'`,;:])/i.test(localTargets) ||
    /(?:installation_id|state\.vscdb|\.pbtxt|id_rsa|id_ed25519|google_accounts\.json|application_default_credentials\.json|user_settings\.pb|antigravity_auth|auth_state)(?:\b|[\/])/i.test(
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

export function readonlyWriteReason(policy: GeminiPathPolicyResult): string {
  if (policy.tier !== 'readonly_official') return '该路径位于 .gemini 根目录或内部状态区，禁止直接写入。请将暂存文件写入当前项目工作区内的 ./scratch/ 目录。';
  const scratch = policy.matchedPaths.some(path => /(?:^|\/)brain\/[^/]+\/scratch(?:\/|$)/i.test(path.replace(/\\/g, '/')));
  return '该路径属于 .gemini 官方只读数据/历史或受控配置区，客户端禁止直接修改或写入。' +
    (scratch ? '请将暂存文件写入当前项目工作区内的 ./scratch/ 目录。' : '请通过官方 agy CLI 管理。');
}

import { isIPv4 } from 'node:net';
import { isBlockedExternalEndpointHost, type ApprovalFloorTier } from '../../shared/approval-contract';
import { isShellToolName } from './shell-mutation-policy';


const READ_ONLY_QUERY_META_KEYS = new Set([
  'query',
  'queries',
  'q',
  'toolSummary',
  'description',
  'chunk_id',
  'context',
  'scope',
  'source',
  'api',
  'language',
  'limit',
  'cursor',
  'offset',
  'page',
  'pageSize',
  'domain',
  'url',
  'uri',
  'ServerName',
  'Uri',
  'kind',
  'filter',
  'sort',
  'topic',
  'search',
  'keyword',
  'keywords',
  'maxResults',
  'max_results',
  'topK',
  'top_k',
  'include',
  'format',
  'version',
]);

const READ_ONLY_QUERY_PRIMARY_KEYS = new Set([
  'query',
  'queries',
  'q',
  'chunk_id',
  'url',
  'uri',
  'Uri',
  'domain',
  'search',
  'keyword',
  'keywords',
  'topic',
  'ServerName',
]);

const MUTATING_OR_PAYLOAD_KEYS = new Set([
  'Content',
  'content',
  'Replacement',
  'newText',
  'new_string',
  'Target',
  'oldText',
  'old_string',
  'CommandLine',
  'command',
  'cmd',
  'Overwrite',
  'Append',
  'body',
  'payload',
  'data',
  'sql',
  'script',
  'code',
  'patch',
  'diff',
  'edits',
  'files',
  'env',
  'method',
]);

const KNOWN_READ_ONLY_LOOKUP_TOOLS = new Set([
  'search_web',
  'web_search',
  'read_url_content',
  'fetch_url',
  'search_marketplace',
  'list_plugin_accounts',
  'list_resources',
  'read_resource',
  'gemini_search_docs',
  'gemini_get_doc',
  'think',
]);

const READ_ONLY_TOOL_VERB_RE =
  /(?:^|[_:/.-])(?:search|list|get|read|view|find|query|describe|inspect|lookup|fetch|docs?|status|info|check|schema|browse)(?:$|[_:/.-])/i;

const MUTATING_OR_PRIVILEGED_VERB_RE =
  /(?:^|[_:/.-])(?:write|edit|update|create|add|set|put|post|patch|delete|remove|rm|drop|destroy|truncate|wipe|purge|clear|reset|kill|terminate|exec|execute|run|eval|shell|bash|powershell|cmd|send|submit|publish|deploy|push|upload|transfer|pay|purchase|charge|withdraw|auth|login|grant|revoke|chmod|chown|sudo|su|install|uninstall)(?:$|[_:/.-])/i;

const DESTRUCTIVE_OR_PRIVILEGED_TOOL_RE =
  /(?:^|[_:/.-])(?:delete|remove|rm|drop|destroy|truncate|wipe|purge|kill|terminate|exec|execute|run_command|shell|bash|powershell|sudo|su|chmod|chown|format|shutdown|reboot|pay|purchase|transfer|charge|withdraw|grant|revoke)(?:$|[_:/.-])/i;

const LOOKUP_URL_KEYS = new Set(['url', 'uri', 'domain', 'endpoint', 'href']);

export function isUnsafeLookupUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:file|ftp|gopher|dict|ldap|smb|javascript|data):/i.test(trimmed)) return true;
  const probe = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(probe);
    if (parsed.username || parsed.password) return true;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$|\.$/g, '');
    if (isIPv4(host)) {
      // URL canonicalizes integer, hex and octal IPv4 spellings before exposing hostname.
      const authority = probe.slice(probe.indexOf('://') + 3);
      const suppliedHost = authority.split(/[:/?#\\]/, 1)[0].replace(/\.$/, '');
      return suppliedHost !== host || isBlockedExternalEndpointHost(host);
    }
    if (host.includes(':')) {
      // The URL parser compresses IPv6, including dotted IPv4-mapped literals.
      return host === '::' || host === '::1' || host.startsWith('::ffff:') ||
        /^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host);
    }
    return !host || host === 'metadata.goog' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.includes('cloudcode-pa') || /^(?:\d+|0x[0-9a-f]+)$/.test(host);
  } catch {
    return true;
  }
}

function mcpToolArguments(rawObj: Record<string, unknown>): Record<string, unknown> | undefined {
  const args = rawObj.Arguments;
  return typeof rawObj.ToolName === 'string' && args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : undefined;
}

export function urlFloor(value: string): ApprovalFloorTier {
  if (!isUnsafeLookupUrl(value)) return 'standard';
  const trimmed = value.trim();
  // 防封号 / 凭据安全红线：Google 私有域 cloudcode-pa、云元数据服务（窃取 IAM/OAuth 凭据）或 URL 内嵌凭据
  if (/169\.254\.(?:169\.254|170\.2)|metadata\.goog(?:le\.internal)?|cloudcode-pa/i.test(trimmed)) {
    return 'tier_a_immutable';
  }
  try {
    const probe = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(probe);
    if (['169.254.169.254', '169.254.170.2', 'metadata.goog', 'metadata.google.internal'].includes(url.hostname.toLowerCase().replace(/\.$/, '')) || url.username || url.password) return 'tier_a_immutable';
  } catch { /* 无法解析的地址按本地高风险交由 AI/人工复核 */ }
  return 'tier_b_intent_gated';
}

/** Classify both the ACP envelope and URL values in nested MCP arguments. */
export function networkTargetFloor(rawObj?: Record<string, unknown>, fileEdit = false): ApprovalFloorTier {
  let tier: ApprovalFloorTier = 'standard';
  const pending: unknown[] = [rawObj];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    for (const [key, value] of Object.entries(next)) {
      if (fileEdit && /^(?:content|codecontent|target|targetcontent|replacement|oldtext|newtext|old_string|new_string|body)$/i.test(key)) continue;
      if (typeof value === 'object') pending.push(value);
      if (typeof value !== 'string' || (!LOOKUP_URL_KEYS.has(key.toLowerCase()) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()))) continue;
      const target = urlFloor(value.trim());
      if (target === 'tier_a_immutable') return target;
      if (target === 'tier_b_intent_gated') tier = target;
    }
  }
  return tier;
}

export function isDestructiveOrPrivilegedToolName(toolName: string): boolean {
  return DESTRUCTIVE_OR_PRIVILEGED_TOOL_RE.test((toolName || '').trim());
}

/**
 * 识别纯只读文档/网络/MCP 查询类工具（不含文件写入、不含 Shell 命令、不含 SSRF 内网地址、不含敏感凭据）：
 * - 命中内置只读检索工具名（如 search_web、gemini_search_docs、list_resources 等）；
 * - 或 MCP / 扩展工具名明确为只读查询动词且不含任何修改/执行/外发字段；
 * - 或 ACP `kind` 为 `other`/`fetch` 且参数字段 100% 属于只读查询元数据白名单（如 `{ query, toolSummary }`）。
 */
export function isPureReadOnlyLookupTool(
  toolName: string,
  declaredKind: string,
  rawObj?: Record<string, unknown>
): boolean {
  const kind = (declaredKind || '').toLowerCase();
  if (['edit', 'delete', 'move', 'execute'].includes(kind)) return false;
  if (isShellToolName(toolName)) return false;
  if (networkTargetFloor(rawObj) !== 'standard') return false;
  if (rawObj && Object.keys(rawObj).some((k) => MUTATING_OR_PAYLOAD_KEYS.has(k))) return false;

  const trimmed = (toolName || '').trim();
  const lower = trimmed.toLowerCase();
  if (MUTATING_OR_PRIVILEGED_VERB_RE.test(trimmed)) return false;

  if (KNOWN_READ_ONLY_LOOKUP_TOOLS.has(lower)) return true;

  // call_mcp_tool 显式调用：仅当目标 ToolName 为明确只读动词且不含写入载荷时视作只读
  if (lower === 'call_mcp_tool' && rawObj && typeof rawObj.ToolName === 'string') {
    const targetTool = rawObj.ToolName.trim();
    const argsObj = mcpToolArguments(rawObj);
    if (argsObj && Object.keys(argsObj).some((k) => MUTATING_OR_PAYLOAD_KEYS.has(k))) return false;
    return READ_ONLY_TOOL_VERB_RE.test(targetTool) && !MUTATING_OR_PRIVILEGED_VERB_RE.test(targetTool);
  }

  // 含 mcp_ 前缀或结构化工具名且明确匹配只读动词
  if (
    (lower.startsWith('mcp_') || kind === 'other' || kind === 'fetch') &&
    trimmed &&
    lower !== 'other' &&
    lower !== 'fetch' &&
    READ_ONLY_TOOL_VERB_RE.test(trimmed)
  ) {
    return true;
  }

  // 当 ACP 只下发 kind="other"/"fetch" 而未附带工具名时，检查参数是否严格仅含只读查询键
  if ((kind === 'other' || kind === 'fetch') && rawObj) {
    const keys = Object.keys(rawObj);
    if (
      keys.length > 0 &&
      keys.some((k) => READ_ONLY_QUERY_PRIMARY_KEYS.has(k)) &&
      keys.every((k) => READ_ONLY_QUERY_META_KEYS.has(k))
    ) {
      return true;
    }
  }

  return false;
}

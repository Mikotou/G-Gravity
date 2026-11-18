/**
 * Gravity v0.2 — 多账号 Profile 官方隔离切换与 Antigravity 本地历史会话纯只读同步契约
 *
 * 合规红线（@compliance 重点核查）：
 * 1. 账号切换：
 *    - 仅走官方 `agy acp [--app-data-dir <profileDir>] --login` 与 ACP `auth/logout`；
 *    - 多账号通过传入客户端自有隔离目录 `--app-data-dir <userData>/profiles/<profileId>` 交由官方 `agy` 自行保存各自凭据；
 *    - 绝不读取、解析、复制、移动或导出任何凭据文件，当前身份仅显示 ACP 协议暴露的字段；
 *    - **严禁自动轮换账号（Account Rotation）**：必须 100% 由用户手动点击切换，遇到 429/403/配额耗尽严禁自动切 Profile。
 * 2. 历史会话同步（仅本地、纯只读、单向导入、零写入）：
 *    - 允许只读解析用户自有的会话内容文件（`transcript.jsonl`、`conversations`、`history` 及只读模式打开 `conversation_summaries.db`）；
 *    - 强制硬黑名单阻断读取任何 OAuth / token / cookie / credential / `installation_id` / `*.pbtxt` / 加密状态文件；
 *    - 对 `~/.gemini` 与 `antigravity` 目录树执行 100% 零写入。
 */

import type { AcpAuthMethod } from './acp-protocol';
import type { ChatMessageItem } from './session-contract';

export interface AccountProfile {
  profileId: string;
  name: string;
  /** 默认官方配置为 true（不额外传 --app-data-dir）；新建隔离 Profile 为 false */
  isDefault: boolean;
  /** 仅非默认 Profile 拥有客户端专属隔离目录（位于 <userData>/profiles/<profileId>） */
  isolatedAppDataDir?: string;
  createdAt: string;
  lastActivatedAt: string;
}

export interface AcpExposedIdentity {
  connected: boolean;
  agentName?: string;
  agentVersion?: string;
  authMethods: AcpAuthMethod[];
  supportsLogout: boolean;
}

export interface AccountsStateSnapshot {
  activeProfileId: string;
  profiles: AccountProfile[];
  acpIdentity: AcpExposedIdentity;
}

export interface CreateAccountProfileInput {
  name: string;
}

export interface ImportedHistorySessionRecord {
  /** 在 Gravity 内带 `ag-history:` 前缀的唯一只读会话 ID */
  sessionId: string;
  rawConversationId: string;
  origin: 'antigravity-desktop' | 'antigravity-cli';
  title: string;
  cwd: string;
  updatedAt: string;
  messageCount: number;
  summarySnippet: string;
  sourcePath: string;
  readOnly: true;
}

/** 列表条目只携带摘要。选中条目后才通过详情接口取得消息数组，以缩小首屏传输量。 */
export interface ImportedHistoryDetail extends ImportedHistorySessionRecord {
  messages: ChatMessageItem[];
}

/** 用导入 ID 找到原始记录。targetCwd 用于新建实时会话，允许续聊时另选工作区。 */
export interface ContinueHistoryInGravityInput {
  importedSessionId: string;
  targetCwd?: string;
}

/**
 * 敏感凭据与内部状态文件硬黑名单正则：命中任意规则必须立即拒绝读取！
 */
const FORBIDDEN_CREDENTIAL_OR_STATE_PATTERNS: readonly RegExp[] = [
  /(?:^|[\\/._-])(?:oauth|token|tokens|refresh_token|access_token|id_token)(?:[\\/._-]|$)/i,
  /(?:^|[\\/._-])(?:cookie|cookies|credential|credentials|secret|secrets|apikey|api_key|passwd|password)(?:[\\/._-]|$)/i,
  /(?:^|[\\/])installation_id$/i,
  /\.pbtxt$/i,
  /\.(?:pem|key|pfx|p12|enc|keystore|jks|kdbx)$/i,
  /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws)(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:google_accounts|application_default_credentials|adc)\.json$/i,
  /(?:^|[\\/])state\.vscdb/i,
];

export function isForbiddenCredentialOrStatePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return true;
  return FORBIDDEN_CREDENTIAL_OR_STATE_PATTERNS.some((re) => re.test(normalized));
}

/**
 * 允许只读导入的用户自有历史会话内容文件白名单：
 * 1. 先执行 `isForbiddenCredentialOrStatePath` 硬黑名单一票否决；
 * 2. 仅放行：
 *    - `.../antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`（或 `transcript_full.jsonl`）
 *    - `.../antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`（或 `transcript_full.jsonl`）
 *    - `.../antigravity-cli/(conversations|history)/.../*.{json,jsonl,md}`
 *    - `.../(antigravity|antigravity-cli)/.../conversation_summaries.db`
 */
const ALLOWED_HISTORY_CONTENT_PATTERNS: readonly RegExp[] = [
  /\/(?:\.gemini\/)?antigravity(?:-cli)?\/brain\/[^/]+\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/i,
  /\/(?:\.gemini\/)?antigravity-cli\/(?:conversations|history)\/[^/]+(?:\.(?:jsonl|json|md)|\/[^/]+\.(?:jsonl|json|md))$/i,
  /\/(?:\.gemini\/)?antigravity(?:-cli)?\/(?:[^/]+\/)*conversation_summaries\.db(?:-wal)?$/i,
];

/**
 * 先排除凭据及状态路径，再匹配历史文件名。
 * 这里仅检查路径文本，调用方打开文件前还要核对真实路径和文件类型。
 */
export function isAllowedReadOnlyHistoryFile(filePath: string): boolean {
  if (isForbiddenCredentialOrStatePath(filePath)) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/').trim();
  return ALLOWED_HISTORY_CONTENT_PATTERNS.some((re) => re.test(normalized));
}

export interface QuotaBucket {
  id: string;
  remainingFraction?: number;
  remainingAmount?: number;
  resetAt?: string;
  disabled?: boolean;
}
export interface AccountQuota {
  profileId: string;
  checkedAt: string;
  plan?: string;
  buckets: QuotaBucket[];
}

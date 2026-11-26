/**
 * Gravity v0.3.3 — 多账号 Profile 官方隔离切换与敏感凭据路径硬拦截契约
 *
 * 合规红线（@compliance 重点核查）：
 * 1. 账号切换：
 *    - 仅走官方 `agy acp [--app-data-dir <profileDir>] --login` 与 ACP `auth/logout`；
 *    - 多账号通过传入客户端自有隔离目录 `--app-data-dir <userData>/profiles/<profileId>` 交由官方 `agy` 自行保存各自凭据；
 *    - 绝不读取、解析、复制、移动或导出任何凭据文件，当前身份仅显示 ACP 协议暴露的字段；
 *    - **严禁自动轮换账号（Account Rotation）**：必须 100% 由用户手动点击切换，遇到 429/403/配额耗尽严禁自动切 Profile。
 * 2. 官方目录零写入、零外部历史扫描：
 *    - 客户端仅展示与管理 G-Gravity 自有会话；
 *    - 强制硬黑名单阻断读取任何 OAuth / token / cookie / credential / `installation_id` / `*.pbtxt` / `.gemini/*.pb` / 加密状态文件。
 */

import type { AcpAuthMethod } from './acp-protocol';

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

/** 无论扩展名或位置一律硬拦截的系统敏感目录、密钥后缀与官方内部状态文件。 */
const UNCONDITIONAL_FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws)(?:\/|$)/i,
  /(?:^|\/)Library\/(?:Keychains|Cookies)(?:\/|$)/i,
  /(?:^|\/)etc\/(?:passwd|shadow|sudoers)(?:$|\/)/i,
  /(?:^|\/)installation_id$/i,
  /\.pbtxt$/i,
  /(?:^|\/)(?:\.gemini|antigravity(?:-cli)?)\/.*\.pb$/i,
  /\.(?:pem|key|pfx|p12|enc|keystore|jks|kdbx)$/i,
  /(?:^|\/)(?:google_accounts|application_default_credentials|adc)\.json$/i,
  /(?:^|\/)state\.vscdb/i,
  /(?:^|\/)\.env(?:\.(?!example$|sample$|template$).+)?$/i,
];

/** 凭据关键词：对官方/系统配置目录（除 `skills/<name>/SKILL.md`）与非源码数据/配置文件一律拦截。 */
const CREDENTIAL_KEYWORD_PATTERNS: readonly RegExp[] = [
  /(?:^|[\\/._-])(?:oauth|token|tokens|refresh_token|access_token|id_token)(?:[\\/._-]|$)/i,
  /(?:^|[\\/._-])(?:cookie|cookies|credential|credentials|secret|secrets|apikey|api_key|passwd|password)(?:[\\/._-]|$)/i,
];

const SENSITIVE_APP_OR_SYSTEM_DIR_RE =
  /(?:^|\/)(?:\.gemini|antigravity(?:-cli)?|\.config|\.local\/share|AppData|Application Support|Library)(?:\/|$)/i;

const SKILL_MARKDOWN_PATH_RE = /(?:^|\/)skills\/[^/]+\/SKILL\.md$/i;

const ORDINARY_SOURCE_OR_DOC_EXT_RE =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|swift|dart|vue|svelte|css|scss|less|html|htm|md|markdown|svg|png|jpe?g|gif|webp|ico)$/i;

/**
 * 敏感凭据与内部状态文件路径硬黑名单校验：
 * - 官方状态文件、私钥证书后缀、SSH/AWS/Keychain/Cookies、`/etc/passwd` 等无条件阻断；
 * - 通用敏感词（`token`/`secret`/`cookie`/`password`/`oauth` 等）仅阻断凭据/数据文件及官方敏感目录，
 *   不误杀工作区正常源代码文件（如 `secret-vault.ts`）与只读技能说明文件（`skills/cookie-debugging/SKILL.md`）。
 */
export function isForbiddenCredentialOrStatePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return true;
  if (UNCONDITIONAL_FORBIDDEN_PATH_PATTERNS.some((re) => re.test(normalized))) return true;
  if (!CREDENTIAL_KEYWORD_PATTERNS.some((re) => re.test(normalized))) return false;
  if (SKILL_MARKDOWN_PATH_RE.test(normalized)) return false;
  if (SENSITIVE_APP_OR_SYSTEM_DIR_RE.test(normalized)) return true;
  const baseName = normalized.replace(/\/+$/, '').split('/').pop() || '';
  return !ORDINARY_SOURCE_OR_DOC_EXT_RE.test(baseName);
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

/** An unavailable official quota source is stable until the profile or the application changes. */
export type AccountQuotaUnavailableReason = 'profile' | 'platform' | 'helper' | 'preview';
export type AccountQuotaReadResult = AccountQuota | { profileId: string; unavailable: AccountQuotaUnavailableReason };

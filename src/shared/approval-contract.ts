/**
 * Gravity v0.2 — Claude Code 风格内联 Request View 与零冷启动 `Approve for me` 契约
 */

export type ApprovalMode = 'hybrid' | 'rules-only' | 'manual';

export const APPROVAL_MODE_ORDER: readonly ApprovalMode[] = [
  'hybrid',
  'rules-only',
  'manual',
] as const;

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export type InlineApprovalDecisionType =
  | 'allow_once'
  | 'allow_session_prefix'
  | 'approve_for_me_ai'
  | 'reject_with_feedback';

export interface ApprovalRiskExplanation {
  /** 【命令含义】 */
  meaning: string;
  /** 【操作对象与范围】 */
  target: string;
  /** 【潜在风险】 */
  risk: string;
}

export interface DeterministicScreeningResult {
  verdict: 'auto_approve' | 'force_ask' | 'deny' | 'grey_zone';
  riskLevel: RiskLevel;
  matchedRule?: string;
  extractedSegments: string[];
  commandPrefix?: string;
  explanation: ApprovalRiskExplanation;
  latencyMs: number;
}

export type ExternalReviewerThinkingLevel = 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high';

export const EXTERNAL_REVIEWER_DEFAULTS = {
  timeoutMs: 8000,
  maxOutputTokens: 4096,
  thinkingLevel: 'auto' as ExternalReviewerThinkingLevel,
  cacheTtlHours: 24,
} as const;

export type ExternalReviewerConnectionStatus = 'untested' | 'connected' | 'failed';

export interface ExternalAiReviewerConfig {
  enabled: boolean;
  provider: 'gemini-api-key' | 'openai-compatible' | 'local-ollama';
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  /** 单次复核最大输出 token 上限（Gemini 含思考与最终 JSON 回复总量），默认 4096 */
  maxOutputTokens?: number;
  /** 思考强度（auto 表示跟随模型默认；按服务端模型能力动态筛选可用项） */
  thinkingLevel?: ExternalReviewerThinkingLevel;
  /** 外部复核连接探测状态（用于限制仅正常连接后才允许开启 AI 代审） */
  connectionStatus?: ExternalReviewerConnectionStatus;
  /** 最近一次验证连通的时间（ISO 字符串） */
  lastVerifiedAt?: string;
  /** Older clients marked a model-list lookup as connected. Only an actual review qualifies. */
  verificationMethod?: 'review-call';
  /** 主进程安全投影标记：是否已在系统加密仓中保存该服务商/源的密钥（永不向渲染层回传明文 Key） */
  hasApiKey?: boolean;
}

/** A saved key belongs to one provider and one network origin. */
export function sameExternalService(
  current: Pick<ExternalAiReviewerConfig, 'provider' | 'endpoint'>,
  next: Partial<Pick<ExternalAiReviewerConfig, 'provider' | 'endpoint'>>
): boolean {
  if (next.provider !== undefined && next.provider !== current.provider) return false;
  const curEndpoint = current.endpoint.trim();
  const nextEndpoint = next.endpoint?.trim();
  if (nextEndpoint === undefined || nextEndpoint === curEndpoint) return true;
  try { return new URL(nextEndpoint).origin === new URL(curEndpoint).origin; }
  catch { return false; }
}

export function sameReviewerSettings(a: ExternalAiReviewerConfig, b: ExternalAiReviewerConfig): boolean {
  return a.provider === b.provider && a.endpoint.trim() === b.endpoint.trim() &&
    a.model.trim() === b.model.trim() && (a.apiKey?.trim() || '') === (b.apiKey?.trim() || '') &&
    a.timeoutMs === b.timeoutMs &&
    (a.maxOutputTokens ?? EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens) === (b.maxOutputTokens ?? EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens) &&
    (a.thinkingLevel ?? 'auto') === (b.thinkingLevel ?? 'auto');
}

export function isExternalReviewerConnected(cfg?: Partial<ExternalAiReviewerConfig> | null): boolean {
  return Boolean(cfg?.enabled && cfg.connectionStatus === 'connected' && cfg.verificationMethod === 'review-call' &&
    cfg.lastVerifiedAt && Number.isFinite(Date.parse(cfg.lastVerifiedAt)) && hasReviewerConnectionSettings(cfg));
}

/**
 * 合规与 SSRF 防护：拦截 Google/Antigravity 内部域以及私网/回环/链路本地/云元数据地址。
 * `127.0.0.1` 仅在显式本机开发/Ollama 路径单独放行。
 */
export function isBlockedExternalEndpointHost(rawHostname: string): boolean {
  const host = rawHostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === 'metadata.goog' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }
  // 严禁任何 Google / Antigravity 私有或内部域经由 openai-compatible 通道访问
  if (
    host === 'googleapis.com' ||
    host.endsWith('.googleapis.com') ||
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    host.includes('cloudcode-pa')
  ) {
    return true;
  }
  // 拦截 IPv4 私有/回环/链路本地/CGNAT/保留地址（以及整数/十六进制/八进制前导零 IP 伪装）
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^(?:0\d+|0x[0-9a-f]+)(?:\.(?:0\d+|0x[0-9a-f]+|\d+)){1,3}$/i.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    if (ipv4.slice(1).some((part) => part.length > 1 && part.startsWith('0'))) return true;
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n < 0 || n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 云元数据 / 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 多播与保留地址
    return false;
  }
  // 拦截 IPv6 字面量（含 ::1、fc00::/7、fe80::/10、::ffff: 映射等）
  if (host.includes(':')) return true;
  // 必须至少包含一个公开域名段
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return true;
  return false;
}

/**
 * 校验 openai-compatible 外部端点：
 * - 允许本机 `http://127.0.0.1[:port]`（本地代理/测试网关）；
 * - 允许公网 `https://<public-host>[/optional-base-path]`，严禁 Google 内部域与内网/元数据 SSRF。
 */
export function isAllowedOpenAiCompatibleEndpoint(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return true;
  if (url.protocol !== 'https:') return false;
  if (url.port && url.port !== '443') return false;
  return !isBlockedExternalEndpointHost(url.hostname);
}

/**
 * 规范化 OpenAI-Compatible 端点根路径，保留 `/api/v1` 等网关子路径，避免拼出 `/v1/v1`。
 * 返回值不含末尾斜杠，可直接追加 `/chat/completions` 或 `/models`（若原路径不含 `/v1` 则补 `/v1`）。
 */
export function normalizeOpenAiCompatibleV1Base(url: URL): string {
  const cleanPath = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '');
  if (!cleanPath || cleanPath === '/') {
    return `${url.origin}/v1`;
  }
  if (/\/v\d+(?:alpha|beta)?$/i.test(cleanPath)) {
    return `${url.origin}${cleanPath}`;
  }
  return `${url.origin}${cleanPath}/v1`;
}

export function hasReviewerConnectionSettings(cfg?: Partial<ExternalAiReviewerConfig> | null): boolean {
  if (!cfg) return false;
  const model = typeof cfg.model === 'string' ? cfg.model.trim() : '';
  if (!model || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(model)) return false;
  const rawEndpoint = typeof cfg.endpoint === 'string' ? cfg.endpoint.trim() : '';
  if (!rawEndpoint) return false;
  try {
    const url = new URL(rawEndpoint);
    if (url.username || url.password || url.search || url.hash) return false;
    if (cfg.provider === 'local-ollama') {
      return url.protocol === 'http:' && url.hostname === '127.0.0.1';
    }
    if (url.hostname === '127.0.0.1' && url.protocol === 'http:') return true;
    const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (!key && !cfg.hasApiKey) return false;
    if (cfg.provider === 'gemini-api-key') {
      return (
        url.hostname === 'generativelanguage.googleapis.com' &&
        url.protocol === 'https:' &&
        (!url.port || url.port === '443')
      );
    }
    if (cfg.provider === 'openai-compatible') {
      return isAllowedOpenAiCompatibleEndpoint(url);
    }
    return false;
  } catch {
    return false;
  }
}

export interface ExternalReviewerModelOption {
  id: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportsThinking: boolean;
  supportedThinkingLevels: ExternalReviewerThinkingLevel[];
  defaultThinkingLevel?: ExternalReviewerThinkingLevel;
}

export interface ExternalReviewerModelsDiscoveryInput {
  provider: ExternalAiReviewerConfig['provider'];
  endpoint: string;
  apiKey?: string;
}

export interface ExternalReviewerModelsDiscoveryResult {
  provider: ExternalAiReviewerConfig['provider'];
  endpoint: string;
  models: ExternalReviewerModelOption[];
  fetchedAt: string;
}

export function isGemini3OrLaterModel(modelId: string): boolean {
  return /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i.test(modelId.trim());
}

export function isGemini25Model(modelId: string): boolean {
  return /^gemini-2\.5-/i.test(modelId.trim());
}

/**
 * 结合服务端返回的能力字段（如 Gemini `thinking` / 未来 `supportedThinkingLevels`）与官方协议矩阵，
 * 推导出该模型可安全下发的思考强度选项（首项恒为 'auto'）。
 */
export function inferSupportedThinkingLevels(
  provider: ExternalAiReviewerConfig['provider'],
  modelId: string,
  serverThinkingFlag?: boolean,
  serverLevels?: readonly string[]
): {
  supportsThinking: boolean;
  supportedThinkingLevels: ExternalReviewerThinkingLevel[];
  defaultThinkingLevel?: ExternalReviewerThinkingLevel;
} {
  const id = modelId.trim().toLowerCase();
  const validLevels = new Set<ExternalReviewerThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high']);

  if (Array.isArray(serverLevels) && serverLevels.length > 0) {
    const normalized: ExternalReviewerThinkingLevel[] = ['auto'];
    for (const raw of serverLevels) {
      const lower = String(raw || '').trim().toLowerCase() as ExternalReviewerThinkingLevel;
      if (validLevels.has(lower) && !normalized.includes(lower)) normalized.push(lower);
    }
    if (normalized.length > 1) {
      return { supportsThinking: true, supportedThinkingLevels: normalized };
    }
  }

  if (provider === 'gemini-api-key') {
    if (serverThinkingFlag === false) {
      return { supportsThinking: false, supportedThinkingLevels: ['auto'] };
    }
    if (isGemini3OrLaterModel(id)) {
      if (/^gemini-3-pro(?:-|$)/i.test(id)) {
        return { supportsThinking: true, supportedThinkingLevels: ['auto', 'low', 'high'], defaultThinkingLevel: 'high' };
      }
      if (/flash-lite|gemini-3\.6-flash|gemini-3-flash/i.test(id)) {
        return {
          supportsThinking: true,
          supportedThinkingLevels: ['auto', 'minimal', 'low', 'medium', 'high'],
          defaultThinkingLevel: /flash-lite/i.test(id) ? 'minimal' : 'medium',
        };
      }
      // Gemini 4 (argon / hydrogen / carbon / neon) & Gemini 3.8 Flash / 3.1 Pro
      return {
        supportsThinking: true,
        supportedThinkingLevels: ['auto', 'low', 'medium', 'high'],
        defaultThinkingLevel: /pro|hydrogen|carbon|neon/i.test(id) ? 'high' : 'medium',
      };
    }
    if (isGemini25Model(id)) {
      if (/pro/i.test(id)) {
        return { supportsThinking: true, supportedThinkingLevels: ['auto', 'low', 'medium', 'high'], defaultThinkingLevel: 'medium' };
      }
      return {
        supportsThinking: true,
        supportedThinkingLevels: ['auto', 'off', 'low', 'medium', 'high'],
        defaultThinkingLevel: /flash-lite/i.test(id) ? 'off' : 'medium',
      };
    }
    if (serverThinkingFlag === true) {
      return { supportsThinking: true, supportedThinkingLevels: ['auto', 'low', 'medium', 'high'] };
    }
    return { supportsThinking: false, supportedThinkingLevels: ['auto'] };
  }

  if (provider === 'openai-compatible') {
    if (/^(?:o[134](?:[-.]|$)|gpt-[56](?:[-.]|$))|reasoning/i.test(id)) {
      const levels: ExternalReviewerThinkingLevel[] = /^gpt-[56]/i.test(id)
        ? ['auto', 'minimal', 'low', 'medium', 'high']
        : ['auto', 'low', 'medium', 'high'];
      return { supportsThinking: true, supportedThinkingLevels: levels, defaultThinkingLevel: 'medium' };
    }
    return { supportsThinking: false, supportedThinkingLevels: ['auto'] };
  }

  // local-ollama
  if (serverThinkingFlag === true || /(?:qwen3|deepseek-r1|qwq|gpt-oss|thinking|reason)/i.test(id)) {
    return { supportsThinking: true, supportedThinkingLevels: ['auto', 'off', 'low', 'medium', 'high'] };
  }
  return { supportsThinking: false, supportedThinkingLevels: ['auto'] };
}

export const APPROVAL_POLICY_DEFAULTS = {
  /** 允许符合用户意图的高风险（非防封号红线）操作由 AI 自动放行 */
  allowAlignedHighRiskPass: true,
  /** 符合用户意图的高风险操作自动放行评分上限（0–100，默认 90 覆盖全部 high 风险区间，可配范围 60–100） */
  alignedHighRiskMaxScore: 90,
  /** Stage 1 规则引擎直接放行工作区内纯只读与常规测试/构建开发命令（非 manual 模式） */
  fastPassLowRiskDev: true,
} as const;

export type ApprovalFloorTier = 'tier_a_immutable' | 'tier_b_intent_gated' | 'standard';

export interface ApproveForMeConfig {
  mode: ApprovalMode;
  enableSafeDownloadAutoApprove: boolean;
  maxDownloadSizeMB: number;
  cacheTtlHours: number;
  allowPatterns: string[];
  askPatterns: string[];
  denyPatterns: string[];
  /** 允许符合用户意图的高风险操作由 AI 自动放行，缺省 true */
  allowAlignedHighRiskPass?: boolean;
  /** 符合用户意图的高风险自动放行分数上限（60–100），缺省 90 */
  alignedHighRiskMaxScore?: number;
  /** Stage 1 直通工作区只读/测试构建命令（git status / npm test / typecheck 等），缺省 true */
  fastPassLowRiskDev?: boolean;
  externalReviewer: ExternalAiReviewerConfig;
}

export const DEFAULT_APPROVAL_CONFIG: ApproveForMeConfig = {
  ...APPROVAL_POLICY_DEFAULTS,
  mode: 'manual',
  enableSafeDownloadAutoApprove: false,
  maxDownloadSizeMB: 50,
  cacheTtlHours: EXTERNAL_REVIEWER_DEFAULTS.cacheTtlHours,
  allowPatterns: [],
  askPatterns: [],
  denyPatterns: [],
  externalReviewer: {
    enabled: false,
    provider: 'gemini-api-key',
    endpoint: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash-lite',
    timeoutMs: EXTERNAL_REVIEWER_DEFAULTS.timeoutMs,
    maxOutputTokens: EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens,
    thinkingLevel: EXTERNAL_REVIEWER_DEFAULTS.thinkingLevel,
  },
};

export type ApprovalIntentAlignment = 'aligned' | 'uncertain' | 'misaligned';

export type ApprovalReviewingStatus = 'reviewing' | 'resolved' | 'escalated' | 'cancelled';

/** Stage 2 外部 AI Guardian 实时复核状态事件（驱动前端审查中呼吸卡片与中途接管） */
export interface ApprovalReviewingEvent {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  commandPreview: string;
  provider: ExternalAiReviewerConfig['provider'];
  model: string;
  status: ApprovalReviewingStatus;
  startedAt: string;
  elapsedMs?: number;
  summary?: string;
}

/** 单条会话级命令前缀授权记录 */
export interface SessionApprovalPrefixGrant {
  prefix: string;
  grantedAt: string;
  hitCount: number;
}

/** 当前会话的 Approve for me 授权快照（支持前端可视化查看与单项撤销） */
export interface SessionApprovalGrantsSnapshot {
  sessionId: string;
  workspaceKey: string;
  delegatedToGuardian: boolean;
  delegatedAt?: string;
  prefixes: SessionApprovalPrefixGrant[];
}

export interface RevokeSessionApprovalGrantInput {
  sessionId: string;
  prefix?: string;
  revokeDelegation?: boolean;
}

/** 突发高频保护 / 复核接管状态通知 */
export interface ApprovalGuardActivityEvent {
  sessionId: string;
  kind: 'burst-guard-enabled' | 'burst-guard-cleared' | 'review-cancelled';
  activeCount: number;
  message: string;
  timestamp: string;
}

/**
 * 面向界面的待审卡片包含主进程给出的范围、风险及可选前缀。
 * 提交决定时保留 requestId 和 sessionId 以便核对。
 */
export interface PendingApprovalRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  commandOrSummary: string;
  cwd: string;
  createdAt: string;
  riskLevel: RiskLevel;
  /** 规则预筛地板层级：tier_a_immutable 不可由 AI 绕过；tier_b_intent_gated 可按用户意图酌情放行 */
  floorTier?: ApprovalFloorTier;
  commandPrefix?: string;
  explanation: ApprovalRiskExplanation;
  screeningSource: 'local-ast' | 'regex-rule' | 'ai-reviewer-fallback' | 'manual-mode';
  aiSuggestion?: {
    recommended: 'approve' | 'ask' | 'deny';
    reason: string;
    latencyMs: number;
    model?: string;
    isError?: boolean;
    /** 0–100 结构化风险评分（Codex Guardian 风格） */
    riskScore?: number;
    /** 操作与用户当前对话意图的一致性评估 */
    intentAlignment?: ApprovalIntentAlignment;
  };
}

export interface ApprovalDecisionSubmission {
  requestId: string;
  sessionId: string;
  decision: InlineApprovalDecisionType;
  allowedPrefix?: string;
  feedbackText?: string;
}

export interface ApprovalDecisionResult {
  outcome: 'approved' | 'rejected' | 'pending' | 'cancelled';
  delegatedMode?: 'hybrid' | 'rules-only';
}

export interface ExternalReviewerTestResult {
  ok: boolean;
  message: string;
  verifiedAt?: string;
}

export type ApprovalAuditVerdict =
  | 'auto_approved'
  | 'auto_approved_turbo'
  | 'user_approved'
  | 'ai_approved'
  | 'denied'
  | 'rejected_with_feedback';

export type ApprovalDecisionSource =
  | 'cache-hit'
  | 'session-prefix'
  | 'local-rule'
  | 'external-ai'
  | 'user-inline'
  | 'turbo-mode';

/** 已结清请求的审计记录。verdict 表示实际结果，decisionSource 解释此次结果来自哪条决策路径。 */
export interface ApprovalAuditEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  toolCallId?: string;
  cwd: string;
  toolName: string;
  commandOrSummary: string;
  modeAtDecision: ApprovalMode;
  verdict: ApprovalAuditVerdict;
  decisionSource: ApprovalDecisionSource;
  riskLevel: RiskLevel;
  latencyMs: number;
  reason: string;
  feedbackText?: string;
}

/**
 * Claude Code 风格编号审批选项结构（严格遵循 v0.2 第 2 条与第 4 条中英术语混排规则）
 */
export interface ClaudeStyleApprovalOptionItem {
  index: 1 | 2 | 3 | 4;
  decision: InlineApprovalDecisionType;
  primaryText: string;
  descriptionText: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function buildClaudeStyleApprovalOptions(
  request: Pick<PendingApprovalRequest, 'commandPrefix'>,
  locale: 'zh-CN' | 'en-US'
): ClaudeStyleApprovalOptionItem[] {
  // 快捷键编号在两种语言中一致。无可复用前缀时保留第 2 项的位置并禁用，其他操作的数字不会移动。
  const prefix = request.commandPrefix?.trim();
  const isZh = locale === 'zh-CN';
  return [
    {
      index: 1,
      decision: 'allow_once',
      primaryText: '1. Yes',
      descriptionText: isZh ? '允许本次执行' : 'Allow this execution once',
    },
    {
      index: 2,
      decision: 'allow_session_prefix',
      primaryText: prefix
        ? `2. Yes, and don't ask again for ${prefix}`
        : `2. Yes, and don't ask again for ...`,
      descriptionText: prefix
        ? isZh
          ? `本会话内对同类前缀 ${prefix} 免确认放行`
          : `Auto-allow matching prefix ${prefix} in this session`
        : isZh
          ? '后端判定该操作无安全前缀，禁止批量前缀放行'
          : 'No safe reusable prefix available for this operation',
      disabled: !prefix,
      disabledReason: !prefix
        ? isZh
          ? '后端判定该命令无安全前缀，禁止按前缀批量放行'
          : 'No safe command prefix granted by security engine'
        : undefined,
    },
    {
      index: 3,
      decision: 'approve_for_me_ai',
      primaryText: '3. Approve for me',
      descriptionText: isZh
        ? '批准后，仅在本会话启用智能批量代审。复核需要确认时保留审批卡。'
        : 'On approval, delegate future reviews in this session. Requests needing your decision stay open.',
    },
    {
      index: 4,
      decision: 'reject_with_feedback',
      primaryText: '4. No, and tell Gravity what to do differently',
      descriptionText: isZh
        ? '拒绝本次执行并附带修改指示'
        : 'Reject execution and provide alternative instructions',
    },
  ];
}

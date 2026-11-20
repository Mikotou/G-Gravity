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
    if (/^(?:o[134](?:[-.]|$)|gpt-5(?:[-.]|$))|reasoning/i.test(id)) {
      const levels: ExternalReviewerThinkingLevel[] = /^gpt-5/i.test(id)
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

export interface ApproveForMeConfig {
  mode: ApprovalMode;
  enableSafeDownloadAutoApprove: boolean;
  maxDownloadSizeMB: number;
  cacheTtlHours: number;
  allowPatterns: string[];
  askPatterns: string[];
  denyPatterns: string[];
  externalReviewer: ExternalAiReviewerConfig;
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
  commandPrefix?: string;
  explanation: ApprovalRiskExplanation;
  screeningSource: 'local-ast' | 'regex-rule' | 'ai-reviewer-fallback' | 'manual-mode';
  aiSuggestion?: {
    recommended: 'approve' | 'ask' | 'deny';
    reason: string;
    latencyMs: number;
  };
}

export interface ApprovalDecisionSubmission {
  requestId: string;
  sessionId: string;
  decision: InlineApprovalDecisionType;
  allowedPrefix?: string;
  feedbackText?: string;
}

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
  verdict: 'auto_approved' | 'user_approved' | 'ai_approved' | 'denied' | 'rejected_with_feedback';
  decisionSource:
    | 'cache-hit'
    | 'session-prefix'
    | 'local-rule'
    | 'external-ai'
    | 'user-inline';
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
        ? '放行本次操作，并开启本会话智能批量代审（低风险自动过、高危仍把关）'
        : 'Allow now and enable smart batch review for this session',
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

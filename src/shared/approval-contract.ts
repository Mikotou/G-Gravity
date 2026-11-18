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

export interface ExternalAiReviewerConfig {
  enabled: boolean;
  provider: 'gemini-api-key' | 'openai-compatible' | 'local-ollama';
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
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

import {
  isRightInspectorTab,
  pageMessages,
  LAYOUT_LIMITS,
  withoutSession,
} from '../../shared/session-contract';
import { APP_BRAND, clampUiScale, UI_SCALE_LIMITS, type GravityIconPreference } from '../../shared/theme-i18n-contract';
import { prepareRevision } from '../../shared/message-revision';
import {
  DEFAULT_VOICE_CONFIG,
  VOICE_LOCAL_MODEL_SPEC,
  VOICE_MAX_DURATION_MS,
  VOICE_MAX_PCM_BYTES,
  VOICE_MIC_TEST_MAX_BYTES,
  VOICE_MIC_TEST_MAX_DURATION_MS,
  VOICE_SAMPLE_RATE,
  isExternalVoiceConnected,
  isVoiceCaptureControlRequest,
  type VoiceAbortInput,
  type VoiceAppendInput,
  type VoiceArmCaptureInput,
  type VoiceCapturePurpose,
  type VoiceCaptureRevokedEvent,
  type VoiceConfig,
  type VoiceConfigPatch,
  type VoiceDiscoverModelsInput,
  type VoiceFinishInput,
  type VoiceModelState,
  type VoiceSegmentEvent,
  type VoiceSettledEvent,
  type VoiceStateSnapshot,
} from '../../shared/voice-contract';
import type { VoiceOwner } from '../../shared/session-owner';
import { outlineFromMarkdown } from '../lib/plan-view';
import {
  calculateTokenCost,
  computeHeatLevel,
  computeUnifiedLineDiff,
  DEFAULT_MODEL_RATE_CARDS,
  DEFAULT_TRANSLATION_CONFIG,
  getCanonicalToolName,
  GRAVITY_BUILTIN_CAPABILITIES,
  isExternalReviewerConnected,
  hasReviewerConnectionSettings,
  sameReviewerSettings,
  sameExternalService,
  isExternalTranslatorConnected,
  isLegacyPollutionSessionTitle,
  isSafeMcpServerName,
  isSafePluginTarget,
  MAX_PARALLEL_ACTIVE_SESSIONS,
  normalizeWorkspacePath,
  resolveModelCompactionLimit,
  resolveModelRateCard,
  summarizeBranchSnippet,
  THEME_PRESETS,
  APPROVAL_POLICY_DEFAULTS,
  validateCustomThemeConfig,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type AppBootstrapPayload,
  type AppUpdateState,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApprovalDecisionResult,
  type ApprovalGuardActivityEvent,
  type ApprovalMode,
  type ApprovalReviewingEvent,
  type RevokeSessionApprovalGrantInput,
  type SessionApprovalGrantsSnapshot,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientPreferences,
  type ConfiguredMcpServerItem,
  type ContextCompactionRecord,
  type ConversationBranchRecord,
  type ConversationTreeNode,
  type ConversationTreeState,
  type CreateAccountProfileInput,
  type CreateSessionInput,
  type DailyCalendarHeatmapCell,
  type DayHourHeatmapCell,
  type DiscoveredSkillItem,
  type ExternalReviewerProviderBreakdownItem,
  type ExternalReviewerTelemetrySnapshot,
  type ExternalReviewerModelsDiscoveryInput,
  type ExternalReviewerModelsDiscoveryResult,
  type ExternalTranslatorConfig,
  type ExternalTranslatorProviderBreakdownItem,
  type ExternalTranslatorTelemetrySnapshot,
  type ExternalTranslatorTestResult,
  type GravityDesktopBridge,
  type HourlyTokenBarBucket,
  type InstalledPluginItem,
  type ManagedSessionSummary,
  type McpActionInput,
  type ModelCostBreakdownItem,
  type ModelRateCard,
  type OpenLinkOrFileInput,
  type OpenLinkOrFileResult,
  type PendingApprovalRequest,
  type PluginActionInput,
  type PluginsManagerSnapshot,
  type SendPromptInput,
  type SessionContextTelemetry,
  type SessionInspectorData,
  type StoredConversationTree,
  type SwarmTopologyState,
  type SwitchConversationBranchInput,
  type SwitchConversationBranchResult,
  type TelemetryDashboardSnapshot,
  type TitleOrganizeResult,
  type TokenCostSummary,
  type TranslationConfig,
  type TranslationConfigPatch,
  type TranslationEngineMode,
  type UiScaleCommand,
  type WorkspaceLayoutState,
  type InspectLocalTargetsInput,
  type GetSessionPlanArtifactInput,
  type PlanArtifactChangedEvent,
  type PlanArtifactSnapshot,
  type InspectLocalTargetsResult,
  type InspectedLocalTarget,
  extractTargetBaseName,
  isPlausibleLocalFileCandidate,
  isSupportedPreviewImageExt,
  MAX_LOCAL_INSPECT_TARGETS,
  stripLocalTargetAnchor,
} from '@shared';

type Listener<T> = (payload: T) => void;

/** 浏览器预览使用内存中的监听器集合实现桌面桥接的订阅约定。返回的清理函数只撤销本次订阅。 */
function createEventChannel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe(fn: Listener<T>): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emit(payload: T): void {
      listeners.forEach((fn) => fn(payload));
    },
  };
}

function sumTokenCosts(items: TokenCostSummary[]): TokenCostSummary {
  return items.reduce<TokenCostSummary>(
    (acc, cur) => ({
      inputTokens: acc.inputTokens + cur.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + cur.cachedInputTokens,
      outputTokens: acc.outputTokens + cur.outputTokens,
      thinkingTokens: acc.thinkingTokens + cur.thinkingTokens,
      totalTokens: acc.totalTokens + cur.totalTokens,
      inputCostUsd: acc.inputCostUsd + cur.inputCostUsd,
      cachedInputCostUsd: acc.cachedInputCostUsd + cur.cachedInputCostUsd,
      outputCostUsd: acc.outputCostUsd + cur.outputCostUsd,
      thinkingCostUsd: acc.thinkingCostUsd + cur.thinkingCostUsd,
      totalCostUsd: acc.totalCostUsd + cur.totalCostUsd,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      outputCostUsd: 0,
      thinkingCostUsd: 0,
      totalCostUsd: 0,
    }
  );
}

function emptySwarmState(sessionId: string): SwarmTopologyState {
    return {
      sessionId,
      isActive: false,
      swarmTitle: '尚未启动 Swarm 协作',
      channels: ['general'],
      workers: [],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 0, working: 0, waiting: 0, completed: 0, killed: 0 },
      updatedAt: new Date().toISOString(),
    };
}

export interface FallbackDesktopBridge extends GravityDesktopBridge {
  triggerDemoApproval(sessionId: string): PendingApprovalRequest;
  /** 预览 Stage 2 Guardian 实时复核卡片：推送 reviewing 事件，延时后转人工并生成待审卡片。 */
  triggerDemoGuardianReview(sessionId: string, delayMs?: number): ApprovalReviewingEvent;
  /** 预览断连、限流冷却与重连等连接状态变化（仅演示环境）。 */
  emitDemoConnectionStatus(patch: Partial<AcpConnectionStatus>): AcpConnectionStatus;
}

/**
 * 浏览器预览中的本地引用检验：无法访问真实文件系统，只按文本规则给出分类，
 * 从不读取任何文件内容；拒绝裸扩展名与 `.gemini` 等受保护路径。
 */
export function mockInspectLocalTargets(input: InspectLocalTargetsInput): InspectLocalTargetsResult {
  const items: Record<string, InspectedLocalTarget> = {};
  for (const raw of (input.targets || []).slice(0, MAX_LOCAL_INSPECT_TARGETS)) {
    if (typeof raw !== 'string') continue;
    const fileName = extractTargetBaseName(raw);
    const clean = stripLocalTargetAnchor(raw);
    if (/(?:^|[\\/])\.gemini(?:[\\/]|$)|antigravity(?:-cli)?[\\/].*(?:\.pbtxt|\.pb|state\.vscdb)/i.test(clean)) {
      items[raw] = { rawTarget: raw, kind: 'forbidden', exists: false, fileName };
      continue;
    }
    if (!isPlausibleLocalFileCandidate(raw)) {
      items[raw] = { rawTarget: raw, kind: 'missing', exists: false, fileName };
      continue;
    }
    const extMatch = /\.([a-z0-9]{1,10})$/i.exec(fileName);
    const ext = extMatch ? extMatch[1].toLowerCase() : undefined;
    const isDir = /[\\/]$/.test(clean) || !ext;
    items[raw] = {
      rawTarget: raw,
      kind: isDir ? 'directory' : isSupportedPreviewImageExt(ext) ? 'image' : 'file',
      exists: true,
      fileName,
      ext,
      isExecutable: Boolean(ext && /^(?:exe|msi|bat|cmd|ps1|sh)$/.test(ext)),
    };
  }
  return { items };
}

/** 创建独立的演示环境。模拟账号、会话和统计都保存在这次调用的闭包中，测试可创建新实例以隔离状态。 */
export function createFallbackDesktopBridge(): FallbackDesktopBridge {
  const sessionEvents = createEventChannel<ManagedSessionSummary>();
  const messageEvents = createEventChannel<{ sessionId: string; message: ChatMessageItem }>();
  const inspectorEvents = createEventChannel<SessionInspectorData>();
  const planArtifactEvents = createEventChannel<PlanArtifactChangedEvent>();
  const approvalReqEvents = createEventChannel<PendingApprovalRequest>();
  const approvalConfigEvents = createEventChannel<ApproveForMeConfig>();
  const approvalResEvents = createEventChannel<{ requestId: string; sessionId: string }>();
  const telemetryEvents = createEventChannel<TelemetryDashboardSnapshot>();
  const swarmEvents = createEventChannel<SwarmTopologyState>();
  const accountEvents = createEventChannel<AccountsStateSnapshot>();
  const updateEvents = createEventChannel<AppUpdateState>();
  const treeEvents = createEventChannel<ConversationTreeState>();
  const translationConfigEvents = createEventChannel<TranslationConfig>();
  const approvalReviewingEvents = createEventChannel<ApprovalReviewingEvent>();
  const approvalGuardEvents = createEventChannel<ApprovalGuardActivityEvent>();
  const connectionEvents = createEventChannel<AcpConnectionStatus>();
  const uiScaleEvents = createEventChannel<UiScaleCommand>();
  let connectionOverride: Partial<AcpConnectionStatus> = {};
  /** 演示模式下按会话保存的 Approve for me 授权快照（命令前缀与 Guardian 委派）。 */
  const sessionGrants = new Map<string, SessionApprovalGrantsSnapshot>();
  /** 正在进行的演示 Stage 2 复核，转人工时据此中止计时并生成待审卡片。 */
  const activeReviews = new Map<string, { event: ApprovalReviewingEvent; timer: ReturnType<typeof setTimeout> }>();
  const treesByRoot = new Map<string, StoredConversationTree>();
  const branchToRoot = new Map<string, string>();

  let updateState: AppUpdateState = {
    status: 'idle',
    currentVersion: APP_BRAND.version,
    repoUrl: APP_BRAND.repoUrl,
    canInstallDirectly: false,
  };

  let preferences: ClientPreferences = {
    locale: 'zh-CN',
    theme: 'claude-code-dark',
    appIcon: 'gravity-claude-dark',
    defaultThoughtTrack: 'zh',
    translationEngine: 'local',
    processPerSession: false,
    activeProfileId: 'default',
    autoCheckUpdates: true,
  };

  let rateCards: ModelRateCard[] = DEFAULT_MODEL_RATE_CARDS.map((c) => ({ ...c }));
  let customRatesEdited = false;

  let accounts: AccountsStateSnapshot = {
    activeProfileId: 'default',
    profiles: [
      {
        profileId: 'default',
        name: 'Default Official Profile',
        isDefault: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        lastActivatedAt: '2026-11-17T07:55:00.000Z',
      },
      {
        profileId: 'profile-work',
        name: 'Studio Isolated Profile',
        isDefault: false,
        isolatedAppDataDir: 'gravity-userdata/profiles/profile-work',
        createdAt: '2026-11-10T00:00:00.000Z',
        lastActivatedAt: '2026-11-15T09:00:00.000Z',
      },
    ],
    acpIdentity: {
      connected: true,
      agentName: 'Antigravity ACP Agent',
      agentVersion: '1.5.10',
      authMethods: [
        {
          id: 'google-oauth',
          name: 'Google Official Login',
          description: 'Authenticate via official agy acp --login terminal',
        },
      ],
      supportsLogout: true,
    },
  };

  let approvalConfig: ApproveForMeConfig = {
    ...APPROVAL_POLICY_DEFAULTS,
    mode: 'rules-only',
    enableSafeDownloadAutoApprove: true,
    maxDownloadSizeMB: 25,
    cacheTtlHours: 24,
    allowPatterns: [
      '^git\\s+(status|diff|log|branch)\\b',
      '^npm\\s+run\\s+(typecheck|lint|test)\\b',
    ],
    askPatterns: ['^npm\\s+(install|publish)\\b', '^git\\s+(push|reset)\\b'],
    denyPatterns: ['rm\\s+-rf\\s+/', 'Format-Volume'],
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      apiKey: '',
      timeoutMs: 8000,
      maxOutputTokens: 4096,
      thinkingLevel: 'auto',
    },
  };

  let translationConfig: TranslationConfig = structuredClone(DEFAULT_TRANSLATION_CONFIG);

  const sampleWorkspaceFiles = [
    'docs/architecture.md',
    'package.json',
    'src/shared/index.ts',
    'src/shared/theme-i18n-contract.ts',
    'src/shared/telemetry-contract.ts',
    'src/shared/session-contract.ts',
    'src/renderer/App.tsx',
    'src/renderer/styles/theme.ts',
    'src/renderer/components/RightInspector.tsx',
    'src/main/core-service.ts',
  ];

  const demoDiff1 = computeUnifiedLineDiff(
    'src/renderer/styles/theme.ts',
    'const DEFAULT_DARK_ID = "codex-obsidian";\nroot.className = "dark";',
    'const DEFAULT_DARK_ID: BuiltinThemeId = "claude-code-dark";\nroot.setAttribute("data-theme", activeId);\nroot.setAttribute("data-polarity", polarity);',
    'tc-edit-theme'
  );

  const demoDiff2 = computeUnifiedLineDiff(
    'src/renderer/components/InlineRequestView.tsx',
    'return <button>Allow</button>;',
    'const options = buildClaudeStyleApprovalOptions(request, locale);\nreturn <div className="cc-option-list">{options.map(renderOption)}</div>;',
    'tc-edit-approval'
  );

  const sessions: ManagedSessionSummary[] = [
    {
      sessionId: 'sess-primary',
      cwd: normalizeWorkspacePath('C:\\Workspace\\DemoProject'),
      rawCwd: 'C:\\Workspace\\DemoProject',
      title: 'Frontend｜Gravity 三栏工作台与 Claude Code 交互重构',
      rawTitle: 'Frontend｜Gravity 三栏工作台与 Claude Code 交互重构',
      categoryTag: 'Frontend',
      pinned: true,
      isLegacyApprovalPollution: false,
      status: 'waiting_approval',
      modelId: 'gemini-4-carbon',
      executionMode: 'default',
      reasoningEffort: 'medium',
      availableEfforts: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'default',
      updatedAt: '2026-11-17T07:58:00.000Z',
    },
    {
      sessionId: 'sess-ui-theme',
      cwd: normalizeWorkspacePath('C:\\Workspace\\DemoProject'),
      rawCwd: 'C:\\Workspace\\DemoProject',
      title: '请帮我配置 6 套主题取色器并核对 24h/7d/30d 热力图渲染',
      rawTitle: '请帮我配置 6 套主题取色器并核对 24h/7d/30d 热力图渲染',
      pinned: false,
      isLegacyApprovalPollution: false,
      status: 'idle',
      modelId: 'gemini-3.8-flash',
      executionMode: 'accept-edits',
      reasoningEffort: 'medium',
      availableEfforts: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'default',
      updatedAt: '2026-11-17T07:50:00.000Z',
    },
    {
      sessionId: 'sess-gateway',
      cwd: normalizeWorkspacePath('/d%3A/Projects/CoreGateway'),
      rawCwd: '/d%3A/Projects/CoreGateway',
      title: 'Backend｜ACP 多路复用与只读历史监听器',
      rawTitle: 'Backend｜ACP 多路复用与只读历史监听器',
      categoryTag: 'Backend',
      pinned: false,
      isLegacyApprovalPollution: false,
      status: 'idle',
      modelId: 'gemini-2.5-pro',
      executionMode: 'plan',
      reasoningEffort: 'xhigh',
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'default',
      updatedAt: '2026-11-17T07:40:00.000Z',
    },
    {
      sessionId: 'sess-legacy-pollution-1',
      cwd: normalizeWorkspacePath('C:\\Workspace\\DemoProject'),
      rawCwd: 'C:\\Workspace\\DemoProject',
      title: "You are 'Approve for Me', an automated tool-approval security reviewer.",
      rawTitle: "You are 'Approve for Me', an automated tool-approval security reviewer.",
      pinned: false,
      isLegacyApprovalPollution: isLegacyPollutionSessionTitle(
        "You are 'Approve for Me', an automated tool-approval security reviewer."
      ),
      status: 'closed',
      modelId: 'gemini-2.5-flash-lite',
      executionMode: 'default',
      reasoningEffort: 'low',
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'default',
      updatedAt: '2026-11-16T12:20:00.000Z',
    },
  ];

  for (const session of sessions) {
    if (session.status !== 'closed') session.availableModels = buildConnectionStatus().availableModels;
  }


  let layout: WorkspaceLayoutState = {
    openTabSessionIds: ['sess-primary', 'sess-ui-theme'],
    activePrimarySessionId: 'sess-primary',
    splitSecondarySessionId: 'sess-ui-theme',
    layoutMode: 'single',
    hideLegacyPollutionSessions: true,
    leftSidebarCollapsed: false,
    leftSidebarWidth: 268,
    rightInspectorCollapsed: false,
    rightInspectorWidth: 380,
    activeInspectorTab: 'diff',
    splitRatio: 0.5,
  };

  let pendingApprovals: PendingApprovalRequest[] = [
    {
      requestId: 'req-init-001',
      sessionId: 'sess-primary',
      toolCallId: 'tc-build-verify',
      toolName: 'run_command',
      commandOrSummary: 'npm run typecheck:renderer && npm run build:renderer',
      cwd: 'C:\\Workspace\\DemoProject',
      createdAt: '2026-11-17T07:57:50.000Z',
      riskLevel: 'low',
      commandPrefix: 'npm run typecheck:renderer',
      explanation: {
        meaning: '运行前端 TypeScript 类型检查并构建 Gravity 渲染层静态资源。',
        target: '工作区 C:\\Workspace\\DemoProject 下的 src/renderer 与 dist/renderer。',
        risk: '更新本地 dist/renderer 构建产物，不修改业务源码或访问外部网络。',
      },
      screeningSource: 'local-ast',
      aiSuggestion: {
        recommended: 'approve',
        reason: '标准本地类型校验与前端打包命令，安全可控。',
        latencyMs: 0.6,
      },
    },
  ];

  const inspectorBySession: Record<string, SessionInspectorData> = {
    'sess-primary': {
      sessionId: 'sess-primary',
      diffs: [demoDiff1, demoDiff2],
      todos: [
        {
          id: 'todo-1',
          content: '重构 Gravity 三栏可拖拽布局及侧栏、检视器和分屏快捷键',
          status: 'completed',
          priority: 'high',
        },
        {
          id: 'todo-2',
          content: '接入 Claude Code 紧凑工具行与 1–4 编号内联权限确认',
          status: 'completed',
          priority: 'high',
        },
        {
          id: 'todo-3',
          content: '运行 typecheck:renderer 与 build:renderer 验证零错误',
          status: 'in_progress',
          priority: 'high',
        },
      ],
      plan: { state: 'present', revision: 3, truncated: false, totalCount: 3, completedCount: 2, failedCount: 0 },
      terminals: [
        {
          id: 'term-1',
          toolCallId: 'tc-git-status',
          command: 'git status --short',
          output: 'M src/renderer/App.tsx\nM src/renderer/styles/theme.ts',
          status: 'completed',
          exitCode: 0,
          timestamp: '2026-11-17T07:55:10.000Z',
        },
      ],
    },
    'sess-ui-theme': {
      sessionId: 'sess-ui-theme',
      diffs: [demoDiff1],
      todos: [
        {
          id: 'todo-ui-1',
          content: '核验 6 套预设主题与 23 项 Design Tokens 取色器',
          status: 'completed',
          priority: 'medium',
        },
      ],
      terminals: [],
    },
  };

  /** v0.3.5 演示：只读 implementation_plan.md（仅主演示会话有文档，其余会话为 missing） */
  const planArtifactsBySession: Record<string, { revision: number; content: string; updatedAt: string }> = {
    'sess-primary': {
      revision: 1,
      updatedAt: '2026-11-17T07:56:00.000Z',
      content: [
        '# Implementation Plan',
        '',
        '## 目标',
        '重构 Gravity 三栏工作台，并验证 **typecheck** 与 **build** 零错误。',
        '',
        '## 步骤',
        '- [x] 三栏可拖拽布局（`src/renderer/components/ResizeHandle.tsx`）',
        '- [x] 内联权限确认卡片',
        '- [ ] 运行 `npm run typecheck:renderer` 与 `npm run build:renderer`',
        '',
        '> 参考：[设计说明](docs/design.md)',
      ].join('\n'),
    },
  };

  const messagesBySession: Record<string, ChatMessageItem[]> = {
    'sess-primary': [
      {
        id: 'msg-u-1',
        sessionId: 'sess-primary',
        role: 'user',
        content: '请将工作台升级为 Gravity 三栏架构，重构主题与内联审批组件并执行构建检查。',
        references: [
          { kind: 'file', label: 'docs/architecture.md', value: 'docs/architecture.md' },
          {
            kind: 'file',
            label: 'src/shared/theme-i18n-contract.ts',
            value: 'src/shared/theme-i18n-contract.ts',
          },
        ],
        createdAt: '2026-11-17T07:54:00.000Z',
      },
      {
        id: 'msg-a-1',
        sessionId: 'sess-primary',
        role: 'assistant',
        content:
          '已完成 Gravity 主题引擎与 Claude Code 风格内联审批组件重构。现在准备运行前端类型检查与生产构建命令，请在下方选择 1–4 确认项：',
        thoughts: [
          {
            id: 'th-1',
            originalText:
              'Inspect shared contracts for Gravity v0.2, update ThemePaletteTokens with diff & syntax colors, render compact tool rows, and run typecheck.',
            translatedZhText:
              '核对 Gravity v0.2 共享契约，扩展包含 Diff 与语法高亮的 23 项颜色变量，渲染紧凑工具调用行并执行类型检查。',
            isStreaming: false,
            languageDetected: 'en',
            translationSource: 'local-stream-glossary',
          },
        ],
        toolCalls: [
          {
            toolCallId: 'tc-read-arch',
            rawToolName: 'read_file',
            canonicalToolName: getCanonicalToolName('read_file'),
            compactTarget: 'docs/architecture.md',
            status: 'completed',
            argsSummary: 'Read docs/architecture.md (lines 1-40)',
            locations: [{ path: 'docs/architecture.md', line: 1 }],
            outputPreview: '# Gravity 客户端架构总纲与合规契约 (v0.2.0)',
            startedAt: '2026-11-17T07:54:20.000Z',
            completedAt: '2026-11-17T07:54:21.000Z',
          },
          {
            toolCallId: 'tc-edit-theme',
            rawToolName: 'edit_file',
            canonicalToolName: getCanonicalToolName('edit_file'),
            compactTarget: 'src/renderer/styles/theme.ts',
            status: 'completed',
            argsSummary: 'Edit src/renderer/styles/theme.ts (+3 -2)',
            locations: [{ path: 'src/renderer/styles/theme.ts', line: 24 }],
            diffPatch: demoDiff1,
            startedAt: '2026-11-17T07:55:40.000Z',
            completedAt: '2026-11-17T07:55:42.000Z',
          },
          {
            toolCallId: 'tc-build-verify',
            rawToolName: 'run_command',
            canonicalToolName: getCanonicalToolName('run_command'),
            compactTarget: 'npm run typecheck:renderer && npm run build:renderer',
            status: 'pending',
            argsSummary: 'npm run typecheck:renderer && npm run build:renderer',
            startedAt: '2026-11-17T07:57:50.000Z',
          },
        ],
        todos: inspectorBySession['sess-primary'].todos,
        pendingApprovalId: 'req-init-001',
        createdAt: '2026-11-17T07:57:50.000Z',
      },
    ],
    'sess-ui-theme': [
      {
        id: 'msg-u-2',
        sessionId: 'sess-ui-theme',
        role: 'user',
        content: '检视 6 套内置主题色板与 24h / 7d / 30d Token 热力图配置。',
        createdAt: '2026-11-17T07:48:00.000Z',
      },
      {
        id: 'msg-a-2',
        sessionId: 'sess-ui-theme',
        role: 'assistant',
        content:
          '已接入 Claude Code Dark/Light、Ubuntu、macOS Dark/Light、Solarized Dark 共 6 套预设色板，并支持自定义取色与 JSON 导入导出。',
        createdAt: '2026-11-17T07:50:00.000Z',
      },
    ],
    'sess-gateway': [
      {
        id: 'msg-u-3',
        sessionId: 'sess-gateway',
        role: 'user',
        content: '确认本地历史导入严格遵循纯只读零写入约束。',
        createdAt: '2026-11-17T07:38:00.000Z',
      },
      {
        id: 'msg-a-3',
        sessionId: 'sess-gateway',
        role: 'assistant',
        content: '已确认：历史会话文件通过硬白名单与敏感路径硬黑名单双重过滤，全程只读零写入。',
        createdAt: '2026-11-17T07:40:00.000Z',
      },
    ],
  };

  const auditEntries: ApprovalAuditEntry[] = [
    {
      id: 'audit-001',
      timestamp: '2026-11-17T07:55:10.000Z',
      sessionId: 'sess-primary',
      cwd: 'C:\\Workspace\\DemoProject',
      toolName: 'run_command',
      commandOrSummary: 'git status --short',
      modeAtDecision: 'hybrid',
      verdict: 'auto_approved',
      decisionSource: 'local-rule',
      riskLevel: 'safe',
      latencyMs: 0.4,
      reason: '命中本地只读白名单正则 ^git\\s+(status|diff|log|branch)\\b',
    },
  ];

  let installedPlugins: InstalledPluginItem[] = [
    {
      name: 'chrome-devtools-plugin',
      version: '1.2.0',
      enabled: true,
      description: 'Chrome DevTools debugging & performance inspection integration',
      marketplace: 'official',
    },
    {
      name: 'gemini-api-helper',
      version: '0.9.4',
      enabled: false,
      description: 'SDK documentation & multimodal helper templates',
      marketplace: 'official',
    },
  ];

  let mcpServers: ConfiguredMcpServerItem[] = [
    {
      name: 'gemini-api-docs',
      type: 'stdio',
      commandOrUrl: 'npx',
      args: ['-y', '@google/gemini-docs-mcp'],
      enabled: true,
      status: 'ready',
    },
  ];

  let discoveredSkills: DiscoveredSkillItem[] = [
    {
      id: 'skill-agy-guide',
      name: 'antigravity-guide',
      description: 'Comprehensive reference for ACP, CLI flags, and customizations',
      scope: 'global',
      skillFilePath: 'builtin/skills/antigravity_guide/SKILL.md',
      enabled: true,
    },
    {
      id: 'skill-swarm',
      name: 'swarm',
      description: 'Multi-agent parallel collaboration through shared message board',
      scope: 'global',
      skillFilePath: 'builtin/skills/native_swarm/SKILL.md',
      enabled: true,
    },
  ];

  let lastPluginCliOutput = 'Ready (official CLI executed only on explicit user action).';

  const swarmBySession: Record<string, SwarmTopologyState> = {
  };

  const sessionRawTokenCounts: Record<
    string,
    {
      modelId: string;
      usedContextTokens: number;
      maxContextTokens: number;
      counts: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        thinkingTokens: number;
      };
    }
  > = {
    'sess-primary': {
      modelId: 'gemini-2.5-pro',
      usedContextTokens: 68_400,
      maxContextTokens: 1_000_000,
      counts: {
        inputTokens: 42_000,
        cachedInputTokens: 14_000,
        outputTokens: 7_600,
        thinkingTokens: 4_800,
      },
    },
    'sess-ui-theme': {
      modelId: 'gemini-2.5-flash',
      usedContextTokens: 31_200,
      maxContextTokens: 1_000_000,
      counts: {
        inputTokens: 19_000,
        cachedInputTokens: 6_200,
        outputTokens: 4_100,
        thinkingTokens: 1_900,
      },
    },
    'sess-gateway': {
      modelId: 'gemini-2.5-pro',
      usedContextTokens: 24_500,
      maxContextTokens: 1_000_000,
      counts: {
        inputTokens: 15_000,
        cachedInputTokens: 4_500,
        outputTokens: 3_200,
        thinkingTokens: 1_800,
      },
    },
  };

  const demoCompactions: Record<string, ContextCompactionRecord[]> = {
    'sess-primary': [
      {
        id: 'cmp-demo-1',
        timestamp: '2026-11-17T07:42:00.000Z',
        trigger: 'manual',
        beforeTokens: 142_800,
        afterTokens: 68_400,
        savedTokens: 74_400,
        maxContextTokens: 1_000_000,
      },
    ],
  };

  /** 复制插件列表以及 MCP 的参数数组再交给界面，调用者编辑表单时不会直接改动演示数据。 */
  function buildPluginsSnapshot(): PluginsManagerSnapshot {
    return {
      builtins: GRAVITY_BUILTIN_CAPABILITIES,
      plugins: installedPlugins.map((p) => ({ ...p })),
      mcpServers: mcpServers.map((m) => ({ ...m, args: [...m.args] })),
      skills: discoveredSkills.map((s) => ({ ...s })),
      lastCommandOutput: lastPluginCliOutput,
      refreshedAt: new Date().toISOString(),
    };
  }

  function buildModelBreakdown(
    entries: Array<{
      modelId: string;
      counts: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        thinkingTokens: number;
      };
    }>
  ): ModelCostBreakdownItem[] {
    const byModel = new Map<
      string,
      {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        thinkingTokens: number;
      }
    >();
    for (const item of entries) {
      const prev = byModel.get(item.modelId) ?? {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
      };
      byModel.set(item.modelId, {
        inputTokens: prev.inputTokens + item.counts.inputTokens,
        cachedInputTokens: prev.cachedInputTokens + item.counts.cachedInputTokens,
        outputTokens: prev.outputTokens + item.counts.outputTokens,
        thinkingTokens: prev.thinkingTokens + item.counts.thinkingTokens,
      });
    }

    const computed = Array.from(byModel.entries()).map(([modelId, counts]) => {
      const rate = resolveModelRateCard(modelId, rateCards);
      const cost = calculateTokenCost(counts, rate);
      return {
        modelId,
        displayName: rate.displayName || modelId,
        ...cost,
        shareRatio: 0,
      };
    });

    const grandTotal = computed.reduce((acc, c) => acc + c.totalCostUsd, 0);
    return computed.map((c) => ({
      ...c,
      shareRatio: grandTotal > 0 ? c.totalCostUsd / grandTotal : 0,
    }));
  }

  /**
   * 用内存中的样例计数构造与桌面版同形的看板。
   * 每次按当前价卡重算金额，使单价编辑能立即反映在演示图表中。
   */
  function buildTelemetrySnapshot(): TelemetryDashboardSnapshot {
    const pricingSource = customRatesEdited ? 'user-custom-rate' : 'reference-api-estimate';
    const proRate = resolveModelRateCard('gemini-2.5-pro', rateCards);

    const activeSessions: Record<string, SessionContextTelemetry> = {};
    const sessionModelBreakdowns: Record<string, ModelCostBreakdownItem[]> = {};

    for (const [sid, raw] of Object.entries(sessionRawTokenCounts)) {
      if (!sessions.some(s => s.sessionId === sid && s.profileId === accounts.activeProfileId)) continue;
      const rate = resolveModelRateCard(raw.modelId, rateCards);
      const costSummary = calculateTokenCost(raw.counts, rate);
      const ratio = raw.usedContextTokens / raw.maxContextTokens;
      activeSessions[sid] = {
        sessionId: sid,
        modelId: raw.modelId,
        maxContextTokens: raw.maxContextTokens,
        usedContextTokens: raw.usedContextTokens,
        usageRatio: ratio,
        pressureLevel:
          ratio > 0.85
            ? 'critical'
            : ratio > 0.65
              ? 'warning'
              : ratio > 0.35
                ? 'moderate'
                : 'healthy',
        breakdown: {
          systemAndRulesTokens: Math.round(raw.usedContextTokens * 0.14),
          userMessagesTokens: Math.round(raw.usedContextTokens * 0.12),
          agentMessagesTokens: Math.round(raw.usedContextTokens * 0.28),
          thoughtTokens: raw.counts.thinkingTokens,
          toolCallsTokens: Math.round(raw.usedContextTokens * 0.24),
          attachmentsTokens: Math.round(raw.usedContextTokens * 0.1),
        },
        attachments:
          sid === 'sess-primary'
            ? [
                {
                  id: 'att-arch',
                  name: 'docs/architecture.md',
                  kind: 'file',
                  sizeBytes: 4_820,
                  estimatedTokens: 1_650,
                },
                {
                  id: 'att-theme',
                  name: 'src/shared/theme-i18n-contract.ts',
                  kind: 'file',
                  sizeBytes: 14_200,
                  estimatedTokens: 4_100,
                },
              ]
            : [],
        compactions: (demoCompactions[sid] ?? []).map((c) => ({ ...c })),
        currentTokensPerSecond: sid === 'sess-primary' ? 78.4 : 64.2,
        averageTokensPerSecond: sid === 'sess-primary' ? 66.8 : 58.5,
        peakTokensPerSecond: sid === 'sess-primary' ? 116.8 : 95.0,
        averageCacheHitRate:
          costSummary.inputTokens + costSummary.cachedInputTokens > 0
            ? costSummary.cachedInputTokens / (costSummary.inputTokens + costSummary.cachedInputTokens)
            : undefined,
        costSummary,
        usageSource: 'mixed',
        pricingSource,
        updatedAt: '2026-11-17T07:58:00.000Z',
      };

      sessionModelBreakdowns[sid] = [
        {
          modelId: raw.modelId,
          displayName: rate.displayName,
          ...costSummary,
          shareRatio: 1,
        },
      ];
    }

    // 1) 24h 按小时柱状序列（24 桶）
    const hourly24h: HourlyTokenBarBucket[] = [];
    const anchorHour = new Date('2026-11-17T15:00:00Z');
    for (let i = 23; i >= 0; i -= 1) {
      const dt = new Date(anchorHour.getTime() - i * 3_600_000);
      const hh = String(dt.getUTCHours()).padStart(2, '0');
      const seed = (i * 7 + 5) % 11;
      const activeFactor = seed <= 2 ? 0 : seed;
      const counts = {
        inputTokens: activeFactor * 6_200,
        cachedInputTokens: activeFactor * 2_800,
        outputTokens: activeFactor * 1_400,
        thinkingTokens: activeFactor * 800,
      };
      const c = calculateTokenCost(counts, proRate);
      hourly24h.push({
        hourKey: `${dt.toISOString().slice(0, 13)}`,
        hourLabel: `${hh}:00`,
        ...counts,
        totalTokens: c.totalTokens,
        costUsd: c.totalCostUsd,
      });
    }

    // 2) 7d 7×24 天×小时矩阵（168 格）
    const matrix7d: DayHourHeatmapCell[] = [];
    const baseDay = new Date('2026-11-17T00:00:00Z');
    for (let d = 6; d >= 0; d -= 1) {
      const dayObj = new Date(baseDay.getTime() - d * 86_400_000);
      const dateStr = dayObj.toISOString().slice(0, 10);
      for (let h = 0; h < 24; h += 1) {
        const score = (d * 13 + h * 5) % 17;
        const intensity: 0 | 1 | 2 | 3 | 4 =
          h < 7 ? 0 : score > 14 ? 4 : score > 10 ? 3 : score > 6 ? 2 : score > 3 ? 1 : 0;
        const totalTokens = intensity * 18_500;
        const c = calculateTokenCost(
          {
            inputTokens: Math.round(totalTokens * 0.55),
            cachedInputTokens: Math.round(totalTokens * 0.2),
            outputTokens: Math.round(totalTokens * 0.15),
            thinkingTokens: Math.round(totalTokens * 0.1),
          },
          proRate
        );
        matrix7d.push({
          date: dateStr,
          hour: h,
          totalTokens,
          costUsd: c.totalCostUsd,
          intensity,
        });
      }
    }

    // 3) 30d 日历热力格（30 格）
    const calendar30d: DailyCalendarHeatmapCell[] = [];
    for (let d = 29; d >= 0; d -= 1) {
      const dayObj = new Date(baseDay.getTime() - d * 86_400_000);
      const dateStr = dayObj.toISOString().slice(0, 10);
      const seed = (d * 19 + 7) % 15;
      const intensity: 0 | 1 | 2 | 3 | 4 =
        seed > 12 ? 4 : seed > 9 ? 3 : seed > 5 ? 2 : seed > 2 ? 1 : 0;
      const counts = {
        inputTokens: intensity * 65_000,
        cachedInputTokens: intensity * 24_000,
        outputTokens: intensity * 14_000,
        thinkingTokens: intensity * 8_000,
      };
      const c = calculateTokenCost(counts, proRate);
      calendar30d.push({
        date: dateStr,
        ...counts,
        totalTokens: c.totalTokens,
        costUsd: c.totalCostUsd,
        sessionCount: intensity === 0 ? 0 : intensity + 1,
        intensity,
      });
    }

    // 4) v0.3.5 7d 按自然日序列：取 30d 末 7 天，并以 7 日窗口独立计算强度
    const daily7dFrom = (calendar: DailyCalendarHeatmapCell[]): DailyCalendarHeatmapCell[] => {
      const last7 = calendar.slice(-7);
      const total = last7.reduce((acc, d) => acc + d.totalTokens, 0);
      const peak = last7.reduce((acc, d) => Math.max(acc, d.totalTokens), 0);
      return last7.map((d) => ({ ...d, intensity: computeHeatLevel(d.totalTokens, total, peak, 7) }));
    };
    const daily7d = daily7dFrom(calendar30d);

    const todayModels = buildModelBreakdown([
      {
        modelId: 'gemini-2.5-pro',
        counts: {
          inputTokens: 185_000,
          cachedInputTokens: 64_000,
          outputTokens: 32_000,
          thinkingTokens: 19_000,
        },
      },
      {
        modelId: 'gemini-2.5-flash',
        counts: {
          inputTokens: 140_000,
          cachedInputTokens: 52_000,
          outputTokens: 28_000,
          thinkingTokens: 11_000,
        },
      },
      {
        modelId: 'gemini-2.5-flash-lite',
        counts: {
          inputTokens: 80_000,
          cachedInputTokens: 20_000,
          outputTokens: 12_000,
          thinkingTokens: 4_000,
        },
      },
    ]);

    const range7dModels = buildModelBreakdown([
      {
        modelId: 'gemini-2.5-pro',
        counts: {
          inputTokens: 1_120_000,
          cachedInputTokens: 430_000,
          outputTokens: 198_000,
          thinkingTokens: 112_000,
        },
      },
      {
        modelId: 'gemini-2.5-flash',
        counts: {
          inputTokens: 890_000,
          cachedInputTokens: 310_000,
          outputTokens: 165_000,
          thinkingTokens: 74_000,
        },
      },
      {
        modelId: 'gemini-2.5-flash-lite',
        counts: {
          inputTokens: 420_000,
          cachedInputTokens: 110_000,
          outputTokens: 68_000,
          thinkingTokens: 22_000,
        },
      },
    ]);

    const range30dModels = buildModelBreakdown([
      {
        modelId: 'gemini-2.5-pro',
        counts: {
          inputTokens: 4_680_000,
          cachedInputTokens: 1_920_000,
          outputTokens: 840_000,
          thinkingTokens: 490_000,
        },
      },
      {
        modelId: 'gemini-2.5-flash',
        counts: {
          inputTokens: 3_540_000,
          cachedInputTokens: 1_280_000,
          outputTokens: 670_000,
          thinkingTokens: 290_000,
        },
      },
      {
        modelId: 'gemini-2.5-flash-lite',
        counts: {
          inputTokens: 1_650_000,
          cachedInputTokens: 480_000,
          outputTokens: 240_000,
          thinkingTokens: 85_000,
        },
      },
    ]);

    const geminiRate = resolveModelRateCard('gemini-4-hydrogen', rateCards);
    const openAiRate = resolveModelRateCard('gpt-4o-mini', rateCards);
    const extProviderGemini = calculateTokenCost(
      { inputTokens: 18_400, cachedInputTokens: 3_200, outputTokens: 2_100, thinkingTokens: 4_800 },
      geminiRate
    );
    const extProviderOpenAi = calculateTokenCost(
      { inputTokens: 9_600, cachedInputTokens: 1_200, outputTokens: 1_450, thinkingTokens: 0 },
      openAiRate
    );
    const extTotalCost = extProviderGemini.totalCostUsd + extProviderOpenAi.totalCostUsd;
    const extCumProviders: ExternalReviewerProviderBreakdownItem[] = [
      {
        key: 'gemini-api-key:generativelanguage.googleapis.com:gemini-4-hydrogen',
        provider: 'gemini-api-key',
        endpointHost: 'generativelanguage.googleapis.com',
        modelId: 'gemini-4-hydrogen',
        displayName: geminiRate.displayName,
        ...extProviderGemini,
        callCount: 19,
        approvedCount: 15,
        askCount: 3,
        denyCount: 1,
        errorCount: 0,
        shareRatio: extTotalCost > 0 ? extProviderGemini.totalCostUsd / extTotalCost : 0.65,
      },
      {
        key: 'openai-compatible:api.openai.com:gpt-4o-mini',
        provider: 'openai-compatible',
        endpointHost: 'api.openai.com',
        modelId: 'gpt-4o-mini',
        displayName: openAiRate.displayName,
        ...extProviderOpenAi,
        callCount: 11,
        approvedCount: 9,
        askCount: 2,
        denyCount: 0,
        errorCount: 0,
        shareRatio: extTotalCost > 0 ? extProviderOpenAi.totalCostUsd / extTotalCost : 0.35,
      },
    ];
    const extSessionGemini = calculateTokenCost(
      { inputTokens: 4_200, cachedInputTokens: 800, outputTokens: 540, thinkingTokens: 1_100 },
      geminiRate
    );
    const extCumSum = sumTokenCosts(extCumProviders);
    const externalReviewer: ExternalReviewerTelemetrySnapshot = {
      cumulativeAllTime: {
        ...extCumSum,
        callCount: 30,
        approvedCount: 24,
        askCount: 5,
        denyCount: 1,
        errorCount: 0,
        providerCount: 2,
      },
      cumulativeProviders: extCumProviders,
      bySession: {
        'sess-primary': {
          sessionId: 'sess-primary',
          ...extSessionGemini,
          callCount: 6,
          approvedCount: 5,
          askCount: 1,
          denyCount: 0,
          errorCount: 0,
          avgLatencyMs: 640,
          providers: [
            {
              key: 'gemini-api-key:generativelanguage.googleapis.com:gemini-4-hydrogen',
              provider: 'gemini-api-key',
              endpointHost: 'generativelanguage.googleapis.com',
              modelId: 'gemini-4-hydrogen',
              displayName: geminiRate.displayName,
              ...extSessionGemini,
              callCount: 6,
              approvedCount: 5,
              askCount: 1,
              denyCount: 0,
              errorCount: 0,
              shareRatio: 1,
            },
          ],
          updatedAt: new Date().toISOString(),
        },
      },
      hourly24h: hourly24h.map((b, idx) => ({
        ...b,
        inputTokens: idx >= 20 ? Math.round(b.inputTokens * 0.08) : 0,
        cachedInputTokens: idx >= 20 ? Math.round(b.cachedInputTokens * 0.06) : 0,
        outputTokens: idx >= 20 ? Math.round(b.outputTokens * 0.05) : 0,
        thinkingTokens: idx >= 20 ? Math.round(b.thinkingTokens * 0.05) : 0,
        totalTokens: idx >= 20 ? Math.round(b.totalTokens * 0.07) : 0,
        costUsd: idx >= 20 ? b.costUsd * 0.05 : 0,
      })),
      matrix7d: matrix7d.map((c, idx) => ({
        ...c,
        totalTokens: idx % 17 === 0 ? Math.round(c.totalTokens * 0.08) : 0,
        costUsd: idx % 17 === 0 ? c.costUsd * 0.05 : 0,
        intensity: (idx % 17 === 0 && c.intensity > 0 ? Math.min(2, c.intensity) : 0) as 0 | 1 | 2 | 3 | 4,
      })),
      calendar30d: calendar30d.map((d, idx) => ({
        ...d,
        inputTokens: idx >= 25 ? Math.round(d.inputTokens * 0.08) : 0,
        cachedInputTokens: idx >= 25 ? Math.round(d.cachedInputTokens * 0.06) : 0,
        outputTokens: idx >= 25 ? Math.round(d.outputTokens * 0.05) : 0,
        thinkingTokens: idx >= 25 ? Math.round(d.thinkingTokens * 0.05) : 0,
        totalTokens: idx >= 25 ? Math.round(d.totalTokens * 0.07) : 0,
        costUsd: idx >= 25 ? d.costUsd * 0.05 : 0,
        sessionCount: idx >= 25 ? 1 : 0,
        intensity: (idx >= 25 ? Math.min(2, d.intensity) : 0) as 0 | 1 | 2 | 3 | 4,
      })),
      costByRange: {
        today: { ...extSessionGemini, callCount: 6 },
        '7d': { ...extCumSum, callCount: 30 },
        '30d': { ...extCumSum, callCount: 30 },
      },
      providerBreakdownByRange: {
        today: [
          {
            key: 'gemini-api-key:generativelanguage.googleapis.com:gemini-4-hydrogen',
            provider: 'gemini-api-key',
            endpointHost: 'generativelanguage.googleapis.com',
            modelId: 'gemini-4-hydrogen',
            displayName: geminiRate.displayName,
            ...extSessionGemini,
            callCount: 6,
            approvedCount: 5,
            askCount: 1,
            denyCount: 0,
            errorCount: 0,
            shareRatio: 1,
          },
        ],
        '7d': extCumProviders,
        '30d': extCumProviders,
      },
      updatedAt: new Date().toISOString(),
    };

    const flashLiteRate = resolveModelRateCard('gemini-2.5-flash-lite', rateCards);
    const transGemini = calculateTokenCost(
      { inputTokens: 24_000, cachedInputTokens: 4_000, outputTokens: 16_500, thinkingTokens: 0 },
      flashLiteRate
    );
    const transOpenAi = calculateTokenCost(
      { inputTokens: 8_400, cachedInputTokens: 0, outputTokens: 5_200, thinkingTokens: 0 },
      openAiRate
    );
    const transTotalCost = transGemini.totalCostUsd + transOpenAi.totalCostUsd;
    const transCumProviders: ExternalTranslatorProviderBreakdownItem[] = [
      {
        key: 'gemini-api-key:generativelanguage.googleapis.com:gemini-2.5-flash-lite',
        provider: 'gemini-api-key',
        endpointHost: 'generativelanguage.googleapis.com',
        modelId: 'gemini-2.5-flash-lite',
        displayName: flashLiteRate.displayName,
        ...transGemini,
        callCount: 42,
        successCount: 40,
        fallbackCount: 2,
        errorCount: 0,
        shareRatio: transTotalCost > 0 ? transGemini.totalCostUsd / transTotalCost : 0.7,
      },
      {
        key: 'openai-compatible:api.openai.com:gpt-4o-mini',
        provider: 'openai-compatible',
        endpointHost: 'api.openai.com',
        modelId: 'gpt-4o-mini',
        displayName: openAiRate.displayName,
        ...transOpenAi,
        callCount: 15,
        successCount: 14,
        fallbackCount: 1,
        errorCount: 0,
        shareRatio: transTotalCost > 0 ? transOpenAi.totalCostUsd / transTotalCost : 0.3,
      },
    ];
    const transSessionGemini = calculateTokenCost(
      { inputTokens: 5_200, cachedInputTokens: 1_000, outputTokens: 3_600, thinkingTokens: 0 },
      flashLiteRate
    );
    const transCumSum = sumTokenCosts(transCumProviders);
    const externalTranslator: ExternalTranslatorTelemetrySnapshot = {
      cumulativeAllTime: {
        ...transCumSum,
        callCount: 57,
        successCount: 54,
        fallbackCount: 3,
        errorCount: 0,
        providerCount: 2,
      },
      cumulativeProviders: transCumProviders,
      bySession: {
        'sess-primary': {
          sessionId: 'sess-primary',
          ...transSessionGemini,
          callCount: 12,
          successCount: 11,
          fallbackCount: 1,
          errorCount: 0,
          avgLatencyMs: 310,
          providers: [
            {
              key: 'gemini-api-key:generativelanguage.googleapis.com:gemini-2.5-flash-lite',
              provider: 'gemini-api-key',
              endpointHost: 'generativelanguage.googleapis.com',
              modelId: 'gemini-2.5-flash-lite',
              displayName: flashLiteRate.displayName,
              ...transSessionGemini,
              callCount: 12,
              successCount: 11,
              fallbackCount: 1,
              errorCount: 0,
              shareRatio: 1,
            },
          ],
          updatedAt: new Date().toISOString(),
        },
      },
      hourly24h: hourly24h.map((b, idx) => ({
        ...b,
        inputTokens: idx >= 18 ? Math.round(b.inputTokens * 0.06) : 0,
        cachedInputTokens: idx >= 18 ? Math.round(b.cachedInputTokens * 0.04) : 0,
        outputTokens: idx >= 18 ? Math.round(b.outputTokens * 0.12) : 0,
        thinkingTokens: 0,
        totalTokens: idx >= 18 ? Math.round(b.totalTokens * 0.06) : 0,
        costUsd: idx >= 18 ? b.costUsd * 0.012 : 0,
      })),
      matrix7d: matrix7d.map((c, idx) => ({
        ...c,
        totalTokens: idx % 13 === 0 ? Math.round(c.totalTokens * 0.06) : 0,
        costUsd: idx % 13 === 0 ? c.costUsd * 0.012 : 0,
        intensity: (idx % 13 === 0 && c.intensity > 0 ? Math.min(2, c.intensity) : 0) as 0 | 1 | 2 | 3 | 4,
      })),
      calendar30d: calendar30d.map((d, idx) => ({
        ...d,
        inputTokens: idx >= 23 ? Math.round(d.inputTokens * 0.06) : 0,
        cachedInputTokens: idx >= 23 ? Math.round(d.cachedInputTokens * 0.04) : 0,
        outputTokens: idx >= 23 ? Math.round(d.outputTokens * 0.12) : 0,
        thinkingTokens: 0,
        totalTokens: idx >= 23 ? Math.round(d.totalTokens * 0.06) : 0,
        costUsd: idx >= 23 ? d.costUsd * 0.012 : 0,
        sessionCount: idx >= 23 ? 1 : 0,
        intensity: (idx >= 23 ? Math.min(2, d.intensity) : 0) as 0 | 1 | 2 | 3 | 4,
      })),
      costByRange: {
        today: { ...transSessionGemini, callCount: 12 },
        '7d': { ...transCumSum, callCount: 57 },
        '30d': { ...transCumSum, callCount: 57 },
      },
      providerBreakdownByRange: {
        today: [
          {
            key: 'gemini-api-key:generativelanguage.googleapis.com:gemini-2.5-flash-lite',
            provider: 'gemini-api-key',
            endpointHost: 'generativelanguage.googleapis.com',
            modelId: 'gemini-2.5-flash-lite',
            displayName: flashLiteRate.displayName,
            ...transSessionGemini,
            callCount: 12,
            successCount: 11,
            fallbackCount: 1,
            errorCount: 0,
            shareRatio: 1,
          },
        ],
        '7d': transCumProviders,
        '30d': transCumProviders,
      },
      updatedAt: new Date().toISOString(),
    };

    externalReviewer.daily7d = daily7dFrom(externalReviewer.calendar30d);
    externalTranslator.daily7d = daily7dFrom(externalTranslator.calendar30d);

    return {
      activeSessions,
      hourly24h,
      daily7d,
      matrix7d,
      calendar30d,
      costByRange: {
        today: sumTokenCosts(todayModels),
        '7d': sumTokenCosts(range7dModels),
        '30d': sumTokenCosts(range30dModels),
      },
      modelBreakdownByRange: {
        today: todayModels,
        '7d': range7dModels,
        '30d': range30dModels,
      },
      sessionModelBreakdowns,
      externalReviewer,
      externalTranslator,
      rateCards: rateCards.map((r) => ({ ...r })),
      pricingSource,
      generatedAt: new Date().toISOString(),
    };
  }

  function buildConnectionStatus(): AcpConnectionStatus {
    const activeCount = sessions.filter(
      (s) => s.profileId === accounts.activeProfileId && !s.isLegacyApprovalPollution && s.status !== 'closed'
    ).length;
    return {
      connected: true,
      agyBinaryPath: 'agy',
      agyVersion: '1.5.10',
      agentServerVersion: '2026.11',
      activeSessionCount: Math.min(activeCount, MAX_PARALLEL_ACTIVE_SESSIONS),
      maxParallelSessions: MAX_PARALLEL_ACTIVE_SESSIONS,
      activeProfileId: accounts.activeProfileId,
      modelListSource: 'live',
      availableModels: [
        { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { modelId: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { modelId: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
        { modelId: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' },
        { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
        { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
        { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
    };
  }

  function getVisibleSessions(includeHiddenPollution = false): ManagedSessionSummary[] {
    return sessions
      .filter((s) => s.profileId === accounts.activeProfileId && (includeHiddenPollution || !s.isLegacyApprovalPollution))
      .map((s) => applyFallbackTreeMetadata(s));
  }


  function grantsFor(sessionId: string): SessionApprovalGrantsSnapshot {
    let snap = sessionGrants.get(sessionId);
    if (!snap) {
      const cwd = sessions.find((s) => s.sessionId === sessionId)?.cwd ?? '';
      snap = { sessionId, workspaceKey: normalizeWorkspacePath(cwd) || cwd, delegatedToGuardian: false, prefixes: [] };
      sessionGrants.set(sessionId, snap);
    }
    return snap;
  }

  function syncGrantFlag(sessionId: string): void {
    const target = sessions.find((s) => s.sessionId === sessionId);
    if (!target) return;
    const snap = sessionGrants.get(sessionId);
    const has = Boolean(snap && (snap.delegatedToGuardian || snap.prefixes.length > 0)) || Boolean(target.approvalModeOverride);
    if (has) target.hasApprovalGrants = true;
    else delete target.hasApprovalGrants;
    sessionEvents.emit({ ...target });
  }

  /** 演示 Stage 2：先推送“正在审查”，到时转人工（escalated）并生成一张 Stage 3 卡片。 */
  function triggerDemoGuardianReview(sessionId: string, delayMs = 4200): ApprovalReviewingEvent {
    const targetSession = sessions.find((s) => s.sessionId === sessionId) ?? sessions[0];
    const requestId = `req-review-${Date.now()}`;
    const event: ApprovalReviewingEvent = {
      requestId,
      sessionId: targetSession.sessionId,
      toolCallId: `tc-review-${Date.now()}`,
      toolName: 'run_command',
      commandPreview: 'npm install --save-dev vitest@latest',
      provider: approvalConfig.externalReviewer.provider,
      model: approvalConfig.externalReviewer.model,
      status: 'reviewing',
      startedAt: new Date().toISOString(),
    };
    const timer = setTimeout(() => finishDemoReview(requestId, 'escalated'), delayMs);
    activeReviews.set(requestId, { event, timer });
    approvalReviewingEvents.emit({ ...event });
    return event;
  }

  function finishDemoReview(requestId: string, status: 'escalated' | 'cancelled'): boolean {
    const active = activeReviews.get(requestId);
    if (!active) return false;
    clearTimeout(active.timer);
    activeReviews.delete(requestId);
    const elapsedMs = Date.now() - Date.parse(active.event.startedAt);
    approvalReviewingEvents.emit({ ...active.event, status, elapsedMs });
    if (status === 'cancelled') {
      approvalGuardEvents.emit({
        sessionId: active.event.sessionId,
        kind: 'review-cancelled',
        activeCount: activeReviews.size,
        message: '已中止 AI 复核，转为人工审批',
        timestamp: new Date().toISOString(),
      });
    }
    const req = triggerDemoApproval(active.event.sessionId);
    const escalated: PendingApprovalRequest = {
      ...req,
      toolName: active.event.toolName,
      commandOrSummary: active.event.commandPreview,
      commandPrefix: 'npm install',
      riskLevel: 'medium',
      screeningSource: 'ai-reviewer-fallback',
      aiSuggestion: status === 'cancelled' ? undefined : {
        recommended: 'ask',
        reason: '安装开发依赖会改写 package-lock.json 并从公网下载包，建议由你确认版本范围。',
        latencyMs: elapsedMs,
        model: active.event.model,
        riskScore: 46,
        intentAlignment: 'uncertain',
      },
    };
    pendingApprovals = pendingApprovals.map((p) => (p.requestId === req.requestId ? escalated : p));
    approvalReqEvents.emit({ ...escalated });
    return true;
  }

  /** 构造一次可交互的样例审批。待审项、工具卡和会话状态共用对应的标识，便于页面联动。 */
  function triggerDemoApproval(sessionId: string): PendingApprovalRequest {
    const targetSession = sessions.find((s) => s.sessionId === sessionId) ?? sessions[0];
    const reqId = `req-${Date.now()}`;
    const tcId = `tc-${Date.now()}`;
    const createdAt = new Date().toISOString();

    const newReq: PendingApprovalRequest = {
      requestId: reqId,
      sessionId: targetSession.sessionId,
      toolCallId: tcId,
      toolName: 'run_command',
      commandOrSummary: 'git diff --stat && npm test',
      cwd: targetSession.cwd,
      createdAt,
      riskLevel: 'low',
      commandPrefix: 'git diff',
      explanation: {
        meaning: '查看当前仓库变更统计并执行 Vitest 测试套件。',
        target: `工作目录 ${targetSession.cwd}。`,
        risk: '只读统计与测试运行，不涉及生产环境外部变更。',
      },
      screeningSource: approvalConfig.mode === 'manual' ? 'manual-mode' : 'local-ast',
    };

    pendingApprovals = [...pendingApprovals, newReq];
    targetSession.status = 'waiting_approval';
    targetSession.updatedAt = createdAt;

    const msg: ChatMessageItem = {
      id: `msg-approval-${Date.now()}`,
      sessionId: targetSession.sessionId,
      role: 'assistant',
      content: '准备运行变更检查与回归测试，请确认操作权限：',
      toolCalls: [
        {
          toolCallId: tcId,
          rawToolName: 'run_command',
          canonicalToolName: 'Bash',
          compactTarget: newReq.commandOrSummary,
          status: 'pending',
          argsSummary: newReq.commandOrSummary,
          startedAt: createdAt,
        },
      ],
      pendingApprovalId: reqId,
      createdAt,
    };

    messagesBySession[targetSession.sessionId] = [
      ...(messagesBySession[targetSession.sessionId] ?? []),
      msg,
    ];

    sessionEvents.emit({ ...targetSession });
    messageEvents.emit({ sessionId: targetSession.sessionId, message: structuredClone(msg) });
    approvalReqEvents.emit({ ...newReq });
    return newReq;
  }

  function resolveFallbackRootId(sessionId: string): string {
    return branchToRoot.get(sessionId) || sessionId;
  }

  function listFallbackBranchIds(sessionId: string): string[] {
    const rootId = resolveFallbackRootId(sessionId);
    const tree = treesByRoot.get(rootId);
    return tree ? Object.keys(tree.branches) : [sessionId];
  }

  function applyFallbackTreeMetadata(session: ManagedSessionSummary): ManagedSessionSummary {
    const rootId = branchToRoot.get(session.sessionId);
    if (!rootId) return { ...session };
    const tree = treesByRoot.get(rootId);
    if (!tree) return { ...session };
    const node = tree.branches[session.sessionId];
    const branchCount = Object.keys(tree.branches).length;
    if (!node || branchCount <= 1) return { ...session };
    const rootSession = sessions.find((s) => s.sessionId === rootId);
    return {
      ...session,
      title: rootSession?.title || session.title,
      rootSessionId: rootId,
      parentBranchId: node.parentBranchId,
      forkAfterMessageId: node.forkAfterMessageId,
      branchCount,
      activeBranchId: tree.activeBranchId,
    };
  }

  function buildFallbackTreeState(sessionId: string): ConversationTreeState {
    const rootId = resolveFallbackRootId(sessionId);
    const stored = treesByRoot.get(rootId);
    const rootSession = sessions.find((s) => s.sessionId === rootId);
    const rootTitle = rootSession?.title || '新建对话';
    const teleSnap = buildTelemetrySnapshot();
    const records: Record<string, ConversationBranchRecord> = stored
      ? structuredClone(stored.branches)
      : {
          [rootId]: {
            branchId: rootId,
            parentBranchId: null,
            forkAfterMessageId: null,
            forkUserTurnIndex: -1,
            forkPromptPreview: summarizeBranchSnippet((messagesBySession[rootId] || []).find((m) => m.role === 'user')?.content, 72),
            createdAt: rootSession?.updatedAt || new Date().toISOString(),
            updatedAt: rootSession?.updatedAt || new Date().toISOString(),
          },
        };
    const activeBranchId = stored?.activeBranchId && records[stored.activeBranchId] ? stored.activeBranchId : rootId;
    const childrenMap = new Map<string, string[]>();
    for (const id of Object.keys(records)) childrenMap.set(id, []);
    for (const rec of Object.values(records)) {
      if (rec.parentBranchId && childrenMap.has(rec.parentBranchId)) {
        childrenMap.get(rec.parentBranchId)!.push(rec.branchId);
      }
    }
    const activePath = new Set<string>();
    let cur: string | null | undefined = activeBranchId;
    while (cur && !activePath.has(cur)) {
      activePath.add(cur);
      cur = records[cur]?.parentBranchId ?? null;
    }
    const forkGroupMap = new Map<string, string[]>();
    for (const rec of Object.values(records)) {
      if (!rec.parentBranchId) continue;
      const key = `${rec.parentBranchId}\x00${rec.forkAfterMessageId ?? 'ROOT'}\x00${rec.forkUserTurnIndex}`;
      const list = forkGroupMap.get(key) || [];
      list.push(rec.branchId);
      forkGroupMap.set(key, list);
    }
    const depthOf = (id: string): number => {
      let d = 0;
      const seen = new Set<string>([id]);
      let p = records[id]?.parentBranchId ?? null;
      while (p && !seen.has(p)) { seen.add(p); d++; p = records[p]?.parentBranchId ?? null; }
      return d;
    };
    const nodesById: Record<string, ConversationTreeNode> = {};
    for (const rec of Object.values(records)) {
      const sess = sessions.find((s) => s.sessionId === rec.branchId);
      const msgs = messagesBySession[rec.branchId] || [];
      const tele = teleSnap.activeSessions[rec.branchId];
      const nonSys = msgs.filter((m) => m.role !== 'system');
      const users = nonSys.filter((m) => m.role === 'user');
      const assistants = nonSys.filter((m) => m.role === 'assistant');
      const own = nonSys.filter((m) => !m.revisionHistory);
      let siblingIndex = 1;
      let siblingCount = 1;
      if (rec.parentBranchId) {
        const key = `${rec.parentBranchId}\x00${rec.forkAfterMessageId ?? 'ROOT'}\x00${rec.forkUserTurnIndex}`;
        const siblings = forkGroupMap.get(key) || [rec.branchId];
        siblingCount = siblings.length + 1;
        siblingIndex = Math.max(0, siblings.indexOf(rec.branchId)) + 2;
      } else {
        const rootTurn0 = forkGroupMap.get(`${rootId}\x00ROOT\x000`) || [];
        siblingCount = rootTurn0.length + 1;
      }
      const modelId = tele?.modelId || sess?.modelId || '';
      const maxContextTokens = tele?.maxContextTokens || resolveModelCompactionLimit(modelId);
      const usedContextTokens = tele?.usedContextTokens || 0;
      nodesById[rec.branchId] = {
        ...rec,
        forkPromptPreview: rec.forkPromptPreview || summarizeBranchSnippet(own.find((m) => m.role === 'user')?.content || users[0]?.content, 72),
        rootSessionId: rootId,
        childrenIds: childrenMap.get(rec.branchId) || [],
        depth: depthOf(rec.branchId),
        siblingIndex,
        siblingCount,
        isActiveBranch: rec.branchId === activeBranchId,
        isOnActivePath: activePath.has(rec.branchId),
        userTurnCount: users.length,
        ownMessageCount: own.length,
        latestUserPreview: summarizeBranchSnippet(users.at(-1)?.content, 72),
        latestAssistantPreview: summarizeBranchSnippet([...assistants].reverse().find((m) => m.content?.trim())?.content, 84),
        status: sess?.status || 'closed',
        modelId,
        usedContextTokens,
        maxContextTokens,
        usageRatio: tele?.usageRatio ?? Math.min(1, usedContextTokens / Math.max(1, maxContextTokens)),
        totalCostUsd: tele?.costSummary?.totalCostUsd || 0,
      };
    }
    const ordered: ConversationTreeNode[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id) || !nodesById[id]) return;
      visited.add(id);
      ordered.push(nodesById[id]);
      for (const cid of nodesById[id].childrenIds) visit(cid);
    };
    visit(rootId);
    for (const id of Object.keys(nodesById)) visit(id);
    return {
      rootSessionId: rootId,
      rootTitle,
      activeBranchId,
      totalBranches: ordered.length,
      nodes: ordered,
      nodesById,
      updatedAt: stored?.updatedAt || new Date().toISOString(),
    };
  }

  return {
    triggerDemoApproval,
    triggerDemoGuardianReview,

    // 首次渲染和桌面模式使用相同的启动数据结构。每次返回独立副本或新建快照。
    async getBootstrap(): Promise<AppBootstrapPayload> {
      return {
        preferences: structuredClone(preferences),
        connection: buildConnectionStatus(),
        accounts: structuredClone(accounts),
        approvalConfig: structuredClone(approvalConfig),
        translationConfig: structuredClone(translationConfig),
        sessions: getVisibleSessions(true),
        layout: { ...layout, openTabSessionIds: [...layout.openTabSessionIds] },
        pendingApprovals: pendingApprovals.map((p) => structuredClone(p)),
        telemetry: buildTelemetrySnapshot(),
        plugins: buildPluginsSnapshot(),
        updateState: structuredClone(updateState),
      };
    },

    async updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences> {
      if (patch.uiScale !== undefined && (typeof patch.uiScale !== 'number' || patch.uiScale < UI_SCALE_LIMITS.min || patch.uiScale > UI_SCALE_LIMITS.max)) throw new Error('界面缩放倍率无效');
      if (patch.translationEngine === 'external-api' && !isExternalTranslatorConnected(translationConfig.externalTranslator)) {
        throw new Error('请先在 G-Gravity 桌面版使用所选模型成功完成翻译测试。');
      }
      preferences = { ...preferences, ...patch, ...(patch.uiScale !== undefined ? { uiScale: clampUiScale(patch.uiScale) } : {}) };
      return structuredClone(preferences);
    },

    async setAppIcon(iconId: GravityIconPreference): Promise<ClientPreferences> {
      preferences = { ...preferences, appIcon: iconId };
      return structuredClone(preferences);
    },

    async importCustomTheme(jsonText: string): Promise<ClientPreferences> {
      const parsed = JSON.parse(jsonText) as unknown;
      const validated = validateCustomThemeConfig(parsed);
      preferences = {
        ...preferences,
        theme: 'custom',
        customTheme: validated,
      };
      return structuredClone(preferences);
    },

    async exportCustomTheme(): Promise<string> {
      const activeCustom = preferences.customTheme ?? {
        name: 'Gravity Custom Theme',
        polarity: 'dark' as const,
        baseThemeId: 'claude-code-dark' as const,
        tokens: { ...THEME_PRESETS[0].tokens },
      };
      return JSON.stringify(activeCustom, null, 2);
    },

    async selectDirectory(defaultPath?: string): Promise<string | null> {
      return defaultPath || preferences.defaultWorkspaceCwd || 'C:\\Workspace\\DemoProject';
    },

    async getConnectionStatus(): Promise<AcpConnectionStatus> {
      return { ...buildConnectionStatus(), ...connectionOverride };
    },

    async inspectLocalTargets(input: InspectLocalTargetsInput): Promise<InspectLocalTargetsResult> {
      return mockInspectLocalTargets(input);
    },

    emitDemoConnectionStatus(patch: Partial<AcpConnectionStatus>): AcpConnectionStatus {
      connectionOverride = { ...connectionOverride, ...patch };
      const status = { ...buildConnectionStatus(), ...connectionOverride };
      connectionEvents.emit(structuredClone(status));
      return status;
    },

    async getAccountsState(): Promise<AccountsStateSnapshot> {
      return structuredClone(accounts);
    },

    async createAccountProfile(
      input: CreateAccountProfileInput
    ): Promise<AccountsStateSnapshot> {
      const cleanName = input.name.trim();
      if (!cleanName) {
        throw new Error('Profile 名称不能为空');
      }
      const id = `profile-${Date.now()}`;
      const now = new Date().toISOString();
      accounts.profiles.push({
        profileId: id,
        name: cleanName,
        isDefault: false,
        isolatedAppDataDir: `gravity-userdata/profiles/${id}`,
        createdAt: now,
        lastActivatedAt: now,
      });
      const snap = structuredClone(accounts);
      accountEvents.emit(snap);
      return snap;
    },

    async deleteAccountProfile(profileId: string): Promise<AccountsStateSnapshot> {
      const target = accounts.profiles.find((p) => p.profileId === profileId);
      if (!target || target.isDefault) {
        throw new Error('默认官方 Profile 不可删除');
      }
      accounts.profiles = accounts.profiles.filter((p) => p.profileId !== profileId);
      if (accounts.activeProfileId === profileId) {
        accounts.activeProfileId = 'default';
        preferences.activeProfileId = 'default';
      }
      const snap = structuredClone(accounts);
      accountEvents.emit(snap);
      return snap;
    },

    async switchAccountProfile(profileId: string): Promise<AccountsStateSnapshot> {
      const target = accounts.profiles.find((p) => p.profileId === profileId);
      if (!target) {
        throw new Error('未找到指定的 Account Profile');
      }
      if (profileId === accounts.activeProfileId) return structuredClone(accounts);
      for (const session of sessions) if (session.profileId === accounts.activeProfileId) {
        session.status = 'closed';
      }
      pendingApprovals = [];
      layout = { ...layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null };
      accounts.activeProfileId = profileId;
      target.lastActivatedAt = new Date().toISOString();
      preferences.activeProfileId = profileId;
      const snap = structuredClone(accounts);
      accountEvents.emit(snap);
      return snap;
    },

    async launchOfficialLogin(
      profileId?: string
    ): Promise<{ launched: boolean; message: string }> {
      const pid = profileId || accounts.activeProfileId;
      return {
        launched: true,
        message:
          pid === 'default'
            ? '已通过官方 agy acp --login 唤起可见终端完成认证。'
            : `已为隔离 Profile (${pid}) 通过官方 agy acp --app-data-dir <dir> --login 唤起登录终端。`,
      };
    },

    async officialLogout(): Promise<{ loggedOut: boolean; message: string }> {
      return {
        loggedOut: true,
        message: '已通过官方 ACP auth/logout 请求安全登出当前会话身份。',
      };
    },

    async listSessions(includeHiddenPollution?: boolean): Promise<ManagedSessionSummary[]> {
      return getVisibleSessions(Boolean(includeHiddenPollution));
    },

    async createSession(input: CreateSessionInput): Promise<ManagedSessionSummary> {
      const normalizedCwd = normalizeWorkspacePath(input.cwd || 'C:\\Workspace\\DemoProject');
      const now = new Date().toISOString();
      const titleParts = (input.title?.trim() ?? '').split(/[｜|]/);
      const structured = {
        organizedTitle: 'General｜新建编码会话',
        categoryTag: titleParts.length === 2 && titleParts[0].trim() ? titleParts[0].trim() : 'General',
      };

      const created: ManagedSessionSummary = {
        sessionId: `sess-${Date.now()}`,
        cwd: normalizedCwd,
        rawCwd: input.cwd || normalizedCwd,
        title: input.title?.trim() || structured.organizedTitle,
        rawTitle: input.title?.trim() || structured.organizedTitle,
        categoryTag: structured.categoryTag,
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'idle',
        modelId: input.modelId || 'gemini-2.5-pro',
        availableModels: buildConnectionStatus().availableModels,
        executionMode: input.executionMode || 'default',
        reasoningEffort: input.reasoningEffort || 'high',
        originKind: 'acp-live',
        readOnly: false,
        profileId: accounts.activeProfileId,
        updatedAt: now,
      };

      sessions.unshift(created);
      messagesBySession[created.sessionId] = [];
      inspectorBySession[created.sessionId] = {
        sessionId: created.sessionId,
        diffs: [],
        todos: [],
        terminals: [],
      };
      sessionRawTokenCounts[created.sessionId] = {
        modelId: created.modelId,
        usedContextTokens: 6_200,
        maxContextTokens: 1_000_000,
        counts: {
          inputTokens: 5_800,
          cachedInputTokens: 0,
          outputTokens: 400,
          thinkingTokens: 0,
        },
      };

      sessionEvents.emit({ ...created });
      telemetryEvents.emit(buildTelemetrySnapshot());
      return { ...created };
    },

    async resumeSession(sessionId: string, cwd: string): Promise<ManagedSessionSummary> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) {
        return this.createSession({ cwd });
      }
      target.cwd = normalizeWorkspacePath(cwd || target.cwd);
      target.updatedAt = new Date().toISOString();
      if (target.status === 'closed') {
        target.status = 'idle';
      }
      sessionEvents.emit({ ...target });
      return { ...target };
    },

    async manageSession(id, action) {
      const rootId = resolveFallbackRootId(id);
      const branchIds = [...new Set([id, ...listFallbackBranchIds(rootId)])];
      const targets = branchIds
        .map((bid) => sessions.find((s) => s.sessionId === bid && s.profileId === accounts.activeProfileId))
        .filter((s): s is ManagedSessionSummary => Boolean(s));
      if (!targets.length) throw new Error('会话不存在');
      if (targets.some((t) => t.status === 'streaming' || t.status === 'waiting_approval')) throw new Error('请等回合结束');
      if (action !== 'restore') {
        for (const t of targets) {
          layout = withoutSession(layout, t.sessionId);
          t.status = 'closed';
        }
      }
      if (action === 'delete') {
        treesByRoot.delete(rootId);
        for (const bid of branchIds) {
          branchToRoot.delete(bid);
          const idx = sessions.findIndex((s) => s.sessionId === bid);
          if (idx >= 0) sessions.splice(idx, 1);
          delete messagesBySession[bid];
          delete inspectorBySession[bid];
          delete swarmBySession[bid];
        }
      } else {
        const stamp = new Date().toISOString();
        for (const t of targets) {
          t.archivedAt = action === 'archive' ? t.archivedAt || stamp : undefined;
        }
      }
      return {
        sessions: structuredClone(sessions.filter((s) => s.profileId === accounts.activeProfileId).map(applyFallbackTreeMetadata)),
        layout: structuredClone(layout),
      };
    },
    async answerQuestion() { throw new Error('这条提问已结束'); },
    async getAccountQuota(_manual?: boolean) { return { profileId: accounts.activeProfileId, unavailable: 'preview' }; },
    async closeSession(sessionId: string): Promise<void> {
      for (const req of pendingApprovals.filter(request => request.sessionId === sessionId)) {
        approvalResEvents.emit({ requestId: req.requestId, sessionId });
      }
      pendingApprovals = pendingApprovals.filter(request => request.sessionId !== sessionId);
      layout.openTabSessionIds = layout.openTabSessionIds.filter((id) => id !== sessionId);
      if (layout.activePrimarySessionId === sessionId) {
        layout.activePrimarySessionId = layout.openTabSessionIds[0] ?? null;
      }
      if (layout.splitSecondarySessionId === sessionId) {
        layout.splitSecondarySessionId = layout.openTabSessionIds[1] ?? null;
      }
    },

    async setSessionMode(
      sessionId: string,
      mode: AgentExecutionMode
    ): Promise<ManagedSessionSummary> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) throw new Error('会话不存在');
      // 与主进程 SessionMultiplexer 一致：演示回合流式进行中拒绝切换 Mode
      // （演示数据里的 waiting_approval 只是静态快照，并无真实挂起的回合）。
      if (target.status === 'streaming') throw new Error('请在活动会话空闲时修改 Mode');
      target.executionMode = mode;
      target.updatedAt = new Date().toISOString();
      sessionEvents.emit({ ...target });
      return { ...target };
    },

    async setSessionEffort(
      sessionId: string,
      effort: AgentReasoningEffort
    ): Promise<ManagedSessionSummary> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) throw new Error('会话不存在');
      target.reasoningEffort = effort;
      target.updatedAt = new Date().toISOString();
      sessionEvents.emit({ ...target });
      return { ...target };
    },

    async setSessionModel(
      sessionId: string,
      modelId: string
    ): Promise<ManagedSessionSummary> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) throw new Error('会话不存在');
      target.modelId = modelId;
      target.updatedAt = new Date().toISOString();
      if (sessionRawTokenCounts[sessionId]) {
        sessionRawTokenCounts[sessionId].modelId = modelId;
      }
      sessionEvents.emit({ ...target });
      telemetryEvents.emit(buildTelemetrySnapshot());
      return { ...target };
    },

    async getSessionMessagePage(sessionId, before) {
      return pageMessages((messagesBySession[sessionId] ?? []).map((m) => structuredClone(m)), before);
    },

    async getSessionPlanArtifact(input: GetSessionPlanArtifactInput): Promise<PlanArtifactSnapshot> {
      const owner = { profileId: input.profileId || 'default', sessionId: input.sessionId };
      const doc = planArtifactsBySession[input.sessionId];
      if (!doc) return { status: 'missing', owner, revision: 0 };
      const view = input.view ?? 'summary';
      if (input.knownRevision !== undefined && input.knownRevision === doc.revision) {
        return { status: 'unchanged', view, owner, revision: doc.revision, summaryRevision: doc.revision, contentRevision: doc.revision };
      }
      return {
        status: 'ready',
        view,
        owner,
        revision: doc.revision,
        summaryRevision: doc.revision,
        contentRevision: doc.revision,
        source: 'brain-artifact',
        filePath: 'implementation_plan.md',
        // summary 视图严禁携带正文；content 视图按需返回原文
        ...(view === 'content' ? { content: doc.content } : { outline: outlineFromMarkdown(doc.content) }),
        truncated: false,
        updatedAt: doc.updatedAt,
      };
    },

    async getSessionInspector(sessionId: string): Promise<SessionInspectorData> {
      const found = inspectorBySession[sessionId];
      if (found) return structuredClone(found);
      return { sessionId, diffs: [], todos: [], terminals: [] };
    },

    async listWorkspaceFiles(_cwd: string, query?: string): Promise<string[]> {
      const q = (query || '').trim().toLowerCase();
      if (!q) return [...sampleWorkspaceFiles];
      return sampleWorkspaceFiles.filter((f) => f.toLowerCase().includes(q));
    },

    // 演示回复在本地拼装，再通过与桌面端相同的事件通知会话窗格。此路径中的文字和用量均为样例数据。
    async reviseMessage(input) {
      const origin = sessions.find(s => s.sessionId === input.sessionId && s.profileId === accounts.activeProfileId);
      if (!origin || origin.status !== 'idle') throw new Error('请等当前回合结束后再编辑');
      const originMessages = messagesBySession[origin.sessionId] || [];
      const revision = prepareRevision(originMessages, input);
      const rootId = resolveFallbackRootId(origin.sessionId);
      const rootSession = sessions.find(s => s.sessionId === rootId) || origin;
      const forkUserTurnIndex = revision.prefix.filter(m => m.role === 'user').length;
      const lastPrefix = revision.prefix.at(-1);
      const forkAfterMessageId = lastPrefix ? (lastPrefix.originMessageId || lastPrefix.id) : null;
      let parentBranchId = origin.sessionId;
      if (!forkAfterMessageId) {
        parentBranchId = rootId;
      } else {
        for (const bid of listFallbackBranchIds(rootId)) {
          const list = messagesBySession[bid] || [];
          if (list.some(m => !m.revisionHistory && (m.originMessageId === forkAfterMessageId || m.id === forkAfterMessageId))) {
            parentBranchId = bid;
            break;
          }
        }
      }
      const branch = await this.createSession({
        cwd: origin.cwd,
        title: rootSession.title,
        modelId: origin.modelId,
        executionMode: origin.executionMode,
        reasoningEffort: origin.reasoningEffort,
      });
      for (const m of revision.prefix) {
        if (!m.originMessageId) m.originMessageId = m.id;
      }
      messagesBySession[branch.sessionId] = revision.prefix.map(m => ({
        ...structuredClone(m),
        originMessageId: m.originMessageId || m.id,
        id: crypto.randomUUID(),
        sessionId: branch.sessionId,
        revisionHistory: true,
        isStreaming: false,
      }));
      const now = new Date().toISOString();
      let tree = treesByRoot.get(rootId);
      if (!tree) {
        tree = {
          rootSessionId: rootId,
          activeBranchId: rootId,
          branches: {
            [rootId]: {
              branchId: rootId,
              parentBranchId: null,
              forkAfterMessageId: null,
              forkUserTurnIndex: -1,
              forkPromptPreview: summarizeBranchSnippet((messagesBySession[rootId] || []).find(m => m.role === 'user')?.content, 72),
              createdAt: rootSession.updatedAt || now,
              updatedAt: now,
            },
          },
          updatedAt: now,
        };
        treesByRoot.set(rootId, tree);
        branchToRoot.set(rootId, rootId);
      }
      tree.branches[branch.sessionId] = {
        branchId: branch.sessionId,
        parentBranchId,
        forkAfterMessageId,
        forkUserTurnIndex,
        forkPromptPreview: summarizeBranchSnippet(input.text, 72),
        createdAt: now,
        updatedAt: now,
      };
      tree.activeBranchId = branch.sessionId;
      tree.updatedAt = now;
      branchToRoot.set(branch.sessionId, rootId);

      // 让新分支在演示数据下也拥有独立的 Context 起始基线
      const originStat = sessionRawTokenCounts[origin.sessionId];
      if (originStat) {
        const prefixRatio = originMessages.length > 0 ? Math.max(0.2, revision.prefix.length / originMessages.length) : 0.3;
        sessionRawTokenCounts[branch.sessionId] = {
          modelId: originStat.modelId,
          usedContextTokens: Math.round(originStat.usedContextTokens * prefixRatio),
          maxContextTokens: originStat.maxContextTokens,
          counts: {
            inputTokens: Math.round(originStat.counts.inputTokens * prefixRatio),
            cachedInputTokens: Math.round(originStat.counts.cachedInputTokens * prefixRatio),
            outputTokens: Math.round(originStat.counts.outputTokens * prefixRatio),
            thinkingTokens: Math.round(originStat.counts.thinkingTokens * prefixRatio),
          },
        };
      }

      origin.status = 'closed';
      await this.sendPrompt({ sessionId: branch.sessionId, text: input.text, references: revision.references, attachments: revision.attachments, annotations: revision.annotations });
      const enrichedRoot = applyFallbackTreeMetadata(rootSession);
      const enrichedBranch = applyFallbackTreeMetadata(sessions.find(s => s.sessionId === branch.sessionId) || branch);
      sessionEvents.emit(enrichedRoot);
      sessionEvents.emit(enrichedBranch);
      treeEvents.emit(buildFallbackTreeState(rootId));
      return enrichedBranch;
    },
    async getConversationTree(sessionId: string): Promise<ConversationTreeState> {
      return buildFallbackTreeState(sessionId);
    },
    async switchConversationBranch(input: SwitchConversationBranchInput): Promise<SwitchConversationBranchResult> {
      const rootId = resolveFallbackRootId(input.sessionId);
      const branchIds = listFallbackBranchIds(rootId);
      if (!branchIds.includes(input.targetBranchId)) throw new Error('目标分支不属于当前会话树');
      const target = sessions.find(s => s.sessionId === input.targetBranchId);
      if (!target) throw new Error('目标分支不存在');
      const prev = sessions.find(s => branchIds.includes(s.sessionId) && s.sessionId !== input.targetBranchId && s.status !== 'closed');
      if (prev) prev.status = 'closed';
      target.status = 'idle';
      target.updatedAt = new Date().toISOString();
      const tree = treesByRoot.get(rootId);
      if (tree) {
        tree.activeBranchId = input.targetBranchId;
        tree.updatedAt = target.updatedAt;
      }
      const treeSet = new Set(branchIds);
      if (layout.openTabSessionIds.some(id => treeSet.has(id))) {
        const replaceId = (id: string | null) => (id && treeSet.has(id) ? input.targetBranchId : id);
        layout = {
          ...layout,
          openTabSessionIds: [...new Set(layout.openTabSessionIds.map(id => (treeSet.has(id) ? input.targetBranchId : id)))],
          activePrimarySessionId: replaceId(layout.activePrimarySessionId),
          splitSecondarySessionId: replaceId(layout.splitSecondarySessionId),
        };
      }
      const rootSession = sessions.find(s => s.sessionId === rootId);
      if (rootSession) sessionEvents.emit(applyFallbackTreeMetadata(rootSession));
      if (prev) sessionEvents.emit(applyFallbackTreeMetadata(prev));
      const enriched = applyFallbackTreeMetadata(target);
      sessionEvents.emit(enriched);
      const treeState = buildFallbackTreeState(rootId);
      const telemetry = buildTelemetrySnapshot();
      treeEvents.emit(treeState);
      telemetryEvents.emit(telemetry);
      const { messages, ...messagePosition } = await this.getSessionMessagePage(target.sessionId);
      return {
        session: enriched,
        previousBranchId: prev?.sessionId ?? null,
        messages, messagePosition,
        inspector: structuredClone(inspectorBySession[input.targetBranchId] ?? { sessionId: input.targetBranchId, diffs: [], todos: [], terminals: [] }),
        swarm: structuredClone(swarmBySession[input.targetBranchId] ?? emptySwarmState(input.targetBranchId)),
        tree: treeState,
        telemetry,
        layout: structuredClone(layout),
      };
    },
    async sendPrompt(input: SendPromptInput): Promise<void> {
      const target = sessions.find((s) => s.sessionId === input.sessionId);
      if (target?.readOnly) {
        throw new Error('只读历史会话不可直接写入，请点击「在 Gravity 中继续」创建新会话');
      }
      const now = new Date().toISOString();
      const userMsgId = `msg-u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const userMsg: ChatMessageItem = {
        id: userMsgId,
        originMessageId: userMsgId,
        sessionId: input.sessionId,
        role: 'user',
        content: input.text,
        annotations: input.annotations,
        references: input.references,
        attachments: input.attachments?.map((a, idx) => ({
          id: `att-${Date.now()}-${idx}`,
          name: a.name,
          mimeType: a.mimeType,
          dataUrl: a.dataBase64
            ? `data:${a.mimeType};base64,${a.dataBase64}`
            : a.uri,
          uri: a.uri,
          sizeBytes: a.sizeBytes,
        })),
        createdAt: now,
      };
      messagesBySession[input.sessionId] = [
        ...(messagesBySession[input.sessionId] ?? []),
        userMsg,
      ];
      messageEvents.emit({ sessionId: input.sessionId, message: structuredClone(userMsg) });

      if (target) {
        target.status = 'streaming';
        target.updatedAt = now;
        sessionEvents.emit({ ...target });
      }

      const replyMsgId = `msg-a-${Date.now() + 1}-${Math.random().toString(36).slice(2, 6)}`;
      const replyMsg: ChatMessageItem = {
        id: replyMsgId,
        originMessageId: replyMsgId,
        sessionId: input.sessionId,
        role: 'assistant',
        content: `已在 Mode=${target?.executionMode ?? 'default'} · Effort=${
          target?.reasoningEffort ?? 'high'
        } 下处理请求：「${input.text}」。`,
        thoughts: [
          {
            id: `th-${Date.now()}`,
            originalText: `Evaluate prompt "${input.text}" with references and verify workspace constraints.`,
            translatedZhText: `结合引用上下文分析指令「${input.text}」，验证工作区约束并生成响应。`,
            isStreaming: false,
            languageDetected: 'en',
            translationSource: 'local-stream-glossary',
          },
        ],
        createdAt: new Date().toISOString(),
      };

      messagesBySession[input.sessionId] = [
        ...(messagesBySession[input.sessionId] ?? []),
        replyMsg,
      ];
      messageEvents.emit({ sessionId: input.sessionId, message: structuredClone(replyMsg) });

      const rawStat = sessionRawTokenCounts[input.sessionId];
      if (rawStat) {
        const delta = Math.max(400, input.text.length * 16);
        rawStat.usedContextTokens += delta;
        rawStat.counts.inputTokens += Math.round(delta * 0.55);
        rawStat.counts.outputTokens += Math.round(delta * 0.3);
        rawStat.counts.thinkingTokens += Math.round(delta * 0.15);
        telemetryEvents.emit(buildTelemetrySnapshot());
      }

      if (target) {
        const hasPending = pendingApprovals.some((p) => p.sessionId === input.sessionId);
        target.status = hasPending ? 'waiting_approval' : 'idle';
        target.updatedAt = new Date().toISOString();
        sessionEvents.emit(applyFallbackTreeMetadata(target));
      }
      if (treesByRoot.has(resolveFallbackRootId(input.sessionId))) {
        treeEvents.emit(buildFallbackTreeState(input.sessionId));
      }
    },

    async cancelPrompt(sessionId: string): Promise<void> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (target && target.status === 'streaming') {
        target.status = 'idle';
        target.updatedAt = new Date().toISOString();
        sessionEvents.emit({ ...target });
      }
    },

    async compactSessionContext(sessionId: string): Promise<void> {
      const rawStat = sessionRawTokenCounts[sessionId];
      if (rawStat) {
        const beforeTokens = rawStat.usedContextTokens;
        const afterTokens = Math.max(8_000, Math.round(rawStat.usedContextTokens * 0.42));
        rawStat.usedContextTokens = afterTokens;
        demoCompactions[sessionId] = [
          ...(demoCompactions[sessionId] ?? []),
          {
            id: `cmp-${Date.now()}`,
            timestamp: new Date().toISOString(),
            trigger: 'manual',
            beforeTokens,
            afterTokens,
            savedTokens: Math.max(0, beforeTokens - afterTokens),
            maxContextTokens: rawStat.maxContextTokens,
          },
        ];
        telemetryEvents.emit(buildTelemetrySnapshot());
      }
    },

    async saveWorkspaceLayout(
      patch: Partial<WorkspaceLayoutState>
    ): Promise<WorkspaceLayoutState> {
      if (patch.activeInspectorTab !== undefined && !isRightInspectorTab(patch.activeInspectorTab)) throw new Error('未知的检视器页签');
      // 与主进程相同的栏宽与分屏比例边界，预览环境也能复现越界保存时的错误反馈。
      const within = (v: unknown, r: { min: number; max: number }) => typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max;
      if (patch.leftSidebarWidth !== undefined && !within(patch.leftSidebarWidth, LAYOUT_LIMITS.leftSidebarWidth)) throw new Error('Inspector 布局或栏宽无效');
      if (patch.rightInspectorWidth !== undefined && !within(patch.rightInspectorWidth, LAYOUT_LIMITS.rightInspectorWidth)) throw new Error('Inspector 布局或栏宽无效');
      if (patch.splitRatio !== undefined && !within(patch.splitRatio, LAYOUT_LIMITS.splitRatio)) throw new Error('分屏比例无效');
      if (patch.composerMinHeight !== undefined && !within(patch.composerMinHeight, LAYOUT_LIMITS.composerMinHeight)) throw new Error('输入框高度无效');
      if (patch.composerMinHeight !== undefined) patch = { ...patch, composerMinHeight: Math.round(patch.composerMinHeight) };
      layout = {
        ...layout,
        ...patch,
        openTabSessionIds: [...new Set(patch.openTabSessionIds ?? layout.openTabSessionIds)],
      };
      return { ...layout, openTabSessionIds: [...layout.openTabSessionIds] };
    },

    async renameSession(sessionId: string, newTitle: string): Promise<ManagedSessionSummary> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) throw new Error('未找到目标会话');
      const trimmed = newTitle.trim();
      if (trimmed) {
        target.title = trimmed;
        const parts = trimmed.split(/[｜|]/);
        if (parts.length === 2 && parts[0].trim()) {
          target.categoryTag = parts[0].trim();
        }
        target.updatedAt = new Date().toISOString();
        sessionEvents.emit({ ...target });
      }
      return { ...target };
    },

    async togglePinSession(sessionId: string): Promise<ManagedSessionSummary> {
      const target = sessions.find((s) => s.sessionId === sessionId);
      if (!target) throw new Error('未找到目标会话');
      target.pinned = !target.pinned;
      target.updatedAt = new Date().toISOString();
      sessionEvents.emit({ ...target });
      return { ...target };
    },

    async organizeTitles(): Promise<TitleOrganizeResult> {
      throw new Error('浏览器预览无法连接官方 Hydrogen (medium)，请在 G-Gravity 桌面版整理标题。原标题已保留。');
    },

    async setApprovalMode(mode: ApprovalMode): Promise<ApproveForMeConfig> {
      return this.updateApprovalConfig({ mode });
    },

    async updateApprovalConfig(patch: Partial<ApproveForMeConfig>): Promise<ApproveForMeConfig> {
      const nextExternal = {
        ...approvalConfig.externalReviewer,
        ...(patch.externalReviewer ?? {}),
        apiKey: patch.externalReviewer?.apiKey ?? (sameExternalService(approvalConfig.externalReviewer, patch.externalReviewer ?? {})
          ? approvalConfig.externalReviewer.apiKey : undefined),
      };
      const prior = approvalConfig.externalReviewer;
      const unchangedSettings = sameReviewerSettings(prior, nextExternal);
      const verified = unchangedSettings && isExternalReviewerConnected({ ...prior, enabled: true });
      if (patch.externalReviewer?.enabled && !verified) {
        throw new Error('请在 G-Gravity 桌面端用所选模型完成一次复核测试，再启用。');
      }
      nextExternal.verificationMethod = verified ? 'review-call' : undefined;
      nextExternal.lastVerifiedAt = verified ? prior.lastVerifiedAt : undefined;
      nextExternal.connectionStatus = verified ? 'connected' : unchangedSettings && prior.connectionStatus === 'failed' ? 'failed' : 'untested';
      nextExternal.enabled = Boolean(nextExternal.enabled && verified);
      const connected = isExternalReviewerConnected(nextExternal);
      const requestedMode = patch.mode ?? approvalConfig.mode;
      if (patch.mode === 'hybrid' && !connected) {
        throw new Error('尚未连接外部复核模型，无法开启「AI 代审」；请先前往「设置 → 审批 → 外部复核」完成连接，当前仅可启用「仅规则」或「人工审批」。');
      }
      const nextMode: ApprovalMode = requestedMode === 'hybrid' && !connected ? 'rules-only' : requestedMode;
      approvalConfig = {
        ...approvalConfig,
        ...patch,
        mode: nextMode,
        externalReviewer: nextExternal,
      };
      approvalConfigEvents.emit(structuredClone(approvalConfig));
      return structuredClone(approvalConfig);
    },

    async clearSessionApprovals(sessionId: string): Promise<ManagedSessionSummary> {
      const session = sessions.find(candidate => candidate.sessionId === sessionId && candidate.profileId === accounts.activeProfileId);
      if (!session) throw new Error('会话不存在');
      delete session.approvalModeOverride;
      delete session.hasApprovalGrants;
      sessionGrants.delete(sessionId);
      sessionEvents.emit({ ...session });
      return { ...session };
    },
    async listSessionApprovalGrants(sessionId: string): Promise<SessionApprovalGrantsSnapshot> {
      const session = sessions.find(candidate => candidate.sessionId === sessionId && candidate.profileId === accounts.activeProfileId);
      if (!session) throw new Error('会话不存在');
      return structuredClone(grantsFor(sessionId));
    },
    async revokeSessionApprovalGrant(input: RevokeSessionApprovalGrantInput): Promise<SessionApprovalGrantsSnapshot> {
      const session = sessions.find(candidate => candidate.sessionId === input.sessionId && candidate.profileId === accounts.activeProfileId);
      if (!session) throw new Error('会话不存在');
      const snap = grantsFor(input.sessionId);
      if (input.prefix !== undefined) snap.prefixes = snap.prefixes.filter((p) => p.prefix !== input.prefix);
      if (input.revokeDelegation) {
        snap.delegatedToGuardian = false;
        delete snap.delegatedAt;
        delete session.approvalModeOverride;
      }
      syncGrantFlag(input.sessionId);
      return structuredClone(snap);
    },
    async cancelStage2ApprovalReview(requestId: string): Promise<{ cancelled: boolean }> {
      return { cancelled: finishDemoReview(requestId, 'cancelled') };
    },
    async submitApprovalDecision(submission: ApprovalDecisionSubmission): Promise<ApprovalDecisionResult> {
      const req = pendingApprovals.find((item) => item.requestId === submission.requestId);
      if (!req || req.sessionId !== submission.sessionId) throw new Error('审批请求不存在或会话不匹配');
      if (submission.decision === 'allow_session_prefix' && (!req.commandPrefix || req.commandPrefix !== submission.allowedPrefix)) {
        throw new Error('此请求不支持安全的会话前缀放行');
      }
      const targetSession = sessions.find((s) => s.sessionId === submission.sessionId && s.profileId === accounts.activeProfileId);
      const delegatedMode = submission.decision === 'approve_for_me_ai'
        ? (isExternalReviewerConnected(approvalConfig.externalReviewer) ? 'hybrid' : 'rules-only') : undefined;
      pendingApprovals = pendingApprovals.filter(
        (item) => item.requestId !== submission.requestId
      );

      if (req) {
        const isReject = submission.decision === 'reject_with_feedback';
        auditEntries.unshift({
          id: `audit-${Date.now()}`,
          timestamp: new Date().toISOString(),
          sessionId: submission.sessionId,
          cwd: req.cwd,
          toolName: req.toolName,
          commandOrSummary: req.commandOrSummary,
          modeAtDecision: targetSession?.approvalModeOverride ?? approvalConfig.mode,
          verdict: isReject
            ? 'rejected_with_feedback'
            : submission.decision === 'approve_for_me_ai'
              ? 'ai_approved'
              : 'user_approved',
          decisionSource:
            submission.decision === 'allow_session_prefix'
              ? 'session-prefix'
              : submission.decision === 'approve_for_me_ai'
                ? 'local-rule'
                : 'user-inline',
          riskLevel: req.riskLevel,
          latencyMs: submission.decision === 'approve_for_me_ai' ? 0.7 : 10,
          reason: isReject
            ? `拒绝并反馈：${submission.feedbackText || '请调整执行策略'}`
            : submission.decision === 'allow_session_prefix'
              ? `允许并记忆本会话前缀：${submission.allowedPrefix || req.commandPrefix}`
              : submission.decision === 'approve_for_me_ai'
                ? '启用 Approve for me 并放行本次操作'
                : '单次批准执行 (1. Yes)',
          feedbackText: submission.feedbackText,
        });

        // 审批决定要同时体现在待审列表和消息中的工具卡上，依请求号定位消息，再依工具调用号更新状态。
        const sessionMsgs = messagesBySession[submission.sessionId] ?? [];
        for (const m of sessionMsgs) {
          if (m.pendingApprovalId === req.requestId) {
            m.pendingApprovalId = undefined;
            if (m.toolCalls) {
              for (const tc of m.toolCalls) {
                if (tc.toolCallId === req.toolCallId) {
                  tc.status = isReject ? 'rejected' : 'completed';
                  tc.exitCode = isReject ? 1 : 0;
                  tc.completedAt = new Date().toISOString();
                  tc.outputPreview = isReject
                    ? `Cancelled with user guidance: ${submission.feedbackText || ''}`
                    : '✓ Typecheck & renderer build succeeded (0 errors).';
                }
              }
            }
            messageEvents.emit({
              sessionId: submission.sessionId,
              message: structuredClone(m),
            });
          }
        }

        const insp = inspectorBySession[submission.sessionId];
        if (insp && !isReject) {
          insp.terminals.unshift({
            id: `term-${Date.now()}`,
            toolCallId: req.toolCallId,
            command: req.commandOrSummary,
            output: '✓ Typecheck & renderer build succeeded (0 errors).',
            status: 'completed',
            exitCode: 0,
            timestamp: new Date().toISOString(),
          });
          inspectorEvents.emit(structuredClone(insp));
        }
      }

      if (targetSession && (delegatedMode || submission.decision === 'allow_session_prefix')) {
        const snap = grantsFor(targetSession.sessionId);
        if (delegatedMode) {
          snap.delegatedToGuardian = true;
          snap.delegatedAt = new Date().toISOString();
        }
        const prefix = submission.allowedPrefix?.trim();
        if (submission.decision === 'allow_session_prefix' && prefix && !snap.prefixes.some((p) => p.prefix === prefix)) {
          snap.prefixes.push({ prefix, grantedAt: new Date().toISOString(), hitCount: 0 });
        }
      }
      if (targetSession) {
        if (delegatedMode) targetSession.approvalModeOverride = delegatedMode;
        if (delegatedMode || submission.decision === 'allow_session_prefix') targetSession.hasApprovalGrants = true;
        const stillWaiting = pendingApprovals.some(
          (item) => item.sessionId === submission.sessionId
        );
        targetSession.status = stillWaiting ? 'waiting_approval' : 'idle';
        targetSession.updatedAt = new Date().toISOString();
        sessionEvents.emit({ ...targetSession });
      }

      approvalResEvents.emit({
        requestId: submission.requestId,
        sessionId: submission.sessionId,
      });
      return { outcome: submission.decision === 'reject_with_feedback' ? 'rejected' : 'approved', delegatedMode };
    },

    async testExternalReviewerConnection() {
      return { ok: false, message: '请在 G-Gravity 桌面端测试所选模型的复核能力。' };
    },
    async listApprovalAudit(limit = 50): Promise<ApprovalAuditEntry[]> {
      return auditEntries.slice(0, limit).map((a) => ({ ...a }));
    },

    async discoverExternalReviewerModels(
      input: ExternalReviewerModelsDiscoveryInput
    ): Promise<ExternalReviewerModelsDiscoveryResult> {
      const now = new Date().toISOString();
      if (input.provider === 'gemini-api-key') {
        if (!hasReviewerConnectionSettings({ ...input, model: 'probe' })) throw new Error('请填写有效的服务地址与所需的 API Key');
        return {
          provider: input.provider,
          endpoint: input.endpoint,
          fetchedAt: now,
          models: [
            {
              id: 'gemini-4-argon',
              displayName: 'Gemini 4 Argon',
              outputTokenLimit: 65536,
              supportsThinking: true,
              supportedThinkingLevels: ['auto', 'low', 'medium', 'high'],
              defaultThinkingLevel: 'medium',
            },
            {
              id: 'gemini-3.8-flash',
              displayName: 'Gemini 3.8 Flash',
              outputTokenLimit: 65536,
              supportsThinking: true,
              supportedThinkingLevels: ['auto', 'low', 'medium', 'high'],
              defaultThinkingLevel: 'medium',
            },
            {
              id: 'gemini-3.5-flash-lite',
              displayName: 'Gemini 3.5 Flash-Lite',
              outputTokenLimit: 65536,
              supportsThinking: true,
              supportedThinkingLevels: ['auto', 'minimal', 'low', 'medium', 'high'],
              defaultThinkingLevel: 'minimal',
            },
            {
              id: 'gemini-2.5-flash-lite',
              displayName: 'Gemini 2.5 Flash-Lite',
              outputTokenLimit: 65536,
              supportsThinking: true,
              supportedThinkingLevels: ['auto', 'off', 'low', 'medium', 'high'],
              defaultThinkingLevel: 'off',
            },
          ],
        };
      }
      if (input.provider === 'openai-compatible') {
        if (!hasReviewerConnectionSettings({ ...input, model: 'probe' })) throw new Error('请填写有效的服务地址与所需的 API Key');
        return {
          provider: input.provider,
          endpoint: input.endpoint,
          fetchedAt: now,
          models: [
            {
              id: 'gpt-5-mini',
              displayName: 'gpt-5-mini',
              supportsThinking: true,
              supportedThinkingLevels: ['auto', 'minimal', 'low', 'medium', 'high'],
              defaultThinkingLevel: 'medium',
            },
            {
              id: 'o4-mini',
              displayName: 'o4-mini',
              supportsThinking: true,
              supportedThinkingLevels: ['auto', 'low', 'medium', 'high'],
              defaultThinkingLevel: 'medium',
            },
            {
              id: 'gpt-4o-mini',
              displayName: 'gpt-4o-mini',
              supportsThinking: false,
              supportedThinkingLevels: ['auto'],
            },
          ],
        };
      }
      return {
        provider: input.provider,
        endpoint: input.endpoint,
        fetchedAt: now,
        models: [
          {
            id: 'qwen3:8b',
            displayName: 'qwen3:8b',
            supportsThinking: true,
            supportedThinkingLevels: ['auto', 'off', 'low', 'medium', 'high'],
          },
          {
            id: 'qwen2.5-coder:7b',
            displayName: 'qwen2.5-coder:7b',
            supportsThinking: false,
            supportedThinkingLevels: ['auto'],
          },
        ],
      };
    },

    async getTranslationConfig(): Promise<TranslationConfig> {
      return structuredClone(translationConfig);
    },

    async updateTranslationConfig(patch: TranslationConfigPatch): Promise<TranslationConfig> {
      const patchExt = patch.externalTranslator;
      const mergedExternal: ExternalTranslatorConfig = patchExt
        ? {
            ...translationConfig.externalTranslator,
            ...patchExt,
            apiKey: patchExt.apiKey ?? (sameExternalService(translationConfig.externalTranslator, patchExt)
              ? translationConfig.externalTranslator.apiKey : undefined),
          }
        : { ...translationConfig.externalTranslator };
      if (typeof mergedExternal.endpoint === 'string') mergedExternal.endpoint = mergedExternal.endpoint.trim();
      if (typeof mergedExternal.model === 'string') mergedExternal.model = mergedExternal.model.trim();
      if (typeof mergedExternal.apiKey === 'string') {
        const trimmedKey = mergedExternal.apiKey.trim();
        if (trimmedKey) mergedExternal.apiKey = trimmedKey;
        else delete mergedExternal.apiKey;
      }
      mergedExternal.lastVerifiedAt = undefined;
      mergedExternal.verifiedBy = undefined;
      mergedExternal.connectionStatus = 'untested';
      mergedExternal.enabled = false;
      const connected = isExternalTranslatorConnected(mergedExternal);
      const requestedEngine: TranslationEngineMode = patch.engine ?? translationConfig.engine;
      if (patch.engine === 'external-api' && !connected) {
        throw new Error('尚未连接外部翻译模型，无法切换至「外部 API」；请先启用并配置有效的公开端点、模型与 API Key。');
      }
      const finalEngine: TranslationEngineMode =
        requestedEngine === 'external-api' && !connected ? 'local' : requestedEngine;
      translationConfig = {
        engine: finalEngine,
        externalTranslator: mergedExternal,
      };
      preferences.translationEngine = finalEngine;
      const snap = structuredClone(translationConfig);
      translationConfigEvents.emit(snap);
      return snap;
    },

    async discoverExternalTranslationModels(
      input: ExternalReviewerModelsDiscoveryInput
    ): Promise<ExternalReviewerModelsDiscoveryResult> {
      const effectiveInput: ExternalReviewerModelsDiscoveryInput =
        input.apiKey === undefined &&
        sameExternalService(translationConfig.externalTranslator, input) &&
        translationConfig.externalTranslator.apiKey
          ? { ...input, apiKey: translationConfig.externalTranslator.apiKey }
          : input;
      return this.discoverExternalReviewerModels(effectiveInput);
    },

    async testExternalTranslatorConnection(): Promise<ExternalTranslatorTestResult> {
      return { ok: false, latencyMs: 0, error: '请在 G-Gravity 桌面版使用所选模型进行翻译测试。' };
    },

    async getTelemetryDashboard(): Promise<TelemetryDashboardSnapshot> {
      return buildTelemetrySnapshot();
    },

    async updateModelRateCards(nextCards: ModelRateCard[]): Promise<TelemetryDashboardSnapshot> {
      rateCards = nextCards.map((c) => ({ ...c }));
      customRatesEdited = true;
      const snap = buildTelemetrySnapshot();
      telemetryEvents.emit(snap);
      return snap;
    },

    async getPluginsSnapshot(): Promise<PluginsManagerSnapshot> {
      return buildPluginsSnapshot();
    },

    async runPluginAction(input: PluginActionInput): Promise<PluginsManagerSnapshot> {
      if (!isSafePluginTarget(input.target)) {
        throw new Error('非法的插件目标标识（严禁包含空格或以 - 开头）');
      }
      const target = input.target.trim();
      if (input.action === 'install') {
        if (!installedPlugins.some((p) => p.name === target)) {
          installedPlugins.push({
            name: target,
            version: '1.0.0',
            enabled: true,
            description: `Installed via agy plugin install ${target}`,
          });
        }
      } else if (input.action === 'uninstall') {
        installedPlugins = installedPlugins.filter((p) => p.name !== target);
      } else if (input.action === 'enable' || input.action === 'disable') {
        installedPlugins = installedPlugins.map((p) =>
          p.name === target ? { ...p, enabled: input.action === 'enable' } : p
        );
      }
      lastPluginCliOutput = `agy plugin ${input.action} ${target} -> exit 0`;
      return buildPluginsSnapshot();
    },

    async runMcpAction(input: McpActionInput): Promise<PluginsManagerSnapshot> {
      if (!isSafeMcpServerName(input.name)) {
        throw new Error('非法的 MCP Server 名称（严禁以 - 开头或包含特殊字符）');
      }
      const name = input.name.trim();
      if (input.action === 'add') {
        const cmd = (input.commandOrUrl || '').trim();
        if (!cmd) throw new Error('MCP 命令或 URL 不能为空');
        mcpServers = [
          ...mcpServers.filter((m) => m.name !== name),
          {
            name,
            type: input.type ?? (cmd.startsWith('http') ? 'http' : 'stdio'),
            commandOrUrl: cmd,
            args: input.args ?? [],
            enabled: true,
            status: 'configured',
          },
        ];
      } else if (input.action === 'remove') {
        mcpServers = mcpServers.filter((m) => m.name !== name);
      } else {
        mcpServers = mcpServers.map((m) =>
          m.name === name ? { ...m, enabled: input.action === 'enable' } : m
        );
      }
      lastPluginCliOutput = `agy mcp ${input.action} ${name} -> exit 0`;
      return buildPluginsSnapshot();
    },

    async toggleSkillEnabled(
      skillId: string,
      enabled: boolean
    ): Promise<PluginsManagerSnapshot> {
      discoveredSkills = discoveredSkills.map((s) =>
        s.id === skillId ? { ...s, enabled } : s
      );
      return buildPluginsSnapshot();
    },

    async getSwarmState(sessionId: string): Promise<SwarmTopologyState> {
      return structuredClone(
        swarmBySession[sessionId] ?? emptySwarmState(sessionId)
      );
    },



    async openLinkOrFileTarget(input: OpenLinkOrFileInput): Promise<OpenLinkOrFileResult> {
      if (typeof window !== 'undefined' && /^(?:https?|mailto):/i.test(input.target)) {
        window.open(input.target, '_blank', 'noopener,noreferrer');
      }
      return {
        opened: true,
        modeUsed: input.action,
        resolvedTarget: input.target,
      };
    },

    async copyText(text: string): Promise<void> {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text).catch(() => {});
      }
    },

    async checkForUpdates(): Promise<AppUpdateState> {
      updateState = {
        ...updateState,
        status: 'up-to-date',
        latestVersion: APP_BRAND.version,
        releaseTag: `v${APP_BRAND.version}`,
        releaseUrl: `${APP_BRAND.repoUrl}/releases/latest`,
        checkedAt: new Date().toISOString(),
        errorMessage: undefined,
      };
      updateEvents.emit(structuredClone(updateState));
      return structuredClone(updateState);
    },

    async downloadUpdate(): Promise<AppUpdateState> {
      return structuredClone(updateState);
    },

    async installUpdate(): Promise<{ launched: boolean; message: string }> {
      return { launched: false, message: '演示模式下不支持安装更新包。' };
    },

    onSessionUpdated: sessionEvents.subscribe,
    onMessageUpserted: messageEvents.subscribe,
    onInspectorUpdated: inspectorEvents.subscribe,
    onPlanArtifactChanged: planArtifactEvents.subscribe,
    ...createFallbackVoice(),
    onApprovalRequested: approvalReqEvents.subscribe,
    onApprovalConfigUpdated: approvalConfigEvents.subscribe,
    onApprovalResolved: approvalResEvents.subscribe,
    onApprovalReviewing: approvalReviewingEvents.subscribe,
    onApprovalGuardActivity: approvalGuardEvents.subscribe,
    onTelemetryUpdated: telemetryEvents.subscribe,
    onSwarmUpdated: swarmEvents.subscribe,
    onAccountUpdated: accountEvents.subscribe,
    onUpdateState: updateEvents.subscribe,
    onTreeUpdated: treeEvents.subscribe,
    onTranslationConfigUpdated: translationConfigEvents.subscribe,
    onConnectionUpdated: connectionEvents.subscribe,
    onUiScaleCommand: uiScaleEvents.subscribe,
  };
}

let sharedFallbackInstance: FallbackDesktopBridge | null = null;

/** 浏览器预览的组件共用一个实例，否则页面读取的列表和注册的监听器会落入不同的演示会话。 */
export function getFallbackDesktopBridge(): FallbackDesktopBridge {
  if (!sharedFallbackInstance) {
    sharedFallbackInstance = createFallbackDesktopBridge();
  }
  return sharedFallbackInstance;
}

/** 仅返回已由测试/夹具/dev 预览显式创建的共享实例，不会自行创建演示数据。 */
export function peekFallbackDesktopBridge(): FallbackDesktopBridge | null {
  return sharedFallbackInstance;
}

export function resetFallbackDesktopBridge(): FallbackDesktopBridge {
  sharedFallbackInstance = createFallbackDesktopBridge();
  return sharedFallbackInstance;
}

/* ---------------------------------------------------------------------------
 * 演示语音听写（9 invoke + 3 event）：纯内存状态机，绝不访问麦克风或网络，生产包整体剔除。
 * ------------------------------------------------------------------------- */
function createFallbackVoice(): Pick<
  GravityDesktopBridge,
  | 'getVoiceState' | 'updateVoiceConfig' | 'discoverVoiceModels' | 'testVoiceConnection' | 'installVoiceModel'
  | 'voiceArmCapture' | 'voiceAppend' | 'voiceFinish' | 'voiceAbort'
  | 'onVoiceSegment' | 'onVoiceSettled' | 'onVoiceCaptureRevoked'
> {
  const segmentEvents = createEventChannel<VoiceSegmentEvent>();
  const settledEvents = createEventChannel<VoiceSettledEvent>();
  const revokedEvents = createEventChannel<VoiceCaptureRevokedEvent>();
  let config: VoiceConfig = structuredClone(DEFAULT_VOICE_CONFIG);
  const model: VoiceModelState = {
    status: 'ready',
    modelId: VOICE_LOCAL_MODEL_SPEC.id,
    fileName: VOICE_LOCAL_MODEL_SPEC.fileName,
    source: 'bundled',
    expectedBytes: VOICE_LOCAL_MODEL_SPEC.sizeBytes,
    sha256Verified: true,
  };
  const captures = new Map<string, { owner: VoiceOwner; purpose: VoiceCapturePurpose; bytes: number; seq: number; state: string }>();
  let n = 0;
  const snapshot = (): VoiceStateSnapshot => ({
    config: structuredClone(config),
    model: { ...model },
    external: { ready: isExternalVoiceConnected(config.externalProvider), encryptionAvailable: true },
    activeCapture: null,
    heldCapture: null,
    updatedAt: new Date().toISOString(),
  });
  return {
    async getVoiceState() {
      return snapshot();
    },
    async updateVoiceConfig(patch: VoiceConfigPatch) {
      const { apiKey, ratePerMinuteUsd, ...ext } = patch.externalProvider ?? {};
      const nextRate =
        ratePerMinuteUsd === null
          ? undefined
          : ratePerMinuteUsd !== undefined
            ? ratePerMinuteUsd
            : config.externalProvider.ratePerMinuteUsd;
      config = {
        ...config,
        ...(patch.engine ? { engine: patch.engine } : {}),
        ...(patch.locale ? { locale: patch.locale } : {}),
        ...(patch.preferredDeviceId !== undefined ? { preferredDeviceId: patch.preferredDeviceId ?? undefined } : {}),
        ...(patch.preferredDeviceLabel !== undefined ? { preferredDeviceLabel: patch.preferredDeviceLabel ?? undefined } : {}),
        externalProvider: {
          ...config.externalProvider,
          ...ext,
          ratePerMinuteUsd: nextRate,
          ...(apiKey ? { hasApiKey: true } : {}),
        },
      };
      return snapshot();
    },
    async discoverVoiceModels(input: VoiceDiscoverModelsInput) {
      return { provider: input.provider, endpoint: input.endpoint, models: [{ id: input.provider === 'gemini-api-key' ? 'gemini-2.5-flash' : 'gpt-4o-mini-transcribe', displayName: input.provider === 'gemini-api-key' ? 'gemini-2.5-flash' : 'gpt-4o-mini-transcribe', supportsThinking: false, supportedThinkingLevels: [] }], fetchedAt: new Date().toISOString() };
    },
    async testVoiceConnection() {
      return { ok: false, latencyMs: 0, error: '演示模式不连接外部服务' };
    },
    async installVoiceModel() {
      return { started: false, state: { ...model }, message: 'bundled' };
    },
    async voiceArmCapture(input: VoiceArmCaptureInput) {
      if (isVoiceCaptureControlRequest(input)) {
        const cap = captures.get(input.captureId);
        if (!cap) throw new Error('capture not found');
        cap.state = input.op === 'media-ready' ? 'capturing' : 'released';
        return { captureId: input.captureId, owner: cap.owner, epoch: 0, purpose: cap.purpose, engine: config.engine, sampleRate: VOICE_SAMPLE_RATE, maxDurationMs: VOICE_MAX_DURATION_MS, maxPcmBytes: VOICE_MAX_PCM_BYTES, state: input.op === 'media-ready' ? 'capturing' : 'released' };
      }
      if (config.engine === 'off') throw new Error('语音听写已关闭');
      const captureId = `cap-${++n}`;
      const purpose = input.purpose ?? 'dictation';
      captures.set(captureId, { owner: input.owner, purpose, bytes: 0, seq: 0, state: 'armed' });
      return { captureId, owner: input.owner, epoch: 0, purpose, engine: config.engine, sampleRate: VOICE_SAMPLE_RATE, maxDurationMs: purpose === 'mic-test' ? VOICE_MIC_TEST_MAX_DURATION_MS : VOICE_MAX_DURATION_MS, maxPcmBytes: purpose === 'mic-test' ? VOICE_MIC_TEST_MAX_BYTES : VOICE_MAX_PCM_BYTES, state: 'armed' };
    },
    async voiceAppend(input: VoiceAppendInput) {
      const cap = captures.get(input.captureId);
      const bytes = input.pcm16.byteLength;
      if (!cap || input.seq !== cap.seq + 1) return { captureId: input.captureId, accepted: false, seq: input.seq, expectedSeq: (cap?.seq ?? 0) + 1, acceptedBytes: cap?.bytes ?? 0, remainingBytes: 0, reason: 'sequence' };
      cap.seq = input.seq;
      cap.bytes += bytes;
      return { captureId: input.captureId, accepted: true, seq: input.seq, acceptedBytes: cap.bytes, remainingBytes: Math.max(0, VOICE_MAX_PCM_BYTES - cap.bytes) };
    },
    async voiceFinish(input: VoiceFinishInput) {
      const cap = captures.get(input.captureId);
      if (!cap) return { captureId: input.captureId, status: 'already-settled', acceptedSeq: 0, acceptedBytes: 0 };
      captures.delete(input.captureId);
      const text = cap.bytes > 0 ? '演示听写文本' : '';
      const durationMs = Math.round((cap.bytes / 2 / VOICE_SAMPLE_RATE) * 1000);
      setTimeout(() => {
        if (text) segmentEvents.emit({ owner: cap.owner, epoch: 0, captureId: input.captureId, seq: 1, text, isFinal: true });
        settledEvents.emit({ owner: cap.owner, epoch: 0, captureId: input.captureId, finalSeq: text ? 1 : 0, text, durationMs, engine: config.engine === 'external-api' ? 'external-api' : 'local', outcome: 'completed' });
      }, 0);
      return { captureId: input.captureId, status: 'finishing', acceptedSeq: cap.seq, acceptedBytes: cap.bytes };
    },
    async voiceAbort(input: VoiceAbortInput) {
      return { captureId: input.captureId, aborted: captures.delete(input.captureId) };
    },
    onVoiceSegment: segmentEvents.subscribe,
    onVoiceSettled: settledEvents.subscribe,
    onVoiceCaptureRevoked: revokedEvents.subscribe,
  };
}

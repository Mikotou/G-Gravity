import {
  isRightInspectorTab,
  LAYOUT_LIMITS,
  TITLE_ORGANIZE_MODEL_LABEL,
  TITLE_ORGANIZE_RATE_LIMIT,
  withoutSession,
} from '../../shared/session-contract';
import { APP_BRAND, clampUiScale, UI_SCALE_LIMITS } from '../../shared/theme-i18n-contract';
import { prepareRevision } from '../../shared/message-revision';
import {
  calculateTokenCost,
  computeUnifiedLineDiff,
  DEFAULT_MODEL_RATE_CARDS,
  generateStructuredChineseTitle,
  getCanonicalToolName,
  GRAVITY_BUILTIN_CAPABILITIES,
  isLegacyPollutionSessionTitle,
  isSafeMcpServerName,
  isSafePluginTarget,
  MAX_PARALLEL_ACTIVE_SESSIONS,
  normalizeWorkspacePath,
  resolveModelRateCard,
  THEME_PRESETS,
  validateCustomThemeConfig,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type AppBootstrapPayload,
  type AppUpdateState,
  type ApprovalAuditEntry,
  type ApprovalDecisionSubmission,
  type ApprovalMode,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientPreferences,
  type ConfiguredMcpServerItem,
  type ContextCompactionRecord,
  type ContinueHistoryInGravityInput,
  type CreateAccountProfileInput,
  type CreateSessionInput,
  type DailyCalendarHeatmapCell,
  type DayHourHeatmapCell,
  type DiscoveredSkillItem,
  type GravityDesktopBridge,
  type GravityIconId,
  type HourlyTokenBarBucket,
  type ImportedHistoryDetail,
  type ImportedHistorySessionRecord,
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
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
  type TitleOrganizeRequest,
  type TitleOrganizeResult,
  type TitleOrganizeSuggestion,
  type TokenCostSummary,
  type WorkspaceLayoutState,
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
}

/** 创建独立的演示环境。模拟账号、会话和统计都保存在这次调用的闭包中，测试可创建新实例以隔离状态。 */
export function createFallbackDesktopBridge(): FallbackDesktopBridge {
  const sessionEvents = createEventChannel<ManagedSessionSummary>();
  const messageEvents = createEventChannel<{ sessionId: string; message: ChatMessageItem }>();
  const inspectorEvents = createEventChannel<SessionInspectorData>();
  const approvalReqEvents = createEventChannel<PendingApprovalRequest>();
  const approvalResEvents = createEventChannel<{ requestId: string; sessionId: string }>();
  const telemetryEvents = createEventChannel<TelemetryDashboardSnapshot>();
  const swarmEvents = createEventChannel<SwarmTopologyState>();
  const historyEvents = createEventChannel<ImportedHistorySessionRecord[]>();
  const accountEvents = createEventChannel<AccountsStateSnapshot>();
  const updateEvents = createEventChannel<AppUpdateState>();

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
    mode: 'hybrid',
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
      timeoutMs: 2500,
    },
  };

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
      cwd: normalizeWorkspacePath('F:\\插件-Gemini'),
      rawCwd: 'F:\\插件-Gemini',
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
      cwd: normalizeWorkspacePath('F:\\插件-Gemini'),
      rawCwd: 'F:\\插件-Gemini',
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
      cwd: normalizeWorkspacePath('F:\\插件-Gemini'),
      rawCwd: 'F:\\插件-Gemini',
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

  const importedHistory: ImportedHistorySessionRecord[] = [
    {
      sessionId: 'ag-history:conv-desktop-001',
      rawConversationId: 'conv-desktop-001',
      origin: 'antigravity-desktop',
      title: '历史架构讨论：ACP JSON-RPC 2.0 握手与能力协商验证',
      cwd: 'F:\\插件-Gemini',
      updatedAt: '2026-11-16T18:30:00.000Z',
      messageCount: 4,
      summarySnippet: '梳理了 initialize 握手参数、session/new 多路复用及本地安全边界设计要点。',
      sourcePath: 'antigravity/brain/conv-desktop-001/.system_generated/logs/transcript.jsonl',
      readOnly: true,
    },
    {
      sessionId: 'ag-history:conv-cli-002',
      rawConversationId: 'conv-cli-002',
      origin: 'antigravity-cli',
      title: 'CLI 历史记录：排查 Windows 路径解码与单元测试速率',
      cwd: 'D:\\Projects\\CoreGateway',
      updatedAt: '2026-11-15T14:15:00.000Z',
      messageCount: 2,
      summarySnippet: '验证了 normalizeWorkspacePath 对编码盘符的转换结果与零写入测试。',
      sourcePath: 'antigravity-cli/history/conv-cli-002.jsonl',
      readOnly: true,
    },
  ];

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
      cwd: 'F:\\插件-Gemini',
      createdAt: '2026-11-17T07:57:50.000Z',
      riskLevel: 'low',
      commandPrefix: 'npm run typecheck:renderer',
      explanation: {
        meaning: '运行前端 TypeScript 类型检查并构建 Gravity 渲染层静态资源。',
        target: '工作区 F:\\插件-Gemini 下的 src/renderer 与 dist/renderer。',
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
          content: '重构 Gravity 三栏可拖拽布局与快捷键 (Ctrl+B / Ctrl+J / Ctrl+\\)',
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
      cwd: 'F:\\插件-Gemini',
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
            : 0,
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

    return {
      activeSessions,
      hourly24h,
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
      .map((s) => ({ ...s }));
  }

  const organizeTimestamps: number[] = [];

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

  return {
    triggerDemoApproval,

    // 首次渲染和桌面模式使用相同的启动数据结构。每次返回独立副本或新建快照。
    async getBootstrap(): Promise<AppBootstrapPayload> {
      return {
        preferences: structuredClone(preferences),
        connection: buildConnectionStatus(),
        accounts: structuredClone(accounts),
        approvalConfig: structuredClone(approvalConfig),
        sessions: getVisibleSessions(!layout.hideLegacyPollutionSessions),
        importedHistory: importedHistory.map((h) => ({ ...h })),
        layout: { ...layout, openTabSessionIds: [...layout.openTabSessionIds] },
        pendingApprovals: pendingApprovals.map((p) => structuredClone(p)),
        telemetry: buildTelemetrySnapshot(),
        plugins: buildPluginsSnapshot(),
        updateState: structuredClone(updateState),
      };
    },

    async updatePreferences(patch: Partial<ClientPreferences>): Promise<ClientPreferences> {
      if (patch.uiScale !== undefined && (typeof patch.uiScale !== 'number' || patch.uiScale < UI_SCALE_LIMITS.min || patch.uiScale > UI_SCALE_LIMITS.max)) throw new Error('界面缩放倍率无效');
      preferences = { ...preferences, ...patch, ...(patch.uiScale !== undefined ? { uiScale: clampUiScale(patch.uiScale) } : {}) };
      return structuredClone(preferences);
    },

    async setAppIcon(iconId: GravityIconId): Promise<ClientPreferences> {
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
      return defaultPath || preferences.defaultWorkspaceCwd || 'F:\\插件-Gemini';
    },

    async getConnectionStatus(): Promise<AcpConnectionStatus> {
      return buildConnectionStatus();
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
      for (const session of sessions) if (session.profileId === accounts.activeProfileId) session.status = 'closed';
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
      const normalizedCwd = normalizeWorkspacePath(input.cwd || 'F:\\插件-Gemini');
      const now = new Date().toISOString();
      const structured = input.title?.trim()
        ? generateStructuredChineseTitle(input.title.trim(), normalizedCwd)
        : { organizedTitle: 'General｜新建编码会话', categoryTag: 'General' };

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
      const index = sessions.findIndex(s => s.sessionId === id && s.profileId === accounts.activeProfileId);
      if (index < 0) throw new Error('会话不存在');
      const target = sessions[index];
      if (target.status === 'streaming' || target.status === 'waiting_approval') throw new Error('请等回合结束');
      if (action !== 'restore') { layout = withoutSession(layout, id); target.status = 'closed'; }
      if (action === 'delete') {
        sessions.splice(index, 1);
        delete messagesBySession[id]; delete inspectorBySession[id]; delete swarmBySession[id];
      } else { target.archivedAt = action === 'archive' ? new Date().toISOString() : undefined; }
      return { sessions: structuredClone(sessions.filter(s => s.profileId === accounts.activeProfileId)), layout: structuredClone(layout) };
    },
    async answerQuestion() { throw new Error('这条提问已结束'); },
    async getAccountQuota() { throw new Error('请在 Gravity 桌面端查看官方账户额度。'); },
    async closeSession(sessionId: string): Promise<void> {
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

    async getSessionMessages(sessionId: string): Promise<ChatMessageItem[]> {
      return (messagesBySession[sessionId] ?? []).map((m) => structuredClone(m));
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
      const revision = prepareRevision(messagesBySession[origin.sessionId] || [], input);
      const branch = await this.createSession({ cwd: origin.cwd, title: origin.title + ' · 修订', modelId: origin.modelId,
        executionMode: origin.executionMode, reasoningEffort: origin.reasoningEffort });
      messagesBySession[branch.sessionId] = revision.prefix.map(m => ({ ...structuredClone(m),
        id: crypto.randomUUID(), sessionId: branch.sessionId, revisionHistory: true, isStreaming: false }));
      await this.closeSession(origin.sessionId);
      await this.sendPrompt({ sessionId: branch.sessionId, text: input.text, references: revision.references, attachments: revision.attachments, annotations: revision.annotations });
      return branch;
    },
    async sendPrompt(input: SendPromptInput): Promise<void> {
      const target = sessions.find((s) => s.sessionId === input.sessionId);
      if (target?.readOnly) {
        throw new Error('只读历史会话不可直接写入，请点击「在 Gravity 中继续」创建新会话');
      }
      const now = new Date().toISOString();
      const userMsg: ChatMessageItem = {
        id: `msg-u-${Date.now()}`,
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

      const replyMsg: ChatMessageItem = {
        id: `msg-a-${Date.now() + 1}`,
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
        sessionEvents.emit({ ...target });
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

    async organizeTitles(request?: TitleOrganizeRequest): Promise<TitleOrganizeResult> {
      const now = Date.now();
      const cutoff = now - TITLE_ORGANIZE_RATE_LIMIT.windowMs;
      while (organizeTimestamps.length > 0 && organizeTimestamps[0] <= cutoff) {
        organizeTimestamps.shift();
      }
      if (organizeTimestamps.length >= TITLE_ORGANIZE_RATE_LIMIT.maxCalls) {
        const waitSec = Math.max(1, Math.ceil((organizeTimestamps[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs - now) / 1000));
        throw new Error(`标题整理触发冷却限制：1 分钟内最多整理 ${TITLE_ORGANIZE_RATE_LIMIT.maxCalls} 次，请 ${waitSec} 秒后再试`);
      }

      const scope =
        request?.scope ??
        (request?.projectCwd ? 'project' : request?.sessionIds?.length === 1 ? 'session' : request?.sessionIds?.length ? 'project' : 'all');
      const targetIds = request?.sessionIds?.length ? new Set(request.sessionIds) : null;
      const projectKey = request?.projectCwd ? normalizeWorkspacePath(request.projectCwd).toLowerCase() : null;
      const suggestions: TitleOrganizeSuggestion[] = [];
      let hiddenPollutionCount = 0;
      let skippedOrganizedCount = 0;
      const candidates: ManagedSessionSummary[] = [];

      for (const s of sessions) {
        if (s.isLegacyApprovalPollution || isLegacyPollutionSessionTitle(s.rawTitle || s.title)) {
          s.isLegacyApprovalPollution = true;
          hiddenPollutionCount += 1;
          continue;
        }
        if (s.archivedAt) continue;
        if (targetIds && !targetIds.has(s.sessionId)) continue;
        if (projectKey && normalizeWorkspacePath(s.cwd || s.rawCwd || '').toLowerCase() !== projectKey) continue;
        if (scope === 'all' && s.titleOrganizedAt) {
          skippedOrganizedCount += 1;
          continue;
        }
        candidates.push(s);
      }

      if (candidates.length === 0) {
        return {
          updatedCount: 0,
          hiddenPollutionCount,
          skippedOrganizedCount,
          modelUsed: TITLE_ORGANIZE_MODEL_LABEL,
          remainingQuotaInWindow: Math.max(0, TITLE_ORGANIZE_RATE_LIMIT.maxCalls - organizeTimestamps.length),
          cooldownResetAt: organizeTimestamps[0]
            ? new Date(organizeTimestamps[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs).toISOString()
            : undefined,
          suggestions: [],
        };
      }

      organizeTimestamps.push(now);
      const nowIso = new Date(now).toISOString();
      for (const s of candidates) {
        const { organizedTitle, categoryTag } = generateStructuredChineseTitle(s.title, s.cwd);
        s.titleOrganizedAt = nowIso;
        s.titleOrganizedModel = TITLE_ORGANIZE_MODEL_LABEL;
        if (organizedTitle !== s.title || s.categoryTag !== categoryTag) {
          suggestions.push({
            sessionId: s.sessionId,
            previousTitle: s.title,
            organizedTitle,
            categoryTag,
          });
          s.title = organizedTitle;
          s.categoryTag = categoryTag;
          s.updatedAt = nowIso;
        }
        sessionEvents.emit({ ...s });
      }

      return {
        updatedCount: suggestions.length,
        hiddenPollutionCount,
        skippedOrganizedCount,
        modelUsed: TITLE_ORGANIZE_MODEL_LABEL,
        remainingQuotaInWindow: Math.max(0, TITLE_ORGANIZE_RATE_LIMIT.maxCalls - organizeTimestamps.length),
        cooldownResetAt: organizeTimestamps[0]
          ? new Date(organizeTimestamps[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs).toISOString()
          : undefined,
        suggestions,
      };
    },

    async listImportedHistory(): Promise<ImportedHistorySessionRecord[]> {
      return importedHistory.map((h) => ({ ...h }));
    },

    async getImportedHistoryDetail(
      importedSessionId: string
    ): Promise<ImportedHistoryDetail> {
      const rec = importedHistory.find((h) => h.sessionId === importedSessionId);
      if (!rec) throw new Error('未找到对应的只读历史会话');
      return {
        ...rec,
        messages: [
          {
            id: `${rec.sessionId}-m1`,
            sessionId: rec.sessionId,
            role: 'user',
            content: `历史提问（${rec.origin}）：${rec.title}`,
            createdAt: rec.updatedAt,
          },
          {
            id: `${rec.sessionId}-m2`,
            sessionId: rec.sessionId,
            role: 'assistant',
            content: `${rec.summarySnippet}\n\n（此会话以纯只读模式从本地日志解析，点击上方「在 Gravity 中继续」可新建标准 ACP 实时会话续聊。）`,
            createdAt: rec.updatedAt,
          },
        ],
      };
    },

    async continueHistoryInGravity(
      input: ContinueHistoryInGravityInput
    ): Promise<ManagedSessionSummary> {
      const rec = importedHistory.find((h) => h.sessionId === input.importedSessionId);
      const cwd = normalizeWorkspacePath(input.targetCwd || rec?.cwd || 'F:\\插件-Gemini');
      const created = await this.createSession({
        cwd,
        title: rec ? `续聊｜${rec.title.slice(0, 20)}` : '续聊｜历史导入会话',
      });
      if (rec) {
        messagesBySession[created.sessionId] = [
          {
            id: `msg-cont-${Date.now()}`,
            sessionId: created.sessionId,
            role: 'assistant',
            content: `已从本地只读历史「${rec.title}」带入上下文摘要开启全新标准 ACP 会话：\n> ${rec.summarySnippet}`,
            createdAt: new Date().toISOString(),
          },
        ];
      }
      return created;
    },

    async setApprovalMode(mode: ApprovalMode): Promise<ApproveForMeConfig> {
      approvalConfig = { ...approvalConfig, mode };
      return structuredClone(approvalConfig);
    },

    async updateApprovalConfig(patch: Partial<ApproveForMeConfig>): Promise<ApproveForMeConfig> {
      approvalConfig = {
        ...approvalConfig,
        ...patch,
        externalReviewer: {
          ...approvalConfig.externalReviewer,
          ...(patch.externalReviewer ?? {}),
        },
      };
      return structuredClone(approvalConfig);
    },

    async submitApprovalDecision(submission: ApprovalDecisionSubmission): Promise<void> {
      const req = pendingApprovals.find((item) => item.requestId === submission.requestId);
      pendingApprovals = pendingApprovals.filter(
        (item) => item.requestId !== submission.requestId
      );

      if (req) {
        if (submission.decision === 'approve_for_me_ai') {
          approvalConfig = { ...approvalConfig, mode: 'hybrid' };
        }
        const isReject = submission.decision === 'reject_with_feedback';
        auditEntries.unshift({
          id: `audit-${Date.now()}`,
          timestamp: new Date().toISOString(),
          sessionId: submission.sessionId,
          cwd: req.cwd,
          toolName: req.toolName,
          commandOrSummary: req.commandOrSummary,
          modeAtDecision: approvalConfig.mode,
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

      const targetSession = sessions.find((s) => s.sessionId === submission.sessionId);
      if (targetSession) {
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
    },

    async listApprovalAudit(limit = 50): Promise<ApprovalAuditEntry[]> {
      return auditEntries.slice(0, limit).map((a) => ({ ...a }));
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

    async getUpdateState(): Promise<AppUpdateState> {
      return structuredClone(updateState);
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
    onApprovalRequested: approvalReqEvents.subscribe,
    onApprovalResolved: approvalResEvents.subscribe,
    onTelemetryUpdated: telemetryEvents.subscribe,
    onSwarmUpdated: swarmEvents.subscribe,
    onHistoryUpdated: historyEvents.subscribe,
    onAccountUpdated: accountEvents.subscribe,
    onUpdateState: updateEvents.subscribe,
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

export function resetFallbackDesktopBridge(): FallbackDesktopBridge {
  sharedFallbackInstance = createFallbackDesktopBridge();
  return sharedFallbackInstance;
}

/** 优先使用 preload 暴露的当前接口，其次兼容旧全局名称。普通浏览器没有桌面接口时使用内存演示实例。 */
export function getDesktopBridge(): GravityDesktopBridge {
  if (typeof window !== 'undefined') {
    if (window.gravityDesktop) return window.gravityDesktop;
    if (window.agyDesktop) return window.agyDesktop;
  }
  return getFallbackDesktopBridge();
}

export function isUsingNativeDesktopBridge(): boolean {
  return Boolean(
    typeof window !== 'undefined' && (window.gravityDesktop || window.agyDesktop)
  );
}

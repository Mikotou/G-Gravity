// @vitest-environment jsdom
import React, { useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_TRANSLATION_CONFIG,
  MAX_APPROVAL_PATTERNS_PER_KIND,
  type AcpConnectionStatus,
  type AccountQuota,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ChatMessageItem,
  type ClientPreferences,
  type ConversationTreeState,
  type DailyCalendarHeatmapCell,
  type HourlyTokenBarBucket,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type PluginsManagerSnapshot,
  type SwarmTopologyState,
  type TelemetryDashboardSnapshot,
} from '@shared';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { ApprovalsPanel, PluginsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { IconsPanel } from '../src/renderer/components/settings/AppearancePanels';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { AccountQuotaFeed, resetAccountQuotaFeeds } from '../src/renderer/lib/account-quota-feed';
import { GuardianReviewingCard, InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { ThinkingBlock } from '../src/renderer/components/ThinkingBlock';
import { ConversationTreePanel } from '../src/renderer/components/ConversationTreePanel';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { TokenHeatmapView } from '../src/renderer/components/context/TokenHeatmapView';
import { formatHourBucketLabel } from '../src/renderer/lib/heatmap';
import { Composer } from '../src/renderer/components/Composer';
import { SwarmPanel } from '../src/renderer/components/SwarmPanel';
import { ImageSessionContext, ImageWorkspace, MessageImage } from '../src/renderer/components/MessageImage';
import { Markdown } from '../src/renderer/components/Markdown';
import { ToolActivityStream, TurnOutcomeBar } from '../src/renderer/components/TurnActivity';
import { isTurnUnconfirmed, summarizeTurn } from '../src/renderer/lib/turn-insights';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

function wrapI18n(node: React.ReactElement, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {node}
    </I18nProvider>
  );
}

function makeConnection(overrides: Partial<AcpConnectionStatus> = {}): AcpConnectionStatus {
  return {
    connected: true,
    agyBinaryPath: '/usr/local/bin/agy',
    agyVersion: '1.0.0',
    activeSessionCount: 1,
    maxParallelSessions: 4,
    activeProfileId: 'default',
    availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    ...overrides,
  };
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-v035-1',
    cwd: 'F:\\Workspace\\demo',
    rawCwd: 'F:\\Workspace\\demo',
    title: 'v0.3.5 Test Session',
    pinned: false,
    isLegacyApprovalPollution: false,
    status: 'idle',
    modelId: 'gemini-2.5-pro',
    executionMode: 'default',
    reasoningEffort: 'medium',
    originKind: 'acp-live',
    readOnly: false,
    profileId: 'default',
    updatedAt: '2026-11-27T01:00:00.000Z',
    ...overrides,
  };
}

function makePreferences(overrides: Partial<ClientPreferences> = {}): ClientPreferences {
  return {
    theme: 'claude-code-dark',
    locale: 'zh-CN',
    uiScale: 1,
    appIcon: 'auto',
    defaultThoughtTrack: 'zh',
    translationEngine: 'local',
    processPerSession: false,
    activeProfileId: 'default',
    ...overrides,
  };
}

function makePluginsSnapshot(): PluginsManagerSnapshot {
  return {
    builtins: [
      {
        id: 'builtin-approve-for-me',
        name: 'Approve for me',
        badge: 'Built-in',
        descriptionZh: '内置审批',
        descriptionEn: 'Built-in approval',
        enabled: true,
      },
    ],
    plugins: [],
    mcpServers: [],
    skills: [],
    refreshedAt: '2026-11-27T01:00:00.000Z',
  };
}

function makeEmptyTelemetry(): TelemetryDashboardSnapshot {
  return {
    generatedAt: '2026-11-27T01:00:00.000Z',
    activeSessions: {},
    rateCards: [],
    allTime: {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalCostUsd: 0,
      sessionCount: 0,
    },
    heatmap24h: [],
    heatmap7d: [],
    heatmap30d: [],
    byModel: [],
  } as unknown as TelemetryDashboardSnapshot;
}

beforeEach(() => {
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
  resetAccountQuotaFeeds();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  resetAccountQuotaFeeds();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('v0.3.5 C1 审计日志决策来源徽章', () => {
  it('区分 AI (--sem-agent)、规则 (--sem-explore) 与用户 (--sem-success) 徽章', () => {
    const entries: ApprovalAuditEntry[] = [
      {
        id: 'a-ai',
        timestamp: '2026-11-27T01:00:00.000Z',
        sessionId: 's1',
        cwd: 'F:\\demo',
        toolName: 'Bash',
        commandOrSummary: 'npm test',
        modeAtDecision: 'hybrid',
        riskLevel: 'low',
        verdict: 'ai_approved',
        decisionSource: 'external-ai',
        reason: 'AI approved safe test command',
        latencyMs: 120,
      },
      {
        id: 'a-rule',
        timestamp: '2026-11-27T01:01:00.000Z',
        sessionId: 's1',
        cwd: 'F:\\demo',
        toolName: 'Bash',
        commandOrSummary: 'git status',
        modeAtDecision: 'rules-only',
        riskLevel: 'safe',
        verdict: 'auto_approved',
        decisionSource: 'local-rule',
        reason: 'Matched read-only rule',
        latencyMs: 2,
      },
      {
        id: 'a-user',
        timestamp: '2026-11-27T01:02:00.000Z',
        sessionId: 's1',
        cwd: 'F:\\demo',
        toolName: 'Bash',
        commandOrSummary: 'rm -rf tmp',
        modeAtDecision: 'manual',
        riskLevel: 'high',
        verdict: 'user_approved',
        decisionSource: 'user-inline',
        reason: 'Approved inline by user',
        latencyMs: 850,
      },
    ];

    render(
      wrapI18n(
        <ApprovalsPanel
          config={DEFAULT_APPROVAL_CONFIG}
          auditEntries={entries}
          initialTab="audit"
          onUpdateConfig={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );

    const aiBadge = screen.getByTestId('audit-source-a-ai');
    const ruleBadge = screen.getByTestId('audit-source-a-rule');
    const userBadge = screen.getByTestId('audit-source-a-user');

    expect(aiBadge.getAttribute('data-source-kind')).toBe('ai');
    expect(aiBadge.className).toContain('audit-source');
    expect(aiBadge.className).toContain('is-ai');
    expect(aiBadge.textContent).toBe('AI');

    expect(ruleBadge.getAttribute('data-source-kind')).toBe('rule');
    expect(ruleBadge.className).toContain('is-rule');
    expect(ruleBadge.textContent).toBe('规则');

    expect(userBadge.getAttribute('data-source-kind')).toBe('user');
    expect(userBadge.className).toContain('is-user');
    expect(userBadge.textContent).toBe('用户');

    // 验证 CSS 样式绑定到语义色令牌
    const settingsCss = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/styles/components/settings.css'),
      'utf8'
    );
    expect(settingsCss).toMatch(/\.audit-source\.is-ai\{[^}]*--sem-agent/);
    expect(settingsCss).toMatch(/\.audit-source\.is-rule\{[^}]*--sem-explore/);
    expect(settingsCss).toMatch(/\.audit-source\.is-user\{[^}]*--sem-success/);
  });
});

describe('v0.3.5 AP-1 外部复核与翻译 API Key 凭据安全', () => {
  it('外部复核携带 API Key 或 hasApiKey 时禁止 650ms 自动发现，展示规范化 origin，仅无鉴权本机 Ollama 自动发现', async () => {
    vi.useFakeTimers();
    const discover = vi.fn(async () => ({
      provider: 'gemini-api-key' as const,
      endpoint: 'https://generativelanguage.googleapis.com',
      fetchedAt: '2026-11-27T01:00:00.000Z',
      models: [{ id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportsThinking: false, supportedThinkingLevels: ['auto' as const] }],
    }));
    window.gravityDesktop = { ...getFallbackDesktopBridge(), discoverExternalReviewerModels: discover };

    render(
      wrapI18n(
        <ApprovalsPanel
          config={{
            ...DEFAULT_APPROVAL_CONFIG,
            externalReviewer: {
              ...DEFAULT_APPROVAL_CONFIG.externalReviewer,
              provider: 'openai-compatible',
              endpoint: 'https://api.example.com/v1/chat',
              hasApiKey: true,
              apiKey: undefined,
            },
          }}
          auditEntries={[]}
          initialTab="reviewer"
          onUpdateConfig={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );

    // 规范化 origin 展示
    expect(screen.getByTestId('reviewer-target-origin').textContent).toContain('https://api.example.com');
    // 已存 hasApiKey 打开页面不自动触发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(discover).not.toHaveBeenCalled();

    // 输入新 API Key 后同样禁止 650ms 自动发现
    fireEvent.change(screen.getByTestId('reviewer-apikey-input'), {
      target: { value: 'sk-synthetic-test-key-1234567890' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(discover).not.toHaveBeenCalled();

    // 用户显式点击按钮才触发 1 次
    await act(async () => {
      fireEvent.click(screen.getByTestId('discover-reviewer-models-btn'));
    });
    expect(discover).toHaveBeenCalledTimes(1);

    // 切到本机 Ollama http://127.0.0.1:11434（无鉴权）保留 650ms 自动发现
    const providerSelect = within(screen.getByTestId('approval-drawer'))
      .getAllByRole('combobox')
      .find((el) => (el as HTMLSelectElement).value === 'openai-compatible')!;
    fireEvent.change(providerSelect, { target: { value: 'local-ollama' } });
    expect(screen.getByTestId('reviewer-target-origin').textContent).toContain('http://127.0.0.1:11434');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'local-ollama', endpoint: 'http://127.0.0.1:11434' })
    );
  });

  it('外部翻译携带 API Key 时禁止 650ms 自动发现，展示规范化 origin，无效地址给出提示', async () => {
    vi.useFakeTimers();
    const discoverTrans = vi.fn(async () => ({
      provider: 'openai-compatible' as const,
      endpoint: 'https://api.example.com',
      fetchedAt: '2026-11-27T01:00:00.000Z',
      models: [{ id: 'gpt-4o-mini', displayName: 'GPT-4o mini', supportsThinking: false, supportedThinkingLevels: ['auto' as const] }],
    }));
    window.gravityDesktop = { ...getFallbackDesktopBridge(), discoverExternalTranslationModels: discoverTrans };

    render(
      wrapI18n(
        <SettingsView
          section="general"
          preferences={makePreferences()}
          connection={makeConnection()}
          accounts={{
            activeProfileId: 'default',
            profiles: [{ profileId: 'default', name: 'Default', isDefault: true, createdAt: '2026-01-01T00:00:00Z', lastActivatedAt: '2026-01-01T00:00:00Z' }],
            acpIdentity: { connected: true, authMethods: [], supportsLogout: false },
          }}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          translationConfig={{
            ...DEFAULT_TRANSLATION_CONFIG,
            externalTranslator: {
              ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
              provider: 'openai-compatible',
              endpoint: 'https://api.example.com/custom/v1',
              hasApiKey: true,
            },
          }}
          auditEntries={[]}
          plugins={makePluginsSnapshot()}
          rateCards={[]}
          updateState={{ status: 'idle', currentVersion: '0.3.5', repoUrl: 'https://github.com/example/gravity' }}
          onSectionChange={() => {}}
          onClose={() => {}}
          onUpdatePreferences={vi.fn().mockResolvedValue(undefined)}
          onCheckUpdates={vi.fn().mockResolvedValue(undefined)}
          onDownloadUpdate={vi.fn().mockResolvedValue(undefined)}
          onInstallUpdate={vi.fn().mockResolvedValue(undefined)}
          onSetAppIcon={vi.fn().mockResolvedValue(undefined)}
          onImportCustomTheme={vi.fn().mockResolvedValue(undefined)}
          onExportCustomTheme={vi.fn().mockResolvedValue('{}')}
          onUpdateRateCards={vi.fn().mockResolvedValue(undefined)}
          onCreateProfile={vi.fn().mockResolvedValue(undefined)}
          onSwitchProfile={vi.fn().mockResolvedValue(undefined)}
          onDeleteProfile={vi.fn().mockResolvedValue(undefined)}
          onLaunchLogin={vi.fn().mockResolvedValue(undefined)}
          onLogout={vi.fn().mockResolvedValue(undefined)}
          onUpdateApprovalConfig={vi.fn().mockResolvedValue(undefined)}
          onRefreshPlugins={vi.fn().mockResolvedValue(undefined)}
          onRunPluginAction={vi.fn().mockResolvedValue(undefined)}
          onRunMcpAction={vi.fn().mockResolvedValue(undefined)}
          onToggleSkill={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );

    if (!screen.queryByTestId('external-translator-form')) {
      fireEvent.click(screen.getByTestId('external-translator-expand-btn'));
    }
    expect(screen.getByTestId('translator-target-origin').textContent).toContain('https://api.example.com');

    fireEvent.change(screen.getByTestId('translator-apikey-input'), {
      target: { value: 'sk-translator-synthetic-key-99999999' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(discoverTrans).not.toHaveBeenCalled();

    // 显式点击触发
    await act(async () => {
      fireEvent.click(screen.getByTestId('discover-translator-models-btn'));
    });
    expect(discoverTrans).toHaveBeenCalledTimes(1);

    // 非法地址展示无效 origin 提示
    fireEvent.change(screen.getByTestId('translator-endpoint-input'), { target: { value: 'not-a-valid-url' } });
    expect(screen.getByTestId('translator-target-origin').textContent).toContain('地址无效');
  });
});

describe('v0.3.5 AP-2/3 审批规则校验、上限、冲突、宽泛警告与旧空白规则删除', () => {
  it('展示 deny > ask > allow 优先级，校验不安全/纯空白/超上限规则，警示冲突与宽泛通配，并支持删除历史空白规则', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const config: ApproveForMeConfig = {
      ...DEFAULT_APPROVAL_CONFIG,
      allowPatterns: ['', '   ', '^npm test$', '^.*'],
      askPatterns: [],
      denyPatterns: ['^npm test$'],
    };

    render(wrapI18n(<ApprovalsPanel config={config} auditEntries={[]} initialTab="rules" onUpdateConfig={onUpdate} />));

    // 优先级提示与计数
    expect(screen.getByTestId('approval-priority-hint').textContent).toMatch(/拒绝.*询问.*允许/);
    expect(screen.getByTestId('pattern-count-allowPatterns').textContent).toBe(`4/${MAX_APPROVAL_PATTERNS_PER_KIND}`);

    // FE-BUG-03：精确区分旧版空规则（已停用不会生效）与旧版非空纯空白规则（仍按字面空白匹配）
    expect(screen.getByTestId('pattern-legacy-blank-allowPatterns-0').textContent).toContain('旧版空规则（已停用不会生效，建议删除）');
    expect(screen.getByTestId('pattern-legacy-whitespace-allowPatterns-1').textContent).toContain('旧版纯空白规则（仍按字面空白匹配，建议删除）');
    // 跨列表冲突 & 宽泛通配警告
    expect(screen.getByTestId('pattern-conflict-warning-allowPatterns-2')).toBeTruthy();
    expect(screen.getByTestId('pattern-broad-warning-allowPatterns-3')).toBeTruthy();

    // 删除旧空白规则（按索引删除）
    fireEvent.click(screen.getByTestId('delete-pattern-allowPatterns-0'));
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        allowPatterns: ['   ', '^npm test$', '^.*'],
      })
    );
    onUpdate.mockClear();

    // 拒绝纯空白新增
    const allowInput = screen.getByTestId('pattern-input-allowPatterns');
    fireEvent.change(allowInput, { target: { value: '   ' } });
    expect(screen.getByTestId('pattern-error-allowPatterns').textContent).toContain('空白');
    fireEvent.submit(screen.getByTestId('pattern-form-allowPatterns'));
    expect(onUpdate).not.toHaveBeenCalled();

    // 拒绝不安全正则（分组/未锚定量词）
    fireEvent.change(allowInput, { target: { value: '(rm)+' } });
    expect(screen.getByTestId('pattern-error-allowPatterns').textContent).toContain('不安全');
    fireEvent.submit(screen.getByTestId('pattern-form-allowPatterns'));
    expect(onUpdate).not.toHaveBeenCalled();

    // 宽泛规则草稿给出警示，但合法可提交
    fireEvent.change(allowInput, { target: { value: '^.+$' } });
    expect(screen.getByTestId('pattern-draft-broad-allowPatterns')).toBeTruthy();

    // 达到上限 MAX_APPROVAL_PATTERNS_PER_KIND = 50 时禁止继续新增
    cleanup();
    const fullList = Array.from({ length: MAX_APPROVAL_PATTERNS_PER_KIND }, (_, i) => `^cmd-${i}$`);
    render(
      wrapI18n(
        <ApprovalsPanel
          config={{ ...DEFAULT_APPROVAL_CONFIG, allowPatterns: fullList }}
          auditEntries={[]}
          initialTab="rules"
          onUpdateConfig={onUpdate}
        />
      )
    );
    expect(screen.getByTestId('pattern-count-allowPatterns').textContent).toBe('50/50');
    expect((screen.getByTestId('pattern-add-allowPatterns') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('pattern-error-allowPatterns').textContent).toContain('50');
  });
});

describe('v0.3.5 PL-1 PluginsPanel 防静默刷 CLI 与隔离账号作用域提示', () => {
  it('切换语言或传入新回调引用不静默调用 getPluginsSnapshot，手动刷新仅触发 1 次，并展示隔离账号作用域横幅', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const snap = makePluginsSnapshot();

    function Host() {
      const [locale, setLocale] = useState<'zh-CN' | 'en-US'>('zh-CN');
      const [cwdTick, setCwdTick] = useState(0);
      return (
        <I18nProvider locale={locale} onChangeLocale={setLocale}>
          <button type="button" data-testid="switch-locale" onClick={() => setLocale((l) => (l === 'zh-CN' ? 'en-US' : 'zh-CN'))}>
            lang
          </button>
          <button type="button" data-testid="switch-tab-cwd" onClick={() => setCwdTick((n) => n + 1)}>
            cwd
          </button>
          <PluginsPanel
            snapshot={snap}
            activeProfile={{
              profileId: 'work-1',
              name: 'WorkProfile',
              isDefault: false,
              isolatedAppDataDir: '/tmp/work',
              createdAt: '2026-01-01T00:00:00Z',
              lastActivatedAt: '2026-01-01T00:00:00Z',
            }}
            onRefresh={async () => {
              await refreshSpy(cwdTick);
            }}
            onRunPluginAction={vi.fn().mockResolvedValue(undefined)}
            onRunMcpAction={vi.fn().mockResolvedValue(undefined)}
            onToggleSkill={vi.fn().mockResolvedValue(undefined)}
          />
        </I18nProvider>
      );
    }

    render(<Host />);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

    const scopeBanner = screen.getByTestId('plugins-profile-scope-banner');
    expect(scopeBanner.getAttribute('data-profile-isolated')).toBe('true');
    expect(scopeBanner.textContent).toContain('WorkProfile');

    // 切换语言 + 模拟会话页签切换导致的回调引用变更：不得静默再次调用
    fireEvent.click(screen.getByTestId('switch-locale'));
    fireEvent.click(screen.getByTestId('switch-tab-cwd'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // 显式点击刷新按钮才触发 1 次
    fireEvent.click(screen.getByTestId('plugins-refresh-btn'));
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(2));
  });
});

describe('v0.3.5 AQ-1 额度探测 429/403 冷却暂停、unavailable 可恢复与隔离 Profile', () => {
  it('订阅 EVENT_CONNECTION_UPDATED 冷却期暂停悬停/聚焦/轮询，仅手动刷新 getAccountQuota(true) 恢复', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-11-27T02:00:00.000Z');
    vi.setSystemTime(t0);

    const connListeners = new Set<(s: AcpConnectionStatus) => void>();
    const quotaOk: AccountQuota = {
      profileId: 'default',
      checkedAt: t0.toISOString(),
      buckets: [{ id: 'gemini-weekly', remainingFraction: 0.75 }],
    };
    const read = vi.fn(async () => quotaOk);
    const feed = new AccountQuotaFeed('default', read, (cb) => {
      connListeners.add(cb);
      return () => {
        connListeners.delete(cb);
      };
    });

    const unsub = feed.subscribe(vi.fn());
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    // 推送 429 冷却状态：完全暂停定时器、focus、attend、afterTurn；冷却尚未到期时手动刷新也不得触发或提前清 pausedByCooldown
    const cooldownStatus = makeConnection({
      cooldownKind: 'rate_limit_429',
      cooldownUntil: new Date(t0.getTime() + 60_000).toISOString(),
    });
    connListeners.forEach((cb) => cb(cooldownStatus));
    expect(feed.snapshot().pausedByCooldown).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // 冷却活跃期内（+30s < +60s）：manual() 也必须被拦截，不得提前清除 pausedByCooldown
    await vi.advanceTimersByTimeAsync(30_000);
    await feed.manual();
    expect(read).toHaveBeenCalledTimes(1);
    expect(feed.snapshot().pausedByCooldown).toBe(true);

    // 冷却到期后（+120s > +60s）：自动探测仍保持暂停，仅显式手动刷新触发 getAccountQuota(true) 并恢复
    await vi.advanceTimersByTimeAsync(90_000);
    window.dispatchEvent(new Event('focus'));
    await feed.attend();
    feed.afterTurn();
    expect(read).toHaveBeenCalledTimes(1);

    await feed.manual();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(true);
    expect(feed.snapshot().pausedByCooldown).toBeUndefined();
    unsub();
  });

  it('FE-BUG-04：429 活跃冷却期内刷新按钮禁用且 1 秒动态倒计时，归零后自动解锁供手动刷新', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-11-27T02:00:00.000Z');
    vi.setSystemTime(t0);

    const quotaOk: AccountQuota = {
      profileId: 'default',
      checkedAt: t0.toISOString(),
      buckets: [{ id: 'gemini-weekly', remainingFraction: 0.8 }],
    };
    const getQuota = vi.fn(async () => quotaOk);
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getAccountQuota: getQuota,
    };

    const conn = makeConnection({
      cooldownKind: 'rate_limit_429',
      cooldownUntil: new Date(t0.getTime() + 3_000).toISOString(),
    });

    render(wrapI18n(<AccountQuotaFooter profileId="default" connection={conn} />));

    // 打开弹层：按钮在活跃冷却期为 aria-disabled="true"，点击绝不触发 getAccountQuota(true)
    fireEvent.click(screen.getByTestId('quota-weekly'));
    const refreshBtn = screen.getByTestId('quota-refresh-btn');
    expect(refreshBtn.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('quota-cooldown-note').textContent).toContain('3 秒');
    fireEvent.click(refreshBtn);
    expect(getQuota).not.toHaveBeenCalled();

    // 1 秒后剩余秒数动态减至 2 秒
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('quota-cooldown-note').textContent).toContain('2 秒');
    expect(screen.getByTestId('quota-refresh-btn').getAttribute('aria-disabled')).toBe('true');

    // 再过 2 秒倒计时归零 -> 自动解锁，手动点击立即调用 getAccountQuota(true)
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('quota-refresh-btn').getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('quota-refresh-btn'));
      await Promise.resolve();
    });
    expect(getQuota).toHaveBeenCalledTimes(1);
    expect(getQuota).toHaveBeenCalledWith(true);
  });

  it('单次 unavailable 不永久禁用手动刷新按钮；隔离 Profile 跳过默认自动探测且可手动刷新', async () => {
    const quotaRecovered: AccountQuota = {
      profileId: 'iso-1',
      checkedAt: '2026-11-27T02:00:00.000Z',
      buckets: [{ id: 'gemini-weekly', remainingFraction: 0.9 }],
    };
    const getQuota = vi
      .fn<(manual?: boolean) => Promise<AccountQuota | { profileId: string; unavailable: 'profile' }>>()
      .mockResolvedValueOnce({ profileId: 'iso-1', unavailable: 'profile' })
      .mockResolvedValueOnce(quotaRecovered);
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getAccountQuota: getQuota,
    };

    render(
      wrapI18n(<AccountQuotaFooter profileId="iso-1" isIsolatedProfile={true} />)
    );

    // 隔离 Profile 挂载、悬停、聚焦均跳过默认自动探测
    const trigger = screen.getByTestId('quota-weekly');
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    expect(getQuota).not.toHaveBeenCalled();
    expect(screen.getByTestId('quota-isolated-note')).toBeTruthy();

    // 手动刷新收到 unavailable，刷新按钮依然存在且未永久禁用
    fireEvent.click(screen.getByTestId('quota-refresh-btn'));
    await waitFor(() => expect(getQuota).toHaveBeenCalledWith(true));
    expect(screen.getByTestId('quota-refresh-btn')).toBeTruthy();

    // 再次点击手动刷新恢复成功
    fireEvent.click(screen.getByTestId('quota-refresh-btn'));
    await waitFor(() => expect(screen.getByTestId('quota-weekly').textContent).toContain('90%'));
    expect(getQuota).toHaveBeenCalledTimes(2);
  });
});

describe('v0.3.5 IR-1 GuardianReviewingCard 无障碍与刷新频率', () => {
  it('收缩 aria-live 到静态标题（计时器在 aria-live 外）且计时器按 1000ms 刷新', () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-11-27T02:00:00.000Z');
    vi.setSystemTime(t0);

    render(
      wrapI18n(
        <GuardianReviewingCard
          event={{
            requestId: 'rev-1',
            sessionId: 's1',
            toolCallId: 'tc-1',
            toolName: 'Bash',
            commandPreview: 'git status',
            provider: 'gemini-api-key',
            model: 'gemini-2.5-flash',
            status: 'reviewing',
            startedAt: t0.toISOString(),
          }}
        />
      )
    );

    const card = screen.getByTestId('approval-reviewing-card-rev-1');
    const status = screen.getByTestId('approval-reviewing-status-rev-1');
    const elapsed = screen.getByTestId('approval-reviewing-elapsed-rev-1');

    expect(card.getAttribute('aria-live')).toBeNull();
    expect(card.getAttribute('role')).toBeNull();
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.contains(elapsed)).toBe(false);

    expect(elapsed.textContent).toBe('0.0s');
    // 400ms 不刷新（间隔已降至 1000ms）
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(elapsed.textContent).toBe('0.0s');
    // 累计 1000ms 后刷新一次
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(elapsed.textContent).toBe('1.0s');
  });
});

describe('v0.3.5 P2 全量前端修复验证', () => {
  it('ThinkingBlock：消除嵌套 button 并补齐 aria-pressed', () => {
    render(
      wrapI18n(
        <ThinkingBlock
          thought={{
            id: 'th-1',
            originalText: 'Analyze root cause',
            translatedZhText: '分析根因',
            languageDetected: 'en',
            translationSource: 'local-model',
            isStreaming: false,
          }}
          defaultTrack="zh"
        />
      )
    );

    const root = screen.getByTestId('thinking-block-th-1');
    const buttons = Array.from(root.querySelectorAll('button'));
    expect(buttons.length).toBe(3);
    for (const btn of buttons) {
      expect(btn.parentElement?.closest('button, [role="button"]')).toBeNull();
    }

    const zhBtn = screen.getByTestId('thought-btn-zh-th-1');
    const rawBtn = screen.getByTestId('thought-btn-raw-th-1');
    expect(zhBtn.getAttribute('aria-pressed')).toBe('true');
    expect(rawBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(rawBtn);
    expect(zhBtn.getAttribute('aria-pressed')).toBe('false');
    expect(rawBtn.getAttribute('aria-pressed')).toBe('true');

    const toggle = screen.getByTestId('thought-toggle-th-1');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('ConversationTreePanel：分开展示模型与费用、去除 512k 假上限、补齐中英 i18n 与 ARIA 树角色', () => {
    const tree: ConversationTreeState = {
      rootSessionId: 'root-1',
      rootTitle: 'Main Thread',
      activeBranchId: 'root-1',
      totalBranches: 2,
      updatedAt: '2026-11-27T01:00:00.000Z',
      nodes: [
        {
          branchId: 'root-1',
          rootSessionId: 'root-1',
          parentBranchId: null,
          forkAfterMessageId: null,
          forkUserTurnIndex: -1,
          forkPromptPreview: 'hello',
          createdAt: '2026-11-27T01:00:00.000Z',
          updatedAt: '2026-11-27T01:00:00.000Z',
          childrenIds: ['child-1'],
          depth: 0,
          siblingIndex: 1,
          siblingCount: 1,
          isActiveBranch: true,
          isOnActivePath: true,
          userTurnCount: 1,
          ownMessageCount: 2,
          latestUserPreview: 'hello',
          latestAssistantPreview: 'world',
          status: 'idle',
          modelId: 'gemini-2.5-pro',
          usedContextTokens: 12000,
          maxContextTokens: 0,
          usageRatio: 0,
          totalCostUsd: 0.42,
        },
        {
          branchId: 'child-1',
          rootSessionId: 'root-1',
          parentBranchId: 'root-1',
          forkAfterMessageId: 'u1',
          forkUserTurnIndex: 0,
          forkPromptPreview: 'alt',
          createdAt: '2026-11-27T01:01:00.000Z',
          updatedAt: '2026-11-27T01:01:00.000Z',
          childrenIds: [],
          depth: 1,
          siblingIndex: 2,
          siblingCount: 2,
          isActiveBranch: false,
          isOnActivePath: false,
          userTurnCount: 1,
          ownMessageCount: 2,
          latestUserPreview: 'alt',
          latestAssistantPreview: 'reply',
          status: 'idle',
          modelId: 'gemini-2.5-flash',
          usedContextTokens: 4000,
          maxContextTokens: 256000,
          usageRatio: 0.015,
          totalCostUsd: 0.05,
        },
      ],
      nodesById: {},
    };
    tree.nodesById = Object.fromEntries(tree.nodes.map((n) => [n.branchId, n]));

    render(wrapI18n(<ConversationTreePanel sessionId="root-1" tree={tree} telemetry={makeEmptyTelemetry()} />, 'zh-CN'));

    // 上限未知不写死 512k
    const ctxText = screen.getByTestId('conversation-tree-active-context').textContent || '';
    expect(ctxText).toContain('上限未知');
    expect(ctxText).not.toContain('512');

    // 模型名与费用分开显示，不再出现「分支模型 · $0.42」误显
    expect(screen.getByTestId('tree-node-model-root-1').textContent).toBe('gemini-2.5-pro');
    const costEl = screen.getByTestId('tree-node-cost-root-1');
    expect(costEl.textContent).toBe('$0.420');
    expect(costEl.textContent).not.toContain('模型');

    // ARIA 树角色属性完整
    const treeEl = screen.getByRole('tree', { name: '对话分支树' });
    const items = within(treeEl).getAllByRole('treeitem');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('aria-level')).toBe('1');
    expect(items[0].getAttribute('aria-expanded')).toBe('true');
    expect(items[1].getAttribute('aria-level')).toBe('2');
    expect(items[1].getAttribute('aria-setsize')).toBe('2');
    expect(items[1].getAttribute('aria-posinset')).toBe('2');
  });

  it('Composer：批量附件 Promise.allSettled 部分失败保留成功文件、IME 组合态拦截、生成中按 Enter 明确提示', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({ status: 'streaming' });

    const { rerender } = render(
      wrapI18n(
        <Composer
          session={session}
          availableSessions={[session]}
          availableModels={[{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          onSendPrompt={onSend}
          onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={vi.fn().mockResolvedValue(undefined)}
          onSetSessionEffort={vi.fn().mockResolvedValue(undefined)}
          onSetSessionModel={vi.fn().mockResolvedValue(undefined)}
          onQueryWorkspaceFiles={vi.fn().mockResolvedValue([])}
          onCycleApprovalMode={vi.fn().mockResolvedValue(undefined)}
          onOpenApprovalSettings={() => {}}
          onOpenContextInspector={() => {}}
          isIsolatedProfile={true}
        />
      )
    );

    const input = screen.getByTestId(`composer-input-${session.sessionId}`);
    fireEvent.change(input, { target: { value: 'hello while streaming' } });

    // 生成中按 Enter 给出明确提示且不发送
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId(`composer-running-hint-${session.sessionId}`).textContent).toContain('Esc');

    // 切回 idle：IME keyCode 229 不触发提交
    const idleSession = makeSession({ status: 'idle' });
    rerender(
      wrapI18n(
        <Composer
          session={idleSession}
          availableSessions={[idleSession]}
          availableModels={[{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          onSendPrompt={onSend}
          onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={vi.fn().mockResolvedValue(undefined)}
          onSetSessionEffort={vi.fn().mockResolvedValue(undefined)}
          onSetSessionModel={vi.fn().mockResolvedValue(undefined)}
          onQueryWorkspaceFiles={vi.fn().mockResolvedValue([])}
          onCycleApprovalMode={vi.fn().mockResolvedValue(undefined)}
          onOpenApprovalSettings={() => {}}
          onOpenContextInspector={() => {}}
          isIsolatedProfile={true}
        />
      )
    );
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    // 批量附件：1 个合法小文件 + 1 个超 20MB 文件，合法文件仍加入并提示部分失败
    const goodFile = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    const hugeFile = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(hugeFile, 'size', { value: 25 * 1024 * 1024 });

    const composerBox = input.closest('.composer')!;
    fireEvent.drop(composerBox, {
      dataTransfer: { files: [goodFile, hugeFile], types: ['Files'] },
    });

    await waitFor(() => {
      expect(screen.getByText('notes.txt')).toBeTruthy();
      expect(screen.getByTestId(`pane-error-${idleSession.sessionId}`).textContent).toContain('2 个附件中有 1 个未能添加');
    });
  });

  it('SwarmPanel：切换语言不触发重复分页拉取', async () => {
    const baseTopology: SwarmTopologyState = {
      sessionId: 's-swarm',
      isActive: true,
      swarmTitle: 'Team Run',
      workers: [],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 0, working: 0, waiting: 0, stopped: 0, killed: 0 },
      earlier: { workers: 10, boardMessages: null, actionTimeline: null },
      refreshHistoryWorkers: true,
    } as unknown as SwarmTopologyState;
    const onLoadPage = vi.fn().mockResolvedValue(baseTopology);

    function Host() {
      const [locale, setLocale] = useState<'zh-CN' | 'en-US'>('zh-CN');
      return (
        <I18nProvider locale={locale} onChangeLocale={setLocale}>
          <button type="button" data-testid="toggle-swarm-lang" onClick={() => setLocale((l) => (l === 'zh-CN' ? 'en-US' : 'zh-CN'))}>
            lang
          </button>
          <SwarmPanel sessionId="s-swarm" topology={baseTopology} onLoadPage={onLoadPage} />
        </I18nProvider>
      );
    }

    render(<Host />);
    // 触发一次加载更早分页以建立 cursors，等待分页及其随后的 refreshHistoryWorkers 同步完成
    const olderBtn = screen.getByRole('button', { name: /更早|Earlier/i });
    fireEvent.click(olderBtn);
    await waitFor(() => expect(onLoadPage).toHaveBeenCalledTimes(2));
    const callsBeforeLocaleSwitch = onLoadPage.mock.calls.length;

    // 连续切换语言：绝不再额外调用 onLoadPage
    fireEvent.click(screen.getByTestId('toggle-swarm-lang'));
    fireEvent.click(screen.getByTestId('toggle-swarm-lang'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLoadPage).toHaveBeenCalledTimes(callsBeforeLocaleSwitch);
  });

  it('InlineRequestView：卸载时清理反馈输入框聚焦用的 setTimeout', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    const req: PendingApprovalRequest = {
      requestId: 'req-unmount-1',
      sessionId: 's1',
      toolCallId: 'tc-unmount-1',
      cwd: 'F:\\demo',
      toolName: 'Bash',
      commandOrSummary: 'echo hi',
      riskLevel: 'medium',
      screeningSource: 'regex-rule',
      explanation: { meaning: 'print', target: 'stdout', risk: 'low' },
      createdAt: '2026-11-27T01:00:00.000Z',
    };

    const { unmount } = render(
      wrapI18n(<InlineRequestView request={req} onSubmitDecision={vi.fn().mockResolvedValue(undefined)} />)
    );
    fireEvent.click(screen.getByTestId('btn-reject-feedback-req-unmount-1'));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // 推进定时器不会抛异常
    act(() => {
      vi.runAllTimers();
    });
  });

  it('SettingsView Updater：下载进度条补齐 role="progressbar" 及空版本号安全兜底', () => {
    const commonProps = {
      section: 'about' as const,
      preferences: makePreferences(),
      connection: makeConnection(),
      accounts: {
        activeProfileId: 'default',
        profiles: [],
        acpIdentity: { connected: true, authMethods: [], supportsLogout: false },
      },
      approvalConfig: DEFAULT_APPROVAL_CONFIG,
      auditEntries: [],
      plugins: makePluginsSnapshot(),
      rateCards: [],
      onSectionChange: () => {},
      onClose: () => {},
      onUpdatePreferences: vi.fn().mockResolvedValue(undefined),
      onCheckUpdates: vi.fn().mockResolvedValue(undefined),
      onDownloadUpdate: vi.fn().mockResolvedValue(undefined),
      onInstallUpdate: vi.fn().mockResolvedValue(undefined),
      onSetAppIcon: vi.fn().mockResolvedValue(undefined),
      onImportCustomTheme: vi.fn().mockResolvedValue(undefined),
      onExportCustomTheme: vi.fn().mockResolvedValue('{}'),
      onUpdateRateCards: vi.fn().mockResolvedValue(undefined),
      onCreateProfile: vi.fn().mockResolvedValue(undefined),
      onSwitchProfile: vi.fn().mockResolvedValue(undefined),
      onDeleteProfile: vi.fn().mockResolvedValue(undefined),
      onLaunchLogin: vi.fn().mockResolvedValue(undefined),
      onLogout: vi.fn().mockResolvedValue(undefined),
      onUpdateApprovalConfig: vi.fn().mockResolvedValue(undefined),
      onRefreshPlugins: vi.fn().mockResolvedValue(undefined),
      onRunPluginAction: vi.fn().mockResolvedValue(undefined),
      onRunMcpAction: vi.fn().mockResolvedValue(undefined),
      onToggleSkill: vi.fn().mockResolvedValue(undefined),
    };

    const { rerender } = render(
      wrapI18n(
        <SettingsView
          {...commonProps}
          updateState={{
            status: 'downloading',
            currentVersion: '0.3.5',
            repoUrl: 'https://github.com/example/gravity',
            progressPercent: 42,
            downloadedBytes: 4200,
            totalBytes: 10000,
          }}
        />
      )
    );

    const bar = screen.getByTestId('update-download-progress');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');

    // 空 latestVersion 不显示裸 "v"，回退「未知版本」
    rerender(
      wrapI18n(
        <SettingsView
          {...commonProps}
          updateState={{
            status: 'downloaded',
            currentVersion: '0.3.5',
            latestVersion: '   ',
            repoUrl: 'https://github.com/example/gravity',
          }}
        />
      )
    );
    expect(screen.getByTestId('update-downloaded-version').textContent).toBe('未知版本');
  });

  it('MessageImage：远程图片渲染 CSP 安全外链胶囊走 openLinkOrFileTarget，本地图片加载失败支持重试', async () => {
    const openSpy = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'browser', resolvedTarget: 'https://example.com/pic.png' });
    window.gravityDesktop = { ...getFallbackDesktopBridge(), openLinkOrFileTarget: openSpy };

    render(
      wrapI18n(
        <ImageSessionContext.Provider value="s-img">
          <ImageWorkspace.Provider value={'F:\\demo'}>
            <div>
              <MessageImage source="https://example.com/pic.png" alt="Remote diagram" />
              <MessageImage source="assets/local.png" alt="Local chart" />
            </div>
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>
      )
    );

    // 远程图片变为外链胶囊（无 broken <img>）
    const capsule = screen.getByTestId('md-img-blocked-capsule');
    expect(capsule.textContent).toContain('Remote diagram');
    fireEvent.click(screen.getByTestId('md-img-blocked-open-btn'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'https://example.com/pic.png',
          action: 'browser',
          cwd: 'F:\\demo',
          sessionId: 's-img',
        })
      )
    );

    // 本地图片失败后显示重试按钮，点击可重新渲染 <img>
    const localImg = screen.getByAltText('Local chart');
    fireEvent.error(localImg);
    expect(screen.getByTestId('md-img-failed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('md-img-retry-btn'));
    expect(screen.getByAltText('Local chart')).toBeTruthy();
  });

  it('Markdown：表格/代码块键盘横向滚动、>40行代码块折叠展开、清理 lang 与冗余 aria-live、GFM Alerts i18n、file:// 中键一致', async () => {
    const openSpy = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'default-app', resolvedTarget: 'F:\\demo\\a.ts' });
    window.gravityDesktop = { ...getFallbackDesktopBridge(), openLinkOrFileTarget: openSpy };

    const longCode = Array.from({ length: 48 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
    const md = [
      '| ColA | ColB |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      longCode,
      '```',
      '',
      '> [!NOTE]',
      '> 注意内容',
      '',
      '> [!CAUTION]',
      '> 小心内容',
      '',
      '[a.ts](file:///F:/demo/a.ts)',
    ].join('\n');

    const { container } = render(
      wrapI18n(
        <ImageSessionContext.Provider value="s-md">
          <ImageWorkspace.Provider value="F:\\demo">
            <Markdown text={md} />
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>,
        'zh-CN'
      )
    );

    // 表格与代码块支持键盘聚焦滚动
    const tableWrap = container.querySelector('.md-table-wrap')!;
    const pre = container.querySelector('.code-block pre')!;
    expect(tableWrap.getAttribute('tabindex')).toBe('0');
    expect(tableWrap.getAttribute('role')).toBe('region');
    expect(pre.getAttribute('tabindex')).toBe('0');
    expect(pre.getAttribute('role')).toBe('region');

    // 清理错误的 lang 与空状态冗余 aria-live
    const langLabel = container.querySelector('.code-block-head > span')!;
    expect(langLabel.getAttribute('lang')).toBeNull();
    expect(container.querySelector('.code-copy-status')).toBeNull();

    // >40 行代码块默认折叠到 40 行，点击展开到全部 48 行
    const foldBtn = screen.getByTestId('code-fold-btn');
    expect(foldBtn.getAttribute('aria-expanded')).toBe('false');
    expect(foldBtn.textContent).toContain('48');
    expect(pre.textContent).not.toContain('line48');
    fireEvent.click(foldBtn);
    expect(foldBtn.getAttribute('aria-expanded')).toBe('true');
    expect(pre.textContent).toContain('line48');

    // GFM Alerts 中文 i18n
    const alertTitles = Array.from(container.querySelectorAll('.md-alert-title')).map((el) => el.textContent);
    expect(alertTitles).toEqual(['注意', '小心']);

    // file:// 链接中键 auxClick 走 openLinkOrFileTarget(default-app)
    const fileLink = container.querySelector<HTMLAnchorElement>('a.md-link-file')!;
    fireEvent(fileLink, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({ target: 'file:///F:/demo/a.ts', action: 'default-app' })
      )
    );
  });

  it('TurnActivity (TA-1/TA-4)：优先 turnStartedAt/turnSettledAt 统计耗时，提问分段不误报，旧历史三条件未确认且不卡转圈', () => {
    // TA-1：整回合 turnStartedAt -> turnSettledAt 为 12s（优先于 createdAt/completedAt 的 2s）
    const settledMsg: ChatMessageItem = {
      id: 'm-settled',
      sessionId: 's1',
      role: 'assistant',
      content: 'All done',
      createdAt: '2026-11-27T01:00:10.000Z',
      completedAt: '2026-11-27T01:00:12.000Z',
      turnStartedAt: '2026-11-27T01:00:00.000Z',
      turnSettledAt: '2026-11-27T01:00:12.000Z',
      toolCalls: [
        {
          toolCallId: 't-stale',
          rawToolName: 'Bash',
          canonicalToolName: 'Bash',
          compactTarget: 'npm test',
          status: 'running',
          argsSummary: 'npm test',
          startedAt: '2026-11-27T01:00:01.000Z',
        },
      ],
    };
    expect(summarizeTurn(settledMsg).durationMs).toBe(12_000);

    // 提问中间分段（无 turnSettledAt）不误报耗时
    const questionSegment: ChatMessageItem = {
      id: 'm-q',
      sessionId: 's1',
      role: 'assistant',
      content: 'Which option?',
      createdAt: '2026-11-27T01:00:00.000Z',
      completedAt: '2026-11-27T01:00:05.000Z',
      question: {
        id: 'q1',
        message: 'Pick one',
        state: 'answered',
        answer: 'A',
        fields: [],
      } as ChatMessageItem['question'],
    };
    expect(summarizeTurn(questionSegment).durationMs).toBeUndefined();

    // 已收口消息即使含遗留 running 工具也不卡转圈
    const { container: settledDom } = render(
      wrapI18n(
        <>
          <ToolActivityStream tools={settledMsg.toolCalls!} settled={true} onInspectDiff={() => {}} />
          <TurnOutcomeBar message={settledMsg} sessionStatus="idle" onInspectDiff={() => {}} />
        </>
      )
    );
    expect(settledDom.querySelector('.spin')).toBeNull();
    expect(screen.getByTestId('turn-outcome-m-settled').textContent).toContain('12s');
    cleanup();

    // TA-4：旧历史消息无 turnSettledAt、非运行态、含未终态工具 -> 三条件命中未确认，显示警示且停止转圈
    const legacyUnconfirmed: ChatMessageItem = {
      id: 'm-legacy',
      sessionId: 's1',
      role: 'assistant',
      content: 'partial',
      createdAt: '2026-11-27T00:00:00.000Z',
      toolCalls: [
        {
          toolCallId: 't-stuck',
          rawToolName: 'Bash',
          canonicalToolName: 'Bash',
          compactTarget: 'long-cmd',
          status: 'running',
          argsSummary: 'long-cmd',
          startedAt: '2026-11-27T00:00:01.000Z',
        },
      ],
    };
    expect(isTurnUnconfirmed(legacyUnconfirmed, { isLatestAssistant: true, sessionStatus: 'streaming' })).toBe(false);
    expect(isTurnUnconfirmed(legacyUnconfirmed, { isLatestAssistant: true, sessionStatus: 'idle' })).toBe(true);
    expect(isTurnUnconfirmed(legacyUnconfirmed, { isLatestAssistant: false, sessionStatus: 'streaming' })).toBe(true);

    const { container: legacyDom } = render(
      wrapI18n(
        <>
          <ToolActivityStream tools={legacyUnconfirmed.toolCalls!} unconfirmed={true} onInspectDiff={() => {}} />
          <TurnOutcomeBar message={legacyUnconfirmed} isLatestAssistant={false} sessionStatus="idle" onInspectDiff={() => {}} />
        </>
      )
    );
    expect(legacyDom.querySelector('.spin')).toBeNull();
    expect(screen.getByTestId('turn-outcome-m-legacy').getAttribute('data-unconfirmed')).toBe('true');
    expect(screen.getByTestId('turn-unconfirmed-m-legacy')).toBeTruthy();
  });
});

describe('v0.3.5 FE-BUG-05 & FE-BUG-09 热力图 DST/键盘漫游与检视器/设置无障碍修复', () => {
  it('FE-BUG-05：24h 柱图优先展示 startIso 数值 UTC 偏移区分 DST 两个 01:00，支持键盘聚焦与左右漫游且仅聚焦播报 aria-live', () => {
    const hourly24h: HourlyTokenBarBucket[] = [
      {
        hourKey: '2026-11-01T01',
        hourLabel: '01:00',
        startIso: '2026-11-01T01:00:00-04:00',
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 200,
        thinkingTokens: 0,
        totalTokens: 1200,
        costUsd: 0.01,
        intensity: 2,
      },
      {
        hourKey: '2026-11-01T01',
        hourLabel: '01:00',
        startIso: '2026-11-01T01:00:00-05:00',
        inputTokens: 4000,
        cachedInputTokens: 0,
        outputTokens: 800,
        thinkingTokens: 0,
        totalTokens: 4800,
        costUsd: 0.04,
        intensity: 4,
      },
      {
        hourKey: '2026-11-01T06',
        hourLabel: '06:00',
        startIso: '2026-11-01T06:00:00+05:45',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        intensity: 0,
      },
    ];

    expect(formatHourBucketLabel(hourly24h[0])).toBe('2026-11-01 01:00 (-04:00)');
    expect(formatHourBucketLabel(hourly24h[1])).toBe('2026-11-01 01:00 (-05:00)');
    expect(formatHourBucketLabel(hourly24h[2])).toBe('2026-11-01 06:00 (+05:45)');

    render(
      wrapI18n(
        <TokenHeatmapView
          testIdPrefix=""
          sectionTestId="hm-sec"
          title="Token 热力图"
          hourly24h={hourly24h}
          daily7d={[]}
          calendar30d={[]}
        />
      )
    );

    const barsWrap = screen.getByTestId('heatmap-24h-bars');
    const bars = Array.from(barsWrap.querySelectorAll<HTMLElement>('.hm-bar'));
    expect(bars).toHaveLength(3);
    expect(bars[0].getAttribute('title')).toContain('-04:00');
    expect(bars[1].getAttribute('title')).toContain('-05:00');
    expect(bars[2].getAttribute('title')).toContain('+05:45');
    expect(bars[0].getAttribute('aria-label')).toContain('-04:00');
    expect(bars[1].getAttribute('aria-label')).toContain('-05:00');

    // 悬停只更新可见读数，不写入 aria-live
    const live = screen.getByTestId('heatmap-live');
    fireEvent.mouseEnter(bars[0]);
    expect(live.textContent).toBe('');

    // 键盘聚焦 + ArrowLeft 漫游 -> 写入 focus-only aria-live
    expect(bars[2].getAttribute('tabindex')).toBe('0');
    act(() => {
      bars[2].focus();
    });
    expect(live.textContent).toContain('+05:45');
    fireEvent.keyDown(bars[2], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(bars[1]);
    expect(live.textContent).toContain('-05:00');
    fireEvent.keyDown(bars[1], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(bars[0]);
    expect(live.textContent).toContain('-04:00');
  });

  it('FE-BUG-09：TokenHeatmapView 空数据先挂载、后异步到达 7d 数据时 active 自动定位到最新一天', () => {
    const days7: DailyCalendarHeatmapCell[] = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-11-${String(21 + i).padStart(2, '0')}`,
      inputTokens: (i + 1) * 800,
      cachedInputTokens: 0,
      outputTokens: (i + 1) * 200,
      thinkingTokens: 0,
      totalTokens: (i + 1) * 1000,
      costUsd: 0.01 * (i + 1),
      sessionCount: 1,
      intensity: (i % 5) as 0 | 1 | 2 | 3 | 4,
    }));

    const { rerender } = render(
      wrapI18n(
        <TokenHeatmapView
          testIdPrefix=""
          sectionTestId="hm-sec"
          title="Token 热力图"
          hourly24h={[]}
          daily7d={[]}
          calendar30d={[]}
        />
      )
    );
    fireEvent.click(screen.getByTestId('heatmap-range-7d'));

    rerender(
      wrapI18n(
        <TokenHeatmapView
          testIdPrefix=""
          sectionTestId="hm-sec"
          title="Token 热力图"
          hourly24h={[]}
          daily7d={days7}
          calendar30d={days7}
        />
      )
    );

    const firstDay = screen.getByTestId('heatmap-7d-day-2026-11-21');
    const latestDay = screen.getByTestId('heatmap-7d-day-2026-11-27');
    expect(firstDay.getAttribute('tabindex')).toBe('-1');
    expect(latestDay.getAttribute('tabindex')).toBe('0');
  });

  it('FE-BUG-09：ContextCostInspectorView jumpTo 持久化并 rAF 滚动、Cost 折叠按钮统一右置、三组 tablist 支持方向键漫游、IconsPanel 接入保存失败提示', async () => {
    const emptyCost = {
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
    };
    const dashboard: TelemetryDashboardSnapshot = {
      generatedAt: '2026-11-27T01:00:00.000Z',
      pricingSource: 'reference-api-estimate',
      activeSessions: {},
      rateCards: [],
      hourly24h: [],
      daily7d: [],
      matrix7d: [],
      calendar30d: [],
      costByRange: { today: emptyCost, '7d': emptyCost, '30d': emptyCost },
      modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
      sessionModelBreakdowns: {},
    };

    localStorage.setItem('gravity.context.collapsed', JSON.stringify({ usage: false, heatmap: false, cost: true }));
    const rafCbs: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });

    render(wrapI18n(<ContextCostInspectorView sessionId={null} dashboard={dashboard} onOpenRateCardsSettings={vi.fn()} />));

    // Cost 卡片折叠按钮统一位于 .card-head 最右侧（在分段切换之后）
    const costHead = screen.getByTestId('cost-breakdown-section').querySelector('.card-head')!;
    const costToggle = screen.getByTestId('context-section-toggle-cost');
    expect(costHead.lastElementChild).toBe(costToggle);
    expect(costToggle.getAttribute('aria-expanded')).toBe('false');

    // jumpTo 展开折叠区、同步写 localStorage，并在 rAF 回调中滚动（尊重 scrollBehavior）
    const costSection = document.getElementById('ctx-section-cost')!;
    const scrollSpy = vi.fn();
    costSection.scrollIntoView = scrollSpy;
    fireEvent.click(screen.getByTestId('context-anchor-cost'));
    expect(costToggle.getAttribute('aria-expanded')).toBe('true');
    expect(JSON.parse(localStorage.getItem('gravity.context.collapsed') || '{}').cost).toBe(false);
    expect(scrollSpy).not.toHaveBeenCalled();
    act(() => {
      while (rafCbs.length) rafCbs.shift()!(0);
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();

    // ctx-view-switch 接入 role="tablist" 与方向键漫游
    const modeSwitch = screen.getByTestId('context-inspector-mode-switch');
    expect(modeSwitch.getAttribute('role')).toBe('tablist');
    const ctxTab = screen.getByTestId('ctx-view-switch-context');
    const revTab = screen.getByTestId('ctx-view-switch-reviewer');
    expect(ctxTab.getAttribute('role')).toBe('tab');
    expect(ctxTab.getAttribute('aria-selected')).toBe('true');
    ctxTab.focus();
    fireEvent.keyDown(modeSwitch, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(revTab);
    expect(revTab.getAttribute('aria-selected')).toBe('true');

    cleanup();

    // ApprovalsPanel & PluginsPanel .sub-tabs 接入 role="tablist" 与方向键漫游
    render(
      wrapI18n(
        <ApprovalsPanel config={DEFAULT_APPROVAL_CONFIG} auditEntries={[]} onUpdateConfig={vi.fn().mockResolvedValue(undefined)} />
      )
    );
    const approvalTabs = screen.getByTestId('approval-drawer').querySelector('.sub-tabs')!;
    expect(approvalTabs.getAttribute('role')).toBe('tablist');
    const rulesTab = screen.getByTestId('drawer-tab-rules');
    const auditTab = screen.getByTestId('drawer-tab-audit');
    rulesTab.focus();
    fireEvent.keyDown(approvalTabs, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(auditTab);
    expect(auditTab.getAttribute('aria-selected')).toBe('true');

    cleanup();

    render(
      wrapI18n(
        <PluginsPanel
          snapshot={makePluginsSnapshot()}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRunPluginAction={vi.fn().mockResolvedValue(undefined)}
          onRunMcpAction={vi.fn().mockResolvedValue(undefined)}
          onToggleSkill={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );
    const pluginTabs = screen.getByTestId('plugins-manager-modal').querySelector('.sub-tabs')!;
    expect(pluginTabs.getAttribute('role')).toBe('tablist');
    const builtinsTab = screen.getByTestId('plugins-tab-builtins');
    const pluginsTab = screen.getByTestId('plugins-tab-plugins');
    builtinsTab.focus();
    fireEvent.keyDown(pluginTabs, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(pluginsTab);
    expect(pluginsTab.getAttribute('aria-selected')).toBe('true');

    cleanup();

    // IconsPanel 接入 usePrefsFeedback 捕获 onSetAppIcon 失败
    const failIcon = vi.fn().mockRejectedValue(new Error('磁盘只读'));
    render(wrapI18n(<IconsPanel preferences={makePreferences({ appIcon: 'auto' })} onSetAppIcon={failIcon} />));
    await act(async () => {
      fireEvent.click(screen.getByTestId('icon-variant-auto'));
    });
    expect(failIcon).toHaveBeenCalledWith('auto');
    expect(screen.getByTestId('settings-prefs-error').textContent).toContain('磁盘只读');
  });
});

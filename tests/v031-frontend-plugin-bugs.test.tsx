import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TRANSLATION_CONFIG,
  GRAVITY_BUILTIN_CAPABILITIES,
  THEME_PRESETS,
  type ApproveForMeConfig,
  type ClientPreferences,
  type CustomThemeConfig,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
  type PluginsManagerSnapshot,
  type SwarmTopologyState,
  type TranslationConfig,
  type WorkspaceLayoutState,
} from '@shared';
import { Composer } from '../src/renderer/components/Composer';
import { QuestionBar } from '../src/renderer/components/QuestionBar';
import { GuardianReviewingCard, InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { TokensPanel } from '../src/renderer/components/settings/AppearancePanels';
import { PluginsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { ProjectSidebar } from '../src/renderer/components/ProjectSidebar';
import { SwarmPanel } from '../src/renderer/components/SwarmPanel';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { TopBar } from '../src/renderer/components/TopBar';
import { TitleOrganizerModal } from '../src/renderer/components/TitleOrganizerModal';
import { NewSessionModal } from '../src/renderer/components/NewSessionModal';
import { ResizeHandle } from '../src/renderer/components/ResizeHandle';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

beforeEach(() => {
  delete window.gravityDesktop;
  document.body.className = '';
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  document.body.className = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wrap(child: React.ReactNode, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {child}
    </I18nProvider>
  );
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-bug-1',
    cwd: 'F:\\Demo\\App',
    rawCwd: 'F:\\Demo\\App',
    title: '回归测试会话',
    pinned: false,
    isLegacyApprovalPollution: false,
    status: 'idle',
    modelId: 'gemini-4-neon',
    executionMode: 'default',
    reasoningEffort: 'medium',
    originKind: 'acp-live',
    readOnly: false,
    profileId: 'default',
    updatedAt: '2026-11-24T12:00:00.000Z',
    ...overrides,
  };
}

function makeApprovalConfig(overrides: Partial<ApproveForMeConfig> = {}): ApproveForMeConfig {
  return {
    mode: 'rules-only',
    enableSafeDownloadAutoApprove: false,
    maxDownloadSizeMB: 50,
    cacheTtlHours: 24,
    allowPatterns: [],
    askPatterns: [],
    denyPatterns: [],
    externalReviewer: {
      enabled: false,
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash-lite',
      timeoutMs: 8000,
      maxOutputTokens: 4096,
      thinkingLevel: 'auto',
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ WCAG 2.1 对比度工具 */

function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  if (clean.length >= 6) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  throw new Error(`Unsupported hex color for WCAG contrast check: ${hex}`);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex).map((ch) => {
    const s = ch / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('v0.3.1 WCAG 2.1 AA 6 套预设主题对比度自动化门禁', () => {
  it('WCAG 2.1 AA：全部 6 套预设主题中 textPrimary/textSecondary/textMuted 与 statusSuccess/Warning/Danger 对主画布与表面均满足 >= 4.5:1', () => {
    expect(THEME_PRESETS).toHaveLength(6);

    const primarySurfaceFgKeys = [
      'textPrimary',
      'textSecondary',
      'textMuted',
      'statusSuccess',
      'statusWarning',
      'statusDanger',
    ] as const;
    const textFgKeys = ['textPrimary', 'textSecondary', 'textMuted'] as const;

    for (const preset of THEME_PRESETS) {
      const { tokens } = preset;
      for (const fgKey of primarySurfaceFgKeys) {
        const crApp = contrastRatio(tokens[fgKey], tokens.bgApp);
        expect(
          crApp,
          `[${preset.id}] ${fgKey} (${tokens[fgKey]}) vs bgApp (${tokens.bgApp}) contrast ${crApp.toFixed(2)} < 4.5`
        ).toBeGreaterThanOrEqual(4.5);
      }

      for (const fgKey of textFgKeys) {
        const crSurface = contrastRatio(tokens[fgKey], tokens.bgSurface);
        expect(
          crSurface,
          `[${preset.id}] ${fgKey} (${tokens[fgKey]}) vs bgSurface (${tokens.bgSurface}) contrast ${crSurface.toFixed(2)} < 4.5`
        ).toBeGreaterThanOrEqual(4.5);

        const crSidebar = contrastRatio(tokens[fgKey], tokens.bgSidebar);
        expect(
          crSidebar,
          `[${preset.id}] ${fgKey} (${tokens[fgKey]}) vs bgSidebar (${tokens.bgSidebar}) contrast ${crSidebar.toFixed(2)} < 4.5`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('v0.3.1 前端本体与内置插件 UI 全仓缺陷回归 (F-P1-4 ~ F-P2-1)', () => {
  it('F-P1-4 (Composer)：会话存在独立审批覆盖时可切回 Manual、@nonexistent 隐藏空弹窗、pane-error 可手动关闭', async () => {
    const onCycleApprovalMode = vi.fn().mockResolvedValue(undefined);
    const onClearSessionApprovals = vi.fn().mockResolvedValue(undefined);
    const onSendPrompt = vi.fn().mockRejectedValueOnce(new Error('模拟发送失败'));

    const session = makeSession({
      sessionId: 'sess-comp',
      approvalModeOverride: 'rules-only',
      hasApprovalGrants: true,
    });

    render(
      wrap(
        <Composer
          session={session}
          availableSessions={[]}
          availableModels={[]}
          approvalConfig={makeApprovalConfig({ mode: 'rules-only' })}
          canTriggerDemoApproval={false}
          onSendPrompt={onSendPrompt}
          onCancelPrompt={vi.fn().mockResolvedValue(undefined)}
          onCompactContext={vi.fn().mockResolvedValue(undefined)}
          onSetSessionMode={vi.fn().mockResolvedValue(undefined)}
          onSetSessionEffort={vi.fn().mockResolvedValue(undefined)}
          onSetSessionModel={vi.fn().mockResolvedValue(undefined)}
          onQueryWorkspaceFiles={vi.fn().mockResolvedValue([])}
          onCycleApprovalMode={onCycleApprovalMode}
          onClearSessionApprovals={onClearSessionApprovals}
          onOpenApprovalSettings={vi.fn()}
          onOpenContextInspector={vi.fn()}
          onTriggerDemoApproval={vi.fn()}
        />
      )
    );

    // 1) 切回 Manual 同步清除会话级审批覆盖
    fireEvent.click(screen.getByTestId('approval-mode-pill-sess-comp'));
    fireEvent.click(screen.getByTestId('approval-menu-mode-manual-sess-comp'));
    await waitFor(() => {
      expect(onCycleApprovalMode).toHaveBeenCalledWith('manual');
      expect(onClearSessionApprovals).toHaveBeenCalledWith('sess-comp');
    });

    // 2) 输入 @nonexistent 无匹配结果时隐藏空弹窗
    const input = screen.getByTestId('composer-input-sess-comp');
    fireEvent.change(input, { target: { value: '@nonexistent_file_xyz' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('mention-menu-sess-comp')).toBeNull();

    // 3) pane-error 出现后可点击关闭按钮干净消除
    fireEvent.change(input, { target: { value: 'hello error' } });
    fireEvent.click(screen.getByTestId('send-prompt-btn-sess-comp'));
    const errBox = await screen.findByTestId('pane-error-sess-comp');
    expect(errBox.textContent).toContain('模拟发送失败');
    const dismissBtn = within(errBox).getByRole('button');
    fireEvent.click(dismissBtn);
    await waitFor(() => expect(screen.queryByTestId('pane-error-sess-comp')).toBeNull());
  });

  it('F-P1-5 (QuestionBar)：清空或输入非法数字不存入/渲染 NaN', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(
      wrap(
        <QuestionBar
          draftKey="numeric-nan-guard"
          native={true}
          submit={submit}
          question={{
            message: '请设置服务端口',
            state: 'open',
            fields: [
              {
                name: 'port',
                title: '端口号',
                type: 'integer',
                required: true,
                initial: 8080,
              },
            ],
          }}
        />
      )
    );

    const numInput = screen.getByLabelText('端口号') as HTMLInputElement;
    expect(numInput.value).toBe('8080');

    // 清空数字输入后不应存入或显示 NaN
    fireEvent.change(numInput, { target: { value: '' } });
    expect(numInput.value).not.toBe('NaN');
    expect(numInput.value).toBe('');

    // 模拟浏览器在输入半截科学计数/非数字文本时上报非空 value 且 valueAsNumber = NaN
    Object.defineProperty(numInput, 'valueAsNumber', { configurable: true, value: Number.NaN });
    fireEvent.change(numInput, { target: { value: '1234' } });
    expect(numInput.value).not.toBe('NaN');

    const stored = window.sessionStorage.getItem('gravity.question.numeric-nan-guard') || '';
    expect(stored).not.toContain('NaN');
    expect(stored).not.toContain('"port":null');

    // 必填数字字段在 NaN 情况下不应视为已填并通过校验提交出 NaN
    fireEvent.click(screen.getByRole('button', { name: '发送回答' }));
    expect(submit).not.toHaveBeenCalled();
  });

  it('F-P1-7 (InlineRequestView)：GuardianReviewingCard 面对非法 startedAt 仍平滑递增耗时，且 en-US 使用 ASCII 冒号而非中文全角冒号', () => {
    vi.useFakeTimers();
    const view1 = render(
      wrap(
        <GuardianReviewingCard
          event={{
            requestId: 'req-bad-ts',
            sessionId: 's1',
            toolCallId: 'tc-1',
            toolName: 'run_command',
            commandPreview: 'npm test',
            provider: 'openai-compatible',
            model: 'gpt-6.2-astra',
            status: 'reviewing',
            startedAt: 'not-a-valid-iso-timestamp',
          }}
        />,
        'en-US'
      )
    );

    const elapsed = screen.getByTestId('approval-reviewing-elapsed-req-bad-ts');
    expect(elapsed.textContent).toBe('0.0s');

    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(elapsed.textContent).not.toBe('0.0s');
    const secVal = Number.parseFloat((elapsed.textContent || '0').replace(/s$/, ''));
    expect(secVal).toBeGreaterThanOrEqual(1.0);
    view1.unmount();

    vi.useRealTimers();
    const request: PendingApprovalRequest = {
      requestId: 'req-colon',
      sessionId: 's1',
      toolCallId: 'tc-2',
      toolName: 'run_command',
      commandOrSummary: 'git push origin main',
      cwd: 'F:\\Demo\\App',
      createdAt: '2026-11-24T12:00:00.000Z',
      riskLevel: 'medium',
      commandPrefix: 'git push',
      explanation: {
        meaning: 'Push local commits to remote origin.',
        target: 'origin/main',
        risk: 'Modifies remote branch state.',
      },
      screeningSource: 'manual-mode',
    };
    render(wrap(<InlineRequestView request={request} onSubmitDecision={vi.fn().mockResolvedValue(undefined)} />, 'en-US'));
    const expEl = screen.getByTestId('request-explanation-req-colon');
    expect(expEl.textContent).not.toContain('：');
    expect(expEl.textContent).toContain(':');
  });

  it('F-P1-8 (AppearancePanels / TokensPanel)：存在未保存草稿时导入主题 JSON 立即刷新草稿，且卸载时不覆写回旧草稿', async () => {
    vi.useFakeTimers();
    const basePrefs: ClientPreferences = {
      locale: 'zh-CN',
      theme: 'claude-code-dark',
      appIcon: 'gravity-claude-dark',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };

    const importedTheme: CustomThemeConfig = {
      name: 'Imported Midnight',
      polarity: 'dark',
      baseThemeId: 'claude-code-dark',
      tokens: {
        ...THEME_PRESETS[0].tokens,
        bgApp: '#101218',
        accentPrimary: '#60a5fa',
      },
    };

    const onUpdatePreferences = vi.fn().mockResolvedValue(undefined);
    let currentPrefs: ClientPreferences = basePrefs;
    const onImportCustomTheme = vi.fn(async () => {
      currentPrefs = { ...basePrefs, theme: 'custom', customTheme: importedTheme };
    });

    const view = render(
      wrap(
        <TokensPanel
          preferences={currentPrefs}
          onUpdatePreferences={onUpdatePreferences}
          onImportCustomTheme={onImportCustomTheme}
          onExportCustomTheme={vi.fn().mockResolvedValue('{}')}
        />
      )
    );

    // 1) 先修改草稿（使 dirtyRef=true 并挂起 450ms 自动保存定时器）
    const bgInput = screen.getByLabelText('bgApp') as HTMLInputElement;
    fireEvent.change(bgInput, { target: { value: '#222222' } });
    expect(bgInput.value).toBe('#222222');

    // 2) 在防抖触发前导入新主题 JSON
    const fileInput = screen.getByTestId('import-theme-file-input') as HTMLInputElement;
    const jsonFile = new File([JSON.stringify(importedTheme)], 'midnight.json', { type: 'application/json' });
    Object.defineProperty(jsonFile, 'text', { value: async () => JSON.stringify(importedTheme) });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [jsonFile] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onImportCustomTheme).toHaveBeenCalledTimes(1);

    // 模拟 App 更新 preferences.customTheme 下发给 TokensPanel
    view.rerender(
      wrap(
        <TokensPanel
          preferences={currentPrefs}
          onUpdatePreferences={onUpdatePreferences}
          onImportCustomTheme={onImportCustomTheme}
          onExportCustomTheme={vi.fn().mockResolvedValue('{}')}
        />
      )
    );

    expect((screen.getByLabelText('bgApp') as HTMLInputElement).value).toBe('#101218');

    // 3) 立即卸载并推进定时器：绝不能把旧脏草稿 (#222222) 写回覆盖新导入主题
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onUpdatePreferences).not.toHaveBeenCalledWith(
      expect.objectContaining({
        customTheme: expect.objectContaining({
          tokens: expect.objectContaining({ bgApp: '#222222' }),
        }),
      })
    );
  });

  it('F-P1-9 (SettingsView 外部翻译)：带待钳制超时的保存保留已验证状态，且云端模式空 API Key 时禁用测试按钮', async () => {
    const fallback = getFallbackDesktopBridge();
    const boot = await fallback.getBootstrap();

    const testSpy = vi.fn().mockResolvedValue({
      ok: true,
      latencyMs: 95,
      sampleTranslation: '连接测试成功',
      verifiedAt: '2026-11-24T12:00:00.000Z',
    });
    const updateTranslationSpy = vi.fn(async (patch) => ({
      engine: patch.engine ?? 'local',
      externalTranslator: {
        ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
        ...patch.externalTranslator,
      },
    }));

    window.gravityDesktop = {
      ...fallback,
      testExternalTranslatorConnection: testSpy,
    };

    const baseSettingsProps = {
      section: 'general' as const,
      preferences: boot.preferences,
      connection: boot.connection,
      accounts: boot.accounts,
      approvalConfig: boot.approvalConfig,
      auditEntries: [],
      plugins: boot.plugins,
      rateCards: boot.telemetry.rateCards,
      updateState: boot.updateState!,
      onSectionChange: vi.fn(),
      onClose: vi.fn(),
      onUpdatePreferences: vi.fn().mockResolvedValue(undefined),
      onUpdateTranslationConfig: updateTranslationSpy,
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

    // 子用例 1：云端模式未填 API Key 时禁用测试按钮
    const emptyKeyConfig: TranslationConfig = {
      engine: 'local',
      externalTranslator: {
        ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: '',
      },
    };
    const viewEmpty = render(
      wrap(<SettingsView {...baseSettingsProps} translationConfig={emptyKeyConfig} focusExternalTranslatorSeq={1} />)
    );
    const testBtnEmpty = screen.getByTestId('test-translator-connection-btn') as HTMLButtonElement;
    expect(testBtnEmpty.disabled).toBe(true);
    viewEmpty.unmount();

    // 子用例 2：填入 API Key + 超出下限的 timeoutMs (50ms，不 blur) -> 测试通过 -> 保存后仍保持已连接/已验证状态
    const validKeyConfig: TranslationConfig = {
      engine: 'local',
      externalTranslator: {
        ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test-valid-key-1234567890',
        timeoutMs: 8000,
      },
    };
    render(
      wrap(<SettingsView {...baseSettingsProps} translationConfig={validKeyConfig} focusExternalTranslatorSeq={1} />)
    );

    const timeoutInput = screen.getByTestId('translator-timeout-input') as HTMLInputElement;
    fireEvent.change(timeoutInput, { target: { value: '50' } });

    const testBtn = screen.getByTestId('test-translator-connection-btn') as HTMLButtonElement;
    expect(testBtn.disabled).toBe(false);
    fireEvent.click(testBtn);

    await waitFor(() => expect(testSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('translator-test-result').textContent).toContain('测试通过'));

    // 勾选启用并保存，验证钳制 timeoutMs=100 后不会把 connectionStatus/verifiedBy 重置为 untested
    const enableSwitch = screen.getByTestId('translator-enable-switch') as HTMLInputElement;
    if (!enableSwitch.checked) {
      fireEvent.click(enableSwitch);
    }
    fireEvent.click(screen.getByTestId('save-translator-config-btn'));

    await waitFor(() => expect(updateTranslationSpy).toHaveBeenCalledTimes(1));
    const savedPatch = updateTranslationSpy.mock.calls[0][0];
    expect(savedPatch.externalTranslator?.connectionStatus).toBe('connected');
    expect(savedPatch.externalTranslator?.verifiedBy).toBe('translation-call');
    expect(savedPatch.externalTranslator?.timeoutMs).toBe(100);
    expect(screen.getByTestId('translator-connection-badge').textContent).toContain('已连接');
  });

  it('F-P1-10 (WorkspacePanels / PluginsPanel)：切换本地 Skill 开关时不自动展开无关的历史 lastCommandOutput', async () => {
    let resolveToggle!: () => void;
    const onToggleSkill = vi.fn(() => new Promise<void>((resolve) => { resolveToggle = resolve; }));
    const snapshot: PluginsManagerSnapshot = {
      builtins: GRAVITY_BUILTIN_CAPABILITIES,
      plugins: [],
      mcpServers: [],
      skills: [
        {
          id: 'sk-1',
          name: 'code-audit',
          description: 'Local code audit skill',
          scope: 'workspace',
          skillFilePath: 'F:\\Demo\\App\\.agents\\skills\\code-audit\\SKILL.md',
          enabled: true,
        },
      ],
      lastCommandOutput: 'agy plugin list\n[{"name":"stale-plugin"}]',
      refreshedAt: '2026-11-24T12:00:00.000Z',
    };

    render(
      wrap(
        <PluginsPanel
          snapshot={snapshot}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onRunPluginAction={vi.fn().mockResolvedValue(undefined)}
          onRunMcpAction={vi.fn().mockResolvedValue(undefined)}
          onToggleSkill={onToggleSkill}
        />
      )
    );

    fireEvent.click(screen.getByTestId('plugins-tab-skills'));
    const outputDetails = screen.getByTestId('plugins-last-command-output') as HTMLDetailsElement;
    expect(outputDetails.open).toBe(false);

    const skillRow = screen.getByTestId('skill-row-code-audit');
    const toggle = within(skillRow).getByRole('checkbox');
    fireEvent.click(toggle);

    await waitFor(() => expect(onToggleSkill).toHaveBeenCalledWith('sk-1', false));
    // 让 busy=true 完成一次提交后再结束操作，复现真实异步 IPC 周期
    await act(async () => {
      resolveToggle();
      await Promise.resolve();
    });
    expect(outputDetails.open).toBe(false);
  });

  it('F-P1-11 (RightInspector)：Terminal 面板通过 getCanonicalToolName 兜底识别未预规范化的 run_command 工具', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    render(
      wrap(
        <RightInspector
          collapsed={false}
          width={380}
          activeTab="terminal"
          focusedDiffFile={null}
          sessionId="sess-term"
          sessionMessages={[
            {
              id: 'm-bash',
              sessionId: 'sess-term',
              role: 'assistant',
              content: '已执行检查。',
              createdAt: '2026-11-24T12:00:00.000Z',
              toolCalls: [
                {
                  toolCallId: 'tc-raw-cmd',
                  rawToolName: 'run_command',
                  canonicalToolName: 'run_command',
                  compactTarget: 'npm run typecheck',
                  command: 'npm run typecheck',
                  status: 'completed',
                  argsSummary: '{"command":"npm run typecheck"}',
                  outputPreview: '0 errors',
                  exitCode: 0,
                  startedAt: '2026-11-24T12:00:00.000Z',
                  completedAt: '2026-11-24T12:00:01.000Z',
                },
              ],
            },
          ]}
          telemetry={boot.telemetry}
          onSelectTab={vi.fn()}
          onFocusDiffFile={vi.fn()}
          onCommitWidth={vi.fn()}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );

    const termView = screen.getByTestId('inspector-view-terminal');
    expect(termView.textContent).toContain('npm run typecheck');
  });

  it('F-P1-12 (ProjectSidebar)：子分支 error 状态冒泡至主条目状态点，且归档计数跟随搜索过滤实时更新', () => {
    const sessions: ManagedSessionSummary[] = [
      makeSession({
        sessionId: 's-root',
        title: '主对话分支',
        status: 'idle',
        branchCount: 2,
        activeBranchId: 's-child-err',
      }),
      makeSession({
        sessionId: 's-child-err',
        rootSessionId: 's-root',
        parentBranchId: 's-root',
        title: '报错子分支',
        status: 'error',
      }),
      makeSession({
        sessionId: 's-arch-1',
        title: 'Alpha 归档对话',
        archivedAt: '2026-11-20T10:00:00.000Z',
      }),
      makeSession({
        sessionId: 's-arch-2',
        title: 'Beta 归档对话',
        archivedAt: '2026-11-21T10:00:00.000Z',
      }),
    ];

    render(
      wrap(
        <ProjectSidebar
          collapsed={false}
          width={264}
          sessions={sessions}
          openTabSessionIds={['s-child-err']}
          selectedSessionId="s-child-err"
          hideLegacyPollutionSessions={true}
          organizingTitles={false}
          onToggleCollapse={vi.fn()}
          onSelectSession={vi.fn()}
          onOpenNewSession={vi.fn()}
          onOrganizeTitles={vi.fn().mockResolvedValue(undefined)}
          onTogglePollutionVisibility={vi.fn().mockResolvedValue(undefined)}
          onRenameSession={vi.fn().mockResolvedValue(undefined)}
          onTogglePinSession={vi.fn().mockResolvedValue(undefined)}
        />
      )
    );

    // 1) 子分支 error 冒泡至主条目状态点
    const rootItem = screen.getByTestId('sidebar-session-s-root');
    expect(rootItem.querySelector('.status-dot.is-error')).toBeTruthy();

    // 2) 归档区计数随搜索词变化（从 2 -> 1）
    const archivedDetails = screen.getByTestId('archived-sessions');
    expect(archivedDetails.querySelector('summary')?.textContent).toContain('2');

    fireEvent.change(screen.getByTestId('sidebar-search-input'), { target: { value: 'Alpha' } });
    expect(archivedDetails.querySelector('summary')?.textContent).toMatch(/1\s*\/\s*2|·\s*1\b/);
    expect(archivedDetails.querySelectorAll('[data-testid^="archived-session-"]').length).toBe(1);
  });

  it('F-P1-13 (SwarmPanel)：killed 与 stopped 状态成员绝不使用活跃态 badge-accent', () => {
    const topology: SwarmTopologyState = {
      sessionId: 'sess-swarm',
      isActive: true,
      swarmTitle: 'Wave 1 并行测试',
      channels: ['main'],
      workers: [
        {
          id: 'w-work',
          name: 'worker-active',
          role: 'Active Worker',
          kind: 'swarm-worker',
          model: 'gemini-4-neon',
          status: 'working',
          workspaceMode: 'share',
          channels: ['main'],
          brief: 'Running tasks',
          startedAt: '2026-11-24T12:00:00.000Z',
          updatedAt: '2026-11-24T12:00:00.000Z',
        },
        {
          id: 'w-kill',
          name: 'worker-killed',
          role: 'Terminated Worker',
          kind: 'swarm-worker',
          model: 'gemini-4-neon',
          status: 'killed',
          workspaceMode: 'share',
          channels: ['main'],
          brief: 'Already terminated',
          startedAt: '2026-11-24T12:00:00.000Z',
          updatedAt: '2026-11-24T12:01:00.000Z',
        },
        {
          id: 'w-stop',
          name: 'worker-stopped',
          role: 'Stopped Worker',
          kind: 'swarm-worker',
          model: 'gemini-4-neon',
          status: 'stopped',
          workspaceMode: 'inherit',
          channels: ['main'],
          brief: 'Stopped worker',
          startedAt: '2026-11-24T12:00:00.000Z',
          updatedAt: '2026-11-24T12:01:00.000Z',
        },
      ],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 3, working: 1, waiting: 0, completed: 0, killed: 1 },
      updatedAt: '2026-11-24T12:01:00.000Z',
    };

    render(wrap(<SwarmPanel sessionId="sess-swarm" topology={topology} />));

    for (const workerName of ['worker-killed', 'worker-stopped']) {
      const card = screen.getByTestId(`swarm-worker-${workerName}`);
      const headBadges = Array.from(card.querySelectorAll('.worker-head .badge'));
      const statusBadge = headBadges[headBadges.length - 1];
      expect(statusBadge).toBeTruthy();
      expect(statusBadge.className).not.toContain('badge-accent');
    }
  });

  it('F-P1-14 (ContextCostInspectorView)：关闭最后一个活跃会话（sessionId 变为 null）时范围自动从 session 重置回 today', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const view = render(
      wrap(
        <ContextCostInspectorView
          sessionId="sess-primary"
          dashboard={boot.telemetry}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );

    expect(screen.getByTestId('cost-scope-session').className).toContain('is-active');

    view.rerender(
      wrap(
        <ContextCostInspectorView
          sessionId={null}
          dashboard={boot.telemetry}
          onOpenRateCardsSettings={vi.fn()}
        />
      )
    );

    await waitFor(() => {
      expect(screen.getByTestId('cost-scope-today').className).toContain('is-active');
      expect(screen.getByTestId('cost-scope-session').className).not.toContain('is-active');
    });
  });

  it('F-P1-15 (AccountQuotaView)：en-US 模式下读取额度报错保留具体错误原因，不丢弃错误详情', async () => {
    const profileId = 'quota-err-en-' + Date.now();
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getAccountQuota: vi.fn().mockRejectedValue(new Error('PowerShell execution policy blocked script')),
    };

    render(wrap(<AccountQuotaFooter profileId={profileId} />, 'en-US'));
    fireEvent.click(screen.getByTestId('quota-weekly'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('PowerShell execution policy blocked script');
  });

  it('F-P1-16a (TopBar)：Tab 支持键盘聚焦与 Enter/Space 选中，中键关闭调用 preventDefault', () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const layout: WorkspaceLayoutState = {
      openTabSessionIds: ['s1'],
      activePrimarySessionId: 's1',
      splitSecondarySessionId: null,
      layoutMode: 'single',
      hideLegacyPollutionSessions: true,
      leftSidebarCollapsed: false,
      leftSidebarWidth: 264,
      rightInspectorCollapsed: false,
      rightInspectorWidth: 380,
      activeInspectorTab: 'diff',
    };
    render(
      wrap(
        <TopBar
          sessions={[makeSession({ sessionId: 's1', title: 'Tab One' })]}
          layout={layout}
          focusedSessionId="s1"
          pendingApprovals={[]}
          onToggleRightInspector={vi.fn()}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onOpenNewSessionModal={vi.fn()}
          onChangeLayoutMode={vi.fn()}
        />
      )
    );
    const tab = screen.getByTestId('tab-item-s1');
    expect(tab.tabIndex).toBe(0);
    fireEvent.keyDown(tab, { key: 'Enter' });
    expect(onSelectTab).toHaveBeenCalledWith('s1');
    const midClickEvent = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    tab.dispatchEvent(midClickEvent);
    expect(midClickEvent.defaultPrevented).toBe(true);
    expect(onCloseTab).toHaveBeenCalledWith('s1');
  });

  it('F-P1-16b (TitleOrganizerModal)：空闲按 Esc 关闭；整理运行中按 Esc 或点击遮罩禁止关闭', async () => {
    const onCloseOrg = vi.fn();
    let resolveOrg!: () => void;
    const onRunOrganize = vi.fn(() => new Promise<void>((r) => { resolveOrg = r; }));
    render(
      wrap(
        <TitleOrganizerModal
          open={true}
          result={{ updatedCount: 1, hiddenPollutionCount: 0, suggestions: [] }}
          onClose={onCloseOrg}
          onRunOrganize={onRunOrganize}
        />
      )
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseOrg).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /重新整理/ }));
    expect(onRunOrganize).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('organize-modal-backdrop'));
    expect(onCloseOrg).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOrg();
      await Promise.resolve();
    });
  });

  it('F-P1-16c (NewSessionModal)：重开重置标题草稿，快速存项目防双击锁且回车不误提交新建会话表单', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    let resolveSaveProj!: () => void;
    const onSaveProject = vi.fn(() => new Promise<void>((r) => { resolveSaveProj = r; }));
    const modalProps = {
      defaultCwd: 'F:\\Demo\\FreshRepo',
      onClose: vi.fn(),
      onCreate,
      onSaveProject,
    };
    const modalView = render(wrap(<NewSessionModal {...modalProps} open={true} />));
    const titleInput = screen.getByTestId('new-session-title-input') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '未提交旧标题草稿' } });
    expect(titleInput.value).toBe('未提交旧标题草稿');

    modalView.rerender(wrap(<NewSessionModal {...modalProps} open={false} />));
    modalView.rerender(wrap(<NewSessionModal {...modalProps} open={true} />));
    expect((screen.getByTestId('new-session-title-input') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByTestId('new-session-save-project-toggle'));
    const quickNameInput = screen.getByTestId('quick-save-project-name');
    fireEvent.change(quickNameInput, { target: { value: 'Fresh Repo' } });
    fireEvent.keyDown(quickNameInput, { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();

    const saveProjBtn = screen.getByTestId('quick-save-project-confirm');
    fireEvent.click(saveProjBtn);
    fireEvent.click(saveProjBtn);
    expect(onSaveProject).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSaveProj();
      await Promise.resolve();
    });
  });

  it('F-P2-1 (ResizeHandle)：拖拽中组件卸载必须清理 body.gv-resizing 与全局 mousemove 监听', () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const resizeView = render(
      <ResizeHandle
        value={264}
        min={200}
        max={500}
        defaultValue={264}
        label="Resize sidebar"
        testId="qa-resize-handle"
        onPreview={onPreview}
        onCommit={onCommit}
      />
    );
    fireEvent.mouseDown(screen.getByTestId('qa-resize-handle'), { button: 0, clientX: 264 });
    expect(document.body.classList.contains('gv-resizing')).toBe(true);

    resizeView.unmount();
    expect(document.body.classList.contains('gv-resizing')).toBe(false);

    onPreview.mockClear();
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(onPreview).not.toHaveBeenCalled();
  });
});

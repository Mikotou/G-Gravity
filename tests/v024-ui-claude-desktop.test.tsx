import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { SettingsView } from '../src/renderer/components/SettingsView';
import { ThinkingBlock } from '../src/renderer/components/ThinkingBlock';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type {
  ApprovalReviewingEvent,
  ApproveForMeConfig,
  DualTrackThoughtBlock,
  GravityDesktopBridge,
  PendingApprovalRequest,
  PluginsManagerSnapshot,
  RevokeSessionApprovalGrantInput,
  SessionApprovalGrantsSnapshot,
} from '../src/shared';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function stripIntentionalLanguageNames(text: string): string {
  // Language switcher & Chinese thought-track toggle intentionally show native Chinese label ("中文" / "简体中文")
  return text.replace(/简体中文|中文/g, '');
}

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  delete document.documentElement.dataset.windowChrome;
  window.localStorage.removeItem('gravity.thoughts.expanded');
  resetFallbackDesktopBridge();
  vi.restoreAllMocks();
});

describe('v0.2.4 Claude Code Desktop UI & Codex Guardian Interaction Gates', () => {
  it('1) Welcome canvas (empty-pane-0) renders welcome-quick-composer-input, creates session & sends first prompt on Enter, while keeping composer-input-<id> absent when 0 tabs open', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    const createdSession = {
      ...baseBoot.sessions[1],
      sessionId: 'sess-welcome-created',
      title: 'Hello Gravity v0.2.4',
      status: 'idle' as const,
    };

    const createSession = vi.fn().mockResolvedValue(createdSession);
    const sendPrompt = vi.fn().mockResolvedValue(undefined);

    const bridge: GravityDesktopBridge = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: { ...baseBoot.preferences, locale: 'en-US' },
        layout: {
          ...baseBoot.layout,
          openTabSessionIds: [],
          activePrimarySessionId: null,
          splitSecondarySessionId: null,
        },
        pendingApprovals: [],
      }),
      createSession,
      sendPrompt,
    };
    window.gravityDesktop = bridge;

    const { container } = render(<App />);
    await screen.findByTestId('empty-pane-0');

    // No session composer-input-<id> should exist while 0 tabs are open
    expect(container.querySelector('[data-testid^="composer-input-"]')).toBeNull();

    const quickInput = screen.getByTestId('welcome-quick-composer-input') as HTMLInputElement | HTMLTextAreaElement;
    fireEvent.change(quickInput, { target: { value: 'Hello Gravity v0.2.4' } });
    const notPrevented = fireEvent.keyDown(quickInput, { key: 'Enter', code: 'Enter' });
    if (notPrevented && quickInput.closest('form')) {
      fireEvent.submit(quickInput.closest('form')!);
    }

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-welcome-created',
          text: 'Hello Gravity v0.2.4',
        })
      );
    });
  });

  it('2) Live Stage 2 reviewing card (approval-reviewing-card-<id>) renders on onApprovalReviewing and clicking btn-cancel-stage2-<id> invokes cancelStage2ApprovalReview', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();
    let reviewingListener: ((event: ApprovalReviewingEvent) => void) | undefined;
    const cancelStage2ApprovalReview = vi.fn().mockResolvedValue({ cancelled: true });

    const bridge: GravityDesktopBridge = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: { ...baseBoot.preferences, locale: 'en-US' },
        pendingApprovals: [],
      }),
      onApprovalReviewing: (cb) => {
        reviewingListener = cb;
        return () => {
          reviewingListener = undefined;
        };
      },
      cancelStage2ApprovalReview,
    };
    window.gravityDesktop = bridge;

    render(<App />);
    await screen.findByTestId('session-pane-sess-primary');
    await waitFor(() => expect(reviewingListener).toBeTypeOf('function'));

    act(() => {
      reviewingListener!({
        requestId: 'req-live-s2',
        sessionId: 'sess-primary',
        toolCallId: 'tc-live-s2',
        toolName: 'run_command',
        commandPreview: 'npm run build',
        provider: 'openai-compatible',
        model: 'gpt-6.2-astra',
        status: 'reviewing',
        startedAt: new Date().toISOString(),
      });
    });

    const card = await screen.findByTestId('approval-reviewing-card-req-live-s2');
    expect(card.textContent).toMatch(/gpt-6\.2-astra|npm run build/);

    const cancelBtn = screen.getByTestId('btn-cancel-stage2-req-live-s2');
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(cancelStage2ApprovalReview).toHaveBeenCalledWith('req-live-s2'));

    act(() => {
      reviewingListener!({
        requestId: 'req-live-s2',
        sessionId: 'sess-primary',
        toolCallId: 'tc-live-s2',
        toolName: 'run_command',
        commandPreview: 'npm run build',
        provider: 'openai-compatible',
        model: 'gpt-6.2-astra',
        status: 'cancelled',
        startedAt: new Date().toISOString(),
        elapsedMs: 420,
      });
    });

    await waitFor(() => expect(screen.queryByTestId('approval-reviewing-card-req-live-s2')).toBeNull());
  });

  it('3) Stage 3 InlineRequestView displays risk-score-<id> and intent-alignment-<id> badges while preserving 1.-4. shortcuts', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const request: PendingApprovalRequest = {
      requestId: 'req-guardian-badge',
      sessionId: 'sess-primary',
      toolCallId: 'tc-guardian-badge',
      toolName: 'run_command',
      commandOrSummary: 'git push origin feature/v024',
      cwd: 'C:\\Work\\G-Gravity',
      createdAt: '2026-11-23T08:00:00.000Z',
      riskLevel: 'high',
      commandPrefix: 'git push',
      screeningSource: 'ai-reviewer-fallback',
      explanation: {
        meaning: 'Push local commits to remote branch feature/v024',
        target: 'Workspace: C:\\Work\\G-Gravity',
        risk: 'Modifies remote repository state',
      },
      aiSuggestion: {
        recommended: 'ask',
        reason: 'Remote push requires human confirmation',
        latencyMs: 260,
        model: 'gpt-6.2-astra',
        isError: false,
        riskScore: 74,
        intentAlignment: 'uncertain',
      },
    };

    render(
      <I18nProvider locale="en-US" onChangeLocale={() => {}}>
        <InlineRequestView request={request} enableNumericShortcuts onSubmitDecision={onSubmit} />
      </I18nProvider>
    );

    const riskScoreBadge = screen.getByTestId('risk-score-req-guardian-badge');
    expect(riskScoreBadge.textContent).toContain('74');

    const alignmentBadge = screen.getByTestId('intent-alignment-req-guardian-badge');
    expect(alignmentBadge.textContent?.trim()).toBeTruthy();

    // 1.-4. numbered labels and keyboard shortcuts remain intact
    expect(screen.getByTestId('btn-allow-once-req-guardian-badge').textContent).toContain('1. Yes');
    expect(screen.getByTestId('btn-allow-prefix-req-guardian-badge').textContent).toContain("2. Yes, and don't ask again for git push");
    expect(screen.getByTestId('btn-approve-for-me-req-guardian-badge').textContent).toContain('3. Approve for me');
    expect(screen.getByTestId('btn-reject-feedback-req-guardian-badge').textContent).toContain('4. No, and tell Gravity what to do differently');

    fireEvent.keyDown(window, { key: '1' });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: 'req-guardian-badge',
        sessionId: 'sess-primary',
        decision: 'allow_once',
      })
    );

    onSubmit.mockClear();
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: 'req-guardian-badge',
        sessionId: 'sess-primary',
        decision: 'allow_session_prefix',
        allowedPrefix: 'git push',
      })
    );

    onSubmit.mockClear();
    fireEvent.keyDown(window, { key: '3' });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: 'req-guardian-badge',
        sessionId: 'sess-primary',
        decision: 'approve_for_me_ai',
      })
    );

    fireEvent.keyDown(window, { key: '4' });
    expect(screen.getByTestId('reject-feedback-box-req-guardian-badge')).toBeTruthy();
  });

  it('4) Composer approval popover lists active prefixes from listSessionApprovalGrants and revokes single prefix (btn-revoke-prefix-0) and delegation (btn-revoke-delegation)', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();

    let grantsSnapshot: SessionApprovalGrantsSnapshot = {
      sessionId: 'sess-primary',
      workspaceKey: 'C:\\Workspace\\DemoProject',
      delegatedToGuardian: true,
      delegatedAt: '2026-11-23T08:00:00.000Z',
      prefixes: [
        { prefix: 'npm test', grantedAt: '2026-11-23T08:01:00.000Z', hitCount: 3 },
        { prefix: 'git status', grantedAt: '2026-11-23T08:02:00.000Z', hitCount: 1 },
      ],
    };

    const listSessionApprovalGrants = vi.fn(async (_sessionId: string) => structuredClone(grantsSnapshot));
    const revokeSessionApprovalGrant = vi.fn(async (input: RevokeSessionApprovalGrantInput) => {
      if (input.prefix) {
        grantsSnapshot = {
          ...grantsSnapshot,
          prefixes: grantsSnapshot.prefixes.filter((p) => p.prefix !== input.prefix),
        };
      }
      if (input.revokeDelegation) {
        grantsSnapshot = {
          ...grantsSnapshot,
          delegatedToGuardian: false,
          delegatedAt: undefined,
        };
      }
      return structuredClone(grantsSnapshot);
    });

    const bridge: GravityDesktopBridge = {
      ...fallback,
      getBootstrap: async () => ({
        ...baseBoot,
        preferences: { ...baseBoot.preferences, locale: 'en-US' },
        sessions: baseBoot.sessions.map((s) =>
          s.sessionId === 'sess-primary'
            ? { ...s, hasApprovalGrants: true, approvalModeOverride: 'hybrid' }
            : s
        ),
        pendingApprovals: [],
      }),
      listSessionApprovalGrants,
      revokeSessionApprovalGrant,
    };
    window.gravityDesktop = bridge;

    render(<App />);
    const modePill = await screen.findByTestId('approval-mode-pill-sess-primary');
    fireEvent.click(modePill);

    const popover = await screen.findByTestId('approval-menu-sess-primary');
    await waitFor(() => expect(listSessionApprovalGrants).toHaveBeenCalledWith('sess-primary'));
    await waitFor(() => {
      expect(popover.textContent).toContain('npm test');
      expect(popover.textContent).toContain('git status');
    });

    const revokeFirstPrefixBtn = await screen.findByTestId('btn-revoke-prefix-0');
    fireEvent.click(revokeFirstPrefixBtn);
    await waitFor(() =>
      expect(revokeSessionApprovalGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-primary',
          prefix: 'npm test',
        })
      )
    );

    const revokeDelegationBtn = await screen.findByTestId('btn-revoke-delegation');
    fireEvent.click(revokeDelegationBtn);
    await waitFor(() =>
      expect(revokeSessionApprovalGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-primary',
          revokeDelegation: true,
        })
      )
    );
  });

  it('5) ThinkingBlock bidirectionally persists thoughtExpandedByDefault (false on collapse AND true on re-expand)', async () => {
    const fallback = getFallbackDesktopBridge();
    const basePrefs = (await fallback.getBootstrap()).preferences;
    const updatePreferences = vi.fn(async (patch) => ({ ...basePrefs, ...patch }));
    window.gravityDesktop = {
      ...fallback,
      updatePreferences,
    };

    const thought: DualTrackThoughtBlock = {
      id: 'th-bidir',
      originalText: 'Analyze the workspace layout and verify bidirectional persistence.',
      translatedZhText: '分析工作区布局并验证双向持久化。',
      isStreaming: false,
      languageDetected: 'en',
      translationSource: 'original',
    };

    render(
      <I18nProvider locale="en-US" onChangeLocale={() => {}}>
        <ThinkingBlock thought={thought} defaultTrack="raw" />
      </I18nProvider>
    );

    const toggleHeader = screen.getByTestId('thinking-block-th-bidir').querySelector('.cc-thinking-head') as HTMLElement;
    expect(toggleHeader).toBeTruthy();
    expect(screen.getByTestId('thought-content-th-bidir')).toBeTruthy();

    // Collapse -> persists thoughtExpandedByDefault: false
    fireEvent.click(toggleHeader);
    expect(screen.queryByTestId('thought-content-th-bidir')).toBeNull();
    expect(window.localStorage.getItem('gravity.thoughts.expanded')).toBe('false');
    await waitFor(() =>
      expect(updatePreferences).toHaveBeenCalledWith({ thoughtExpandedByDefault: false })
    );

    // Re-expand -> MUST persist thoughtExpandedByDefault: true
    updatePreferences.mockClear();
    fireEvent.click(toggleHeader);
    expect(screen.getByTestId('thought-content-th-bidir')).toBeTruthy();
    expect(window.localStorage.getItem('gravity.thoughts.expanded')).not.toBe('false');
    await waitFor(() =>
      expect(updatePreferences).toHaveBeenCalledWith({ thoughtExpandedByDefault: true })
    );
  });

  it('6) en-US Settings (General, ApprovalsPanel, PluginsPanel) contain zero unexpected CJK characters', async () => {
    const fallback = getFallbackDesktopBridge();
    const baseBoot = await fallback.getBootstrap();

    const enApprovalConfig: ApproveForMeConfig = {
      mode: 'rules-only',
      enableSafeDownloadAutoApprove: false,
      maxDownloadSizeMB: 50,
      cacheTtlHours: 24,
      allowPatterns: ['^git status$'],
      askPatterns: ['^git push'],
      denyPatterns: ['rm -rf /'],
      externalReviewer: {
        enabled: true,
        provider: 'gemini-api-key',
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'gemini-3.5-flash-lite',
        apiKey: 'AIzaSyEnglishLocaleCheck1234',
        timeoutMs: 8000,
        maxOutputTokens: 4096,
        thinkingLevel: 'auto',
        connectionStatus: 'connected',
        verificationMethod: 'review-call',
        lastVerifiedAt: '2026-11-23T00:00:00.000Z',
      },
    };

    const enPlugins: PluginsManagerSnapshot = {
      builtins: baseBoot.plugins.builtins,
      plugins: [
        {
          name: 'chrome-devtools-plugin',
          version: '1.2.0',
          enabled: true,
          description: 'Chrome DevTools debugging integration',
          marketplace: 'official',
        },
      ],
      mcpServers: [
        {
          name: 'gemini-api-docs',
          type: 'stdio',
          commandOrUrl: 'npx',
          args: ['-y', '@google/gemini-docs-mcp'],
          enabled: true,
          status: 'ready',
        },
      ],
      skills: [
        {
          id: 'skill-en-1',
          name: 'antigravity-guide',
          description: 'Comprehensive guide for ACP and CLI customizations',
          scope: 'global',
          skillFilePath: 'builtin/skills/antigravity_guide/SKILL.md',
          enabled: true,
        },
      ],
      sectionErrors: {
        plugins: 'Partial refresh warning: registry timed out',
      },
      refreshedAt: '2026-11-23T08:00:00.000Z',
    };

    const enAuditEntries = [
      {
        id: 'audit-en-1',
        timestamp: '2026-11-23T08:00:00.000Z',
        sessionId: 'sess-primary',
        cwd: 'C:\\Work\\G-Gravity',
        toolName: 'run_command',
        commandOrSummary: 'git status --short',
        modeAtDecision: 'rules-only' as const,
        verdict: 'auto_approved' as const,
        decisionSource: 'local-rule' as const,
        riskLevel: 'safe' as const,
        latencyMs: 1,
        reason: 'Matched read-only allowlist rule',
      },
    ];

    function renderSettings(section: 'general' | 'approvals' | 'plugins') {
      return render(
        <I18nProvider locale="en-US" onChangeLocale={() => {}}>
          <SettingsView
            section={section}
            preferences={{ ...baseBoot.preferences, locale: 'en-US' }}
            connection={baseBoot.connection}
            accounts={baseBoot.accounts}
            approvalConfig={enApprovalConfig}
            translationConfig={baseBoot.translationConfig}
            auditEntries={enAuditEntries}
            plugins={enPlugins}
            rateCards={baseBoot.telemetry.rateCards}
            updateState={baseBoot.updateState!}
            onSectionChange={() => {}}
            onClose={() => {}}
            onUpdatePreferences={async () => {}}
            onUpdateTranslationConfig={async () => {}}
            onCheckUpdates={async () => {}}
            onDownloadUpdate={async () => {}}
            onInstallUpdate={async () => {}}
            onSetAppIcon={async () => {}}
            onImportCustomTheme={async () => {}}
            onExportCustomTheme={async () => '{}'}
            onUpdateRateCards={async () => {}}
            onCreateProfile={async () => {}}
            onSwitchProfile={async () => {}}
            onDeleteProfile={async () => {}}
            onLaunchLogin={async () => {}}
            onLogout={async () => {}}
            onUpdateApprovalConfig={async () => {}}
            onRefreshPlugins={async () => {}}
            onRunPluginAction={async () => {}}
            onRunMcpAction={async () => {}}
            onToggleSkill={async () => {}}
          />
        </I18nProvider>
      );
    }

    // 6A: General panel (including expanded external translator card)
    const generalView = renderSettings('general');
    fireEvent.click(screen.getByTestId('external-translator-expand-btn'));
    const generalText = stripIntentionalLanguageNames(generalView.container.textContent || '');
    expect(generalText, 'Unexpected CJK leaked in en-US General settings').not.toMatch(CJK_RE);
    cleanup();

    // 6B: ApprovalsPanel across all 3 sub-tabs (rules, audit, reviewer — including mode-mismatch banner & thinking default)
    const approvalsView = renderSettings('approvals');
    for (const tab of ['rules', 'audit', 'reviewer'] as const) {
      fireEvent.click(screen.getByTestId(`drawer-tab-${tab}`));
      const tabText = stripIntentionalLanguageNames(approvalsView.container.textContent || '');
      expect(tabText, `Unexpected CJK leaked in en-US ApprovalsPanel (${tab} tab)`).not.toMatch(CJK_RE);
    }
    cleanup();

    // 6C: PluginsPanel across all 4 sub-tabs (builtins, plugins, mcp, skills)
    const pluginsView = renderSettings('plugins');
    for (const tab of ['builtins', 'plugins', 'mcp', 'skills'] as const) {
      fireEvent.click(screen.getByTestId(`plugins-tab-${tab}`));
      const tabText = stripIntentionalLanguageNames(pluginsView.container.textContent || '');
      expect(tabText, `Unexpected CJK leaked in en-US PluginsPanel (${tab} tab)`).not.toMatch(CJK_RE);
    }
  });
});

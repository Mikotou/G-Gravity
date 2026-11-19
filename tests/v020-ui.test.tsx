import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { AccountQuotaFooter } from '../src/renderer/components/AccountQuotaView';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { ContextStatusBar } from '../src/renderer/components/ContextStatusBar';
import { ImageSessionContext, ImageWorkspace, MessageImage } from '../src/renderer/components/MessageImage';
import { ProjectSidebar } from '../src/renderer/components/ProjectSidebar';
import { ThinkingBlock } from '../src/renderer/components/ThinkingBlock';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { DualTrackThoughtBlock, ManagedSessionSummary, TitleOrganizeRequest } from '../src/shared';

beforeEach(() => {
  delete window.agyDesktop;
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.agyDesktop;
  delete window.gravityDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const wrap = (child: React.ReactNode) => (
  <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
    {child}
  </I18nProvider>
);

describe('v0.2.0 前端交互与视觉契约', () => {
  it('1) 右下角额度显示百分比 + 进度条，删除左侧独立额度入口并重设计弹层', async () => {
    const bridge = getFallbackDesktopBridge();
    window.gravityDesktop = {
      ...bridge,
      getAccountQuota: vi.fn().mockResolvedValue({
        profileId: 'v020-quota-ui',
        plan: 'Pro',
        checkedAt: '2026-11-19T12:00:00.000Z',
        buckets: [
          { id: 'gemini-weekly', remainingFraction: 0.925, resetAt: '2026-11-26T00:00:00.000Z' },
          { id: 'gemini-5h', remainingFraction: 1, resetAt: '2026-11-19T17:00:00.000Z' },
          { id: '3p-weekly', remainingFraction: 0.15, resetAt: '2026-11-26T00:00:00.000Z' },
          { id: '3p-5h', remainingFraction: 0 },
        ],
      }),
    };

    render(wrap(<AccountQuotaFooter profileId="v020-quota-ui"><span>CTX</span></AccountQuotaFooter>));

    expect(screen.queryByTestId('quota-trigger')).toBeNull();
    const weeklyBtn = screen.getByTestId('quota-weekly');
    const miniBar = screen.getByTestId('quota-weekly-bar');
    expect(miniBar).toBeTruthy();

    await waitFor(() => expect(weeklyBtn.textContent).toContain('92.5%'));
    expect(miniBar.getAttribute('data-quota-level')).toBe('high');

    fireEvent.click(weeklyBtn);
    const details = await screen.findByTestId('quota-details');
    expect(details.textContent).toContain('Pro');
    expect(details.querySelectorAll('[data-testid="quota-bucket"]')).toHaveLength(4);
    expect(details.querySelectorAll('progress.quota-progress')).toHaveLength(4);
  });

  it('2) Context 窗口显示会话平均 TPS 与平均缓存命中率，对话框底部显示实时 TPS', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const tele = {
      ...boot.telemetry.activeSessions['sess-primary'],
      currentTokensPerSecond: 112.4,
      averageTokensPerSecond: 64.5,
      averageCacheHitRate: 0.425,
    };
    const dashboard = {
      ...boot.telemetry,
      activeSessions: { ...boot.telemetry.activeSessions, 'sess-primary': tele },
    };

    render(
      wrap(
        <>
          <ContextStatusBar
            sessionId="sess-primary"
            sessionTelemetry={tele}
            onCompactContext={async () => {}}
            onOpenContextInspector={() => {}}
          />
          <ContextCostInspectorView
            sessionId="sess-primary"
            dashboard={dashboard}
            onOpenRateCardsSettings={() => {}}
          />
        </>
      )
    );

    expect(screen.getByTestId('composer-realtime-tps-sess-primary').textContent).toContain('112.4 tok/s');
    expect(screen.getByTestId('context-avg-tps').textContent).toContain('64.5 tok/s');
    expect(screen.getByTestId('context-cache-hit-rate').textContent).toContain('42.5%');
  });

  it('3) 侧栏提供全部/项目/单会话三个整理按钮、Hydrogen (medium) 运行提示及共享冷却锁定', async () => {
    const calls: Array<TitleOrganizeRequest | undefined> = [];
    const onOrganize = vi.fn(async (req?: TitleOrganizeRequest) => {
      calls.push(req);
    });
    const sessions: ManagedSessionSummary[] = [
      {
        sessionId: 's1',
        cwd: 'F:\\DemoProj',
        rawCwd: 'F:\\DemoProj',
        title: '调试接口超时',
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'idle',
        modelId: 'gemini-4-carbon',
        executionMode: 'default',
        reasoningEffort: 'high',
        originKind: 'acp-live',
        readOnly: false,
        profileId: 'default',
        updatedAt: '2026-11-19T12:00:00.000Z',
      },
    ];

    const baseProps = {
      collapsed: false,
      width: 264,
      sessions,
      importedHistory: [],
      openTabSessionIds: ['s1'],
      selectedSessionId: 's1',
      selectedHistoryId: null,
      hideLegacyPollutionSessions: true,
      organizingTitles: false,
      onToggleCollapse: () => {},
      onSelectSession: () => {},
      onSelectHistory: () => {},
      onOpenNewSession: () => {},
      onOrganizeTitles: onOrganize,
      onTogglePollutionVisibility: async () => {},
      onRenameSession: async () => {},
      onTogglePinSession: async () => {},
    };

    const view = render(wrap(<ProjectSidebar {...baseProps} />));
    fireEvent.click(screen.getByTestId('btn-organize-titles'));
    fireEvent.click(screen.getByTestId('organize-project-F:\\DemoProj'));
    fireEvent.click(screen.getByTestId('organize-session-s1'));

    expect(calls).toEqual([
      { scope: 'all' },
      { scope: 'project', projectCwd: 'F:\\DemoProj', sessionIds: ['s1'] },
      { scope: 'session', sessionIds: ['s1'] },
    ]);

    // 整理中提示当前使用内置模型 Hydrogen (medium)
    view.rerender(wrap(<ProjectSidebar {...baseProps} organizingTitles organizingTarget="session:s1" />));
    expect(screen.getByTestId('organize-model-status').textContent).toContain('Hydrogen (medium)');
    expect((screen.getByTestId('btn-organize-titles') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('organize-project-F:\\DemoProj') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('organize-session-s1') as HTMLButtonElement).disabled).toBe(true);

    // 冷却状态下三个按钮共享禁用与倒计时展示
    view.rerender(wrap(<ProjectSidebar {...baseProps} organizeCooldownSec={38} organizeQuotaLeft={0} />));
    expect(screen.getByTestId('organize-model-status').textContent).toContain('38s');
    expect((screen.getByTestId('btn-organize-titles') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('organize-project-F:\\DemoProj') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('organize-session-s1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('4) 正文末尾图片支持缩略图悬浮复制、大图工具栏复制及快捷键 Ctrl+C，且首按钮保持关闭预览', async () => {
    const openSpy = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'copy-image', resolvedTarget: 'F:\\proj\\out.png' });
    const bridge = getFallbackDesktopBridge();
    window.gravityDesktop = { ...bridge, openLinkOrFileTarget: openSpy };

    render(
      wrap(
        <ImageSessionContext.Provider value="sess-img">
          <ImageWorkspace.Provider value={'F:\\proj'}>
            <MessageImage source="./out.png" alt="生成结果" />
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>
      )
    );

    fireEvent.click(screen.getByTestId('copy-message-image-btn'));
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'copy-image', cwd: 'F:\\proj', sessionId: 'sess-img' })
      )
    );

    // 打开大图预览，点击复制按钮与 Ctrl+C
    fireEvent.click(screen.getByRole('button', { name: '生成结果' }));
    const copyInLightbox = screen.getByTestId('lightbox-copy-image-btn');
    fireEvent.click(copyInLightbox);
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(3));

    // 第一个 button 仍是关闭按钮（保障旧回归测试与键盘焦点兼容）
    fireEvent.click(document.querySelector('dialog button')!);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('5) 思考片段英文原位切换为更短中文译文时平滑推进显影，不跳切且不破坏段落 DOM 稳定性', () => {
    vi.useFakeTimers();
    const english: DualTrackThoughtBlock = {
      id: 'morph-zh',
      originalText: 'Analyzing the entire workspace architecture and checking all module boundaries carefully.',
      translatedZhText: '',
      languageDetected: 'en',
      translationSource: 'pending',
      isStreaming: true,
      isTranslating: true,
    };
    const view = render(wrap(<ThinkingBlock thought={english} defaultTrack="zh" forceAnimation />));
    act(() => { vi.advanceTimersByTime(1500); });
    const body = screen.getByTestId('thought-content-morph-zh');
    expect(body.textContent).toContain('Analyzing');

    // 译文到达（中文字符长度明显短于英文原文）：morph 模式应从公共前缀 0 处渐进显影而非一帧瞬切
    const chinese: DualTrackThoughtBlock = {
      ...english,
      translatedZhText: '正在分析整个工作区架构并仔细核对各模块边界。',
      translationSource: 'local-model',
    };
    view.rerender(wrap(<ThinkingBlock thought={chinese} defaultTrack="zh" forceAnimation />));
    act(() => { vi.advanceTimersByTime(64); });
    const midLen = (body.textContent || '').length;
    expect(midLen).toBeGreaterThan(0);
    expect(midLen).toBeLessThan(chinese.translatedZhText.length);

    // 完整显影后收口，innerHTML 保持完全一致
    act(() => { vi.advanceTimersByTime(1400); });
    expect(body.textContent).toBe(chinese.translatedZhText);
    const settledHtml = body.innerHTML;
    view.rerender(wrap(<ThinkingBlock thought={{ ...chinese, isStreaming: false, isTranslating: false }} defaultTrack="zh" forceAnimation />));
    expect(body.innerHTML).toBe(settledHtml);
  });

  it('6) App 集成：点击全部整理弹出模型提示并在弹窗展示 Hydrogen (medium) 徽章', async () => {
    render(<App />);
    await screen.findByTestId('agy-app-root');
    fireEvent.click(screen.getByTestId('btn-organize-titles'));
    const modal = await screen.findByTestId('title-organizer-modal');
    expect(modal.textContent).toContain('Hydrogen (medium)');
    expect(screen.getByTestId('organize-model-badge').textContent).toContain('Hydrogen (medium)');
  });
});

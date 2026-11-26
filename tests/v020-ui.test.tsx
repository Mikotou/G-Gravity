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
import { TitleOrganizerModal } from '../src/renderer/components/TitleOrganizerModal';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { DualTrackThoughtBlock, ManagedSessionSummary, TitleOrganizeRequest } from '../src/shared';

beforeEach(() => {
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
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
  it('标题结果显示待整理数，并且仅在用户点击后继续处理指定的会话', async () => {
    const nextBatch = { scope: 'project' as const, projectCwd: '/test', sessionIds: ['31', '32'] };
    const run = vi.fn(async () => {});
    render(wrap(<TitleOrganizerModal open result={{ updatedCount: 30, hiddenPollutionCount: 0, suggestions: [], nextBatch }}
      onClose={() => {}} onRunOrganize={run} />));
    expect(screen.getByText(/还有 2 个待整理/)).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续整理' })); });
    expect(run).toHaveBeenCalledExactlyOnceWith(nextBatch);
  });
  it('完成项目整理后再次点击仍是原项目，零次调用不显示模型徽章', async () => {
    const request = { scope: 'project' as const, projectCwd: '/A' };
    const run = vi.fn(async () => {});
    render(wrap(<TitleOrganizerModal open repeatRequest={request} result={{ updatedCount: 0, hiddenPollutionCount: 0, suggestions: [] }}
      onClose={() => {}} onRunOrganize={run} />));
    expect(screen.queryByTestId('organize-model-badge')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /重新整理/ })); });
    expect(run).toHaveBeenCalledExactlyOnceWith(request);
  });
  it('侧栏手动改名最多 200 字，保存失败后保留草稿并可直接重试', async () => {
    const bridge = getFallbackDesktopBridge();
    const rename = vi.fn(bridge.renameSession).mockRejectedValueOnce(new Error('标题写入失败'));
    window.gravityDesktop = { ...bridge, renameSession: rename };
    render(<App />);
    fireEvent.click(await screen.findByTestId('rename-btn-sess-primary'));
    const input = screen.getByTestId('rename-input-sess-primary') as HTMLInputElement;
    const title = '稿'.repeat(200);
    expect(input.maxLength).toBe(200);
    fireEvent.change(input, { target: { value: title } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(rename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('app-toast').textContent).toContain('标题写入失败'));
    expect(input.value).toBe(title);
    expect(input.readOnly).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('rename-input-sess-primary')).toBeNull());
    expect((await bridge.listSessions()).find(s => s.sessionId === 'sess-primary')?.title).toBe(title);
    expect(rename).toHaveBeenCalledTimes(2);
  });
  it.each(['success', 'failure'])('回车与失焦只提交一次，A 的迟到 %s 结果保留 B 正在编辑的标题', async outcome => {
    const bridge = getFallbackDesktopBridge();
    let finish!: (row: ManagedSessionSummary) => void, fail!: (error: Error) => void;
    const pending = new Promise<ManagedSessionSummary>((resolve, reject) => { finish = resolve; fail = reject; });
    const rename = vi.fn(bridge.renameSession).mockImplementationOnce(() => pending);
    window.gravityDesktop = { ...bridge, renameSession: rename };
    render(<App />);
    fireEvent.click(await screen.findByTestId('rename-btn-sess-primary'));
    const first = screen.getByTestId('rename-input-sess-primary');
    fireEvent.change(first, { target: { value: '第一会话的新名' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    fireEvent.blur(first);
    expect(rename).toHaveBeenCalledExactlyOnceWith('sess-primary', '第一会话的新名');
    fireEvent.click(screen.getByTestId('rename-btn-sess-ui-theme'));
    const second = screen.getByTestId('rename-input-sess-ui-theme') as HTMLInputElement;
    fireEvent.change(second, { target: { value: '第二会话的草稿' } });
    await act(async () => {
      if (outcome === 'success') finish(await bridge.renameSession('sess-primary', '第一会话的新名'));
      else fail(new Error('标题写入失败'));
    });
    expect(screen.getByTestId('rename-input-sess-ui-theme')).toBe(second);
    expect(second.value).toBe('第二会话的草稿');
  });
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

  it.each(['zh-CN', 'en-US'] as const)('额度不可读取时给出 %s 指引且隐藏刷新入口', async locale => {
    const profileId = 'quota-guide-' + locale;
    const read = vi.fn().mockResolvedValue({ profileId, unavailable: 'profile' });
    window.gravityDesktop = { ...getFallbackDesktopBridge(), getAccountQuota: read };
    render(<I18nProvider locale={locale} onChangeLocale={() => {}}><AccountQuotaFooter profileId={profileId} /></I18nProvider>);
    fireEvent.click(screen.getByTestId('quota-weekly'));
    const guide = await screen.findByText(/\/usage/);
    expect(guide.textContent).toContain(locale === 'zh-CN' ? '默认登录资料' : 'default sign-in');
    expect(screen.queryByRole('button', { name: /^(刷新|Refresh)$/ })).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
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

  it('只显示上报的缓存命中率，区分未知、确认为零和极低的正值', async () => {
    const { telemetry } = await getFallbackDesktopBridge().getBootstrap();
    const state = telemetry.activeSessions['sess-primary'];
    const inspector = (rate: number | undefined, sessionId = 'sess-primary', locale: 'zh-CN' | 'en-US' = 'zh-CN') => (
      <I18nProvider locale={locale} onChangeLocale={() => {}}>
        <ContextCostInspectorView sessionId={sessionId} dashboard={{
          ...telemetry, activeSessions: { 'sess-primary': { ...state, averageCacheHitRate: rate } },
        }} onOpenRateCardsSettings={() => {}} />
      </I18nProvider>
    );
    const ui = render(inspector(undefined));
    const displayed = () => screen.getByTestId('context-cache-hit-rate').querySelector('strong')?.textContent;
    expect(state.costSummary.cachedInputTokens).toBeGreaterThan(0);
    expect(displayed()).toBe('未知');
    for (const [rate, expected] of [[0, '0%'], [0.00002, '<0.1%'], [0.375, '37.5%'], [0.99999, '>99.9%'], [1, '100%']] as const) {
      ui.rerender(inspector(rate));
      expect(displayed()).toBe(expected);
    }
    ui.rerender(inspector(1, 'empty-session', 'en-US'));
    expect(displayed()).toBe('Unknown');
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
      openTabSessionIds: ['s1'],
      selectedSessionId: 's1',
      hideLegacyPollutionSessions: true,
      organizingTitles: false,
      onToggleCollapse: () => {},
      onSelectSession: () => {},
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

  it('6) 浏览器预览无法调用官方 Hydrogen 时保留标题并说明原因', async () => {
    const bridge = getFallbackDesktopBridge();
    const before = await bridge.listSessions();
    const titles = before.map(s => s.title);
    render(<App />);
    await screen.findByTestId('agy-app-root');
    fireEvent.click(screen.getByTestId('btn-organize-titles'));
    await waitFor(() => expect(screen.getByTestId('app-toast').textContent).toContain('原标题已保留'));
    expect(screen.queryByTestId('title-organizer-modal')).toBeNull();
    expect((await bridge.listSessions()).map(s => s.title)).toEqual(titles);
    expect((await bridge.testExternalTranslatorConnection()).ok).toBe(false);
  });
});

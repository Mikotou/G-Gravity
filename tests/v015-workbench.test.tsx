import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { Composer } from '../src/renderer/components/Composer';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { ApproveForMeConfig, ManagedSessionSummary } from '../src/shared';

beforeEach(() => { delete window.agyDesktop; delete window.gravityDesktop; resetFallbackDesktopBridge(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.className = ''; });
async function mount() { render(<App />); await screen.findByTestId('agy-app-root'); }
const layout = async () => (await getFallbackDesktopBridge().getBootstrap()).layout;

describe('v0.1.5 可调整工作台与反馈', () => {
  it('侧栏可拖拽调宽并持久化，双击恢复默认宽度', async () => {
    await mount();
    const start = (await layout()).leftSidebarWidth;
    const handle = screen.getByTestId('sidebar-resize-handle');
    fireEvent.mouseDown(handle, { clientX: 300 });
    expect(document.body.classList.contains('gv-resizing')).toBe(true);
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(screen.getByTestId('project-sidebar').style.width).toBe(`${start + 100}px`);
    fireEvent.mouseUp(window);
    expect(document.body.classList.contains('gv-resizing')).toBe(false);
    await waitFor(async () => expect((await layout()).leftSidebarWidth).toBe(start + 100));
    fireEvent.doubleClick(handle);
    await waitFor(async () => expect((await layout()).leftSidebarWidth).toBe(264));
    // 超出上限时钳制在可用区间内，不会把越界值交给主进程
    fireEvent.mouseDown(handle, { clientX: 300 }); fireEvent.mouseMove(window, { clientX: 5000 }); fireEvent.mouseUp(window);
    await waitFor(async () => expect((await layout()).leftSidebarWidth).toBeLessThanOrEqual(600));
  });

  it('双栏之间的分隔条用键盘调整比例，网格仍只有两个窗格', async () => {
    await mount();
    expect(screen.queryByTestId('split-resize-handle')).toBeNull();
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    const handle = await screen.findByTestId('split-resize-handle');
    expect(screen.getByTestId('workspace-grid').children).toHaveLength(2);
    expect(handle.getAttribute('role')).toBe('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(async () => expect((await layout()).splitRatio).toBeCloseTo(0.52, 5));
    await waitFor(() => expect(screen.getByTestId('workspace-grid').style.gridTemplateColumns).toContain('0.52fr'));
    fireEvent.keyDown(handle, { key: 'End' });
    await waitFor(async () => expect((await layout()).splitRatio).toBe(0.75));
    fireEvent.keyDown(handle, { key: 'Enter' });
    await waitFor(async () => expect((await layout()).splitRatio).toBe(0.5));
  });

  it('Ctrl+= / Ctrl+- / Ctrl+0 调整界面缩放并给出轻提示', async () => {
    await mount();
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    await waitFor(async () => expect((await getFallbackDesktopBridge().getBootstrap()).preferences.uiScale).toBe(1.1));
    expect((await screen.findByTestId('app-toast')).textContent).toContain('界面缩放 110%');
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    fireEvent.keyDown(window, { key: '-', ctrlKey: true });
    await waitFor(async () => expect((await getFallbackDesktopBridge().getBootstrap()).preferences.uiScale).toBe(0.9));
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    await waitFor(async () => expect((await getFallbackDesktopBridge().getBootstrap()).preferences.uiScale).toBe(1));
  });

  it('模型与推理强度合并为二级菜单，账户菜单收纳账号、设置与语言', async () => {
    await mount();
    const bridge = getFallbackDesktopBridge();
    const effort = vi.spyOn(bridge, 'setSessionEffort');
    fireEvent.click(screen.getByTestId('model-select-sess-primary'));
    const menu = screen.getByTestId('model-menu-sess-primary');
    expect(within(menu).getAllByRole('menuitemradio').length).toBeGreaterThan(1);
    fireEvent.click(within(screen.getByTestId('effort-select-sess-primary')).getByRole('radio', { name: /high|高/ }));
    await waitFor(() => expect(effort).toHaveBeenCalledWith('sess-primary', 'high'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('model-menu-sess-primary')).toBeNull());

    expect(screen.queryByTestId('account-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('account-menu-btn'));
    const account = screen.getByTestId('account-menu');
    expect(within(account).getByTestId('locale-switch-en')).toBeTruthy();
    fireEvent.click(within(account).getByTestId('open-accounts-modal-btn'));
    expect(await screen.findByTestId('settings-overlay')).toBeTruthy();
    expect(screen.queryByTestId('account-menu')).toBeNull();
  });

  it('错误轻提示使用醒目语气并可手动关闭', async () => {
    await mount();
    vi.spyOn(getFallbackDesktopBridge(), 'saveWorkspaceLayout').mockRejectedValueOnce(new Error('布局写入失败'));
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    const toast = await screen.findByTestId('app-toast');
    expect(toast.className).toContain('tone-error');
    expect(toast.textContent).toContain('布局写入失败');
    fireEvent.click(within(toast).getByRole('button'));
    await waitFor(() => expect(screen.queryByTestId('app-toast')).toBeNull());
  });

  it('生成中在输入框按 Esc 中断当前回合，空闲时不触发', async () => {
    const session = { sessionId: 's1', cwd: 'C:\\w', rawCwd: 'C:\\w', title: 't', pinned: false, isLegacyApprovalPollution: false,
      status: 'streaming', modelId: 'm', executionMode: 'default', reasoningEffort: 'medium', originKind: 'acp-live', readOnly: false,
      profileId: 'default', updatedAt: '' } as unknown as ManagedSessionSummary;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const props = {
      availableSessions: [], availableModels: [], approvalConfig: { mode: 'manual' } as ApproveForMeConfig, canTriggerDemoApproval: false,
      onSendPrompt: vi.fn(), onCancelPrompt: cancel, onCompactContext: vi.fn(), onSetSessionMode: vi.fn(), onSetSessionEffort: vi.fn(),
      onSetSessionModel: vi.fn(), onQueryWorkspaceFiles: vi.fn().mockResolvedValue([]), onCycleApprovalMode: vi.fn(),
      onOpenApprovalSettings: vi.fn(), onOpenContextInspector: vi.fn(), onTriggerDemoApproval: vi.fn(),
    };
    const tree = (s: ManagedSessionSummary) => <I18nProvider locale="zh-CN" onChangeLocale={() => {}}><Composer session={s} {...props} /></I18nProvider>;
    const view = render(tree(session));
    const input = screen.getByTestId('composer-input-s1') as HTMLTextAreaElement;
    expect(input.placeholder).toContain('Esc');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('s1');
    view.rerender(tree({ ...session, status: 'idle' }));
    fireEvent.keyDown(screen.getByTestId('composer-input-s1'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('composer-resize-s1').getAttribute('aria-orientation')).toBe('horizontal');
  });
});

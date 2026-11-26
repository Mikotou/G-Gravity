import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

beforeEach(() => {
  delete window.gravityDesktop;
  window.localStorage.clear();
  resetFallbackDesktopBridge();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.className = '';
});

async function mount() {
  render(<App />);
  await screen.findByTestId('agy-app-root');
}

describe('v0.1.6 Claude Code Studio 前端架构', () => {
  it('48px 图标轨常驻显示，折叠会话抽屉后核心入口仍可一键直达', async () => {
    await mount();
    const rail = screen.getByTestId('activity-rail');
    expect(rail).toBeTruthy();
    expect(within(rail).getByTestId('topbar-app-icon')).toBeTruthy();
    expect(within(rail).getByTestId('sidebar-new-session-btn')).toBeTruthy();
    expect(within(rail).getByTestId('account-menu-btn')).toBeTruthy();
    expect(within(rail).getByTestId('open-theme-modal-btn')).toBeTruthy();
    // D3：项目与插件入口收进 Rail 账户菜单，点开后仍可一键直达
    fireEvent.click(within(rail).getByTestId('account-menu-btn'));
    expect(within(rail).getByTestId('open-projects-modal-btn')).toBeTruthy();
    expect(within(rail).getByTestId('open-plugins-modal-btn')).toBeTruthy();
    fireEvent.click(within(rail).getByTestId('account-menu-btn'));

    // 点击图标轨的抽屉按钮折叠会话栏，图标轨本身仍常驻
    const toggle = within(rail).getByTestId('toggle-left-sidebar-btn');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('project-sidebar').style.width).toBe('0px'));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('activity-rail')).toBeTruthy();

    // 折叠状态下点击图标轨上的新建会话按钮仍能打开弹窗
    fireEvent.click(within(rail).getByTestId('sidebar-new-session-btn'));
    expect(await screen.findByTestId('new-session-modal')).toBeTruthy();
  });

  it('会话抽屉正确高亮当前活跃会话，并支持搜索框一键清空', async () => {
    await mount();
    const activeRow = screen.getByTestId('sidebar-session-sess-primary');
    expect(activeRow.className).toContain('is-selected');

    const input = screen.getByTestId('sidebar-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'CoreGateway' } });
    expect(input.value).toBe('CoreGateway');
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(input.value).toBe('');
  });

  it('检视器支持在停靠与悬浮模式间切换并本地记住状态，页签区保持纯 tablist 结构', async () => {
    await mount();
    const inspector = screen.getByTestId('right-inspector');
    expect(inspector.getAttribute('data-inspector-mode')).toBe('docked');
    expect(inspector.className).not.toContain('is-floating');

    // D1 (v0.3.4)：验证 tablist 内部严格 5 个一级页签（Changes / Plan / Terminal / Context / Swarm，分支树收敛至 Context 二级视图），操作按钮位于独立的 inspector-head-actions 中
    const head = inspector.querySelector('.inspector-head') as HTMLElement;
    expect(within(head).getAllByRole('tab')).toHaveLength(5);
    expect(within(head).queryAllByRole('button')).toHaveLength(0);

    const floatBtn = screen.getByTestId('inspector-float-toggle');
    fireEvent.click(floatBtn);
    expect(inspector.getAttribute('data-inspector-mode')).toBe('floating');
    expect(inspector.className).toContain('is-floating');
    expect(window.localStorage.getItem('gravity.inspector.floating')).toBe('true');

    // 关闭按钮可收起检视器并将宽度置 0px
    fireEvent.click(screen.getByTestId('inspector-close-btn'));
    await waitFor(() => expect(screen.getByTestId('right-inspector').style.width).toBe('0px'));
    expect((await getFallbackDesktopBridge().getBootstrap()).layout.rightInspectorCollapsed).toBe(true);
  });

  it('操作记录折叠头包含语义类别指示点，内联审批卡键帽保留完整选项文本', async () => {
    await mount();
    const dots = document.querySelectorAll('.activity-group .tool-cat-dot');
    expect(dots.length).toBeGreaterThan(0);

    const allowBtn = document.querySelector('[data-testid^="btn-allow-once-"]') as HTMLElement;
    expect(allowBtn).toBeTruthy();
    expect(allowBtn.querySelector('.option-num')?.textContent).toBe('1. ');
    expect(allowBtn.textContent).toContain('1. Yes');
  });
});

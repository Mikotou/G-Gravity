import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import { MESSAGE_PAGE_SIZE, pageMessages, type GravityDesktopBridge, type ChatMessageItem } from '../src/shared';

const primary = 'sess-primary';
const secondary = 'sess-ui-theme';

async function mount(overrides: Partial<GravityDesktopBridge> = {}) {
  window.gravityDesktop = { ...getFallbackDesktopBridge(), ...overrides };
  render(<App />);
  await screen.findByTestId('agy-app-root');
}

beforeEach(() => {
  resetFallbackDesktopBridge();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  vi.restoreAllMocks();
});

describe('工作台交互回归', () => {
  it('审批卡保持待决定时显示人工确认提示，设置与另一个窗格仍保留原模式', async () => {
    const bridge = getFallbackDesktopBridge();
    await bridge.setApprovalMode('manual');
    await mount({ submitApprovalDecision: vi.fn(async () => ({ outcome: 'pending' as const })) });
    const cards = await screen.findAllByTestId(/^btn-approve-for-me-/);
    fireEvent.click(cards[0]);
    await waitFor(() => expect(screen.getByTestId('app-toast').textContent).toContain('仍需你确认'));
    expect(screen.getByTestId('inline-request-view-req-init-001')).toBeTruthy();
    for (const pill of screen.getAllByTestId(/^approval-mode-pill-/)) expect(pill.textContent).toContain('人工审批');
  });
  it('A 审批成功后只更新 A 的模式徽标，B 和设置中的默认模式均仍是纯手动', async () => {
    const bridge = getFallbackDesktopBridge();
    await bridge.setApprovalMode('manual');
    await mount();
    fireEvent.click(screen.getByTestId('layout-btn-split-2'));
    const left = await screen.findByTestId('approval-mode-pill-' + primary);
    const right = await screen.findByTestId('approval-mode-pill-' + secondary);
    fireEvent.click(screen.getByTestId('btn-approve-for-me-req-init-001'));
    await waitFor(() => expect(left.textContent).toContain('仅规则'));
    expect(right.textContent).toContain('人工审批');
    expect((await bridge.getBootstrap()).approvalConfig.mode).toBe('manual');
    expect(screen.getByTestId('app-toast').textContent).toContain('仅当前会话');
    fireEvent.click(left);
    expect(screen.queryByTestId('clear-session-approvals-' + secondary)).toBeNull();
    fireEvent.click(await screen.findByTestId('clear-session-approvals-' + primary));
    await waitFor(() => expect(left.textContent).toContain('人工审批'));
    expect(right.textContent).toContain('人工审批');
    expect(screen.getByTestId('app-toast').textContent).toContain('已清除本会话');
  });

  it('恢复窗口期间已经解决的审批不会被启动快照重新显示', async () => {
    const bridge = getFallbackDesktopBridge();
    const original = await bridge.getBootstrap();
    let deliver!: () => void;
    const getBootstrap = () => new Promise<typeof original>(resolve=>{deliver=()=>resolve(original);});
    window.gravityDesktop = {...bridge, getBootstrap};
    render(<App/>);
    const card = original.pendingApprovals[0];
    await act(async()=>{
      await bridge.submitApprovalDecision({sessionId:card.sessionId, requestId:card.requestId, decision:'allow_once'});
      deliver();
    });
    await screen.findByTestId('agy-app-root');
    expect(screen.queryByTestId('inline-request-view-' + card.requestId)).toBeNull();
  });
  it.each(['恢复窗口', '重新打开标签'])('%s 时迟到的快照保留刚收到的回复和终端结果', async phase => {
    const bridge = getFallbackDesktopBridge();
    const older: ChatMessageItem = { id: 'streaming-answer', sessionId: primary, role: 'assistant', createdAt: '', content: '前半段' };
    let push!: Parameters<GravityDesktopBridge['onMessageUpserted']>[0];
    let inspect!: Parameters<GravityDesktopBridge['onInspectorUpdated']>[0];
    let release: (() => void) | undefined;
    let delaySnapshot = phase === '恢复窗口';
    window.gravityDesktop = {
      ...bridge,
      onMessageUpserted(callback) { push = callback; return bridge.onMessageUpserted(callback); },
      onInspectorUpdated(callback) { inspect = callback; return bridge.onInspectorUpdated(callback); },
      async getSessionMessagePage(id, before) {
        if (id !== primary) return bridge.getSessionMessagePage(id, before);
        if (delaySnapshot) await new Promise<void>(resolve => { release = resolve; });
        return pageMessages([older]);
      },
    };
    render(<App />);
    if (!delaySnapshot) {
      await screen.findByTestId('agy-app-root');
      delaySnapshot = true;
      fireEvent.click(screen.getByTestId('sidebar-session-' + primary));
    }
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => {
      push({ sessionId: primary, message: { ...older, content: '完整的新回复' } });
      push({ sessionId: primary, message: { ...older, id: 'another-answer', content: '第二条新回复' } });
      inspect({ sessionId: primary, diffs: [], todos: [], terminals: [
        { id: 'new-terminal', toolCallId: 'new-terminal', command: 'read latest report', output: 'done', status: 'completed', timestamp: '' },
      ] });
      release!();
    });
    const pane = within(await screen.findByTestId('session-pane-' + primary));
    expect(pane.getAllByText('完整的新回复')).toHaveLength(1);
    expect(pane.getByText('第二条新回复')).toBeTruthy();
    fireEvent.click(screen.getByTestId('inspector-tab-terminal'));
    expect(await screen.findByText('read latest report')).toBeTruthy();
  });
  it('弹窗内的数字和长按重复事件不会触发审批，返回工作台后单次按键仍然生效', async () => {
    const submitApprovalDecision = vi.fn().mockResolvedValue(undefined);
    await mount({ submitApprovalDecision });
    for (const button of ['open-theme-modal-btn', 'sidebar-new-session-btn']) {
      fireEvent.click(screen.getByTestId(button));
      const dialog = await screen.findByRole('dialog');
      fireEvent.keyDown(within(dialog).getAllByRole('button')[0], { key: '1' });
      fireEvent.keyDown(window, { key: '1' });
      expect(submitApprovalDecision).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    fireEvent.keyDown(window, { key: '1', repeat: true });
    expect(submitApprovalDecision).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: '1' });
    await waitFor(() => expect(submitApprovalDecision).toHaveBeenCalledTimes(1));
  });

  it('键盘进入右窗格时保留控件焦点，收回单栏后标签和快捷键都跟随可见会话', async () => {
    const bridge = getFallbackDesktopBridge();
    const setSessionMode = vi.fn(bridge.setSessionMode.bind(bridge));
    await mount({ setSessionMode });
    fireEvent.click(screen.getByTestId('layout-btn-split-2'));
    const rightButton = await screen.findByTestId('model-select-' + secondary);
    act(() => { rightButton.focus(); });
    expect(document.activeElement).toBe(rightButton);
    expect(screen.getByTestId('tab-item-' + secondary).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('session-pane-' + secondary)).toBeNull());
    expect(screen.getByTestId('tab-item-' + primary).getAttribute('aria-selected')).toBe('true');
    // F-01: 确保焦点未停留在按钮控件上再触发全局 Shift+Tab 模式循环
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(setSessionMode).toHaveBeenCalledWith(primary, 'accept-edits'));
  });

  it('刷新会话后忽略上一批迟到的历史页，仍能按顺序读取中间消息', async () => {
    const history: ChatMessageItem[] = Array.from({ length: 3 * MESSAGE_PAGE_SIZE + 2 }, (_, i) => ({
      sessionId: primary, id: 'page-' + i, createdAt: '', role: 'system', content: '测试消息 ' + i,
    }));
    let release: (() => void) | undefined;
    let delayNext = false;
    await mount({ getSessionMessagePage: async (id, before) => {
      if (delayNext && before !== undefined) {
        delayNext = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return pageMessages(id === primary ? history : [], before);
    } });
    const pane = within(screen.getByTestId('session-pane-' + primary));
    await act(async () => { fireEvent.click(pane.getByTestId('load-earlier-messages')); });
    const middle = history[MESSAGE_PAGE_SIZE + 2].content;
    expect(pane.getByText(middle)).toBeTruthy();
    delayNext = true;
    fireEvent.click(pane.getByTestId('load-earlier-messages'));
    expect(release).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByTestId('sidebar-session-' + primary)); });
    expect(pane.queryByText(middle)).toBeNull();
    await act(async () => { release!(); });
    expect(pane.queryByText(history[2].content)).toBeNull();
    await act(async () => { fireEvent.click(pane.getByTestId('load-earlier-messages')); });
    expect(pane.getByText(middle)).toBeTruthy();
  });

  it('等待审批时保留草稿并允许停止，不向忙碌的会话发送第二轮', async () => {
    const cancelPrompt = vi.fn().mockResolvedValue(undefined);
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    await mount({ cancelPrompt, sendPrompt });
    const input = screen.getByTestId('composer-input-' + primary) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '下一轮草稿' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByTestId('send-prompt-btn-' + primary)).toBeNull();
    fireEvent.click(screen.getByTestId('cancel-prompt-btn-' + primary));
    // v0.3.6 B13/B14：首个取消请求在途时同步重复 Esc 去重；请求返回后若回合仍未收口可再次停止
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cancelPrompt.mock.calls).toEqual([[primary]]);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cancelPrompt.mock.calls).toEqual([[primary], [primary]]);
    expect(input.value).toBe('下一轮草稿');
  });

  it.each(['question', 'composer'])('从 %s 回答失败后保留问题，成功后可正常收起', async (source) => {
    const bridge = getFallbackDesktopBridge();
    await bridge.submitApprovalDecision({ sessionId: primary, requestId: 'req-init-001', decision: 'allow_once' });
    const question: ChatMessageItem = {
      id: 'test-written-question-' + source, sessionId: primary, role: 'assistant', createdAt: '',
      content: '请问优先执行哪一项？\nA. 方案甲\nB. 方案乙',
    };
    const failedTurn: ChatMessageItem = { id: 'failed', sessionId: primary, role: 'user', content: '上次未发出', createdAt: '', sendFailed: true };
    const sendPrompt = vi.fn().mockRejectedValueOnce(new Error('模拟断线')).mockResolvedValue(undefined);
    await mount({ sendPrompt, getSessionMessagePage: async (id, before) => pageMessages(id === primary ? [question, failedTurn] : [], before) });
    await screen.findByRole('radio', { name: '方案甲' });
    const answer = async () => {
      if (source === 'composer') {
        const input = screen.getByTestId('composer-input-' + primary) as HTMLTextAreaElement;
        await act(async () => { input.focus(); });
        fireEvent.change(input, { target: { value: '请继续方案甲' } });
        await waitFor(() => expect(input.value).toBe('请继续方案甲'));
        await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
      } else {
        const form = within(screen.getByTestId('question-bar'));
        fireEvent.click(form.getByRole('radio', { name: '方案甲' }));
        await act(async () => { fireEvent.click(form.getByRole('button', { name: '发送回答' })); });
      }
    };
    await answer();
    expect(screen.getByTestId('question-bar')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('模拟断线');
    await answer();
    expect(sendPrompt).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('question-bar')).toBeNull();
  });

  it('发送中的消息临时替换提问后，若发送失败会恢复所选答案和错误', async () => {
    const bridge = getFallbackDesktopBridge();
    await bridge.submitApprovalDecision({ sessionId: primary, requestId: 'req-init-001', decision: 'allow_once' });
    const question: ChatMessageItem = { id: 'pending-reply', sessionId: primary, role: 'assistant', createdAt: '',
      content: '请问选哪一个？\nA. 方案甲\nB. 方案乙' };
    const outgoing: ChatMessageItem = { id: 'outgoing', sessionId: primary, role: 'user', createdAt: '', content: '方案乙' };
    let upsert!: Parameters<GravityDesktopBridge['onMessageUpserted']>[0];
    let fail!: (err: Error) => void;
    await mount({
      getSessionMessagePage: async (id, before) => pageMessages(id === primary ? [question] : [], before),
      onMessageUpserted: listener => { upsert = listener; return () => {}; },
      sendPrompt: async () => {
        upsert({ sessionId: primary, message: outgoing });
        return new Promise<void>((_, reject) => { fail = reject; });
      },
    });
    const form = within(screen.getByTestId('question-bar'));
    fireEvent.click(form.getByRole('radio', { name: '方案乙' }));
    fireEvent.click(form.getByRole('button', { name: '发送回答' }));
    expect(screen.queryByTestId('question-bar')).toBeNull();
    await act(async () => {
      upsert({ sessionId: primary, message: { ...outgoing, sendFailed: true } });
      fail(new Error('未能送达'));
    });
    const restored = within(screen.getByTestId('question-bar'));
    expect(restored.getByRole('radio', { name: '方案乙' }).getAttribute('aria-checked')).toBe('true');
    expect(restored.getByRole('alert').textContent).toContain('未能送达');
  });

  it('偏好写入失败时保留项目目录，不显示成功，缩放快捷键也保留错误提示', async () => {
    const updatePreferences = vi.fn().mockRejectedValue(new Error('测试写入失败'));
    await mount({ updatePreferences });
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    fireEvent.click(screen.getByTestId('settings-tab-projects'));
    const input = screen.getByTestId('settings-default-cwd-input') as HTMLInputElement;
    const save = screen.getByTestId('settings-save-default-cwd-btn');
    fireEvent.change(input, { target: { value: 'F:/project' } });
    await act(async () => { fireEvent.click(save); });
    expect(save.textContent).not.toContain('已保存');
    expect(input.value).toBe('F:/project');
    expect(screen.getByRole('alert').textContent).toContain('测试写入失败');
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => { fireEvent.keyDown(window, { key: '=', ctrlKey: true }); });
    expect(screen.getByTestId('app-toast').textContent).toContain('测试写入失败');
  });

  it('不展示突发保护/复核中止/审批取消/整理进行中等无用轻提示与守卫徽标', async () => {
    const guardListeners: Array<Parameters<GravityDesktopBridge['onApprovalGuardActivity']>[0]> = [];
    let resolveOrganize!: () => void;
    const organizePending = new Promise<never>(() => { resolveOrganize = () => {}; });
    void resolveOrganize;
    await mount({
      onApprovalGuardActivity: (listener) => {
        guardListeners.push(listener);
        return () => {};
      },
      submitApprovalDecision: vi.fn(async () => ({ outcome: 'cancelled' as const })),
      organizeTitles: vi.fn(() => organizePending),
    });

    // 1. 即使主进程推送 burst-guard-enabled / cleared / review-cancelled，也不弹 toast 且不显示突发保护徽标
    for (const listener of guardListeners) {
      await act(async () => {
        listener({ sessionId: primary, kind: 'burst-guard-enabled', activeCount: 3, message: 'burst', timestamp: new Date().toISOString() });
        listener({ sessionId: primary, kind: 'burst-guard-cleared', activeCount: 0, message: 'cleared', timestamp: new Date().toISOString() });
        listener({ sessionId: primary, kind: 'review-cancelled', activeCount: 0, message: 'cancelled', timestamp: new Date().toISOString() });
      });
    }
    expect(screen.queryByTestId('app-toast')).toBeNull();
    expect(screen.queryByTestId(`approval-guard-dot-${primary}`)).toBeNull();

    // 2. 审批结果返回 cancelled 时不弹出冗余的「本次审批已取消」提示
    const allowBtn = await screen.findByTestId('btn-allow-once-req-init-001');
    await act(async () => { fireEvent.click(allowBtn); });
    expect(screen.queryByTestId('app-toast')).toBeNull();

    // 3. 点击整理标题时侧边栏已有内联加载态，不弹出「正在使用内置模型…整理标题」中间态 toast
    await act(async () => { fireEvent.click(screen.getByTestId('btn-organize-titles')); });
    expect(screen.queryByTestId('app-toast')).toBeNull();
  });
});

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { ThinkingBlock } from '../src/renderer/components/ThinkingBlock';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import { THEME_PRESETS, type PendingApprovalRequest } from '../src/shared';

beforeEach(() => { delete window.gravityDesktop; resetFallbackDesktopBridge(); });
afterEach(() => { cleanup(); delete window.gravityDesktop; vi.restoreAllMocks(); });
const mount = async () => { const result = render(<App />); await screen.findByTestId('agy-app-root'); return result; };
const wrap = (child: React.ReactNode) => <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>{child}</I18nProvider>;
const request: PendingApprovalRequest = {
  requestId: 'request', sessionId: 'session', toolCallId: 'tool', toolName: 'run_command', commandOrSummary: 'npm test',
  cwd: 'F:\\工作区', createdAt: '', riskLevel: 'medium', commandPrefix: 'npm test', screeningSource: 'local-ast',
  explanation: { meaning: '执行测试', target: '当前工作区', risk: '脚本可能写入文件' },
};

describe('Request View 四种原生交互', () => {
  it.each([
    ['btn-allow-once-request', 'allow_once'], ['btn-allow-prefix-request', 'allow_session_prefix'], ['btn-approve-for-me-request', 'approve_for_me_ai'],
  ])('%s 回传正确冻结载荷', async (testId, decision) => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(wrap(<InlineRequestView request={request} onSubmitDecision={submit} />));
    fireEvent.click(screen.getByTestId(testId));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({ requestId: 'request', sessionId: 'session', decision });
    if (decision === 'allow_session_prefix') expect(submit.mock.calls[0][0].allowedPrefix).toBe('npm test');
    expect(screen.getByTestId('risk-badge-request').textContent).toMatch(/[\u4e00-\u9fff]/);
    expect(screen.getByTestId('request-explanation-request').textContent).toContain('当前工作区');
  });
  it('拒绝按钮展开反馈，再次确认回传反馈文本', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(wrap(<InlineRequestView request={request} onSubmitDecision={submit} />));
    fireEvent.click(screen.getByTestId('btn-reject-feedback-request'));
    fireEvent.change(screen.getByTestId('reject-feedback-input-request'), { target: { value: '  请只读检查  ' } });
    fireEvent.click(screen.getByTestId('confirm-reject-btn-request'));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ requestId: 'request', sessionId: 'session', decision: 'reject_with_feedback', feedbackText: '请只读检查' }));
  });
  it('后端未提供安全前缀时禁止本会话前缀放行', () => {
    render(wrap(<InlineRequestView request={{ ...request, commandPrefix: undefined, commandOrSummary: 'rm -rf project', riskLevel: 'high' }} onSubmitDecision={vi.fn()} />));
    expect((screen.getByTestId('btn-allow-prefix-request') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('prefix-disabled-reason-request').textContent).toContain('安全前缀');
  });
  it('正在提交时四分支禁用，防止重复授权', async () => {
    let release!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(wrap(<InlineRequestView request={request} onSubmitDecision={submit} />));
    fireEvent.click(screen.getByTestId('btn-allow-once-request'));
    expect((screen.getByTestId('btn-approve-for-me-request') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('btn-allow-once-request')); expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });
  it('审批提交失败在卡片原位显示错误，不丢失待审批操作', async () => {
    render(wrap(<InlineRequestView request={request} onSubmitDecision={vi.fn().mockRejectedValue(new Error('审计写入失败'))} />));
    fireEvent.click(screen.getByTestId('btn-allow-once-request'));
    expect((await screen.findByRole('alert')).textContent).toContain('审计写入失败');
    expect((screen.getByTestId('btn-allow-once-request') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('App 主界面演示桥接交互（不等同真实服务）', () => {
  it('中英热切、主题六选及全局 Shift+Tab 四档Mode循环', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('account-menu-btn'));
    fireEvent.click(screen.getByTestId('locale-switch-en'));
    await waitFor(() => expect(document.documentElement.lang).toBe('en-US'));
    fireEvent.click(screen.getByTestId('locale-switch-zh'));
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    expect(screen.getByTestId('theme-group-dark').querySelectorAll('[data-testid^="theme-card-"]')).toHaveLength(4);
    expect(screen.getByTestId('theme-group-light').querySelectorAll('[data-testid^="theme-card-"]')).toHaveLength(2);
    for (const theme of THEME_PRESETS) {
      fireEvent.click(screen.getByTestId(`theme-card-${theme.id}`));
      await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe(theme.id));
    }
    const bridge = getFallbackDesktopBridge();
    // 未连接外部复核时默认仅启用基础「仅规则」机制，不允许无连接开启 AI 代审
    expect((await bridge.getBootstrap()).approvalConfig.mode).toBe('rules-only');
    // v0.3：设置为全屏覆盖层，Esc 关闭后快捷键才作用于工作台
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('settings-overlay')).toBeNull());
    // F-01 + F-13：设置页关闭归还焦点至触发按钮后，需离焦回画布再触发全局 Shift+Tab（避免按钮焦点被 Shift+Tab 劫持）
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    // v0.3+：对齐真实官方 agy acp 能力，仅循环 default / accept-edits / plan 三档，不再与 AI 代审重复
    const expected = ['accept-edits', 'plan', 'default'];
    for (const label of expected) {
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      await waitFor(() => expect(screen.getByTestId('execution-mode-pill-sess-primary').textContent).toContain(label));
    }
  });
  it('分屏一/二/四窗格，标题整理与污染会话可见性', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('layout-btn-split-2'));
    await waitFor(() => expect(screen.getByTestId('workspace-grid').children).toHaveLength(2));
    expect(screen.queryByTestId('layout-btn-grid-4')).toBeNull();
    expect(screen.queryByTestId('sidebar-session-sess-legacy-pollution-1')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-toggle-pollution'));
    await screen.findByTestId('sidebar-session-sess-legacy-pollution-1');
    vi.spyOn(getFallbackDesktopBridge(), 'organizeTitles').mockResolvedValue({
      updatedCount: 0, hiddenPollutionCount: 1, suggestions: [],
    });
    fireEvent.click(screen.getByTestId('btn-organize-titles'));
    await screen.findByTestId('title-organizer-modal');
    expect(screen.getByTestId('organize-summary-banner').textContent).toMatch(/[0-9]/);
  });
  it('Context Inspector展示24/168/30桶及蜂群任务/动作', async () => {
    await mount(); fireEvent.click(screen.getByTestId('context-inspector-trigger-sess-primary'));
    await screen.findByTestId('context-cost-inspector');
    expect(screen.getByTestId('heatmap-24h-bars').children).toHaveLength(24);
    fireEvent.click(screen.getByTestId('heatmap-range-7d'));
    // v0.3.5：7d 改为单行 7 张按日卡片（不再有 7×24 小时格）
    expect(screen.getByTestId('heatmap-7d-matrix').querySelectorAll('.heatmap-cell')).toHaveLength(7);
    fireEvent.click(screen.getByTestId('heatmap-range-30d'));
    // U-04 (v0.3.4): 30d 日历新增周一–周日列头与前置偏移格，按 .heatmap-cell 精准计 30 天单元格
    expect(screen.getByTestId('heatmap-30d-calendar').querySelectorAll('.heatmap-cell')).toHaveLength(30);
    expect(screen.getByTestId('compaction-monitor-section').textContent).toContain('142.8k');
    expect(screen.getByTestId('cost-disclaimer-banner').textContent).toContain('非实际账单');
    fireEvent.click(screen.getByTestId('inspector-tab-swarm'));
    await screen.findByTestId('swarm-monitor-panel');
    expect(screen.getByTestId('swarm-monitor-panel').textContent).toContain('还没有');
    expect(screen.queryByTestId('load-demo-swarm-btn')).toBeNull();
  });
  it('双轨思考切换准确，更新后的增量保留原文', () => {
    const initial = { id: 'thought', originalText: 'Check file', translatedZhText: '检查文件', isStreaming: true, languageDetected: 'en' as const, translationSource: 'local-stream-glossary' as const };
    const view = render(wrap(<ThinkingBlock thought={initial} defaultTrack="zh" />));
    expect(screen.getByTestId('thought-content-thought').textContent).toBe('检查文件');
    fireEvent.click(screen.getByTestId('thought-btn-raw-thought'));
    expect(screen.getByTestId('thought-content-thought').textContent).toBe('Check file');
    view.rerender(wrap(<ThinkingBlock thought={{ ...initial, originalText: 'Check file and test', translatedZhText: '检查文件并测试' }} defaultTrack="zh" />));
    expect(screen.getByTestId('thought-content-thought').textContent).toBe('Check file and test');
    fireEvent.click(screen.getByTestId('thought-btn-zh-thought'));
    expect(screen.getByTestId('thought-content-thought').textContent).toBe('检查文件并测试');
  });
  it('bootstrap 失败显示中文错误和恢复入口', async () => {
    const bridge = getFallbackDesktopBridge();
    window.gravityDesktop = { ...bridge, getBootstrap: vi.fn().mockRejectedValue(new Error('ACP 连接失败')) };
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('ACP 连接失败');
    expect(screen.queryByTestId('agy-app-root')).toBeNull();
  });
  it('已打开会话离线恢复为只读时显示缓存正文与重连入口', async () => {
    const bridge = getFallbackDesktopBridge(); const boot = await bridge.getBootstrap();
    const id = 'sess-primary';
    boot.sessions = boot.sessions.map(s => s.sessionId === id ? { ...s, status: 'closed' } : s);
    boot.layout = { ...boot.layout, openTabSessionIds: [id], activePrimarySessionId: id };
    const cached = boot.sessions.find(s => s.sessionId === id)!;
    const readOnlySession = { ...cached, status: 'closed' as const, readOnly: true };
    const clear = vi.fn(async () => ({ ...readOnlySession, hasApprovalGrants: false }));
    window.gravityDesktop = { ...bridge, getBootstrap: async () => boot, resumeSession: async () => ({ ...readOnlySession, hasApprovalGrants: true }), clearSessionApprovals: clear };
    await mount();
    expect(screen.getByText('正在查看本机保存的对话')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除本会话已记住的授权' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '清除本会话已记住的授权' })).toBeNull());
    expect(clear).toHaveBeenCalledWith(id);
    expect(screen.queryByTestId('composer-input-' + id)).toBeNull();
    expect(document.querySelector('.cc-user-prompt')).toBeTruthy();
  });
  it('零打开标签时不能把未恢复的历史会话渲染成可输入工作台', async () => {
    const bridge = getFallbackDesktopBridge(); const boot = await bridge.getBootstrap();
    boot.sessions = boot.sessions.map((session) => ({ ...session, status: 'closed' }));
    boot.layout = { ...boot.layout, openTabSessionIds: [], activePrimarySessionId: null, splitSecondarySessionId: null };
    window.gravityDesktop = { ...bridge, getBootstrap: async () => boot };
    await mount();
    expect(screen.queryByTestId('composer-input-sess-primary')).toBeNull();
    expect(screen.getByTestId('empty-pane-0')).toBeTruthy();
  });
});

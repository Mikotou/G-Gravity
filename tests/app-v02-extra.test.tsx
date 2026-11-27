import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { ToolCallCard } from '../src/renderer/components/ToolCallCard';
import { Markdown } from '../src/renderer/components/Markdown';
import { ImageWorkspace, resolveImage } from '../src/renderer/components/MessageImage';
import { EditUserMessage } from '../src/renderer/components/EditUserMessage';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import { computeUnifiedLineDiff, pageMessages, type PendingApprovalRequest } from '../src/shared';

beforeEach(() => { delete window.gravityDesktop; resetFallbackDesktopBridge(); });
afterEach(() => { cleanup(); delete window.gravityDesktop; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const wrap = (child: React.ReactNode) => <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>{child}</I18nProvider>;
async function mount() { render(<App />); await screen.findByTestId('agy-app-root'); }

describe('v0.2 三栏、Composer与Inspector组件交互', () => {
  it('终端未读标记在打开时消失并记住，新增输出重新提示，完整的长命令与输出可收起', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const sessionId = 'read-test';
    const command = 'echo ' + 'very-long-param '.repeat(32) + 'THE_END';
    const entry = { id: '1', toolCallId: '1', command, output: '示例结果', status: 'failed' as const, exitCode: 1, timestamp: 't' };
    const tree = (activeTab: 'terminal' | 'plan', output = entry.output, collapsed = false) =>
      wrap(<RightInspector collapsed={collapsed} width={380} activeTab={activeTab} focusedDiffFile={null} sessionId={sessionId} sessionMessages={[]}
        telemetry={boot.telemetry} inspectorData={{ sessionId, terminals: [{ ...entry, output }], todos: [], diffs: [] }}
        onSelectTab={() => {}} onFocusDiffFile={() => {}} onCommitWidth={() => {}} onOpenRateCardsSettings={() => {}} />);
    const badge = () => screen.getByTestId('inspector-tab-terminal').querySelector('.tab-count');
    const view = render(tree('plan'));
    expect(badge()?.classList.contains('tone-danger')).toBe(true);
    // F-12：收起态不渲染内部控件，且收起期间切到 terminal 不应消除未读计数；展开回 plan 仍可见未读，真正展开 terminal 后消失。
    view.rerender(tree('terminal', entry.output, true));
    expect(screen.queryByTestId('inspector-tab-terminal')).toBeNull();
    view.rerender(tree('plan', entry.output, false)); expect(badge()).toBeTruthy();
    view.rerender(tree('terminal')); expect(badge()).toBeNull();
    const toggle = screen.getByRole('button', { name: '展开' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(entry.output)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(command).classList.contains('term-command')).toBe(true);
    expect(screen.getByText(entry.output)).toBeTruthy();
    fireEvent.click(toggle); expect(screen.queryByText(entry.output)).toBeNull();
    view.unmount();
    const next = render(tree('plan')); expect(badge()).toBeNull();
    next.rerender(tree('plan', '新的结果')); expect(badge()?.textContent).toBe('1');
  });
  it('正文图片支持相对路径、中文与空格、普通链接、引用、嵌入和原图预览', () => {
    const markdown = '![流程](<./图 片/a#b.png>)\n\n[截图](result.png)\n\n![样本][图]\n\n[图]: https://example.test/a.webp\n\n![内嵌](data:image/png;base64,AQID)';
    render(wrap(<ImageWorkspace.Provider value={'F:\\项目'}><Markdown text={markdown} /></ImageWorkspace.Provider>));
    expect(screen.getByAltText('流程').getAttribute('src')).toBe('file:///F:/%E9%A1%B9%E7%9B%AE/%E5%9B%BE%20%E7%89%87/a%23b.png');
    // v0.3.5 P2：被 CSP 拦截的远程图片渲染为安全外链胶囊而非破图 <img>
    const remoteCapsule = screen.getByTestId('md-img-blocked-capsule');
    expect(remoteCapsule.textContent).toContain('样本');
    expect(remoteCapsule.getAttribute('data-remote-src')).toBe('https://example.test/a.webp');
    expect(screen.getByAltText('截图').getAttribute('src')).toContain('/result.png');
    expect(screen.getByAltText('内嵌').getAttribute('src')).toBe('data:image/png;base64,AQID');
    const extra = render(wrap(<ImageWorkspace.Provider value="F:/test"><Markdown text={'F:/test/裸路径.jpg\n\n<img src="s.png" alt="图像标签" width="200" />'} /></ImageWorkspace.Provider>));
    expect(extra.getByAltText('裸路径.jpg').getAttribute('src')).toContain('/test/');
    expect(extra.getByAltText('图像标签').getAttribute('src')).toBe('file:///F:/test/s.png');
    expect(resolveImage('javascript:test', 'F:\\项目')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '流程' }));
    expect(document.querySelector('dialog img')?.getAttribute('src')).toBe(screen.getAllByAltText('流程')[0].getAttribute('src'));
    fireEvent.click(document.querySelector('dialog button')!);
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('编辑旧消息支持取消、保留草稿与附件选择，快捷键只提交一次', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const m = { id: 'old', sessionId: 'session', role: 'user' as const, content: '旧内容', createdAt: '', attachments: [
      { id: 'good', name: 'keep.txt', mimeType: 'text/plain', textContent: 'contents', sizeBytes: 8 },
      { id: 'lost', name: 'legacy.txt', mimeType: 'text/plain', sizeBytes: 3 }] };
    render(wrap(<EditUserMessage message={m} busy={false} submit={submit}>旧内容</EditUserMessage>));
    fireEvent.click(screen.getByRole('button', { name: '编辑消息' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '编辑消息' }));
    expect((screen.getByLabelText(/legacy/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '修订过的正文' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session', messageId: 'old', text: '修订过的正文', attachmentIds: ['good'] });
  });
  it('Inspector拖拽宽度持久化，并将两端限制在280与680像素', async () => {
    await mount(); const bridge = getFallbackDesktopBridge();
    const handle = screen.getByTestId('inspector-resize-handle');
    fireEvent.mouseDown(handle, { clientX: 1000 }); fireEvent.mouseMove(window, { clientX: -1000 }); fireEvent.mouseUp(window);
    await waitFor(async () => expect((await bridge.getBootstrap()).layout.rightInspectorWidth).toBe(680));
    await waitFor(() => expect(screen.getByTestId('right-inspector').style.width).toBe('680px'));
    fireEvent.mouseDown(handle, { clientX: 1000 }); fireEvent.mouseMove(window, { clientX: 3000 }); fireEvent.mouseUp(window);
    await waitFor(async () => expect((await bridge.getBootstrap()).layout.rightInspectorWidth).toBe(280));
    await waitFor(() => expect(screen.getByTestId('right-inspector').style.width).toBe('280px'));
  });
  it('Files Changed只呈现已完成修改，挂起与失败工具不伪报成功变更', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const message = { id: 'changes', sessionId: 's', role: 'assistant' as const, content: '', createdAt: '',
      toolCalls: (['pending', 'failed', 'completed'] as const).map((status) => ({ toolCallId: status, rawToolName: 'edit_file', canonicalToolName: 'Edit' as const, compactTarget: `${status}.ts`, status, argsSummary: '{}', startedAt: '', diffPatch: computeUnifiedLineDiff(`${status}.ts`, 'old', 'new') })) };
    render(wrap(<RightInspector collapsed={false} width={380} activeTab="files" focusedDiffFile={null} sessionId="s" sessionMessages={[message]} telemetry={boot.telemetry} onSelectTab={() => {}} onFocusDiffFile={() => {}} onCommitWidth={() => {}} onOpenRateCardsSettings={() => {}} />));
    expect(screen.getByTestId('changed-file-item-completed.ts')).toBeTruthy();
    expect(screen.queryByTestId('changed-file-item-pending.ts')).toBeNull(); expect(screen.queryByTestId('changed-file-item-failed.ts')).toBeNull();
  });
  it('Ctrl+B/Ctrl+J折叠对应栏，Ctrl+反斜杠切分屏并持久化', async () => {
    await mount(); const bridge = getFallbackDesktopBridge();
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('project-sidebar').style.width).toBe('0px'));
    expect((await bridge.getBootstrap()).layout.leftSidebarCollapsed).toBe(true);
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('right-inspector').style.width).toBe('0px'));
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('workspace-grid').children).toHaveLength(2));
    expect((await bridge.getBootstrap()).layout.layoutMode).toBe('split-2');
  });
  it('Inspector六页可切换，用户块采用>前缀且工具默认折叠', async () => {
    await mount();
    for (const tab of ['diff', 'files', 'plan', 'terminal', 'context', 'swarm']) {
      fireEvent.click(screen.getByTestId(`inspector-tab-${tab}`));
      await waitFor(async () => expect((await getFallbackDesktopBridge().getBootstrap()).layout.activeInspectorTab).toBe(tab));
    }
    const user = document.querySelector('.cc-user-prompt'); expect(user?.textContent?.trim().startsWith('>')).toBe(true);
  });
  it('/与@补全、图片粘贴最终通过冻结SendPrompt载荷传递', async () => {
    const bridge = getFallbackDesktopBridge(); const send = vi.fn().mockResolvedValue(undefined);
    await bridge.submitApprovalDecision({ sessionId: 'sess-primary', requestId: 'req-init-001', decision: 'allow_once' });
    window.gravityDesktop = { ...bridge, sendPrompt: send }; await mount();
    const input = screen.getByTestId('composer-input-sess-primary');
    fireEvent.change(input, { target: { value: '/pl' } });
    expect(screen.getByTestId('slash-menu-sess-primary').textContent).toContain('/plan');
    fireEvent.change(input, { target: { value: '@' } });
    const menu = await screen.findByTestId('mention-menu-sess-primary');
    await waitFor(() => expect(within(menu).getAllByRole('button').length).toBeGreaterThan(0));
    fireEvent.click(within(menu).getAllByRole('button')[0]);
    fireEvent.change(input, { target: { value: '检查附件' } });
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'clipboard-test.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    await screen.findByText('clipboard-test.png'); fireEvent.click(screen.getByTestId('send-prompt-btn-sess-primary'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-primary', text: '检查附件', attachments: [{ name: 'clipboard-test.png', mimeType: 'image/png', sizeBytes: 4 }] });
    expect(send.mock.calls[0][0].attachments[0].dataBase64).toBeTruthy(); expect(send.mock.calls[0][0].references).toHaveLength(1);
  });
  it('添加文件按钮支持任意文本/代码文件附件，且无独立推理档位的模型隐藏 Effort 下拉框', async () => {
    const bridge = getFallbackDesktopBridge();
    await bridge.submitApprovalDecision({ sessionId: 'sess-primary', requestId: 'req-init-001', decision: 'allow_once' });
    const boot = await bridge.getBootstrap();
    boot.sessions = boot.sessions.map((s) => s.sessionId === 'sess-primary' ? { ...s, modelId: 'claude-sonnet-4-6', availableEfforts: [] } : s);
    const send = vi.fn().mockResolvedValue(undefined);
    window.gravityDesktop = { ...bridge, getBootstrap: async () => boot, sendPrompt: send }; await mount();
    expect(screen.queryByTestId('effort-select-sess-primary')).toBeNull();
    expect(screen.getByTestId('attach-file-btn-sess-primary')).toBeTruthy();
    const codeFile = new File(['const x = 42;\n'], 'sample.ts', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('attach-file-input-sess-primary'), { target: { files: [codeFile] } });
    await screen.findByText('sample.ts');
    fireEvent.click(screen.getByTestId('send-prompt-btn-sess-primary'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].attachments[0]).toMatchObject({ name: 'sample.ts', textContent: 'const x = 42;\n' });
  });
  it('编号1–4可键盘选择，缺失安全前缀不能通过数字2批准', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const request: PendingApprovalRequest = { requestId: 'numeric', sessionId: 's', toolCallId: 't', toolName: 'run_command', commandOrSummary: 'unknown', cwd: 'F:\\测试', createdAt: '', riskLevel: 'medium', screeningSource: 'manual-mode', explanation: { meaning: '待核对', target: '测试', risk: '需确认' } };
    render(wrap(<InlineRequestView request={request} enableNumericShortcuts onSubmitDecision={submit} />));
    expect(screen.getByTestId('btn-allow-once-numeric').textContent).toContain('1. Yes');
    fireEvent.keyDown(window, { key: '2' }); expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: '1' }); await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow_once' })));
    await waitFor(() => expect((screen.getByTestId('btn-allow-once-numeric') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(window, { key: '4' }); await screen.findByTestId('reject-feedback-input-numeric');
    const feedback = screen.getByTestId('reject-feedback-input-numeric');
    fireEvent.keyDown(feedback, { key: '1' }); expect(submit).toHaveBeenCalledTimes(1);
  });
  it('Edit工具单行折叠，展开呈现红绿行级Diff', () => {
    const diff = computeUnifiedLineDiff('test.ts', 'old line', 'new line');
    render(wrap(<ToolCallCard tool={{ toolCallId: 'edit', rawToolName: 'edit_file', canonicalToolName: 'Edit', compactTarget: 'test.ts', status: 'completed', argsSummary: '{}', diffPatch: diff, startedAt: '' }} />));
    expect(screen.queryByTestId('diff-file-test.ts')).toBeNull();
    fireEvent.click(within(screen.getByTestId('tool-card-edit')).getByRole('button'));
    expect(screen.getByTestId('diff-file-test.ts').textContent).toContain('old line');
    expect(screen.getByTestId('diff-file-test.ts').textContent).toContain('new line');
  });
  it('同窗格多个待审批卡片时，数字1只批准当前第一项，不能同时批准多项', async () => {
    const bridge = getFallbackDesktopBridge(); const boot = await bridge.getBootstrap();
    const request = (id: string): PendingApprovalRequest => ({ requestId: id, sessionId: 'sess-primary', toolCallId: id, toolName: 'run_command', commandOrSummary: `unknown ${id}`, cwd: 'F:\\测试', createdAt: '', riskLevel: 'medium', screeningSource: 'manual-mode', explanation: { meaning: '核对', target: '测试', risk: '需人工确认' } });
    boot.pendingApprovals = [request('first'), request('second')];
    const submit = vi.fn().mockResolvedValue(undefined);
    window.gravityDesktop = { ...bridge, getBootstrap: async () => boot,
      getSessionMessagePage: async (id, before) => id === 'sess-primary' ? pageMessages(['first', 'second'].map((requestId) => ({ id: `message-${requestId}`, sessionId: id, role: 'assistant' as const, content: '待审批', pendingApprovalId: requestId, createdAt: '' })), before) : bridge.getSessionMessagePage(id, before),
      submitApprovalDecision: submit };
    await mount();
    await act(async () => { fireEvent.keyDown(window, { key: '1' }); });
    expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0][0].requestId).toBe('first');
  });
});

describe('v0.2 自定义主题、图标、价格与管理面板UI', () => {
  it('取色器应用23项tokens，自定义JSON导入拦截url并可导出实际JSON', async () => {
    let exportedBlob: Blob | undefined;
    const OriginalURL = URL;
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL(blob: Blob) { exportedBlob = blob; return 'blob:qa-theme'; } static revokeObjectURL() {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await mount(); fireEvent.click(screen.getByTestId('open-theme-modal-btn')); fireEvent.click(screen.getByTestId('settings-tab-themes')); fireEvent.click(screen.getByTestId('settings-tab-tokens'));
    expect(screen.getByTestId('custom-tokens-editor').querySelectorAll('input[type="color"]')).toHaveLength(23);
    fireEvent.change(screen.getByTestId('color-picker-accentPrimary'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByTestId('apply-custom-theme-btn'));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent-primary')).toBe('#123456'));
    const importInput = screen.getByTestId('import-theme-file-input');
    const invalid = new File(['{}'], 'bad.json', { type: 'application/json' }); Object.defineProperty(invalid, 'text', { value: async () => '{"tokens":{"bgApp":"url(https://evil.example)"}}' });
    fireEvent.change(importInput, { target: { files: [invalid] } }); expect((await screen.findByRole('alert')).textContent).toContain('非法');
    fireEvent.click(screen.getByTestId('export-theme-json-btn'));
    await waitFor(() => expect(exportedBlob).toBeTruthy());
    const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exportedBlob!); });
    expect(JSON.parse(text).tokens.accentPrimary).toBe('#123456');
  });
  it('图标选项与单价表编辑传递到桥接', async () => {
    await mount(); fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    // v0.3.5 SV1：应用图标是「外观」的二级页签
    fireEvent.click(screen.getByTestId('settings-tab-themes'));
    fireEvent.click(screen.getByTestId('settings-tab-icons')); fireEvent.click(screen.getByTestId('icon-variant-gravity-ubuntu'));
    await waitFor(() => expect(screen.getByTestId('topbar-app-icon').getAttribute('src')).toContain('gravity-ubuntu'));
    fireEvent.click(screen.getByTestId('settings-tab-rates'));
    fireEvent.change(screen.getByTestId('rate-default-inputPerMillionUsd'), { target: { value: '2.34' } }); fireEvent.click(screen.getByTestId('save-rate-cards-btn'));
    await waitFor(async () => expect((await getFallbackDesktopBridge().getTelemetryDashboard()).rateCards[0].inputPerMillionUsd).toBe(2.34));
  });
  it('插件页首次读取失败后显示原因，并能手动重新加载', async () => {
    const refresh = vi.spyOn(getFallbackDesktopBridge(), 'getPluginsSnapshot')
      .mockRejectedValueOnce(new Error('项目插件读取失败'));
    await mount();
    // v0.3.5 A1：插件入口从账户浮层移到设置中心
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    fireEvent.click(screen.getByTestId('settings-tab-plugins'));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('项目插件读取失败');
    fireEvent.click(within(error).getByRole('button', { name: '重新加载' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('Plugins管理展示Built-in，并能进行内存适配器安装和MCP交互', async () => {
    const bridge = getFallbackDesktopBridge();
    const refresh = vi.spyOn(bridge, 'getPluginsSnapshot');
    const add = vi.spyOn(bridge, 'runMcpAction');
    await mount();
    // v0.3.5 A1：插件入口从账户浮层移到设置中心
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    fireEvent.click(screen.getByTestId('settings-tab-plugins'));
    await screen.findByTestId('plugins-manager-modal');
    const boot = await bridge.getBootstrap();
    const active = boot.sessions.find(s => s.sessionId === boot.layout.activePrimarySessionId);
    expect(active?.cwd).toBeTruthy();
    expect(refresh).toHaveBeenCalledWith(active!.cwd);
    expect(screen.getByTestId('builtin-item-builtin-approve-for-me').textContent).toContain('Built-in');
    fireEvent.click(screen.getByTestId('plugins-tab-plugins'));
    fireEvent.change(screen.getByTestId('plugin-install-input'), { target: { value: 'qa-plugin' } }); fireEvent.click(screen.getByTestId('plugin-install-btn'));
    await screen.findByTestId('plugin-row-qa-plugin'); fireEvent.click(screen.getByTestId('plugins-tab-mcp'));
    fireEvent.change(screen.getByTestId('mcp-name-input'), { target: { value: 'qa-server' } });
    fireEvent.change(screen.getByTestId('mcp-cmd-input'), { target: { value: '"C:\\Program Files\\node.exe" "my server.js"' } }); fireEvent.click(screen.getByTestId('mcp-add-btn'));
    await screen.findByTestId('mcp-row-qa-server');
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ commandOrUrl: 'C:\\Program Files\\node.exe', args: ['my server.js'] }));
  });
});

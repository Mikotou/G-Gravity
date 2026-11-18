import React from 'react';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { CoreService } from '../src/main/core-service';
import { prepareMockAcp } from './helpers/stdio-rpc';
import { createCoreBridge } from './helpers/core-bridge';

describe('App → 真正 CoreService → ACP 桩子进程', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  let core: CoreService | undefined; let dataDir = '';
  beforeAll(async () => { fixture = await prepareMockAcp(); });
  afterAll(async () => { await fixture?.cleanup(); });
  afterEach(async () => { cleanup(); delete window.agyDesktop; await core?.dispose(); core = undefined; if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });
  async function setup(count = 1) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'agy-qa-app-core-'));
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    core = new CoreService({ dataDir, acpOptions: { spawn: spawnSpy } });
    const sessions = await Promise.all(Array.from({ length: count }, (_, n) => core!.createSession({ cwd: `F:\\UI联调${n}`, title: `测试${n}` })));
    await core.saveWorkspaceLayout({ openTabSessionIds: sessions.map((session) => session.sessionId), activePrimarySessionId: sessions[0].sessionId, layoutMode: count === 4 ? 'grid-4' : 'single' });
    window.agyDesktop = createCoreBridge(core);
    render(<App />); await screen.findByTestId('agy-app-root');
    return { core, sessions, spawnSpy };
  }
  it('四窗格实际内核并行流、蜂群事件、消息隔离，只有一个 ACP 主进程', async () => {
    const { core, sessions, spawnSpy } = await setup(4);
    expect(screen.getByTestId('workspace-grid').children).toHaveLength(4);
    await act(async () => { await Promise.all(sessions.map((session) => core.sendPrompt({ sessionId: session.sessionId, text: '[swarm]' }))); });
    for (const session of sessions) {
      const pane = screen.getByTestId(`session-pane-${session.sessionId}`);
      expect(pane.textContent).toContain(`完成:${session.sessionId}`);
      for (const other of sessions.filter((item) => item.sessionId !== session.sessionId)) expect(pane.textContent).not.toContain(`完成:${other.sessionId}`);
      expect(pane.querySelector('[data-testid^="swarm-active-pill-"]')).toBeTruthy();
    }
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
  it('真实权限挂起经 Request View 允许一次返回 ACP，并呈现审计', async () => {
    const { core, sessions, spawnSpy } = await setup(); const sessionId = sessions[0].sessionId;
    const requested = once(core, 'approval-requested'); let run!: Promise<void>;
    await act(async () => { run = core.sendPrompt({ sessionId, text: '[permission] git status' }); await requested; });
    const [card] = await requested;
    expect(screen.getByTestId(`inline-request-view-${card.requestId}`)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId(`btn-allow-once-${card.requestId}`)); await run; });
    await waitFor(() => expect(screen.queryByTestId(`inline-request-view-${card.requestId}`)).toBeNull());
    expect(screen.getByTestId(`session-pane-${sessionId}`).textContent).toContain('allow-once');
    expect((await core.listApprovalAudit())[0].verdict).toBe('user_approved');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
  it('原生内核未声明压缩能力时，按钮显示可读错误而非未捕获异常', async () => {
    const { sessions } = await setup();
    fireEvent.click(screen.getByTestId(`btn-compact-context-${sessions[0].sessionId}`));
    expect((await screen.findByRole('alert')).textContent).toContain('未声明');
  });
  it('设置中切换账号立即清除旧标签和消息，再次选回可以看到原会话', async () => {
    const { core, sessions } = await setup();
    const session = sessions[0];
    await act(async () => { await core.createAccountProfile({ name: '测试 Profile' }); });
    const other = (await core.getAccountsState()).profiles.find(p => !p.isDefault)!;
    await act(async () => { await core.sendPrompt({ sessionId: session.sessionId, text: 'old-profile-only' }); });
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    fireEvent.click(screen.getByTestId('settings-tab-accounts'));
    fireEvent.click(screen.getByTestId('switch-profile-' + other.profileId));
    await screen.findByTestId('switch-profile-default');
    expect(screen.queryByTestId('session-pane-' + session.sessionId)).toBeNull();
    expect(screen.queryByText('old-profile-only')).toBeNull();
    fireEvent.click(screen.getByTestId('switch-profile-default'));
    await screen.findByTestId('switch-profile-' + other.profileId);
    expect(screen.getByTestId('project-sidebar').textContent).toContain(session.title);
  });
});

import React from 'react';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  afterEach(async () => { cleanup(); delete window.gravityDesktop; await core?.dispose(); core = undefined; if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });
  async function setup(count = 1) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'agy-qa-app-core-'));
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    core = new CoreService({ dataDir, acpOptions: { spawn: spawnSpy } });
    const sessions = await Promise.all(Array.from({ length: count }, (_, n) => core!.createSession({ cwd: `F:\\UI联调${n}`, title: `测试${n}` })));
    await core.saveWorkspaceLayout({ openTabSessionIds: sessions.map((session) => session.sessionId), activePrimarySessionId: sessions[0].sessionId, layoutMode: count > 1 ? 'split-2' : 'single' });
    window.gravityDesktop = createCoreBridge(core);
    render(<App />); await screen.findByTestId('agy-app-root');
    return { core, sessions, spawnSpy };
  }
  it('四个标签与双栏实际内核并行流、蜂群事件、消息隔离，只有一个 ACP 主进程', async () => {
    const { core, sessions, spawnSpy } = await setup(4);
    expect(screen.getByTestId('workspace-grid').children).toHaveLength(2);
    await act(async () => { await Promise.all(sessions.map((session) => core.sendPrompt({ sessionId: session.sessionId, text: '[swarm]' }))); });
    for (const session of sessions) {
      fireEvent.click(screen.getByTestId('tab-item-' + session.sessionId));
      await screen.findByTestId('session-pane-' + session.sessionId);
      const pane = screen.getByTestId(`session-pane-${session.sessionId}`);
      expect(pane.textContent).toContain(`完成:${session.sessionId}`);
      for (const other of sessions.filter((item) => item.sessionId !== session.sessionId)) expect(pane.textContent).not.toContain(`完成:${other.sessionId}`);
      expect(pane.querySelector('[data-testid^="swarm-active-pill-"]')).toBeTruthy();
    }
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
  it('拖动侧栏和标签可以指定左右栏，换出的会话继续生成', async () => {
    const { core, sessions } = await setup(3);
    const [a, b, c] = sessions.map(s => s.sessionId);
    let run!: Promise<void>;
    const started = new Promise<void>(resolve => {
      function onThought(event: { sessionId: string; message: { role: string } }) {
        if (event.sessionId === b && event.message.role === 'assistant') {
          core.off('message-upserted', onThought);
          resolve();
        }
      }
      core.on('message-upserted', onThought);
    });
    await act(async () => { run = core.sendPrompt({ sessionId: b, text: '[stream-during-drag]' }); await started; });
    const drag = async (source: string, slot: number, id: string) => {
      const store = new Map<string, string>();
      const dataTransfer = { get types() { return [...store.keys()]; }, setData(key: string, v: string) { store.set(key, v); },
        getData(key: string) { return store.get(key) || ''; }, files: [] };
      const target = screen.getByTestId('workspace-slot-' + slot);
      await act(async () => {
        fireEvent.dragStart(screen.getByTestId(source), { dataTransfer });
        fireEvent.dragOver(target, { dataTransfer });
        fireEvent.drop(target, { dataTransfer });
      });
      await within(target).findByTestId('session-pane-' + id);
    };
    await drag('sidebar-session-' + c, 1, c);
    expect(within(screen.getByTestId('workspace-slot-0')).getByTestId('session-pane-' + a)).toBeTruthy();
    expect(screen.getByTestId('tab-item-' + b)).toBeTruthy();
    expect(core.sessions.isBusy(b)).toBe(true);
    await act(async () => { await run; });
    expect(core.sessions.get(b).status).toBe('idle');
    expect(screen.queryByTestId('session-pane-' + b)).toBeNull();
    await drag('tab-item-' + b, 0, b);
    expect(within(screen.getByTestId('workspace-slot-1')).getByTestId('session-pane-' + c)).toBeTruthy();
    expect(screen.getByTestId('session-pane-' + b).textContent).toContain('完成:' + b);
    await drag('tab-item-' + c, 0, c);
    expect(within(screen.getByTestId('workspace-slot-1')).getByTestId('session-pane-' + b)).toBeTruthy();
    await act(async () => {
      expect((await core.getBootstrap()).layout.openTabSessionIds).toEqual([a, b, c]);
    });
  });

  it('原生表单未改写选项时直接单次 typed accept 原值原类型', async () => {
    const { core, sessions } = await setup();
    const sessionId = sessions[0].sessionId;
    let run!: Promise<void>;
    await act(async () => { run = core.sendPrompt({ sessionId, text: '[question]' }); });
    const form = await screen.findByTestId('question-bar');
    fireEvent.click(within(form).getByRole('radio', { name: '青绿' }));
    fireEvent.click(within(form).getByTestId('question-next'));
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: '原生补充' } });
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: /^发送回答/ })); await run; });
    expect(screen.queryByTestId('question-followup-preview')).toBeNull();
    expect(screen.queryByTestId('question-bar')).toBeNull();
    const saved = (await core.getSessionMessagePage(sessionId)).messages;
    expect(saved.find(m => m.content.includes('"action":"accept"'))?.content).toContain('"color":"teal"');
    expect(saved.find(m => m.content.includes('"action":"accept"'))?.content).toContain('"freeform_response":"原生补充"');
  });

  it.each(['[question]', '[closed choice]'])('模型通过表单收到用户改过的选项 %s（v2 预览确认后走跟进）', async marker => {
    const { core, sessions } = await setup();
    const sessionId = sessions[0].sessionId;
    const request = vi.spyOn(core.client, 'request');
    let run!: Promise<void>;
    await act(async () => { run = core.sendPrompt({ sessionId, text: marker }); });
    const form = await screen.findByTestId('question-bar');
    expect(screen.queryByTestId('inline-request-view')).toBeNull();
    // v0.3.5：选中后不再自动出现重复输入框，改为点击选项右上角铅笔就地编辑
    fireEvent.click(within(form).getByRole('radio', { name: '青绿' }));
    expect(within(form).queryByRole('textbox', { name: '修改选项 青绿' })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: '编辑选项「青绿」' }));
    fireEvent.change(within(form).getByRole('textbox', { name: '修改选项 青绿' }), { target: { value: '海玻璃绿' } });
    // v0.3.5 原生 v2：改写闭集 enum 选项先弹出逐题汇总预览，经用户二次确认后 1 次 decline + 1 条可见跟进消息
    fireEvent.click(within(form).getByRole('button', { name: /^发送回答/ }));
    const preview = await within(form).findByTestId('question-followup-preview');
    expect(preview.textContent).toContain('海玻璃绿');
    await act(async () => {
      fireEvent.click(within(form).getByTestId('question-followup-confirm'));
      await run;
    });
    expect(screen.queryByTestId('question-bar')).toBeNull();
    await waitFor(async () => {
      const saved = (await core.getSessionMessagePage(sessionId)).messages;
      expect(saved.some(m => m.role === 'assistant' && m.content.includes('"action":"decline"'))).toBe(true);
      expect(saved.some(m => m.role === 'user' && m.content.includes('海玻璃绿'))).toBe(true);
    });
    const saved = (await core.getSessionMessagePage(sessionId)).messages;
    expect(saved.find(m => m.question)?.question).toMatchObject({ state: 'answered', answer: expect.stringContaining('海玻璃绿') });
    expect(request.mock.calls.filter(([method]) => method === 'session/prompt').at(-1)?.[1]).toMatchObject({
      prompt: expect.arrayContaining([{ type: 'text', text: expect.stringContaining('海玻璃绿') }]),
    });
  });

  it('只在模型消息中组合批注，原对话和修改后的分支都呈现干净的原文与评论', async () => {
    const { core, sessions } = await setup();
    const sessionId = sessions[0].sessionId;
    const annotations = [{ excerpt: 'La', comment: '这是什么意思？', messageNumber: 7 }];
    const spy = vi.spyOn(core.client, 'request');
    await act(async () => { await core.sendPrompt({ sessionId, text: '', annotations }); });
    const sent = (await core.getSessionMessagePage(sessionId)).messages.find(m => m.role === 'user')!;
    expect(sent).toMatchObject({ content: '', annotations });
    expect(screen.getByTestId('session-pane-' + sessionId).textContent).not.toContain('User-selected passages');
    expect(screen.getByText('这是什么意思？')).toBeTruthy();
    const wire = spy.mock.calls.find(([method]) => method === 'session/prompt')?.[1];
    expect(JSON.stringify(wire)).toContain('User-selected passages');
    expect(JSON.stringify(wire)).toContain('这是什么意思？');
    const revised = [{ ...annotations[0], comment: '请解释这个词' }];
    let branchId = '';
    await act(async () => {
      const branch = await core.reviseMessage({ sessionId, messageId: sent.id, text: '法语', annotations: revised });
      branchId = branch.sessionId;
    });
    await waitFor(async () => expect((await core.getSessionMessagePage(branchId)).messages.some(m => m.annotations?.[0].comment === '请解释这个词')).toBe(true));
    await waitFor(async () => expect((await core.getSessionMessagePage(branchId)).messages.some(m => m.role === 'assistant' && !m.isStreaming)).toBe(true));
    expect((await core.getSessionMessagePage(sessionId)).messages.find(m => m.id === sent.id)?.annotations).toEqual(annotations);
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

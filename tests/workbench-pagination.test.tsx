import React from 'react';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import { MESSAGE_PAGE_SIZE, type ChatMessageItem } from '../src/shared';
import { prepareMockAcp } from './helpers/stdio-rpc';
import { createCoreBridge } from './helpers/core-bridge';

it('双栏按页读取超过 500 条的旧对话，编辑开头消息时保留原记录和两侧草稿', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'gravity-workbench-pages-'));
  const fixture = await prepareMockAcp();
  const client = new AcpClient({ spawn: (_binary, _args, options) => spawn(fixture.executable, fixture.args, options) });
  let core: CoreService | undefined;
  try {
    // These conversations already exist in both the official-protocol fixture and a legacy local snapshot.
    await client.start();
    const session = () => client.request<{ sessionId: string }>('session/new', { cwd: dataDir, mcpServers: [] });
    const left = (await session()).sessionId;
    const right = (await session()).sessionId;
    const count = MESSAGE_PAGE_SIZE * 8 + 3;
    const history: ChatMessageItem[] = Array.from({ length: count }, (_, i) => ({
      id: 'saved-' + i, originMessageId: 'saved-' + i, sessionId: left, createdAt: '',
      role: i < 8 ? (i % 2 ? 'assistant' : 'user') : 'system', content: '过去的记录 ' + i,
    }));
    const store = new ClientStore(dataDir);
    store.write('messages-default.json', { [left]: history, [right]: [] });
    store.write('owned-sessions-default.json', Object.fromEntries([left, right].map(id => [id, {
      sessionId: id, cwd: dataDir, rawCwd: dataDir, title: '历史 ' + id, updatedAt: new Date().toISOString(),
      profileId: 'default', modelId: '', executionMode: 'default', reasoningEffort: 'high', status: 'closed',
      pinned: false, isLegacyApprovalPollution: false,
    }])));
    core = new CoreService({ dataDir, homeDir: dataDir, acp: client, enableAutoUpdateCheck: false });
    await core.saveWorkspaceLayout({ openTabSessionIds: [left, right], activePrimarySessionId: left,
      splitSecondarySessionId: right, layoutMode: 'split-2', activeInspectorTab: 'tree' });
    const bridge = createCoreBridge(core);
    const pages = vi.fn(bridge.getSessionMessagePage);
    window.gravityDesktop = { ...bridge, getSessionMessagePage: pages };
    render(<App />);
    const leftPane = within(await screen.findByTestId('session-pane-' + left));
    const rightInput = screen.getByTestId('composer-input-' + right) as HTMLTextAreaElement;
    const leftInput = screen.getByTestId('composer-input-' + left) as HTMLTextAreaElement;
    await act(async () => { rightInput.focus(); });
    fireEvent.change(rightInput, { target: { value: '右栏草稿' } });
    await waitFor(() => expect(rightInput.value).toBe('右栏草稿'));
    await act(async () => { leftInput.focus(); });
    fireEvent.change(leftInput, { target: { value: '原分支草稿' } });
    expect(leftPane.queryByText(history[0].content)).toBeNull();
    expect(rightInput.value).toBe('右栏草稿');
    for (let remaining = count - MESSAGE_PAGE_SIZE; remaining > 0; remaining -= MESSAGE_PAGE_SIZE) {
      const load = leftPane.getByTestId('load-earlier-messages');
      act(() => load.focus());
      await act(async () => { fireEvent.click(load); });
      expect(pages).toHaveBeenCalledWith(left, remaining);
      expect(leftPane.getByText(history[Math.max(0, remaining - MESSAGE_PAGE_SIZE)].content)).toBeTruthy();
    }
    expect(leftPane.queryByTestId('load-earlier-messages')).toBeNull();
    expect(leftInput.value).toBe('原分支草稿');
    expect(rightInput.value).toBe('右栏草稿');
    fireEvent.click(leftPane.getByTestId('edit-msg-saved-4'));
    fireEvent.change(leftPane.getByRole('textbox', { name: '编辑原消息' }), { target: { value: '编辑最早一页的内容' } });
    fireEvent.click(leftPane.getByRole('button', { name: '重新发送' }));
    const branchId = await waitFor(async () => {
      const tree = await bridge.getConversationTree(left);
      expect(tree.activeBranchId).not.toBe(left);
      expect(tree.totalBranches).toBe(2);
      return tree.activeBranchId;
    });
    const branchPane = within(await screen.findByTestId('session-pane-' + branchId));
    expect(await branchPane.findByText('编辑最早一页的内容')).toBeTruthy();
    expect(branchPane.getByText(history[3].content)).toBeTruthy();
    expect(branchPane.queryByText(history[4].content)).toBeNull();
    expect((screen.getByTestId('composer-input-' + branchId) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByTestId('tab-item-' + branchId).getAttribute('aria-selected')).toBe('true');
    expect(rightInput.value).toBe('右栏草稿');
    const allSaved: ChatMessageItem[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await core.getSessionMessagePage(left, before);
      allSaved.unshift(...page.messages);
      if (page.earlierCount <= 0) break;
      before = page.earlierCount;
    }
    expect(allSaved.map(m => m.id)).toEqual(history.map(m => m.id));
    await waitFor(() => expect(core!.sessions.isBusy(branchId)).toBe(false));
    fireEvent.click(screen.getByTestId('tree-node-' + left));
    const restored = await screen.findByTestId('composer-input-' + left);
    expect((restored as HTMLTextAreaElement).value).toBe('原分支草稿');
    await waitFor(() => expect(screen.getByTestId('tab-item-' + left).getAttribute('aria-selected')).toBe('true'));
    expect(within(screen.getByTestId('workspace-slot-1')).getByTestId('composer-input-' + right)).toBe(rightInput);
  } finally {
    cleanup(); delete window.gravityDesktop;
    if (core) await core.dispose(); else await client.stop();
    await fixture.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20000);

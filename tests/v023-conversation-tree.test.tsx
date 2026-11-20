import React from 'react';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { CoreService } from '../src/main/core-service';
import {
  buildConversationTreeRenderRows,
  getMessageForkControl,
  type ChatMessageItem,
  type ConversationTreeState,
} from '../src/shared';
import { prepareMockAcp } from './helpers/stdio-rpc';
import { createCoreBridge } from './helpers/core-bridge';

describe('v0.2.3 Codex 风格原地对话分支树（左侧单主对话 + 多级嵌套分叉 + 右侧分支树 + Context 联动）', () => {
  let fixture: Awaited<ReturnType<typeof prepareMockAcp>>;
  let core: CoreService | undefined;
  let dataDir = '';

  beforeAll(async () => {
    fixture = await prepareMockAcp();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  afterEach(async () => {
    cleanup();
    delete window.agyDesktop;
    delete window.gravityDesktop;
    await core?.dispose();
    core = undefined;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = '';
    }
  });

  async function setupApp(title = '架构设计主对话') {
    dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-v023-tree-'));
    const spawnSpy = vi.fn((_binary, _args, options) => spawn(fixture.executable, fixture.args, options));
    core = new CoreService({ dataDir, acpOptions: { spawn: spawnSpy } });
    const root = await core.createSession({ cwd: 'F:\\TreeQA', title });
    await core.saveWorkspaceLayout({
      openTabSessionIds: [root.sessionId],
      activePrimarySessionId: root.sessionId,
      layoutMode: 'single',
      activeInspectorTab: 'tree',
    });
    window.gravityDesktop = createCoreBridge(core);
    render(<App />);
    await screen.findByTestId('agy-app-root');
    return { core, root, spawnSpy };
  }

  async function waitIdle(svc: CoreService, sessionId: string) {
    await waitFor(
      async () => {
        expect(svc.sessions.isBusy(sessionId)).toBe(false);
        const msgs = await svc.getSessionMessages(sessionId);
        expect(msgs.at(-1)?.role).toBe('assistant');
        expect(msgs.at(-1)?.isStreaming).toBe(false);
      },
      { timeout: 10000 }
    );
  }

  it('1) 修改历史消息重发后左侧仅显示主对话、保留原回复、支持内联 ‹ 1 / 2 › 原地来回切换', async () => {
    const { core: svc, root } = await setupApp('单主对话验证');

    await act(async () => {
      await svc.sendPrompt({ sessionId: root.sessionId, text: '第一问：初始化工作区' });
      await svc.sendPrompt({ sessionId: root.sessionId, text: '第二问：原始方案 ALPHA' });
    });

    const rootMessages = await svc.getSessionMessages(root.sessionId);
    const turn2 = rootMessages.find((m) => m.role === 'user' && m.content.includes('原始方案 ALPHA'))!;
    expect(turn2).toBeTruthy();

    // 通过界面编辑按钮修改第二条消息并重发
    fireEvent.click(screen.getByTestId(`edit-msg-${turn2.id}`));
    const editor = screen.getByRole('textbox', { name: '编辑原消息' });
    fireEvent.change(editor, { target: { value: '第二问：修订方案 BETA' } });
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));

    let branchAId = '';
    await waitFor(async () => {
      const tree = await svc.getConversationTree(root.sessionId);
      expect(tree.totalBranches).toBe(2);
      branchAId = tree.activeBranchId;
      expect(branchAId).not.toBe(root.sessionId);
    });
    await waitIdle(svc, branchAId);

    // 左侧历史对话栏中依然只显示 1 条主对话（绝不出现重复会话条目），且带分支角标 2
    const sidebar = screen.getByTestId('project-sidebar');
    const sidebarItems = sidebar.querySelectorAll('[data-testid^="sidebar-session-"]');
    expect(sidebarItems).toHaveLength(1);
    expect(sidebarItems[0].getAttribute('data-testid')).toBe(`sidebar-session-${root.sessionId}`);
    expect(sidebarItems[0].className).toContain('is-selected');
    expect(screen.getByTestId(`sidebar-branch-count-${root.sessionId}`).textContent).toContain('2');

    // 主舞台显示修订后的分支 BETA，且第二条用户消息下方出现内联分支切换器 2 / 2
    await screen.findByTestId(`session-pane-${branchAId}`);
    const branchAMsgs = await svc.getSessionMessages(branchAId);
    const revisedTurn2 = branchAMsgs.find((m) => m.role === 'user' && m.content.includes('修订方案 BETA'))!;
    expect(revisedTurn2).toBeTruthy();
    expect(screen.getByTestId(`branch-counter-${revisedTurn2.id}`).textContent?.trim()).toBe('2 / 2');

    // 点击「上一个分支 ‹」切回原始主对话：原消息与原回复完整保留且未删除
    fireEvent.click(screen.getByTestId(`branch-prev-${revisedTurn2.id}`));
    await screen.findByTestId(`session-pane-${root.sessionId}`);
    expect(screen.getByTestId(`session-pane-${root.sessionId}`).textContent).toContain('原始方案 ALPHA');
    expect(screen.getByTestId(`branch-counter-${turn2.id}`).textContent?.trim()).toBe('1 / 2');

    // 再点击「下一个分支 ›」切回分支 BETA
    fireEvent.click(screen.getByTestId(`branch-next-${turn2.id}`));
    await screen.findByTestId(`session-pane-${branchAId}`);
    expect(screen.getByTestId(`session-pane-${branchAId}`).textContent).toContain('修订方案 BETA');
    expect(screen.getByTestId(`branch-counter-${revisedTurn2.id}`).textContent?.trim()).toBe('2 / 2');
  }, 20000);

  it('2) 修改过的分支可继续追问、再编辑后续消息形成多级嵌套树，同分叉点多版本正确归组且恪守并行槽位上限', async () => {
    const { core: svc, root } = await setupApp('多级嵌套分支树');

    await act(async () => {
      await svc.sendPrompt({ sessionId: root.sessionId, text: 'T1_SHARED_ROOT' });
      await svc.sendPrompt({ sessionId: root.sessionId, text: 'T2_ORIGINAL' });
    });

    const rootMsgs = await svc.getSessionMessages(root.sessionId);
    const t2Original = rootMsgs.find((m) => m.role === 'user' && m.content === 'T2_ORIGINAL')!;

    // 1) 在第 2 轮分叉创建 Branch A
    let branchA!: Awaited<ReturnType<CoreService['reviseMessage']>>;
    await act(async () => {
      branchA = await svc.reviseMessage({
        sessionId: root.sessionId,
        messageId: t2Original.id,
        text: 'T2_BRANCH_A',
      });
    });
    await waitIdle(svc, branchA.sessionId);

    // 2) 在修改后的 Branch A 上继续发送第 3 轮消息，验证模型正常回复
    await act(async () => {
      await svc.sendPrompt({ sessionId: branchA.sessionId, text: 'T3_FOLLOWUP_ON_A' });
    });
    await waitIdle(svc, branchA.sessionId);
    const branchAMsgs = await svc.getSessionMessages(branchA.sessionId);
    expect(branchAMsgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'T1_SHARED_ROOT',
      'T2_BRANCH_A',
      'T3_FOLLOWUP_ON_A',
    ]);

    // 3) 编辑 Branch A 上的第 3 轮消息，创建深度 2 的嵌套子分支 A-1
    const t3OnA = branchAMsgs.find((m) => m.role === 'user' && m.content === 'T3_FOLLOWUP_ON_A')!;
    let branchA1!: Awaited<ReturnType<CoreService['reviseMessage']>>;
    await act(async () => {
      branchA1 = await svc.reviseMessage({
        sessionId: branchA.sessionId,
        messageId: t3OnA.id,
        text: 'T3_NESTED_A1',
      });
    });
    await waitIdle(svc, branchA1.sessionId);

    // 4) 在嵌套子分支 A-1 中继续编辑第 2 轮消息（继承自 A），应归组为第 2 轮分叉的第 3 个同级分支 B
    const a1Msgs = await svc.getSessionMessages(branchA1.sessionId);
    const t2InA1 = a1Msgs.find((m) => m.role === 'user' && m.content === 'T2_BRANCH_A')!;
    let branchB!: Awaited<ReturnType<CoreService['reviseMessage']>>;
    await act(async () => {
      branchB = await svc.reviseMessage({
        sessionId: branchA1.sessionId,
        messageId: t2InA1.id,
        text: 'T2_BRANCH_B',
      });
    });
    await waitIdle(svc, branchB.sessionId);

    // 验证整棵 4 节点 N 叉树拓扑
    const tree = await svc.getConversationTree(root.sessionId);
    expect(tree.totalBranches).toBe(4);
    expect(tree.nodesById[root.sessionId].depth).toBe(0);
    expect(tree.nodesById[branchA.sessionId].depth).toBe(1);
    expect(tree.nodesById[branchA.sessionId].parentBranchId).toBe(root.sessionId);
    expect(tree.nodesById[branchA1.sessionId].depth).toBe(2);
    expect(tree.nodesById[branchA1.sessionId].parentBranchId).toBe(branchA.sessionId);
    expect(tree.nodesById[branchB.sessionId].depth).toBe(1);
    expect(tree.nodesById[branchB.sessionId].parentBranchId).toBe(root.sessionId);

    // 验证嵌套子分支 A-1 在第 2 轮显示 2/3、在第 3 轮显示 2/2
    const ctrlT2OnA1 = getMessageForkControl(tree, branchA1.sessionId, a1Msgs, t2InA1.id);
    expect(ctrlT2OnA1).toMatchObject({ currentIndex: 1, totalCount: 3 });
    const t3InA1 = a1Msgs.find((m) => m.role === 'user' && m.content === 'T3_NESTED_A1')!;
    const ctrlT3OnA1 = getMessageForkControl(tree, branchA1.sessionId, a1Msgs, t3InA1.id);
    expect(ctrlT3OnA1).toMatchObject({ currentIndex: 1, totalCount: 2 });

    // 验证左侧栏仍只有 1 个主对话且角标显示 4，且活跃 ACP 会话始终只占 1 个槽位
    await waitFor(() => {
      const sidebar = screen.getByTestId('project-sidebar');
      expect(sidebar.querySelectorAll('[data-testid^="sidebar-session-"]')).toHaveLength(1);
      expect(screen.getByTestId(`sidebar-branch-count-${root.sessionId}`).textContent).toContain('4');
    });
    expect(svc.sessions.activeSessionCount).toBe(1);
  }, 25000);

  it('3) 右侧栏专属「分支树」页面展示树状拓扑，点击节点切换分支并同步改变 Context 窗口记录', async () => {
    const { core: svc, root } = await setupApp('Context联动测试');

    // 在主分支发送一段较长内容，使主分支与短修订分支的 Context Token 产生明显差异
    const longPrompt = '主分支长上下文说明：' + '架构细节验证数据 '.repeat(260);
    await act(async () => {
      await svc.sendPrompt({ sessionId: root.sessionId, text: '第一轮公共起点' });
      await svc.sendPrompt({ sessionId: root.sessionId, text: longPrompt });
    });

    const rootMsgs = await svc.getSessionMessages(root.sessionId);
    const turn2 = rootMsgs.find((m) => m.role === 'user' && m.content.startsWith('主分支长上下文说明'))!;
    const rootTelemetryBefore = (await svc.getTelemetryDashboard()).activeSessions[root.sessionId];
    expect(rootTelemetryBefore.usedContextTokens).toBeGreaterThan(1000);

    // 通过界面编辑第 2 条为极短提示，生成轻量分支
    fireEvent.click(screen.getByTestId(`edit-msg-${turn2.id}`));
    const editor = screen.getByRole('textbox', { name: '编辑原消息' });
    fireEvent.change(editor, { target: { value: '短修订' } });
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));

    let shortBranchId = '';
    await waitFor(async () => {
      const tree = await svc.getConversationTree(root.sessionId);
      expect(tree.totalBranches).toBe(2);
      shortBranchId = tree.activeBranchId;
      expect(shortBranchId).not.toBe(root.sessionId);
    });
    await waitIdle(svc, shortBranchId);

    const teleAfterFork = await svc.getTelemetryDashboard();
    const shortUsed = teleAfterFork.activeSessions[shortBranchId].usedContextTokens;
    const rootUsed = teleAfterFork.activeSessions[root.sessionId].usedContextTokens;
    expect(rootUsed).toBeGreaterThan(shortUsed);

    // 验证右侧检视器「分支树」页签已激活并展示两个带各自 Context 读数的节点
    await screen.findByTestId('conversation-tree-panel');
    expect(screen.getByTestId(`tree-node-${root.sessionId}`)).toBeTruthy();
    expect(screen.getByTestId(`tree-node-${shortBranchId}`)).toBeTruthy();
    expect(screen.getByTestId(`tree-node-active-${shortBranchId}`)).toBeTruthy();

    const shortContextReadout = screen.getByTestId(`tree-node-context-${shortBranchId}`).textContent;
    const rootContextReadout = screen.getByTestId(`tree-node-context-${root.sessionId}`).textContent;
    expect(shortContextReadout).not.toBe(rootContextReadout);

    // 切到右侧 Context 页签：此时应显示短分支的 Context 窗口数值
    fireEvent.click(screen.getByTestId('inspector-tab-context'));
    await screen.findByTestId('context-branch-banner');
    expect(screen.getByTestId('context-branch-banner').textContent).toContain('第 2 轮分叉');
    const contextViewShortText = screen.getByTestId('context-cost-inspector').textContent || '';

    // 切回「分支树」页签，点击主对话节点切回主分支
    fireEvent.click(screen.getByTestId('context-banner-open-tree'));
    await screen.findByTestId('conversation-tree-panel');
    fireEvent.click(screen.getByTestId(`tree-node-${root.sessionId}`));

    await waitFor(() => {
      expect(screen.getByTestId(`tree-node-active-${root.sessionId}`)).toBeTruthy();
      expect(screen.getByTestId(`session-pane-${root.sessionId}`)).toBeTruthy();
    });

    // 再次查看 Context 页签：必须随分支切换同步更新为主分支的 Context 窗口记录
    fireEvent.click(screen.getByTestId('conversation-tree-open-context'));
    await screen.findByTestId('context-branch-banner');
    expect(screen.getByTestId('context-branch-banner').textContent).toContain('主对话分支');
    const contextViewRootText = screen.getByTestId('context-cost-inspector').textContent || '';
    expect(contextViewRootText).not.toBe(contextViewShortText);
    // 主分支数值较大（k 级），与短分支截然不同
    expect(contextViewRootText).toContain(
      rootUsed >= 1000 ? `${(rootUsed / 1000).toFixed(1)}k` : String(rootUsed)
    );
  }, 25000);

  it('4) 重启冷启动完整恢复对话分支树、重命名同步全树、删除主对话级联清理全部隐藏子分支', async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'gravity-v023-persist-'));
    const makeCore = () =>
      new CoreService({
        dataDir,
        acpOptions: { spawn: (_b, _a, opts) => spawn(fixture.executable, fixture.args, opts) },
      });

    core = makeCore();
    const root = await core.createSession({ cwd: 'F:\\PersistTree', title: '持久化原名' });
    await core.sendPrompt({ sessionId: root.sessionId, text: '首轮问题' });
    const firstUser = (await core.getSessionMessages(root.sessionId)).find((m) => m.role === 'user')!;
    const branch = await core.reviseMessage({
      sessionId: root.sessionId,
      messageId: firstUser.id,
      text: '修订首轮问题',
    });
    await waitIdle(core, branch.sessionId);

    // 重命名主对话 -> 同步更新子分支标题（且无「· 修订」后缀污染）
    await core.renameSession(root.sessionId, '整洁的新标题');
    const listedBefore = await core.listSessions();
    const childBefore = listedBefore.find((s) => s.sessionId === branch.sessionId)!;
    expect(childBefore.title).toBe('整洁的新标题');
    expect(childBefore.parentBranchId).toBe(root.sessionId);
    expect(childBefore.rootSessionId).toBe(root.sessionId);

    // 模拟冷启动重启
    await core.dispose();
    core = makeCore();
    const restoredTree = await core.getConversationTree(root.sessionId);
    expect(restoredTree.totalBranches).toBe(2);
    expect(restoredTree.activeBranchId).toBe(branch.sessionId);
    expect(restoredTree.rootTitle).toBe('整洁的新标题');

    // 归档 -> 主对话与子分支一起归档；恢复 -> 一起恢复；删除 -> 级联彻底清除
    const archived = await core.manageSession(root.sessionId, 'archive');
    expect(archived.sessions.every((s) => Boolean(s.archivedAt))).toBe(true);
    const restored = await core.manageSession(root.sessionId, 'restore');
    expect(restored.sessions.every((s) => !s.archivedAt)).toBe(true);
    const deleted = await core.manageSession(root.sessionId, 'delete');
    expect(deleted.sessions).toHaveLength(0);
  }, 20000);

  it('5) 纯函数验证：首条用户消息分叉（Turn 0）、系统消息穿插、多层树轨线计算准确无误', () => {
    const msgsBranch1: ChatMessageItem[] = [
      { id: 'sys-0', sessionId: 'b1', role: 'system', content: '限流提醒', createdAt: '2026-11-20T00:00:00Z' },
      { id: 'u1-b1', originMessageId: 'u1-b1', sessionId: 'b1', role: 'user', content: '修订首轮', createdAt: '2026-11-20T00:00:01Z' },
      { id: 'a1-b1', originMessageId: 'a1-b1', sessionId: 'b1', role: 'assistant', content: '回复 1', createdAt: '2026-11-20T00:00:02Z' },
    ];
    const mkNode = (
      branchId: string,
      parentBranchId: string | null,
      forkAfterMessageId: string | null,
      forkUserTurnIndex: number,
      depth: number,
      childrenIds: string[],
      createdAt: string,
      isActiveBranch = false
    ) => ({
      branchId,
      rootSessionId: 'root',
      parentBranchId,
      forkAfterMessageId,
      forkUserTurnIndex,
      forkPromptPreview: branchId,
      createdAt,
      updatedAt: createdAt,
      childrenIds,
      depth,
      siblingIndex: 1,
      siblingCount: 2,
      isActiveBranch,
      isOnActivePath: isActiveBranch || branchId === 'root',
      userTurnCount: 1,
      ownMessageCount: 2,
      latestUserPreview: branchId,
      latestAssistantPreview: 'ok',
      status: 'idle' as const,
      modelId: 'gemini-4-carbon',
      usedContextTokens: 1000,
      maxContextTokens: 512000,
      usageRatio: 0.002,
      totalCostUsd: 0.01,
    });

    const nRoot = mkNode('root', null, null, -1, 0, ['b1', 'b2'], '2026-11-20T00:00:00Z');
    const nB1 = mkNode('b1', 'root', null, 0, 1, ['b1_1'], '2026-11-20T00:01:00Z', true);
    const nB11 = mkNode('b1_1', 'b1', 'a1-b1', 1, 2, [], '2026-11-20T00:02:00Z');
    const nB2 = mkNode('b2', 'root', null, 0, 1, [], '2026-11-20T00:03:00Z');
    const tree: ConversationTreeState = {
      rootSessionId: 'root',
      rootTitle: '测试树',
      activeBranchId: 'b1',
      totalBranches: 4,
      nodes: [nRoot, nB1, nB11, nB2],
      nodesById: { root: nRoot, b1: nB1, b1_1: nB11, b2: nB2 },
      updatedAt: '2026-11-20T00:03:00Z',
    };

    // 即使在 Turn 0 前穿插了 system 消息，仍准确匹配 Turn 0 的 3 路分叉 [root, b1, b2]
    const ctrl = getMessageForkControl(tree, 'b1', msgsBranch1, 'u1-b1');
    expect(ctrl).toMatchObject({
      currentIndex: 1,
      totalCount: 3,
      branchIds: ['root', 'b1', 'b2'],
      prevBranchId: 'root',
      nextBranchId: 'b2',
    });

    // 渲染行顺序和贯穿轨线：b1 不是 root 的最后一个子节点，所以 b1_1 的 ancestorHasMore 应为 [true]
    const rows = buildConversationTreeRenderRows(tree);
    expect(rows.map((r) => r.node.branchId)).toEqual(['root', 'b1', 'b1_1', 'b2']);
    expect(rows[1].isLastChild).toBe(false);
    expect(rows[2].ancestorHasMore).toEqual([true]);
    expect(rows[2].isLastChild).toBe(true);
    expect(rows[3].isLastChild).toBe(true);
  });

  it('6) 满 4 路并行会话时来回切换分支仍不超额，切回原分支可继续追问并再分叉，关标签重开直达活跃分支', async () => {
    const { core: svc, root } = await setupApp('满槽位分支切换');
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        await svc.createSession({ cwd: 'F:\\TreeQA', title: `并行占位${i}` });
      }
      await svc.sendPrompt({ sessionId: root.sessionId, text: 'BASE_MSG_1' });
    });
    expect(svc.sessions.activeSessionCount).toBe(4);

    const firstUser = (await svc.getSessionMessages(root.sessionId)).find((m) => m.role === 'user')!;
    fireEvent.click(screen.getByTestId(`edit-msg-${firstUser.id}`));
    fireEvent.change(screen.getByRole('textbox', { name: '编辑原消息' }), { target: { value: 'REVISED_MSG_1' } });
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    let branch1Id = '';
    await waitFor(async () => {
      const tree = await svc.getConversationTree(root.sessionId);
      expect(tree.totalBranches).toBe(2);
      branch1Id = tree.activeBranchId;
      expect(branch1Id).not.toBe(root.sessionId);
    });
    await waitIdle(svc, branch1Id);
    await screen.findByTestId(`session-pane-${branch1Id}`);
    expect(svc.sessions.activeSessionCount).toBe(4);

    // 切回 root 分支并继续追问，验证槽位始终稳定在 4
    await screen.findByTestId(`tree-node-${root.sessionId}`);
    fireEvent.click(screen.getByTestId(`tree-node-${root.sessionId}`));
    await screen.findByTestId(`session-pane-${root.sessionId}`);
    await act(async () => {
      await svc.sendPrompt({ sessionId: root.sessionId, text: 'ROOT_FOLLOWUP_2' });
    });
    await waitIdle(svc, root.sessionId);
    expect(svc.sessions.activeSessionCount).toBe(4);
    expect((await svc.getSessionMessages(root.sessionId)).some((m) => m.content === 'ROOT_FOLLOWUP_2')).toBe(true);

    // 通过右侧「分支树」切回 branch1，关闭该标签后点击左侧主对话行，应直达最后活跃的 branch1
    fireEvent.click(screen.getByTestId(`tree-node-${branch1Id}`));
    await screen.findByTestId(`session-pane-${branch1Id}`);
    fireEvent.click(screen.getByTestId(`tab-close-${branch1Id}`));
    await waitFor(() => expect(screen.queryByTestId(`session-pane-${branch1Id}`)).toBeNull());
    fireEvent.click(screen.getByTestId(`sidebar-session-${root.sessionId}`));
    await screen.findByTestId(`session-pane-${branch1Id}`);
    expect(svc.sessions.activeSessionCount).toBe(4);
  }, 25000);
});

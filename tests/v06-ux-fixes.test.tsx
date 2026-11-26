// @vitest-environment jsdom
import React from 'react';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageItem, ManagedSessionSummary, SwarmTopologyState } from '../src/shared';
import { CoreService } from '../src/main/core-service';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { NewSessionModal } from '../src/renderer/components/NewSessionModal';
import { ProjectSidebar } from '../src/renderer/components/ProjectSidebar';
import { SessionPane } from '../src/renderer/components/SessionPane';
import { SwarmPanel, areSwarmTextsSimilar } from '../src/renderer/components/SwarmPanel';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

function wrapI18n(node: React.ReactElement): React.ReactElement {
  return (
    <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
      {node}
    </I18nProvider>
  );
}

const tempDirs: string[] = [];

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('v0.6 右击真实点击链路、Reactive 子个体收口、Swarm 折叠、Project 管理与 Context 可视化验收', () => {
  it('1) 真实鼠标 mousedown -> mouseup -> click 全链路触发右击菜单且 file:// URI 正确解析打开', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gravity-fileuri-'));
    tempDirs.push(root);
    const sheetFile = join(root, 'antigravity_character_sheet.md');
    writeFileSync(sheetFile, '# Character Sheet');
    const fileUriWithHash = `${pathToFileURL(sheetFile).toString()}#L10-L20`;

    // 验证后端 CoreService 对 file:/// URI（之前 parsed.origin === "null" 的崩溃点）100% 正常解析
    const openedCalls: Array<{ target: string; mode: string }> = [];
    const fakeCore = {
      options: {
        openTargetHandler: async (target: string, mode: string) => {
          openedCalls.push({ target, mode });
        },
      },
    } as unknown as CoreService;
    const openFn = CoreService.prototype.openLinkOrFileTarget.bind(fakeCore);

    const resDefault = await openFn({ target: fileUriWithHash, action: 'default-app' });
    expect(resDefault.opened).toBe(true);
    expect(resDefault.modeUsed).toBe('default-app');
    expect(resDefault.resolvedTarget).toBe(realpathSync(sheetFile));

    const resCopy = await openFn({ target: fileUriWithHash, action: 'copy' });
    expect(resCopy.modeUsed).toBe('copy');
    expect(openedCalls.at(-1)?.mode).toBe('copy');

    // 验证前端真实物理点击顺序：mousedown(冒泡到 window) -> mouseup -> click 不会提前卸载菜单
    const openTargetSpy = vi.fn().mockResolvedValue({
      opened: true,
      modeUsed: 'default-app',
      resolvedTarget: sheetFile,
    });
    const bridge = getFallbackDesktopBridge();
    const boot = await bridge.getBootstrap();
    window.gravityDesktop = { ...bridge, openLinkOrFileTarget: openTargetSpy };

    const session: ManagedSessionSummary = {
      sessionId: 'sess-ctx-fix',
      rawCwd: root,
      pinned: false,
      isLegacyApprovalPollution: false,
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'default',
      title: 'Right Click Fix',
      cwd: root,
      status: 'idle',
      modelId: 'gemini-4-carbon',
      executionMode: 'accept-edits',
      reasoningEffort: 'medium',
      updatedAt: new Date().toISOString(),
    };
    const msg: ChatMessageItem = {
      id: 'm1',
      sessionId: 'sess-ctx-fix',
      role: 'assistant',
      content: `请查看角色设定卡 [antigravity_character_sheet.md](${fileUriWithHash})。`,
      createdAt: new Date().toISOString(),
    };

    render(
      wrapI18n(
        <SessionPane
          slotIndex={0}
          layoutMode="single"
          isFocused
          session={session}
          availableSessions={[session]}
          availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
          messages={[msg]}
          pendingApprovals={[]}
          approvalConfig={boot.approvalConfig}
          defaultThoughtTrack="zh"
          telemetryDashboard={boot.telemetry}
          scrollMemoryRef={{ current: {} }}
          canTriggerDemoApproval={false}
          appIcon="gravity-claude-dark"
          onFocusPane={() => {}}
          onBindSlotSession={() => {}}
          onOpenNewSession={() => {}}
          onSendPrompt={async () => {}}
          onCancelPrompt={async () => {}}
          onCompactContext={async () => {}}
          onSetSessionMode={async () => {}}
          onSetSessionEffort={async () => {}}
          onSetSessionModel={async () => {}}
          onQueryWorkspaceFiles={async () => []}
          onSubmitApproval={async () => {}}
          onCycleApprovalMode={async () => {}}
          onOpenApprovalSettings={() => {}}
          onOpenSwarmInspector={() => {}}
          onOpenContextInspector={() => {}}
          onInspectDiffFile={() => {}}
          onTriggerDemoApproval={() => {}}
        />
      )
    );

    const fileAnchor = document.querySelector<HTMLAnchorElement>('p a[href*="antigravity_character_sheet.md"]')!;
    fireEvent.contextMenu(fileAnchor, { clientX: 220, clientY: 180 });

    const defaultAppBtn = screen.getByTestId('ctx-open-default-app');
    // 真实浏览器点击顺序：先触发 mousedown（冒泡至 window），验证菜单仍然存活且 click 成功执行！
    fireEvent.mouseDown(defaultAppBtn, { button: 0, bubbles: true });
    expect(screen.queryByTestId('target-context-menu')).toBeTruthy();
    fireEvent.mouseUp(defaultAppBtn, { button: 0, bubbles: true });
    fireEvent.click(defaultAppBtn, { button: 0, bubbles: true });

    await waitFor(() => expect(openTargetSpy).toHaveBeenCalledTimes(1));
    expect(openTargetSpy).toHaveBeenCalledWith({
      target: fileUriWithHash,
      action: 'default-app',
      cwd: root,
      sessionId: 'sess-ctx-fix',
    });
  });

  it('2) 中断前仍在运行的成员等待官方汇报，按发送者确认完成', async () => {
    const tracker = new SwarmTracker();
    tracker.consume('sess-wake', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'wake-sub-1',
      name: 'invoke_subagent',
      rawInput: {
        Role: 'Anime Character Illustrator',
        TypeName: 'image-generator',
        Prompt: 'Generate anime portrait...',
      },
      rawOutput: {},
      status: 'completed',
    });
    expect(tracker.getState('sess-wake').workers[0].status).toBe('working');

    tracker.markUnconfirmed('sess-wake');
    const afterWake = tracker.getState('sess-wake');
    expect(afterWake.workers[0].status).toBe('unconfirmed');
    expect(afterWake.stats.working).toBe(0);
    expect(afterWake.stats.completed).toBe(0);
    tracker.consume('sess-wake', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'wake-msg-1',
      name: 'post_message',
      rawInput: { sender: 'Anime Character Illustrator', content: '[done] Finished' },
      rawOutput: {},
      status: 'completed',
    });
    expect(tracker.getState('sess-wake').stats.completed).toBe(1);
  });

  it('3) Swarm 面板支持长任务说明折叠，并自动折叠消息板与时间线中过度相似的内容', () => {
    expect(
      areSwarmTextsSimilar(
        '[done] 已流式翻译 Thinking 片段（gemini-3.8-flash）',
        '[done] 已流式翻译 Thinking 片段（gemini-3.8-flash）'
      )
    ).toBe(true);

    const longBrief =
      'Generate a high-quality anime-style (2D Japanese illustration) anthropomorphic character portrait representing Antigravity, an intelligent AI agent designed by Google DeepMind with floating holographic code panels and aurora sky.';

    const topology: SwarmTopologyState = {
      sessionId: 'sess-swarm-fold',
      isActive: true,
      swarmTitle: '立绘生成协作',
      channels: ['translation'],
      workers: [
        {
          id: 'w-ill',
          name: 'Anime-Illustrator',
          role: 'Anime Character Illustrator',
          kind: 'subagent',
          model: 'inherit',
          status: 'completed',
          workspaceMode: 'inherit',
          channels: [],
          brief: longBrief,
          resultSummary: '已完成新版零重力立绘输出',
          startedAt: '2026-11-18T00:10:00.000Z',
          updatedAt: '2026-11-18T00:12:00.000Z',
        },
      ],
      boardMessages: [1, 2, 3, 4].map((seq) => ({
        seq,
        sender: 'thought-translator',
        mentions: [],
        channel: 'translation',
        content: `[done] 已流式翻译第 ${seq} 段 Thinking 片段（gemini-3.8-flash）`,
        isDoneReport: true,
        isStallAlert: false,
        timestamp: `2026-11-18T00:10:0${seq}.000Z`,
      })),
      actionTimeline: [1, 2, 3].map((idx) => ({
        id: `ev-${idx}`,
        sessionId: 'sess-swarm-fold',
        actorName: 'thought-translator',
        eventType: 'board_posted',
        summaryZh: `thought-translator：[done] 已流式翻译第 ${idx} 段 Thinking 片段`,
        summaryEn: `thought-translator: [done] Translated segment ${idx}`,
        timestamp: `2026-11-18T00:10:0${idx}.000Z`,
      })),
      stats: { total: 1, working: 0, waiting: 0, completed: 1, killed: 0 },
      updatedAt: '2026-11-18T00:12:00.000Z',
    };

    render(wrapI18n(<SwarmPanel sessionId="sess-swarm-fold" topology={topology} />));

    // 长任务说明默认折叠，点击后展开完整文本
    const briefToggle = screen.getByTestId('toggle-worker-brief-Anime-Illustrator');
    expect(briefToggle.textContent).toContain('展开全文');
    fireEvent.click(briefToggle);
    expect(screen.getByTestId('swarm-worker-Anime-Illustrator').textContent).toContain('aurora sky.');

    // 4 条高度相似的消息板内容默认折叠为 1 条代表 + "+3 条相似" 开关
    expect(screen.getByTestId('toggle-similar-board-4').textContent).toContain('3');
    expect(screen.queryByTestId('swarm-board-seq-1')).toBeNull();
    fireEvent.click(screen.getByTestId('toggle-similar-board-4'));
    expect(screen.getByTestId('swarm-board-seq-1')).toBeTruthy();

    // 3 条高度相似的时间线记录同样自动聚合折叠
    expect(screen.getByTestId('toggle-similar-timeline-ev-3').textContent).toContain('2');
  });

  it('4) 支持自定义 Project 项目文件夹、修改默认目录与侧栏常驻展示', async () => {
    const projects = [
      {
        id: 'proj-core',
        name: '核心推理引擎 Project',
        path: 'D:\\Projects\\InferenceEngine',
        description: '高性能推理后端',
        defaultMode: 'auto' as const,
        pinned: true,
      },
    ];

    render(
      wrapI18n(
        <ProjectSidebar
          collapsed={false}
          width={268}
          sessions={[]}
          openTabSessionIds={[]}
          selectedSessionId={null}
          hideLegacyPollutionSessions
          organizingTitles={false}
          projects={projects}
          onToggleCollapse={() => {}}
          onSelectSession={() => {}}
          onOpenNewSession={() => {}}
          onOrganizeTitles={async () => {}}
          onTogglePollutionVisibility={async () => {}}
          onRenameSession={async () => {}}
          onTogglePinSession={async () => {}}
        />
      )
    );

    // 即使当前有 0 条历史会话，自定义 Project 依然在侧栏显示自定义项目名
    expect(screen.getByText('核心推理引擎 Project')).toBeTruthy();

    // 验证新建会话弹窗优先加载默认目录并支持一键点击 Project 切换目录与默认 Mode
    const onCreateSpy = vi.fn().mockResolvedValue(undefined);
    render(
      wrapI18n(
        <NewSessionModal
          open
          defaultCwd={'C:\\Fallback'}
          configuredDefaultCwd={'F:\\DefaultStudio'}
          projects={projects}
          onClose={() => {}}
          onCreate={onCreateSpy}
        />
      )
    );
    const cwdInput = screen.getByTestId('new-session-cwd-input') as HTMLInputElement;
    expect(cwdInput.value).toBe('F:\\DefaultStudio');

    fireEvent.click(screen.getByTestId('new-session-project-chip-proj-core'));
    expect(cwdInput.value).toBe('D:\\Projects\\InferenceEngine');
    fireEvent.click(screen.getByTestId('confirm-create-session-btn'));
    await waitFor(() => expect(onCreateSpy).toHaveBeenCalledWith('D:\\Projects\\InferenceEngine', undefined, 'auto'));
  });

  it('在新建窗口开始输入后保留光标，不会稍后全选刚输入的路径', () => {
    vi.useFakeTimers();
    try {
      render(wrapI18n(<NewSessionModal open defaultCwd="C:/start" onClose={() => {}} onCreate={vi.fn()} />));
      const field = screen.getByTestId('new-session-cwd-input') as HTMLInputElement;
      const prefix = 'F:/draft';
      field.focus();
      fireEvent.change(field, { target: { value: prefix } });
      field.setSelectionRange(prefix.length, prefix.length);
      vi.runAllTimers();
      expect([field.selectionStart, field.selectionEnd]).toEqual([prefix.length, prefix.length]);
    } finally { vi.useRealTimers(); }
  });

  it('默认目录变化时保留手输和清空的草稿，再次打开时采用最新默认值', () => {
    const modal = (open: boolean, path: string) => wrapI18n(
      <NewSessionModal open={open} defaultCwd={path} onClose={() => {}} onCreate={vi.fn()} />);
    const { rerender } = render(modal(true, 'C:/start'));
    const field = () => screen.getByTestId('new-session-cwd-input') as HTMLInputElement;
    rerender(modal(true, 'C:/suggestion'));
    expect(field().value).toBe('C:/suggestion');
    fireEvent.change(field(), { target: { value: 'F:/my-path' } });
    rerender(modal(true, 'C:/changed'));
    expect(field().value).toBe('F:/my-path');
    fireEvent.change(field(), { target: { value: '' } });
    rerender(modal(true, 'C:/latest'));
    expect(field().value).toBe('');
    rerender(modal(false, 'C:/latest'));
    rerender(modal(true, 'C:/latest'));
    expect(field().value).toBe('C:/latest');
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 'C:/latest'.length]);
  });

  it('按最终工作目录采用项目的模式，保留第二个项目已设定的计划模式', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(wrapI18n(<NewSessionModal open defaultCwd="" onClose={() => {}} onCreate={onCreate}
      projects={[{ id: 'a', name: 'A', path: 'F:\\A', defaultMode: 'auto' },
        { id: 'b', name: 'B', path: 'F:\\B', defaultMode: 'plan' }]} />));
    fireEvent.click(screen.getByTestId('new-session-project-chip-a'));
    fireEvent.change(screen.getByTestId('new-session-cwd-input'), { target: { value: 'F:\\B' } });
    fireEvent.click(screen.getByTestId('confirm-create-session-btn'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('F:\\B', undefined, 'plan'));
  });

  it('5) Context 微圆环、按占比降序靠左且保留未使用背景色进度条、Token 左侧花费刻度条渲染正确', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const tele = structuredClone(boot.telemetry);
    tele.activeSessions['sess-primary'] = {
      ...tele.activeSessions['sess-primary'],
      maxContextTokens: 512_000,
      usedContextTokens: 102_400,
      usageRatio: 0.2,
      pressureLevel: 'healthy',
      breakdown: {
        systemAndRulesTokens: 12_000,
        userMessagesTokens: 8_000,
        agentMessagesTokens: 52_400,
        thoughtTokens: 20_000,
        toolCallsTokens: 10_000,
        attachmentsTokens: 0,
      },
    };

    render(
      wrapI18n(
        <ContextCostInspectorView
          sessionId="sess-primary"
          dashboard={tele}
          onOpenRateCardsSettings={() => {}}
        />
      )
    );

    // 1. 百分比旁显示上下文占用微圆环
    expect(screen.getByTestId('context-usage-mini-ring')).toBeTruthy();

    // 2. Context 进度条按占比降序排列（Assistant 52.4k 最靠左，随后 Thinking 20k -> System 12k -> Tools 10k -> User 8k），且总宽为 20%（右侧 80% 展示背景色）
    const ctxBar = screen.getByTestId('context-sorted-stack-bar');
    const segLabels = Array.from(ctxBar.children).map((el) => el.getAttribute('data-segment-label'));
    expect(segLabels[0]).toBe('Assistant');
    expect(segLabels[1]).toBe('Thinking');
    const totalFilledPct = Array.from(ctxBar.children).reduce(
      (sum, el) => sum + parseFloat((el as HTMLElement).style.width || '0'),
      0
    );
    expect(totalFilledPct).toBeCloseTo(20, 1);

    // 3. Token 用量左侧显示花费刻度条且保持 24 根分档色阶柱
    expect(screen.getByTestId('heatmap-y-scale')).toBeTruthy();
    expect(screen.getByTestId('heatmap-24h-bars').children).toHaveLength(24);

    // 4. Cost 总体进度条同样按金额从大到小靠左排列
    expect(screen.getByTestId('cost-sorted-stack-bar')).toBeTruthy();
  });
});

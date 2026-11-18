// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageItem, DualTrackThoughtBlock, SemanticToolCallCard } from '../src/shared';
import {
  classifyTool,
  formatDuration,
  groupToolCalls,
  summarizeTurn,
} from '../src/renderer/lib/turn-insights';
import { PaneStatusChip, ToolActivityStream, TurnOutcomeBar } from '../src/renderer/components/TurnActivity';
import { ThinkingBlock } from '../src/renderer/components/ThinkingBlock';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';

const wrap = (node: React.ReactElement) => (
  <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
    {node}
  </I18nProvider>
);

function tool(id: string, canonical: string, extra: Partial<SemanticToolCallCard> = {}): SemanticToolCallCard {
  return {
    toolCallId: id,
    rawToolName: canonical.toLowerCase(),
    canonicalToolName: canonical,
    compactTarget: `src/${id}.ts`,
    status: 'completed',
    argsSummary: '',
    startedAt: '2026-11-18T10:00:00.000Z',
    completedAt: '2026-11-18T10:00:02.000Z',
    ...extra,
  };
}

const diff = (path: string, added: number, removed: number) => ({
  filePath: path,
  oldText: '',
  newText: '',
  addedLines: added,
  removedLines: removed,
  lines: [],
  updatedAt: '',
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('v0.7 信息层级：回合洞察、工具分组、结果条、状态胶囊', () => {
  it('工具按类别分类，连续成功的只读探索被合并，改动/命令/失败保持独立', () => {
    expect(classifyTool('Read')).toBe('explore');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('Bash')).toBe('exec');
    expect(classifyTool('Subagent')).toBe('agent');

    const tools = [
      tool('r1', 'Read'),
      tool('r2', 'Grep'),
      tool('r3', 'Read'),
      tool('e1', 'Edit', { diffPatch: diff('src/a.ts', 10, 2) }),
      tool('r4', 'Read', { status: 'failed' }),
      tool('r5', 'Read'),
      tool('b1', 'Bash', { exitCode: 1 }),
    ];
    const segs = groupToolCalls(tools);
    expect(segs.map((s) => s.kind)).toEqual(['explore-group', 'single', 'single', 'single', 'single']);
    expect(segs[0].kind === 'explore-group' && segs[0].tools).toHaveLength(3);
  });

  it('回合汇总统计文件改动、命令失败与耗时', () => {
    const msg: ChatMessageItem = {
      id: 'a1',
      sessionId: 's',
      role: 'assistant',
      content: '完成',
      createdAt: '2026-11-18T10:00:05.000Z',
      completedAt: '2026-11-18T10:01:47.000Z',
      toolCalls: [
        tool('e1', 'Edit', { diffPatch: diff('src/a.ts', 10, 2) }),
        tool('e2', 'Edit', { diffPatch: diff('src/a.ts', 3, 1) }),
        tool('w1', 'Write', { diffPatch: diff('src/b.ts', 40, 0) }),
        tool('b1', 'Bash', { exitCode: 2 }),
        tool('b2', 'Bash', { exitCode: 0 }),
        tool('r1', 'Read'),
      ],
    };
    const insight = summarizeTurn(msg, '2026-11-18T10:00:00.000Z');
    expect(insight.changedFiles.map((f) => f.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(insight.addedLines).toBe(53);
    expect(insight.removedLines).toBe(3);
    expect(insight.commands).toBe(2);
    expect(insight.failedCommands).toBe(1);
    expect(insight.failedTools).toBe(1);
    expect(insight.durationMs).toBe(107_000);
    expect(formatDuration(107_000)).toBe('1m 47s');
    expect(formatDuration(450)).toBe('0.5s');
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });

  it('命令与文件操作在同一行下折叠，展开后同级显示并保留失败状态', () => {
    render(wrap(<ToolActivityStream tools={[tool('r1', 'Read'), tool('r2', 'Glob'),
      tool('b1', 'Bash', { status: 'failed', outputPreview: 'npm ERR!' }), tool('w1', 'Write')]} onInspectDiff={() => {}} />));
    const group = screen.getByTestId('tool-group-r1') as HTMLDetailsElement;
    expect(group.open).toBe(false);
    expect(group.querySelector('summary')?.textContent).toMatch(/操作记录.*4/);
    fireEvent.click(group.querySelector('summary')!);
    expect(group.open).toBe(true);
    const body = group.querySelector('.tool-group-body');
    for (const id of ['r1', 'r2', 'b1', 'w1']) expect(screen.getByTestId('tool-card-' + id).parentElement).toBe(body);

    const failed = screen.getByTestId('tool-card-b1');
    expect(failed.classList.contains('is-failed')).toBe(true);
    expect(failed.getAttribute('data-tool-category')).toBe('exec');
  });

  it('回合结果条展示成功/失败、耗时、改动文件并可点击跳转 Diff', () => {
    const onInspect = vi.fn();
    const msg: ChatMessageItem = {
      id: 'a2',
      sessionId: 's',
      role: 'assistant',
      content: 'ok',
      createdAt: '2026-11-18T10:00:00.000Z',
      completedAt: '2026-11-18T10:00:42.000Z',
      toolCalls: [tool('e1', 'Edit', { diffPatch: diff('src/renderer/App.tsx', 12, 4) }), tool('b1', 'Bash', { exitCode: 1 })],
    };
    render(wrap(<TurnOutcomeBar message={msg} onInspectDiff={onInspect} />));
    const bar = screen.getByTestId('turn-outcome-a2');
    expect(bar.classList.contains('has-failure')).toBe(true);
    expect(bar.textContent).toContain('1 项失败');
    expect(bar.textContent).toContain('42s');
    expect(bar.textContent).toContain('修改 1 个文件');
    fireEvent.click(screen.getByText('App.tsx'));
    expect(onInspect).toHaveBeenCalledWith('src/renderer/App.tsx');
  });

  it('仍有工具在等待（如待审批）时结果条显示等待中而不是完成', () => {
    const msg: ChatMessageItem = {
      id: 'a4',
      sessionId: 's',
      role: 'assistant',
      content: '请确认',
      createdAt: '2026-11-18T10:00:00.000Z',
      toolCalls: [tool('e1', 'Edit', { diffPatch: diff('src/a.ts', 1, 1) }), tool('b1', 'Bash', { status: 'pending', completedAt: undefined })],
    };
    render(wrap(<TurnOutcomeBar message={msg} onInspectDiff={() => {}} />));
    const bar = screen.getByTestId('turn-outcome-a4');
    expect(bar.classList.contains('is-pending')).toBe(true);
    expect(bar.textContent).toContain('1 项等待中');
    expect(bar.textContent).not.toContain('完成');
  });

  it('纯短文本回复不显示结果条，避免噪音', () => {
    const msg: ChatMessageItem = {
      id: 'a3',
      sessionId: 's',
      role: 'assistant',
      content: '你好',
      createdAt: '2026-11-18T10:00:00.000Z',
      completedAt: '2026-11-18T10:00:00.800Z',
    };
    render(wrap(<TurnOutcomeBar message={msg} onInspectDiff={() => {}} />));
    expect(screen.queryByTestId('turn-outcome-a3')).toBeNull();
  });

  it('窗格状态胶囊：待审批优先，运行中显示实时计时，空闲不显示', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T10:00:30.000Z'));
    const { rerender } = render(
      wrap(<PaneStatusChip sessionId="s" status="streaming" pendingApprovals={0} turnStartedAt="2026-11-18T10:00:00.000Z" />)
    );
    expect(screen.getByTestId('pane-status-chip-s').textContent).toContain('运行中');
    expect(screen.getByTestId('pane-status-chip-s').textContent).toContain('30s');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('pane-status-chip-s').textContent).toContain('35s');

    rerender(wrap(<PaneStatusChip sessionId="s" status="streaming" pendingApprovals={2} />));
    expect(screen.getByTestId('pane-status-chip-s').textContent).toContain('待审批 ×2');

    rerender(wrap(<PaneStatusChip sessionId="s" status="idle" pendingApprovals={0} />));
    expect(screen.queryByTestId('pane-status-chip-s')).toBeNull();
  });

  it('思考默认展开，完成保持展开，手动收起对后续片段和重开有效', () => {
    const base: DualTrackThoughtBlock = {
      id: 'th',
      originalText: '先检查 **core-service** 的回合收口逻辑，再补测试。',
      translatedZhText: '先检查 **core-service** 的回合收口逻辑，再补测试。',
      isStreaming: true,
      languageDetected: 'zh',
      translationSource: 'native-zh',
    };
    localStorage.removeItem('gravity.thoughts.expanded');
    const view = render(wrap(<ThinkingBlock thought={base} defaultTrack="zh" />));
    expect(screen.getByTestId('thought-content-th')).toBeTruthy();
    view.rerender(wrap(<ThinkingBlock thought={{ ...base, isStreaming: false }} defaultTrack="zh" />));
    expect(screen.getByTestId('thought-content-th')).toBeTruthy();
    fireEvent.click(screen.getByTestId('thinking-block-th').querySelector('[aria-expanded]')!);
    expect(screen.queryByTestId('thought-content-th')).toBeNull();
    view.unmount();
    render(wrap(<><ThinkingBlock thought={{ ...base, isStreaming: false }} defaultTrack="zh" />
      <ThinkingBlock thought={{ ...base, id: 'next', originalText: 'New text', translatedZhText: '新译文', languageDetected: 'en' }} defaultTrack="zh" /></>));
    expect(screen.queryByTestId('thought-content-next')).toBeNull();
    expect(screen.getByTestId('thinking-block-next').textContent).toContain('新译文');
    expect(screen.getByTestId('thinking-block-th').textContent).toContain('先检查 core-service 的回合收口逻辑');
    fireEvent.click(screen.getByTestId('thinking-block-next').querySelector('[aria-expanded]')!);
    expect(screen.getByTestId('thought-content-th')).toBeTruthy();
    expect(screen.getByTestId('thought-content-next').textContent).toContain('新译文');
  });
});

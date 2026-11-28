// @vitest-environment jsdom
import React, { Profiler, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { InlinePlanCard, PlanTimeline } from '../src/renderer/components/PlanTimeline';
import { PlanArtifactPanel } from '../src/renderer/components/PlanArtifactPanel';
import { SessionPane, type SessionPaneProps } from '../src/renderer/components/SessionPane';
import { SentAnnotations } from '../src/renderer/components/SentAnnotations';
import { EditUserMessage } from '../src/renderer/components/EditUserMessage';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import {
  clearAnnotationDraft,
  mergeRestoredAnnotations,
  migrateLegacyDraft,
  newAnnotationId,
  setActiveAnnotation,
  showAnnotationRanges,
  toWireAnnotations,
  type AnnotationDraftItem,
} from '../src/renderer/lib/annotation-drafts';
import { anchorFromRange, annotatableText, rangeFromAnchor, resolveAnchorOffset } from '../src/renderer/lib/annotation-text';
import { computePlanProgress, derivePlanViewKind, groupPlanTimeline, resolveAuthoritativeTodos } from '../src/renderer/lib/plan-view';
import {
  DEFAULT_APPROVAL_CONFIG,
  type ChatMessageItem,
  type ClientLocale,
  type GravityDesktopBridge,
  type ManagedSessionSummary,
  type PlanArtifactChangedEvent,
  type PlanArtifactSnapshot,
  type RightInspectorTab,
  type SessionInspectorData,
  type SessionTodoItem,
  type TelemetryDashboardSnapshot,
} from '../src/shared';

function wrap(ui: React.ReactElement, locale: ClientLocale = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {ui}
    </I18nProvider>
  );
}

function makeTelemetry(): TelemetryDashboardSnapshot {
  const zero = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    inputCostUsd: 0,
    cachedInputCostUsd: 0,
    outputCostUsd: 0,
    thinkingCostUsd: 0,
    totalCostUsd: 0,
  };
  return {
    generatedAt: '2026-11-28T00:00:00.000Z',
    pricingSource: 'reference-api-estimate',
    activeSessions: {},
    hourly24h: [],
    matrix7d: [],
    calendar30d: [],
    costByRange: { today: zero, '7d': zero, '30d': zero },
    modelBreakdownByRange: { today: [], '7d': [], '30d': [] },
    sessionModelBreakdowns: {},
    rateCards: [],
  };
}

function makeSession(overrides: Partial<ManagedSessionSummary> = {}): ManagedSessionSummary {
  return {
    sessionId: 'sess-v036-ann',
    profileId: 'p-v036',
    title: 'v0.3.6 QA Session',
    cwd: 'C:\\Workspace\\Gravity',
    rawCwd: 'C:\\Workspace\\Gravity',
    pinned: false,
    isLegacyApprovalPollution: false,
    originKind: 'acp-live',
    readOnly: false,
    status: 'idle',
    modelId: 'gemini-4-carbon',
    executionMode: 'default',
    reasoningEffort: 'high',
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...overrides,
  };
}

let seqId = 0;
function uid(prefix: string): string {
  return `${prefix}-${++seqId}`;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetFallbackDesktopBridge();
  window.gravityDesktop = { ...getFallbackDesktopBridge() };
});

afterEach(() => {
  cleanup();
  setActiveAnnotation(null);
  delete window.gravityDesktop;
  vi.restoreAllMocks();
});

/* ============================================================================
 * PART A · Plan 四态时间线与按需原文抽屉（TC-PLAN-01 .. TC-PLAN-17）
 * ========================================================================== */

describe('Gravity v0.3.6 Plan 四态时间线与按需原文抽屉 (TC-PLAN-01..17)', () => {
  it('TC-PLAN-01 & TC-PLAN-08：状态 ①（纯空）、①′（unavailable 无文件名）、④（显式清空 DEC-04：0 文件栏且不复活旧 todos）', async () => {
    const s1 = uid('plan-s1');
    const s1p = uid('plan-s1p');
    const s4 = uid('plan-s4');

    // ① 纯空态
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({ status: 'missing', owner: { profileId: 'p1', sessionId: s1 }, revision: 0 }),
    };
    const v1 = render(wrap(<PlanTimeline profileId="p1" sessionId={s1} plan={undefined} todos={[]} />));
    expect(await screen.findByTestId('plan-empty')).toBeTruthy();
    expect(screen.queryByTestId('plan-source-line')).toBeNull();
    expect(screen.getByTestId('inspector-view-plan').textContent).not.toContain('implementation_plan.md');
    v1.unmount();

    // ①′ unavailable：仅展示原因，不含文件名
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({
        status: 'unavailable',
        owner: { profileId: 'p1', sessionId: s1p },
        revision: 0,
        reason: '文件超出体积上限',
      }),
    };
    const v1p = render(wrap(<PlanTimeline profileId="p1" sessionId={s1p} plan={undefined} todos={[]} />));
    const unavail = await screen.findByTestId('plan-unavailable');
    expect(unavail.textContent).toContain('文件超出体积上限');
    expect(unavail.textContent).not.toContain('implementation_plan.md');
    expect(screen.queryByTestId('plan-source-line')).toBeNull();
    v1p.unmount();

    // ④ 显式清空（DEC-04）：即使后端存在 implementation_plan.md 且旧消息有 todos，仍 0 文件栏、0 文件名、0 旧待办复活
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({
        status: 'ready',
        view: 'summary',
        owner: { profileId: 'p1', sessionId: s4 },
        revision: 5,
        summaryRevision: 5,
        contentRevision: 5,
        filePath: 'C:\\brain\\implementation_plan.md',
        outline: { title: '旧计划', sections: [{ id: 'sec-1', level: 2, heading: '不应在清空态露文件栏', summary: '' }], sectionCount: 1 },
      }),
    };
    const oldMsg: ChatMessageItem = {
      id: 'm-old',
      sessionId: s4,
      role: 'assistant',
      content: '',
      createdAt: '',
      todos: [{ id: 'ghost-1', content: '不应复活的旧待办', status: 'in_progress' }],
    };
    const clearedSession = makeSession({ sessionId: s4, profileId: 'p1' });
    render(
      wrap(
        <SessionPane
          slotIndex={0}
          layoutMode="single"
          isFocused
          session={clearedSession}
          availableSessions={[clearedSession]}
          availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
          messages={[oldMsg]}
          pendingApprovals={[]}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          defaultThoughtTrack="zh"
          telemetryDashboard={makeTelemetry()}
          inspectorData={{
            sessionId: s4,
            diffs: [],
            terminals: [],
            todos: [],
            plan: { state: 'empty', revision: 5, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
          }}
          scrollMemoryRef={{ current: {} }}
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
        />
      )
    );
    expect(await screen.findByTestId('plan-cleared')).toBeTruthy();
    expect(screen.queryByTestId('plan-source-line')).toBeNull();
    expect(screen.queryByTestId('plan-source-open')).toBeNull();
    expect(screen.queryByTestId('plan-artifact-open-file')).toBeNull();
    expect(screen.queryByText('不应复活的旧待办')).toBeNull();
    const clearedCard = screen.getByTestId('inline-plan-card');
    expect(clearedCard.getAttribute('data-plan-view')).toBe('cleared');
    expect(clearedCard.textContent).not.toContain('implementation_plan.md');

    // 仅当 plan 缺省时，resolveAuthoritativeTodos 才允许回溯旧消息
    expect(resolveAuthoritativeTodos(undefined, [], [oldMsg])).toHaveLength(1);
    expect(
      resolveAuthoritativeTodos(
        { state: 'empty', revision: 1, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
        [],
        [oldMsg]
      )
    ).toEqual([]);
  });

  it('TC-PLAN-02 & TC-PLAN-14：状态 ②（文档概要态）仅读 summary、0 假百分比、中性圆点、底部执行前提示与中英切换', async () => {
    const sid = uid('plan-s2');
    const getSessionPlanArtifact = vi.fn().mockResolvedValue({
      status: 'ready',
      view: 'summary',
      owner: { profileId: 'p1', sessionId: sid },
      revision: 2,
      summaryRevision: 2,
      contentRevision: 2,
      filePath: 'C:\\brain\\implementation_plan.md',
      updatedAt: '2026-11-28T00:00:00.000Z',
      outline: {
        title: 'v0.3.6 重构计划',
        goal: '重构语音与 Plan 视图，不引入虚假进度百分比。',
        sections: [
          { id: 'a', heading: '契约冻结', summary: '统一共享协议' },
          { id: 'b', heading: '渲染层改造', summary: '四态时间线' },
        ],
        sectionCount: 4,
      },
    });
    window.gravityDesktop = { ...getFallbackDesktopBridge(), getSessionPlanArtifact };

    const view = render(
      wrap(
        <PlanTimeline
          profileId="p1"
          sessionId={sid}
          plan={{ state: 'unreceived', revision: 0, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 }}
          todos={[]}
        />,
        'zh-CN'
      )
    );
    const outline = await screen.findByTestId('plan-outline');
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(1);
    expect(getSessionPlanArtifact).toHaveBeenCalledWith({ profileId: 'p1', sessionId: sid, view: 'summary' });
    expect(outline.textContent).toContain('v0.3.6 重构计划');
    expect(screen.getByTestId('plan-outline-goal').textContent).toContain('重构语音与 Plan 视图');
    expect(screen.getByTestId('plan-outline-section-a').querySelector('.plan-outline-dot')).toBeTruthy();
    expect(outline.textContent).toContain('另有 2 个章节');
    expect(outline.textContent).toContain('执行开始后显示实时进度');
    expect(screen.queryByTestId('plan-progressbar')).toBeNull();
    expect(screen.queryByTestId('plan-artifact-document')).toBeNull();
    expect(screen.getByTestId('plan-source-open')).toBeTruthy();

    // 切换英文验证提示语国际化
    view.rerender(
      wrap(
        <PlanTimeline
          profileId="p1"
          sessionId={sid}
          plan={{ state: 'unreceived', revision: 0, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 }}
          todos={[]}
        />,
        'en-US'
      )
    );
    expect(screen.getByTestId('plan-outline').textContent).toContain('Live progress will appear once execution begins.');
  });

  it('TC-PLAN-03 & TC-PLAN-04 & TC-PLAN-11：状态 ③ 6 态时间线、≥3 连续已完成折叠、章节数底栏与截断提示', async () => {
    const sid = uid('plan-s3');
    const todos: SessionTodoItem[] = [
      { id: 'c1', content: '步骤一', status: 'completed' },
      { id: 'c2', content: '步骤二', status: 'completed' },
      { id: 'c3', content: '步骤三', status: 'completed' },
      { id: 'ip1', content: '执行核心联调', status: 'in_progress' },
      { id: 'p1', content: '等待打包冒烟', status: 'pending' },
      { id: 'sk1', content: '跳过旧步骤', status: 'skipped' },
      { id: 'f1', content: 'src/' + 'deep-nested-dir/'.repeat(8) + 'broken.ts', status: 'failed' },
      { id: 'u1', content: '等待审批网关', status: 'unknown', rawStatus: 'blocked-external' },
    ];
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({
        status: 'ready',
        view: 'summary',
        owner: { profileId: 'p1', sessionId: sid },
        revision: 3,
        summaryRevision: 3,
        contentRevision: 3,
        filePath: 'C:\\brain\\implementation_plan.md',
        outline: { title: '计划', sections: [{ id: 's1', heading: '一' }, { id: 's2', heading: '二' }, { id: 's3', heading: '三' }], sectionCount: 3 },
      }),
    };

    const view = render(
      wrap(
        <PlanTimeline
          profileId="p1"
          sessionId={sid}
          plan={{ state: 'present', revision: 3, truncated: true, totalCount: 12, completedCount: 3, failedCount: 1 }}
          todos={todos}
        />
      )
    );

    // 连续 3 条 completed 默认折叠为「已完成 3 步」
    const groupBtn = screen.getByTestId('plan-done-group-c1');
    expect(groupBtn.textContent).toContain('已完成 3 步');
    expect(screen.queryByTestId('plan-item-c1')).toBeNull();
    fireEvent.click(groupBtn);
    expect(screen.getByTestId('plan-item-c1').dataset.status).toBe('completed');
    expect(screen.getByTestId('plan-item-c2').dataset.status).toBe('completed');
    expect(screen.getByTestId('plan-item-c3').dataset.status).toBe('completed');

    // 其余 5 态与进度条/当前步/截断提示
    expect(screen.getByTestId('plan-item-ip1').dataset.status).toBe('in_progress');
    expect(screen.getByTestId('plan-item-p1').dataset.status).toBe('pending');
    expect(screen.getByTestId('plan-item-sk1').dataset.status).toBe('skipped');
    expect(screen.getByTestId('plan-item-f1').dataset.status).toBe('failed');
    expect(screen.getByTestId('plan-item-u1').textContent).toContain('blocked-external');
    expect(screen.getByTestId('plan-current-step').textContent).toContain('执行核心联调');
    const bar = screen.getByTestId('plan-progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('12');
    expect((bar.firstElementChild as HTMLElement).style.getPropertyValue('--fill')).toBe('0.25');
    expect(screen.getByTestId('plan-truncated-hint')).toBeTruthy();

    // 底部文档行携带章节数（中/英）
    await waitFor(() => expect(screen.getByTestId('plan-source-open').textContent).toContain('计划文档 · 3 个章节'));
    view.rerender(
      wrap(
        <PlanTimeline
          profileId="p1"
          sessionId={sid}
          plan={{ state: 'present', revision: 3, truncated: true, totalCount: 12, completedCount: 3, failedCount: 1 }}
          todos={todos}
        />,
        'en-US'
      )
    );
    expect(screen.getByTestId('plan-source-open').textContent).toContain('Plan document · 3 sections');

    // 纯函数边界验证：2 条已完成不折叠，3 条以上才折叠
    expect(groupPlanTimeline(todos.slice(0, 2)).every((e) => e.kind === 'item')).toBe(true);
    expect(computePlanProgress(undefined, todos).done).toBe(3);
    expect(derivePlanViewKind({ plan: undefined, todos: [], artifactStatus: 'missing', hasOutline: false })).toBe('empty');
  });

  it('TC-PLAN-05..07 & TC-PLAN-16：按需原文抽屉、Esc 关闭、Mermaid 折叠、Callout、GFM 表格、0 <img> 与 D-01 owner 边界', async () => {
    const sid = uid('plan-drawer');
    const filePath = 'C:\\Users\\QA\\.gemini\\brain\\plan-drawer\\implementation_plan.md';
    const md = [
      '# 实施总览',
      '',
      '> [!IMPORTANT]',
      '> 严禁擅自修改冻结契约。',
      '',
      '> [!WARNING]',
      '> 请勿加载远端图片。',
      '',
      '| 模块 | 责任人 | 状态 |',
      '| --- | --- | --- |',
      '| Voice | Neon | Ready |',
      '| Plan | Astra | Ready |',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Summary] --> B[Drawer]',
      '  B --> C[Done]',
      '```',
      '',
      '![恶意信标](https://tracker.example.com/pixel.png)',
      '',
      '## 验证章节',
      '- [跳转](#验证章节) / [外链](https://example.com) / [本体](file:///C:/Users/QA/.gemini/brain/plan-drawer/implementation_plan.md)',
    ].join('\n');

    const getSessionPlanArtifact = vi.fn(async (input: { view?: 'summary' | 'content' }) =>
      input.view === 'content'
        ? {
            status: 'ready' as const,
            view: 'content' as const,
            owner: { profileId: 'p1', sessionId: sid },
            revision: 4,
            summaryRevision: 4,
            contentRevision: 4,
            filePath,
            content: md,
            truncated: false,
            updatedAt: '2026-11-28T00:00:00.000Z',
          }
        : {
            status: 'ready' as const,
            view: 'summary' as const,
            owner: { profileId: 'p1', sessionId: sid },
            revision: 4,
            summaryRevision: 4,
            contentRevision: 4,
            filePath,
            outline: { title: '实施总览', sections: [{ id: 'v', level: 2, heading: '验证章节', summary: '' }], sectionCount: 1 },
            updatedAt: '2026-11-28T00:00:00.000Z',
          }
    );
    const openLinkOrFileTarget = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'browser', resolvedTarget: '' });
    window.gravityDesktop = { ...getFallbackDesktopBridge(), getSessionPlanArtifact, openLinkOrFileTarget };

    render(wrap(<PlanTimeline profileId="p1" sessionId={sid} cwd="C:\\repo" plan={undefined} todos={[]} />));
    await screen.findByTestId('plan-outline');
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(1);

    // 打开原文抽屉才发 view: 'content'
    fireEvent.click(screen.getByTestId('plan-source-open'));
    const doc = await screen.findByTestId('plan-artifact-document');
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(2);
    expect(getSessionPlanArtifact).toHaveBeenLastCalledWith({ profileId: 'p1', sessionId: sid, view: 'content' });

    // Mermaid 折叠、Callout、GFM 表格、0 <img>
    const mermaid = screen.getByTestId('plan-doc-mermaid');
    expect(mermaid.hasAttribute('open')).toBe(false);
    expect(mermaid.textContent).toContain('3');
    expect(screen.getByTestId('plan-doc-callout-important').textContent).toContain('严禁擅自修改冻结契约');
    expect(screen.getByTestId('plan-doc-callout-warning').textContent).toContain('请勿加载远端图片');
    const table = doc.querySelector('table.md-table');
    expect(table).toBeTruthy();
    expect(table?.querySelectorAll('thead th')).toHaveLength(3);
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(doc.querySelectorAll('img')).toHaveLength(0);

    // #anchor 页内滚动 0 IPC；外链无 owner；本体带 owner
    const heading = doc.querySelector<HTMLElement>('[data-anchor="验证章节"]')!;
    heading.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: '跳转' }));
    expect(heading.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(openLinkOrFileTarget).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '外链' })));
    expect(openLinkOrFileTarget.mock.calls.at(-1)?.[0].planArtifactOwner).toBeUndefined();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '本体' })));
    expect(openLinkOrFileTarget.mock.calls.at(-1)?.[0].planArtifactOwner).toMatchObject({
      profileId: 'p1',
      sessionId: sid,
      contentRevision: 4,
    });

    // 抽屉内按 Esc 关闭回到概要态
    fireEvent.keyDown(screen.getByTestId('plan-source-drawer'), { key: 'Escape' });
    expect(screen.queryByTestId('plan-source-drawer')).toBeNull();
    expect(screen.getByTestId('plan-outline')).toBeTruthy();
  });

  it('TC-PLAN-13（QA1-FE-12）：summaryRevision 未变而 contentRevision 递增时，重挂后打开抽屉强制拉取最新正文', async () => {
    const sid = uid('plan-dual-rev');
    let contentRev = 100;
    const getSessionPlanArtifact = vi.fn(
      async (input: { view?: 'summary' | 'content'; knownRevision?: number }): Promise<PlanArtifactSnapshot> => {
        const view = input.view ?? 'summary';
        if (view === 'summary') {
          if (input.knownRevision === 100) {
            return {
              status: 'unchanged',
              view: 'summary',
              owner: { profileId: 'p1', sessionId: sid },
              revision: 100,
              summaryRevision: 100,
              contentRevision: contentRev,
            };
          }
          return {
            status: 'ready',
            view: 'summary',
            owner: { profileId: 'p1', sessionId: sid },
            revision: 100,
            summaryRevision: 100,
            contentRevision: contentRev,
            filePath: 'C:\\brain\\implementation_plan.md',
            outline: { title: '大纲不变', sections: [{ id: 's1', level: 2, heading: '第一节', summary: '' }], sectionCount: 1 },
          };
        }
        return {
          status: 'ready',
          view: 'content',
          owner: { profileId: 'p1', sessionId: sid },
          revision: contentRev,
          summaryRevision: 100,
          contentRevision: contentRev,
          filePath: 'C:\\brain\\implementation_plan.md',
          content: contentRev === 100 ? '# 大纲不变\n\n旧版正文 v1' : '# 大纲不变\n\n全新正文 v2',
        };
      }
    );
    window.gravityDesktop = { ...getFallbackDesktopBridge(), getSessionPlanArtifact };

    // 1) 首次挂载并打开抽屉缓存 contentRev=100
    const first = render(wrap(<PlanTimeline profileId="p1" sessionId={sid} plan={undefined} todos={[]} />));
    await screen.findByTestId('plan-outline');
    fireEvent.click(screen.getByTestId('plan-source-open'));
    expect((await screen.findByTestId('plan-artifact-document')).textContent).toContain('旧版正文 v1');
    first.unmount();

    // 2) 卸载期间正文更新但大纲未变：summaryRevision=100 不变，contentRevision 升至 200
    contentRev = 200;

    // 3) 切回 Plan 页签重挂 -> 收到 summary unchanged(contentRevision=200) -> 标脏缓存 -> 再次打开抽屉必须重拉 v2
    render(wrap(<PlanTimeline profileId="p1" sessionId={sid} plan={undefined} todos={[]} />));
    await waitFor(() =>
      expect(getSessionPlanArtifact).toHaveBeenCalledWith({
        profileId: 'p1',
        sessionId: sid,
        view: 'summary',
        knownRevision: 100,
      })
    );
    fireEvent.click(screen.getByTestId('plan-source-open'));
    await waitFor(() => expect(screen.getByTestId('plan-artifact-document').textContent).toContain('全新正文 v2'));
  });

  it('TC-PLAN-15 & TC-PLAN-17 & TC-PLAN-10：rerender 切会话复位抽屉、epoch undefined→1 不重复拉取、epoch 1→2 正确刷新与事件跨 epoch 过滤', async () => {
    const sA = uid('plan-ep-a');
    const sB = uid('plan-ep-b');
    let listener: ((e: PlanArtifactChangedEvent) => void) | undefined;
    const getSessionPlanArtifact = vi.fn(async (input: { profileId: string; sessionId: string; view?: 'summary' | 'content' }) => ({
      status: 'ready' as const,
      view: input.view ?? 'summary',
      owner: { profileId: input.profileId, sessionId: input.sessionId },
      revision: 1,
      summaryRevision: 1,
      contentRevision: 1,
      filePath: `C:\\brain\\${input.sessionId}\\implementation_plan.md`,
      ...(input.view === 'content'
        ? { content: `# ${input.sessionId} 全文` }
        : { outline: { title: `概要 ${input.sessionId}`, sections: [{ id: 'x', level: 2, heading: '章节', summary: '' }], sectionCount: 1 } }),
    }));
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact,
      onPlanArtifactChanged: (fn) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    };

    const view = render(wrap(<PlanTimeline profileId="p1" sessionId={sA} epoch={undefined} plan={undefined} todos={[]} />));
    await screen.findByTestId('plan-outline');
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(1);

    // 首帧 epoch undefined -> 1 收敛：不触发第二次 summary 拉取
    view.rerender(wrap(<PlanTimeline profileId="p1" sessionId={sA} epoch={1} plan={undefined} todos={[]} />));
    await act(async () => { await Promise.resolve(); });
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(1);

    // 跨 epoch 事件被忽略
    await act(async () => listener?.({ profileId: 'p1', sessionId: sA, epoch: 99, revision: 9, summaryRevision: 9, contentRevision: 9 }));
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(1);

    // 打开 sA 抽屉后，epoch 1 -> 2 触发失效重拉
    fireEvent.click(screen.getByTestId('plan-source-open'));
    await screen.findByTestId('plan-artifact-document');
    const beforeEpochBump = getSessionPlanArtifact.mock.calls.length;
    view.rerender(wrap(<PlanTimeline profileId="p1" sessionId={sA} epoch={2} plan={undefined} todos={[]} />));
    await waitFor(() => expect(getSessionPlanArtifact.mock.calls.length).toBeGreaterThan(beforeEpochBump));

    // 直接 rerender 切换到 sB：drawerOpen 必须自动复位（不直接显示 sB 的抽屉）
    view.rerender(wrap(<PlanTimeline profileId="p1" sessionId={sB} epoch={1} plan={undefined} todos={[]} />));
    await waitFor(() => expect(screen.queryByTestId('plan-source-drawer')).toBeNull());
    expect((await screen.findByTestId('plan-outline')).textContent).toContain(`概要 ${sB}`);

    // 兼容外壳 PlanArtifactPanel 同样遵守按需读取
    view.unmount();
    render(wrap(<PlanArtifactPanel profileId="p1" sessionId={sB} />));
    expect(await screen.findByTestId('plan-outline')).toBeTruthy();
    expect(screen.queryByTestId('plan-artifact-document')).toBeNull();
  });

  it('TC-PLAN-09 & TC-PLAN-12：主对话流仅最新含待办消息挂载 1 张 InlinePlanCard（折叠态示进度与当前步）；旧桥接直接返回 content 自动降级提取概要', async () => {
    const sid = uid('inline-plan-sess');
    const session = makeSession({ sessionId: sid });
    const messages: ChatMessageItem[] = [
      {
        id: 'a1',
        sessionId: sid,
        role: 'assistant',
        content: '第一轮计划',
        createdAt: '2026-11-28T00:00:00.000Z',
        todos: [{ id: 'old-t', content: '旧消息待办', status: 'completed' }],
      },
      {
        id: 'a2',
        sessionId: sid,
        role: 'assistant',
        content: '第二轮进度',
        createdAt: '2026-11-28T00:01:00.000Z',
        todos: [
          { id: 'n1', content: '已完成步骤', status: 'completed' },
          { id: 'n2', content: '当前进行步骤', status: 'in_progress' },
        ],
      },
    ];
    render(
      wrap(
        <SessionPane
          slotIndex={0}
          layoutMode="single"
          isFocused
          session={session}
          availableSessions={[session]}
          availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
          messages={messages}
          pendingApprovals={[]}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          defaultThoughtTrack="zh"
          telemetryDashboard={makeTelemetry()}
          scrollMemoryRef={{ current: {} }}
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
        />
      )
    );
    // 仅最新含待办助手消息 a2 挂载 1 张 InlinePlanCard（旧消息不渲染，无残留 plan-chip-*）
    const cards = screen.getAllByTestId('inline-plan-card');
    expect(cards).toHaveLength(1);
    expect(screen.queryByTestId(/^plan-chip-/)).toBeNull();
    expect(cards[0].closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a2');
    expect(screen.getByTestId('plan-item-n1')).toBeTruthy();
    expect(screen.getByTestId('plan-item-n2')).toBeTruthy();
    expect(screen.queryByText('旧消息待办')).toBeNull();
    // 展开态仅 1 个 role="progressbar"；折叠后头部显示 1 / 2 进度与当前步骤且装饰条 aria-hidden
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('inline-plan-toggle'));
    expect(screen.queryByTestId('plan-timeline')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('inline-plan-toggle').textContent).toContain('1 / 2');
    expect(screen.getByTestId('inline-plan-toggle').textContent).toContain('当前进行步骤');

    // TC-PLAN-12：旧桥接返回 content（无 outline）自动降级提取概要并可直接原地展开原文
    cleanup();
    const legacySid = uid('plan-legacy-fallback');
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({
        status: 'ready',
        owner: { profileId: 'p1', sessionId: legacySid },
        revision: 1,
        content: '# 兼容旧桥接\n\n## 第一阶段\n正文内容',
      }),
    };
    render(wrap(<InlinePlanCard profileId="p1" sessionId={legacySid} plan={undefined} todos={[]} />));
    expect((await screen.findByTestId('plan-outline')).textContent).toContain('第一阶段');
    fireEvent.click(screen.getByTestId('plan-source-open'));
    expect((await screen.findByTestId('plan-artifact-document')).textContent).toContain('正文内容');
  });
});

/* ============================================================================
 * PART A2 · InlinePlanCard 深度交互、QA-1 回归守卫与 4 页签 RightInspector（QA-2）
 * ========================================================================== */

function makePaneProps(overrides: Partial<SessionPaneProps> & { session: ManagedSessionSummary }): SessionPaneProps {
  return {
    slotIndex: 0,
    layoutMode: 'single',
    isFocused: true,
    availableSessions: [overrides.session],
    availableModels: [{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }],
    messages: [],
    pendingApprovals: [],
    approvalConfig: DEFAULT_APPROVAL_CONFIG,
    defaultThoughtTrack: 'zh',
    telemetryDashboard: makeTelemetry(),
    scrollMemoryRef: { current: {} },
    appIcon: 'gravity-claude-dark',
    onFocusPane: () => {},
    onBindSlotSession: () => {},
    onOpenNewSession: () => {},
    onSendPrompt: async () => {},
    onCancelPrompt: async () => {},
    onCompactContext: async () => {},
    onSetSessionMode: async () => {},
    onSetSessionEffort: async () => {},
    onSetSessionModel: async () => {},
    onQueryWorkspaceFiles: async () => [],
    onSubmitApproval: async () => {},
    onCycleApprovalMode: async () => {},
    onOpenApprovalSettings: () => {},
    onOpenSwarmInspector: () => {},
    onOpenContextInspector: () => {},
    onInspectDiffFile: () => {},
    ...overrides,
  };
}

describe('Gravity v0.3.6 InlinePlanCard 回归与 4 页签 RightInspector (QA-2)', () => {
  it('FE-P0-1：最新助手消息为 question（open / answered）时不吞卡片；全为 question 时自动兜底至流底部', async () => {
    const sid = uid('plan-q-host');
    const session = makeSession({ sessionId: sid, profileId: 'p1' });
    const inspectorData: SessionInspectorData = {
      sessionId: sid,
      diffs: [],
      terminals: [],
      todos: [
        { id: 'qt1', content: '起草设计文档', status: 'completed' },
        { id: 'qt2', content: '确认关键参数', status: 'in_progress' },
      ],
      plan: { state: 'present', revision: 2, truncated: false, totalCount: 2, completedCount: 1, failedCount: 0 },
    };
    const openQuestionMsg: ChatMessageItem = {
      id: 'a-q-open',
      sessionId: sid,
      role: 'assistant',
      content: '请确认下列问题',
      createdAt: '2026-11-28T00:02:00.000Z',
      question: { message: '选择方案', state: 'open', fields: [] },
    };
    const answeredQuestionMsg: ChatMessageItem = {
      id: 'a-q-ans',
      sessionId: sid,
      role: 'assistant',
      content: '已确认',
      createdAt: '2026-11-28T00:01:30.000Z',
      question: { message: '旧确认', state: 'answered', answer: '选项 A', fields: [] },
    };
    const normalMsg: ChatMessageItem = {
      id: 'a-normal',
      sessionId: sid,
      role: 'assistant',
      content: '已完成初步方案设计。',
      createdAt: '2026-11-28T00:01:00.000Z',
    };

    // 1) 存在早先普通助手消息 -> 回退挂载到 a-normal，绝不挂到 question 消息上导致 0 DOM
    const view = render(
      wrap(<SessionPane {...makePaneProps({ session, messages: [normalMsg, answeredQuestionMsg, openQuestionMsg], inspectorData })} />)
    );
    const card = screen.getByTestId('inline-plan-card');
    expect(card.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a-normal');
    expect(screen.getByTestId('plan-item-qt2')).toBeTruthy();

    // 2) 全部助手消息均为 question -> 兜底挂载在流底部（无 data-message-id 祖先），仍然完整渲染
    view.rerender(
      wrap(<SessionPane {...makePaneProps({ session, messages: [answeredQuestionMsg, openQuestionMsg], inspectorData })} />)
    );
    const fallbackCard = screen.getByTestId('inline-plan-card');
    expect(fallbackCard.closest('[data-message-id]')).toBeNull();
    expect(screen.getByTestId('plan-item-qt1')).toBeTruthy();
    expect(screen.getByTestId('plan-item-qt2')).toBeTruthy();
  });

  it('FE-P0-3：宿主消息从流底部 -> a1 -> a2 迁移时保留 sourceOpen / expanded / expandedGroups，切换会话后统一复位', async () => {
    const sidA = uid('plan-migrate-a');
    const sidB = uid('plan-migrate-b');
    const makeArtifact = (sid: string) => ({
      summary: {
        status: 'ready' as const,
        view: 'summary' as const,
        owner: { profileId: 'p1', sessionId: sid },
        revision: 3,
        summaryRevision: 3,
        contentRevision: 3,
        filePath: `C:\\brain\\${sid}\\implementation_plan.md`,
        outline: { title: `计划 ${sid}`, sections: [{ id: 's1', level: 2, heading: '阶段一', summary: '' }], sectionCount: 1 },
      },
      content: {
        status: 'ready' as const,
        view: 'content' as const,
        owner: { profileId: 'p1', sessionId: sid },
        revision: 3,
        summaryRevision: 3,
        contentRevision: 3,
        filePath: `C:\\brain\\${sid}\\implementation_plan.md`,
        content: `# 计划 ${sid}\n\n## 阶段一\n正在阅读的原文段落`,
      },
    });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn(async (input: { sessionId: string; view?: 'summary' | 'content' }) => {
        const pair = makeArtifact(input.sessionId);
        return input.view === 'content' ? pair.content : pair.summary;
      }),
    };

    const todos: SessionTodoItem[] = [
      { id: 'm1', content: '已完成 1', status: 'completed' },
      { id: 'm2', content: '已完成 2', status: 'completed' },
      { id: 'm3', content: '已完成 3', status: 'completed' },
      { id: 'm4', content: '进行中 4', status: 'in_progress' },
    ];
    const inspA: SessionInspectorData = {
      sessionId: sidA,
      diffs: [],
      terminals: [],
      todos,
      plan: { state: 'present', revision: 3, truncated: false, totalCount: 4, completedCount: 3, failedCount: 0 },
    };
    const sessA = makeSession({ sessionId: sidA, profileId: 'p1' });
    const sessB = makeSession({ sessionId: sidB, profileId: 'p1' });

    // 初始 0 助手消息 -> 渲染在流底部兜底位
    const view = render(wrap(<SessionPane {...makePaneProps({ session: sessA, messages: [], inspectorData: inspA })} />));
    await screen.findByTestId('plan-source-open');

    // 展开已完成折叠组 + 展开原地原文
    fireEvent.click(screen.getByTestId('plan-done-group-m1'));
    expect(screen.getByTestId('plan-item-m1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('plan-source-open'));
    expect((await screen.findByTestId('plan-artifact-document')).textContent).toContain('正在阅读的原文段落');

    // 宿主从兜底位迁移到助手消息 a1，再迁移到新回合 a2 -> 原文展开态与分组展开态必须 100% 保持
    const msgA1: ChatMessageItem = { id: 'a1', sessionId: sidA, role: 'assistant', content: '第一轮输出', createdAt: '' };
    const msgA2: ChatMessageItem = { id: 'a2', sessionId: sidA, role: 'assistant', content: '第二轮流式输出', isStreaming: true, createdAt: '' };
    view.rerender(wrap(<SessionPane {...makePaneProps({ session: sessA, messages: [msgA1], inspectorData: inspA })} />));
    expect(screen.getByTestId('inline-plan-card').closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a1');
    expect(screen.getByTestId('plan-source-drawer')).toBeTruthy();
    expect(screen.getByTestId('plan-item-m1')).toBeTruthy();

    view.rerender(wrap(<SessionPane {...makePaneProps({ session: sessA, messages: [msgA1, msgA2], inspectorData: inspA })} />));
    expect(screen.getByTestId('inline-plan-card').closest('[data-message-id]')?.getAttribute('data-message-id')).toBe('a2');
    expect(screen.getByTestId('plan-source-drawer')).toBeTruthy();
    expect(screen.getByTestId('plan-item-m1')).toBeTruthy();

    // 用户手动折叠卡片 -> 宿主再迁移至 a3 时仍保持折叠，绝不自动弹开
    fireEvent.click(screen.getByTestId('inline-plan-toggle'));
    expect(screen.getByTestId('inline-plan-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('plan-source-drawer')).toBeNull();
    const msgA3: ChatMessageItem = { id: 'a3', sessionId: sidA, role: 'assistant', content: '第三轮输出', createdAt: '' };
    view.rerender(wrap(<SessionPane {...makePaneProps({ session: sessA, messages: [msgA1, msgA2, msgA3], inspectorData: inspA })} />));
    expect(screen.getByTestId('inline-plan-toggle').getAttribute('aria-expanded')).toBe('false');

    // 切换到新会话 sidB -> expanded 复位为 true、sourceOpen 复位为 false、expandedGroups 复位为 {}
    const inspB: SessionInspectorData = { ...inspA, sessionId: sidB };
    view.rerender(wrap(<SessionPane {...makePaneProps({ session: sessB, messages: [], inspectorData: inspB })} />));
    await waitFor(() => expect(screen.getByTestId('inline-plan-toggle').getAttribute('aria-expanded')).toBe('true'));
    expect(screen.queryByTestId('plan-source-drawer')).toBeNull();
    expect(screen.getByTestId('plan-done-group-m1')).toBeTruthy();
  });

  it('FE-P0-2：split-2 双栏各自展开原文时 Esc 仅关闭聚焦栏；IME / 菜单 / 语音 / 行内编辑让路；折叠同步关原文', async () => {
    const sidL = uid('split-left');
    const sidR = uid('split-right');
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn(async (input: { sessionId: string; view?: 'summary' | 'content' }) => ({
        status: 'ready' as const,
        view: input.view ?? 'summary',
        owner: { profileId: 'p1', sessionId: input.sessionId },
        revision: 1,
        summaryRevision: 1,
        contentRevision: 1,
        filePath: `C:\\brain\\${input.sessionId}\\implementation_plan.md`,
        ...(input.view === 'content'
          ? { content: `# ${input.sessionId}\n\n原文内容` }
          : { outline: { title: `概要 ${input.sessionId}`, sections: [{ id: 's1', level: 2, heading: '一', summary: '' }], sectionCount: 1 } }),
      })),
    };

    const sessL = makeSession({ sessionId: sidL, profileId: 'p1', status: 'idle' });
    const sessR = makeSession({ sessionId: sidR, profileId: 'p1', status: 'streaming' });
    const cancelL = vi.fn().mockResolvedValue(undefined);
    const cancelR = vi.fn().mockResolvedValue(undefined);

    const renderDual = (focus: 'left' | 'right') =>
      wrap(
        <div className="workspace mode-split-2">
          <SessionPane
            {...makePaneProps({
              slotIndex: 0,
              layoutMode: 'split-2',
              isFocused: focus === 'left',
              session: sessL,
              availableSessions: [sessL, sessR],
              messages: [{ id: 'al', sessionId: sidL, role: 'assistant', content: '左栏', createdAt: '' }],
              onCancelPrompt: cancelL,
            })}
          />
          <SessionPane
            {...makePaneProps({
              slotIndex: 1,
              layoutMode: 'split-2',
              isFocused: focus === 'right',
              session: sessR,
              availableSessions: [sessL, sessR],
              messages: [{ id: 'ar', sessionId: sidR, role: 'assistant', content: '右栏', createdAt: '' }],
              onCancelPrompt: cancelR,
            })}
          />
        </div>
      );

    const view = render(renderDual('right'));
    const paneL = screen.getByTestId(`session-pane-${sidL}`);
    const paneR = screen.getByTestId(`session-pane-${sidR}`);

    // 左右栏均展开原文
    await within(paneL).findByTestId('plan-source-open');
    await within(paneR).findByTestId('plan-source-open');
    fireEvent.click(within(paneL).getByTestId('plan-source-open'));
    fireEvent.click(within(paneR).getByTestId('plan-source-open'));
    await within(paneL).findByTestId('plan-artifact-document');
    await within(paneR).findByTestId('plan-artifact-document');

    // 1) IME 组合态按 Esc：两边都不关闭
    fireEvent.keyDown(paneR, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(within(paneL).getByTestId('plan-source-drawer')).toBeTruthy();
    expect(within(paneR).getByTestId('plan-source-drawer')).toBeTruthy();

    // 2) 聚焦右栏并在右栏内存在 .popover / .voice-status / .composer-input 时按 Esc：不关闭右栏原文
    const fakePopover = document.createElement('div');
    fakePopover.className = 'popover';
    paneR.appendChild(fakePopover);
    fireEvent.keyDown(paneR, { key: 'Escape' });
    expect(within(paneR).getByTestId('plan-source-drawer')).toBeTruthy();
    fakePopover.remove();

    const fakeVoice = document.createElement('div');
    fakeVoice.className = 'voice-status';
    paneR.appendChild(fakeVoice);
    const voiceCaptureSpy = vi.fn((e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    window.addEventListener('keydown', voiceCaptureSpy, true);
    try {
      fireEvent.keyDown(paneR, { key: 'Escape' });
      expect(voiceCaptureSpy).toHaveBeenCalledTimes(1);
      expect(within(paneR).getByTestId('plan-source-drawer')).toBeTruthy();
      expect(cancelR).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', voiceCaptureSpy, true);
      fakeVoice.remove();
    }

    // 行内编辑（.message-editor 内 textarea）按 Esc：既不关闭原文，也不中断流式
    const fakeEditor = document.createElement('div');
    fakeEditor.className = 'message-editor';
    const fakeTextarea = document.createElement('textarea');
    fakeEditor.appendChild(fakeTextarea);
    paneR.appendChild(fakeEditor);
    fireEvent.keyDown(fakeTextarea, { key: 'Escape' });
    expect(within(paneR).getByTestId('plan-source-drawer')).toBeTruthy();
    expect(cancelR).not.toHaveBeenCalled();
    fakeEditor.remove();

    // composer-input 打开斜杠补全菜单时按 Esc：InlinePlanCard 让路（原文不关），Composer 仅清菜单不中断流式
    const composerR = within(paneR).getByTestId(`composer-input-${sidR}`);
    fireEvent.change(composerR, { target: { value: '/' } });
    fireEvent.keyDown(composerR, { key: 'Escape' });
    expect(within(paneR).getByTestId('plan-source-drawer')).toBeTruthy();
    expect(cancelR).not.toHaveBeenCalled();

    // 3) 正常在聚焦右栏按 Esc：仅关闭右栏原文，左栏原文保持展开且不中止右栏流式
    fireEvent.keyDown(within(paneR).getByTestId('plan-source-drawer'), { key: 'Escape' });
    expect(within(paneR).queryByTestId('plan-source-drawer')).toBeNull();
    expect(within(paneL).getByTestId('plan-source-drawer')).toBeTruthy();
    expect(cancelR).not.toHaveBeenCalled();

    // 4) 此时右栏已关原文且正在流式，非聚焦左栏仍开着原文 -> 右栏再按 Esc 应中止右栏流式，绝不被左栏劫持
    fireEvent.keyDown(paneR, { key: 'Escape' });
    await waitFor(() => expect(cancelR).toHaveBeenCalledWith(sidR));
    expect(within(paneL).getByTestId('plan-source-drawer')).toBeTruthy();

    // 5) 焦点切回左栏，折叠左栏卡片 -> 同步关闭原文抽屉且恢复 plan-source-open（不残留幽灵 Esc）
    view.rerender(renderDual('left'));
    fireEvent.click(within(paneL).getByTestId('inline-plan-toggle'));
    expect(within(paneL).queryByTestId('plan-source-drawer')).toBeNull();
    expect(within(paneL).getByTestId('plan-source-open')).toBeTruthy();
    expect(within(paneL).getByTestId('plan-source-open').getAttribute('aria-expanded')).toBe('false');
  });

  it('FE-P1-3：收起原文后正文单边更新（contentRevision 递增）时外部打开不携过期 contentRevision', async () => {
    const sid = uid('plan-stale-crev');
    const filePath = `C:\\brain\\${sid}\\implementation_plan.md`;
    let listener: ((e: PlanArtifactChangedEvent) => void) | undefined;
    let contentRev = 100;
    const getSessionPlanArtifact = vi.fn(async (input: { view?: 'summary' | 'content' }) =>
      input.view === 'content'
        ? {
            status: 'ready' as const,
            view: 'content' as const,
            owner: { profileId: 'p1', sessionId: sid },
            revision: contentRev,
            summaryRevision: 100,
            contentRevision: contentRev,
            filePath,
            content: `# 计划\n\n正文 rev=${contentRev} [本体](file:///C:/brain/${sid}/implementation_plan.md)`,
          }
        : {
            status: 'ready' as const,
            view: 'summary' as const,
            owner: { profileId: 'p1', sessionId: sid },
            revision: 100,
            summaryRevision: 100,
            contentRevision: contentRev,
            filePath,
            outline: { title: '计划', sections: [{ id: 's1', level: 2, heading: '章节', summary: '' }], sectionCount: 1 },
          }
    );
    const openLinkOrFileTarget = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'default-app', resolvedTarget: filePath });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact,
      openLinkOrFileTarget,
      onPlanArtifactChanged: (fn) => {
        listener = fn;
        return () => { listener = undefined; };
      },
    };

    render(wrap(<InlinePlanCard profileId="p1" sessionId={sid} cwd="C:\\repo" plan={undefined} todos={[]} />));
    await screen.findByTestId('plan-outline');

    // 1) 展开原文缓存 contentRevision=100 后收起原文
    fireEvent.click(screen.getByTestId('plan-source-open'));
    await screen.findByTestId('plan-artifact-document');
    fireEvent.click(screen.getByTestId('plan-source-close'));
    expect(screen.queryByTestId('plan-source-drawer')).toBeNull();

    // 2) 正文更新 contentRevision -> 200（summaryRevision 维持 100），再点头部外部打开
    contentRev = 200;
    await act(async () => {
      listener?.({ profileId: 'p1', sessionId: sid, revision: 200, summaryRevision: 100, contentRevision: 200 });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-artifact-open-file'));
    });
    const closedCall = openLinkOrFileTarget.mock.calls.at(-1)?.[0];
    expect(closedCall.planArtifactOwner).toMatchObject({ profileId: 'p1', sessionId: sid, revision: 100, summaryRevision: 100 });
    expect(closedCall.planArtifactOwner.contentRevision).toBeUndefined();

    // 3) 重新展开原文拉取 contentRevision=200，点文档内自链携带最新 contentRevision=200
    fireEvent.click(screen.getByTestId('plan-source-open'));
    await waitFor(() => expect(screen.getByTestId('plan-artifact-document').textContent).toContain('rev=200'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '本体' }));
    });
    const openCall = openLinkOrFileTarget.mock.calls.at(-1)?.[0];
    expect(openCall.planArtifactOwner).toMatchObject({ profileId: 'p1', sessionId: sid, revision: 200, contentRevision: 200 });
  });

  it('FE-P1-4：areSessionPanePropsEqual 仅关注 inspectorData.plan / todos / epoch，终端与 Diff 高频更新跳过 SessionPane 重渲染', async () => {
    const sid = uid('pane-memo-perf');
    const session = makeSession({ sessionId: sid, profileId: 'p1' });
    const stableTodos: SessionTodoItem[] = [{ id: 't1', content: '步骤一', status: 'in_progress' }];
    const stablePlan = { state: 'present' as const, revision: 1, truncated: false, totalCount: 1, completedCount: 0, failedCount: 0 };
    const stableMessages: ChatMessageItem[] = [{ id: 'a1', sessionId: sid, role: 'assistant', content: '正文', createdAt: '' }];
    const baseProps = makePaneProps({ session, messages: stableMessages });

    const memoPane = SessionPane as unknown as { $$typeof?: symbol; type: (...args: unknown[]) => unknown };
    expect(memoPane.$$typeof).toBe(Symbol.for('react.memo'));
    const origPaneType = memoPane.type;
    let paneRenders = 0;
    memoPane.type = function trackedPane(...args: unknown[]) {
      paneRenders += 1;
      return origPaneType(...args);
    };

    try {
      const view = render(
        wrap(
          <Profiler id="pane-perf" onRender={() => {}}>
            <SessionPane
              {...baseProps}
              inspectorData={{ sessionId: sid, owner: { profileId: 'p1', sessionId: sid, epoch: 1 }, diffs: [], terminals: [], todos: stableTodos, plan: stablePlan }}
            />
          </Profiler>
        )
      );
      await act(async () => { await Promise.resolve(); });
      const rendersAfterMount = paneRenders;

      // 仅变化 terminals / diffs（plan / todos / epoch 引用不变）-> SessionPane 必须跳过重渲染
      view.rerender(
        wrap(
          <Profiler id="pane-perf" onRender={() => {}}>
            <SessionPane
              {...baseProps}
              inspectorData={{
                sessionId: sid,
                owner: { profileId: 'p1', sessionId: sid, epoch: 1 },
                diffs: [{ filePath: 'a.ts', oldText: 'a', newText: 'b', addedLines: 3, removedLines: 1, lines: [], updatedAt: '' }],
                terminals: [{ id: 'term-1', toolCallId: 'tc-1', command: 'echo 1', output: '1\n', status: 'running', timestamp: '' }],
                todos: stableTodos,
                plan: stablePlan,
              }}
            />
          </Profiler>
        )
      );
      expect(paneRenders).toBe(rendersAfterMount);

      // 变更 todos 引用 -> 必须正常触发重渲染更新 UI
      view.rerender(
        wrap(
          <Profiler id="pane-perf" onRender={() => {}}>
            <SessionPane
              {...baseProps}
              inspectorData={{
                sessionId: sid,
                owner: { profileId: 'p1', sessionId: sid, epoch: 1 },
                diffs: [],
                terminals: [],
                todos: [{ id: 't1', content: '步骤一已完成', status: 'completed' }],
                plan: { ...stablePlan, revision: 2, completedCount: 1 },
              }}
            />
          </Profiler>
        )
      );
      expect(paneRenders).toBeGreaterThan(rendersAfterMount);
      expect(screen.getByText('步骤一已完成')).toBeTruthy();
    } finally {
      memoPane.type = origPaneType;
    }
  });

  it('FE-P1-5：RightInspector 严格 4 页签，传入历史非法 activeTab="plan" 时自动降级至 diff 保持 Tab 停靠点与有效 aria-labelledby', () => {
    render(
      wrap(
        <RightInspector
          collapsed={false}
          width={380}
          activeTab={'plan' as unknown as RightInspectorTab}
          focusedDiffFile={null}
          sessionId="sess-legacy-tab"
          sessionMessages={[]}
          telemetry={makeTelemetry()}
          onSelectTab={() => {}}
          onFocusDiffFile={() => {}}
          onCommitWidth={() => {}}
          onOpenRateCardsSettings={() => {}}
        />
      )
    );
    const head = screen.getByTestId('right-inspector').querySelector('.inspector-head') as HTMLElement;
    const tabs = within(head).getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(screen.queryByTestId('inspector-tab-plan')).toBeNull();
    const diffTab = screen.getByTestId('inspector-tab-diff');
    expect(diffTab.getAttribute('aria-selected')).toBe('true');
    expect(diffTab.getAttribute('tabindex')).toBe('0');
    expect(screen.getByTestId('inspector-view-diff')).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toBe(diffTab);
  });

  it('划词批注零干扰：InlinePlanCard 展开与展开原文均不改变正文锚点偏移，且在 Plan 卡片内划词绝不弹悬浮条', async () => {
    const sid = uid('plan-ann-iso');
    const session = makeSession({ sessionId: sid, profileId: 'p1' });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn(async (input: { view?: 'summary' | 'content' }) => ({
        status: 'ready' as const,
        view: input.view ?? 'summary',
        owner: { profileId: 'p1', sessionId: sid },
        revision: 1,
        summaryRevision: 1,
        contentRevision: 1,
        filePath: `C:\\brain\\${sid}\\implementation_plan.md`,
        ...(input.view === 'content'
          ? { content: '# 计划全文\n\n这段计划原文不应影响正文划词锚点。' }
          : { outline: { title: '计划概要', sections: [{ id: 's1', level: 2, heading: '步骤', summary: '说明' }], sectionCount: 1 } }),
      })),
    };
    const msg: ChatMessageItem = {
      id: 'a-iso',
      sessionId: sid,
      role: 'assistant',
      content: '正文首段用于精确校验偏移量。',
      createdAt: '2026-11-28T00:00:00.000Z',
    };
    render(
      wrap(
        <SessionPane
          {...makePaneProps({
            session,
            messages: [msg],
            inspectorData: {
              sessionId: sid,
              diffs: [],
              terminals: [],
              todos: [{ id: 't1', content: '执行步骤', status: 'in_progress' }],
              plan: { state: 'present', revision: 1, truncated: false, totalCount: 1, completedCount: 0, failedCount: 0 },
            },
          })}
        />
      )
    );
    await screen.findByTestId('plan-source-open');

    const bodyEl = screen.getByTestId('assistant-body-a-iso');
    const measureAnchor = () => {
      const pNode = bodyEl.querySelector('p')!.firstChild!;
      const r = document.createRange();
      r.setStart(pNode, 2);
      r.setEnd(pNode, 9);
      return anchorFromRange(bodyEl, r);
    };
    const beforeSource = measureAnchor();

    // 展开原地原文后，正文偏移与上下文必须逐字一致
    fireEvent.click(screen.getByTestId('plan-source-open'));
    const doc = await screen.findByTestId('plan-artifact-document');
    expect(measureAnchor()).toEqual(beforeSource);

    // 在 InlinePlanCard 原文内划词 -> 绝不弹出划词悬浮条
    const docP = doc.querySelector('p')!;
    const planRange = document.createRange();
    planRange.selectNodeContents(docP);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => docP.textContent || '',
      anchorNode: docP.firstChild,
      rangeCount: 1,
      getRangeAt: () => planRange,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    fireEvent.mouseUp(docP, { button: 0, clientX: 120, clientY: 120 });
    expect(screen.queryByTestId('selection-floating-bar')).toBeNull();
  });
});

/* ============================================================================
 * PART B · 划词标注全链路保序配对（TC-ANN-01 .. TC-ANN-18）
 * ========================================================================== */

describe('Gravity v0.3.6 划词标注全链路保序配对 (TC-ANN-01..18)', () => {
  it('TC-ANN-05 & TC-ANN-07 & TC-ANN-11：旧草稿迁移、失败原序合并、上下文 32 字回退定位与 wire 载荷序列化', () => {
    // 旧 { quotes, notes } 迁移按时间戳合并为单一有序数组
    const migrated = migrateLegacyDraft({
      quotes: [{ id: 'qt-1700000002000-a', messageId: 'm1', text: '旧引用' }],
      notes: [
        {
          id: 'nt-1700000001000-b',
          messageId: 'm1',
          selectedText: '更早的旧批注',
          comment: '先排第一',
          createdAt: '2023-11-14T22:13:21.000Z',
        },
      ],
    });
    expect(migrated.map((m) => m.id)).toEqual(['nt-1700000001000-b', 'qt-1700000002000-a']);
    expect(migrated[0].comment).toBe('先排第一');
    expect(migrated[1].comment).toBe('');

    // 失败合并恢复：已提交在前，发送中新增（不重复 ID）在后
    const a1: AnnotationDraftItem = { id: newAnnotationId(), messageId: 'm1', originMessageId: 'orig-1', excerpt: 'A', comment: '', createdAt: '' };
    const a2: AnnotationDraftItem = { id: newAnnotationId(), messageId: 'm1', originMessageId: 'orig-1', excerpt: 'B', comment: '  保留批注  ', createdAt: '' };
    const a3: AnnotationDraftItem = { id: newAnnotationId(), messageId: 'm1', originMessageId: 'orig-1', excerpt: 'C', comment: '新增', createdAt: '' };
    const merged = mergeRestoredAnnotations([a1, a2], [a2, a3]);
    expect(merged.map((i) => i.id)).toEqual([a1.id, a2.id, a3.id]);

    // toWireAnnotations：保序、ann-* 透传、originMessageId 透传、空批注归一 undefined
    const wire = toWireAnnotations(merged);
    expect(wire).toEqual([
      { id: a1.id, messageId: 'm1', originMessageId: 'orig-1', excerpt: 'A' },
      { id: a2.id, messageId: 'm1', originMessageId: 'orig-1', excerpt: 'B', comment: '保留批注' },
      { id: a3.id, messageId: 'm1', originMessageId: 'orig-1', excerpt: 'C', comment: '新增' },
    ]);

    // 32 字上下文偏移回退：同词出现两次，偏移失配后靠 prefix/suffix 精准命中第 2 处
    const fullText = '甲段开头关键术语甲段结尾——随后新增前缀干扰——乙段开头关键术语乙段结尾';
    const secondIdx = fullText.lastIndexOf('关键术语');
    const resolved = resolveAnchorOffset(fullText, {
      start: 999,
      anchorText: '关键术语',
      prefix: '乙段开头',
      suffix: '乙段结尾',
    });
    expect(resolved).toBe(secondIdx);
  });

  it('TC-ANN-06 & TC-ANN-15（QA1-FE-05）：真实 DOM Range 跨代码块头部划词清洗 0 按钮/语言标签噪音，纯噪音选区不弹条', async () => {
    const sid = uid('ann-clean');
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({ sessionId: sid });
    const messages: ChatMessageItem[] = [
      {
        id: 'm-code-1',
        originMessageId: 'orig-code-1',
        sessionId: sid,
        role: 'assistant',
        content: '前置说明文字。\n\n```typescript\nconst answer = 42;\n```\n\n后置结论。',
        createdAt: '2026-11-28T00:00:00.000Z',
      },
    ];
    const { container } = render(
      wrap(
        <SessionPane
          slotIndex={0}
          layoutMode="single"
          isFocused
          session={session}
          availableSessions={[session]}
          availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
          messages={messages}
          pendingApprovals={[]}
          approvalConfig={DEFAULT_APPROVAL_CONFIG}
          defaultThoughtTrack="zh"
          telemetryDashboard={makeTelemetry()}
          scrollMemoryRef={{ current: {} }}
          canTriggerDemoApproval={false}
          appIcon="gravity-claude-dark"
          onFocusPane={() => {}}
          onBindSlotSession={() => {}}
          onOpenNewSession={() => {}}
          onSendPrompt={sendPrompt}
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

    const bodyEl = screen.getByTestId('assistant-body-m-code-1');
    const firstP = bodyEl.querySelector('p')!;
    const codeHead = bodyEl.querySelector('.code-block-head')!;
    const codeEl = bodyEl.querySelector('pre code')!;
    expect(codeHead.hasAttribute('data-annotation-skip')).toBe(true);

    // 1) 仅选中代码块头部（全为 data-annotation-skip / button UI 噪音）-> 不弹划词悬浮条
    const noiseRange = document.createRange();
    noiseRange.selectNodeContents(codeHead);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => codeHead.textContent || 'typescript 复制',
      anchorNode: codeHead,
      rangeCount: 1,
      getRangeAt: () => noiseRange,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    fireEvent.mouseUp(bodyEl, { button: 0, clientX: 160, clientY: 160 });
    expect(screen.queryByTestId('selection-floating-bar')).toBeNull();

    // 2) 真实 DOM Range 从前置说明跨过代码块头部（含语言标签与复制按钮）拖选至代码内容
    const spanRange = document.createRange();
    spanRange.setStart(firstP.firstChild!, 0);
    spanRange.setEnd(codeEl, codeEl.childNodes.length);
    const anchor = anchorFromRange(bodyEl, spanRange);
    expect(anchor).toBeTruthy();
    expect(anchor!.anchorText).toContain('前置说明文字');
    expect(anchor!.anchorText).toContain('const answer = 42;');
    expect(anchor!.anchorText).not.toMatch(/typescript|复制|Copy/i);
    expect(annotatableText(bodyEl)).not.toMatch(/复制|Copy/);

    // 反向 rangeFromAnchor 还原验证
    const restored = rangeFromAnchor(bodyEl, anchor!);
    expect(restored).toBeTruthy();

    vi.spyOn(window, 'getSelection').mockReturnValue({
      // 刻意让 raw sel.toString() 包含脏的语言标签与按钮文案，验证 SessionPane 采用清洗后的 anchor.anchorText
      toString: () => '前置说明文字。\ntypescript 复制\nconst answer = 42;',
      anchorNode: firstP.firstChild,
      rangeCount: 1,
      getRangeAt: () => spanRange,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    fireEvent.mouseUp(bodyEl, { button: 0, clientX: 180, clientY: 200 });
    fireEvent.click(screen.getByTestId('selection-quote-only-btn'));

    // 发送后检查 excerpt 干净且透传 originMessageId
    fireEvent.click(screen.getByTestId(`send-prompt-btn-${sid}`));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    const sent = sendPrompt.mock.calls[0][0];
    expect(sent.annotations[0].excerpt).not.toMatch(/typescript|复制|Copy/i);
    expect(sent.annotations[0].excerpt).toContain('const answer = 42;');
    expect(sent.annotations[0].originMessageId).toBe('orig-code-1');
    expect(container.querySelector('.code-block-head')).toBeTruthy();
  });

  it('TC-ANN-01/04/08/09/10/13/16/17/18：重复引用提示、聚焦批注框/IME 防误触/Esc 不停 AI、CSS Highlight 联动、跨分支编号与分会话隔离', async () => {
    const sid = uid('ann-flow');
    const otherSid = uid('ann-other');
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const session = makeSession({ sessionId: sid, status: 'streaming' });

    // 注入 CSS.highlights / Highlight 桩以验证 TC-ANN-08
    const highlightMap = new Map<string, { ranges: Range[] }>();
    class MockHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const origCss = globalThis.CSS;
    const origHighlight = (globalThis as unknown as { Highlight?: unknown }).Highlight;
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (s: string) => s, highlights: highlightMap },
    });
    Object.defineProperty(globalThis, 'Highlight', { configurable: true, value: MockHighlight });

    try {
      const messages: ChatMessageItem[] = [
        // 纯标注无正文的用户消息也必须计入 visibleIndex / messageNumber（TC-ANN-16）
        {
          id: 'u-ann-only',
          sessionId: sid,
          role: 'user',
          content: '',
          annotations: [{ id: 'ann-prev-1', messageId: 'm0', excerpt: '前序引用' }],
          createdAt: '2026-11-28T00:00:00.000Z',
        },
        {
          id: 'a-branch-1',
          originMessageId: 'orig-root-a1',
          sessionId: sid,
          role: 'assistant',
          content: '第一句核心实现逻辑，第二句用于重复引用检测。',
          createdAt: '2026-11-28T00:00:10.000Z',
        },
      ];

      render(
        wrap(
          <SessionPane
            slotIndex={0}
            layoutMode="single"
            isFocused
            session={session}
            availableSessions={[session]}
            availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
            messages={messages}
            pendingApprovals={[]}
            approvalConfig={DEFAULT_APPROVAL_CONFIG}
            defaultThoughtTrack="zh"
            telemetryDashboard={makeTelemetry()}
            scrollMemoryRef={{ current: {} }}
            canTriggerDemoApproval={false}
            appIcon="gravity-claude-dark"
            onFocusPane={() => {}}
            onBindSlotSession={() => {}}
            onOpenNewSession={() => {}}
            onSendPrompt={onSend}
            onCancelPrompt={onCancel}
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

      const bodyEl = screen.getByTestId('assistant-body-a-branch-1');
      const textNode = bodyEl.querySelector('p')!.firstChild!;
      const r1 = document.createRange();
      r1.setStart(textNode, 0);
      r1.setEnd(textNode, 8);
      vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => '第一句核心实现逻辑',
        anchorNode: textNode,
        rangeCount: 1,
        getRangeAt: () => r1,
        removeAllRanges: vi.fn(),
      } as unknown as Selection);

      // 点击「引用」自动创建条目并聚焦其批注框
      fireEvent.mouseUp(bodyEl, { button: 0, clientX: 200, clientY: 200 });
      fireEvent.click(screen.getByTestId('selection-quote-btn'));
      const commentBox = (await screen.findAllByTestId(/^composer-annotation-comment-/))[0] as HTMLTextAreaElement;
      expect(document.activeElement).toBe(commentBox);

      // CSS Highlight 全部锚点注册 + 悬停高亮激活（TC-ANN-08）
      expect(highlightMap.has('gravity-annotations')).toBe(true);
      const cardEl = screen.getAllByTestId(/^composer-annotation-ann-/)[0];
      fireEvent.mouseEnter(cardEl);
      expect(highlightMap.has('gravity-annotation-active')).toBe(true);
      fireEvent.mouseLeave(cardEl);
      expect(highlightMap.has('gravity-annotation-active')).toBe(false);

      // TC-ANN-18：IME 组合态内按 Enter 不跳离批注框、不提交
      fireEvent.keyDown(commentBox, { key: 'Enter', isComposing: true, keyCode: 229 });
      expect(document.activeElement).toBe(commentBox);
      expect(onSend).not.toHaveBeenCalled();

      // TC-ANN-10：批注框内按 Esc 仅回主输入框，绝不中断流式 AI 回合
      fireEvent.keyDown(commentBox, { key: 'Escape' });
      expect(document.activeElement).toBe(screen.getByTestId(`composer-input-${sid}`));
      expect(onCancel).not.toHaveBeenCalled();

      // 再聚焦批注框并输入内容，非组合态 Enter 回主输入框不发送
      commentBox.focus();
      fireEvent.change(commentBox, { target: { value: '请补充边界单测' } });
      fireEvent.keyDown(commentBox, { key: 'Enter' });
      expect(document.activeElement).toBe(screen.getByTestId(`composer-input-${sid}`));
      expect(onSend).not.toHaveBeenCalled();

      // TC-ANN-04：再次划选相同锚点提示「已引用为 #1」且不重复创建
      fireEvent.mouseUp(bodyEl, { button: 0, clientX: 200, clientY: 200 });
      fireEvent.click(screen.getByTestId('selection-quote-btn'));
      expect(screen.getByTestId('composer-annotation-notice').textContent).toContain('#1');
      expect(screen.getAllByTestId(/^composer-annotation-ann-/)).toHaveLength(1);

      // TC-ANN-13：草稿按 [profile, sessionId] 隔离，另一个会话不受影响
      expect(localStorage.getItem(`gravity.annotations.${JSON.stringify(['p-v036', sid])}`)).toContain('orig-root-a1');
      expect(localStorage.getItem(`gravity.annotations.${JSON.stringify(['p-v036', otherSid])}`)).toBeNull();
      // messageNumber 必须为 2（包含第 1 条纯标注用户消息 u-ann-only）
      const stored = JSON.parse(localStorage.getItem(`gravity.annotations.${JSON.stringify(['p-v036', sid])}`)!);
      expect(stored.items[0].messageNumber).toBe(2);
      expect(stored.items[0].originMessageId).toBe('orig-root-a1');

      // showAnnotationRanges 清理函数正常回收高亮
      const dispose = showAnnotationRanges(screen.getByTestId(`session-pane-${sid}`), stored.items);
      dispose?.();
      clearAnnotationDraft('p-v036', sid);
    } finally {
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: origCss });
      Object.defineProperty(globalThis, 'Highlight', { configurable: true, value: origHighlight });
    }
  });

  it('TC-ANN-02 & TC-ANN-03 & TC-ANN-14（QA1-FE-04）：SentAnnotations 渲染与 EditUserMessage 删除单卡及全删显式传 annotations: []', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const msg: ChatMessageItem = {
      id: 'u-edit-1',
      sessionId: 's-edit',
      role: 'user',
      content: '请基于以上两点修改',
      annotations: [
        { id: 'ann-1', messageId: 'a-1', excerpt: '原文片段一', comment: '批注一' },
        { id: 'ann-2', messageId: 'a-1', excerpt: '原文片段二' },
      ],
      createdAt: '2026-11-28T00:00:00.000Z',
    };

    // SentAnnotations：卡片编号 #1 / #2，仅引用展示标签，标记 data-annotation-skip
    const sentView = render(wrap(<SentAnnotations items={msg.annotations} />));
    const list = screen.getByTestId('sent-annotations');
    expect(list.hasAttribute('data-annotation-skip')).toBe(true);
    expect(list.querySelectorAll('li.sent-annotation')).toHaveLength(2);
    expect(list.textContent).toContain('#1');
    expect(list.textContent).toContain('批注一');
    expect(list.textContent).toContain('#2');
    expect(list.querySelector('p.is-quote-only')).toBeTruthy();
    sentView.unmount();

    // EditUserMessage：1) 删除第 1 张卡片并修改第 2 张批注后提交
    function Host() {
      const [current, setCurrent] = useState(msg);
      return (
        <EditUserMessage
          message={current}
          busy={false}
          submit={async (input) => {
            await submit(input);
            setCurrent((prev) => ({ ...prev, content: input.text, annotations: input.annotations }));
          }}
        >
          <div>{current.content}</div>
        </EditUserMessage>
      );
    }
    render(wrap(<Host />));
    fireEvent.click(screen.getByTestId('edit-msg-u-edit-1'));
    expect(screen.getByTestId('edit-annotation-remove-ann-1')).toBeTruthy();
    expect(screen.getByTestId('edit-annotation-remove-ann-2')).toBeTruthy();

    fireEvent.click(screen.getByTestId('edit-annotation-remove-ann-1'));
    expect(screen.queryByTestId('edit-annotation-remove-ann-1')).toBeNull();
    const editBox = screen.getByLabelText('编辑批注 1');
    fireEvent.change(editBox, { target: { value: '补充第二条意见' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    });
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'u-edit-1',
        annotations: [expect.objectContaining({ id: 'ann-2', excerpt: '原文片段二', comment: '补充第二条意见' })],
      })
    );

    // 2) 再次编辑删除最后一张卡片 -> 必须显式传递 annotations: []（而非 undefined）
    fireEvent.click(screen.getByTestId('edit-msg-u-edit-1'));
    fireEvent.click(screen.getByTestId('edit-annotation-remove-ann-2'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    });
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'u-edit-1',
        text: '请基于以上两点修改',
        annotations: [],
      })
    );
  });
});

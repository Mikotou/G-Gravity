// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { PlanTimeline } from '../src/renderer/components/PlanTimeline';
import { PlanArtifactPanel } from '../src/renderer/components/PlanArtifactPanel';
import { SessionPane } from '../src/renderer/components/SessionPane';
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
  return {
    generatedAt: '2026-11-28T00:00:00.000Z',
    pricingSource: 'reference-api-estimate',
    activeSessions: {},
    today: { totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalTokens: 0, totalCostUsd: 0, byModel: [] },
    last7Days: { totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalTokens: 0, totalCostUsd: 0, byModel: [] },
    last30Days: { totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalTokens: 0, totalCostUsd: 0, byModel: [] },
    heatmap24h: [],
    heatmap7d: [],
    heatmap30d: [],
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
        outline: { title: '旧计划', sections: [{ id: 'sec-1', heading: '不应在清空态露文件栏' }], sectionCount: 1 },
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
    render(
      wrap(
        <RightInspector
          open
          width={400}
          activeTab="plan"
          profileId="p1"
          sessionId={s4}
          inspectorData={{
            sessionId: s4,
            diffs: [],
            terminals: [],
            todos: [],
            plan: { state: 'empty', revision: 5, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 },
          }}
          sessionMessages={[oldMsg]}
          telemetry={makeTelemetry()}
          onSelectTab={() => {}}
          onFocusDiffFile={() => {}}
          onCommitWidth={() => {}}
          onOpenRateCardsSettings={() => {}}
        />
      )
    );
    expect(await screen.findByTestId('plan-cleared')).toBeTruthy();
    expect(screen.queryByTestId('plan-source-line')).toBeNull();
    expect(screen.queryByText('不应复活的旧待办')).toBeNull();
    expect(screen.getByTestId('inspector-view-plan').textContent).not.toContain('implementation_plan.md');

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
            outline: { title: '实施总览', sections: [{ id: 'v', heading: '验证章节' }], sectionCount: 1 },
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
            outline: { title: '大纲不变', sections: [{ id: 's1', heading: '第一节' }], sectionCount: 1 },
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
        : { outline: { title: `概要 ${input.sessionId}`, sections: [{ id: 'x', heading: '章节' }], sectionCount: 1 } }),
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

  it('TC-PLAN-09 & TC-PLAN-12：正文内联仅最新消息展示单行 PlanChip 并可跳 Plan 页签；旧桥接直接返回 content 自动降级提取概要', async () => {
    const sid = uid('plan-chip-sess');
    const onOpenPlanInspector = vi.fn();
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
          onOpenPlanInspector={onOpenPlanInspector}
          onInspectDiffFile={() => {}}
          onTriggerDemoApproval={() => {}}
        />
      )
    );
    // 仅最新一条助手消息展示 PlanChip（旧消息不渲染内联待办表）
    const chips = screen.getAllByTestId(/^plan-chip-/);
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('data-testid')).toBe('plan-chip-a2');
    expect(chips[0].textContent).toContain('Plan 1/2');
    expect(chips[0].textContent).toContain('当前进行步骤');
    expect(screen.queryByText('旧消息待办')).toBeNull();
    fireEvent.click(chips[0]);
    expect(onOpenPlanInspector).toHaveBeenCalledTimes(1);

    // TC-PLAN-12：旧桥接返回 content（无 outline）自动降级提取概要并可直接开抽屉
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
    render(wrap(<PlanTimeline profileId="p1" sessionId={legacySid} plan={undefined} todos={[]} />));
    expect((await screen.findByTestId('plan-outline')).textContent).toContain('第一阶段');
    fireEvent.click(screen.getByTestId('plan-source-open'));
    expect((await screen.findByTestId('plan-artifact-document')).textContent).toContain('正文内容');
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

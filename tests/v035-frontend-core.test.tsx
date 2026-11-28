import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeHeatLevel,
  type ChatMessageItem,
  type ClientLocale,
  type DailyCalendarHeatmapCell,
  type GravityDesktopBridge,
  type HourlyTokenBarBucket,
  type PlanArtifactChangedEvent,
  type SessionInspectorData,
  type TelemetryDashboardSnapshot,
  type UserQuestion,
} from '../src/shared';
import { TokenHeatmapView } from '../src/renderer/components/context/TokenHeatmapView';
import { QuestionBar, readQuestionDraft } from '../src/renderer/components/QuestionBar';
import { QuestionFollowupStatus } from '../src/renderer/components/QuestionFollowupStatus';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { InlinePlanCard, PlanTimeline } from '../src/renderer/components/PlanTimeline';
import { resolveAuthoritativeTodos } from '../src/renderer/lib/plan-view';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { formatTokenCompact, resolveDaily7d } from '../src/renderer/lib/heatmap';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

/**
 * Gravity v0.3.5 前端核心专项：热力图重设计、Plan 提问卡片 v2、Plan 检视器与只读计划文档、followup 投递状态。
 */

function wrap(child: React.ReactNode, locale: ClientLocale = 'zh-CN') {
  return (
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      {child}
    </I18nProvider>
  );
}

function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeCalendar(days: number, tokensAt: (i: number) => number, intensity: (i: number) => 0 | 1 | 2 | 3 | 4 = () => 0): DailyCalendarHeatmapCell[] {
  const today = new Date();
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i));
    const totalTokens = tokensAt(i);
    return {
      date: localKey(d),
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens,
      costUsd: totalTokens / 1e6,
      sessionCount: totalTokens > 0 ? 1 : 0,
      intensity: intensity(i),
    };
  });
}

function makeHourly(tokensAt: (i: number) => number, intensity?: (i: number) => 0 | 1 | 2 | 3 | 4 | undefined): HourlyTokenBarBucket[] {
  return Array.from({ length: 24 }, (_, i) => {
    const totalTokens = tokensAt(i);
    const level = intensity?.(i);
    return {
      hourKey: `h-${i}`,
      hourLabel: `${String(i).padStart(2, '0')}:00`,
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens,
      costUsd: totalTokens / 1e6,
      ...(level !== undefined ? { intensity: level } : {}),
    };
  });
}

beforeEach(() => {
  resetFallbackDesktopBridge();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  vi.restoreAllMocks();
});

/* =========================================================================
 * 1. 热力图
 * ======================================================================= */
describe('v0.3.5 热力图：24h / 7d / 30d 重设计', () => {
  it('formatTokenCompact 始终 ≤ 4 个字符且量级正确', () => {
    const samples = [0, 7, 999, 1000, 1049, 1250, 9949, 9951, 12_345, 99_999, 123_456, 999_499, 999_600, 1_234_567, 12_345_678, 999_999_999, 4.2e12, 9.99e14];
    for (const n of samples) expect(formatTokenCompact(n).length, String(n)).toBeLessThanOrEqual(4);
    expect(formatTokenCompact(1250)).toBe('1.3k');
    expect(formatTokenCompact(12_345)).toBe('12k');
    expect(formatTokenCompact(999_600)).toBe('1M');
    expect(formatTokenCompact(1_234_567)).toBe('1.2M');
  });

  it('7d：新快照消费 daily7d（7 根按日柱状图 + 与 24h 同款 Token 用量 Y 轴刻度、今天高亮 + aria-current，不再出现小时格）', () => {
    const calendar = makeCalendar(30, (i) => (i % 3 === 0 ? 0 : 50_000 + i * 1000));
    const daily7d = makeCalendar(7, (i) => (i + 1) * 120_000, (i) => ((i % 4) + 1) as 1 | 2 | 3 | 4);
    render(wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="Token" hourly24h={makeHourly(() => 0)} daily7d={daily7d} calendar30d={calendar} />));
    fireEvent.click(screen.getByTestId('heatmap-range-7d'));
    const grid = screen.getByTestId('heatmap-7d-matrix');
    const cols = Array.from(grid.querySelectorAll<HTMLElement>('.heatmap-cell'));
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.className.match(/i-(\d)/)?.[1])).toEqual(daily7d.map((d) => String(d.intensity)));
    // 与 24h 同款的 Token 用量 Y 轴（峰值 840k / 半值 420k / 0）
    const yScale = screen.getByTestId('heatmap-y-scale');
    expect(Array.from(yScale.children).map((s) => s.textContent)).toEqual(['840k', '420k', '0']);
    // 柱高按日 Token 用量比例渲染（峰值日 100%，首日 ~14.29%）
    const heights = cols.map((c) => c.querySelector<HTMLElement>('.hm-bar-7d')?.style.height);
    expect(heights[6]).toBe('100%');
    expect(heights[0]).toBe('14.29%');
    const today = cols[6];
    expect(today.getAttribute('aria-current')).toBe('date');
    expect(today.classList.contains('is-today')).toBe(true);
    expect(cols.filter((c) => c.getAttribute('aria-current')).length).toBe(1);
    const axisItems = Array.from(grid.closest('section')!.querySelectorAll<HTMLElement>('.hm-7d-axis-item'));
    expect(axisItems).toHaveLength(7);
    for (const item of axisItems) {
      expect(item.querySelector('.hm-7d-axis-wd')?.textContent).toMatch(/^周[一二三四五六日]$/);
      expect(item.querySelector('.hm-7d-axis-date')?.textContent).toMatch(/^\d+\/\d+$/);
    }
    expect(axisItems[6].classList.contains('is-today')).toBe(true);
    expect(grid.closest('section')!.querySelector('.hm-7d-ruler, .hm-7d-cells')).toBeNull();
  });

  it('7d：旧快照缺 daily7d 时从 calendar30d 末 7 天以 7 日窗口 S/P 重算 computeHeatLevel', () => {
    const calendar = makeCalendar(30, (i) => (i < 23 ? 9_000_000 : (i - 22) * 40_000), () => 4);
    const days = resolveDaily7d(undefined, calendar);
    const last7 = calendar.slice(-7);
    const S = last7.reduce((a, d) => a + d.totalTokens, 0);
    const P = Math.max(...last7.map((d) => d.totalTokens));
    expect(days.map((d) => d.intensity)).toEqual(last7.map((d) => computeHeatLevel(d.totalTokens, S, P, 7)));
    // 30d 窗口的旧强度（全部 4）不得被沿用
    expect(days.some((d) => d.intensity !== 4)).toBe(true);
    render(wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="Token" hourly24h={makeHourly(() => 0)} calendar30d={calendar} />));
    fireEvent.click(screen.getByTestId('heatmap-range-7d'));
    const classes = Array.from(screen.getByTestId('heatmap-7d-matrix').querySelectorAll('.heatmap-cell')).map((c) => c.className.match(/i-(\d)/)?.[1]);
    expect(classes).toEqual(days.map((d) => String(d.intensity)));
  });

  it('30d：周一至周日对齐的周行方格，前后不足一周的槽位留空，周起始标签 / 周合计按断点显隐', () => {
    const calendar = makeCalendar(30, (i) => i * 10_000, (i) => (i % 5) as 0 | 1 | 2 | 3 | 4);
    render(wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="Token" hourly24h={makeHourly(() => 0)} calendar30d={calendar} />));
    fireEvent.click(screen.getByTestId('heatmap-range-30d'));
    const cal = screen.getByTestId('heatmap-30d-calendar');
    const rows = Array.from(cal.querySelectorAll<HTMLElement>('[role="row"]'));
    expect(cal.querySelectorAll('.heatmap-cell')).toHaveLength(30);
    for (const row of rows) {
      // 7 个槽位（方格或占位）+ 周起始标签 + 周合计
      expect(row.querySelectorAll('.heatmap-cell, .hm-day-blank')).toHaveLength(7);
      expect(row.querySelector('.hm-week-label')).toBeTruthy();
      expect(row.querySelector('.hm-week-total')).toBeTruthy();
    }
    const firstCol = (new Date(calendar[0].date + 'T00:00:00').getDay() + 6) % 7;
    expect(rows[0].querySelectorAll('.hm-day-blank')).toHaveLength(firstCol);
    const css = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../src/renderer/styles/components/context.css'), 'utf8') as string;
    expect(css).toMatch(/\.hm-card \{[^}]*container: hm \/ inline-size/);
    expect(css).toMatch(/@container hm \(max-width: 299\.98px\)[\s\S]*\.hm-week-label, \.hm-week-total \{ display: none; \}/);
    expect(css).toMatch(/@container hm \(min-width: 440px\)[\s\S]*grid-template-columns: 30px repeat\(7, minmax\(0, 1fr\)\) 48px/);
    expect(css).toMatch(/\.hm-calendar \.heatmap-cell \{[^}]*aspect-ratio: 1/);
  });

  it('24h：按后端 intensity 着色（缺省回退 computeHeatLevel），低柱封顶，零柱无 has-data', () => {
    const tokens = (i: number) => (i < 4 ? 0 : i === 23 ? 240_000 : i * 1500);
    const backend = makeHourly(tokens, (i) => (tokens(i) > 0 ? (i === 23 ? 4 : 1) : 0));
    const { unmount } = render(wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="T" hourly24h={backend} calendar30d={[]} />));
    let bars = Array.from(screen.getByTestId('heatmap-24h-bars').children) as HTMLElement[];
    expect(bars.slice(0, 4).every((b) => !b.classList.contains('has-data'))).toBe(true);
    expect(bars[23].classList.contains('tier-4')).toBe(true);
    expect(bars[10].classList.contains('tier-1')).toBe(true);
    expect(bars[10].classList.contains('has-cap')).toBe(true);
    expect(bars[10].dataset.cap).toBe('1');
    expect(bars[23].classList.contains('has-cap')).toBe(false);
    unmount();

    const legacy = makeHourly(tokens);
    render(wrap(<TokenHeatmapView testIdPrefix="" sectionTestId="hm" title="T" hourly24h={legacy} calendar30d={[]} />));
    bars = Array.from(screen.getByTestId('heatmap-24h-bars').children) as HTMLElement[];
    const S = legacy.reduce((a, b) => a + b.totalTokens, 0);
    const P = 240_000;
    for (let i = 4; i < 24; i += 1) {
      expect(bars[i].dataset.level).toBe(String(computeHeatLevel(tokens(i), S, P, 24)));
    }
  });

  it('切换页签：tablist 方向键漫游 + aria-controls / tabpanel；悬停不触发 aria-live，键盘聚焦才播报', () => {
    const calendar = makeCalendar(30, (i) => i * 10_000, () => 2);
    render(wrap(<TokenHeatmapView testIdPrefix="x-" sectionTestId="hm" title="T" hourly24h={makeHourly((i) => i * 1000)} calendar30d={calendar} />));
    const tab24 = screen.getByTestId('x-heatmap-range-24h');
    const panel = screen.getByTestId('x-heatmap-panel');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(tab24.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tab24.id);
    expect(tab24.tabIndex).toBe(0);
    expect(screen.getByTestId('x-heatmap-range-7d').tabIndex).toBe(-1);
    tab24.focus();
    fireEvent.keyDown(tab24, { key: 'ArrowRight' });
    expect(screen.getByTestId('x-heatmap-range-7d').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('x-heatmap-range-7d'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByTestId('x-heatmap-range-30d').getAttribute('aria-selected')).toBe('true');

    const live = screen.getByTestId('x-heatmap-live');
    const cell = screen.getByTestId('x-heatmap-30d-calendar').querySelector<HTMLElement>('.heatmap-cell')!;
    fireEvent.mouseEnter(cell);
    expect(screen.getByTestId('hm').querySelector('.hm-hover')!.textContent).not.toBe('');
    expect(live.textContent).toBe('');
    expect(screen.getByTestId('hm').querySelector('.hm-hover')!.hasAttribute('aria-live')).toBe(false);
    fireEvent.focus(cell);
    expect(live.textContent).toContain(calendar[0].date);
    // 图例标明双轴强度含义
    expect(screen.getByTestId('hm').textContent).toContain('绝对用量 × 窗口占比');
  });
});

/* =========================================================================
 * 2. Plan 提问卡片
 * ======================================================================= */
const MULTI: UserQuestion = {
  message: '开始实施前请确认：',
  state: 'open',
  fields: [
    { name: 'q1', title: '使用哪种数据库？', type: 'string', required: true, choices: [{ value: 'pg', label: 'PostgreSQL' }, { value: 'sqlite', label: 'SQLite' }] },
    { name: 'q2', title: '需要哪些模块？', type: 'array', required: true, choices: [{ value: 'auth', label: '认证' }, { value: 'billing', label: '计费' }] },
    { name: 'q3', title: '还有其他要求吗？', type: 'string', required: false },
  ],
};

function renderQuestion(question: UserQuestion, submit = vi.fn().mockResolvedValue(undefined), native = true, draftKey = 'k') {
  const view = render(wrap(<QuestionBar question={question} draftKey={draftKey} native={native} submit={submit} />));
  return { submit, view, bar: within(screen.getByTestId('question-bar')) };
}

describe('v0.3.5 Plan 提问卡片', () => {
  it('单题隐藏步进器；多题显示 1/N + 题号胶囊 + 上一题 / 下一题，点选选项绝不自动切题', () => {
    const single: UserQuestion = { ...MULTI, fields: [MULTI.fields[0]] };
    const first = renderQuestion(single);
    expect(screen.queryByTestId('question-stepper')).toBeNull();
    expect(first.bar.getByRole('radiogroup')).toBeTruthy();
    first.view.unmount();

    const { bar, submit } = renderQuestion(MULTI);
    expect(screen.getByTestId('question-step-count').textContent).toBe('1/3');
    expect(bar.getAllByRole('button', { name: /^第 \d 题/ })).toHaveLength(3);
    fireEvent.click(bar.getByRole('radio', { name: 'PostgreSQL' }));
    expect(bar.getByRole('radio', { name: 'PostgreSQL' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('question-step-count').textContent).toBe('1/3');
    expect(screen.getByTestId('question-pill-1').dataset.state).toBe('answered');
    fireEvent.click(screen.getByTestId('question-next'));
    expect(screen.getByTestId('question-step-count').textContent).toBe('2/3');
    expect(bar.getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('question-pill-3'));
    expect(screen.getByTestId('question-step-count').textContent).toBe('3/3');
    expect(screen.getByTestId('question-next').hasAttribute('disabled')).toBe(true);
    // 发送按钮显示已答计数
    expect(bar.getByRole('button', { name: '发送回答（已答 1/3）' })).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it('非文本输入框内 ←/→ 切题；文本框内不切题；Alt+← 与数字键不作为快捷键', () => {
    const { bar } = renderQuestion(MULTI);
    const radio = bar.getByRole('radio', { name: 'SQLite' });
    radio.focus();
    fireEvent.keyDown(radio, { key: 'ArrowRight' });
    expect(screen.getByTestId('question-step-count').textContent).toBe('2/3');
    const cb = bar.getAllByRole('checkbox')[0];
    fireEvent.keyDown(cb, { key: 'ArrowLeft', altKey: true });
    expect(screen.getByTestId('question-step-count').textContent).toBe('2/3');
    fireEvent.keyDown(cb, { key: '1' });
    fireEvent.keyDown(cb, { key: '3' });
    expect(screen.getByTestId('question-step-count').textContent).toBe('2/3');
    expect(cb.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(cb, { key: 'ArrowRight' });
    const textarea = bar.getByRole('textbox', { name: '还有其他要求吗？' });
    fireEvent.keyDown(textarea, { key: 'ArrowLeft' });
    expect(screen.getByTestId('question-step-count').textContent).toBe('3/3');
  });

  it('选项铅笔：未选中项点铅笔会选中并就地编辑；Enter 仅确认不提交；Esc 回滚 prevSelected；失焦空值还原', () => {
    const { bar, submit } = renderQuestion({ ...MULTI, fields: [MULTI.fields[0]] });
    // 选中前没有任何重复输入框
    expect(bar.queryAllByRole('textbox')).toHaveLength(0);
    fireEvent.click(bar.getByRole('radio', { name: 'PostgreSQL' }));
    expect(bar.queryAllByRole('textbox')).toHaveLength(0);

    // Esc：回滚到 prevSelected（PostgreSQL）
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    const input = bar.getByRole('textbox', { name: '修改选项 SQLite' });
    fireEvent.change(input, { target: { value: 'SQLite（WAL）' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(bar.queryByRole('textbox')).toBeNull();
    expect(bar.getByRole('radio', { name: 'PostgreSQL' }).getAttribute('aria-checked')).toBe('true');
    expect(bar.getByRole('radio', { name: 'SQLite' }).getAttribute('aria-checked')).toBe('false');

    // Enter：只确认编辑，绝不提交
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    const input2 = bar.getByRole('textbox', { name: '修改选项 SQLite' });
    fireEvent.change(input2, { target: { value: 'SQLite（WAL）' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    expect(bar.getByRole('radio', { name: /SQLite（WAL）/ }).getAttribute('aria-checked')).toBe('true');
    expect(bar.getByText('已编辑')).toBeTruthy();
    // ↺ 还原
    fireEvent.click(bar.getByRole('button', { name: '还原选项「SQLite」' }));
    expect(bar.queryByText('已编辑')).toBeNull();

    // 失焦且空值：还原原文案
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    const input3 = bar.getByRole('textbox', { name: '修改选项 SQLite' });
    fireEvent.change(input3, { target: { value: '   ' } });
    fireEvent.blur(input3);
    expect(bar.getByRole('radio', { name: 'SQLite' })).toBeTruthy();
    expect(bar.queryByText('已编辑')).toBeNull();
  });

  it('每题自定义回答与选项互斥，切回选项保留草稿并显示「自定义草稿 · 恢复」；纯开放题直接是紧凑 textarea', () => {
    const { bar } = renderQuestion(MULTI);
    fireEvent.click(bar.getByRole('radio', { name: 'SQLite' }));
    fireEvent.click(bar.getByRole('button', { name: '自定义回答' }));
    fireEvent.change(bar.getByRole('textbox', { name: '自定义回答' }), { target: { value: 'DuckDB' } });
    expect(bar.getByRole('radio', { name: 'SQLite' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('question-pill-1').dataset.state).toBe('edited');
    fireEvent.click(bar.getByRole('radio', { name: 'PostgreSQL' }));
    expect(bar.queryByRole('textbox', { name: '自定义回答' })).toBeNull();
    const restore = screen.getByTestId('question-custom-restore');
    expect(restore.textContent).toContain('自定义草稿');
    expect(restore.textContent).toContain('DuckDB');
    fireEvent.click(within(restore).getByRole('button', { name: '恢复' }));
    expect((bar.getByRole('textbox', { name: '自定义回答' }) as HTMLTextAreaElement).value).toBe('DuckDB');
    // 开放题不再套「自定义回答」开关
    fireEvent.click(screen.getByTestId('question-pill-3'));
    expect(bar.getByRole('textbox', { name: '还有其他要求吗？' }).tagName).toBe('TEXTAREA');
    expect(bar.queryByRole('button', { name: '自定义回答' })).toBeNull();
  });

  it('统一提交：缺必填定位首道缺题并 role=alert；Ctrl+Enter 提交且 IME 组合态不提交；切题点选全程 0 次 IPC', async () => {
    const { bar, submit } = renderQuestion({ ...MULTI, submissionVersion: 2 });
    fireEvent.click(bar.getByRole('radio', { name: 'SQLite' }));
    fireEvent.click(screen.getByTestId('question-pill-3'));
    fireEvent.change(bar.getByRole('textbox', { name: '还有其他要求吗？' }), { target: { value: '无' } });
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('question-send'));
    });
    expect(submit).not.toHaveBeenCalled();
    expect(bar.getByRole('alert').textContent).toContain('第 2 题');
    expect(screen.getByTestId('question-step-count').textContent).toBe('2/3');

    fireEvent.click(bar.getAllByRole('checkbox')[1]);
    const form = screen.getByTestId('question-bar');
    await act(async () => {
      fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true, isComposing: true });
    });
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      action: 'accept',
      delivery: 'form',
      values: { q1: 'sqlite', q2: ['billing'], q3: '无' },
    });
    expect(submit.mock.calls[0][0].submissionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('原生 v2：同一提交意图失败重试复用同一 submissionId；保留 false / 0；schema 不合法时定位并报错', async () => {
    const q: UserQuestion = {
      message: '设置',
      state: 'open',
      submissionVersion: 2,
      fields: [
        { name: 'flag', title: '开关', type: 'boolean', required: true, initial: false },
        { name: 'n', title: '数量', type: 'integer', required: true, initial: 0, minimum: 0, maximum: 5 },
      ],
    };
    const submit = vi.fn().mockRejectedValueOnce(new Error('断线')).mockResolvedValue({ mode: 'form', submissionId: 'x' });
    const { bar } = renderQuestion(q, submit);
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(bar.getByRole('alert').textContent).toContain('断线');
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0].values).toEqual({ flag: false, n: 0 });
    expect(submit.mock.calls[1][0].submissionId).toBe(submit.mock.calls[0][0].submissionId);

    cleanup();
    const bad = vi.fn().mockResolvedValue(undefined);
    renderQuestion({ ...q, fields: [{ ...q.fields[1], initial: 9 }] }, bad, true, 'bad');
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(bad).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('格式');
  });

  it('原生 v2：改写闭集选项 / 自定义回答 → 卡片内逐题预览 + 明确说明，二次确认后发 followup', async () => {
    const submit = vi.fn().mockResolvedValue({ mode: 'followup', submissionId: 'abc', followupState: 'queued' });
    const { bar } = renderQuestion({ ...MULTI, submissionVersion: 2 }, submit);
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    fireEvent.change(bar.getByRole('textbox', { name: '修改选项 SQLite' }), { target: { value: 'SQLite + WAL' } });
    fireEvent.keyDown(bar.getByRole('textbox', { name: '修改选项 SQLite' }), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('question-next'));
    fireEvent.click(bar.getByRole('button', { name: '自定义回答' }));
    fireEvent.change(bar.getByRole('textbox', { name: '自定义回答' }), { target: { value: '只要认证' } });
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(submit).not.toHaveBeenCalled();
    const preview = screen.getByTestId('question-followup-preview');
    expect(preview.textContent).toContain('将以普通消息发送，跳过当前表单');
    expect(preview.textContent).toContain('SQLite + WAL');
    expect(preview.textContent).toContain('原选项：SQLite');
    expect(preview.textContent).toContain('只要认证');
    fireEvent.click(screen.getByTestId('question-followup-back'));
    expect(screen.queryByTestId('question-followup-preview')).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    await act(async () => fireEvent.click(screen.getByTestId('question-followup-confirm')));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      action: 'accept',
      delivery: 'followup',
      optionEdits: { q1: { sqlite: 'SQLite + WAL' } },
      customAnswers: { q2: '只要认证' },
    });
    expect(submit.mock.calls[0][0].submissionId).toBeTruthy();
  });

  it('FE-BUG-07：预览态隐藏步进器且 Ctrl+Enter 直接发 preview、编辑全选、maxItems 阻断、混合校验、提交不回写草稿、数字中间态缓冲', async () => {
    // 1) 预览态隐藏步进器 + Ctrl+Enter 直接确认发送 + 编辑聚焦全选
    const submitPreview = vi.fn().mockResolvedValue({ mode: 'followup', submissionId: 's1', followupState: 'queued' });
    const { bar } = renderQuestion({ ...MULTI, submissionVersion: 2 }, submitPreview, true, 'fe-bug-07-preview');
    fireEvent.click(bar.getByRole('button', { name: '编辑选项「SQLite」' }));
    const editInput = bar.getByRole('textbox', { name: '修改选项 SQLite' }) as HTMLInputElement;
    expect(document.activeElement).toBe(editInput);
    expect(editInput.selectionStart).toBe(0);
    expect(editInput.selectionEnd).toBe('SQLite'.length);
    fireEvent.change(editInput, { target: { value: 'SQLite WAL' } });
    fireEvent.keyDown(editInput, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('question-next'));
    fireEvent.click(bar.getByRole('checkbox', { name: /认证/ }));
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(screen.getByTestId('question-followup-preview')).toBeTruthy();
    expect(screen.queryByTestId('question-stepper')).toBeNull();
    // 预览态按 Ctrl+Enter 直接发送 preview，而不是重建预览
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('question-bar'), { key: 'Enter', ctrlKey: true });
    });
    expect(submitPreview).toHaveBeenCalledTimes(1);
    expect(submitPreview.mock.calls[0][0]).toMatchObject({ delivery: 'followup' });
    expect(sessionStorage.getItem('gravity.question.fe-bug-07-preview')).toBeNull();

    cleanup();

    // 2) 多选 maxItems 提示与上限阻断（含铅笔按钮）+ 混合改写时其余字段仍走 validateFieldValue + 数字中间态缓冲 + 直接提交不回写草稿
    const complexQ: UserQuestion = {
      message: '高级设置',
      state: 'open',
      submissionVersion: 2,
      fields: [
        {
          name: 'tags',
          title: '标签',
          type: 'array',
          required: true,
          maxItems: 2,
          choices: [
            { value: 'a', label: '甲' },
            { value: 'b', label: '乙' },
            { value: 'c', label: '丙' },
          ],
        },
        {
          name: 'ratio',
          title: '系数',
          type: 'number',
          required: true,
          minimum: -10,
          maximum: 10,
        },
      ],
    };
    const submitComplex = vi.fn().mockResolvedValue({ mode: 'form', submissionId: 's2' });
    const { bar: bar2 } = renderQuestion(complexQ, submitComplex, true, 'fe-bug-07-complex');
    expect(screen.getByTestId('question-max-items-tags').textContent).toContain('2');
    fireEvent.click(bar2.getByRole('checkbox', { name: '甲' }));
    fireEvent.click(bar2.getByRole('checkbox', { name: '乙' }));
    const thirdCheckbox = bar2.getByRole('checkbox', { name: '丙' }) as HTMLButtonElement;
    const thirdPencil = bar2.getByRole('button', { name: '编辑选项「丙」' }) as HTMLButtonElement;
    expect(thirdCheckbox.disabled).toBe(true);
    expect(thirdPencil.disabled).toBe(true);

    // 改写已选中的「甲」触发 hasRewrite，同时第 2 题输入超范围数字 -> 必须先拦截校验，不能进入预览
    fireEvent.click(bar2.getByRole('button', { name: '编辑选项「甲」' }));
    fireEvent.change(bar2.getByRole('textbox', { name: '修改选项 甲' }), { target: { value: '甲定制' } });
    fireEvent.keyDown(bar2.getByRole('textbox', { name: '修改选项 甲' }), { key: 'Enter' });

    fireEvent.click(screen.getByTestId('question-next'));
    const numInput = bar2.getByRole('textbox', { name: '系数' }) as HTMLInputElement;
    // 允许键入中间态 '-' / '-.' / '1.'
    fireEvent.change(numInput, { target: { value: '-' } });
    expect(numInput.value).toBe('-');
    fireEvent.change(numInput, { target: { value: '-.' } });
    expect(numInput.value).toBe('-.');
    fireEvent.blur(numInput);
    expect(numInput.value).toBe('');
    fireEvent.change(numInput, { target: { value: '1.' } });
    expect(numInput.value).toBe('1.');
    fireEvent.blur(numInput);
    expect(numInput.value).toBe('1');

    // 输入超范围 99：即使第 1 题 hasRewrite，仍须拒绝
    fireEvent.change(numInput, { target: { value: '99' } });
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(screen.queryByTestId('question-followup-preview')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('格式');

    // 还原改写并改为合法负数 -2.5 -> 直接提交 form，提交后 sessionStorage 不得被 useEffect 写回
    fireEvent.change(numInput, { target: { value: '-2.5' } });
    fireEvent.click(screen.getByTestId('question-prev'));
    fireEvent.click(bar2.getByRole('button', { name: '还原选项「甲」' }));
    await act(async () => fireEvent.click(screen.getByTestId('question-send')));
    expect(submitComplex).toHaveBeenCalledTimes(1);
    expect(submitComplex.mock.calls[0][0]).toMatchObject({
      delivery: 'form',
      values: { tags: ['a', 'b'], ratio: -2.5 },
    });
    expect(sessionStorage.getItem('gravity.question.fe-bug-07-complex')).toBeNull();
  });

  it('旧对象（缺 submissionVersion）沿用旧协议，不携带 delivery；草稿 v1 迁移为 v2', async () => {
    const legacyQ: UserQuestion = { ...MULTI, fields: [MULTI.fields[0]] };
    const v1 = JSON.stringify({ values: { q1: 'pg' }, edits: { [JSON.stringify(['q1', 'pg'])]: 'Postgres 16' }, custom: '' });
    const migrated = readQuestionDraft(v1, legacyQ);
    expect(migrated).toMatchObject({ v: 2, values: { q1: 'pg' }, edits: { q1: { pg: 'Postgres 16' } } });
    expect(readQuestionDraft(JSON.stringify({ values: {}, edits: {}, custom: '随便' }), legacyQ)).toMatchObject({ custom: { q1: '随便' }, mode: { q1: 'custom' } });

    sessionStorage.setItem('gravity.question.legacy', v1);
    const submit = vi.fn().mockResolvedValue(undefined);
    const { bar } = renderQuestion(legacyQ, submit, true, 'legacy');
    expect(bar.getByRole('radio', { name: /Postgres 16/ }).getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(bar.getByRole('button', { name: '发送回答' })));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].delivery).toBeUndefined();
    expect(submit.mock.calls[0][0]).toMatchObject({ action: 'accept', values: { q1: 'pg' }, customReply: 'Postgres 16' });
    expect(JSON.parse(sessionStorage.getItem('gravity.question.legacy') ?? 'null')).toBeNull();
  });
});

/* =========================================================================
 * 3. followup 状态
 * ======================================================================= */
describe('v0.3.5 questionFollowup 投递状态', () => {
  it('仅 failed-unsent 展示唯一「重新发送」并携带 retryUnsentFollowup；unknown 不提供重发', async () => {
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    window.gravityDesktop = { ...getFallbackDesktopBridge(), answerQuestion } as GravityDesktopBridge;
    const { unmount } = render(
      wrap(<QuestionFollowupStatus sessionId="s1" followup={{ questionMessageId: 'm1', submissionId: 'sub-1', state: 'failed-unsent' }} />)
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByTestId('question-followup-retry-m1')));
    expect(answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', messageId: 'm1', submissionId: 'sub-1', retryUnsentFollowup: true, delivery: 'followup' })
    );
    unmount();
    render(wrap(<QuestionFollowupStatus sessionId="s1" followup={{ questionMessageId: 'm2', submissionId: 'sub-2', state: 'unknown' }} />));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('question-followup-m2').textContent).toContain('核对');
    expect(answerQuestion).toHaveBeenCalledTimes(1);
  });
});

/* =========================================================================
 * 4. Plan 检视器
 * ======================================================================= */
function telemetry(): TelemetryDashboardSnapshot {
  return {
    activeSessions: {},
    hourly24h: [],
    matrix7d: [],
    calendar30d: [],
    costByRange: {} as TelemetryDashboardSnapshot['costByRange'],
    modelBreakdownByRange: {} as TelemetryDashboardSnapshot['modelBreakdownByRange'],
    rateCards: [],
    updatedAt: '',
  } as unknown as TelemetryDashboardSnapshot;
}

function renderPlan(inspectorData: SessionInspectorData | undefined, messages: ChatMessageItem[] = [], sessionId = 's-plan') {
  const todos = resolveAuthoritativeTodos(inspectorData?.plan, inspectorData?.todos, messages);
  return render(
    wrap(
      <InlinePlanCard
        profileId="p1"
        sessionId={sessionId}
        plan={inspectorData?.plan}
        todos={todos}
      />
    )
  );
}

const oldTodosMsg: ChatMessageItem = {
  id: 'old',
  sessionId: 's-plan',
  role: 'assistant',
  content: '',
  createdAt: '',
  todos: [{ id: 'legacy-1', content: '旧待办', status: 'pending' }],
};

describe('v0.3.5 Plan 检视器', () => {
  it('plan.state === empty 时绝不复活旧消息待办；仅 plan 缺省时才回溯', async () => {
    window.gravityDesktop = { ...getFallbackDesktopBridge() };
    const { unmount } = renderPlan(
      { sessionId: 's-plan', diffs: [], todos: [], terminals: [], plan: { state: 'empty', revision: 2, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 } },
      [oldTodosMsg]
    );
    expect(screen.queryByText('旧待办')).toBeNull();
    unmount();
    renderPlan({ sessionId: 's-plan', diffs: [], todos: [], terminals: [] }, [oldTodosMsg]);
    expect(screen.getByText('旧待办')).toBeTruthy();
    await act(async () => {});
  });

  it('6 态待办 + rawStatus 标签 + 进度按 completedCount/totalCount 且带 aria-label + 截断提示 + 长路径断行', async () => {
    window.gravityDesktop = { ...getFallbackDesktopBridge() };
    const longPath = 'src/' + 'very-long-directory-name/'.repeat(12) + 'file.ts';
    renderPlan({
      sessionId: 's-plan',
      diffs: [],
      terminals: [],
      todos: [
        { id: 'a', content: '待办', status: 'pending' },
        { id: 'b', content: '进行', status: 'in_progress' },
        { id: 'c', content: '完成', status: 'completed' },
        { id: 'd', content: '跳过', status: 'skipped' },
        { id: 'e', content: longPath, status: 'failed' },
        { id: 'f', content: '未知', status: 'unknown', rawStatus: 'blocked-by-review' },
      ],
      plan: { state: 'present', revision: 4, truncated: true, totalCount: 9, completedCount: 3, failedCount: 1 },
    });
    for (const [id, status] of [['a', 'pending'], ['b', 'in_progress'], ['c', 'completed'], ['d', 'skipped'], ['e', 'failed'], ['f', 'unknown']] as const) {
      expect(screen.getByTestId(`plan-item-${id}`).dataset.status).toBe(status);
    }
    expect(screen.getByRole('img', { name: '已跳过' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '失败' })).toBeTruthy();
    expect(screen.getByTestId('plan-item-f').textContent).toContain('blocked-by-review');
    const bar = screen.getByTestId('plan-progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('9');
    expect(bar.getAttribute('aria-label')).toBe('计划进度：已完成 3/9');
    expect(screen.getByTestId('plan-truncated-hint')).toBeTruthy();
    expect(screen.getByTestId('inline-plan-card').getAttribute('style')).toBeNull();
    expect(screen.getByTestId('plan-item-e').querySelector('.plan-item-text')).toBeTruthy();
    await act(async () => {});
  });

  it('只读 implementation_plan.md：先 summary 后按需抽屉 content、knownRevision 增量读取、事件刷新、手动刷新、D-01 planArtifactOwner 仅限计划本体、#anchor 抽屉内滚动', async () => {
    let listener: ((e: PlanArtifactChangedEvent) => void) | undefined;
    const planFilePath = 'D:\\sandbox-home\\.gemini\\brain\\s-plan\\implementation_plan.md';
    const content = [
      '# Plan',
      '',
      '## 实施步骤',
      '',
      '- [x] 第一步 [跳转实施](#实施步骤)',
      '- [ ] 第二步 [文档](https://example.com/doc) 与 [代码](./src/app.ts) 与 [本体](file:///D:/sandbox-home/.gemini/brain/s-plan/implementation_plan.md)',
      '',
      '![图](https://example.com/a.png)',
    ].join('\n');
    const planSessionId = 's-plan-doc';
    let revision = 1;
    const getSessionPlanArtifact = vi.fn(
      async (input: { profileId: string; sessionId: string; view?: 'summary' | 'content'; knownRevision?: number }) => {
        const view = input.view ?? 'summary';
        if (input.knownRevision === revision) {
          return {
            status: 'unchanged' as const,
            view,
            owner: { profileId: 'p1', sessionId: planSessionId },
            revision,
            summaryRevision: revision,
            contentRevision: revision,
          };
        }
        return {
          status: 'ready' as const,
          view,
          owner: { profileId: 'p1', sessionId: planSessionId },
          revision,
          summaryRevision: revision,
          contentRevision: revision,
          filePath: planFilePath,
          ...(view === 'content'
            ? { content: content + (revision > 1 ? '\n\n新增' : '') }
            : {
                outline: {
                  title: 'Plan',
                  sections: [{ id: 's1', level: 2, heading: '实施步骤', summary: revision > 1 ? '含新增步骤' : '第一步与第二步' }],
                  sectionCount: 1,
                },
              }),
          updatedAt: '2026-11-26T00:00:00Z',
        };
      }
    );
    const openLinkOrFileTarget = vi.fn().mockResolvedValue({ opened: true, modeUsed: 'browser', resolvedTarget: '' });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact,
      openLinkOrFileTarget,
      onPlanArtifactChanged: (fn) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    };
    render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId={planSessionId}
          plan={{ state: 'unreceived', revision: 1, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 }}
          todos={[]}
        />
      )
    );
    // v0.3.6：先只读 summary 展示概要态，不提前加载原文
    const outlineEl = await screen.findByTestId('plan-outline');
    expect(outlineEl.textContent).toContain('实施步骤');
    expect(getSessionPlanArtifact).toHaveBeenCalledWith({ profileId: 'p1', sessionId: planSessionId, view: 'summary' });
    expect(screen.queryByTestId('plan-artifact-document')).toBeNull();

    // 点击「查看原文」按需打开抽屉读取 content
    fireEvent.click(screen.getByTestId('plan-source-open'));
    const doc = await screen.findByTestId('plan-artifact-document');
    expect(getSessionPlanArtifact).toHaveBeenLastCalledWith({ profileId: 'p1', sessionId: planSessionId, view: 'content' });
    expect(doc.textContent).toContain('第一步');
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(doc.innerHTML).not.toContain('<img');

    // 其他会话事件忽略；同会话新修订触发 summary 增量与抽屉正文刷新
    const callsBefore = getSessionPlanArtifact.mock.calls.length;
    await act(async () => listener?.({ profileId: 'p1', sessionId: 'other', revision: 9, summaryRevision: 9, contentRevision: 9 }));
    expect(getSessionPlanArtifact).toHaveBeenCalledTimes(callsBefore);
    revision = 2;
    await act(async () => listener?.({ profileId: 'p1', sessionId: planSessionId, revision: 2, summaryRevision: 2, contentRevision: 2 }));
    expect(getSessionPlanArtifact).toHaveBeenCalledWith({ profileId: 'p1', sessionId: planSessionId, view: 'summary', knownRevision: 1 });
    await waitFor(() => expect(screen.getByTestId('plan-artifact-document').textContent).toContain('新增'));

    // 抽屉内手动刷新不传 knownRevision
    await act(async () => fireEvent.click(screen.getByTestId('plan-artifact-refresh')));
    expect(getSessionPlanArtifact).toHaveBeenCalledWith({ profileId: 'p1', sessionId: planSessionId, view: 'content' });

    // FE-BUG-08：标题生成确定性 id 与 data-anchor，点击 #anchor 直接抽屉内滚动，绝不调用 openLinkOrFileTarget
    const targetHeading = doc.querySelector<HTMLElement>('[data-anchor="实施步骤"]')!;
    expect(targetHeading).toBeTruthy();
    expect(targetHeading.id).toContain('实施步骤');
    const scrollSpy = vi.fn();
    targetHeading.scrollIntoView = scrollSpy;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '跳转实施' })));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(openLinkOrFileTarget).not.toHaveBeenCalled();

    // D-01：外链与工作区其它文件链接走常规安全打开，不传 planArtifactOwner
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '文档' })));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 'https://example.com/doc', action: 'browser', sessionId: planSessionId })
    );
    expect(openLinkOrFileTarget.mock.calls.at(-1)?.[0].planArtifactOwner).toBeUndefined();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '代码' })));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: './src/app.ts', action: 'default-app', sessionId: planSessionId })
    );
    expect(openLinkOrFileTarget.mock.calls.at(-1)?.[0].planArtifactOwner).toBeUndefined();

    // D-01：仅打开计划文档本体（抽屉打开按钮或精准指向 snapshot.filePath 的链接）才携带 planArtifactOwner
    await act(async () => fireEvent.click(screen.getByTestId('plan-artifact-open-file')));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: planFilePath,
        action: 'default-app',
        planArtifactOwner: expect.objectContaining({ profileId: 'p1', sessionId: planSessionId, revision: 2, contentRevision: 2 }),
      })
    );

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '本体' })));
    expect(openLinkOrFileTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'default-app',
        planArtifactOwner: expect.objectContaining({ profileId: 'p1', sessionId: planSessionId, revision: 2, contentRevision: 2 }),
      })
    );

    // 关闭原文抽屉回到概要态
    fireEvent.click(screen.getByTestId('plan-source-close'));
    expect(screen.queryByTestId('plan-source-drawer')).toBeNull();
    expect(screen.getByTestId('plan-outline')).toBeTruthy();
  });

  it('FE-BUG-08：snapshot === null 收到 unchanged 时无 knownRevision 重拉一次，仍无内容则按纯空态收口不卡 Loading', async () => {
    // 场景 A：首次 unchanged，重拉一次返回 ready（旧桥接返回 content 时前端自动提取概要）
    const retryFetcher = vi
      .fn()
      .mockResolvedValueOnce({ status: 'unchanged', owner: { profileId: 'p1', sessionId: 's-plan-retry' }, revision: 3 })
      .mockResolvedValueOnce({
        status: 'ready',
        owner: { profileId: 'p1', sessionId: 's-plan-retry' },
        revision: 3,
        content: '# Recovered\n\n## Section A\nBody',
      });
    window.gravityDesktop = { ...getFallbackDesktopBridge(), getSessionPlanArtifact: retryFetcher };
    const { unmount } = render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-retry"
          plan={undefined}
          todos={[]}
        />
      )
    );
    expect((await screen.findByTestId('plan-outline')).textContent).toContain('Recovered');
    expect(retryFetcher).toHaveBeenCalledTimes(2);
    expect(retryFetcher.mock.calls[1][0]).toEqual({ profileId: 'p1', sessionId: 's-plan-retry', view: 'summary' });
    unmount();

    // 场景 B：连续 unchanged 也不卡 Loading，InlinePlanCard 呈纯空 0 DOM，兼容 PlanTimeline 按纯空态收口且 0 文件栏
    const stuckFetcher = vi.fn(async (input: { profileId: string; sessionId: string }) => ({
      status: 'unchanged' as const,
      owner: { profileId: input.profileId, sessionId: input.sessionId },
      revision: 0,
    }));
    window.gravityDesktop = { ...getFallbackDesktopBridge(), getSessionPlanArtifact: stuckFetcher };
    const inlineStuck = render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-stuck"
          plan={undefined}
          todos={[]}
        />
      )
    );
    await waitFor(() => expect(stuckFetcher).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('inline-plan-card')).toBeNull();
    expect(screen.queryByTestId('plan-source-open')).toBeNull();
    inlineStuck.unmount();

    render(wrap(<PlanTimeline profileId="p1" sessionId="s-plan-stuck-compat" plan={undefined} todos={[]} />));
    expect(await screen.findByTestId('plan-empty')).toBeTruthy();
    expect(screen.queryByTestId('plan-source-line')).toBeNull();
  });

  it('unavailable 状态（0 文件名）与不支持该接口的旧桥接（0 文件栏 / 内联 0 DOM）', async () => {
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({ status: 'unavailable', owner: { profileId: 'p1', sessionId: 's-plan-unavail' }, revision: 0, reason: '权限不足' }),
    };
    const { unmount } = render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-unavail"
          plan={undefined}
          todos={[]}
        />
      )
    );
    const unavail = await screen.findByTestId('plan-unavailable');
    expect(unavail.textContent).toContain('权限不足');
    expect(unavail.textContent).not.toContain('implementation_plan.md');
    expect(screen.queryByTestId('plan-source-open')).toBeNull();
    unmount();
    const legacy = { ...getFallbackDesktopBridge() } as Partial<GravityDesktopBridge>;
    delete legacy.getSessionPlanArtifact;
    delete legacy.onPlanArtifactChanged;
    window.gravityDesktop = legacy as GravityDesktopBridge;
    const inlineLegacy = render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-legacy"
          plan={undefined}
          todos={[]}
        />
      )
    );
    expect(screen.queryByTestId('inline-plan-card')).toBeNull();
    inlineLegacy.unmount();
    render(wrap(<PlanTimeline profileId="p1" sessionId="s-plan-legacy-compat" plan={undefined} todos={[]} />));
    expect(screen.getByTestId('plan-empty')).toBeTruthy();
    expect(screen.queryByTestId('plan-source-line')).toBeNull();
  });

  it('unreceived + 文档就绪展示概要态；missing 内联 0 DOM；plan.state === empty（状态 ④）隐藏文件按钮', async () => {
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: vi.fn().mockResolvedValue({
        status: 'ready',
        view: 'summary',
        owner: { profileId: 'p1', sessionId: 's-plan-outline-only' },
        revision: 1,
        summaryRevision: 1,
        contentRevision: 1,
        filePath: '/repo/implementation_plan.md',
        outline: { title: '实施计划', sections: [{ id: 'sec-1', level: 2, heading: '第一步', summary: '' }], sectionCount: 1 },
      }),
    };
    const unreceivedPlan = { state: 'unreceived' as const, revision: 1, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 };
    const { unmount } = render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-outline-only"
          plan={unreceivedPlan}
          todos={[]}
        />
      )
    );
    expect((await screen.findByTestId('plan-outline')).textContent).toContain('实施计划');
    expect(screen.queryByTestId('plan-empty')).toBeNull();
    unmount();

    // 状态 ④（DEC-04）：plan.state === 'empty' 时即使存在计划文档也不展示文件按钮与文件名
    const clearedView = render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-outline-only"
          plan={{ state: 'empty', revision: 2, truncated: false, totalCount: 0, completedCount: 0, failedCount: 0 }}
          todos={[]}
        />
      )
    );
    expect(await screen.findByTestId('plan-cleared')).toBeTruthy();
    expect(screen.queryByTestId('plan-source-open')).toBeNull();
    expect(screen.queryByTestId('plan-artifact-open-file')).toBeNull();
    expect(screen.getByTestId('inline-plan-card').textContent).not.toContain('implementation_plan.md');
    clearedView.unmount();

    const missingFetcher = vi.fn().mockResolvedValue({
      status: 'missing',
      owner: { profileId: 'p1', sessionId: 's-plan-missing' },
      revision: 0,
    });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      getSessionPlanArtifact: missingFetcher,
    };
    render(
      wrap(
        <InlinePlanCard
          profileId="p1"
          sessionId="s-plan-missing"
          plan={unreceivedPlan}
          todos={[]}
        />
      )
    );
    await waitFor(() => expect(missingFetcher).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('inline-plan-card')).toBeNull();
    expect(screen.queryByTestId('plan-source-open')).toBeNull();
  });
});

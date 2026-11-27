import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  ExternalLink,
  FileText,
  ListTodo,
} from 'lucide-react';
import type { SessionPlanSummary, SessionTodoItem } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { usePlanArtifact } from '../hooks/usePlanArtifact';
import {
  computePlanProgress,
  derivePlanViewKind,
  groupPlanTimeline,
  normalizeTodoStatus,
  type PlanTimelineEntry,
} from '../lib/plan-view';
import { PlanSourceDrawer, formatPlanTime, openPlanArtifactExternally } from './PlanArtifactPanel';
import { Icon } from './ui/Icon';

/** 6 态：图标 / 颜色（CSS `is-*`）/ 文案三者一致 */
export const PLAN_STATUS_ICON = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
  skipped: CircleMinus,
  failed: CircleX,
  unknown: CircleDashed,
} as const;

/**
 * v0.3.6 Plan 页签：四态时间线（纯空 / 计划概要 / 实时执行 / 显式清空）+ 按需原文抽屉。
 * 计划文档仅在抽屉打开时读取正文；摘要视图不携带正文。
 */
export function PlanTimeline({
  profileId,
  sessionId,
  epoch,
  cwd,
  plan,
  todos,
}: {
  profileId: string;
  sessionId: string | null;
  epoch?: number;
  cwd?: string;
  plan: SessionPlanSummary | undefined;
  todos: SessionTodoItem[];
}): React.ReactElement {
  const { dict } = useI18n();
  const t5 = dict.ui.v035;
  const t6 = dict.ui.v036;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openError, setOpenError] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // QA1-FE-18 / TC-PLAN-15：直接 rerender 切换会话/Profile 时立即复位抽屉与折叠态
  useEffect(() => {
    setDrawerOpen(false);
    setOpenError('');
    setExpandedGroups({});
  }, [profileId, sessionId]);
  const artifact = usePlanArtifact({ profileId, sessionId, epoch, contentOpen: drawerOpen });
  const summary = artifact.summary;
  const outline = summary?.status === 'ready' ? summary.outline : undefined;
  const hasDoc = summary?.status === 'ready';
  const kind = derivePlanViewKind({
    plan,
    todos,
    artifactStatus: artifact.error ? 'error' : summary?.status,
    hasOutline: Boolean(outline),
  });
  const progress = useMemo(() => computePlanProgress(plan, todos), [plan, todos]);
  const timeline = useMemo(() => groupPlanTimeline(todos), [todos]);
  const updated = formatPlanTime(summary?.updatedAt);
  const owner = sessionId
    ? { profileId, sessionId, ...(epoch !== undefined ? { epoch } : {}), revision: summary?.revision, summaryRevision: summary?.revision }
    : null;

  const openExternal = () => {
    if (!summary?.filePath || !owner || !sessionId) return;
    setOpenError('');
    void openPlanArtifactExternally({ filePath: summary.filePath, cwd, sessionId, owner }).catch((reason) =>
      setOpenError(`${t5.planArtifactOpenError}：${stripIpcErrorPrefix(reason)}`)
    );
  };

  if (drawerOpen && sessionId && hasDoc) {
    return (
      <div className="inspector-stack plan-stack" data-testid="inspector-view-plan" data-plan-view="source">
        <PlanSourceDrawer
          profileId={profileId}
          sessionId={sessionId}
          epoch={epoch}
          cwd={cwd}
          filePath={summary?.filePath}
          revision={artifact.content?.revision}
          content={artifact.content?.content ?? null}
          truncated={artifact.content?.truncated}
          updatedAt={artifact.content?.updatedAt ?? summary?.updatedAt}
          loading={artifact.loadingContent || artifact.loadingSummary}
          error={artifact.error}
          onRefresh={artifact.refresh}
          onClose={() => setDrawerOpen(false)}
        />
      </div>
    );
  }

  // QA1-FE-13 / TC-PLAN-01：仅状态 ②（概要）与状态 ③（实时执行）展示底部文件入口；① 纯空与 ④ 显式清空 DOM 严格 0 文件栏
  const showSourceFooter = hasDoc && (kind === 'outline' || kind === 'execution');
  const sourceFooter = showSourceFooter ? (
    <div className="plan-source-line" data-testid="plan-source-line">
      <button type="button" className="plan-source-open" onClick={() => setDrawerOpen(true)} data-testid="plan-source-open">
        <Icon icon={FileText} size="xs" />
        <span>
          {kind === 'execution'
            ? outline && outline.sectionCount > 0
              ? t6.planDocWithSections(outline.sectionCount)
              : t6.planDocLine
            : t6.planViewSource}
        </span>
      </button>
      {updated && <span className="plan-source-meta truncate">{t6.planUpdated(updated)}</span>}
      {summary?.filePath && (
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={openExternal}
          aria-label={t6.planOpenExternal}
          title={t6.planOpenExternal}
          data-testid="plan-artifact-open-file"
        >
          <Icon icon={ExternalLink} size="xs" />
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="inspector-stack plan-stack" data-testid="inspector-view-plan" data-plan-view={artifact.pending && kind === 'empty' ? 'pending' : kind}>
      {kind === 'empty' && !artifact.pending && (
        <div className="plan-empty" data-testid="plan-empty">
          <Icon icon={ListTodo} size="md" />
          <strong>{t6.planEmptyTitle}</strong>
          <span>{t6.planEmptyHint}</span>
        </div>
      )}
      {kind === 'unavailable' && (
        <p className="plan-note" role="status" data-testid="plan-unavailable">
          {t6.planUnavailable(artifact.error || summary?.reason || '')}
        </p>
      )}
      {kind === 'cleared' && (
        <p className="plan-note" role="status" data-testid="plan-cleared">
          {t6.planCleared}
        </p>
      )}
      {kind === 'outline' && outline && (
        <section className="plan-outline" data-testid="plan-outline">
          {outline.title && <h3 className="plan-outline-title">{outline.title}</h3>}
          {outline.goal && (
            <p className="plan-outline-goal" data-testid="plan-outline-goal">
              {outline.goal}
            </p>
          )}
          {outline.sections.length > 0 && (
            <ol className="plan-outline-sections" aria-label={t6.planSections(outline.sectionCount)}>
              {outline.sections.map((section) => (
                <li key={section.id} className="plan-outline-section" data-testid={`plan-outline-section-${section.id}`}>
                  <span className="plan-outline-dot" aria-hidden="true" />
                  <span className="plan-outline-text">
                    <span className="plan-outline-heading">{section.heading}</span>
                    {section.summary && <span className="plan-outline-summary">{section.summary}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {outline.sectionCount > outline.sections.length && (
            <p className="plan-note">{t6.planSectionsMore(outline.sectionCount - outline.sections.length)}</p>
          )}
          <p className="plan-note">{t6.planOutlineFooterHint}</p>
        </section>
      )}
      {kind === 'execution' && (
        <>
          <div className="plan-summary" data-testid="plan-summary">
            <div className="plan-summary-row">
              <span className="plan-summary-count">{dict.planProgress(progress.done, progress.total)}</span>
              {progress.failed > 0 && (
                <span className="badge badge-danger plan-failed-count">{t5.planFailedCount(progress.failed)}</span>
              )}
            </div>
            <span
              className="plan-progressbar"
              role="progressbar"
              aria-label={t5.planProgressAria(progress.done, progress.total)}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              data-testid="plan-progressbar"
            >
              <span style={{ '--fill': progress.total ? progress.done / progress.total : 0 } as React.CSSProperties} />
            </span>
            {progress.current && (
              <span className="plan-summary-now truncate" data-testid="plan-current-step" title={progress.current}>
                {t6.planNow(progress.current)}
              </span>
            )}
          </div>
          <ol className="plan-timeline" data-testid="plan-timeline">
            {timeline.map((entry: PlanTimelineEntry) =>
              entry.kind === 'item' ? (
                <PlanTodoRow key={entry.item.id} item={entry.item} />
              ) : expandedGroups[entry.key] ? (
                entry.items.map((item) => <PlanTodoRow key={item.id} item={item} />)
              ) : (
                <li key={entry.key} className="plan-item is-completed is-group">
                  <button
                    type="button"
                    className="plan-group-toggle"
                    aria-expanded={false}
                    onClick={() => setExpandedGroups((prev) => ({ ...prev, [entry.key]: true }))}
                    data-testid={`plan-done-group-${entry.items[0].id}`}
                  >
                    <Icon icon={CircleCheck} size="sm" className="plan-item-icon is-completed" />
                    <span className="plan-item-text">{t6.planDoneGroup(entry.items.length)}</span>
                    <Icon icon={ChevronRight} size="xs" />
                  </button>
                </li>
              )
            )}
          </ol>
          {progress.truncated && (
            <div className="plan-truncated" role="note" data-testid="plan-truncated-hint">
              {t5.planTruncated}
            </div>
          )}
        </>
      )}
      {sourceFooter}
      {openError && (
        <p role="alert" className="plan-drawer-msg is-error">
          {openError}
        </p>
      )}
    </div>
  );
}

/** 6 态 SessionTodoStatus + 原始状态标签；长路径在行内断行。 */
export function PlanTodoRow({ item }: { item: SessionTodoItem }): React.ReactElement {
  const { dict } = useI18n();
  const v035 = dict.ui.v035;
  const status = normalizeTodoStatus(item.status);
  const tone = status.replace('_', '-');
  const label = v035.planStatus[status];
  return (
    <li className={`plan-item is-${tone}`} data-status={status} data-testid={`plan-item-${item.id}`}>
      <Icon icon={PLAN_STATUS_ICON[status]} size="sm" className={`plan-item-icon is-${tone}`} label={label} />
      <span className="plan-item-text">{item.content}</span>
      {status !== 'pending' && status !== 'completed' && status !== 'unknown' && (
        <span className={`plan-item-state is-${tone}`} aria-hidden="true">
          {label}
        </span>
      )}
      {item.rawStatus && (status === 'unknown' || item.rawStatus !== item.status) && (
        <span className="badge badge-mono plan-item-raw" title={v035.planRawStatus(item.rawStatus)}>
          {item.rawStatus}
        </span>
      )}
    </li>
  );
}

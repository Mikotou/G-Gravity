import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  RefreshCw,
} from 'lucide-react';
import type { SessionPlanSummary, SessionTodoItem } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { isImeComposing } from '../lib/platform-keys';
import { usePlanArtifact, type UsePlanArtifactResult } from '../hooks/usePlanArtifact';
import {
  computePlanProgress,
  derivePlanViewKind,
  groupPlanTimeline,
  normalizeTodoStatus,
  type PlanTimelineEntry,
} from '../lib/plan-view';
import { PlanDocument, PlanSourceDrawer, formatPlanTime, isPlanArtifactSelfTarget, openPlanArtifactExternally, planHeadingSlug } from './PlanArtifactPanel';
import { scrollBehavior } from '../lib/motion';
import { getDesktopBridge } from '../services/desktop-bridge';
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
  const effectiveEpoch = (drawerOpen ? artifact.content?.epoch : undefined) ?? artifact.summary?.epoch ?? epoch;
  const owner = sessionId
    ? { profileId, sessionId, ...(effectiveEpoch !== undefined ? { epoch: effectiveEpoch } : {}), revision: summary?.revision, summaryRevision: summary?.revision }
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
          epoch={effectiveEpoch}
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
    <div className="plan-src-footer" data-testid="plan-source-line">
      <button type="button" className="inline-plan-src-btn" onClick={() => setDrawerOpen(true)} data-testid="plan-source-open">
        <Icon icon={FileText} size="xs" />
        <span>
          {kind === 'execution'
            ? outline && outline.sectionCount > 0
              ? t6.planDocWithSections(outline.sectionCount)
              : t6.planDocLine
            : t6.planViewSource}
        </span>
      </button>
      {updated && <span className="plan-drawer-meta truncate">{t6.planUpdated(updated)}</span>}
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

/* ---------------------------------------------------------------------------
 * v0.3.6 InlinePlanCard：宽幅内联卡片，渲染在主对话流内 MessageTurn 中。
 * 五态：empty → null（0 DOM），execution / outline / cleared / unavailable。
 * 内部管理 usePlanArtifact 与 source drawer 的展开/折叠/Esc/会话切换复位。
 * ------------------------------------------------------------------------- */

export function InlinePlanCard({
  profileId,
  sessionId,
  epoch,
  cwd,
  plan,
  todos,
  artifact: artifactProp,
  sourceOpen: sourceOpenProp,
  onSourceOpenChange,
  expanded: expandedProp,
  onExpandedChange,
  expandedGroups: expandedGroupsProp,
  onExpandedGroupsChange,
  isFocused = true,
}: {
  profileId: string;
  sessionId: string;
  epoch?: number;
  cwd?: string;
  plan: SessionPlanSummary | undefined;
  todos: SessionTodoItem[];
  artifact?: UsePlanArtifactResult;
  sourceOpen?: boolean;
  onSourceOpenChange?: (open: boolean) => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  expandedGroups?: Record<string, boolean>;
  onExpandedGroupsChange?: (groups: Record<string, boolean>) => void;
  isFocused?: boolean;
}): React.ReactElement | null {
  const { dict } = useI18n();
  const t5 = dict.ui.v035;
  const t6 = dict.ui.v036;
  const uid = useId();
  const cardRef = useRef<HTMLElement>(null);

  const [ownExpanded, setOwnExpanded] = useState(true);
  const expanded = expandedProp ?? ownExpanded;
  const setExpanded = useCallback(
    (next: boolean) => {
      if (onExpandedChange) onExpandedChange(next);
      else setOwnExpanded(next);
    },
    [onExpandedChange]
  );

  const [ownSourceOpen, setOwnSourceOpen] = useState(false);
  const sourceOpen = sourceOpenProp ?? ownSourceOpen;
  const setSourceOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(sourceOpen) : next;
      if (onSourceOpenChange) onSourceOpenChange(value);
      else setOwnSourceOpen(value);
    },
    [onSourceOpenChange, sourceOpen]
  );

  const [ownExpandedGroups, setOwnExpandedGroups] = useState<Record<string, boolean>>({});
  const expandedGroups = expandedGroupsProp ?? ownExpandedGroups;
  const setExpandedGroups = useCallback(
    (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => {
      if (onExpandedGroupsChange) {
        onExpandedGroupsChange(updater(expandedGroups));
      } else {
        setOwnExpandedGroups(updater);
      }
    },
    [onExpandedGroupsChange, expandedGroups]
  );

  const [openError, setOpenError] = useState('');
  const docRef = React.useRef<HTMLDivElement | null>(null);

  // 归属切换复位：仅当 (profileId, sessionId) 真实变更时触发，首次挂载不 fire
  const prevOwnerRef = useRef(`${profileId}:${sessionId}`);
  useEffect(() => {
    const key = `${profileId}:${sessionId}`;
    if (prevOwnerRef.current === key) return;
    prevOwnerRef.current = key;
    setOwnSourceOpen(false);
    onSourceOpenChange?.(false);
    setOpenError('');
    setOwnExpandedGroups({});
    if (onExpandedGroupsChange) onExpandedGroupsChange({});
    setOwnExpanded(true);
    if (onExpandedChange) onExpandedChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, sessionId]);

  const ownArtifact = usePlanArtifact({ profileId, sessionId: artifactProp ? null : sessionId, epoch, contentOpen: sourceOpen });
  const artifact = artifactProp ?? ownArtifact;
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
  const updated = formatPlanTime(artifact.content?.updatedAt ?? summary?.updatedAt);
  const effectiveEpoch = (sourceOpen ? artifact.content?.epoch : undefined) ?? artifact.summary?.epoch ?? epoch;
  const owner = sessionId
    ? {
        profileId,
        sessionId,
        ...(effectiveEpoch !== undefined ? { epoch: effectiveEpoch } : {}),
        revision: sourceOpen && artifact.content?.revision !== undefined ? artifact.content.revision : summary?.revision,
        ...(summary?.revision !== undefined ? { summaryRevision: summary.revision } : {}),
        ...(sourceOpen && artifact.content?.revision !== undefined ? { contentRevision: artifact.content.revision } : {}),
      }
    : null;

  // Esc handler：sourceOpen && expanded && isFocused 时捕获阶段关闭原文
  useEffect(() => {
    if (!sourceOpen || !expanded || !isFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
      if (document.querySelector('dialog[open], [aria-modal="true"], .target-context-menu, .selection-floating-bar')) return;
      // 同窗格菜单 / 语音听写守卫
      const cardPane = cardRef.current?.closest('.pane');
      if (cardPane?.querySelector('.popover, [role="menu"], .voice-status')) return;
      // 焦点落在其它窗格时让路
      const target = e.target instanceof Element ? e.target : null;
      const targetPane = target?.closest('.pane');
      if (targetPane && cardPane && targetPane !== cardPane) return;
      // 可编辑元素让路
      if (target?.closest('.composer-input, .question-bar, .message-editor, .turn-notation-edit-row, .pane-switch, .feedback-box')) return;
      const editable = target instanceof HTMLElement && (/^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
      if (editable) return;
      e.preventDefault();
      e.stopPropagation();
      setSourceOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded, isFocused, setSourceOpen, sourceOpen]);

  const openExternal = useCallback(() => {
    if (!summary?.filePath || !owner || !sessionId) return;
    setOpenError('');
    void openPlanArtifactExternally({ filePath: summary.filePath, cwd, sessionId, owner }).catch((reason) =>
      setOpenError(`${t5.planArtifactOpenError}：${stripIpcErrorPrefix(reason)}`)
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, summary?.filePath, sessionId, profileId, effectiveEpoch, summary?.revision, artifact.content?.revision, sourceOpen, t5.planArtifactOpenError]);

  const openLink = useCallback(
    async (target: string) => {
      setOpenError('');
      if (target.startsWith('#')) {
        let raw = target.slice(1);
        try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
        const normalizedRaw = raw.trim().toLowerCase();
        const slug = planHeadingSlug(raw);
        const headings = docRef.current?.querySelectorAll<HTMLElement>('[data-anchor]');
        const match = headings
          ? Array.from(headings).find((el) => el.dataset.anchor === normalizedRaw || el.dataset.anchor === slug)
          : null;
        if (match && typeof match.scrollIntoView === 'function') {
          match.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        }
        return;
      }
      const isSelf = isPlanArtifactSelfTarget(target, summary?.filePath);
      try {
        await getDesktopBridge().openLinkOrFileTarget({
          target,
          action: /^https?:/i.test(target) ? 'browser' : 'default-app',
          ...(cwd ? { cwd } : {}),
          sessionId,
          ...(isSelf && owner ? { planArtifactOwner: owner } : {}),
        });
      } catch (reason) {
        setOpenError(`${t5.planArtifactOpenError}：${stripIpcErrorPrefix(reason)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd, sessionId, summary?.filePath, profileId, effectiveEpoch, summary?.revision, artifact.content?.revision, sourceOpen, t5.planArtifactOpenError]
  );

  if (kind === 'empty') return null;

  const showFileButtons = hasDoc && (kind === 'outline' || kind === 'execution');

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    // 折叠时同步关闭原文抽屉，避免折叠态残留幽灵 Esc
    if (!next) setSourceOpen(false);
  };
  const handleSourceToggle = () => {
    const next = !sourceOpen;
    if (next) setExpanded(true);
    setSourceOpen(next);
  };

  // --- header summary text ---
  let headerLabel: React.ReactNode;
  if (kind === 'execution') {
    headerLabel = (
      <>
        <span className="inline-plan-label truncate">{expanded ? t6.inlinePlanLabel : dict.planProgress(progress.done, progress.total)}</span>
        {!expanded && (
          <span className="plan-progressbar inline-plan-bar" aria-hidden="true">
            <span style={{ '--fill': progress.total ? progress.done / progress.total : 0 } as React.CSSProperties} />
          </span>
        )}
        {!expanded && progress.failed > 0 && (
          <span className="badge badge-danger inline-plan-fail">{t5.planFailedCount(progress.failed)}</span>
        )}
        {!expanded && progress.current && (
          <span className="inline-plan-now truncate">{t6.planNow(progress.current)}</span>
        )}
      </>
    );
  } else if (kind === 'outline') {
    headerLabel = (
      <>
        <span className="inline-plan-label truncate">{!expanded && outline?.title ? outline.title : t6.inlinePlanLabel}</span>
        {outline && outline.sectionCount > 0 && (
          <span className="badge inline-plan-sections">{t6.inlinePlanSectionsBadge(outline.sectionCount)}</span>
        )}
      </>
    );
  } else if (kind === 'cleared') {
    headerLabel = <span className="inline-plan-label truncate">{t6.planCleared}</span>;
  } else {
    headerLabel = <span className="inline-plan-label truncate">{t6.inlinePlanLabel}</span>;
  }

  return (
    <section
      ref={cardRef}
      className="inline-plan-card"
      data-testid="inline-plan-card"
      data-plan-view={kind}
      data-annotation-skip=""
      aria-label={t6.inlinePlanLabel}
    >
      {/* -- header bar -- */}
      <div className="inline-plan-head">
        <button
          type="button"
          className="inline-plan-toggle"
          onClick={handleToggle}
          aria-expanded={expanded}
          aria-controls={`${uid}-body`}
          data-testid="inline-plan-toggle"
        >
          <Icon icon={ChevronRight} size="xs" className={`inline-plan-chev${expanded ? ' is-open' : ''}`} />
          <Icon icon={ListTodo} size="sm" className="inline-plan-icon" />
          {headerLabel}
        </button>
        {showFileButtons && (
          <span className="inline-plan-actions">
            <button
              type="button"
              className="inline-plan-src-btn"
              onClick={handleSourceToggle}
              aria-expanded={sourceOpen}
              aria-controls={`${uid}-source`}
              data-testid={sourceOpen ? 'plan-source-close' : 'plan-source-open'}
            >
              <Icon icon={FileText} size="xs" />
              <span>{sourceOpen ? t6.inlinePlanHideSource : t6.inlinePlanViewSource}</span>
            </button>
            {sourceOpen && (
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                onClick={artifact.refresh}
                disabled={artifact.loadingContent || artifact.loadingSummary}
                aria-label={t5.planArtifactRefresh}
                title={t5.planArtifactRefresh}
                data-testid="plan-artifact-refresh"
              >
                <Icon icon={RefreshCw} size="xs" className={artifact.loadingContent ? 'spin' : undefined} />
              </button>
            )}
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
          </span>
        )}
      </div>

      {/* -- body -- */}
      {expanded && (
        <div className="inline-plan-body" id={`${uid}-body`}>
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

          {kind === 'cleared' && (
            <p className="plan-note" role="status" data-testid="plan-cleared">
              {t6.planCleared}
            </p>
          )}

          {kind === 'unavailable' && (
            <p className="plan-note" role="status" data-testid="plan-unavailable">
              {t6.planUnavailable(artifact.error || summary?.reason || '')}
            </p>
          )}

          {/* inline source drawer */}
          {sourceOpen && sessionId && hasDoc && (
            <div className="inline-plan-source" id={`${uid}-source`} data-testid="plan-source-drawer">
              <div className="inline-plan-source-sep" />
              {updated && <p className="plan-drawer-meta">{t6.planUpdated(updated)}</p>}
              {artifact.error ? (
                <p role="alert" className="plan-drawer-msg is-error">{t5.planArtifactUnavailable(artifact.error)}</p>
              ) : artifact.content?.content === undefined || artifact.content?.content === null ? (
                <p className="plan-drawer-msg">{t6.planLoadingSource}</p>
              ) : (
                <PlanDocument text={artifact.content.content} onOpenLink={openLink} idPrefix={uid} docRef={docRef} />
              )}
              {artifact.content?.truncated && <p className="plan-drawer-msg is-warn">{t5.planArtifactTruncated}</p>}
            </div>
          )}
        </div>
      )}

      {openError && (
        <p role="alert" className="plan-drawer-msg is-error">
          {openError}
        </p>
      )}
    </section>
  );
}

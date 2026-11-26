import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Eye,
  EyeOff,
  Folder,
  FolderKanban,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  normalizeProjectCompareKey,
  normalizeWorkspacePath,
  TITLE_ORGANIZE_MODEL_LABEL,
  TITLE_ORGANIZE_RATE_LIMIT,
  type AgentExecutionMode,
  type ManagedSessionSummary,
  type SessionAction,
  type TitleOrganizeRequest,
  type WorkspaceProjectConfig,
} from '@shared';
import { startSessionDrag } from '../lib/session-drag';
import { ResizeHandle } from './ResizeHandle';
import { useI18n } from '../i18n/I18nContext';
import { formatRelativeTime, stripIpcErrorPrefix } from '../i18n/locales';
import { Icon } from './ui/Icon';

export interface ProjectSidebarProps {
  collapsed: boolean;
  width: number;
  sessions: ManagedSessionSummary[];
  openTabSessionIds: string[];
  selectedSessionId: string | null;
  hideLegacyPollutionSessions: boolean;
  organizingTitles: boolean;
  /** 当前正在整理的目标标识（all / project:<cwd> / session:<id>） */
  organizingTarget?: string | null;
  /** 共享 1 分钟 4 次冷却剩余秒数（0 表示当前可用） */
  organizeCooldownSec?: number;
  /** 当前 1 分钟窗口剩余整理次数（默认 4） */
  organizeQuotaLeft?: number;
  projects?: WorkspaceProjectConfig[];
  /** D3：侧栏头折叠钮已移除（Rail 抽屉开关与 Ctrl+B 保留），保留可选签名兼容调用方 */
  onToggleCollapse?: () => void;
  onSelectSession: (session: ManagedSessionSummary) => void;
  /** D3：侧栏头重复「新建」已移除，保留可选签名兼容调用方 */
  onOpenNewSession?: () => void;
  onCreateSessionInProject?: (cwd: string, mode?: AgentExecutionMode) => void;
  onOrganizeTitles: (request?: TitleOrganizeRequest) => Promise<void>;
  onTogglePollutionVisibility: () => Promise<void>;
  onRenameSession: (sessionId: string, newTitle: string) => Promise<void>;
  onTogglePinSession: (sessionId: string) => Promise<void>;
  onManageSession?: (id: string, action: SessionAction) => Promise<void>;
  onCommitWidth?: (width: number) => void;
}

type RenameDraft = { sessionId: string; profileId: string; value: string; saving?: boolean };

const SIDEBAR_MIN = 200;
const SIDEBAR_DEFAULT = 264;

/** 常规屏幕最宽 440px；宽屏放宽到窗口的 30%，但不超过主进程允许的 600px。 */
function sidebarMax(): number {
  const viewport = typeof window !== 'undefined' ? window.innerWidth : 1280;
  return Math.max(440, Math.min(600, Math.round(viewport * 0.3)));
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path || '/';
}

/**
 * 可展开会话抽屉：紧贴左侧极窄图标轨，专注呈现按项目分组的会话树、搜索、归档与只读历史。
 * 支持拖拽右缘调宽、双击恢复默认，以及侧栏快捷键（Windows/Linux 为 Ctrl+B，macOS 为 ⌘B，界面文案统一经 useI18n().shortcut() 输出）折叠为 0px。
 */
const LIVE_STATUS_RANK: Record<ManagedSessionSummary['status'], number> = {
  closed: 0,
  idle: 1,
  streaming: 2,
  error: 3,
  waiting_question: 4,
  waiting_approval: 5,
};

function archivedFilter(q: string) {
  return (list: ManagedSessionSummary[]) => list.filter((s) => !q || (s.title + ' ' + s.cwd).toLowerCase().includes(q));
}

function ProjectSidebarImpl({
  collapsed,
  width,
  sessions,
  openTabSessionIds,
  selectedSessionId,
  hideLegacyPollutionSessions,
  organizingTitles,
  organizingTarget = null,
  organizeCooldownSec = 0,
  organizeQuotaLeft = TITLE_ORGANIZE_RATE_LIMIT.maxCalls,
  projects = [],
  onSelectSession,
  onCreateSessionInProject,
  onOrganizeTitles,
  onTogglePollutionVisibility,
  onRenameSession,
  onTogglePinSession,
  onManageSession,
  onCommitWidth,
}: ProjectSidebarProps): React.ReactElement {
  const { dict } = useI18n();
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const submittingRename = React.useRef<RenameDraft | null>(null);
  const [manage, setManage] = useState<ManagedSessionSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manageError, setManageError] = useState('');
  const dialog = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    if (manage) dialog.current?.showModal?.();
  }, [manage]);

  const [liveWidth, setLiveWidth] = useState(width || SIDEBAR_DEFAULT);
  React.useEffect(() => {
    if (width) setLiveWidth(width);
  }, [width]);

  function openActions(s: ManagedSessionSummary): void {
    setConfirmDelete(false);
    setManageError('');
    setManage(s);
  }

  async function applyAction(action: SessionAction): Promise<void> {
    if (!manage || !onManageSession || saving) return;
    setSaving(true);
    setManageError('');
    try {
      await onManageSession(manage.sessionId, action);
      setManage(null);
    } catch (error) {
      setManageError(stripIpcErrorPrefix(error));
    } finally {
      setSaving(false);
    }
  }

  const q = search.trim().toLowerCase();
  const archivedMatches = archivedFilter(q);

  // 将所有子分支折叠归属于主对话（rootSessionId），左侧栏只显示主对话并同步活跃分支状态。
  const { sessionById, treeMetaByRoot, selectedRootId, openRootSet, archivedPrimary } = useMemo(() => {
    const byId = new Map<string, ManagedSessionSummary>();
    const metaByRoot = new Map<
      string,
      { branchCount: number; activeBranch?: ManagedSessionSummary; latestUpdatedAt: string; liveStatus: ManagedSessionSummary['status'] }
    >();
    for (const s of sessions) byId.set(s.sessionId, s);
    for (const s of sessions) {
      const rootId = s.rootSessionId || s.sessionId;
      const entry = metaByRoot.get(rootId) || {
        branchCount: 0,
        activeBranch: undefined,
        latestUpdatedAt: s.updatedAt,
        liveStatus: s.status,
      };
      entry.branchCount += 1;
      if (s.updatedAt > entry.latestUpdatedAt) entry.latestUpdatedAt = s.updatedAt;
      // 主条目汇总整棵对话树最需要关注的状态：待审批 > 待回答 > 出错 > 运行中 > 空闲 > 未打开；子分支出错不再被隐藏。
      if (LIVE_STATUS_RANK[s.status] > LIVE_STATUS_RANK[entry.liveStatus]) {
        entry.liveStatus = s.status;
      }
      if (s.activeBranchId && byId.has(s.activeBranchId)) {
        entry.activeBranch = byId.get(s.activeBranchId);
      } else if (s.status !== 'closed' && !entry.activeBranch) {
        entry.activeBranch = s;
      }
      metaByRoot.set(rootId, entry);
    }
    const selRoot = selectedSessionId ? (byId.get(selectedSessionId)?.rootSessionId || selectedSessionId) : null;
    const openRoots = new Set(openTabSessionIds.map((id) => byId.get(id)?.rootSessionId || id));
    const archived = sessions.filter((s) => Boolean(s.archivedAt) && !s.parentBranchId);
    return {
      sessionById: byId,
      treeMetaByRoot: metaByRoot,
      selectedRootId: selRoot,
      openRootSet: openRoots,
      archivedPrimary: archived,
    };
  }, [openTabSessionIds, selectedSessionId, sessions]);

  const projectByPath = useMemo(() => {
    const map = new Map<string, WorkspaceProjectConfig>();
    for (const proj of projects) {
      const norm = normalizeWorkspacePath(proj.path || '');
      // PATH-01：Windows 路径忽略大小写、POSIX 保留大小写，避免大小写敏感卷上不同目录被合并。
      if (norm) map.set(normalizeProjectCompareKey(norm), proj);
    }
    return map;
  }, [projects]);

  const groups = useMemo(() => {
    const map = new Map<string, ManagedSessionSummary[]>();
    const canonicalKeyByLower = new Map<string, string>();

    for (const proj of projects) {
      const norm = normalizeWorkspacePath(proj.path || '');
      if (!norm) continue;
      if (q && !proj.name.toLowerCase().includes(q) && !norm.toLowerCase().includes(q)) continue;
      canonicalKeyByLower.set(normalizeProjectCompareKey(norm), norm);
      if (!map.has(norm)) map.set(norm, []);
    }

    for (const s of sessions) {
      if (s.archivedAt) continue;
      if (s.parentBranchId) continue;
      if (hideLegacyPollutionSessions && s.isLegacyApprovalPollution) continue;
      const rawKey = normalizeWorkspacePath(s.cwd || s.rawCwd || '');
      const compareKey = normalizeProjectCompareKey(rawKey);
      const matchedProj = projectByPath.get(compareKey);
      if (
        q &&
        !s.title.toLowerCase().includes(q) &&
        !s.cwd.toLowerCase().includes(q) &&
        !(matchedProj && matchedProj.name.toLowerCase().includes(q))
      ) {
        continue;
      }
      const key = canonicalKeyByLower.get(compareKey) ?? rawKey;
      canonicalKeyByLower.set(compareKey, key);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }

    const entries = Array.from(map.entries()).map(([key, list]) => {
      const timeOf = (s: ManagedSessionSummary) => treeMetaByRoot.get(s.sessionId)?.latestUpdatedAt || s.updatedAt;
      list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : timeOf(b).localeCompare(timeOf(a))));
      const proj = projectByPath.get(normalizeProjectCompareKey(key));
      return {
        key,
        list,
        project: proj,
        pinnedProject: Boolean(proj?.pinned),
        latest: list.reduce((acc, s) => {
          const ts = timeOf(s);
          return ts > acc ? ts : acc;
        }, ''),
      };
    });
    entries.sort((a, b) => {
      if (a.pinnedProject !== b.pinnedProject) return a.pinnedProject ? -1 : 1;
      return b.latest.localeCompare(a.latest);
    });
    return entries;
  }, [sessions, hideLegacyPollutionSessions, q, projects, projectByPath, treeMetaByRoot]);

  const totalThreads = groups.reduce((acc, g) => acc + g.list.length, 0);
  const organizeBlocked = organizingTitles || organizeCooldownSec > 0;
  const organizeAllTooltip = organizingTitles
    ? dict.ui.organizingWithModel(TITLE_ORGANIZE_MODEL_LABEL)
    : organizeCooldownSec > 0
      ? dict.ui.organizeCooldownBanner(organizeCooldownSec)
      : `${dict.ui.organizeAllTitle} · ${dict.ui.organizeWindowQuota(organizeQuotaLeft, TITLE_ORGANIZE_RATE_LIMIT.maxCalls)}`;

  function startRename(session: ManagedSessionSummary): void {
    setRenameDraft(current => current?.sessionId === session.sessionId && current.profileId === session.profileId
      ? current : { sessionId: session.sessionId, profileId: session.profileId, value: session.title });
  }

  async function commitRename(draft: RenameDraft): Promise<void> {
    if (draft.saving || submittingRename.current === draft) return;
    const trimmed = draft.value.trim();
    if (!trimmed) {
      setRenameDraft(current => current === draft ? null : current);
      return;
    }
    const savingDraft = { ...draft, saving: true };
    submittingRename.current = draft;
    setRenameDraft(current => current === draft ? savingDraft : current);
    try {
      await onRenameSession(draft.sessionId, trimmed);
      setRenameDraft(current => current === savingDraft ? null : current);
    } catch {
      // The application shows the error. Keep this draft available for correction or retry.
      setRenameDraft(current => current === savingDraft ? draft : current);
    } finally {
      if (submittingRename.current === draft) submittingRename.current = null;
    }
  }

  return (
    <aside
      className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}
      style={{ width: collapsed ? 0 : liveWidth }}
      data-testid="project-sidebar"
      aria-hidden={collapsed}
      // F-12：收起态整体 inert 且不挂载内部控件，避免键盘焦点落入不可见侧栏。
      inert={collapsed || undefined}
    >
      {!collapsed && (
      <div className="sidebar-inner">
        {manage && (
          <dialog
            ref={dialog}
            className="session-actions-dialog"
            aria-label={dict.ui.copy.manageConversation}
            onCancel={(e) => {
              e.preventDefault();
              if (!saving) setManage(null);
            }}
          >
            <h3>{manage.title}</h3>
            {confirmDelete ? (
              <p>
                {dict.ui.copy.permanentlyDeleteThisConversationAnd}
              </p>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={() => void applyAction(manage.archivedAt ? 'restore' : 'archive')}
              >
                {manage.archivedAt ? <Icon icon={ArchiveRestore} size="md" /> : <Icon icon={Archive} size="md" />}
                {manage.archivedAt
                  ? dict.ui.copy.restoreConversation
                  : dict.ui.copy.archiveConversation}
              </button>
            )}
            <button
              type="button"
              className="btn danger"
              disabled={saving}
              onClick={() => (confirmDelete ? void applyAction('delete') : setConfirmDelete(true))}
            >
              <Icon icon={Trash2} size="md" />
              {confirmDelete
                ? dict.ui.copy.permanentlyDelete
                : dict.ui.copy.deleteConversation}
            </button>
            <button type="button" className="btn" autoFocus disabled={saving} onClick={() => setManage(null)}>
              {dict.ui.copy.cancel}
            </button>
            {manageError && <p role="alert" className="sidebar-alert">{manageError}</p>}
          </dialog>
        )}

        <header className="sidebar-head">
          <span className="brand-name">Gravity</span>
          {totalThreads > 0 && <span className="drawer-count">{totalThreads}</span>}
          <span className="spacer" />
          <button
            type="button"
            className={`icon-btn icon-btn-sm ${organizingTarget === 'all' ? 'is-active' : ''}`}
            disabled={organizeBlocked}
            onClick={() => void onOrganizeTitles({ scope: 'all' })}
            title={organizeAllTooltip}
            aria-label={dict.organizeTitlesBtn}
            data-testid="btn-organize-titles"
          >
            <Icon icon={Sparkles} size="sm" className={organizingTarget === 'all' ? 'spin' : undefined} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={() => void onTogglePollutionVisibility()}
            title={hideLegacyPollutionSessions ? dict.hidePollutionSessions : dict.showPollutionSessions}
            aria-label={hideLegacyPollutionSessions ? dict.hidePollutionSessions : dict.showPollutionSessions}
            data-testid="btn-toggle-pollution"
          >
            {hideLegacyPollutionSessions ? <Icon icon={EyeOff} size="sm" /> : <Icon icon={Eye} size="sm" />}
          </button>
        </header>

        <div className="sidebar-actions">
          <div className="search-box">
            <Icon icon={Search} size="sm" className="search-icon" />
            <input
              className="input"
              placeholder={dict.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="sidebar-search-input"
            />
            {search && (
              <button
                type="button"
                className="icon-btn icon-btn-sm search-clear"
                onClick={() => setSearch('')}
                aria-label={dict.ui.clearSearch}
              >
                <Icon icon={X} size="xs" />
              </button>
            )}
          </div>
          {(organizingTitles || organizeCooldownSec > 0) && (
            <div
              className={`organize-status-pill ${organizingTitles ? 'is-running' : 'is-cooldown'}`}
              role="status"
              data-testid="organize-model-status"
            >
              <Icon icon={Sparkles} size="xs" className={organizingTitles ? 'spin' : undefined} />
              <span className="truncate">
                {organizingTitles
                  ? dict.ui.organizingWithModel(TITLE_ORGANIZE_MODEL_LABEL)
                  : dict.ui.organizeCooldownBanner(organizeCooldownSec)}
              </span>
            </div>
          )}
        </div>

        <div className="sidebar-scroll">
          {groups.length === 0 && (
            <div className="empty-state" style={{ padding: '24px 12px' }}>
              {q ? dict.emptySearch : dict.emptySessions}
            </div>
          )}

          {groups.map(({ key, list, project }) => {
            const isCollapsed = Boolean(collapsedGroups[key]);
            const groupLabel = project?.name || folderName(key);
            const groupTooltip = project?.description ? `${project.name}\n${key}\n${project.description}` : key;
            return (
              <div key={key} className="sidebar-group" data-testid={`cwd-group-${key}`}>
                <div className="group-head-row">
                  <button
                    type="button"
                    className={`group-head ${isCollapsed ? 'is-collapsed' : ''}`}
                    title={groupTooltip}
                    onClick={() => setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))}
                  >
                    <Icon icon={ChevronDown} size="xs" className="chev" />
                    {project ? (
                      <Icon icon={FolderKanban} size="sm" className="group-icon-project" />
                    ) : (
                      <Icon icon={Folder} size="sm" className="muted" />
                    )}
                    <span className="truncate">{groupLabel}</span>
                    <span className="group-count">{list.length}</span>
                  </button>
                  {list.length > 0 && (
                    <button
                      type="button"
                      className={`icon-btn icon-btn-sm group-quick-add group-organize-btn ${organizingTarget === `project:${key}` ? 'is-active' : ''}`}
                      disabled={organizeBlocked}
                      title={
                        organizingTitles
                          ? dict.ui.organizingWithModel(TITLE_ORGANIZE_MODEL_LABEL)
                          : organizeCooldownSec > 0
                            ? dict.ui.organizeCooldownBanner(organizeCooldownSec)
                            : dict.ui.organizeProjectTitle(groupLabel)
                      }
                      aria-label={dict.ui.organizeProjectTitle(groupLabel)}
                      onClick={() =>
                        void onOrganizeTitles({
                          scope: 'project',
                          projectCwd: key,
                          sessionIds: list.map((item) => item.sessionId),
                        })
                      }
                      data-testid={`organize-project-${key}`}
                    >
                      <Icon icon={Sparkles} size="xs" className={organizingTarget === `project:${key}` ? 'spin' : undefined} />
                    </button>
                  )}
                  {onCreateSessionInProject && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm group-quick-add"
                      title={dict.ui.copy.fmtNewThreadIn(groupLabel)}
                      aria-label={dict.ui.copy.fmtNewThreadIn(groupLabel)}
                      onClick={() => onCreateSessionInProject(key, project?.defaultMode)}
                      data-testid={`quick-new-in-group-${key}`}
                    >
                      <Icon icon={Plus} size="xs" />
                    </button>
                  )}
                </div>

                {!isCollapsed &&
                  list.map((s) => {
                    const meta = treeMetaByRoot.get(s.sessionId);
                    const branchCount = Math.max(s.branchCount || 1, meta?.branchCount || 1);
                    const liveStatus = meta?.liveStatus || s.status;
                    const displayUpdatedAt = meta?.latestUpdatedAt || s.updatedAt;
                    const activeTarget =
                      (s.activeBranchId && sessionById.get(s.activeBranchId)) ||
                      meta?.activeBranch ||
                      s;
                    const selected = selectedRootId === s.sessionId;
                    const editing = renameDraft?.sessionId === s.sessionId && renameDraft.profileId === s.profileId ? renameDraft : null;
                    return (
                      <div
                        key={s.sessionId}
                        className={[
                          'thread-item',
                          selected ? 'is-selected' : '',
                          openRootSet.has(s.sessionId) && liveStatus !== 'closed' ? 'is-open' : '',
                          s.isLegacyApprovalPollution ? 'is-dim' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => {
                          if (!editing) onSelectSession(activeTarget);
                        }}
                        role="group"
                        draggable={!editing}
                        onDragStart={(e) => startSessionDrag(e.dataTransfer, activeTarget.sessionId)}
                        tabIndex={0}
                        aria-label={s.title}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.target === e.currentTarget && !editing) {
                            e.preventDefault();
                            onSelectSession(activeTarget);
                          }
                        }}
                        title={s.title}
                        data-testid={`sidebar-session-${s.sessionId}`}
                      >
                        {liveStatus === 'streaming' || liveStatus === 'waiting_approval' || liveStatus === 'waiting_question' || liveStatus === 'error' ? (
                          <span className={`status-dot is-${liveStatus}`} />
                        ) : null}
                        <div className="thread-main">
                          {editing ? (
                            <input
                              autoFocus
                              className="input thread-rename"
                              value={editing.value}
                              maxLength={200}
                              readOnly={editing.saving}
                              onChange={(e) => setRenameDraft({ ...editing, value: e.target.value })}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => void commitRename(editing)}
                              onKeyDown={(e) => {
                                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void commitRename(editing);
                                } else if (e.key === 'Escape') {
                                  setRenameDraft(null);
                                }
                              }}
                              data-testid={`rename-input-${s.sessionId}`}
                            />
                          ) : (
                            <span
                              className="thread-title truncate"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startRename(s);
                              }}
                            >
                              {s.title}
                            </span>
                          )}
                          {s.isLegacyApprovalPollution && !editing && (
                            <span className="thread-meta">
                              <span className="badge badge-warning">{dict.pollutionBadge}</span>
                            </span>
                          )}
                        </div>
                        {branchCount > 1 && !editing && (
                          <span
                            className="thread-branch-pill"
                            title={dict.ui.copy.fmtConversationBranches(branchCount)}
                            data-testid={`sidebar-branch-count-${s.sessionId}`}
                          >
                            <Icon icon={GitBranch} size="xs" />
                            <span>{branchCount}</span>
                          </span>
                        )}
                        {s.pinned && !editing && <Icon icon={Pin} size="xs" className="thread-pin" />}
                        {!editing && <span className="thread-time">{formatRelativeTime(displayUpdatedAt, dict)}</span>}
                        {!editing && (
                          <div className="thread-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className={`icon-btn icon-btn-sm ${organizingTarget === `session:${s.sessionId}` ? 'is-active' : ''}`}
                              disabled={organizeBlocked}
                              title={
                                organizingTitles
                                  ? dict.ui.organizingWithModel(TITLE_ORGANIZE_MODEL_LABEL)
                                  : organizeCooldownSec > 0
                                    ? dict.ui.organizeCooldownBanner(organizeCooldownSec)
                                    : dict.ui.organizeSessionTitle
                              }
                              aria-label={dict.ui.organizeSessionTitle}
                              onClick={() =>
                                void onOrganizeTitles({
                                  scope: 'session',
                                  sessionIds: [s.sessionId],
                                })
                              }
                              data-testid={`organize-session-${s.sessionId}`}
                            >
                              <Icon icon={Sparkles} size="xs" className={organizingTarget === `session:${s.sessionId}` ? 'spin' : undefined} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn icon-btn-sm"
                              title={dict.renameSession}
                              aria-label={dict.renameSession}
                              onClick={() => {
                                startRename(s);
                              }}
                              data-testid={`rename-btn-${s.sessionId}`}
                            >
                              <Icon icon={Pencil} size="sm" />
                            </button>
                            <button
                              type="button"
                              className={`icon-btn icon-btn-sm ${s.pinned ? 'is-active' : ''}`}
                              title={s.pinned ? dict.unpinSession : dict.pinSession}
                              aria-label={s.pinned ? dict.unpinSession : dict.pinSession}
                              onClick={() => void onTogglePinSession(s.sessionId)}
                              data-testid={`pin-btn-${s.sessionId}`}
                            >
                              <Icon icon={Pin} size="xs" />
                            </button>
                            {onManageSession && (
                              <button
                                type="button"
                                className="icon-btn icon-btn-sm"
                                title={dict.ui.copy.manageConversation}
                                aria-label={dict.ui.copy.manageConversation}
                                data-testid={'manage-session-' + s.sessionId}
                                onClick={() => openActions(s)}
                              >
                                <Icon icon={MoreHorizontal} size="sm" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}

          {archivedPrimary.length > 0 && (
            <details className="archived-sessions" data-testid="archived-sessions">
              <summary>
                <Icon icon={Archive} size="xs" /> {dict.ui.copy.archived} · {dict.ui.v031.archiveMatches(archivedMatches(archivedPrimary).length, archivedPrimary.length)}
              </summary>
              {archivedMatches(archivedPrimary)
                .map((s) => (
                  <button
                    type="button"
                    key={s.sessionId}
                    onClick={() => openActions(s)}
                    data-testid={'archived-session-' + s.sessionId}
                  >
                    <span className="truncate">{s.title}</span>
                    <Icon icon={MoreHorizontal} size="sm" />
                  </button>
                ))}
            </details>
          )}
        </div>
      </div>
      )}

      {!collapsed && onCommitWidth && (
        <ResizeHandle
          value={liveWidth}
          min={SIDEBAR_MIN}
          max={sidebarMax}
          defaultValue={SIDEBAR_DEFAULT}
          label={dict.ui.resizeSidebar}
          className="edge-right"
          testId="sidebar-resize-handle"
          onPreview={setLiveWidth}
          onCommit={(w) => onCommitWidth(Math.round(w))}
        />
      )}
    </aside>
  );
}

/** F-08：浅比较 props，流式分片不改变会话摘要与选中项时跳过侧栏提交。 */
export const ProjectSidebar = React.memo(ProjectSidebarImpl);

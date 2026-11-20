import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  ChevronDown,
  Eye,
  EyeOff,
  Folder,
  FolderKanban,
  GitBranch,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  isLegacyPollutionSessionTitle,
  normalizeWorkspacePath,
  TITLE_ORGANIZE_MODEL_LABEL,
  TITLE_ORGANIZE_RATE_LIMIT,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type ClientLocale,
  type GravityIconId,
  type ImportedHistorySessionRecord,
  type ManagedSessionSummary,
  type SessionAction,
  type TitleOrganizeRequest,
  type WorkspaceProjectConfig,
} from '@shared';
import { startSessionDrag } from '../lib/session-drag';
import { ResizeHandle } from './ResizeHandle';
import { useI18n } from '../i18n/I18nContext';
import { formatRelativeTime } from '../i18n/locales';

export interface ProjectSidebarProps {
  collapsed: boolean;
  width: number;
  appIcon?: GravityIconId;
  connection?: AcpConnectionStatus;
  accounts?: AccountsStateSnapshot;
  sessions: ManagedSessionSummary[];
  importedHistory: ImportedHistorySessionRecord[];
  openTabSessionIds: string[];
  selectedSessionId: string | null;
  selectedHistoryId: string | null;
  hideLegacyPollutionSessions: boolean;
  organizingTitles: boolean;
  /** 当前正在整理的目标标识（all / project:<cwd> / session:<id>） */
  organizingTarget?: string | null;
  /** 共享 1 分钟 4 次冷却剩余秒数（0 表示当前可用） */
  organizeCooldownSec?: number;
  /** 当前 1 分钟窗口剩余整理次数（默认 4） */
  organizeQuotaLeft?: number;
  pluginCount?: number;
  projects?: WorkspaceProjectConfig[];
  onToggleCollapse: () => void;
  onSelectSession: (session: ManagedSessionSummary) => void;
  onSelectHistory: (record: ImportedHistorySessionRecord) => void;
  onRefreshHistory?: () => Promise<void>;
  onOpenNewSession: () => void;
  onCreateSessionInProject?: (cwd: string, mode?: AgentExecutionMode) => void;
  onOpenProjects?: () => void;
  onOrganizeTitles: (request?: TitleOrganizeRequest) => Promise<void>;
  onTogglePollutionVisibility: () => Promise<void>;
  onRenameSession: (sessionId: string, newTitle: string) => Promise<void>;
  onTogglePinSession: (sessionId: string) => Promise<void>;
  onManageSession?: (id: string, action: SessionAction) => Promise<void>;
  onOpenAccounts?: () => void;
  onOpenPlugins?: () => void;
  onOpenSettings?: () => void;
  onChangeLocale?: (locale: ClientLocale) => void;
  onCommitWidth?: (width: number) => void;
}

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
 * 支持拖拽右缘调宽、双击恢复默认，以及 Ctrl+B 折叠为 0px。
 */
export function ProjectSidebar({
  collapsed,
  width,
  sessions,
  importedHistory,
  openTabSessionIds,
  selectedSessionId,
  selectedHistoryId,
  hideLegacyPollutionSessions,
  organizingTitles,
  organizingTarget = null,
  organizeCooldownSec = 0,
  organizeQuotaLeft = TITLE_ORGANIZE_RATE_LIMIT.maxCalls,
  projects = [],
  onToggleCollapse,
  onSelectSession,
  onSelectHistory,
  onRefreshHistory,
  onOpenNewSession,
  onCreateSessionInProject,
  onOrganizeTitles,
  onTogglePollutionVisibility,
  onRenameSession,
  onTogglePinSession,
  onManageSession,
  onCommitWidth,
}: ProjectSidebarProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const zh = locale === 'zh-CN';
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(40);
  const [syncingHistory, setSyncingHistory] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
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
      setManageError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const q = search.trim().toLowerCase();

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
      if (s.status === 'waiting_approval' || (s.status === 'streaming' && entry.liveStatus !== 'waiting_approval')) {
        entry.liveStatus = s.status;
      } else if (s.status !== 'closed' && entry.liveStatus === 'closed') {
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
      if (norm) map.set(norm.toLowerCase(), proj);
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
      const lower = norm.toLowerCase();
      canonicalKeyByLower.set(lower, norm);
      if (!map.has(norm)) map.set(norm, []);
    }

    for (const s of sessions) {
      if (s.archivedAt) continue;
      if (s.parentBranchId) continue;
      if (hideLegacyPollutionSessions && s.isLegacyApprovalPollution) continue;
      const rawKey = normalizeWorkspacePath(s.cwd || s.rawCwd || '');
      const matchedProj = projectByPath.get(rawKey.toLowerCase());
      if (
        q &&
        !s.title.toLowerCase().includes(q) &&
        !s.cwd.toLowerCase().includes(q) &&
        !(matchedProj && matchedProj.name.toLowerCase().includes(q))
      ) {
        continue;
      }
      const key = canonicalKeyByLower.get(rawKey.toLowerCase()) ?? rawKey;
      canonicalKeyByLower.set(rawKey.toLowerCase(), key);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }

    const entries = Array.from(map.entries()).map(([key, list]) => {
      const timeOf = (s: ManagedSessionSummary) => treeMetaByRoot.get(s.sessionId)?.latestUpdatedAt || s.updatedAt;
      list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : timeOf(b).localeCompare(timeOf(a))));
      const proj = projectByPath.get(key.toLowerCase());
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

  const history = useMemo(() => {
    const liveIds = new Set(sessions.map((s) => s.sessionId));
    const byConvId = new Map<string, ImportedHistorySessionRecord>();
    for (const rec of importedHistory) {
      if (liveIds.has(rec.rawConversationId)) continue;
      if (
        hideLegacyPollutionSessions &&
        (isLegacyPollutionSessionTitle(rec.title) || isLegacyPollutionSessionTitle(rec.summarySnippet))
      ) {
        continue;
      }
      const key = rec.rawConversationId || rec.sessionId;
      const existing = byConvId.get(key);
      if (!existing) {
        byConvId.set(key, rec);
        continue;
      }
      const recIsJsonl = /\.jsonl$/i.test(rec.sourcePath);
      const existingIsJsonl = /\.jsonl$/i.test(existing.sourcePath);
      if (recIsJsonl && !existingIsJsonl) {
        byConvId.set(key, {
          ...rec,
          title: existing.title && existing.title !== '导入的历史会话' ? existing.title : rec.title,
          cwd: rec.cwd || existing.cwd,
        });
      } else if (!recIsJsonl && existingIsJsonl) {
        byConvId.set(key, {
          ...existing,
          title: rec.title && rec.title !== '导入的历史会话' ? rec.title : existing.title,
          cwd: existing.cwd || rec.cwd,
        });
      } else if (rec.messageCount > existing.messageCount) {
        byConvId.set(key, rec);
      }
    }
    const deduped = Array.from(byConvId.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return q
      ? deduped.filter(
          (h) =>
            h.title.toLowerCase().includes(q) ||
            h.cwd.toLowerCase().includes(q) ||
            h.summarySnippet.toLowerCase().includes(q)
        )
      : deduped;
  }, [hideLegacyPollutionSessions, importedHistory, q, sessions]);

  const visibleHistory = q ? history.slice(0, 100) : history.slice(0, historyLimit);
  const totalThreads = groups.reduce((acc, g) => acc + g.list.length, 0);
  const organizeBlocked = organizingTitles || organizeCooldownSec > 0;
  const organizeAllTooltip = organizingTitles
    ? dict.ui.organizingWithModel(TITLE_ORGANIZE_MODEL_LABEL)
    : organizeCooldownSec > 0
      ? dict.ui.organizeCooldownBanner(organizeCooldownSec)
      : `${dict.ui.organizeAllTitle} · ${dict.ui.organizeWindowQuota(organizeQuotaLeft, TITLE_ORGANIZE_RATE_LIMIT.maxCalls)}`;

  async function commitRename(sessionId: string): Promise<void> {
    const trimmed = editingValue.trim();
    setEditingId(null);
    if (trimmed) await onRenameSession(sessionId, trimmed);
  }

  return (
    <aside
      className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}
      style={{ width: collapsed ? 0 : liveWidth }}
      data-testid="project-sidebar"
      aria-hidden={collapsed}
    >
      <div className="sidebar-inner">
        {manage && (
          <dialog
            ref={dialog}
            className="session-actions-dialog"
            aria-label={zh ? '管理会话' : 'Manage conversation'}
            onCancel={(e) => {
              e.preventDefault();
              if (!saving) setManage(null);
            }}
          >
            <h3>{manage.title}</h3>
            {confirmDelete ? (
              <p>
                {zh
                  ? '永久删除 Gravity 中保存的这条会话及消息？此操作无法撤销。'
                  : 'Permanently delete this conversation and its messages from Gravity? This cannot be undone.'}
              </p>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={() => void applyAction(manage.archivedAt ? 'restore' : 'archive')}
              >
                {manage.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                {manage.archivedAt
                  ? zh
                    ? '恢复会话'
                    : 'Restore conversation'
                  : zh
                    ? '归档会话'
                    : 'Archive conversation'}
              </button>
            )}
            <button
              type="button"
              className="btn danger"
              disabled={saving}
              onClick={() => (confirmDelete ? void applyAction('delete') : setConfirmDelete(true))}
            >
              <Trash2 size={15} />
              {confirmDelete
                ? zh
                  ? '确认永久删除'
                  : 'Permanently delete'
                : zh
                  ? '删除会话'
                  : 'Delete conversation'}
            </button>
            <button type="button" className="btn" autoFocus disabled={saving} onClick={() => setManage(null)}>
              {zh ? '取消' : 'Cancel'}
            </button>
            {manageError && <p role="alert">{manageError}</p>}
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
            <Sparkles size={13} className={organizingTarget === 'all' ? 'spin' : undefined} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={() => void onTogglePollutionVisibility()}
            title={hideLegacyPollutionSessions ? dict.hidePollutionSessions : dict.showPollutionSessions}
            aria-label={hideLegacyPollutionSessions ? dict.hidePollutionSessions : dict.showPollutionSessions}
            data-testid="btn-toggle-pollution"
          >
            {hideLegacyPollutionSessions ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={onOpenNewSession}
            title={`${dict.newSession} (Ctrl+N)`}
            aria-label={dict.newSession}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={onToggleCollapse}
            title={dict.sidebarToggleHide}
            aria-label={dict.sidebarToggleHide}
          >
            <PanelLeftClose size={14} />
          </button>
        </header>

        <div className="sidebar-actions">
          <div className="search-box">
            <Search size={13} className="search-icon" />
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
                <X size={12} />
              </button>
            )}
          </div>
          {(organizingTitles || organizeCooldownSec > 0) && (
            <div
              className={`organize-status-pill ${organizingTitles ? 'is-running' : 'is-cooldown'}`}
              role="status"
              data-testid="organize-model-status"
            >
              <Sparkles size={11} className={organizingTitles ? 'spin' : undefined} />
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
                    <ChevronDown size={12} className="chev" />
                    {project ? (
                      <FolderKanban size={13} className="group-icon-project" />
                    ) : (
                      <Folder size={13} className="muted" />
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
                      <Sparkles size={11} className={organizingTarget === `project:${key}` ? 'spin' : undefined} />
                    </button>
                  )}
                  {onCreateSessionInProject && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm group-quick-add"
                      title={zh ? `在「${groupLabel}」中新建会话` : `New thread in ${groupLabel}`}
                      onClick={() => onCreateSessionInProject(key, project?.defaultMode)}
                      data-testid={`quick-new-in-group-${key}`}
                    >
                      <Plus size={12} />
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
                    const selected = !selectedHistoryId && selectedRootId === s.sessionId;
                    const editing = editingId === s.sessionId;
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
                        {liveStatus === 'streaming' || liveStatus === 'waiting_approval' || liveStatus === 'error' ? (
                          <span className={`status-dot is-${liveStatus}`} />
                        ) : null}
                        <div className="thread-main">
                          {editing ? (
                            <input
                              autoFocus
                              className="input thread-rename"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => void commitRename(s.sessionId)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void commitRename(s.sessionId);
                                } else if (e.key === 'Escape') {
                                  setEditingId(null);
                                }
                              }}
                              data-testid={`rename-input-${s.sessionId}`}
                            />
                          ) : (
                            <span
                              className="thread-title truncate"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setEditingId(s.sessionId);
                                setEditingValue(s.title);
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
                            title={zh ? `包含 ${branchCount} 个对话分支` : `${branchCount} conversation branches`}
                            data-testid={`sidebar-branch-count-${s.sessionId}`}
                          >
                            <GitBranch size={10} />
                            <span>{branchCount}</span>
                          </span>
                        )}
                        {s.pinned && !editing && <Pin size={11} className="thread-pin" />}
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
                              <Sparkles size={11} className={organizingTarget === `session:${s.sessionId}` ? 'spin' : undefined} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn icon-btn-sm"
                              title={dict.renameSession}
                              aria-label={dict.renameSession}
                              onClick={() => {
                                setEditingId(s.sessionId);
                                setEditingValue(s.title);
                              }}
                              data-testid={`rename-btn-${s.sessionId}`}
                            >
                              <Pencil size={11} />
                            </button>
                            <button
                              type="button"
                              className={`icon-btn icon-btn-sm ${s.pinned ? 'is-active' : ''}`}
                              title={s.pinned ? dict.unpinSession : dict.pinSession}
                              aria-label={s.pinned ? dict.unpinSession : dict.pinSession}
                              onClick={() => void onTogglePinSession(s.sessionId)}
                              data-testid={`pin-btn-${s.sessionId}`}
                            >
                              <Pin size={11} />
                            </button>
                            {onManageSession && (
                              <button
                                type="button"
                                className="icon-btn icon-btn-sm"
                                title={zh ? '管理会话' : 'Manage conversation'}
                                aria-label={zh ? '管理会话' : 'Manage conversation'}
                                data-testid={'manage-session-' + s.sessionId}
                                onClick={() => openActions(s)}
                              >
                                <MoreHorizontal size={14} />
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
                <Archive size={12} /> {zh ? '已归档' : 'Archived'} · {archivedPrimary.length}
              </summary>
              {archivedPrimary
                .filter((s) => !q || (s.title + ' ' + s.cwd).toLowerCase().includes(q))
                .map((s) => (
                  <button
                    type="button"
                    key={s.sessionId}
                    onClick={() => openActions(s)}
                    data-testid={'archived-session-' + s.sessionId}
                  >
                    <span className="truncate">{s.title}</span>
                    <MoreHorizontal size={13} />
                  </button>
                ))}
            </details>
          )}

          {history.length > 0 && (
            <div className="sidebar-history" data-testid="imported-history-section">
              <div className="section-head">
                <span>{dict.historySectionTitle}</span>
                <span className="spacer" />
                {onRefreshHistory && (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    disabled={syncingHistory}
                    onClick={() => {
                      setSyncingHistory(true);
                      void onRefreshHistory().finally(() => setSyncingHistory(false));
                    }}
                    title={zh ? '同步本地 Antigravity 历史记录' : 'Sync local Antigravity history'}
                    aria-label={zh ? '同步本地 Antigravity 历史记录' : 'Sync local Antigravity history'}
                    data-testid="btn-sync-history"
                  >
                    <RefreshCw size={12} className={syncingHistory ? 'spin' : undefined} />
                  </button>
                )}
              </div>
              <button
                type="button"
                className={`group-head ${historyCollapsed ? 'is-collapsed' : ''}`}
                onClick={() => setHistoryCollapsed((prev) => !prev)}
              >
                <ChevronDown size={12} className="chev" />
                <BookOpen size={13} className="muted" />
                <span className="truncate">{dict.readOnlyBadge}</span>
                <span className="group-count">{history.length}</span>
              </button>
              {!historyCollapsed &&
                visibleHistory.map((rec) => (
                  <div
                    key={rec.sessionId}
                    draggable
                    onDragStart={(e) => startSessionDrag(e.dataTransfer, rec.sessionId)}
                    className={`thread-item ${selectedHistoryId === rec.sessionId ? 'is-selected' : ''}`}
                    onClick={() => onSelectHistory(rec)}
                    title={rec.cwd ? `${rec.title}\n${rec.cwd}` : rec.title}
                    data-testid={`history-item-${rec.sessionId}`}
                  >
                    <div className="thread-main">
                      <span className="thread-title truncate">{rec.title}</span>
                    </div>
                    <span className="thread-time">{formatRelativeTime(rec.updatedAt, dict)}</span>
                  </div>
                ))}
              {!historyCollapsed && !q && history.length > historyLimit && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', marginTop: 4, justifyContent: 'center' }}
                  onClick={() => setHistoryLimit((prev) => prev + 60)}
                  data-testid="btn-load-more-history"
                >
                  {zh
                    ? `加载更多（剩余 ${history.length - historyLimit} 条）`
                    : `Load more (${history.length - historyLimit} left)`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

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

import React, { useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, MoreHorizontal, Trash2,
  BookOpen,
  Blocks,
  ChevronDown,
  Eye,
  EyeOff,
  Folder,
  FolderKanban,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import {
  isLegacyPollutionSessionTitle,
  normalizeWorkspacePath,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type ClientLocale,
  type GravityIconId,
  type ImportedHistorySessionRecord,
  type ManagedSessionSummary,
  type SessionAction,
  type WorkspaceProjectConfig,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatRelativeTime } from '../i18n/locales';
import { resolveGravityIconVariant } from '../styles/theme';

export interface ProjectSidebarProps {
  collapsed: boolean;
  width: number;
  appIcon: GravityIconId;
  connection: AcpConnectionStatus;
  accounts: AccountsStateSnapshot;
  sessions: ManagedSessionSummary[];
  importedHistory: ImportedHistorySessionRecord[];
  openTabSessionIds: string[];
  selectedSessionId: string | null;
  selectedHistoryId: string | null;
  hideLegacyPollutionSessions: boolean;
  organizingTitles: boolean;
  pluginCount: number;
  projects?: WorkspaceProjectConfig[];
  onToggleCollapse: () => void;
  onSelectSession: (session: ManagedSessionSummary) => void;
  onSelectHistory: (record: ImportedHistorySessionRecord) => void;
  onRefreshHistory?: () => Promise<void>;
  onOpenNewSession: () => void;
  onCreateSessionInProject?: (cwd: string, mode?: AgentExecutionMode) => void;
  onOpenProjects?: () => void;
  onOrganizeTitles: () => Promise<void>;
  onTogglePollutionVisibility: () => Promise<void>;
  onRenameSession: (sessionId: string, newTitle: string) => Promise<void>;
  onTogglePinSession: (sessionId: string) => Promise<void>;
  onManageSession?: (id: string, action: SessionAction) => Promise<void>;
  onOpenAccounts: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onChangeLocale: (locale: ClientLocale) => void;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path || '/';
}

export function ProjectSidebar({
  collapsed,
  width,
  appIcon,
  connection,
  accounts,
  sessions,
  importedHistory,
  openTabSessionIds,
  selectedSessionId,
  selectedHistoryId,
  hideLegacyPollutionSessions,
  organizingTitles,
  pluginCount,
  projects = [],
  onToggleCollapse,
  onSelectSession,
  onSelectHistory,
  onRefreshHistory,
  onOpenNewSession,
  onCreateSessionInProject,
  onOpenProjects,
  onOrganizeTitles,
  onTogglePollutionVisibility,
  onRenameSession,
  onTogglePinSession,
  onManageSession,
  onOpenAccounts,
  onOpenPlugins,
  onOpenSettings,
  onChangeLocale,
}: ProjectSidebarProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(40);
  const [syncingHistory, setSyncingHistory] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const zh = locale === 'zh-CN';
  const [manage, setManage] = useState<ManagedSessionSummary | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manageError, setManageError] = useState('');
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => { if (manage) dialog.current?.showModal?.(); }, [manage]);
  function openActions(s: ManagedSessionSummary) {
    setConfirmDelete(false); setManageError(''); setManage(s);
  }
  async function applyAction(action: SessionAction) {
    if (!manage || !onManageSession || saving) return;
    setSaving(true); setManageError('');
    try { await onManageSession(manage.sessionId, action); setManage(null); }
    catch (error) { setManageError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  const icon = resolveGravityIconVariant(appIcon);
  const q = search.trim().toLowerCase();
  const openSet = new Set(openTabSessionIds);

  // 按规范化、小写路径建立项目索引。会话中的大小写或分隔符不同，仍可关联到用户保存的项目名称。
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

    // 先把用户已配置的自定义 Project 注册到分组树中（即使尚无对话也在侧栏常驻显示）
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
    // 这里有两级独立排序。项目内的会话按置顶和更新时间排序，项目之间按项目置顶和最新会话时间排序。
    const entries = Array.from(map.entries()).map(([key, list]) => {
      list.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt)));
      const proj = projectByPath.get(key.toLowerCase());
      return {
        key,
        list,
        project: proj,
        pinnedProject: Boolean(proj?.pinned),
        latest: list.reduce((acc, s) => (s.updatedAt > acc ? s.updatedAt : acc), ''),
      };
    });
    entries.sort((a, b) => {
      if (a.pinnedProject !== b.pinnedProject) return a.pinnedProject ? -1 : 1;
      return b.latest.localeCompare(a.latest);
    });
    return entries;
  }, [sessions, hideLegacyPollutionSessions, q, projects, projectByPath]);

  const history = useMemo(() => {
    // 先移除已在实时会话列表中的原始 ID，再合并不同来源的历史摘要，避免侧栏为同一会话展示两个入口。
    const liveIds = new Set(sessions.map((s) => s.sessionId));
    // 按 rawConversationId 去重：同一会话优先保留带完整对话内容的 .jsonl 记录，其次保留 .db 摘要记录
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

  // 搜索时可显示前 100 个匹配项。无搜索词时受逐批展开的显示上限控制，完整索引仍可用于下次搜索。
  const visibleHistory = q ? history.slice(0, 100) : history.slice(0, historyLimit);

  const activeProfile =
    accounts.profiles.find((p) => p.profileId === accounts.activeProfileId) ?? accounts.profiles[0];
  const profileName = activeProfile?.name ?? 'Default';

  async function commitRename(sessionId: string): Promise<void> {
    const trimmed = editingValue.trim();
    setEditingId(null);
    if (trimmed) await onRenameSession(sessionId, trimmed);
  }

  return (
    <aside
      className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}
      style={{ width: collapsed ? 0 : width || 268 }}
      data-testid="project-sidebar"
      aria-hidden={collapsed}
    >
      <div className="sidebar-inner">
        {manage && <dialog ref={dialog} className="session-actions-dialog" aria-label={zh ? '管理会话' : 'Manage conversation'}
          onCancel={e => { e.preventDefault(); if (!saving) setManage(null); }}>
          <h3>{manage.title}</h3>
          {confirmDelete ? <p>{zh ? '永久删除 Gravity 中保存的这条会话及消息？此操作无法撤销。' : 'Permanently delete this conversation and its messages from Gravity? This cannot be undone.'}</p>
            : <button type="button" className="btn" disabled={saving} onClick={() => void applyAction(manage.archivedAt ? 'restore' : 'archive')}>
               {manage.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
               {manage.archivedAt ? (zh ? '恢复会话' : 'Restore conversation') : (zh ? '归档会话' : 'Archive conversation')}</button>}
          <button type="button" className="btn danger" disabled={saving} onClick={() => confirmDelete ? void applyAction('delete') : setConfirmDelete(true)}>
            <Trash2 size={15} />{confirmDelete ? (zh ? '确认永久删除' : 'Permanently delete') : (zh ? '删除会话' : 'Delete conversation')}</button>
          <button type="button" className="btn" autoFocus disabled={saving} onClick={() => setManage(null)}>{zh ? '取消' : 'Cancel'}</button>
          {manageError && <p role="alert">{manageError}</p>}
        </dialog>}
        <div className="sidebar-head">
          <img src={icon.publicSvgUrl} alt="Gravity" className="brand-logo" data-testid="topbar-app-icon" />
          <span className="brand-name">Gravity</span>
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleCollapse}
            title={dict.sidebarToggleHide}
            aria-label={dict.sidebarToggleHide}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>

        <div className="sidebar-actions">
          <button type="button" className="new-thread-btn" onClick={onOpenNewSession} data-testid="sidebar-new-session-btn">
            <Plus size={15} />
            <span>{dict.newSession}</span>
            <span className="kbd">Ctrl N</span>
          </button>
          <div className="search-box">
            <Search size={13} />
            <input
              className="input"
              placeholder={dict.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="sidebar-search-input"
            />
          </div>
        </div>

        <nav className="nav-list">
          {onOpenProjects && (
            <button type="button" className="nav-item" onClick={onOpenProjects} data-testid="open-projects-modal-btn">
              <FolderKanban size={15} />
              <span>{locale === 'zh-CN' ? '项目与目录' : 'Projects'}</span>
              {projects.length > 0 && <span className="badge">{projects.length}</span>}
            </button>
          )}
          <button type="button" className="nav-item" onClick={onOpenPlugins} data-testid="open-plugins-modal-btn">
            <Blocks size={15} />
            <span>{dict.navPlugins}</span>
            {pluginCount > 0 && <span className="badge">{pluginCount}</span>}
          </button>
        </nav>

        <div className="sidebar-scroll">
          <div className="section-head">
            <span>{dict.navThreads}</span>
            <span className="spacer" />
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              disabled={organizingTitles}
              onClick={() => void onOrganizeTitles()}
              title={organizingTitles ? dict.organizingTitles : dict.organizeTitlesBtn}
              aria-label={dict.organizeTitlesBtn}
              data-testid="btn-organize-titles"
            >
              <Sparkles size={13} />
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
          </div>

          {groups.length === 0 && (
            <div className="empty-state" style={{ padding: '16px 10px' }}>
              {q ? dict.emptySearch : dict.emptySessions}
            </div>
          )}

          {groups.map(({ key, list, project }) => {
            const isCollapsed = Boolean(collapsedGroups[key]);
            const groupLabel = project?.name || folderName(key);
            const groupTooltip = project?.description ? `${project.name}\n${key}\n${project.description}` : key;
            return (
              <div key={key} data-testid={`cwd-group-${key}`}>
                <div className="group-head-row">
                  <button
                    type="button"
                    className={`group-head ${isCollapsed ? 'is-collapsed' : ''}`}
                    title={groupTooltip}
                    onClick={() => setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))}
                  >
                    <ChevronDown size={12} className="chev" />
                    {project ? (
                      <FolderKanban size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                    ) : (
                      <Folder size={13} className="muted" />
                    )}
                    <span className="truncate">{groupLabel}</span>
                    <span className="group-count">{list.length}</span>
                  </button>
                  {onCreateSessionInProject && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm group-quick-add"
                      title={locale === 'zh-CN' ? `在「${groupLabel}」中新建会话` : `New thread in ${groupLabel}`}
                      onClick={() => onCreateSessionInProject(key, project?.defaultMode)}
                      data-testid={`quick-new-in-group-${key}`}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>

                {!isCollapsed &&
                  list.map((s) => {
                    const selected = !selectedHistoryId && selectedSessionId === s.sessionId;
                    const editing = editingId === s.sessionId;
                    return (
                      <div
                        key={s.sessionId}
                        className={[
                          'thread-item',
                          selected ? 'is-selected' : '',
                          openSet.has(s.sessionId) && s.status !== 'closed' ? 'is-open' : '',
                          s.isLegacyApprovalPollution ? 'is-dim' : '',
                        ].join(' ')}
                        onClick={() => {
                          if (!editing) onSelectSession(s);
                        }}
                        role="group"
                        tabIndex={0}
                        aria-label={s.title}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && e.target === e.currentTarget && !editing) { e.preventDefault(); onSelectSession(s); }
                        }}
                        title={s.title}
                        data-testid={`sidebar-session-${s.sessionId}`}
                      >
                        {s.status === 'streaming' || s.status === 'waiting_approval' || s.status === 'error' ? (
                          <span className={`status-dot is-${s.status}`} />
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
                        {s.pinned && !editing && <Pin size={11} className="thread-pin" />}
                        {!editing && <span className="thread-time">{formatRelativeTime(s.updatedAt, dict)}</span>}
                        {!editing && (
                          <div className="thread-actions" onClick={(e) => e.stopPropagation()}>
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
                            {onManageSession && <button type="button" className="icon-btn icon-btn-sm" title={zh ? '管理会话' : 'Manage conversation'}
                              aria-label={zh ? '管理会话' : 'Manage conversation'} data-testid={'manage-session-' + s.sessionId}
                              onClick={() => openActions(s)}><MoreHorizontal size={14} /></button>}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}

          {sessions.some(s => s.archivedAt) && <details className="archived-sessions" data-testid="archived-sessions">
            <summary><Archive size={13} /> {zh ? '已归档' : 'Archived'} · {sessions.filter(s => s.archivedAt).length}</summary>
            {sessions.filter(s => s.archivedAt && (!q || (s.title + ' ' + s.cwd).toLowerCase().includes(q))).map(s =>
              <button type="button" key={s.sessionId} onClick={() => openActions(s)} data-testid={'archived-session-' + s.sessionId}>
                <span className="truncate">{s.title}</span><MoreHorizontal size={13} /></button>)}
          </details>}
          {history.length > 0 && (
            <div data-testid="imported-history-section">
              <div className="section-head" style={{ marginTop: 14 }}>
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
                    title={locale === 'zh-CN' ? '同步本地 Antigravity 历史记录' : 'Sync local Antigravity history'}
                    aria-label={locale === 'zh-CN' ? '同步本地 Antigravity 历史记录' : 'Sync local Antigravity history'}
                    data-testid="btn-sync-history"
                  >
                    <RefreshCw size={12} />
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
                  {locale === 'zh-CN'
                    ? `加载更多（剩余 ${history.length - historyLimit} 条）`
                    : `Load more (${history.length - historyLimit} left)`}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="sidebar-foot">
          <button
            type="button"
            className="account-chip"
            onClick={onOpenAccounts}
            title={`${profileName} · ${connection.connected ? dict.acpConnected : dict.acpDisconnected}`}
            data-testid="open-accounts-modal-btn"
          >
            <span className="avatar">{profileName.trim().charAt(0).toUpperCase() || 'G'}</span>
            <span className={`status-dot ${connection.connected ? 'is-idle' : 'is-error'}`} />
            <span className="account-name truncate">{profileName}</span>
          </button>
          <div className="segmented locale-toggle" data-testid="locale-switcher">
            <button
              type="button"
              className={`segmented-btn ${locale === 'zh-CN' ? 'is-active' : ''}`}
              onClick={() => onChangeLocale('zh-CN')}
              data-testid="locale-switch-zh"
            >
              中
            </button>
            <button
              type="button"
              className={`segmented-btn ${locale === 'en-US' ? 'is-active' : ''}`}
              onClick={() => onChangeLocale('en-US')}
              data-testid="locale-switch-en"
            >
              EN
            </button>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onOpenSettings}
            title={`${dict.navSettings} (Ctrl+,)`}
            aria-label={dict.navSettings}
            data-testid="open-theme-modal-btn"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

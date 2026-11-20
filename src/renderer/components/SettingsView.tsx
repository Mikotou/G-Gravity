import React, { useEffect, useState } from 'react';
import {
  Blocks,
  Check,
  Coins,
  Download,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  Info,
  Paintbrush,
  Palette,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  APP_BRAND,
  clampUiScale,
  EXECUTION_MODE_ORDER,
  normalizeWorkspacePath,
  UI_SCALE_LIMITS,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type AppUpdateState,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ClientPreferences,
  type GravityIconId,
  type McpActionInput,
  type ModelRateCard,
  type PluginActionInput,
  type PluginsManagerSnapshot,
  type WorkspaceProjectConfig,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError, type SettingsSection } from '../i18n/locales';
import { getDesktopBridge } from '../services/desktop-bridge';
import { resolveGravityIconVariant } from '../styles/theme';
import { IconsPanel, ThemesPanel, TokensPanel } from './settings/AppearancePanels';
import { AccountsPanel, ApprovalsPanel, PluginsPanel, RatesPanel } from './settings/WorkspacePanels';
import { ResizeHandle } from './ResizeHandle';

export type { SettingsSection };

export interface SettingsViewProps {
  section: SettingsSection;
  preferences: ClientPreferences;
  connection: AcpConnectionStatus;
  accounts: AccountsStateSnapshot;
  approvalConfig: ApproveForMeConfig;
  auditEntries: ApprovalAuditEntry[];
  plugins: PluginsManagerSnapshot;
  rateCards: ModelRateCard[];
  updateState: AppUpdateState;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onCheckUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onSetAppIcon: (iconId: GravityIconId) => Promise<void>;
  onImportCustomTheme: (jsonText: string) => Promise<void>;
  onExportCustomTheme: () => Promise<string>;
  onUpdateRateCards: (cards: ModelRateCard[]) => Promise<void>;
  onCreateProfile: (name: string) => Promise<void>;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onLaunchLogin: (profileId?: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onUpdateApprovalConfig: (patch: Partial<ApproveForMeConfig>) => Promise<void>;
  onRefreshPlugins: () => Promise<void>;
  onRunPluginAction: (input: PluginActionInput) => Promise<void>;
  onRunMcpAction: (input: McpActionInput) => Promise<void>;
  onToggleSkill: (skillId: string, enabled: boolean) => Promise<void>;
  onQuickCreateInProject?: (cwd: string, mode?: AgentExecutionMode) => Promise<void>;
}

const NAV: ReadonlyArray<{ group: 'app' | 'workspace' | 'info'; id: SettingsSection; Icon: typeof Palette }> = [
  { group: 'app', id: 'general', Icon: SlidersHorizontal },
  { group: 'app', id: 'themes', Icon: Palette },
  { group: 'app', id: 'tokens', Icon: Paintbrush },
  { group: 'app', id: 'icons', Icon: Sparkles },
  { group: 'workspace', id: 'projects', Icon: FolderKanban },
  { group: 'workspace', id: 'accounts', Icon: UserRound },
  { group: 'workspace', id: 'approvals', Icon: ShieldCheck },
  { group: 'workspace', id: 'plugins', Icon: Blocks },
  { group: 'workspace', id: 'rates', Icon: Coins },
  { group: 'info', id: 'about', Icon: Info },
];

function inferFolderLabel(rawPath: string): string {
  const parts = rawPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || rawPath || 'Project';
}

function GeneralPanel({
  preferences,
  onUpdatePreferences,
  onOpenProjectsTab,
}: {
  preferences: ClientPreferences;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onOpenProjectsTab: () => void;
}): React.ReactElement {
  const { locale, dict, setLocale } = useI18n();
  const isZh = locale === 'zh-CN';
  const [scale, setScale] = useState(clampUiScale(preferences.uiScale));

  useEffect(() => {
    setScale(clampUiScale(preferences.uiScale));
  }, [preferences.uiScale]);

  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label">{dict.languageLabel}</span>
          <span className="spacer" />
          <div className="segmented">
            <button
              type="button"
              className={`segmented-btn ${locale === 'zh-CN' ? 'is-active' : ''}`}
              onClick={() => setLocale('zh-CN')}
            >
              {dict.localeZhLabel}
            </button>
            <button
              type="button"
              className={`segmented-btn ${locale === 'en-US' ? 'is-active' : ''}`}
              onClick={() => setLocale('en-US')}
            >
              {dict.localeEnLabel}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">{dict.defaultThoughtTrackLabel}</span>
          <span className="spacer" />
          <div className="segmented">
            {(['zh', 'raw'] as const).map((track) => (
              <button
                key={track}
                type="button"
                className={`segmented-btn ${preferences.defaultThoughtTrack === track ? 'is-active' : ''}`}
                onClick={() => void onUpdatePreferences({ defaultThoughtTrack: track })}
              >
                {track === 'zh' ? dict.thoughtTrackZh : dict.thoughtTrackRaw}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">{dict.translationEngineLabel}</span>
          <span data-testid="translation-engine">{dict.localTranslatorLabel}</span>
        </div>
        <div className="setting-row" title={dict.processPerSessionDesc}>
          <span className="setting-label">{dict.processPerSessionLabel}</span>
          <span className="badge badge-mono">--process-per-session</span>
          <span className="spacer" />
          <label className="switch">
            <input
              type="checkbox"
              checked={preferences.processPerSession}
              aria-label={dict.processPerSessionLabel}
              onChange={(e) => void onUpdatePreferences({ processPerSession: e.target.checked })}
            />
            <span className="switch-track" />
          </label>
        </div>
      </div>

      <h3 className="settings-group-title">{isZh ? '显示' : 'Display'}</h3>
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label">{dict.ui.uiScaleLabel}</span>
          <span className="kbd">Ctrl = / −</span>
          <span className="spacer" />
          <div className="scale-control" data-testid="ui-scale-control">
            <input
              type="range"
              min={UI_SCALE_LIMITS.min}
              max={UI_SCALE_LIMITS.max}
              step={0.05}
              value={scale}
              aria-label={dict.ui.uiScaleLabel}
              onChange={(e) => setScale(Number(e.target.value))}
              onMouseUp={() => void onUpdatePreferences({ uiScale: scale })}
              onKeyUp={() => void onUpdatePreferences({ uiScale: scale })}
              data-testid="ui-scale-range"
            />
            <span className="scale-value mono">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={scale === UI_SCALE_LIMITS.default}
              onClick={() => { setScale(UI_SCALE_LIMITS.default); void onUpdatePreferences({ uiScale: UI_SCALE_LIMITS.default }); }}
            >
              {dict.ui.resetAction}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">{isZh ? '默认工作目录' : 'Default folder'}</span>
          <span className="muted truncate mono" style={{ fontSize: 12 }}>
            {preferences.defaultWorkspaceCwd || '—'}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onOpenProjectsTab}>
            <FolderKanban size={13} />
            <span>{(preferences.projects ?? []).length}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectsPanel({
  preferences,
  onUpdatePreferences,
  onQuickCreateInProject,
  onClose,
}: {
  preferences: ClientPreferences;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onQuickCreateInProject?: (cwd: string, mode?: AgentExecutionMode) => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const isZh = locale === 'zh-CN';
  const projects = preferences.projects ?? [];

  const [defaultCwd, setDefaultCwd] = useState(preferences.defaultWorkspaceCwd || '');
  const [defaultSaved, setDefaultSaved] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [projName, setProjName] = useState('');
  const [projPath, setProjPath] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [projMode, setProjMode] = useState<AgentExecutionMode | ''>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDefaultCwd(preferences.defaultWorkspaceCwd || '');
  }, [preferences.defaultWorkspaceCwd]);

  /** 将默认目录规范化后存入偏好。空字符串允许用户清除默认值，后续新会话可使用其他目录来源。 */
  async function saveDefaultFolder(): Promise<void> {
    setError(null);
    try {
      const clean = defaultCwd.trim() ? normalizeWorkspacePath(defaultCwd.trim()) : '';
      await onUpdatePreferences({ defaultWorkspaceCwd: clean });
      setDefaultSaved(true);
      setTimeout(() => setDefaultSaved(false), 1600);
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  async function browseForDefault(): Promise<void> {
    try {
      const picked = await getDesktopBridge().selectDirectory(defaultCwd || undefined);
      if (picked) {
        setDefaultCwd(picked);
      }
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  async function browseForProject(): Promise<void> {
    try {
      const picked = await getDesktopBridge().selectDirectory(projPath || defaultCwd || undefined);
      if (picked) {
        setProjPath(picked);
        if (!projName.trim()) {
          setProjName(inferFolderLabel(picked));
        }
      }
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  function resetForm(): void {
    setEditingId(null);
    setProjName('');
    setProjPath('');
    setProjDesc('');
    setProjMode('');
  }

  async function submitProject(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const normalizedPath = normalizeWorkspacePath(projPath.trim());
    const cleanName = (projName.trim() || inferFolderLabel(normalizedPath)).slice(0, 80);
    if (!normalizedPath || !cleanName) return;

    const item: WorkspaceProjectConfig = {
      id: editingId || `proj-${Date.now()}`,
      name: cleanName,
      path: normalizedPath,
      description: projDesc.trim() || undefined,
      defaultMode: projMode || undefined,
      pinned: editingId ? projects.find((p) => p.id === editingId)?.pinned : true,
    };

    // 编辑用项目 ID 定位原条目。新增用规范化路径去重，并把新项目放到列表首位。
    const nextList = editingId
      ? projects.map((p) => (p.id === editingId ? item : p))
      : [
          item,
          ...projects.filter((p) => normalizeWorkspacePath(p.path).toLowerCase() !== normalizedPath.toLowerCase()),
        ];

    try {
      await onUpdatePreferences({ projects: nextList });
      resetForm();
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  return (
    <div className="settings-section" data-testid="projects-settings-panel">
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      <h3 className="settings-group-title">{isZh ? '默认工作目录' : 'Default folder'}</h3>
      <div className="settings-group" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input input-mono"
            style={{ flex: 1 }}
            placeholder={isZh ? '例如 F:\\插件-Gemini 或 D:\\Workspace' : 'e.g. D:\\Projects\\MyApp'}
            value={defaultCwd}
            onChange={(e) => setDefaultCwd(e.target.value)}
            data-testid="settings-default-cwd-input"
          />
          <button
            type="button"
            className="btn"
            onClick={() => void browseForDefault()}
            data-testid="settings-browse-default-cwd-btn"
          >
            <FolderOpen size={14} />
            <span>{isZh ? '浏览…' : 'Browse…'}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saveDefaultFolder()}
            data-testid="settings-save-default-cwd-btn"
          >
            {defaultSaved ? <Check size={14} /> : null}
            <span>{defaultSaved ? dict.savedHint : dict.saveAction}</span>
          </button>
        </div>
      </div>

      <h3 className="settings-group-title">
        {editingId ? (isZh ? '编辑项目' : 'Edit project') : isZh ? '添加项目' : 'Add project'}
      </h3>
      <form className="settings-group" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => void submitProject(e)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 8 }}>
          <input
            className="input"
            placeholder={isZh ? '项目名称' : 'Project name'}
            value={projName}
            onChange={(e) => setProjName(e.target.value)}
            data-testid="project-name-input"
            required
          />
          <select
            className="input"
            aria-label={isZh ? '项目默认 Mode' : 'Default Mode'}
            value={projMode}
            onChange={(e) => setProjMode(e.target.value as AgentExecutionMode | '')}
            data-testid="project-mode-select"
          >
            <option value="">{isZh ? '跟随全局 Mode' : 'Default mode'}</option>
            {EXECUTION_MODE_ORDER.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input input-mono"
            style={{ flex: 1 }}
            placeholder={isZh ? '项目文件夹绝对路径' : 'Project folder path'}
            value={projPath}
            onChange={(e) => setProjPath(e.target.value)}
            data-testid="project-path-input"
            required
          />
          <button
            type="button"
            className="btn"
            onClick={() => void browseForProject()}
            data-testid="project-browse-path-btn"
          >
            <FolderOpen size={14} />
            <span>{isZh ? '选择目录…' : 'Browse…'}</span>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={isZh ? '备注（可选）' : 'Note (optional)'}
            value={projDesc}
            onChange={(e) => setProjDesc(e.target.value)}
            data-testid="project-desc-input"
          />
          {editingId && (
            <button type="button" className="btn btn-ghost" onClick={resetForm}>
              {dict.cancelAction}
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!projPath.trim() || !projName.trim()}
            data-testid="save-project-btn"
          >
            <Plus size={14} />
            <span>{editingId ? dict.saveAction : isZh ? '添加 Project' : 'Add Project'}</span>
          </button>
        </div>
      </form>

      <h3 className="settings-group-title">
        {isZh ? `已保存的项目 · ${projects.length}` : `Projects · ${projects.length}`}
      </h3>
      <div className="settings-group">
        {projects.length === 0 ? (
          <div className="empty-state">
            {isZh ? '暂无项目' : 'No projects yet'}
          </div>
        ) : (
          projects.map((proj) => {
            const isDef =
              Boolean(preferences.defaultWorkspaceCwd) &&
              normalizeWorkspacePath(preferences.defaultWorkspaceCwd || '').toLowerCase() ===
                normalizeWorkspacePath(proj.path).toLowerCase();
            return (
              <div key={proj.id} className="list-row" data-testid={`project-row-${proj.id}`}>
                <span className="list-icon">
                  <FolderKanban size={15} />
                </span>
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span>{proj.name}</span>
                    {proj.pinned && <span className="badge badge-accent">{isZh ? '侧栏常驻' : 'Pinned'}</span>}
                    {proj.defaultMode && <span className="badge badge-mono">{proj.defaultMode}</span>}
                    {isDef && <span className="badge badge-success">{isZh ? '默认目录' : 'Default'}</span>}
                  </div>
                  <div className="list-row-desc mono truncate" title={proj.path}>
                    {proj.path}
                  </div>
                  {proj.description && <div className="list-row-desc">{proj.description}</div>}
                </div>
                <div className="list-row-actions">
                  {onQuickCreateInProject && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        onClose();
                        void onQuickCreateInProject(proj.path, proj.defaultMode);
                      }}
                      data-testid={`launch-project-${proj.id}`}
                    >
                      <Plus size={12} />
                      <span>{dict.newSession}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={isZh ? '设为默认工作目录' : 'Set as default folder'}
                    onClick={() => void onUpdatePreferences({ defaultWorkspaceCwd: proj.path })}
                    data-testid={`set-default-project-${proj.id}`}
                  >
                    <Star size={13} style={{ color: isDef ? 'var(--accent-primary)' : undefined }} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={proj.pinned ? dict.unpinSession : dict.pinSession}
                    onClick={() =>
                      void onUpdatePreferences({
                        projects: projects.map((p) => (p.id === proj.id ? { ...p, pinned: !p.pinned } : p)),
                      })
                    }
                  >
                    <Pin size={13} style={{ color: proj.pinned ? 'var(--accent-primary)' : undefined }} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={isZh ? '编辑项目' : 'Edit project'}
                    onClick={() => {
                      setEditingId(proj.id);
                      setProjName(proj.name);
                      setProjPath(proj.path);
                      setProjDesc(proj.description || '');
                      setProjMode(proj.defaultMode || '');
                    }}
                    data-testid={`edit-project-${proj.id}`}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={dict.deleteAction}
                    onClick={() =>
                      void onUpdatePreferences({
                        projects: projects.filter((p) => p.id !== proj.id),
                      })
                    }
                    data-testid={`delete-project-${proj.id}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function formatUpdateBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function AboutPanel({
  preferences,
  connection,
  updateState,
  onUpdatePreferences,
  onCheckUpdates,
  onDownloadUpdate,
  onInstallUpdate,
}: {
  preferences: ClientPreferences;
  connection: AcpConnectionStatus;
  updateState: AppUpdateState;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onCheckUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
}): React.ReactElement {
  const { dict } = useI18n();
  const icon = resolveGravityIconVariant(preferences.appIcon);
  const autoCheckEnabled = preferences.autoCheckUpdates !== false;
  const repoUrl = updateState.repoUrl || APP_BRAND.repoUrl;
  const releaseHref = updateState.releaseUrl || `${repoUrl}/releases`;
  const progressPct =
    updateState.progressPercent !== undefined
      ? Math.max(0, Math.min(100, updateState.progressPercent))
      : updateState.totalBytes && updateState.downloadedBytes
        ? Math.min(100, Math.round((updateState.downloadedBytes / updateState.totalBytes) * 100))
        : 0;
  const shortcuts: Array<[string, string]> = [
    [dict.shortcutLabels.newThread, 'Ctrl N'],
    [dict.shortcutLabels.sidebar, 'Ctrl B'],
    [dict.shortcutLabels.inspector, 'Ctrl J'],
    [dict.shortcutLabels.split, 'Ctrl \\'],
    [dict.shortcutLabels.mode, 'Shift Tab'],
    [dict.shortcutLabels.settings, 'Ctrl ,'],
  ];

  const openExternal = (target: string) => {
    void getDesktopBridge().openLinkOrFileTarget({ target, action: 'browser' }).catch(() => {});
  };

  return (
    <div className="settings-section" data-testid="about-gravity-modal">
      <div className="about-hero">
        <img src={icon.publicSvgUrl} alt={APP_BRAND.name} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3>{APP_BRAND.name}</h3>
            <span className="badge badge-accent badge-mono">v{updateState.currentVersion || APP_BRAND.version}</span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>{dict.appTagline}</div>
        </div>
      </div>

      <h3 className="settings-group-title">{dict.updatesSectionTitle}</h3>
      <div className="settings-group update-card" data-testid="update-panel">
        <div className="setting-row">
          <span className="setting-label">{dict.updatesSourceLabel}</span>
          <span className="muted mono truncate">{APP_BRAND.repoSlug}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => openExternal(releaseHref)}
            data-testid="open-release-page-btn"
          >
            <ExternalLink size={13} />
            <span>{dict.updatesViewReleaseBtn}</span>
          </button>
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">{dict.updatesAutoCheckLabel}</div>
            <div className="setting-desc">{dict.updatesAutoCheckDesc}</div>
          </div>
          <span className="spacer" />
          <label className="switch">
            <input
              type="checkbox"
              checked={autoCheckEnabled}
              aria-label={dict.updatesAutoCheckLabel}
              onChange={(e) => void onUpdatePreferences({ autoCheckUpdates: e.target.checked })}
              data-testid="auto-check-updates-toggle"
            />
            <span className="switch-track" />
          </label>
        </div>

        <div className="setting-row update-status-row">
          <div className="update-status-copy">
            {updateState.status === 'checking' && (
              <span className="update-status-line muted">
                <RefreshCw size={13} className="spin" />
                <span>{dict.updatesChecking}</span>
              </span>
            )}
            {updateState.status === 'up-to-date' && (
              <span className="update-status-line" style={{ color: 'var(--status-success)' }}>
                <Check size={14} />
                <span>
                  {dict.updatesUpToDate}
                  {updateState.latestVersion ? ` (v${updateState.latestVersion})` : ''}
                </span>
              </span>
            )}
            {updateState.status === 'available' && (
              <div className="update-available-meta">
                <span className="badge badge-accent badge-mono">
                  {dict.updatesAvailableBadge(updateState.latestVersion || '')}
                </span>
                {updateState.asset ? (
                  <span className="muted mono truncate">
                    {updateState.asset.name}
                    {updateState.asset.sizeBytes ? ` · ${formatUpdateBytes(updateState.asset.sizeBytes)}` : ''}
                  </span>
                ) : (
                  <span className="muted">{dict.updatesNoMatchingAsset}</span>
                )}
              </div>
            )}
            {updateState.status === 'downloading' && (
              <div className="update-progress-wrap">
                <div className="update-progress-head">
                  <span>{dict.updatesDownloading}</span>
                  <span className="mono muted">
                    {progressPct}%
                    {updateState.downloadedBytes
                      ? ` · ${formatUpdateBytes(updateState.downloadedBytes)}${updateState.totalBytes ? ` / ${formatUpdateBytes(updateState.totalBytes)}` : ''}`
                      : ''}
                  </span>
                </div>
                <div className="update-progress-track">
                  <div className="update-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
              </div>
            )}
            {updateState.status === 'downloaded' && (
              <div className="update-available-meta">
                <span className="badge badge-success badge-mono">
                  v{updateState.latestVersion}
                </span>
                <span className="muted truncate">{updateState.asset?.name}</span>
              </div>
            )}
            {updateState.status === 'installing' && (
              <span className="update-status-line muted">
                <RotateCw size={13} className="spin" />
                <span>{dict.updatesInstalling}</span>
              </span>
            )}
            {updateState.status === 'error' && (
              <span className="update-status-line" style={{ color: 'var(--status-danger)' }}>
                {updateState.errorMessage || dict.unknownError}
              </span>
            )}
            {updateState.status === 'idle' && (
              <span className="muted">{dict.updatesIdleHint}</span>
            )}
          </div>

          <div className="update-actions">
            {updateState.status === 'available' && updateState.asset && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void onDownloadUpdate()}
                data-testid="download-update-btn"
              >
                <Download size={13} />
                <span>{dict.updatesDownloadBtn}</span>
              </button>
            )}
            {updateState.status === 'downloaded' && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void onInstallUpdate()}
                data-testid="install-update-btn"
              >
                <RotateCw size={13} />
                <span>
                  {updateState.canInstallDirectly
                    ? dict.updatesInstallRestartBtn
                    : dict.updatesOpenPackageBtn}
                </span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={
                updateState.status === 'checking' ||
                updateState.status === 'downloading' ||
                updateState.status === 'installing'
              }
              onClick={() => void onCheckUpdates()}
              data-testid="check-updates-btn"
            >
              <RefreshCw size={13} className={updateState.status === 'checking' ? 'spin' : ''} />
              <span>{dict.updatesCheckBtn}</span>
            </button>
          </div>
        </div>

        {updateState.releaseNotes &&
          (updateState.status === 'available' ||
            updateState.status === 'downloading' ||
            updateState.status === 'downloaded') && (
            <div className="update-notes" data-testid="update-release-notes">
              <pre>{updateState.releaseNotes}</pre>
            </div>
          )}
      </div>

      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label">agy</span>
          <span className="muted mono truncate">{connection.agyBinaryPath || 'agy'}</span>
          <span className="spacer" />
          <span className="badge badge-mono">{connection.agyVersion || '—'}</span>
        </div>
        <div className="setting-row">
          <span className="setting-label">ACP</span>
          <span className="muted truncate">
            {connection.connected ? dict.acpConnected : dict.acpDisconnected}
            {connection.lastError ? ` · ${connection.lastError}` : ''}
          </span>
          <span className="spacer" />
          <span className="badge badge-mono">
            {connection.activeSessionCount}/{connection.maxParallelSessions}
          </span>
        </div>
      </div>
      <h3 className="settings-group-title">{dict.shortcutsTitle}</h3>
      <div className="settings-group">
        {shortcuts.map(([label, keys]) => (
          <div key={label} className="setting-row" style={{ minHeight: 38 }}>
            <span className="setting-label" style={{ fontWeight: 450 }}>
              {label}
            </span>
            <span className="spacer" />
            <span className="kbd">{keys}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 全屏设置：左侧分组导航 + 右侧内容（参照 Codex / Claude 桌面端） */
export function SettingsView(props: SettingsViewProps): React.ReactElement {
  const { dict } = useI18n();
  const { section, onSectionChange, onClose } = props;
  const [navWidth, setNavWidth] = useState(216);

  // Escape 交给当前设置页关闭回调。组件卸载时移除监听，以便工作台恢复对快捷键的处理。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (section === 'plugins') void props.onRefreshPlugins().catch(() => {});
    // 仅在进入 Plugins 时刷新一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // 设置导航只挂载当前栏目。保存偏好、执行管理操作等能力从 App 传入，各栏目保留自己的表单草稿。
  let content: React.ReactNode;
  switch (section) {
    case 'general':
      content = (
        <GeneralPanel
          preferences={props.preferences}
          onUpdatePreferences={props.onUpdatePreferences}
          onOpenProjectsTab={() => onSectionChange('projects')}
        />
      );
      break;
    case 'themes':
      content = <ThemesPanel preferences={props.preferences} onUpdatePreferences={props.onUpdatePreferences} />;
      break;
    case 'tokens':
      content = (
        <TokensPanel
          preferences={props.preferences}
          onUpdatePreferences={props.onUpdatePreferences}
          onImportCustomTheme={props.onImportCustomTheme}
          onExportCustomTheme={props.onExportCustomTheme}
        />
      );
      break;
    case 'icons':
      content = <IconsPanel preferences={props.preferences} onSetAppIcon={props.onSetAppIcon} />;
      break;
    case 'projects':
      content = (
        <ProjectsPanel
          preferences={props.preferences}
          onUpdatePreferences={props.onUpdatePreferences}
          onQuickCreateInProject={props.onQuickCreateInProject}
          onClose={onClose}
        />
      );
      break;
    case 'accounts':
      content = (
        <AccountsPanel
          accounts={props.accounts}
          onCreateProfile={props.onCreateProfile}
          onSwitchProfile={props.onSwitchProfile}
          onDeleteProfile={props.onDeleteProfile}
          onLaunchLogin={props.onLaunchLogin}
          onLogout={props.onLogout}
        />
      );
      break;
    case 'approvals':
      content = (
        <ApprovalsPanel
          config={props.approvalConfig}
          auditEntries={props.auditEntries}
          onUpdateConfig={props.onUpdateApprovalConfig}
        />
      );
      break;
    case 'plugins':
      content = (
        <PluginsPanel
          snapshot={props.plugins}
          onRunPluginAction={props.onRunPluginAction}
          onRunMcpAction={props.onRunMcpAction}
          onToggleSkill={props.onToggleSkill}
        />
      );
      break;
    case 'rates':
      content = <RatesPanel rateCards={props.rateCards} onUpdateRateCards={props.onUpdateRateCards} />;
      break;
    default:
      content = (
        <AboutPanel
          preferences={props.preferences}
          connection={props.connection}
          updateState={props.updateState}
          onUpdatePreferences={props.onUpdatePreferences}
          onCheckUpdates={props.onCheckUpdates}
          onDownloadUpdate={props.onDownloadUpdate}
          onInstallUpdate={props.onInstallUpdate}
        />
      );
  }

  const hasPendingUpdate =
    props.updateState.status === 'available' || props.updateState.status === 'downloaded';

  return (
    <div className="overlay" onMouseDown={onClose} data-testid="settings-overlay">
      <div className="settings" onMouseDown={(e) => e.stopPropagation()} data-testid="theme-settings-modal">
        <nav className="settings-nav" style={{ width: navWidth }}>
          <div className="settings-nav-title">{dict.settingsTitle}</div>
          {(['app', 'workspace', 'info'] as const).map((group) => (
            <React.Fragment key={group}>
              <div className="settings-nav-group">{dict.settingsNavGroups[group]}</div>
              {NAV.filter((item) => item.group === group).map(({ id, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-nav-item ${section === id ? 'is-active' : ''}`}
                  onClick={() => onSectionChange(id)}
                  data-testid={`settings-tab-${id}`}
                >
                  <Icon size={15} />
                  <span className="truncate">{dict.settingsNav[id]}</span>
                  {id === 'about' && hasPendingUpdate && (
                    <span className="settings-nav-dot" aria-hidden="true" />
                  )}
                </button>
              ))}
            </React.Fragment>
          ))}
          <ResizeHandle
            value={navWidth}
            min={176}
            max={300}
            defaultValue={216}
            label={dict.ui.resizeSidebar}
            className="edge-right"
            testId="settings-nav-resize-handle"
            onPreview={setNavWidth}
            onCommit={(w) => setNavWidth(Math.round(w))}
          />
        </nav>
        <section className="settings-main">
          <header className="settings-head">
            <h2>{dict.settingsNav[section]}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={dict.closeAction} title="Esc">
              <X size={16} />
            </button>
          </header>
          <div className="settings-body" key={section}>{content}</div>
        </section>
      </div>
    </div>
  );
}

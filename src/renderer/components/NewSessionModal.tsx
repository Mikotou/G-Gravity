import React, { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, FolderKanban, FolderOpen, Star, X } from 'lucide-react';
import {
  normalizeWorkspacePath,
  type AgentExecutionMode,
  type WorkspaceProjectConfig,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { getDesktopBridge } from '../services/desktop-bridge';

export interface NewSessionModalProps {
  open: boolean;
  defaultCwd: string;
  configuredDefaultCwd?: string;
  projects?: WorkspaceProjectConfig[];
  recentCwds?: string[];
  onClose: () => void;
  onCreate: (cwd: string, title?: string, executionMode?: AgentExecutionMode) => Promise<void>;
  onSaveDefaultCwd?: (cwd: string) => Promise<void>;
  onSaveProject?: (project: WorkspaceProjectConfig) => Promise<void>;
  onOpenProjectsSettings?: () => void;
}

function inferProjectName(rawPath: string): string {
  const parts = rawPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || rawPath || 'Project';
}

export function NewSessionModal({
  open,
  defaultCwd,
  configuredDefaultCwd,
  projects = [],
  recentCwds = [],
  onClose,
  onCreate,
  onSaveDefaultCwd,
  onSaveProject,
  onOpenProjectsSettings,
}: NewSessionModalProps): React.ReactElement | null {
  const { locale, dict } = useI18n();
  const isZh = locale === 'zh-CN';
  const [cwd, setCwd] = useState(defaultCwd);
  const [title, setTitle] = useState('');
  const [selectedMode, setSelectedMode] = useState<AgentExecutionMode | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [quickProjectName, setQuickProjectName] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cwdRef = useRef<HTMLInputElement | null>(null);

  // 每次打开或默认路径变化时，以用户保存的工作区为首选，并在输入框挂载后选中文本，方便直接替换路径。
  useEffect(() => {
    if (open) {
      setCwd(configuredDefaultCwd || defaultCwd);
      setSelectedMode(undefined);
      setAddingProject(false);
      setError(null);
      setTimeout(() => cwdRef.current?.select(), 0);
    }
  }, [open, configuredDefaultCwd, defaultCwd]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const normalized = normalizeWorkspacePath(cwd);
  const isCurrentDefault =
    Boolean(normalized) &&
    Boolean(configuredDefaultCwd) &&
    normalizeWorkspacePath(configuredDefaultCwd || '').toLowerCase() === normalized.toLowerCase();
  const matchedProject = projects.find(
    (p) => normalizeWorkspacePath(p.path).toLowerCase() === normalized.toLowerCase()
  );

  async function handleBrowse(): Promise<void> {
    try {
      const picked = await getDesktopBridge().selectDirectory(normalized || undefined);
      if (picked) {
        setCwd(picked);
      }
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  async function handleSetAsDefault(): Promise<void> {
    if (!normalized || !onSaveDefaultCwd || savingDefault) return;
    setSavingDefault(true);
    setError(null);
    try {
      await onSaveDefaultCwd(normalized);
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setSavingDefault(false);
    }
  }

  async function handleQuickSaveProject(): Promise<void> {
    if (!normalized || !onSaveProject) return;
    const name = (quickProjectName.trim() || inferProjectName(normalized)).slice(0, 80);
    try {
      await onSaveProject({
        id: `proj-${Date.now()}`,
        name,
        path: normalized,
        defaultMode: selectedMode,
        pinned: true,
      });
      setAddingProject(false);
      setQuickProjectName('');
    } catch (err) {
      setError(formatActionError(err, dict));
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (creating || !normalized) return;
    setCreating(true);
    setError(null);
    try {
      // 本次手动选择的模式优先。未选择时继承匹配项目的默认模式。创建成功才关闭弹窗，失败保留草稿。
      await onCreate(normalized, title.trim() || undefined, selectedMode ?? matchedProject?.defaultMode);
      setTitle('');
      onClose();
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setCreating(false);
    }
  }

  // 最近使用的目录先规范化并去重，再排除已有项目，避免同一位置在两组快捷入口中重复。
  const projectPathSet = new Set(projects.map((p) => normalizeWorkspacePath(p.path).toLowerCase()));
  const recents = Array.from(new Set(recentCwds.map(normalizeWorkspacePath).filter(Boolean)))
    .filter((p) => !projectPathSet.has(p.toLowerCase()))
    .slice(0, 6);

  return (
    <div className="overlay" onMouseDown={onClose} data-testid="new-session-backdrop">
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        data-testid="new-session-modal"
      >
        <div className="modal-head">
          <h2>{dict.newSessionModalTitle}</h2>
          {onOpenProjectsSettings && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 'auto', marginRight: 6 }}
              onClick={() => {
                onClose();
                onOpenProjectsSettings();
              }}
              data-testid="modal-manage-projects-btn"
            >
              <FolderKanban size={13} />
              <span>{isZh ? '管理 Project' : 'Manage Projects'}</span>
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={dict.closeAction}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          {projects.length > 0 && (
            <div className="field">
              <span className="field-label">{isZh ? '我的项目 (Projects)' : 'Projects'}</span>
              <div className="chip-row">
                {projects.map((proj) => {
                  const active =
                    normalizeWorkspacePath(proj.path).toLowerCase() === normalized.toLowerCase();
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      className={`chip-btn ${active ? 'is-active' : ''}`}
                      title={`${proj.name}\n${proj.path}${proj.description ? `\n${proj.description}` : ''}`}
                      onClick={() => {
                        setCwd(proj.path);
                        setSelectedMode(proj.defaultMode);
                      }}
                      data-testid={`new-session-project-chip-${proj.id}`}
                    >
                      <FolderKanban size={11} />
                      <span>{proj.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="field-label">{dict.newSessionCwdLabel}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {onSaveDefaultCwd && normalized && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ height: 22, padding: '0 7px', fontSize: 11 }}
                    disabled={savingDefault || isCurrentDefault}
                    onClick={() => void handleSetAsDefault()}
                    data-testid="new-session-set-default-btn"
                  >
                    {isCurrentDefault ? <Check size={11} /> : <Star size={11} />}
                    <span>{isCurrentDefault ? (isZh ? '已是默认目录' : 'Default folder') : isZh ? '设为默认目录' : 'Set default'}</span>
                  </button>
                )}
                {onSaveProject && normalized && !matchedProject && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ height: 22, padding: '0 7px', fontSize: 11 }}
                    onClick={() => {
                      setAddingProject((v) => !v);
                      setQuickProjectName(inferProjectName(normalized));
                    }}
                    data-testid="new-session-save-project-toggle"
                  >
                    <BookmarkPlus size={11} />
                    <span>{isZh ? '存为 Project' : 'Save as Project'}</span>
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                ref={cwdRef}
                className="input input-mono"
                style={{ flex: 1 }}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                data-testid="new-session-cwd-input"
                required
              />
              <button
                type="button"
                className="btn"
                onClick={() => void handleBrowse()}
                data-testid="new-session-browse-btn"
              >
                <FolderOpen size={14} />
                <span>{isZh ? '浏览…' : 'Browse…'}</span>
              </button>
            </div>
            {normalized && normalized !== cwd.trim() && (
              <span className="field-hint mono">
                {dict.newSessionNormalizedPreview}
                {normalized}
              </span>
            )}
          </div>

          {addingProject && (
            <div className="inline-project-save" data-testid="quick-save-project-box">
              <input
                className="input"
                placeholder={isZh ? '输入 Project 名称，例如：核心网关服务' : 'Project name'}
                value={quickProjectName}
                onChange={(e) => setQuickProjectName(e.target.value)}
                data-testid="quick-save-project-name"
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleQuickSaveProject()}
                data-testid="quick-save-project-confirm"
              >
                {isZh ? '保存项目' : 'Save'}
              </button>
            </div>
          )}

          {recents.length > 0 && (
            <div className="field">
              <span className="field-label">{dict.recentWorkspacesLabel}</span>
              <div className="chip-row">
                {recents.map((path) => (
                  <button key={path} type="button" className="chip-btn" title={path} onClick={() => setCwd(path)}>
                    <FolderOpen size={11} />
                    {path}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="field">
            <span className="field-label">{dict.newSessionTitleLabel}</span>
            <input
              className="input"
              placeholder={dict.newSessionTitlePlaceholder}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="new-session-title-input"
            />
          </label>

          {error && (
            <div role="alert" className="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {dict.cancelAction}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating || !normalized}
            data-testid="confirm-create-session-btn"
          >
            {dict.createSessionConfirm}
          </button>
        </div>
      </form>
    </div>
  );
}

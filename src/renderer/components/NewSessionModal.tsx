import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, FolderKanban, FolderOpen, Star, X, Zap } from 'lucide-react';
import {
  EXECUTION_MODE_ORDER,
  REASONING_EFFORT_ORDER,
  normalizeProjectCompareKey,
  normalizeWorkspacePath,
  type AcpModelOption,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type WorkspaceProjectConfig,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { isImeComposing } from '../lib/platform-keys';
import { formatActionError } from '../i18n/locales';
import { getDesktopBridge } from '../services/desktop-bridge';
import { Icon } from './ui/Icon';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { modelDisplayName, resolveCreateModelId } from '../lib/model-options';

export interface NewSessionModalProps {
  open: boolean;
  defaultCwd: string;
  configuredDefaultCwd?: string;
  projects?: WorkspaceProjectConfig[];
  recentCwds?: string[];
  /** U-02：可选模型目录（连接快照 + 现有非污染会话去重）；为空时展示「目录尚未同步」提示 */
  availableModels?: AcpModelOption[];
  /** 全局默认模型（项目未指定 `defaultModelId` 时回显） */
  defaultModelId?: string;
  onClose: () => void;
  onCreate: (
    cwd: string,
    title?: string,
    executionMode?: AgentExecutionMode,
    options?: NewSessionCreateOptions
  ) => Promise<void>;
  onSaveDefaultCwd?: (cwd: string) => Promise<void>;
  onSaveProject?: (project: WorkspaceProjectConfig) => Promise<void>;
  onOpenProjectsSettings?: () => void;
}

export interface NewSessionCreateOptions {
  modelId?: string;
  reasoningEffort?: AgentReasoningEffort;
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
  availableModels = [],
  defaultModelId,
  onClose,
  onCreate,
  onSaveDefaultCwd,
  onSaveProject,
  onOpenProjectsSettings,
}: NewSessionModalProps): React.ReactElement | null {
  const { dict } = useI18n();
  const v034 = dict.ui.v034;
  const [cwdDraft, setCwd] = useState<string>();
  const cwd = cwdDraft ?? (configuredDefaultCwd || defaultCwd);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [quickProjectName, setQuickProjectName] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  // v0.3.2：新建会话可显式指定执行模式（含 Turbo / full-access）；空字符串表示跟随项目默认。
  const [modeDraft, setModeDraft] = useState<AgentExecutionMode | ''>('');
  // U-02：空字符串表示跟随项目默认 / 官方默认模型与推理强度。
  const [modelDraft, setModelDraft] = useState('');
  const [effortDraft, setEffortDraft] = useState<AgentReasoningEffort | ''>('');
  const cwdRef = useRef<HTMLInputElement | null>(null);
  // F-13：焦点陷阱与关闭后归还触发按钮（cwd 输入框由下方 layout effect 抢先聚焦）
  const trapRef = useFocusTrap<HTMLFormElement>(open);
  // 同步锁：两次极快的提交（回车 + 点击）在下一次渲染前都能看到 creating=false，用 ref 防止重复创建会话。
  const submittingRef = useRef(false);

  // Select the suggested path before the first keystroke can arrive. A later suggestion only affects an untouched field.
  useLayoutEffect(() => {
    if (open) {
      cwdRef.current?.focus();
      cwdRef.current?.select();
    } else {
      // 关闭即重置草稿：下次打开不会残留上次的标题、项目名或错误。
      setCwd(undefined);
      setTitle('');
      setQuickProjectName('');
      setAddingProject(false);
      setModeDraft('');
      setModelDraft('');
      setEffortDraft('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      // 中文/日文输入法组词时的 Esc 只取消候选，不能关闭弹窗丢失表单。
      if (isImeComposing(e)) return;
      if (e.key === 'Escape' && !submittingRef.current) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const normalized = normalizeWorkspacePath(cwd);
  const compareKey = normalizeProjectCompareKey(normalized);
  const isCurrentDefault =
    Boolean(normalized) &&
    Boolean(configuredDefaultCwd) &&
    normalizeProjectCompareKey(configuredDefaultCwd || '') === compareKey;
  const matchedProject = projects.find((p) => normalizeProjectCompareKey(p.path) === compareKey);
  const effectiveMode: AgentExecutionMode | undefined = modeDraft || matchedProject?.defaultMode;
  const followModelId = matchedProject?.defaultModelId || defaultModelId;
  const followModelLabel = matchedProject?.defaultModelId
    ? v034.newSessionModelFollowProject(modelDisplayName(matchedProject.defaultModelId, availableModels))
    : v034.newSessionModelFollowOfficial;
  // FE-09：创建期间锁定遮罩、右上角 X、取消按钮与 Esc 全部关闭出口，避免产生幽灵会话。
  const requestClose = (): void => {
    if (creating || submittingRef.current) return;
    onClose();
  };

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
    if (!normalized || !onSaveProject || savingProject) return;
    const name = (quickProjectName.trim() || inferProjectName(normalized)).slice(0, 80);
    setSavingProject(true);
    setError(null);
    try {
      await onSaveProject({
        id: `proj-${Date.now()}`,
        name,
        path: normalized,
        defaultMode: matchedProject?.defaultMode,
        pinned: true,
      });
      setAddingProject(false);
      setQuickProjectName('');
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setSavingProject(false);
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (creating || submittingRef.current || !normalized) return;
    submittingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const modelId = resolveCreateModelId(modelDraft || undefined, followModelId, availableModels);
      const createOptions: NewSessionCreateOptions = {
        ...(modelId ? { modelId } : {}),
        ...(effortDraft ? { reasoningEffort: effortDraft } : {}),
      };
      // 未选择模型/强度时保持三参调用，兼容只关心目录、标题与模式的调用方。
      if (Object.keys(createOptions).length > 0) {
        await onCreate(normalized, title.trim() || undefined, effectiveMode, createOptions);
      } else {
        await onCreate(normalized, title.trim() || undefined, effectiveMode);
      }
      setTitle('');
      onClose();
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      submittingRef.current = false;
      setCreating(false);
    }
  }

  // 最近使用的目录先规范化并去重，再排除已有项目，避免同一位置在两组快捷入口中重复。
  const projectPathSet = new Set(projects.map((p) => normalizeProjectCompareKey(p.path)));
  const recents = Array.from(new Set(recentCwds.map(normalizeWorkspacePath).filter(Boolean)))
    .filter((p) => !projectPathSet.has(normalizeProjectCompareKey(p)))
    .slice(0, 6);

  return (
    <div className="overlay" onMouseDown={requestClose} data-testid="new-session-backdrop">
      <form
        ref={trapRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={dict.newSessionModalTitle}
        aria-busy={creating || undefined}
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
              disabled={creating}
              onClick={() => {
                if (creating) return;
                onClose();
                onOpenProjectsSettings();
              }}
              data-testid="modal-manage-projects-btn"
            >
              <Icon icon={FolderKanban} size="sm" />
              <span>{dict.ui.copy.manageProjects}</span>
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={requestClose}
            disabled={creating}
            aria-label={dict.closeAction}
            data-testid="new-session-close-btn"
          >
            <Icon icon={X} size="md" />
          </button>
        </div>
        <div className="modal-body">
          {projects.length > 0 && (
            <div className="field">
              <span className="field-label">{dict.ui.copy.projects}</span>
              <div className="chip-row">
                {projects.map((proj) => {
                  const active = normalizeProjectCompareKey(proj.path) === compareKey;
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      className={`chip-btn ${active ? 'is-active' : ''}`}
                      title={`${proj.name}\n${proj.path}${proj.description ? `\n${proj.description}` : ''}`}
                      onClick={() => setCwd(proj.path)}
                      data-testid={`new-session-project-chip-${proj.id}`}
                    >
                      <Icon icon={FolderKanban} size="xs" />
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
                    {isCurrentDefault ? <Icon icon={Check} size="xs" /> : <Icon icon={Star} size="xs" />}
                    <span>{isCurrentDefault ? (dict.ui.copy.defaultFolder) : dict.ui.copy.setDefault}</span>
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
                    <Icon icon={BookmarkPlus} size="xs" />
                    <span>{dict.ui.copy.saveAsProject}</span>
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
                <Icon icon={FolderOpen} size="sm" />
                <span>{dict.ui.copy.browse}</span>
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
                placeholder={dict.ui.copy.projectName}
                value={quickProjectName}
                onChange={(e) => setQuickProjectName(e.target.value)}
                onKeyDown={(e) => {
                  // 回车只保存项目，不提交整张新建会话表单。
                  if (e.key === 'Enter' && !isImeComposing(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleQuickSaveProject();
                  }
                }}
                disabled={savingProject}
                data-testid="quick-save-project-name"
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={savingProject}
                onClick={() => void handleQuickSaveProject()}
                data-testid="quick-save-project-confirm"
              >
                {dict.ui.copy.save}
              </button>
            </div>
          )}

          {recents.length > 0 && (
            <div className="field">
              <span className="field-label">{dict.recentWorkspacesLabel}</span>
              <div className="chip-row">
                {recents.map((path) => (
                  <button key={path} type="button" className="chip-btn" title={path} onClick={() => setCwd(path)}>
                    <Icon icon={FolderOpen} size="xs" />
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

          <div className="field">
            <span className="field-label">{dict.ui.copy.executionMode}</span>
            <select
              className="input"
              aria-label={dict.ui.copy.executionModeForTheNew}
              value={modeDraft}
              onChange={(e) => setModeDraft(e.target.value as AgentExecutionMode | '')}
              disabled={creating}
              data-testid="new-session-mode-select"
            >
              <option value="">
                {matchedProject?.defaultMode
                  ? `${dict.ui.copy.projectDefault} · ${dict.executionModes[matchedProject.defaultMode]?.label ?? matchedProject.defaultMode}`
                  : dict.ui.copy.globalDefault}
              </option>
              {EXECUTION_MODE_ORDER.map((m) => (
                <option key={m} value={m}>
                  {m === 'full-access'
                    ? `${dict.executionModes[m].label} (full-access)`
                    : dict.executionModes[m].label}
                </option>
              ))}
            </select>
            {effectiveMode === 'full-access' && (
              <span className="field-hint turbo-field-hint" role="note" data-testid="new-session-turbo-hint">
                <Icon icon={Zap} size="xs" />
                {dict.ui.copy.turboFullAccessWithNo}
              </span>
            )}
          </div>

          <div className="field-row new-session-model-row">
            <label className="field">
              <span className="field-label">{v034.newSessionModelLabel}</span>
              <select
                className="input"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                disabled={creating}
                data-testid="new-session-model-select"
              >
                <option value="">{followModelLabel}</option>
                {availableModels.map((m) => (
                  <option key={m.modelId} value={m.modelId} title={m.description || m.modelId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{v034.newSessionEffortLabel}</span>
              <select
                className="input"
                value={effortDraft}
                onChange={(e) => setEffortDraft(e.target.value as AgentReasoningEffort | '')}
                disabled={creating}
                data-testid="new-session-effort-select"
              >
                <option value="">{v034.newSessionEffortFollow}</option>
                {REASONING_EFFORT_ORDER.map((ef) => (
                  <option key={ef} value={ef}>
                    {dict.effortLevels[ef]}
                  </option>
                ))}
              </select>
            </label>
            {availableModels.length === 0 && (
              <span className="field-hint" role="note" data-testid="new-session-model-pending">
                {v034.newSessionModelCatalogPending}
              </span>
            )}
          </div>

          {error && (
            <div role="alert" className="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={requestClose}
            disabled={creating}
            data-testid="new-session-cancel-btn"
          >
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

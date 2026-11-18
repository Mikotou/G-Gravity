import React, { useEffect, useState } from 'react';
import { Check, Cpu, Info, LogIn, LogOut, Plus, Puzzle, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import {
  APPROVAL_MODE_ORDER,
  COST_DISCLAIMER,
  DEFAULT_MODEL_RATE_CARDS,
  type AccountsStateSnapshot,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ExternalAiReviewerConfig,
  type McpActionInput,
  type ModelRateCard,
  type PluginActionInput,
  type PluginsManagerSnapshot,
} from '@shared';
import { useI18n } from '../../i18n/I18nContext';
import { formatActionError } from '../../i18n/locales';

/** 统一的忙碌 / 错误处理 */
function useAction() {
  const { dict } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 同一面板的操作复用忙碌状态，每次重试先清除上次错误，再把新的异常按当前语言显示。
  async function run(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}): React.ReactElement {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" />
    </label>
  );
}

/* ------------------------------------------------------------------ 账号 */

export function AccountsPanel({
  accounts,
  onCreateProfile,
  onSwitchProfile,
  onDeleteProfile,
  onLaunchLogin,
  onLogout,
}: {
  accounts: AccountsStateSnapshot;
  onCreateProfile: (name: string) => Promise<void>;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onLaunchLogin: (profileId?: string) => Promise<void>;
  onLogout: () => Promise<void>;
}): React.ReactElement {
  const { dict } = useI18n();
  const { busy, error, run } = useAction();
  const [name, setName] = useState('');
  // 连接标识来自 ACP 握手，Profile 名称来自本地账号清单，面板并列展示这两份信息。
  const identity = accounts.acpIdentity;
  const activeProfile = accounts.profiles.find((p) => p.profileId === accounts.activeProfileId);

  return (
    <div className="settings-section" data-testid="accounts-manager-modal">
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      <h3 className="settings-group-title">{dict.accountsIdentityTitle}</h3>
      <div className="settings-group">
        <div className="list-row">
          <span className={`status-dot ${identity.connected ? 'is-idle' : 'is-error'}`} />
          <div className="list-row-main">
            <div className="list-row-title">
              <span>{identity.agentName ?? 'agy acp'}</span>
              {identity.agentVersion && <span className="badge badge-mono">v{identity.agentVersion}</span>}
              {activeProfile && <span className="badge">{activeProfile.name}</span>}
              <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                {identity.connected ? dict.acpConnected : dict.acpDisconnected}
              </span>
            </div>
          </div>
          <div className="list-row-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void run(() => onLaunchLogin(accounts.activeProfileId))}
              data-testid="official-login-btn"
            >
              <LogIn size={13} />
              <span>{dict.officialLogin}</span>
            </button>
            {identity.supportsLogout && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void run(onLogout)}
                data-testid="official-logout-btn"
              >
                <LogOut size={13} />
                <span>{dict.officialLogout}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <h3 className="settings-group-title">{dict.accountsProfilesTitle}</h3>
      <div className="settings-group">
        {accounts.profiles.map((p) => {
          const active = p.profileId === accounts.activeProfileId;
          return (
            <div
              key={p.profileId}
              className="list-row"
              title={p.isolatedAppDataDir}
              data-testid={`profile-row-${p.profileId}`}
            >
              <span className="avatar">{p.name.trim().charAt(0).toUpperCase() || 'P'}</span>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{p.name}</span>
                  {active && (
                    <span className="badge badge-accent">
                      <Check size={10} />
                      {dict.accountsActiveLabel}
                    </span>
                  )}
                  {p.isDefault && <span className="badge">{dict.officialDefaultBadge}</span>}
                </div>
              </div>
              <div className="list-row-actions">
                {!active && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void run(() => onSwitchProfile(p.profileId))}
                    data-testid={`switch-profile-${p.profileId}`}
                  >
                    {dict.accountsSwitchBtn}
                  </button>
                )}
                {!p.isDefault && !active && (
                  <button
                    type="button"
                    className="icon-btn"
                    title={dict.accountsDeleteBtn}
                    aria-label={dict.accountsDeleteBtn}
                    disabled={busy}
                    onClick={() => void run(() => onDeleteProfile(p.profileId))}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(async () => {
            await onCreateProfile(name.trim());
            setName('');
          });
        }}
      >
        <input
          className="input"
          placeholder={dict.accountsCreatePlaceholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="create-profile-input"
        />
        <button type="submit" className="btn" disabled={busy || !name.trim()} data-testid="create-profile-btn">
          <Plus size={13} />
          <span>{dict.accountsCreateBtn}</span>
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ Approve for me */

type ApprovalTab = 'rules' | 'audit' | 'reviewer';
type PatternField = 'allowPatterns' | 'askPatterns' | 'denyPatterns';

export function ApprovalsPanel({
  config,
  auditEntries,
  onUpdateConfig,
}: {
  config: ApproveForMeConfig;
  auditEntries: ApprovalAuditEntry[];
  onUpdateConfig: (patch: Partial<ApproveForMeConfig>) => Promise<void>;
}): React.ReactElement {
  const { dict } = useI18n();
  const { busy, error, run } = useAction();
  const [tab, setTab] = useState<ApprovalTab>('rules');
  const [drafts, setDrafts] = useState<Record<PatternField, string>>({ allowPatterns: '', askPatterns: '', denyPatterns: '' });
  const [reviewer, setReviewer] = useState<ExternalAiReviewerConfig>(config.externalReviewer);

  useEffect(() => setReviewer(config.externalReviewer), [config.externalReviewer]);

  const groups: Array<{ field: PatternField; title: string; badge: string }> = [
    { field: 'allowPatterns', title: dict.allowRulesTitle, badge: 'badge-success' },
    { field: 'askPatterns', title: dict.askRulesTitle, badge: 'badge-warning' },
    { field: 'denyPatterns', title: dict.denyRulesTitle, badge: 'badge-danger' },
  ];

  /** 每类规则使用独立的输入草稿。将非空的新规则并入所选列表，提交发生异常时保留输入便于纠正。 */
  function addPattern(field: PatternField): void {
    const value = drafts[field].trim();
    if (!value) return;
    void run(async () => {
      if (!config[field].includes(value)) await onUpdateConfig({ [field]: [...config[field], value] });
      setDrafts((prev) => ({ ...prev, [field]: '' }));
    });
  }

  return (
    <div className="settings-section" data-testid="approval-drawer">
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      <div className="sub-tabs">
        {(
          [
            ['rules', dict.approvalTabRules],
            ['audit', dict.approvalTabAudit],
            ['reviewer', dict.approvalTabReviewer],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`sub-tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => setTab(key)}
            data-testid={`drawer-tab-${key}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'rules' && (
        <>
          <h3 className="settings-group-title">{dict.approvalModeLabel}</h3>
          <div className="settings-group">
            {APPROVAL_MODE_ORDER.map((mode) => (
              <button
                key={mode}
                type="button"
                className="setting-row"
                style={{ textAlign: 'left', minHeight: 42 }}
                disabled={busy}
                onClick={() => void run(() => onUpdateConfig({ mode }))}
                title={dict.approvalModes[mode].shortDesc}
                data-testid={`approval-mode-option-${mode}`}
              >
                <span className="setting-label">{dict.approvalModes[mode].label}</span>
                <span className="muted truncate" style={{ fontSize: 12 }}>
                  {dict.approvalModes[mode].shortDesc}
                </span>
                <span className="spacer" />
                {config.mode === mode && <Check size={16} color="var(--accent-primary)" />}
              </button>
            ))}
            <div className="setting-row" style={{ minHeight: 42 }} title={dict.safeDownloadDesc}>
              <span className="setting-label">{dict.safeDownloadToggle}</span>
              <span className="spacer" />
              <Switch
                checked={config.enableSafeDownloadAutoApprove}
                disabled={busy}
                label={dict.safeDownloadToggle}
                onChange={(v) => void run(() => onUpdateConfig({ enableSafeDownloadAutoApprove: v }))}
              />
            </div>
          </div>

          {groups.map((g) => (
            <React.Fragment key={g.field}>
              <h3 className="settings-group-title">
                <span className={`badge ${g.badge}`}>{g.title}</span>
              </h3>
              <div className="settings-group">
                {config[g.field].length === 0 ? (
                  <div className="pattern-row muted" style={{ fontFamily: 'var(--font-sans)' }}>
                    {dict.rulesEmpty}
                  </div>
                ) : (
                  config[g.field].map((pat) => (
                    <div key={pat} className="pattern-row">
                      <code className="truncate" style={{ flex: 1 }}>
                        {pat}
                      </code>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label={dict.deleteRuleBtn}
                        title={dict.deleteRuleBtn}
                        disabled={busy}
                        onClick={() =>
                          void run(() => onUpdateConfig({ [g.field]: config[g.field].filter((item) => item !== pat) }))
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <form
                className="inline-form"
                style={{ marginTop: -8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  addPattern(g.field);
                }}
              >
                <input
                  className="input input-mono"
                  placeholder={dict.addPatternPlaceholder}
                  value={drafts[g.field]}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [g.field]: e.target.value }))}
                />
                <button type="submit" className="btn btn-sm" disabled={busy || !drafts[g.field].trim()}>
                  <Plus size={12} />
                  <span>{dict.addRuleBtn}</span>
                </button>
              </form>
            </React.Fragment>
          ))}
        </>
      )}

      {tab === 'audit' && (
        <div className="settings-group">
          {auditEntries.length === 0 ? (
            <div className="empty-state">{dict.auditEmpty}</div>
          ) : (
            auditEntries.map((item) => (
              <div key={item.id} className="audit-row" data-testid={`audit-row-${item.id}`}>
                <div className="audit-head">
                  <span
                    className={`badge ${
                      item.verdict === 'denied' || item.verdict === 'rejected_with_feedback' ? 'badge-danger' : 'badge-success'
                    }`}
                  >
                    {dict.verdictLabels[item.verdict]}
                  </span>
                  <span className="muted">{dict.decisionSourceLabels[item.decisionSource]}</span>
                  <span className="spacer" />
                  <span className="muted mono">
                    {item.latencyMs}ms · {item.timestamp.replace('T', ' ').slice(5, 16)}
                  </span>
                </div>
                <code className="audit-cmd">{item.commandOrSummary}</code>
                {item.reason && <div className="list-row-desc">{item.reason}</div>}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'reviewer' && (
        <>
          <div className="settings-group" style={{ padding: '10px 14px', fontSize: 12, lineHeight: 1.55 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              双层零配额守卫架构（严格遵循合规红线 #6）
            </div>
            <div className="muted">
              • <strong>第一层（默认内置、0ms、零额度消耗）</strong>：本地多段 AST 语义引擎 + 密集命令批量守卫，自动放行只读文件/代码检索、多级管道筛选（如 <code>Get-ChildItem | Select-String</code>）及会话托管下的低风险构建测试命令。<br />
              • <strong>第二层（可选开启）</strong>：对接本机 <code>127.0.0.1:11434</code> Ollama 或自备公开 API Key 模型复核灰区命令（绝不调用隐藏订阅会话，API Key 仅驻留内存不落盘）。
            </div>
          </div>
          <div className="settings-group">
            <div className="setting-row" title={dict.reviewerComplianceBanner}>
              <span className="setting-label">{dict.reviewerEnableToggle}</span>
              <span className="spacer" />
              <Switch
                checked={reviewer.enabled}
                label={dict.reviewerEnableToggle}
                onChange={(v) => setReviewer((prev) => ({ ...prev, enabled: v }))}
              />
            </div>
            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerProviderLabel}</span>
              </span>
              <select
                className="input"
                style={{ width: 260 }}
                value={reviewer.provider}
                onChange={(e) => {
                  const nextProvider = e.target.value as ExternalAiReviewerConfig['provider'];
                  const defaultsByProvider: Record<
                    ExternalAiReviewerConfig['provider'],
                    { endpoint: string; model: string }
                  > = {
                    'gemini-api-key': {
                      endpoint: 'https://generativelanguage.googleapis.com',
                      model: 'gemini-2.5-flash-lite',
                    },
                    'openai-compatible': {
                      endpoint: 'https://api.openai.com',
                      model: 'gpt-4o-mini',
                    },
                    'local-ollama': {
                      endpoint: 'http://127.0.0.1:11434',
                      model: 'qwen2.5-coder:7b',
                    },
                  };
                  setReviewer((prev) => ({
                    ...prev,
                    provider: nextProvider,
                    endpoint: defaultsByProvider[nextProvider].endpoint,
                    model: defaultsByProvider[nextProvider].model,
                  }));
                }}
              >
                <option value="gemini-api-key">{dict.reviewerProviderGemini}</option>
                <option value="openai-compatible">{dict.reviewerProviderOpenAi}</option>
                <option value="local-ollama">{dict.reviewerProviderOllama}</option>
              </select>
            </div>
            {(
              [
                ['endpoint', dict.reviewerEndpointLabel, 'text'],
                ['model', dict.reviewerModelLabel, 'text'],
                ...(reviewer.provider === 'local-ollama'
                  ? ([] as const)
                  : ([['apiKey', dict.reviewerApiKeyLabel, 'password']] as const)),
              ] as const
            ).map(([field, label, type]) => (
              <div key={field} className="setting-row">
                <span className="setting-text">
                  <span className="setting-label">{label}</span>
                </span>
                <input
                  className="input input-mono"
                  style={{ width: 260 }}
                  type={type}
                  value={(reviewer[field] as string | undefined) ?? ''}
                  onChange={(e) => setReviewer((prev) => ({ ...prev, [field]: e.target.value }))}
                  aria-label={label}
                />
              </div>
            ))}
            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerTimeoutLabel}</span>
              </span>
              <input
                className="input input-mono"
                style={{ width: 120 }}
                type="number"
                min={500}
                step={100}
                value={reviewer.timeoutMs}
                onChange={(e) => setReviewer((prev) => ({ ...prev, timeoutMs: Math.max(0, Number(e.target.value) || 0) }))}
                aria-label={dict.reviewerTimeoutLabel}
              />
            </div>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void run(() => onUpdateConfig({ externalReviewer: reviewer }))}
              data-testid="save-reviewer-config-btn"
            >
              {dict.saveReviewerBtn}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Plugins */

type PluginsTab = 'builtins' | 'plugins' | 'mcp' | 'skills';

export function PluginsPanel({
  snapshot,
  onRunPluginAction,
  onRunMcpAction,
  onToggleSkill,
}: {
  snapshot: PluginsManagerSnapshot;
  onRunPluginAction: (input: PluginActionInput) => Promise<void>;
  onRunMcpAction: (input: McpActionInput) => Promise<void>;
  onToggleSkill: (skillId: string, enabled: boolean) => Promise<void>;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const { busy, error, run } = useAction();
  const [tab, setTab] = useState<PluginsTab>('builtins');
  const [target, setTarget] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpType, setMcpType] = useState<'stdio' | 'http'>('stdio');
  const [mcpCmd, setMcpCmd] = useState('');

  const tabs: Array<[PluginsTab, string, number]> = [
    ['builtins', dict.pluginsTabBuiltins, snapshot.builtins.length],
    ['plugins', dict.pluginsTabPlugins, snapshot.plugins.length],
    ['mcp', dict.pluginsTabMcp, snapshot.mcpServers.length],
    ['skills', dict.pluginsTabSkills, snapshot.skills.length],
  ];

  return (
    <div className="settings-section" data-testid="plugins-manager-modal">
      <div className="sub-tabs">
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            className={`sub-tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => setTab(key)}
            data-testid={`plugins-tab-${key}`}
          >
            {label}
            {count > 0 && <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>{count}</span>}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      {tab === 'builtins' && (
        <div className="settings-group">
          {snapshot.builtins.map((b) => (
            <div
              key={b.id}
              className="list-row"
              title={locale === 'zh-CN' ? b.descriptionZh : b.descriptionEn}
              data-testid={`builtin-item-${b.id}`}
            >
              <span className="list-icon" style={{ width: 28, height: 28 }}>
                <Sparkles size={15} />
              </span>
              <div className="list-row-main">
                <div className="list-row-title">
                  <span>{b.name}</span>
                  <span className="badge badge-accent">{b.badge}</span>
                </div>
              </div>
              <span className="badge badge-success">{dict.activeLabel}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'plugins' && (
        <>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!target.trim()) return;
              void run(async () => {
                await onRunPluginAction({ action: 'install', target: target.trim() });
                setTarget('');
              });
            }}
          >
            <input
              className="input input-mono"
              placeholder={dict.pluginInstallPlaceholder}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="plugin-install-input"
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !target.trim()} data-testid="plugin-install-btn">
              <Plus size={13} />
              <span>{dict.pluginInstallBtn}</span>
            </button>
          </form>
          <div className="settings-group">
            {snapshot.plugins.length === 0 ? (
              <div className="empty-state">{dict.pluginsEmpty}</div>
            ) : (
              snapshot.plugins.map((pl) => (
                <div key={pl.name} className="list-row" data-testid={`plugin-row-${pl.name}`}>
                  <span className="list-icon">
                    <Puzzle size={16} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span className="mono">{pl.name}</span>
                      {pl.version && <span className="badge badge-mono">v{pl.version}</span>}
                      {pl.marketplace && <span className="badge">{pl.marketplace}</span>}
                    </div>
                    {pl.description && <div className="list-row-desc">{pl.description}</div>}
                  </div>
                  <div className="list-row-actions">
                    <Switch
                      checked={pl.enabled}
                      disabled={busy}
                      label={pl.enabled ? dict.pluginDisableBtn : dict.pluginEnableBtn}
                      onChange={(v) => void run(() => onRunPluginAction({ action: v ? 'enable' : 'disable', target: pl.name }))}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title={dict.pluginUninstallBtn}
                      aria-label={dict.pluginUninstallBtn}
                      disabled={busy}
                      onClick={() => void run(() => onRunPluginAction({ action: 'uninstall', target: pl.name }))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'mcp' && (
        <>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!mcpName.trim() || !mcpCmd.trim()) return;
              void run(async () => {
                // stdio 表单按空白拆分程序和参数，HTTP 类型则保留完整地址。主进程收到的是分别标记过的字段。
                const parts = mcpCmd.trim().split(/\s+/);
                await onRunMcpAction({
                  action: 'add',
                  name: mcpName.trim(),
                  type: mcpType,
                  commandOrUrl: mcpType === 'http' ? mcpCmd.trim() : parts[0],
                  args: mcpType === 'http' ? [] : parts.slice(1),
                });
                setMcpName('');
                setMcpCmd('');
              });
            }}
          >
            <input
              className="input input-mono"
              style={{ flex: '0 0 140px' }}
              placeholder={dict.mcpNamePlaceholder}
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
              data-testid="mcp-name-input"
            />
            <select
              className="input"
              style={{ flex: '0 0 86px' }}
              value={mcpType}
              onChange={(e) => setMcpType(e.target.value as 'stdio' | 'http')}
              aria-label="type"
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
            <input
              className="input input-mono"
              placeholder={dict.mcpCmdPlaceholder}
              value={mcpCmd}
              onChange={(e) => setMcpCmd(e.target.value)}
              data-testid="mcp-cmd-input"
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !mcpName.trim() || !mcpCmd.trim()}
              data-testid="mcp-add-btn"
            >
              <Plus size={13} />
              <span>{dict.mcpAddBtn}</span>
            </button>
          </form>
          <div className="settings-group">
            {snapshot.mcpServers.length === 0 ? (
              <div className="empty-state">{dict.mcpEmpty}</div>
            ) : (
              snapshot.mcpServers.map((srv) => (
                <div key={srv.name} className="list-row" data-testid={`mcp-row-${srv.name}`}>
                  <span className="list-icon">
                    <Cpu size={16} />
                  </span>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      <span className="mono">{srv.name}</span>
                      <span className="badge badge-mono">{srv.type}</span>
                      {srv.status && <span className="badge">{srv.status}</span>}
                    </div>
                    <div className="list-row-desc mono truncate">
                      {srv.commandOrUrl} {srv.args.join(' ')}
                    </div>
                  </div>
                  <div className="list-row-actions">
                    <Switch
                      checked={srv.enabled}
                      disabled={busy}
                      label={srv.enabled ? dict.pluginDisableBtn : dict.pluginEnableBtn}
                      onChange={(v) => void run(() => onRunMcpAction({ action: v ? 'enable' : 'disable', name: srv.name }))}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title={dict.mcpRemoveBtn}
                      aria-label={dict.mcpRemoveBtn}
                      disabled={busy}
                      onClick={() => void run(() => onRunMcpAction({ action: 'remove', name: srv.name }))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'skills' && (
        <div className="settings-group">
          {snapshot.skills.length === 0 ? (
            <div className="empty-state">{dict.skillsEmpty}</div>
          ) : (
            snapshot.skills.map((sk) => (
              <div key={sk.id} className="list-row" data-testid={`skill-row-${sk.name}`}>
                <span className="list-icon">
                  <Wand2 size={16} />
                </span>
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span className="mono">{sk.name}</span>
                    <span className="badge">{sk.scope}</span>
                  </div>
                  <div className="list-row-desc">{sk.description}</div>
                </div>
                <Switch
                  checked={sk.enabled}
                  disabled={busy}
                  label={sk.name}
                  onChange={(v) => void run(() => onToggleSkill(sk.id, v))}
                />
              </div>
            ))
          )}
        </div>
      )}

      {snapshot.lastCommandOutput && !snapshot.lastCommandOutput.startsWith('Ready ') && (
        <div className="field">
          <span className="field-label">{dict.lastCommandLabel}</span>
          <div className="code-line">$ {snapshot.lastCommandOutput}</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 单价 */

export function RatesPanel({
  rateCards,
  onUpdateRateCards,
}: {
  rateCards: ModelRateCard[];
  onUpdateRateCards: (cards: ModelRateCard[]) => Promise<void>;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const { busy, error, run } = useAction();
  // 编辑单价使用逐行复制的草稿，保存后再接收新的价卡快照，输入过程不会直接修改看板使用的单价。
  const [draft, setDraft] = useState<ModelRateCard[]>(rateCards.map((r) => ({ ...r })));
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(rateCards.map((r) => ({ ...r }))), [rateCards]);

  const fields = [
    ['inputPerMillionUsd', 'Input'],
    ['cachedInputPerMillionUsd', 'Cached'],
    ['outputPerMillionUsd', 'Output'],
    ['thinkingPerMillionUsd', 'Thinking'],
  ] as const;

  return (
    <div className="settings-section" data-testid="rate-cards-editor">
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      <div className="settings-group">
        <div className="rate-grid is-head">
          <span>{dict.rateColModel}</span>
          {fields.map(([, label]) => (
            <span key={label}>{label} $/1M</span>
          ))}
        </div>
        {draft.map((card, idx) => (
          <div key={card.modelId} className="rate-grid">
            <span className="rate-model" title={card.modelId}>
              <strong className="truncate">{card.displayName}</strong>
            </span>
            {fields.map(([field]) => (
              <input
                key={field}
                type="number"
                min={0}
                step={0.01}
                className="input input-mono"
                value={card[field]}
                onChange={(e) => {
                  const val = Math.max(0, Number(e.target.value) || 0);
                  setSaved(false);
                  setDraft((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
                }}
                aria-label={`${card.modelId} ${field}`}
                data-testid={`rate-${card.modelId}-${field}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="disclaimer">
          <Info size={11} />
          {COST_DISCLAIMER[locale]}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setDraft(DEFAULT_MODEL_RATE_CARDS.map((c) => ({ ...c })))}>
          {dict.rateCardsResetBtn}
        </button>
        {saved && <span className="badge badge-success">{dict.savedHint}</span>}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await onUpdateRateCards(draft);
              setSaved(true);
            })
          }
          data-testid="save-rate-cards-btn"
        >
          {dict.rateCardsSaveBtn}
        </button>
      </div>
    </div>
  );
}

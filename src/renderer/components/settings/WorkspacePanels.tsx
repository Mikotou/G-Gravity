import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Cpu, Info, LogIn, LogOut, Plus, Puzzle, RefreshCw, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import {
  APPROVAL_MODE_ORDER,
  APPROVAL_POLICY_DEFAULTS,
  COST_DISCLAIMER,
  DEFAULT_MODEL_RATE_CARDS,
  EXTERNAL_REVIEWER_DEFAULTS,
  formatExternalReviewerProviderLabel,
  inferSupportedThinkingLevels,
  hasReviewerConnectionSettings,
  isExternalReviewerConnected,
  sameReviewerSettings,
  parseMcpCommandLine,
  sameExternalService,
  type AccountsStateSnapshot,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ExternalAiReviewerConfig,
  type ExternalReviewerModelOption,
  type ExternalReviewerTelemetrySnapshot,
  type ExternalReviewerThinkingLevel,
  type McpActionInput,
  type ModelRateCard,
  type PluginActionInput,
  type PluginsManagerSnapshot,
} from '@shared';
import { useI18n } from '../../i18n/I18nContext';
import { formatActionError } from '../../i18n/locales';
import { getDesktopBridge } from '../../services/desktop-bridge';
import { DraftNumberInput } from './DraftNumberInput';
import { formatTokenShort, formatUsd } from '../ContextStatusBar';
import { formatLocalDateTime } from '../../lib/time-format';
import { isImeComposing } from '../../lib/platform-keys';
import { Icon } from '../ui/Icon';
import { projectApiKeyForSubmit } from '../../lib/api-key-projection';
import { useSettingsDirty } from './settings-dirty';

/** v0.3.2：符合意图的高风险放行评分上限可配置范围（默认 90，覆盖全部 high 风险区间）。 */
const ALIGNED_HIGH_RISK_SCORE_RANGE = { min: 60, max: 100 } as const;

function clampAlignedHighRiskScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return APPROVAL_POLICY_DEFAULTS.alignedHighRiskMaxScore;
  return Math.max(ALIGNED_HIGH_RISK_SCORE_RANGE.min, Math.min(ALIGNED_HIGH_RISK_SCORE_RANGE.max, Math.round(n)));
}

/** 读取 v0.3.2 放行策略的生效值（缺省字段按共享层默认值补齐）。 */
function resolveApprovalPolicy(config: ApproveForMeConfig): Required<Pick<ApproveForMeConfig, 'allowAlignedHighRiskPass' | 'alignedHighRiskMaxScore' | 'fastPassLowRiskDev'>> {
  return {
    allowAlignedHighRiskPass: config.allowAlignedHighRiskPass ?? APPROVAL_POLICY_DEFAULTS.allowAlignedHighRiskPass,
    alignedHighRiskMaxScore: clampAlignedHighRiskScore(config.alignedHighRiskMaxScore ?? APPROVAL_POLICY_DEFAULTS.alignedHighRiskMaxScore),
    fastPassLowRiskDev: config.fastPassLowRiskDev ?? APPROVAL_POLICY_DEFAULTS.fastPassLowRiskDev,
  };
}

/** 命令输出超过该长度时不再尝试格式化，直接按原文等宽显示。 */
const COMMAND_OUTPUT_FORMAT_LIMIT = 200_000;

/**
 * 把 CLI 输出整理成便于阅读的文本：整段（或以空白分隔的多段）合法 JSON 会被缩进格式化，
 * 其他内容原样返回。纯函数，只做字符串处理，不执行任何内容。
 */
function formatCommandOutput(raw: string): { text: string; json: boolean } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > COMMAND_OUTPUT_FORMAT_LIMIT || !/^[[{]/.test(trimmed)) return { text: raw, json: false };
  const segments: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (ch === '{' || ch === '[') {
        start = i;
        depth = 1;
      } else if (!/\s/.test(ch)) {
        return { text: raw, json: false };
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) segments.push(trimmed.slice(start, i + 1));
    }
  }
  if (depth !== 0 || segments.length === 0) return { text: raw, json: false };
  try {
    return { text: segments.map((seg) => JSON.stringify(JSON.parse(seg), null, 2)).join('\n\n'), json: true };
  } catch {
    return { text: raw, json: false };
  }
}

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
  id,
  describedBy,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
  describedBy?: string;
}): React.ReactElement {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        id={id}
        data-testid={id}
        aria-describedby={describedBy}
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
              <span className="muted settings-title-aside">
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
              <Icon icon={LogIn} size="sm" />
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
                <Icon icon={LogOut} size="sm" />
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
                      <Icon icon={Check} size="xs" />
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
                    <Icon icon={Trash2} size="sm" />
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
          <Icon icon={Plus} size="sm" />
          <span>{dict.accountsCreateBtn}</span>
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ Approve for me */

export type ApprovalTab = 'rules' | 'audit' | 'reviewer';
type PatternField = 'allowPatterns' | 'askPatterns' | 'denyPatterns';

/** 外部复核超时下限：输入框与保存/测试请求统一为 500ms，避免过短超时导致复核必然失败。 */
const REVIEWER_TIMEOUT_MIN_MS = 500;

function reviewerRequestSettings(draft: ExternalAiReviewerConfig, model: ExternalReviewerModelOption): ExternalAiReviewerConfig {
  const level = draft.thinkingLevel ?? 'auto';
  return {
    ...draft,
    thinkingLevel: model.supportedThinkingLevels.includes(level) ? level : 'auto',
    timeoutMs: Math.max(REVIEWER_TIMEOUT_MIN_MS, Math.min(60000, draft.timeoutMs || EXTERNAL_REVIEWER_DEFAULTS.timeoutMs)),
    maxOutputTokens: Math.max(64, Math.min(model.outputTokenLimit || 65536, 65536, draft.maxOutputTokens || EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens)),
  };
}

export function ApprovalsPanel({
  config,
  auditEntries,
  initialTab = 'rules',
  externalReviewerTelemetry,
  currentSessionId,
  onUpdateConfig,
}: {
  config: ApproveForMeConfig;
  auditEntries: ApprovalAuditEntry[];
  initialTab?: ApprovalTab;
  externalReviewerTelemetry?: ExternalReviewerTelemetrySnapshot;
  currentSessionId?: string | null;
  onUpdateConfig: (patch: Partial<ApproveForMeConfig>) => Promise<void>;
}): React.ReactElement {
  const { locale, dict } = useI18n();
  const { busy, error, run } = useAction();
  const [tab, setTab] = useState<ApprovalTab>(initialTab);
  const [hybridConnectPrompt, setHybridConnectPrompt] = useState(false);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const [drafts, setDrafts] = useState<Record<PatternField, string>>({ allowPatterns: '', askPatterns: '', denyPatterns: '' });
  const normalizeReviewer = (raw: ExternalAiReviewerConfig): ExternalAiReviewerConfig => ({
    ...raw,
    timeoutMs: raw.timeoutMs || EXTERNAL_REVIEWER_DEFAULTS.timeoutMs,
    maxOutputTokens: raw.maxOutputTokens || EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens,
    thinkingLevel: raw.thinkingLevel ?? EXTERNAL_REVIEWER_DEFAULTS.thinkingLevel,
  });
  const [reviewer, applyReviewer] = useState<ExternalAiReviewerConfig>(() => normalizeReviewer(config.externalReviewer));
  const reviewerRef = useRef(reviewer);
  const previousConfig = useRef(config.externalReviewer);
  const testVersion = useRef(0);
  const [testing, setTesting] = useState(false);
  const [reviewerNotice, setReviewerNotice] = useState<{ text: string; error?: boolean }>();
  const [activationRequested, setActivationRequested] = useState(false);
  const [savingReviewer, setSavingReviewer] = useState(false);
  const savingRef = useRef(false);
  const verified = isExternalReviewerConnected({ ...reviewer, enabled: true });
  const activeReviewer = isExternalReviewerConnected(config.externalReviewer);
  const discoveryReady = hasReviewerConnectionSettings({ ...reviewer, model: 'probe' });
  // D4：主进程仅返回 hasApiKey。同 provider + origin 时留空即沿用已存密钥；显式清除需点击「清除密钥」。
  const [reviewerKeyCleared, setReviewerKeyCleared] = useState(false);
  const savedReviewerKey =
    Boolean(config.externalReviewer.hasApiKey) && sameExternalService(config.externalReviewer, reviewer) && !reviewerKeyCleared;
  const reviewerKeyNeedsReentry =
    Boolean(config.externalReviewer.hasApiKey) &&
    !sameExternalService(config.externalReviewer, reviewer) &&
    !reviewer.apiKey?.trim();
  const v034 = dict.ui.v034;
  // F-10：复核连接草稿未保存时，关闭设置前需确认。
  useSettingsDirty('approvals-reviewer', !sameReviewerSettings(normalizeReviewer(config.externalReviewer), reviewer) || reviewerKeyCleared);
  const [cacheTtlHours, setCacheTtlHours] = useState<number>(config.cacheTtlHours ?? EXTERNAL_REVIEWER_DEFAULTS.cacheTtlHours);
  // P3-1：输入框使用受控字符串草稿，允许清空后重输（不再回弹 0 形成「048」），失焦 / 回车时再解析钳制。
  const [cacheTtlText, setCacheTtlText] = useState<string>(() => String(config.cacheTtlHours ?? EXTERNAL_REVIEWER_DEFAULTS.cacheTtlHours));
  const cacheTtlTextRef = useRef(cacheTtlText);
  cacheTtlTextRef.current = cacheTtlText;
  const cacheTtlRef = useRef(cacheTtlHours);
  cacheTtlRef.current = cacheTtlHours;
  /** 解析当前缓存时长草稿：空值或非法值回退到上一次有效值，合法值钳制到 0–168 小时。 */
  function resolveCacheTtl(): number {
    const raw = cacheTtlTextRef.current.trim();
    const n = raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(168, Math.round(n))) : cacheTtlRef.current;
  }
  function commitCacheTtlText(): number {
    const next = resolveCacheTtl();
    cacheTtlRef.current = next;
    cacheTtlTextRef.current = String(next);
    setCacheTtlHours(next);
    setCacheTtlText(String(next));
    return next;
  }
  const [discoveredModels, setDiscoveredModels] = useState<ExternalReviewerModelOption[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [customModelMode, setCustomModelMode] = useState(false);
  /**
   * 切换服务商时自动填入的默认模型名（例如 openai-compatible 的 gpt-4o-mini）。
   * 用户尚未改动它时，查询到的模型列表若不含该名称，会直接选中列表第一项并显示下拉框；
   * 已保存或用户亲手输入的自定义模型（置为 null）始终保持原值与文本输入框。
   */
  const placeholderModelRef = useRef<string | null>(null);
  const discoverySeqRef = useRef(0);
  const lastAutoDiscoveryKeyRef = useRef('');

  useEffect(() => {
    if (tab !== 'reviewer') {
      setTesting(false);
      setActivationRequested(false);
    }
    return () => { ++testVersion.current; };
  }, [tab]);

  function setReviewer(update: React.SetStateAction<ExternalAiReviewerConfig>): void {
    const prev = reviewerRef.current;
    let next = typeof update === 'function' ? update(prev) : update;
    if (!sameReviewerSettings(prev, next)) {
      ++testVersion.current;
      setTesting(false);
      setReviewerNotice(undefined);
      next = { ...next, enabled: false, connectionStatus: 'untested', verificationMethod: undefined, lastVerifiedAt: undefined };
    }
    reviewerRef.current = next;
    applyReviewer(next);
  }

  useEffect(() => {
    const previous = previousConfig.current;
    const next = config.externalReviewer;
    previousConfig.current = next;
    if (sameReviewerSettings(previous, next) && previous.enabled === next.enabled &&
        previous.connectionStatus === next.connectionStatus && previous.lastVerifiedAt === next.lastVerifiedAt &&
        previous.verificationMethod === next.verificationMethod) return;
    const hasDraft = !sameReviewerSettings(reviewerRef.current, previous);
    const sameDraftSettings = sameReviewerSettings(reviewerRef.current, next);
    if (hasDraft && !sameDraftSettings) return;
    if (!sameDraftSettings) {
      ++testVersion.current;
      setTesting(false);
      setReviewerNotice(undefined);
      resetReviewerDiscovery();
    }
    placeholderModelRef.current = null;
    setReviewerKeyCleared(false);
    reviewerRef.current = normalizeReviewer(next);
    applyReviewer(reviewerRef.current);
  }, [config.externalReviewer]);
  useEffect(() => {
    const next = config.cacheTtlHours ?? EXTERNAL_REVIEWER_DEFAULTS.cacheTtlHours;
    setCacheTtlHours(next);
    setCacheTtlText(String(next));
  }, [config.cacheTtlHours]);

  // v0.3.2 放行策略：开关即时保存；评分上限滑块先写草稿，松手 / 失焦 / 键盘调整后提交一次。
  const policy = resolveApprovalPolicy(config);
  const [scoreDraft, setScoreDraft] = useState<number>(policy.alignedHighRiskMaxScore);
  const scoreDraftRef = useRef(scoreDraft);
  scoreDraftRef.current = scoreDraft;
  // P3-1：数字输入框的字符串草稿，与滑块数值草稿分离，输入过程可清空重输。
  const [scoreText, setScoreText] = useState<string>(String(policy.alignedHighRiskMaxScore));
  const scoreTextRef = useRef(scoreText);
  scoreTextRef.current = scoreText;
  const [policyNotice, setPolicyNotice] = useState<string>();
  useEffect(() => {
    const next = clampAlignedHighRiskScore(config.alignedHighRiskMaxScore ?? APPROVAL_POLICY_DEFAULTS.alignedHighRiskMaxScore);
    setScoreDraft(next);
    setScoreText(String(next));
  }, [config.alignedHighRiskMaxScore]);
  function savePolicy(patch: Partial<ApproveForMeConfig>): void {
    setPolicyNotice(undefined);
    void run(async () => {
      await onUpdateConfig(patch);
      setPolicyNotice(dict.ui.v032.policySaved);
    });
  }
  /** 数字输入框失焦 / 回车：解析字符串草稿（空值或非法值回退到当前生效值），钳制后交给统一提交。 */
  function commitScoreText(): void {
    const raw = scoreTextRef.current.trim();
    const n = raw === '' ? NaN : Number(raw);
    scoreDraftRef.current = Number.isFinite(n) ? n : policy.alignedHighRiskMaxScore;
    commitScoreDraft();
  }
  function commitScoreDraft(): void {
    const next = clampAlignedHighRiskScore(scoreDraftRef.current);
    scoreDraftRef.current = next;
    scoreTextRef.current = String(next);
    setScoreDraft(next);
    setScoreText(String(next));
    if (next === policy.alignedHighRiskMaxScore && config.alignedHighRiskMaxScore !== undefined) return;
    savePolicy({ alignedHighRiskMaxScore: next });
  }

  async function saveReviewer(draft: ExternalAiReviewerConfig, action: 'enable' | 'disable' | 'save'): Promise<void> {
    if (savingRef.current) return;
    const enabling = action === 'enable';
    const keepEnabled = action === 'save' && activeReviewer && isExternalReviewerConnected({ ...draft, enabled: true });
    const next = projectApiKeyForSubmit({ ...draft, enabled: enabling || keepEnabled }, reviewerKeyCleared);
    const sequence = testVersion.current;
    savingRef.current = true;
    setSavingReviewer(true);
    setReviewerNotice(undefined);
    try {
      // FE-05：启用 / 测试并启用 / 保存都携带缓存时长与 v0.3.2 放行策略，不再只在独立保存时才发送。
      await onUpdateConfig({
        ...(enabling && !activeReviewer && config.mode !== 'hybrid' ? { mode: 'hybrid' as const } : {}),
        cacheTtlHours: commitCacheTtlText(),
        allowAlignedHighRiskPass: policy.allowAlignedHighRiskPass,
        alignedHighRiskMaxScore: clampAlignedHighRiskScore(scoreDraftRef.current),
        fastPassLowRiskDev: policy.fastPassLowRiskDev,
        externalReviewer: next,
      });
      if (sequence !== testVersion.current) return;
      // D4 + F-10：保存成功后立即清空渲染层输入框中的明文 apiKey 草稿并复位清除标记，避免残留明文或误判「未保存草稿」。
      const nextHasKey = Boolean(next.apiKey?.trim()) || (Boolean(config.externalReviewer.hasApiKey) && sameExternalService(config.externalReviewer, next) && !reviewerKeyCleared);
      const savedProjected: ExternalAiReviewerConfig = { ...next, apiKey: undefined, hasApiKey: nextHasKey };
      if (sameReviewerSettings(reviewerRef.current, next)) setReviewer(savedProjected);
      setReviewerKeyCleared(false);
      setActivationRequested(false);
      const text = action === 'save' ? (dict.ui.copy.reviewSettingsSaved)
        : enabling ? (dict.ui.copy.externalReviewEnabled)
        : (dict.ui.copy.externalReviewTurnedOff);
      setReviewerNotice({ text });
    } catch (err) {
      if (sequence === testVersion.current) setReviewerNotice({ text: formatActionError(err, dict), error: true });
    } finally {
      savingRef.current = false;
      setSavingReviewer(false);
    }
  }

  async function testReviewer(enableAfterTest = false): Promise<void> {
    if (testing || savingRef.current) return;
    setReviewer(reviewerRequestSettings(reviewerRef.current, selectedModelMeta));
    const draft = reviewerRef.current;
    const seq = ++testVersion.current;
    setTesting(true);
    setReviewerNotice(undefined);
    try {
      const result = await getDesktopBridge().testExternalReviewerConnection(projectApiKeyForSubmit(draft, reviewerKeyCleared));
      if (seq !== testVersion.current) return;
      const ok = result.ok && Number.isFinite(Date.parse(result.verifiedAt || ''));
      const checked: ExternalAiReviewerConfig = { ...draft, enabled: ok && draft.enabled, connectionStatus: ok ? 'connected' : 'failed',
        verificationMethod: ok ? 'review-call' : undefined, lastVerifiedAt: ok ? result.verifiedAt : undefined };
      setReviewer(checked);
      if (ok && enableAfterTest) await saveReviewer(checked, 'enable');
      else setReviewerNotice({ text: result.ok && !ok ? (dict.ui.copy.reviewVerificationWasIncompleteTry) : result.message, error: !ok });
    } catch (err) {
      if (seq !== testVersion.current) return;
      setReviewer(prev => ({ ...prev, enabled: false, connectionStatus: 'failed', verificationMethod: undefined, lastVerifiedAt: undefined }));
      setReviewerNotice({ text: formatActionError(err, dict), error: true });
    } finally {
      if (seq === testVersion.current) setTesting(false);
    }
  }

  function resetReviewerDiscovery(): void {
    ++discoverySeqRef.current;
    lastAutoDiscoveryKeyRef.current = '';
    setDiscovering(false);
    setDiscoveredModels([]);
    setDiscoverError(null);
  }

  const fetchServerModels = useCallback(
    async (
      provider: ExternalAiReviewerConfig['provider'],
      endpoint: string,
      apiKey?: string
    ): Promise<void> => {
      const seq = ++discoverySeqRef.current;
      setDiscovering(true);
      setDiscoverError(null);
      try {
        const result = await getDesktopBridge().discoverExternalReviewerModels({
          provider,
          endpoint: endpoint.trim(),
          apiKey: apiKey?.trim() || undefined,
        });
        if (seq !== discoverySeqRef.current) return;
        setDiscoveredModels(result.models);
        const current = reviewerRef.current;
        const selected = result.models.find(model => model.id === current.model);
        const draftModel = current.model?.trim() ?? '';
        const untouchedPlaceholder =
          !draftModel || (placeholderModelRef.current !== null && current.model === placeholderModelRef.current);
        if (!selected && untouchedPlaceholder && result.models.length > 0) {
          // 默认占位模型不在服务端列表里：直接选中第一项并显示下拉框，用户仍可在下拉中选择“自定义”。
          const picked = result.models[0];
          const aligned = reviewerRequestSettings({ ...current, model: picked.id }, picked);
          placeholderModelRef.current = picked.id;
          setCustomModelMode(false);
          setReviewer({
            ...current,
            model: picked.id,
            thinkingLevel: aligned.thinkingLevel,
            maxOutputTokens: aligned.maxOutputTokens,
          });
          return;
        }
        setCustomModelMode(!selected);
        if (selected) {
          const aligned = reviewerRequestSettings(current, selected);
          const exceedsLimit = selected.outputTokenLimit && (current.maxOutputTokens ?? EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens) > selected.outputTokenLimit;
          if (exceedsLimit || aligned.thinkingLevel !== (current.thinkingLevel ?? 'auto')) {
            setReviewer({ ...current, maxOutputTokens: exceedsLimit ? aligned.maxOutputTokens : current.maxOutputTokens, thinkingLevel: aligned.thinkingLevel });
            setReviewerNotice({ text: dict.ui.v034.reviewerAdjusted });
          }
        }
      } catch (err) {
        if (seq !== discoverySeqRef.current) return;
        setDiscoverError(formatActionError(err, dict));
      } finally {
        if (seq === discoverySeqRef.current) setDiscovering(false);
      }
    },
    [dict, locale]
  );

  // 用户在复核页填完 API Key（或切到本地 Ollama）后自动防抖查询服务端允许的模型与思考强度。
  useEffect(() => {
    if (tab !== 'reviewer') return;
    const ep = reviewer.endpoint.trim();
    const key = reviewer.apiKey?.trim() || '';
    const readyToProbe = hasReviewerConnectionSettings({ provider: reviewer.provider, endpoint: ep, model: 'probe',
      apiKey: key.length >= 16 ? key : undefined, hasApiKey: !key && reviewer.hasApiKey });
    if (!readyToProbe) return;
    const probeKey = `${reviewer.provider}\0${ep}\0${key}`;
    if (probeKey === lastAutoDiscoveryKeyRef.current) return;
    const timer = window.setTimeout(() => {
      if (lastAutoDiscoveryKeyRef.current === probeKey) return;
      lastAutoDiscoveryKeyRef.current = probeKey;
      void fetchServerModels(reviewer.provider, ep, key);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [tab, reviewer.provider, reviewer.endpoint, reviewer.apiKey, fetchServerModels]);

  const selectedModelMeta = useMemo<ExternalReviewerModelOption>(() => {
    const found = discoveredModels.find((m) => m.id === reviewer.model);
    if (found) return found;
    const inferred = inferSupportedThinkingLevels(reviewer.provider, reviewer.model);
    return {
      id: reviewer.model,
      displayName: reviewer.model,
      ...inferred,
    };
  }, [discoveredModels, reviewer.model, reviewer.provider]);

  function changeReviewerEnabled(enabled: boolean): void {
    if (!enabled) {
      void saveReviewer(config.externalReviewer, 'disable');
      return;
    }
    setReviewer(reviewerRequestSettings(reviewerRef.current, selectedModelMeta));
    const draft = reviewerRef.current;
    if (isExternalReviewerConnected({ ...draft, enabled: true })) {
      void saveReviewer(draft, 'enable');
    } else {
      setReviewerNotice(undefined);
      setActivationRequested(true);
    }
  }

  const canTestReviewer = hasReviewerConnectionSettings(reviewer);
  const reviewerWorking = busy || testing || savingReviewer;
  function reviewerActivationHint(): string {
    if (savingReviewer) return dict.ui.copy.savingReviewSettings;
    if (testing) return dict.ui.copy.fmtTestingAReviewWith(reviewer.model);
    if (reviewerNotice) return reviewerNotice.text;
    if (activeReviewer) {
      if (!sameReviewerSettings(config.externalReviewer, reviewer)) return dict.ui.copy.fmtCurrentlyUsingTestThe(config.externalReviewer.model);
      return dict.ui.copy.fmtCurrentlyUsing(config.externalReviewer.model);
    }
    if (!canTestReviewer && activationRequested) return dict.ui.copy.enterAValidEndpointAnd;
    if (verified) return dict.ui.copy.testPassedTurnOnTo;
    if (activationRequested) return dict.ui.copy.fmtSendOneSampleReview(reviewer.model);
    return dict.ui.copy.turnOnToTestThe;
  }

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
            {APPROVAL_MODE_ORDER.map((mode) => {
              const reviewerReady = isExternalReviewerConnected(config.externalReviewer);
              const lockedHybrid = mode === 'hybrid' && !reviewerReady;
              return (
                <button
                  key={mode}
                  type="button"
                  className="setting-row setting-row-option"
                  disabled={busy}
                  onClick={() => {
                    if (lockedHybrid) {
                      setHybridConnectPrompt(true);
                      return;
                    }
                    setHybridConnectPrompt(false);
                    void run(() => onUpdateConfig({ mode }));
                  }}
                  title={dict.approvalModes[mode].shortDesc}
                  data-testid={`approval-mode-option-${mode}`}
                >
                  <span className="setting-label">{dict.approvalModes[mode].label}</span>
                  <span className="muted truncate setting-row-hint">
                    {dict.approvalModes[mode].shortDesc}
                  </span>
                  <span className="spacer" />
                  {lockedHybrid && (
                    <span className="badge badge-warning badge-xs">
                      {dict.ui.v034.connectReviewerFirst}
                    </span>
                  )}
                  {config.mode === mode && <Icon icon={Check} size="md" color="var(--accent-text, var(--accent-primary))" />}
                </button>
              );
            })}
            {hybridConnectPrompt && !isExternalReviewerConnected(config.externalReviewer) && (
              <div
                className="setting-row settings-inline-warning"
                data-testid="rules-hybrid-connect-prompt"
              >
                <span className="settings-banner-text">
                  {dict.ui.copy.externalReviewerIsNotConnected}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setHybridConnectPrompt(false);
                    setTab('reviewer');
                  }}
                  data-testid="rules-goto-reviewer-btn"
                >
                  {dict.ui.v034.connectReviewerArrow}
                </button>
              </div>
            )}
            <div className="setting-row setting-row-option" title={dict.safeDownloadDesc}>
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

          <h3 className="settings-group-title">{dict.ui.v032.policyTitle}</h3>
          <div className="settings-group approval-policy-group" data-testid="approval-policy-group">
            <div className="setting-row approval-policy-lead">
              <span className="setting-desc">{dict.ui.v032.policyLead}</span>
            </div>
            <div className="setting-row setting-row-option">
              <div className="setting-text">
                <label className="setting-label" htmlFor="policy-allow-aligned-high-risk">{dict.ui.v032.allowAlignedHighRiskLabel}</label>
                <div className="setting-desc" id="policy-allow-aligned-high-risk-desc">{dict.ui.v032.allowAlignedHighRiskDesc}</div>
              </div>
              <span className="spacer" />
              <Switch
                id="policy-allow-aligned-high-risk"
                describedBy="policy-allow-aligned-high-risk-desc"
                checked={policy.allowAlignedHighRiskPass}
                disabled={busy}
                label={dict.ui.v032.allowAlignedHighRiskLabel}
                onChange={(v) => savePolicy({ allowAlignedHighRiskPass: v })}
              />
            </div>
            <div
              className={`setting-row approval-policy-score${policy.allowAlignedHighRiskPass ? '' : ' is-disabled'}`}
              data-testid="policy-score-row"
            >
              <div className="setting-text">
                <label className="setting-label" htmlFor="policy-aligned-high-risk-max-score">{dict.ui.v032.alignedHighRiskMaxScoreLabel}</label>
                <div className="setting-desc" id="policy-aligned-high-risk-max-score-desc">
                  {dict.ui.v032.alignedHighRiskMaxScoreDesc(clampAlignedHighRiskScore(scoreDraft))}
                </div>
              </div>
              <div className="approval-policy-score-ctrl">
                <input
                  type="range"
                  className="approval-policy-range"
                  min={ALIGNED_HIGH_RISK_SCORE_RANGE.min}
                  max={ALIGNED_HIGH_RISK_SCORE_RANGE.max}
                  step={1}
                  value={clampAlignedHighRiskScore(scoreDraft)}
                  disabled={busy || !policy.allowAlignedHighRiskPass}
                  aria-label={dict.ui.v032.alignedHighRiskMaxScoreLabel}
                  aria-describedby="policy-aligned-high-risk-max-score-desc"
                  aria-valuetext={String(clampAlignedHighRiskScore(scoreDraft))}
                  onChange={(e) => {
                    setScoreDraft(Number(e.target.value));
                    setScoreText(e.target.value);
                  }}
                  onPointerUp={commitScoreDraft}
                  onKeyUp={commitScoreDraft}
                  onBlur={commitScoreDraft}
                  data-testid="policy-aligned-high-risk-score-range"
                />
                <input
                  id="policy-aligned-high-risk-max-score"
                  className="input input-mono approval-policy-number"
                  type="number"
                  min={ALIGNED_HIGH_RISK_SCORE_RANGE.min}
                  max={ALIGNED_HIGH_RISK_SCORE_RANGE.max}
                  step={1}
                  inputMode="numeric"
                  value={scoreText}
                  disabled={busy || !policy.allowAlignedHighRiskPass}
                  onChange={(e) => {
                    const text = e.target.value;
                    setScoreText(text);
                    const n = text.trim() === '' ? NaN : Number(text);
                    if (Number.isFinite(n)) setScoreDraft(n);
                  }}
                  onBlur={commitScoreText}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isImeComposing(e)) {
                      e.preventDefault();
                      commitScoreText();
                    }
                  }}
                  data-testid="policy-aligned-high-risk-score-input"
                />
              </div>
            </div>
            <div className="setting-row setting-row-option">
              <div className="setting-text">
                <label className="setting-label" htmlFor="policy-fast-pass-low-risk-dev">{dict.ui.v032.fastPassLowRiskDevLabel}</label>
                <div className="setting-desc" id="policy-fast-pass-low-risk-dev-desc">{dict.ui.v032.fastPassLowRiskDevDesc}</div>
              </div>
              <span className="spacer" />
              <Switch
                id="policy-fast-pass-low-risk-dev"
                describedBy="policy-fast-pass-low-risk-dev-desc"
                checked={policy.fastPassLowRiskDev}
                disabled={busy}
                label={dict.ui.v032.fastPassLowRiskDevLabel}
                onChange={(v) => savePolicy({ fastPassLowRiskDev: v })}
              />
            </div>
            {(config.mode !== 'hybrid' || !isExternalReviewerConnected(config.externalReviewer)) && (
              <div className="setting-row approval-policy-note muted" data-testid="policy-hybrid-note">
                <Icon icon={Info} size="xs" />
                <span>{dict.ui.v032.policyHybridNote}</span>
              </div>
            )}
            {policyNotice && (
              <div className="setting-row approval-policy-note" role="status" data-testid="policy-saved-notice">
                <Icon icon={Check} size="xs" />
                <span>{policyNotice}</span>
              </div>
            )}
          </div>

          {groups.map((g) => (
            <React.Fragment key={g.field}>
              <h3 className="settings-group-title">
                <span className={`badge ${g.badge}`}>{g.title}</span>
              </h3>
              <div className="settings-group">
                {config[g.field].length === 0 ? (
                  <div className="pattern-row pattern-row-empty muted">
                    {dict.rulesEmpty}
                  </div>
                ) : (
                  config[g.field].map((pat) => (
                    <div key={pat} className="pattern-row">
                      <code className="truncate pattern-code">
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
                        <Icon icon={X} size="xs" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <form
                className="inline-form inline-form-attached"
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
                  <Icon icon={Plus} size="xs" />
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
                      item.verdict === 'denied' || item.verdict === 'rejected_with_feedback'
                        ? 'badge-danger'
                        : item.verdict === 'auto_approved_turbo'
                          ? 'badge-turbo'
                          : 'badge-success'
                    }`}
                  >
                    {dict.verdictLabels[item.verdict]}
                  </span>
                  <span className="muted">{dict.decisionSourceLabels[item.decisionSource]}</span>
                  <span className="spacer" />
                  <span className="muted mono" title={item.timestamp}>
                    {item.latencyMs}ms · {formatLocalDateTime(item.timestamp, locale)}
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
          <div className="settings-group settings-note-card">
            <div className="settings-note-head">
              <span className="settings-note-title">{dict.ui.reviewerArchTitle}</span>
              <span
                className={`badge ${
                  verified
                    ? 'badge-success'
                    : reviewer.connectionStatus === 'failed'
                      ? 'badge-danger'
                      : 'badge-warning'
                }`}
                data-testid="reviewer-connection-badge"
              >
                {verified
                  ? dict.ui.copy.reviewTestPassed
                  : reviewer.connectionStatus === 'failed'
                    ? dict.ui.copy.connectionFailed
                    : dict.ui.copy.notConnected3}
              </span>
            </div>
            <ul className="settings-note-list muted">
              <li>
                <strong>{dict.ui.reviewerArchLayer1Title}</strong>
                {dict.ui.copy.labelItem2}
                {dict.ui.reviewerArchLayer1Body}
              </li>
              <li>
                <strong>{dict.ui.reviewerArchLayer2Title}</strong>
                {dict.ui.copy.labelItem2}
                {dict.ui.reviewerArchLayer2Lead} <code>127.0.0.1:11434</code> {dict.ui.reviewerArchLayer2Rest}
              </li>
            </ul>
          </div>

          {externalReviewerTelemetry && (
            <div
              className="settings-group settings-usage-card"
              data-testid="reviewer-panel-usage-card"
            >
              <div className="settings-usage-head">
                <span className="settings-note-title">
                  {dict.ui.v034.reviewerCumulativeTitle}
                </span>
                <span className="mono settings-usage-total">
                  {formatUsd(externalReviewerTelemetry.cumulativeAllTime.totalCostUsd)}
                </span>
              </div>
              <div className="settings-usage-stats muted">
                <span>
                  {dict.ui.v034.allTimePrefix}
                  <strong className="mono settings-usage-num">
                    {externalReviewerTelemetry.cumulativeAllTime.callCount}
                  </strong>{' '}
                  {dict.ui.v034.callsSep}
                  <strong className="mono settings-usage-num">
                    {formatTokenShort(externalReviewerTelemetry.cumulativeAllTime.totalTokens)}
                  </strong>{' '}
                  Tokens
                </span>
                {currentSessionId && externalReviewerTelemetry.bySession[currentSessionId] && (
                  <span>
                    {dict.ui.v034.sessionPrefix}
                    <strong className="mono settings-usage-num">
                      {externalReviewerTelemetry.bySession[currentSessionId].callCount}
                    </strong>{' '}
                    {dict.ui.v034.callsSep}
                    <strong className="mono settings-usage-num">
                      {formatUsd(externalReviewerTelemetry.bySession[currentSessionId].totalCostUsd)}
                    </strong>
                  </span>
                )}
              </div>
              {externalReviewerTelemetry.cumulativeProviders.length > 0 && (
                <div className="settings-usage-providers">
                  {externalReviewerTelemetry.cumulativeProviders.map((item) => (
                    <div key={item.key} className="settings-usage-provider">
                      <span className="badge badge-mono badge-xs">
                        {formatExternalReviewerProviderLabel(item.provider, locale)}
                      </span>
                      <span className="mono truncate">{item.modelId}</span>
                      <span className="spacer" />
                      <span className="muted mono">
                        {item.callCount}× · {formatTokenShort(item.totalTokens)}
                      </span>
                      <span className="mono">{formatUsd(item.totalCostUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {isExternalReviewerConnected(config.externalReviewer) && config.mode !== 'hybrid' && (
            <div
              className="settings-group settings-banner tone-warning"
              data-testid="reviewer-mode-mismatch-banner"
            >
              <span className="settings-banner-text">
                {dict.ui.reviewerModeMismatch(dict.approvalModes[config.mode].label, dict.approvalModes.hybrid.label)}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void run(() => onUpdateConfig({ mode: 'hybrid' }))}
                data-testid="switch-to-hybrid-mode-btn"
              >
                {dict.ui.switchToMode(dict.approvalModes.hybrid.label)}
              </button>
            </div>
          )}
          <div className="settings-group">
            <div className="setting-row">
              <div className="setting-text">
                <label className="setting-label" htmlFor="reviewer-enable-action">{dict.reviewerEnableToggle}</label>
                <div className="setting-desc reviewer-activation-feedback" role="status" id="reviewer-activation-feedback"
                  data-testid="reviewer-activation-feedback" style={reviewerNotice?.error ? { color: 'var(--danger-text, var(--status-danger))' } : undefined}>
                  <span data-testid={reviewerNotice ? 'reviewer-test-result' : undefined}>{reviewerActivationHint()}</span>
                </div>
                {activationRequested && !verified && !activeReviewer && (
                  <button type="button" className="btn btn-sm reviewer-activation-action" data-testid="reviewer-test-and-enable"
                    disabled={reviewerWorking || !canTestReviewer} onClick={() => void testReviewer(true)}>
                    {testing ? (dict.ui.copy.testing) : (dict.ui.copy.testAndEnable)}
                  </button>
                )}
              </div>
              <Switch
                id="reviewer-enable-action"
                describedBy="reviewer-activation-feedback"
                checked={activeReviewer}
                disabled={reviewerWorking}
                label={dict.reviewerEnableToggle}
                onChange={changeReviewerEnabled}
              />
            </div>
            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerProviderLabel}</span>
              </span>
              <select
                className="input w-260"
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
                  resetReviewerDiscovery();
                  setCustomModelMode(false);
                  placeholderModelRef.current = defaultsByProvider[nextProvider].model;
                  setReviewer((prev) => ({
                    ...prev,
                    provider: nextProvider,
                    apiKey: '',
                    // D4：更换服务商后已存密钥不再适用，需重新输入。
                    hasApiKey: sameExternalService(config.externalReviewer, { provider: nextProvider, endpoint: defaultsByProvider[nextProvider].endpoint })
                      ? config.externalReviewer.hasApiKey
                      : false,
                    lastVerifiedAt: undefined,
                    endpoint: defaultsByProvider[nextProvider].endpoint,
                    model: defaultsByProvider[nextProvider].model,
                    thinkingLevel: 'auto',
                    connectionStatus: 'untested',
                  }));
                }}
              >
                <option value="gemini-api-key">{dict.reviewerProviderGemini}</option>
                <option value="openai-compatible">{dict.reviewerProviderOpenAi}</option>
                <option value="local-ollama">{dict.reviewerProviderOllama}</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerEndpointLabel}</span>
              </span>
              <input
                className="input input-mono w-280"
                type="text"
                value={reviewer.endpoint ?? ''}
                onChange={(e) => {
                  const endpoint = e.target.value;
                  resetReviewerDiscovery();
                  setReviewer((prev) => ({
                    ...prev, endpoint, apiKey: sameExternalService(prev, { endpoint }) ? prev.apiKey : '',
                    hasApiKey: sameExternalService(config.externalReviewer, { provider: prev.provider, endpoint })
                      ? config.externalReviewer.hasApiKey && !reviewerKeyCleared
                      : false,
                    lastVerifiedAt: undefined, connectionStatus: 'untested',
                  }));
                }}
                aria-label={dict.reviewerEndpointLabel}
              />
            </div>

            {reviewer.provider !== 'local-ollama' ? (
              <div className="setting-row setting-row-wrap">
                <span className="setting-text setting-text-grow">
                  <span className="setting-label">{dict.reviewerApiKeyLabel}</span>
                  <span className="setting-desc">
                    {discovering
                      ? dict.reviewerDiscovering
                      : discoverError
                        ? <span className="text-danger">{discoverError}</span>
                        : discoveredModels.length > 0
                          ? <span className="text-success">{dict.reviewerDiscoveredCount(discoveredModels.length)}</span>
                          : reviewer.apiKey?.trim()
                             ? <span>{dict.ui.v034.apiKeyEntered}</span>
                            : reviewerKeyCleared
                              ? <span className="text-warning" data-testid="reviewer-apikey-cleared">{v034.apiKeyCleared}</span>
                              : reviewerKeyNeedsReentry
                                ? <span className="text-warning" role="note" data-testid="reviewer-apikey-reenter">{v034.apiKeyReenterHint}</span>
                                : savedReviewerKey
                                  ? <span className="text-success">{v034.apiKeySavedPlaceholder}</span>
                                  : dict.reviewerDiscoverPromptHint}
                  </span>
                </span>
                <div className="inline-cluster">
                  <input
                    className="input input-mono w-210"
                    type="password"
                    value={reviewer.apiKey ?? ''}
                    placeholder={savedReviewerKey ? v034.apiKeySavedPlaceholder : undefined}
                    autoComplete="off"
                    onChange={(e) => {
                      const apiKey = e.target.value;
                      resetReviewerDiscovery();
                      setReviewer((prev) => ({ ...prev, apiKey, lastVerifiedAt: undefined, connectionStatus: 'untested' }));
                    }}
                    aria-label={dict.reviewerApiKeyLabel}
                    data-testid="reviewer-apikey-input"
                  />
                  {(savedReviewerKey || reviewerKeyCleared) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        resetReviewerDiscovery();
                        if (reviewerKeyCleared) {
                          setReviewerKeyCleared(false);
                          setReviewer((prev) => ({ ...prev, hasApiKey: config.externalReviewer.hasApiKey }));
                        } else {
                          setReviewerKeyCleared(true);
                          setReviewer((prev) => ({ ...prev, apiKey: '', hasApiKey: false, lastVerifiedAt: undefined, connectionStatus: 'untested' }));
                        }
                      }}
                      data-testid="reviewer-apikey-clear-btn"
                    >
                      {reviewerKeyCleared ? v034.apiKeyUndoClear : v034.apiKeyClear}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={discovering || !discoveryReady}
                    onClick={() => {
                      lastAutoDiscoveryKeyRef.current = `${reviewer.provider}\0${reviewer.endpoint.trim()}\0${reviewer.apiKey?.trim() || ''}`;
                      void fetchServerModels(reviewer.provider, reviewer.endpoint, reviewer.apiKey);
                    }}
                    data-testid="discover-reviewer-models-btn"
                  >
                    <Icon icon={RefreshCw} size="sm" className={discovering ? 'spin' : ''} />
                    <span>{dict.reviewerDiscoverBtn}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="setting-row">
                <span className="setting-text">
                  <span className="setting-label">{dict.reviewerDiscoverBtn}</span>
                  <span className="setting-desc">
                    {discovering
                      ? dict.reviewerDiscovering
                      : discoverError
                        ? <span className="text-danger">{discoverError}</span>
                        : discoveredModels.length > 0
                          ? <span className="text-success">{dict.reviewerDiscoveredCount(discoveredModels.length)}</span>
                          : dict.ui.reviewerOllamaDiscoverHint}
                  </span>
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={discovering || !discoveryReady}
                  onClick={() => {
                    lastAutoDiscoveryKeyRef.current = `${reviewer.provider}\0${reviewer.endpoint.trim()}\0`;
                    void fetchServerModels(reviewer.provider, reviewer.endpoint);
                  }}
                  data-testid="discover-reviewer-models-btn"
                >
                  <Icon icon={RefreshCw} size="sm" className={discovering ? 'spin' : ''} />
                  <span>{dict.reviewerDiscoverBtn}</span>
                </button>
              </div>
            )}

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerModelLabel}</span>
                {selectedModelMeta.outputTokenLimit && (
                  <span className="setting-desc mono">
                    Max out: {selectedModelMeta.outputTokenLimit.toLocaleString()} tokens
                  </span>
                )}
              </span>
              {discoveredModels.length > 0 && !customModelMode ? (
                <select
                  className="input input-mono w-280"
                  value={discoveredModels.some((m) => m.id === reviewer.model) ? reviewer.model : '__custom__'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '__custom__') {
                      setCustomModelMode(true);
                      return;
                    }
                    const nextMeta = discoveredModels.find((m) => m.id === val);
                    placeholderModelRef.current = null;
                    setReviewer((prev) => {
                      const nextLevel: ExternalReviewerThinkingLevel =
                        prev.thinkingLevel && nextMeta?.supportedThinkingLevels.includes(prev.thinkingLevel)
                          ? prev.thinkingLevel
                          : 'auto';
                      const curMax = prev.maxOutputTokens || EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens;
                      const nextMax =
                        nextMeta?.outputTokenLimit && curMax > nextMeta.outputTokenLimit
                          ? nextMeta.outputTokenLimit
                          : curMax;
                      return {
                        ...prev,
                        model: val,
                        thinkingLevel: nextLevel,
                        maxOutputTokens: nextMax,
                      };
                    });
                  }}
                  aria-label={dict.reviewerModelLabel}
                  data-testid="reviewer-model-select"
                >
                  {discoveredModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.id}
                    </option>
                  ))}
                  <option value="__custom__">{dict.reviewerCustomModelOption}</option>
                </select>
              ) : (
                <div className="inline-cluster inline-cluster-tight">
                  <input
                    className={`input input-mono ${discoveredModels.length > 0 ? 'w-210' : 'w-280'}`}
                    type="text"
                    value={reviewer.model ?? ''}
                    onChange={(e) => {
                      placeholderModelRef.current = null;
                      const model = e.target.value;
                      setReviewer((prev) => ({ ...prev, model }));
                    }}
                    aria-label={dict.reviewerModelLabel}
                    data-testid="reviewer-model-input"
                  />
                  {discoveredModels.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setCustomModelMode(false)}
                    >
                      {dict.ui.reviewerBackToList}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerThinkingLabel}</span>
                <span className="setting-desc">
                  {selectedModelMeta.supportedThinkingLevels.length <= 1
                    ? dict.reviewerThinkingUnsupported
                    : selectedModelMeta.defaultThinkingLevel
                      ? dict.ui.reviewerModelDefaultLevel(selectedModelMeta.defaultThinkingLevel)
                      : undefined}
                </span>
              </span>
              <select
                className="input w-220"
                disabled={selectedModelMeta.supportedThinkingLevels.length <= 1}
                value={
                  reviewer.thinkingLevel && selectedModelMeta.supportedThinkingLevels.includes(reviewer.thinkingLevel)
                    ? reviewer.thinkingLevel
                    : 'auto'
                }
                onChange={(e) =>
                  setReviewer((prev) => ({
                    ...prev,
                    thinkingLevel: e.target.value as ExternalReviewerThinkingLevel,
                  }))
                }
                aria-label={dict.reviewerThinkingLabel}
                data-testid="reviewer-thinking-select"
              >
                {selectedModelMeta.supportedThinkingLevels.map((lv) => (
                  <option key={lv} value={lv}>
                    {dict.reviewerThinkingLevels[lv]}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerMaxOutputLabel}</span>
                <span className="setting-desc">{dict.reviewerMaxOutputHint}</span>
              </span>
              <DraftNumberInput
                className="input input-mono w-120"
                min={64}
                max={Math.min(selectedModelMeta.outputTokenLimit || 65536, 65536)}
                step={256}
                integer
                fallback={EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens}
                value={reviewer.maxOutputTokens ?? EXTERNAL_REVIEWER_DEFAULTS.maxOutputTokens}
                onValueChange={(maxOutputTokens) => setReviewer((prev) => ({ ...prev, maxOutputTokens }))}
                aria-label={dict.reviewerMaxOutputLabel}
                data-testid="reviewer-max-output-input"
              />
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerTimeoutLabel}</span>
                <span className="setting-desc">{dict.reviewerTimeoutHint}</span>
              </span>
              <DraftNumberInput
                className="input input-mono w-120"
                min={REVIEWER_TIMEOUT_MIN_MS}
                max={60000}
                step={500}
                integer
                fallback={EXTERNAL_REVIEWER_DEFAULTS.timeoutMs}
                value={reviewer.timeoutMs}
                onValueChange={(timeoutMs) => setReviewer((prev) => ({ ...prev, timeoutMs }))}
                aria-label={dict.reviewerTimeoutLabel}
                data-testid="reviewer-timeout-input"
              />
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerCacheTtlLabel}</span>
              </span>
              <input
                className="input input-mono w-120"
                type="number"
                min={0}
                max={168}
                step={1}
                inputMode="numeric"
                value={cacheTtlText}
                onChange={(e) => setCacheTtlText(e.target.value)}
                onBlur={() => { commitCacheTtlText(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isImeComposing(e)) {
                    e.preventDefault();
                    commitCacheTtlText();
                  }
                }}
                aria-label={dict.reviewerCacheTtlLabel}
                data-testid="approval-cache-ttl-input"
              />
            </div>
          </div>
          <div className="setting-row gap-8 reviewer-actions">
            <button type="button" className="btn btn-sm" disabled={reviewerWorking || !canTestReviewer}
              onClick={() => void testReviewer()} data-testid="test-reviewer-connection-btn">
              {testing ? dict.ui.v034.testingModel : dict.ui.v034.testReviewModel}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={reviewerWorking}
              onClick={() => {
                setReviewer(reviewerRequestSettings(reviewerRef.current, selectedModelMeta));
                void saveReviewer(reviewerRef.current, 'save');
              }}
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
  onRefresh,
  onRunPluginAction,
  onRunMcpAction,
  onToggleSkill,
}: {
  snapshot: PluginsManagerSnapshot;
  onRefresh: () => Promise<void>;
  onRunPluginAction: (input: PluginActionInput) => Promise<void>;
  onRunMcpAction: (input: McpActionInput) => Promise<void>;
  onToggleSkill: (skillId: string, enabled: boolean) => Promise<void>;
}): React.ReactElement {
  const { locale, dict, mac } = useI18n();
  const { busy, error, run } = useAction();
  const [tab, setTab] = useState<PluginsTab>('builtins');
  const [target, setTarget] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpType, setMcpType] = useState<'stdio' | 'http'>('stdio');
  const [mcpCmd, setMcpCmd] = useState('');
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // “上次命令输出”默认收起：例行只读刷新不打扰；用户亲手执行的操作结束或出错时自动展开。
  const [outputOpen, setOutputOpen] = useState(false);
  const wasBusyRef = useRef(false);
  const lastOutput = snapshot.lastCommandOutput;
  const outputSignature = lastOutput || '';
  const outputAtStartRef = useRef(outputSignature);
  const awaitingOutputRef = useRef(false);
  // 只有用户操作后官方 CLI 真正产生了新的输出才自动展开；切换本地 Skill 等不调用 CLI 的操作不会弹出旧日志。
  useEffect(() => {
    if (busy && !wasBusyRef.current) {
      outputAtStartRef.current = outputSignature;
      awaitingOutputRef.current = true;
    }
    if (awaitingOutputRef.current && outputSignature && outputSignature !== outputAtStartRef.current) {
      awaitingOutputRef.current = false;
      setOutputOpen(true);
    }
    wasBusyRef.current = busy;
  }, [busy, outputSignature]);
  useEffect(() => {
    if (error) setOutputOpen(true);
  }, [error]);
  const formattedOutput = useMemo(() => (lastOutput ? formatCommandOutput(lastOutput) : null), [lastOutput]);
  useEffect(() => {
    let current = true;
    setRefreshError(null);
    void onRefresh().catch(err => { if (current) setRefreshError(formatActionError(err, dict)); });
    return () => { current = false; };
  }, [onRefresh, dict, refreshAttempt]);

  const sectionErrors = snapshot.sectionErrors ?? {};
  const sectionErrorFor = (section: 'plugins' | 'mcp' | 'skills') => {
    const message = sectionErrors[section];
    if (!message) return null;
    return (
      <div role="alert" className="alert alert-warning plugins-section-error" data-testid={`plugins-section-error-${section}`}>
        <span className="settings-banner-text">{dict.ui.pluginSectionError(dict.ui.pluginSectionNames[section], message)}</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setRefreshAttempt(n => n + 1)}>
          {dict.ui.v034.retryLoad}
        </button>
      </div>
    );
  };

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
            {count > 0 && <span className="sub-tab-count muted">{count}</span>}
            {sectionErrors[key as keyof typeof sectionErrors] && (
              <span className="sub-tab-error" aria-hidden="true" data-testid={`plugins-tab-error-${key}`} />
            )}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      {refreshError && (
        <div role="alert" className="alert">
          {refreshError}{' '}
          <button type="button" className="btn btn-sm" onClick={() => setRefreshAttempt(n => n + 1)}>
            {dict.ui.v034.retryLoad}
          </button>
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
              <span className="list-icon list-icon-sm">
                <Icon icon={Sparkles} size="md" />
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
          {sectionErrorFor('plugins')}
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
              placeholder={dict.ui.v032.pluginPathPlaceholder(dict.pluginInstallPlaceholder, mac)}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="plugin-install-input"
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !target.trim()} data-testid="plugin-install-btn">
              <Icon icon={Plus} size="sm" />
              <span>{dict.pluginInstallBtn}</span>
            </button>
          </form>
          <div className="settings-hint" data-testid="plugin-install-hint">{dict.ui.pluginInstallHint}</div>
          <div className="settings-group">
            {snapshot.plugins.length === 0 ? (
              <div className="empty-state">{dict.pluginsEmpty}</div>
            ) : (
              snapshot.plugins.map((pl) => (
                <div key={pl.name} className="list-row" data-testid={`plugin-row-${pl.name}`}>
                  <span className="list-icon">
                    <Icon icon={Puzzle} size="md" />
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
                      <Icon icon={Trash2} size="sm" />
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
          {sectionErrorFor('mcp')}
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!mcpName.trim() || !mcpCmd.trim()) return;
              void run(async () => {
                const parts = mcpType === 'http' ? [mcpCmd.trim()] : parseMcpCommandLine(mcpCmd.trim());
                if (!parts?.[0]) throw new Error(dict.ui.v034.enterCommandQuotes);
                await onRunMcpAction({
                  action: 'add',
                  name: mcpName.trim(),
                  type: mcpType,
                  commandOrUrl: parts[0],
                  args: parts.slice(1),
                });
                setMcpName('');
                setMcpCmd('');
              });
            }}
          >
            <input
              className="input input-mono mcp-name-input"
              placeholder={dict.mcpNamePlaceholder}
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
              data-testid="mcp-name-input"
            />
            <select
              className="input mcp-type-select"
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
              <Icon icon={Plus} size="sm" />
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
                    <Icon icon={Cpu} size="md" />
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
                      <Icon icon={Trash2} size="sm" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {tab === 'skills' && sectionErrorFor('skills')}
      {tab === 'skills' && (
        <div className="settings-group">
          {snapshot.skills.length === 0 ? (
            <div className="empty-state">{dict.skillsEmpty}</div>
          ) : (
            snapshot.skills.map((sk) => (
              <div key={sk.id} className="list-row" data-testid={`skill-row-${sk.name}`}>
                <span className="list-icon">
                  <Icon icon={Wand2} size="md" />
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

      {lastOutput && formattedOutput && !lastOutput.startsWith('Ready ') && (
        <details
          className="command-output-disclosure"
          open={outputOpen}
          onToggle={(e) => setOutputOpen((e.currentTarget as HTMLDetailsElement).open)}
          data-testid="plugins-last-command-output"
        >
          <summary className="command-output-summary">
            <span className="command-output-chevron" aria-hidden="true">›</span>
            <span className="field-label">{dict.lastCommandLabel}</span>
            {formattedOutput.json && <span className="badge badge-mono command-output-kind">JSON</span>}
          </summary>
          <pre className="code-line command-output-body">
            <span className="command-output-prompt" aria-hidden="true">$ </span>
            {formattedOutput.text}
          </pre>
        </details>
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

  const appliedRates = useRef(JSON.stringify(rateCards));
  useEffect(() => {
    const latest = JSON.stringify(rateCards);
    if (appliedRates.current !== latest) {
      appliedRates.current = latest;
      setDraft(rateCards.map(card => ({ ...card })));
    }
  }, [rateCards]);

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
              <DraftNumberInput
                key={field}
                min={0}
                max={1_000_000}
                step={0.01}
                fallback={0}
                className="input input-mono"
                value={card[field]}
                onValueChange={(val) => {
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
      <div className="inline-cluster inline-cluster-wrap">
        <span className="disclaimer">
          <Icon icon={Info} size="xs" />
          {COST_DISCLAIMER[locale]}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => { setSaved(false); setDraft(DEFAULT_MODEL_RATE_CARDS.map(card => ({ ...card }))); }}>
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

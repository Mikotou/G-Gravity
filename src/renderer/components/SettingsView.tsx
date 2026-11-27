import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  Download,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  Info,
  Languages,
  Loader2,
  Paintbrush,
  Palette,
  Pencil,
  Pin,
  PlugZap,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import {
  APP_BRAND,
  clampUiScale,
  DEFAULT_TRANSLATION_CONFIG,
  EXECUTION_MODE_ORDER,
  EXTERNAL_TRANSLATOR_DEFAULTS,
  inferSupportedThinkingLevels,
  isExternalTranslatorConnected,
  sameTranslatorSettings,
  sameExternalService,
  normalizeProjectCompareKey,
  normalizeWorkspacePath,
  UI_SCALE_LIMITS,
  type AccountsStateSnapshot,
  type AcpConnectionStatus,
  type AgentExecutionMode,
  type AppUpdateState,
  type ApprovalAuditEntry,
  type ApproveForMeConfig,
  type ClientPreferences,
  type ExternalReviewerModelOption,
  type ExternalReviewerTelemetrySnapshot,
  type ExternalReviewerThinkingLevel,
  type ExternalTranslatorConfig,
  type ExternalTranslatorTelemetrySnapshot,
  type ExternalTranslatorTestResult,
  type GravityIconPreference,
  type McpActionInput,
  type ModelRateCard,
  type PluginActionInput,
  type PluginsManagerSnapshot,
  type TranslationConfig,
  type TranslationConfigPatch,
  type WorkspaceProjectConfig,
} from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError, type SettingsSection } from '../i18n/locales';
import { usePrefsFeedback } from './settings/usePrefsFeedback';
import { handleTablistKeyDown } from '../hooks/useRovingTabs';
import { getDesktopBridge } from '../services/desktop-bridge';
import { isImeComposing, isPrimaryModifier } from '../lib/platform-keys';
import { DraftNumberInput } from './settings/DraftNumberInput';
import { resolveGravityIconVariant } from '../styles/theme';
import { formatTokenShort, formatUsd } from './ContextStatusBar';
import { IconsPanel, ThemesPanel, TokensPanel } from './settings/AppearancePanels';
import { AccountsPanel, ApprovalsPanel, PluginsPanel, RatesPanel, type ApprovalTab } from './settings/WorkspacePanels';
import { ResizeHandle } from './ResizeHandle';
import { Icon as UiIcon } from './ui/Icon';
import { VoiceSettingsCard } from './settings/VoiceSettingsCard';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { scrollBehavior } from '../lib/motion';
import { projectApiKeyForSubmit } from '../lib/api-key-projection';
import { canAutoDiscoverExternalModels, resolveExternalTargetOrigin } from '../lib/external-endpoint';
import { SettingsDirtyContext, useSettingsDirty } from './settings/settings-dirty';

export type { SettingsSection };

export interface SettingsViewProps {
  section: SettingsSection;
  preferences: ClientPreferences;
  connection: AcpConnectionStatus;
  accounts: AccountsStateSnapshot;
  approvalConfig: ApproveForMeConfig;
  approvalInitialTab?: ApprovalTab;
  externalReviewerTelemetry?: ExternalReviewerTelemetrySnapshot;
  translationConfig?: TranslationConfig;
  externalTranslatorTelemetry?: ExternalTranslatorTelemetrySnapshot;
  focusExternalTranslatorSeq?: number;
  currentSessionId?: string | null;
  auditEntries: ApprovalAuditEntry[];
  plugins: PluginsManagerSnapshot;
  rateCards: ModelRateCard[];
  updateState: AppUpdateState;
  onSectionChange: (section: SettingsSection) => void;
  /** v0.3.6：外部语音转写独立用量（设置 → 通用 → 语音听写费用摘要） */
  voiceTelemetry?: import('@shared').VoiceExternalTelemetrySnapshot;
  onClose: () => void;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onUpdateTranslationConfig?: (patch: TranslationConfigPatch) => Promise<TranslationConfig | void>;
  onOpenTranslatorStats?: () => void;
  onCheckUpdates: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onSetAppIcon: (iconId: GravityIconPreference) => Promise<void>;
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

const APPEARANCE_SECTIONS: ReadonlyArray<SettingsSection> = ['themes', 'tokens', 'icons'];

const NAV: ReadonlyArray<{ group: 'app' | 'workspace' | 'info'; id: SettingsSection; Icon: typeof Palette }> = [
  { group: 'app', id: 'general', Icon: SlidersHorizontal },
  // SV1：主题 / 自定义配色 / 应用图标合并为「外观」一级导航 + 二级页签（旧 section id 'tokens' / 'icons' 深链仍然有效）
  { group: 'app', id: 'themes', Icon: Palette },
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

const ALL_TRANSLATOR_THINKING_LEVELS: readonly ExternalReviewerThinkingLevel[] = [
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
];

function normalizeTranslatorDraft(raw?: ExternalTranslatorConfig): ExternalTranslatorConfig {
  const base = raw ?? DEFAULT_TRANSLATION_CONFIG.externalTranslator;
  return {
    ...DEFAULT_TRANSLATION_CONFIG.externalTranslator,
    ...base,
    timeoutMs: base.timeoutMs || EXTERNAL_TRANSLATOR_DEFAULTS.timeoutMs,
    maxOutputTokens: base.maxOutputTokens || EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens,
    thinkingLevel: base.thinkingLevel ?? EXTERNAL_TRANSLATOR_DEFAULTS.thinkingLevel,
  };
}

function GeneralPanel({
  preferences,
  translationConfig,
  externalTranslatorTelemetry,
  focusExternalTranslatorSeq,
  onUpdatePreferences,
  onUpdateTranslationConfig,
  onOpenTranslatorStats,
  onOpenProjectsTab,
}: {
  preferences: ClientPreferences;
  translationConfig?: TranslationConfig;
  externalTranslatorTelemetry?: ExternalTranslatorTelemetrySnapshot;
  focusExternalTranslatorSeq?: number;
  onUpdatePreferences: (patch: Partial<ClientPreferences>) => Promise<void>;
  onUpdateTranslationConfig?: (patch: TranslationConfigPatch) => Promise<TranslationConfig | void>;
  onOpenTranslatorStats?: () => void;
  onOpenProjectsTab: () => void;
}): React.ReactElement {
  const { locale, dict, setLocale, shortcut } = useI18n();
  const { save: savePref, feedback: prefsFeedback } = usePrefsFeedback(onUpdatePreferences);
  const isZh = locale === 'zh-CN';
  const [scale, setScale] = useState(clampUiScale(preferences.uiScale));
  const scaleControl = useRef<{ confirmed: number; draft?: number; save: number }>({ confirmed: scale, save: 0 });

  function saveScale(value = scaleControl.current.draft) {
    if (value === undefined) return;
    const control = scaleControl.current;
    control.draft = undefined;
    const save = ++control.save;
    void savePref({ uiScale: value }).then((ok) => {
      if (!ok && save === control.save && control.draft === undefined) setScale(control.confirmed);
    });
  }

  const effectiveTranslation = translationConfig ?? DEFAULT_TRANSLATION_CONFIG;
  const savedExternalConnected = isExternalTranslatorConnected(effectiveTranslation.externalTranslator);
  const [draftExt, restoreDraftExt] = useState<ExternalTranslatorConfig>(() =>
    normalizeTranslatorDraft(effectiveTranslation.externalTranslator)
  );
  const [externalExpanded, setExternalExpanded] = useState<boolean>(
    () =>
      effectiveTranslation.engine === 'external-api' ||
      effectiveTranslation.externalTranslator.enabled ||
      Boolean(effectiveTranslation.externalTranslator.apiKey || effectiveTranslation.externalTranslator.hasApiKey) ||
      effectiveTranslation.externalTranslator.provider !== EXTERNAL_TRANSLATOR_DEFAULTS.provider ||
      Boolean(focusExternalTranslatorSeq)
  );
  const [connectPrompt, setConnectPrompt] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<ExternalReviewerModelOption[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExternalTranslatorTestResult | null>(null);
  const [savingExt, setSavingExt] = useState(false);
  const [savedExtFlash, setSavedExtFlash] = useState(false);
  const [extError, setExtError] = useState<string | null>(null);

  const savedConfigRef = useRef(effectiveTranslation.externalTranslator);
  // D4：主进程只返回 hasApiKey；同 provider + origin 留空沿用已存密钥，「清除密钥」显式提交空串。
  const [extKeyCleared, setExtKeyCleared] = useState(false);
  const savedExt = effectiveTranslation.externalTranslator;
  const savedExtKey = Boolean(savedExt.hasApiKey) && sameExternalService(savedExt, draftExt) && !extKeyCleared;
  const extKeyNeedsReentry = Boolean(savedExt.hasApiKey) && !sameExternalService(savedExt, draftExt) && !draftExt.apiKey?.trim();
  const v034 = dict.ui.v034;
  useSettingsDirty(
    'translator-external',
    !sameTranslatorSettings(normalizeTranslatorDraft(savedExt), draftExt) || extKeyCleared
  );
  const setDraftExt = (update: (previous: ExternalTranslatorConfig) => ExternalTranslatorConfig) => {
    restoreDraftExt(previous => {
      const next = update(previous);
      return sameTranslatorSettings(previous, next) ? next : {
        ...next, enabled: false, lastVerifiedAt: undefined, verifiedBy: undefined, connectionStatus: 'untested',
      };
    });
  };
  const discoverySeqRef = useRef(0);
  const testSeqRef = useRef(0);
  const skipNextTestResetRef = useRef(false);
  const lastAutoDiscoveryKeyRef = useRef('');
  const configCardRef = useRef<HTMLDivElement | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const control = scaleControl.current;
    control.confirmed = clampUiScale(preferences.uiScale);
    if (control.draft === undefined) setScale(control.confirmed);
  }, [preferences.uiScale]);

  useEffect(() => {
    const saved = effectiveTranslation.externalTranslator;
    const previous = savedConfigRef.current;
    if (sameTranslatorSettings(previous, saved) && previous.enabled === saved.enabled &&
        previous.connectionStatus === saved.connectionStatus && previous.lastVerifiedAt === saved.lastVerifiedAt &&
        previous.verifiedBy === saved.verifiedBy) return;
    savedConfigRef.current = saved;
    setExtKeyCleared(false);
    if (sameTranslatorSettings(previous, saved)) {
      restoreDraftExt(draft => sameTranslatorSettings(draft, saved) ? normalizeTranslatorDraft(saved) : draft);
      return;
    }
    ++discoverySeqRef.current;
    ++testSeqRef.current;
    setDiscovering(false);
    setTesting(false);
    restoreDraftExt(normalizeTranslatorDraft(saved));
  }, [effectiveTranslation]);

  useEffect(() => {
    if (skipNextTestResetRef.current) {
      skipNextTestResetRef.current = false;
      return;
    }
    ++testSeqRef.current;
    setTesting(false);
    setTestResult(null);
  }, [draftExt.model, draftExt.thinkingLevel, draftExt.timeoutMs, draftExt.maxOutputTokens]);

  useEffect(() => {
    if (focusExternalTranslatorSeq && focusExternalTranslatorSeq > 0) {
      setExternalExpanded(true);
      window.setTimeout(() => {
        if (typeof configCardRef.current?.scrollIntoView === 'function') {
          configCardRef.current.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
        }
        apiKeyInputRef.current?.focus();
      }, 30);
    }
  }, [focusExternalTranslatorSeq]);

  const applyTranslationUpdate = useCallback(
    async (patch: TranslationConfigPatch): Promise<TranslationConfig> => {
      if (onUpdateTranslationConfig) {
        const res = await onUpdateTranslationConfig(patch);
        return res ?? getDesktopBridge().getTranslationConfig();
      }
      return getDesktopBridge().updateTranslationConfig(patch);
    },
    [onUpdateTranslationConfig]
  );

  const fetchTranslatorModels = useCallback(
    async (
      provider: ExternalTranslatorConfig['provider'],
      endpoint: string,
      apiKey?: string
    ): Promise<void> => {
      const seq = ++discoverySeqRef.current;
      setDiscovering(true);
      setDiscoverError(null);
      try {
        const result = await getDesktopBridge().discoverExternalTranslationModels({
          provider,
          endpoint: endpoint.trim(),
          apiKey: apiKey?.trim() || undefined,
        });
        if (seq !== discoverySeqRef.current) return;
        setDiscoveredModels(result.models);
      } catch (err) {
        if (seq !== discoverySeqRef.current) return;
        setDiscoverError(formatActionError(err, dict));
      } finally {
        if (seq === discoverySeqRef.current) setDiscovering(false);
      }
    },
    [dict]
  );

  const translatorOrigin = resolveExternalTargetOrigin(draftExt.endpoint);

  // AP-1：仅无鉴权本机 Ollama（http://127.0.0.1）保留自动防抖模型发现；凡携带 API Key 或已存密钥的外部服务必须由用户显式点击按钮触发。
  useEffect(() => {
    if (!externalExpanded) return;
    const ep = draftExt.endpoint.trim();
    const key = draftExt.apiKey?.trim() || '';
    if (!canAutoDiscoverExternalModels({ provider: draftExt.provider, endpoint: ep, apiKey: key, hasApiKey: savedExtKey })) return;
    const probeKey = `${draftExt.provider}\0${ep}`;
    if (probeKey === lastAutoDiscoveryKeyRef.current) return;
    const timer = window.setTimeout(() => {
      if (lastAutoDiscoveryKeyRef.current === probeKey) return;
      lastAutoDiscoveryKeyRef.current = probeKey;
      void fetchTranslatorModels(draftExt.provider, ep);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [externalExpanded, draftExt.provider, draftExt.endpoint, draftExt.apiKey, savedExtKey, fetchTranslatorModels]);

  const selectedModelMeta = useMemo<ExternalReviewerModelOption>(() => {
    const found = discoveredModels.find((m) => m.id === draftExt.model);
    if (found) return found;
    const inferred = inferSupportedThinkingLevels(draftExt.provider, draftExt.model);
    return {
      id: draftExt.model,
      displayName: draftExt.model,
      ...inferred,
    };
  }, [discoveredModels, draftExt.model, draftExt.provider]);

  // FE-01：测试通过后草稿尚未启用（enabled=false），状态徽章应按「连通性」判断，而不是要求已启用。
  const draftConnected = isExternalTranslatorConnected({ ...draftExt, enabled: true });
  const transCum = externalTranslatorTelemetry?.cumulativeAllTime;

  async function handleSelectEngine(nextEngine: 'local' | 'external-api'): Promise<void> {
    setExtError(null);
    if (nextEngine === 'local') {
      setConnectPrompt(false);
      if (effectiveTranslation.engine !== 'local') {
        setSavingExt(true);
        try {
          await applyTranslationUpdate({ engine: 'local' });
        } catch (err) {
          setExtError(formatActionError(err, dict));
        } finally {
          setSavingExt(false);
        }
      }
      return;
    }

    if (!savedExternalConnected) {
      setConnectPrompt(true);
      setExternalExpanded(true);
      window.setTimeout(() => {
        if (typeof configCardRef.current?.scrollIntoView === 'function') {
          configCardRef.current.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
        }
        apiKeyInputRef.current?.focus();
      }, 30);
      return;
    }

    setConnectPrompt(false);
    if (effectiveTranslation.engine !== 'external-api') {
      setSavingExt(true);
      try {
        await applyTranslationUpdate({ engine: 'external-api' });
      } catch (err) {
        setExtError(formatActionError(err, dict));
      } finally {
        setSavingExt(false);
      }
    }
  }

  /** 测试与保存共用的规范化：去除首尾空白并钳制超时与输出上限，保证测试通过的参数就是保存的参数。 */
  function normalizeExternalTranslatorDraft(cfg: ExternalTranslatorConfig): ExternalTranslatorConfig {
    return {
      ...cfg,
      endpoint: cfg.endpoint.trim(),
      model: cfg.model.trim(),
      timeoutMs: Math.max(100, Math.min(60000, cfg.timeoutMs || EXTERNAL_TRANSLATOR_DEFAULTS.timeoutMs)),
      maxOutputTokens: Math.max(
        64,
        Math.min(
          selectedModelMeta.outputTokenLimit || 65536,
          cfg.maxOutputTokens || EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens
        )
      ),
    };
  }

  async function handleTestConnection(): Promise<void> {
    if (testing) return;
    const seq = ++testSeqRef.current;
    setTesting(true);
    setTestResult(null);
    setExtError(null);
    const normalized = normalizeExternalTranslatorDraft(draftExt);
    // 把钳制后的参数同步回草稿（不重置验证状态，也不触发上面的 effect 丢弃本次在途测试结果）。
    if (
      normalized.model !== draftExt.model ||
      normalized.timeoutMs !== draftExt.timeoutMs ||
      normalized.maxOutputTokens !== draftExt.maxOutputTokens
    ) {
      skipNextTestResetRef.current = true;
    }
    restoreDraftExt((prev) => ({
      ...prev,
      endpoint: normalized.endpoint,
      model: normalized.model,
      timeoutMs: normalized.timeoutMs,
      maxOutputTokens: normalized.maxOutputTokens,
    }));
    try {
      const res = await getDesktopBridge().testExternalTranslatorConnection(
        projectApiKeyForSubmit({ ...normalized, enabled: true }, extKeyCleared)
      );
      if (seq !== testSeqRef.current) return;
      setTestResult(res);
      setDraftExt((prev) => ({
        ...prev,
        connectionStatus: res.ok ? 'connected' : 'failed',
        enabled: res.ok && (prev.enabled || connectPrompt),
        verifiedBy: res.ok ? 'translation-call' : undefined,
        lastVerifiedAt: res.ok ? res.verifiedAt || new Date().toISOString() : undefined,
      }));
    } catch (err) {
      if (seq !== testSeqRef.current) return;
      const msg = formatActionError(err, dict);
      setTestResult({ ok: false, latencyMs: 0, error: msg });
      setDraftExt((prev) => ({ ...prev, verifiedBy: undefined, lastVerifiedAt: undefined, connectionStatus: 'failed' }));
    } finally {
      if (seq === testSeqRef.current) setTesting(false);
    }
  }

  function resetConnectionDraft(): void {
    ++discoverySeqRef.current;
    ++testSeqRef.current;
    lastAutoDiscoveryKeyRef.current = '';
    setDiscovering(false);
    setTesting(false);
    setDiscoveredModels([]);
    setDiscoverError(null);
    setTestResult(null);
  }

  async function handleSaveExternalTranslator(): Promise<void> {
    if (savingExt) return;
    setSavingExt(true);
    setExtError(null);
    const sanitized = normalizeExternalTranslatorDraft(draftExt);
    // 直接写回规范化草稿：参数与测试时一致，保留已验证的连接状态。
    restoreDraftExt(() => sanitized);
    const readyAfterSave = isExternalTranslatorConnected(sanitized);
    try {
      if (sanitized.enabled && !readyAfterSave) {
        throw new Error(
          sanitized.connectionStatus === 'failed'
            ? dict.ui.copy.externalTranslatorConnectionFailedCheck
            : dict.ui.copy.runASuccessfulTranslationTest
        );
      }
      const shouldSwitchExternal = readyAfterSave && connectPrompt;
      const submitted = projectApiKeyForSubmit(sanitized, extKeyCleared);
      await applyTranslationUpdate({
        ...(shouldSwitchExternal ? { engine: 'external-api' as const } : {}),
        externalTranslator: submitted,
      });
      // D4 + F-10：保存成功后清空渲染层明文 apiKey 草稿并复位清除标记，与主进程投影一致，防止误触发未保存草稿拦截。
      const nextHasKey = Boolean(submitted.apiKey?.trim()) || (Boolean(savedExt.hasApiKey) && sameExternalService(savedExt, submitted) && !extKeyCleared);
      restoreDraftExt((prev) =>
        sameTranslatorSettings(prev, sanitized) ? { ...sanitized, apiKey: undefined, hasApiKey: nextHasKey } : prev
      );
      setExtKeyCleared(false);
      if (readyAfterSave) setConnectPrompt(false);
      setSavedExtFlash(true);
      window.setTimeout(() => setSavedExtFlash(false), 1800);
    } catch (err) {
      setExtError(formatActionError(err, dict));
    } finally {
      setSavingExt(false);
    }
  }

  return (
    <div className="settings-section">
      {prefsFeedback}
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label">{dict.languageLabel}</span>
          <span className="spacer" />
          <div className="segmented">
            <button
              type="button"
              className={`segmented-btn ${dict.ui.copy.labelItem}`}
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
                onClick={() => void savePref({ defaultThoughtTrack: track })}
              >
                {track === 'zh' ? dict.thoughtTrackZh : dict.thoughtTrackRaw}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row setting-row-wrap-loose">
          <span className="setting-label">{dict.translationEngineLabel}</span>
          <span className="spacer" />
          <div className="segmented" data-testid="translation-engine">
            <button
              type="button"
              className={`segmented-btn ${effectiveTranslation.engine === 'local' ? 'is-active' : ''}`}
              disabled={savingExt}
              onClick={() => void handleSelectEngine('local')}
              data-testid="translation-engine-local"
            >
              {dict.translationEngineLocal}
            </button>
            <button
              type="button"
              className={`segmented-btn ${effectiveTranslation.engine === 'external-api' ? 'is-active' : ''}`}
              disabled={savingExt}
              onClick={() => void handleSelectEngine('external-api')}
              data-testid="translation-engine-external"
            >
              <span>{dict.translationEngineExternal}</span>
              {!savedExternalConnected && (
                <span className="muted settings-title-aside-xs">
                  ({dict.ui.copy.off})
                </span>
              )}
            </button>
          </div>
        </div>
        {connectPrompt && !savedExternalConnected && (
          <div
            className="setting-row settings-inline-warning"
            data-testid="translation-external-connect-prompt"
          >
            <span className="flex-1">{dict.translationExternalConnectPrompt}</span>
          </div>
        )}
        <div className="setting-row" title={dict.processPerSessionDesc}>
          <span className="setting-label">{dict.processPerSessionLabel}</span>
          <span className="badge badge-mono">--process-per-session</span>
          <span className="spacer" />
          <label className="switch">
            <input
              type="checkbox"
              checked={preferences.processPerSession}
              aria-label={dict.processPerSessionLabel}
              onChange={(e) => void savePref({ processPerSession: e.target.checked })}
            />
            <span className="switch-track" />
          </label>
        </div>
      </div>

      {/* 独立外部翻译 API 配置卡片（与 AI 代审完全隔离） */}
      <div
        ref={configCardRef}
        className="settings-group translator-config-card"
        data-testid="external-translator-config-card"
      >
        <div className="setting-row translator-card-head setting-row-wrap-tight">
          <button
            type="button"
            className="translator-card-toggle"
            aria-expanded={externalExpanded}
            onClick={() => setExternalExpanded((v) => !v)}
            data-testid="external-translator-expand-btn"
          >
            {externalExpanded ? <UiIcon icon={ChevronDown} size="sm" /> : <UiIcon icon={ChevronRight} size="sm" />}
            <UiIcon icon={Languages} size="sm" />
            <span className="setting-label">{dict.translationExternalCardTitle}</span>
          </button>
          <span
            className={`badge ${
              draftConnected
                ? 'badge-success'
                : draftExt.connectionStatus === 'failed'
                  ? 'badge-danger'
                  : 'badge-warning'
            }`}
            data-testid="translator-connection-badge"
          >
            {draftConnected
              ? dict.ui.copy.connected
              : draftExt.connectionStatus === 'failed'
                ? dict.ui.copy.failed
                : dict.ui.copy.notConnected2}
          </span>
          <span className="spacer" />
          <span
            className="muted mono text-xs"
            data-testid="translator-settings-usage-summary"
          >
            {transCum && transCum.callCount > 0
              ? `${dict.ui.copy.allTime} ${transCum.callCount}× · ${formatTokenShort(transCum.totalTokens)} tok · ${formatUsd(transCum.totalCostUsd)}`
              : `${dict.ui.copy.allTime} 0× · $0.00`}
          </span>
          {onOpenTranslatorStats && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onOpenTranslatorStats}
              data-testid="translator-open-stats-btn"
            >
              <UiIcon icon={BarChart3} size="xs" />
              <span>{dict.translationExternalViewStatsBtn}</span>
            </button>
          )}
        </div>

        {externalExpanded && (
          <div data-testid="external-translator-form">
            {extError && (
              <div className="setting-row">
                <div role="alert" className="alert flex-1">
                  {extError}
                </div>
              </div>
            )}

            <div className="setting-row setting-row-note">
              <span className="muted">{dict.translationExternalBanner}</span>
            </div>

            {savedExternalConnected && effectiveTranslation.engine === 'local' && (
              <div
                className="setting-row settings-inline-accent"
                data-testid="translator-mode-ready-banner"
              >
                <span className="flex-1">
                  {dict.ui.copy.externalTranslationApiIsReady}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingExt}
                  onClick={() => void handleSelectEngine('external-api')}
                  data-testid="switch-to-external-translation-btn"
                >
                  {dict.ui.copy.switchToExternalApi}
                </button>
              </div>
            )}

            <div className="setting-row">
              <span className="setting-label">{dict.translationExternalEnableToggle}</span>
              <span className="spacer" />
              <label className="switch">
                <input
                  type="checkbox"
                  checked={draftExt.enabled}
                  disabled={!isExternalTranslatorConnected({ ...draftExt, enabled: true })}
                  aria-label={dict.translationExternalEnableToggle}
                  onChange={(e) => setDraftExt((prev) => ({ ...prev, enabled: e.target.checked }))}
                  data-testid="translator-enable-switch"
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerProviderLabel}</span>
              </span>
              <select
                className="input w-260"
                value={draftExt.provider}
                onChange={(e) => {
                  const nextProvider = e.target.value as ExternalTranslatorConfig['provider'];
                  const defaultsByProvider: Record<
                    ExternalTranslatorConfig['provider'],
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
                      model: 'qwen2.5:7b',
                    },
                  };
                  resetConnectionDraft();
                  setCustomModelMode(false);
                  setDraftExt((prev) => ({
                    ...prev,
                    provider: nextProvider,
                    apiKey: '',
                    hasApiKey: sameExternalService(savedExt, { provider: nextProvider, endpoint: defaultsByProvider[nextProvider].endpoint })
                      ? savedExt.hasApiKey
                      : false,
                    lastVerifiedAt: undefined,
                    endpoint: defaultsByProvider[nextProvider].endpoint,
                    model: defaultsByProvider[nextProvider].model,
                    thinkingLevel: EXTERNAL_TRANSLATOR_DEFAULTS.thinkingLevel,
                    connectionStatus: 'untested',
                  }));
                }}
                aria-label={dict.reviewerProviderLabel}
                data-testid="translator-provider-select"
              >
                <option value="gemini-api-key">{dict.reviewerProviderGemini}</option>
                <option value="openai-compatible">{dict.reviewerProviderOpenAi}</option>
                <option value="local-ollama">{dict.reviewerProviderOllama}</option>
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerEndpointLabel}</span>
                <span className="setting-desc mono" data-testid="translator-target-origin">
                  {translatorOrigin ? dict.ui.v035.targetOrigin(translatorOrigin) : dict.ui.v035.targetOriginInvalid}
                </span>
                <span className="setting-desc" data-testid="translator-auto-discover-hint">
                  {dict.ui.v035.autoDiscoverLocalOnly}
                </span>
              </span>
              <input
                className="input input-mono w-280"
                type="text"
                value={draftExt.endpoint ?? ''}
                onChange={(e) => {
                  const endpoint = e.target.value;
                  resetConnectionDraft();
                  setDraftExt((prev) => ({
                    ...prev, endpoint, apiKey: sameExternalService(prev, { endpoint }) ? prev.apiKey : '',
                    hasApiKey: sameExternalService(savedExt, { provider: prev.provider, endpoint })
                      ? savedExt.hasApiKey && !extKeyCleared
                      : false,
                    lastVerifiedAt: undefined, connectionStatus: 'untested',
                  }));
                }}
                aria-label={dict.reviewerEndpointLabel}
                data-testid="translator-endpoint-input"
              />
            </div>

            {draftExt.provider !== 'local-ollama' ? (
              <div className="setting-row setting-row-wrap">
                <span className="setting-text setting-text-grow">
                  <span className="setting-label">{dict.reviewerApiKeyLabel}</span>
                  <span className="setting-desc">
                    {discovering ? (
                      dict.reviewerDiscovering
                    ) : discoverError ? (
                      <span className="text-danger">{discoverError}</span>
                    ) : discoveredModels.length > 0 ? (
                      <span className="text-success">
                        {dict.reviewerDiscoveredCount(discoveredModels.length)}
                      </span>
                    ) : draftExt.apiKey?.trim() ? (
                      <span className="text-success">{dict.ui.copy.keyEntered}</span>
                    ) : extKeyCleared ? (
                      <span className="text-warning" data-testid="translator-apikey-cleared">{v034.apiKeyCleared}</span>
                    ) : extKeyNeedsReentry ? (
                      <span className="text-warning" role="note" data-testid="translator-apikey-reenter">{v034.apiKeyReenterHint}</span>
                    ) : savedExtKey ? (
                      <span className="text-success">{dict.translationSavedKeyHint}</span>
                    ) : (
                      dict.reviewerDiscoverPromptHint
                    )}
                  </span>
                </span>
                <div className="inline-cluster">
                  <input
                    ref={apiKeyInputRef}
                    className="input input-mono w-210"
                    type="password"
                    value={draftExt.apiKey ?? ''}
                    placeholder={savedExtKey ? v034.apiKeySavedPlaceholder : undefined}
                    autoComplete="off"
                    onChange={(e) => {
                      const apiKey = e.target.value;
                      resetConnectionDraft();
                      setDraftExt((prev) => ({ ...prev, apiKey, lastVerifiedAt: undefined, connectionStatus: 'untested' }));
                    }}
                    aria-label={dict.reviewerApiKeyLabel}
                    data-testid="translator-apikey-input"
                  />
                  {(savedExtKey || extKeyCleared) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        resetConnectionDraft();
                        if (extKeyCleared) {
                          setExtKeyCleared(false);
                          restoreDraftExt((prev) => ({ ...prev, hasApiKey: savedExt.hasApiKey }));
                        } else {
                          setExtKeyCleared(true);
                          restoreDraftExt((prev) => ({
                            ...prev, apiKey: '', hasApiKey: false, enabled: false,
                            lastVerifiedAt: undefined, verifiedBy: undefined, connectionStatus: 'untested',
                          }));
                        }
                      }}
                      data-testid="translator-apikey-clear-btn"
                    >
                      {extKeyCleared ? v034.apiKeyUndoClear : v034.apiKeyClear}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={discovering || !draftExt.endpoint.trim() || (!draftExt.apiKey?.trim() && !savedExtKey)}
                    onClick={() => {
                      lastAutoDiscoveryKeyRef.current = `${draftExt.provider}\0${draftExt.endpoint.trim()}\0${draftExt.apiKey?.trim() || ''}`;
                      void fetchTranslatorModels(draftExt.provider, draftExt.endpoint, draftExt.apiKey);
                    }}
                    data-testid="discover-translator-models-btn"
                  >
                    <UiIcon icon={RefreshCw} size="sm" className={discovering ? 'spin' : ''} />
                    <span>{dict.translationExternalDiscoverBtn}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="setting-row">
                <span className="setting-text">
                  <span className="setting-label">{dict.translationExternalDiscoverBtn}</span>
                  <span className="setting-desc">
                    {discovering ? (
                      dict.reviewerDiscovering
                    ) : discoverError ? (
                      <span className="text-danger">{discoverError}</span>
                    ) : discoveredModels.length > 0 ? (
                      <span className="text-success">
                        {dict.reviewerDiscoveredCount(discoveredModels.length)}
                      </span>
                    ) : dict.ui.copy.fetchInstalledModelsFromLocal}
                  </span>
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={discovering || !draftExt.endpoint.trim()}
                  onClick={() => {
                    lastAutoDiscoveryKeyRef.current = `${draftExt.provider}\0${draftExt.endpoint.trim()}\0`;
                    void fetchTranslatorModels(draftExt.provider, draftExt.endpoint);
                  }}
                  data-testid="discover-translator-models-btn"
                >
                  <UiIcon icon={RefreshCw} size="sm" className={discovering ? 'spin' : ''} />
                  <span>{dict.translationExternalDiscoverBtn}</span>
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
                  value={discoveredModels.some((m) => m.id === draftExt.model) ? draftExt.model : '__custom__'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '__custom__') {
                      setCustomModelMode(true);
                      return;
                    }
                    const nextMeta = discoveredModels.find((m) => m.id === val);
                    setDraftExt((prev) => {
                      const curMax = prev.maxOutputTokens || EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens;
                      const nextMax =
                        nextMeta?.outputTokenLimit && curMax > nextMeta.outputTokenLimit
                          ? nextMeta.outputTokenLimit
                          : curMax;
                      return {
                        ...prev,
                        model: val,
                        maxOutputTokens: nextMax,
                      };
                    });
                  }}
                  aria-label={dict.reviewerModelLabel}
                  data-testid="translator-model-select"
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
                    value={draftExt.model ?? ''}
                    onChange={(e) => setDraftExt((prev) => ({ ...prev, model: e.target.value }))}
                    aria-label={dict.reviewerModelLabel}
                    data-testid="translator-model-input"
                  />
                  {discoveredModels.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setCustomModelMode(false)}
                    >
                      {dict.ui.copy.list}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerThinkingLabel}</span>
                <span className="setting-desc">
                  {dict.ui.copy.offIsRecommendedForFast}
                </span>
              </span>
              <select
                className="input w-220"
                value={draftExt.thinkingLevel ?? EXTERNAL_TRANSLATOR_DEFAULTS.thinkingLevel}
                onChange={(e) =>
                  setDraftExt((prev) => ({
                    ...prev,
                    thinkingLevel: e.target.value as ExternalReviewerThinkingLevel,
                  }))
                }
                aria-label={dict.reviewerThinkingLabel}
                data-testid="translator-thinking-select"
              >
                {ALL_TRANSLATOR_THINKING_LEVELS.map((lv) => (
                  <option key={lv} value={lv}>
                    {dict.reviewerThinkingLevels[lv]}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerMaxOutputLabel}</span>
                <span className="setting-desc">{dict.translationMaxOutputHint}</span>
              </span>
              <DraftNumberInput
                className="input input-mono w-120"
                min={64}
                max={selectedModelMeta.outputTokenLimit || 65536}
                step={256}
                integer
                fallback={EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens}
                value={draftExt.maxOutputTokens ?? EXTERNAL_TRANSLATOR_DEFAULTS.maxOutputTokens}
                onValueChange={(maxOutputTokens) => setDraftExt((prev) => ({ ...prev, maxOutputTokens }))}
                aria-label={dict.reviewerMaxOutputLabel}
                data-testid="translator-max-output-input"
              />
            </div>

            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">{dict.reviewerTimeoutLabel}</span>
                <span className="setting-desc">{dict.translationTimeoutHint}</span>
              </span>
              <DraftNumberInput
                className="input input-mono w-120"
                min={100}
                max={60000}
                step={500}
                integer
                fallback={EXTERNAL_TRANSLATOR_DEFAULTS.timeoutMs}
                value={draftExt.timeoutMs}
                onValueChange={(timeoutMs) => setDraftExt((prev) => ({ ...prev, timeoutMs }))}
                aria-label={dict.reviewerTimeoutLabel}
                data-testid="translator-timeout-input"
              />
            </div>

            {testResult && (
              <div
                className={`setting-row settings-inline-result ${testResult.ok ? 'tone-success' : 'tone-danger'}`}
                data-testid="translator-test-result"
              >
                {testResult.ok ? (
                  <span className="text-success">
                    {isZh
                      ? `测试通过 (${testResult.latencyMs}ms)${testResult.sampleTranslation ? ` · 示例译文：「${testResult.sampleTranslation}」` : ''}`
                      : `Connection OK (${testResult.latencyMs}ms)${testResult.sampleTranslation ? ` · Sample: "${testResult.sampleTranslation}"` : ''}`}
                  </span>
                ) : (
                  <span className="text-danger">
                    {testResult.error || dict.unknownError}
                  </span>
                )}
              </div>
            )}

            <div className="setting-row gap-8">
              <button
                type="button"
                className="btn btn-sm"
                disabled={testing || !draftExt.endpoint.trim() || !draftExt.model.trim() ||
                  (draftExt.provider !== 'local-ollama' && !draftExt.apiKey?.trim() && !savedExtKey)}
                title={draftExt.provider !== 'local-ollama' && !draftExt.apiKey?.trim() && !savedExtKey ? dict.ui.v031.testNeedsKey : undefined}
                onClick={() => void handleTestConnection()}
                data-testid="test-translator-connection-btn"
              >
                <UiIcon icon={testing ? Loader2 : PlugZap} size="xs" className={testing ? 'spin' : ''} />
                <span>{testing ? dict.translationExternalTesting : dict.translationExternalTestBtn}</span>
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={savingExt}
                onClick={() => void handleSaveExternalTranslator()}
                data-testid="save-translator-config-btn"
              >
                {savedExtFlash ? <UiIcon icon={Check} size="xs" /> : null}
                <span>{savedExtFlash ? dict.savedHint : dict.translationExternalSaveBtn}</span>
              </button>
              <span className="spacer" />
            </div>
          </div>
        )}
      </div>

      <h3 className="settings-group-title">{dict.ui.copy.display}</h3>
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label">{dict.ui.uiScaleLabel}</span>
          <span className="kbd">{shortcut('=', 'keycap')} / {shortcut('−', 'keycap')}</span>
          <span className="spacer" />
          <div className="scale-control" data-testid="ui-scale-control">
            <input
              type="range"
              min={UI_SCALE_LIMITS.min}
              max={UI_SCALE_LIMITS.max}
              step={0.05}
              value={scale}
              aria-label={dict.ui.uiScaleLabel}
              onChange={(e) => { scaleControl.current.draft = Number(e.target.value); setScale(scaleControl.current.draft); }}
              onPointerUp={() => saveScale()}
              onMouseUp={() => saveScale()}
              onKeyUp={() => saveScale()}
              onBlur={() => saveScale()}
              data-testid="ui-scale-range"
            />
            <span className="scale-value mono">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={scale === UI_SCALE_LIMITS.default}
              onClick={() => { setScale(UI_SCALE_LIMITS.default); saveScale(UI_SCALE_LIMITS.default); }}
            >
              {dict.ui.resetAction}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <span className="setting-label">{dict.ui.copy.defaultFolder2}</span>
          <span className="muted truncate mono text-sm">
            {preferences.defaultWorkspaceCwd || '—'}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onOpenProjectsTab}>
            <UiIcon icon={FolderKanban} size="sm" />
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
  const { dict, mac } = useI18n();
  const { save: savePref, feedback: prefsFeedback } = usePrefsFeedback(onUpdatePreferences);
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

  // F-10：默认目录或项目表单存在未保存修改时上报草稿，关闭设置前需确认。
  const editingOriginal = editingId ? projects.find((p) => p.id === editingId) : undefined;
  const projectFormDirty = editingOriginal
    ? projName !== editingOriginal.name ||
      projPath !== editingOriginal.path ||
      projDesc !== (editingOriginal.description || '') ||
      projMode !== (editingOriginal.defaultMode || '')
    : Boolean(projName.trim() || projPath.trim() || projDesc.trim());
  useSettingsDirty('projects-form', projectFormDirty);
  useSettingsDirty('projects-default-cwd', defaultCwd.trim() !== (preferences.defaultWorkspaceCwd || '').trim());

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
          ...projects.filter((p) => normalizeProjectCompareKey(p.path) !== normalizeProjectCompareKey(normalizedPath)),
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
      {prefsFeedback}
      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      <h3 className="settings-group-title">{dict.ui.copy.defaultFolder2}</h3>
      <div className="settings-group settings-group-padded">
        <div className="inline-row">
          <input
            className="input input-mono flex-1"
            placeholder={dict.ui.v032.defaultCwdPlaceholder(mac)}
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
            <UiIcon icon={FolderOpen} size="sm" />
            <span>{dict.ui.copy.browse}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saveDefaultFolder()}
            data-testid="settings-save-default-cwd-btn"
          >
            {defaultSaved ? <UiIcon icon={Check} size="sm" /> : null}
            <span>{defaultSaved ? dict.savedHint : dict.saveAction}</span>
          </button>
        </div>
      </div>

      <h3 className="settings-group-title">
        {editingId ? (dict.ui.copy.editProject) : dict.ui.copy.addProject}
      </h3>
      <form className="settings-group settings-group-padded settings-form-stack" onSubmit={(e) => void submitProject(e)}>
        <div className="settings-form-grid">
          <input
            className="input"
            placeholder={dict.ui.copy.projectName2}
            value={projName}
            onChange={(e) => setProjName(e.target.value)}
            data-testid="project-name-input"
            required
          />
          <select
            className="input"
            aria-label={dict.ui.copy.defaultMode}
            value={projMode}
            onChange={(e) => setProjMode(e.target.value as AgentExecutionMode | '')}
            data-testid="project-mode-select"
          >
            <option value="">{dict.ui.copy.defaultMode2}</option>
            {EXECUTION_MODE_ORDER.map((m) => (
              <option key={m} value={m}>
                {m === 'full-access' ? `${dict.executionModes[m].label} (full-access)` : dict.executionModes[m].label}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-row">
          <input
            className="input input-mono flex-1"
            placeholder={dict.ui.copy.projectFolderPath}
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
            <UiIcon icon={FolderOpen} size="sm" />
            <span>{dict.ui.copy.browse2}</span>
          </button>
        </div>
        <div className="inline-cluster">
          <input
            className="input flex-1"
            placeholder={dict.ui.copy.noteOptional}
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
            <UiIcon icon={Plus} size="sm" />
            <span>{editingId ? dict.saveAction : dict.ui.copy.addProject2}</span>
          </button>
        </div>
      </form>

      <h3 className="settings-group-title">
        {dict.ui.copy.fmtProjects(projects.length)}
      </h3>
      <div className="settings-group">
        {projects.length === 0 ? (
          <div className="empty-state">
            {dict.ui.copy.noProjectsYet}
          </div>
        ) : (
          projects.map((proj) => {
            const isDef =
              Boolean(preferences.defaultWorkspaceCwd) &&
              normalizeProjectCompareKey(preferences.defaultWorkspaceCwd || '') === normalizeProjectCompareKey(proj.path);
            return (
              <div key={proj.id} className="list-row" data-testid={`project-row-${proj.id}`}>
                <span className="list-icon">
                  <UiIcon icon={FolderKanban} size="md" />
                </span>
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span>{proj.name}</span>
                    {proj.pinned && <span className="badge badge-accent">{dict.ui.copy.pinned}</span>}
                    {proj.defaultMode && <span className={`badge badge-mono${proj.defaultMode === 'full-access' ? ' badge-turbo' : ''}`}>{proj.defaultMode === 'full-access' ? <><UiIcon icon={Zap} size="xs" />{dict.executionModes[proj.defaultMode].label}</> : proj.defaultMode}</span>}
                    {isDef && <span className="badge badge-success">{dict.ui.copy.default}</span>}
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
                      <UiIcon icon={Plus} size="xs" />
                      <span>{dict.newSession}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={dict.ui.copy.setAsDefaultFolder}
                    aria-label={dict.ui.copy.setAsDefaultFolder}
                    onClick={() => void savePref({ defaultWorkspaceCwd: proj.path })}
                    data-testid={`set-default-project-${proj.id}`}
                  >
                    <UiIcon icon={Star} size="sm" style={{ color: isDef ? 'var(--accent-primary)' : undefined }} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={proj.pinned ? dict.unpinSession : dict.pinSession}
                    aria-label={proj.pinned ? dict.unpinSession : dict.pinSession}
                    onClick={() =>
                      void savePref({
                        projects: projects.map((p) => (p.id === proj.id ? { ...p, pinned: !p.pinned } : p)),
                      })
                    }
                  >
                    <UiIcon icon={Pin} size="sm" style={{ color: proj.pinned ? 'var(--accent-primary)' : undefined }} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={dict.ui.copy.editProject}
                    aria-label={dict.ui.copy.editProject}
                    onClick={() => {
                      setEditingId(proj.id);
                      setProjName(proj.name);
                      setProjPath(proj.path);
                      setProjDesc(proj.description || '');
                      setProjMode(proj.defaultMode || '');
                    }}
                    data-testid={`edit-project-${proj.id}`}
                  >
                    <UiIcon icon={Pencil} size="sm" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    title={dict.deleteAction}
                    aria-label={dict.deleteAction}
                    onClick={() => {
                      // 删除正在编辑的项目时同步退出编辑态，否则随后的保存会因找不到原条目而静默失效。
                      if (editingId === proj.id) resetForm();
                      void savePref({
                        projects: projects.filter((p) => p.id !== proj.id),
                      }).catch((err) => setError(formatActionError(err, dict)));
                    }}
                    data-testid={`delete-project-${proj.id}`}
                  >
                    <UiIcon icon={Trash2} size="sm" />
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
  const { dict, shortcut, keys } = useI18n();
  const { save: savePref, feedback: prefsFeedback } = usePrefsFeedback(onUpdatePreferences);
  const icon = resolveGravityIconVariant(preferences.appIcon, preferences.theme, preferences.customTheme);
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
    [dict.shortcutLabels.newThread, shortcut('N', 'keycap')],
    [dict.shortcutLabels.sidebar, shortcut('B', 'keycap')],
    [dict.shortcutLabels.inspector, shortcut('J', 'keycap')],
    [dict.shortcutLabels.split, shortcut('\\', 'keycap')],
    [dict.shortcutLabels.mode, keys(['shift', 'tab'], 'keycap')],
    [dict.shortcutLabels.settings, shortcut(',', 'keycap')],
  ];

  const openExternal = (target: string) => {
    void getDesktopBridge().openLinkOrFileTarget({ target, action: 'browser' }).catch(() => {});
  };

  const currentVer = (updateState.currentVersion || APP_BRAND.version || '').trim();
  const latestVer = (updateState.latestVersion || '').trim();

  return (
    <div className="settings-section" data-testid="about-gravity-modal">
      {prefsFeedback}
      <div className="about-hero">
        <img src={icon.publicSvgUrl} alt={APP_BRAND.name} />
        <div>
          <div className="inline-cluster">
            <h3>{APP_BRAND.name}</h3>
            <span className="badge badge-accent badge-mono" data-testid="about-current-version">
              {currentVer ? `v${currentVer}` : dict.ui.v035.updateVersionUnknown}
            </span>
          </div>
          <div className="muted mt-4">{dict.appTagline}</div>
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
            <UiIcon icon={ExternalLink} size="sm" />
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
              onChange={(e) => void savePref({ autoCheckUpdates: e.target.checked })}
              data-testid="auto-check-updates-toggle"
            />
            <span className="switch-track" />
          </label>
        </div>

        <div className="setting-row update-status-row">
          <div className="update-status-copy">
            {updateState.status === 'checking' && (
              <span className="update-status-line muted">
                <UiIcon icon={RefreshCw} size="sm" className="spin" />
                <span>{dict.updatesChecking}</span>
              </span>
            )}
            {updateState.status === 'up-to-date' && (
              <span className="update-status-line text-success">
                <UiIcon icon={Check} size="sm" />
                <span>
                  {dict.updatesUpToDate}
                  {latestVer ? ` (v${latestVer})` : ''}
                </span>
              </span>
            )}
            {updateState.status === 'available' && (
              <div className="update-available-meta">
                <span className="badge badge-accent badge-mono" data-testid="update-available-version">
                  {latestVer ? dict.updatesAvailableBadge(latestVer) : dict.ui.v035.updateVersionUnknown}
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
                <div
                  className="update-progress-track"
                  role="progressbar"
                  aria-label={dict.ui.v035.updateProgressLabel}
                  aria-valuenow={progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  data-testid="update-download-progress"
                >
                  <div className="update-progress-fill" style={{ '--fill': progressPct / 100 } as React.CSSProperties} />
                </div>
              </div>
            )}
            {updateState.status === 'downloaded' && (
              <div className="update-available-meta">
                <span className="badge badge-success badge-mono" data-testid="update-downloaded-version">
                  {latestVer ? `v${latestVer}` : dict.ui.v035.updateVersionUnknown}
                </span>
                <span className="muted truncate">{updateState.asset?.name}</span>
              </div>
            )}
            {updateState.status === 'installing' && (
              <span className="update-status-line muted">
                <UiIcon icon={Loader2} size="sm" className="spin" />
                <span>{dict.updatesInstalling}</span>
              </span>
            )}
            {updateState.status === 'error' && (
              <span className="update-status-line text-danger">
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
                <UiIcon icon={Download} size="sm" />
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
                <UiIcon icon={Download} size="sm" />
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
              <UiIcon icon={RefreshCw} size="sm" className={updateState.status === 'checking' ? 'spin' : ''} />
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
          <div key={label} className="setting-row setting-row-compact">
            <span className="setting-label setting-label-regular">
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
const SETTINGS_NAV_WIDTH_KEY = 'gravity.settings.navWidth';
const SETTINGS_NAV_DEFAULT = 216;

function readNavWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(SETTINGS_NAV_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= 176 && raw <= 300) return Math.round(raw);
  } catch {
    // localStorage 不可用时使用默认宽度
  }
  return SETTINGS_NAV_DEFAULT;
}

export function SettingsView(props: SettingsViewProps): React.ReactElement {
  const { dict, keys, mac } = useI18n();
  const { section, onSectionChange, onClose } = props;
  const [navWidth, setNavWidth] = useState(readNavWidth);
  const dialogRef = useFocusTrap<HTMLDivElement>(true);

  // F-10：汇总各分区上报的未保存草稿；存在草稿时 Esc / ✕ / Ctrl+, 先弹出确认条，背景点击永不关闭（D3）。
  const dirtyKeysRef = useRef(new Set<string>());
  const [dirtyCount, setDirtyCount] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    const set = dirtyKeysRef.current;
    const had = set.has(key);
    if (dirty === had) return;
    if (dirty) set.add(key);
    else set.delete(key);
    setDirtyCount(set.size);
  }, []);
  const dirty = dirtyCount > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const confirmRef = useRef(confirmClose);
  confirmRef.current = confirmClose;
  const pendingRef = useRef<SettingsSection | null>(null);
  useEffect(() => {
    if (!dirty) {
      setConfirmClose(false);
      setPendingSection(null);
    }
  }, [dirty]);
  // B1：存在未保存草稿时切换分组先提示（继续编辑 / 放弃修改），避免卸载分区静默丢稿
  const [pendingSection, setPendingSection] = useState<SettingsSection | null>(null);
  pendingRef.current = pendingSection;
  const requestSection = useCallback((id: SettingsSection) => {
    if (id === section) return;
    if (dirtyRef.current) {
      setPendingSection(id);
      return;
    }
    onSectionChange(id);
  }, [onSectionChange, section]);
  const discardAndSwitch = useCallback(() => {
    const target = pendingSection;
    dirtyKeysRef.current.clear();
    setDirtyCount(0);
    setPendingSection(null);
    if (target) onSectionChange(target);
  }, [onSectionChange, pendingSection]);

  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }, [onClose]);

  // Escape 交给当前设置页关闭回调。组件卸载时移除监听，以便工作台恢复对快捷键的处理。
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // 输入法组词中的 Esc 只取消候选，不关闭设置中心。
      if (isImeComposing(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        // 确认条打开时再次 Esc 表示「继续编辑」。
        if (pendingRef.current) setPendingSection(null);
        else if (confirmRef.current) setConfirmClose(false);
        else requestClose();
        return;
      }
      // Ctrl/⌘+, 由工作台切换设置；存在草稿时在捕获阶段截住，改为确认。
      if (isPrimaryModifier(e, mac) && e.key === ',' && dirtyRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setConfirmClose(true);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [requestClose, mac]);

  // 设置导航只挂载当前栏目。保存偏好、执行管理操作等能力从 App 传入，各栏目保留自己的表单草稿。
  let content: React.ReactNode;
  switch (section) {
    case 'general':
      content = (
        <GeneralPanel
          preferences={props.preferences}
          translationConfig={props.translationConfig}
          externalTranslatorTelemetry={props.externalTranslatorTelemetry}
          focusExternalTranslatorSeq={props.focusExternalTranslatorSeq}
          onUpdatePreferences={props.onUpdatePreferences}
          onUpdateTranslationConfig={props.onUpdateTranslationConfig}
          onOpenTranslatorStats={props.onOpenTranslatorStats}
          onOpenProjectsTab={() => onSectionChange('projects')}
        />
      );
      content = (
        <>
          {content}
          <VoiceSettingsCard profileId={props.accounts.activeProfileId} telemetry={props.voiceTelemetry} />
        </>
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
          onClose={requestClose}
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
          initialTab={props.approvalInitialTab}
          externalReviewerTelemetry={props.externalReviewerTelemetry}
          currentSessionId={props.currentSessionId}
          onUpdateConfig={props.onUpdateApprovalConfig}
        />
      );
      break;
    case 'plugins':
      content = (
        <PluginsPanel
          snapshot={props.plugins}
          activeProfile={props.accounts.profiles.find((p) => p.profileId === props.accounts.activeProfileId)}
          onRefresh={props.onRefreshPlugins}
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

  const isAppearance = APPEARANCE_SECTIONS.includes(section);
  const navActive = (id: SettingsSection) => (id === 'themes' ? isAppearance : section === id);

  const hasPendingUpdate =
    props.updateState.status === 'available' || props.updateState.status === 'downloaded';

  return (
    // D3：取消「点击背景即关闭」，防止误触丢失草稿；仅保留右上角 ✕ 与 Esc（带草稿保护）。
    <div className="overlay" data-testid="settings-overlay">
      <div className="settings" role="dialog" aria-modal="true" aria-label={dict.settingsTitle}
        ref={dialogRef} tabIndex={-1} data-testid="theme-settings-modal">
        <nav className="settings-nav" style={{ width: navWidth }}>
          <div className="settings-nav-title">{dict.settingsTitle}</div>
          {(['app', 'workspace', 'info'] as const).map((group) => (
            <React.Fragment key={group}>
              <div className="settings-nav-group">{dict.settingsNavGroups[group]}</div>
              {NAV.filter((item) => item.group === group).map(({ id, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-nav-item ${navActive(id) ? 'is-active' : ''}`}
                  aria-current={navActive(id) ? 'page' : undefined}
                  onClick={() => requestSection(id)}
                  data-testid={`settings-tab-${id}`}
                >
                  <UiIcon icon={Icon} size="md" />
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
            onCommit={(w) => {
              const next = Math.round(w);
              setNavWidth(next);
              try {
                window.localStorage.setItem(SETTINGS_NAV_WIDTH_KEY, String(next));
              } catch {
                // 持久化失败不影响本次会话
              }
            }}
          />
        </nav>
        <section className="settings-main">
          {/* v0.3.6：分组名已在左侧导航高亮显示，标题栏不再重复同一文字 */}
          <header className="settings-head">
            <button type="button" className="icon-btn" onClick={requestClose} aria-label={dict.closeAction} title="Esc"
              data-testid="settings-close-btn">
              <UiIcon icon={X} size="md" />
            </button>
          </header>
          {pendingSection && (
            <div className="settings-discard-bar" role="alertdialog" aria-live="assertive"
              aria-label={dict.ui.v036.settingsDirtyLeave} data-testid="settings-section-dirty-confirm">
              <span>{dict.ui.v036.settingsDirtyLeave}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPendingSection(null)} autoFocus
                data-testid="settings-section-dirty-stay">
                {dict.ui.v036.settingsDirtyStay}
              </button>
              <button type="button" className="btn btn-sm danger" onClick={discardAndSwitch} data-testid="settings-section-dirty-discard">
                {dict.ui.v036.settingsDirtyDiscard}
              </button>
            </div>
          )}
          {confirmClose && (
            <div className="settings-discard-bar" role="alertdialog" aria-live="assertive"
              aria-label={dict.ui.v034.settingsDiscardConfirm} data-testid="settings-discard-confirm">
              <span>{dict.ui.v034.settingsDiscardConfirm}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmClose(false)}
                data-testid="settings-discard-cancel" autoFocus>
                {dict.cancelAction} <span className="kbd">{keys(['esc'], 'keycap')}</span>
              </button>
              <button type="button" className="btn btn-sm danger" onClick={onClose} data-testid="settings-discard-confirm-btn">
                {dict.closeAction}
              </button>
            </div>
          )}
          <SettingsDirtyContext.Provider value={reportDirty}>
            <div className="settings-body">
              {isAppearance && (
                <div
                  className="segmented segmented-sm settings-subnav"
                  role="tablist"
                  aria-label={dict.ui.v035.appearanceSubnavLabel}
                  onKeyDown={(e) => handleTablistKeyDown(e)}
                  data-testid="settings-appearance-subnav"
                >
                  {APPEARANCE_SECTIONS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`settings-subtab-${id}`}
                      aria-selected={section === id}
                      aria-controls="settings-appearance-panel"
                      tabIndex={section === id ? 0 : -1}
                      className={`segmented-btn ${section === id ? 'is-active' : ''}`}
                      onClick={() => onSectionChange(id)}
                      data-testid={id === 'themes' ? 'settings-subtab-themes' : `settings-tab-${id}`}
                    >
                      <UiIcon icon={id === 'themes' ? Palette : id === 'tokens' ? Paintbrush : Sparkles} size="sm" />
                      <span>
                        {id === 'themes'
                          ? dict.ui.v035.appearanceSubTheme
                          : id === 'tokens'
                            ? dict.ui.v035.appearanceSubColors
                            : dict.ui.v035.appearanceSubIcon}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {isAppearance ? (
                <div key={section} role="tabpanel" id="settings-appearance-panel" aria-labelledby={`settings-subtab-${section}`}>
                  {content}
                </div>
              ) : (
                <React.Fragment key={section}>{content}</React.Fragment>
              )}
            </div>
          </SettingsDirtyContext.Provider>
        </section>
      </div>
    </div>
  );
}

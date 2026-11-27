import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  COST_DISCLAIMER,
  EXTERNAL_VOICE_DEFAULTS,
  VOICE_LOCAL_MODEL_SPEC,
  VOICE_MIC_TEST_MAX_DURATION_MS,
  type ExternalReviewerModelOption,
  type VoiceConfigPatch,
  type VoiceEngineMode,
  type VoiceExternalProviderId,
  type VoiceExternalTelemetrySnapshot,
  type VoiceLocale,
  type VoiceStateSnapshot,
} from '@shared';
import { useI18n } from '../../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../../i18n/locales';
import { formatLocalDateTime } from '../../lib/time-format';
import { VoiceCaptureController, listInputDevicesWithLease } from '../../lib/voice/controller';
import { getVoiceBridge } from '../../services/desktop-bridge';
import { formatUsd } from '../ContextStatusBar';
import { useSettingsDirty } from './settings-dirty';
import workletUrl from '../../lib/voice/pcm-worklet.ts?worker&url';

interface ExtVoiceDraft {
  provider: VoiceExternalProviderId;
  endpoint: string;
  model: string;
  apiKey: string;
  rate: string;
}

function extDraftFromSnapshot(next: VoiceStateSnapshot): ExtVoiceDraft {
  const p = next.config.externalProvider;
  return {
    provider: p.provider,
    endpoint: p.endpoint,
    model: p.model,
    apiKey: '',
    rate: p.ratePerMinuteUsd !== undefined ? String(p.ratePerMinuteUsd) : '',
  };
}

/**
 * v0.3.6「设置 → 通用」语音听写卡片。
 *
 * - 静息态 0 次 getUserMedia / enumerateDevices / permissions.query：只有用户点击「选择输入设备」（device-list 租约）
 *   或「3 秒试录」（mic-test 租约）才申请租约，用毕立即 release-media；
 * - 本地模型缺失需用户确认后安装；安装中且卡片可见时以 1 s 单飞轮询 `getVoiceState()` 展示进度；
 * - 外部转写：OpenAI 兼容 / Gemini Developer API，模型发现、测试连接、独立费用摘要（含 COST_DISCLAIMER）。
 */
export function VoiceSettingsCard({
  profileId,
  telemetry,
}: {
  profileId: string;
  telemetry?: VoiceExternalTelemetrySnapshot;
}): React.ReactElement | null {
  const { dict, locale } = useI18n();
  const t = dict.ui.v036;
  const bridge = getVoiceBridge();
  const [state, setState] = useState<VoiceStateSnapshot | null>(null);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }> | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [ext, setExt] = useState<ExtVoiceDraft>({
    provider: EXTERNAL_VOICE_DEFAULTS.provider as VoiceExternalProviderId,
    endpoint: '',
    model: '',
    apiKey: '',
    rate: '',
  });
  const savedExtRef = useRef<ExtVoiceDraft | null>(null);
  const [models, setModels] = useState<ExternalReviewerModelOption[]>([]);
  const [connNotice, setConnNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const inflight = useRef(false);
  const micTestCtrlRef = useRef<VoiceCaptureController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      micTestCtrlRef.current?.dispose();
      micTestCtrlRef.current = null;
    };
  }, []);

  const dirty =
    savedExtRef.current !== null &&
    (ext.provider !== savedExtRef.current.provider ||
      ext.endpoint !== savedExtRef.current.endpoint ||
      ext.model !== savedExtRef.current.model ||
      ext.apiKey !== '' ||
      ext.rate !== savedExtRef.current.rate);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useSettingsDirty('voice', dirty);

  // QA1-FE-09：仅同步运行态快照（不冲刷正在编辑的外部表单草稿）
  const applySnapshotOnly = useCallback((next: VoiceStateSnapshot) => {
    setState(next);
  }, []);

  const applyWithForm = useCallback((next: VoiceStateSnapshot, forceForm = false) => {
    setState(next);
    const synced = extDraftFromSnapshot(next);
    if (forceForm || !savedExtRef.current || !dirtyRef.current) {
      savedExtRef.current = synced;
      setExt(synced);
    }
  }, []);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getVoiceState().then((snap) => applyWithForm(snap, false), (e) => setError(stripIpcErrorPrefix(e)));
  }, [applyWithForm, bridge]);

  // 安装中且卡片可见：1 s 单飞轮询（只更新模型状态，不冲刷未保存外部表单）
  const installing = state?.model.status === 'downloading' || state?.model.status === 'verifying' || state?.model.status === 'loading';
  useEffect(() => {
    if (!bridge || !installing) return;
    const timer = window.setInterval(() => {
      if (inflight.current || document.visibilityState === 'hidden' || !cardRef.current?.isConnected) return;
      inflight.current = true;
      void bridge.getVoiceState().then(applySnapshotOnly, () => undefined).finally(() => {
        inflight.current = false;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [applySnapshotOnly, bridge, installing]);

  if (!bridge) {
    return (
      <section className="settings-section" data-testid="voice-settings-card">
        <h3 className="settings-group-title">{t.voiceSettingsTitle}</h3>
        <div className="settings-group"><div className="setting-row"><span className="setting-desc">{t.voiceUnavailable}</span></div></div>
      </section>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(stripIpcErrorPrefix(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: VoiceConfigPatch, commitExtForm = false) =>
    run(async () => applyWithForm(await bridge.updateVoiceConfig(patch), commitExtForm));

  const pickDevices = () =>
    run(async () => {
      setDevices(await listInputDevicesWithLease(bridge, { profileId }));
    });

  const micTest = () =>
    run(async () => {
      setTesting(true);
      setTestResult(null);
      // QA1-FE-10：3 秒试录仅做本机采音验证（0 外联 / 0 voiceFinish），按实际采集时长与峰值给出真实反馈
      const outcome = await new Promise<{ text: string; durationMs: number; peak: number }>((resolve, reject) => {
        let out = '';
        let settled = false;
        const finish = (controller: VoiceCaptureController, fn: () => void) => {
          if (settled) return;
          settled = true;
          if (micTestCtrlRef.current === controller) micTestCtrlRef.current = null;
          controller.dispose();
          fn();
        };
        const controller = new VoiceCaptureController(
          bridge,
          {
            onSegment: (_id, _seq, seg) => {
              out += seg;
            },
            onSettled: (_id, event) => {
              const peak = controller.peakAmplitude;
              finish(controller, () => resolve({ text: (event.text || out).trim(), durationMs: event.durationMs, peak }));
            },
            onAborted: () => {
              const peak = controller.peakAmplitude;
              finish(controller, () => resolve({ text: out.trim(), durationMs: 0, peak }));
            },
            onNotice: (kind, message) => {
              if (kind === 'error') {
                finish(controller, () => reject(new Error(message || 'error')));
              }
            },
          },
          { workletUrl }
        );
        micTestCtrlRef.current = controller;
        void controller
          .start({
            owner: { profileId },
            purpose: 'mic-test',
            maxDurationMs: VOICE_MIC_TEST_MAX_DURATION_MS,
            ...(state?.config.preferredDeviceId ? { deviceId: state.config.preferredDeviceId } : {}),
            ...(state?.config.locale ? { locale: state.config.locale } : {}),
          })
          .then((ok) => {
            if (!ok && controller.phase === 'idle') {
              finish(controller, () => resolve({ text: out.trim(), durationMs: 0, peak: 0 }));
            }
          });
      }).finally(() => {
        if (mountedRef.current) setTesting(false);
      });
      if (!mountedRef.current) return;
      if (outcome.text) {
        setTestResult(t.voiceMicTestDone(outcome.text));
      } else if (outcome.durationMs > 0 || outcome.peak > 0) {
        setTestResult(t.voiceMicTestPass(Math.max(0.1, outcome.durationMs / 1000).toFixed(1)));
      } else {
        setTestResult(t.voiceMicTestSilent);
      }
    });

  const install = () => {
    const mb = (VOICE_LOCAL_MODEL_SPEC.sizeBytes / 1_048_576).toFixed(0);
    if (!window.confirm(t.voiceModelInstallConfirm(mb))) return;
    void run(async () => {
      const res = await bridge.installVoiceModel({ action: 'start' });
      setState((prev) => (prev ? { ...prev, model: res.state } : prev));
    });
  };

  const extTestInput = () => ({
    provider: ext.provider,
    endpoint: ext.endpoint.trim(),
    model: ext.model.trim(),
    ...(ext.apiKey.trim() ? { apiKey: ext.apiKey.trim() } : {}),
  });

  const extSavePatch = () => {
    const trimmedRate = ext.rate.trim();
    return {
      ...extTestInput(),
      ratePerMinuteUsd: trimmedRate && Number.isFinite(Number(trimmedRate)) ? Number(trimmedRate) : null,
    };
  };

  const cfg = state?.config;
  const model = state?.model;
  const cost = telemetry;
  const encryptionUnavailable = state?.external.encryptionAvailable === false;
  const cooldownUntil = state?.external.cooldownUntil;
  const cooldownActive = Boolean(cooldownUntil && Date.parse(cooldownUntil) > Date.now());
  return (
    <section className="settings-section" data-testid="voice-settings-card" ref={cardRef}>
      <h3 className="settings-group-title">{t.voiceSettingsTitle}</h3>
      <p className="setting-desc">{t.voiceSettingsDesc}</p>
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-text"><span className="setting-label">{t.voiceEngine}</span></span>
          <select className="input w-260" value={cfg?.engine ?? 'local'} disabled={!cfg || busy}
            onChange={(e) => void update({ engine: e.target.value as VoiceEngineMode })} data-testid="voice-engine-select">
            <option value="local">{t.voiceEngineLocal}</option>
            <option value="external-api">{t.voiceEngineExternal}</option>
            <option value="off">{t.voiceEngineOff}</option>
          </select>
        </div>
        <div className="setting-row">
          <span className="setting-text"><span className="setting-label">{t.voiceLocale}</span></span>
          <select className="input w-260" value={cfg?.locale ?? 'auto'} disabled={!cfg || busy}
            onChange={(e) => void update({ locale: e.target.value as VoiceLocale })} data-testid="voice-locale-select">
            <option value="auto">{t.voiceLocaleAuto}</option>
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
        <div className="setting-row">
          <span className="setting-text">
            <span className="setting-label">{t.voiceDevice}</span>
            <span className="setting-desc">{cfg?.preferredDeviceLabel || t.voiceDeviceDefault}</span>
          </span>
          {devices && devices.length > 0 ? (
            <select className="input w-260" value={cfg?.preferredDeviceId ?? ''} disabled={busy} data-testid="voice-device-select"
              onChange={(e) => {
                const d = devices.find((x) => x.deviceId === e.target.value);
                void update({ preferredDeviceId: d?.deviceId ?? null, preferredDeviceLabel: d?.label ?? null });
              }}>
              <option value="">{t.voiceDeviceDefault}</option>
              {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
          ) : (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void pickDevices()} data-testid="voice-pick-device">
              {t.voicePickDevice}
            </button>
          )}
          <button type="button" className="btn btn-sm" disabled={busy || cfg?.engine === 'off'} onClick={() => void micTest()} data-testid="voice-mic-test">
            {testing ? t.voiceMicTesting : t.voiceMicTest}
          </button>
        </div>
        {testResult && <div className="setting-row"><span className="setting-desc" role="status" data-testid="voice-mic-test-result">{testResult}</span></div>}
        <div className="setting-row" data-testid="voice-model-row">
          <span className="setting-text">
            <span className="setting-label">{model ? t.voiceModelStatus[model.status] : '…'}</span>
            <span className="setting-desc mono">{VOICE_LOCAL_MODEL_SPEC.fileName} · MIT</span>
          </span>
          {installing && model?.progressPercent !== undefined && (
            <span className="gauge voice-model-gauge" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(model.progressPercent)} aria-label={t.voiceModelProgress(Math.round(model.progressPercent))}>
              <span style={{ '--fill': model.progressPercent / 100 } as React.CSSProperties} />
            </span>
          )}
          {(model?.status === 'missing' || model?.status === 'error') && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={install} data-testid="voice-model-install">{t.voiceModelInstall}</button>
          )}
          {installing && (
            <button type="button" className="btn btn-sm" onClick={() => void run(async () => { const r = await bridge.installVoiceModel({ action: 'cancel' }); setState((p) => (p ? { ...p, model: r.state } : p)); })}>
              {t.voiceModelCancel}
            </button>
          )}
        </div>
      </div>

      <h3 className="settings-group-title">{t.voiceExternalTitle}</h3>
      {encryptionUnavailable && (
        <div className="alert" role="alert" data-testid="voice-encryption-unavailable">
          {t.voiceEncryptionUnavailable}
        </div>
      )}
      {cooldownActive && cooldownUntil && (
        <div className="alert alert-warning" role="status" data-testid="voice-cooldown-banner">
          {t.voiceCooldownActive(
            state?.external.cooldownKind === 'permission_403' ? '403' : '429',
            formatLocalDateTime(cooldownUntil, locale)
          )}
        </div>
      )}
      <div className="settings-group" data-testid="voice-external-group">
        <div className="setting-row">
          <span className="setting-text"><span className="setting-label">{t.voiceExternalProvider}</span></span>
          <select className="input w-260" value={ext.provider} onChange={(e) => {
            const provider = e.target.value as VoiceExternalProviderId;
            setExt((p) => ({
              ...p,
              provider,
              endpoint: provider === 'gemini-api-key' ? EXTERNAL_VOICE_DEFAULTS.geminiEndpoint : EXTERNAL_VOICE_DEFAULTS.openaiEndpoint,
              model: provider === 'gemini-api-key' ? EXTERNAL_VOICE_DEFAULTS.geminiModel : EXTERNAL_VOICE_DEFAULTS.openaiModel,
            }));
            setModels([]);
          }} data-testid="voice-ext-provider">
            <option value="openai-compatible">OpenAI compatible</option>
            <option value="gemini-api-key">Gemini Developer API</option>
          </select>
        </div>
        <label className="setting-row">
          <span className="setting-text"><span className="setting-label">{t.voiceExternalEndpoint}</span></span>
          <input className="input input-mono w-260" value={ext.endpoint} onChange={(e) => setExt((p) => ({ ...p, endpoint: e.target.value }))} data-testid="voice-ext-endpoint" />
        </label>
        <div className="setting-row">
          <span className="setting-text"><span className="setting-label">{t.voiceExternalModel}</span></span>
          {models.length ? (
            <select className="input input-mono w-260" value={ext.model} onChange={(e) => setExt((p) => ({ ...p, model: e.target.value }))} data-testid="voice-ext-model">
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName || m.id}</option>)}
            </select>
          ) : (
            <input className="input input-mono w-260" value={ext.model} onChange={(e) => setExt((p) => ({ ...p, model: e.target.value }))} data-testid="voice-ext-model" />
          )}
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => {
            const res = await bridge.discoverVoiceModels({ provider: ext.provider, endpoint: ext.endpoint.trim(), ...(ext.apiKey.trim() ? { apiKey: ext.apiKey.trim() } : {}) });
            setModels(res.models);
          })} data-testid="voice-ext-discover">{t.voiceDiscover}</button>
        </div>
        <label className="setting-row">
          <span className="setting-text">
            <span className="setting-label">{t.voiceExternalKey}</span>
            {cfg?.externalProvider.hasApiKey && <span className="setting-desc">{t.voiceExternalKeySaved}</span>}
          </span>
          <input className="input input-mono w-260" type="password" autoComplete="off" value={ext.apiKey} onChange={(e) => setExt((p) => ({ ...p, apiKey: e.target.value }))} data-testid="voice-ext-key" />
        </label>
        <label className="setting-row">
          <span className="setting-text"><span className="setting-label">{t.voiceExternalRate}</span></span>
          <input className="input input-mono w-120" inputMode="decimal" value={ext.rate} onChange={(e) => setExt((p) => ({ ...p, rate: e.target.value }))} data-testid="voice-ext-rate" />
        </label>
        <div className="setting-row">
          <span className="setting-desc" role="status" data-testid="voice-ext-status">{connNotice}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => {
            const res = await bridge.testVoiceConnection(extTestInput());
            setConnNotice(res.ok ? t.voiceTestOk(res.latencyMs) : t.voiceTestFail(res.error ?? ''));
            applySnapshotOnly(await bridge.getVoiceState());
          })} data-testid="voice-ext-test">{t.voiceTest}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void update({ externalProvider: extSavePatch() }, true)} data-testid="voice-ext-save">{t.voiceSave}</button>
        </div>
      </div>

      <h3 className="settings-group-title">{t.voiceCostTitle}</h3>
      <div className="settings-group" data-testid="voice-cost-summary">
        <div className="setting-row">
          <span className="setting-text">
            <span className="setting-label mono">
              {t.voiceCostSummary(cost?.cumulativeCalls ?? 0, ((cost?.totalDurationMs ?? 0) / 60000).toFixed(1), formatUsd(cost?.knownCostUsd ?? 0))}
            </span>
            {cost?.hasUnknownCost && <span className="setting-desc">{t.voiceCostUnknown}</span>}
            <span className="setting-desc">{COST_DISCLAIMER[locale]}</span>
          </span>
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
    </section>
  );
}

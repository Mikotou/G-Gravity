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
import { VoiceCaptureController, listInputDevicesWithLease } from '../../lib/voice/controller';
import { getVoiceBridge } from '../../services/desktop-bridge';
import { formatUsd } from '../ContextStatusBar';
import workletUrl from '../../lib/voice/pcm-worklet.ts?worker&url';

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
  const [ext, setExt] = useState({ provider: EXTERNAL_VOICE_DEFAULTS.provider as VoiceExternalProviderId, endpoint: '', model: '', apiKey: '', rate: '' });
  const [models, setModels] = useState<ExternalReviewerModelOption[]>([]);
  const [connNotice, setConnNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const inflight = useRef(false);

  const apply = useCallback((next: VoiceStateSnapshot) => {
    setState(next);
    const p = next.config.externalProvider;
    setExt((prev) => ({
      provider: p.provider,
      endpoint: p.endpoint,
      model: p.model,
      apiKey: prev.apiKey,
      rate: p.ratePerMinuteUsd !== undefined ? String(p.ratePerMinuteUsd) : '',
    }));
  }, []);

  useEffect(() => {
    if (!bridge) return;
    void bridge.getVoiceState().then(apply, (e) => setError(stripIpcErrorPrefix(e)));
  }, [apply, bridge]);

  // 安装中且卡片可见：1 s 单飞轮询
  const installing = state?.model.status === 'downloading' || state?.model.status === 'verifying' || state?.model.status === 'loading';
  useEffect(() => {
    if (!bridge || !installing) return;
    const timer = window.setInterval(() => {
      if (inflight.current || document.visibilityState === 'hidden' || !cardRef.current?.isConnected) return;
      inflight.current = true;
      void bridge.getVoiceState().then(apply, () => undefined).finally(() => {
        inflight.current = false;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [apply, bridge, installing]);

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
  const update = (patch: VoiceConfigPatch) => run(async () => apply(await bridge.updateVoiceConfig(patch)));

  const pickDevices = () =>
    run(async () => {
      setDevices(await listInputDevicesWithLease(bridge, { profileId }));
    });

  const micTest = () =>
    run(async () => {
      setTesting(true);
      setTestResult(null);
      const text = await new Promise<string>((resolve, reject) => {
        let out = '';
        const controller = new VoiceCaptureController(
          bridge,
          {
            onSegment: (_id, _seq, seg) => {
              out += seg;
            },
            onSettled: (_id, event) => {
              controller.dispose();
              resolve(event.text || out);
            },
            onAborted: () => {
              controller.dispose();
              resolve(out);
            },
            onNotice: (kind, message) => {
              if (kind === 'error') {
                controller.dispose();
                reject(new Error(message || 'error'));
              }
            },
          },
          { workletUrl }
        );
        void controller
          .start({
            owner: { profileId },
            purpose: 'mic-test',
            maxDurationMs: VOICE_MIC_TEST_MAX_DURATION_MS,
            ...(state?.config.preferredDeviceId ? { deviceId: state.config.preferredDeviceId } : {}),
            ...(state?.config.locale ? { locale: state.config.locale } : {}),
          })
          .then((ok) => {
            if (!ok && controller.phase === 'idle') resolve(out);
          });
      }).finally(() => setTesting(false));
      setTestResult(t.voiceMicTestDone(text.trim()));
    });

  const install = () => {
    const mb = (VOICE_LOCAL_MODEL_SPEC.sizeBytes / 1_048_576).toFixed(0);
    if (!window.confirm(t.voiceModelInstallConfirm(mb))) return;
    void run(async () => {
      const res = await bridge.installVoiceModel({ action: 'start' });
      setState((prev) => (prev ? { ...prev, model: res.state } : prev));
    });
  };

  const extPatch = () => ({
    provider: ext.provider,
    endpoint: ext.endpoint.trim(),
    model: ext.model.trim(),
    ...(ext.apiKey.trim() ? { apiKey: ext.apiKey.trim() } : {}),
    ...(ext.rate.trim() && Number.isFinite(Number(ext.rate)) ? { ratePerMinuteUsd: Number(ext.rate) } : {}),
  });

  const cfg = state?.config;
  const model = state?.model;
  const cost = telemetry;
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
          {devices ? (
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
            <select className="input input-mono w-260" value={ext.model} onChange={(e) => setExt((p) => ({ ...p, model: e.target.value }))}>
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
          <input className="input input-mono w-120" inputMode="decimal" value={ext.rate} onChange={(e) => setExt((p) => ({ ...p, rate: e.target.value }))} />
        </label>
        <div className="setting-row">
          <span className="setting-desc" role="status" data-testid="voice-ext-status">{connNotice}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => {
            const res = await bridge.testVoiceConnection(extPatch());
            setConnNotice(res.ok ? t.voiceTestOk(res.latencyMs) : t.voiceTestFail(res.error ?? ''));
            apply(await bridge.getVoiceState());
          })} data-testid="voice-ext-test">{t.voiceTest}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void update({ externalProvider: extPatch() })} data-testid="voice-ext-save">{t.voiceSave}</button>
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

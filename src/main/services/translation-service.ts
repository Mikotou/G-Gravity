import { ownedExternalUsage } from '../telemetry/external-usage-owner';
import { ServiceVerifier } from '../llm/service-verifier';
import { maskKnownSecret, redactSecretsForReviewer } from '../security/redaction';
import type { ExternalTranslatorUsageRecordInput } from '../../shared/telemetry-contract';
import type { ExternalUsageHost, CoreServiceOptions } from '../core-contracts';
import type { WorkspaceSettings } from './workspace-settings';
import { publicTranslationConfig, VALID_THINKING_LEVELS } from './secret-vault';
import { LocalTranslator } from '../translation/local-translator';
import {
  translatorCircuit, discoverExternalModels, IndependentModelCallError, validateExternalEndpoint, withModelDeadline,
} from '../llm/external-llm-transport';
import { sameExternalService, type ExternalReviewerModelsDiscoveryInput } from '../../shared/approval-contract';
import {
  EXTERNAL_TRANSLATOR_DEFAULTS, isExternalTranslatorConnected, sameTranslatorSettings,
  type ExternalTranslatorConfig, type ExternalTranslatorTestResult, type TranslationEngineMode,
  type TranslationConfig, type TranslationConfigPatch,
} from '../../shared/translation-contract';
import {
  testExternalTranslator, translateWithExternalModel, EXTERNAL_TRANSLATOR_TEST_PHRASE,
  translationSampleResult,
} from '../translation/external-translator';

export class TranslationService {
  private verifier = new ServiceVerifier(sameTranslatorSettings);
  private localTranslator = new LocalTranslator();
  constructor(private settings: WorkspaceSettings, private app: ExternalUsageHost,
    private options: Pick<CoreServiceOptions, 'externalTranslator' | 'modelDiscoveryFetcher'>,
    private sessionForThought: (thoughtId: string) => string | undefined,
    private nowMs: () => number, private isDisposed: () => boolean) {}

  dispose(): void { this.localTranslator.dispose(); }

  async translateThoughtSegment(
    originalText: string,
    thoughtId: string,
    signal?: AbortSignal
  ): Promise<{ text: string; source: 'local-model' | 'external-api' }> {
    const cfg = this.settings.translationConfig;
    if (cfg.engine === 'external-api' && isExternalTranslatorConnected(cfg.externalTranslator)) {
      const extCfg = structuredClone(cfg.externalTranslator);
      if (!this.options.externalTranslator && translatorCircuit.remaining(extCfg.endpoint) > 0) {
        return { text: await this.localTranslator.translate(originalText, signal), source: 'local-model' };
      }
      const sessionId = this.sessionForThought(thoughtId) || '';
      const profileId = this.app.sessions.profileId;
      const record = (event: ExternalTranslatorUsageRecordInput) => {
        if (this.isDisposed()) return;
        this.app.telemetry.recordExternalTranslationUsage(ownedExternalUsage(this.app, profileId, event), profileId);
      };
      const redactedText = redactSecretsForReviewer(originalText);
      const started = this.nowMs();
      const timeoutMs = Math.min(
        Math.max(Math.round(extCfg.timeoutMs || EXTERNAL_TRANSLATOR_DEFAULTS.timeoutMs), 100),
        60_000
      );
      try {
        const translator = this.options.externalTranslator;
        const result = translator
          ? await withModelDeadline(timeoutMs, '外部翻译', signal, requestSignal => translator(redactedText, extCfg, this.options.modelDiscoveryFetcher, requestSignal))
          : await translateWithExternalModel(redactedText, extCfg, this.options.modelDiscoveryFetcher, signal);
        signal?.throwIfAborted();
        const translated = (result.text || '').trim();
        if (!translated) {
          throw new IndependentModelCallError('外部翻译模型返回内容为空', result.usage);
        }
        record({
          sessionId,
          provider: extCfg.provider,
          endpoint: extCfg.endpoint,
          modelId: extCfg.model,
          outcome: 'success',
          latencyMs: Math.max(0, Math.round(result.latencyMs ?? (this.nowMs() - started))),
          usage: result.usage,
        });
        return { text: translated, source: 'external-api' };
      } catch (err) {
        signal?.throwIfAborted();
        const usage = err instanceof IndependentModelCallError ? err.usage : undefined;
        const latencyMs = Math.max(0, Math.round(this.nowMs() - started));
        const recordFailure = (outcome: 'fallback' | 'error') => record({
          sessionId, provider: extCfg.provider, endpoint: extCfg.endpoint, modelId: extCfg.model,
          outcome, latencyMs, usage,
        });
        let fallbackText: string;
        try {
          fallbackText = await this.localTranslator.translate(originalText, signal);
          signal?.throwIfAborted();
          if (!fallbackText?.trim()) throw new Error('本地翻译未返回译文');
        } catch (localError) {
          signal?.throwIfAborted();
          recordFailure('error');
          throw localError;
        }
        recordFailure('fallback');
        return { text: fallbackText, source: 'local-model' };
      }
    }
    const localText = await this.localTranslator.translate(originalText, signal);
    return { text: localText, source: 'local-model' };
  }
  async getTranslationConfig(): Promise<TranslationConfig> {
    return publicTranslationConfig(this.settings.translationConfig);
  }
  async updateTranslationConfig(patch: TranslationConfigPatch): Promise<TranslationConfig> {
    const current = this.settings.translationConfig;
    const patchExt = patch.externalTranslator;
    const providerChanged = patchExt !== undefined && !sameExternalService(current.externalTranslator, patchExt);
    const clearedApiKey =
      patchExt?.apiKey === '' || (providerChanged && patchExt?.apiKey === undefined);
    const mergedExternal: ExternalTranslatorConfig = patchExt
      ? {
          ...current.externalTranslator,
          ...patchExt,
          // 仅在未切换服务商且未显式覆盖 apiKey 时保留已恢复的系统加密密钥；切换服务商绝不跨服务商继承旧密钥
          ...(providerChanged
            ? { apiKey: patchExt.apiKey }
            : patchExt.apiKey === undefined && current.externalTranslator.apiKey !== undefined
              ? { apiKey: current.externalTranslator.apiKey }
              : {}),
        }
      : { ...current.externalTranslator };

    delete mergedExternal.hasApiKey;
    if (typeof mergedExternal.endpoint === 'string') mergedExternal.endpoint = mergedExternal.endpoint.trim();
    if (typeof mergedExternal.model === 'string') mergedExternal.model = mergedExternal.model.trim();
    if (typeof mergedExternal.apiKey === 'string') {
      const trimmedKey = mergedExternal.apiKey.trim();
      if (trimmedKey) mergedExternal.apiKey = trimmedKey;
      else delete mergedExternal.apiKey;
    } else if (mergedExternal.apiKey === undefined) {
      delete mergedExternal.apiKey;
    }

    const nextEngine: TranslationEngineMode = patch.engine ?? current.engine;
    if (nextEngine !== 'local' && nextEngine !== 'external-api') {
      throw new Error('无效的翻译引擎模式');
    }
    if (!['gemini-api-key', 'openai-compatible', 'local-ollama'].includes(mergedExternal.provider)) {
      throw new Error('无效的外部翻译服务商');
    }
    if (
      mergedExternal.timeoutMs !== undefined &&
      (!Number.isFinite(mergedExternal.timeoutMs) ||
        mergedExternal.timeoutMs < 100 ||
        mergedExternal.timeoutMs > 60_000)
    ) {
      throw new Error('外部翻译超时时间必须介于 100 至 60000 ms');
    }
    if (
      mergedExternal.maxOutputTokens !== undefined &&
      (!Number.isFinite(mergedExternal.maxOutputTokens) ||
        mergedExternal.maxOutputTokens < 64 ||
        mergedExternal.maxOutputTokens > 65_536)
    ) {
      throw new Error('最大输出 Token 上限必须介于 64 至 65536');
    }
    if (
      mergedExternal.thinkingLevel !== undefined &&
      !VALID_THINKING_LEVELS.has(mergedExternal.thinkingLevel)
    ) {
      throw new Error('无效的思考强度配置');
    }

    const proof = this.verifier.verifiedAt(mergedExternal) ?? (sameTranslatorSettings(current.externalTranslator, mergedExternal) &&
          isExternalTranslatorConnected({ ...current.externalTranslator, enabled: true })
        ? current.externalTranslator.lastVerifiedAt : undefined);
    mergedExternal.lastVerifiedAt = proof;
    mergedExternal.verifiedBy = proof ? 'translation-call' : undefined;
    mergedExternal.connectionStatus = proof ? 'connected' : 'untested';
    mergedExternal.enabled = Boolean(mergedExternal.enabled && proof);
    if (mergedExternal.enabled || patchExt?.enabled && !clearedApiKey) validateExternalEndpoint(mergedExternal);
    const connected = isExternalTranslatorConnected(mergedExternal);
    if (patch.engine === 'external-api' && !connected) {
      throw new Error('尚未连接外部翻译模型，请先用所选模型成功完成一次翻译测试。');
    }
    const finalEngine: TranslationEngineMode =
      nextEngine === 'external-api' && !connected ? 'local' : nextEngine;

    const next: TranslationConfig = {
      engine: finalEngine,
      externalTranslator: mergedExternal,
    };
    this.settings.saveSettings(this.settings.preferences, next, clearedApiKey);
    if (patchExt) {
      this.verifier.changed(mergedExternal, true);
      if (current.externalTranslator.apiKey !== mergedExternal.apiKey) translatorCircuit.reset(mergedExternal.endpoint);
    }
    const snapshot = publicTranslationConfig(this.settings.translationConfig);
    this.app.emit('translation-config-updated', snapshot);
    return snapshot;
  }
  async discoverExternalTranslationModels(input: ExternalReviewerModelsDiscoveryInput) {
    const effectiveInput: ExternalReviewerModelsDiscoveryInput =
      input.apiKey === undefined &&
      sameExternalService(this.settings.translationConfig.externalTranslator, input) &&
      this.settings.translationConfig.externalTranslator.apiKey
        ? { ...input, apiKey: this.settings.translationConfig.externalTranslator.apiKey }
        : input;
    return discoverExternalModels(effectiveInput, this.options.modelDiscoveryFetcher);
  }
  async testExternalTranslatorConnection(
    input?: Partial<ExternalTranslatorConfig>
  ): Promise<ExternalTranslatorTestResult> {
    const current = this.settings.translationConfig.externalTranslator;
    const providerChanged = input !== undefined && !sameExternalService(current, input);
    const candidate: ExternalTranslatorConfig = {
      ...current,
      ...input,
      enabled: true,
      ...(providerChanged
        ? { apiKey: input?.apiKey }
        : input?.apiKey === undefined && current.apiKey !== undefined
          ? { apiKey: current.apiKey }
          : {}),
    };
    delete candidate.hasApiKey;
    if (typeof candidate.endpoint === 'string') candidate.endpoint = candidate.endpoint.trim();
    if (typeof candidate.model === 'string') candidate.model = candidate.model.trim();
    if (typeof candidate.apiKey === 'string') {
      const trimmed = candidate.apiKey.trim();
      candidate.apiKey = trimmed || undefined;
    } else if (candidate.apiKey === undefined) {
      delete candidate.apiKey;
    }
    this.verifier.begin(candidate);
    const recordVerified = translatorCircuit.successRecorder(candidate.endpoint);
    const result = await this.runTranslatorSample(candidate);
    if (!this.verifier.current(candidate) || this.isDisposed()) {
      return { ok: false, latencyMs: result.latencyMs, error: '配置或测试已更新，请重新测试当前设置' };
    }
    this.verifier.finish(candidate);
    if (result.ok) {
      recordVerified();
      const verifiedAt = this.verifier.accept(candidate);
      return { ...result, verifiedAt };
    }
    this.verifier.reject();
    if (sameTranslatorSettings(this.settings.translationConfig.externalTranslator, candidate) &&
        this.settings.translationConfig.externalTranslator.verifiedBy) {
      const externalTranslator: ExternalTranslatorConfig = { ...this.settings.translationConfig.externalTranslator,
        enabled: false, lastVerifiedAt: undefined, verifiedBy: undefined, connectionStatus: 'failed' };
      const next: TranslationConfig = { engine: 'local', externalTranslator };
      this.settings.saveSettings(this.settings.preferences, next);
      this.app.emit('translation-config-updated', publicTranslationConfig(next));
    }
    return result;
  }
  private async runTranslatorSample(candidate: ExternalTranslatorConfig): Promise<ExternalTranslatorTestResult> {
    if (this.options.externalTranslator) {
      const started = performance.now();
      try {
        validateExternalEndpoint(candidate);
        if (!candidate.model || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(candidate.model)) {
          throw new Error('外部翻译模型名称无效');
        }
        const translator = this.options.externalTranslator;
        const timeout = Math.min(Math.max(candidate.timeoutMs || EXTERNAL_TRANSLATOR_DEFAULTS.timeoutMs, 100), 60_000);
        const res = await withModelDeadline(timeout, '外部翻译测试', undefined, signal =>
          translator(EXTERNAL_TRANSLATOR_TEST_PHRASE, candidate, this.options.modelDiscoveryFetcher, signal));
        const latencyMs = Math.max(0, Math.round(res.latencyMs ?? (performance.now() - started)));
        return translationSampleResult(res.text, latencyMs, res.usage);
      } catch (err) {
        const latencyMs = Math.max(0, Math.round(performance.now() - started));
        let message = err instanceof Error ? err.message : String(err);
        if (candidate.apiKey && message) message = maskKnownSecret(message, candidate.apiKey);
        const usage =
          err instanceof IndependentModelCallError && err.usage
            ? {
                inputTokens: err.usage.inputTokens,
                cachedInputTokens: err.usage.cachedInputTokens,
                outputTokens: err.usage.outputTokens,
                thinkingTokens: err.usage.thinkingTokens,
                totalTokens: err.usage.totalTokens,
              }
            : undefined;
        return { ok: false, latencyMs, error: message, usage };
      }
    }
    // The caller commits a verified sample after checking the active settings revision.
    return testExternalTranslator(candidate, this.options.modelDiscoveryFetcher, () => {});
  }
}

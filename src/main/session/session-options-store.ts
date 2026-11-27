import { AcpClient } from '../acp/acp-client';
import type { ManagedSessionSummary } from '../../shared/session-contract';
import type { ClientStore } from '../storage/client-store';
import { EXECUTION_MODE_ORDER, REASONING_EFFORT_ORDER } from '../../shared/acp-protocol';
import type {
  AcpConfigOption, AcpModelOption, AcpSessionNewResult, AgentExecutionMode, AgentReasoningEffort,
} from '../../shared/acp-protocol';

export function isSessionExecutionMode(value: unknown): value is AgentExecutionMode {
  return value === 'auto' || EXECUTION_MODE_ORDER.some(mode => mode === value);
}

function cleanModels(value: unknown): AcpModelOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map<string, AcpModelOption>();
  for (const item of value) {
    if (typeof item?.modelId !== 'string' || !item.modelId) continue;
    byId.set(item.modelId, { modelId: item.modelId, name: typeof item.name === 'string' && item.name || item.modelId,
      ...(typeof item.description === 'string' && { description: item.description }) });
  }
  return byId.size || !value.length ? [...byId.values()] : undefined;
}

/** ACP select options are either leaves or groups containing a list of leaves. */
export function selectValues(options: unknown): Array<{ value: string; name: string; description?: string }> {
  if (!Array.isArray(options)) return [];
  return options.flatMap(item => Array.isArray(item?.options) ? item.options : [item])
    .filter(item => typeof item?.value === 'string' && item.value);
}

export function modelConfig(options?: AcpConfigOption[]): AcpConfigOption | undefined {
  return options?.find(option => option.id === 'model') ?? options?.find(option => option.category === 'model');
}

export function declaredModels(result?: AcpSessionNewResult): AcpModelOption[] | undefined {
  const option = modelConfig(result?.configOptions);
  if (option) {
    if (!Array.isArray(option.options)) return undefined;
    const leaves = selectValues(option.options);
    if (!leaves.length && option.options.some(item => !Array.isArray((item as { options?: unknown } | null)?.options))) return undefined;
    return cleanModels(leaves.map(item => ({ modelId: item?.value, name: item?.name, description: item?.description })));
  }
  return cleanModels(result?.models?.availableModels);
}

interface SavedModelCatalog { models?: AcpModelOption[]; cliVersion?: string }

export class SessionOptionsStore {
  constructor(private store: ClientStore | undefined, private profile: () => string,
    private client: AcpClient, private active: ReadonlySet<string>, private sessions: ReadonlyMap<string, ManagedSessionSummary>) {
    this.savedSettings = store?.read('session-settings.json', {}) || {};
  }
  optionsBySession = new Map<string, AcpSessionNewResult>();
  localTurboSessions = new Set<string>();
  private savedSettings: Record<string, { executionMode: AgentExecutionMode; reasoningEffort: AgentReasoningEffort }>;
  private modelCatalog: SavedModelCatalog = {};
  private modelCatalogNeedsSave = false;

  modelList(): { availableModels: AcpModelOption[]; modelListSource: 'live' | 'cached' | 'unknown' } {
    if (this.modelCatalogNeedsSave) this.saveModelCatalog(this.modelCatalog);
    const live = [...this.active].map(id => declaredModels(this.optionsBySession.get(id))).filter(list => list !== undefined);
    if (live.length) return { availableModels: cleanModels(live.flat())!, modelListSource: 'live' };
    const version = this.client.initializeResult?.agentInfo?.version;
    if (version && this.modelCatalog.cliVersion && version !== this.modelCatalog.cliVersion) this.saveModelCatalog({});
    return this.modelCatalog.models ? { availableModels: [...this.modelCatalog.models], modelListSource: 'cached' }
      : { availableModels: [], modelListSource: 'unknown' };
  }

  private saveModelCatalog(next: SavedModelCatalog): void {
    if (!this.modelCatalogNeedsSave && JSON.stringify(next) === JSON.stringify(this.modelCatalog)) return;
    this.modelCatalog = next;
    // A display cache must not orphan an official session if the local disk is temporarily unavailable.
    try {
      this.store?.write(`model-catalog-${this.profile()}.json`, next);
      this.modelCatalogNeedsSave = false;
    } catch { this.modelCatalogNeedsSave = true; }
  }

  invalidateModelCatalog(): void {
    // An empty record also prevents migration from reviving the previous login's list.
    this.store?.write(`model-catalog-${this.profile()}.json`, {});
    this.modelCatalog = {};
    this.modelCatalogNeedsSave = false;
  }

  loadModelCatalog(): void {
    const saved = this.store?.read<SavedModelCatalog | null>(`model-catalog-${this.profile()}.json`, null);
    this.modelCatalog = {};
    this.modelCatalogNeedsSave = false;
    if (saved != null) {
      this.modelCatalog = { models: cleanModels(saved.models), cliVersion: typeof saved.cliVersion === 'string' ? saved.cliVersion : undefined };
      return;
    }
    const latest = [...this.sessions.values()].filter(s => Array.isArray(s.availableModels) && !s.isLegacyApprovalPollution)
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
    if (latest) this.saveModelCatalog({ models: cleanModels(latest.availableModels) });
  }

  hasConfigOptions(sessionId: string): boolean {
    return Boolean(this.optionsBySession.get(sessionId)?.configOptions?.length);
  }

  supportsMode(id: string, mode: AgentExecutionMode): boolean {
    const options = this.optionsBySession.get(id);
    return Boolean(selectValues(options?.configOptions?.find(c => c.id === 'mode')?.options).some(o => o.value === mode) ||
      options?.modes?.availableModes?.some(o => o.id === mode));
  }

  supportsEffort(id: string, effort: AgentReasoningEffort): boolean {
    return selectValues(this.optionsBySession.get(id)?.configOptions?.find(c => c.id === 'thought_level')?.options).some(o => o.value === effort);
  }

  applyReportedMode(session: ManagedSessionSummary, mode: unknown): boolean {
    if (!isSessionExecutionMode(mode)) return false;
    // A server reporting its own default mode cannot turn off a client-only preference.
    if (mode !== 'full-access' && this.localTurboSessions.has(session.sessionId)) return false;
    this.localTurboSessions.delete(session.sessionId);
    session.executionMode = mode;
    return true;
  }

  syncSessionFromOptions(session: ManagedSessionSummary, result?: AcpSessionNewResult, reported = true): void {
    if (!result) return;
    const cfg = result.configOptions;
    const modelOpt = modelConfig(cfg);
    const models = declaredModels(result);
    session.availableModels = models;
    if (models && reported) this.saveModelCatalog({ models, cliVersion: this.client.initializeResult?.agentInfo?.version });
    const currentModel = modelOpt ? modelOpt.currentValue : result.models?.currentModelId;
    if (typeof currentModel === 'string') session.modelId = currentModel;

    // 代理已声明统一配置但未列出推理选项时，写入空列表。
    // 界面可据此区分「明确无档位」与「旧协议未提供此信息」。
    if (Array.isArray(cfg)) {
      const effortOpt = cfg.find((opt) => opt.id === 'thought_level');
      if (effortOpt?.options?.length) {
        session.availableEfforts = selectValues(effortOpt.options)
          .filter((opt) => (REASONING_EFFORT_ORDER as readonly string[]).includes(opt.value))
          .map((opt) => ({ value: opt.value as AgentReasoningEffort, name: opt.name }));
        if (
          effortOpt.currentValue &&
          (REASONING_EFFORT_ORDER as readonly string[]).includes(effortOpt.currentValue)
        ) {
          session.reasoningEffort = effortOpt.currentValue as AgentReasoningEffort;
        }
      } else {
        session.availableEfforts = [];
      }
    }

    const modeOpt = cfg?.find((opt) => opt.id === 'mode');
    const currentMode = modeOpt?.currentValue || result.modes?.currentModeId;
    this.applyReportedMode(session, currentMode);
  }

  settings(sessionId: string): { executionMode?: AgentExecutionMode; reasoningEffort?: AgentReasoningEffort } {
    const saved = this.savedSettings[`${this.profile()}:${sessionId}`];
    return saved
      ? {
          executionMode: isSessionExecutionMode(saved.executionMode)
            ? saved.executionMode
            : 'default',
          reasoningEffort: REASONING_EFFORT_ORDER.includes(saved.reasoningEffort)
            ? saved.reasoningEffort
            : 'high',
        }
      : {};
  }

  persistSettings(session: ManagedSessionSummary): void {
    const next = {
      ...this.savedSettings,
      [`${this.profile()}:${session.sessionId}`]: { executionMode: session.executionMode, reasoningEffort: session.reasoningEffort },
    };
    this.store?.write('session-settings.json', next);
    this.savedSettings = next;
  }

  forget(id: string): void {
    this.optionsBySession.delete(id);
    this.localTurboSessions.delete(id);
    const key = this.profile() + ':' + id;
    const next = { ...this.savedSettings };
    delete next[key];
    this.store?.write('session-settings.json', next);
    this.savedSettings = next;
  }
}

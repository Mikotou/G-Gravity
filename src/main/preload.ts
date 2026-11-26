import { contextBridge, ipcRenderer } from 'electron';
import type { TelemetryCharts, TelemetryDelta } from './telemetry/telemetry-update';
import type { TelemetryDashboardSnapshot } from '../shared/telemetry-contract';
import type { GravityDesktopBridge } from '../shared/ipc-channels';

// 沙箱 Preload 运行时仅加载 Electron，所有共享依赖均为类型导入。
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
/** 只将业务载荷交给页面。返回的清理函数保留同一个监听器引用，组件卸载时能精确取消订阅。 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler);
}
type DashboardBaseline = TelemetryCharts & Pick<TelemetryDashboardSnapshot, 'profileId' | 'sequence' | 'rateCards' | 'pricingSource'>;
let baseline: DashboardBaseline | undefined;
function rememberDashboard(value?: TelemetryDashboardSnapshot): void {
  if (!value || (baseline?.sequence ?? -1) > (value.sequence ?? 0)) return;
  const { profileId, sequence, rateCards, pricingSource, hourly24h, matrix7d, calendar30d, costByRange, modelBreakdownByRange } = value;
  baseline = { profileId, sequence, rateCards, pricingSource, hourly24h, matrix7d, calendar30d, costByRange, modelBreakdownByRange };
}
const readDashboard = async (): Promise<TelemetryDashboardSnapshot> => {
  const result = await invoke('gravity:telemetry:get-dashboard');
  rememberDashboard(result);
  return result;
};
function subscribeTelemetry(listener: (snapshot: TelemetryDashboardSnapshot) => void): () => void {
  let active = true;
  let recovery: Promise<TelemetryDashboardSnapshot> | undefined;
  let queued: TelemetryDelta[] = [];
  const apply = (value: TelemetryDelta) => {
    if (!baseline || baseline.profileId !== value.profileId || (baseline.sequence ?? -1) > (value.sequence ?? 0)) return;
    const { nativeCharts, ...delta } = value;
    baseline = { ...baseline, ...nativeCharts, sequence: value.sequence };
    listener({ ...baseline, ...delta });
  };
  const unsubscribe = subscribe<TelemetryDelta | TelemetryDashboardSnapshot>('gravity:event:telemetry-updated', value => {
    if ('rateCards' in value) { rememberDashboard(value); listener(value); return; }
    if (baseline?.profileId === value.profileId && baseline) { apply(value); return; }
    if (baseline && (baseline.sequence ?? -1) >= (value.sequence ?? 0)) return;
    queued.push(value);
    if (recovery) return;
    recovery = readDashboard();
    void recovery.then(full => {
      if (!active) return;
      listener(full);
      for (const delta of queued) apply(delta);
    }, () => {}).finally(() => { recovery = undefined; queued = []; });
  });
  return () => { active = false; queued = []; unsubscribe(); };
}
// 此表是页面可调用的完整接口。新增方法时必须同步共享类型和主进程路由，通道名由桥接层固定。
const bridge: GravityDesktopBridge = {
  getBootstrap: async () => { const result = await invoke('gravity:app:get-bootstrap'); rememberDashboard(result.telemetry); return result; },
  updatePreferences: patch => invoke('gravity:app:update-preferences', patch),
  setAppIcon: icon => invoke('gravity:app:set-icon', icon),
  importCustomTheme: json => invoke('gravity:app:import-custom-theme', json),
  exportCustomTheme: () => invoke('gravity:app:export-custom-theme'),
  inspectLocalTargets: input => invoke('gravity:app:inspect-local-targets', input),
  openLinkOrFileTarget: input => invoke('gravity:app:open-target', input),
  copyText: text => invoke('gravity:app:copy-text', text),
  selectDirectory: defaultPath => invoke('gravity:app:select-directory', defaultPath),
  checkForUpdates: () => invoke('gravity:app:check-updates'),
  downloadUpdate: () => invoke('gravity:app:download-update'),
  installUpdate: () => invoke('gravity:app:install-update'),
  getAccountsState: () => invoke('gravity:account:get-state'),
  createAccountProfile: input => invoke('gravity:account:create-profile', input),
  deleteAccountProfile: id => invoke('gravity:account:delete-profile', id),
  switchAccountProfile: id => invoke('gravity:account:switch-profile', id),
  officialLogout: () => invoke('gravity:auth:official-logout'),
  launchOfficialLogin: id => invoke('gravity:auth:launch-official-login', id),
  getConnectionStatus: () => invoke('gravity:acp:get-connection-status'),
  listSessions: include => invoke('gravity:session:list', include),
  createSession: input => invoke('gravity:session:create', input),
  resumeSession: (id, cwd) => invoke('gravity:session:resume', id, cwd),
  manageSession: (id, action) => invoke('gravity:session:manage', id, action),
  answerQuestion: input => invoke('gravity:session:answer-question', input),
  getAccountQuota: (manual = false) => invoke('gravity:account:quota', manual),
  closeSession: id => invoke('gravity:session:close', id),
  setSessionMode: (id, mode) => invoke('gravity:session:set-mode', id, mode),
  setSessionEffort: (id, effort) => invoke('gravity:session:set-effort', id, effort),
  setSessionModel: (id, model) => invoke('gravity:session:set-model', id, model),
  getSessionInspector: id => invoke('gravity:session:get-inspector', id),
  listWorkspaceFiles: (cwd, query) => invoke('gravity:session:list-workspace-files', cwd, query),
  getSessionMessagePage: (id, before) => invoke('gravity:session:get-message-page', id, before),
  reviseMessage: input => invoke('gravity:session:revise-message', input),
  getConversationTree: id => invoke('gravity:session:get-tree', id),
  switchConversationBranch: async input => { const result = await invoke('gravity:session:switch-branch', input); rememberDashboard(result.telemetry); return result; },
  sendPrompt: input => invoke('gravity:session:send-prompt', input),
  cancelPrompt: id => invoke('gravity:session:cancel-prompt', id),
  compactSessionContext: id => invoke('gravity:session:compact-context', id),
  saveWorkspaceLayout: layout => invoke('gravity:session:save-layout', layout),
  renameSession: (id, title) => invoke('gravity:session:rename', id, title),
  togglePinSession: id => invoke('gravity:session:toggle-pin', id),
  organizeTitles: request => invoke('gravity:session:organize-titles', request),
  setApprovalMode: mode => invoke('gravity:approval:set-mode', mode),
  updateApprovalConfig: patch => invoke('gravity:approval:update-config', patch),
  submitApprovalDecision: decision => invoke('gravity:approval:submit-decision', decision),
  listSessionApprovalGrants: id => invoke('gravity:approval:list-session-grants', id),
  revokeSessionApprovalGrant: input => invoke('gravity:approval:revoke-session-grant', input),
  cancelStage2ApprovalReview: id => invoke('gravity:approval:cancel-stage2-review', id),
  onApprovalReviewing: listener => subscribe('gravity:event:approval-reviewing', listener),
  onApprovalGuardActivity: listener => subscribe('gravity:event:approval-guard-activity', listener),
  clearSessionApprovals: sessionId => invoke('gravity:approval:clear-session', sessionId),
  listApprovalAudit: limit => invoke('gravity:approval:list-audit', limit),
  discoverExternalReviewerModels: input => invoke('gravity:approval:discover-models', input),
  testExternalReviewerConnection: input => invoke('gravity:approval:test-connection', input),
  getTranslationConfig: () => invoke('gravity:translation:get-config'),
  updateTranslationConfig: patch => invoke('gravity:translation:update-config', patch),
  discoverExternalTranslationModels: input => invoke('gravity:translation:discover-models', input),
  testExternalTranslatorConnection: input => invoke('gravity:translation:test-connection', input),
  getTelemetryDashboard: readDashboard,
  updateModelRateCards: async rates => { const result = await invoke('gravity:telemetry:update-rate-cards', rates); rememberDashboard(result); return result; },
  getPluginsSnapshot: cwd => invoke('gravity:plugins:get-snapshot', cwd),
  runPluginAction: input => invoke('gravity:plugins:run-action', input),
  runMcpAction: input => invoke('gravity:mcp:run-action', input),
  toggleSkillEnabled: (id, enabled) => invoke('gravity:skills:toggle-enabled', id, enabled),
  getSwarmState: (id, before) => invoke('gravity:swarm:get-state', id, before),
  onConnectionUpdated: listener => subscribe('gravity:event:connection-updated', listener),
  onSessionUpdated: listener => subscribe('gravity:event:session-updated', listener),
  onMessageUpserted: listener => subscribe('gravity:event:message-upserted', listener),
  onInspectorUpdated: listener => subscribe('gravity:event:inspector-updated', listener),
  onAccountUpdated: listener => subscribe('gravity:event:account-updated', listener),
  onApprovalRequested: listener => subscribe('gravity:event:approval-requested', listener),
  onApprovalConfigUpdated: listener => subscribe('gravity:event:approval-config-updated', listener),
  onApprovalResolved: listener => subscribe('gravity:event:approval-resolved', listener),
  onTelemetryUpdated: subscribeTelemetry,
  onSwarmUpdated: listener => subscribe('gravity:event:swarm-updated', listener),
  onUpdateState: listener => subscribe('gravity:event:update-state', listener),
  onTreeUpdated: listener => subscribe('gravity:event:tree-updated', listener),
  onUiScaleCommand: listener => subscribe('gravity:event:ui-scale-command', listener),
  onTranslationConfigUpdated: listener => subscribe('gravity:event:translation-config-updated', listener),
};
contextBridge.exposeInMainWorld('gravityDesktop', Object.freeze(bridge));

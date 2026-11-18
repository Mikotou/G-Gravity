import { contextBridge, ipcRenderer } from 'electron';
import type { AgyDesktopBridge } from '../shared/ipc-channels';

// 沙箱 Preload 运行时仅加载 Electron，所有共享依赖均为类型导入。
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
/** 只将业务载荷交给页面。返回的清理函数保留同一个监听器引用，组件卸载时能精确取消订阅。 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler);
}
// 此表是页面可调用的完整接口。新增方法时必须同步共享类型和主进程路由，通道名由桥接层固定。
const bridge: AgyDesktopBridge = {
  getBootstrap: () => invoke('gravity:app:get-bootstrap'),
  updatePreferences: patch => invoke('gravity:app:update-preferences', patch),
  setAppIcon: icon => invoke('gravity:app:set-icon', icon),
  importCustomTheme: json => invoke('gravity:app:import-custom-theme', json),
  exportCustomTheme: () => invoke('gravity:app:export-custom-theme'),
  openLinkOrFileTarget: input => invoke('gravity:app:open-target', input),
  selectDirectory: defaultPath => invoke('gravity:app:select-directory', defaultPath),
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
  getAccountQuota: () => invoke('gravity:account:quota'),
  closeSession: id => invoke('gravity:session:close', id),
  setSessionMode: (id, mode) => invoke('gravity:session:set-mode', id, mode),
  setSessionEffort: (id, effort) => invoke('gravity:session:set-effort', id, effort),
  setSessionModel: (id, model) => invoke('gravity:session:set-model', id, model),
  getSessionInspector: id => invoke('gravity:session:get-inspector', id),
  listWorkspaceFiles: (cwd, query) => invoke('gravity:session:list-workspace-files', cwd, query),
  getSessionMessages: id => invoke('gravity:session:get-messages', id),
  reviseMessage: input => invoke('gravity:session:revise-message', input),
  sendPrompt: input => invoke('gravity:session:send-prompt', input),
  cancelPrompt: id => invoke('gravity:session:cancel-prompt', id),
  compactSessionContext: id => invoke('gravity:session:compact-context', id),
  saveWorkspaceLayout: layout => invoke('gravity:session:save-layout', layout),
  renameSession: (id, title) => invoke('gravity:session:rename', id, title),
  togglePinSession: id => invoke('gravity:session:toggle-pin', id),
  organizeTitles: request => invoke('gravity:session:organize-titles', request),
  listImportedHistory: () => invoke('gravity:history:list-imported'),
  getImportedHistoryDetail: id => invoke('gravity:history:get-detail', id),
  continueHistoryInGravity: input => invoke('gravity:history:continue-in-gravity', input),
  setApprovalMode: mode => invoke('gravity:approval:set-mode', mode),
  updateApprovalConfig: patch => invoke('gravity:approval:update-config', patch),
  submitApprovalDecision: decision => invoke('gravity:approval:submit-decision', decision),
  listApprovalAudit: limit => invoke('gravity:approval:list-audit', limit),
  getTelemetryDashboard: () => invoke('gravity:telemetry:get-dashboard'),
  updateModelRateCards: rates => invoke('gravity:telemetry:update-rate-cards', rates),
  getPluginsSnapshot: cwd => invoke('gravity:plugins:get-snapshot', cwd),
  runPluginAction: input => invoke('gravity:plugins:run-action', input),
  runMcpAction: input => invoke('gravity:mcp:run-action', input),
  toggleSkillEnabled: (id, enabled) => invoke('gravity:skills:toggle-enabled', id, enabled),
  getSwarmState: id => invoke('gravity:swarm:get-state', id),
  onSessionUpdated: listener => subscribe('gravity:event:session-updated', listener),
  onMessageUpserted: listener => subscribe('gravity:event:message-upserted', listener),
  onInspectorUpdated: listener => subscribe('gravity:event:inspector-updated', listener),
  onHistoryUpdated: listener => subscribe('gravity:event:history-updated', listener),
  onAccountUpdated: listener => subscribe('gravity:event:account-updated', listener),
  onApprovalRequested: listener => subscribe('gravity:event:approval-requested', listener),
  onApprovalResolved: listener => subscribe('gravity:event:approval-resolved', listener),
  onTelemetryUpdated: listener => subscribe('gravity:event:telemetry-updated', listener),
  onSwarmUpdated: listener => subscribe('gravity:event:swarm-updated', listener),
};
// 两个全局名称指向同一组冻结的方法，旧版渲染代码也可以调用当前接口。
contextBridge.exposeInMainWorld('agyDesktop', Object.freeze(bridge));
contextBridge.exposeInMainWorld('gravityDesktop', Object.freeze(bridge));

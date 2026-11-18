import type { AgyDesktopBridge } from '../../src/shared';
import type { CoreService } from '../../src/main/core-service';

/** 只用于测试：将真正的内核 API 和事件绑定到冻结渲染契约。 */
export function createCoreBridge(core: CoreService): AgyDesktopBridge {
  const methods = [
    'getBootstrap', 'updatePreferences', 'launchOfficialLogin', 'getConnectionStatus',
    'listSessions', 'createSession', 'resumeSession', 'closeSession', 'getSessionMessages',
    'reviseMessage', 'sendPrompt', 'cancelPrompt', 'compactSessionContext', 'saveWorkspaceLayout',
    'renameSession', 'togglePinSession', 'organizeTitles', 'setApprovalMode',
    'updateApprovalConfig', 'submitApprovalDecision', 'listApprovalAudit',
    'getTelemetryDashboard', 'getSwarmState',
    'setAppIcon', 'importCustomTheme', 'exportCustomTheme', 'openLinkOrFileTarget', 'selectDirectory', 'getAccountsState',
    'createAccountProfile', 'deleteAccountProfile', 'switchAccountProfile', 'officialLogout',
    'setSessionMode', 'setSessionEffort', 'setSessionModel', 'getSessionInspector', 'listWorkspaceFiles',
    'listImportedHistory', 'getImportedHistoryDetail', 'continueHistoryInGravity', 'updateModelRateCards',
    'getPluginsSnapshot', 'runPluginAction', 'runMcpAction', 'toggleSkillEnabled',
  ] as const satisfies readonly (keyof AgyDesktopBridge)[];
  const result: Record<string, unknown> = {};
  for (const name of methods) {
    const method = (core as unknown as Record<string, (...args: any[]) => unknown>)[name];
    if (typeof method !== 'function') throw new Error(`内核缺少冻结桥接方法：${name}`);
    result[name] = method.bind(core);
  }
  const events = {
    onSessionUpdated: 'session-updated', onMessageUpserted: 'message-upserted',
    onApprovalRequested: 'approval-requested', onApprovalResolved: 'approval-resolved',
    onTelemetryUpdated: 'telemetry-updated', onSwarmUpdated: 'swarm-updated',
    onInspectorUpdated: 'inspector-updated', onHistoryUpdated: 'history-updated', onAccountUpdated: 'account-updated',
  };
  for (const [method, event] of Object.entries(events)) result[method] = (listener: (...args: any[]) => void) => {
    core.on(event, listener); return () => { core.off(event, listener); };
  };
  return result as unknown as AgyDesktopBridge;
}

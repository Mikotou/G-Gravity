import type { ChatMessageItem, GravityDesktopBridge } from '../../src/shared';
import type { CoreService } from '../../src/main/core-service';

/** 只用于测试：分页拉取会话全部消息（替代 D1-B 删除的 getSessionMessages）。 */
export async function readAllSessionMessages(
  core: Pick<CoreService, 'getSessionMessagePage'>,
  sessionId: string
): Promise<ChatMessageItem[]> {
  const pages: ChatMessageItem[][] = [];
  let page = await core.getSessionMessagePage(sessionId);
  pages.push(page.messages);
  while (page.earlierCount > 0) {
    const next = await core.getSessionMessagePage(sessionId, page.earlierCount);
    if (next.earlierCount >= page.earlierCount) break;
    page = next;
    pages.push(page.messages);
  }
  return pages.reverse().flat();
}

/** 只用于测试：将真正的内核 API 和事件绑定到冻结渲染契约。 */
export function createCoreBridge(core: CoreService): GravityDesktopBridge {
  const methods = [
    'getBootstrap', 'updatePreferences', 'launchOfficialLogin', 'getConnectionStatus',
    'listSessions', 'createSession', 'resumeSession', 'manageSession', 'getAccountQuota', 'answerQuestion', 'closeSession', 'getSessionMessagePage',
    'reviseMessage', 'getConversationTree', 'switchConversationBranch', 'sendPrompt', 'cancelPrompt', 'compactSessionContext', 'saveWorkspaceLayout',
    'renameSession', 'togglePinSession', 'organizeTitles', 'setApprovalMode',
    'updateApprovalConfig', 'submitApprovalDecision', 'listSessionApprovalGrants', 'revokeSessionApprovalGrant', 'cancelStage2ApprovalReview',
    'clearSessionApprovals', 'listApprovalAudit', 'discoverExternalReviewerModels', 'testExternalReviewerConnection',
    'getTranslationConfig', 'updateTranslationConfig', 'discoverExternalTranslationModels', 'testExternalTranslatorConnection',
    'getTelemetryDashboard', 'getSwarmState',
    'setAppIcon', 'importCustomTheme', 'exportCustomTheme', 'inspectLocalTargets', 'openLinkOrFileTarget', 'copyText', 'selectDirectory',
    'checkForUpdates', 'downloadUpdate', 'installUpdate', 'getAccountsState',
    'createAccountProfile', 'deleteAccountProfile', 'switchAccountProfile', 'officialLogout',
    'setSessionMode', 'setSessionEffort', 'setSessionModel', 'getSessionInspector', 'getSessionPlanArtifact', 'listWorkspaceFiles',
    'updateModelRateCards',
    'getPluginsSnapshot', 'runPluginAction', 'runMcpAction', 'toggleSkillEnabled',
  ] as const satisfies readonly (keyof GravityDesktopBridge)[];
  const result: Record<string, unknown> = {};
  for (const name of methods) {
    const method = (core as unknown as Record<string, (...args: any[]) => unknown>)[name];
    if (typeof method !== 'function') throw new Error(`内核缺少冻结桥接方法：${name}`);
    result[name] = method.bind(core);
  }
  const events = {
    onConnectionUpdated: 'connection-updated',
    onSessionUpdated: 'session-updated',
    onMessageUpserted: 'message-upserted',
    onInspectorUpdated: 'inspector-updated',
    onPlanArtifactChanged: 'plan-artifact-changed',
    onAccountUpdated: 'account-updated',
    onApprovalRequested: 'approval-requested',
    onApprovalReviewing: 'approval-reviewing',
    onApprovalGuardActivity: 'approval-guard-activity',
    onApprovalConfigUpdated: 'approval-config-updated',
    onApprovalResolved: 'approval-resolved',
    onTelemetryUpdated: 'telemetry-updated',
    onSwarmUpdated: 'swarm-updated',
    onUpdateState: 'update-state',
    onTreeUpdated: 'tree-updated',
    onUiScaleCommand: 'ui-scale-command',
    onTranslationConfigUpdated: 'translation-config-updated',
  } as const satisfies Partial<Record<keyof GravityDesktopBridge, string>>;
  for (const [method, event] of Object.entries(events)) {
    result[method] = (listener: (...args: any[]) => void) => {
      core.on(event, listener);
      return () => {
        core.off(event, listener);
      };
    };
  }
  return result as unknown as GravityDesktopBridge;
}

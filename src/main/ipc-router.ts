import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { CoreService } from './core-service';

/** 将一个窗口绑定到一个 CoreService。返回的函数同时解除请求处理和事件转发，供应用退出时调用。 */
export function registerIpcRouter(ipcMain: IpcMain, service: CoreService, trustedContents: WebContents): () => void {
  const handlers: Record<string, (...args: any[]) => unknown> = {
    [IPC_CHANNELS.APP_GET_BOOTSTRAP]: () => service.getBootstrap(),
    [IPC_CHANNELS.APP_UPDATE_PREFERENCES]: patch => service.updatePreferences(patch),
    [IPC_CHANNELS.APP_SET_ICON]: id => service.setAppIcon(id),
    [IPC_CHANNELS.APP_IMPORT_CUSTOM_THEME]: json => service.importCustomTheme(json),
    [IPC_CHANNELS.APP_EXPORT_CUSTOM_THEME]: () => service.exportCustomTheme(),
    [IPC_CHANNELS.APP_OPEN_TARGET]: input => service.openLinkOrFileTarget(input),
    [IPC_CHANNELS.APP_SELECT_DIRECTORY]: defaultPath => service.selectDirectory(defaultPath),
    [IPC_CHANNELS.APP_GET_UPDATE_STATE]: () => service.getUpdateState(),
    [IPC_CHANNELS.APP_CHECK_UPDATES]: () => service.checkForUpdates(),
    [IPC_CHANNELS.APP_DOWNLOAD_UPDATE]: () => service.downloadUpdate(),
    [IPC_CHANNELS.APP_INSTALL_UPDATE]: () => service.installUpdate(),
    [IPC_CHANNELS.ACCOUNT_GET_STATE]: () => service.getAccountsState(),
    [IPC_CHANNELS.ACCOUNT_CREATE_PROFILE]: input => service.createAccountProfile(input),
    [IPC_CHANNELS.ACCOUNT_DELETE_PROFILE]: id => service.deleteAccountProfile(id),
    [IPC_CHANNELS.ACCOUNT_SWITCH_PROFILE]: id => service.switchAccountProfile(id),
    [IPC_CHANNELS.AUTH_LAUNCH_OFFICIAL_LOGIN]: id => service.launchOfficialLogin(id),
    [IPC_CHANNELS.AUTH_OFFICIAL_LOGOUT]: () => service.officialLogout(),
    [IPC_CHANNELS.ACP_GET_CONNECTION_STATUS]: () => service.getConnectionStatus(),
    [IPC_CHANNELS.SESSION_LIST]: include => service.listSessions(include),
    [IPC_CHANNELS.SESSION_CREATE]: input => service.createSession(input),
    [IPC_CHANNELS.SESSION_RESUME]: (id, cwd) => service.resumeSession(id, cwd),
    [IPC_CHANNELS.SESSION_MANAGE]: (id, action) => service.manageSession(id, action),
    [IPC_CHANNELS.SESSION_ANSWER_QUESTION]: input => service.answerQuestion(input),
    [IPC_CHANNELS.ACCOUNT_QUOTA]: () => service.getAccountQuota(),
    [IPC_CHANNELS.SESSION_CLOSE]: id => service.closeSession(id),
    [IPC_CHANNELS.SESSION_SET_MODE]: (id, mode) => service.setSessionMode(id, mode),
    [IPC_CHANNELS.SESSION_SET_EFFORT]: (id, effort) => service.setSessionEffort(id, effort),
    [IPC_CHANNELS.SESSION_SET_MODEL]: (id, model) => service.setSessionModel(id, model),
    [IPC_CHANNELS.SESSION_GET_INSPECTOR]: id => service.getSessionInspector(id),
    [IPC_CHANNELS.SESSION_LIST_WORKSPACE_FILES]: (cwd, query) => service.listWorkspaceFiles(cwd, query),
    [IPC_CHANNELS.SESSION_REVISE_MESSAGE]: input => service.reviseMessage(input),
    [IPC_CHANNELS.SESSION_SEND_PROMPT]: input => service.sendPrompt(input),
    [IPC_CHANNELS.SESSION_CANCEL_PROMPT]: id => service.cancelPrompt(id),
    [IPC_CHANNELS.SESSION_COMPACT_CONTEXT]: id => service.compactSessionContext(id),
    [IPC_CHANNELS.SESSION_GET_MESSAGES]: id => service.getSessionMessages(id),
    [IPC_CHANNELS.SESSION_SAVE_LAYOUT]: layout => service.saveWorkspaceLayout(layout),
    [IPC_CHANNELS.SESSION_RENAME]: (id, title) => service.renameSession(id, title),
    [IPC_CHANNELS.SESSION_TOGGLE_PIN]: id => service.togglePinSession(id),
    [IPC_CHANNELS.SESSION_ORGANIZE_TITLES]: request => service.organizeTitles(request),
    [IPC_CHANNELS.HISTORY_LIST_IMPORTED]: () => service.listImportedHistory(),
    [IPC_CHANNELS.HISTORY_GET_DETAIL]: id => service.getImportedHistoryDetail(id),
    [IPC_CHANNELS.HISTORY_CONTINUE_IN_GRAVITY]: input => service.continueHistoryInGravity(input),
    [IPC_CHANNELS.APPROVAL_SET_MODE]: mode => service.setApprovalMode(mode),
    [IPC_CHANNELS.APPROVAL_UPDATE_CONFIG]: patch => service.updateApprovalConfig(patch),
    [IPC_CHANNELS.APPROVAL_SUBMIT_DECISION]: submission => service.submitApprovalDecision(submission),
    [IPC_CHANNELS.APPROVAL_LIST_AUDIT]: limit => service.listApprovalAudit(limit),
    [IPC_CHANNELS.APPROVAL_DISCOVER_MODELS]: input => service.discoverExternalReviewerModels(input),
    [IPC_CHANNELS.TELEMETRY_GET_DASHBOARD]: () => service.getTelemetryDashboard(),
    [IPC_CHANNELS.TELEMETRY_UPDATE_RATE_CARDS]: rates => service.updateModelRateCards(rates),
    [IPC_CHANNELS.PLUGINS_GET_SNAPSHOT]: cwd => service.getPluginsSnapshot(cwd),
    [IPC_CHANNELS.PLUGINS_RUN_ACTION]: input => service.runPluginAction(input),
    [IPC_CHANNELS.MCP_RUN_ACTION]: input => service.runMcpAction(input),
    [IPC_CHANNELS.SKILLS_TOGGLE_ENABLED]: (id, enabled) => service.toggleSkillEnabled(id, enabled),
    [IPC_CHANNELS.SWARM_GET_STATE]: id => service.getSwarmState(id),
  };
  // 调用时读取窗口当前 URL，以窗口对象、主 frame 和页面地址共同确认来源。
  const trustedUrl = () => trustedContents.getURL();
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== trustedContents || event.senderFrame !== trustedContents.mainFrame || event.senderFrame?.url !== trustedUrl()) throw new Error('拒绝来自非主窗口的 IPC 请求');
      if (args.length > 3) throw new Error('IPC 参数数量无效');
      if (JSON.stringify(args).length > 32 * 1024 * 1024) throw new Error('IPC 请求超过大小限制');
      return handler(...args);
    });
  }
  // 请求由页面发起，服务事件沿相反方向推送。保存每个监听器的引用，便于成对注销。
  const events: Record<string, string> = { 'session-updated': IPC_CHANNELS.EVENT_SESSION_UPDATED, 'message-upserted': IPC_CHANNELS.EVENT_MESSAGE_UPSERTED, 'inspector-updated': IPC_CHANNELS.EVENT_INSPECTOR_UPDATED, 'history-updated': IPC_CHANNELS.EVENT_HISTORY_UPDATED, 'account-updated': IPC_CHANNELS.EVENT_ACCOUNT_UPDATED, 'approval-requested': IPC_CHANNELS.EVENT_APPROVAL_REQUESTED, 'approval-resolved': IPC_CHANNELS.EVENT_APPROVAL_RESOLVED, 'telemetry-updated': IPC_CHANNELS.EVENT_TELEMETRY_UPDATED, 'swarm-updated': IPC_CHANNELS.EVENT_SWARM_UPDATED, 'update-state': IPC_CHANNELS.EVENT_UPDATE_STATE };
  const listeners = Object.entries(events).map(([event, channel]) => {
    const listener = (payload: unknown) => { if (!trustedContents.isDestroyed()) trustedContents.send(channel, payload); };
    service.on(event, listener); return { event, listener };
  });
  return () => { for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel); for (const { event, listener } of listeners) service.off(event, listener); };
}

import { types } from 'node:util';
import type { VoiceAppendInput } from '../shared/voice-contract';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC_CHANNELS, type GravityDesktopBridge } from '../shared/ipc-channels';
import type { CoreService } from './core-service';

type Channels = typeof IPC_CHANNELS;
type InvokeChannel = Channels[Exclude<keyof Channels, `EVENT_${string}`>];

type BridgeMethods = keyof GravityDesktopBridge & keyof CoreService;
type CompatibleMethod = {
  [K in BridgeMethods]: CoreService[K] extends GravityDesktopBridge[K] ? K : never;
}[BridgeMethods];

function checkVoiceAppend(value: unknown): number {
  const invalid = (): never => { throw new Error('语音分片格式无效'); };
  if (!value || typeof value !== 'object') return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return invalid();
  if (Reflect.ownKeys(value).length !== 3 || !['captureId', 'seq', 'pcm16'].every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, 'value');
  })) return invalid();
  const { captureId, seq, pcm16 } = value as VoiceAppendInput;
  if (typeof captureId !== 'string' || !captureId.length || captureId.length > 128 ||
      !Number.isSafeInteger(seq) || seq < 1) return invalid();
  const view = ArrayBuffer.isView(pcm16);
  if (view && Object.getPrototypeOf(pcm16) !== Uint8Array.prototype) return invalid();
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const actual = (key: string) => Object.getOwnPropertyDescriptor(typed, key)!.get!.call(pcm16);
  const buffer = view ? actual('buffer') : pcm16;
  // Invoke the intrinsic brand check. Shared buffers and lookalikes cannot satisfy it.
  const get = (key: string) => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, key)?.get;
  const bytes: number = get('byteLength')!.call(buffer);
  if (!bytes || bytes > 32_768 || bytes % 2 || get('resizable')?.call(buffer) || get('detached')?.call(buffer) ||
      (view && (actual('byteOffset') !== 0 || actual('byteLength') !== bytes))) return invalid();
  return bytes;
}

function checkPayload(args: unknown[], channel: string): void {
  const prompt = channel === IPC_CHANNELS.SESSION_SEND_PROMPT || channel === IPC_CHANNELS.SESSION_REVISE_MESSAGE;
  let audio: VoiceAppendInput['pcm16'] | undefined;
  let audioBytes = 0;
  if (channel === IPC_CHANNELS.VOICE_APPEND) {
    if (args.length !== 1) throw Error('语音分片参数数量无效');
    audioBytes = checkVoiceAppend(args[0]);
    audio = (args[0] as VoiceAppendInput).pcm16;
  }
  let attachmentBytes = 0;
  let remaining = 32 * 1024 * 1024;
  const maxNodes = 100_000;
  let nodes = 0;
  const visit = (value: unknown, depth: number, scope?: 'prompt' | 'attachments' | 'attachment' | 'data' | 'voice' | 'pcm16') => {
    if (depth > 64 || ++nodes > maxNodes) throw new Error('IPC 请求超过大小限制');
    if (scope === 'pcm16' && audio && value === audio) {
      remaining -= audioBytes;
      if (remaining < 0) throw Error('IPC 请求超过大小限制');
      return;
    }
    if (types.isAnyArrayBuffer(value) || ArrayBuffer.isView(value)) throw Error('IPC 参数格式无效');
    if (scope === 'data' && value !== undefined) {
      const maxBytes = 20 * 1024 * 1024;
      if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('附件编码无效或超过大小限制');
      const bytes = Buffer.byteLength(value, 'base64');
      attachmentBytes += bytes;
      if (bytes > maxBytes || attachmentBytes > 24 * 1024 * 1024 || remaining < 0) throw new Error('附件超过大小限制');
      return;
    }
    if (scope === 'attachments' && value !== undefined && (!Array.isArray(value) || value.length > 20)) throw new Error('附件数量无效');
    if (typeof value === 'string' && value.length > remaining) throw new Error('IPC 请求超过大小限制');
    remaining -= typeof value === 'string' ? Buffer.byteLength(value) + 2 : 8;
    if (remaining < 0) throw new Error('IPC 请求超过大小限制');
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') {
      if (!['boolean', 'number', 'string'].includes(typeof value)) throw new Error('IPC 参数格式无效');
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > maxNodes - nodes) throw new Error('IPC 请求超过大小限制');
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error('IPC 参数格式无效');
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (key.length > remaining) throw new Error('IPC 请求超过大小限制');
      remaining -= Buffer.byteLength(key) + 3;
      const childScope = audio && depth === 0 && key === '0' ? 'voice'
        : scope === 'voice' && key === 'pcm16' ? 'pcm16' : prompt && depth === 0 && key === '0' ? 'prompt'
        : scope === 'prompt' && key === 'attachments' ? 'attachments'
        : scope === 'attachments' && /^(0|[1-9]\d*)$/.test(key) ? 'attachment'
        : scope === 'attachment' && key === 'dataBase64' ? 'data' : undefined;
      visit((value as Record<string, unknown>)[key], depth + 1, childScope);
    }
  };
  visit(args, 0);
}

/** 将一个窗口绑定到一个 CoreService。返回的函数同时解除请求处理和事件转发，供应用退出时调用。 */
export function registerIpcRouter(ipcMain: IpcMain, service: CoreService, trustedContents: WebContents, trustedUrl = trustedContents.getURL()): () => void {
  const handlers = {
    [IPC_CHANNELS.APP_GET_BOOTSTRAP]: 'getBootstrap',
    [IPC_CHANNELS.APP_UPDATE_PREFERENCES]: 'updatePreferences',
    [IPC_CHANNELS.APP_SET_ICON]: 'setAppIcon',
    [IPC_CHANNELS.APP_IMPORT_CUSTOM_THEME]: 'importCustomTheme',
    [IPC_CHANNELS.APP_EXPORT_CUSTOM_THEME]: 'exportCustomTheme',
    [IPC_CHANNELS.APP_INSPECT_LOCAL_TARGETS]: 'inspectLocalTargets',
    [IPC_CHANNELS.APP_OPEN_TARGET]: 'openLinkOrFileTarget',
    [IPC_CHANNELS.APP_COPY_TEXT]: 'copyText',
    [IPC_CHANNELS.APP_SELECT_DIRECTORY]: 'selectDirectory',
    [IPC_CHANNELS.APP_CHECK_UPDATES]: 'checkForUpdates',
    [IPC_CHANNELS.APP_DOWNLOAD_UPDATE]: 'downloadUpdate',
    [IPC_CHANNELS.APP_INSTALL_UPDATE]: 'installUpdate',
    [IPC_CHANNELS.ACCOUNT_GET_STATE]: 'getAccountsState',
    [IPC_CHANNELS.ACCOUNT_CREATE_PROFILE]: 'createAccountProfile',
    [IPC_CHANNELS.ACCOUNT_DELETE_PROFILE]: 'deleteAccountProfile',
    [IPC_CHANNELS.ACCOUNT_SWITCH_PROFILE]: 'switchAccountProfile',
    [IPC_CHANNELS.AUTH_LAUNCH_OFFICIAL_LOGIN]: 'launchOfficialLogin',
    [IPC_CHANNELS.AUTH_OFFICIAL_LOGOUT]: 'officialLogout',
    [IPC_CHANNELS.ACP_GET_CONNECTION_STATUS]: 'getConnectionStatus',
    [IPC_CHANNELS.SESSION_LIST]: 'listSessions',
    [IPC_CHANNELS.SESSION_CREATE]: 'createSession',
    [IPC_CHANNELS.SESSION_RESUME]: 'resumeSession',
    [IPC_CHANNELS.SESSION_MANAGE]: 'manageSession',
    [IPC_CHANNELS.SESSION_ANSWER_QUESTION]: 'answerQuestion',
    [IPC_CHANNELS.ACCOUNT_QUOTA]: 'getAccountQuota',
    [IPC_CHANNELS.SESSION_CLOSE]: 'closeSession',
    [IPC_CHANNELS.SESSION_SET_MODE]: 'setSessionMode',
    [IPC_CHANNELS.SESSION_SET_EFFORT]: 'setSessionEffort',
    [IPC_CHANNELS.SESSION_SET_MODEL]: 'setSessionModel',
    [IPC_CHANNELS.SESSION_GET_INSPECTOR]: 'getSessionInspector',
    [IPC_CHANNELS.SESSION_GET_PLAN_ARTIFACT]: 'getSessionPlanArtifact',
    [IPC_CHANNELS.SESSION_LIST_WORKSPACE_FILES]: 'listWorkspaceFiles',
    [IPC_CHANNELS.SESSION_REVISE_MESSAGE]: 'reviseMessage',
    [IPC_CHANNELS.SESSION_GET_TREE]: 'getConversationTree',
    [IPC_CHANNELS.SESSION_SWITCH_BRANCH]: 'switchConversationBranch',
    [IPC_CHANNELS.SESSION_SEND_PROMPT]: 'sendPrompt',
    [IPC_CHANNELS.SESSION_CANCEL_PROMPT]: 'cancelPrompt',
    [IPC_CHANNELS.SESSION_COMPACT_CONTEXT]: 'compactSessionContext',
    [IPC_CHANNELS.SESSION_GET_MESSAGE_PAGE]: 'getSessionMessagePage',
    [IPC_CHANNELS.SESSION_SAVE_LAYOUT]: 'saveWorkspaceLayout',
    [IPC_CHANNELS.SESSION_RENAME]: 'renameSession',
    [IPC_CHANNELS.SESSION_TOGGLE_PIN]: 'togglePinSession',
    [IPC_CHANNELS.SESSION_ORGANIZE_TITLES]: 'organizeTitles',
    [IPC_CHANNELS.APPROVAL_SET_MODE]: 'setApprovalMode',
    [IPC_CHANNELS.APPROVAL_UPDATE_CONFIG]: 'updateApprovalConfig',
    [IPC_CHANNELS.APPROVAL_SUBMIT_DECISION]: 'submitApprovalDecision',
    [IPC_CHANNELS.APPROVAL_LIST_SESSION_GRANTS]: 'listSessionApprovalGrants',
    [IPC_CHANNELS.APPROVAL_REVOKE_SESSION_GRANT]: 'revokeSessionApprovalGrant',
    [IPC_CHANNELS.APPROVAL_CANCEL_STAGE2_REVIEW]: 'cancelStage2ApprovalReview',
    [IPC_CHANNELS.APPROVAL_CLEAR_SESSION]: 'clearSessionApprovals',
    [IPC_CHANNELS.APPROVAL_LIST_AUDIT]: 'listApprovalAudit',
    [IPC_CHANNELS.APPROVAL_DISCOVER_MODELS]: 'discoverExternalReviewerModels',
    [IPC_CHANNELS.APPROVAL_TEST_CONNECTION]: 'testExternalReviewerConnection',
    [IPC_CHANNELS.VOICE_GET_STATE]: 'getVoiceState',
    [IPC_CHANNELS.VOICE_UPDATE_CONFIG]: 'updateVoiceConfig',
    [IPC_CHANNELS.VOICE_DISCOVER_MODELS]: 'discoverVoiceModels',
    [IPC_CHANNELS.VOICE_TEST_CONNECTION]: 'testVoiceConnection',
    [IPC_CHANNELS.VOICE_INSTALL_MODEL]: 'installVoiceModel',
    [IPC_CHANNELS.VOICE_ARM_CAPTURE]: 'voiceArmCapture',
    [IPC_CHANNELS.VOICE_APPEND]: 'voiceAppend',
    [IPC_CHANNELS.VOICE_FINISH]: 'voiceFinish',
    [IPC_CHANNELS.VOICE_ABORT]: 'voiceAbort',
    [IPC_CHANNELS.TRANSLATION_GET_CONFIG]: 'getTranslationConfig',
    [IPC_CHANNELS.TRANSLATION_UPDATE_CONFIG]: 'updateTranslationConfig',
    [IPC_CHANNELS.TRANSLATION_DISCOVER_MODELS]: 'discoverExternalTranslationModels',
    [IPC_CHANNELS.TRANSLATION_TEST_CONNECTION]: 'testExternalTranslatorConnection',
    [IPC_CHANNELS.TELEMETRY_GET_DASHBOARD]: 'getTelemetryDashboard',
    [IPC_CHANNELS.TELEMETRY_UPDATE_RATE_CARDS]: 'updateModelRateCards',
    [IPC_CHANNELS.PLUGINS_GET_SNAPSHOT]: 'getPluginsSnapshot',
    [IPC_CHANNELS.PLUGINS_RUN_ACTION]: 'runPluginAction',
    [IPC_CHANNELS.MCP_RUN_ACTION]: 'runMcpAction',
    [IPC_CHANNELS.SKILLS_TOGGLE_ENABLED]: 'toggleSkillEnabled',
    [IPC_CHANNELS.SWARM_GET_STATE]: 'getSwarmState',
  } as const satisfies Record<InvokeChannel, CompatibleMethod>;
  // 调用时读取窗口当前 URL，以窗口对象、主 frame 和页面地址共同确认来源。
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== trustedContents || event.senderFrame !== trustedContents.mainFrame || event.senderFrame?.url !== trustedUrl || trustedContents.getURL() !== trustedUrl) throw new Error('拒绝来自非主窗口的 IPC 请求');
      if (args.length > 3 || (channel.startsWith('gravity:voice:') &&
          (channel === IPC_CHANNELS.VOICE_GET_STATE ? args.length !== 0 :
            channel === IPC_CHANNELS.VOICE_INSTALL_MODEL || channel === IPC_CHANNELS.VOICE_TEST_CONNECTION ? args.length > 1 : args.length !== 1))) throw new Error('IPC 参数数量无效');
      if (service.savingForQuit && !/^(?:get|list|inspect|cancel|voiceAbort)/.test(handler) &&
          !(handler === 'installVoiceModel' && (args[0] as { action?: string })?.action === 'cancel') &&
          !(handler === 'voiceArmCapture' && (args[0] as { op?: string })?.op === 'release-media')) throw Error('正在保存退出，请稍候');
      checkPayload(args, channel);
      return Reflect.apply(service[handler], service, args);
    });
  }
  // 请求由页面发起，服务事件沿相反方向推送。保存每个监听器的引用，便于成对注销。
  const events = {
    'approval-reviewing': IPC_CHANNELS.EVENT_APPROVAL_REVIEWING,
    'approval-guard-activity': IPC_CHANNELS.EVENT_APPROVAL_GUARD_ACTIVITY,
    'connection-updated': IPC_CHANNELS.EVENT_CONNECTION_UPDATED,
    'session-updated': IPC_CHANNELS.EVENT_SESSION_UPDATED,
    'message-upserted': IPC_CHANNELS.EVENT_MESSAGE_UPSERTED,
    'inspector-updated': IPC_CHANNELS.EVENT_INSPECTOR_UPDATED,
    'plan-artifact-changed': IPC_CHANNELS.EVENT_PLAN_ARTIFACT_CHANGED,
    'account-updated': IPC_CHANNELS.EVENT_ACCOUNT_UPDATED,
    'approval-config-updated': IPC_CHANNELS.EVENT_APPROVAL_CONFIG_UPDATED,
    'approval-requested': IPC_CHANNELS.EVENT_APPROVAL_REQUESTED,
    'approval-resolved': IPC_CHANNELS.EVENT_APPROVAL_RESOLVED,
    'telemetry-wire': IPC_CHANNELS.EVENT_TELEMETRY_UPDATED,
    'swarm-updated': IPC_CHANNELS.EVENT_SWARM_UPDATED,
    'update-state': IPC_CHANNELS.EVENT_UPDATE_STATE,
    'tree-updated': IPC_CHANNELS.EVENT_TREE_UPDATED,
    'voice-segment': IPC_CHANNELS.EVENT_VOICE_SEGMENT,
    'voice-settled': IPC_CHANNELS.EVENT_VOICE_SETTLED,
    'voice-capture-revoked': IPC_CHANNELS.EVENT_VOICE_CAPTURE_REVOKED,
    'translation-config-updated': IPC_CHANNELS.EVENT_TRANSLATION_CONFIG_UPDATED,
  } as const;
  const listeners = Object.entries(events).map(([event, channel]) => {
    const listener = (payload: unknown) => { if (!trustedContents.isDestroyed() && trustedContents.getURL() === trustedUrl) trustedContents.send(channel, payload); };
    service.on(event, listener); return { event, listener };
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const { event, listener } of listeners) service.off(event, listener);
    service.voice?.revoke('window-closed');
  };
}

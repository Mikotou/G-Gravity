import type { EventEmitter } from 'node:events';
import type { ManagedSessionSummary } from '../shared/session-contract';
import type { ClientPreferences, GravityIconPreference } from '../shared/theme-i18n-contract';
import type { AcpClient } from './acp/acp-client';
import type { AcpClientOptions } from './acp/acp-types';
import type { ApprovalEngine } from './approval/approval-engine';
import type { Reviewer } from './approval/external-reviewer';
import type { ClientStore } from './storage/client-store';
import type { ConversationMessages } from './storage/conversation-messages';
import type { SessionMultiplexer } from './session/session-multiplexer';
import type { TitleOrganizer } from './organizer/title-organizer';
import type { TelemetryStore } from './telemetry/telemetry-store';
import type { ThoughtTranslator } from './translation/thought-translator';
import type { SwarmWorkerClient } from './swarm/swarm-worker-client';
import type { AccountManager } from './accounts/account-manager';
import type { CliExecutor } from './plugins/plugins-manager';
import type { WorkspaceFiles } from './workspace/workspace-files';
import type { InspectorStore } from './session/inspector-store';
import type { ConversationTreeStore } from './session/conversation-tree-store';
import type { ExternalTranslatorFn } from './translation/external-translator';
import type { GitHubUpdaterOptions } from './updater/github-updater';
import type { SecretCipher } from './services/secret-vault';
import type { LocalTargetContext } from './services/local-media-inspector';
import type { GravityDesktopBridge } from '../shared/ipc-channels';
export interface CoreServiceOptions {
  dataDir: string;
  acp?: AcpClient;
  acpOptions?: AcpClientOptions;
  reviewer?: Reviewer;
  externalTranslator?: ExternalTranslatorFn;
  modelDiscoveryFetcher?: typeof fetch;
  secretCipher?: SecretCipher;
  translator?: ThoughtTranslator;
  pluginsExecutor?: CliExecutor;
  homeDir?: string;
  now?: () => number;
  appVersion?: string;
  enableAutoUpdateCheck?: boolean;
  updaterOptions?: Partial<GitHubUpdaterOptions>;
  windowChrome?: 'win-overlay' | 'mac-inset' | 'standard';
  setIcon?: (iconId: GravityIconPreference) => void | Promise<void>;
  setZoom?: (factor: number) => void;
  onThemeChanged?: (preferences: ClientPreferences) => void;
  openTargetHandler?: (resolvedTarget: string, mode: 'browser' | 'default-app' | 'reveal-in-folder' | 'copy' | 'copy-image', isDirectory?: boolean) => void | Promise<void>;
  copyTextHandler?: (text: string) => void | Promise<void>;
  selectDirectoryHandler?: (defaultPath?: string) => Promise<string | null>;
}

export interface ProfileDataBundle {
  messages: ConversationMessages;
  swarm: SwarmWorkerClient;
  inspector: InspectorStore;
  trees: ConversationTreeStore;
}

interface CoreResources extends ProfileDataBundle {
  store: ClientStore;
  accounts: AccountManager;
  sessions: SessionMultiplexer;
  approval: ApprovalEngine;
  telemetry: TelemetryStore;
  titles: TitleOrganizer;
  thoughts: ThoughtTranslator;
  workspaceFiles: WorkspaceFiles;
  client: AcpClient;
  emit: EventEmitter['emit'];
}
export type SettingsHost = Pick<CoreResources, 'store' | 'accounts' | 'client' | 'emit'>;
export type OrganizerHost = Pick<CoreResources, 'accounts' | 'client' | 'sessions' | 'trees' | 'titles' | 'emit'>;
export type ApprovalHost = Pick<CoreResources, 'store' | 'sessions' | 'telemetry' | 'emit'>;
export type TranslationHost = Pick<CoreResources, 'store' | 'telemetry' | 'sessions' | 'emit'>;
export type BranchHost = Pick<CoreResources, 'accounts' | 'sessions' | 'trees' | 'titles' | 'telemetry' | 'inspector' | 'swarm' | 'emit'>
  & Pick<GravityDesktopBridge, 'createSession' | 'resumeSession' | 'sendPrompt' | 'closeSession'>;
export interface TelemetryHost extends Pick<CoreResources, 'store' | 'accounts' | 'client' | 'sessions' | 'telemetry' | 'emit'> {
  listenerCount: EventEmitter['listenerCount'];
  readonly disposed: boolean;
}
export interface TurnHost extends Omit<CoreResources, 'titles' | 'store'> {
  readonly disposed: boolean;
  isChangingSession(id: string): boolean;
  isEphemeral(id: string): boolean;
  enrichSession(session: ManagedSessionSummary): ManagedSessionSummary;
  syncSessionCheckpointWindow(id: string): void;
  maybeSyncSessionCheckpointWindow(id: string): void;
  treeUpdated(id: string): void;
  publishConnection(force?: boolean): void;
  mediaContext(): LocalTargetContext;
}

export interface LifecycleHost extends Pick<TurnHost, 'accounts' | 'client' | 'sessions' | 'telemetry' | 'thoughts' | 'inspector' | 'trees' | 'swarm' | 'messages' | 'approval' | 'emit' | 'mediaContext' | 'isChangingSession'> {
  store: ClientStore;
  titles: TitleOrganizer;
}

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { AcpClient } from '../acp/acp-client';
import { normalizeWorkspacePath, isTempExtractionDir } from '../../shared/session-contract';
import type { ManagedSessionSummary } from '../../shared/session-contract';
import type { ClientStore } from '../storage/client-store';

import { SessionOptionsStore } from './session-options-store';
export function resolveAccessibleCwd(path: string, fallback = homedir()): string {
  return !path || (isTempExtractionDir(path) && !existsSync(path)) ? fallback : normalizeWorkspacePath(path);
}

export class SessionLedger extends EventEmitter {
  readonly sessions = new Map<string, ManagedSessionSummary>();
  protected active = new Set<string>();
  profileId = 'default';
  protected ownedIds = new Set<string>();
  private hasLoadedLedger = false;
  protected readonly options: SessionOptionsStore;
  constructor(readonly client: AcpClient, protected store?: ClientStore) {
    super();
    this.options = new SessionOptionsStore(store, () => this.profileId, client, this.active, this.sessions);
    this.loadOwnedLedger();
    this.options.loadModelCatalog();
  }
  private ownedLedgerFile(): string {
    return `owned-sessions-${this.profileId}.json`;
  }

  ownsSession(id: string): boolean { return this.ownedIds.has(id); }

  hasPersistedLedger(): boolean {
    if (!this.store) return false;
    const raw = this.store.read<Record<string, ManagedSessionSummary> | null>(this.ownedLedgerFile(), null);
    return raw !== null && typeof raw === 'object';
  }

  protected loadOwnedLedger(): void {
    if (!this.store) return;
    // 用 null 区分从未建立清单和已经保存过的空清单，后者不能触发旧消息迁移。
    const saved = this.store.read<Record<string, ManagedSessionSummary> | null>(this.ownedLedgerFile(), null);
    this.hasLoadedLedger = saved !== null;
    if (!saved || typeof saved !== 'object') return;
    for (const [id, item] of Object.entries(saved)) {
      if (!item || typeof item !== 'object' || !id) continue;
      const restoredCwd = resolveAccessibleCwd(item.cwd);
      if (restoredCwd !== item.cwd) {
        item.cwd = restoredCwd;
        item.rawCwd = item.cwd;
      }
      this.ownedIds.add(id);
      this.sessions.set(id, {
        ...this.defaults(),
        ...item,
        ...this.options.settings(id),
        sessionId: id,
        profileId: this.profileId,
        readOnly: false,
        diagnostic: undefined,
        status: this.active.has(id) ? item.status : 'closed',
      });
    }
  }

  flush(): void { this.store?.flushPending(this.ownedLedgerFile()); }

  saveOwnedLedger(): void {
    if (!this.store) return;
    const payload: Record<string, ManagedSessionSummary> = {};
    // 磁盘只记录可恢复的会话摘要。活动状态属于本次连接，下次启动需重新恢复会话。
    for (const id of this.ownedIds) {
      const s = this.sessions.get(id);
      if (s && !s.isLegacyApprovalPollution) {
        const { diagnostic: _transient, ...saved } = s;
        payload[id] = { ...saved, status: 'closed', readOnly: false };
      }
    }
    this.hasLoadedLedger = true;
    this.store.writeDebounced(this.ownedLedgerFile(), payload);
  }

  /**
   * 首次升级迁移：仅将 Gravity 自有 `messages-<profile>.json` 中已保存的对话注册进独立账本，
   * 彻底隔离外部 Antigravity / CLI 会话。
   */
  seedOwnedFromLocalMessages(
    entries: Array<{ sessionId: string; title: string; cwd: string; updatedAt: string }>
  ): void {
    if (!this.store || this.hasLoadedLedger) return;
    for (const entry of entries) {
      const cleanCwd = resolveAccessibleCwd(entry.cwd);
      this.ownedIds.add(entry.sessionId);
      this.sessions.set(entry.sessionId, {
        ...this.defaults(),
        ...this.options.settings(entry.sessionId),
        sessionId: entry.sessionId,
        cwd: cleanCwd,
        rawCwd: cleanCwd,
        title: entry.title || '新建对话',
        pinned: false,
        isLegacyApprovalPollution: false,
        status: 'closed',
        modelId: '',
        updatedAt: entry.updatedAt || new Date().toISOString(),
      });
    }
    this.saveOwnedLedger();
    this.flush();
  }

  forgetSession(id: string): void {
    this.ownedIds.delete(id);
    this.sessions.delete(id);
    this.options.forget(id);
    this.saveOwnedLedger();
    this.flush();
  }

  /** Title overrides have their own durable store and only need the in-memory summary refreshed. */
  updateSessionRecord(session: ManagedSessionSummary, persist = true): void {
    if (!this.sessions.has(session.sessionId)) return;
    this.sessions.set(session.sessionId, { ...session });
    if (persist && this.ownedIds.has(session.sessionId)) {
      this.saveOwnedLedger();
    }
  }

  protected defaults() {
    return {
      executionMode: 'default' as const,
      reasoningEffort: 'high' as const,
      originKind: 'acp-live' as const,
      readOnly: false,
      profileId: this.profileId,
    };
  }

}

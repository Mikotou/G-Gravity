import { join } from 'node:path';
import { TelemetryStore } from './telemetry-store';
import { readSessionCheckpointLimit } from './checkpoint-limit-reader';
import type { CoreServiceOptions, TelemetryHost } from '../core-contracts';

export class TelemetryCoordinator {
  constructor(private app: TelemetryHost, private options: CoreServiceOptions, private voiceUsage?: TelemetryStore['voiceUsage']) {}
  private checkpointReading = new Map<string, symbol>();
  private checkpointResolvedModel = new Map<string, string>();
  private checkpointSyncAt = new Map<string, number>();
  private readonly coverBranchChanges = new WeakMap<TelemetryStore, (ids: ReadonlySet<string>) => void>();
  private telemetryPush?: NodeJS.Timeout;
  private telemetryClock?: NodeJS.Timeout;
  createTelemetryStore(profileId: string): TelemetryStore {
    const telemetry = new TelemetryStore({ store: this.app.store, profileId, now: this.options.now });
    telemetry.voiceUsage = this.voiceUsage;
    const changed = new Set<string>();
    const partitions = new Set<string>();
    const native = new Set<string>();
    let all = false;
    telemetry.on('changed', (id: string | undefined, partition: string) => {
      if (this.app.disposed || telemetry !== this.app.telemetry) return;
      if (partition === 'all') { partitions.add('native'); partitions.add('reviewer'); partitions.add('translator'); }
      else partitions.add(partition);
      if (id === undefined && partition === 'native') all = true;
      if (id !== undefined) {
        changed.add(id);
        if (partition === 'native' || partition === 'all') native.add(id);
      }
      if (this.telemetryPush) return;
      this.telemetryPush = setTimeout(() => {
        this.telemetryPush = undefined;
        if (telemetry === this.app.telemetry) {
          const full = all ? telemetry.snapshot() : undefined;
          if (this.app.listenerCount('telemetry-wire')) this.app.emit('telemetry-wire', full ?? telemetry.delta(changed, native, partitions));
          if (this.app.listenerCount('telemetry-updated')) this.app.emit('telemetry-updated', full ?? telemetry.snapshot(changed));
        }
        native.clear();
        changed.clear();
        partitions.clear();
        all = false;
      }, 100);
      this.telemetryPush.unref();
    });
    this.coverBranchChanges.set(telemetry, ids => {
      if (all || !changed.size || [...changed].some(id => !ids.has(id))) return;
      clearTimeout(this.telemetryPush);
      this.telemetryPush = undefined;
      native.clear(); changed.clear(); partitions.clear();
    });
    return telemetry;
  }
  branchSnapshot(ids: ReadonlySet<string>) {
    const snapshot = this.app.telemetry.snapshot();
    this.coverBranchChanges.get(this.app.telemetry)?.(ids);
    return snapshot;
  }
  scheduleTelemetryClock(): void {
    const now = new Date((this.options.now?.() ?? Date.now()));
    const wait = 3600000 - ((now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds());
    this.telemetryClock = setTimeout(() => {
      if (this.app.disposed) return;
      const snapshot = this.app.telemetry.snapshot(new Set());
      this.app.emit('telemetry-wire', snapshot);
      this.app.emit('telemetry-updated', snapshot);
      this.scheduleTelemetryClock();
    }, wait);
    this.telemetryClock.unref();
  }
  private hasAntigravityOptions(sessionId?: string): boolean {
    const agentName = this.app.client.initializeResult?.agentInfo?.name || '';
    return agentName.toLowerCase().includes('antigravity') || Boolean(sessionId && this.app.sessions.hasConfigOptions(sessionId));
  }
  /** 在后台读取当前 Profile 里该会话的压缩阈值，成功后再更新看板并记录同模型学习值。缺失读数时继续使用已有窗口估计。 */
  syncSessionCheckpointWindow(sessionId: string): void {
    if (!this.hasAntigravityOptions(sessionId)) return;
    const session = this.app.sessions.sessions.get(sessionId);
    const modelId = session?.modelId;
    const modelKey = (modelId || '').trim().toLowerCase();
    const now = (this.options.now?.() ?? Date.now());
    const last = this.checkpointSyncAt.get(sessionId);
    if (this.checkpointReading.has(sessionId) || (last !== undefined && now - last <
        (modelKey && this.checkpointResolvedModel.get(sessionId) === modelKey ? 300000 : 4000))) return;
    const request = Symbol();
    this.checkpointReading.set(sessionId, request);
    this.checkpointSyncAt.set(sessionId, (this.options.now?.() ?? Date.now()));
    const activeProfile = this.app.accounts
      .getState()
      .profiles.find((p) => p.profileId === this.app.accounts.activeProfileId);
    void readSessionCheckpointLimit({
      sessionId,
      cacheDir: join(this.options.dataDir, 'checkpoint-cache'),
      isolatedAppDataDir: activeProfile?.isDefault ? undefined : activeProfile?.isolatedAppDataDir,
      homeDir: this.options.homeDir,
    })
      .then((limit) => {
        if (limit && !this.app.disposed && this.checkpointReading.get(sessionId) === request && activeProfile?.profileId === this.app.accounts.activeProfileId
            && this.app.sessions.sessions.has(sessionId) && this.app.sessions.sessions.get(sessionId)?.modelId === modelId) {
          this.checkpointResolvedModel.set(sessionId, modelKey);
          this.app.telemetry.setCheckpointWindowLimit(sessionId, limit, modelId);
        }
      })
      .catch(() => {}).finally(() => {
        if (this.checkpointReading.get(sessionId) === request) this.checkpointReading.delete(sessionId);
      });
  }
  /** 回合进行中按 4 秒节流读取一次实测压缩阈值，避免长回合首轮一直停留在 256k 默认值。 */
  maybeSyncSessionCheckpointWindow(sessionId: string): void {
    if (!this.hasAntigravityOptions(sessionId)) return;
    const modelKey = (this.app.sessions.sessions.get(sessionId)?.modelId || '').trim().toLowerCase();
    if (this.checkpointResolvedModel.get(sessionId) === modelKey && modelKey) return;
    const last = this.checkpointSyncAt.get(sessionId) || 0;
    if ((this.options.now?.() ?? Date.now()) - last < 4000) return;
    this.syncSessionCheckpointWindow(sessionId);
  }
  resetSession(id: string): void {
    this.checkpointSyncAt.delete(id);
    this.checkpointResolvedModel.delete(id);
    this.checkpointReading.delete(id);
  }
  resetProfile(): void {
    this.checkpointSyncAt.clear();
    this.checkpointResolvedModel.clear();
    this.checkpointReading.clear();
    clearTimeout(this.telemetryPush);
    this.telemetryPush = undefined;
  }
  dispose(): void { this.resetProfile(); clearTimeout(this.telemetryClock); }
}

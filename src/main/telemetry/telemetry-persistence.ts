import { pressureLevel } from './telemetry-data';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_MODEL_RATE_CARDS } from '../../shared/telemetry-contract';
import type {
  ContextCompactionRecord, FourDimTokenCounts, ModelRateCard, SessionContextTelemetry,
  TelemetryDashboardSnapshot,
} from '../../shared/telemetry-contract';
import { cacheHitRate, validCacheUsage } from './acp-usage';
import {
  KEYS, selectedEntries, isRecord, SESSION_FIELDS, type HourRecord, type Turn, type TelemetryOptions,
  type SavedSessionTelemetry, type SavedCompactions, type StreamingCheckpoint,
} from './telemetry-data';
import { ExternalServiceLedger } from './external-service-ledger';
import { TelemetryAggregator, nativeCalendar } from './telemetry-aggregator';
export abstract class TelemetryPersistence extends EventEmitter {
  protected states = new Map<string, SessionContextTelemetry>();
  protected ledger = new Map<string, HourRecord>();
  protected sessionCounts = new Map<string, Map<string, FourDimTokenCounts>>();
  protected sessionSpeedStats = new Map<string, { totalGeneratedTokens: number; totalDurationSec: number; completedTurns: number }>();
  protected samples = new Map<string, Array<{ time: number; tokens: number }>>();
  protected turns = new Map<string, Turn>();
  protected reportedUsed = new Map<string, number>();
  protected checkpointLimits = new Map<string, number>();
  protected reportedWindowLimits = new Map<string, number>();
  protected otherProfiles = new Map<string, Record<string, unknown>>();
  protected readonly legacyProfileId: string;
  protected readonly streamingFile: string;
  protected checkpointOnDisk = false;
  protected generation: string;
  protected pendingSessions = new Set<string>();
  protected pendingHours = new Set<string>();
  protected migratingLedgers = false;
  protected learnedModelLimits = new Map<string, number>();
  protected compactionsBySession = new Map<string, ContextCompactionRecord[]>();
  protected pendingCompaction = new Map<string, { before: number; beforeEstimated: boolean; after?: number; completed?: boolean; estimatedRecord?: ContextCompactionRecord }>();
  protected rateCards: ModelRateCard[];
  protected customRates: boolean;
  protected timer?: NodeJS.Timeout;
  protected now: () => number;


  protected readonly nativeCache = new TelemetryAggregator<ReturnType<typeof nativeCalendar>>();
  private backgroundLedgers = false;
  private externalHost = {
    now: () => this.now(), rates: () => this.rateCards,
    read: <T>(name: string, fallback: T) => this.readLedger(name, fallback),
    write: (name: string, data: unknown) => this.writeLedger(name, data),
    loadProfiles: <T extends object>(key: string, legacy: T, profiles?: Record<string, T>) => this.readProfileData(key, legacy, profiles),
    saveProfiles: (key: string, data: object) => this.profileData(key, data),
    inactive: (key: string) => this.otherProfiles.get(key)!,
    currentProfile: () => this.options.profileId || 'default',
    hourSessionId: (id: string, profileId: string) => this.hourSessionId(id, profileId),
  };
  protected readonly reviewer = new ExternalServiceLedger('reviewer', { approvedCount: 'approve', askCount: 'ask', denyCount: 'deny' }, this.externalHost);
  protected readonly translator = new ExternalServiceLedger('translator', { successCount: 'success', fallbackCount: 'fallback' }, this.externalHost);

  protected abstract refresh(state: SessionContextTelemetry, emit?: boolean): void;
  protected abstract resolveMaxWindow(id: string, model?: string): number;
  abstract snapshot(sessionIds?: ReadonlySet<string>): TelemetryDashboardSnapshot;

  // A previous executable can still share this client data directory and write its old format on exit.
  private readLedger<T>(name: string, fallback: T): T {
    const current = this.options.store.read<T | null>(`v2-${name}`, null);
    if (current !== null) return current;
    const legacy = this.options.store.read<T | null>(name, null);
    if (legacy !== null) this.migratingLedgers = true;
    return legacy ?? fallback;
  }

  private writeLedger(name: string, value: unknown): void {
    this.options.store.write('v2-' + name, value, this.backgroundLedgers ? 'queued' : 'immediate');
  }

  // Previous versions stored the last active profile's maps without an owner. Claim them once
  // for the original default profile, even if a different profile performs the upgrade.
  private readProfileData<T extends object>(key: string, legacy: T, profiles?: Record<string, T>): T {
    const owner = this.options.profileId || 'default';
    const retained = { ...profiles };
    if (!profiles && owner !== this.legacyProfileId) retained[this.legacyProfileId] = legacy;
    delete retained[owner];
    this.otherProfiles.set(key, retained);
    if (profiles) return profiles[owner] ?? {} as T;
    return owner === this.legacyProfileId ? legacy : {} as T;
  }

  private profileData(key: string, data: object): Record<string, unknown> {
    return { ...this.otherProfiles.get(key), [this.options.profileId || 'default']: data };
  }

  protected hourSessionId(id: string, profileId = this.options.profileId): string {
    return profileId && profileId !== 'default' ? `${profileId}\0${id}` : id;
  }

  protected notifyUpdated(sessionId?: string, snapshot?: TelemetryDashboardSnapshot, partition: 'native' | 'reviewer' | 'translator' | 'all' = 'native'): void {
    this.emit('changed', sessionId, partition);
    if (this.listenerCount('updated')) this.emit('updated', snapshot ?? this.snapshot());
  }

  constructor(protected options: TelemetryOptions) {
    super();
    this.now = options.now || Date.now;
    const sessionsFile = this.readLedger<SavedSessionTelemetry & {
      profiles?: Record<string, SavedSessionTelemetry>; legacyProfileId?: string; generation?: string;
    }>('session-telemetry.json', {});
    this.legacyProfileId = sessionsFile?.legacyProfileId || 'default';
    this.streamingFile = 'telemetry-stream-' + createHash('sha256').update(options.profileId || 'default').digest('hex') + '.json';
    this.generation = sessionsFile?.generation ?? 'original';
    options.store.flushPending(this.streamingFile);
    const resumed = options.store.read<StreamingCheckpoint | null>(this.streamingFile, null);
    const checkpoint = resumed && resumed.generation === this.generation && Array.isArray(resumed.ids) && Array.isArray(resumed.hours) && isRecord(resumed.sessions) ? resumed : undefined;
    this.checkpointOnDisk = !!checkpoint;
    const saved = options.store.read<ModelRateCard[] | null>('model-rate-cards.json', null);
    this.customRates = !!(options.rateCards || saved);
    this.rateCards = structuredClone(options.rateCards || saved || [...DEFAULT_MODEL_RATE_CARDS]);
    try {
      this.validateRates(this.rateCards);
    } catch {
      this.rateCards = structuredClone([...DEFAULT_MODEL_RATE_CARDS]);
      this.customRates = false;
    }

    const records = this.readLedger<HourRecord[]>('token-hours.json', []);
    for (const record of [...(Array.isArray(records) ? records : []), ...(checkpoint?.hours ?? [])]) {
      if (
        record && /^\d{4}-\d{2}-\d{2}T\d{2}(?::[0-5]\d)?$/.test(record.hourKey) &&
        typeof record.modelId === 'string' &&
        KEYS.every((key) => Number.isFinite(record[key]) && record[key] >= 0) &&
        Array.isArray(record.sessions)
      ) {
        this.ledger.set(`${record.hourKey}\0${record.modelId}`, record);
      }
    }
    for (const record of checkpoint?.hours ?? []) if (record) this.pendingHours.add(`${record.hourKey}\0${record.modelId}`);

    const compactionsFile = this.readLedger<SavedCompactions & { profiles?: Record<string, SavedCompactions> }>('compactions.json', {});
    const savedCompactions = this.readProfileData('compactions', compactionsFile || {}, compactionsFile?.profiles);
    if (savedCompactions && typeof savedCompactions === 'object') {
      for (const [sid, list] of Object.entries(savedCompactions)) {
        if (Array.isArray(list)) this.compactionsBySession.set(sid, list.slice(-50));
      }
    }

    this.reviewer.load();
    this.translator.load();

    const savedSessions = this.readProfileData<SavedSessionTelemetry>('sessions', sessionsFile || {}, sessionsFile?.profiles);
    if (checkpoint) {
      for (const field of SESSION_FIELDS) {
        const entries: Record<string, unknown> = savedSessions[field] ??= {};
        for (const id of checkpoint.ids) delete entries[id];
        Object.assign(entries, checkpoint.sessions[field]);
      }
      Object.assign(sessionsFile.learnedModelLimits ??= {}, checkpoint.learnedModelLimits);
    }
    for (const [id, limit] of Object.entries(savedSessions.reportedWindowLimits || {})) {
      if (Number.isFinite(limit) && limit > 0 && limit <= 800_000) this.reportedWindowLimits.set(id, limit);
    }
    if (savedSessions?.sessionSpeedStats && typeof savedSessions.sessionSpeedStats === 'object') {
      for (const [sid, stat] of Object.entries(savedSessions.sessionSpeedStats)) {
        if (
          stat &&
          typeof stat === 'object' &&
          Number.isFinite(stat.totalGeneratedTokens) &&
          stat.totalGeneratedTokens >= 0 &&
          Number.isFinite(stat.totalDurationSec) &&
          stat.totalDurationSec >= 0 &&
          Number.isFinite(stat.completedTurns) &&
          stat.completedTurns >= 0
        ) {
          this.sessionSpeedStats.set(sid, {
            totalGeneratedTokens: stat.totalGeneratedTokens,
            totalDurationSec: stat.totalDurationSec,
            completedTurns: stat.completedTurns,
          });
        }
      }
    }
    if (savedSessions?.checkpointLimits && typeof savedSessions.checkpointLimits === 'object') {
      for (const [sid, lim] of Object.entries(savedSessions.checkpointLimits)) {
        if (typeof lim === 'number' && lim >= 16_000 && lim <= 2_000_000) {
          this.checkpointLimits.set(sid, lim);
        }
      }
    }
    if (sessionsFile?.learnedModelLimits && typeof sessionsFile.learnedModelLimits === 'object') {
      for (const [mid, lim] of Object.entries(sessionsFile.learnedModelLimits)) {
        const key = mid.trim().toLowerCase();
        if (key && key !== 'default' && typeof lim === 'number' && lim >= 16_000 && lim <= 2_000_000) {
          this.learnedModelLimits.set(key, Math.round(lim));
        }
      }
    }
    if (savedSessions?.reportedUsed && typeof savedSessions.reportedUsed === 'object') {
      for (const [sid, val] of Object.entries(savedSessions.reportedUsed)) {
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) this.reportedUsed.set(sid, val);
      }
    }
    if (savedSessions?.sessionCounts && typeof savedSessions.sessionCounts === 'object') {
      for (const [sid, modelMap] of Object.entries(savedSessions.sessionCounts)) {
        if (modelMap && typeof modelMap === 'object') {
          const inner = new Map<string, FourDimTokenCounts>();
          for (const [mid, counts] of Object.entries(modelMap)) {
            if (counts && KEYS.every((k) => Number.isFinite(counts[k]) && counts[k] >= 0)) {
              inner.set(mid, { ...counts });
            }
          }
          if (inner.size > 0) this.sessionCounts.set(sid, inner);
        }
      }
    }
    if (savedSessions?.states && typeof savedSessions.states === 'object') {
      for (const [sid, st] of Object.entries(savedSessions.states)) {
        if (st && typeof st === 'object' && st.sessionId === sid && st.breakdown) {
          const copy = structuredClone(st);
          if (this.reportedUsed.has(sid)) copy.reportedBreakdownTokens ??= Object.values(copy.breakdown).reduce((sum, value) => sum + value, 0);
          const retainedCompactions = this.compactionsBySession.get(sid)?.length ?? 0;
          if (copy.compactionCount === undefined && retainedCompactions >= 50) copy.compactionCountIsMinimum = true;
          copy.compactionCount = Math.max(copy.compactionCount ?? 0, retainedCompactions);
          // 将旧版落盘的 1,048,576 原始输入容量统一迁移为实际模型压缩窗口上限
          copy.maxContextTokens = this.resolveMaxWindow(sid, copy.modelId);
          copy.usageRatio = Math.min(1, copy.usedContextTokens / Math.max(1, copy.maxContextTokens));
          copy.pressureLevel = pressureLevel(copy.usageRatio);
          const speedStat = this.sessionSpeedStats.get(sid);
          if (speedStat && speedStat.totalGeneratedTokens > 0 && speedStat.totalDurationSec > 0) {
            copy.averageTokensPerSecond = Math.round((speedStat.totalGeneratedTokens / speedStat.totalDurationSec) * 10) / 10;
          } else if (copy.averageTokensPerSecond === undefined) {
            copy.averageTokensPerSecond = copy.currentTokensPerSecond || 0;
          }
          if (!validCacheUsage(copy.reportedCacheUsage)) {
            delete copy.reportedCacheUsage;
            // Previous releases saved the same numeric zero for missing and explicit reports.
            if (!this.sessionCounts.has(sid) && !copy.costSummary?.totalTokens && !Object.values(copy.breakdown).some(n => n > 0))
              copy.reportedCacheUsage = { inputTokens: 0, cachedReadTokens: 0 };
          }
          copy.averageCacheHitRate = cacheHitRate(copy.reportedCacheUsage);
          this.states.set(sid, copy);
          if (this.sessionCounts.has(sid)) this.refresh(copy, false);
        }
      }
    }
    this.pendingSessions = new Set(checkpoint?.ids ?? []);
    if (this.migratingLedgers) {
      this.flush();
      this.migratingLedgers = false;
    }
  }

  protected validateRates(rates: ModelRateCard[]): void {
    if (!Array.isArray(rates) || !rates.length || rates.length > 100) {
      throw new Error('模型单价表须包含 1 至 100 项');
    }
    const ids = new Set<string>();
    for (const rate of rates) {
      if (
        typeof rate.modelId !== 'string' ||
        !rate.modelId.trim() ||
        rate.modelId.length > 160 ||
        ids.has(rate.modelId.toLowerCase()) ||
        typeof rate.displayName !== 'string'
      ) {
        throw new Error('模型单价 ID 无效或重复');
      }
      ids.add(rate.modelId.toLowerCase());
      for (const key of [
        'inputPerMillionUsd',
        'cachedInputPerMillionUsd',
        'outputPerMillionUsd',
        'thinkingPerMillionUsd',
      ] as const) {
        if (!Number.isFinite(rate[key]) || rate[key] < 0 || rate[key] > 1000000) {
          throw new Error('Token 单价必须是有限非负数');
        }
      }
    }
    if (!ids.has('default')) throw new Error('单价表须保留 default 参考项');
  }

  /** 把短时间内的账本更新合并为一次落盘，定时器执行完清空引用，下一批分片可重新排队。 */
  protected scheduleFlush(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          if (this.pendingSessions.size || this.pendingHours.size) {
            this.options.store.write(this.streamingFile, {
              generation: this.generation, ids: [...this.pendingSessions], sessions: this.serializeSessions(this.pendingSessions),
              hours: [...this.pendingHours].flatMap(key => this.ledger.get(key) ?? []),
              learnedModelLimits: Object.fromEntries(this.learnedModelLimits),
            } satisfies StreamingCheckpoint, 'queued');
            this.checkpointOnDisk = true;
          }
          this.backgroundLedgers = true;
          const cutoff = new Date(this.now() - 32 * 86400000).toISOString().slice(0, 13);
          if (this.reviewer.dirty) this.reviewer.flush(cutoff);
          if (this.translator.dirty) this.translator.flush(cutoff);
        } catch {
          this.emit('storageError', 'Token 历史账本保存失败');
        } finally { this.backgroundLedgers = false; }
      }, 250);
      this.timer.unref();
    }
  }

  protected removeLegacySession(sessionId: string): void {
    const owner = this.options.profileId || 'default';
    for (const name of ['session-telemetry.json', 'compactions.json', 'external-reviewer-totals.json', 'external-translator-totals.json']) {
      const file = this.options.store.read<unknown>(name, null);
      if (!isRecord(file)) continue;
      let group: unknown;
      if (isRecord(file.profiles)) group = file.profiles[owner];
      else if (owner === this.legacyProfileId) group = name.endsWith('-totals.json') ? file.sessions : file;
      if (!isRecord(group)) continue;
      const maps = name === 'session-telemetry.json'
        ? [group.states, group.sessionCounts, group.sessionSpeedStats, group.reportedUsed, group.checkpointLimits, group.reportedWindowLimits]
        : [group];
      let changed = false;
      for (const entries of maps) {
        if (isRecord(entries) && Object.prototype.hasOwnProperty.call(entries, sessionId)) {
          delete entries[sessionId];
          changed = true;
        }
      }
      if (changed) this.options.store.write(name, file);
    }
  }

  protected saveCompactions(): void {
    this.writeLedger('compactions.json', { profiles: this.profileData('compactions', Object.fromEntries(this.compactionsBySession)) });
  }

  private serializeSessions(ids?: ReadonlySet<string>): SavedSessionTelemetry {
    const serializedCounts: Record<string, Record<string, FourDimTokenCounts>> = {};
    for (const [sid, inner] of selectedEntries(this.sessionCounts, ids)) {
      serializedCounts[sid] = Object.fromEntries(inner);
    }
    return {
      states: Object.fromEntries(selectedEntries(this.states, ids)),
      sessionCounts: serializedCounts,
      sessionSpeedStats: Object.fromEntries(selectedEntries(this.sessionSpeedStats, ids)),
      reportedUsed: Object.fromEntries(selectedEntries(this.reportedUsed, ids)),
      checkpointLimits: Object.fromEntries(selectedEntries(this.checkpointLimits, ids)),
      reportedWindowLimits: Object.fromEntries(selectedEntries(this.reportedWindowLimits, ids)),
    };
  }

  flush(all = true): void {
    if (all) this.saveCompactions();
    // Include both edges of the local-calendar 30-day window in the UTC ledger.
    const cutoff = new Date(this.now() - 32 * 86400000).toISOString().slice(0, 13);
    for (const [key, record] of this.ledger) {
      if (record.hourKey < cutoff) this.ledger.delete(key);
    }
    this.writeLedger('token-hours.json', [...this.ledger.values()]);

    if (all || this.reviewer.dirty) this.reviewer.flush(cutoff);
    if (all || this.translator.dirty) this.translator.flush(cutoff);

    const generation = randomUUID();
    this.writeLedger('session-telemetry.json', {
      generation, profiles: this.profileData('sessions', this.serializeSessions()),
      learnedModelLimits: Object.fromEntries(this.learnedModelLimits),
      legacyProfileId: this.legacyProfileId,
    });
    this.generation = generation;
    if (this.checkpointOnDisk) this.options.store.write(this.streamingFile, null);
    this.checkpointOnDisk = false;
    this.pendingSessions.clear();
    this.pendingHours.clear();
  }

  dispose(persist = true): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (persist) this.flush();
  }
}

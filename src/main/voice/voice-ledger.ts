import { createHash, randomUUID } from 'node:crypto';
import type { VoiceOwner } from '../../shared/session-owner';
import type {
  ExternalVoiceProviderConfig, VoiceCostBasis, VoiceExternalTelemetrySnapshot, VoiceProviderUsageBreakdown,
  VoiceRangeUsageSummary, VoiceUsageOutcome,
} from '../../shared/voice-contract';
import type { ClientStore } from '../storage/client-store';

interface Attempt {
  requestId: string;
  owner: VoiceOwner;
  scope: 'connection-test' | 'dictation';
  startedAt: number;
  provider: ExternalVoiceProviderConfig['provider'];
  host: string;
  model: string;
  durationMs: number;
  rate?: number;
  outcome?: VoiceUsageOutcome;
  costBasis?: VoiceCostBasis;
  costUsd?: number;
}
interface Saved {
  attempts?: Attempt[];
  bases?: Record<string, Partial<Record<VoiceCostBasis, number>>>;
  unknownDays?: Record<string, number>;
  providers: VoiceProviderUsageBreakdown[];
  days: Record<string, VoiceRangeUsageSummary>;
}
const empty = (): VoiceRangeUsageSummary => ({ callCount: 0, totalDurationMs: 0, knownCostUsd: 0, hasUnknownCost: false });
function add(total: VoiceRangeUsageSummary, row: VoiceRangeUsageSummary): void {
  total.callCount += row.callCount;
  total.totalDurationMs += row.totalDurationMs;
  total.knownCostUsd += row.knownCostUsd;
  total.hasUnknownCost ||= row.hasUnknownCost;
}
function dayKey(date: Date, offset = 0): string {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + offset)).toISOString().slice(0, 10);
}
function aggregateCostBasis(hasUnknown: boolean, hasEstimate: boolean): VoiceCostBasis {
  if (hasUnknown) return 'unknown';
  return hasEstimate ? 'estimated-per-minute' : 'provider-direct';
}
class VoiceBook {
  private data: Saved;
  constructor(private store: ClientStore, private now: () => number, private changed: () => void, private file: string) {
    const saved = store.read<Saved>(this.file, { days: {}, providers: [] });
    this.data = saved?.days && Array.isArray(saved.providers) ? saved : { days: {}, providers: [] };
    // Requests interrupted by a process exit retain their original attribution and duration.
    for (const attempt of this.data.attempts ?? []) if (!attempt.outcome) this.complete(attempt.requestId, 'aborted', undefined, false);
  }
  begin(config: ExternalVoiceProviderConfig, durationMs: number, owner: VoiceOwner, scope: Attempt['scope']): string {
    const requestId = randomUUID();
    const attempt: Attempt = { requestId, owner: { ...owner }, scope, startedAt: this.now(), durationMs,
      provider: config.provider, host: new URL(config.endpoint).host, model: config.model, rate: config.ratePerMinuteUsd };
    const next = { ...this.data, attempts: [...(this.data.attempts ?? []), attempt] };
    this.store.write(this.file, next);
    this.data = next;
    this.changed();
    return requestId;
  }
  complete(requestId: string, outcome: VoiceUsageOutcome, direct?: number, notify = true): void {
    const data = structuredClone(this.data);
    const attempt = data.attempts?.find(row => row.requestId === requestId);
    if (!attempt || (attempt.outcome && (direct === undefined || attempt.costBasis === 'provider-direct'))) return;
    const previousBasis = attempt.costBasis;
    const previousCost = attempt.costUsd ?? 0;
    const { durationMs, host, provider, model, rate } = attempt;
    const date = new Date(attempt.startedAt);
    const key = JSON.stringify([provider, host, model]);
    const estimated = rate === undefined ? undefined : rate * durationMs / 60_000;
    const cost = direct ?? estimated;
    const basis: VoiceCostBasis = direct !== undefined ? 'provider-direct' : estimated !== undefined ? 'estimated-per-minute' : 'unknown';
    Object.assign(attempt, { outcome: attempt.outcome ?? outcome, costBasis: basis, costUsd: cost });
    const settled = data.attempts!.filter(row => row.outcome);
    if (settled.length > 256) data.attempts = [...data.attempts!.filter(row => !row.outcome), ...settled.slice(-256)];
    const sample = { callCount: 1, totalDurationMs: durationMs, knownCostUsd: cost ?? 0, hasUnknownCost: cost === undefined };
    let row = data.providers.find(item => item.key === key);
    if (!row) {
      row = { ...empty(), key, endpointHost: host, provider, modelId: model, completedCount: 0,
        errorCount: 0, costBasis: basis };
      data.providers.push(row);
    }
    const day = dayKey(date);
    const daily = data.days[day] ??= empty();
    const counts = (data.bases ??= {})[key] ??= {};
    const unknownDays = data.unknownDays ??= {};
    counts[basis] = (counts[basis] ?? 0) + 1;
    if (previousBasis) {
      counts[previousBasis] = Math.max(0, (counts[previousBasis] ?? 0) - 1);
      row.knownCostUsd += (cost ?? 0) - previousCost;
      daily.knownCostUsd += (cost ?? 0) - previousCost;
      if (previousBasis === 'unknown') unknownDays[day] = Math.max(0, (unknownDays[day] ?? 0) - 1);
    } else {
      add(row, sample);
      add(daily, sample);
      if (outcome === 'completed') row.completedCount++;
      if (outcome === 'error') row.errorCount++;
      if (basis === 'unknown') unknownDays[day] = (unknownDays[day] ?? 0) + 1;
    }
    row.hasUnknownCost = (counts.unknown ?? 0) > 0;
    daily.hasUnknownCost = (unknownDays[day] ?? 0) > 0;
    row.costBasis = aggregateCostBasis(row.hasUnknownCost, (counts['estimated-per-minute'] ?? 0) > 0);
    for (const k of Object.keys(data.days)) if (k < dayKey(new Date(this.now()), -29)) { delete data.days[k]; delete unknownDays[k]; }
    this.store.write(this.file, data);
    this.data = data;
    if (notify) this.changed();
  }
  snapshot(): VoiceExternalTelemetrySnapshot {
    const date = new Date(this.now());
    const byRange = { today: empty(), '7d': empty(), '30d': empty() };
    for (const [key, day] of Object.entries(this.data.days)) {
      if (key > dayKey(date)) continue;
      if (key === dayKey(date)) add(byRange.today, day);
      if (key >= dayKey(date, -6)) add(byRange['7d'], day);
      if (key >= dayKey(date, -29)) add(byRange['30d'], day);
    }
    const providers = structuredClone(this.data.providers);
    for (const row of providers) {
      const counts = this.data.bases?.[row.key];
      if (counts) row.costBasis = aggregateCostBasis((counts.unknown ?? 0) > 0, (counts['estimated-per-minute'] ?? 0) > 0);
    }
    for (const attempt of this.data.attempts ?? []) {
      if (attempt.outcome) continue;
      const { host, provider, model, rate, durationMs } = attempt;
      const key = JSON.stringify([provider, host, model]);
      const basis = rate === undefined ? 'unknown' : 'estimated-per-minute';
      const sample = { callCount: 1, totalDurationMs: durationMs, knownCostUsd: (rate ?? 0) * durationMs / 60_000, hasUnknownCost: rate === undefined };
      let row = providers.find(p => p.key === key);
      if (!row) {
        row = { ...empty(), key, endpointHost: host, provider, modelId: model, completedCount: 0, errorCount: 0, costBasis: basis };
        providers.push(row);
      } else {
        row.costBasis = aggregateCostBasis(row.hasUnknownCost || sample.hasUnknownCost,
          row.costBasis === 'estimated-per-minute' || basis === 'estimated-per-minute');
      }
      add(row, sample);
      const day = dayKey(new Date(attempt.startedAt));
      if (day > dayKey(date)) continue;
      if (day === dayKey(date)) add(byRange.today, sample);
      if (day >= dayKey(date, -6)) add(byRange['7d'], sample);
      if (day >= dayKey(date, -29)) add(byRange['30d'], sample);
    }
    const totals = empty();
    let completedCalls = 0, errorCalls = 0;
    for (const row of providers) {
      add(totals, row);
      completedCalls += row.completedCount;
      errorCalls += row.errorCount;
    }
    return { cumulativeCalls: totals.callCount, completedCalls, errorCalls, totalDurationMs: totals.totalDurationMs,
      knownCostUsd: totals.knownCostUsd, hasUnknownCost: totals.hasUnknownCost, byRange,
      providers, updatedAt: date.toISOString() };
  }
}

interface Receipt { requestId: string; profileId: string }
export class VoiceLedger {
  private books = new Map<string, VoiceBook>();
  constructor(private store: ClientStore, private now: () => number, private changed: () => void, private profile: () => string) {}
  private book(profileId: string): VoiceBook {
    let book = this.books.get(profileId);
    if (!book) {
      const file = 'external-voice-' + createHash('sha256').update(profileId).digest('hex') + '.json';
      book = new VoiceBook(this.store, this.now, () => { if (this.profile() === profileId) this.changed(); }, file);
      this.books.set(profileId, book);
    }
    return book;
  }
  begin(c: ExternalVoiceProviderConfig, durationMs: number, owner: VoiceOwner, scope: Attempt['scope']): Receipt {
    return { profileId: owner.profileId, requestId: this.book(owner.profileId).begin(c, durationMs, owner, scope) };
  }
  complete(receipt: Receipt, outcome: VoiceUsageOutcome, direct?: number): void {
    this.book(receipt.profileId).complete(receipt.requestId, outcome, direct);
  }
  snapshot(): VoiceExternalTelemetrySnapshot { return this.book(this.profile()).snapshot(); }
}

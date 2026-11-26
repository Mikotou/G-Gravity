import { calculateTokenCost, resolveModelRateCard } from '../../shared/telemetry-contract';
import type {
  ExternalReviewerProviderId, ExternalReviewerUsageRecordInput, ExternalTranslatorUsageRecordInput,
  FourDimTokenCounts, ModelRateCard, TokenCostSummary,
} from '../../shared/telemetry-contract';
import { calendarFor, ledgerHour } from './calendar';
import { add, zero, selectedEntries, type SavedExternalSessions } from './telemetry-data';
import { summarizeCalendar, TelemetryAggregator, sumCosts } from './telemetry-aggregator';
interface ExternalBaseBucket extends FourDimTokenCounts {
  provider: ExternalReviewerProviderId;
  endpointHost: string;
  modelId: string;
  callCount: number;
  errorCount: number;
  directCostUsd: number;
  hasDirectCost: boolean;
  // Tokens belonging to calls without provider pricing. Legacy buckets did not separate them.
  estimatedTokens: FourDimTokenCounts;
  totalLatencyMs: number;
}
function extractSafeEndpointHost(endpoint: string, provider: ExternalReviewerProviderId): string {
  try {
    const parsed = new URL(endpoint);
    return parsed.host || parsed.hostname || provider;
  } catch {
    return provider;
  }
}

function isValidExtProvider(val: unknown): val is ExternalReviewerProviderId {
  return val === 'gemini-api-key' || val === 'openai-compatible' || val === 'local-ollama';
}

const safeNonNegInt = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;

const safeNonNegFloat = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

function safeCounts(value?: Partial<Record<keyof FourDimTokenCounts, unknown>>): FourDimTokenCounts {
  return {
    inputTokens: safeNonNegInt(value?.inputTokens), cachedInputTokens: safeNonNegInt(value?.cachedInputTokens),
    outputTokens: safeNonNegInt(value?.outputTokens), thinkingTokens: safeNonNegInt(value?.thinkingTokens),
  };
}

function sanitizeBaseExternalBucket(raw: unknown): ExternalBaseBucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidExtProvider(r.provider) || typeof r.modelId !== 'string' || !r.modelId.trim()) return null;
  const estimate = r.estimatedTokens && typeof r.estimatedTokens === 'object'
    ? r.estimatedTokens as Partial<FourDimTokenCounts>
    : r.hasDirectCost ? {} : r;
  return {
    provider: r.provider,
    endpointHost: typeof r.endpointHost === 'string' && r.endpointHost.trim() ? r.endpointHost.trim() : r.provider,
    modelId: r.modelId.trim(),
    inputTokens: safeNonNegInt(r.inputTokens),
    cachedInputTokens: safeNonNegInt(r.cachedInputTokens),
    outputTokens: safeNonNegInt(r.outputTokens),
    thinkingTokens: safeNonNegInt(r.thinkingTokens),
    callCount: safeNonNegInt(r.callCount),
    errorCount: safeNonNegInt(r.errorCount),
    directCostUsd: safeNonNegFloat(r.directCostUsd),
    hasDirectCost: Boolean(r.hasDirectCost),
    estimatedTokens: safeCounts(estimate),
    totalLatencyMs: safeNonNegInt(r.totalLatencyMs),
  };
}

interface LedgerHost {
  now(): number;
  rates(): ModelRateCard[];
  read<T>(name: string, fallback: T): T;
  write(name: string, data: unknown): void;
  loadProfiles<T extends object>(key: string, legacy: T, profiles?: Record<string, T>): T;
  saveProfiles(key: string, data: object): Record<string, unknown>;
  inactive(key: string): Record<string, unknown>;
  currentProfile(): string;
  hourSessionId(id: string, profileId: string): string;
}
type Bucket<K extends string> = ExternalBaseBucket & Record<K, number>;
type Hour<K extends string> = Bucket<K> & { hourKey: string; sessions: string[] };
type Session<K extends string> = { buckets: Map<string, Bucket<K>>; updatedAt: string };

export class ExternalServiceLedger<K extends string> {
  private hours = new Map<string, Hour<K>>();
  private cumulative = new Map<string, Bucket<K>>();
  private sessions = new Map<string, Session<K>>();
  private updatedAt = '';
  dirty = false;
  private cache = new TelemetryAggregator<ReturnType<ExternalServiceLedger<K>['calendar']>>();
  constructor(private name: 'reviewer' | 'translator', private outcomes: Record<K, string>, private host: LedgerHost) {}

  private counters(value: (key: K) => number): Record<K, number> {
    return Object.fromEntries((Object.keys(this.outcomes) as K[]).map(key => [key, value(key)])) as Record<K, number>;
  }

  private sanitize(raw: unknown): Bucket<K> | null {
    const base = sanitizeBaseExternalBucket(raw);
    return base && { ...base, ...this.counters(key => safeNonNegInt((raw as Record<string, unknown>)[key])) };
  }

  private merge(target: Bucket<K>, src: Bucket<K>): Bucket<K> {
    return { ...target, ...add(target, src), ...this.counters(key => target[key] + src[key]),
      callCount: target.callCount + src.callCount, errorCount: target.errorCount + src.errorCount,
      directCostUsd: target.directCostUsd + src.directCostUsd, hasDirectCost: target.hasDirectCost || src.hasDirectCost,
      estimatedTokens: add(target.estimatedTokens, src.estimatedTokens), totalLatencyMs: target.totalLatencyMs + src.totalLatencyMs };
  }
  load(): void {
    const savedExtHours = this.host.read<Hour<K>[]>('external-' + this.name + '-hours.json', []);
    for (const rawRec of Array.isArray(savedExtHours) ? savedExtHours : []) {
      if (!rawRec || typeof rawRec.hourKey !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}(?::[0-5]\d)?$/.test(rawRec.hourKey)) continue;
      const clean = this.sanitize(rawRec);
      if (!clean) continue;
      const sessions = Array.isArray(rawRec.sessions)
        ? rawRec.sessions.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      const bKey = `${clean.provider}\0${clean.endpointHost}\0${clean.modelId}`;
      this.hours.set(`${rawRec.hourKey}\0${bKey}`, { ...clean, hourKey: rawRec.hourKey, sessions });
    }

    const savedExtTotals = this.host.read<{
      cumulative?: Record<string, Bucket<K>>;
      sessions?: SavedExternalSessions<Bucket<K>>;
      profiles?: Record<string, SavedExternalSessions<Bucket<K>>>;
      updatedAt?: string;
    }>('external-' + this.name + '-totals.json', {});
    if (savedExtTotals?.cumulative && typeof savedExtTotals.cumulative === 'object') {
      for (const rawBucket of Object.values(savedExtTotals.cumulative)) {
        const clean = this.sanitize(rawBucket);
        if (!clean) continue;
        const bKey = `${clean.provider}\0${clean.endpointHost}\0${clean.modelId}`;
        const prev = this.cumulative.get(bKey);
        this.cumulative.set(bKey, prev ? this.merge(prev, clean) : clean);
      }
    }
    const reviewerSessions = this.host.loadProfiles(this.name + 's', savedExtTotals?.sessions || {}, savedExtTotals?.profiles);
    if (reviewerSessions) {
      for (const [sid, sessData] of Object.entries(reviewerSessions)) {
        if (!sessData || typeof sessData !== 'object' || !sessData.buckets) continue;
        const inner = new Map<string, Bucket<K>>();
        for (const rawBucket of Object.values(sessData.buckets)) {
          const clean = this.sanitize(rawBucket);
          if (!clean) continue;
          const bKey = `${clean.provider}\0${clean.endpointHost}\0${clean.modelId}`;
          const prev = inner.get(bKey);
          inner.set(bKey, prev ? this.merge(prev, clean) : clean);
        }
        if (inner.size > 0) {
          this.sessions.set(sid, {
            buckets: inner,
            updatedAt: typeof sessData.updatedAt === 'string' ? sessData.updatedAt : new Date(this.host.now()).toISOString(),
          });
        }
      }
    }
    if (typeof savedExtTotals?.updatedAt === 'string') {
      this.updatedAt = savedExtTotals.updatedAt;
    }

  }

  record(input: ExternalReviewerUsageRecordInput | ExternalTranslatorUsageRecordInput, profileId = this.host.currentProfile()): boolean {
    if (!input || !isValidExtProvider(input.provider) || !input.modelId?.trim()) return false;
    const ts = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) ? input.timestamp : this.host.now();
    const hourKey = ledgerHour(ts);
    const endpointHost = extractSafeEndpointHost(input.endpoint || '', input.provider);
    const modelId = input.modelId.trim();
    const bKey = `${input.provider}\0${endpointHost}\0${modelId}`;

    const counts = safeCounts(input.usage);
    const directCost =
      input.provider === 'local-ollama'
        ? 0
        : typeof input.usage?.directCostUsd === 'number' && Number.isFinite(input.usage.directCostUsd) && input.usage.directCostUsd >= 0
          ? input.usage.directCostUsd
          : undefined;

    const delta: Bucket<K> = {
      provider: input.provider,
      endpointHost,
      modelId,
      ...counts,
      callCount: 1,
      ...this.counters(key => Number(input.outcome === this.outcomes[key])),
      errorCount: input.outcome === 'error' ? 1 : 0,
      directCostUsd: directCost ?? 0,
      hasDirectCost: directCost !== undefined,
      estimatedTokens: directCost !== undefined ? zero() : counts,
      totalLatencyMs: safeNonNegInt(input.latencyMs),
    };

    // 1. 永久客户端累计（不因 30 天滚动窗口裁剪丢失）
    const prevCum = this.cumulative.get(bKey);
    this.cumulative.set(bKey, prevCum ? this.merge(prevCum, delta) : { ...delta });

    // 2. 当前会话明细
    if (input.sessionId && profileId !== this.host.currentProfile()) {
      const inactive = this.host.inactive(this.name + 's');
      const sessions = (inactive[profileId] ??= {}) as SavedExternalSessions<Bucket<K>>;
      const session = Object.hasOwn(sessions, input.sessionId) ? sessions[input.sessionId] : {};
      Object.defineProperty(sessions, input.sessionId, { value: session, enumerable: true, configurable: true, writable: true });
      const buckets = session.buckets ??= {};
      const prior = this.sanitize(buckets[bKey]);
      buckets[bKey] = prior ? this.merge(prior, delta) : { ...delta };
      session.updatedAt = new Date(ts).toISOString();
    } else if (input.sessionId) {
      const sessStore = this.sessions.get(input.sessionId) || {
        buckets: new Map<string, Bucket<K>>(),
        updatedAt: new Date(ts).toISOString(),
      };
      const prevSess = sessStore.buckets.get(bKey);
      sessStore.buckets.set(bKey, prevSess ? this.merge(prevSess, delta) : { ...delta });
      sessStore.updatedAt = new Date(ts).toISOString();
      this.sessions.set(input.sessionId, sessStore);
    }

    // 3. 小时级分布账本（驱动 24h / 7d / 30d 热力图与时段费用）
    const hKey = `${hourKey}\0${bKey}`;
    const prevHour = this.hours.get(hKey);
    if (prevHour) {
      const merged = this.merge(prevHour, delta);
      const ledgerId = this.host.hourSessionId(input.sessionId, profileId);
      const sessions = prevHour.sessions.includes(ledgerId) || !input.sessionId
        ? prevHour.sessions
        : [...prevHour.sessions, ledgerId];
      this.hours.set(hKey, { ...merged, hourKey, sessions });
    } else {
      this.hours.set(hKey, {
        ...delta,
        hourKey,
        sessions: input.sessionId ? [this.host.hourSessionId(input.sessionId, profileId)] : [],
      });
    }

    this.updatedAt = new Date(ts).toISOString();
    this.dirty = true;
    this.cache.invalidate();
    return true;
  }

  remove(id: string): void { this.sessions.delete(id); }

  flush(cutoff: string): void {
    for (const [key, record] of this.hours) {
      if (record.hourKey < cutoff) this.hours.delete(key);
    }
    this.host.write('external-' + this.name + '-hours.json', [...this.hours.values()]);

    const serializedExtSessions: Record<string, { buckets: Record<string, Bucket<K>>; updatedAt: string }> = {};
    for (const [sid, sessStore] of this.sessions) {
      serializedExtSessions[sid] = {
        buckets: Object.fromEntries(sessStore.buckets),
        updatedAt: sessStore.updatedAt,
      };
    }
    this.host.write('external-' + this.name + '-totals.json', {
      cumulative: Object.fromEntries(this.cumulative),
      profiles: this.host.saveProfiles(this.name + 's', serializedExtSessions),
      updatedAt: this.updatedAt || new Date(this.host.now()).toISOString(),
    });

    this.dirty = false;
  }
  private externalBucketCost(bucket: ExternalBaseBucket): TokenCostSummary {
    if (bucket.provider === 'local-ollama') {
      return calculateTokenCost(bucket, {
        inputPerMillionUsd: 0,
        cachedInputPerMillionUsd: 0,
        outputPerMillionUsd: 0,
        thinkingPerMillionUsd: 0,
      });
    }
    const rate = resolveModelRateCard(bucket.modelId, this.host.rates());
    const computed = calculateTokenCost(bucket, rate);
    if (!bucket.hasDirectCost) return computed;
    const estimated = calculateTokenCost(bucket.estimatedTokens, rate);
    const reportedWeight = computed.totalCostUsd - estimated.totalCostUsd;
    const ratio = reportedWeight > 0 ? bucket.directCostUsd / reportedWeight : 0;
    for (const field of ['inputCostUsd', 'cachedInputCostUsd', 'outputCostUsd', 'thinkingCostUsd'] as const) {
      computed[field] = estimated[field] + (computed[field] - estimated[field]) * ratio;
    }
    if (reportedWeight <= 0) computed.inputCostUsd += bucket.directCostUsd;
    computed.totalCostUsd = estimated.totalCostUsd + bucket.directCostUsd;
    return computed;
  }


  private breakdown(buckets: Iterable<Bucket<K>>) {
    const merged = new Map<string, Bucket<K>>();
    for (const bucket of buckets) {
      const key = [bucket.provider, bucket.endpointHost, bucket.modelId].join('\0');
      const previous = merged.get(key);
      merged.set(key, previous ? this.merge(previous, bucket) : bucket);
    }
    const outcomes = this.counters(() => 0);
    let callCount = 0, errorCount = 0, totalLatencyMs = 0;
    const items = [...merged.values()].map(bucket => {
      callCount += bucket.callCount;
      errorCount += bucket.errorCount;
      totalLatencyMs += bucket.totalLatencyMs;
      const counters = this.counters(key => { outcomes[key] += bucket[key]; return bucket[key]; });
      const rate = resolveModelRateCard(bucket.modelId, this.host.rates());
      return { key: [bucket.provider, bucket.endpointHost, bucket.modelId].join(':'), provider: bucket.provider,
        endpointHost: bucket.endpointHost, modelId: bucket.modelId, displayName: rate.modelId === 'default' && bucket.modelId !== 'default' ? bucket.modelId : rate.displayName,
        ...this.externalBucketCost(bucket), ...counters, callCount: bucket.callCount, errorCount: bucket.errorCount, shareRatio: 0 };
    });
    const cost = sumCosts(items);
    for (const item of items) item.shareRatio = cost.totalCostUsd > 0 ? item.totalCostUsd / cost.totalCostUsd
      : cost.totalTokens > 0 ? item.totalTokens / cost.totalTokens : callCount ? item.callCount / callCount : 0;
    items.sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens || b.callCount - a.callCount);
    return { total: { ...cost, ...outcomes, callCount, errorCount }, totalLatencyMs, items };
  }

  private calendar(calendar: ReturnType<typeof calendarFor>) {
    const { hourly24h, calendar30d, matrix7d, costByRange, breakdownByRange } = summarizeCalendar(this.hours.values(), calendar, rows => this.breakdown(rows));
    const { total, items } = this.breakdown(this.cumulative.values());
    const providerCount = new Set(items.map(item => item.provider + ':' + item.endpointHost)).size;
    const tokens = (row: TokenCostSummary) => ({ inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens, thinkingTokens: row.thinkingTokens, totalTokens: row.totalTokens, costUsd: row.totalCostUsd });
    return {
      hourly24h: hourly24h.map(row => ({ hourKey: row.hourKey, hourLabel: row.hourLabel, ...tokens(row) })),
      calendar30d: calendar30d.map(row => ({ date: row.date, sessionCount: row.sessionCount, intensity: row.intensity, ...tokens(row) })),
      matrix7d, costByRange, providerBreakdownByRange: breakdownByRange,
      cumulativeAllTime: { ...total, providerCount }, cumulativeProviders: items,
    };
  }

  private sessionSummary(id: string, session: Session<K>) {
    const { total, items, totalLatencyMs } = this.breakdown(session.buckets.values());
    return { ...total, sessionId: id, providers: items, updatedAt: session.updatedAt,
      avgLatencyMs: total.callCount ? Math.round(totalLatencyMs / total.callCount) : 0 };
  }

  snapshot(ids?: ReadonlySet<string>) {
    const now = this.host.now();
    const charts = this.cache.get(now, this.host.rates(), calendar => this.calendar(calendar));
    const bySession = Object.fromEntries([...selectedEntries(this.sessions, ids)].map(([id, session]) => [id, this.sessionSummary(id, session)]));
    return { ...structuredClone(charts), bySession, updatedAt: this.updatedAt || new Date(now).toISOString() };
  }
}

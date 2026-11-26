import type {
  ContextCompactionRecord, ContextTokenBreakdown, FourDimTokenCounts, ModelRateCard,
  SessionContextTelemetry,
} from '../../shared/telemetry-contract';
import { mergeUsage } from './acp-usage';
import { ClientStore } from '../storage/client-store';
export function estimateTokens(text: string): number {
  return Math.ceil(tokenUnits(text) / 4);
}

export function tokenUnits(text: string): number {
  let units = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x3400 && code <= 0x9fff) units += 3;
  }
  return units;
}

export function toolTextTokens(text: string): number {
  // The inspector may receive its JSON preview already truncated inside an encoded blob.
  const visible = text.replace(/"(?:data|blob|dataBase64)"\s*:\s*"[A-Za-z0-9+/=]{24,}/gi, '')
    .replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+/gi, '');
  return estimateTokens(visible);
}

export const KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'thinkingTokens'] as const;
export const zero = (): FourDimTokenCounts => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
});

export function add(a: FourDimTokenCounts, b: FourDimTokenCounts): FourDimTokenCounts {
  return { inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens, thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    unclassifiedTokens: (a.unclassifiedTokens ?? 0) + (b.unclassifiedTokens ?? 0) };
}

export const intensity = (n: number): 0 | 1 | 2 | 3 | 4 =>
  n === 0 ? 0 : n < 1000 ? 1 : n < 10000 ? 2 : n < 100000 ? 3 : 4;

export interface HourRecord extends FourDimTokenCounts {
  hourKey: string;
  modelId: string;
  sessions: string[];
}

export interface Turn {
  counts: FourDimTokenCounts;
  reportedUsage: ReturnType<typeof mergeUsage>;
  reportedPromptTotal?: number;
  modelId: string;
  hourKey: string;
  startedAt: number;
  firstChunkAt?: number;
  lastChunkAt?: number;
  streamedTokens: number;
  /** Only locally estimated reply tokens can be removed from billed output. */
  unreportedReplyTokens?: number;
  /** Estimates added after the last official total were not included in that total. */
  replyTokensAfterTotal?: number;
  toolArgumentTokens: number;
  units: Partial<Record<keyof ContextTokenBreakdown, number>>;
  tools: Map<string, { args: number; result: number }>;
  original: SessionContextTelemetry;
  existingHourSession: boolean;
  existingModel: boolean;
}

export interface TelemetryOptions {
  store: ClientStore;
  profileId?: string;
  now?: () => number;
  maxContextTokens?: number;
  rateCards?: ModelRateCard[];
}

export type SavedExternalSessions<T> = Record<string, { buckets?: Record<string, T>; updatedAt?: string }>;
export type SavedCompactions = Record<string, ContextCompactionRecord[]>;
export interface SavedSessionTelemetry {
  states?: Record<string, SessionContextTelemetry>;
  sessionCounts?: Record<string, Record<string, FourDimTokenCounts>>;
  sessionSpeedStats?: Record<string, { totalGeneratedTokens: number; totalDurationSec: number; completedTurns: number }>;
  reportedUsed?: Record<string, number>;
  checkpointLimits?: Record<string, number>;
  reportedWindowLimits?: Record<string, number>;
  learnedModelLimits?: Record<string, number>;
}
export interface StreamingCheckpoint {
  generation: string;
  ids: string[];
  sessions: SavedSessionTelemetry;
  hours: HourRecord[];
  learnedModelLimits: Record<string, number>;
}
export const SESSION_FIELDS = ['states', 'sessionCounts', 'sessionSpeedStats', 'reportedUsed', 'checkpointLimits', 'reportedWindowLimits'] as const;

export function* selectedEntries<T>(map: Map<string, T>, ids?: ReadonlySet<string>): Iterable<[string, T]> {
  if (!ids) { yield* map; return; }
  for (const id of ids) {
    const value = map.get(id);
    if (value !== undefined) yield [id, value];
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function pressureLevel(ratio: number): SessionContextTelemetry['pressureLevel'] {
  return ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warning' : ratio >= 0.6 ? 'moderate' : 'healthy';
}

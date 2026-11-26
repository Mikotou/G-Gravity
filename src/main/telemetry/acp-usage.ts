import type { AcpTokenUsage } from '../../shared/acp-protocol';
import type { FourDimTokenCounts, SessionContextTelemetry } from '../../shared/telemetry-contract';

type ReportedUsage = Partial<Record<keyof AcpTokenUsage, number>>;
type CacheUsage = NonNullable<SessionContextTelemetry['reportedCacheUsage']>;

const fields = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedInputTokens', 'cachedWriteTokens', 'totalTokens'] as const;
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Notifications and the final result can carry complementary fields for the same turn. */
export function mergeUsage(previous: ReportedUsage, update: AcpTokenUsage): ReportedUsage {
  const merged = { ...previous };
  const incoming: ReportedUsage = {};
  for (const key of fields) {
    const value = update[key];
    if (validCount(value)) incoming[key] = value;
  }
  if (!Object.keys(incoming).length) return previous;
  const read = incoming.cachedReadTokens ?? incoming.cachedInputTokens;
  const previousRead = previous.cachedReadTokens ?? previous.cachedInputTokens;
  const changed = (key: keyof ReportedUsage) =>
    incoming[key] !== undefined && previous[key] !== undefined && incoming[key] !== previous[key];
  const newTotalWithoutInput = changed('totalTokens') && incoming.inputTokens === undefined;
  if (newTotalWithoutInput) delete merged.inputTokens;
  const previousConflict = previous.cachedReadTokens !== undefined && previous.cachedInputTokens !== undefined &&
    previous.cachedReadTokens !== previous.cachedInputTokens;
  if (newTotalWithoutInput || changed('inputTokens') || (read !== undefined && (read !== previousRead || previousConflict))) {
    // An earlier read count cannot certify the hit rate for a different input snapshot.
    delete merged.cachedReadTokens;
    delete merged.cachedInputTokens;
  }
  if (incoming.totalTokens === undefined && (changed('inputTokens') || changed('outputTokens') || changed('thoughtTokens') ||
      changed('cachedWriteTokens') || (read !== undefined && previousRead !== undefined && read !== previousRead))) {
    delete merged.totalTokens;
  }
  return Object.assign(merged, incoming);
}

export function validCacheUsage(value: CacheUsage | undefined): value is CacheUsage {
  return !!value && validCount(value.cachedReadTokens) &&
    (value.inputTokens === null || (validCount(value.inputTokens) && value.inputTokens >= value.cachedReadTokens));
}

export function combineCacheUsage(previous?: CacheUsage, current?: CacheUsage): CacheUsage | undefined {
  if (!previous || !current) return undefined;
  return {
    cachedReadTokens: previous.cachedReadTokens + current.cachedReadTokens,
    inputTokens: previous.inputTokens === null || current.inputTokens === null ? null : previous.inputTokens + current.inputTokens,
  };
}

export function cacheHitRate(usage?: CacheUsage): number | undefined {
  if (!usage || usage.inputTokens === 0) return undefined;
  if (usage.cachedReadTokens === 0) return 0;
  return usage.inputTokens === null ? undefined : usage.cachedReadTokens / usage.inputTokens;
}

/** ACP implementations can include cache reads/writes in inputTokens or report them separately. */
function possibleInputTotals(input: number, read: number, write: number): number[] {
  const totals = new Set<number>();
  for (const separateRead of new Set([0, read])) {
    for (const separateWrite of new Set([0, write])) {
      if (input >= read - separateRead + write - separateWrite) totals.add(input + separateRead + separateWrite);
    }
  }
  return [...totals].sort((a, b) => a - b);
}

export function samePromptCounters(a: ReportedUsage, b: ReportedUsage): boolean {
  return a.inputTokens === b.inputTokens && a.cachedWriteTokens === b.cachedWriteTokens &&
    (a.cachedReadTokens ?? a.cachedInputTokens) === (b.cachedReadTokens ?? b.cachedInputTokens);
}

/** Keep the cost ledger disjoint even when only some categories have been reported.
 * The session hit rate uses only an explicit read count and a provable denominator. */
export function reconcileUsage(usage: ReportedUsage, estimated: FourDimTokenCounts, previousPromptTotal?: number): {
  counts: FourDimTokenCounts; cacheUsage?: CacheUsage;
} {
  const { inputTokens: input, outputTokens: output, totalTokens: total } = usage;
  const reportedRead = usage.cachedReadTokens ?? usage.cachedInputTokens;
  const write = usage.cachedWriteTokens ?? 0;
  const minimumInput = possibleInputTotals(input ?? 0, reportedRead ?? 0, write)[0];
  const reportedThought = usage.thoughtTokens ?? 0;
  const minimumOutput = reportedThought > (output ?? 0) ? (output ?? 0) + reportedThought : (output ?? 0);
  if (total !== undefined && minimumInput + minimumOutput > total) {
    // These counters cannot describe the same snapshot. Keep its reported total without charging overlapping categories.
    return { counts: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0, unclassifiedTokens: total } };
  }
  const cached = reportedRead ?? Math.min(estimated.cachedInputTokens, Math.max(0, (input ?? Infinity) - write),
    Math.max(0, (total ?? Infinity) - minimumOutput - write));
  const maxPrompt = (total ?? Infinity) - minimumOutput;
  const inputTotals = input === undefined ? [] : possibleInputTotals(input, cached, write).filter(value => value <= maxPrompt);
  const thought = usage.thoughtTokens ?? Math.min(estimated.thinkingTokens, Math.max(0, (total ?? Infinity) - (inputTotals[0] ?? cached + write)));
  // Output can include reasoning or exclude it. A reported total can disambiguate both conventions.
  const outputTotals = output === undefined ? [] : [output];
  if (output !== undefined && usage.thoughtTokens) {
    if (thought > output) outputTotals.length = 0;
    outputTotals.push(output + thought);
  }
  const matches = inputTotals.filter(prompt => outputTotals.some(generated => prompt + generated === total));
  const possible = matches.length ? matches : inputTotals;
  let measuredInput: number | null = null;
  if (possible.length === 1) measuredInput = possible[0];
  else if (!matches.length) {
    if (previousPromptTotal !== undefined && possible.includes(previousPromptTotal)) measuredInput = previousPromptTotal;
    else if (usage.cachedInputTokens !== undefined && input !== undefined && input >= cached + write) measuredInput = input;
  }
  // With conflicting or incomplete conventions, charge only the input that is unambiguously accounted for.
  const prompt = measuredInput ?? possible[0];
  const generated = matches.length && total !== undefined
    ? total - matches[matches.length - 1] : outputTotals[0];
  const thinking = Math.min(generated ?? Infinity, thought);
  let ordinaryInput = prompt === undefined ? 0 : prompt - cached;
  let ordinaryOutput = generated === undefined ? 0 : generated - thinking;
  let available = Math.max(0, (total ?? Infinity) - cached - thinking - ordinaryInput - ordinaryOutput);
  if (prompt === undefined) {
    ordinaryInput = Math.min(available, Math.max(write, estimated.inputTokens + estimated.cachedInputTokens - cached));
    available -= ordinaryInput;
  }
  if (generated === undefined) {
    ordinaryOutput = Math.min(available, Math.max(0, estimated.outputTokens + estimated.thinkingTokens - thinking));
    available -= ordinaryOutput;
  }
  const conflictingReads = usage.cachedReadTokens !== undefined && usage.cachedInputTokens !== undefined &&
    usage.cachedReadTokens !== usage.cachedInputTokens;
  const classifiedBefore = estimated.inputTokens + estimated.cachedInputTokens + estimated.outputTokens + estimated.thinkingTokens;
  const newlyClassified = Math.max(0, ordinaryInput + cached + ordinaryOutput + thinking - classifiedBefore);
  const unclassified = total === undefined ? Math.max(0, (estimated.unclassifiedTokens ?? 0) - newlyClassified) : available;
  return {
    counts: { inputTokens: ordinaryInput, cachedInputTokens: cached, outputTokens: ordinaryOutput, thinkingTokens: thinking,
      unclassifiedTokens: unclassified },
    cacheUsage: reportedRead === undefined || conflictingReads ? undefined : { cachedReadTokens: reportedRead, inputTokens: measuredInput },
  };
}

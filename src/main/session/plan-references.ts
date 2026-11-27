import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessageItem } from '../../shared/session-contract';

export const planFilename = 'implementation_plan.md';
function asPath(raw: string): string | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return;
  if (!/^file:/i.test(raw)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return;
    const normalized = process.platform === 'win32' && /^\/[a-z]:[\\/]/i.test(raw) ? raw.slice(1) : raw;
    return isAbsolute(normalized) ? normalized : normalized.split(/[?#]/, 1)[0];
  }
  if (raw.replace(/%2e/ig, '.').split(/[\\/]/).includes('..')) return;
  try {
    const url = new URL(raw);
    if (!url.hostname || url.hostname === 'localhost') return fileURLToPath(url);
  } catch { /* Not a local file URL. */ }
}

const planLabel = /(?:^|[^a-z0-9])plan(?:$|[^a-z0-9])|(?:实施|实现|执行|开发|工作)计划|^计划$/i;
function planReference(raw: unknown, label?: unknown): string | undefined {
  if (typeof raw !== 'string') return;
  const path = asPath(raw);
  if (path && (basename(path).toLowerCase() === planFilename || (typeof label === 'string' && planLabel.test(label)))) return path;
}
export function hasPlanText(text: string): boolean {
  return text.toLowerCase().includes(planFilename) || (text.includes('](') && planLabel.test(text));
}

/** A workspace artifact needs a canonical filename or an explicit plan designation in this transcript. */
export function* planReferences(messages: readonly ChatMessageItem[]): Generator<string> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    for (const ref of Array.isArray(m.references) ? m.references : []) {
      const path = ref?.kind === 'file' && planReference(ref.value, ref.label);
      if (path) yield path;
    }
    for (const card of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      if (!card) continue;
      for (const location of Array.isArray(card.locations) ? card.locations : []) {
        const path = planReference(location?.path);
        if (path) yield path;
      }
      const diff = planReference(card.diffPatch?.filePath);
      if (diff) yield diff;
      if (typeof card.argsSummary === 'string' && (card.argsSummary.toLowerCase().includes(planFilename) || /artifact.?type/i.test(card.argsSummary))) {
        try {
          const args = JSON.parse(card.argsSummary);
          const path = planReference(args?.path ?? args?.file_path ?? args?.filePath ?? args?.TargetFile ?? args?.AbsolutePath,
            args?.ArtifactMetadata?.ArtifactType ?? args?.artifactType ?? args?.artifact_type);
          if (path) yield path;
        } catch { /* A truncated argument preview cannot establish a reference. */ }
      }
    }
    if (typeof m.content !== 'string' || !hasPlanText(m.content)) continue;
    const paths = /\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^\s()\r\n]+))\)|\x60([^\x60\r\n]+)\x60|(?:^|[\s(])((?:[^\s<>()\x60\x22'\[\]]*[\\/])?implementation_plan\.md)(?=$|[\s).,;!?#。，；])/gimu;
    for (const match of m.content.matchAll(paths)) {
      const link = match[2] || match[3];
      let raw = link || match[4] || match[5];
      if (link?.includes('%') && !/^file:/i.test(link)) {
        try { raw = decodeURI(link); } catch { continue; }
      }
      const path = planReference(raw, match[1]);
      if (path) yield path;
    }
  }
}

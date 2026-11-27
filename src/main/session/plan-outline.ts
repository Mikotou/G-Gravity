import { createHash } from 'node:crypto';
import type { PlanOutline, PlanOutlineSection } from '../../shared/plan-contract';

/** Parse only structural Markdown. No model, embedded HTML, links or external resources are evaluated. */
export function parsePlanOutline(content: string): PlanOutline {
  const lines = content.split(/\r?\n/);
  const result: PlanOutline = { title: '', sections: [], sectionCount: 0 };
  const seen = new Map<string, number>();
  let section: PlanOutlineSection | undefined;
  let front = lines[0]?.trim() === '---';
  let fence = '';
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (front) { if (index && /^(---|\.\.\.)$/.test(text)) front = false; continue; }
    const marker = /^(\x60{3,}|~{3,})/.exec(text)?.[1];
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length && marker === text) fence = ''; continue; }
    if (marker) { fence = marker; continue; }
    if (!text || text.includes('|') || /^(?:<!--|<[^>]+>|[-_*]{3,}$)/.test(text)) continue;
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(text);
    if (heading) {
      const title = heading[2].slice(0, 200);
      const level = heading[1].length;
      if (level === 1 && !result.title) { result.title = title; section = undefined; continue; }
      const ordinal = (seen.get(title) ?? 0) + 1;
      seen.set(title, ordinal);
      result.sectionCount++;
      section = { heading: title, level, id: 'section-' + createHash('sha256').update(title).digest('hex').slice(0, 16) + '-' + ordinal, summary: '' };
      if (result.sections.length < 32) result.sections.push(section);
      else result.truncated = true;
      continue;
    }
    const bullet = /^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(text);
    const sentence = (bullet?.[1] ?? text).split(/(?<=[。！？])|(?<=[.!?])\s/)[0].slice(0, 240);
    if (!section) result.goal ??= sentence;
    else if (bullet) {
      if ((section.bullets?.length ?? 0) < 3) (section.bullets ??= []).push(sentence);
      if (!section.summary) section.summary = sentence;
    } else if (!section.summary) section.summary = sentence;
  }
  result.title ||= 'Implementation Plan';
  return result;
}

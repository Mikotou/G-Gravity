import type { ChatMessageItem, MessageAnnotation } from '../../shared/session-contract';

const heading = 'User-selected passages and comments:\n';
export function modelMessage(text: string, annotations?: MessageAnnotation[]): string {
  if (!annotations?.length) return text;
  return heading + JSON.stringify({ message: text, annotations });
}

/** Read transcripts written before user text and selected passages were stored separately. */
export function restoreAnnotatedMessage(message: ChatMessageItem): ChatMessageItem {
  if (message.role !== 'user' || message.annotations || !message.content) return message;
  const raw = message.content;
  if (raw.startsWith(heading)) {
    try {
      const saved = JSON.parse(raw.slice(heading.length));
      if (typeof saved.message === 'string' && Array.isArray(saved.annotations) &&
          saved.annotations.every((a: MessageAnnotation) => a && typeof a.excerpt === 'string' &&
            (a.comment === undefined || typeof a.comment === 'string'))) {
        return { ...message, content: saved.message, annotations: saved.annotations };
      }
    } catch { /* An incomplete or user-authored example stays intact. */ }
  }
  const header = /^(【逐处标记批注 \(Notations\)】|\[Multi-spot Selection Notations\])\r?$/m.exec(raw);
  if (!header) return message;
  const before = raw.slice(0, header.index).trim();
  if (before && !before.split(/\r?\n/).every(line => !line || line.startsWith('> '))) return message;
  const annotations: MessageAnnotation[] = before ? before.split(/\r?\n\r?\n/).map(block => ({ excerpt: block.replace(/^> /gm, '') })) : [];
  const rest = raw.slice(header.index + header[0].length).trimStart();
  // Old messages placed an optional message number immediately before the user's draft.
  // Prefer that boundary for passages or comments with blank lines inside them.
  const ending = /(?:（第 \d+ 条消息）| \(message \d+\))(?=\r?\n\r?\n|$)/g;
  const lastOrigin = [...rest.matchAll(ending)].at(-1);
  const boilerplate = /\r?\n\r?\n(?:请严格结合以上逐处标记位置与批注说明进行修改或解答。|Please address each marked passage according to its notation above\.)$/.exec(rest);
  const divider = boilerplate?.index ?? (lastOrigin ? lastOrigin.index! + lastOrigin[0].length : rest.search(/\r?\n\r?\n/));
  const list = divider < 0 ? rest : rest.slice(0, divider);
  let text = divider < 0 ? '' : rest.slice(divider).trim();
  const entries = list.split(/\r?\n(?=\d+\. (?:针对原文「|Regarding "))/);
  for (const [index, entry] of entries.entries()) {
    const match = /^(?:(\d+)\. 针对原文「([\s\S]*?)」：|(\d+)\. Regarding "([\s\S]*?)": )([\s\S]+)$/.exec(entry);
    if (!match || Number(match[1] || match[3]) !== index + 1) return message;
    const origin = /(?:（第 (\d+) 条消息）| \(message (\d+)\))$/.exec(match[5]);
    annotations.push({ excerpt: match[2] || match[4], comment: origin ? match[5].slice(0, origin.index) : match[5],
      messageNumber: origin ? Number(origin[1] || origin[2]) : undefined });
  }
  if (text === '请严格结合以上逐处标记位置与批注说明进行修改或解答。' || text === 'Please address each marked passage according to its notation above.') text = '';
  return { ...message, content: text, annotations };
}

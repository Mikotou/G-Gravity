import { ANNOTATION_WIRE_HEADING, decodeAnnotatedWireContent, ensureAnnotationIds } from '../../shared/message-annotation';
import type { ChatMessageItem, MessageAnnotation } from '../../shared/session-contract';

export function modelMessage(text: string, annotations?: MessageAnnotation[]): string {
  if (!annotations?.length) return text;
  return ANNOTATION_WIRE_HEADING + JSON.stringify({ message: text, annotations });
}

/** Read transcripts written before user text and selected passages were stored separately. */
export function restoreAnnotatedMessage(message: ChatMessageItem): ChatMessageItem {
  if (message.role !== 'user') return message;
  if (message.annotations) return { ...message, annotations: ensureAnnotationIds(message.annotations) };
  return { ...message, ...decodeAnnotatedWireContent(message.content) };
}

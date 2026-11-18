import { randomUUID } from 'node:crypto';
import type { ChatMessageItem } from '../../shared/session-contract';

const types: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp', svg: 'svg+xml' };

export function appendImage(message: Pick<ChatMessageItem, 'attachments'>, payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    for (const item of payload) appendImage(message, item);
    return;
  }
  const block = payload as Record<string, unknown>;
  if (block.type === 'content' || block.type === 'resource' || block.inlineData || block.source) {
    appendImage(message, block.inlineData ?? block.source ?? block.content ?? block.resource);
    return;
  }
  const imageUrl = block.image_url && typeof block.image_url === 'object' ? (block.image_url as Record<string, unknown>).url : block.image_url;
  const uri = [block.uri, block.url, imageUrl].find((value): value is string => typeof value === 'string');
  const encoded = uri && /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(uri);
  const extension = uri?.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  const mime = String(block.mimeType || block.media_type || encoded?.[1] || (extension && types[extension] ? 'image/' + types[extension] : '')).toLowerCase();
  if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mime)) return;
  const bytes = block.data ?? block.blob ?? encoded?.[2];
  const valid = typeof bytes === 'string' && bytes.length <= 28 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(bytes);
  const dataUrl = valid ? 'data:' + mime + ';base64,' + bytes : undefined;
  const location = uri && !/^data:/i.test(uri) ? uri : undefined;
  if (!dataUrl && !location) return;
  const images = message.attachments ||= [];
  if (images.some(image => (dataUrl && image.dataUrl === dataUrl) || (location && image.uri === location))) return;
  images.push({
    id: randomUUID(), mimeType: mime, dataUrl, uri: location,
    sizeBytes: valid ? Buffer.byteLength(bytes, 'base64') : 0,
    name: typeof block.name === 'string' ? block.name : location?.split(/[\\/]/).at(-1) || 'Image ' + (images.length + 1),
  });
}

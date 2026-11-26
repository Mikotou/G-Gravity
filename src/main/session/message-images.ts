import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SendPromptInput } from '../../shared/ipc-channels';
import { isBareExtensionOrFragment, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES } from '../../shared/media-contract';
import { isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import { safeWorkspacePath, within } from '../workspace/workspace-files';
import { resolveLocalTarget, type LocalTargetContext } from '../services/local-media-inspector';
import { readBoundedLocalFile } from '../workspace/local-path-safety';
import type { ChatMessageItem } from '../../shared/session-contract';

const types: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp', svg: 'svg+xml', ico: 'x-icon' };
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
type Attachment = NonNullable<SendPromptInput['attachments']>[number];

function attachmentSize(item: Attachment): number {
  if (!item || typeof item.name !== 'string' || typeof item.mimeType !== 'string' ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(item.mimeType) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 ||
      (item.uri !== undefined && typeof item.uri !== 'string') ||
      (item.textContent !== undefined && (typeof item.textContent !== 'string' || item.textContent.length > 8 * 1024 * 1024)) ||
      (item.dataBase64 !== undefined && (typeof item.dataBase64 !== 'string' || item.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)))) throw new Error('附件大小或格式无效');
  return Math.max(item.sizeBytes, Buffer.byteLength(item.textContent || '') + Buffer.byteLength(item.dataBase64 || '', 'base64'));
}

export function validateAttachments(items: SendPromptInput['attachments']): number {
  if (items === undefined) return 0;
  if (!Array.isArray(items) || items.length > MAX_MESSAGE_ATTACHMENTS) throw new Error('每条消息最多支持 20 个附件');
  let total = 0;
  for (const item of items) {
    const size = attachmentSize(item);
    total += size;
    if (size > MAX_ATTACHMENT_BYTES || total > MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES) throw new Error('附件超过大小限制');
  }
  return total;
}

export async function prepareAttachments(items: SendPromptInput['attachments'], cwd: string): Promise<Attachment[]> {
  let total = validateAttachments(items);
  const result: Attachment[] = [];
  for (const item of items || []) {
    if (!item.uri || item.textContent !== undefined || item.dataBase64 !== undefined) {
      result.push({ ...item, sizeBytes: attachmentSize(item) });
      continue;
    }
    const uri = new URL(item.uri);
    if (uri.protocol !== 'file:' || uri.hostname && uri.hostname !== 'localhost') throw new Error('附件 URI 只支持当前工作区内的本地文件');
    const candidate = fileURLToPath(uri);
    if (!isAbsolute(cwd) || !safeWorkspacePath(cwd) || !safeWorkspacePath(candidate)) throw new Error('附件超出工作区或涉及敏感文件');
    const root = await realpath(cwd), actual = await realpath(candidate);
    if (!within(root, actual) || !safeWorkspacePath(root) || !safeWorkspacePath(actual)) throw new Error('附件真实路径超出工作区或涉及敏感文件');
    const text = /^(?:text\/|application\/(?:json|xml|javascript)$)/i.test(item.mimeType);
    const remaining = MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES - total + item.sizeBytes;
    const bytes = await readBoundedLocalFile(actual, Math.min(remaining, MAX_ATTACHMENT_BYTES, text ? 512 * 1024 : Infinity));
    total += Math.max(0, bytes.length - item.sizeBytes);
    if (text && bytes.includes(0)) throw new Error('二进制文件不能作为文本引用');
    result.push({ ...item, sizeBytes: bytes.length, ...(text ? { textContent: bytes.toString('utf8') } : { dataBase64: bytes.toString('base64') }) });
  }
  return result;
}

function safeImageUri(raw: string, sessionId?: string, context?: () => LocalTargetContext): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'data:') return /^data:image\/[\w+.-]+;base64,/i.test(raw);
    if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password) return false;
    const path = decodeURIComponent(url.pathname);
    if (isForbiddenCredentialOrStatePath(path) || isBareExtensionOrFragment(path.split('/').at(-1) || '')) return false;
    if (url.protocol === 'file:') {
      const target = resolveLocalTarget(raw, { sessionId }, context?.() ?? {});
      return target.kind !== 'forbidden' && !!target.path;
    }
    return true;
  } catch { return false; }
}

export function appendImage(message: Pick<ChatMessageItem, 'attachments'> & { sessionId?: string }, payload: unknown, context?: () => LocalTargetContext): void {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    for (const item of payload) appendImage(message, item, context);
    return;
  }
  const block = payload as Record<string, unknown>;
  if (block.type === 'content' || block.type === 'resource' || block.inlineData || block.source) {
    appendImage(message, block.inlineData ?? block.source ?? block.content ?? block.resource, context);
    return;
  }
  const imageUrl = block.image_url && typeof block.image_url === 'object' ? (block.image_url as Record<string, unknown>).url : block.image_url;
  const uri = [block.uri, block.url, imageUrl].find((value): value is string => typeof value === 'string');
  if (uri !== undefined && !safeImageUri(uri, message.sessionId, context)) return;
  if (typeof block.name === 'string' && isBareExtensionOrFragment(block.name)) return;
  const encoded = uri && /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(uri);
  const extension = uri?.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  const mime = String(block.mimeType || block.media_type || encoded?.[1] || (extension && types[extension] ? 'image/' + types[extension] : '')).toLowerCase();
  if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon)$/.test(mime)) return;
  const bytes = block.data ?? block.blob ?? encoded?.[2];
  const valid = typeof bytes === 'string' && bytes.length <= 28 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(bytes);
  const dataUrl = valid ? 'data:' + mime + ';base64,' + bytes : undefined;
  const location = uri && !/^data:/i.test(uri) ? uri : undefined;
  if (!dataUrl && !location) return;
  const images = message.attachments ||= [];
  if (images.some(image => (dataUrl && image.dataUrl === dataUrl) || (location && image.uri === location))) return;
  const sizeBytes = valid ? Buffer.byteLength(bytes, 'base64') : 0;
  if (images.length >= MAX_MESSAGE_ATTACHMENTS || sizeBytes > MAX_ATTACHMENT_BYTES ||
      images.reduce((total, image) => total + image.sizeBytes, sizeBytes) > MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES) return;
  images.push({
    id: randomUUID(), mimeType: mime, dataUrl, uri: location,
    sizeBytes,
    name: typeof block.name === 'string' ? block.name : location?.split(/[\\/]/).at(-1) || 'Image ' + (images.length + 1),
  });
}

/**
 * Gravity v0.3.6 — 划词引用与逐处批注共享契约、纯归一化与旧史解码（纯叶模块，零内部依赖）
 *
 * 设计约束：
 * 1. 顺序只认 `annotations[]` 数组下标；前端生成稳定 `ann-<UUID>`，旧数据读时补确定性 `ann-legacy-*` ID；
 * 2. 沿用平铺字段 `messageId` / `messageNumber`，新增 `originMessageId` 供跨分支祖先稳定解析；
 * 3. 纯文本解码函数放于共享叶模块，使 `storage/conversation-messages.ts` 无需向上依赖 `session/`。
 */

export const MAX_MESSAGE_ANNOTATIONS = 32;
export const MAX_ANNOTATION_EXCERPT_CHARS = 8_000;
export const MAX_ANNOTATION_COMMENT_CHARS = 16_000;
export const MAX_ANNOTATIONS_TOTAL_CHARS = 128_000;
export const ANNOTATION_WIRE_HEADING = 'User-selected passages and comments:\n';

export interface MessageAnnotation {
  /** 条目稳定标识（前端生成 `ann-<UUID>`；旧数据读时确定性补全） */
  id?: string;
  /** 用户选中的原文摘录 */
  excerpt: string;
  /** 针对该摘录的批注或提问；缺省或空白归一为 undefined（表示「仅引用」） */
  comment?: string;
  /** 被划词消息 ID（平铺保留向后兼容） */
  messageId?: string;
  /** 被划词消息的跨分支稳定原始 ID */
  originMessageId?: string;
  /** 被划词消息在对话中的序号（1-based） */
  messageNumber?: number;
  /** 创建时间 ISO 字符串（可选） */
  createdAt?: string;
}

/** 32-bit FNV-1a，用于为没有 `id` 的历史标注生成确定性、跨加载稳定的 `ann-legacy-*` 标识。 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createDeterministicLegacyAnnotationId(
  annotation: Pick<MessageAnnotation, 'excerpt' | 'comment' | 'messageId' | 'originMessageId' | 'messageNumber'>,
  index: number
): string {
  const payload = [
    String(index),
    annotation.originMessageId ?? '',
    annotation.messageId ?? '',
    annotation.messageNumber !== undefined ? String(annotation.messageNumber) : '',
    annotation.excerpt,
    annotation.comment ?? '',
  ].join('\0');
  return `ann-legacy-${index + 1}-${fnv1aHex(payload)}`;
}

function isValidAnnotationId(value: unknown): value is string {
  return typeof value === 'string' && /^ann-[A-Za-z0-9._-]{1,80}$/.test(value.trim());
}

/**
 * 归一化单条标注：
 * - 拒绝空摘录或超长字段；
 * - 将纯空白 `comment` 归一为 `undefined`；
 * - 保证输出带有稳定 `id`（保留合法原 `id`，否则按序号和内容生成确定性 ID）。
 */
export function normalizeMessageAnnotation(
  raw: unknown,
  index: number,
  options: { assignDeterministicId?: boolean } = {}
): MessageAnnotation {
  if (!raw || typeof raw !== 'object') {
    throw new Error('标注格式无效');
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.excerpt !== 'string') {
    throw new Error('标注缺少有效摘录内容');
  }
  const excerpt = item.excerpt.trim();
  if (!excerpt) {
    throw new Error('标注摘录不能为空');
  }
  if (excerpt.length > MAX_ANNOTATION_EXCERPT_CHARS) {
    throw new Error(`单条标注摘录不能超过 ${MAX_ANNOTATION_EXCERPT_CHARS} 字符`);
  }

  let comment: string | undefined;
  if (item.comment !== undefined) {
    if (typeof item.comment !== 'string') {
      throw new Error('标注批注必须是文本');
    }
    const trimmed = item.comment.trim();
    if (trimmed.length > MAX_ANNOTATION_COMMENT_CHARS) {
      throw new Error(`单条标注批注不能超过 ${MAX_ANNOTATION_COMMENT_CHARS} 字符`);
    }
    if (trimmed) comment = trimmed;
  }

  const messageId = typeof item.messageId === 'string' && item.messageId.trim()
    ? item.messageId.trim().slice(0, 128)
    : undefined;
  const originMessageId = typeof item.originMessageId === 'string' && item.originMessageId.trim()
    ? item.originMessageId.trim().slice(0, 128)
    : undefined;
  const messageNumber =
    typeof item.messageNumber === 'number' && Number.isSafeInteger(item.messageNumber) && item.messageNumber > 0
      ? item.messageNumber
      : undefined;
  const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim()
    ? item.createdAt.trim().slice(0, 64)
    : undefined;

  const base: MessageAnnotation = {
    excerpt,
    ...(comment !== undefined ? { comment } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(originMessageId !== undefined ? { originMessageId } : {}),
    ...(messageNumber !== undefined ? { messageNumber } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  };

  if (isValidAnnotationId(item.id)) {
    base.id = item.id.trim();
  } else if (options.assignDeterministicId !== false) {
    base.id = createDeterministicLegacyAnnotationId(base, index);
  }
  return base;
}

/**
 * 校验并归一化有序标注数组（用于发送、编辑修订前置校验与持久化前净化）。
 * 保持数组原始顺序，绝不按「引用在前 / 批注在后」重排。
 */
export function normalizeMessageAnnotations(
  rawList: unknown,
  options: { assignDeterministicId?: boolean } = {}
): MessageAnnotation[] {
  if (rawList === undefined) return [];
  if (!Array.isArray(rawList)) {
    throw new Error('标注列表必须是数组');
  }
  if (rawList.length > MAX_MESSAGE_ANNOTATIONS) {
    throw new Error(`单条消息最多包含 ${MAX_MESSAGE_ANNOTATIONS} 条划词标注`);
  }
  let totalChars = 0;
  const seenIds = new Set<string>();
  const normalized: MessageAnnotation[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = normalizeMessageAnnotation(rawList[i], i, options);
    totalChars += item.excerpt.length + (item.comment?.length ?? 0);
    if (totalChars > MAX_ANNOTATIONS_TOTAL_CHARS) {
      throw new Error('标注总字符数超出限制');
    }
    if (item.id) {
      let candidateId = item.id;
      let suffix = 2;
      while (seenIds.has(candidateId)) {
        candidateId = `${item.id}-${suffix++}`;
      }
      item.id = candidateId;
      seenIds.add(candidateId);
    }
    normalized.push(item);
  }
  return normalized;
}

/** 为无 ID 的已存旧标注在读取时补全确定性稳定 ID（不修改原对象）。 */
export function ensureAnnotationIds(annotations?: readonly MessageAnnotation[]): MessageAnnotation[] | undefined {
  if (!annotations) return undefined;
  let changed = false;
  const seen = new Set<string>();
  const result = annotations.map((item, idx) => {
    const baseId = isValidAnnotationId(item.id)
      ? item.id.trim()
      : createDeterministicLegacyAnnotationId(item, idx);
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    seen.add(id);
    if (item.id === id) return item;
    changed = true;
    return { ...item, id };
  });
  return changed ? result : (annotations as MessageAnnotation[]);
}

/**
 * 可逆解码线路格式（JSON 封装 + 历史中英文 Notations 格式），纯函数无副作用。
 * 若输入不符合已识别封装格式则返回 null，保持原文本完好。
 */
export function decodeAnnotatedWireContent(
  raw: string
): { content: string; annotations: MessageAnnotation[] } | null {
  if (!raw) return null;
  if (raw.startsWith(ANNOTATION_WIRE_HEADING)) {
    try {
      const saved = JSON.parse(raw.slice(ANNOTATION_WIRE_HEADING.length));
      if (
        saved &&
        typeof saved === 'object' &&
        typeof saved.message === 'string' &&
        Array.isArray(saved.annotations) &&
        saved.annotations.every(
          (a: unknown) =>
            a &&
            typeof a === 'object' &&
            typeof (a as MessageAnnotation).excerpt === 'string' &&
            ((a as MessageAnnotation).comment === undefined ||
              typeof (a as MessageAnnotation).comment === 'string')
        )
      ) {
        return {
          content: saved.message,
          annotations: ensureAnnotationIds(saved.annotations as MessageAnnotation[]) ?? [],
        };
      }
    } catch {
      /* An incomplete or user-authored example stays intact. */
    }
  }

  const header = /^(【逐处标记批注 \(Notations\)】|\[Multi-spot Selection Notations\])\r?$/m.exec(raw);
  if (!header) return null;
  const before = raw.slice(0, header.index).trim();
  if (before && !before.split(/\r?\n/).every((line) => !line || line.startsWith('> '))) {
    return null;
  }
  const annotations: MessageAnnotation[] = before
    ? before.split(/\r?\n\r?\n/).map((block) => ({ excerpt: block.replace(/^> /gm, '') }))
    : [];
  const rest = raw.slice(header.index + header[0].length).trimStart();
  const ending = /(?:（第 \d+ 条消息）| \(message \d+\))(?=\r?\n\r?\n|$)/g;
  const lastOrigin = [...rest.matchAll(ending)].at(-1);
  const boilerplate =
    /\r?\n\r?\n(?:请严格结合以上逐处标记位置与批注说明进行修改或解答。|Please address each marked passage according to its notation above\.)$/.exec(
      rest
    );
  const divider =
    boilerplate?.index ??
    (lastOrigin ? lastOrigin.index! + lastOrigin[0].length : rest.search(/\r?\n\r?\n/));
  const list = divider < 0 ? rest : rest.slice(0, divider);
  let text = divider < 0 ? '' : rest.slice(divider).trim();
  const entries = list.split(/\r?\n(?=\d+\. (?:针对原文「|Regarding "))/);
  for (const [index, entry] of entries.entries()) {
    const match =
      /^(?:(\d+)\. 针对原文「([\s\S]*?)」：|(\d+)\. Regarding "([\s\S]*?)": )([\s\S]+)$/.exec(entry);
    if (!match || Number(match[1] || match[3]) !== index + 1) return null;
    const origin = /(?:（第 (\d+) 条消息）| \(message (\d+)\))$/.exec(match[5]);
    annotations.push({
      excerpt: match[2] || match[4],
      comment: origin ? match[5].slice(0, origin.index) : match[5],
      messageNumber: origin ? Number(origin[1] || origin[2]) : undefined,
    });
  }
  if (
    text === '请严格结合以上逐处标记位置与批注说明进行修改或解答。' ||
    text === 'Please address each marked passage according to its notation above.'
  ) {
    text = '';
  }
  return { content: text, annotations: ensureAnnotationIds(annotations) ?? [] };
}

/**
 * 为 Approve for me 复核上下文与 Title Organizer 生成安全隔离的用户意图摘要：
 * 显式区分「用户批注/指令」与「被引用原文」（防止将引文当作用户授权指令）。
 */
export function summarizeMessageIntentForContext(
  content: string | undefined,
  annotations: readonly MessageAnnotation[] | undefined,
  maxChars = 1_200
): string {
  const parts: string[] = [];
  const trimmed = (content || '').trim();
  if (trimmed) {
    parts.push(trimmed);
  }
  if (annotations && annotations.length > 0) {
    for (let i = 0; i < annotations.length; i++) {
      const ann = annotations[i];
      const excerptOneLine = ann.excerpt.replace(/\s+/g, ' ').trim().slice(0, 120);
      const commentOneLine = ann.comment?.replace(/\s+/g, ' ').trim().slice(0, 240);
      if (commentOneLine) {
        parts.push(`[Annotation #${i + 1} user comment] ${commentOneLine} (quoted passage: "${excerptOneLine}")`);
      } else if (excerptOneLine) {
        parts.push(`[Quoted passage #${i + 1} (reference only)] "${excerptOneLine}"`);
      }
    }
  }
  const combined = parts.join('\n').trim();
  return combined.length > maxChars ? `${combined.slice(0, Math.max(0, maxChars - 1))}…` : combined;
}

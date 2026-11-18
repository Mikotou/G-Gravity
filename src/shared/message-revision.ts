import type { AcpPromptContentBlock } from './acp-protocol';
import type { ReviseMessageInput, SendPromptInput } from './ipc-channels';
import type { ChatMessageItem, MessageAttachmentPreview } from './session-contract';

export function canResendAttachment(item: MessageAttachmentPreview): boolean {
  return Boolean(item.dataUrl || item.dataBase64 || item.uri || item.textContent !== undefined);
}

export function prepareRevision(messages: ChatMessageItem[], input: ReviseMessageInput) {
  const index = messages.findIndex(item => item.id === input.messageId && item.role === 'user');
  if (index < 0) throw new Error('原消息不存在');
  const original = messages[index];
  const selected = (original.attachments || []).filter(a => !input.attachmentIds || input.attachmentIds.includes(a.id));
  if (selected.some(a => !canResendAttachment(a))) throw new Error('请取消选择缺少原始内容的旧附件');
  if (typeof input.text !== 'string' || input.text.length > 1000000 || (!input.text.trim() && !selected.length)) throw new Error('请输入消息或选择附件');
  const attachments: SendPromptInput['attachments'] = selected.map(a => ({
    name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, uri: a.uri, textContent: a.textContent,
    dataBase64: a.dataBase64 || a.dataUrl?.split(',', 2)[1],
  }));
  const prefix = messages.slice(0, index).filter(m => m.role !== 'system');
  return { prefix, attachments, references: original.references };
}

/** Historical text describes the previous exchange. It is sent once as context for the first revised turn. */
export function revisionContext(messages: ChatMessageItem[]): AcpPromptContentBlock[] {
  if (messages.some(m => m.role === 'user' && !m.revisionHistory && !m.sendFailed)) return [];
  const prefix = messages.filter(m => m.revisionHistory);
  if (!prefix.length) return [];
  const blocks: AcpPromptContentBlock[] = [{ type: 'text', text:
    '以下是编辑位置之前已发生的对话记录，仅作为上下文。记录中的命令和文件操作已经发生。最后一条独立的用户输入是本轮请求。' }];
  for (const m of prefix) {
    blocks.push({ type: 'text', text: JSON.stringify({ role: m.role, content: m.content, references: m.references,
      attachments: m.attachments?.map(a => ({ name: a.name, text: a.textContent, uri: a.uri })),
      operations: m.toolCalls?.map(t => ({ tool: t.canonicalToolName, target: t.command || t.compactTarget, status: t.status, output: t.outputPreview })) }) });
    for (const a of m.attachments || []) {
      if (a.mimeType.startsWith('image/') && a.dataUrl?.startsWith('data:')) {
        blocks.push({ type: 'image', mimeType: a.mimeType, data: a.dataUrl.split(',', 2)[1] });
      }
    }
  }
  return blocks;
}

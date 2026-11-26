import {
  getMessageForkControl,
  type ChatMessageItem,
  type ConversationTreeState,
  type MessageForkControl,
  type MessagePagePosition,
} from '@shared';

/**
 * F-14：一次遍历预计算 `Map<messageId, forkControl>`。
 *
 * 共享层 `getMessageForkControl` 对每条消息都要重新扫描整段消息与全部分支节点（O(n²)）。
 * 这里先把分叉点索引成 `forkUserTurnIndex|forkAfterMessageId` 集合，顺序遍历一次消息得到每条用户消息的
 * 回合序号与前驱原始 ID，只有真正命中分叉点的消息才调用共享函数生成完整控件（与原语义逐字一致）。
 */
export function buildForkControlMap(
  tree: ConversationTreeState | undefined,
  activeBranchId: string,
  messages: ChatMessageItem[],
  position?: MessagePagePosition
): Map<string, MessageForkControl> {
  const out = new Map<string, MessageForkControl>();
  if (!tree || tree.totalBranches <= 1) return out;
  const forkKeys = new Set<string>();
  for (const n of tree.nodes) {
    if (n.parentBranchId !== null) forkKeys.add(`${n.forkUserTurnIndex}|${n.forkAfterMessageId ?? ''}`);
  }
  if (forkKeys.size === 0) return out;
  let userTurnIndex = position?.earlierUserCount || 0;
  let prevOriginId: string | null = position?.precedingOriginId ?? null;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (forkKeys.has(`${userTurnIndex}|${prevOriginId ?? ''}`)) {
        const control = getMessageForkControl(tree, activeBranchId, messages, m.id, position);
        if (control) out.set(m.id, control);
      }
      userTurnIndex += 1;
    }
    prevOriginId = m.originMessageId || m.id;
  }
  return out;
}

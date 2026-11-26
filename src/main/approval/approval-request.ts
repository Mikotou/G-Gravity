import { createHash } from 'node:crypto';
import type { AcpRequestPermissionParams, AcpRequestPermissionResult } from '../../shared/acp-protocol';
import type {
  ApprovalFloorTier, ApprovalReviewingEvent, ApproveForMeConfig, DeterministicScreeningResult,
  PendingApprovalRequest,
} from '../../shared/approval-contract';

export interface Pending {
  profileId: string;
  rpcId?: string | number;
  card: PendingApprovalRequest & { floorTier: ApprovalFloorTier };
  params: AcpRequestPermissionParams;
  screen: DeterministicScreeningResult;
  withinWorkspace: boolean;
  explicitAskRule: boolean;
  readOnly: boolean;
  turboEligible: boolean;
  toolArguments?: string;
  manualTakeover?: boolean;
  batchReview?: symbol;
  conversationContext?: string;
  resolve: (result: AcpRequestPermissionResult) => void;
  reject: (error: unknown) => void;
  started: number;
  review?: { controller: AbortController; event: ApprovalReviewingEvent };
  reviewRevision?: number;
  awaitingUser: boolean;
  ruleRevision: number;
  revokedDuringReview?: boolean;
}

/** 把会话、目录、去除单次 toolCallId 的工具参数和审批配置一并计入缓存键，限制已有结论可复用的范围并确保同类请求真实命中缓存。 */
export function decisionCacheKey(item: Pending, config: ApproveForMeConfig): string {
  const { kind, title, rawInput, locations } = item.params.toolCall;
  return item.card.sessionId + '\0' + createHash('sha256')
    .update(
      JSON.stringify([
        item.profileId,
        item.card.sessionId,
        item.card.cwd,
        item.card.toolName,
        { kind, title, rawInput, locations },
        item.conversationContext,
        config,
      ])
    )
    .digest('hex');
}

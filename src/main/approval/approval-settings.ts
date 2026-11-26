import { APPROVAL_POLICY_DEFAULTS, type ApproveForMeConfig } from '../../shared/approval-contract';
import { compileSafePattern } from './shell-screening';
import { alignedRiskCeiling, validateExternalEndpoint } from './external-reviewer';
export function validatedApprovalConfig(current: ApproveForMeConfig, patch: Partial<ApproveForMeConfig>): ApproveForMeConfig {
    const next = {
      ...current,
      ...patch,
      externalReviewer: { ...current.externalReviewer, ...patch.externalReviewer },
    };
    if (!['manual', 'rules-only', 'hybrid'].includes(next.mode)) throw new Error('无效的审批模式');
    for (const field of ['allowPatterns', 'askPatterns', 'denyPatterns'] as const) {
      if (!Array.isArray(next[field]) || next[field].length > 50) throw new Error('每类审批规则最多 50 条');
      next[field].forEach(compileSafePattern);
    }
    if (!Number.isFinite(next.cacheTtlHours) || next.cacheTtlHours < 0 || next.cacheTtlHours > 168) {
      throw new Error('缓存有效期必须介于 0 至 168 小时');
    }
    for (const field of ['allowAlignedHighRiskPass', 'fastPassLowRiskDev'] as const) {
      if (next[field] === undefined) next[field] = APPROVAL_POLICY_DEFAULTS[field];
      if (typeof next[field] !== 'boolean') throw new Error('无效审批开关 ' + field);
    }
    if (next.alignedHighRiskMaxScore !== undefined && !Number.isFinite(next.alignedHighRiskMaxScore)) throw new Error('高风险审批上限必须为有效分数');
    next.alignedHighRiskMaxScore = alignedRiskCeiling(next.alignedHighRiskMaxScore);
    if (typeof next.enableSafeDownloadAutoApprove !== 'boolean') throw new Error('下载审批开关无效');
    if (!Number.isFinite(next.maxDownloadSizeMB) || next.maxDownloadSizeMB < 0) {
      throw new Error('下载大小限制无效');
    }
    if (
      next.externalReviewer.timeoutMs !== undefined &&
      (!Number.isFinite(next.externalReviewer.timeoutMs) ||
        next.externalReviewer.timeoutMs < 100 ||
        next.externalReviewer.timeoutMs > 60_000)
    ) {
      throw new Error('外部复核超时时间必须介于 100 至 60000 ms');
    }
    if (
      next.externalReviewer.maxOutputTokens !== undefined &&
      (!Number.isFinite(next.externalReviewer.maxOutputTokens) ||
        next.externalReviewer.maxOutputTokens < 64 ||
        next.externalReviewer.maxOutputTokens > 65_536)
    ) {
      throw new Error('最大输出 Token 上限必须介于 64 至 65536');
    }
    if (
      next.externalReviewer.thinkingLevel !== undefined &&
      !['auto', 'off', 'minimal', 'low', 'medium', 'high'].includes(next.externalReviewer.thinkingLevel)
    ) {
      throw new Error('无效的思考强度配置');
    }
    if (next.externalReviewer.enabled) validateExternalEndpoint(next.externalReviewer);
    return next;
}

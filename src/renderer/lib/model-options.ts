import type { AcpModelOption, ManagedSessionSummary } from '@shared';

/**
 * U-02：新建对话可选模型目录。
 * 合并连接快照的 `availableModels`（live / cached `model-catalog.json`）与现有非污染会话上报的模型，按 `modelId` 去重，
 * 保持连接目录的原始顺序在前。旧版审批污染会话（`isLegacyApprovalPollution`）的模型信息不可信，直接跳过。
 */
export function buildNewSessionModelOptions(
  connectionModels: readonly AcpModelOption[] | undefined,
  sessions: readonly ManagedSessionSummary[] = []
): AcpModelOption[] {
  const seen = new Map<string, AcpModelOption>();
  const push = (opt: AcpModelOption | undefined): void => {
    const id = opt?.modelId?.trim();
    if (!id || seen.has(id)) return;
    seen.set(id, { ...opt!, modelId: id, name: opt!.name?.trim() || id });
  };
  for (const m of connectionModels ?? []) push(m);
  for (const s of sessions) {
    if (s.isLegacyApprovalPollution) continue;
    for (const m of s.availableModels ?? []) push(m);
  }
  return Array.from(seen.values());
}

/** 将「跟随默认」解析为实际提交的模型：仅当目录未同步或目录包含该模型时才显式提交项目默认模型。 */
export function resolveCreateModelId(
  explicit: string | undefined,
  projectDefault: string | undefined,
  options: readonly AcpModelOption[]
): string | undefined {
  if (explicit) return explicit;
  const fallback = projectDefault?.trim();
  if (!fallback) return undefined;
  if (options.length === 0 || options.some((m) => m.modelId === fallback)) return fallback;
  return undefined;
}

export function modelDisplayName(modelId: string | undefined, options: readonly AcpModelOption[]): string {
  if (!modelId) return '';
  return options.find((m) => m.modelId === modelId)?.name || modelId;
}

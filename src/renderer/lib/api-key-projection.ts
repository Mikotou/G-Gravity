/**
 * D4：外部第三方 API Key 零明文回传的渲染层提交规则。
 *
 * 主进程只返回 `hasApiKey: boolean`，渲染层草稿里的 `apiKey` 只可能来自用户本次输入：
 * - 用户输入了新 Key → 提交去除首尾空白后的新 Key；
 * - 用户点击「清除密钥」且未输入新 Key → 提交 `apiKey: ""` 显式清除；
 * - 其余情况（留空 / 未改动）→ 提交时省略 `apiKey` 字段，主进程保留同 provider + origin 的已存 Key。
 * `hasApiKey` 是只读投影标记，不回传给主进程。
 */
export function projectApiKeyForSubmit<T extends { apiKey?: string; hasApiKey?: boolean }>(
  draft: T,
  cleared: boolean
): T {
  const { apiKey, hasApiKey: _projection, ...rest } = draft;
  void _projection;
  const typed = apiKey?.trim();
  if (typed) return { ...rest, apiKey: typed } as T;
  if (cleared) return { ...rest, apiKey: '' } as T;
  return { ...rest } as T;
}

/**
 * v0.3.5 AP-1：外部 AI 服务（复核 / 翻译）端点 origin 规范化与自动发现安全守卫。
 * 凡携带 API Key（或已保存 hasApiKey）或非本机 Ollama 的服务，禁止防抖自动发起模型发现请求；
 * 唯一允许无鉴权自动发现的仅限本机 Ollama `http://127.0.0.1[:port]`。
 */

export function resolveExternalTargetOrigin(rawEndpoint: string | undefined): string | null {
  const trimmed = (rawEndpoint ?? '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (!url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function canAutoDiscoverExternalModels(cfg: {
  provider: string;
  endpoint?: string;
  apiKey?: string;
  hasApiKey?: boolean;
}): boolean {
  if (cfg.provider !== 'local-ollama') return false;
  if (cfg.apiKey?.trim() || cfg.hasApiKey) return false;
  const trimmed = (cfg.endpoint ?? '').trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

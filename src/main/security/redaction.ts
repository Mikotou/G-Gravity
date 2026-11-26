export function redactSecretsForReviewer(raw: string): string {
  return raw
    .replace(/\bya29\.[\w.-]+/g, '[REDACTED_TOKEN]')
    .replace(/(https?:\/\/)[^/\s"']+:[^@\s"']+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|api_key|access_token)=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bsk-(?:proj-|ant-|live-|test-)?[0-9A-Za-z_-]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:gh[pousr]_[0-9A-Za-z_]{20,}|github_pat_[0-9A-Za-z_]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/((?:^|[\s"',{])(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?)[^\r\n"']+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]')
    .replace(/(\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})(["']?)/gi, '$1[REDACTED]$3');
}

export function sanitizeOutput(value: string): string {
  return redactSecretsForReviewer(value)
    .replace(/((?:bearer|basic)\s+)[\w.\-+/=]+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}"']+)/gi,
      (_, label: string, secret: string) => label + (secret.startsWith('"') ? '"[已隐藏]"' : '[已隐藏]'))
    .replace(/(https?:\/\/)[^/\s"']+:[^@\s"']+@/gi, '$1[已隐藏]@');
}

export function maskKnownSecret(text: string, secret?: string, mask = '***'): string {
  return secret ? text.split(secret).join(mask) : text;
}

/** Redact only presentation values after parsing, preserving booleans, numbers and the JSON shape. */
export function redactCliValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return /^(?:token|password|secret|api[_-]?key|authorization)$/i.test(key) ? '[已隐藏]' : sanitizeOutput(value);
}

export function redactCliDiagnostic(detail: string): string {
  return sanitizeOutput(detail)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*(?:-----END [\w ]*PRIVATE KEY-----|$)/g, '[已隐藏]')
    .replace(/\b(?:sk-[\w-]+|AIza[\w-]+|github_pat_[\w-]+|gh[pousr]_[\w-]+|AKIA[A-Z0-9]{16})\b/g, '[已隐藏]')
    .replace(/((?:[A-Z]:[\\/]+Users|\/(?:home|Users))[\\/]+)[^\\/:\r\n]+/gi, '$1[用户]')
    .replace(/(\b(?:user(?:name)?|login)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[用户]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[用户]')
    .replace(/(--(?:api[-_]?key|token|password|secret)\s+)\S+/gi, '$1[已隐藏]')
    .replace(/\s+/g, ' ').trim().slice(0, 240) || '官方管理命令未成功完成';
}

export function diagnosticDetail(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (!text) return undefined;
  // Provider errors can quote the request, credentials, or absolute paths. Keep only a short public reason.
  if (/(?:authorization|cookie|bearer|basic|password|api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|secret)["']?\s*[:=]|(?:bearer|basic)\s+\S+|-----BEGIN .*KEY-----/i.test(text) ||
      /[a-z]:[\\/]|\\\\[^\\]|file:\/\/|~[\\/]|(?:^|[\s"'=:（(])\/(?:Users|home|var|tmp|etc|opt|Applications|private|Volumes|mnt|root)(?:\/|$)/i.test(text)) return '[redacted]';
  return text.replace(/\b(?:sk-[\w-]+|AIza[\w-]+|github_pat_[\w-]+|gh[pousr]_[\w-]+)\b/g, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 280);
}

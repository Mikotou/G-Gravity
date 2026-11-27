import { classifyErrorToDiagnosticCode, type DiagnosticCode } from '../../shared/diagnostic-contract';

export const officialLoginRequiredMessage = '官方 agy 未登录或登录已过期，请完成官方登录后重试。';

function statusCode(value: unknown): DiagnosticCode | undefined {
  switch (typeof value === 'string' ? value.toUpperCase() : value) {
    case 429: case '429': case 'RESOURCE_EXHAUSTED': return 'rate_limited_429';
    case 403: case '403': case 'PERMISSION_DENIED': return 'permission_denied_403';
    case 401: case '401': case 'UNAUTHENTICATED': return 'auth_required_401';
    case 'CONTEXT_LENGTH_EXCEEDED': case 'CONTEXT_OVERFLOW': return 'context_overflow';
  }
}

// Inspect only the public error envelope. Counts, token usage and other arbitrary numeric data
// in JSON-RPC error.data have no bearing on an HTTP/gRPC status.
function officialStatus(data: unknown, depth = 0): DiagnosticCode | undefined {
  if (depth > 4 || !data) return;
  if (typeof data === 'string') return statusCode(data.trim());
  if (Array.isArray(data)) {
    for (const item of data.slice(0, 16)) {
      const found = officialStatus(item, depth + 1);
      if (found) return found;
    }
  } else if (typeof data === 'object') {
    const value = data as Record<string, unknown>;
    return statusCode(value.status) || statusCode(value.reason) || statusCode(value.statusCode) ||
      officialStatus(value.error, depth + 1) || officialStatus(value.details, depth + 1);
  }
}

export function errorDiagnosticCode(error: unknown): DiagnosticCode {
  const value = error && typeof error === 'object' ? error as { code?: unknown; data?: unknown; message?: unknown } : {};
  const classified = classifyErrorToDiagnosticCode(error instanceof Error ? error : typeof value.message === 'string' ? value.message : error);
  const status = statusCode(value.code) || officialStatus(value.data);
  if (status) return status;
  if (classified !== 'unknown_error') return classified;
  if (typeof value.message === 'string' &&
      /\b(?:authentication required|(?:credentials?|access token|refresh token|login|authentication) (?:has |have |is |are )?expired|invalid_grant)\b/i.test(value.message)) return 'auth_required_401';
  if (typeof value.message === 'string' && /\b(?:context_length_exceeded|context_overflow)\b/i.test(value.message)) return 'context_overflow';
  return 'unknown_error';
}

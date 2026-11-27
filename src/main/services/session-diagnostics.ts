import { diagnosticDetail } from '../security/redaction';
import { buildDiagnosticBanner, type DiagnosticCode } from '../../shared/diagnostic-contract';
import type { AcpDiagnosticContext } from '../acp/acp-types';

import { errorDiagnosticCode } from '../acp/protocol-errors';
export { diagnosticDetail } from '../security/redaction';
export { officialLoginRequiredMessage } from '../acp/protocol-errors';

export function disconnectDiagnostic(client: AcpDiagnosticContext, event?: { exitCode?: number | null; signal?: string | null; lastError?: string } | string) {
  const info = typeof event === 'object' ? event : undefined;
  return buildDiagnosticBanner('acp_disconnected', {
    technicalDetail: diagnosticDetail(info?.lastError ?? client.lastError ?? event),
    exitCode: info?.exitCode ?? client.lastExitCode, signal: info?.signal ?? client.lastSignal,
  });
}

export function diagnosticForError(error: unknown, client: AcpDiagnosticContext, override?: DiagnosticCode) {
  const code = override || errorDiagnosticCode(error);
  const limited = code === 'rate_limited_429' || code === 'permission_denied_403';
  return buildDiagnosticBanner(code, {
    technicalDetail: diagnosticDetail(error),
    cooldownUntil: limited && client.cooldownUntilMs ? new Date(client.cooldownUntilMs).toISOString() : undefined,
    exitCode: client.lastExitCode, signal: client.lastSignal,
  });
}

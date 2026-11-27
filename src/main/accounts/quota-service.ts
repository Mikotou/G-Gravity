import { AccountQuotaUnavailable, MacQuotaNotReported, readAccountQuota } from './account-quota';
import type { AccountQuotaReadResult } from '../../shared/accounts-history-contract';
import type { AccountManager } from './account-manager';
import type { AcpClient } from '../acp/acp-client';
import { officialLoginRequiredMessage } from '../acp/protocol-errors';
export class QuotaService {
  private requests = new Map<string, { controller: AbortController; result: Promise<AccountQuotaReadResult> }>();
  private resumedAfter = 0;
  constructor(private host: { accounts: AccountManager; client: AcpClient; disposed: boolean; savingForQuit: boolean }) {}
  async cancel(): Promise<void> {
    const requests = [...this.requests.values()];
    for (const { controller } of requests) controller.abort();
    await Promise.allSettled(requests.map(request => request.result));
  }

  async getAccountQuota(manual = false): Promise<AccountQuotaReadResult> {
    this.host.accounts.assertReady();
    if (this.host.disposed || this.host.savingForQuit) throw new Error('客户端正在退出。');
    if (typeof manual !== 'boolean') throw new Error('额度刷新参数无效');
    const deadline = this.host.client.cooldownUntilMs;
    const assertAllowed = () => {
      this.host.client.assertRequestAllowed();
      if (this.host.client.cooldownUntilMs !== deadline || (!manual && this.resumedAfter < deadline)) {
        throw new Error('额度自动刷新已暂停，请手动刷新。');
      }
    };
    assertAllowed();
    const state = this.host.accounts.getState();
    const profile = state.profiles.find(p => p.profileId === state.activeProfileId)!;
    const existing = this.requests.get(profile.profileId);
    if (existing) return existing.result;
    const controller = new AbortController();
    const result = readAccountQuota(profile, this.host.client.options.binaryPath, controller.signal, assertAllowed)
      .catch((error): AccountQuotaReadResult => {
        if (error instanceof AccountQuotaUnavailable) return { profileId: profile.profileId, unavailable: error.reason };
        if (error instanceof MacQuotaNotReported && this.host.client.lastErrorCode === 'auth_required_401') {
          throw new Error(officialLoginRequiredMessage);
        }
        throw error;
      }).then(value => {
        if (manual && !('unavailable' in value) && !controller.signal.aborted && !this.host.disposed &&
            this.host.accounts.activeProfileId === profile.profileId && this.host.client.cooldownUntilMs === deadline) this.resumedAfter = deadline;
        return value;
      }).finally(() => this.requests.delete(profile.profileId));
    this.requests.set(profile.profileId, { controller, result });
    return result;
  }
}

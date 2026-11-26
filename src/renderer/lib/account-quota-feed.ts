import type { AccountQuota, AccountQuotaReadResult, AccountQuotaUnavailableReason } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';
import { stripIpcErrorPrefix } from '../i18n/locales';

interface QuotaSnapshot {
  quota?: AccountQuota;
  loading: boolean;
  error?: string;
  unavailable?: AccountQuotaUnavailableReason;
}

const minute = 60_000;
const feeds = new Map<string, AccountQuotaFeed>();

/** One refresh schedule per signed-in profile, shared by every visible conversation. */
export class AccountQuotaFeed {
  private value: QuotaSnapshot = { loading: false };
  private listeners = new Set<() => void>();
  private lastAttempt = -Infinity;
  private turnFinished = false;
  private timer?: number;

  constructor(
    private profileId: string,
    private read: (manual: boolean) => Promise<AccountQuotaReadResult> = (manual) =>
      getDesktopBridge().getAccountQuota(manual)
  ) {}

  snapshot = (): QuotaSnapshot => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && !this.value.unavailable) {
      window.addEventListener('focus', this.attend);
      document.addEventListener('visibilitychange', this.attend);
      this.timer = window.setInterval(this.tick, 15_000);
      this.tick();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopSchedule();
    };
  };

  private stopSchedule(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    window.removeEventListener('focus', this.attend);
    document.removeEventListener('visibilitychange', this.attend);
  }

  attend = () => this.refresh(minute, false);
  manual = () => this.refresh(0, true);
  afterTurn = () => {
    this.turnFinished = true;
    this.tick();
  };

  private tick = () => {
    const quota = this.value.quota;
    const resetDue = quota?.buckets.some(bucket => {
      const resetAt = Date.parse(bucket.resetAt || '');
      return resetAt > Date.parse(quota.checkedAt) && resetAt <= Date.now();
    });
    this.refresh(this.turnFinished || resetDue ? 30_000 : 5 * minute, false);
  };

  private publish(value: QuotaSnapshot) {
    this.value = value;
    this.listeners.forEach(listener => listener());
  }

  private async refresh(maxAge: number, manual = false): Promise<void> {
    if (this.value.unavailable || document.hidden || this.value.loading || Date.now() - this.lastAttempt < maxAge) return;
    this.lastAttempt = Date.now();
    this.turnFinished = false;
    this.publish({ quota: this.value.quota, loading: true });
    try {
      const quota = await this.read(manual);
      if (quota.profileId !== this.profileId) throw new Error(QUOTA_PROFILE_SWITCHED);
      if ('unavailable' in quota) {
        this.stopSchedule();
        this.publish({ unavailable: quota.unavailable, loading: false });
      } else this.publish({ quota, loading: false });
    } catch (reason) {
      const message = stripIpcErrorPrefix(reason);
      this.publish({ quota: this.value.quota, loading: false, error: message });
    }
  }
}

/** 读取期间账号已切换时的固定错误文本（作为标记使用）；界面按当前语言替换为对应说明。 */
export const QUOTA_PROFILE_SWITCHED = '账户已切换，请重新查看当前账户的额度。';

export function accountQuotaFeed(profileId: string): AccountQuotaFeed {
  let feed = feeds.get(profileId);
  if (!feed) {
    feed = new AccountQuotaFeed(profileId);
    feeds.set(profileId, feed);
  }
  return feed;
}

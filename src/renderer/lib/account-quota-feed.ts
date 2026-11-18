import type { AccountQuota } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';

interface QuotaSnapshot {
  quota?: AccountQuota;
  loading: boolean;
  error?: string;
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

  constructor(private profileId: string, private read = () => getDesktopBridge().getAccountQuota()) {}

  snapshot = (): QuotaSnapshot => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      window.addEventListener('focus', this.attend);
      document.addEventListener('visibilitychange', this.attend);
      this.timer = window.setInterval(this.tick, 15_000);
      this.tick();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        window.clearInterval(this.timer);
        window.removeEventListener('focus', this.attend);
        document.removeEventListener('visibilitychange', this.attend);
      }
    };
  };

  attend = () => this.refresh(minute);
  manual = () => this.refresh(0);
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
    this.refresh(this.turnFinished || resetDue ? 30_000 : 5 * minute);
  };

  private publish(value: QuotaSnapshot) {
    this.value = value;
    this.listeners.forEach(listener => listener());
  }

  private async refresh(maxAge: number): Promise<void> {
    if (document.hidden || this.value.loading || Date.now() - this.lastAttempt < maxAge) return;
    this.lastAttempt = Date.now();
    this.turnFinished = false;
    this.publish({ quota: this.value.quota, loading: true });
    try {
      const quota = await this.read();
      if (quota.profileId !== this.profileId) throw new Error('账户已切换，请重新查看当前账户的额度。');
      this.publish({ quota, loading: false });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.publish({ quota: this.value.quota, loading: false, error: message.replace(/^Error invoking remote method '[^']+': Error: /, '') });
    }
  }
}

export function accountQuotaFeed(profileId: string): AccountQuotaFeed {
  let feed = feeds.get(profileId);
  if (!feed) {
    feed = new AccountQuotaFeed(profileId);
    feeds.set(profileId, feed);
  }
  return feed;
}

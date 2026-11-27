import type { AccountQuota, AccountQuotaReadResult, AccountQuotaUnavailableReason, AcpConnectionStatus } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';
import { stripIpcErrorPrefix } from '../i18n/locales';

export interface QuotaSnapshot {
  quota?: AccountQuota;
  loading: boolean;
  error?: string;
  unavailable?: AccountQuotaUnavailableReason;
  cooldownUntil?: string;
  cooldownKind?: 'rate_limit_429' | 'permission_403';
  pausedByCooldown?: boolean;
  isolated?: boolean;
}

export interface QuotaSubscribeOptions {
  isolated?: boolean;
  connection?: AcpConnectionStatus;
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
  private unsubConnection?: () => void;
  private isolated = false;
  private cooldownUntil?: string;
  private cooldownKind?: 'rate_limit_429' | 'permission_403';
  private pausedByCooldown = false;

  constructor(
    private profileId: string,
    private read: (manual: boolean) => Promise<AccountQuotaReadResult> = (manual) =>
      getDesktopBridge().getAccountQuota(manual),
    private subscribeConnection: (listener: (status: AcpConnectionStatus) => void) => () => void = (listener) => {
      try {
        const bridge = getDesktopBridge();
        return typeof bridge.onConnectionUpdated === 'function' ? bridge.onConnectionUpdated(listener) : () => {};
      } catch {
        return () => {};
      }
    }
  ) {}

  snapshot = (): QuotaSnapshot => this.value;

  private isCooldownActive(): boolean {
    if (!this.cooldownUntil) return false;
    const until = Date.parse(this.cooldownUntil);
    return Number.isFinite(until) && until > Date.now();
  }

  private buildSnapshot(base: {
    quota?: AccountQuota;
    loading: boolean;
    error?: string;
    unavailable?: AccountQuotaUnavailableReason;
  }): QuotaSnapshot {
    const next: QuotaSnapshot = { loading: base.loading };
    if (base.quota !== undefined) next.quota = base.quota;
    if (base.error !== undefined) next.error = base.error;
    if (base.unavailable !== undefined) next.unavailable = base.unavailable;
    if (this.cooldownUntil) next.cooldownUntil = this.cooldownUntil;
    if (this.cooldownKind) next.cooldownKind = this.cooldownKind;
    if (this.pausedByCooldown) next.pausedByCooldown = true;
    if (this.isolated) next.isolated = true;
    return next;
  }

  private canAutoProbe(): boolean {
    return !this.isolated && !this.value.unavailable && !this.pausedByCooldown && !this.isCooldownActive();
  }

  private startSchedule(): void {
    if (this.timer !== undefined || !this.canAutoProbe() || !this.listeners.size) return;
    window.addEventListener('focus', this.attend);
    document.addEventListener('visibilitychange', this.attend);
    this.timer = window.setInterval(this.tick, 15_000);
  }

  private stopSchedule(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    window.removeEventListener('focus', this.attend);
    document.removeEventListener('visibilitychange', this.attend);
  }

  private applyConnectionInternal(status: AcpConnectionStatus, notify: boolean): void {
    if (status.activeProfileId && status.activeProfileId !== this.profileId) return;
    const untilMs = status.cooldownUntil ? Date.parse(status.cooldownUntil) : NaN;
    const activeCooldown = Number.isFinite(untilMs) && untilMs > Date.now();
    if (activeCooldown) {
      const nextKind = status.cooldownKind ?? 'rate_limit_429';
      const changed =
        this.cooldownUntil !== status.cooldownUntil ||
        this.cooldownKind !== nextKind ||
        !this.pausedByCooldown;
      this.cooldownUntil = status.cooldownUntil;
      this.cooldownKind = nextKind;
      this.pausedByCooldown = true;
      this.stopSchedule();
      if (changed) {
        const snap = this.buildSnapshot(this.value);
        if (notify) this.publish(snap);
        else this.value = snap;
      }
    }
  }

  applyConnectionStatus = (status: AcpConnectionStatus): void => {
    this.applyConnectionInternal(status, true);
  };

  setIsolated = (isolated: boolean): void => {
    if (this.isolated === isolated) return;
    this.isolated = isolated;
    if (isolated) {
      this.stopSchedule();
    } else if (this.listeners.size > 0 && this.canAutoProbe()) {
      this.startSchedule();
    }
    this.publish(this.buildSnapshot(this.value));
  };

  subscribe = (listener: () => void, options?: QuotaSubscribeOptions): (() => void) => {
    const firstSubscriber = this.listeners.size === 0;
    if (options?.isolated !== undefined && this.isolated !== options.isolated) {
      this.isolated = options.isolated;
      if (this.isolated) this.stopSchedule();
      this.value = this.buildSnapshot(this.value);
    }
    if (options?.connection) {
      this.applyConnectionInternal(options.connection, false);
    }
    this.listeners.add(listener);
    if (firstSubscriber) {
      this.unsubConnection = this.subscribeConnection(this.applyConnectionStatus);
      if (this.canAutoProbe()) {
        this.startSchedule();
        this.tick();
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stopSchedule();
        this.unsubConnection?.();
        this.unsubConnection = undefined;
      }
    };
  };

  attend = () => this.refresh(minute, false);
  manual = () => this.refresh(0, true);
  afterTurn = () => {
    if (!this.canAutoProbe()) return;
    this.turnFinished = true;
    this.tick();
  };

  private tick = () => {
    if (!this.canAutoProbe()) return;
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
    if (this.value.loading) return;
    // FE-BUG-04：429/403 活跃冷却期内禁止一切额度探测（含手动刷新），且不提前清除 pausedByCooldown。
    if (this.isCooldownActive()) return;
    if (!manual) {
      if (!this.canAutoProbe() || document.hidden || Date.now() - this.lastAttempt < maxAge) return;
    }
    this.lastAttempt = Date.now();
    this.turnFinished = false;
    this.publish(this.buildSnapshot({ quota: this.value.quota, unavailable: this.value.unavailable, loading: true }));
    try {
      const quota = await this.read(manual);
      if (quota.profileId !== this.profileId) throw new Error(QUOTA_PROFILE_SWITCHED);
      if ('unavailable' in quota) {
        this.stopSchedule();
        this.publish(this.buildSnapshot({ unavailable: quota.unavailable, loading: false }));
      } else {
        if (manual && !this.isCooldownActive()) {
          this.pausedByCooldown = false;
          this.cooldownUntil = undefined;
          this.cooldownKind = undefined;
        }
        this.publish(this.buildSnapshot({ quota, loading: false }));
        if (this.listeners.size > 0 && this.canAutoProbe()) {
          this.startSchedule();
        }
      }
    } catch (reason) {
      const message = stripIpcErrorPrefix(reason);
      this.publish(this.buildSnapshot({ quota: this.value.quota, unavailable: this.value.unavailable, loading: false, error: message }));
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

/** 仅供测试清理缓存的 feed 实例。 */
export function resetAccountQuotaFeeds(): void {
  feeds.clear();
}

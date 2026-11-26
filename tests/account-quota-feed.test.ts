// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountQuota } from '../src/shared';
import { AccountQuotaFeed, accountQuotaFeed } from '../src/renderer/lib/account-quota-feed';

const start = new Date('2026-11-18T10:00:00Z');
const snapshot = (profileId = 'default'): AccountQuota => ({
  profileId, checkedAt: new Date().toISOString(),
  buckets: [{ id: 'gemini-weekly', remainingFraction: .812 }, { id: '3p-5h', remainingFraction: 0 }],
});

describe('account quota refresh', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('shares an in-flight request and refresh timer across panes and releases the timer after the last unsubscribe', async () => {
    expect(accountQuotaFeed('default')).toBe(accountQuotaFeed('default'));
    expect(accountQuotaFeed('default')).not.toBe(accountQuotaFeed('other'));
    let resolve!: (data: AccountQuota) => void;
    const read = vi.fn(() => new Promise<AccountQuota>(done => { resolve = done; }));
    const feed = new AccountQuotaFeed('default', read);
    const first = feed.subscribe(vi.fn()), second = feed.subscribe(vi.fn());
    void feed.attend(); void feed.manual();
    expect(read).toHaveBeenCalledTimes(1);
    resolve(snapshot()); await Promise.resolve();
    expect(feed.snapshot().loading).toBe(false);
    first(); await vi.advanceTimersByTimeAsync(299_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    resolve(snapshot()); await Promise.resolve();
    second(); await vi.advanceTimersByTimeAsync(900_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refreshes after a turn, on reset and return to the foreground, without polling hidden windows', async () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const resetAt = new Date(start.getTime() + 75_000).toISOString();
    const read = vi.fn(async () => {
      const quota = snapshot();
      quota.buckets[0].resetAt = resetAt;
      return quota;
    });
    const feed = new AccountQuotaFeed('default', read);
    const unsub = feed.subscribe(vi.fn()); await Promise.resolve();
    feed.afterTurn(); feed.afterTurn();
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000); expect(read).toHaveBeenCalledTimes(3);
    hidden = true;
    await vi.advanceTimersByTimeAsync(600_000); expect(read).toHaveBeenCalledTimes(3);
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus')); await feed.attend(); expect(read).toHaveBeenCalledTimes(4);
    unsub();
  });

  it('keeps the last successful reading on errors and rejects data attributed to another profile', async () => {
    const original = snapshot();
    const read = vi.fn<() => Promise<AccountQuota>>().mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(snapshot('other'));
    const feed = new AccountQuotaFeed('default', read);
    await feed.manual(); await feed.manual();
    expect(feed.snapshot()).toEqual({ loading: false, quota: original, error: 'offline' });
    await feed.manual();
    expect(feed.snapshot().quota).toBe(original);
    expect(feed.snapshot().error).toContain('账户已切换');
  });

  it('stops the timer and all refresh triggers once the active profile cannot supply a quota', async () => {
    const read = vi.fn(async () => ({ profileId: 'isolated', unavailable: 'profile' as const }));
    const feed = new AccountQuotaFeed('isolated', read);
    const off = feed.subscribe(vi.fn());
    await Promise.resolve();
    expect(feed.snapshot()).toEqual({ loading: false, unavailable: 'profile' });
    expect(vi.getTimerCount()).toBe(0);
    await feed.manual(); await feed.attend(); feed.afterTurn();
    off();
    const again = feed.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(600_000);
    window.dispatchEvent(new Event('focus'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    again();
  });
});

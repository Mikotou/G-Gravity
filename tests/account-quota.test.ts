// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseQuota, readAccountQuota } from '../src/main/accounts/account-quota';

describe('public account quota', () => {
  it('preserves zero and absolute amounts, independent reset times and disabled buckets', () => {
    const now = new Date('2026-11-18T09:00:00Z');
    const q = parseQuota({ plan: 'Test', quota: { five: { remaining_fraction: 0, reset_in_seconds: 300 },
      week: { remaining_amount: 120, reset_time: '2026-11-24T10:20:00Z' }, off: { disabled: true }, missing: {}, invalid: { remaining_fraction: 10 } } }, 'test', now);
    expect(q.buckets.map(b => b.id)).toEqual(['five', 'week', 'off']);
    expect(q.buckets[0]).toMatchObject({ remainingFraction: 0, resetAt: '2026-11-18T09:05:00.000Z' });
    expect(q.buckets[1]).toMatchObject({ remainingAmount: 120, resetAt: '2026-11-24T10:20:00.000Z' });
    expect(q.buckets[2].disabled).toBe(true);
    expect(() => parseQuota({ quota: {} }, 'test')).toThrow();
  });
  it('never shows default-profile quota for an isolated profile', async () => {
    await expect(readAccountQuota({ profileId: 'other', name: 'Other', isDefault: false,
      createdAt: '', lastActivatedAt: '' })).rejects.toThrow();
  });
});

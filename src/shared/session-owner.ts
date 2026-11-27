/**
 * Gravity v0.3.6 — 统一会话与 Profile 归属契约（Owner + 实例代次 Epoch）
 *
 * 供 Plan、语音采集、媒体探测、Inspector 与会话事件共同校验归属，杜绝跨会话/跨 Profile/迟到回包污染。
 */

export interface ProfileOwner {
  profileId: string;
}

export interface SessionOwner extends ProfileOwner {
  sessionId: string;
  /** 单调递增的归属代次（切 Profile / 重载 / 删除重建时递增，用于丢弃迟到事件） */
  epoch?: number;
}

/**
 * 语音采集归属：
 * - 听写（`dictation`）归属具体 `{ profileId, sessionId }`；
 * - 设置页设备枚举与 3 秒试录（`device-list` / `mic-test`）仅需 `{ profileId }`，无打开会话也可用。
 */
export interface VoiceOwner extends ProfileOwner {
  sessionId?: string;
  epoch?: number;
}

export function normalizeOwnerId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isValidSessionOwner(value: unknown): value is SessionOwner {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionOwner>;
  const profileId = normalizeOwnerId(candidate.profileId);
  const sessionId = normalizeOwnerId(candidate.sessionId);
  if (!profileId || !sessionId) return false;
  if (candidate.epoch !== undefined) {
    return typeof candidate.epoch === 'number' && Number.isSafeInteger(candidate.epoch) && candidate.epoch >= 0;
  }
  return true;
}

export function isValidVoiceOwner(value: unknown): value is VoiceOwner {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<VoiceOwner>;
  const profileId = normalizeOwnerId(candidate.profileId);
  if (!profileId) return false;
  if (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string') return false;
  if (candidate.epoch !== undefined) {
    return typeof candidate.epoch === 'number' && Number.isSafeInteger(candidate.epoch) && candidate.epoch >= 0;
  }
  return true;
}

export function sameSessionOwner(a?: Partial<SessionOwner> | null, b?: Partial<SessionOwner> | null): boolean {
  if (!a || !b) return false;
  const profileA = normalizeOwnerId(a.profileId);
  const profileB = normalizeOwnerId(b.profileId);
  const sessionA = normalizeOwnerId(a.sessionId);
  const sessionB = normalizeOwnerId(b.sessionId);
  if (!profileA || !sessionA || profileA !== profileB || sessionA !== sessionB) return false;
  if (a.epoch !== undefined && b.epoch !== undefined && a.epoch !== b.epoch) return false;
  return true;
}

export function sessionOwnerKey(owner: Pick<SessionOwner, 'profileId' | 'sessionId' | 'epoch'>): string {
  const base = `${normalizeOwnerId(owner.profileId)}:${normalizeOwnerId(owner.sessionId)}`;
  return owner.epoch !== undefined ? `${base}:${owner.epoch}` : base;
}

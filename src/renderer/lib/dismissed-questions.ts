/**
 * 持久化记录用户已跳过或已回复的正文模型提问（writtenQuestion），
 * 避免切换同层级分支、切换标签页或重启后 `<SessionPane>` 卸载重建导致旧提问卡片重新弹出。
 */

const STORAGE_PREFIX = 'gravity.dismissedQuestions.';
const MAX_STORED_PER_PROFILE = 400;

const memoryCache = new Map<string, Set<string>>();

function storageKey(profileId?: string): string {
  return `${STORAGE_PREFIX}${profileId || 'default'}`;
}

function entryKey(sessionId: string, messageId: string): string {
  return `${sessionId}\x00${messageId}`;
}

function readSet(profileId?: string): Set<string> {
  const key = storageKey(profileId);
  let set = memoryCache.get(key);
  if (!set) {
    set = new Set<string>();
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item) set.add(item);
          }
        }
      }
    } catch {
      /* 仅保留内存态即可 */
    }
    memoryCache.set(key, set);
  }
  return set;
}

function writeSet(profileId: string | undefined, set: Set<string>): void {
  const key = storageKey(profileId);
  if (set.size > MAX_STORED_PER_PROFILE) {
    const trimmed = [...set].slice(set.size - MAX_STORED_PER_PROFILE);
    set.clear();
    for (const item of trimmed) set.add(item);
  }
  try {
    if (set.size > 0) {
      window.localStorage.setItem(key, JSON.stringify([...set]));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* 仅保留内存态即可 */
  }
}

export function isQuestionDismissed(profileId: string | undefined, sessionId: string, messageId: string): boolean {
  if (!sessionId || !messageId) return false;
  return readSet(profileId).has(entryKey(sessionId, messageId));
}

export function markQuestionDismissed(profileId: string | undefined, sessionId: string, messageId: string): void {
  if (!sessionId || !messageId) return;
  const set = readSet(profileId);
  const k = entryKey(sessionId, messageId);
  if (set.has(k)) return;
  set.add(k);
  writeSet(profileId, set);
}

export function clearDismissedQuestionsForSession(profileId: string | undefined, sessionId: string): void {
  if (!sessionId) return;
  const set = readSet(profileId);
  const prefix = `${sessionId}\x00`;
  let changed = false;
  for (const item of [...set]) {
    if (item.startsWith(prefix)) {
      set.delete(item);
      changed = true;
    }
  }
  if (changed) writeSet(profileId, set);
}

export function resetDismissedQuestionsCacheForTests(): void {
  memoryCache.clear();
}

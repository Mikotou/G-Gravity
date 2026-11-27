import type { ExternalUsageHost } from '../core-contracts';

/** Deleted sessions retain only global usage. A late result keeps its initiating profile. */
export function ownedExternalUsage<T extends { sessionId: string }>(app: ExternalUsageHost, profile: string, event: T): T {
  const owned = profile === app.sessions.profileId ? app.sessions.sessions.has(event.sessionId)
    : Object.hasOwn(app.store.read('owned-sessions-' + profile + '.json', {}), event.sessionId);
  return owned ? event : { ...event, sessionId: '' };
}

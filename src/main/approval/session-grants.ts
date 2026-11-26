import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type { ApprovalAuditEntry, SessionApprovalGrantsSnapshot, SessionApprovalPrefixGrant, RevokeSessionApprovalGrantInput } from '../../shared/approval-contract';
import { ClientStore, type JournalRecordPosition } from '../storage/client-store';

type Delegation = 'hybrid' | 'rules-only';
interface Grant {
  sessionId: string;
  cwd: string;
  prefixes: string[]; // Retain the v1 wire format for saved conversations.
  prefixDetails?: SessionApprovalPrefixGrant[];
  delegation?: Delegation;
  delegatedAt?: string;
}
interface GrantFile {
  version: 1;
  profile: string;
  grants: Grant[];
  pending?: { grant: Grant; audit: JournalRecordPosition };
}

export function approvalWorkspaceKey(cwd: string): string {
  if (!cwd) return '';
  if (process.platform === 'win32' || /^[a-z]:[\\/]|^\\\\/i.test(cwd)) {
    const resolved = win32.resolve(cwd);
    return (resolved === win32.parse(resolved).root ? resolved : resolved.replace(/\\+$/, '')).toLowerCase();
  }
  return cwd === '/' ? cwd : cwd.replace(/\/+$/, '');
}

function validGrant(value: Grant): boolean {
  return Boolean(value && typeof value.sessionId === 'string' && value.sessionId && typeof value.cwd === 'string' && value.cwd &&
    Array.isArray(value.prefixes) && value.prefixes.every(p => typeof p === 'string' && p.length > 0) &&
    (value.prefixDetails === undefined || (Array.isArray(value.prefixDetails) && value.prefixDetails.every(detail =>
      detail && typeof detail.prefix === 'string' && typeof detail.grantedAt === 'string' &&
      Number.isSafeInteger(detail.hitCount) && detail.hitCount >= 0))) &&
    (value.delegatedAt === undefined || typeof value.delegatedAt === 'string') &&
    (value.delegation === undefined || value.delegation === 'hybrid' || value.delegation === 'rules-only'));
}

const grantKey = (sessionId: string, cwd: string) => JSON.stringify([sessionId, approvalWorkspaceKey(cwd)]);

/** An explicit grant and its audit share one commit point, the complete appended audit record. */
export class SessionGrants {
  private profile?: string;
  private records = new Map<string, Grant>();
  private file = '';

  constructor(private store: ClientStore, private currentProfile: () => string) {}

  private load(): void {
    const profile = this.currentProfile();
    if (profile === this.profile) return;
    const file = 'approval-grants-' + createHash('sha256').update(profile).digest('hex') + '.json';
    const saved = this.store.readGrantSnapshot<GrantFile>(file);
    const records = new Map<string, Grant>();
    if (saved?.version === 1 && saved.profile === profile && Array.isArray(saved.grants) && saved.grants.every(validGrant)) {
      for (const grant of saved.grants) {
        records.set(grantKey(grant.sessionId, grant.cwd), grant);
      }
      const pending = saved.pending;
      if (pending && validGrant(pending.grant) && this.store.hasJournalRecord('audit.jsonl', pending.audit)) {
        records.set(grantKey(pending.grant.sessionId, pending.grant.cwd), pending.grant);
      }
    }
    this.records = records;
    this.file = file;
    this.profile = profile;
  }

  get(sessionId: string, cwd: string): Readonly<Grant> | undefined {
    try { this.load(); } catch { return undefined; }
    return this.records.get(grantKey(sessionId, cwd));
  }

  getSessionGrantsSnapshot(sessionId: string, cwd: string): SessionApprovalGrantsSnapshot {
    this.load();
    const grant = this.records.get(grantKey(sessionId, cwd));
    return {
      sessionId, workspaceKey: approvalWorkspaceKey(cwd),
      delegatedToGuardian: Boolean(grant?.delegation), delegatedAt: grant?.delegatedAt,
      prefixes: grant?.prefixes.map(prefix => {
        const detail = grant.prefixDetails?.find(item => item.prefix === prefix);
        // Older snapshots did not record grant times. An empty value denotes an unknown date.
        return { prefix, grantedAt: detail?.grantedAt ?? '', hitCount: detail?.hitCount ?? 0 };
      }) ?? [],
    };
  }

  revokeSessionGrant(sessionId: string, cwd: string, input: RevokeSessionApprovalGrantInput): SessionApprovalGrantsSnapshot {
    if (!input || input.sessionId !== sessionId || (input.prefix !== undefined && typeof input.prefix !== 'string') ||
        (input.revokeDelegation !== undefined && typeof input.revokeDelegation !== 'boolean')) throw new Error('无效的会话授权撤销请求');
    this.load();
    const key = grantKey(sessionId, cwd);
    const current = this.records.get(key);
    if (current && (current.prefixes.includes(input.prefix ?? '') || (input.revokeDelegation && current.delegation))) {
      const next = new Map(this.records);
      const grant = { ...current, prefixes: current.prefixes.filter(p => p !== input.prefix),
        prefixDetails: current.prefixDetails?.filter(detail => detail.prefix !== input.prefix) };
      if (input.revokeDelegation) {
        delete grant.delegation;
        delete grant.delegatedAt;
      }
      if (grant.prefixes.length || grant.delegation) next.set(key, grant);
      else next.delete(key);
      this.saveRecords(next);
    }
    return this.getSessionGrantsSnapshot(sessionId, cwd);
  }

  commit(entry: ApprovalAuditEntry, prefix?: string, mode?: Delegation, matchedPrefix?: string): void {
    this.load();
    const existing = this.records.get(grantKey(entry.sessionId, entry.cwd));
    const grant: Grant = { sessionId: entry.sessionId, cwd: approvalWorkspaceKey(entry.cwd), prefixes: [...existing?.prefixes ?? []],
      delegation: mode ?? existing?.delegation };
    grant.prefixDetails = this.getSessionGrantsSnapshot(entry.sessionId, entry.cwd).prefixes;
    grant.delegatedAt = existing?.delegatedAt ?? (mode ? entry.timestamp : undefined);
    if (prefix && !grant.prefixes.includes(prefix)) {
      grant.prefixes.push(prefix);
      grant.prefixDetails.push({ prefix, grantedAt: entry.timestamp, hitCount: 0 });
    }
    const hit = matchedPrefix && grant.prefixDetails.find(detail => detail.prefix === matchedPrefix);
    if (hit) hit.hitCount++;
    const base: GrantFile = {version: 1, profile: this.profile!, grants: [...this.records.values()]};
    const audit = this.store.nextJournalRecord('audit.jsonl', entry);
    // No other approval can interleave between these synchronous writes in the single owning desktop process.
    // On restart an uncommitted candidate is ignored, even if another audit was later written at the same offset.
    this.store.write(this.file, { ...base, pending: { grant, audit } });
    try {
      this.store.append('audit.jsonl', entry);
    } catch (error) {
      // Remove the prepared record if possible. A partial or missing journal entry cannot activate it on restart.
      this.store.write(this.file, base);
      throw error;
    }
    this.records.set(grantKey(grant.sessionId, grant.cwd), grant);
  }

  clear(sessionId: string, cwd?: string): void {
    this.load();
    const remaining = new Map(this.records);
    if (cwd !== undefined) remaining.delete(grantKey(sessionId, cwd));
    else for (const [key, grant] of remaining) if (grant.sessionId === sessionId) remaining.delete(key);
    if (remaining.size === this.records.size) return;
    this.saveRecords(remaining);
  }

  private saveRecords(remaining: Map<string, Grant>): void {
    this.store.write(this.file, {version: 1, profile: this.profile!, grants: [...remaining.values()]} satisfies GrantFile);
    this.records = remaining;
  }
}

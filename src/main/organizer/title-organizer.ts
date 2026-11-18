import { generateStructuredChineseTitle } from '../../shared/session-contract';
import type { ManagedSessionSummary, TitleOrganizeRequest, TitleOrganizeResult } from '../../shared/session-contract';
import { ClientStore } from '../storage/client-store';

type TitleOverride = { title?: string; pinned?: boolean; categoryTag?: string };
export class TitleOrganizer {
  private overrides: Record<string, TitleOverride>;
  constructor(private store: ClientStore) { this.overrides = store.read('titles.json', {}); }
  private key(session: ManagedSessionSummary): string { return `${session.profileId || 'default'}:${session.sessionId}`; }
  /** 默认 Profile 兼容早期只按会话号保存的修改，然后叠加当前 Profile 的标题和置顶状态。 */
  apply(session: ManagedSessionSummary): ManagedSessionSummary { return { ...session, ...(session.profileId === 'default' ? this.overrides[session.sessionId] : {}), ...this.overrides[this.key(session)] }; }
  rename(session: ManagedSessionSummary, title: string): ManagedSessionSummary {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('标题应为 1 至 200 个字符');
    return this.save(session, { title: title.trim() });
  }
  remove(profile: string, id: string): void {
    delete this.overrides[profile + ':' + id];
    if (profile === 'default') delete this.overrides[id];
    this.store.write('titles.json', this.overrides);
  }
  togglePin(session: ManagedSessionSummary): ManagedSessionSummary { return this.save(session, { pinned: !this.apply(session).pinned }); }
  /** 按请求中的会话范围整理本地标题，未指定范围时遍历传入清单。结果只列出本次确实改写的标题。 */
  organize(sessions: ManagedSessionSummary[], request: TitleOrganizeRequest = {}): TitleOrganizeResult {
    const suggestions: TitleOrganizeResult['suggestions'] = [];
    for (const item of sessions) {
      if (item.isLegacyApprovalPollution || (request.sessionIds && !request.sessionIds.includes(item.sessionId))) continue;
      const session = this.apply(item);
      const { organizedTitle, categoryTag } = generateStructuredChineseTitle(session.title, session.cwd);
      if (session.title === organizedTitle) continue;
      suggestions.push({ sessionId: item.sessionId, previousTitle: session.title, organizedTitle, categoryTag });
      this.overrides[this.key(item)] = { ...this.overrides[this.key(item)], title: organizedTitle, categoryTag };
    }
    this.store.write('titles.json', this.overrides);
    return { updatedCount: suggestions.length, hiddenPollutionCount: sessions.filter(item => item.isLegacyApprovalPollution).length, suggestions };
  }
  private save(session: ManagedSessionSummary, patch: TitleOverride): ManagedSessionSummary {
    this.overrides[this.key(session)] = { ...this.overrides[this.key(session)], ...patch };
    this.store.write('titles.json', this.overrides); return this.apply(session);
  }
}

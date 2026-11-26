import { normalizeWorkspacePath } from '../../shared/session-contract';
import type {
  ManagedSessionSummary, TitleOrganizeRequest, TitleOrganizeResult, TitleOrganizeScope,
} from '../../shared/session-contract';
import { ClientStore } from '../storage/client-store';

type TitleOverride = {
  title?: string;
  pinned?: boolean;
  categoryTag?: string;
  titleOrganizedAt?: string;
  titleOrganizedModel?: string;
};

interface SelectedOrganizeTargets {
  scope: TitleOrganizeScope;
  targets: ManagedSessionSummary[];
  skippedOrganizedCount: number;
  hiddenPollutionCount: number;
}

export class TitleOrganizer {
  private overrides: Record<string, TitleOverride>;
  constructor(private store: ClientStore) { this.overrides = store.read('titles.json', {}); }
  private key(session: ManagedSessionSummary): string { return `${session.profileId || 'default'}:${session.sessionId}`; }
  /** 默认 Profile 兼容早期只按会话号保存的修改，然后叠加当前 Profile 的标题、置顶和整理标记。 */
  apply(session: ManagedSessionSummary): ManagedSessionSummary {
    return {
      ...session,
      ...(session.profileId === 'default' ? this.overrides[session.sessionId] : {}),
      ...this.overrides[this.key(session)],
    };
  }
  rename(session: ManagedSessionSummary, title: string): ManagedSessionSummary {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('标题应为 1 至 200 个字符');
    return this.save(session, { title: title.trim() });
  }
  remove(profile: string, id: string): void {
    const next = { ...this.overrides };
    delete next[profile + ':' + id];
    if (profile === 'default') delete next[id];
    this.commit(next);
  }
  togglePin(session: ManagedSessionSummary): ManagedSessionSummary { return this.save(session, { pinned: !this.apply(session).pinned }); }

  /** 根据整理范围筛选候选会话：all 跳过已整理会话；project 与 session 显式重整目标。 */
  selectTargets(sessions: ManagedSessionSummary[], request: TitleOrganizeRequest = {}): SelectedOrganizeTargets {
    const scope: TitleOrganizeScope = request.scope
      ?? (request.projectCwd ? 'project' : request.sessionIds?.length === 1 ? 'session' : request.sessionIds?.length ? 'project' : 'all');
    const idSet = request.sessionIds === undefined ? null : new Set(request.sessionIds);
    const projectKey = (cwd: string) => {
      const normalized = normalizeWorkspacePath(cwd);
      return /^(?:[A-Za-z]:|\\\\)/.test(cwd) || /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    const normalizedProject = request.projectCwd ? projectKey(request.projectCwd) : null;
    const hiddenPollutionCount = sessions.filter(item => item.isLegacyApprovalPollution).length;

    let skippedOrganizedCount = 0;
    const targets: ManagedSessionSummary[] = [];
    if ((scope === 'session' && !idSet?.size) || (scope === 'project' && !normalizedProject && !idSet?.size)) {
      return { scope, targets, skippedOrganizedCount, hiddenPollutionCount };
    }

    for (const raw of sessions) {
      if (raw.isLegacyApprovalPollution || raw.archivedAt || raw.parentBranchId) continue;
      if (idSet && !idSet.has(raw.sessionId)) continue;
      if (normalizedProject) {
        const cwdNorm = projectKey(raw.cwd || raw.rawCwd || '');
        if (cwdNorm !== normalizedProject) continue;
      }
      const applied = this.apply(raw);
      if (scope === 'all' && applied.titleOrganizedAt) {
        skippedOrganizedCount += 1;
        continue;
      }
      targets.push(applied);
    }

    return { scope, targets, skippedOrganizedCount, hiddenPollutionCount };
  }

  /** 写回已验证模型生成的标题，并为本次参与整理的目标打上已整理标记。 */
  applyOrganizedTitles(
    targets: ManagedSessionSummary[],
    organizedMap: Map<string, { organizedTitle: string; categoryTag?: string }>,
    options: {
      modelUsed: string;
      hiddenPollutionCount: number;
      skippedOrganizedCount: number;
      nowIso?: string;
    }
  ): TitleOrganizeResult {
    const nowIso = options.nowIso || new Date().toISOString();
    const modelUsed = options.modelUsed;
    const suggestions: TitleOrganizeResult['suggestions'] = [];
    const next = { ...this.overrides };

    for (const session of targets) {
      const entry = organizedMap.get(session.sessionId);
      const nextTitle = entry?.organizedTitle?.replace(/\s+/g, ' ').trim().slice(0, 120);
      const nextCategory = entry?.categoryTag?.replace(/\s+/g, ' ').trim().slice(0, 24)
        || (nextTitle && nextTitle.includes('｜') ? nextTitle.split('｜')[0].trim() : session.categoryTag)
        || 'General';
      const overrideKey = this.key(session);
      const existing = this.overrides[overrideKey] || {};

      if (nextTitle && nextTitle !== session.title) {
        suggestions.push({
          sessionId: session.sessionId,
          previousTitle: session.title,
          organizedTitle: nextTitle,
          categoryTag: nextCategory,
        });
        next[overrideKey] = {
          ...existing,
          title: nextTitle,
          categoryTag: nextCategory,
          titleOrganizedAt: nowIso,
          titleOrganizedModel: modelUsed,
        };
      } else if (entry) {
        next[overrideKey] = {
          ...existing,
          categoryTag: nextCategory,
          titleOrganizedAt: nowIso,
          titleOrganizedModel: modelUsed,
        };
      }
    }

    this.commit(next);
    return {
      updatedCount: suggestions.length,
      hiddenPollutionCount: options.hiddenPollutionCount,
      skippedOrganizedCount: options.skippedOrganizedCount,
      modelUsed,
      suggestions,
    };
  }

  private save(session: ManagedSessionSummary, patch: TitleOverride): ManagedSessionSummary {
    const key = this.key(session);
    this.commit({ ...this.overrides, [key]: { ...this.overrides[key], ...patch } });
    return this.apply(session);
  }
  private commit(next: Record<string, TitleOverride>): void {
    this.store.write('titles.json', next);
    this.overrides = next;
  }
}

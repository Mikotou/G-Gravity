/**
 * v0.3.6 会话私有计划文档读取 Hook（summary / content 分视图）。
 *
 * - 归属 key = `profileId:sessionId:epoch`，另配单调「请求代次」：key 变化或代次过期的迟到响应一律丢弃；
 * - `summaryRevision` 与 `contentRevision` 独立维护；先读 `view: 'summary'`，仅原文抽屉打开时才读 `view: 'content'`；
 * - 兼容旧桥接：摘要请求若只回正文（无 outline），本地提取概要并顺带缓存正文；
 * - 模块级小缓存：切回 Plan 页签时直接复用上次摘要，消除首帧空态闪烁。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanArtifactChangedEvent, PlanArtifactSnapshot, PlanOutline } from '@shared';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { outlineFromMarkdown } from '../lib/plan-view';
import { getDesktopBridge } from '../services/desktop-bridge';

export interface PlanSummaryState {
  status: PlanArtifactSnapshot['status'];
  outline?: PlanOutline;
  filePath?: string;
  updatedAt?: string;
  reason?: string;
  revision?: number;
  epoch?: number;
}

export interface PlanContentState {
  content: string;
  truncated: boolean;
  revision?: number;
  updatedAt?: string;
  epoch?: number;
}

export interface UsePlanArtifactResult {
  supported: boolean;
  /** 尚未取得首个摘要结果 */
  pending: boolean;
  summary: PlanSummaryState | null;
  content: PlanContentState | null;
  loadingSummary: boolean;
  loadingContent: boolean;
  error: string;
  refresh: () => void;
}

const CACHE_LIMIT = 16;
const summaryCache = new Map<string, { epoch?: number; summary: PlanSummaryState; content: PlanContentState | null }>();

function remember(key: string, summary: PlanSummaryState, content: PlanContentState | null, epoch?: number): void {
  summaryCache.delete(key);
  summaryCache.set(key, { ...(epoch !== undefined ? { epoch } : {}), summary, content });
  while (summaryCache.size > CACHE_LIMIT) {
    const oldest = summaryCache.keys().next().value;
    if (oldest === undefined) break;
    summaryCache.delete(oldest);
  }
}

/** 仅供测试：清空模块级缓存。 */
export function __resetPlanArtifactCache(): void {
  summaryCache.clear();
}

export function planArtifactKey(profileId: string, sessionId: string, epoch?: number): string {
  return `${profileId}:${sessionId}:${epoch ?? 0}`;
}

export function usePlanArtifact({
  profileId,
  sessionId,
  epoch,
  contentOpen,
}: {
  profileId: string;
  sessionId: string | null;
  epoch?: number;
  contentOpen: boolean;
}): UsePlanArtifactResult {
  const supported = typeof getDesktopBridge().getSessionPlanArtifact === 'function';
  const baseKey = sessionId ? `${profileId}:${sessionId}` : '';
  // QA1-FE-18：epoch 由 undefined 首次收敛为定义值 N 时不重建 key、不二次拉取；仅当两个不同定义值间切换时才失效重拉
  const epochTrackRef = useRef<{ base: string; definedEpoch?: number; generation: number }>({ base: '', generation: 0 });
  if (epochTrackRef.current.base !== baseKey) {
    epochTrackRef.current = { base: baseKey, definedEpoch: epoch, generation: 0 };
  } else if (epoch !== undefined) {
    if (epochTrackRef.current.definedEpoch !== undefined && epochTrackRef.current.definedEpoch !== epoch) {
      epochTrackRef.current = { base: baseKey, definedEpoch: epoch, generation: epochTrackRef.current.generation + 1 };
    } else if (epochTrackRef.current.definedEpoch === undefined) {
      epochTrackRef.current.definedEpoch = epoch;
    }
  }
  const key = baseKey ? `${baseKey}#${epochTrackRef.current.generation}` : '';
  const rawCached = baseKey ? summaryCache.get(baseKey) : undefined;
  const cached =
    rawCached && !(epoch !== undefined && rawCached.epoch !== undefined && rawCached.epoch !== epoch)
      ? rawCached
      : undefined;
  const [summary, setSummary] = useState<PlanSummaryState | null>(cached?.summary ?? null);
  const [content, setContent] = useState<PlanContentState | null>(cached?.content ?? null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState('');
  const keyRef = useRef(key);
  const baseKeyRef = useRef(baseKey);
  baseKeyRef.current = baseKey;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const genRef = useRef(0);
  const summaryRef = useRef<PlanSummaryState | null>(summary);
  const contentRef = useRef<PlanContentState | null>(content);
  const contentStaleRef = useRef(false);
  const contentOpenRef = useRef(contentOpen);
  contentOpenRef.current = contentOpen;

  // QA2-P0: 追踪当前 key 下最新已确认代次（与 key 同步复位，防跨会话污染）
  const knownEpochRef = useRef<{ key: string; epoch?: number }>({ key, epoch });
  if (knownEpochRef.current.key !== key) {
    knownEpochRef.current = { key, epoch };
  } else if (epoch !== undefined) {
    knownEpochRef.current.epoch =
      knownEpochRef.current.epoch === undefined ? epoch : Math.max(knownEpochRef.current.epoch, epoch);
  }

  /**
   * 直接请求响应的归属校验（loadSummary / loadContent 使用）：
   * 仅丢弃早于当前已知代次的旧响应，接受同代次或更新代次的响应并推进 knownEpochRef。
   */
  const ownerMatchesDirect = useCallback(
    (result: PlanArtifactSnapshot): boolean => {
      const owner = result.owner;
      if (owner) {
        if (owner.sessionId && owner.sessionId !== sessionId) return false;
        if (owner.profileId && owner.profileId !== profileId) return false;
      }
      const resultEpoch = result.epoch ?? owner?.epoch;
      const expectedEpoch = knownEpochRef.current.epoch ?? epochRef.current;
      // 丢弃早于当前已知代次的旧响应
      if (expectedEpoch !== undefined && resultEpoch !== undefined && resultEpoch < expectedEpoch) return false;
      // 推进 knownEpochRef
      if (
        resultEpoch !== undefined &&
        (knownEpochRef.current.epoch === undefined || resultEpoch > knownEpochRef.current.epoch)
      ) {
        knownEpochRef.current.epoch = resultEpoch;
      }
      return true;
    },
    [profileId, sessionId]
  );

  const commitSummary = useCallback((next: PlanSummaryState | null) => {
    summaryRef.current = next;
    setSummary(next);
  }, []);
  const commitContent = useCallback((next: PlanContentState | null) => {
    contentRef.current = next;
    setContent(next);
  }, []);

  const loadSummary = useCallback(
    async (force: boolean) => {
      const fetcher = getDesktopBridge().getSessionPlanArtifact;
      if (typeof fetcher !== 'function' || !sessionId) return;
      const myKey = keyRef.current;
      const gen = ++genRef.current;
      const stale = () => keyRef.current !== myKey || genRef.current !== gen;
      const known = force ? undefined : summaryRef.current?.revision;
      setLoadingSummary(true);
      setError('');
      try {
        const prevKnown = knownEpochRef.current.epoch;
        let result = await fetcher({
          profileId,
          sessionId,
          view: 'summary',
          ...(known !== undefined ? { knownRevision: known } : {}),
        });
        if (stale() || !ownerMatchesDirect(result)) return;
        if (result.status === 'unchanged') {
          if (summaryRef.current) {
            const unchangedEpoch = result.epoch ?? result.owner?.epoch;
            const epochAdvanced =
              unchangedEpoch !== undefined &&
              ((prevKnown !== undefined && unchangedEpoch > prevKnown) ||
                (contentRef.current?.epoch !== undefined && unchangedEpoch > contentRef.current.epoch));
            if (unchangedEpoch !== undefined && summaryRef.current.epoch !== unchangedEpoch) {
              commitSummary({ ...summaryRef.current, epoch: unchangedEpoch });
            }
            // QA1-FE-12 / QA2-P0：摘要未变但正文 revision 递增或代次前移时，将已缓存正文标脏并按需重拉
            if (
              contentRef.current &&
              (epochAdvanced ||
                (typeof result.contentRevision === 'number' && result.contentRevision !== contentRef.current.revision))
            ) {
              contentStaleRef.current = true;
              if (contentOpenRef.current) void loadContent(false);
            }
            return;
          }
          result = await fetcher({ profileId, sessionId, view: 'summary' });
          if (stale() || !ownerMatchesDirect(result)) return;
          if (result.status === 'unchanged') result = { ...result, status: 'missing' };
        }
        const resultEpoch = result.epoch ?? result.owner?.epoch;
        const epochAdvanced =
          resultEpoch !== undefined &&
          ((prevKnown !== undefined && resultEpoch > prevKnown) ||
            (contentRef.current?.epoch !== undefined && resultEpoch > contentRef.current.epoch));
        const revision = result.summaryRevision ?? result.revision;
        let outline = result.outline;
        let legacyContent: PlanContentState | null = null;
        if (result.status === 'ready' && !outline && typeof result.content === 'string') {
          // 旧桥接：摘要请求直接返回正文
          outline = outlineFromMarkdown(result.content);
          legacyContent = {
            content: result.content,
            truncated: Boolean(result.truncated),
            revision: result.contentRevision ?? result.revision,
            updatedAt: result.updatedAt,
            ...(resultEpoch !== undefined ? { epoch: resultEpoch } : {}),
          };
        }
        const next: PlanSummaryState = {
          status: result.status,
          ...(outline ? { outline } : {}),
          ...(result.filePath ? { filePath: result.filePath } : {}),
          ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          revision,
          ...(resultEpoch !== undefined ? { epoch: resultEpoch } : {}),
        };
        commitSummary(next);
        let shouldReloadContent = false;
        if (legacyContent) commitContent(legacyContent);
        else if (result.status !== 'ready') commitContent(null);
        else if (
          contentRef.current &&
          (epochAdvanced ||
            (result.contentRevision !== undefined && result.contentRevision !== contentRef.current.revision))
        ) {
          contentStaleRef.current = true;
          shouldReloadContent = true;
        }
        remember(
          baseKeyRef.current,
          next,
          legacyContent ?? (result.status === 'ready' ? contentRef.current : null),
          resultEpoch ?? knownEpochRef.current.epoch ?? epochRef.current
        );
        if (shouldReloadContent && contentOpenRef.current) void loadContent(false);
      } catch (reason) {
        if (!stale()) setError(stripIpcErrorPrefix(reason));
      } finally {
        if (!stale()) setLoadingSummary(false);
      }
    },
    [commitContent, commitSummary, ownerMatchesDirect, profileId, sessionId]
  );

  const contentGenRef = useRef(0);
  const loadContent = useCallback(
    async (force: boolean) => {
      const fetcher = getDesktopBridge().getSessionPlanArtifact;
      if (typeof fetcher !== 'function' || !sessionId) return;
      const myKey = keyRef.current;
      const gen = ++contentGenRef.current;
      const stale = () => keyRef.current !== myKey || contentGenRef.current !== gen;
      const known = force || contentStaleRef.current ? undefined : contentRef.current?.revision;
      setError('');
      setLoadingContent(true);
      try {
        const result = await fetcher({
          profileId,
          sessionId,
          view: 'content',
          ...(known !== undefined ? { knownRevision: known } : {}),
        });
        if (stale() || !ownerMatchesDirect(result)) return;
        if (result.status === 'unchanged' && contentRef.current) return;
        contentStaleRef.current = false;
        if (result.status === 'ready' && typeof result.content === 'string') {
          const contentEpoch = result.epoch ?? result.owner?.epoch;
          const next: PlanContentState = {
            content: result.content,
            truncated: Boolean(result.truncated),
            revision: result.contentRevision ?? result.revision,
            updatedAt: result.updatedAt,
            ...(contentEpoch !== undefined ? { epoch: contentEpoch } : {}),
          };
          commitContent(next);
          if (summaryRef.current) {
            remember(
              baseKeyRef.current,
              summaryRef.current,
              next,
              contentEpoch ?? knownEpochRef.current.epoch ?? epochRef.current
            );
          }
        } else if (result.status !== 'unchanged') {
          commitContent(null);
          if (result.status === 'missing' || result.status === 'unavailable') {
            const contentEpoch = result.epoch ?? result.owner?.epoch;
            commitSummary({
              status: result.status,
              ...(result.reason ? { reason: result.reason } : {}),
              ...(contentEpoch !== undefined ? { epoch: contentEpoch } : {}),
            });
          }
        }
      } catch (reason) {
        if (!stale()) setError(stripIpcErrorPrefix(reason));
      } finally {
        if (!stale()) setLoadingContent(false);
      }
    },
    [commitContent, commitSummary, ownerMatchesDirect, profileId, sessionId]
  );

  // 归属切换：复位并以缓存（若有）作为首帧，随后增量刷新摘要
  useEffect(() => {
    keyRef.current = key;
    genRef.current++;
    contentGenRef.current++;
    // QA2-P0: key 变更时同步重置 knownEpochRef
    knownEpochRef.current = { key, epoch: epochRef.current };
    const rawHit = baseKey ? summaryCache.get(baseKey) : undefined;
    const hit =
      rawHit && !(epochRef.current !== undefined && rawHit.epoch !== undefined && rawHit.epoch !== epochRef.current)
        ? rawHit
        : undefined;
    commitSummary(hit?.summary ?? null);
    commitContent(hit?.content ?? null);
    contentStaleRef.current = false;
    setError('');
    setLoadingSummary(false);
    setLoadingContent(false);
    if (!key || !supported) return;
    void loadSummary(false);
    const unsubscribe = getDesktopBridge().onPlanArtifactChanged?.((event: PlanArtifactChangedEvent) => {
      if (event.sessionId !== sessionId || (event.profileId && event.profileId !== profileId)) return;
      // QA2-P0: 订阅回调严格相等判断（保护 TC-PLAN-15/17/10）
      const activeEpoch = knownEpochRef.current.epoch ?? epochRef.current;
      if (activeEpoch !== undefined && event.epoch !== undefined && event.epoch !== activeEpoch) return;
      const summaryRev = event.summaryRevision ?? event.revision;
      if (summaryRef.current?.revision === undefined || summaryRev !== summaryRef.current.revision) void loadSummary(false);
      const contentRev = event.contentRevision ?? event.revision;
      if (contentRef.current && contentRev !== contentRef.current.revision) {
        contentStaleRef.current = true;
        if (contentOpenRef.current) void loadContent(false);
      }
    });
    return () => {
      keyRef.current = '';
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supported]);

  // 原文抽屉打开时才按需读取正文
  useEffect(() => {
    if (!contentOpen || !key || !supported) return;
    if (contentRef.current && !contentStaleRef.current) return;
    void loadContent(false);
  }, [contentOpen, key, loadContent, supported]);

  const refresh = useCallback(() => {
    void loadSummary(true);
    if (contentOpenRef.current) void loadContent(true);
    else contentStaleRef.current = true;
  }, [loadContent, loadSummary]);

  return {
    supported,
    pending: supported && Boolean(key) && summary === null && !error,
    summary,
    content,
    loadingSummary,
    loadingContent,
    error,
    refresh,
  };
}

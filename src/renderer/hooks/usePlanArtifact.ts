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
}

export interface PlanContentState {
  content: string;
  truncated: boolean;
  revision?: number;
  updatedAt?: string;
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
const summaryCache = new Map<string, { summary: PlanSummaryState; content: PlanContentState | null }>();

function remember(key: string, summary: PlanSummaryState, content: PlanContentState | null): void {
  summaryCache.delete(key);
  summaryCache.set(key, { summary, content });
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

function ownerMatches(result: PlanArtifactSnapshot, profileId: string, sessionId: string, epoch?: number): boolean {
  const owner = result.owner;
  if (owner) {
    if (owner.sessionId && owner.sessionId !== sessionId) return false;
    if (owner.profileId && owner.profileId !== profileId) return false;
  }
  const resultEpoch = result.epoch ?? owner?.epoch;
  return !(epoch !== undefined && resultEpoch !== undefined && resultEpoch !== epoch);
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
  const key = sessionId ? planArtifactKey(profileId, sessionId, epoch) : '';
  const cached = key ? summaryCache.get(key) : undefined;
  const [summary, setSummary] = useState<PlanSummaryState | null>(cached?.summary ?? null);
  const [content, setContent] = useState<PlanContentState | null>(cached?.content ?? null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState('');
  const keyRef = useRef(key);
  const genRef = useRef(0);
  const summaryRef = useRef<PlanSummaryState | null>(summary);
  const contentRef = useRef<PlanContentState | null>(content);
  const contentStaleRef = useRef(false);
  const contentOpenRef = useRef(contentOpen);
  contentOpenRef.current = contentOpen;

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
        let result = await fetcher({
          profileId,
          sessionId,
          view: 'summary',
          ...(known !== undefined ? { knownRevision: known } : {}),
        });
        if (stale() || !ownerMatches(result, profileId, sessionId, epoch)) return;
        if (result.status === 'unchanged') {
          if (summaryRef.current) return;
          result = await fetcher({ profileId, sessionId, view: 'summary' });
          if (stale() || !ownerMatches(result, profileId, sessionId, epoch)) return;
          if (result.status === 'unchanged') result = { ...result, status: 'missing' };
        }
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
          };
        }
        const next: PlanSummaryState = {
          status: result.status,
          ...(outline ? { outline } : {}),
          ...(result.filePath ? { filePath: result.filePath } : {}),
          ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          revision,
        };
        commitSummary(next);
        if (legacyContent) commitContent(legacyContent);
        else if (result.status !== 'ready') commitContent(null);
        else if (contentRef.current && result.contentRevision !== undefined && result.contentRevision !== contentRef.current.revision) {
          contentStaleRef.current = true;
        }
        remember(myKey, next, legacyContent ?? (result.status === 'ready' ? contentRef.current : null));
      } catch (reason) {
        if (!stale()) setError(stripIpcErrorPrefix(reason));
      } finally {
        if (!stale()) setLoadingSummary(false);
      }
    },
    [commitContent, commitSummary, epoch, profileId, sessionId]
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
      setLoadingContent(true);
      try {
        const result = await fetcher({
          profileId,
          sessionId,
          view: 'content',
          ...(known !== undefined ? { knownRevision: known } : {}),
        });
        if (stale() || !ownerMatches(result, profileId, sessionId, epoch)) return;
        if (result.status === 'unchanged' && contentRef.current) return;
        contentStaleRef.current = false;
        if (result.status === 'ready' && typeof result.content === 'string') {
          const next: PlanContentState = {
            content: result.content,
            truncated: Boolean(result.truncated),
            revision: result.contentRevision ?? result.revision,
            updatedAt: result.updatedAt,
          };
          commitContent(next);
          if (summaryRef.current) remember(myKey, summaryRef.current, next);
        } else if (result.status !== 'unchanged') {
          commitContent(null);
          if (result.status === 'missing' || result.status === 'unavailable') {
            commitSummary({ status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
          }
        }
      } catch (reason) {
        if (!stale()) setError(stripIpcErrorPrefix(reason));
      } finally {
        if (!stale()) setLoadingContent(false);
      }
    },
    [commitContent, commitSummary, epoch, profileId, sessionId]
  );

  // 归属切换：复位并以缓存（若有）作为首帧，随后增量刷新摘要
  useEffect(() => {
    keyRef.current = key;
    genRef.current++;
    contentGenRef.current++;
    const hit = key ? summaryCache.get(key) : undefined;
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
      if (epoch !== undefined && event.epoch !== undefined && event.epoch !== epoch) return;
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

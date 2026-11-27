import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, FileText, Link2, RefreshCw } from 'lucide-react';
import type { PlanArtifactSnapshot } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { scrollBehavior } from '../lib/motion';
import { getDesktopBridge } from '../services/desktop-bridge';
import { Icon } from './ui/Icon';

/** 规范化本地路径（去 fragment / `file://` / 反斜杠），用于判断链接是否精准指向当前计划文档本体。 */
function normalizeLocalPathForCompare(raw: string): string {
  const withoutHash = raw.split('#')[0].trim();
  if (!withoutHash) return '';
  let normalized = withoutHash;
  if (/^file:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\//i, '').replace(/^localhost\//i, '/');
    if (/^\/[a-zA-Z]:/.test(normalized)) normalized = normalized.slice(1);
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      /* 保留原始编码串 */
    }
  }
  normalized = normalized.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isPlanArtifactSelfTarget(target: string, filePath?: string): boolean {
  if (!filePath || !target || target.startsWith('#') || /^https?:/i.test(target)) return false;
  const a = normalizeLocalPathForCompare(target);
  const b = normalizeLocalPathForCompare(filePath);
  return Boolean(a && b && a === b);
}

/** 为计划文档标题生成确定性锚点 slug（支持中英文与 Unicode 字母数字）。 */
export function planHeadingSlug(raw: string): string {
  const plain = raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase();
  const slug = plain
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

/**
 * v0.3.5：Plan 页签下方可折叠的只读 `implementation_plan.md` 预览。
 *
 * - 与结构化待办解耦：待办被清空（`plan.state === 'empty'`）不影响文档预览；
 * - 首次与事件驱动刷新携带 `knownRevision`（主进程可回 `unchanged`），手动刷新按钮不传 `knownRevision` 强制重读；
 * - 订阅 `onPlanArtifactChanged`，仅处理同一 `(profileId, sessionId)` 的事件；迟到的旧会话结果按 owner 丢弃；
 * - 自研极简只读渲染：不渲染原始 HTML、不加载任何图片 / 外部 URL；
 *   仅打开计划文档本体（头部打开按钮或精准指向 `snapshot.filePath` 的链接）时携带 `planArtifactOwner`；
 *   文档内嵌外部链接与其它工作区文件走常规 `openLinkOrFileTarget({ target, action, cwd, sessionId })`，`#anchor` 在面板内平滑滚动。
 */
export function PlanArtifactPanel({
  profileId,
  sessionId,
  cwd,
  onStatusChange,
}: {
  profileId: string;
  sessionId: string;
  cwd?: string;
  onStatusChange?: (status: PlanArtifactSnapshot['status'] | 'loading') => void;
}): React.ReactElement | null {
  const { dict } = useI18n();
  const t = dict.ui.v035;
  const uid = useId();
  const [open, setOpen] = useState(true);
  const [snapshot, setSnapshot] = useState<PlanArtifactSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [linkError, setLinkError] = useState('');
  const revisionRef = useRef<number | undefined>(undefined);
  const snapshotRef = useRef<PlanArtifactSnapshot | null>(null);
  const docRef = useRef<HTMLDivElement | null>(null);
  const ownerRef = useRef(`${profileId}\u0000${sessionId}`);
  const bridge = getDesktopBridge();
  const supported = typeof bridge.getSessionPlanArtifact === 'function';

  useEffect(() => {
    if (!supported) {
      onStatusChange?.('missing');
      return;
    }
    onStatusChange?.(snapshot?.status ?? 'loading');
  }, [onStatusChange, snapshot?.status, supported]);

  const load = useCallback(
    async (useKnownRevision: boolean) => {
      const fetcher = getDesktopBridge().getSessionPlanArtifact;
      if (typeof fetcher !== 'function') return;
      const owner = `${profileId}\u0000${sessionId}`;
      setLoading(true);
      setError('');
      try {
        let result = await fetcher({
          profileId,
          sessionId,
          ...(useKnownRevision && revisionRef.current !== undefined ? { knownRevision: revisionRef.current } : {}),
        });
        // 会话已切换：丢弃迟到结果
        if (ownerRef.current !== owner) return;
        if (result.owner && (result.owner.sessionId !== sessionId || (result.owner.profileId && result.owner.profileId !== profileId))) return;
        if (result.status === 'unchanged') {
          if (snapshotRef.current !== null) return;
          // FE-BUG-08：尚未持有快照时收到 unchanged，丢弃 knownRevision 重拉一次；若仍无内容则按空态收口，避免卡在 Loading
          if (useKnownRevision) {
            revisionRef.current = undefined;
            result = await fetcher({ profileId, sessionId });
            if (ownerRef.current !== owner) return;
            if (result.owner && (result.owner.sessionId !== sessionId || (result.owner.profileId && result.owner.profileId !== profileId))) return;
          }
          if (result.status === 'unchanged') {
            const settled: PlanArtifactSnapshot = { ...result, status: 'missing' };
            snapshotRef.current = settled;
            setSnapshot(settled);
            return;
          }
        }
        revisionRef.current = result.revision;
        snapshotRef.current = result;
        setSnapshot(result);
      } catch (reason) {
        if (ownerRef.current === owner) setError(stripIpcErrorPrefix(reason));
      } finally {
        if (ownerRef.current === owner) setLoading(false);
      }
    },
    [profileId, sessionId]
  );

  useEffect(() => {
    ownerRef.current = `${profileId}\u0000${sessionId}`;
    revisionRef.current = undefined;
    snapshotRef.current = null;
    setSnapshot(null);
    setError('');
    setLinkError('');
    void load(true);
    const unsubscribe = getDesktopBridge().onPlanArtifactChanged?.((event) => {
      if (event.sessionId !== sessionId || (event.profileId && event.profileId !== profileId)) return;
      if (revisionRef.current !== undefined && event.revision === revisionRef.current) return;
      void load(true);
    });
    return () => {
      ownerRef.current = '';
      unsubscribe?.();
    };
  }, [load, profileId, sessionId]);

  const openPlanFile = useCallback(async () => {
    const filePath = snapshotRef.current?.filePath;
    if (!filePath) return;
    setLinkError('');
    try {
      await getDesktopBridge().openLinkOrFileTarget({
        target: filePath,
        action: 'default-app',
        ...(cwd ? { cwd } : {}),
        sessionId,
        planArtifactOwner: { profileId, sessionId, revision: revisionRef.current },
      });
    } catch (reason) {
      setLinkError(`${t.planArtifactOpenError}：${stripIpcErrorPrefix(reason)}`);
    }
  }, [cwd, profileId, sessionId, t.planArtifactOpenError]);

  const openLink = useCallback(
    async (target: string) => {
      setLinkError('');
      // FE-BUG-08：文档内 #anchor 直接在面板内滚动定位，不走外部打开 IPC
      if (target.startsWith('#')) {
        let raw = target.slice(1);
        try {
          raw = decodeURIComponent(raw);
        } catch {
          /* 保留原始锚点文本 */
        }
        const normalizedRaw = raw.trim().toLowerCase();
        const slug = planHeadingSlug(raw);
        const headings = docRef.current?.querySelectorAll<HTMLElement>('[data-anchor]');
        const match = headings
          ? Array.from(headings).find((el) => el.dataset.anchor === normalizedRaw || el.dataset.anchor === slug)
          : null;
        if (match && typeof match.scrollIntoView === 'function') {
          match.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
        }
        return;
      }
      // D-01：仅当链接精准指向计划文档本体时携带 planArtifactOwner；外链与工作区其它文件走常规安全打开链路
      const isSelf = isPlanArtifactSelfTarget(target, snapshotRef.current?.filePath);
      try {
        await getDesktopBridge().openLinkOrFileTarget({
          target,
          action: /^https?:/i.test(target) ? 'browser' : 'default-app',
          ...(cwd ? { cwd } : {}),
          sessionId,
          ...(isSelf ? { planArtifactOwner: { profileId, sessionId, revision: revisionRef.current } } : {}),
        });
      } catch (reason) {
        setLinkError(`${t.planArtifactOpenError}：${stripIpcErrorPrefix(reason)}`);
      }
    },
    [cwd, profileId, sessionId, t.planArtifactOpenError]
  );

  if (!supported) return null;
  const bodyId = `${uid}-body`;
  const updated =
    snapshot?.updatedAt && Number.isFinite(Date.parse(snapshot.updatedAt))
      ? new Date(snapshot.updatedAt).toLocaleString()
      : '';

  return (
    <section className="plan-artifact" data-testid="plan-artifact-panel" data-status={snapshot?.status ?? 'loading'}>
      <div className="plan-artifact-head">
        <button
          type="button"
          className="plan-artifact-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          data-testid="plan-artifact-toggle"
        >
          <Icon icon={ChevronDown} size="xs" className={open ? '' : 'is-collapsed'} />
          <Icon icon={FileText} size="xs" />
          <span className="mono truncate">{t.planArtifactTitle}</span>
        </button>
        <span className="badge badge-mono plan-artifact-ro">{t.planArtifactReadonly}</span>
        {snapshot?.status === 'ready' && snapshot.filePath && (
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={() => void openPlanFile()}
            aria-label={t.planArtifactOpenFile}
            title={t.planArtifactOpenFile}
            data-testid="plan-artifact-open-file"
          >
            <Icon icon={ExternalLink} size="xs" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={() => void load(false)}
          disabled={loading}
          aria-label={t.planArtifactRefresh}
          title={t.planArtifactRefresh}
          data-testid="plan-artifact-refresh"
        >
          <Icon icon={RefreshCw} size="xs" className={loading ? 'spin' : ''} />
        </button>
      </div>
      <div className="plan-artifact-body" id={bodyId} hidden={!open}>
        {error ? (
          <p role="alert" className="plan-artifact-msg is-error">
            {t.planArtifactUnavailable(error)}
          </p>
        ) : !snapshot ? (
          <p className="plan-artifact-msg">{t.planArtifactLoading}</p>
        ) : snapshot.status === 'missing' ? (
          <p className="plan-artifact-msg" data-testid="plan-artifact-missing">
            {t.planArtifactMissing}
          </p>
        ) : snapshot.status === 'unavailable' ? (
          <p className="plan-artifact-msg is-warn" data-testid="plan-artifact-unavailable">
            {t.planArtifactUnavailable(snapshot.reason ?? '')}
          </p>
        ) : (
          <>
            {updated && <p className="plan-artifact-meta">{t.planArtifactUpdated(updated)}</p>}
            <PlanDocument text={snapshot.content ?? ''} onOpenLink={openLink} idPrefix={uid} docRef={docRef} />
            {snapshot.truncated && <p className="plan-artifact-msg is-warn">{t.planArtifactTruncated}</p>}
          </>
        )}
        {linkError && (
          <p role="alert" className="plan-artifact-msg is-error">
            {linkError}
          </p>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * 极简只读 Markdown：标题 / 段落 / 列表 / 任务框 / 引用 / 围栏代码 / 行内代码 / 粗体 / 链接；
 * 绝不渲染原始 HTML，绝不发起图片或 URL 请求。
 * ------------------------------------------------------------------------- */

function renderInline(text: string, onOpenLink: (target: string) => void, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[3] !== undefined) {
      const isImage = m[1] === '!';
      const label = m[2] || m[3];
      const target = m[3];
      out.push(
        <button
          key={key}
          type="button"
          className={`plan-doc-link${isImage ? ' is-image' : ''}`}
          title={target}
          onClick={() => onOpenLink(target)}
        >
          {isImage && <Icon icon={Link2} size="xs" />}
          <span>{label}</span>
        </button>
      );
    } else if (m[4] !== undefined) {
      out.push(<code key={key}>{m[4]}</code>);
    } else if (m[5] !== undefined) {
      out.push(<strong key={key}>{m[5]}</strong>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function PlanDocument({
  text,
  onOpenLink,
  idPrefix,
  docRef,
}: {
  text: string;
  onOpenLink: (target: string) => void;
  idPrefix?: string;
  docRef?: React.Ref<HTMLDivElement>;
}): React.ReactElement {
  const fallbackId = useId();
  const prefix = idPrefix ?? fallbackId;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  const slugCounts = new Map<string, number>();
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i += 1;
      blocks.push(
        <pre key={k++} className="plan-doc-code" tabIndex={0}>
          <code>{body.join('\n')}</code>
        </pre>
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      const Tag = `h${level}` as 'h3';
      const baseSlug = planHeadingSlug(heading[2]);
      const seen = slugCounts.get(baseSlug) ?? 0;
      slugCounts.set(baseSlug, seen + 1);
      const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;
      blocks.push(
        <Tag key={k++} id={`${prefix}-h-${slug}`} data-anchor={slug} className="plan-doc-h">
          {renderInline(heading[2], onOpenLink, `h${k}`)}
        </Tag>
      );
      i += 1;
      continue;
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      const ordered = /^\s*\d+[.)]/.test(line);
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(raw);
        const indent = lines[i].length - lines[i].trimStart().length;
        items.push(
          <li
            key={i}
            className={task ? `plan-doc-task${task[1] !== ' ' ? ' is-done' : ''}` : undefined}
            data-indent={indent ? Math.min(4, Math.floor(indent / 2)) : undefined}
          >
            {task && <span className="plan-doc-check" aria-hidden="true">{task[1] !== ' ' ? '☑' : '☐'}</span>}
            {renderInline(task ? task[2] : raw, onOpenLink, `li${i}`)}
          </li>
        );
        i += 1;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={k++}>{renderInline(quote.join(' '), onOpenLink, `q${k}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s+|\s*>|\s*(`{3,}|~{3,}))/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{renderInline(para.join(' '), onOpenLink, `p${k}`)}</p>);
  }
  return (
    <div ref={docRef} className="plan-doc" data-testid="plan-artifact-document">
      {blocks}
    </div>
  );
}

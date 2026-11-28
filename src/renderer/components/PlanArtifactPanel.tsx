import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleCheck, Circle, ExternalLink, Info, Link2, RefreshCw, TriangleAlert, Workflow } from 'lucide-react';
import type { PlanArtifactOwner } from '@shared';
import { countFenceLines } from '../lib/plan-view';
import { PlanTimeline } from './PlanTimeline';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { scrollBehavior } from '../lib/motion';
import { isImeComposing } from '../lib/platform-keys';
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

export function isPlanArtifactSelfTarget(target: string, filePath?: string): boolean {
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
 * v0.3.6：按需打开的计划原文抽屉（纯展示组件，数据由 `usePlanArtifact` 提供）。
 *
 * - 刷新按钮位于抽屉内；外部打开计划文档本体时携带 `planArtifactOwner`；
 * - 文档内嵌外部链接与其它工作区文件走常规 `openLinkOrFileTarget`，`#anchor` 在抽屉内平滑滚动；
 * - Mermaid 围栏折叠为「流程图（N 行）」，`> [!IMPORTANT]` 等渲染为提示框；代码块自身横向滚动，抽屉 0 横向溢出。
 */
export function PlanSourceDrawer({
  profileId,
  sessionId,
  epoch,
  cwd,
  filePath,
  revision,
  content,
  truncated,
  updatedAt,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  profileId: string;
  sessionId: string;
  epoch?: number;
  cwd?: string;
  filePath?: string;
  revision?: number;
  content: string | null;
  truncated?: boolean;
  updatedAt?: string;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onClose: () => void;
}): React.ReactElement {
  const { dict } = useI18n();
  const t = dict.ui.v035;
  const t6 = dict.ui.v036;
  const uid = useId();
  const docRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [linkError, setLinkError] = useState('');
  const owner = { profileId, sessionId, ...(epoch !== undefined ? { epoch } : {}), revision, contentRevision: revision };

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
      if (document.querySelector('dialog[open], [aria-modal="true"], .target-context-menu, .selection-floating-bar')) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const openLink = useCallback(
    async (target: string) => {
      setLinkError('');
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
      const isSelf = isPlanArtifactSelfTarget(target, filePath);
      try {
        await getDesktopBridge().openLinkOrFileTarget({
          target,
          action: /^https?:/i.test(target) ? 'browser' : 'default-app',
          ...(cwd ? { cwd } : {}),
          sessionId,
          ...(isSelf ? { planArtifactOwner: owner } : {}),
        });
      } catch (reason) {
        setLinkError(`${t.planArtifactOpenError}：${stripIpcErrorPrefix(reason)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd, filePath, profileId, sessionId, epoch, revision, t.planArtifactOpenError]
  );

  const updated = formatPlanTime(updatedAt);
  return (
    <section
      className="plan-drawer"
      data-testid="plan-source-drawer"
      aria-label={t6.planDrawerTitle}
    >
      <div className="plan-drawer-head">
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label={t6.planDrawerClose} title={t6.planDrawerClose} data-testid="plan-source-close">
          <Icon icon={ChevronLeft} size="sm" />
        </button>
        <span className="plan-drawer-title truncate">{t6.planDrawerTitle}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onRefresh} disabled={loading} aria-label={t.planArtifactRefresh} title={t.planArtifactRefresh} data-testid="plan-artifact-refresh">
          <Icon icon={RefreshCw} size="sm" className={loading ? 'spin' : undefined} />
        </button>
        {filePath && (
          <button type="button" className="icon-btn" onClick={() => void openPlanArtifactExternally({ filePath, cwd, sessionId, owner }).catch((r) => setLinkError(`${t.planArtifactOpenError}：${stripIpcErrorPrefix(r)}`))} aria-label={t.planArtifactOpenFile} title={t.planArtifactOpenFile} data-testid="plan-artifact-open-file">
            <Icon icon={ExternalLink} size="sm" />
          </button>
        )}
      </div>
      {updated && <p className="plan-drawer-meta">{t6.planUpdated(updated)}</p>}
      {error ? (
        <p role="alert" className="plan-drawer-msg is-error">{t.planArtifactUnavailable(error)}</p>
      ) : content === null ? (
        <p className="plan-drawer-msg">{t6.planLoadingSource}</p>
      ) : (
        <PlanDocument text={content} onOpenLink={openLink} idPrefix={uid} docRef={docRef} />
      )}
      {truncated && <p className="plan-drawer-msg is-warn">{t.planArtifactTruncated}</p>}
      {linkError && <p role="alert" className="plan-drawer-msg is-error">{linkError}</p>}
    </section>
  );
}

export function formatPlanTime(iso?: string): string {
  return iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : '';
}

/** 外部打开计划文档本体（携带 `planArtifactOwner` 供主进程核验归属）。 */
export async function openPlanArtifactExternally({
  filePath,
  cwd,
  sessionId,
  owner,
}: {
  filePath: string;
  cwd?: string;
  sessionId: string;
  owner: PlanArtifactOwner;
}): Promise<void> {
  await getDesktopBridge().openLinkOrFileTarget({
    target: filePath,
    action: 'default-app',
    ...(cwd ? { cwd } : {}),
    sessionId,
    planArtifactOwner: owner,
  });
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

const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/;

function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  const header = lines[idx];
  const sep = lines[idx + 1];
  return header.includes('|') && TABLE_SEP_RE.test(sep) && sep.includes('-');
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
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
  const { dict } = useI18n();
  const calloutTitles = dict.ui.v035.calloutTitle;
  const mermaidLabel = dict.ui.v036.planMermaid;
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
      const lang = line.trim().slice(fence[1].length).trim().toLowerCase();
      const pre = (
        <pre className="plan-doc-code" tabIndex={0}>
          <code>{body.join('\n')}</code>
        </pre>
      );
      blocks.push(
        lang === 'mermaid' ? (
          <details key={k++} className="plan-doc-fold" data-testid="plan-doc-mermaid">
            <summary>
              <Icon icon={ChevronRight} size="xs" className="plan-doc-fold-chev" />
              <Icon icon={Workflow} size="xs" />
              <span>{mermaidLabel(countFenceLines(body))}</span>
            </summary>
            {pre}
          </details>
        ) : (
          <React.Fragment key={k++}>{pre}</React.Fragment>
        )
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
            style={indent ? ({ '--indent': Math.min(4, Math.floor(indent / 2)) } as React.CSSProperties) : undefined}
          >
            {task && <Icon icon={task[1] !== ' ' ? CircleCheck : Circle} size="xs" className="plan-doc-check" />}
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
      const callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(quote[0] ?? '');
      if (callout) {
        const kind = callout[1].toLowerCase() as "note" | "tip" | "important" | "warning" | "caution";
        blocks.push(
          <div key={k++} className={`plan-doc-callout is-${kind}`} role="note" data-testid={`plan-doc-callout-${kind}`}>
            <span className="plan-doc-callout-title">
              <Icon icon={kind === 'warning' || kind === 'caution' ? TriangleAlert : Info} size="xs" />
              {calloutTitles[kind]}
            </span>
            <p>{renderInline(quote.slice(1).join(' '), onOpenLink, `c${k}`)}</p>
          </div>
        );
        continue;
      }
      blocks.push(<blockquote key={k++}>{renderInline(quote.join(' '), onOpenLink, `q${k}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i++]));
      }
      const tableKey = k++;
      blocks.push(
        <div key={tableKey} className="md-table-wrap" tabIndex={0}>
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, ci) => (
                  <th key={ci}>{renderInline(h, onOpenLink, `th${tableKey}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci}>{renderInline(row[ci] ?? '', onOpenLink, `td${tableKey}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isTableStart(lines, i) &&
      !/^(#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s+|\s*>|\s*(`{3,}|~{3,}))/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={k++}>{renderInline(para.join(' '), onOpenLink, `p${k}`)}</p>);
  }
  return (
    <div ref={docRef} className="plan-doc" data-testid="plan-artifact-document">
      {blocks}
    </div>
  );
}

/**
 * @deprecated v0.3.6 兼容导出：旧单体面板已拆分为 `PlanTimeline`（四态 + 摘要）与 `PlanSourceDrawer`（按需原文）。
 * 仅为旧调用方保留签名；正文只在用户打开「查看原文」抽屉后读取。
 */
export function PlanArtifactPanel(props: {
  profileId: string;
  sessionId: string;
  cwd?: string;
  onStatusChange?: (status: string) => void;
}): React.ReactElement {
  return <PlanTimeline profileId={props.profileId} sessionId={props.sessionId} cwd={props.cwd} plan={undefined} todos={[]} />;
}

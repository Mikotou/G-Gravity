import { getComponentCopy } from '../i18n/domains/copy';
import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Clock, Gauge, RefreshCw } from 'lucide-react';
import type { AccountQuotaUnavailableReason, QuotaBucket } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { accountQuotaFeed, QUOTA_PROFILE_SWITCHED } from '../lib/account-quota-feed';
import { Icon } from './ui/Icon';
import { isImeComposing } from '../lib/platform-keys';

function bucketLabel(id: string, zh: boolean) {
  const match = /^(gemini|3p)-(5h|weekly)$/i.exec(id);
  if (!match) return id;
  const model = match[1].toLowerCase() === '3p' ? (getComponentCopy(zh).thirdParty) : 'Gemini';
  const period = match[2].toLowerCase() === '5h' ? (getComponentCopy(zh).label5hWindow) : (getComponentCopy(zh).weekly);
  return model + ' · ' + period;
}

type QuotaLevel = 'high' | 'mid' | 'low' | 'empty' | 'unknown';

const unavailableText: Record<AccountQuotaUnavailableReason, [string, string]> = {
  platform: ['此平台暂不支持自动读取额度。在终端运行 agy，然后输入 /usage 查看。', 'Automatic quota readings are unavailable on this platform. Run agy in a terminal and enter /usage.'],
  profile: ['当前官方 CLI 只提供默认登录资料的额度。终端里的 agy → /usage 显示默认资料的额度。', 'The official CLI reports quota for its default sign-in only. Running agy and entering /usage in a terminal shows that default account.'],
  helper: ['此安装缺少 macOS 额度读取组件。在终端运行 agy，然后输入 /usage 查看。', 'The macOS quota reader is unavailable in this installation. Run agy in a terminal and enter /usage.'],
  preview: ['请在 G-Gravity 桌面端查看额度，或在终端运行 agy 后输入 /usage。', 'Open G-Gravity on the desktop to view quota, or run agy in a terminal and enter /usage.'],
};

function resolveQuotaLevel(bucket?: QuotaBucket): QuotaLevel {
  if (!bucket || bucket.disabled) return 'unknown';
  if (bucket.remainingFraction === undefined) return 'unknown';
  if (bucket.remainingFraction <= 0.05) return 'empty';
  if (bucket.remainingFraction <= 0.2) return 'low';
  if (bucket.remainingFraction <= 0.5) return 'mid';
  return 'high';
}

export function AccountQuotaFooter({ profileId, generating = false, children }: {
  profileId: string; generating?: boolean; children?: React.ReactNode;
}) {
  const { locale , dict} = useI18n();
  const zh = locale === 'zh-CN';
  const label = dict.ui.copy.accountQuota;
  const feed = accountQuotaFeed(profileId);
  const { quota, loading, error, unavailable } = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const [mode, setMode] = useState<'closed' | 'preview' | 'pinned'>('closed');
  const open = mode !== 'closed';
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const wasGenerating = useRef(generating);
  useEffect(() => {
    if (wasGenerating.current && !generating) feed.afterTurn();
    wasGenerating.current = generating;
  }, [feed, generating]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!lastTrigger.current?.contains(target) && !root.current?.querySelector('.quota-view')?.contains(target)) setMode('closed');
    };
    // F-02：额度弹层的 Esc 只关闭弹层本身。在捕获阶段截住并停止传播，避免 Composer / 窗格级 Esc 同时中断进行中的回合。
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (root.current?.querySelector('.quota-view')?.contains(document.activeElement)) lastTrigger.current?.focus();
      setMode('closed');
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  function preview(button: HTMLButtonElement) {
    lastTrigger.current = button;
    setMode(previous => previous === 'pinned' ? previous : 'preview');
    void feed.attend();
  }

  function amount(bucket?: QuotaBucket) {
    if (bucket?.disabled) return dict.ui.copy.disabled;
    if (bucket?.remainingFraction !== undefined) {
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bucket.remainingFraction);
    }
    return bucket?.remainingAmount?.toLocaleString(locale) ?? '—';
  }

  const weeklyBucket = quota?.buckets.find(bucket => bucket.id.toLowerCase() === 'gemini-weekly');
  const weekly = amount(weeklyBucket);
  const weeklyLevel = resolveQuotaLevel(weeklyBucket);
  const weeklyPct =
    weeklyBucket && !weeklyBucket.disabled && weeklyBucket.remainingFraction !== undefined
      ? Math.min(100, Math.max(0, weeklyBucket.remainingFraction * 100))
      : null;

  // 非法 / 缺失的 ISO 时间显示为空，而不是「Invalid Date」。
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
  };

  const trigger = {
    type: 'button' as const,
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) => { if (e.pointerType !== 'touch') preview(e.currentTarget); },
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => preview(e.currentTarget),
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      lastTrigger.current = e.currentTarget;
      setMode(previous => previous === 'pinned' ? 'closed' : 'pinned');
      if (mode !== 'pinned') void feed.attend();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      lastTrigger.current = e.currentTarget;
      setMode('pinned');
      void feed.attend();
      window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.quota-view')?.focus());
    },
  };

  return (
    <div
      ref={root}
      className="quota-footer"
      data-quota-open={open}
      onPointerLeave={e => { if (e.pointerType !== 'touch') setMode(previous => previous === 'preview' ? 'closed' : previous); }}
      onBlur={e => {
        // 焦点被浏览器丢到 body（relatedTarget 为空）且浮层内元素仍在文档中时，不视为用户主动离开固定浮层。
        if (e.relatedTarget === null && mode === 'pinned' && e.currentTarget.contains(e.target as Node)) {
          const host = e.currentTarget;
          window.requestAnimationFrame(() => {
            if (!host.isConnected) return;
            if (document.activeElement === document.body || document.activeElement === null) {
              host.querySelector<HTMLElement>('.quota-view')?.focus();
            } else if (!host.contains(document.activeElement)) {
              setMode('closed');
            }
          });
          return;
        }
        if (!e.currentTarget.contains(e.relatedTarget)) setMode('closed');
      }}
    >
      {children}
      <button
        {...trigger}
        className={`quota-weekly level-${weeklyLevel}`}
        aria-label={`${label}: ${dict.ui.copy.geminiWeekly} ${weekly}`}
        data-testid="quota-weekly"
      >
        <Icon icon={Gauge} size="xs" className="quota-pill-icon" />
        <span className="quota-weekly-label">{dict.ui.copy.geminiWeekly}</span>
        <span
          className={`quota-mini-bar level-${weeklyLevel}`}
          aria-hidden="true"
          data-testid="quota-weekly-bar"
          data-quota-level={weeklyLevel}
        >
          <span style={{ '--fill': (weeklyPct === null ? 0 : Math.max(weeklyPct > 0 ? 3 : 0, weeklyPct)) / 100 } as React.CSSProperties} />
        </span>
        <strong className={`quota-weekly-pct level-${weeklyLevel}`}>{weekly}</strong>
      </button>

      {open && (
        <section
          id={id}
          tabIndex={-1}
          className="quota-view"
          aria-label={label}
          aria-busy={loading}
          data-testid="quota-details"
        >
          <header className="quota-view-head">
            <div className="quota-view-title-wrap">
              <span className="quota-view-icon" aria-hidden="true">
                <Icon icon={Gauge} size="sm" />
              </span>
              <div className="quota-view-heading">
                <div className="quota-view-title-row">
                  <h3>{label}</h3>
                  {quota?.plan && <span className="quota-plan-pill">{quota.plan}</span>}
                </div>
                {quota && (
                  <p className="quota-updated-at">
                    {dict.ui.copy.updated}
                    {date(quota.checkedAt)}
                  </p>
                )}
              </div>
            </div>
            {!unavailable && <button
              type="button"
              className={`btn btn-ghost btn-sm quota-refresh-btn${loading ? ' is-busy' : ''}`}
              // FE-03：不用原生 disabled。按钮被禁用时 Chromium 会让焦点以 relatedTarget=null 离开，
              // 触发外层 onBlur 立即关闭固定浮层；改为 aria-disabled + 点击防重入，焦点留在按钮上。
              aria-disabled={loading || undefined}
              data-testid="quota-refresh-btn"
              onClick={() => {
                if (loading) return;
                void feed.manual();
              }}
            >
              <Icon icon={RefreshCw} size="xs" className={loading ? 'spin' : undefined} />
              <span>{dict.ui.copy.refresh}</span>
            </button>}
          </header>

          {loading && !quota && (
            <p className="quota-state-note" role="status">
              {dict.ui.copy.readingOfficialQuota}
            </p>
          )}
          {unavailable && <p className="quota-state-note" role="status">{unavailableText[unavailable][zh ? 0 : 1]}</p>}
          {error && (
            <p className="quota-state-error" role="alert">
              {/* 两种语言都保留具体失败原因，并附上可执行的排查指引。 */}
              {error === QUOTA_PROFILE_SWITCHED
                ? (dict.ui.copy.theAccountChangedReopenTo)
                : dict.ui.copy.fmtCouldNotReadOfficial(error.replace(/[。.]\s*$/, ''))}
            </p>
          )}

          {quota && (
            <div className="quota-buckets">
              {quota.buckets.map(bucket => {
                const level = resolveQuotaLevel(bucket);
                const frac = !bucket.disabled && bucket.remainingFraction !== undefined
                  ? Math.min(1, Math.max(0, bucket.remainingFraction))
                  : null;
                return (
                  <article
                    key={bucket.id}
                    className={`quota-bucket-card level-${level}`}
                    title={bucket.id}
                    data-testid="quota-bucket"
                  >
                    <header>
                      <strong>{bucketLabel(bucket.id, zh)}</strong>
                      <span className={`quota-pct level-${level}`}>{amount(bucket)}</span>
                    </header>
                    {frac !== null && (
                      <progress
                        className={`quota-progress level-${level}`}
                        value={frac}
                        max={1}
                        aria-label={dict.ui.copy.remainingQuota}
                      />
                    )}
                    {bucket.resetAt && (
                      <small className="quota-reset">
                        <Icon icon={Clock} size="xs" />
                        <span>{dict.ui.copy.resets}{date(bucket.resetAt)}</span>
                      </small>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

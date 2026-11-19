import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Clock, Gauge, RefreshCw } from 'lucide-react';
import type { QuotaBucket } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { accountQuotaFeed } from '../lib/account-quota-feed';

function bucketLabel(id: string, zh: boolean) {
  const match = /^(gemini|3p)-(5h|weekly)$/i.exec(id);
  if (!match) return id;
  const model = match[1].toLowerCase() === '3p' ? (zh ? '第三方模型' : 'Third-party') : 'Gemini';
  const period = match[2].toLowerCase() === '5h' ? (zh ? '5 小时' : '5h window') : (zh ? '每周' : 'Weekly');
  return model + ' · ' + period;
}

type QuotaLevel = 'high' | 'mid' | 'low' | 'empty' | 'unknown';

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
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const label = zh ? '账户额度' : 'Account quota';
  const feed = accountQuotaFeed(profileId);
  const { quota, loading, error } = useSyncExternalStore(feed.subscribe, feed.snapshot);
  const [open, setOpen] = useState(false);
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
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (root.current?.querySelector('.quota-view')?.contains(document.activeElement)) lastTrigger.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function show(button: HTMLButtonElement) {
    lastTrigger.current = button;
    setOpen(true);
    void feed.attend();
  }

  function amount(bucket?: QuotaBucket) {
    if (bucket?.disabled) return zh ? '未启用' : 'Disabled';
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

  const date = (iso: string) =>
    new Date(iso).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const trigger = {
    type: 'button' as const,
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onPointerEnter: (e: React.PointerEvent<HTMLButtonElement>) => { if (e.pointerType !== 'touch') show(e.currentTarget); },
    onFocus: (e: React.FocusEvent<HTMLButtonElement>) => show(e.currentTarget),
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => show(e.currentTarget),
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      show(e.currentTarget);
      window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.quota-view')?.focus());
    },
  };

  return (
    <div
      ref={root}
      className="quota-footer"
      onPointerLeave={e => { if (e.pointerType !== 'touch') setOpen(false); }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    >
      {children}
      <button
        {...trigger}
        className={`quota-weekly level-${weeklyLevel}`}
        aria-label={`${label}: ${zh ? 'Gemini 周额度' : 'Gemini weekly'} ${weekly}`}
        data-testid="quota-weekly"
      >
        <Gauge size={11} className="quota-pill-icon" aria-hidden="true" />
        <span className="quota-weekly-label">{zh ? 'Gemini 周额度' : 'Gemini weekly'}</span>
        <span
          className={`quota-mini-bar level-${weeklyLevel}`}
          aria-hidden="true"
          data-testid="quota-weekly-bar"
          data-quota-level={weeklyLevel}
        >
          <span style={{ width: `${weeklyPct === null ? 0 : Math.max(weeklyPct > 0 ? 3 : 0, weeklyPct)}%` }} />
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
                <Gauge size={13} />
              </span>
              <div className="quota-view-heading">
                <div className="quota-view-title-row">
                  <h3>{label}</h3>
                  {quota?.plan && <span className="quota-plan-pill">{quota.plan}</span>}
                </div>
                {quota && (
                  <p className="quota-updated-at">
                    {zh ? '更新于 ' : 'Updated '}
                    {date(quota.checkedAt)}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm quota-refresh-btn"
              disabled={loading}
              onClick={() => void feed.manual()}
            >
              <RefreshCw size={12} className={loading ? 'spin' : undefined} />
              <span>{zh ? '刷新' : 'Refresh'}</span>
            </button>
          </header>

          {loading && !quota && (
            <p className="quota-state-note" role="status">
              {zh ? '正在读取官方额度…' : 'Reading official quota…'}
            </p>
          )}
          {error && (
            <p className="quota-state-error" role="alert">
              {zh
                ? error
                : profileId === 'default'
                  ? 'Could not refresh official quota. Check sign-in and try again.'
                  : 'The installed CLI reports quota for its default sign-in only.'}
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
                        aria-label={zh ? '剩余额度' : 'Remaining quota'}
                      />
                    )}
                    {bucket.resetAt && (
                      <small className="quota-reset">
                        <Clock size={10} aria-hidden="true" />
                        <span>{zh ? '重置于 ' : 'Resets '}{date(bucket.resetAt)}</span>
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

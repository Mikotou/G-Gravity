import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import type { QuotaBucket } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { accountQuotaFeed } from '../lib/account-quota-feed';

function bucketLabel(id: string, zh: boolean) {
  const match = /^(gemini|3p)-(5h|weekly)$/i.exec(id);
  if (!match) return id;
  const model = match[1].toLowerCase() === '3p' ? (zh ? '第三方模型' : 'Third-party models') : 'Gemini';
  const period = match[2].toLowerCase() === '5h' ? (zh ? '5 小时' : '5 hours') : (zh ? '每周' : 'Weekly');
  return model + ' · ' + period;
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

  const weekly = amount(quota?.buckets.find(bucket => bucket.id.toLowerCase() === 'gemini-weekly'));
  const date = (iso: string) => new Date(iso).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  return <div ref={root} className="quota-footer"
    onPointerLeave={e => { if (e.pointerType !== 'touch') setOpen(false); }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button {...trigger} className="quota-trigger" aria-label={label} data-testid="quota-trigger">
      <Gauge size={13} /><span>{zh ? '额度' : 'Quota'}</span>
    </button>
    {children}
    <button {...trigger} className="quota-weekly" data-testid="quota-weekly">
      <span>{zh ? 'Gemini 周额度' : 'Gemini weekly'}</span><strong>{weekly}</strong>
    </button>
    {open && <section id={id} tabIndex={-1} className="quota-view" aria-label={label} aria-busy={loading} data-testid="quota-details">
      <header><h3>{label}</h3>
        <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void feed.manual()}>
          <RefreshCw size={12} />{zh ? '刷新' : 'Refresh'}
        </button>
      </header>
      {loading && <p role="status">{zh ? '正在读取官方额度…' : 'Reading official quota…'}</p>}
      {error && <p role="alert">{zh ? error : profileId === 'default'
        ? 'Could not refresh official quota. Check sign-in and try again.' : 'The installed CLI reports quota for its default sign-in only.'}</p>}
      {quota && <>
        <p>{quota.plan && <strong>{quota.plan} · </strong>}{zh ? '上次更新 ' : 'Last updated '}{date(quota.checkedAt)}</p>
        <div className="quota-buckets">{quota.buckets.map(bucket => <article key={bucket.id} title={bucket.id} data-testid="quota-bucket">
          <header><strong>{bucketLabel(bucket.id, zh)}</strong><span>{amount(bucket)}</span></header>
          {!bucket.disabled && bucket.remainingFraction !== undefined &&
            <progress value={bucket.remainingFraction} max={1} aria-label={zh ? '剩余额度' : 'Remaining quota'} />}
          {bucket.resetAt && <small>{zh ? '重置于 ' : 'Resets '}{date(bucket.resetAt)}</small>}
        </article>)}</div>
      </>}
    </section>}
  </div>;
}

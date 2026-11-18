import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AccountQuota } from '@shared';
import { getDesktopBridge } from '../services/desktop-bridge';
import { useI18n } from '../i18n/I18nContext';

function bucketLabel(id: string, zh: boolean) {
  const match = /^(gemini|3p)-(5h|weekly)$/i.exec(id);
  if (!match) return id;
  const model = match[1] === '3p' ? (zh ? '第三方模型' : 'Third-party models') : 'Gemini';
  const period = match[2] === '5h' ? (zh ? '5 小时' : '5 hours') : (zh ? '每周' : 'Weekly');
  return model + ' · ' + period;
}
export function AccountQuotaView({ profileId }: { profileId: string }) {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const [quota, setQuota] = useState<AccountQuota>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    let current = true;
    pending.current = true;
    setBusy(true); setError('');
    getDesktopBridge().getAccountQuota().then(data => {
      if (current && data.profileId === profileId) setQuota(data);
    }, reason => {
      if (current) setError(zh ? (reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(reason))
        : profileId === 'default' ? 'The official client returned no quota for this profile. Check sign-in and refresh.'
        : 'The installed CLI can report quota only for its default sign-in.');
    }).finally(() => { if (current) { setBusy(false); pending.current = false; } });
    return () => { current = false; };
  }, [profileId, refresh, zh]);
  const date = (iso: string) => new Date(iso).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <section className="quota-view" data-testid="inspector-view-quota" aria-busy={busy}>
    <header><h3>{zh ? '账户额度' : 'Account quota'}</h3>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { if (!pending.current) setRefresh(n => n + 1); }}>
        <RefreshCw size={12} /> {zh ? '刷新' : 'Refresh'}</button></header>
    {busy && <p role="status">{zh ? '正在读取官方额度…' : 'Reading official quota…'}</p>}
    {error && <p role="alert">{error}</p>}
    {quota && <>
      <p>{quota.plan && <strong>{quota.plan} · </strong>}{zh ? '上次更新 ' : 'Last updated '}{date(quota.checkedAt)}</p>
      {quota.buckets.map(b => <article key={b.id} title={b.id} data-testid="quota-bucket">
        <header><strong>{bucketLabel(b.id, zh)}</strong>
          <span>{b.disabled ? (zh ? '未启用' : 'Disabled') : b.remainingFraction !== undefined ?
            new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(b.remainingFraction) : b.remainingAmount?.toLocaleString(locale)}</span></header>
        {!b.disabled && b.remainingFraction !== undefined && <progress value={b.remainingFraction} max={1} aria-label={zh ? '剩余额度' : 'Remaining quota'} />}
        <small>{zh ? '剩余额度' : 'Remaining quota'}{b.resetAt && ' · ' + (zh ? '重置于 ' : 'Resets ') + date(b.resetAt)}</small>
      </article>)}
    </>}
  </section>;
}

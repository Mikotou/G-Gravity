import React, { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, FolderGit2, Lock, X } from 'lucide-react';
import type { ImportedHistoryDetail, ThoughtDisplayTrack } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { ImageWorkspace } from './MessageImage';
import { Markdown } from './Markdown';
import { SentAnnotations } from './SentAnnotations';
import { getDesktopBridge } from '../services/desktop-bridge';
import { ThinkingBlock } from './ThinkingBlock';

export interface ReadOnlyHistoryViewProps {
  detail: ImportedHistoryDetail;
  defaultThoughtTrack?: ThoughtDisplayTrack;
  onContinueInGravity: (importedSessionId: string, cwd: string) => Promise<void>;
  onCloseHistoryView: () => void;
}

export function ImportedHistoryPane({ id, ...props }: Omit<ReadOnlyHistoryViewProps, 'detail'> & { id: string }) {
  const [detail, setDetail] = useState<ImportedHistoryDetail>();
  const [error, setError] = useState('');
  const { dict } = useI18n();
  useEffect(() => {
    let active = true;
    getDesktopBridge().getImportedHistoryDetail(id).then(value => { if (active) setDetail(value); })
      .catch(reason => { if (active) setError(formatActionError(reason, dict)); });
    return () => { active = false; };
  }, [id, dict]);
  if (detail) return <ReadOnlyHistoryView detail={detail} {...props} />;
  return <div className="pane" aria-busy={!error}>{error ? <div role="alert">{error}</div> : dict.bootstrapLoading}</div>;
}

export function ReadOnlyHistoryView({
  detail,
  defaultThoughtTrack = 'zh',
  onContinueInGravity,
  onCloseHistoryView,
}: ReadOnlyHistoryViewProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const [continuing, setContinuing] = useState(false);
  const [targetCwd, setTargetCwd] = useState(detail.cwd || '');
  const [error, setError] = useState<string | null>(null);

  // 切换到另一条历史记录时，把续聊目录恢复为该记录的目录，并清除上一条记录的错误提示。
  useEffect(() => {
    setTargetCwd(detail.cwd || '');
    setError(null);
  }, [detail.sessionId, detail.cwd]);

  /** 续聊提交导入 ID 和目标目录，后端据此创建新会话。工作目录缺失的历史可在此视图手工补入。 */
  async function handleContinue(): Promise<void> {
    if (continuing) return;
    setContinuing(true);
    setError(null);
    try {
      await onContinueInGravity(detail.sessionId, targetCwd.trim());
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setContinuing(false);
    }
  }

  return (
    <section className="pane" style={{ flex: 1 }} data-testid={`readonly-history-view-${detail.sessionId}`}>
      <header className="pane-header" style={{ borderBottom: '1px solid var(--border-subtle)', height: 46 }}>
        <BookOpen size={14} className="muted" />
        <span className="pane-title truncate" title={detail.title}>
          {detail.title}
        </span>
        <span
          className="badge badge-warning"
          title={`${dict.readOnlyBannerDesc}\n${detail.sourcePath}`}
          data-testid="history-readonly-badge"
        >
          <Lock size={10} />
          {dict.readOnlyBadge}
        </span>
        {detail.cwd ? (
          <span className="pane-sub truncate" title={detail.cwd}>
            <FolderGit2 size={11} />
            <span className="truncate">{detail.cwd}</span>
          </span>
        ) : (
          <input
            className="input mono"
            style={{ width: 200, height: 26, fontSize: 11.5 }}
            value={targetCwd}
            onChange={(e) => setTargetCwd(e.target.value)}
            placeholder={locale === 'zh-CN' ? '续聊工作区路径（留空用主目录）' : 'Workspace path (optional)'}
            aria-label="Workspace path"
          />
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={continuing}
          onClick={() => void handleContinue()}
          data-testid="continue-in-gravity-btn"
        >
          <span>{continuing ? dict.continuingInGravity : dict.continueInGravityBtn}</span>
          <ArrowRight size={13} />
        </button>
        <button type="button" className="icon-btn" onClick={onCloseHistoryView} aria-label={dict.closeAction}>
          <X size={15} />
        </button>
      </header>
      {error && (
        <div role="alert" className="alert" style={{ margin: '10px 24px 0' }}>
          {error}
        </div>
      )}
      <ImageWorkspace.Provider value={detail.cwd || ''}><div className="stream">
        <div className="stream-inner">
          {detail.messages.map((msg) =>
            msg.role === 'user' ? (
              <div key={msg.id} className="turn">
                <div className="cc-user-prompt">
                  <span className="cc-user-chevron">&gt;</span>
                  <div className="cc-user-body"><SentAnnotations items={msg.annotations} /><Markdown text={msg.content} attachments={msg.attachments} /></div>
                </div>
              </div>
            ) : (
              <div key={msg.id} className="turn">
                <div className="cc-assistant">
                  {msg.thoughts?.map((th) => (
                    <ThinkingBlock key={th.id} thought={th} defaultTrack={defaultThoughtTrack} />
                  ))}
                  <div className="cc-text">
                    <span className="cc-bullet">⏺</span>
                    <Markdown text={msg.content} attachments={msg.attachments} />
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      </div></ImageWorkspace.Provider>
    </section>
  );
}

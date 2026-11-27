import { getComponentCopy } from '../i18n/domains/copy';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, GitBranch, Layers, Send } from 'lucide-react';
import type { SwarmActionEvent, SwarmBoardMessage, SwarmHistoryCursor, SwarmTopologyState, SwarmWorkerStatus } from '@shared';
import { swarmMessageMentions } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { formatLocalClock } from '../lib/time-format';
import { Icon } from './ui/Icon';

export interface SwarmPanelProps {
  sessionId: string | null;
  topology?: SwarmTopologyState;
  onLaunchSwarmTask?: (sessionId: string, taskBrief: string) => Promise<void>;
  onLoadPage?: (sessionId: string, cursor: SwarmHistoryCursor) => Promise<SwarmTopologyState>;
  drafts?: SwarmDrafts;
  busy?: boolean;
}

type SubView = 'all' | 'workers' | 'board' | 'timeline';

interface Draft {
  text: string;
  version: number;
  sending: boolean;
  submission?: symbol;
  error?: string;
}
const blankDraft: Draft = { text: '', version: 0, sending: false };

/** The inspector owns one instance per profile, across tab changes and pending submissions. */
export class SwarmDrafts {
  private entries = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  keepSessions(ids: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
    for (const notify of this.listeners) notify();
  }
  read(id: string): Draft { return this.entries.get(id) ?? blankDraft; }
  patch(id: string, values: Partial<Draft>): void {
    const updated = { ...this.read(id), ...values };
    if (updated.text || updated.sending || updated.error) this.entries.set(id, updated);
    else this.entries.delete(id);
    for (const notify of this.listeners) notify();
  }
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    return () => { this.listeners.delete(notify); };
  };
}

/** 比较前先去掉完成标记、统一数字和标点。显示和展开仍使用消息原文，规范化只影响折叠判断。 */
function normalizeForSimilarity(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\[done\]|\[stall(?:ed)?\]/gi, '')
    .replace(/\b[0-9a-f]{8,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[\s.,;:!?，。；：！？()（）【】「」『』'"`_-]+/g, ' ')
    .trim();
}

function buildBigrams(str: string): Set<string> {
  const compact = str.replace(/\s+/g, '');
  const set = new Set<string>();
  if (compact.length < 2) {
    if (compact) set.add(compact);
    return set;
  }
  for (let i = 0; i < compact.length - 1; i++) {
    set.add(compact.slice(i, i + 2));
  }
  return set;
}

/**
 * 判断两条消息或事件摘要是否过度相似（用于消息板与时间线自动折叠去噪）。
 */
export function areSwarmTextsSimilar(a: string, b: string): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  if (minLen >= 14 && (na.startsWith(nb.slice(0, Math.floor(minLen * 0.8))) || nb.startsWith(na.slice(0, Math.floor(minLen * 0.8))))) {
    if (minLen / maxLen >= 0.65) return true;
  }

  // 精确或长度相近的前缀匹配之外，用共同的相邻字符对计算 Dice 系数，以识别稍有改写的重复状态消息。
  const bgA = buildBigrams(na);
  const bgB = buildBigrams(nb);
  if (bgA.size === 0 || bgB.size === 0) return false;
  let inter = 0;
  for (const gram of bgA) {
    if (bgB.has(gram)) inter++;
  }
  const dice = (2 * inter) / (bgA.size + bgB.size);
  return dice >= 0.74;
}

interface BoardMessageGroup {
  representative: SwarmBoardMessage;
  collapsedDuplicates: SwarmBoardMessage[];
}

function BoardMentions({ message }: { message: SwarmBoardMessage }) {
  const inline = new Set(swarmMessageMentions(message.content));
  const extra = swarmMessageMentions('', message.mentions).filter(name => !inline.has(name));
  return extra.length > 0 ? <span className="muted">{extra.map(name => '@' + name).join(' ')}</span> : null;
}

/** 只比较相邻分组里同发送者、同频道的条目，保留中间插入的不同发言和原始顺序。 */
function groupSimilarBoardMessages(messages: SwarmBoardMessage[]): BoardMessageGroup[] {
  const groups: BoardMessageGroup[] = [];
  for (const msg of messages) {
    const prev = groups.at(-1);
    const recipients = new Set(swarmMessageMentions('', msg.mentions));
    const previousRecipients = swarmMessageMentions('', prev?.representative.mentions);
    if (
      prev &&
      prev.representative.sender === msg.sender &&
      prev.representative.channel === msg.channel &&
      previousRecipients.length === recipients.size && previousRecipients.every(name => recipients.has(name)) &&
      areSwarmTextsSimilar(prev.representative.content, msg.content)
    ) {
      // 保留最新一条作为主展示代表，旧的相似条目收入折叠组
      prev.collapsedDuplicates.push(prev.representative);
      prev.representative = msg;
    } else {
      groups.push({ representative: msg, collapsedDuplicates: [] });
    }
  }
  return groups;
}

interface TimelineEventGroup {
  representative: SwarmActionEvent;
  collapsedDuplicates: SwarmActionEvent[];
}

/** 时间线按执行者和事件类型限制合并范围，再比较当前显示语言的摘要。展开分组仍可看到被折叠的记录。 */
function groupSimilarTimelineEvents(events: SwarmActionEvent[], isZh: boolean): TimelineEventGroup[] {
  const groups: TimelineEventGroup[] = [];
  for (const evt of events) {
    const prev = groups.at(-1);
    const curText = isZh ? evt.summaryZh : evt.summaryEn;
    const prevText = prev ? (isZh ? prev.representative.summaryZh : prev.representative.summaryEn) : '';
    if (
      prev &&
      prev.representative.actorName === evt.actorName &&
      prev.representative.eventType === evt.eventType &&
      areSwarmTextsSimilar(prevText, curText)
    ) {
      prev.collapsedDuplicates.push(prev.representative);
      prev.representative = evt;
    } else {
      groups.push({ representative: evt, collapsedDuplicates: [] });
    }
  }
  return groups;
}

function CollapsibleText({
  text,
  prefix,
  maxChars = 115,
  isZh,
  testId,
}: {
  text: string;
  prefix?: React.ReactNode;
  maxChars?: number;
  isZh: boolean;
  testId?: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const lineCount = text.split('\n').length;
  const needsCollapse = text.length > maxChars || lineCount > 3;

  if (!needsCollapse) {
    return (
      <span>
        {prefix}
        {text}
      </span>
    );
  }

  const preview = expanded
    ? text
    : `${text.replace(/\s+/g, ' ').slice(0, maxChars).trimEnd()}…`;

  return (
    <span className="swarm-collapsible-text">
      {prefix}
      <span style={{ whiteSpace: expanded ? 'pre-wrap' : 'normal' }}>{preview}</span>
      <button
        type="button"
        className="swarm-fold-btn"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        data-testid={testId}
      >
        {expanded ? (
          <>
            <Icon icon={ChevronDown} size="xs" />
            <span>{getComponentCopy(isZh).collapse}</span>
          </>
        ) : (
          <>
            <Icon icon={ChevronRight} size="xs" />
            <span>{getComponentCopy(isZh).fmtExpand(text.length)}</span>
          </>
        )}
      </button>
    </span>
  );
}

/** 成员状态徽标语义色：终止（killed / failed）为危险色，已停止 / 未确认为中性，仅运行中与等待使用强调色。 */
function workerBadgeClass(status: SwarmWorkerStatus): string {
  switch (status) {
    case 'completed':
      return 'badge-success';
    case 'failed':
    case 'killed':
      return 'badge-danger';
    case 'stopped':
    case 'unconfirmed':
      return 'badge-neutral';
    case 'waiting':
      return 'badge-warning';
    default:
      return 'badge-accent';
  }
}

export function SwarmPanel(props: SwarmPanelProps): React.ReactElement {
  const localDrafts = useMemo(() => new SwarmDrafts(), []);
  return <SessionSwarmPanel key={props.sessionId} {...props} drafts={props.drafts ?? localDrafts} />;
}

function SessionSwarmPanel({
  sessionId,
  topology: latest,
  onLaunchSwarmTask,
  onLoadPage,
  drafts,
  busy,
}: SwarmPanelProps & { drafts: SwarmDrafts }): React.ReactElement {
  const { locale, dict } = useI18n();
  const isZh = locale === 'zh-CN';
  const [view, setView] = useState<SubView>('all');
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.read(sessionId || ''));
  const { text: taskBrief, sending: launching } = draft;
  const [error, setError] = useState<string | null>(null);
  const [expandedBoardGroups, setExpandedBoardGroups] = useState<Record<string, boolean>>({});
  const [expandedTimelineGroups, setExpandedTimelineGroups] = useState<Record<string, boolean>>({});
  const [timelineShowAll, setTimelineShowAll] = useState(false);
  const [page, setPage] = useState<SwarmTopologyState>();
  const [cursors, setCursors] = useState<SwarmHistoryCursor[]>([]);
  const [loading, setLoading] = useState(false);
  const dictRef = useRef(dict);
  dictRef.current = dict;
  const topology = page ?? latest;
  const hasRecords = Boolean(topology && (topology.isActive && topology.swarmTitle || topology.workers.length || topology.boardMessages.length || topology.actionTimeline.length));
  const canLoadEarlier = Object.values(topology?.earlier ?? {}).some(Boolean);
  const boardKey = (m: SwarmBoardMessage) => String(m.rowId ?? JSON.stringify([m.channel, m.sender, m.seq]));
  useEffect(() => {
    const before = cursors.at(-1);
    if (latest?.refreshHistoryWorkers && before?.workers && sessionId && onLoadPage) {
      let active = true;
      void onLoadPage(sessionId, { ...before, boardMessages: null, actionTimeline: null }).then(updated => {
        if (active) setPage(prev => prev ? { ...prev, workers: updated.workers, stats: updated.stats } : prev);
      }).catch(err => { if (active) setError(formatActionError(err, dictRef.current)); });
      return () => { active = false; };
    }
    if (!latest?.changedWorkers?.length) return;
    const changed = new Map(latest.changedWorkers.map(w => [w.rowId ?? w.id, w]));
    setPage(prev => prev ? { ...prev, stats: latest.stats, workers: prev.workers.map(w => changed.get(w.rowId ?? w.id) ?? w) } : prev);
  }, [latest, cursors, sessionId, onLoadPage]);

  async function navigate(older: boolean): Promise<void> {
    if (loading || !onLoadPage || !sessionId) return;
    const next = older && topology?.earlier ? [...cursors, topology.earlier] : cursors.slice(0, -1);
    if (!next.length) { setCursors([]); setPage(undefined); return; }
    setLoading(true);
    setError(null);
    try {
      const target = await onLoadPage(sessionId, next[next.length - 1]);
      setPage(target); setCursors(next); setTimelineShowAll(true);
    } catch (err) { setError(formatActionError(err, dict)); }
    finally { setLoading(false); }
  }

  const hasWorkers = Boolean(topology && topology.workers.length > 0);

  const boardGroups = useMemo(
    () => groupSimilarBoardMessages(topology?.boardMessages ?? []),
    [topology?.boardMessages]
  );

  const timelineGroups = useMemo(
    () => groupSimilarTimelineEvents(topology?.actionTimeline ?? [], isZh),
    [topology?.actionTimeline, isZh]
  );

  // 时间线上限按分组数计算。默认显示最新八组，展开后可查看当前拓扑中的完整分组列表。
  const visibleTimelineGroups =
    timelineShowAll || timelineGroups.length <= 8
      ? timelineGroups
      : timelineGroups.slice(-8);

  async function launchRealSwarm(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = taskBrief.trim();
    if (!sessionId || !onLaunchSwarmTask || !trimmed || drafts.read(sessionId).sending || busy) return;
    const submission = Symbol();
    drafts.patch(sessionId, { sending: true, submission, error: undefined });
    setError(null);
    try {
      await onLaunchSwarmTask(sessionId, trimmed);
      const current = drafts.read(sessionId);
      if (current.submission === submission && current.version === draft.version) drafts.patch(sessionId, { text: '' });
    } catch (err) {
      if (drafts.read(sessionId).submission === submission) drafts.patch(sessionId, { error: formatActionError(err, dict) });
    } finally {
      if (drafts.read(sessionId).submission === submission) drafts.patch(sessionId, { sending: false, submission: undefined });
    }
  }

  const labels: Record<SubView, string> = {
    all: dict.swarmViewAll,
    workers: dict.swarmViewWorkers,
    board: dict.swarmViewBoard,
    timeline: dict.swarmViewTimeline,
  };

  return (
    <div className="inspector-stack" data-testid="swarm-monitor-panel">
      {latest?.historyUnavailable && (
        <div role="alert" className="alert">
          {dict.ui.copy.someCollaborationHistoryCouldNot}
        </div>
      )}
      {topology?.isActive && topology.swarmTitle && (
        <div className="card-title" style={{ fontSize: 13 }} data-testid="swarm-title-banner">
          {topology.swarmTitle}
        </div>
      )}

      {(error || draft.error) && (
        <div role="alert" className="alert">
          {error || draft.error}
        </div>
      )}

      {topology && hasWorkers && cursors.length > 0 && (
        <div className="swarm-stats-scope muted" data-testid="swarm-stats-scope">{dict.ui.v031.swarmSnapshotStats}</div>
      )}
      {topology && hasWorkers && (
        <div className="swarm-stats">
          <div className="swarm-stat">
            <strong>{topology.stats.total}</strong>
            <span>{dict.swarmStatTotal}</span>
          </div>
          <div className="swarm-stat">
            <strong style={{ color: 'var(--accent-text, var(--accent-primary))' }}>{topology.stats.working}</strong>
            <span>{dict.swarmStatWorking}</span>
          </div>
          <div className="swarm-stat">
            <strong>{topology.stats.waiting}</strong>
            <span>{dict.swarmStatWaiting}</span>
          </div>
          <div className="swarm-stat">
            <strong style={{ color: 'var(--success-text, var(--status-success))' }}>{topology.stats.completed}</strong>
            <span>{dict.swarmStatCompleted}</span>
          </div>
        </div>
      )}

      {hasRecords && (
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          {(['all', 'workers', 'board', 'timeline'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`segmented-btn ${view === v ? 'is-active' : ''}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {labels[v]}
            </button>
          ))}
        </div>
      )}

      {sessionId && onLaunchSwarmTask && (
        <form onSubmit={(e) => void launchRealSwarm(e)} style={{ display: 'flex', gap: 6 }}>
          <input
            className="input"
            style={{ flex: 1, height: 30, fontSize: 12 }}
            value={taskBrief}
            onChange={(e) => drafts.patch(sessionId, { text: e.target.value, version: draft.version + 1 })}
            placeholder={
              dict.ui.copy.describeAMultiAgentTask
            }
            data-testid="swarm-launch-input"
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={launching || busy || !taskBrief.trim()}
            data-testid="swarm-launch-btn"
          >
            <Icon icon={Send} size="xs" />
            <span>{dict.ui.copy.launch}</span>
          </button>
        </form>
      )}

      {(canLoadEarlier || cursors.length > 0) && onLoadPage && (
        <div className="sub-tabs">
          {canLoadEarlier && (
            <button className="btn btn-sm" disabled={loading} onClick={() => void navigate(true)} data-testid="swarm-earlier">
              {dict.ui.copy.earlierRecords}
            </button>
          )}
          {cursors.length > 0 && (
            <button className="btn btn-sm" disabled={loading} onClick={() => void navigate(false)} data-testid="swarm-newer">
              {cursors.length === 1 ? (dict.ui.copy.latestRecords) : (dict.ui.copy.newerRecords)}
            </button>
          )}
        </div>
      )}
      {!hasRecords ? (
        <div className="empty-state">{dict.swarmEmptyDesc}</div>
      ) : (
        <>
          {(view === 'all' || view === 'workers') && hasWorkers && (
            <>
              <div className="sub-head">{dict.swarmViewWorkers}</div>
              {topology!.workers.map((w) => (
                <div
                  key={w.rowId ?? w.id}
                  className={`worker ${w.status === 'working' ? 'is-working' : ''}`}
                  data-testid={`swarm-worker-${w.name}`}
                >
                  <div className="worker-head">
                    <span className={`status-dot is-${w.status}`} />
                    <span className="worker-name">@{w.name}</span>
                    <span className="badge">{dict.swarmMemberKinds[w.kind]}</span>
                    <span className="spacer" />
                    <span className={`badge ${workerBadgeClass(w.status)}`} data-worker-status={w.status}>
                      {dict.swarmWorkerStatuses[w.status]}
                    </span>
                  </div>
                  <div className="worker-line" style={{ color: 'var(--text-primary)' }}>
                    {w.role}
                  </div>
                  <div className="thread-meta">
                    <span className="badge badge-mono">{w.model}</span>
                    <span className="badge" data-workspace-mode={w.workspaceMode}>
                      <Icon icon={GitBranch} size="xs" />
                      {dict.swarmWorkspaceModes[w.workspaceMode]}
                    </span>
                  </div>
                  <div className="worker-line">
                    <CollapsibleText
                      text={w.brief}
                      prefix={<b>{dict.swarmBriefLabel} · </b>}
                      maxChars={108}
                      isZh={isZh}
                      testId={`toggle-worker-brief-${w.name}`}
                    />
                  </div>
                  {w.currentAction && w.status === 'working' && (
                    <div className="worker-line" style={{ color: 'var(--accent-text, var(--accent-primary))' }}>
                      <CollapsibleText
                        text={w.currentAction}
                        prefix={<b>{dict.swarmCurrentActionLabel} · </b>}
                        maxChars={96}
                        isZh={isZh}
                      />
                    </div>
                  )}
                  {w.resultSummary && (
                    <div className="worker-line" style={{ color: w.status === 'completed' ? 'var(--success-text, var(--status-success))' : undefined }}>
                      {w.status === 'completed' && <Icon icon={CheckCircle2} size="xs" style={{ verticalAlign: '-1px', marginRight: 4 }} />}
                      <CollapsibleText
                        text={w.resultSummary}
                        maxChars={108}
                        isZh={isZh}
                        testId={`toggle-worker-result-${w.name}`}
                      />
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {(view === 'all' || view === 'board') && boardGroups.length > 0 && (
            <>
              <div className="sub-head">{dict.swarmBoardTitle}</div>
              {boardGroups.map((group) => {
                const bm = group.representative;
                const dupCount = group.collapsedDuplicates.length;
                const key = boardKey(bm);
                const isGroupOpen = Boolean(expandedBoardGroups[key]);
                return (
                  <div key={key} className="swarm-group-wrap">
                    <div
                      className={`board-msg ${bm.isDoneReport ? 'is-done' : ''} ${bm.isStallAlert ? 'is-stall' : ''}`}
                      data-testid={`swarm-board-seq-${bm.seq}`}
                    >
                      <div className="board-msg-head">
                        <span className="badge badge-accent badge-mono">#{bm.seq}</span>
                        <strong>@{bm.sender}</strong>
                        <BoardMentions message={bm} />
                        <span className="muted">#{bm.channel}</span>
                        <span className="spacer" />
                        {dupCount > 0 && (
                          <button
                            type="button"
                            className="swarm-dup-pill"
                            onClick={() =>
                              setExpandedBoardGroups((prev) => ({ ...prev, [key]: !prev[key] }))
                            }
                            data-testid={`toggle-similar-board-${bm.seq}`}
                          >
                            <Icon icon={Layers} size="xs" />
                            <span>
                              {isGroupOpen
                                ? dict.ui.copy.fmtHideSimilar(dupCount)
                                : dict.ui.copy.fmtSimilar(dupCount)}
                            </span>
                          </button>
                        )}
                        {bm.isDoneReport && <span className="badge badge-success">{dict.swarmDoneBadge}</span>}
                        {bm.isStallAlert && <span className="badge badge-danger">{dict.swarmStallBadge}</span>}
                      </div>
                      <div>
                        <CollapsibleText
                          text={bm.content}
                          maxChars={128}
                          isZh={isZh}
                          testId={`toggle-board-text-${bm.seq}`}
                        />
                      </div>
                    </div>
                    {dupCount > 0 && isGroupOpen && (
                      <div className="swarm-dup-children" data-testid={`similar-board-list-${bm.seq}`}>
                        {group.collapsedDuplicates.map((oldBm) => (
                          <div key={boardKey(oldBm)} className="board-msg is-collapsed-dup" data-testid={`swarm-board-seq-${oldBm.seq}`}>
                            <div className="board-msg-head">
                              <span className="badge badge-mono">#{oldBm.seq}</span>
                              <BoardMentions message={oldBm} />
                              <span className="muted">{formatLocalClock(oldBm.timestamp, locale)}</span>
                            </div>
                            <CollapsibleText text={oldBm.content} maxChars={100} isZh={isZh} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {(view === 'all' || view === 'timeline') && timelineGroups.length > 0 && (
            <>
              <div className="sub-head">
                <span>{dict.swarmTimelineTitle}</span>
                {timelineGroups.length > 8 && (
                  <button
                    type="button"
                    className="swarm-fold-btn"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setTimelineShowAll((v) => !v)}
                    data-testid="toggle-timeline-all"
                  >
                    {timelineShowAll
                      ? dict.ui.copy.showLatest8
                      : dict.ui.copy.fmtShowOlder(timelineGroups.length - 8)}
                  </button>
                )}
              </div>
              <div className="timeline">
                {visibleTimelineGroups.map((group) => {
                  const evt = group.representative;
                  const dupCount = group.collapsedDuplicates.length;
                  const isOpen = Boolean(expandedTimelineGroups[evt.id]);
                  const summaryText = isZh ? evt.summaryZh : evt.summaryEn;
                  return (
                    <div key={evt.id} className="timeline-item">
                      <div>
                        <CollapsibleText
                          text={summaryText}
                          maxChars={96}
                          isZh={isZh}
                          testId={`toggle-timeline-text-${evt.id}`}
                        />
                      </div>
                      <div className="timeline-meta" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>
                          @{evt.actorName}
                          {evt.targetName ? ` → @${evt.targetName}` : ''} · {formatLocalClock(evt.timestamp, locale, false)}
                        </span>
                        {dupCount > 0 && (
                          <button
                            type="button"
                            className="swarm-dup-pill"
                            onClick={() =>
                              setExpandedTimelineGroups((prev) => ({ ...prev, [evt.id]: !prev[evt.id] }))
                            }
                            data-testid={`toggle-similar-timeline-${evt.id}`}
                          >
                            <Icon icon={Layers} size="xs" />
                            <span>
                              {isOpen
                                ? dict.ui.copy.fmtHide(dupCount)
                                : dict.ui.copy.fmtSimilar2(dupCount)}
                            </span>
                          </button>
                        )}
                      </div>
                      {dupCount > 0 && isOpen && (
                        <div className="swarm-dup-timeline-children">
                          {group.collapsedDuplicates.map((oldEvt) => (
                            <div key={oldEvt.id} className="timeline-dup-row">
                              <span className="mono muted">{formatLocalClock(oldEvt.timestamp, locale)}</span>
                              <span>{isZh ? oldEvt.summaryZh : oldEvt.summaryEn}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

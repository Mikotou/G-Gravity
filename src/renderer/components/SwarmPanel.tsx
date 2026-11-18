import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, GitBranch, Layers, Send } from 'lucide-react';
import type { SwarmActionEvent, SwarmBoardMessage, SwarmTopologyState } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';

export interface SwarmPanelProps {
  sessionId: string | null;
  topology?: SwarmTopologyState;
  onLaunchSwarmTask?: (sessionId: string, taskBrief: string) => Promise<void>;
}

type SubView = 'all' | 'workers' | 'board' | 'timeline';

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

/** 只比较相邻分组里同发送者、同频道的条目，保留中间插入的不同发言和原始顺序。 */
function groupSimilarBoardMessages(messages: SwarmBoardMessage[]): BoardMessageGroup[] {
  const groups: BoardMessageGroup[] = [];
  for (const msg of messages) {
    const prev = groups.at(-1);
    if (
      prev &&
      prev.representative.sender === msg.sender &&
      prev.representative.channel === msg.channel &&
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
            <ChevronDown size={11} />
            <span>{isZh ? '收起' : 'Collapse'}</span>
          </>
        ) : (
          <>
            <ChevronRight size={11} />
            <span>{isZh ? `展开全文 (${text.length}字)` : `Expand (${text.length})`}</span>
          </>
        )}
      </button>
    </span>
  );
}

export function SwarmPanel({
  sessionId,
  topology,
  onLaunchSwarmTask,
}: SwarmPanelProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const isZh = locale === 'zh-CN';
  const [view, setView] = useState<SubView>('all');
  const [launching, setLaunching] = useState(false);
  const [taskBrief, setTaskBrief] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expandedBoardGroups, setExpandedBoardGroups] = useState<Record<number, boolean>>({});
  const [expandedTimelineGroups, setExpandedTimelineGroups] = useState<Record<string, boolean>>({});
  const [timelineShowAll, setTimelineShowAll] = useState(false);

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
    if (!sessionId || !onLaunchSwarmTask || !trimmed || launching) return;
    setLaunching(true);
    setError(null);
    try {
      setTaskBrief('');
      await onLaunchSwarmTask(sessionId, trimmed);
    } catch (err) {
      setError(formatActionError(err, dict));
    } finally {
      setLaunching(false);
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
      {topology?.isActive && topology.swarmTitle && (
        <div className="card-title" style={{ fontSize: 13 }} data-testid="swarm-title-banner">
          {topology.swarmTitle}
        </div>
      )}

      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      {topology && hasWorkers && (
        <div className="swarm-stats">
          <div className="swarm-stat">
            <strong>{topology.stats.total}</strong>
            <span>{dict.swarmStatTotal}</span>
          </div>
          <div className="swarm-stat">
            <strong style={{ color: 'var(--accent-primary)' }}>{topology.stats.working}</strong>
            <span>{dict.swarmStatWorking}</span>
          </div>
          <div className="swarm-stat">
            <strong>{topology.stats.waiting}</strong>
            <span>{dict.swarmStatWaiting}</span>
          </div>
          <div className="swarm-stat">
            <strong style={{ color: 'var(--status-success)' }}>{topology.stats.completed}</strong>
            <span>{dict.swarmStatCompleted}</span>
          </div>
        </div>
      )}

      {hasWorkers && (
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          {(['all', 'workers', 'board', 'timeline'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`segmented-btn ${view === v ? 'is-active' : ''}`}
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
            onChange={(e) => setTaskBrief(e.target.value)}
            placeholder={
              isZh
                ? '输入需要多子个体并行协作的任务…'
                : 'Describe a multi-agent task to launch swarm…'
            }
            data-testid="swarm-launch-input"
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={launching || !taskBrief.trim()}
            data-testid="swarm-launch-btn"
          >
            <Send size={12} />
            <span>{isZh ? '启动蜂群' : 'Launch'}</span>
          </button>
        </form>
      )}

      {!hasWorkers ? (
        <div className="empty-state">{dict.swarmEmptyDesc}</div>
      ) : (
        <>
          {(view === 'all' || view === 'workers') && (
            <>
              <div className="sub-head">{dict.swarmViewWorkers}</div>
              {topology!.workers.map((w) => (
                <div
                  key={w.id}
                  className={`worker ${w.status === 'working' ? 'is-working' : ''}`}
                  data-testid={`swarm-worker-${w.name}`}
                >
                  <div className="worker-head">
                    <span className={`status-dot is-${w.status}`} />
                    <span className="worker-name">@{w.name}</span>
                    <span className="badge">{dict.swarmMemberKinds[w.kind]}</span>
                    <span className="spacer" />
                    <span className={`badge ${w.status === 'completed' ? 'badge-success' : 'badge-accent'}`}>
                      {dict.swarmWorkerStatuses[w.status]}
                    </span>
                  </div>
                  <div className="worker-line" style={{ color: 'var(--text-primary)' }}>
                    {w.role}
                  </div>
                  <div className="thread-meta">
                    <span className="badge badge-mono">{w.model}</span>
                    <span className="badge" data-workspace-mode={w.workspaceMode}>
                      <GitBranch size={10} />
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
                    <div className="worker-line" style={{ color: 'var(--accent-primary)' }}>
                      <CollapsibleText
                        text={w.currentAction}
                        prefix={<b>{dict.swarmCurrentActionLabel} · </b>}
                        maxChars={96}
                        isZh={isZh}
                      />
                    </div>
                  )}
                  {w.resultSummary && (
                    <div className="worker-line" style={{ color: 'var(--status-success)' }}>
                      <CheckCircle2 size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
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
                const isGroupOpen = Boolean(expandedBoardGroups[bm.seq]);
                return (
                  <div key={bm.seq} className="swarm-group-wrap">
                    <div
                      className={`board-msg ${bm.isDoneReport ? 'is-done' : ''} ${bm.isStallAlert ? 'is-stall' : ''}`}
                      data-testid={`swarm-board-seq-${bm.seq}`}
                    >
                      <div className="board-msg-head">
                        <span className="badge badge-accent badge-mono">#{bm.seq}</span>
                        <strong>@{bm.sender}</strong>
                        <span className="muted">#{bm.channel}</span>
                        <span className="spacer" />
                        {dupCount > 0 && (
                          <button
                            type="button"
                            className="swarm-dup-pill"
                            onClick={() =>
                              setExpandedBoardGroups((prev) => ({ ...prev, [bm.seq]: !prev[bm.seq] }))
                            }
                            data-testid={`toggle-similar-board-${bm.seq}`}
                          >
                            <Layers size={10} />
                            <span>
                              {isGroupOpen
                                ? isZh
                                  ? `收起相似 (${dupCount})`
                                  : `Hide ${dupCount} similar`
                                : isZh
                                  ? `已折叠 ${dupCount} 条相似`
                                  : `+${dupCount} similar`}
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
                          <div key={oldBm.seq} className="board-msg is-collapsed-dup" data-testid={`swarm-board-seq-${oldBm.seq}`}>
                            <div className="board-msg-head">
                              <span className="badge badge-mono">#{oldBm.seq}</span>
                              <span className="muted">{oldBm.timestamp.slice(11, 19)}</span>
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
                      ? isZh
                        ? '仅显示最近 8 组'
                        : 'Show latest 8'
                      : isZh
                        ? `展开更早记录 (+${timelineGroups.length - 8})`
                        : `Show +${timelineGroups.length - 8} older`}
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
                          {evt.targetName ? ` → @${evt.targetName}` : ''} · {evt.timestamp.slice(11, 16)}
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
                            <Layers size={10} />
                            <span>
                              {isOpen
                                ? isZh
                                  ? `收起 (${dupCount})`
                                  : `Hide (${dupCount})`
                                : isZh
                                  ? `折叠了 ${dupCount} 条相似事件`
                                  : `+${dupCount} similar`}
                            </span>
                          </button>
                        )}
                      </div>
                      {dupCount > 0 && isOpen && (
                        <div className="swarm-dup-timeline-children">
                          {group.collapsedDuplicates.map((oldEvt) => (
                            <div key={oldEvt.id} className="timeline-dup-row">
                              <span className="mono muted">{oldEvt.timestamp.slice(11, 19)}</span>
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

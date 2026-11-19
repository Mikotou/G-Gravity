import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileCode2,
  Loader2,
  Search,
  ShieldAlert,
  SquareTerminal,
} from 'lucide-react';
import type { ChatMessageItem, ManagedSessionStatus, SemanticToolCallCard } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import {
  basenameOf,
  classifyTool,
  formatDuration,
  summarizeTurn,
} from '../lib/turn-insights';
import { ToolCallCard } from './ToolCallCard';

/* ============================================================================
 * 1. 工具调用流：连续只读探索合并为一行，关键动作单独突出
 * ========================================================================== */

export function ToolActivityStream({
  tools,
  onInspectDiff,
}: {
  tools: SemanticToolCallCard[];
  onInspectDiff: (filePath: string) => void;
}): React.ReactElement {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const failed = tools.filter(t => t.status === 'failed' || t.status === 'rejected').length;
  const running = tools.some(t => t.status === 'pending' || t.status === 'running');
  // 折叠态用最多 3 颗语义小圆点呈现本轮涉及的操作类别（改动/命令/探索等），无需展开即可感知重点。
  const categories = Array.from(new Set(tools.map(t => classifyTool(t.canonicalToolName || t.rawToolName)))).slice(0, 4);
  return (
    <details className={`tool-group activity-group ${failed > 0 ? 'has-failure' : ''} ${running ? 'is-running' : ''}`} data-testid={'tool-group-' + tools[0]?.toolCallId}>
      <summary className="tool-group-head">
        <ChevronRight size={13} className="cc-tool-chev" />
        <span className="tool-group-title">{zh ? '操作记录' : 'Activity'}</span>
        <span className="tool-group-badge">{tools.length}</span>
        <span className="tool-cat-dots" aria-hidden="true">
          {categories.map(cat => <span key={cat} className={`tool-cat-dot is-${cat}`} />)}
        </span>
        {failed > 0 && <span className="cc-del">{failed} {zh ? '项失败' : 'failed'}</span>}
        {running && <Loader2 size={12} className="spin tool-group-spin" aria-label={zh ? '执行中' : 'Running'} />}
      </summary>
      <div className="tool-group-body">
        {tools.map(tool => <ToolCallCard key={tool.toolCallId} tool={tool} onInspectDiff={onInspectDiff} nested />)}
      </div>
    </details>
  );
}

/* ============================================================================
 * 2. 回合结果条：本轮做了什么、改了哪些文件、有无失败、耗时多久
 * ========================================================================== */

export function TurnOutcomeBar({
  message,
  turnStartedAt,
  onInspectDiff,
}: {
  message: ChatMessageItem;
  turnStartedAt?: string;
  onInspectDiff: (filePath: string) => void;
}): React.ReactElement | null {
  const { locale } = useI18n();
  const isZh = locale === 'zh-CN';
  const insight = summarizeTurn(message, turnStartedAt);

  // 纯文字回复且没有耗时信息时不显示，避免噪音
  if (insight.totalTools === 0 && insight.durationMs === undefined) return null;
  if (insight.totalTools === 0 && (insight.durationMs ?? 0) < 1500) return null;

  // 结果条优先显示失败，其次显示尚未结束的工具。文件按汇总后的顺序最多展示三项。
  const hasFailure = insight.failedTools > 0;
  const pending = insight.activeTools > 0;
  const shownFiles = insight.changedFiles.slice(0, 3);
  const hiddenFiles = insight.changedFiles.length - shownFiles.length;
  const stateTone = hasFailure ? 'tone-danger' : pending ? 'tone-warning' : 'tone-success';
  const StateIcon = hasFailure ? AlertTriangle : pending ? Loader2 : CheckCircle2;

  return (
    <div
      className={`turn-outcome ${hasFailure ? 'has-failure' : pending ? 'is-pending' : 'is-ok'}`}
      data-testid={`turn-outcome-${message.id}`}
    >
      <span className={`outcome-chip outcome-state ${stateTone}`}>
        <StateIcon size={11} className={pending && !hasFailure ? 'spin' : undefined} />
        <span>
          {hasFailure
            ? isZh
              ? `${insight.failedTools} 项失败`
              : `${insight.failedTools} failed`
            : pending
              ? isZh
                ? `${insight.activeTools} 项等待中`
                : `${insight.activeTools} pending`
              : isZh
                ? '完成'
                : 'Done'}
        </span>
      </span>

      {insight.durationMs !== undefined && (
        <span className="outcome-chip tone-muted" title={isZh ? '本轮耗时' : 'Turn duration'}>
          <Clock3 size={11} />
          <span>{formatDuration(insight.durationMs)}</span>
        </span>
      )}

      {insight.changedFiles.length > 0 && (
        <span className="outcome-files">
          <span className="outcome-chip tone-edit">
            <FileCode2 size={11} />
            <span>
              {isZh ? `修改 ${insight.changedFiles.length} 个文件` : `${insight.changedFiles.length} file${insight.changedFiles.length > 1 ? 's' : ''} changed`}
            </span>
            <span className="cc-add">+{insight.addedLines}</span>
            <span className="cc-del">−{insight.removedLines}</span>
          </span>
          {shownFiles.map((f) => (
            <button
              key={f.path}
              type="button"
              className="outcome-file"
              title={`${f.path}  +${f.added} −${f.removed}`}
              onClick={() => onInspectDiff(f.path)}
            >
              {basenameOf(f.path)}
            </button>
          ))}
          {hiddenFiles > 0 && <span className="outcome-more">+{hiddenFiles}</span>}
        </span>
      )}

      {insight.commands > 0 && (
        <span className={`outcome-chip ${insight.failedCommands ? 'tone-danger' : 'tone-exec'}`}>
          <SquareTerminal size={11} />
          <span>
            {isZh ? `命令 ${insight.commands}` : `${insight.commands} cmd`}
            {insight.failedCommands ? (isZh ? ` · ${insight.failedCommands} 失败` : ` · ${insight.failedCommands} failed`) : ''}
          </span>
        </span>
      )}

      {insight.explored > 0 && (
        <span className="outcome-chip tone-muted">
          <Search size={11} />
          <span>{isZh ? `探索 ${insight.explored}` : `${insight.explored} explored`}</span>
        </span>
      )}
    </div>
  );
}

/* ============================================================================
 * 3. 窗格状态胶囊：运行中（带实时计时）/ 待审批 / 出错 / 空闲
 * ========================================================================== */

function useElapsed(startIso: string | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  const start = startIso ? Date.parse(startIso) : NaN;
  return running && Number.isFinite(start) ? Math.max(0, now - start) : 0;
}

export function PaneStatusChip({
  sessionId,
  status,
  pendingApprovals,
  turnStartedAt,
}: {
  sessionId: string;
  status: ManagedSessionStatus;
  pendingApprovals: number;
  turnStartedAt?: string;
}): React.ReactElement | null {
  const { locale } = useI18n();
  const isZh = locale === 'zh-CN';
  // 待审请求优先决定状态芯片的文案和计时行为，即使流式会话还在等待该操作，界面也会提示用户先处理审批。
  const effective: ManagedSessionStatus = pendingApprovals > 0 ? 'waiting_approval' : status;
  const elapsed = useElapsed(turnStartedAt, effective === 'streaming');

  if (effective === 'idle' || effective === 'closed') return null;

  const label =
    effective === 'waiting_approval'
      ? isZh
        ? `待审批${pendingApprovals > 1 ? ` ×${pendingApprovals}` : ''}`
        : `Needs approval${pendingApprovals > 1 ? ` ×${pendingApprovals}` : ''}`
      : effective === 'error'
        ? isZh
          ? '出错'
          : 'Error'
        : isZh
          ? '运行中'
          : 'Running';

  const Icon = effective === 'waiting_approval' ? ShieldAlert : effective === 'error' ? AlertTriangle : Loader2;

  return (
    <span className={`pane-status-chip is-${effective}`} data-testid={`pane-status-chip-${sessionId}`}>
      <Icon size={11} className={effective === 'streaming' ? 'spin' : undefined} />
      <span>{label}</span>
      {effective === 'streaming' && elapsed >= 1000 && <span className="pane-status-time">{formatDuration(elapsed)}</span>}
    </span>
  );
}

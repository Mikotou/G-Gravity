import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  Clock3,
  FileCode2,
  Loader2,
  MessageCircleQuestion,
  OctagonAlert,
  RotateCw,
  Search,
  ShieldAlert,
  SquareTerminal,
} from 'lucide-react';
import { isToolCallFailure, type ChatMessageItem, type ManagedSessionStatus, type SemanticToolCallCard } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import {
  basenameOf,
  classifyTool,
  formatDuration,
  isTurnUnconfirmed,
  summarizeTurn,
} from '../lib/turn-insights';
import { ToolCallCard } from './ToolCallCard';
import { Icon as UiIcon } from './ui/Icon';

/** agy 命令输出的样板头：时间戳、退出码提示与「Command output:」标题，不是真实错误内容。 */
const AGY_BOILERPLATE_LINE = /^(?:Created At:|Completed At:|Command exited with code|Command output:)/i;
const POLICY_BLOCKED_LINE = /\[(?:本地安全策略已拦截|Blocked by local (?:security )?policy)\]/i;

/**
 * D-LIVE-03：折叠态失败速览挑选最能说明问题的一行（纯函数）。
 * 优先本地策略拦截原因；否则跳过空白与 agy 样板头，取第一条真实输出；全是样板时回退首个非空行。
 */
export function pickFailurePeekLine(output: string | undefined, max = 160): string | undefined {
  const lines = (output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const picked =
    lines.find((l) => POLICY_BLOCKED_LINE.test(l)) ??
    lines.find((l) => !AGY_BOILERPLATE_LINE.test(l)) ??
    lines[0];
  return picked.length > max ? `${picked.slice(0, max)}…` : picked;
}

/* ============================================================================
 * 1. 工具调用流：连续只读探索合并为一行，关键动作单独突出
 * ========================================================================== */

export function ToolActivityStream({
  tools,
  onInspectDiff,
  settled = false,
  unconfirmed = false,
}: {
  tools: SemanticToolCallCard[];
  onInspectDiff: (filePath: string) => void;
  /** TA-1/TA-4：回合已明确收口（含 turnSettledAt / turnStop）时不再因遗留工具状态持续转圈 */
  settled?: boolean;
  /** TA-4：命中旧历史未确认判定时停止转圈 */
  unconfirmed?: boolean;
}): React.ReactElement {
  const { dict } = useI18n();
  // v0.3.2：exit 1 等非零退出码与被拦截（rejected）统一计入失败数。
  const failed = tools.filter(isToolCallFailure).length;
  const running = !settled && !unconfirmed && tools.some(t => t.status === 'pending' || t.status === 'running');
  // 折叠态用最多 3 颗语义小圆点呈现本轮涉及的操作类别（改动/命令/探索等），无需展开即可感知重点。
  const categories = Array.from(new Set(tools.map(t => classifyTool(t.canonicalToolName || t.rawToolName)))).slice(0, 4);
  // 收起态也要能看到第一处失败/拦截的原因（主进程会把本地策略拦截原因置顶写入 outputPreview）。
  const firstFailure = running ? undefined : tools.find(isToolCallFailure);
  const failurePeek = firstFailure ? pickFailurePeekLine(firstFailure.outputPreview) : undefined;
  const failureName = firstFailure ? firstFailure.canonicalToolName || firstFailure.rawToolName : '';
  const failureCode = firstFailure && typeof firstFailure.exitCode === 'number' && firstFailure.exitCode !== 0
    ? `exit ${firstFailure.exitCode}`
    : firstFailure?.status === 'rejected' ? (dict.ui.copy.blocked) : firstFailure ? (dict.ui.copy.failed2) : '';
  return (
    <>
    <details className={`tool-group activity-group ${failed > 0 ? 'has-failure' : ''} ${running ? 'is-running' : ''}`} data-testid={'tool-group-' + tools[0]?.toolCallId}>
      <summary className="tool-group-head">
        <UiIcon icon={ChevronRight} size="sm" className="cc-tool-chev" />
        <span className="tool-group-title">{dict.ui.copy.activity}</span>
        <span className="tool-group-badge">{tools.length}</span>
        <span className="tool-cat-dots" aria-hidden="true">
          {categories.map(cat => <span key={cat} className={`tool-cat-dot is-${cat}`} />)}
        </span>
        {failed > 0 && (
          <span className="tool-group-failed" data-testid={'tool-group-failed-' + tools[0]?.toolCallId}>
            <UiIcon icon={OctagonAlert} size="xs" />
            <span>{failed} {dict.ui.copy.failed3}</span>
          </span>
        )}
        {running && <UiIcon icon={Loader2} size="xs" className="spin tool-group-spin" label={dict.ui.copy.running} />}
      </summary>
      <div className="tool-group-body">
        {tools.map(tool => (
          <ToolCallCard key={tool.toolCallId} tool={tool} onInspectDiff={onInspectDiff} nested settled={settled || unconfirmed} />
        ))}
      </div>
    </details>
    {firstFailure && (
      <div className="tool-failure-peek" data-testid={'tool-failure-peek-' + firstFailure.toolCallId}>
        <span className="tool-failure-peek-glyph" aria-hidden="true">⎿</span>
        <span className="tool-failure-peek-name mono">{failureName}</span>
        <span className="tool-failure-peek-code mono">{failureCode}</span>
        {failurePeek && <span className="tool-failure-peek-text truncate" title={firstFailure.outputPreview}>{failurePeek}</span>}
      </div>
    )}
    </>
  );
}

/* ============================================================================
 * 2. 回合结果条：本轮做了什么、改了哪些文件、有无失败、耗时多久
 * ========================================================================== */

export function TurnOutcomeBar({
  message,
  turnStartedAt,
  isLatestAssistant,
  sessionStatus,
  onInspectDiff,
}: {
  message: ChatMessageItem;
  turnStartedAt?: string;
  isLatestAssistant?: boolean;
  sessionStatus?: ManagedSessionStatus;
  onInspectDiff: (filePath: string) => void;
}): React.ReactElement | null {
  const { locale, dict } = useI18n();
  const isZh = locale === 'zh-CN';
  const insight = summarizeTurn(message, turnStartedAt);
  // 非正常结束（暂停 / 截断 / 断连 / 拒绝 / 自动续接失败）不能显示绿色「完成」。
  const stopSeverity = message.turnStop?.severity ?? (message.autoResumeFailure ? 'warning' : undefined);
  const unconfirmed = isTurnUnconfirmed(message, { isLatestAssistant, sessionStatus });
  const settled = Boolean(message.turnSettledAt);

  // 纯文字回复且没有耗时信息（或耗时很短）时不显示，避免噪音；命中未确认判定时需展示警示。
  if (!stopSeverity && !unconfirmed && insight.totalTools === 0 && (insight.durationMs ?? 0) < 1500) return null;

  // TA-1/TA-4：已通过 turnSettledAt 收口或判定为旧历史未确认时，不再继续展示「等待中」转圈。
  const hasFailure = insight.failedTools > 0;
  const pending = insight.activeTools > 0 && !stopSeverity && !settled && !unconfirmed;
  const shownFiles = insight.changedFiles.slice(0, 3);
  const hiddenFiles = insight.changedFiles.length - shownFiles.length;
  const stateTone = hasFailure || stopSeverity === 'error'
    ? 'tone-danger'
    : stopSeverity === 'paused'
      ? 'tone-paused'
      : stopSeverity === 'warning' || pending || unconfirmed
        ? 'tone-warning'
        : 'tone-success';
  const StateIcon = stopSeverity === 'paused'
    ? CirclePause
    : stopSeverity === 'error'
      ? OctagonAlert
      : hasFailure || stopSeverity === 'warning' || unconfirmed
        ? AlertTriangle
        : pending
          ? Loader2
          : CheckCircle2;
  const stopLabel = stopSeverity === 'paused'
    ? (message.turnStop?.code === 'user_cancelled' ? dict.ui.v031.stoppedChip : dict.ui.v031.pausedChip)
    : stopSeverity === 'error' ? dict.ui.v031.errorChip : dict.ui.v031.warningChip;

  return (
    <div
      className={`turn-outcome ${hasFailure ? 'has-failure' : stopSeverity ? `is-stopped is-${stopSeverity}` : unconfirmed ? 'is-unconfirmed' : pending ? 'is-pending' : 'is-ok'}`}
      data-testid={`turn-outcome-${message.id}`}
      data-turn-stop={message.turnStop?.code}
      data-unconfirmed={unconfirmed ? 'true' : undefined}
    >
      <span
        className={`outcome-chip outcome-state ${stateTone}`}
        title={unconfirmed && !hasFailure && !stopSeverity ? dict.ui.v035.turnUnconfirmed : undefined}
        data-testid={unconfirmed && !hasFailure && !stopSeverity ? `turn-unconfirmed-${message.id}` : undefined}
      >
        <UiIcon icon={StateIcon} size="xs" className={pending && !hasFailure ? 'spin' : undefined} />
        <span>
          {stopSeverity && !hasFailure
            ? stopLabel
            : hasFailure
              ? dict.ui.copy.fmtFailed(insight.failedTools)
              : unconfirmed
                ? dict.ui.v035.turnUnconfirmedShort
                : pending
                  ? dict.ui.copy.fmtPending(insight.activeTools)
                  : dict.ui.copy.done}
        </span>
      </span>

      {!unconfirmed && insight.durationMs !== undefined && (
        <span className="outcome-chip tone-muted" title={dict.ui.copy.turnDuration}>
          <UiIcon icon={Clock3} size="xs" />
          <span>{formatDuration(insight.durationMs)}</span>
        </span>
      )}

      {insight.changedFiles.length > 0 && (
        <span className="outcome-files">
          <span className="outcome-chip tone-edit">
            <UiIcon icon={FileCode2} size="xs" />
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
          <UiIcon icon={SquareTerminal} size="xs" />
          <span>
            {dict.ui.copy.fmtCmd(insight.commands)}
            {insight.failedCommands ? (dict.ui.copy.fmtFailed2(insight.failedCommands)) : ''}
          </span>
        </span>
      )}

      {insight.explored > 0 && (
        <span className="outcome-chip tone-muted">
          <UiIcon icon={Search} size="xs" />
          <span>{dict.ui.copy.fmtExplored(insight.explored)}</span>
        </span>
      )}
    </div>
  );
}

/* ============================================================================
 * 2b. 回合结算状态条（v0.3.2 · 防「看似卡死」）
 *     回合已结算、含失败或被拦截的工具、但主进程没有写入 turnStop 时，
 *     在消息底部给出精简明确的结束提示，并在最新回合提供「继续任务」。
 * ========================================================================== */

export function TurnSettledStrip({
  message,
  turnStartedAt,
  onContinue,
  busy = false,
  hasReply = false,
}: {
  message: ChatMessageItem;
  turnStartedAt?: string;
  onContinue?: () => void | Promise<void>;
  busy?: boolean;
  /** D-LIVE-02：本轮已有正文或附件回复时，不再宣称「模型没有继续输出」，也不提供继续按钮 */
  hasReply?: boolean;
}): React.ReactElement | null {
  const { dict } = useI18n();
  const v = dict.ui.v032;
  const tools = message.toolCalls ?? [];
  if (message.isStreaming || message.turnStop || tools.length === 0) return null;
  const failures = tools.filter(isToolCallFailure);
  if (failures.length === 0) return null;
  const rejected = failures.filter((t) => t.status === 'rejected').length;
  const insight = summarizeTurn(message, turnStartedAt);
  const firstExit = failures.find((t) => typeof t.exitCode === 'number' && t.exitCode !== 0)?.exitCode;
  return (
    <div
      className={`turn-settled-strip${hasReply ? ' is-replied' : ''}`}
      role="status"
      data-testid={`turn-settled-${message.id}`}
      data-has-reply={hasReply ? 'true' : undefined}
    >
      {hasReply
        ? <UiIcon icon={AlertTriangle} size="sm" className="turn-settled-icon" />
        : <UiIcon icon={OctagonAlert} size="sm" className="turn-settled-icon" />}
      <span className="turn-settled-main">
        <strong>{hasReply ? v.turnSettledFailedWithReply(failures.length) : v.turnSettledFailed(failures.length)}</strong>
        {rejected > 0 && <span className="turn-settled-chip">{v.turnSettledRejected(rejected)}</span>}
        {firstExit !== undefined && <span className="turn-settled-chip mono">{v.toolExitCode(firstExit)}</span>}
        {insight.durationMs !== undefined && (
          <span className="turn-settled-chip is-muted">
            <UiIcon icon={Clock3} size="xs" />
            {formatDuration(insight.durationMs)}
          </span>
        )}
        {!hasReply && <span className="turn-settled-hint">{v.turnSettledHint}</span>}
      </span>
      {onContinue && !hasReply && (
        <button
          type="button"
          className="btn btn-sm turn-settled-continue"
          disabled={busy}
          onClick={() => void onContinue()}
          data-testid={`turn-settled-continue-${message.id}`}
        >
          <UiIcon icon={RotateCw} size="xs" />
          <span>{v.turnSettledContinue}</span>
        </button>
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
    // 恢复计时时立即刷新，避免先显示上次停止时的陈旧耗时（甚至负值被钳成 0）一秒。
    setNow(Date.now());
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
  stopping = false,
}: {
  sessionId: string;
  status: ManagedSessionStatus;
  pendingApprovals: number;
  turnStartedAt?: string;
  /** 用户已发出停止请求，等待官方回合结算 */
  stopping?: boolean;
}): React.ReactElement | null {
  const { dict } = useI18n();
  // 待审请求优先决定状态芯片的文案和计时行为，即使流式会话还在等待该操作，界面也会提示用户先处理审批。
  const effective: ManagedSessionStatus = pendingApprovals > 0 ? 'waiting_approval' : status;
  const isStopping = stopping && (effective === 'streaming' || effective === 'waiting_approval' || effective === 'waiting_question');
  const elapsed = useElapsed(turnStartedAt, effective === 'streaming' && !isStopping);

  if (effective === 'idle' || effective === 'closed') return null;

  const label = isStopping
    ? dict.ui.v031.stoppingLabel
    : effective === 'waiting_approval'
      ? dict.ui.v036.needsApproval(pendingApprovals)
      : effective === 'waiting_question'
        ? dict.ui.v031.waitingAnswerChip
        : effective === 'error'
          ? dict.ui.copy.error3
          : dict.ui.copy.running2;

  const Icon = isStopping ? Loader2 : effective === 'waiting_approval' ? ShieldAlert : effective === 'waiting_question'
    ? MessageCircleQuestion : effective === 'error' ? AlertTriangle : Loader2;
  const chipState = isStopping ? 'stopping' : effective;

  return (
    <span className={`pane-status-chip is-${chipState}`} data-testid={`pane-status-chip-${sessionId}`} data-status={chipState}>
      <UiIcon icon={Icon} size="xs" className={effective === 'streaming' || isStopping ? 'spin' : undefined} />
      <span>{label}</span>
      {effective === 'streaming' && !isStopping && elapsed >= 1000 && <span className="pane-status-time">{formatDuration(elapsed)}</span>}
    </span>
  );
}

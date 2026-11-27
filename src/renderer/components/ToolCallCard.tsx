import React, { useState } from 'react';
import {
  Bot,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FileText,
  Globe,
  Loader2,
  OctagonAlert,
  FilePenLine,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { getCanonicalToolName, isToolCallFailure, type SemanticToolCallCard } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { classifyTool, formatDuration, isToolActive, toolDurationMs } from '../lib/turn-insights';
import { UnifiedDiffBlock } from './UnifiedDiffBlock';
import { Icon as UiIcon } from './ui/Icon';

export interface ToolCallCardProps {
  tool: SemanticToolCallCard;
  onInspectDiff?: (filePath: string) => void;
  /** 在探索分组内部渲染时使用更紧凑的样式 */
  nested?: boolean;
  /** TA-1/TA-4：所属回合已收口或已判定为旧历史未确认时，停止残留 running/pending 工具的旋转指示器 */
  settled?: boolean;
}

function firstLine(text?: string): string {
  if (!text) return '';
  const line = text.split(/\r?\n/).find((item) => item.trim()) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export function resolveToolIcon(canonical: string): LucideIcon {
  switch (canonical) {
    case 'Read':
      return FileText;
    case 'Grep':
    case 'Glob':
      return Search;
    case 'Edit':
      return FilePenLine;
    case 'Write':
      return FilePlus2;
    case 'Bash':
      return SquareTerminal;
    case 'WebSearch':
    case 'WebFetch':
      return Globe;
    case 'Swarm':
    case 'Subagent':
      return Bot;
    default:
      return Wrench;
  }
}

/**
 * Claude Code 风格工具行：类别图标 + 名称 + 目标，默认折叠；
 * 失败行红色高亮、运行中图标旋转，结果摘要在下方 ⎿ 行展示。
 */
export function ToolCallCard({ tool, onInspectDiff, nested = false, settled = false }: ToolCallCardProps): React.ReactElement {
  const { dict } = useI18n();
  const [expanded, setExpanded] = useState<boolean>(false);

  // 显示名称沿用主进程归一后的类型，旧记录缺少该字段时从原始工具名补齐，以便沿用相同图标和分组。
  const canonical = tool.canonicalToolName || getCanonicalToolName(tool.rawToolName);
  const category = classifyTool(canonical);
  // v0.3.2：与主进程共用 isToolCallFailure —— failed、rejected 与 exit≠0 都视为失败。
  const failed = isToolCallFailure(tool);
  const active = !settled && isToolActive(tool);
  const Icon = active ? Loader2 : failed ? OctagonAlert : resolveToolIcon(canonical);
  const nonZeroExit = typeof tool.exitCode === 'number' && tool.exitCode !== 0 ? tool.exitCode : undefined;
  const duration = formatDuration(toolDurationMs(tool));

  // 折叠行先显示紧凑目标，再取首个定位路径，最后才截取参数摘要。完整参数仍保留给展开视图。
  const compactArg =
    tool.compactTarget || tool.locations?.[0]?.path || firstLine(tool.argsSummary).slice(0, 80);

  const statusText =
    tool.status === 'pending'
      ? dict.toolStatusPending
      : tool.status === 'running'
        ? dict.toolStatusRunning
        : tool.status === 'completed'
          ? nonZeroExit !== undefined
            ? dict.ui.v032.toolExitCode(nonZeroExit)
            : dict.toolStatusCompleted
          : tool.status === 'rejected'
            ? dict.toolStatusRejected
            : nonZeroExit !== undefined
              ? `${dict.toolStatusFailed} · ${dict.ui.v032.toolExitCode(nonZeroExit)}`
              : dict.toolStatusFailed;

  // 包含行级补丁时用差异视图承载改动，避免同时把原始输出重复放进摘要。
  const summary = tool.diffPatch ? '' : firstLine(tool.outputPreview);

  const toggle = () => setExpanded((prev) => !prev);

  return (
    <div
      className={[
        'cc-tool',
        `tool-cat-${category}`,
        expanded ? 'is-expanded' : '',
        failed ? 'is-failed' : '',
        active ? 'is-active' : '',
        nested ? 'is-nested' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={`tool-card-${tool.toolCallId}`}
      data-tool-category={category}
      data-tool-failed={failed ? 'true' : undefined}
    >
      <div
        className="cc-tool-line"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={`cc-tool-icon status-${tool.status}${failed ? ' is-failed' : ''}`} aria-hidden="true">
          <UiIcon icon={Icon} size="sm" className={active ? 'spin' : undefined} />
        </span>
        <span className="cc-tool-name">{canonical}</span>
        {compactArg && <span className="cc-tool-arg truncate">{compactArg}</span>}
        {tool.diffPatch && (
          <span className="cc-tool-stat">
            <span className="cc-add">+{tool.diffPatch.addedLines}</span>
            <span className="cc-del">−{tool.diffPatch.removedLines}</span>
          </span>
        )}
        <span className="spacer" />
        {(failed || active) && (
          <span className={`cc-tool-status ${failed ? 'is-failed' : 'is-active'}`}>{statusText}</span>
        )}
        {!failed && !active && duration && <span className="cc-tool-duration">{duration}</span>}
        <UiIcon icon={ChevronRight} size="sm" className="cc-tool-chev" />
      </div>

      {!expanded && summary && tool.status !== 'pending' && (
        <div className={`cc-tool-result ${failed ? 'is-failed' : ''}`}>
          <span className="cc-tool-result-glyph" aria-hidden="true">⎿</span>
          <span className="truncate">{summary}</span>
        </div>
      )}

      {expanded && (
        <div className="cc-tool-detail">
          {tool.argsSummary && <div className="cc-tool-args">{tool.argsSummary}</div>}
          {tool.diffPatch && (
            <>
              <UnifiedDiffBlock entry={tool.diffPatch} />
              {onInspectDiff && (
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onInspectDiff(tool.diffPatch!.filePath)}
                  >
                    <UiIcon icon={ExternalLink} size="xs" />
                    <span>{dict.openDiffInInspector}</span>
                  </button>
                </div>
              )}
            </>
          )}
          {tool.outputPreview && <pre className="cc-tool-output">{tool.outputPreview}</pre>}
        </div>
      )}
    </div>
  );
}

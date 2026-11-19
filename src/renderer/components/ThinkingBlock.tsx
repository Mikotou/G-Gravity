import React, { useEffect, useRef, useState } from 'react';
import type { DualTrackThoughtBlock, ThoughtDisplayTrack } from '@shared';
import { useFluidStreamText } from '../hooks/useFluidStreamText';
import { useI18n } from '../i18n/I18nContext';
import { Markdown } from './Markdown';

const expansionKey = 'gravity.thoughts.expanded';
let fallbackExpanded = true;
function readExpanded(): boolean {
  try { return window.localStorage.getItem(expansionKey) !== 'false'; }
  catch { return fallbackExpanded; }
}
function rememberCollapsedDefault(): void {
  fallbackExpanded = false;
  try { window.localStorage.setItem(expansionKey, 'false'); } catch { /* Keep the preference for this window. */ }
}

export interface ThinkingBlockProps {
  thought: DualTrackThoughtBlock;
  defaultTrack: ThoughtDisplayTrack;
  forceAnimation?: boolean;
}

export function ThinkingBlock({
  thought,
  defaultTrack,
  forceAnimation = false,
}: ThinkingBlockProps): React.ReactElement {
  const { dict } = useI18n();
  const [expanded, setExpanded] = useState(readExpanded);
  function toggleExpansion(): void {
    if (expanded) rememberCollapsedDefault();
    setExpanded(!expanded);
  }
  const [track, setTrack] = useState<ThoughtDisplayTrack>(defaultTrack);

  useEffect(() => {
    setTrack(defaultTrack);
  }, [defaultTrack]);

  // 中文轨尚无可用译文时先显示原句，原文轨也可兼容只有译文的旧记录。
  const activeText =
    track === 'zh'
      ? thought.translatedZhText || thought.originalText
      : thought.originalText || thought.translatedZhText;

  const isTranslating =
    track === 'zh' &&
    (Boolean(thought.isTranslating) ||
      (thought.translationSource === 'pending' && thought.languageDetected !== 'zh' && thought.isStreaming));

  const hasTranslation =
    thought.languageDetected !== 'zh' &&
    Boolean(thought.translatedZhText) &&
    thought.translatedZhText !== thought.originalText;

  const useChineseMorph = track === 'zh' && (hasTranslation || isTranslating);
  const flow = useFluidStreamText(
    activeText,
    thought.isStreaming || Boolean(thought.isTranslating),
    useChineseMorph ? 'morph' : 'thought',
    forceAnimation
  );

  // 中文译文落位或切换「中文 / 原文」时触发一次柔和显影过渡（不改动内部段落节点与排版尺寸）。
  const [zhRevealTick, setZhRevealTick] = useState(0);
  const prevTrackRef = useRef<ThoughtDisplayTrack>(track);
  const prevHasTranslationRef = useRef<boolean>(hasTranslation);
  useEffect(() => {
    const switchedTrack = prevTrackRef.current !== track;
    const arrivedTranslation = !prevHasTranslationRef.current && hasTranslation && track === 'zh';
    prevTrackRef.current = track;
    prevHasTranslationRef.current = hasTranslation;
    if (!switchedTrack && !arrivedTranslation) return;
    setZhRevealTick((n) => n + 1);
    const timer = window.setTimeout(() => setZhRevealTick(0), 280);
    return () => window.clearTimeout(timer);
  }, [track, hasTranslation]);

  const sourceLabel =
    thought.translationSource === 'native-zh'
      ? dict.thoughtSourceNativeZh
      : thought.translationSource === 'local-model' ? dict.localTranslatorLabel : thought.translationSource === 'acp-subagent'
        ? dict.thoughtSourceSubagent
        : thought.translationSource === 'external-api'
          ? dict.thoughtSourceExternal
          : dict.thoughtSourceGlossary;

  const collapsedPreview = !expanded
    ? activeText
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96)
    : '';

  const blockClass = [
    'cc-thinking',
    thought.isStreaming ? 'is-streaming' : '',
    track === 'zh' ? 'is-zh-track' : 'is-raw-track',
    isTranslating ? 'is-translating' : '',
    flow.isCatchingUp && useChineseMorph ? 'is-zh-morphing' : '',
    zhRevealTick > 0 ? 'is-zh-reveal' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={blockClass}
      data-testid={`thinking-block-${thought.id}`}
    >
      <div
        className="cc-thinking-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpansion}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggleExpansion();
          }
        }}
      >
        <span className={`cc-thinking-glyph ${thought.isStreaming ? 'is-streaming' : ''}`}>✻</span>
        <span className={`cc-thinking-title ${thought.isStreaming ? 'is-streaming' : ''}`}>
          {thought.isStreaming ? dict.thinkingStreamingTitle : dict.thinkingCompletedTitle}
        </span>
        {isTranslating && <span className="badge badge-accent">{dict.thoughtTranslatingBadge}</span>}
        {collapsedPreview && <span className="cc-thinking-preview truncate">{collapsedPreview}</span>}
        <span className="spacer" />
        <div
          className="segmented segmented-sm cc-thinking-switch"
          onClick={(e) => e.stopPropagation()}
          title={hasTranslation ? sourceLabel : undefined}
          data-testid={`thought-track-switch-${thought.id}`}
        >
          <button
            type="button"
            className={`segmented-btn ${track === 'zh' ? 'is-active' : ''}`}
            onClick={() => {
              setTrack('zh');
            }}
            data-testid={`thought-btn-zh-${thought.id}`}
          >
            {dict.thoughtTrackZh}
          </button>
          <button
            type="button"
            className={`segmented-btn ${track === 'raw' ? 'is-active' : ''}`}
            onClick={() => {
              setTrack('raw');
            }}
            data-testid={`thought-btn-raw-${thought.id}`}
          >
            {dict.thoughtTrackRaw}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="cc-thinking-body" data-testid={`thought-content-${thought.id}`}>
          <Markdown text={flow.visibleText} compact />
        </div>
      )}
    </div>
  );
}

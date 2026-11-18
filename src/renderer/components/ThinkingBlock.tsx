import React, { useEffect, useState, useSyncExternalStore } from 'react';
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
function subscribeExpansion(listener: () => void): () => void {
  window.addEventListener(expansionKey, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(expansionKey, listener);
    window.removeEventListener('storage', listener);
  };
}
function toggleExpansion(): void {
  fallbackExpanded = !readExpanded();
  try { window.localStorage.setItem(expansionKey, String(fallbackExpanded)); } catch { /* Window memory still works. */ }
  window.dispatchEvent(new Event(expansionKey));
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
  const expanded = useSyncExternalStore(subscribeExpansion, readExpanded, () => true);
  const [track, setTrack] = useState<ThoughtDisplayTrack>(defaultTrack);

  useEffect(() => {
    setTrack(defaultTrack);
  }, [defaultTrack]);

  // 中文轨尚无可用译文时先显示原句，原文轨也可兼容只有译文的旧记录。
  const activeText =
    track === 'zh'
      ? thought.translatedZhText || thought.originalText
      : thought.originalText || thought.translatedZhText;

  const flow = useFluidStreamText(activeText, thought.isStreaming || Boolean(thought.isTranslating), 'thought', forceAnimation);

  const sourceLabel =
    thought.translationSource === 'native-zh'
      ? dict.thoughtSourceNativeZh
      : thought.translationSource === 'local-model' ? dict.localTranslatorLabel : thought.translationSource === 'acp-subagent'
        ? dict.thoughtSourceSubagent
        : thought.translationSource === 'external-api'
          ? dict.thoughtSourceExternal
          : dict.thoughtSourceGlossary;

  const isTranslating =
    track === 'zh' &&
    (Boolean(thought.isTranslating) ||
      (thought.translationSource === 'pending' && thought.languageDetected !== 'zh' && thought.isStreaming));

  const hasTranslation =
    thought.languageDetected !== 'zh' &&
    Boolean(thought.translatedZhText) &&
    thought.translatedZhText !== thought.originalText;

  const collapsedPreview = !expanded
    ? activeText
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96)
    : '';

  return (
    <div
      className={`cc-thinking ${thought.isStreaming ? 'is-streaming' : ''}`}
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

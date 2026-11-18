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

/**
 * 轻量内联格式化：用于思考流式吐字与中英替换动画期间，保持段内与行内代码不断行跳动。
 */
function renderInlineCodeSegments(text: string, keyPrefix: string): React.ReactNode[] {
  if (!text) return [];
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((part, idx) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={`${keyPrefix}-ic-${idx}`} className="inline" data-inline-code={part.slice(1, -1)}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={`${keyPrefix}-tx-${idx}`}>{part}</React.Fragment>;
  });
}

/** Claude Code 风格的 ✻ Thinking 折叠块：支持流式雾化吐字与中文渐进替换英文动效 */
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

  // 动效 2 触发条件：中文轨下正在把当前英文从句渐进替换为中文译文
  const isMorphingZhOverEn =
    track === 'zh' &&
    Boolean(thought.isTranslating) &&
    thought.languageDetected !== 'zh' &&
    Boolean(thought.zhMorphing || thought.enMorphingRemainder);

  // 动效 1：思考流连续雾化显影吐字（消除 chunk 一卡一卡顿挫）
  const thoughtFluid = useFluidStreamText(
    activeText,
    thought.isStreaming && !isMorphingZhOverEn,
    'thought',
    forceAnimation
  );

  // 动效 2：新译出的中文字符平滑推进覆盖英文余部
  const morphZhFluid = useFluidStreamText(
    thought.zhMorphing ?? '',
    isMorphingZhOverEn,
    'morph',
    forceAnimation
  );
  // 尚未送入当前翻译段的英文尾部有独立显示进度，已定稿、翻译中和待译文本可以同时连续呈现。
  const morphPendingEnFluid = useFluidStreamText(
    thought.enPendingTail ?? '',
    isMorphingZhOverEn && thought.isStreaming,
    'thought',
    forceAnimation
  );

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

  const showMistTail =
    !isMorphingZhOverEn &&
    thought.isStreaming &&
    Boolean(thoughtFluid.freshTail);

  const collapsedPreview = !expanded
    ? activeText
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96)
    : '';

  return (
    <div
      className={`cc-thinking ${thought.isStreaming ? 'is-streaming' : ''} ${isMorphingZhOverEn ? 'is-morphing' : ''}`}
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
          {isMorphingZhOverEn ? (
            <div className="cc-thought-morph-stage" data-testid={`thought-morph-stage-${thought.id}`}>
              {thought.zhFinalized && (
                <span className="cc-morph-zh-settled">
                  {renderInlineCodeSegments(thought.zhFinalized, `${thought.id}-zf`)}
                </span>
              )}
              {morphZhFluid.visibleText && (
                <span
                  key={`zh-${(thought.zhFinalized || '').length}`}
                  className="cc-morph-zh-wave"
                  data-testid={`thought-morph-zh-${thought.id}`}
                >
                  {renderInlineCodeSegments(morphZhFluid.visibleText, `${thought.id}-zm`)}
                </span>
              )}
              <span className="cc-morph-prism" aria-hidden="true" />
              {thought.enMorphingRemainder && (
                <span
                  className="cc-morph-en-dissolve"
                  data-testid={`thought-morph-en-${thought.id}`}
                >
                  {morphZhFluid.visibleText ? ' ' : ''}
                  {renderInlineCodeSegments(thought.enMorphingRemainder, `${thought.id}-er`)}
                </span>
              )}
              {morphPendingEnFluid.visibleText && (
                <span className="cc-morph-en-pending">
                  {renderInlineCodeSegments(morphPendingEnFluid.visibleText, `${thought.id}-ep`)}
                </span>
              )}
            </div>
          ) : showMistTail ? (
            <div className="cc-thought-flow" data-testid={`thought-fluid-flow-${thought.id}`}>
              <span className="cc-thought-settled">
                {renderInlineCodeSegments(thoughtFluid.settledText, `${thought.id}-st`)}
              </span>
              <span
                key={`mist-${thoughtFluid.settledText.length}`}
                className="cc-thought-mist-tail"
                data-testid={`thought-mist-tail-${thought.id}`}
              >
                {renderInlineCodeSegments(thoughtFluid.freshTail, `${thought.id}-ft`)}
              </span>
            </div>
          ) : (
            <Markdown text={activeText} compact />
          )}
        </div>
      )}
    </div>
  );
}

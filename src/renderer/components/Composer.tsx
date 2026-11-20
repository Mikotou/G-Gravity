import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  APPROVAL_MODE_ORDER,
  BUILTIN_SLASH_COMMANDS,
  EXECUTION_MODE_ORDER,
  isExternalReviewerConnected,
  REASONING_EFFORT_ORDER,
  type AcpModelOption,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type ApprovalAuditEntry,
  type ApprovalMode,
  type ApproveForMeConfig,
  type ExternalReviewerTelemetrySnapshot,
  type ManagedSessionSummary,
  type SendPromptInput,
  type SessionContextTelemetry,
} from '@shared';
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Cpu,
  FileText,
  MessageSquarePlus,
  Paperclip,
  Quote,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { getDesktopBridge, isUsingNativeDesktopBridge } from '../services/desktop-bridge';
import { MessageImage } from './MessageImage';
import { ContextStatusBar, formatTokenShort, formatUsd } from './ContextStatusBar';
import { AccountQuotaFooter } from './AccountQuotaView';
import { ResizeHandle } from './ResizeHandle';
import {
  type TextNotationItem,
  type TextQuoteItem,
} from './SelectionAnnotationTools';

import { useComposerDraft, type DraftAttachment } from '../lib/composer-draft';

type Reference = { kind: 'file' | 'session'; label: string; value: string };

type MenuItem =
  | { type: 'slash'; command: string; desc: string }
  | { type: 'file'; path: string }
  | { type: 'session'; session: ManagedSessionSummary };

export interface ComposerProps {
  session: ManagedSessionSummary;
  availableSessions: ManagedSessionSummary[];
  availableModels: AcpModelOption[];
  approvalConfig: ApproveForMeConfig;
  latestAudit?: ApprovalAuditEntry;
  sessionTelemetry?: SessionContextTelemetry;
  externalReviewerTelemetry?: ExternalReviewerTelemetrySnapshot;
  canTriggerDemoApproval: boolean;
  autoFocus?: boolean;
  quotes?: TextQuoteItem[];
  notations?: TextNotationItem[];
  focusTrigger?: number;
  onRemoveQuote?: (id: string) => void;
  onRemoveNotation?: (id: string) => void;
  onSubmitAnnotations?: (quotes: TextQuoteItem[], notations: TextNotationItem[]) => () => void;
  onEditLast?: () => void;
  onSendPrompt: (input: SendPromptInput) => Promise<void>;
  onCancelPrompt: (sessionId: string) => Promise<void>;
  onCompactContext: (sessionId: string) => Promise<void>;
  onSetSessionMode: (sessionId: string, mode: AgentExecutionMode) => Promise<void>;
  onSetSessionEffort: (sessionId: string, effort: AgentReasoningEffort) => Promise<void>;
  onSetSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  onQueryWorkspaceFiles: (cwd: string, query?: string) => Promise<string[]>;
  onCycleApprovalMode: (nextMode: ApprovalMode) => Promise<void>;
  onOpenApprovalSettings: () => void;
  onOpenExternalReviewerSettings?: () => void;
  onOpenReviewerStats?: () => void;
  onOpenContextInspector: () => void;
  onTriggerDemoApproval: (sessionId: string) => void;
}

const FALLBACK_MODELS: AcpModelOption[] = [
  { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { modelId: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { modelId: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
  { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
  { modelId: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' },
  { modelId: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  { modelId: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];

const COMPOSER_MIN_HEIGHT_KEY = 'gravity.composer.minHeight';
const COMPOSER_DEFAULT_HEIGHT = 46;
const COMPOSER_MAX_HEIGHT = 520;
/** 输入框高度只影响本机界面，按设备保存在 localStorage，不进入会话或主进程数据。 */
function readComposerMinHeight(): number {
  try {
    const v = Number(window.localStorage.getItem(COMPOSER_MIN_HEIGHT_KEY));
    return Number.isFinite(v) && v >= COMPOSER_DEFAULT_HEIGHT ? Math.min(COMPOSER_MAX_HEIGHT, v) : COMPOSER_DEFAULT_HEIGHT;
  } catch {
    return COMPOSER_DEFAULT_HEIGHT;
  }
}
function saveComposerMinHeight(v: number): void {
  const rounded = Math.round(v);
  try { window.localStorage.setItem(COMPOSER_MIN_HEIGHT_KEY, String(rounded)); } catch { /* 本次窗口内保持即可 */ }
  if (isUsingNativeDesktopBridge()) {
    void getDesktopBridge().saveWorkspaceLayout({ composerMinHeight: rounded }).catch(() => {});
  }
}

const TEXT_FILE_EXT_RE =
  /\.(?:txt|md|markdown|rst|json|jsonl|jsonc|yaml|yml|toml|ini|cfg|conf|env|xml|svg|csv|tsv|log|sql|graphql|gql|prisma|html|htm|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|py|pyi|rb|php|go|rs|java|kt|kts|scala|c|h|cc|cpp|cxx|hpp|cs|swift|m|mm|sh|bash|zsh|ps1|psm1|bat|cmd|dockerfile|makefile|cmake|gradle|lua|r|pl|dart|ex|exs|erl|hs|clj)$/i;

function isLikelyTextFile(file: File): boolean {
  const mime = (file.type || '').toLowerCase();
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/ld+json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript' ||
    mime === 'application/x-yaml' ||
    mime === 'application/sql' ||
    mime === 'application/x-sh'
  ) {
    return true;
  }
  if (mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('audio/') || mime.startsWith('video/')) {
    return false;
  }
  return TEXT_FILE_EXT_RE.test(file.name || '') || /^(?:dockerfile|makefile|readme|license|claude\.md|\.gitignore)$/i.test(file.name || '');
}

function readAsDataUrlBase64(file: File): Promise<{ dataUrl: string; base64: string } | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
      resolve(base64 ? { dataUrl, base64 } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function readAsUtf8Text(file: File): Promise<string | null> {
  if (typeof file.text === 'function') {
    return file.text().catch(() => null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * 将选取、粘贴或拖入的文件转换为草稿附件。
 * 图片保留预览，较小的文本优先读取正文，其他文件以 Base64 传送。
 */
async function readUserAttachmentFile(file: File): Promise<DraftAttachment | null> {
  if (file.size > 20 * 1024 * 1024) {
    throw new Error(`文件 ${file.name} 超过 20MB 限制`);
  }
  const id = crypto.randomUUID();
  const mimeType = file.type || 'application/octet-stream';

  if (mimeType.startsWith('image/')) {
    const parsed = await readAsDataUrlBase64(file);
    if (!parsed) return null;
    return {
      id,
      name: file.name || `clipboard-${Date.now()}.png`,
      mimeType,
      dataBase64: parsed.base64,
      previewUrl: parsed.dataUrl,
      sizeBytes: file.size,
    };
  }

  if (isLikelyTextFile(file) && file.size <= 5 * 1024 * 1024) {
    const textContent = await readAsUtf8Text(file);
    if (textContent !== null && !textContent.includes('\u0000')) {
      return {
        id,
        name: file.name || `file-${Date.now()}.txt`,
        mimeType: file.type || 'text/plain',
        textContent,
        sizeBytes: file.size,
      };
    }
  }

  const parsed = await readAsDataUrlBase64(file);
  if (!parsed) return null;
  return {
    id,
    name: file.name || `attachment-${Date.now()}`,
    mimeType,
    dataBase64: parsed.base64,
    sizeBytes: file.size,
  };
}

export function Composer({
  session,
  availableSessions,
  availableModels,
  approvalConfig,
  latestAudit,
  sessionTelemetry,
  externalReviewerTelemetry,
  canTriggerDemoApproval,
  autoFocus,
  quotes = [],
  notations = [],
  focusTrigger = 0,
  onRemoveQuote,
  onRemoveNotation,
  onSubmitAnnotations,
  onEditLast,
  onSendPrompt,
  onCancelPrompt,
  onCompactContext,
  onSetSessionMode,
  onSetSessionEffort,
  onSetSessionModel,
  onQueryWorkspaceFiles,
  onCycleApprovalMode,
  onOpenApprovalSettings,
  onOpenExternalReviewerSettings,
  onOpenReviewerStats,
  onOpenContextInspector,
  onTriggerDemoApproval,
}: ComposerProps): React.ReactElement {
  const { locale, dict } = useI18n();
  const { text: draft, setDraft, references, setReferences, attachments, setAttachments, sending, setSending, isSending } = useComposerDraft(session.sessionId);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [showConnectPrompt, setShowConnectPrompt] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const reviewerConnected = isExternalReviewerConnected(approvalConfig.externalReviewer);
  const extCum = externalReviewerTelemetry?.cumulativeAllTime;
  const extSess = externalReviewerTelemetry?.bySession?.[session.sessionId];
  const [inputMinHeight, setInputMinHeight] = useState(readComposerMinHeight);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const anyFileInputRef = useRef<HTMLInputElement | null>(null);
  const approvalMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const ui = dict.ui;

  const isStreaming = session.status === 'streaming';
  const normalizedMode: AgentExecutionMode = (EXECUTION_MODE_ORDER as readonly string[]).includes(session.executionMode)
    ? session.executionMode
    : 'default';
  const currentEffort = session.reasoningEffort || 'medium';
  const reportError = (err: unknown) => setError(formatActionError(err, dict));

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus, session.sessionId]);

  useEffect(() => {
    if (focusTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // 先释放旧高度再读 scrollHeight，删除文字时输入框也能缩回。用户拖高输入框后，上限随之放宽。
    el.style.height = 'auto';
    const maxHeight = Math.max(240, inputMinHeight);
    el.style.height = `${Math.min(maxHeight, Math.max(inputMinHeight, el.scrollHeight))}px`;
    el.style.maxHeight = `${maxHeight}px`;
  }, [draft, inputMinHeight]);

  useEffect(() => {
    if (!approvalMenuOpen && !modelMenuOpen) return;
    function onDown(e: MouseEvent): void {
      const target = e.target as Node;
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(target)) setApprovalMenuOpen(false);
      if (modelMenuRef.current && !modelMenuRef.current.contains(target)) setModelMenuOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setApprovalMenuOpen(false);
        setModelMenuOpen(false);
      }
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [approvalMenuOpen, modelMenuOpen]);

  const slashMatches = useMemo(() => {
    const trimmed = draft.trimStart();
    if (!trimmed.startsWith('/') || trimmed.includes(' ')) return [];
    const q = trimmed.toLowerCase();
    return BUILTIN_SLASH_COMMANDS.filter((item) => item.command.toLowerCase().startsWith(q));
  }, [draft]);

  // 只对草稿末尾正在输入的 @ 片段触发补全。null 表示未处于补全状态，空字符串表示用户刚输入 @。
  const mentionToken = useMemo(() => {
    const match = /(?:^|\s)@([^\s@]*)$/.exec(draft);
    return match ? match[1] : null;
  }, [draft]);

  useEffect(() => {
    if (mentionToken === null) {
      setMentionFiles([]);
      return;
    }
    // 每次查询绑定当时的目录和搜索词。输入变化时废弃旧结果，较慢的响应不会覆盖新列表。
    let cancelled = false;
    void onQueryWorkspaceFiles(session.cwd, mentionToken)
      .then((files) => {
        if (!cancelled) setMentionFiles(files.slice(0, 8));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mentionToken, onQueryWorkspaceFiles, session.cwd]);

  const menuItems: MenuItem[] = useMemo(() => {
    if (slashMatches.length > 0) {
      return slashMatches.map((sc) => ({
        type: 'slash' as const,
        command: sc.command,
        desc: locale === 'zh-CN' ? sc.descriptionZh : sc.descriptionEn,
      }));
    }
    if (mentionToken !== null) {
      const q = mentionToken.toLowerCase();
      return [
        ...mentionFiles.map((path) => ({ type: 'file' as const, path })),
        ...availableSessions
          .filter((s) => s.sessionId !== session.sessionId && s.title.toLowerCase().includes(q))
          .slice(0, 3)
          .map((s) => ({ type: 'session' as const, session: s })),
      ];
    }
    return [];
  }, [availableSessions, locale, mentionFiles, mentionToken, session.sessionId, slashMatches]);

  useEffect(() => {
    setMenuIndex(0);
  }, [menuItems.length, slashMatches.length, mentionToken]);

  /** 将选中的文件或会话保存为结构化引用，按类型和值去重。输入框里触发补全的临时片段随即移除。 */
  function addReference(ref: Reference): void {
    setReferences((prev) =>
      prev.some((r) => r.kind === ref.kind && r.value === ref.value) ? prev : [...prev, ref]
    );
    setDraft((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, ' ').trimStart());
  }

  function applyMenuItem(item: MenuItem): void {
    if (item.type === 'slash') setDraft(`${item.command} `);
    else if (item.type === 'file') addReference({ kind: 'file', label: item.path, value: item.path });
    else addReference({ kind: 'session', label: item.session.title, value: item.session.sessionId });
    textareaRef.current?.focus();
  }

  async function addFiles(files: File[]): Promise<void> {
    setError(null);
    try {
      const results = await Promise.all(files.map(readUserAttachmentFile));
      const valid = results.filter((item): item is DraftAttachment => Boolean(item));
      if (valid.length) setAttachments((prev) => [...prev, ...valid]);
    } catch (err) {
      reportError(err);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === 'file' || item.type?.startsWith('image/')) {
        const file = item.getAsFile?.();
        if (file) files.push(file);
      }
    }
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer.files));
  }

  const hasQuotesOrNotations = quotes.length > 0 || notations.length > 0;

  const sendLabel = notations.length ? (locale === 'zh-CN' ? '发送 ' + notations.length + ' 条批注' : 'Send annotations (' + notations.length + ')') : dict.sendMessageBtn;
  async function submit(): Promise<void> {
    const text = draft.trim();
    if ((!text && attachments.length === 0 && !hasQuotesOrNotations) || isSending() || isStreaming) return;
    setError(null);

    // 独立输入的 /compact 和 /plan 走各自的操作入口。带有引用摘录或批注时，草稿会与它们一起构造成消息。
    if (text === '/compact' && !hasQuotesOrNotations) {
      setDraft('');
      try {
        await onCompactContext(session.sessionId);
      } catch (err) {
        reportError(err);
      }
      return;
    }
    if (text === '/plan' && !hasQuotesOrNotations) {
      setDraft('');
      void onSetSessionMode(session.sessionId, 'plan').catch(reportError);
      return;
    }

    const prevDraft = draft;
    const prevRefs = [...references];
    const prevAtts = [...attachments];
    const prevQuotes = [...quotes];
    const prevNotations = [...notations];
    const hasImage = prevAtts.some((a) => Boolean(a.previewUrl));
    const annotations = [
      ...prevQuotes.map(q => ({ messageId: q.messageId, excerpt: q.text })),
      ...prevNotations.map(n => ({ messageId: n.messageId, messageNumber: n.messageNumber, excerpt: n.selectedText, comment: n.comment })),
    ];
    const visibleText = text || (annotations.length ? '' : `[${hasImage ? dict.pastedImageBadge : dict.attachedFileBadge}]`);

    // 先清空当前输入以反馈发送状态。如果发送失败，下方 catch 用快照还原正文、文件或会话引用以及附件。
    setDraft('');
    setReferences([]);
    setAttachments([]);
    setSending(true);
    const restoreAnnotations = onSubmitAnnotations?.(prevQuotes, prevNotations);
    try {
      await onSendPrompt({
        sessionId: session.sessionId,
        text: visibleText,
        annotations: annotations.length ? annotations : undefined,
        references: prevRefs.length ? prevRefs : undefined,
        attachments: prevAtts.length
          ? prevAtts.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              dataBase64: a.dataBase64,
              textContent: a.textContent,
              sizeBytes: a.sizeBytes,
            }))
          : undefined,
      });
    } catch (err) {
      restoreAnnotations?.();
      setDraft(current => [prevDraft, current].filter(Boolean).join('\n'));
      setReferences(current => [...prevRefs, ...current.filter(r => !prevRefs.some(p => p.value === r.value && p.kind === r.kind))]);
      setAttachments(current => [...prevAtts, ...current]);
      reportError(err);
    } finally {
      setSending(false);
    }
  }

  function cycleMode(): void {
    const idx = EXECUTION_MODE_ORDER.indexOf(normalizedMode);
    const nextMode = EXECUTION_MODE_ORDER[(idx + 1) % EXECUTION_MODE_ORDER.length];
    void onSetSessionMode(session.sessionId, nextMode).catch(reportError);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowUp' && onEditLast && !draft && !menuItems.length && !references.length && !attachments.length &&
        !hasQuotesOrNotations && !sending && !isStreaming && session.status !== 'waiting_approval' &&
        !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      onEditLast();
      return;
    }
    if (menuItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        applyMenuItem(menuItems[menuIndex] ?? menuItems[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft((prev) => prev.replace(/(?:^|\s)@([^\s@]*)$/, ' ').replace(/^\s*\/\S*$/, ''));
        return;
      }
    }
    // 中文输入法正在组词时由输入法接管回车。普通回车先确认候选，候选已是完整命令时才直接提交。
    if (e.key === 'Escape' && isStreaming && !approvalMenuOpen && !modelMenuOpen) {
      // Claude Code 式中断：生成中按 Esc 停止当前回合，草稿保持不变。
      e.preventDefault();
      void onCancelPrompt(session.sessionId).catch(reportError);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      const item = menuItems[menuIndex] ?? menuItems[0];
      if (item && !(item.type === 'slash' && draft.trim() === item.command)) {
        e.preventDefault();
        applyMenuItem(item);
        return;
      }
      e.preventDefault();
      void submit();
    }
  }

  // 模型选项优先反映当前会话声明的能力，再使用全局列表或界面后备值。最终设置仍由主进程核验。
  const modelChoices =
    session.availableModels && session.availableModels.length > 0
      ? session.availableModels
      : availableModels.length > 0
        ? availableModels
        : FALLBACK_MODELS;

  const effortChoices: Array<{ value: AgentReasoningEffort; name: string }> = Array.isArray(session.availableEfforts)
    ? session.availableEfforts
    : REASONING_EFFORT_ORDER.map((ef) => ({ value: ef, name: dict.effortLevels[ef] }));

  const modeArrows = normalizedMode === 'default' ? '›' : normalizedMode === 'plan' ? '⏸' : '⏵⏵';
  const allModelChoices: AcpModelOption[] =
    session.modelId && !modelChoices.some((m) => m.modelId === session.modelId)
      ? [...modelChoices, { modelId: session.modelId, name: session.modelId }]
      : modelChoices;
  const currentModelName = allModelChoices.find((m) => m.modelId === session.modelId)?.name || session.modelId || 'Model';
  const effectiveEffort: AgentReasoningEffort = effortChoices.some((ef) => ef.value === currentEffort)
    ? currentEffort
    : effortChoices[0]?.value ?? currentEffort;

  return (
    <div className="composer-dock">
      <div className="composer-wrap">
        {error && (
          <div role="alert" className="alert" data-testid={`pane-error-${session.sessionId}`}>
            {error}
          </div>
        )}

        {menuItems.length > 0 && slashMatches.length > 0 && (
          <div className="popover composer-menu" data-testid={`slash-menu-${session.sessionId}`}>
            <div className="menu-label">{dict.slashMenuHeader}</div>
            {menuItems.map((item, idx) =>
              item.type === 'slash' ? (
                <button
                  key={item.command}
                  type="button"
                  className={`menu-item ${idx === menuIndex ? 'is-active' : ''}`}
                  onMouseEnter={() => setMenuIndex(idx)}
                  onClick={() => applyMenuItem(item)}
                >
                  <span className="menu-item-main">{item.command}</span>
                  <span className="menu-item-desc truncate">{item.desc}</span>
                </button>
              ) : null
            )}
          </div>
        )}

        {mentionToken !== null && slashMatches.length === 0 && (
          <div className="popover composer-menu" data-testid={`mention-menu-${session.sessionId}`}>
            <div className="menu-label">{dict.mentionMenuHeader}</div>
            {menuItems.map((item, idx) => {
              if (item.type === 'slash') return null;
              const key = item.type === 'file' ? `f-${item.path}` : `s-${item.session.sessionId}`;
              return (
                <button
                  key={key}
                  type="button"
                  className={`menu-item ${idx === menuIndex ? 'is-active' : ''}`}
                  onMouseEnter={() => setMenuIndex(idx)}
                  onClick={() => applyMenuItem(item)}
                >
                  <AtSign size={12} className="muted" />
                  <span className={item.type === 'file' ? 'mono truncate' : 'truncate'}>
                    {item.type === 'file' ? item.path : item.session.title}
                  </span>
                  <span className="badge">{item.type === 'file' ? 'File' : 'Thread'}</span>
                </button>
              );
            })}
          </div>
        )}

        <div
          className={`composer ${isStreaming ? 'is-busy' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
          }}
          onDrop={handleDrop}
        >
          <ResizeHandle
            axis="y"
            value={inputMinHeight}
            min={COMPOSER_DEFAULT_HEIGHT}
            max={COMPOSER_MAX_HEIGHT}
            defaultValue={COMPOSER_DEFAULT_HEIGHT}
            direction={-1}
            label={ui.resizeComposer}
            className="composer-grip"
            testId={`composer-resize-${session.sessionId}`}
            onPreview={setInputMinHeight}
            onCommit={(v) => { setInputMinHeight(v); saveComposerMinHeight(v); }}
          />
          {hasQuotesOrNotations && (
            <div className="composer-annotations-tray" data-testid={`composer-annotations-${session.sessionId}`}>
              {quotes.map((q) => (
                <div key={q.id} className="composer-quote-pill" data-testid={`composer-quote-${q.id}`}>
                  <Quote size={11} className="composer-quote-icon" />
                  <span className="truncate" title={q.text}>
                    {q.text.replace(/\s+/g, ' ')}
                  </span>
                  {onRemoveQuote && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      aria-label={locale === 'zh-CN' ? '移除引用' : 'Remove quote'}
                      onClick={() => onRemoveQuote(q.id)}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
              {notations.map((nt, idx) => (
                <div key={nt.id} className="composer-notation-pill" data-testid={`composer-notation-${nt.id}`}>
                  <span className="composer-notation-idx">#{idx + 1}</span>
                  <MessageSquarePlus size={11} className="composer-quote-icon" />
                  <span className="composer-notation-snippet truncate" title={nt.selectedText}>
                    「{nt.selectedText.replace(/\s+/g, ' ')}」
                  </span>
                  <span className="muted">→</span>
                  <span className="composer-notation-comment truncate" title={nt.comment}>
                    {nt.comment}
                  </span>
                  {onRemoveNotation && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-sm"
                      aria-label={locale === 'zh-CN' ? '移除批注' : 'Remove notation'}
                      onClick={() => onRemoveNotation(nt.id)}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {attachments.some(a => a.previewUrl) && <div className="composer-image-tray" data-testid="composer-image-tray">
            {attachments.filter(a => a.previewUrl).map(att => <figure key={att.id}>
              <MessageImage source={att.previewUrl!} alt={att.name} />
              <button type="button" className="icon-btn composer-image-remove" aria-label={dict.removeAttachmentLabel + ' ' + att.name}
                onClick={() => setAttachments(items => items.filter(item => item.id !== att.id))}><X size={13} /></button>
              <figcaption title={att.name}>{att.name}</figcaption>
            </figure>)}
          </div>}
          {(references.length > 0 || attachments.some(a => !a.previewUrl)) && (
            <div className="composer-chips">
              {references.map((r) => (
                <span key={`${r.kind}-${r.value}`} className="chip chip-mono" title={r.value}>
                  <AtSign size={11} className="muted" />
                  <span className="truncate">{r.label}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={dict.removeAttachmentLabel}
                    onClick={() => setReferences((prev) => prev.filter((item) => item.value !== r.value))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {attachments.filter(a => !a.previewUrl).map((att) => (
                <span key={att.id} className="chip" title={att.name}>
                  <FileText size={12} className="muted" />
                  <span className="truncate">{att.name}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={dict.removeAttachmentLabel}
                    onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== att.id))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            placeholder={isStreaming ? `${dict.composerPlaceholderBusy}  ·  ${ui.interruptHint}` : dict.composerPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={onKeyDown}
            data-testid={`composer-input-${session.sessionId}`}
          />

          <div className="composer-bar">
            <button
              type="button"
              className={`mode-pill mode-${normalizedMode}`}
              onClick={cycleMode}
              title={`${dict.executionModes[normalizedMode].desc} (Shift+Tab)`}
              data-testid={`execution-mode-pill-${session.sessionId}`}
            >
              <span>{modeArrows}</span>
              <span>{dict.executionModes[normalizedMode].label}</span>
            </button>

            <div className="menu-anchor" ref={approvalMenuRef}>
              <button
                type="button"
                className="mode-pill"
                onClick={() => {
                  setApprovalMenuOpen((open) => {
                    if (open) setShowConnectPrompt(false);
                    return !open;
                  });
                }}
                title={dict.approvalModes[approvalConfig.mode].shortDesc}
                data-testid={`approval-mode-pill-${session.sessionId}`}
              >
                <ShieldCheck size={13} />
                <span className="approval-label">{dict.approvalModes[approvalConfig.mode].label}</span>
              </button>
              {approvalMenuOpen && (
                <div className="popover menu-up" style={{ width: 274 }} data-testid={`approval-menu-${session.sessionId}`}>
                  <div className="menu-label">{dict.approvalMenuTitle}</div>
                  {APPROVAL_MODE_ORDER.map((mode) => {
                    const lockedHybrid = mode === 'hybrid' && !reviewerConnected;
                    return (
                      <button
                        key={mode}
                        type="button"
                        className={`menu-item ${approvalConfig.mode === mode ? 'is-checked' : ''}`}
                        title={
                          lockedHybrid
                            ? locale === 'zh-CN'
                              ? '需先连接外部复核模型方可开启 AI 代审'
                              : 'Connect an external reviewer first to enable AI review'
                            : dict.approvalModes[mode].shortDesc
                        }
                        data-testid={`approval-menu-mode-${mode}-${session.sessionId}`}
                        onClick={() => {
                          if (lockedHybrid) {
                            setShowConnectPrompt(true);
                            return;
                          }
                          setShowConnectPrompt(false);
                          setApprovalMenuOpen(false);
                          void onCycleApprovalMode(mode).catch(reportError);
                        }}
                      >
                        <span className="menu-check">{approvalConfig.mode === mode ? <Check size={13} /> : null}</span>
                        <span style={{ fontWeight: 550 }}>{dict.approvalModes[mode].label}</span>
                        {lockedHybrid && (
                          <span
                            className="muted"
                            style={{ marginLeft: 'auto', fontSize: 10.5 }}
                            data-testid={`approval-hybrid-unconnected-tag-${session.sessionId}`}
                          >
                            {locale === 'zh-CN' ? '未连接外部复核' : 'Not connected'}
                          </span>
                        )}
                      </button>
                    );
                  })}

                  {showConnectPrompt && !reviewerConnected && (
                    <div
                      className="approval-connect-prompt"
                      data-testid={`approval-connect-reviewer-prompt-${session.sessionId}`}
                    >
                      <span>
                        {locale === 'zh-CN'
                          ? '尚未连接外部复核模型，无法开启「AI 代审」；当前仅可使用基础规则机制（仅规则 / 人工审批）。'
                          : 'Connect an external reviewer API first to enable AI review; only basic rules or manual mode are available.'}
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={() => {
                          setShowConnectPrompt(false);
                          setApprovalMenuOpen(false);
                          if (onOpenExternalReviewerSettings) onOpenExternalReviewerSettings();
                          else onOpenApprovalSettings();
                        }}
                        data-testid={`approval-goto-connect-btn-${session.sessionId}`}
                      >
                        {locale === 'zh-CN' ? '前往连接外部复核 →' : 'Connect External Reviewer →'}
                      </button>
                    </div>
                  )}

                  <div className="menu-sep" />
                  <div
                    className="approval-usage-box"
                    data-testid={`approval-menu-reviewer-usage-${session.sessionId}`}
                  >
                    <div className="approval-usage-row">
                      <span style={{ fontWeight: 600 }}>
                        {locale === 'zh-CN' ? '外部复核 API 用量' : 'Reviewer API Usage'}
                      </span>
                      <span className={`badge ${reviewerConnected ? 'badge-success' : ''}`} style={{ fontSize: 10, padding: '0 5px' }}>
                        {reviewerConnected
                          ? locale === 'zh-CN' ? '已连接' : 'Live'
                          : locale === 'zh-CN' ? '未连接' : 'Off'}
                      </span>
                    </div>
                    <div className="approval-usage-row">
                      <span className="muted">{locale === 'zh-CN' ? '本会话' : 'Session'}</span>
                      <span className="mono">
                        {extSess ? `${extSess.callCount}× · ${formatTokenShort(extSess.totalTokens)} · ${formatUsd(extSess.totalCostUsd)}` : '0× · $0.00'}
                      </span>
                    </div>
                    <div
                      className="approval-usage-row"
                      title={
                        extCum && extCum.providerCount > 1
                          ? locale === 'zh-CN'
                            ? `已联合统计 ${extCum.providerCount} 个历史 API 服务商`
                            : `Combined across ${extCum.providerCount} API providers`
                          : undefined
                      }
                    >
                      <span className="muted">
                        {locale === 'zh-CN'
                          ? `客户端累计${extCum && extCum.providerCount > 1 ? ` (${extCum.providerCount}商)` : ''}`
                          : 'All-time'}
                      </span>
                      <span className="mono" style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                        {extCum && extCum.callCount > 0
                          ? `${extCum.callCount}× · ${formatTokenShort(extCum.totalTokens)} · ${formatUsd(extCum.totalCostUsd)}`
                          : '0× · $0.00'}
                      </span>
                    </div>
                    {onOpenReviewerStats && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ justifyContent: 'flex-start', padding: '2px 4px', marginTop: 2, fontSize: 11 }}
                        onClick={() => {
                          setShowConnectPrompt(false);
                          setApprovalMenuOpen(false);
                          onOpenReviewerStats();
                        }}
                        data-testid={`approval-open-reviewer-stats-btn-${session.sessionId}`}
                      >
                        {locale === 'zh-CN' ? '查看 24h / 7d / 30d 分布与明细 →' : 'View 24h / 7d / 30d stats →'}
                      </button>
                    )}
                  </div>

                  {latestAudit && (
                    <>
                      <div className="menu-sep" />
                      <div className="menu-label" title={latestAudit.reason}>
                        {dict.verdictLabels[latestAudit.verdict]} · {latestAudit.latencyMs}ms
                      </div>
                    </>
                  )}
                  <div className="menu-sep" />
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setShowConnectPrompt(false);
                      setApprovalMenuOpen(false);
                      onOpenApprovalSettings();
                    }}
                    data-testid={`open-approval-drawer-btn-${session.sessionId}`}
                  >
                    <span className="menu-check" />
                    <span>{dict.rulesAndAuditLink}</span>
                  </button>
                </div>
              )}
            </div>

            <span className="spacer" />

            <input
              ref={anyFileInputRef}
              type="file"
              multiple
              hidden
              data-testid={`attach-file-input-${session.sessionId}`}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) void addFiles(files);
              }}
            />
            <button
              type="button"
              className="icon-btn attach-btn"
              title={`${dict.attachFileLabel} / ${dict.attachImageLabel}`}
              aria-label={dict.attachFileLabel}
              onClick={() => anyFileInputRef.current?.click()}
              data-testid={`attach-file-btn-${session.sessionId}`}
            >
              <Paperclip size={15} />
            </button>

            <div className="menu-anchor" ref={modelMenuRef}>
              <button
                type="button"
                className={`model-chip ${modelMenuOpen ? 'is-open' : ''}`}
                onClick={() => setModelMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                title={`${ui.modelMenuTitle} · ${ui.effortTitle}`}
                data-testid={`model-select-${session.sessionId}`}
              >
                <Cpu size={12} className="model-chip-icon" />
                <span className="model-chip-name truncate">{currentModelName}</span>
                {effortChoices.length > 0 && (
                  <span className="model-chip-effort">{dict.effortLevels[effectiveEffort] ?? effectiveEffort}</span>
                )}
                <ChevronDown size={12} className="model-chip-chev" />
              </button>
              {modelMenuOpen && (
                <div className="popover menu-up menu-right model-menu" role="menu" data-testid={`model-menu-${session.sessionId}`}>
                  <div className="menu-label">{ui.modelMenuTitle}</div>
                  <div className="model-menu-list">
                    {allModelChoices.map((m) => (
                      <button
                        key={m.modelId}
                        type="button"
                        role="menuitemradio"
                        aria-checked={m.modelId === session.modelId}
                        className={`menu-item ${m.modelId === session.modelId ? 'is-checked' : ''}`}
                        title={m.description || m.modelId}
                        onClick={() => {
                          setModelMenuOpen(false);
                          if (m.modelId !== session.modelId) void onSetSessionModel(session.sessionId, m.modelId).catch(reportError);
                        }}
                      >
                        <span className="menu-check">{m.modelId === session.modelId ? <Check size={13} /> : null}</span>
                        <span className="truncate">{m.name || m.modelId}</span>
                      </button>
                    ))}
                  </div>
                  {effortChoices.length > 0 && (
                    <>
                      <div className="menu-sep" />
                      <div className="menu-label">{ui.effortTitle}</div>
                      <div className="segmented segmented-sm effort-segmented" role="radiogroup" aria-label="Effort"
                        data-testid={`effort-select-${session.sessionId}`}>
                        {effortChoices.map((ef) => (
                          <button
                            key={ef.value}
                            type="button"
                            role="radio"
                            aria-checked={effectiveEffort === ef.value}
                            className={`segmented-btn ${effectiveEffort === ef.value ? 'is-active' : ''}`}
                            onClick={() => {
                              if (ef.value !== effectiveEffort) void onSetSessionEffort(session.sessionId, ef.value).catch(reportError);
                            }}
                          >
                            {dict.effortLevels[ef.value] ?? ef.value}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {canTriggerDemoApproval && (
              <button
                type="button"
                className="icon-btn"
                title={dict.triggerDemoApprovalBtn}
                aria-label={dict.triggerDemoApprovalBtn}
                onClick={() => onTriggerDemoApproval(session.sessionId)}
                data-testid={`trigger-demo-approval-${session.sessionId}`}
              >
                <Sparkles size={15} />
              </button>
            )}

            {isStreaming ? (
              <button
                type="button"
                className="send-btn is-stop"
                title={dict.stopGeneratingBtn}
                aria-label={dict.stopGeneratingBtn}
                onClick={() => void onCancelPrompt(session.sessionId).catch(reportError)}
                data-testid={`cancel-prompt-btn-${session.sessionId}`}
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                title={sendLabel}
                aria-label={sendLabel}
                disabled={(!draft.trim() && attachments.length === 0 && !hasQuotesOrNotations) || sending}
                onClick={() => void submit()}
                data-testid={`send-prompt-btn-${session.sessionId}`}
              >
                <ArrowUp size={16} />{notations.length > 0 && <span>{notations.length}</span>}
              </button>
            )}
          </div>
        </div>

        <AccountQuotaFooter key={session.profileId} profileId={session.profileId} generating={isStreaming}>
          <ContextStatusBar
            sessionId={session.sessionId}
            modelId={session.modelId}
            sessionTelemetry={sessionTelemetry}
            onCompactContext={onCompactContext}
            onOpenContextInspector={onOpenContextInspector}
          />
        </AccountQuotaFooter>
      </div>
    </div>
  );
}

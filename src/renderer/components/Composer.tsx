import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  APPROVAL_MODE_ORDER,
  BUILTIN_SLASH_COMMANDS,
  buildDiagnosticBanner,
  classifyErrorToDiagnosticCode,
  EXECUTION_MODE_ORDER,
  isExternalReviewerConnected,
  REASONING_EFFORT_ORDER,
  type AcpConnectionStatus,
  type AcpModelOption,
  type AgentExecutionMode,
  type AgentReasoningEffort,
  type ApprovalAuditEntry,
  type ApprovalMode,
  type ApproveForMeConfig,
  type ConversationTreeTotalCost,
  type ExternalReviewerTelemetrySnapshot,
  type ManagedSessionSummary,
  type SendPromptInput,
  type SessionApprovalGrantsSnapshot,
  type SessionContextTelemetry,
} from '@shared';
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Cpu,
  FileText,
  Loader2,
  RotateCw,
  MessageSquarePlus,
  Paperclip,
  Quote,
  ShieldCheck,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { formatActionError } from '../i18n/locales';
import { getDesktopBridge, isUsingNativeDesktopBridge } from '../services/desktop-bridge';
import { useWorkspaceWriters, type WorkspaceWriters } from '../lib/workspace-writers';
import { MessageImage } from './MessageImage';
import { ContextStatusBar } from './ContextStatusBar';
import { AccountQuotaFooter } from './AccountQuotaView';
import { ResizeHandle } from './ResizeHandle';
import { setActiveAnnotation, toWireAnnotations, type AnnotationDraftItem } from '../lib/annotation-drafts';

import { useComposerDraft, type DraftAttachment } from '../lib/composer-draft';
import { isImeComposing } from '../lib/platform-keys';
import { Icon } from './ui/Icon';
import { VoiceControls } from './VoiceControls';
import { useVoiceCapture } from '../hooks/useVoiceCapture';
import { EXECUTION_MODE_ICONS } from './ui/mode-icons';

type Reference = { kind: 'file' | 'session'; label: string; value: string };
const EMPTY_ANNOTATIONS: AnnotationDraftItem[] = [];

/**
 * 已在本次运行中确认过 Turbo 风险提示的会话。仅保存在内存中：重启应用后首次切换会再次提示，
 * 防止长期遗忘「完全访问」的含义；Shift+Tab 永远不会进入 Turbo。
 */
const turboAcknowledgedSessions = new Set<string>();

type MenuItem =
  | { type: 'slash'; command: string; desc: string }
  | { type: 'file'; path: string }
  | { type: 'session'; session: ManagedSessionSummary };

export interface ComposerProps {
  session: ManagedSessionSummary;
  availableSessions: ManagedSessionSummary[];
  availableModels: AcpModelOption[];
  modelListSource?: 'live' | 'cached' | 'unknown';
  approvalConfig: ApproveForMeConfig;
  latestAudit?: ApprovalAuditEntry;
  sessionTelemetry?: SessionContextTelemetry;
  treeCost?: ConversationTreeTotalCost;
  externalReviewerTelemetry?: ExternalReviewerTelemetrySnapshot;
  /** @deprecated v0.3.4：演示审批已移出生产界面（仅测试夹具可直接调用 fallback bridge），保留可选签名兼容调用方 */
  canTriggerDemoApproval?: boolean;
  autoFocus?: boolean;
  /** v0.3.6：所在窗格是否为焦点窗格（F5 听写快捷键只作用于焦点窗格） */
  paneFocused?: boolean;
  /** v0.3.6：单一有序引用/批注条目 */
  annotations?: AnnotationDraftItem[];
  /** 聚焦某条目的批注框（引用后或重复引用时） */
  annotationFocus?: { id: string; seq: number; notice?: string } | null;
  focusTrigger?: number;
  onUpdateAnnotation?: (id: string, comment: string) => void;
  onRemoveAnnotation?: (id: string) => void;
  onSubmitAnnotations?: (items: AnnotationDraftItem[]) => () => void;
  onEditLast?: () => void;
  onSendPrompt: (input: SendPromptInput) => Promise<void>;
  onCancelPrompt: (sessionId: string) => Promise<void>;
  onCompactContext: (sessionId: string) => Promise<void>;
  onSetSessionMode: (sessionId: string, mode: AgentExecutionMode) => Promise<void>;
  onSetSessionEffort: (sessionId: string, effort: AgentReasoningEffort) => Promise<void>;
  onSetSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  onQueryWorkspaceFiles: (cwd: string, query?: string) => Promise<string[]>;
  onCycleApprovalMode: (nextMode: ApprovalMode) => Promise<void>;
  onClearSessionApprovals?: (sessionId: string) => Promise<void>;
  onOpenApprovalSettings: () => void;
  onOpenExternalReviewerSettings?: () => void;
  onOpenReviewerStats?: () => void;
  onOpenContextInspector: () => void;
  /** @deprecated v0.3.4：见 canTriggerDemoApproval */
  onTriggerDemoApproval?: (sessionId: string) => void;
  /** 已发出停止请求，等待回合结算 */
  stopping?: boolean;
  /** AQ-1：当前活动账号是否为隔离 Profile（跳过默认自动额度探测） */
  isIsolatedProfile?: boolean;
  /** AQ-1：实时连接状态（同步 429/403 冷却暂停状态给额度组件） */
  connection?: AcpConnectionStatus;
}

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
function saveComposerMinHeight(v: number, writers: WorkspaceWriters): void {
  const rounded = Math.round(v);
  try { window.localStorage.setItem(COMPOSER_MIN_HEIGHT_KEY, String(rounded)); } catch { /* 本次窗口内保持即可 */ }
  if (isUsingNativeDesktopBridge()) {
    // 经由 App.patchLayout 写入，App 的布局快照随之更新，后续整体布局保存不会把旧高度写回。
    void writers.patchLayout({ composerMinHeight: rounded }).catch(() => {});
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
class AttachmentTooLargeError extends Error {
  constructor(readonly fileName: string) {
    super(`${fileName} > 20MB`);
  }
}

async function readUserAttachmentFile(file: File): Promise<DraftAttachment | null> {
  if (file.size > 20 * 1024 * 1024) {
    throw new AttachmentTooLargeError(file.name);
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
  modelListSource,
  approvalConfig,
  latestAudit,
  sessionTelemetry,
  treeCost,
  externalReviewerTelemetry,
  autoFocus,
  paneFocused,
  annotations: annotationItems = EMPTY_ANNOTATIONS,
  annotationFocus,
  focusTrigger = 0,
  onUpdateAnnotation,
  onRemoveAnnotation,
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
  onClearSessionApprovals,
  onOpenApprovalSettings,
  onOpenExternalReviewerSettings,
  onOpenReviewerStats,
  onOpenContextInspector,
  stopping = false,
  isIsolatedProfile = false,
  connection,
}: ComposerProps): React.ReactElement {
  const { locale, dict, keys } = useI18n();
  const { text: draft, setDraft, references, setReferences, attachments, setAttachments, sending, setSending, isSending } = useComposerDraft(session.sessionId);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [error, setErrorState] = useState<{ message: string; hint?: string } | null>(null);
  const setError = (value: string | null) => setErrorState(value ? { message: value } : null);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [showConnectPrompt, setShowConnectPrompt] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [turboConfirmOpen, setTurboConfirmOpen] = useState(false);
  const reviewerConnected = isExternalReviewerConnected(approvalConfig.externalReviewer);
  const [inputMinHeight, setInputMinHeight] = useState(readComposerMinHeight);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const anyFileInputRef = useRef<HTMLInputElement | null>(null);
  const approvalMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const ui = dict.ui;
  const t6 = ui.v036;

  const isStreaming = session.status === 'streaming';
  const turnActive = isStreaming || session.status === 'waiting_approval';
  const normalizedMode: AgentExecutionMode = (EXECUTION_MODE_ORDER as readonly string[]).includes(session.executionMode)
    ? session.executionMode
    : 'default';
  const currentEffort = session.reasoningEffort || 'medium';
  // 发送 / 停止等失败统一收敛到可关闭的错误条，并按诊断分类附上一条可执行建议。
  const reportError = (err: unknown) => {
    if (err instanceof AttachmentTooLargeError) {
      setErrorState({ message: ui.attachmentTooLarge(err.fileName) });
      return;
    }
    const code = classifyErrorToDiagnosticCode(err);
    const banner = code === 'unknown_error' ? undefined : buildDiagnosticBanner(code);
    const hint = banner ? (locale === 'zh-CN' ? banner.suggestionsZh[0] : banner.suggestionsEn[0]) : undefined;
    setErrorState({ message: formatActionError(err, dict), hint });
  };
  const [grants, setGrants] = useState<SessionApprovalGrantsSnapshot | null>(null);
  const [grantsState, setGrantsState] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  const [grantsError, setGrantsError] = useState('');
  const [grantsReload, setGrantsReload] = useState(0);
  const [revokingGrant, setRevokingGrant] = useState<string | null>(null);
  const workspaceWriters = useWorkspaceWriters();
  const grantsSupported = typeof getDesktopBridge().listSessionApprovalGrants === 'function';
  const sessionApprovalMode = session.approvalModeOverride ?? approvalConfig.mode;

  useEffect(() => {
    const input = textareaRef.current;
    if (autoFocus && input && !input.closest('.pane')?.contains(document.activeElement)) input.focus();
  }, [autoFocus, session.sessionId]);

  useEffect(() => {
    if (focusTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  // v0.3.6：合规语音听写（F5 / /voice / /record / 麦克风按钮）；停录只保留文本，绝不自动发送
  const composingRef = useRef(false);
  const voice = useVoiceCapture({ profileId: session.profileId || 'default', sessionId: session.sessionId, textareaRef, composingRef });
  const voiceToggleRef = useRef(voice.toggle);
  voiceToggleRef.current = voice.toggle;
  const voicePhaseRef = useRef(voice.phase);
  voicePhaseRef.current = voice.phase;
  const voiceAbortRef = useRef(voice.abort);
  voiceAbortRef.current = voice.abort;
  useEffect(() => {
    if (!paneFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F5' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || isImeComposing(e)) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      e.preventDefault();
      voiceToggleRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneFocused]);

  // QA1-FE-08：语音采集非 idle 时，在 window 捕获阶段先拦截 Esc，确保无论焦点在按钮还是输入框都仅中止听写，绝不穿透到 SessionPane 中断 AI
  useEffect(() => {
    if (voice.phase === 'idle') return;
    const onCaptureEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isImeComposing(e) || voicePhaseRef.current === 'idle') return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      voiceAbortRef.current();
    };
    window.addEventListener('keydown', onCaptureEsc, true);
    return () => window.removeEventListener('keydown', onCaptureEsc, true);
  }, [voice.phase]);

  // v0.3.6：引用后聚焦该条自己的批注框；重复引用时提示「已引用为 #n」
  const annotationInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const [annotationNotice, setAnnotationNotice] = useState('');
  useEffect(() => {
    if (!annotationFocus) return;
    const el = annotationInputs.current.get(annotationFocus.id);
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
    setAnnotationNotice(annotationFocus.notice ?? '');
    if (!annotationFocus.notice) return;
    const timer = window.setTimeout(() => setAnnotationNotice(''), 2400);
    return () => window.clearTimeout(timer);
  }, [annotationFocus]);

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
    if (!approvalMenuOpen && !modelMenuOpen && !modeMenuOpen) return;
    function onDown(e: MouseEvent): void {
      const target = e.target as Node;
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(target)) setApprovalMenuOpen(false);
      if (modelMenuRef.current && !modelMenuRef.current.contains(target)) setModelMenuOpen(false);
      if (modeMenuRef.current && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false);
        setTurboConfirmOpen(false);
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setApprovalMenuOpen(false);
        setModelMenuOpen(false);
        setModeMenuOpen(false);
        setTurboConfirmOpen(false);
      }
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [approvalMenuOpen, modelMenuOpen, modeMenuOpen]);

  // 审批菜单无论以何种方式关闭（点外部、Esc、选择档位），都收起「去连接外部复核」提示。
  useEffect(() => {
    if (!approvalMenuOpen) setShowConnectPrompt(false);
  }, [approvalMenuOpen]);

  // 切换会话时收起模式菜单与 Turbo 确认步骤，避免把上一个会话的确认带到当前会话。
  useEffect(() => {
    setModeMenuOpen(false);
    setTurboConfirmOpen(false);
  }, [session.sessionId]);

  // 打开权限浮层时读取本会话的 Guardian 委派与已记住前缀；会话授权变化时同步刷新。
  useEffect(() => {
    if (!approvalMenuOpen) return;
    const bridge = getDesktopBridge();
    if (typeof bridge.listSessionApprovalGrants !== 'function') {
      setGrantsState('unavailable');
      return;
    }
    let cancelled = false;
    setGrantsState((prev) => (prev === 'ready' ? prev : 'loading'));
    bridge
      .listSessionApprovalGrants(session.sessionId)
      .then((snap) => {
        if (cancelled) return;
        setGrants(snap);
        setGrantsError('');
        setGrantsState('ready');
      })
      .catch((err) => {
        // 接口存在但读取失败属于加载错误（可重试），不再误报为「当前连接不支持」。
        if (cancelled) return;
        setGrantsError(formatActionError(err, dict));
        setGrantsState('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalMenuOpen, session.sessionId, session.hasApprovalGrants, session.approvalModeOverride, grantsReload]);

  /**
   * 切换审批档位：若本会话存在独立覆盖（例如此前委派 Guardian 代审），选择其他档位（含切回 Manual）
   * 时先撤销该覆盖，再按需更新全局默认，避免会话一直停留在旧档位。
   */
  async function selectApprovalMode(mode: ApprovalMode): Promise<void> {
    const override = session.approvalModeOverride;
    const bridge = getDesktopBridge();
    if (override && override !== mode) {
      if (mode === 'manual' && onClearSessionApprovals) {
        await onClearSessionApprovals(session.sessionId);
      } else if (typeof bridge.revokeSessionApprovalGrant === 'function') {
        setGrants(await bridge.revokeSessionApprovalGrant({ sessionId: session.sessionId, revokeDelegation: true }));
      } else if (onClearSessionApprovals) {
        await onClearSessionApprovals(session.sessionId);
      }
    }
    await onCycleApprovalMode(mode);
  }

  async function revokeGrant(key: string, input: { prefix?: string; revokeDelegation?: boolean }): Promise<void> {
    const bridge = getDesktopBridge();
    if (typeof bridge.revokeSessionApprovalGrant !== 'function' || revokingGrant) return;
    setRevokingGrant(key);
    try {
      setGrants(await bridge.revokeSessionApprovalGrant({ sessionId: session.sessionId, ...input }));
    } catch (err) {
      reportError(err);
    } finally {
      setRevokingGrant(null);
    }
  }

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
    const settled = await Promise.allSettled(files.map(readUserAttachmentFile));
    const valid: DraftAttachment[] = [];
    const failures: unknown[] = [];
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        if (entry.value) valid.push(entry.value);
      } else {
        failures.push(entry.reason);
      }
    }
    if (valid.length) setAttachments((prev) => [...prev, ...valid]);
    if (failures.length > 0) {
      if (valid.length > 0) {
        const firstReason = failures[0] instanceof AttachmentTooLargeError
          ? ui.attachmentTooLarge(failures[0].fileName)
          : formatActionError(failures[0], dict);
        setErrorState({ message: ui.v035.composerAttachPartial(failures.length, files.length), hint: firstReason });
      } else {
        reportError(failures[0]);
      }
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

  const hasQuotesOrNotations = annotationItems.length > 0;
  const [runningEnterNotice, setRunningEnterNotice] = useState(false);

  useEffect(() => {
    if (!turnActive) setRunningEnterNotice(false);
  }, [turnActive]);

  const compactingRef = useRef(false);
  const sendLabel = annotationItems.length ? ui.v035.composerSendAnnotations(annotationItems.length) : dict.sendMessageBtn;
  async function submit(): Promise<void> {
    const text = draft.trim();
    // QA1-FE-18 / TC-VOICE-31：AI 生成中仍允许通过 /voice 或 /record 启动/停止纯本地听写草稿，不向 agy 发送任何内容
    if ((text === '/voice' || text === '/record') && !hasQuotesOrNotations && !isSending()) {
      setError(null);
      setDraft('');
      voice.toggle();
      return;
    }
    if ((!text && attachments.length === 0 && !hasQuotesOrNotations) || isSending() || turnActive) return;
    setError(null);

    // 独立输入的 /compact 和 /plan 走各自的操作入口。带有引用摘录或批注时，草稿会与它们一起构造成消息。
    if (text === '/compact' && !hasQuotesOrNotations) {
      // B12：压缩进行中重复回车 / 双击发送只触发一次；失败时恢复原指令
      if (compactingRef.current) return;
      compactingRef.current = true;
      setDraft('');
      setSending(true);
      try {
        await onCompactContext(session.sessionId);
      } catch (err) {
        setDraft((current) => current || text);
        reportError(err);
      } finally {
        compactingRef.current = false;
        setSending(false);
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
    const prevAnnotations = [...annotationItems];
    const hasImage = prevAtts.some((a) => Boolean(a.previewUrl));
    const annotations = toWireAnnotations(prevAnnotations);
    const visibleText = text || (annotations.length ? '' : `[${hasImage ? dict.pastedImageBadge : dict.attachedFileBadge}]`);

    // 先清空当前输入以反馈发送状态。如果发送失败，下方 catch 用快照还原正文、文件或会话引用以及附件。
    setDraft('');
    setReferences([]);
    setAttachments([]);
    setSending(true);
    const restoreAnnotations = onSubmitAnnotations?.(prevAnnotations);
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

  function applyMode(mode: AgentExecutionMode): void {
    setModeMenuOpen(false);
    setTurboConfirmOpen(false);
    if (mode === normalizedMode) return;
    void onSetSessionMode(session.sessionId, mode).catch(reportError);
  }

  /** 菜单中选择执行模式。首次进入 Turbo（full-access）时先展示内联风险确认，确认后才真正下发。 */
  function selectMode(mode: AgentExecutionMode): void {
    if (turnActive) return;
    if (mode === 'full-access' && normalizedMode !== 'full-access' && !turboAcknowledgedSessions.has(session.sessionId)) {
      setTurboConfirmOpen(true);
      return;
    }
    applyMode(mode);
  }

  function confirmTurbo(): void {
    if (turnActive) return;
    turboAcknowledgedSessions.add(session.sessionId);
    applyMode('full-access');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (isImeComposing(e)) return;
    if (voice.phase !== 'idle') {
      // 听写中：Esc 仅回滚本次未编辑的听写（不中断 AI 生成）；Enter 停录保留文本，绝不发送
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        voice.abort();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        voice.stop();
        return;
      }
    }
    if (e.key === 'ArrowUp' && onEditLast && !draft && !menuItems.length && !references.length && !attachments.length &&
        !hasQuotesOrNotations && !sending && !turnActive &&
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
    if (e.key === 'Escape' && !isImeComposing(e) && turnActive && !approvalMenuOpen && !modelMenuOpen && !modeMenuOpen) {
      // Claude Code 式中断：生成中按 Esc 停止当前回合，草稿保持不变。
      e.preventDefault();
      setRunningEnterNotice(false);
      void onCancelPrompt(session.sessionId).catch(reportError);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
      const item = menuItems[menuIndex] ?? menuItems[0];
      if (item && !(item.type === 'slash' && draft.trim() === item.command)) {
        e.preventDefault();
        applyMenuItem(item);
        return;
      }
      e.preventDefault();
      const trimmed = draft.trim();
      if ((trimmed === '/voice' || trimmed === '/record') && !hasQuotesOrNotations) {
        void submit();
        return;
      }
      if (turnActive) {
        setRunningEnterNotice(true);
        return;
      }
      void submit();
    }
  }

  const sessionModels = session.status === 'closed' || session.status === 'error' ? undefined : session.availableModels;
  const modelChoices = sessionModels ?? availableModels;
  let modelNotice: string | undefined;
  if (!sessionModels && modelListSource === 'cached') {
    modelNotice = dict.ui.copy.lastReportedForThisAccount;
  } else if (!sessionModels && availableModels.length) {
    modelNotice = dict.ui.copy.reportedByOtherSessionsWaiting;
  } else if (!modelChoices.length) {
    modelNotice = sessionModels ? (dict.ui.copy.thisSessionOffersNoSwitchable)
      : (dict.ui.copy.waitingForTheModelList);
  }

  const effortChoices: Array<{ value: AgentReasoningEffort; name: string }> = Array.isArray(session.availableEfforts)
    ? session.availableEfforts
    : REASONING_EFFORT_ORDER.map((ef) => ({ value: ef, name: dict.effortLevels[ef] }));

  const ModeIcon = EXECUTION_MODE_ICONS[normalizedMode];
  const isTurbo = normalizedMode === 'full-access';
  const currentModelName = modelChoices.find((m) => m.modelId === session.modelId)?.name || session.modelId || 'Model';
  const effectiveEffort: AgentReasoningEffort = effortChoices.some((ef) => ef.value === currentEffort)
    ? currentEffort
    : effortChoices[0]?.value ?? currentEffort;

  return (
    <div className="composer-dock">
      <div className="composer-wrap">
        {error && (
          <div role="alert" className="alert pane-error" data-testid={`pane-error-${session.sessionId}`}>
            <span className="pane-error-text">
              <span>{error.message}</span>
              {error.hint && <span className="pane-error-hint">{error.hint}</span>}
            </span>
            <button
              type="button"
              className="icon-btn icon-btn-sm pane-error-close"
              aria-label={ui.v031.dismissAction}
              title={ui.v031.dismissAction}
              onClick={() => setErrorState(null)}
              data-testid={`pane-error-dismiss-${session.sessionId}`}
            >
              <Icon icon={X} size="xs" />
            </button>
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

        {mentionToken !== null && slashMatches.length === 0 && menuItems.length > 0 && (
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
                  <Icon icon={AtSign} size="xs" className="muted" />
                  <span className={item.type === 'file' ? 'mono truncate' : 'truncate'}>
                    {item.type === 'file' ? item.path : item.session.title}
                  </span>
                  <span className="badge">{item.type === 'file' ? ui.v035.composerMentionFile : ui.v035.composerMentionThread}</span>
                </button>
              );
            })}
          </div>
        )}

        <div
          className={`composer ${turnActive ? 'is-busy' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
          }}
          onDrop={handleDrop}
        >
          <span className="composer-busy-rail" aria-hidden="true"><span /></span>
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
            onCommit={(v) => { setInputMinHeight(v); saveComposerMinHeight(v, workspaceWriters); }}
          />
          {hasQuotesOrNotations && (
            <ol className="composer-annotations-tray" aria-label={t6.annTrayLabel(annotationItems.length)} data-testid={`composer-annotations-${session.sessionId}`}>
              {annotationItems.map((item, idx) => (
                <li
                  key={item.id}
                  className="composer-annotation"
                  data-testid={`composer-annotation-${item.id}`}
                  onMouseEnter={() => setActiveAnnotation(item.id)}
                  onMouseLeave={() => setActiveAnnotation(null)}
                >
                  <div className="composer-annotation-head">
                    <span className="composer-notation-idx">#{idx + 1}</span>
                    <span className="composer-notation-snippet truncate" title={item.excerpt}>
                      {item.excerpt.replace(/\s+/g, ' ')}
                    </span>
                    {onRemoveAnnotation && (
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label={t6.annRemove(idx + 1)}
                        title={t6.annRemove(idx + 1)}
                        onClick={() => {
                          onRemoveAnnotation(item.id);
                          setActiveAnnotation(null);
                          textareaRef.current?.focus();
                        }}
                        data-testid={`composer-annotation-remove-${item.id}`}
                      >
                        <Icon icon={X} size="xs" />
                      </button>
                    )}
                  </div>
                  <textarea
                    ref={(el) => {
                      if (el) annotationInputs.current.set(item.id, el);
                      else annotationInputs.current.delete(item.id);
                    }}
                    className="composer-annotation-input"
                    rows={1}
                    value={item.comment}
                    placeholder={t6.annCommentPlaceholder}
                    aria-label={t6.annCommentLabel(idx + 1)}
                    onChange={(e) => onUpdateAnnotation?.(item.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (isImeComposing(e)) return;
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        textareaRef.current?.focus();
                      } else if (e.key === 'Escape') {
                        // 仅回主输入框：阻止冒泡，绝不中断正在生成的回合
                        e.preventDefault();
                        e.stopPropagation();
                        textareaRef.current?.focus();
                      }
                    }}
                    data-testid={`composer-annotation-comment-${item.id}`}
                  />
                </li>
              ))}
            </ol>
          )}
          {annotationNotice && (
            <div className="composer-annotation-notice" role="status" data-testid="composer-annotation-notice">
              {annotationNotice}
            </div>
          )}
          {hasQuotesOrNotations && <div className="composer-annotation-divider" aria-hidden="true"><span>{t6.annSupplement}</span></div>}

          {attachments.some(a => a.previewUrl) && <div className="composer-image-tray" data-testid="composer-image-tray">
            {attachments.filter(a => a.previewUrl).map(att => <figure key={att.id}>
              <MessageImage source={att.previewUrl!} alt={att.name} />
              <button type="button" className="icon-btn composer-image-remove" aria-label={dict.removeAttachmentLabel + ' ' + att.name}
                onClick={() => setAttachments(items => items.filter(item => item.id !== att.id))}><Icon icon={X} size="xs" /></button>
              <figcaption title={att.name}>{att.name}</figcaption>
            </figure>)}
          </div>}
          {(references.length > 0 || attachments.some(a => !a.previewUrl)) && (
            <div className="composer-chips">
              {references.map((r) => (
                <span key={`${r.kind}-${r.value}`} className="chip chip-mono" title={r.value}>
                  <Icon icon={AtSign} size="xs" className="muted" />
                  <span className="truncate">{r.label}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={dict.removeAttachmentLabel}
                    onClick={() => setReferences((prev) => prev.filter((item) => item.kind !== r.kind || item.value !== r.value))}
                  >
                    <Icon icon={X} size="xs" />
                  </button>
                </span>
              ))}
              {attachments.filter(a => !a.previewUrl).map((att) => (
                <span key={att.id} className="chip" title={att.name}>
                  <Icon icon={FileText} size="xs" className="muted" />
                  <span className="truncate">{att.name}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={dict.removeAttachmentLabel}
                    onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== att.id))}
                  >
                    <Icon icon={X} size="xs" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            placeholder={stopping ? ui.v031.stoppingLabel : turnActive ? `${dict.composerPlaceholderBusy}  ·  ${ui.interruptHint}` : hasQuotesOrNotations ? t6.annSupplementPlaceholder : dict.composerPlaceholder}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setErrorState(null);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              queueMicrotask(() => voice.flushImeBuffer());
            }}
            onPaste={handlePaste}
            onKeyDown={onKeyDown}
            data-testid={`composer-input-${session.sessionId}`}
          />

          <div className="composer-bar">
            <div className="menu-anchor mode-menu-anchor" ref={modeMenuRef}>
              <button
                type="button"
                className={`mode-pill mode-${normalizedMode}${modeMenuOpen ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
                onClick={() => {
                  setModeMenuOpen((open) => !open);
                  setTurboConfirmOpen(false);
                }}
                title={
                  isTurbo
                    ? ui.v032.turboActiveTitle(keys(['shift', 'tab']))
                    : `${dict.executionModes[normalizedMode].desc} (${keys(['shift', 'tab'])})`
                }
                data-testid={`execution-mode-pill-${session.sessionId}`}
                data-execution-mode={normalizedMode}
              >
                <Icon icon={ModeIcon} size="sm" className={isTurbo ? 'mode-pill-icon mode-pill-turbo-icon' : 'mode-pill-icon'} />
                <span>{dict.executionModes[normalizedMode].label}</span>
                <Icon icon={ChevronDown} size="xs" className="mode-pill-chev" />
              </button>
              {modeMenuOpen && (
                <div
                  className={`popover menu-up mode-menu${turboConfirmOpen ? ' is-confirming' : ''}`}
                  role="menu"
                  aria-label={ui.v032.modeMenuTitle}
                  data-testid={`execution-mode-menu-${session.sessionId}`}
                >
                  {turboConfirmOpen ? (
                    <div className="turbo-confirm" role="alertdialog" aria-labelledby={`turbo-confirm-title-${session.sessionId}`} data-testid={`turbo-confirm-${session.sessionId}`}>
                      <div className="turbo-confirm-head" id={`turbo-confirm-title-${session.sessionId}`}>
                        <Icon icon={Zap} size="sm" />
                        <span>{ui.v032.turboConfirmTitle}</span>
                      </div>
                      <p className="turbo-confirm-body">{ui.v032.turboConfirmBody}</p>
                      <p className="turbo-confirm-safe">
                        <Icon icon={ShieldCheck} size="xs" />
                        <span>{ui.v032.turboConfirmSafeguards}</span>
                      </p>
                      <div className="turbo-confirm-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setTurboConfirmOpen(false)}
                          data-testid={`turbo-confirm-cancel-${session.sessionId}`}
                        >
                          {ui.v032.turboConfirmCancel}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm turbo-confirm-btn"
                          autoFocus
                          disabled={turnActive}
                          title={turnActive ? ui.v032.modeMenuBusyHint : undefined}
                          onClick={confirmTurbo}
                          data-testid={`turbo-confirm-btn-${session.sessionId}`}
                        >
                          <Icon icon={Zap} size="xs" />
                          <span>{ui.v032.turboConfirmAction}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="menu-label">{ui.v032.modeMenuTitle}</div>
                      {turnActive && (
                        <div className="mode-menu-busy" role="note" data-testid={`execution-mode-busy-${session.sessionId}`}>
                          <Icon icon={Loader2} size="xs" className="spin" />
                          <span>{ui.v032.modeMenuBusyHint}</span>
                        </div>
                      )}
                      {EXECUTION_MODE_ORDER.map((mode) => {
                        const turbo = mode === 'full-access';
                        const checked = normalizedMode === mode;
                        return (
                          <React.Fragment key={mode}>
                            {turbo && <div className="menu-sep" role="separator" />}
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={checked}
                              className={`menu-item mode-menu-item mode-${mode}${checked ? ' is-checked' : ''}`}
                              title={turnActive ? ui.v032.modeMenuBusyHint : dict.executionModes[mode].desc}
                              // P3-2：回合进行中（streaming / waiting_approval）后端会拒绝切换，菜单项直接禁用并给出提示。
                              disabled={turnActive && !checked}
                              aria-disabled={turnActive || undefined}
                              onClick={() => selectMode(mode)}
                              data-testid={`execution-mode-option-${mode}-${session.sessionId}`}
                            >
                              <span className="menu-check">{checked ? <Icon icon={Check} size="sm" /> : null}</span>
                              <span className="mode-menu-glyph" aria-hidden="true">
                                <Icon icon={EXECUTION_MODE_ICONS[mode]} size="sm" />
                              </span>
                              <span className="mode-menu-text">
                                <span className="menu-item-strong">
                                  {dict.executionModes[mode].label}
                                  {turbo && <span className="mode-menu-tag mono">full-access</span>}
                                </span>
                                <span className="menu-item-desc">{dict.executionModes[mode].desc}</span>
                              </span>
                            </button>
                          </React.Fragment>
                        );
                      })}
                      <div className="menu-foot mode-menu-foot">{ui.v032.modeMenuCycleHint(keys(['shift', 'tab']))}</div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="menu-anchor" ref={approvalMenuRef}>
              <button
                type="button"
                className="mode-pill approval-pill"
                onClick={() => setApprovalMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={approvalMenuOpen}
                aria-label={`${dict.approvalMenuTitle}: ${dict.approvalModes[sessionApprovalMode].label}`}
                title={dict.approvalModes[sessionApprovalMode].shortDesc}
                data-testid={`approval-mode-pill-${session.sessionId}`}
              >
                <Icon icon={ShieldCheck} size="sm" />
                <span className="approval-label">{dict.approvalModes[sessionApprovalMode].label}</span>
              </button>
              {approvalMenuOpen && (
                <div className="popover menu-up approval-menu" role="menu" aria-label={dict.approvalMenuTitle}
                  data-testid={`approval-menu-${session.sessionId}`}>
                  <div className="menu-label">{dict.approvalMenuTitle}{session.approvalModeOverride && ui.approvalGlobalDefaultSuffix}</div>
                  {APPROVAL_MODE_ORDER.map((mode) => {
                    const lockedHybrid = mode === 'hybrid' && !reviewerConnected;
                    return (
                      <button
                        key={mode}
                        type="button"
                        className={`menu-item ${sessionApprovalMode === mode ? 'is-checked' : ''}`}
                        title={lockedHybrid ? ui.approvalHybridLockedTitle : dict.approvalModes[mode].shortDesc}
                        data-testid={`approval-menu-mode-${mode}-${session.sessionId}`}
                        onClick={() => {
                          if (lockedHybrid) {
                            setShowConnectPrompt(true);
                            return;
                          }
                          setShowConnectPrompt(false);
                          setApprovalMenuOpen(false);
                          void selectApprovalMode(mode).catch(reportError);
                        }}
                      >
                        <span className="menu-check">{sessionApprovalMode === mode ? <Icon icon={Check} size="sm" /> : null}</span>
                        <span className="menu-item-strong">{dict.approvalModes[mode].label}</span>
                        {lockedHybrid && (
                          <span className="menu-item-tag muted" data-testid={`approval-hybrid-unconnected-tag-${session.sessionId}`}>
                            {ui.approvalHybridNotConnected}
                          </span>
                        )}
                      </button>
                    );
                  })}

                  {session.hasApprovalGrants && onClearSessionApprovals && (
                    <button type="button" className="menu-item" data-testid={`clear-session-approvals-${session.sessionId}`}
                      onClick={() => {
                        setApprovalMenuOpen(false);
                        void onClearSessionApprovals(session.sessionId).catch(reportError);
                      }}>
                      <span className="menu-check" aria-hidden="true" />
                      <span>{dict.clearSessionApprovals}</span>
                    </button>
                  )}
                  {showConnectPrompt && !reviewerConnected && (
                    <div
                      className="approval-connect-prompt"
                      data-testid={`approval-connect-reviewer-prompt-${session.sessionId}`}
                    >
                      <span>{ui.approvalConnectPromptText}</span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm approval-connect-btn"
                        onClick={() => {
                          setShowConnectPrompt(false);
                          setApprovalMenuOpen(false);
                          if (onOpenExternalReviewerSettings) onOpenExternalReviewerSettings();
                          else onOpenApprovalSettings();
                        }}
                        data-testid={`approval-goto-connect-btn-${session.sessionId}`}
                      >
                        {ui.approvalConnectPromptBtn}
                      </button>
                    </div>
                  )}

                  {grantsSupported && (
                    <>
                      <div className="menu-sep" />
                      <div className="approval-trust" data-testid={`approval-trust-${session.sessionId}`}>
                        <div className="approval-trust-head">
                          <span>{ui.trustTitle}</span>
                        </div>
                        {grantsState === 'loading' && !grants && <div className="approval-trust-muted">{ui.trustLoading}</div>}
                        {grantsState === 'unavailable' && <div className="approval-trust-muted">{ui.trustUnavailable}</div>}
                        {grantsState === 'error' && (
                          <div className="approval-trust-error" role="alert" data-testid={`approval-trust-error-${session.sessionId}`}>
                            <span>{ui.v031.trustLoadFailed(grantsError)}</span>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setGrantsReload((n) => n + 1)}>
                              <Icon icon={RotateCw} size="xs" />
                              <span>{ui.v031.retryAction}</span>
                            </button>
                          </div>
                        )}
                        {grants && grantsState !== 'unavailable' && grantsState !== 'error' && (
                          <>
                            <div className={`approval-trust-row${grants.delegatedToGuardian || (sessionApprovalMode === 'hybrid' && reviewerConnected) ? ' is-on' : ''}`}
                              data-testid={`approval-trust-delegation-${session.sessionId}`}>
                              <span className="approval-trust-dot" aria-hidden="true" />
                              <span className="approval-trust-main">
                                <span>
                                  {grants.delegatedToGuardian
                                    ? ui.trustDelegated
                                    : sessionApprovalMode === 'hybrid' && reviewerConnected
                                      ? ui.trustFollowingHybrid
                                      : ui.trustNotDelegated}
                                </span>
                                {grants.delegatedToGuardian && grants.delegatedAt && (
                                  <span className="approval-trust-sub">
                                    {ui.trustDelegatedSince(new Date(grants.delegatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }))}
                                  </span>
                                )}
                              </span>
                              {grants.delegatedToGuardian && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm approval-trust-revoke"
                                  disabled={revokingGrant !== null}
                                  onClick={() => void revokeGrant('delegation', { revokeDelegation: true })}
                                  data-testid="btn-revoke-delegation"
                                >
                                  {ui.trustRevokeDelegation}
                                </button>
                              )}
                            </div>
                            <div className="approval-trust-label">{ui.trustPrefixesTitle}</div>
                            {grants.prefixes.length === 0 ? (
                              <div className="approval-trust-muted">{ui.trustNoPrefixes}</div>
                            ) : (
                              <ul className="approval-trust-prefixes">
                                {grants.prefixes.map((grant, index) => (
                                  <li key={grant.prefix} className="approval-trust-prefix" title={grant.prefix}>
                                    <code className="truncate">{grant.prefix}</code>
                                    <span className="approval-trust-hits mono">{ui.trustPrefixHits(grant.hitCount)}</span>
                                    <button
                                      type="button"
                                      className="icon-btn icon-btn-sm"
                                      disabled={revokingGrant !== null}
                                      aria-label={ui.trustRevokePrefix(grant.prefix)}
                                      title={ui.trustRevokePrefix(grant.prefix)}
                                      onClick={() => void revokeGrant('prefix:' + grant.prefix, { prefix: grant.prefix })}
                                      data-testid={`btn-revoke-prefix-${index}`}
                                    >
                                      <Icon icon={X} size="xs" />
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}

                  <div className="menu-sep" />
                  <div
                    className="approval-usage-box"
                    data-testid={`approval-menu-reviewer-usage-${session.sessionId}`}
                  >
                    <div className="approval-usage-row">
                      <span className="approval-usage-title">{ui.reviewerUsageTitle}</span>
                      <span className={`badge badge-xs ${reviewerConnected ? 'badge-success' : ''}`}>
                        {reviewerConnected ? ui.reviewerUsageLive : ui.reviewerUsageOff}
                      </span>
                    </div>
                    {onOpenReviewerStats && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm approval-usage-link"
                        onClick={() => {
                          setShowConnectPrompt(false);
                          setApprovalMenuOpen(false);
                          onOpenReviewerStats();
                        }}
                        data-testid={`approval-open-reviewer-stats-btn-${session.sessionId}`}
                      >
                        {ui.reviewerUsageStatsLink}
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
            <VoiceControls
              sessionId={session.sessionId}
              voice={voice}
              onAttach={() => anyFileInputRef.current?.click()}
              attachLabel={dict.attachFileLabel}
              attachTitle={`${dict.attachFileLabel} / ${dict.attachImageLabel}`}
            />

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
                <Icon icon={Cpu} size="xs" className="model-chip-icon" />
                <span className="model-chip-name truncate">{currentModelName}</span>
                {effortChoices.length > 0 && (
                  <span className="model-chip-effort">{dict.effortLevels[effectiveEffort] ?? effectiveEffort}</span>
                )}
                <Icon icon={ChevronDown} size="xs" className="model-chip-chev" />
              </button>
              {modelMenuOpen && (
                <div className="popover menu-up menu-right model-menu" role="menu" data-testid={`model-menu-${session.sessionId}`}>
                  <div className="menu-label">{ui.modelMenuTitle}</div>
                  {modelNotice && <div className="menu-label">{modelNotice}</div>}
                  <div className="model-menu-list">
                    {modelChoices.map((m) => (
                      <button
                        key={m.modelId}
                        type="button"
                        role="menuitemradio"
                        disabled={!sessionModels || turnActive}
                        aria-checked={m.modelId === session.modelId}
                        className={`menu-item ${m.modelId === session.modelId ? 'is-checked' : ''}`}
                        title={m.description || m.modelId}
                        onClick={() => {
                          setModelMenuOpen(false);
                          if (m.modelId !== session.modelId) void onSetSessionModel(session.sessionId, m.modelId).catch(reportError);
                        }}
                      >
                        <span className="menu-check">{m.modelId === session.modelId ? <Icon icon={Check} size="sm" /> : null}</span>
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
                            disabled={turnActive}
                            title={turnActive ? ui.v033.effortBusyHint : undefined}
                            className={`segmented-btn ${effectiveEffort === ef.value ? 'is-active' : ''}`}
                            onClick={() => {
                              if (turnActive) return;
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

            {turnActive ? (
              <button
                type="button"
                className={`send-btn is-stop${stopping ? ' is-stopping' : ''}`}
                title={stopping ? ui.v031.stoppingLabel : dict.stopGeneratingBtn}
                aria-label={stopping ? ui.v031.stoppingLabel : dict.stopGeneratingBtn}
                onClick={() => void onCancelPrompt(session.sessionId).catch(reportError)}
                data-testid={`cancel-prompt-btn-${session.sessionId}`}
              >
                {stopping ? <Icon icon={Loader2} size="xs" className="spin" /> : <Icon icon={Square} size="xs" fill="currentColor" />}
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
                <Icon icon={ArrowUp} size="md" />{annotationItems.length > 0 && <span>{annotationItems.length}</span>}
              </button>
            )}
          </div>
        </div>

        {runningEnterNotice && turnActive && (
          <div role="status" className="composer-running-hint" data-testid={`composer-running-hint-${session.sessionId}`}>
            <span>{ui.v035.composerRunningEnterHint}</span>
          </div>
        )}

        <AccountQuotaFooter
          key={session.profileId}
          profileId={session.profileId}
          generating={isStreaming}
          isIsolatedProfile={isIsolatedProfile}
          connection={connection}
        >
          <ContextStatusBar
            sessionId={session.sessionId}
            modelId={session.modelId}
            sessionTelemetry={sessionTelemetry}
            treeCost={treeCost}
            onCompactContext={onCompactContext}
            onOpenContextInspector={onOpenContextInspector}
          />
        </AccountQuotaFooter>
      </div>
    </div>
  );
}

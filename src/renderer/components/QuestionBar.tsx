import { getComponentCopy } from '../i18n/domains/copy';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, RotateCcw } from 'lucide-react';
import type { AnswerValue, QuestionField, QuestionSubmission, QuestionSubmissionReceipt, UserQuestion } from '@shared';
import { useI18n } from '../i18n/I18nContext';
import { stripIpcErrorPrefix } from '../i18n/locales';
import { isImeComposing, isPrimaryModifier } from '../lib/platform-keys';
import { Icon } from './ui/Icon';

/**
 * v0.3.5 Plan 模式提问卡片
 *
 * - 多题步进器（单题隐藏）：`1/N` + 可点击题号胶囊（未答 / 已选 / 已编辑铅笔角标）+ 上一题 / 下一题；
 *   非文本输入框内 ←/→ 切题、↑/↓ 在选项间移动焦点；不用 Alt+←/→，不设 1–4 数字快捷键；点选选项绝不自动切题；
 * - 每个选项右上角铅笔按钮就地编辑（Enter 仅确认、Esc 回滚到 prevSelected、失焦确认且空值还原原文案），已编辑项显示标记与 ↺ 还原；
 * - 有选项的题提供每题独立「自定义回答」，与选项互斥，切回选项时保留草稿并显示「自定义草稿 · 恢复」；纯开放题直接渲染紧凑自适应 textarea；
 * - 切题 / 点选 / 编辑 / 输入全程 0 次 IPC，只在「发送回答」或 Ctrl/⌘+Enter（IME 保护）时统一校验并提交；
 * - 草稿使用 `v: 2` sessionStorage schema（兼容迁移 v1），每个最终提交意图生成稳定 UUID `submissionId`；
 * - 原生 v2（`submissionVersion === 2`）：合法 schema 走 `delivery: 'form'`；改写闭集选项或使用 schema 不可表达的自定义回答时，
 *   卡片内展示逐题汇总预览并经用户二次确认后走 `delivery: 'followup'`。缺 `submissionVersion` 的旧对象沿用旧协议。
 */

export type QuestionReply = Omit<QuestionSubmission, 'sessionId' | 'messageId'>;

type Mode = 'choice' | 'custom';

export interface QuestionDraftV2 {
  v: 2;
  values: Record<string, AnswerValue>;
  /** fieldName -> optionValue -> 编辑后的文案 */
  edits: Record<string, Record<string, string>>;
  /** fieldName -> 自定义回答草稿 */
  custom: Record<string, string>;
  /** 有选项题的当前作答方式 */
  mode: Record<string, Mode>;
  step: number;
  submissionId?: string;
  /** 生成 submissionId 时的提交意图指纹；意图变化才换新 UUID */
  intentKey?: string;
}

interface DraftV1 {
  values: Record<string, AnswerValue>;
  edits: Record<string, string>;
  custom: string;
}

function initialDraft(question: UserQuestion): QuestionDraftV2 {
  return {
    v: 2,
    values: Object.fromEntries(question.fields.filter((f) => f.initial !== undefined).map((f) => [f.name, f.initial!])),
    edits: {},
    custom: {},
    mode: {},
    step: 0,
  };
}

/** 读取草稿：v2 直接使用；v1（`edits` 以 JSON 键、全局 `custom`）迁移为逐题结构。 */
export function readQuestionDraft(raw: string | null, question: UserQuestion): QuestionDraftV2 {
  const fallback = initialDraft(question);
  if (!raw) return fallback;
  try {
    const saved = JSON.parse(raw) as Partial<QuestionDraftV2> & Partial<DraftV1>;
    if (!saved || typeof saved !== 'object' || !saved.values || typeof saved.values !== 'object') return fallback;
    if (saved.v === 2) {
      return {
        ...fallback,
        ...saved,
        v: 2,
        edits: saved.edits && typeof saved.edits === 'object' ? (saved.edits as QuestionDraftV2['edits']) : {},
        custom: saved.custom && typeof saved.custom === 'object' ? (saved.custom as Record<string, string>) : {},
        mode: saved.mode && typeof saved.mode === 'object' ? saved.mode : {},
        step: Math.max(0, Math.min(question.fields.length - 1, Number(saved.step) || 0)),
      };
    }
    // v1 迁移
    const edits: QuestionDraftV2['edits'] = {};
    for (const [key, text] of Object.entries((saved.edits as Record<string, string>) || {})) {
      try {
        const [field, value] = JSON.parse(key) as [string, string];
        if (typeof field === 'string' && typeof value === 'string' && typeof text === 'string') {
          (edits[field] ||= {})[value] = text;
        }
      } catch {
        /* 跳过无法解析的旧键 */
      }
    }
    const custom: Record<string, string> = {};
    const mode: Record<string, Mode> = {};
    const legacyCustom = typeof saved.custom === 'string' ? saved.custom : '';
    if (legacyCustom.trim()) {
      const target = question.fields.find((f) => f.choices?.length) ?? question.fields[0];
      if (target) {
        custom[target.name] = legacyCustom;
        mode[target.name] = 'custom';
      }
    }
    return { ...fallback, values: saved.values as Record<string, AnswerValue>, edits, custom, mode };
  } catch {
    return fallback;
  }
}

function newSubmissionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 回退到下方实现 */
  }
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const isBlank = (v: AnswerValue | undefined) =>
  v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'number' && Number.isNaN(v));

/** schema 基础校验（保留 false / 0；format 只做基础检查） */
export function validateFieldValue(field: QuestionField, value: AnswerValue | undefined): boolean {
  if (isBlank(value)) return !field.required;
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (field.type === 'integer' && !Number.isInteger(value)) return false;
      if (field.minimum !== undefined && value < field.minimum) return false;
      if (field.maximum !== undefined && value > field.maximum) return false;
      return true;
    }
    case 'array': {
      if (!Array.isArray(value)) return false;
      if (field.minItems !== undefined && value.length < field.minItems) return false;
      if (field.maxItems !== undefined && value.length > field.maxItems) return false;
      if (field.choices && value.some((v) => !field.choices!.some((c) => c.value === v))) return false;
      return true;
    }
    case 'string':
    default: {
      if (typeof value !== 'string') return false;
      if (field.choices && !field.choices.some((c) => c.value === value)) return false;
      if (field.minLength !== undefined && value.length < field.minLength) return false;
      if (field.maxLength !== undefined && value.length > field.maxLength) return false;
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern, 'u').test(value)) return false;
        } catch {
          /* 无法编译的 pattern 交由主进程裁决 */
        }
      }
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
      if ((field.format === 'uri' || field.format === 'url') && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(value)) return false;
      if (field.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      if (field.format === 'date-time' && !Number.isFinite(Date.parse(value))) return false;
      return true;
    }
  }
}

type FieldState = 'unanswered' | 'answered' | 'edited';

export function QuestionBar({
  question,
  draftKey,
  native,
  sendError,
  submit,
}: {
  question: UserQuestion;
  draftKey: string;
  native: boolean;
  sendError?: string;
  submit: (reply: QuestionReply) => Promise<QuestionSubmissionReceipt | void>;
}): React.ReactElement {
  const { dict, locale, shortcut, mac } = useI18n();
  const zh = locale === 'zh-CN';
  const copy = getComponentCopy(zh);
  const t = dict.ui.v035;
  const uid = useId();
  const key = 'gravity.question.' + draftKey;
  const fields = question.fields;
  const multi = fields.length > 1;
  const nativeV2 = native && question.submissionVersion === 2;

  const [draft, setDraft] = useState<QuestionDraftV2>(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch {
      /* optional storage */
    }
    return readQuestionDraft(raw, question);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<QuestionReply | null>(null);
  const [numText, setNumText] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of question.fields) {
      if ((f.type === 'number' || f.type === 'integer') && !f.choices?.length) {
        const v = draft.values[f.name];
        if (typeof v === 'number' && Number.isFinite(v)) init[f.name] = String(v);
      }
    }
    return init;
  });
  const [editing, setEditing] = useState<{
    field: string;
    option: string;
    text: string;
    prevSelected: AnswerValue | undefined;
    prevEdit: string | undefined;
    prevMode: Mode | undefined;
  } | null>(null);
  const locked = useRef(false);
  const submittedRef = useRef(false);
  const prevKeyRef = useRef(key);
  if (prevKeyRef.current !== key) {
    prevKeyRef.current = key;
    submittedRef.current = false;
  }
  const formRef = useRef<HTMLFormElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (submittedRef.current) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      /* in-memory drafting still works */
    }
  }, [draft, key]);

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editing?.field, editing?.option]); // eslint-disable-line react-hooks/exhaustive-deps

  const parseNumericText = (raw: string): number | undefined => {
    const s = raw.trim();
    if (!s) return undefined;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  const step = multi ? Math.max(0, Math.min(fields.length - 1, draft.step)) : 0;
  const setStep = useCallback(
    (next: number) => setDraft((prev) => ({ ...prev, step: Math.max(0, Math.min(fields.length - 1, next)) })),
    [fields.length]
  );

  const setValue = (name: string, value: AnswerValue | undefined) =>
    setDraft((prev) => {
      const values = { ...prev.values };
      if (value === undefined) delete values[name];
      else values[name] = value;
      return { ...prev, values };
    });

  /** 渲染与提交共用的草稿视图；发送时若仍在就地编辑，会先把未确认的编辑并入该视图 */
  let view = draft;
  const optionText = (field: QuestionField, option: string): string => {
    const label = field.choices?.find((c) => c.value === option)?.label ?? option;
    const edit = view.edits[field.name]?.[option];
    return edit !== undefined && edit.trim() ? edit : label;
  };
  const isEdited = (field: QuestionField, option: string): boolean => {
    const label = field.choices?.find((c) => c.value === option)?.label ?? option;
    const edit = view.edits[field.name]?.[option];
    return edit !== undefined && edit.trim() !== '' && edit !== label;
  };
  const modeOf = (field: QuestionField): Mode => (field.choices?.length ? draft.mode[field.name] ?? 'choice' : 'choice');
  const customOf = (field: QuestionField) => draft.custom[field.name] ?? '';

  const fieldState = (field: QuestionField): FieldState => {
    if (field.choices?.length && modeOf(field) === 'custom') {
      return customOf(field).trim() ? 'edited' : 'unanswered';
    }
    const v = draft.values[field.name];
    if (isBlank(v)) return 'unanswered';
    if (field.choices?.length) {
      const ids = Array.isArray(v) ? v : [String(v)];
      if (ids.some((id) => isEdited(field, id))) return 'edited';
    }
    return 'answered';
  };
  const answeredCount = fields.filter((f) => fieldState(f) !== 'unanswered').length;

  /* ------------------------------------------------------------ 选项编辑 */
  const beginEdit = (field: QuestionField, option: string) => {
    const prevSelected = draft.values[field.name];
    const selected = Array.isArray(prevSelected) ? prevSelected.includes(option) : prevSelected === option;
    if (!selected) {
      if (field.type === 'array') {
        const list = Array.isArray(prevSelected) ? (prevSelected as string[]) : [];
        if (field.maxItems !== undefined && list.length >= field.maxItems) {
          setError(t.qMaxItemsReached(field.maxItems));
          return;
        }
        setValue(field.name, [...list, option]);
      } else {
        setValue(field.name, option);
      }
    }
    setError('');
    const prevMode = draft.mode[field.name];
    if (prevMode === 'custom') setDraft((prev) => ({ ...prev, mode: { ...prev.mode, [field.name]: 'choice' } }));
    setEditing({
      field: field.name,
      option,
      text: optionText(field, option),
      prevSelected,
      prevEdit: draft.edits[field.name]?.[option],
      prevMode,
    });
  };
  const commitEdit = (current = editing) => {
    if (!current) return;
    const field = fields.find((f) => f.name === current.field);
    const label = field?.choices?.find((c) => c.value === current.option)?.label ?? current.option;
    const text = current.text;
    setDraft((prev) => {
      const forField = { ...(prev.edits[current.field] || {}) };
      if (!text.trim() || text === label) delete forField[current.option];
      else forField[current.option] = text;
      return { ...prev, edits: { ...prev.edits, [current.field]: forField } };
    });
    setEditing(null);
  };
  const cancelEdit = () => {
    if (!editing) return;
    const { field, option, prevSelected, prevEdit, prevMode } = editing;
    setDraft((prev) => {
      const values = { ...prev.values };
      if (prevSelected === undefined) delete values[field];
      else values[field] = prevSelected;
      const forField = { ...(prev.edits[field] || {}) };
      if (prevEdit === undefined) delete forField[option];
      else forField[option] = prevEdit;
      const mode = { ...prev.mode };
      if (prevMode === undefined) delete mode[field];
      else mode[field] = prevMode;
      return { ...prev, values, edits: { ...prev.edits, [field]: forField }, mode };
    });
    setEditing(null);
  };
  const restoreOption = (field: QuestionField, option: string) =>
    setDraft((prev) => {
      const forField = { ...(prev.edits[field.name] || {}) };
      delete forField[option];
      return { ...prev, edits: { ...prev.edits, [field.name]: forField } };
    });

  const chooseOption = (field: QuestionField, option: string) => {
    const val = draft.values[field.name];
    const selected = Array.isArray(val) ? val.includes(option) : val === option;
    if (field.type === 'array' && !selected) {
      const list = Array.isArray(val) ? (val as string[]) : [];
      if (field.maxItems !== undefined && list.length >= field.maxItems) {
        setError(t.qMaxItemsReached(field.maxItems));
        return;
      }
    }
    setError('');
    setDraft((prev) => {
      const values = { ...prev.values };
      if (field.type === 'array') {
        const list = Array.isArray(values[field.name]) ? (values[field.name] as string[]) : [];
        if (!selected && field.maxItems !== undefined && list.length >= field.maxItems) return prev;
        const nextList = selected ? list.filter((v) => v !== option) : [...list, option];
        if (nextList.length) values[field.name] = nextList;
        else delete values[field.name];
      } else {
        values[field.name] = option;
      }
      return { ...prev, values, mode: { ...prev.mode, [field.name]: 'choice' } };
    });
  };

  /* ------------------------------------------------------------ 组装提交 */
  const summaryText = (field: QuestionField): string => {
    if (field.choices?.length && modeOf(field) === 'custom') return customOf(field).trim();
    const v = draft.values[field.name];
    if (v === undefined) return '';
    if (field.choices?.length) {
      const ids = Array.isArray(v) ? v : [String(v)];
      return ids.map((id) => optionText(field, id)).join('、');
    }
    if (typeof v === 'boolean') return v ? copy.yes : copy.no;
    return Array.isArray(v) ? v.join('、') : String(v);
  };

  /** 汇总文本：单题只给答案，多题逐题 `题目 · 答案` */
  const buildDisplay = (): string =>
    fields
      .map((f) => ({ f, text: summaryText(f) }))
      .filter((x) => x.text)
      .map(({ f, text }) => (multi ? `${f.title} · ${text}` : text))
      .join('\n');

  const collectEditsAndCustom = () => {
    const optionEdits: Record<string, Record<string, string>> = {};
    const customAnswers: Record<string, string> = {};
    for (const f of fields) {
      if (f.choices?.length && modeOf(f) === 'custom') {
        const text = customOf(f).trim();
        if (text) customAnswers[f.name] = text;
        continue;
      }
      const v = draft.values[f.name];
      if (v === undefined || !f.choices?.length) continue;
      for (const id of Array.isArray(v) ? v : [String(v)]) {
        if (isEdited(f, id)) (optionEdits[f.name] ||= {})[id] = optionText(f, id);
      }
    }
    return { optionEdits, customAnswers };
  };

  /** 稳定 submissionId：同一提交意图复用同一 UUID（失败重试幂等），意图变化才生成新的。 */
  const stableSubmissionId = (intent: unknown): string => {
    const intentKey = JSON.stringify(intent);
    if (draft.submissionId && draft.intentKey === intentKey) return draft.submissionId;
    const id = newSubmissionId();
    // 函数式更新，避免覆盖同一事件内刚确认的就地编辑；持久化由草稿 effect 统一写入
    setDraft((prev) => ({ ...prev, submissionId: id, intentKey }));
    return id;
  };

  const focusField = (index: number) => {
    if (multi) setStep(index);
    requestAnimationFrame?.(() => {
      const el = formRef.current?.querySelector<HTMLElement>(
        `[data-field-index="${index}"] :is(input, textarea, select, [role="radio"], [role="checkbox"])`
      );
      el?.focus();
    });
  };

  async function deliver(reply: QuestionReply) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await submit(reply);
      submittedRef.current = true;
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* optional storage */
      }
      setPreview(null);
    } catch (reason) {
      setError(stripIpcErrorPrefix(reason));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function send(action: QuestionReply['action']) {
    if (locked.current) return;
    // 正在就地编辑时，发送前先确认当前编辑
    if (editing) {
      const current = editing;
      const field = fields.find((f) => f.name === current.field);
      const label = field?.choices?.find((c) => c.value === current.option)?.label ?? current.option;
      const forField = { ...(draft.edits[current.field] || {}) };
      if (!current.text.trim() || current.text === label) delete forField[current.option];
      else forField[current.option] = current.text;
      view = { ...draft, edits: { ...draft.edits, [current.field]: forField } };
      commitEdit(current);
    }
    if (action !== 'accept') {
      const submissionId = nativeV2 ? stableSubmissionId({ action }) : undefined;
      await deliver({ action, ...(submissionId ? { submissionId } : {}) });
      return;
    }

    const hasUnparsedNum = (f: QuestionField) =>
      (f.type === 'number' || f.type === 'integer') &&
      !f.choices?.length &&
      Boolean(numText[f.name]?.trim()) &&
      parseNumericText(numText[f.name]!) === undefined;

    // 1) 必填校验：定位首道缺题
    const missing = fields.findIndex(
      (f) => f.required && fieldState(f) === 'unanswered' && !(nativeV2 && hasUnparsedNum(f))
    );
    if (missing >= 0) {
      setError(multi ? t.qMissingRequired(missing + 1, fields[missing].title) : copy.answerTheRequiredFields);
      focusField(missing);
      return;
    }

    const display = buildDisplay();
    const { optionEdits, customAnswers } = collectEditsAndCustom();
    const hasRewrite = Object.keys(optionEdits).length > 0 || Object.keys(customAnswers).length > 0;
    const values: Record<string, AnswerValue> = {};
    for (const f of fields) {
      if (f.choices?.length && modeOf(f) === 'custom') continue;
      const v = draft.values[f.name];
      if (!isBlank(v)) values[f.name] = v as AnswerValue;
    }

    // 2) 正文提问（非原生）：一律以普通消息发送
    if (!native) {
      if (!display) {
        setError(copy.enterYourAnswer);
        return;
      }
      await deliver({ action, values, customReply: display });
      return;
    }

    // 3) 原生 v2：先校验所有未以自定义回答替代的字段；合法 schema → form；含改写 → 预览确认后 followup
    if (nativeV2) {
      const invalid = fields.findIndex((f) => {
        if (f.choices?.length && modeOf(f) === 'custom') return false;
        if (hasUnparsedNum(f)) return true;
        return !validateFieldValue(f, values[f.name]);
      });
      if (invalid >= 0) {
        setError(t.qInvalidField(invalid + 1, fields[invalid].title));
        focusField(invalid);
        return;
      }
      if (!hasRewrite) {
        const submissionId = stableSubmissionId({ delivery: 'form', values });
        await deliver({ action, values, delivery: 'form', submissionId });
        return;
      }
      const submissionId = stableSubmissionId({ delivery: 'followup', values, optionEdits, customAnswers });
      setError('');
      setPreview({
        action,
        values,
        optionEdits,
        customAnswers,
        delivery: 'followup',
        submissionId,
        displayAnswer: display,
      });
      return;
    }

    // 4) 旧版原生协议（缺 submissionVersion）：兼容 v0.3.4 行为
    const free = fields.find(
      (f) => f.type === 'string' && !f.choices && /free.?form|free.?text|custom|other|additional|comment|补充|自定义/i.test(f.name + ' ' + f.title)
    );
    const changes = fields
      .filter((f) => f.choices?.length && (optionEdits[f.name] || customAnswers[f.name]))
      .map((f) => `${f.title} · ${summaryText(f)}`);
    const customText = Object.values(customAnswers).join('\n');
    let customReply: string | undefined;
    if (hasRewrite && free) {
      values[free.name] = [values[free.name], customText || changes.join('\n')].filter(Boolean).join('\n');
    } else if (hasRewrite) {
      customReply = customText && !Object.keys(optionEdits).length && !multi ? customText : display;
    }
    // 旧协议仅接受闭集选项值：被自定义回答替代的题目不提交选项值
    await deliver({ action, values, customReply, displayAnswer: hasRewrite ? display : undefined });
  }

  /* ------------------------------------------------------------ 键盘 */
  const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && isPrimaryModifier(e, mac) && !e.altKey && !e.shiftKey) {
      if (isImeComposing(e)) return;
      e.preventDefault();
      if (preview) {
        void deliver(preview);
        return;
      }
      void send('accept');
      return;
    }
    const target = e.target as HTMLElement;
    const inText = target.closest('input, textarea, select, [contenteditable="true"]');
    if (inText || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (multi && !preview && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setStep(step + (e.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const group = target.closest('.qb-options');
      if (!group) return;
      const items = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]'));
      const i = items.indexOf(target);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };

  /* ------------------------------------------------------------ 渲染 */
  const renderChoices = (field: QuestionField, index: number) => {
    const val = draft.values[field.name];
    const custom = modeOf(field) === 'custom';
    const isArray = field.type === 'array';
    const selectedList = isArray && Array.isArray(val) ? (val as string[]) : [];
    const maxItems = isArray && typeof field.maxItems === 'number' && field.maxItems > 0 ? field.maxItems : undefined;
    const atMaxItems = Boolean(!custom && maxItems !== undefined && selectedList.length >= maxItems);
    const legendId = `${uid}-legend-${index}`;
    return (
      <>
        {maxItems !== undefined && (
          <small data-testid={`question-max-items-${field.name}`}>{t.qMaxItemsHint(maxItems)}</small>
        )}
        <div
          className={`qb-options${custom ? ' is-dimmed' : ''}`}
          role={isArray ? 'group' : 'radiogroup'}
          aria-labelledby={legendId}
        >
          {field.choices!.map((option) => {
            const selected = !custom && (Array.isArray(val) ? val.includes(option.value) : val === option.value);
            const blockedByMax = atMaxItems && !selected;
            const edited = isEdited(field, option.value);
            const isEditing = editing?.field === field.name && editing.option === option.value;
            const label = optionText(field, option.value);
            return (
              <div
                key={option.value}
                className={`qb-option${selected ? ' is-selected' : ''}${edited ? ' is-edited' : ''}${isEditing ? ' is-editing' : ''}`}
              >
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    className="qb-option-edit"
                    aria-label={copy.editOption + (option.label || option.value)}
                    value={editing!.text}
                    onChange={(e) => setEditing((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
                    onKeyDown={(e) => {
                      if (isImeComposing(e)) return;
                      if (e.key === 'Enter' && !isPrimaryModifier(e, mac)) {
                        e.preventDefault();
                        e.stopPropagation();
                        commitEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelEdit();
                      }
                    }}
                    onBlur={() => commitEdit()}
                  />
                ) : (
                  <button
                    type="button"
                    role={isArray ? 'checkbox' : 'radio'}
                    aria-checked={selected}
                    disabled={busy || blockedByMax}
                    className="qb-option-main"
                    title={blockedByMax && maxItems !== undefined ? t.qMaxItemsReached(maxItems) : option.description}
                    onClick={() => chooseOption(field, option.value)}
                  >
                    <span className="qb-option-mark" aria-hidden="true" />
                    <span className="qb-option-text">
                      <span className="qb-option-label">{label}</span>
                      {edited && <span className="qb-option-orig">{option.label}</span>}
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </button>
                )}
                <span className="qb-option-tools">
                  {edited && !isEditing && <span className="qb-edited-mark">{t.qEditedMark}</span>}
                  {edited && !isEditing && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-xs qb-option-restore"
                      aria-label={t.qRestoreOption(option.label)}
                      title={t.qRestoreOption(option.label)}
                      onClick={() => restoreOption(field, option.value)}
                    >
                      <Icon icon={RotateCcw} size="xs" />
                    </button>
                  )}
                  {!isEditing && (
                    <button
                      type="button"
                      className="icon-btn icon-btn-xs qb-option-pencil"
                      disabled={busy || blockedByMax}
                      aria-label={t.qEditOptionBtn(option.label)}
                      title={blockedByMax && maxItems !== undefined ? t.qMaxItemsReached(maxItems) : t.qEditOptionBtn(option.label)}
                      onClick={() => beginEdit(field, option.value)}
                    >
                      <Icon icon={Pencil} size="xs" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {custom ? (
          <div className="qb-custom">
            <textarea
              className="qb-custom-input"
              aria-label={copy.customAnswer}
              placeholder={t.qCustomPlaceholder}
              rows={1}
              autoFocus
              value={customOf(field)}
              onChange={(e) => {
                const text = e.target.value;
                autosize(e.target);
                setDraft((prev) => ({ ...prev, custom: { ...prev.custom, [field.name]: text } }));
              }}
            />
          </div>
        ) : customOf(field).trim() ? (
          <div className="qb-custom-restore" data-testid="question-custom-restore">
            <span className="truncate">
              {t.qCustomDraft} · {customOf(field).trim()}
            </span>
            <button
              type="button"
              className="status-link"
              onClick={() => setDraft((prev) => ({ ...prev, mode: { ...prev.mode, [field.name]: 'custom' } }))}
            >
              {t.qCustomDraftRestore}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="status-link qb-custom-toggle"
            aria-expanded={false}
            onClick={() => setDraft((prev) => ({ ...prev, mode: { ...prev.mode, [field.name]: 'custom' } }))}
          >
            {copy.customAnswer}
          </button>
        )}
      </>
    );
  };

  const renderField = (field: QuestionField, index: number) => {
    const val = draft.values[field.name];
    const legendId = `${uid}-legend-${index}`;
    const showLegend = field.title !== question.message || multi;
    const rawNumValue = numText[field.name] ?? (val === undefined ? '' : String(val));
    return (
      <fieldset key={field.name} disabled={busy} data-field-index={index} className="qb-field">
        {showLegend && (
          <legend id={legendId}>
            {field.title}
            {field.required ? ' *' : ''}
          </legend>
        )}
        {!showLegend && (
          <span id={legendId} className="sr-only">
            {field.title}
          </span>
        )}
        {field.description && <small>{field.description}</small>}
        {field.choices?.length ? (
          renderChoices(field, index)
        ) : field.type === 'boolean' ? (
          <select
            aria-label={field.title}
            value={val === undefined ? '' : String(val)}
            onChange={(e) => setValue(field.name, e.target.value === '' ? undefined : e.target.value === 'true')}
          >
            <option value="">—</option>
            <option value="true">{copy.yes}</option>
            <option value="false">{copy.no}</option>
          </select>
        ) : field.type === 'string' ? (
          <textarea
            className="qb-open-input"
            aria-label={field.title}
            placeholder={t.qOpenAnswerPlaceholder}
            rows={1}
            value={String(val ?? '')}
            maxLength={field.maxLength}
            onChange={(e) => {
              autosize(e.target);
              setValue(field.name, e.target.value || undefined);
            }}
          />
        ) : (
          <input
            type="text"
            inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
            aria-label={field.title}
            value={rawNumValue}
            onChange={(e) => {
              const raw = e.target.value;
              setNumText((prev) => ({ ...prev, [field.name]: raw }));
              setValue(field.name, parseNumericText(raw));
            }}
            onBlur={() => {
              const raw = numText[field.name];
              if (raw === undefined) return;
              const parsed = parseNumericText(raw);
              if (parsed !== undefined) {
                setNumText((prev) => ({ ...prev, [field.name]: String(parsed) }));
                setValue(field.name, parsed);
              } else {
                setNumText((prev) => ({ ...prev, [field.name]: '' }));
                setValue(field.name, undefined);
              }
            }}
          />
        )}
      </fieldset>
    );
  };

  const stateLabel = (s: FieldState) =>
    s === 'unanswered' ? t.qStateUnanswered : s === 'edited' ? t.qStateEdited : t.qStateAnswered;

  const previewRows = useMemo(() => {
    if (!preview) return [];
    return fields.map((f) => {
      const custom = preview.customAnswers?.[f.name];
      const v = preview.values?.[f.name];
      const ids = v === undefined ? [] : Array.isArray(v) ? v : [String(v)];
      const parts = custom
        ? [`${custom}（${t.qFollowupCustom}）`]
        : ids.map((id) => {
            const edit = preview.optionEdits?.[f.name]?.[id];
            const original = f.choices?.find((c) => c.value === id)?.label ?? id;
            return edit ? `${edit} ${t.qFollowupEditedFrom(original)}` : f.choices ? original : typeof v === 'boolean' ? (v ? copy.yes : copy.no) : String(id);
          });
      const cleanTitle = f.title.replace(/^\d+[.)．、）]\s*/, '') || f.title;
      return { name: f.name, title: cleanTitle, text: parts.join('、') || '—' };
    });
  }, [copy.no, copy.yes, fields, preview, t]);

  const sendLabel = multi ? t.qSendWithCount(answeredCount, fields.length) : copy.sendAnswer;

  return (
    <form
      ref={formRef}
      className={`question-bar${multi ? ' is-multi' : ''}`}
      aria-label={copy.modelQuestion}
      data-testid="question-bar"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={onFormKeyDown}
    >
      <header>
        <small>{copy.modelQuestion}</small>
        <strong>{question.message}</strong>
      </header>

      {multi && !preview && (
        <nav className="qb-stepper" aria-label={t.qNavLabel} data-testid="question-stepper">
          <button
            type="button"
            className="icon-btn icon-btn-sm qb-step-btn"
            aria-label={t.qPrev}
            title={t.qPrev}
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
            data-testid="question-prev"
          >
            <Icon icon={ChevronLeft} size="sm" />
          </button>
          <span className="qb-step-count mono" aria-live="polite" data-testid="question-step-count">
            {t.qStep(step + 1, fields.length)}
          </span>
          <div className="qb-pills">
            {fields.map((f, i) => {
              const s = fieldState(f);
              return (
                <button
                  key={f.name}
                  type="button"
                  className={`qb-pill is-${s}${i === step ? ' is-current' : ''}`}
                  aria-label={t.qJumpTo(i + 1, stateLabel(s))}
                  aria-current={i === step ? 'step' : undefined}
                  title={f.title}
                  onClick={() => setStep(i)}
                  data-testid={`question-pill-${i + 1}`}
                  data-state={s}
                >
                  {i + 1}
                  {s === 'edited' && (
                    <span className="qb-pill-badge" aria-hidden="true">
                      <Icon icon={Pencil} size="xs" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm qb-step-btn"
            aria-label={t.qNext}
            title={t.qNext}
            disabled={step === fields.length - 1}
            onClick={() => setStep(step + 1)}
            data-testid="question-next"
          >
            <Icon icon={ChevronRight} size="sm" />
          </button>
        </nav>
      )}

      <div className="qb-body">
        {preview ? (
          <section className="qb-preview" role="region" aria-labelledby={`${uid}-preview-title`} data-testid="question-followup-preview">
            <strong id={`${uid}-preview-title`}>{t.qFollowupPreviewTitle}</strong>
            <p>{t.qFollowupPreviewBody}</p>
            <ol className="qb-preview-list">
              {previewRows.map((row) => (
                <li key={row.name}>
                  <span className="qb-preview-q">{row.title}</span>
                  <span className="qb-preview-a">{row.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : multi ? (
          renderField(fields[step], step)
        ) : (
          fields.map((f, i) => renderField(f, i))
        )}
      </div>

      {(error || sendError) && (
        <p role="alert" className="question-error">
          {error || sendError}
        </p>
      )}
      <footer>
        {preview ? (
          <>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPreview(null)} data-testid="question-followup-back">
              {t.qFollowupBack}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void deliver(preview)}
              data-testid="question-followup-confirm"
            >
              {t.qFollowupConfirm}
            </button>
          </>
        ) : (
          <>
            <span className="qb-hint">{t.qShortcutHint(shortcut('Enter'))}</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void send('decline')}>
              {copy.skip}
            </button>
            {native && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void send('cancel')}>
                {copy.cancel2}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void send('accept')}
              data-testid="question-send"
            >
              {sendLabel}
            </button>
          </>
        )}
      </footer>
    </form>
  );
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(160, el.scrollHeight)}px`;
}

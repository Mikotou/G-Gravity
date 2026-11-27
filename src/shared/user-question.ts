export type AnswerValue = string | number | boolean | string[];

export interface QuestionField {
  name: string;
  title: string;
  description?: string;
  type: 'string' | 'array' | 'boolean' | 'number' | 'integer';
  required: boolean;
  choices?: { value: string; label: string; description?: string }[];
  initial?: AnswerValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
}

export type QuestionFollowupState = 'queued' | 'sending' | 'sent' | 'failed-unsent' | 'unknown';

export interface QuestionFollowupMetadata {
  questionMessageId: string;
  submissionId: string;
  state: QuestionFollowupState;
  detail?: string;
}

export interface QuestionSubmissionReceipt {
  mode: 'form' | 'followup';
  submissionId: string;
  followupMessageId?: string;
  followupState?: QuestionFollowupState;
}

export interface UserQuestion {
  message: string;
  fields: QuestionField[];
  state: 'open' | 'answered' | 'declined' | 'cancelled';
  answer?: string;
  /** 新版主进程显式声明 2，前端据此选用幂等回执与显式跟进协议；缺省按旧协议兼容 */
  submissionVersion?: 2;
}

export interface QuestionSubmission {
  sessionId: string;
  messageId: string;
  action: 'accept' | 'decline' | 'cancel';
  values?: Record<string, AnswerValue>;
  customReply?: string;
  displayAnswer?: string;
  /** 每个最终用户意图唯一 UUID，按 (profile, session, messageId, submissionId) 幂等去重 */
  submissionId?: string;
  /** 逐题选项编辑：fieldName -> { originalOptionValue -> editedText } */
  optionEdits?: Record<string, Record<string, string>>;
  /** 逐题自定义回答：fieldName -> customText */
  customAnswers?: Record<string, string>;
  /** 原生表单投递模式：合法 schema 走 form，经用户预览确认的不可表达改写走 followup */
  delivery?: 'form' | 'followup';
  /** 仅当跟进消息确认为 failed-unsent 时由用户手动点击「重新发送」携带 */
  retryUnsentFollowup?: boolean;
}

export function answerSummary(fields: QuestionField[], values: Record<string, AnswerValue>) {
  return fields
    .filter(f => values[f.name] !== undefined)
    .map(f => {
      const v = values[f.name];
      const show = (s: string) => f.choices?.find(o => o.value === s)?.label || s;
      const text = Array.isArray(v) ? v.map(show).join('、') : typeof v === 'string' ? show(v) : String(v);
      return fields.length > 1 ? f.title + ' · ' + text : text;
    })
    .join('\n');
}

interface ParsedListLine {
  indent: number;
  kind: 'number' | 'alpha' | 'bullet';
  text: string;
}

const isBlockquoteLine = (raw: string) => /^\s*>/.test(raw);
const cleanLine = (s: string) => s.replace(/^[#*\s]+/, '').replace(/\*\*/g, '').trim();

const isQuestionPrompt = (s: string) =>
  /[?？]$/.test(s) ||
  /^(?:请(?:选择|挑选|确认)|请选择|which (?:one|option)|choose (?:one|an option)|pick (?:one|an option)).*[:：]$/i.test(s);

const isGenericClosingQuestion = (s: string) =>
  /^(?:any (?:other )?questions|anything else|let me know if\b|还有(?:其他|什么)?问题吗|有问题吗|还需要(?:其他|什么)帮助吗)[?？]?$/i.test(
    s.trim()
  );

function parseListLine(raw: string): ParsedListLine | undefined {
  const indent = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  const num = /^(?:\d{1,2}[.)、：:]|\(\d{1,2}\))\s+(.+)$/.exec(trimmed);
  if (num) return { indent, kind: 'number', text: cleanLine(num[1]) };
  const alpha = /^(?:[A-Ha-h][.)、：:]|\([A-Ha-h]\))\s+(.+)$/.exec(trimmed);
  if (alpha) return { indent, kind: 'alpha', text: cleanLine(alpha[1]) };
  const bullet = /^[-*•]\s+(.+)$/.exec(trimmed);
  if (bullet) return { indent, kind: 'bullet', text: cleanLine(bullet[1]) };
  return undefined;
}

const NON_CHOICE_TOKEN_RE = /^(?:月|天|年|日|周|时|小时|分钟|秒|次|页|人|台|个|GB|GiB|MB|MiB|KB|KiB|TB|USD|CNY|RMB|s|ms|h|d|m)$/i;

function stripParentheticalNotes(s: string): string {
  return s.replace(/[（(][^（）()]*[）)]/g, '').replace(/\s+/g, ' ').trim();
}

function extractInlineChoices(rawTitle: string): string[] {
  const title = cleanLine(rawTitle);
  const withoutParens = stripParentheticalNotes(title);
  // 去掉开头“主题：”以便提取核心问句中的二选一或斜杠选项
  const core = withoutParens.replace(/^[^：:?？]{1,18}[：:]\s*/, '').trim();

  // 1) 行内斜杠/竖线短选项（如“平时主要用 电信 / 联通 / 移动 哪一家？”）
  const slashMatches = core.matchAll(
    /(?<![:/\w])([\u4e00-\u9fffA-Za-z0-9_+.-]{1,16}(?:\s*[/|]\s*[\u4e00-\u9fffA-Za-z0-9_+.-]{1,16}){1,5})(?![:/\w])/g
  );
  for (const match of slashMatches) {
    const rawGroup = match[1];
    if (/(?:^|[/|])\s*(?:https?:|file:|src|dist|app|usr|etc)(?=\s*[/|]|$)/i.test(rawGroup)) continue;
    const parts = rawGroup
      .split(/\s*[/|]\s*/)
      .map(p => p.replace(/^["'“「‘`]|["'”」’`]$/g, '').trim())
      .filter(Boolean);
    if (parts.length < 2 || parts.length > 6) continue;
    if (parts.some(p => p.length > 16 || NON_CHOICE_TOKEN_RE.test(p) || /^\$?\d+(?:\.\d+)?$/.test(p))) continue;
    const unique = [...new Set(parts)];
    if (unique.length !== parts.length) continue;
    // 2 项斜杠需要明确的选择语境，避免把“Docker/脚本”“GCP 账号 / 东京机器”等并列名词误判为选项
    const hasChoiceCue =
      unique.length >= 3 ||
      /(?:哪一|哪个|哪家|选择|选用|偏好|倾向|采用|使用|which|choose|prefer|pick)/i.test(core);
    if (hasChoiceCue) return unique;
  }

  // 2) “X 还是 Y？” / “prefer X or Y?” 二选一
  const pairSource = core || withoutParens;
  const pair =
    /^(?:would you (?:prefer|like)|do you (?:prefer|want)|(?:你|您)?(?:更)?(?:想要|想选|喜欢|偏好|希望选择|想选择|想用|选用|选择|是希望|倾向于?)|是否(?:直接)?(?:采用|使用|需要|希望)?)\s*(.{1,48}?)[,，]?\s*(?:还是|\s+or\s+)\s*(.{1,48}?)[？?]$/i.exec(
      pairSource
    );
  if (pair) {
    const cleaned = pair
      .slice(1)
      .map(s => s.replace(/^["'“「‘`]|["'”」’`]$/g, '').replace(/[,，;；]+$/, '').trim())
      .filter(Boolean);
    if (cleaned.length === 2 && cleaned[0] !== cleaned[1]) return cleaned;
  }

  // 3) 是非问句（排除含“还是 / or”的复合句）
  if (
    !/还是|\s+or\s+/i.test(pairSource) &&
    /^(?:would you like|do you want|should I|shall I|是否|要不要|需要我|要我)/i.test(pairSource)
  ) {
    return /[\u4e00-\u9fff]/.test(pairSource) ? ['是', '否'] : ['Yes', 'No'];
  }

  return [];
}

/** Chat-only agents may ask single or multiple structured questions in prose. */
export function writtenQuestion(text: string): UserQuestion | undefined {
  const lines = text.trimEnd().split(/\r?\n/);
  let fence = '';
  let afterFence = 0;
  lines.forEach((line, index) => {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) return;
    if (!fence) fence = match[1];
    else if (match[1].startsWith(fence) && !match[2].trim()) {
      afterFence = index + 1;
      fence = '';
    }
  });
  if (fence) return undefined;

  const rawSlice = lines
    .slice(Math.max(afterFence, lines.length - 40))
    .filter(line => line.trim().length > 0);
  if (!rawSlice.length || rawSlice.some(line => /^(?:```|~~~)/.test(line.trim()))) return undefined;

  // 1) 多题模式：检测末尾连续编号问题块（支持每题带缩进子选项或行内选项，修复 4 题错配为 1 题 + 3 假选项 Bug）
  const parsedLines = rawSlice.map(raw => ({ raw, blockquote: isBlockquoteLine(raw), clean: cleanLine(raw), item: isBlockquoteLine(raw) ? undefined : parseListLine(raw) }));
  const lastEntry = parsedLines[parsedLines.length - 1];
  if (lastEntry?.blockquote) return undefined;
  if (lastEntry?.item) {
    // 收集从末尾向前的连续列表块（允许同一编号题下的缩进续行或子选项）
    let blockStart = parsedLines.length;
    for (let i = parsedLines.length - 1; i >= 0; i--) {
      const entry = parsedLines[i];
      if (entry.item) {
        blockStart = i;
        continue;
      }
      // 允许属于上一条列表项的缩进续行
      const indent = entry.raw.length - entry.raw.trimStart().length;
      if (indent >= 2 && i > 0 && parsedLines[i - 1].item) {
        blockStart = i;
        continue;
      }
      break;
    }

    const block = parsedLines.slice(blockStart);
    const numberItems = block.filter(e => e.item?.kind === 'number');
    if (numberItems.length >= 2) {
      const topIndent = Math.min(...numberItems.map(e => e.item!.indent));
      const grouped: Array<{ title: string; subOptions: string[] }> = [];
      let validMulti = true;
      for (const entry of block) {
        if (entry.item && entry.item.kind === 'number' && entry.item.indent === topIndent) {
          grouped.push({ title: entry.item.text, subOptions: [] });
        } else if (entry.item && grouped.length > 0 && (entry.item.indent > topIndent || entry.item.kind !== 'number')) {
          grouped[grouped.length - 1].subOptions.push(entry.item.text);
        } else if (!entry.item && grouped.length > 0) {
          grouped[grouped.length - 1].title = `${grouped[grouped.length - 1].title} ${entry.clean}`.trim();
        } else {
          validMulti = false;
          break;
        }
      }
      if (validMulti && grouped.length >= 2 && grouped.length <= 12) {
        const questionCount = grouped.filter(g => isQuestionPrompt(g.title)).length;
        const hasSubChoices = grouped.some(g => g.subOptions.length >= 2);
        if (questionCount >= 2 || (questionCount >= 1 && hasSubChoices)) {
          const prevLine = blockStart > 0 ? parsedLines[blockStart - 1] : undefined;
          const intro =
            prevLine && !prevLine.item && /[:：?？]$/.test(prevLine.clean)
              ? prevLine.clean
              : grouped[0].title;
          const fields: QuestionField[] = grouped.map((g, idx) => {
            const choices =
              g.subOptions.length >= 2
                ? g.subOptions
                : extractInlineChoices(g.title);
            return {
              name: `q${idx + 1}`,
              title: g.title,
              type: 'string',
              required: true,
              choices: choices.length >= 2 ? choices.map(s => ({ value: s, label: s })) : undefined,
            };
          });
          return { message: intro, state: 'open', fields };
        }
      }
    }
  }

  // 2) 单题 + 下方选项列表（如“请选择一个：\nA. 蓝色\nB. 绿色”或“Which approach?\n1. A\n2. B”）
  if (lastEntry?.item) {
    let idx = parsedLines.length - 1;
    const options: string[] = [];
    while (idx >= 0 && options.length < 12) {
      const item = parsedLines[idx].item;
      if (!item || isQuestionPrompt(item.text)) break;
      options.unshift(item.text);
      idx--;
    }
    if (options.length >= 2 && idx >= 0 && !parsedLines[idx].item && !parsedLines[idx].blockquote && isQuestionPrompt(parsedLines[idx].clean)) {
      const message = parsedLines[idx].clean;
      return {
        message,
        state: 'open',
        fields: [
          {
            name: 'answer',
            title: message,
            type: 'string',
            required: true,
            choices: options.map(s => ({ value: s, label: s })),
          },
        ],
      };
    }
  }

  // 3) 单条末尾问句（不再倒吃前面普通步骤列表如“1. Start\n2. Verify\nAny questions?”）
  if (!lastEntry.item && isQuestionPrompt(lastEntry.clean)) {
    const message = lastEntry.clean;
    if (isGenericClosingQuestion(message)) return undefined;
    const inline = extractInlineChoices(message);
    if (!inline.length && parsedLines.length >= 2 && parsedLines[parsedLines.length - 2].item) {
      // 紧跟在普通列表后的开放尾问（无明确选项），避免把说明步骤误制卡
      return undefined;
    }
    return {
      message,
      state: 'open',
      fields: [
        {
          name: 'answer',
          title: message,
          type: 'string',
          required: true,
          choices: inline.length >= 2 ? inline.map(s => ({ value: s, label: s })) : undefined,
        },
      ],
    };
  }

  return undefined;
}

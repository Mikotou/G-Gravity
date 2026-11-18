import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedReadOnlyHistoryFile, isForbiddenCredentialOrStatePath } from '../../shared/accounts-history-contract';
import type { ImportedHistorySessionRecord, ImportedHistoryDetail } from '../../shared/accounts-history-contract';
import type { ChatMessageItem, DualTrackThoughtBlock } from '../../shared/session-contract';
import { normalizeWorkspacePath } from '../../shared/session-contract';
import { detectThoughtLanguage } from '../translation/thought-translator';
import { appendImage } from '../session/message-images';
import { within } from '../workspace/workspace-files';

export interface HistoryImporterOptions {
  roots?: string[];
  cacheDir: string;
  maxFileBytes?: number;
  debounceMs?: number;
}

function obj(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  const data = obj(value);
  return typeof data.text === 'string'
    ? data.text
    : typeof data.content === 'string'
      ? data.content
      : Array.isArray(data.content)
        ? extractText(data.content)
        : '';
}

function extractCwdFromWorkspaceUris(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return normalizeWorkspacePath(trimmed);
  try {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr) || !arr.length) return '';
    const first = String(arr[0] || '').trim();
    if (!first) return '';
    if (/^file:\/\//i.test(first)) {
      return normalizeWorkspacePath(fileURLToPath(new URL(first)));
    }
    return normalizeWorkspacePath(first);
  } catch {
    return '';
  }
}

/**
 * 兼容历史记录中的 SQL 时间和 ISO 时间。
 * 将小数秒整理到毫秒精度，无法解析或明显无效的日期采用传入的后备值。
 */
function normalizeHistoryTimestamp(raw: unknown, fallbackIso: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallbackIso;
  const trimmed = raw.trim();
  const goSqlMatch = /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(trimmed);
  if (goSqlMatch) {
    const year = parseInt(goSqlMatch[1].slice(0, 4), 10);
    if (year <= 1971) return fallbackIso;
    const ms = (goSqlMatch[3] || '000').slice(0, 3).padEnd(3, '0');
    let tz = goSqlMatch[4] || 'Z';
    if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
    const parsed = new Date(`${goSqlMatch[1]}T${goSqlMatch[2]}.${ms}${tz}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime()) && direct.getUTCFullYear() > 1971) {
    return direct.toISOString();
  }
  return fallbackIso;
}

/** 提取日志封装中的用户正文和工作目录，并标记内部系统步骤。调用方据此决定该条目是否显示为用户消息。 */
function unwrapAntigravityUserContent(raw: string): {
  text: string;
  extractedCwd?: string;
  isInternalSystemStep: boolean;
} {
  let extractedCwd: string | undefined;
  const wsMatch = /(?:Command Working Directory:\s*([^\r\n<]+)|Active Workspaces:\s*\r?\n-\s*([^\r\n<]+))/i.exec(raw);
  if (wsMatch) {
    const candidate = (wsMatch[1] || wsMatch[2] || '').trim();
    if (candidate) extractedCwd = normalizeWorkspacePath(candidate);
  }

  const reqMatches = [...raw.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/gi)];
  if (reqMatches.length > 0) {
    const joined = reqMatches.map((m) => m[1].trim()).filter(Boolean).join('\n\n');
    return { text: joined, extractedCwd, isInternalSystemStep: false };
  }

  if (/<SYSTEM_MESSAGE>[\s\S]*<\/SYSTEM_MESSAGE>/i.test(raw)) {
    return { text: '', extractedCwd, isInternalSystemStep: true };
  }

  const stripped = raw
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<user_information>[\s\S]*?<\/user_information>/gi, '')
    .trim();

  return { text: stripped, extractedCwd, isInternalSystemStep: false };
}

function cleanFallbackTitle(rawText: string): string {
  const firstLine = rawText
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return firstLine.slice(0, 64) || '导入的历史会话';
}

/** 仅读取白名单内容；从不打开源数据库作 SQLite 写入或自动修复。 */
export class HistoryImporter extends EventEmitter {
  readonly roots: string[];
  private details = new Map<string, ImportedHistoryDetail>();
  private watchers: FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private scanning?: Promise<ImportedHistorySessionRecord[]>;
  private disposed = false;
  private validatedRoots = new Set<string>();
  private cache = new Map<string, { signature: string; details: ImportedHistoryDetail[]; explicitTitleIds?: Set<string> }>();

  constructor(private options: HistoryImporterOptions) {
    super();
    this.roots = (
      options.roots || [join(homedir(), '.gemini', 'antigravity'), join(homedir(), '.gemini', 'antigravity-cli')]
    ).map((root) => resolve(root));
    if (isForbiddenCredentialOrStatePath(options.cacheDir) || this.roots.some((root) => within(root, resolve(options.cacheDir)))) {
      throw new Error('历史缓存必须位于独立客户端目录');
    }
  }

  list(): ImportedHistorySessionRecord[] {
    return [...this.details.values()]
      .map(({ messages: _messages, ...record }) => ({ ...record }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getDetail(sessionId: string): ImportedHistoryDetail {
    const item = this.details.get(sessionId);
    if (!item) throw new Error('导入历史不存在，请刷新列表');
    return structuredClone(item);
  }

  /** 手动刷新与目录监听共享同一轮扫描。从进入扫描到 finally 清理期间，调用者都等待同一份结果。 */
  async refresh(): Promise<ImportedHistorySessionRecord[]> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scan();
    try {
      return await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }

  private shouldEnterDirectory(depth: number, parentName: string, entryName: string): boolean {
    if (depth === 0) {
      return /^(?:brain|conversations|history)$/i.test(entryName);
    }
    if (depth === 2 && /^brain$/i.test(parentName)) {
      // brain/<convId> 下只进入 .system_generated，跳过海量截图与临时产物
      return entryName === '.system_generated';
    }
    if (depth === 3 && parentName === '.system_generated') {
      return entryName === 'logs';
    }
    return depth < 6;
  }

  private async scan(): Promise<ImportedHistorySessionRecord[]> {
    const next = new Map<string, ImportedHistoryDetail>();
    const explicitTitles = new Set<string>();
    const dbMetaByConvId = new Map<string, { title: string; cwd: string; updatedAt: string }>();
    const seenPaths = new Set<string>();

    for (const root of this.roots) {
      if (isForbiddenCredentialOrStatePath(root)) continue;
      try {
        if ((await fs.lstat(root)).isSymbolicLink() || (await fs.realpath(root)) !== root) continue;
      } catch {
        continue;
      }
      this.validatedRoots.add(root);
      const queue: Array<{ path: string; depth: number; grandParentName: string }> = [
        { path: root, depth: 0, grandParentName: '' },
      ];
      let entriesSeen = 0;

      while (queue.length && entriesSeen < 60000) {
        const dir = queue.shift()!;
        let entries;
        try {
          entries = await fs.readdir(dir.path, { withFileTypes: true });
        } catch {
          continue;
        }
        const curDirName = basename(dir.path);

        for (const entry of entries) {
          if (++entriesSeen > 60000) break;
          const path = join(dir.path, entry.name);
          if (entry.isSymbolicLink() || isForbiddenCredentialOrStatePath(path)) continue;
          if (entry.isDirectory()) {
            const parentTag = dir.depth === 2 ? dir.grandParentName : curDirName;
            if (this.shouldEnterDirectory(dir.depth, parentTag, entry.name)) {
              queue.push({ path, depth: dir.depth + 1, grandParentName: curDirName });
            }
            continue;
          }
          if (!entry.isFile() || entry.name.endsWith('.db-wal') || !isAllowedReadOnlyHistoryFile(path)) continue;
          // 同一目录同时存在精简与完整转录时只选精简版，避免一段对话被导入两遍。
          if (entry.name === 'transcript_full.jsonl' && entries.some((other) => other.name === 'transcript.jsonl')) continue;

          try {
            const actual = await fs.realpath(path);
            if (!within(root, actual) || actual !== path || isForbiddenCredentialOrStatePath(actual) || !isAllowedReadOnlyHistoryFile(actual)) {
              continue;
            }
            const before = await fs.stat(actual);
            if (before.size > (this.options.maxFileBytes || 32 * 1024 * 1024)) continue;

            // 摘要库的最近提交可能只在 WAL 中。缓存签名也纳入它的大小和修改时间，主库未变时仍能察觉新内容。
            let signature = `${before.size}:${before.mtimeMs}`;
            const isSummaryDb = basename(actual) === 'conversation_summaries.db';
            if (isSummaryDb && isAllowedReadOnlyHistoryFile(`${actual}-wal`) && !isForbiddenCredentialOrStatePath(`${actual}-wal`)) {
              try {
                const wal = await fs.lstat(`${actual}-wal`);
                if (wal.isSymbolicLink()) continue;
                signature += `:${wal.size}:${wal.mtimeMs}`;
              } catch {
                signature += ':no-wal';
              }
            }
            seenPaths.add(actual);

            const cached = this.cache.get(actual);
            if (cached?.signature === signature) {
              for (const detail of cached.details) {
                const cloned = structuredClone(detail);
                next.set(cloned.sessionId, cloned);
                if (cached.explicitTitleIds?.has(cloned.sessionId)) explicitTitles.add(cloned.sessionId);
                if (isSummaryDb) {
                  const prevMeta = dbMetaByConvId.get(cloned.rawConversationId);
                  if (!prevMeta || (!prevMeta.title && cloned.title) || (!prevMeta.cwd && cloned.cwd)) {
                    dbMetaByConvId.set(cloned.rawConversationId, {
                      title: cloned.title || prevMeta?.title || '',
                      cwd: cloned.cwd || prevMeta?.cwd || '',
                      updatedAt: cloned.updatedAt,
                    });
                  }
                }
              }
              continue;
            }

            // 最后一次打开前重复双重校验，源文件只以读取模式访问。
            if (isForbiddenCredentialOrStatePath(actual) || !isAllowedReadOnlyHistoryFile(actual)) continue;
            const bytes = await fs.readFile(actual);
            const after = await fs.stat(actual);
            if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) continue;

            if (isSummaryDb) {
              const details = await this.readDatabaseSnapshot(actual, bytes, before.mtime.toISOString(), before);
              this.cache.set(actual, { signature, details: structuredClone(details) });
              for (const detail of details) {
                next.set(detail.sessionId, detail);
                const prevMeta = dbMetaByConvId.get(detail.rawConversationId);
                if (!prevMeta || (!prevMeta.title && detail.title) || (!prevMeta.cwd && detail.cwd)) {
                  dbMetaByConvId.set(detail.rawConversationId, {
                    title: detail.title || prevMeta?.title || '',
                    cwd: detail.cwd || prevMeta?.cwd || '',
                    updatedAt: detail.updatedAt,
                  });
                }
              }
            } else {
              const parsed = this.parseContentWithMeta(actual, bytes.toString('utf8'), before.mtime.toISOString());
              const explicitSet = new Set<string>();
              if (parsed?.detail && parsed.hasExplicitTitle) explicitSet.add(parsed.detail.sessionId);
              this.cache.set(actual, {
                signature,
                details: parsed?.detail ? [structuredClone(parsed.detail)] : [],
                explicitTitleIds: explicitSet,
              });
              if (parsed?.detail) {
                next.set(parsed.detail.sessionId, parsed.detail);
                if (parsed.hasExplicitTitle) explicitTitles.add(parsed.detail.sessionId);
              }
            }
          } catch {
            this.emit('warning', `已跳过无法安全读取的历史文件：${basename(path)}`);
          }
        }
      }
    }

    // 将 conversation_summaries.db 中的整理标题与工作区路径合并补充到对应 transcript.jsonl 记录上
    for (const detail of next.values()) {
      if (basename(detail.sourcePath) === 'conversation_summaries.db') continue;
      const meta = dbMetaByConvId.get(detail.rawConversationId);
      if (!meta) continue;
      if (meta.title && meta.title !== '导入的历史会话' && !explicitTitles.has(detail.sessionId)) {
        detail.title = meta.title;
      }
      if (!detail.cwd && meta.cwd) {
        detail.cwd = meta.cwd;
      }
    }

    // 扫描完成才发布整套索引。先移除这次未见的缓存项，以便源文件删除或改名后在列表中体现。
    for (const path of this.cache.keys()) if (!seenPaths.has(path)) this.cache.delete(path);
    if (!this.disposed) {
      this.details = next;
      this.emit('updated', this.list());
    }
    return this.list();
  }

  private makeDetail(
    path: string,
    rawId: string,
    title: string,
    cwd: string,
    updatedAt: string,
    messages: ChatMessageItem[],
    summary = ''
  ): ImportedHistoryDetail {
    const origin = path.replace(/\\/g, '/').includes('/antigravity-cli/')
      ? ('antigravity-cli' as const)
      : ('antigravity-desktop' as const);
    // 源路径与原始会话号共同决定导入 ID。同号的不同来源可以区分，同一份记录刷新后仍可定位。
    const sessionId = `ag-history:${createHash('sha256').update(`${path}\0${rawId}`).digest('hex').slice(0, 32)}`;
    const resolvedTitle =
      title.trim() ||
      cleanFallbackTitle(messages.find((message) => message.role === 'user')?.content || summary || '');
    return {
      sessionId,
      rawConversationId: rawId,
      origin,
      title: resolvedTitle,
      cwd: normalizeWorkspacePath(cwd || ''),
      updatedAt,
      messageCount: messages.length,
      summarySnippet: (summary || messages.map((message) => `${message.role}: ${message.content}`).join('\n')).slice(
        0,
        4000
      ),
      sourcePath: path,
      readOnly: true,
      messages: messages.map((message) => ({ ...message, sessionId })),
    };
  }

  parseContent(path: string, text: string, modifiedAt: string): ImportedHistoryDetail | undefined {
    return this.parseContentWithMeta(path, text, modifiedAt)?.detail;
  }

  private parseContentWithMeta(
    path: string,
    text: string,
    modifiedAt: string
  ): { detail: ImportedHistoryDetail; hasExplicitTitle: boolean } | undefined {
    if (isForbiddenCredentialOrStatePath(path) || !isAllowedReadOnlyHistoryFile(path)) {
      throw new Error('历史文件未通过双重路径检查');
    }
    let records: unknown[] = [];
    let metadata: Record<string, any> = {};
    // 先按文件格式提取记录，再统一建立消息。JSONL 按行容错，一条损坏记录不会截断后续聊天。
    if (path.endsWith('.md')) {
      records = [{ role: 'assistant', content: text }];
    } else if (path.endsWith('.jsonl')) {
      records = text
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } else {
      const parsed = JSON.parse(text);
      metadata = obj(parsed);
      records = Array.isArray(parsed) ? parsed : parsed.messages || parsed.turns || parsed.history || [];
    }

    const messages: ChatMessageItem[] = [];
    let pendingThoughts: string[] = [];
    let latestStepAt = '';

    // 不同历史版本把正文放在 message、payload 或记录本身。
    // 统一外层结构后只处理末尾 1200 条，限制单份历史的展示成本。
    for (const record of records.slice(-1200)) {
      const outer = obj(record);
      const payload = obj(outer.payload);
      const message = Object.keys(obj(outer.message)).length
        ? obj(outer.message)
        : Object.keys(payload).length
          ? payload
          : outer;

      if (typeof outer.cwd === 'string') metadata.cwd ||= outer.cwd;
      if (typeof message.cwd === 'string') metadata.cwd ||= message.cwd;
      if (typeof outer.title === 'string') metadata.title ||= outer.title;

      const stepTime =
        typeof outer.created_at === 'string'
          ? normalizeHistoryTimestamp(outer.created_at, modifiedAt)
          : typeof outer.timestamp === 'string'
            ? normalizeHistoryTimestamp(outer.timestamp, modifiedAt)
            : '';
      if (stepTime && stepTime > latestStepAt) latestStepAt = stepTime;

      const isAntigravityTrajectory =
        typeof outer.step_index === 'number' ||
        outer.type === 'USER_INPUT' ||
        outer.type === 'PLANNER_RESPONSE' ||
        outer.type === 'GENERIC';

      const parts = message.content ?? message.parts ?? message.text ?? message.message;
      const media: Pick<ChatMessageItem, 'attachments'> = {};
      appendImage(media, parts);
      if (isAntigravityTrajectory) {
        if (outer.type === 'USER_INPUT') {
          pendingThoughts = [];
          const rawUser = extractText(parts);
          const unwrapped = unwrapAntigravityUserContent(rawUser);
          if (unwrapped.extractedCwd && !metadata.cwd) metadata.cwd = unwrapped.extractedCwd;
          if (unwrapped.isInternalSystemStep || (!unwrapped.text && !media.attachments?.length)) continue;
          messages.push({
            id: `history-${messages.length}`,
            sessionId: '',
            role: 'user',
            content: unwrapped.text.slice(0, 100000), ...media,
            createdAt: stepTime || modifiedAt,
          });
        } else if (outer.type === 'PLANNER_RESPONSE') {
          if (typeof outer.thinking === 'string' && outer.thinking.trim()) {
            pendingThoughts.push(outer.thinking.trim());
          }
          // 思考和正文可分属不同步骤。先暂存连续的思考片段，等第一段非空的助手正文到达时一并归到该条消息。
          const content = extractText(parts).trim();
          if (!content && !media.attachments?.length) continue;
          const combinedThought = pendingThoughts.join('\n\n');
          pendingThoughts = [];
          const thoughtBlocks: DualTrackThoughtBlock[] | undefined = combinedThought
            ? [
                {
                  id: `history-thought-${messages.length}`,
                  originalText: combinedThought,
                  translatedZhText: combinedThought,
                  isStreaming: false,
                  languageDetected: detectThoughtLanguage(combinedThought),
                  translationSource: 'native-zh',
                },
              ]
            : undefined;
          messages.push({
            id: `history-${messages.length}`,
            sessionId: '',
            role: 'assistant',
            content: content.slice(0, 100000), ...media,
            thoughts: thoughtBlocks,
            createdAt: stepTime || modifiedAt,
          });
        }
        // 跳过 GENERIC 等工具原始输出行，避免文件内容刷屏对话流
        continue;
      }

      const rawRole =
        message.role ||
        outer.role ||
        (message.type === 'user_message' || outer.source === 'USER_EXPLICIT'
          ? 'user'
          : message.type === 'agent_message' || outer.source === 'MODEL'
            ? 'assistant'
            : outer.source === 'SYSTEM'
              ? 'system'
              : '');
      const role = rawRole === 'model' ? 'assistant' : rawRole;
      const content = extractText(parts);
      if (!['user', 'assistant', 'system'].includes(role) || (!content && !media.attachments?.length)) continue;
      messages.push({
        id: `history-${messages.length}`,
        sessionId: '',
        role: role as 'user' | 'assistant' | 'system',
        content: content.slice(0, 100000), ...media,
        createdAt: stepTime || modifiedAt,
      });
    }

    if (!messages.length && !metadata.summary) return undefined;
    const firstUserMsg = messages.find((m) => m.role === 'user')?.content || '';
    if (/^\[Gravity Translator\]/i.test(firstUserMsg.trim())) return undefined;
    const normalized = path.replace(/\\/g, '/');
    const id =
      metadata.id ||
      metadata.sessionId ||
      /\/brain\/([^/]+)\//.exec(normalized)?.[1] ||
      basename(path).replace(/\.[^.]+$/, '');
    const explicitTitle = String(metadata.title || '').trim();
    const detail = this.makeDetail(
      path,
      String(id),
      explicitTitle,
      String(metadata.cwd || metadata.workspace || ''),
      latestStepAt || modifiedAt,
      messages,
      extractText(metadata.summary)
    );
    return { detail, hasExplicitTitle: Boolean(explicitTitle) };
  }

  /** 在客户端缓存中建立摘要库的临时快照。若有 WAL 一并复制，让只读查询能看到尚未合入主库的提交。 */
  private async readDatabaseSnapshot(
    source: string,
    bytes: Buffer,
    modifiedAt: string,
    expected: { size: number; mtimeMs: number }
  ): Promise<ImportedHistoryDetail[]> {
    if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') return [];
    const sourceStat = await fs.stat(source);
    if (sourceStat.size !== expected.size || sourceStat.mtimeMs !== expected.mtimeMs) {
      throw new Error('历史数据库已改变，请稍后刷新');
    }
    let walBytes: Buffer | undefined;
    const walPath = `${source}-wal`;
    if (bytes[18] === 2 || bytes[19] === 2) {
      if (!isAllowedReadOnlyHistoryFile(walPath) || isForbiddenCredentialOrStatePath(walPath)) {
        throw new Error('WAL 文件未通过历史路径校验');
      }
      try {
        const stat = await fs.lstat(walPath);
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          stat.size > (this.options.maxFileBytes || 32 * 1024 * 1024) ||
          (await fs.realpath(walPath)) !== walPath
        ) {
          throw new Error('WAL 路径或大小不安全');
        }
        if (!isAllowedReadOnlyHistoryFile(walPath) || isForbiddenCredentialOrStatePath(walPath)) {
          throw new Error('WAL 路径校验失败');
        }
        walBytes = await fs.readFile(walPath);
        const after = await fs.stat(walPath);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
          throw new Error('历史数据库仍在写入，请稍后刷新');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const afterDb = await fs.stat(source);
      if (afterDb.size !== sourceStat.size || afterDb.mtimeMs !== sourceStat.mtimeMs) {
        throw new Error('历史数据库写入中，快照已放弃');
      }
    }

    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    await fs.mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
    const realCache = await fs.realpath(this.options.cacheDir);
    if (
      realCache !== resolve(this.options.cacheDir) ||
      isForbiddenCredentialOrStatePath(realCache) ||
      this.roots.some((root) => within(root, realCache))
    ) {
      throw new Error('历史临时快照目录不安全');
    }
    const snapshotDir = join(realCache, `history-${randomUUID()}`);
    await fs.mkdir(snapshotDir, { mode: 0o700 });
    const snapshot = join(snapshotDir, 'conversation_summaries.db');
    const copy = Buffer.from(bytes);
    if (!walBytes) {
      copy[18] = 1;
      copy[19] = 1;
    }
    let db: InstanceType<typeof DatabaseSync> | undefined;
    try {
      await fs.writeFile(snapshot, copy, { mode: 0o600, flag: 'wx' });
      if (walBytes) await fs.writeFile(`${snapshot}-wal`, walBytes, { mode: 0o600, flag: 'wx' });
      db = new DatabaseSync(snapshot, { open: true, readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_summaries','conversations','sessions')")
        .all();
      const details: ImportedHistoryDetail[] = [];

      for (const table of tables) {
        const name = String(table.name);
        const columns = db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map((row) => String(row.name));
        // 先枚举实际表结构，再与候选列取交集。不同版本的摘要库可缺少字段，查询只选用可识别的列。
        const candidateCols = [
          'id',
          'conversation_id',
          'session_id',
          'title',
          'summary',
          'summary_text',
          'preview',
          'cwd',
          'workspace',
          'workspace_path',
          'workspace_uris',
          'updated_at',
          'updatedAt',
          'last_modified_time',
          'parent_conversation_id',
          'nesting_depth',
          'killed',
        ];
        const allowed = candidateCols.filter((column) => columns.includes(column));
        if (!allowed.length) continue;

        const orderCol = ['last_modified_time', 'updated_at', 'updatedAt'].find((col) => columns.includes(col));
        const orderClause = orderCol ? ` ORDER BY "${orderCol}" DESC` : '';
        const rows = db
          .prepare(`SELECT ${allowed.map((column) => `"${column}"`).join(',')} FROM "${name}"${orderClause} LIMIT 1500`)
          .all();

        const hasRealAntigravitySchema = columns.includes('last_modified_time') && columns.includes('preview');

        for (const row of rows) {
          // 过滤子智能体内部派生会话与已销毁空记录
          if (typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim()) continue;
          if (typeof row.nesting_depth === 'number' && row.nesting_depth > 0) continue;
          if (Number(row.killed) === 1) continue;

          const id = String(row.conversation_id || row.session_id || row.id || details.length);
          const title = String(row.title || '').trim();
          const summary = String(row.summary || row.summary_text || row.preview || '').trim();
          if (/^\[Gravity Translator\]/i.test(title) || /^\[Gravity Translator\]/i.test(summary)) continue;
          if (hasRealAntigravitySchema && !title && !summary) continue;

          const rawCwd =
            String(row.cwd || row.workspace || row.workspace_path || '').trim() ||
            extractCwdFromWorkspaceUris(row.workspace_uris);
          const rawTime = row.last_modified_time || row.updated_at || row.updatedAt;
          const updatedAt = normalizeHistoryTimestamp(rawTime, modifiedAt);

          details.push(
            this.makeDetail(
              source,
              id,
              title,
              rawCwd,
              updatedAt,
              summary
                ? [{ id: 'summary', sessionId: '', role: 'user', content: summary, createdAt: updatedAt }]
                : [],
              summary
            )
          );
        }
      }
      return details;
    } finally {
      db?.close();
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await fs.unlink(`${snapshot}${suffix}`).catch(() => {});
      }
      await fs.rmdir(snapshotDir).catch(() => {});
    }
  }

  /** 只监听已在扫描中验证过的根目录。连续变更共用防抖定时器，最终统一通过 refresh 更新索引。 */
  startWatching(): void {
    if (this.watchers.length || this.disposed) return;
    for (const root of this.roots) {
      if (!this.validatedRoots.has(root) || isForbiddenCredentialOrStatePath(root)) continue;
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
          if (file && isForbiddenCredentialOrStatePath(join(root, file.toString()))) return;
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().catch(() => this.emit('warning', '历史刷新失败'));
          }, this.options.debounceMs || 300);
          this.timer.unref();
        });
        watcher.on('error', () => this.emit('warning', '历史目录监听已停止'));
        this.watchers.push(watcher);
      } catch {
        /* 目录不存在时无监听 */
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}

import { EventEmitter } from 'node:events';
import type { AcpSessionUpdatePayload } from '../../shared/acp-protocol';
import { computeUnifiedLineDiff, isToolCallFailure, terminalCommand } from '../../shared/session-contract';
import type { SemanticToolCallCard, SessionInspectorData, FileDiffEntry } from '../../shared/session-contract';
import { getCanonicalToolName } from '../../shared/theme-i18n-contract';
import type { ClientStore } from '../storage/client-store';

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
export class InspectorStore extends EventEmitter {
  private states = new Map<string, SessionInspectorData>();
  private proposedDiffs = new Map<string, FileDiffEntry[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private filename = 'inspector-states.json';
  constructor(private store?: ClientStore, profileId?: string, owned?: ReadonlySet<string>) {
    super();
    this.setProfile(profileId, owned);
  }
  setProfile(profileId?: string, owned?: ReadonlySet<string>): void {
    this.flush();
    this.clear();
    this.filename = profileId ? 'inspector-states-' + profileId + '.json' : 'inspector-states.json';
    if (this.store) {
      const saved = this.store.readSessionRecords<SessionInspectorData>(this.filename, 'inspector-states.json', owned);
      if (saved && typeof saved === 'object') {
        for (const [sid, data] of Object.entries(saved)) {
          if (data && typeof data === 'object' && Array.isArray(data.diffs)) {
            for (const entry of data.terminals ??= []) entry.revision ??= 0;
            this.states.set(sid, data);
          }
        }
      }
    }
  }
  get(sessionId: string): SessionInspectorData { return structuredClone(this.states.get(sessionId) || { sessionId, diffs: [], todos: [], terminals: [] }); }
  flush(): void {
    for (const id of this.timers.keys()) this.publish(id);
    this.store?.flushPending(this.filename);
  }
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.states.clear(); this.proposedDiffs.clear();
  }
  /** 消费一条增量通知，更新该会话的计划、工具卡片或终端记录。调用者传入旧卡片以合并仅含状态的新通知。 */
  consume(sessionId: string, update: AcpSessionUpdatePayload, previous?: SemanticToolCallCard, denyReason?: string): SemanticToolCallCard | undefined {
    const state: SessionInspectorData = this.states.get(sessionId) || { sessionId, diffs: [], todos: [], terminals: [] };
    if (update.sessionUpdate === 'plan') {
      state.todos = (update.entries || []).slice(0, 100).map((entry, index) => ({ id: `todo-${index}`, content: entry.content, status: entry.status || 'pending', priority: entry.priority })); this.save(state); return;
    }
    if (!update.toolCallId) return;
    const input = record(update.rawInput); const output = record(update.rawOutput);
    const kindNames: Record<string, string> = { execute: 'run_command', read: 'read_file', edit: 'edit_file', search: 'grep_search', fetch: 'search_web' };
    const titleName = update.title && getCanonicalToolName(update.title) !== update.title ? update.title : undefined;
    const knownName = previous && previous.rawToolName !== previous.canonicalToolName ? previous.rawToolName : undefined;
    const name = string(input.toolName) || string(update.name) || knownName || titleName || kindNames[update.kind || '']
      || (previous?.rawToolName !== 'Tool' ? previous?.rawToolName : undefined) || update.title || 'Tool';
    const now = new Date().toISOString();
    const card: SemanticToolCallCard = {
      toolCallId: update.toolCallId, compactTarget: '', argsSummary: '', status: 'pending', startedAt: now,
      ...previous, rawToolName: name, canonicalToolName: getCanonicalToolName(name),
    };
    if (update.rawInput !== undefined) {
      card.argsSummary = (typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput)).slice(0, 20000);
      const command = string(input.command) || string(input.CommandLine) || string(input.cmd) || string(input.Command) ||
        (card.canonicalToolName === 'Bash' ? string(update.rawInput) : '');
      if (command) card.command = command;
      card.compactTarget = (command || string(input.path) || string(input.file_path) || string(input.filePath) || string(input.pattern) || string(input.query) || card.argsSummary).replace(/\s+/g, ' ').slice(0, 240);
    }
    const content = update.toolContent || (Array.isArray(update.content) ? update.content as unknown as NonNullable<AcpSessionUpdatePayload['toolContent']> : []);
    const outputText = content.filter(item => item.type === 'content' && item.content?.type === 'text')
      .map(item => item.content!.text).join('\n');
    if (update.rawOutput !== undefined || outputText) {
      const streams = [output.stdout, output.stderr].filter(item => typeof item === 'string' && item).join('\n');
      const text = string(update.rawOutput) || streams || string(output.Output) || string(output.output) || outputText;
      const hasResultFields = Object.keys(output).some(key => !['exitCode', 'exit_code', 'ExitCode'].includes(key));
      if (text || hasResultFields) {
        const full = text || JSON.stringify(output);
        card.outputPreview = full.length <= 20000 ? full : full.slice(0, 18996) + '\n…\n' + full.slice(-1000);
      }
    }
    if (update.locations) card.locations = update.locations;
    if (update.status) card.status = update.status === 'in_progress' ? 'running' : ['completed', 'failed', 'rejected'].includes(update.status) ? update.status as 'completed' | 'failed' | 'rejected' : 'pending';
    const exitCode = output.exitCode ?? output.exit_code ?? output.ExitCode;
    if (typeof exitCode === 'number') card.exitCode = exitCode;
    if (denyReason) {
      card.status = 'rejected';
      const prefix = '[本地安全策略已拦截] ' + denyReason;
      if (!card.outputPreview?.startsWith(prefix)) card.outputPreview = prefix + (card.outputPreview ? '\n' + card.outputPreview : '');
    }
    if (card.status === 'completed' || card.status === 'failed' || card.status === 'rejected') card.completedAt ??= now;
    // ACP 的 diff 内容是权威修改数据；不得读回工作区文件来伪造修改前版本。
    const patches = content.filter(item => item.type === 'diff' && item.path);
    if (!patches.length && ['Edit', 'Write'].includes(card.canonicalToolName)) {
      const filePath = string(input.path || input.file_path || input.filePath || update.locations?.[0]?.path);
      const oldText = input.oldText ?? input.old_string; const newText = input.newText ?? input.new_string ?? input.content;
      if (filePath && typeof newText === 'string' && (typeof oldText === 'string' || card.canonicalToolName === 'Write')) patches.push({ type: 'diff', path: filePath, oldText: string(oldText), newText });
    }
    // 同一会话可以有多个工具同时编辑文件，用会话号和工具调用号关联暂存补丁与最终结果。
    const patchKey = `${sessionId}\0${card.toolCallId}`; const proposed: FileDiffEntry[] = [];
    for (const patch of patches) {
      if (typeof patch.newText !== 'string') continue;
      const diff = computeUnifiedLineDiff(patch.path!, patch.oldText || '', patch.newText, card.toolCallId);
      card.diffPatch = diff; proposed.push(diff);
    }
    if (proposed.length) this.proposedDiffs.set(patchKey, proposed);
    // 只有完成的工具改动进入文件检查面板。失败或被拒绝时丢弃提案，避免将预览当作已写入的内容。
    if (isToolCallFailure(card)) {
      this.proposedDiffs.delete(patchKey);
      state.diffs = state.diffs.filter(diff => diff.toolCallId !== card.toolCallId);
    } else if (card.status === 'completed') {
      for (const diff of this.proposedDiffs.get(patchKey) || []) { const index = state.diffs.findIndex(item => item.filePath === diff.filePath); if (index >= 0) state.diffs[index] = diff; else state.diffs.push(diff); }
      this.proposedDiffs.delete(patchKey);
    }
    if (card.canonicalToolName === 'Bash' && card.status !== 'pending') {
      const terminal = { id: card.toolCallId, toolCallId: card.toolCallId, command: terminalCommand(card), output: card.outputPreview || '', status: card.status, exitCode: card.exitCode, timestamp: card.startedAt };
      const index = state.terminals.findIndex(item => item.toolCallId === card.toolCallId);
      const old = state.terminals[index];
      if (!old || old.command !== terminal.command || old.output !== terminal.output || old.status !== terminal.status || old.exitCode !== terminal.exitCode) {
        const revised = { ...terminal, revision: (old?.revision ?? 0) + 1 };
        if (old) state.terminals[index] = revised; else state.terminals.push(revised);
      }
    }
    state.diffs = state.diffs.slice(-200); state.terminals = state.terminals.slice(-200); this.save(state, Boolean(card.completedAt)); return card;
  }
  remove(id: string): void {
    for (const key of this.proposedDiffs.keys()) if (key.startsWith(id + '\0')) this.proposedDiffs.delete(key);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.states.delete(id);
    this.store?.write(this.filename, Object.fromEntries(this.states));
  }
  private save(state: SessionInspectorData, immediate = false): void {
    this.states.delete(state.sessionId);
    this.states.set(state.sessionId, state);
    while (this.states.size > 200) this.states.delete(this.states.keys().next().value!);
    if (immediate) { this.publish(state.sessionId); return; }
    if (this.timers.has(state.sessionId)) return;
    const timer = setTimeout(() => this.publish(state.sessionId), 50);
    timer.unref();
    this.timers.set(state.sessionId, timer);
  }
  private publish(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const state = this.states.get(id);
    if (!state) return;
    this.store?.writeDebounced(this.filename, Object.fromEntries(this.states));
    this.emit('updated', structuredClone(state));
  }
}

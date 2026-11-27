import { redactSecretsForReviewer } from '../security/redaction';
import { summarizeMessageIntentForContext } from '../../shared/message-annotation';
import { modelConfig, selectValues } from '../session/session-options-store';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AcpConfigOption, AcpSessionUpdateNotification } from '../../shared/acp-protocol';
import {
  TITLE_ORGANIZE_MODEL_LABEL, TITLE_ORGANIZE_RATE_LIMIT, type ManagedSessionSummary,
  type TitleOrganizeRequest, type TitleOrganizeResult,
} from '../../shared/session-contract';
import type { OrganizerHost } from '../core-contracts';
import type { ConversationMessages } from '../storage/conversation-messages';


export class TitleOrganizerService {
  private titleOrganizeTimestamps: number[] = [];
  organizingTitles = false;

  constructor(private app: OrganizerHost, private messages: () => ConversationMessages,
    private enrichSession: (session: ManagedSessionSummary) => ManagedSessionSummary,
    private emitTreeUpdate: (sessionId: string) => void, private nowMs: () => number,
    private isDisposed: () => boolean, private homeDir?: string) {}

  async renameSession(sessionId: string, newTitle: string) {
    this.app.accounts.assertReady();
    const rootId = this.app.trees.resolveRootId(sessionId);
    const root = this.app.sessions.get(rootId);
    const renamed = this.app.titles.rename(root, newTitle);
    this.publishTreeTitle(renamed);
    return this.enrichSession(this.app.sessions.get(sessionId));
  }
  private publishTreeTitle(root: ManagedSessionSummary): void {
    const rootId = root.sessionId;
    this.app.sessions.updateSessionRecord(root, false);
    const branches = this.app.trees.listBranchIds(rootId);
    for (const bid of branches) {
      const s = this.app.sessions.sessions.get(bid);
      if (!s) continue;
      if (bid !== rootId) {
        s.title = root.title;
        this.app.sessions.updateSessionRecord(s, false);
      }
      this.app.emit('session-updated', this.enrichSession(s));
    }
    if (this.app.trees.hasTree(rootId)) this.emitTreeUpdate(rootId);
  }
  async togglePinSession(sessionId: string) {
    this.app.accounts.assertReady();
    const rootId = this.app.trees.resolveRootId(sessionId);
    const session = this.app.titles.togglePin(this.app.sessions.get(rootId));
    this.app.sessions.updateSessionRecord(session, false);
    const enriched = this.enrichSession(session);
    this.app.emit('session-updated', enriched);
    return sessionId === rootId ? enriched : this.enrichSession(this.app.sessions.get(sessionId));
  }
  private pruneOrganizeTimestamps(now = this.nowMs()): number[] {
    const cutoff = now - TITLE_ORGANIZE_RATE_LIMIT.windowMs;
    this.titleOrganizeTimestamps = this.titleOrganizeTimestamps.filter(ts => ts > cutoff);
    return this.titleOrganizeTimestamps;
  }
  private parseOrganizedTitleResponse(
    rawText: string,
    targets: ManagedSessionSummary[]
  ): Map<string, { organizedTitle: string; categoryTag?: string }> {
    const result = new Map<string, { organizedTitle: string; categoryTag?: string }>();
    const targetIds = new Set(targets.map(item => item.sessionId));
    const trimmed = rawText.trim();
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = (fenceMatch ? fenceMatch[1] : trimmed).trim();
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start < 0 || end <= start) return result;
    let parsed: unknown;
    try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return result; }
    if (!Array.isArray(parsed)) return result;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId.trim() : '';
      const rawTitle = typeof rec.organizedTitle === 'string' ? rec.organizedTitle : typeof rec.title === 'string' ? rec.title : '';
      const cleanTitle = rawTitle.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!sessionId || !targetIds.has(sessionId) || !cleanTitle) continue;
      const rawCat = typeof rec.categoryTag === 'string' ? rec.categoryTag : typeof rec.category === 'string' ? rec.category : '';
      const cleanCat = rawCat.replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
      const formatted = /[｜|]/.test(cleanTitle)
        ? cleanTitle.replace(/\s*\|\s*/, '｜')
        : cleanCat ? `${cleanCat}｜${cleanTitle}` : cleanTitle;
      result.set(sessionId, {
        organizedTitle: formatted,
        categoryTag: cleanCat || (formatted.includes('｜') ? formatted.split('｜')[0].trim() : undefined),
      });
    }
    return result;
  }
  /** 通过官方 agy acp 临时只读会话调用内置模型 Hydrogen (medium) 整理标题，用毕立即关闭并释放并发槽位。 */
  private async runHydrogenTitleOrganizer(
    targets: ManagedSessionSummary[]
  ): Promise<{ map: Map<string, { organizedTitle: string; categoryTag?: string }>; modelUsed: string }> {
    const slot = this.app.sessions.reserveExternalSlot();
    const profileId = targets[0].profileId;
    const checkProfile = () => {
      if (this.isDisposed() || profileId !== this.app.accounts.activeProfileId) throw new Error('当前账号已切换，已停止整理');
    };
    let tempSessionId: string | undefined;
    let outputText = '';
    const onUpdate = (payload: AcpSessionUpdateNotification) => {
      if (payload?.sessionId !== tempSessionId) return;
      if (payload.update?.sessionUpdate === 'agent_message_chunk' && payload.update.content?.text) {
        outputText += payload.update.content.text;
      }
    };
    try {
      await this.app.client.start();
      checkProfile();
      if (!this.app.client.initializeResult?.agentCapabilities.sessionCapabilities?.close) throw new Error('官方未声明 close 能力，无法创建临时整理会话');
      const validCwd = targets.find(item => item.cwd && existsSync(item.cwd))?.cwd || this.homeDir || homedir();
      const append = this.app.client.initializeResult?.agentCapabilities._meta?.antigravity?.systemPrompt?.append;
      const created = await this.app.sessions.slots.open(slot, 'session/new', {
        cwd: validCwd,
        mcpServers: [],
        ...(append
          ? {
              _meta: {
                antigravity: {
                  systemPrompt: {
                    append: '你是只读标题整理助手。严禁调用任何工具、命令或子智能体，只返回要求的纯 JSON 数组。',
                  },
                },
              },
            }
          : {}),
      }, {
        charge: () => this.titleOrganizeTimestamps.push(this.nowMs()),
        refund: () => { this.titleOrganizeTimestamps.pop(); },
      });
      if (!created?.sessionId) throw new Error('内置模型 Hydrogen (medium) 初始化临时整理会话失败');
      tempSessionId = created.sessionId;

      let latestConfigOptions: AcpConfigOption[] | undefined = created.configOptions;
      const cfgModel = modelConfig(latestConfigOptions);
      const hydrogenName = /^(?:gemini(?:[-\s]+\d+(?:\.\d+)*)?[-\s]+)?hydrogen(?:\s*\(medium\))?$/i;
      const modelValues = selectValues(cfgModel?.options);
      const hydrogenOpt =
        modelValues.find(opt => /^gemini-4-hydrogen$/i.test(opt.value))
        || modelValues.find(opt => hydrogenName.test(opt.value) || hydrogenName.test(opt.name));
      const legacyHydrogen =
        created.models?.availableModels?.find(m => /^gemini-4-hydrogen$/i.test(m.modelId))
        || created.models?.availableModels?.find(m => hydrogenName.test(m.modelId) || hydrogenName.test(m.name));

      if (!hydrogenOpt && !legacyHydrogen) {
        throw new Error('当前官方 ACP 模型列表中未找到 Hydrogen，已保留原标题');
      }
      const config = (id: string) => latestConfigOptions?.find(opt => opt.id === id);
      const setOption = async (id: string, value: string) => {
        if (config(id)?.currentValue === value) return;
        const reply = await this.app.client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
          sessionId: tempSessionId, configId: id, value,
        });
        latestConfigOptions = reply?.configOptions;
        if (config(id)?.currentValue !== value) {
          throw new Error(`官方未确认 ${id} = ${value}，已保留原标题`);
        }
      };
      if (hydrogenOpt && cfgModel) {
        await setOption(cfgModel.id, hydrogenOpt.value);
      } else if (legacyHydrogen && created.models?.currentModelId !== legacyHydrogen.modelId) {
        await this.app.client.request('session/set_model', { sessionId: tempSessionId, modelId: legacyHydrogen.modelId });
      }
      const mode = config('mode');
      if (selectValues(mode?.options).some(opt => opt.value === 'plan')) await setOption('mode', 'plan');
      const effort = config('thought_level');
      const medium = selectValues(effort?.options).find(opt => opt.value.toLowerCase() === 'medium')?.value;
      if (medium) await setOption('thought_level', medium);
      const selectedName = hydrogenOpt?.name || legacyHydrogen?.name || '';
      const confirmedEffort = config('thought_level');
      const isMedium = confirmedEffort ? confirmedEffort.currentValue?.toLowerCase() === 'medium' :
        /\(medium\)\s*$/i.test(selectedName);
      if (!isMedium ||
          (hydrogenOpt && modelConfig(latestConfigOptions)?.currentValue !== hydrogenOpt.value) ||
          (!hydrogenOpt && legacyHydrogen && modelConfig(latestConfigOptions)?.currentValue &&
            modelConfig(latestConfigOptions)?.currentValue !== legacyHydrogen.modelId) ||
          (selectValues(mode?.options).some(opt => opt.value === 'plan') && config('mode')?.currentValue !== 'plan')) {
        throw new Error('官方未确认 Hydrogen (medium) 的整理配置，已保留原标题');
      }

      checkProfile();
      const items = targets.map(item => {
        const msgs = this.messages().firstTurns(item.sessionId);
        const user = msgs.find(m => m.role === 'user');
        const firstUser = redactSecretsForReviewer(summarizeMessageIntentForContext(user?.content, user?.annotations, 200));
        const firstAssistant = msgs.find(m => m.role === 'assistant')?.content?.replace(/\s+/g, ' ').trim().slice(0, 140) || '';
        const folder = item.cwd.split(/[\\/]/).filter(Boolean).pop() || '';
        return {
          sessionId: item.sessionId,
          currentTitle: redactSecretsForReviewer(item.title),
          folder: redactSecretsForReviewer(folder),
          firstUser,
          firstAssistant: redactSecretsForReviewer(firstAssistant),
        };
      });

      const promptText = [
        '[Gravity Title Organizer]',
        '请根据以下会话信息为每条会话整理一个简洁、准确的中文标题，格式统一为「分类｜核心主题」。',
        '要求：',
        '1. 分类（categoryTag）为 2–10 字的高信息量标签（例如 Frontend、Backend、QA、Docs、Swarm、或项目简称），保留必要英文技术词。',
        '2. 核心主题为 4–20 字，直击核心意图，去掉“请帮我/帮我/一下”等口语废词。',
        '3. 严禁调用任何工具、命令或修改文件，只输出严格 JSON 数组，不要输出多余解释：',
        '[{"sessionId":"...","categoryTag":"分类","organizedTitle":"分类｜核心主题"}]',
        '',
        JSON.stringify(items),
      ].join('\n');

      this.app.client.on('session/update', onUpdate);
      const reply = await this.app.client.request<{ stopReason?: string }>('session/prompt', {
        sessionId: tempSessionId,
        prompt: [{ type: 'text', text: promptText }],
      }, 90_000);

      if (reply?.stopReason && reply.stopReason !== 'end_turn') {
        throw new Error('官方标题整理未完整结束，已保留原标题');
      }
      checkProfile();
      const map = this.parseOrganizedTitleResponse(outputText, targets);
      if (map.size === 0) {
        throw new Error('内置模型 Hydrogen (medium) 返回的标题格式无法解析，请稍后重试');
      }
      const name = (hydrogenName.test(selectedName) ? selectedName : 'Hydrogen').replace(/\s*\(medium\)\s*$/i, '');
      const modelLabel = `${name} (medium)`;
      return { map, modelUsed: modelLabel };
    } finally {
      this.app.client.off('session/update', onUpdate);
      this.app.sessions.slots.releaseUnused(slot);
      if (tempSessionId) await this.app.sessions.slots.close(slot);
    }
  }
  async organizeTitles(request?: TitleOrganizeRequest): Promise<TitleOrganizeResult> {
    this.app.accounts.assertReady();
    if (this.organizingTitles) {
      throw new Error(`正在使用内置模型 ${TITLE_ORGANIZE_MODEL_LABEL} 整理标题，请等待当前整理完成`);
    }
    const now = this.nowMs();
    const recent = this.pruneOrganizeTimestamps(now);
    if (recent.length >= TITLE_ORGANIZE_RATE_LIMIT.maxCalls) {
      const waitSec = Math.max(1, Math.ceil((recent[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs - now) / 1000));
      throw new Error(`标题整理触发冷却限制：1 分钟内最多整理 ${TITLE_ORGANIZE_RATE_LIMIT.maxCalls} 次，请 ${waitSec} 秒后再试`);
    }
    const allSessions = [...this.app.sessions.sessions.values()].map(s => this.enrichSession(s));
    const selected = this.app.titles.selectTargets(allSessions, request);
    if (selected.targets.length === 0) {
      return {
        updatedCount: 0,
        hiddenPollutionCount: selected.hiddenPollutionCount,
        skippedOrganizedCount: selected.skippedOrganizedCount,
        remainingQuotaInWindow: Math.max(0, TITLE_ORGANIZE_RATE_LIMIT.maxCalls - recent.length),
        cooldownResetAt: recent[0] ? new Date(recent[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs).toISOString() : undefined,
        suggestions: [],
      };
    }

    this.organizingTitles = true;
    try {
      const batch = selected.targets.slice(0, TITLE_ORGANIZE_RATE_LIMIT.batchSize);
      const aiOutcome = await this.runHydrogenTitleOrganizer(batch);
      const stillCurrent = (previous: ManagedSessionSummary) => {
        const live = this.app.sessions.sessions.get(previous.sessionId);
        if (!live) return false;
        const current = this.enrichSession(live);
        return current.profileId === previous.profileId && current.title === previous.title &&
          current.titleOrganizedAt === previous.titleOrganizedAt && !current.archivedAt &&
          !current.parentBranchId && !current.isLegacyApprovalPollution;
      };
      const currentBatch = batch.filter(stillCurrent);
      const result = this.app.titles.applyOrganizedTitles(currentBatch, aiOutcome.map, {
        modelUsed: aiOutcome.modelUsed,
        hiddenPollutionCount: selected.hiddenPollutionCount,
        skippedOrganizedCount: selected.skippedOrganizedCount,
        nowIso: new Date(this.nowMs()).toISOString(),
      });
      result.skippedChangedCount = batch.length - currentBatch.length;
      for (const session of currentBatch) {
        if (!aiOutcome.map.has(session.sessionId)) continue;
        const root = this.app.sessions.get(session.sessionId);
        this.publishTreeTitle(this.app.titles.apply(root));
      }
      const pending = [...selected.targets.slice(batch.length).filter(stillCurrent),
        ...currentBatch.filter(s => !aiOutcome.map.has(s.sessionId))];
      if (pending.length) result.nextBatch = { ...request, scope: selected.scope, sessionIds: pending.map(s => s.sessionId) };
      const latestWindow = this.pruneOrganizeTimestamps(this.nowMs());
      result.remainingQuotaInWindow = Math.max(0, TITLE_ORGANIZE_RATE_LIMIT.maxCalls - latestWindow.length);
      result.cooldownResetAt = latestWindow[0]
        ? new Date(latestWindow[0] + TITLE_ORGANIZE_RATE_LIMIT.windowMs).toISOString()
        : undefined;
      return result;
    } finally {
      this.organizingTitles = false;
    }
  }
}

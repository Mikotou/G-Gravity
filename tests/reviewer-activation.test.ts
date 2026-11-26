// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import type { Reviewer } from '../src/main/approval/external-reviewer';
import { createFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { ExternalAiReviewerConfig } from '../src/shared/approval-contract';

const draft: ExternalAiReviewerConfig = {
  provider: 'local-ollama', endpoint: 'http://127.0.0.1:11434', model: 'sample',
  timeoutMs: 8000, maxOutputTokens: 1024, thinkingLevel: 'auto', enabled: false,
};
const review = { recommended: 'ask' as const, riskLevel: 'low' as const, reason: 'Synthetic local review', latencyMs: 1 };
let directory: string;
let core: CoreService | undefined;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'gravity-reviewer-activation-')); });
afterEach(async () => {
  await core?.dispose();
  core = undefined;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function open() {
  const answers: Array<{ succeed: () => void; fail: () => void }> = [];
  const reviewer: Reviewer = () => new Promise((resolve, reject) => {
    answers.push({ succeed: () => resolve(review), fail: () => reject(new Error('Fixture test failed')) });
  });
  core = new CoreService({dataDir: directory, homeDir: path.join(directory, 'fixture-home'), enableAutoUpdateCheck: false, reviewer});
  return { service: core, answers };
}

describe('外部复核验证、保存与启用', () => {
  it('网页预览接受草稿，无法将演示或调用方提供的连通标记当成真实测试', async () => {
    const bridge = createFallbackDesktopBridge();
    const copiedStatus = { ...draft, enabled:true, verificationMethod:'review-call' as const, connectionStatus:'connected' as const,
      lastVerifiedAt:'2026-01-01T00:00:00Z' };
    expect((await bridge.testExternalReviewerConnection(copiedStatus)).ok).toBe(false);
    await expect(bridge.updateApprovalConfig({externalReviewer:copiedStatus})).rejects.toThrow('桌面端');
    expect((await bridge.updateApprovalConfig({externalReviewer:{...copiedStatus, enabled:false}})).externalReviewer)
      .toMatchObject({enabled:false, connectionStatus:'untested', verificationMethod:undefined});
  });

  it('升级保留原设置字段，明确要求启用旧配置返回错误，仍可以关闭状态保存草稿', async () => {
    const legacy = { ...draft, enabled: true, connectionStatus: 'connected' as const, lastVerifiedAt: '2026-01-01T00:00:00Z' };
    new ClientStore(directory).write('approval-config.json', {mode:'hybrid', externalReviewer:legacy});
    const { service } = open();
    const before = service.approval.getConfig();
    expect(before).toMatchObject({mode:'rules-only', externalReviewer:{enabled:false, model:draft.model, connectionStatus:'untested'}});
    await expect(service.updateApprovalConfig({externalReviewer:{...legacy, verificationMethod:'review-call'}})).rejects.toThrow('复核测试');
    expect(service.approval.getConfig()).toEqual(before);
    const saved = await service.updateApprovalConfig({externalReviewer:{...legacy, enabled:false, model:'saved-draft'}});
    expect(saved.externalReviewer).toMatchObject({enabled:false, model:'saved-draft', connectionStatus:'untested'});
    expect(saved.externalReviewer.verificationMethod).toBeUndefined();
  });

  it('同一模型测试期间可以保存草稿和缓存时间，成功后明确启用，保留调用方未更改的审批模式', async () => {
    const { service, answers } = open();
    const result = service.testExternalReviewerConnection(draft);
    for (const cacheTtlHours of [33, 34]) {
      const saved = await service.updateApprovalConfig({externalReviewer:draft, cacheTtlHours});
      expect(saved.externalReviewer.enabled).toBe(false);
    }
    await service.updateApprovalConfig({askPatterns:['^sample$']});
    expect(answers).toHaveLength(1);
    answers[0].succeed();
    expect((await result).ok).toBe(true);
    expect(service.approval.getConfig().externalReviewer.enabled).toBe(false);
    expect(await service.updateApprovalConfig({externalReviewer:{...draft, enabled:true}})).toMatchObject({
      mode:'manual', cacheTtlHours:34, externalReviewer:{enabled:true, verificationMethod:'review-call'},
    });
  });

  it.each([
    ['模型', {model:'other'}], ['服务类型', {provider:'openai-compatible' as const}],
    ['服务地址', {endpoint:'http://127.0.0.1:11435'}], ['密钥', {apiKey:'synthetic-new-key'}],
    ['超时', {timeoutMs:1000}], ['输出上限', {maxOutputTokens:2048}], ['思考强度', {thinkingLevel:'low' as const}],
  ] as const)('保存不同%s使先前测试失效', async (_label, patch) => {
    const { service, answers } = open();
    const result = service.testExternalReviewerConnection(draft);
    await service.updateApprovalConfig({externalReviewer:{...draft,...patch}});
    answers[0].succeed();
    expect(await result).toMatchObject({ok:false});
    await expect(service.updateApprovalConfig({externalReviewer:{...draft, enabled:true}})).rejects.toThrow('复核测试');
  });

  it.each(['succeed', 'fail'] as const)('主动关闭后，旧测试的 %s 回复不会重新启用或撤销原验证', async action => {
    const { service, answers } = open();
    const first = service.testExternalReviewerConnection(draft);
    answers[0].succeed();
    await first;
    await service.updateApprovalConfig({mode:'hybrid', externalReviewer:{...draft, enabled:true}});
    const second = service.testExternalReviewerConnection(draft);
    const off = await service.updateApprovalConfig({externalReviewer:draft});
    expect(off).toMatchObject({mode:'rules-only', externalReviewer:{enabled:false, verificationMethod:'review-call'}});
    answers[1][action]();
    expect((await second).ok).toBe(false);
    expect(service.approval.getConfig()).toEqual(off);
  });

  it('新的同配置测试替代先前测试；未保存成功的配置变更不会取消仍有效的测试', async () => {
    const { service, answers } = open();
    const first = service.testExternalReviewerConnection(draft);
    const second = service.testExternalReviewerConnection(draft);
    answers[0].succeed();
    expect((await first).ok).toBe(false);
    await expect(service.updateApprovalConfig({externalReviewer:{...draft, enabled:true}})).rejects.toThrow('复核测试');
    vi.spyOn(service.store, 'write').mockImplementationOnce(() => { throw new Error('fixture disk unavailable'); });
    await expect(service.updateApprovalConfig({externalReviewer:{...draft, model:'other'}})).rejects.toThrow('fixture disk unavailable');
    answers[1].succeed();
    expect((await second).ok).toBe(true);
    expect((await service.updateApprovalConfig({externalReviewer:{...draft, enabled:true}})).externalReviewer.enabled).toBe(true);
  });
});

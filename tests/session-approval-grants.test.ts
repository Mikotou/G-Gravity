// @vitest-environment node
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEngine, type ApprovalEngineOptions } from '../src/main/approval/approval-engine';
import type { Reviewer } from '../src/main/approval/external-reviewer';
import { ClientStore } from '../src/main/storage/client-store';
import type { AcpRequestPermissionParams, ApprovalDecisionSubmission } from '../src/shared';

const cwd = 'F:\\项目';
let directory: string;
let profile: string;
const engines: ApprovalEngine[] = [];
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'gravity-session-grants-'));
  profile = 'default';
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
  rmSync(directory, {recursive: true, force: true});
});

function open(options: Partial<ApprovalEngineOptions> = {}) {
  const store = new ClientStore(directory);
  const engine = new ApprovalEngine({store, getProfileId: () => profile, ...options});
  engines.push(engine);
  return {engine, store};
}

function ask(engine: ApprovalEngine, command = 'npm test', sessionId = 'a', workspace = cwd) {
  const params: AcpRequestPermissionParams = {
    sessionId, toolCall: {toolCallId: 'fixture', title: 'run_command', kind: 'execute', rawInput: {command}},
    options: [{optionId: 'once', kind: 'allow_once', name: '允许一次'}, {optionId: 'no', kind: 'reject_once', name: '拒绝'}],
  };
  return engine.requestPermission(params, workspace);
}

async function submit(engine: ApprovalEngine, decision: ApprovalDecisionSubmission['decision'], sessionId = 'a', command = 'npm test', workspace = cwd) {
  const result = ask(engine, command, sessionId, workspace);
  const card = engine.listAwaitingUser().find(item => item.sessionId === sessionId);
  expect(card).toBeDefined();
  const done = await engine.submitDecision({sessionId, decision, requestId: card!.requestId, allowedPrefix: card!.commandPrefix});
  expect((await result).outcome).toEqual({outcome: 'selected', optionId: 'once'});
  return done;
}

async function expectManual(engine: ApprovalEngine, command: string, sessionId = 'a', workspace = cwd) {
  const result = ask(engine, command, sessionId, workspace);
  expect(engine.listAwaitingUser().some(item => item.sessionId === sessionId)).toBe(true);
  engine.cancelPending(sessionId);
  expect((await result).outcome.outcome).toBe('cancelled');
}

async function expectAllowed(engine: ApprovalEngine, command: string, sessionId = 'a', workspace = cwd) {
  const result = ask(engine, command, sessionId, workspace);
  expect(engine.listPending()).toHaveLength(0);
  expect((await result).outcome).toEqual({outcome: 'selected', optionId: 'once'});
}

describe('保存到原会话的显式审批', () => {
  it('重启后恢复前缀和委托，按账号、工作区和独立会话隔离，撤销 A 后 B 的授权保留', async () => {
    const first = open().engine;
    await submit(first, 'allow_session_prefix');
    await submit(first, 'approve_for_me_ai', 'a', 'pwd');
    await submit(first, 'allow_session_prefix', 'b');
    first.cancelSession('a');
    await expectAllowed(first, 'npm test --verbose');
    first.dispose();

    const second = open().engine;
    expect(second.sessionApprovalOverride('a', 'f:/项目/')).toBe('rules-only');
    await expectAllowed(second, 'npm test --verbose', 'a', 'f:/项目/');
    expect(second.listAudit()[0].decisionSource).toBe('session-prefix');
    await expectAllowed(second, 'pwd');
    await expectManual(second, 'pwd', 'b');
    await expectManual(second, 'npm test', 'a-independent-branch');
    await expectManual(second, 'npm test', 'a', 'F:\\另一个项目');
    profile = 'other-account';
    await expectManual(second, 'npm test');
    expect(second.hasSessionGrants('a', cwd)).toBe(false);
    await submit(second, 'allow_session_prefix', 'a', 'npm test');
    profile = 'default';
    second.clearSessionGrants('a', cwd);
    const third = open().engine;
    await expectManual(third, 'npm test');
    await expectManual(third, 'pwd');
    await expectAllowed(third, 'npm test', 'b');
    profile = 'other-account';
    await expectAllowed(third, 'npm test');
  });

  it('全局模式和普通设置不会清除授权，新加的 Ask 和 Deny 即时优先', async () => {
    const {engine} = open();
    await submit(engine, 'allow_session_prefix');
    await submit(engine, 'approve_for_me_ai', 'a', 'pwd');
    engine.updateConfig({mode: 'rules-only', cacheTtlHours: 3});
    engine.updateConfig({mode: 'manual'});
    expect(engine.sessionApprovalOverride('a', cwd)).toBe('rules-only');
    await expectAllowed(engine, 'npm test');
    engine.updateConfig({askPatterns: ['^npm test']});
    const blocked = ask(engine);
    expect(engine.listAwaitingUser()[0]?.commandPrefix).toBeUndefined();
    expect(engine.listPending()).toHaveLength(1);
    engine.cancelPending('a');
    await blocked;
    engine.updateConfig({askPatterns: [], denyPatterns: ['^npm test']});
    expect((await ask(engine)).outcome).toEqual({outcome: 'selected', optionId: 'no'});
    engine.updateConfig({denyPatterns: []});
    await expectAllowed(engine, 'npm test');
  });

  it('一次同意、规则或短期缓存都不会变成重启后的前缀，选项 3 只保存委托', async () => {
    const {engine} = open({config: {fastPassLowRiskDev: false}});
    await submit(engine, 'allow_once');
    await submit(engine, 'approve_for_me_ai', 'a', 'cargo test');
    await expectAllowed(engine, 'pwd');
    await expectAllowed(engine, 'pwd');
    const recovered = open({config: {fastPassLowRiskDev: false}}).engine;
    await expectManual(recovered, 'npm test');
    await expectManual(recovered, 'cargo test');
    await expectAllowed(recovered, 'pwd');
    expect(recovered.listAudit()[0].decisionSource).toBe('local-rule');
  });

  it.each(['clear-current', 'clear-other', 'switch-profile'] as const)('复核期间发生 %s，迟到决定遵守当前会话的授权', async change => {
    let finishReview!: (value: Awaited<ReturnType<Reviewer>>) => void;
    const reviewer: Reviewer = () => new Promise(resolve => {finishReview = resolve;});
    const {engine} = open({reviewer, config: {mode:'manual', externalReviewer:{
      provider:'local-ollama', endpoint:'http://127.0.0.1:11434', model:'fixture', enabled:true, timeoutMs:10_000,
      verificationMethod:'review-call', connectionStatus:'connected', lastVerifiedAt:'2026-01-01T00:00:00Z',
    }}});
    await submit(engine, 'allow_session_prefix');
    await submit(engine, 'allow_session_prefix', 'b');
    const result = ask(engine, 'cargo test');
    const card = engine.listAwaitingUser()[0];
    const submission = engine.submitDecision({sessionId:'a', requestId:card.requestId, decision:'approve_for_me_ai'});
    if (change === 'switch-profile') profile = 'other-account';
    else engine.clearSessionGrants(change === 'clear-current' ? 'a' : 'b', 'f:/项目/');
    finishReview({recommended:'approve', riskLevel:'low', reason:'normal fixture', latencyMs:1});
    expect((await submission).outcome).toBe(change === 'clear-current' ? 'pending' : change === 'clear-other' ? 'approved' : 'cancelled');
    if (change === 'clear-current') {
      expect(engine.listAwaitingUser()).toHaveLength(1);
      engine.cancelPending('a');
    }
    expect((await result).outcome.outcome).toBe(change === 'clear-other' ? 'selected' : 'cancelled');
    if (change === 'switch-profile') expect(engine.hasSessionGrants('a', cwd)).toBe(false);
    profile = 'default';
    const recovered = open().engine;
    expect(recovered.isSessionDelegated('a', cwd)).toBe(change === 'clear-other');
    expect(recovered.hasSessionGrants('a', cwd)).toBe(change !== 'clear-current');
    expect(recovered.hasSessionGrants('b', cwd)).toBe(change !== 'clear-other');
  });

  it.each(['grant-file', 'audit-file', 'torn-audit'] as const)('写入 %s 失败取消本次请求，重启只保留先前成功的授权', async failure => {
    const {engine, store} = open();
    await submit(engine, 'allow_session_prefix', 'b');
    const promise = ask(engine);
    const card = engine.listAwaitingUser()[0];
    if (failure === 'grant-file') {
      vi.spyOn(store, 'write').mockImplementationOnce(() => { throw new Error('grant file unavailable'); });
    } else {
      // Also interrupt the rollback write. The newly staged snapshot is the one a fresh process will actually read.
      const write = store.write.bind(store);
      vi.spyOn(store, 'write').mockImplementationOnce(write).mockImplementationOnce(() => {throw new Error('interrupted');});
      vi.spyOn(store, 'append').mockImplementationOnce((name, entry) => {
        if (failure === 'torn-audit') appendFileSync(path.join(directory, name), JSON.stringify(entry));
        throw new Error('audit unavailable');
      });
    }
    await expect(engine.submitDecision({sessionId:'a', requestId:card.requestId, decision:'allow_session_prefix', allowedPrefix:card.commandPrefix})).rejects.toThrow('审计');
    expect((await promise).outcome.outcome).toBe('cancelled');
    const recovered = open();
    await expectManual(recovered.engine, 'npm test');
    await expectAllowed(recovered.engine, 'npm test', 'b');
    expect(recovered.engine.listAudit()[0].sessionId).toBe('b');
    expect(recovered.engine.listAudit().filter(entry => entry.sessionId === 'a')).toHaveLength(0);
    await expectManual(open().engine, 'npm test');
  });

  it('撤销写入失败不会假报成功，可重试；撤销后主文件损坏也不会从旧备份恢复', async () => {
    const {engine, store} = open();
    await submit(engine, 'allow_session_prefix');
    const file = readdirSync(directory).find(name => /^approval-grants-.*\.json$/.test(name))!;
    expect(readdirSync(directory)).not.toContain(file + '.bak');
    copyFileSync(path.join(directory, file), path.join(directory, file + '.bak'));
    vi.spyOn(store, 'write').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => engine.clearSessionGrants('a', cwd)).toThrow('disk full');
    await expectAllowed(open().engine, 'npm test');
    engine.clearSessionGrants('a', cwd);
    await expectManual(open().engine, 'npm test');
    writeFileSync(path.join(directory, file), '{');
    await expectManual(open().engine, 'npm test');
  });
});

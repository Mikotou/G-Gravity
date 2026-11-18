import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import { screenCommand } from '../src/main/approval/shell-screening';
import { ClientStore } from '../src/main/storage/client-store';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import type { AcpRequestPermissionParams, PendingApprovalRequest } from '../src/shared';

const tempDirs: string[] = [];
const activeEngines: ApprovalEngine[] = [];

afterEach(() => {
  cleanup();
  for (const eng of activeEngines.splice(0)) eng.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createTestEngine(config = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v08-approval-'));
  tempDirs.push(dir);
  const store = new ClientStore(dir);
  const engine = new ApprovalEngine({ store, config });
  activeEngines.push(engine);
  return { engine, store, dir };
}

function makeAcpPermissionParams(
  toolCall: AcpRequestPermissionParams['toolCall'],
  sessionId = 'sess-v08'
): AcpRequestPermissionParams {
  return {
    sessionId,
    toolCall,
    options: [
      { optionId: 'opt-once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'opt-always', name: '总是允许', kind: 'allow_always' },
      { optionId: 'opt-reject', name: '拒绝', kind: 'reject_once' },
    ],
  };
}

describe('v0.8 Approve for me 多段语义快筛、纯只读工具识别与选项3修复', () => {
  it('1) 修复截图1：跨目录纯只读 read/search 工具自动放行，不再误判为文件写入；敏感凭据路径仍硬拦截', async () => {
    const { engine } = createTestEngine({ mode: 'hybrid' });

    // 复现用户截图1：工作区 F:\Gravity 读取 F:\插件-Gemini\assets\icons\gravity-claude-dark.png
    const readIconReq = makeAcpPermissionParams({
      toolCallId: 'tc-read-icon',
      kind: 'read',
      title: 'read',
      rawInput: { Path: 'F:\\插件-Gemini\\assets\\icons\\gravity-claude-dark.png' },
      locations: [{ path: 'F:\\插件-Gemini\\assets\\icons\\gravity-claude-dark.png' }],
    });

    const outcome = await engine.requestPermission(readIconReq, 'F:\\Gravity');
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(engine.listPending()).toHaveLength(0);
    expect(engine.listAudit()[0]).toMatchObject({
      verdict: 'auto_approved',
      decisionSource: 'local-rule',
      riskLevel: 'safe',
    });

    // 验证即使在 manual 模式下生成卡片，用意说明也是「只读读取」而非「终端执行/文件写入」
    const { engine: manualEngine } = createTestEngine({ mode: 'manual' });
    const reqPromise = once(manualEngine, 'requested');
    const pendingRes = manualEngine.requestPermission(readIconReq, 'F:\\Gravity');
    const [card] = (await reqPromise) as [PendingApprovalRequest];
    expect(card.explanation.meaning).toContain('只读读取本地文件或目录');
    expect(card.commandPrefix).toBe('read');
    manualEngine.cancelSession('sess-v08');
    await pendingRes;

    // 敏感状态或凭据文件即使走 kind='read' 也必须 100% 拒绝（守住合规红线 #1）
    const credentialRead = makeAcpPermissionParams({
      toolCallId: 'tc-read-cred',
      kind: 'read',
      title: 'read',
      rawInput: { Path: 'C:\\Users\\Admin\\.ssh\\id_rsa' },
    });
    const deniedOutcome = await engine.requestPermission(credentialRead, 'F:\\Gravity');
    expect(deniedOutcome).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-reject' } });
    expect(engine.listAudit()[0].verdict).toBe('denied');
  });

  it('2) 修复截图2：含引号正则与多级管道的 PowerShell 只读检索自动放行，危险管道与重定向严格拦截', async () => {
    const { engine } = createTestEngine({ mode: 'hybrid' });

    // 复现用户截图2原命令
    const pwshPipeline =
      'Get-ChildItem -Path "F:\\插件-Gemini\\src","F:\\插件-Gemini\\tests" -Recurse -Include *.ts,*.tsx | Select-String -Pattern "GRAVITY_ICON|appIcon|publicSvgUrl|assetIcoRelPath" | Select-Object Path, LineNumber, Line';

    const screenRes = screenCommand(pwshPipeline, 'F:\\Gravity', engine.getConfig(), 'execute', {
      CommandLine: pwshPipeline,
      toolSummary: 'Check all icon references in src and tests',
    });
    expect(screenRes.verdict).toBe('auto_approve');
    expect(screenRes.commandPrefix).toBe('get-childitem');
    expect(screenRes.extractedSegments).toHaveLength(3);

    const execReq = makeAcpPermissionParams({
      toolCallId: 'tc-pwsh-pipe',
      kind: 'execute',
      title: 'execute',
      rawInput: {
        CommandLine: pwshPipeline,
        toolSummary: 'Check all icon references in src and tests',
      },
    });
    const res = await engine.requestPermission(execReq, 'F:\\Gravity');
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(engine.listPending()).toHaveLength(0);

    // 验证危险变体绝不误放行：管道接 Invoke-Expression、重定向写文件、串联 Remove-Item -Recurse
    for (const dangerousCmd of [
      'Get-ChildItem -Path "F:\\插件-Gemini\\src" | Invoke-Expression',
      'Get-ChildItem -Path "F:\\插件-Gemini\\src" > dump.txt',
      'Get-Location; Remove-Item -Recurse -Force build',
    ]) {
      const check = screenCommand(dangerousCmd, 'F:\\Gravity', engine.getConfig(), 'execute');
      expect(check.verdict).toBe('force_ask');
      expect(check.riskLevel).toBe('high');
    }
  });

  it('3) 修复选项3（3. Approve for me）点击无效问题：即使未配置外部模型也能立即放行并开启本会话批量托管', async () => {
    // 初始为 manual 模式且未启用 externalReviewer（真实默认开箱状态）
    const { engine } = createTestEngine({ mode: 'manual' });
    let configChangedToHybrid = false;
    engine.on('config-updated', (cfg) => {
      if (cfg.mode === 'hybrid') configChangedToHybrid = true;
    });

    // 第一条转交人工的命令（例如未知脚本构建或高风险操作）
    const firstReq = makeAcpPermissionParams({
      toolCallId: 'tc-first',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'node scripts/generate-icons.mjs' },
    });
    const reqEvent = once(engine, 'requested');
    const firstPromise = engine.requestPermission(firstReq, 'F:\\插件-Gemini');
    const [firstCard] = (await reqEvent) as [PendingApprovalRequest];

    // 用户点击选项 3: Approve for me
    await engine.submitDecision({
      requestId: firstCard.requestId,
      sessionId: 'sess-v08',
      decision: 'approve_for_me_ai',
    });

    // 1. 当前卡片必须立即放行并从挂起队列移除（不再死锁无响应）
    expect(await firstPromise).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(engine.listPending()).toHaveLength(0);
    expect(engine.getConfig().mode).toBe('hybrid');
    expect(configChangedToHybrid).toBe(true);
    expect(engine.isSessionDelegated('sess-v08', 'F:\\插件-Gemini')).toBe(true);

    // 2. 随后本会话内连续运行的低风险检查串联命令（含 PowerShell $LASTEXITCODE 判断）与工作区内源码编辑均自动放行
    const chainedDevCheck = makeAcpPermissionParams({
      toolCallId: 'tc-chain-check',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'npm run typecheck; if ($LASTEXITCODE -eq 0) { npx vitest run }' },
    });
    expect(await engine.requestPermission(chainedDevCheck, 'F:\\插件-Gemini')).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-once' },
    });

    const inWorkspaceEdit = makeAcpPermissionParams({
      toolCallId: 'tc-edit-in-cwd',
      kind: 'edit',
      title: 'edit_file',
      rawInput: {
        Path: 'F:\\插件-Gemini\\src\\renderer\\App.tsx',
        Target: 'const a = 1;',
        Replacement: 'const a = 2;',
      },
    });
    expect(await engine.requestPermission(inWorkspaceEdit, 'F:\\插件-Gemini')).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-once' },
    });

    // 3. 高危破坏性命令依然严格拦截交由人工把关
    const destructiveReq = makeAcpPermissionParams({
      toolCallId: 'tc-rm',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'rm -rf dist' },
    });
    const rmEvent = once(engine, 'requested');
    const rmPromise = engine.requestPermission(destructiveReq, 'F:\\插件-Gemini');
    const [rmCard] = (await rmEvent) as [PendingApprovalRequest];
    expect(rmCard.riskLevel).toBe('high');
    engine.cancelSession('sess-v08');
    await rmPromise;
  });

  it('4) 密集命令批量守卫预测与 UI 选项副标题渲染闭环', async () => {
    const { engine } = createTestEngine({ mode: 'hybrid' });
    const guardEvents: unknown[] = [];
    engine.on('guard-activity', (ev) => guardEvents.push(ev));

    // 模拟 Plan 阶段预测到多步任务，提前开启批量守卫
    engine.enableBurstGuard('sess-v08');

    const statusReq = makeAcpPermissionParams({
      toolCallId: 'tc-git-status',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'git status' },
    });
    expect(await engine.requestPermission(statusReq, 'F:\\插件-Gemini')).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-once' },
    });
    expect(guardEvents.length).toBeGreaterThanOrEqual(1);

    // 验证 InlineRequestView 展示选项 3 的清晰辅助说明并支持按键 3 触发
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const sampleCard: PendingApprovalRequest = {
      requestId: 'req-ui-3',
      sessionId: 'sess-v08',
      toolCallId: 'tc-ui-3',
      toolName: 'run_command',
      commandOrSummary: 'python scripts/migrate.py',
      cwd: 'F:\\插件-Gemini',
      createdAt: new Date().toISOString(),
      riskLevel: 'high',
      screeningSource: 'local-ast',
      explanation: {
        meaning: '运行本地脚本文件',
        target: '工作目录：F:\\插件-Gemini',
        risk: '涉及脚本解释器执行，转交人工确认',
      },
    };
    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <InlineRequestView request={sampleCard} enableNumericShortcuts onSubmitDecision={onSubmit} />
      </I18nProvider>
    );
    expect(screen.getByTestId('btn-approve-for-me-req-ui-3').textContent).toContain('3. Approve for me');
    expect(screen.getByTestId('btn-approve-for-me-req-ui-3').textContent).toContain('智能批量代审');
    fireEvent.keyDown(window, { key: '3' });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        requestId: 'req-ui-3',
        sessionId: 'sess-v08',
        decision: 'approve_for_me_ai',
      })
    );
  });
});

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
import { ApprovalsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { AcpRequestPermissionParams, ApproveForMeConfig, PendingApprovalRequest } from '../src/shared';

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

    // 跨工作区只读：工作区 C:\Workspace\DemoApp 读取 C:\Workspace\DemoProject\assets\icons\gravity-claude-dark.png
    const readIconReq = makeAcpPermissionParams({
      toolCallId: 'tc-read-icon',
      kind: 'read',
      title: 'read',
      rawInput: { Path: 'C:\\Workspace\\DemoProject\\assets\\icons\\gravity-claude-dark.png' },
      locations: [{ path: 'C:\\Workspace\\DemoProject\\assets\\icons\\gravity-claude-dark.png' }],
    });

    const outcome = await engine.requestPermission(readIconReq, 'C:\\Workspace\\DemoApp');
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
    const pendingRes = manualEngine.requestPermission(readIconReq, 'C:\\Workspace\\DemoApp');
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
      rawInput: { Path: 'C:\\Users\\dev\\.ssh\\id_rsa' },
    });
    const deniedOutcome = await engine.requestPermission(credentialRead, 'C:\\Workspace\\DemoApp');
    expect(deniedOutcome).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-reject' } });
    expect(engine.listAudit()[0].verdict).toBe('denied');
  });

  it('2) 修复截图2：含引号正则与多级管道的 PowerShell 只读检索自动放行，危险管道与重定向严格拦截', async () => {
    const { engine } = createTestEngine({ mode: 'hybrid' });

    // 多级管道 PowerShell 只读检索命令
    const pwshPipeline =
      'Get-ChildItem -Path "C:\\Workspace\\DemoProject\\src","C:\\Workspace\\DemoProject\\tests" -Recurse -Include *.ts,*.tsx | Select-String -Pattern "GRAVITY_ICON|appIcon|publicSvgUrl|assetIcoRelPath" | Select-Object Path, LineNumber, Line';

    const screenRes = screenCommand(pwshPipeline, 'C:\\Workspace\\DemoApp', engine.getConfig(), 'execute', {
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
    const res = await engine.requestPermission(execReq, 'C:\\Workspace\\DemoApp');
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(engine.listPending()).toHaveLength(0);

    // 验证危险变体绝不误放行：管道接 Invoke-Expression、重定向写文件、串联 Remove-Item -Recurse
    for (const dangerousCmd of [
      'Get-ChildItem -Path "C:\\Workspace\\DemoProject\\src" | Invoke-Expression',
      'Get-ChildItem -Path "C:\\Workspace\\DemoProject\\src" > dump.txt',
      'Get-Location; Remove-Item -Recurse -Force build',
    ]) {
      const check = screenCommand(dangerousCmd, 'C:\\Workspace\\DemoApp', engine.getConfig(), 'execute');
      expect(check.verdict).toBe('force_ask');
      expect(check.riskLevel).toBe('high');
    }
  });

  it('3) 选项3（3. Approve for me）：未连接外部复核时放行当前操作并切至基础仅规则模式（绝不伪开 AI 代审）；连接外部复核后开启 AI 代审托管', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'gravity-v08-ws-'));
    tempDirs.push(workspace);
    // A) 未配置外部模型（真实开箱状态）：点击选项 3 放行本次并切换至基础 rules-only，不伪开 hybrid
    const { engine } = createTestEngine({ mode: 'manual' });
    let lastUpdatedMode: string | null = null;
    engine.on('config-updated', (cfg) => {
      lastUpdatedMode = cfg.mode;
    });

    const firstReq = makeAcpPermissionParams({
      toolCallId: 'tc-first',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'node scripts/generate-icons.mjs' },
    });
    const reqEvent = once(engine, 'requested');
    const firstPromise = engine.requestPermission(firstReq, workspace);
    const [firstCard] = (await reqEvent) as [PendingApprovalRequest];

    await engine.submitDecision({
      requestId: firstCard.requestId,
      sessionId: 'sess-v08',
      decision: 'approve_for_me_ai',
    });

    // 当前卡片必须立即放行，且模式落到基础 rules-only（未连接外部复核不可开启 hybrid AI 代审）
    expect(await firstPromise).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(engine.listPending()).toHaveLength(0);
    expect(engine.getConfig().mode).toBe('manual');
    expect(engine.sessionApprovalOverride('sess-v08', workspace)).toBe('rules-only');
    expect(lastUpdatedMode).toBeNull();

    // 基础规则下：纯只读命令自动放行，灰区开发命令与高危命令均继续由人工把关
    const readOnlyCheck = makeAcpPermissionParams({
      toolCallId: 'tc-pwd',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'pwd' },
    });
    expect(await engine.requestPermission(readOnlyCheck, workspace)).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-once' },
    });

    const destructiveReq = makeAcpPermissionParams({
      toolCallId: 'tc-rm',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'rm -rf dist' },
    });
    const rmEvent = once(engine, 'requested');
    const rmPromise = engine.requestPermission(destructiveReq, workspace);
    const [rmCard] = (await rmEvent) as [PendingApprovalRequest];
    expect(rmCard.riskLevel).toBe('high');
    engine.cancelSession('sess-v08');
    await rmPromise;

    // B) 正常连接外部复核后，点击选项 3 切换至 hybrid AI 代审，灰区命令与工作区内编辑均由外部复核托管放行
    const dir2 = mkdtempSync(path.join(tmpdir(), 'gravity-v08-approval-ext-'));
    tempDirs.push(dir2);
    const reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'low',
      reason: '常规本地开发校验与工作区编辑，安全放行',
      latencyMs: 85,
    });
    const connectedEngine = new ApprovalEngine({
      store: new ClientStore(dir2),
      config: {
        mode: 'manual',
        externalReviewer: {
          enabled: true,
          connectionStatus: 'connected', verificationMethod: 'review-call', lastVerifiedAt: '2026-01-01T00:00:00Z',
          provider: 'local-ollama',
          endpoint: 'http://127.0.0.1:11434',
          model: 'qwen2.5-coder:7b',
          timeoutMs: 8000,
        },
      },
      reviewer,
    });
    activeEngines.push(connectedEngine);

    const chainedDevCheck = makeAcpPermissionParams({
      toolCallId: 'tc-chain-check',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'npm run typecheck; if ($LASTEXITCODE -eq 0) { npx vitest run }' },
    });
    const ev2 = once(connectedEngine, 'requested');
    const p2 = connectedEngine.requestPermission(chainedDevCheck, workspace);
    const [card2] = (await ev2) as [PendingApprovalRequest];
    await connectedEngine.submitDecision({
      requestId: card2.requestId,
      sessionId: 'sess-v08',
      decision: 'approve_for_me_ai',
    });
    expect(await p2).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(connectedEngine.getConfig().mode).toBe('manual');
    expect(connectedEngine.sessionApprovalOverride('sess-v08', workspace)).toBe('hybrid');
    expect(connectedEngine.isSessionDelegated('sess-v08', workspace)).toBe(true);

    const inWorkspaceEdit = makeAcpPermissionParams({
      toolCallId: 'tc-edit-in-cwd',
      kind: 'edit',
      title: 'edit_file',
      rawInput: {
        Path: path.join(workspace, 'src', 'renderer', 'App.tsx'),
        Target: 'const a = 1;',
        Replacement: 'const a = 2;',
      },
    });
    expect(await connectedEngine.requestPermission(inWorkspaceEdit, workspace)).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-once' },
    });
    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it('4) 外部复核守卫事件上报与 UI 选项副标题渲染闭环', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v08-guard-'));
    tempDirs.push(dir);
    const reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'low',
      reason: '只读状态检查安全放行',
      latencyMs: 50,
    });
    const engine = new ApprovalEngine({
      store: new ClientStore(dir),
      config: {
        mode: 'hybrid',
        externalReviewer: {
          enabled: true,
          connectionStatus: 'connected', verificationMethod: 'review-call', lastVerifiedAt: '2026-01-01T00:00:00Z',
          provider: 'local-ollama',
          endpoint: 'http://127.0.0.1:11434',
          model: 'qwen2.5-coder:7b',
          timeoutMs: 8000,
        },
      },
      reviewer,
    });
    activeEngines.push(engine);
    const guardEvents: unknown[] = [];
    engine.on('guard-activity', (ev) => guardEvents.push(ev));

    const statusReq = makeAcpPermissionParams({
      toolCallId: 'tc-git-commit',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: 'git commit -m "chore: guard check"' },
    });
    expect(await engine.requestPermission(statusReq, 'C:\\Workspace\\DemoProject')).toEqual({
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
      cwd: 'C:\\Workspace\\DemoProject',
      createdAt: new Date().toISOString(),
      riskLevel: 'high',
      screeningSource: 'local-ast',
      explanation: {
        meaning: '运行本地脚本文件',
        target: '工作目录：C:\\Workspace\\DemoProject',
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

  it('4) 外部复核设置页：填入 API Key 后查询服务端可用模型与思考强度，支持自定义模型/强度/timeout/maxOutputTokens（默认 8000 / 4096）', async () => {
    resetFallbackDesktopBridge();
    const onUpdateConfig = vi.fn().mockResolvedValue(undefined);
    const initialConfig: ApproveForMeConfig = {
      mode: 'hybrid',
      enableSafeDownloadAutoApprove: false,
      maxDownloadSizeMB: 50,
      cacheTtlHours: 24,
      allowPatterns: [],
      askPatterns: [],
      denyPatterns: [],
      externalReviewer: {
        enabled: false,
        provider: 'gemini-api-key',
        endpoint: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash-lite',
        timeoutMs: 8000,
        maxOutputTokens: 4096,
        thinkingLevel: 'auto',
      },
    };

    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <ApprovalsPanel config={initialConfig} auditEntries={[]} onUpdateConfig={onUpdateConfig} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByTestId('drawer-tab-reviewer'));
    expect((screen.getByTestId('reviewer-timeout-input') as HTMLInputElement).value).toBe('8000');
    expect((screen.getByTestId('reviewer-max-output-input') as HTMLInputElement).value).toBe('4096');

    fireEvent.change(screen.getByTestId('reviewer-apikey-input'), {
      target: { value: 'AIzaSyTestKey1234567890' },
    });
    fireEvent.click(screen.getByTestId('discover-reviewer-models-btn'));

    const modelSelect = (await screen.findByTestId('reviewer-model-select')) as HTMLSelectElement;
    expect(Array.from(modelSelect.options).map((o) => o.value)).toContain('gemini-3.5-flash-lite');

    // 选择 gemini-3.5-flash-lite 后，思考强度下拉动态列出服务端/模型支持的 minimal/low/medium/high
    fireEvent.change(modelSelect, { target: { value: 'gemini-3.5-flash-lite' } });
    const thinkingSelect = screen.getByTestId('reviewer-thinking-select') as HTMLSelectElement;
    expect(Array.from(thinkingSelect.options).map((o) => o.value)).toEqual([
      'auto',
      'minimal',
      'low',
      'medium',
      'high',
    ]);

    fireEvent.change(thinkingSelect, { target: { value: 'low' } });
    fireEvent.change(screen.getByTestId('reviewer-timeout-input'), { target: { value: '12000' } });
    fireEvent.change(screen.getByTestId('reviewer-max-output-input'), { target: { value: '2048' } });
    fireEvent.click(screen.getByTestId('save-reviewer-config-btn'));

    await waitFor(() =>
      expect(onUpdateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheTtlHours: 24,
          externalReviewer: expect.objectContaining({
            model: 'gemini-3.5-flash-lite',
            thinkingLevel: 'low',
            timeoutMs: 12000,
            maxOutputTokens: 2048,
          }),
        })
      )
    );
  });
});

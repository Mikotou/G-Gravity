import React from 'react';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEngine } from '../src/main/approval/approval-engine';
import {
  callIndependentModel,
  callIndependentModelWithUsage,
  IndependentModelCallError,
  reviewWithIndependentModel,
  type Reviewer,
} from '../src/main/approval/external-reviewer';
import { isReadOnlyScriptReviewCandidate } from '../src/main/approval/shell-screening';
import { CoreService } from '../src/main/core-service';
import { ClientStore } from '../src/main/storage/client-store';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { Composer } from '../src/renderer/components/Composer';
import { ContextCostInspectorView } from '../src/renderer/components/ContextCostInspectorView';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { RightInspector } from '../src/renderer/components/RightInspector';
import { ApprovalsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type {
  AcpRequestPermissionParams,
  ApproveForMeConfig,
  ExternalAiReviewerConfig,
  ManagedSessionSummary,
  PendingApprovalRequest,
} from '../src/shared';

const tempDirs: string[] = [];
const activeEngines: ApprovalEngine[] = [];

afterEach(() => {
  cleanup();
  for (const eng of activeEngines.splice(0)) eng.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const enabledGeminiReviewer: ExternalAiReviewerConfig = {
  enabled: true,
  provider: 'gemini-api-key',
  endpoint: 'https://generativelanguage.googleapis.com',
  model: 'gemini-4-hydrogen',
  apiKey: 'AIzaSyTestSecretKeyForOverhaul9999',
  timeoutMs: 8000,
  maxOutputTokens: 4096,
  thinkingLevel: 'low',
};

function createEngine(config: Partial<ApproveForMeConfig> = {}, reviewer?: Reviewer) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gravity-v022-overhaul-'));
  tempDirs.push(dir);
  const store = new ClientStore(dir);
  const engine = new ApprovalEngine({ store, config, reviewer });
  activeEngines.push(engine);
  return { engine, store, dir };
}

function makePerm(
  toolCall: AcpRequestPermissionParams['toolCall'],
  sessionId = 'sess-overhaul'
): AcpRequestPermissionParams {
  return {
    sessionId,
    toolCall,
    options: [
      { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
      { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
    ],
  };
}

describe('v0.2.2 Approve for me 完整逻辑修复（无外部复核 + 有外部复核全链路适配）', () => {
  it('1) 复现截图场景：只读 MCP/文档检索工具不再误标为 other/高风险/终端命令，hybrid 与 rules-only 零开销自动放行，manual 展示正确工具名与前缀', async () => {
    const reviewer = vi.fn();
    const { engine: hybridWithAi } = createEngine(
      { mode: 'hybrid', externalReviewer: enabledGeminiReviewer },
      reviewer
    );
    const { engine: hybridLocal } = createEngine({ mode: 'hybrid' });
    const { engine: manualEngine } = createEngine({ mode: 'manual' });

    const docsSearchTool = makePerm({
      toolCallId: 'tc-docs-1',
      kind: 'other',
      title: 'mcp_gemini-api_gemini-api-docs_gemini_search_docs',
      rawInput: {
        query: 'gemini-4-hydrogen pricing input output tokens',
        toolSummary: 'Search Gemini 4 Hydrogen docs',
      },
    });

    // 有外部复核与无外部复核在 hybrid 模式下都直接本地安全放行，不浪费外部模型额度
    expect(await hybridWithAi.requestPermission(docsSearchTool, 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).not.toHaveBeenCalled();
    expect(hybridWithAi.listAudit()[0]).toMatchObject({
      verdict: 'auto_approved',
      decisionSource: 'local-rule',
      riskLevel: 'safe',
      toolName: 'mcp_gemini-api_gemini-api-docs_gemini_search_docs',
    });

    expect(await hybridLocal.requestPermission(docsSearchTool, 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    // 即使 ACP 把 title 也省略成 'other'，纯只读查询元数据载荷（query + toolSummary）仍应识别为只读放行
    const anonDocsQuery = makePerm({
      toolCallId: 'tc-docs-anon',
      kind: 'other',
      title: 'other',
      rawInput: {
        query: 'gemini-4-hydrogen pricing input output tokens',
        toolSummary: 'Search Gemini 4 Hydrogen docs',
      },
    });
    expect(await hybridWithAi.requestPermission(anonDocsQuery, 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).not.toHaveBeenCalled();

    // manual 模式弹窗时：保留真实工具名、风险为 safe、意图绝不误报“在终端执行命令”、且选项 2 前缀可用
    const reqEv = once(manualEngine, 'requested');
    const manualPromise = manualEngine.requestPermission(docsSearchTool, 'F:\\Gravity');
    const [card] = (await reqEv) as [PendingApprovalRequest];
    expect(card.toolName).toBe('mcp_gemini-api_gemini-api-docs_gemini_search_docs');
    expect(card.riskLevel).toBe('safe');
    expect(card.commandPrefix).toBe('tool:mcp_gemini-api_gemini-api-docs_gemini_search_docs');
    expect(card.explanation.meaning).toContain('Search Gemini 4 Hydrogen docs');
    expect(card.explanation.meaning).toContain('只读');
    expect(card.explanation.meaning).not.toContain('在终端执行命令');
    manualEngine.cancelSession('sess-overhaul');
    await manualPromise;

    // SSRF 防护：指向本机或云元数据内网地址的 fetch/other 工具必须强制人工确认且禁止前缀放行
    const ssrfReq = makePerm({
      toolCallId: 'tc-ssrf',
      kind: 'fetch',
      title: 'fetch_url',
      rawInput: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    const ssrfEv = once(hybridWithAi, 'requested');
    const ssrfPromise = hybridWithAi.requestPermission(ssrfReq, 'F:\\Gravity');
    const [ssrfCard] = (await ssrfEv) as [PendingApprovalRequest];
    expect(ssrfCard.riskLevel).toBe('high');
    expect(ssrfCard.commandPrefix).toBeUndefined();
    expect(ssrfCard.explanation.risk).toContain('SSRF');
    expect(reviewer).not.toHaveBeenCalled();
    hybridWithAi.cancelSession('sess-overhaul');
    await ssrfPromise;
  });

  it('2) 非纯只读 MCP 工具：无外部复核提供中风险精准意图与选项2会话记忆；有外部复核真实调用模型、支持跨 toolCallId 缓存并透出真实错误', async () => {
    const mcpWriteReq = (toolCallId: string) =>
      makePerm({
        toolCallId,
        kind: 'other',
        title: 'mcp_notion_create_page',
        rawInput: { pageTitle: 'Release Notes', section: 'v0.2.2', toolSummary: 'Create release notes page' },
      });

    // A) 无外部复核：弹窗为中风险、非终端描述、选项 2 可记忆 `tool:mcp_notion_create_page`
    const { engine: localEngine } = createEngine({ mode: 'hybrid' });
    const ev1 = once(localEngine, 'requested');
    const p1 = localEngine.requestPermission(mcpWriteReq('tc-n-1'), 'F:\\Gravity');
    const [card1] = (await ev1) as [PendingApprovalRequest];
    expect(card1.toolName).toBe('mcp_notion_create_page');
    expect(card1.riskLevel).toBe('medium');
    expect(card1.commandPrefix).toBe('tool:mcp_notion_create_page');
    expect(card1.explanation.meaning).not.toContain('在终端执行命令');
    expect(card1.explanation.meaning).toContain('mcp_notion_create_page');

    await localEngine.submitDecision({
      requestId: card1.requestId,
      sessionId: 'sess-overhaul',
      decision: 'allow_session_prefix',
      allowedPrefix: 'tool:mcp_notion_create_page',
    });
    expect(await p1).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    // 同一会话后续调用同一 MCP 工具直接命中 session-prefix 自动放行
    expect(await localEngine.requestPermission(mcpWriteReq('tc-n-2'), 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(localEngine.listAudit()[0].decisionSource).toBe('session-prefix');

    // B) 有外部复核：携带完整 ReviewContext 调用模型，放行后不同 toolCallId 的同类请求真实命中缓存
    const reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'low',
      reason: '创建常规发布说明页面，无凭据外泄风险',
      latencyMs: 140,
    });
    const { engine: aiEngine } = createEngine(
      { mode: 'hybrid', cacheTtlHours: 24, externalReviewer: enabledGeminiReviewer },
      reviewer
    );

    expect(await aiEngine.requestPermission(mcpWriteReq('tc-ai-1'), 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0][3]).toMatchObject({
      toolName: 'mcp_notion_create_page',
      executionMode: 'default',
      withinWorkspace: true,
    });
    expect(aiEngine.listAudit()[0]).toMatchObject({
      verdict: 'ai_approved',
      decisionSource: 'external-ai',
    });

    // 换新的 toolCallId 再次发起相同调用 -> 必须命中缓存（不再重复调用外部模型）
    expect(await aiEngine.requestPermission(mcpWriteReq('tc-ai-2'), 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(aiEngine.listAudit()[0].decisionSource).toBe('cache-hit');

    // C) 外部复核出错时严格回退人工并透出脱敏后的真实错误原因（绝不吞掉 HTTP 状态码）
    const failingReviewer = vi
      .fn()
      .mockRejectedValue(
        new Error(`独立模型请求失败（HTTP 404: models/bad-model not found, key=${enabledGeminiReviewer.apiKey}）`)
      );
    const { engine: failEngine } = createEngine(
      { mode: 'hybrid', externalReviewer: enabledGeminiReviewer },
      failingReviewer
    );
    const failEv = once(failEngine, 'requested');
    const failPromise = failEngine.requestPermission(mcpWriteReq('tc-ai-fail'), 'F:\\Gravity');
    const [failCard] = (await failEv) as [PendingApprovalRequest];
    expect(failCard.aiSuggestion).toMatchObject({
      recommended: 'ask',
      model: 'gemini-4-hydrogen',
      isError: true,
    });
    expect(failCard.aiSuggestion?.reason).toContain('HTTP 404');
    expect(failCard.aiSuggestion?.reason).not.toContain(enabledGeminiReviewer.apiKey!);
    failEngine.cancelSession('sess-overhaul');
    await failPromise;
  });

  it('3) 破坏性/提权 MCP 工具与隐藏终端命令严禁走灰区自动放行或绕过人工确认', async () => {
    const reviewer = vi.fn();
    const { engine } = createEngine({ mode: 'hybrid', externalReviewer: enabledGeminiReviewer }, reviewer);

    const dangerousCases = [
      makePerm({ toolCallId: 'tc-del-mcp', kind: 'other', title: 'mcp_db_delete_table', rawInput: { table: 'users' } }),
      makePerm({ toolCallId: 'tc-hid-sh', kind: 'other', title: 'mcp_helper', rawInput: { CommandLine: 'rm -rf .' } }),
    ];

    for (const req of dangerousCases) {
      const ev = once(engine, 'requested');
      const p = engine.requestPermission(req, 'F:\\Gravity');
      const [card] = (await ev) as [PendingApprovalRequest];
      expect(card.riskLevel).toBe('high');
      expect(card.commandPrefix).toBeUndefined();
      engine.cancelSession('sess-overhaul');
      await p;
    }
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('4) 只读 PowerShell 分析脚本：无外部复核严保人工确认，开启外部复核后交由外部模型复审放行，危险脚本仍坚决拦截', async () => {
    const readOnlyPsScript =
      '$lines = Get-Content "C:\\Users\\Admin\\.gemini\\config\\plugins\\approve-for-me\\data\\audit.jsonl" -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }\nWrite-Host "Total: $($lines.Count)"';

    expect(isReadOnlyScriptReviewCandidate(readOnlyPsScript)).toBe(true);
    expect(isReadOnlyScriptReviewCandidate('echo $(whoami)')).toBe(false);
    expect(isReadOnlyScriptReviewCandidate('Get-Content a.txt | Invoke-Expression')).toBe(false);
    expect(isReadOnlyScriptReviewCandidate('$x = Get-Content a.txt; Remove-Item -Recurse build')).toBe(false);
    expect(isReadOnlyScriptReviewCandidate('Get-Content a.txt > dump.txt')).toBe(false);

    const psReq = makePerm({
      toolCallId: 'tc-ps-analytics',
      kind: 'execute',
      title: 'run_command',
      rawInput: { CommandLine: readOnlyPsScript, toolSummary: 'Compute exact approve-for-me audit statistics' },
    });

    // 无外部复核：保持 high + 人工确认
    const { engine: localOnly } = createEngine({ mode: 'hybrid' });
    const evLocal = once(localOnly, 'requested');
    const pLocal = localOnly.requestPermission(psReq, 'F:\\Gravity');
    const [localCard] = (await evLocal) as [PendingApprovalRequest];
    expect(localCard.riskLevel).toBe('high');
    expect(localCard.explanation.meaning).toContain('只读读取本地文件');
    localOnly.cancelSession('sess-overhaul');
    await pLocal;

    // 开启外部复核：送交外部模型复审并放行
    const reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'low',
      reason: '纯只读聚合统计 JSONL 审计日志，无任何文件写入或外传行为',
      latencyMs: 210,
    });
    const { engine: withAi } = createEngine(
      { mode: 'hybrid', externalReviewer: enabledGeminiReviewer },
      reviewer
    );
    expect(await withAi.requestPermission(psReq, 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(withAi.listAudit()[0]).toMatchObject({ verdict: 'ai_approved', decisionSource: 'external-ai' });
  });

  it('5) 开启外部复核时仍尊重 accept-edits / auto 模式（工作区内编辑免等待 API），default 模式源码编辑交由外部复核', async () => {
    const reviewer = vi.fn().mockResolvedValue({
      recommended: 'approve',
      riskLevel: 'low',
      reason: '工作区内常规源码改动，无安全风险',
      latencyMs: 95,
    });
    const { engine } = createEngine(
      { mode: 'hybrid', externalReviewer: enabledGeminiReviewer },
      reviewer
    );

    const inWsEdit = (id: string) =>
      makePerm({
        toolCallId: id,
        kind: 'edit',
        title: 'edit_file',
        rawInput: {
          Path: 'F:\\Gravity\\src\\renderer\\App.tsx',
          Target: 'const x = 1;',
          Replacement: 'const x = 2;',
        },
      });

    // accept-edits 模式下：已验证工作区内源码编辑直接本地放行，0 次外部 API 调用
    engine.setSessionExecutionMode('sess-overhaul', 'accept-edits');
    expect(await engine.requestPermission(inWsEdit('tc-edit-1'), 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).not.toHaveBeenCalled();
    expect(engine.listAudit()[0]).toMatchObject({ verdict: 'auto_approved', decisionSource: 'local-rule' });

    // default 模式下（换一个修改目标避免命中上一条的缓存）：送交外部复核并带上 withinWorkspace=true
    engine.setSessionExecutionMode('sess-overhaul', 'default');
    const inWsEdit2 = makePerm({
      toolCallId: 'tc-edit-2',
      kind: 'edit',
      title: 'write_file',
      rawInput: {
        Path: 'F:\\Gravity\\src\\renderer\\Demo.ts',
        Content: 'export const ok = true;\n',
      },
    });
    expect(await engine.requestPermission(inWsEdit2, 'F:\\Gravity')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0][3]).toMatchObject({ withinWorkspace: true, executionMode: 'default' });
    expect(engine.listAudit()[0]).toMatchObject({ verdict: 'ai_approved', decisionSource: 'external-ai' });
  });

  it('6) 外部复核调用器：结构化上下文透传、容错解析带说明文字的 JSON，且超时透出明确耗时提示', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'thinking...', thought: true },
                  { text: '审查结果如下：\n{"recommended":"approve","reason":"只读查询安全","riskLevel":"low"}' },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const res = await reviewWithIndependentModel('git status', 'F:\\Gravity', enabledGeminiReviewer, {
      toolName: 'run_command',
      executionMode: 'default',
      intentSummary: '只读检查 Git 仓库未提交变更状态',
      withinWorkspace: true,
    });
    expect(res).toMatchObject({ recommended: 'approve', riskLevel: 'low', reason: '只读查询安全' });
    const reqBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body || '{}'));
    const userPayload = JSON.parse(reqBody.contents[0].parts[0].text);
    expect(userPayload).toMatchObject({
      toolName: 'run_command',
      command: 'git status',
      cwd: 'F:\\Gravity',
      withinWorkspace: true,
    });

    // 超时场景透出明确中文超时提示
    const abortingFetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    await expect(
      callIndependentModel({ ...enabledGeminiReviewer, timeoutMs: 100 }, 'sys', 'in', abortingFetcher)
    ).rejects.toThrow('独立模型请求超时（超过 100ms）');
  });

  it('7) UI 卡片与设置页：非 Shell 工具不显示假 $ 符号、外部复核结论/异常直接外露展示、开启外部复核自动提示并切换 AI 代审模式', async () => {
    const card: PendingApprovalRequest = {
      requestId: 'req-vis-ai',
      sessionId: 'sess-overhaul',
      toolCallId: 'tc-vis-ai',
      toolName: 'mcp_notion_create_page',
      commandOrSummary: '{"pageTitle":"Notes"}',
      cwd: 'F:\\Gravity',
      createdAt: new Date().toISOString(),
      riskLevel: 'medium',
      commandPrefix: 'tool:mcp_notion_create_page',
      screeningSource: 'ai-reviewer-fallback',
      explanation: {
        meaning: '调用外部/扩展工具 `mcp_notion_create_page`（参数：pageTitle=Notes）',
        target: '扩展工具：mcp_notion_create_page · 工作目录：F:\\Gravity',
        risk: '非纯只读外部/MCP 工具调用',
      },
      aiSuggestion: {
        recommended: 'ask',
        reason: '外部复核失败（HTTP 404: model not found），已回退人工确认',
        latencyMs: 320,
        model: 'gemini-4-hydrogen',
        isError: true,
      },
    };

    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <InlineRequestView request={card} onSubmitDecision={async () => {}} />
      </I18nProvider>
    );

    // 非 Shell 工具显示 › 而非误导性 $
    expect(screen.getByTestId('request-cmd-req-vis-ai').querySelector('.request-cmd-prompt')?.textContent).toBe('›');
    // AI 复核异常横幅直接位于 <details> 之外可见，且包含模型名、耗时与真实错误
    const banner = screen.getByTestId('request-ai-reason-req-vis-ai');
    expect(banner.closest('details')).toBeNull();
    expect(banner.className).toContain('is-error');
    expect(banner.textContent).toContain('AI 代审异常：');
    expect(banner.textContent).toContain('HTTP 404');
    expect(banner.textContent).toContain('gemini-4-hydrogen · 320ms');

    cleanup();

    // ApprovalsPanel：当审批模式仍是 manual，用户在外部复核页开启开关并保存时自动升级为 hybrid
    const onUpdateConfig = vi.fn().mockResolvedValue(undefined);
    const manualConfig: ApproveForMeConfig = {
      mode: 'manual',
      enableSafeDownloadAutoApprove: false,
      maxDownloadSizeMB: 50,
      cacheTtlHours: 24,
      allowPatterns: [],
      askPatterns: [],
      denyPatterns: [],
      externalReviewer: { ...enabledGeminiReviewer, enabled: false },
    };

    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <ApprovalsPanel config={manualConfig} auditEntries={[]} onUpdateConfig={onUpdateConfig} />
      </I18nProvider>
    );

    fireEvent.click(screen.getByTestId('drawer-tab-reviewer'));
    fireEvent.click(screen.getByRole('checkbox', { name: '启用外部模型复核' }));
    expect(screen.getByTestId('reviewer-mode-mismatch-banner').textContent).toContain('AI 代审');
    fireEvent.click(screen.getByTestId('save-reviewer-config-btn'));

    await waitFor(() =>
      expect(onUpdateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'hybrid',
          externalReviewer: expect.objectContaining({ enabled: true, model: 'gemini-4-hydrogen' }),
        })
      )
    );
  });

  it('8) 外部复核多 API Provider 用量提取与 TelemetryStore 永久累计、分会话及 24h/7d/30d 分布统计', async () => {
    // A) 验证 Gemini / OpenAI / Ollama 与 MAX_TOKENS 截断场景均准确提取 API Provider 返回的 Token 用量
    const geminiFetcher: typeof fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: '{"recommended":"approve","reason":"ok","riskLevel":"low"}' }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            cachedContentTokenCount: 200,
            candidatesTokenCount: 120,
            thoughtsTokenCount: 300,
            totalTokenCount: 1420,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const geminiRes = await callIndependentModelWithUsage(enabledGeminiReviewer, 'sys', 'in', geminiFetcher);
    expect(geminiRes.usage).toMatchObject({
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 120,
      thinkingTokens: 300,
      totalTokens: 1420,
      providerReported: true,
    });

    const openAiConfig: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-openai-key',
      timeoutMs: 8000,
    };
    const openAiFetcher: typeof fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"recommended":"ask","reason":"check","riskLevel":"medium"}' } }],
          usage: {
            prompt_tokens: 600,
            completion_tokens: 150,
            prompt_tokens_details: { cached_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 50 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const openAiRes = await callIndependentModelWithUsage(openAiConfig, 'sys', 'in', openAiFetcher);
    expect(openAiRes.usage).toMatchObject({
      inputTokens: 500,
      cachedInputTokens: 100,
      outputTokens: 100,
      thinkingTokens: 50,
      totalTokens: 750,
      providerReported: true,
    });

    const ollamaConfig: ExternalAiReviewerConfig = {
      enabled: true,
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
      timeoutMs: 8000,
    };
    const ollamaFetcher: typeof fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { content: '{"recommended":"approve","reason":"ok","riskLevel":"low"}' },
          prompt_eval_count: 400,
          eval_count: 80,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const ollamaRes = await callIndependentModelWithUsage(ollamaConfig, 'sys', 'in', ollamaFetcher);
    expect(ollamaRes.usage).toMatchObject({
      inputTokens: 400,
      outputTokens: 80,
      totalTokens: 480,
      directCostUsd: 0,
    });

    // MAX_TOKENS 截断时服务端已计费的 usage 仍附带在错误对象上，不丢账
    const truncatedFetcher: typeof fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'thinking', thought: true }] } }],
          usageMetadata: { promptTokenCount: 500, thoughtsTokenCount: 512, totalTokenCount: 1012 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    let capturedErr: unknown;
    try {
      await callIndependentModelWithUsage(enabledGeminiReviewer, 'sys', 'in', truncatedFetcher);
    } catch (err) {
      capturedErr = err;
    }
    expect(capturedErr).toBeInstanceOf(IndependentModelCallError);
    expect((capturedErr as IndependentModelCallError).usage?.totalTokens).toBe(1012);

    // B) TelemetryStore 跨 3 个历史 API Provider 共同累计、分会话隔离、生成 24h/7d/30d 分布，且重启后无损恢复
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-ext-tele-'));
    tempDirs.push(dir);
    const fixedNow = Date.parse('2026-11-20T09:30:00Z');
    const store1 = new ClientStore(dir);
    const tele1 = new TelemetryStore({ store: store1, now: () => fixedNow });

    tele1.recordExternalReviewUsage({
      sessionId: 'sess-1',
      provider: 'gemini-api-key',
      endpoint: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-4-hydrogen',
      outcome: 'approve',
      latencyMs: 520,
      usage: geminiRes.usage,
      timestamp: fixedNow,
    });
    tele1.recordExternalReviewUsage({
      sessionId: 'sess-1',
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      modelId: 'gpt-4o-mini',
      outcome: 'ask',
      latencyMs: 680,
      usage: openAiRes.usage,
      timestamp: fixedNow,
    });
    tele1.recordExternalReviewUsage({
      sessionId: 'sess-2',
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen2.5-coder:7b',
      outcome: 'approve',
      latencyMs: 210,
      usage: ollamaRes.usage,
      timestamp: fixedNow - 3600_000,
    });
    tele1.flush();

    const snap1 = tele1.snapshot();
    const ext1 = snap1.externalReviewer!;
    expect(ext1.cumulativeAllTime.callCount).toBe(3);
    expect(ext1.cumulativeAllTime.providerCount).toBe(3);
    expect(ext1.cumulativeAllTime.totalTokens).toBe(1420 + 750 + 480);
    expect(ext1.cumulativeAllTime.totalCostUsd).toBeGreaterThan(0);
    expect(ext1.cumulativeProviders).toHaveLength(3);
    expect(ext1.cumulativeProviders.find((p) => p.provider === 'local-ollama')?.totalCostUsd).toBe(0);
    expect(ext1.bySession['sess-1'].callCount).toBe(2);
    expect(ext1.bySession['sess-1'].totalTokens).toBe(1420 + 750);
    expect(ext1.bySession['sess-2'].callCount).toBe(1);
    expect(ext1.hourly24h).toHaveLength(24);
    expect(ext1.matrix7d).toHaveLength(168);
    expect(ext1.calendar30d).toHaveLength(30);
    expect(ext1.hourly24h.reduce((s, b) => s + b.totalTokens, 0)).toBe(1420 + 750 + 480);

    // 模拟重启恢复：永久累计与会话统计无损保留
    const tele2 = new TelemetryStore({ store: new ClientStore(dir), now: () => fixedNow });
    const ext2 = tele2.snapshot().externalReviewer!;
    expect(ext2.cumulativeAllTime.callCount).toBe(3);
    expect(ext2.cumulativeAllTime.totalTokens).toBe(2650);
    expect(ext2.cumulativeProviders).toHaveLength(3);
    expect(ext2.bySession['sess-1'].callCount).toBe(2);
    tele1.dispose();
    tele2.dispose();
  });

  it('9) 严格门控：未连接外部复核严禁开启 AI 代审（CoreService 拒切且启动/断开自动降级为基础规则机制）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gravity-hybrid-gate-'));
    tempDirs.push(dir);
    // 1. 磁盘上残留 mode='hybrid' 但外部复核未启用 -> 启动自动安全降级为 rules-only
    writeFileSync(
      path.join(dir, 'approval-config.json'),
      JSON.stringify({
        mode: 'hybrid',
        externalReviewer: {
          enabled: false,
          provider: 'gemini-api-key',
          endpoint: 'https://generativelanguage.googleapis.com',
          model: 'gemini-4-hydrogen',
          timeoutMs: 8000,
        },
      }),
      'utf8'
    );
    const core = new CoreService({ dataDir: dir });
    try {
      expect(core.approval.getConfig().mode).toBe('rules-only');

      // 2. 未连接外部复核时尝试切换到 hybrid -> 拒绝并提示去连接
      await expect(core.setApprovalMode('hybrid')).rejects.toThrow('尚未连接外部复核模型');
      expect(core.approval.getConfig().mode).toBe('rules-only');

      // 3. 正确连接外部复核并开启后，允许启用 AI 代审
      const connected = await core.updateApprovalConfig({
        mode: 'hybrid',
        externalReviewer: enabledGeminiReviewer,
      });
      expect(connected.mode).toBe('hybrid');
      expect(connected.externalReviewer.enabled).toBe(true);

      // 4. 关闭外部复核后，自动降级回基础规则机制（rules-only）
      const downgraded = await core.updateApprovalConfig({
        externalReviewer: { ...enabledGeminiReviewer, enabled: false },
      });
      expect(downgraded.mode).toBe('rules-only');
    } finally {
      await core.dispose();
    }
  });

  it('10) Approve for me 菜单用量展示 + 未连接外部复核点击 AI 代审引导去连接 + Context 窗口与外部复核统计双视图切换', async () => {
    resetFallbackDesktopBridge();
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const onOpenExtSettings = vi.fn();
    const onOpenReviewerStats = vi.fn();
    const onCycleMode = vi.fn().mockResolvedValue(undefined);

    const session: ManagedSessionSummary = boot.sessions[0];
    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <Composer
          session={session}
          availableSessions={boot.sessions}
          availableModels={boot.connection.availableModels}
          approvalConfig={boot.approvalConfig}
          sessionTelemetry={boot.telemetry.activeSessions[session.sessionId]}
          externalReviewerTelemetry={boot.telemetry.externalReviewer}
          canTriggerDemoApproval={false}
          onSendPrompt={async () => {}}
          onCancelPrompt={async () => {}}
          onCompactContext={async () => {}}
          onSetSessionMode={async () => {}}
          onSetSessionEffort={async () => {}}
          onSetSessionModel={async () => {}}
          onQueryWorkspaceFiles={async () => []}
          onCycleApprovalMode={onCycleMode}
          onOpenApprovalSettings={() => {}}
          onOpenExternalReviewerSettings={onOpenExtSettings}
          onOpenReviewerStats={onOpenReviewerStats}
          onOpenContextInspector={() => {}}
          onTriggerDemoApproval={() => {}}
        />
      </I18nProvider>
    );

    // 打开 Approve for me 菜单：展示外部复核累计/本会话用量与“未连接外部复核”提示
    fireEvent.click(screen.getByTestId(`approval-mode-pill-${session.sessionId}`));
    const usageBox = screen.getByTestId(`approval-menu-reviewer-usage-${session.sessionId}`);
    expect(usageBox.textContent).toContain('外部复核 API 用量');
    expect(usageBox.textContent).toContain('客户端累计');
    expect(usageBox.textContent).toContain('本会话');

    // 未连接时点击「AI 代审」不调用切换，而是弹出引导提示并支持一键跳转外部复核设置
    fireEvent.click(screen.getByTestId(`approval-menu-mode-hybrid-${session.sessionId}`));
    expect(onCycleMode).not.toHaveBeenCalled();
    expect(screen.getByTestId(`approval-connect-reviewer-prompt-${session.sessionId}`).textContent).toContain('尚未连接外部复核模型');
    fireEvent.click(screen.getByTestId(`approval-goto-connect-btn-${session.sessionId}`));
    expect(onOpenExtSettings).toHaveBeenCalledTimes(1);

    // 再次打开菜单点击查看 24h/7d/30d 分布统计入口
    fireEvent.click(screen.getByTestId(`approval-mode-pill-${session.sessionId}`));
    fireEvent.click(screen.getByTestId(`approval-open-reviewer-stats-btn-${session.sessionId}`));
    expect(onOpenReviewerStats).toHaveBeenCalledTimes(1);

    cleanup();

    // ContextCostInspectorView：默认展示 Context 窗口，切换至「外部复核统计」可查看全量 24h/7d/30d 与多服务商共同汇总
    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <ContextCostInspectorView
          sessionId={session.sessionId}
          dashboard={boot.telemetry}
          reviewerConnected={false}
          onOpenExternalReviewerSettings={onOpenExtSettings}
          onOpenRateCardsSettings={() => {}}
        />
      </I18nProvider>
    );
    expect(screen.getByTestId('context-inspector-mode-switch')).toBeTruthy();
    expect(screen.queryByTestId('external-reviewer-telemetry-view')).toBeNull();

    fireEvent.click(screen.getByTestId('context-mode-tab-reviewer'));
    expect(screen.getByTestId('external-reviewer-telemetry-view')).toBeTruthy();
    expect(screen.getByTestId('reviewer-alltime-summary').textContent).toContain('2 个服务商');
    expect(screen.getByTestId('reviewer-session-summary').textContent).toContain('6 次');
    expect(screen.getByTestId('reviewer-provider-breakdown').textContent).toContain('Google AI Studio');
    expect(screen.getByTestId('reviewer-provider-breakdown').textContent).toContain('OpenAI API');

    // 切换 7d / 30d 分布与本会话/累计花费维度
    fireEvent.click(screen.getByTestId('reviewer-heatmap-range-7d'));
    expect(screen.getByTestId('reviewer-heatmap-7d-matrix')).toBeTruthy();
    fireEvent.click(screen.getByTestId('reviewer-heatmap-range-30d'));
    expect(screen.getByTestId('reviewer-heatmap-30d-calendar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('reviewer-cost-scope-session'));
    expect(screen.getByTestId('reviewer-cost-total-usd').textContent).toContain('$');
  });

  it('11) 右侧检视器极窄宽度下的横向滑动栏：保持 .inspector-head 纯 5 页签、溢出时显示左右滑动按钮并支持滚轮横滑', async () => {
    resetFallbackDesktopBridge();
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const onSelectTab = vi.fn();

    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <RightInspector
          collapsed={false}
          width={280}
          activeTab="diff"
          focusedDiffFile={null}
          sessionId={boot.sessions[0].sessionId}
          sessionMessages={[]}
          telemetry={boot.telemetry}
          onSelectTab={onSelectTab}
          onFocusDiffFile={() => {}}
          onCommitWidth={() => {}}
          onOpenRateCardsSettings={() => {}}
        />
      </I18nProvider>
    );

    const inspector = screen.getByTestId('right-inspector');
    const head = inspector.querySelector('.inspector-head') as HTMLDivElement;
    // 严格保持 tablist 语义纯净：5 个 tab、0 个多余 button
    expect(within(head).getAllByRole('tab')).toHaveLength(5);
    expect(within(head).queryAllByRole('button')).toHaveLength(0);

    // 模拟窄栏溢出（例如右侧栏压缩至 280px，可用页签区仅 80px，5 个页签总宽 220px）
    Object.defineProperty(head, 'clientWidth', { configurable: true, value: 80 });
    Object.defineProperty(head, 'scrollWidth', { configurable: true, value: 220 });
    let scrollLeftVal = 0;
    Object.defineProperty(head, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeftVal,
      set: (v: number) => {
        scrollLeftVal = v;
      },
    });

    fireEvent.scroll(head);
    const viewport = screen.getByTestId('inspector-tabs-viewport');
    expect(viewport.className).toContain('is-overflowing');
    expect(screen.getByTestId('inspector-tabs-scroll-right')).toBeTruthy();
    expect(screen.queryByTestId('inspector-tabs-scroll-left')).toBeNull();

    // 点击右滑按钮：横向滚动，左侧回滑按钮出现
    fireEvent.click(screen.getByTestId('inspector-tabs-scroll-right'));
    expect(scrollLeftVal).toBeGreaterThan(0);
    expect(screen.getByTestId('inspector-tabs-scroll-left')).toBeTruthy();

    // 滚轮垂直滚动自动转为横向滚动
    const beforeWheel = scrollLeftVal;
    fireEvent.wheel(head, { deltaY: 30 });
    expect(scrollLeftVal).toBeGreaterThan(beforeWheel);

    // 可以直接点击到靠右的 Context 与 Swarm 页签
    fireEvent.click(screen.getByTestId('inspector-tab-context'));
    fireEvent.click(screen.getByTestId('inspector-tab-swarm'));
    expect(onSelectTab).toHaveBeenCalledWith('context');
    expect(onSelectTab).toHaveBeenCalledWith('swarm');
  });
});

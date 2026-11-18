// @vitest-environment jsdom
import React from 'react';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveModelCompactionLimit,
  type ChatMessageItem,
  type DualTrackThoughtBlock,
  type ManagedSessionSummary,
  type PendingApprovalRequest,
} from '../src/shared';
import { describeOperationIntent, screenCommand } from '../src/main/approval/shell-screening';
import { CoreService } from '../src/main/core-service';
import {
  decodeCheckpointMaxTokenLimit,
  readSessionCheckpointLimit,
} from '../src/main/telemetry/checkpoint-limit-reader';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';
import { ClientStore } from '../src/main/storage/client-store';
import { formatTokenShort } from '../src/renderer/components/ContextStatusBar';
import { InlineRequestView } from '../src/renderer/components/InlineRequestView';
import { Markdown } from '../src/renderer/components/Markdown';
import { SessionPane } from '../src/renderer/components/SessionPane';
import { ThinkingBlock } from '../src/renderer/components/ThinkingBlock';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let n = BigInt(val);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function encodeSubmessage(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 0), encodeVarint(value)]);
}

function wrapI18n(node: React.ReactElement): React.ReactElement {
  return (
    <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
      {node}
    </I18nProvider>
  );
}

const tempDirs: string[] = [];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { agyDesktop?: unknown }).agyDesktop;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('v0.5 六项核心增强验收测试', () => {
  it('1) 上下文窗口精确映射模型实际压缩上限 (512k / 256k) 且可从 executor_metadata 只读解析', async () => {
    // 验证 CASCADE_USE_EXPERIMENT_CHECKPOINTER 模型目录映射与本地默认 256,000
    expect(resolveModelCompactionLimit('gemini-4-carbon-high')).toBe(512_000);
    expect(resolveModelCompactionLimit('gemini-4-carbon-medium')).toBe(512_000);
    expect(resolveModelCompactionLimit('gemini-4-hydrogen-extra')).toBe(512_000);
    expect(resolveModelCompactionLimit('gemini-pro-orchestrator')).toBe(512_000);
    expect(resolveModelCompactionLimit('gemini-3.8-flash')).toBe(256_000);
    expect(resolveModelCompactionLimit('claude-sonnet-4-6')).toBe(256_000);

    // 验证状态栏整千格式化
    expect(formatTokenShort(512_000)).toBe('512k');
    expect(formatTokenShort(256_000)).toBe('256k');
    expect(formatTokenShort(68_400)).toBe('68.4k');

    // 构造真实 Protobuf 结构：executor_metadata -> field 10 (cascade_config) -> field 2 (checkpoint_config) -> field 5 (max_token_limit = 512000)
    const checkpointConfig = encodeVarintField(5, 512_000);
    const modelRawLimit = encodeSubmessage(1, encodeVarintField(22, 1_048_576));
    const cascadeConfig = Buffer.concat([modelRawLimit, encodeSubmessage(2, checkpointConfig)]);
    const executorMetadataBlob = encodeSubmessage(10, cascadeConfig);

    expect(decodeCheckpointMaxTokenLimit(executorMetadataBlob)).toBe(512_000);

    // 验证只读读取 SQLite 会话库且源目录零写入
    const root = mkdtempSync(join(tmpdir(), 'gravity-chk-'));
    tempDirs.push(root);
    const appDataDir = join(root, 'isolated-profile');
    const convDir = join(appDataDir, 'conversations');
    const cacheDir = join(root, 'cache');
    mkdirSync(convDir, { recursive: true });

    const sessionId = 'sess_carbon_512k_test';
    const dbPath = join(convDir, `${sessionId}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(1, executorMetadataBlob);
    db.close();

    const parsedLimit = await readSessionCheckpointLimit({
      sessionId,
      cacheDir,
      isolatedAppDataDir: appDataDir,
    });
    expect(parsedLimit).toBe(512_000);

    // 验证 TelemetryStore 不会被 usage_update 的 1,048,576 覆盖实际压缩窗口
    const store = new TelemetryStore({ store: new ClientStore(join(root, 'store')) });
    store.ensure(sessionId, 'gemini-4-carbon');
    expect(store.snapshot().activeSessions[sessionId].maxContextTokens).toBe(512_000);
    store.applyContextWindow(sessionId, 128_000, 1_048_576);
    expect(store.snapshot().activeSessions[sessionId].maxContextTokens).toBe(512_000);
    expect(store.snapshot().activeSessions[sessionId].usedContextTokens).toBe(128_000);
    store.dispose();
  });

  it('思考的译文、原文和完成状态使用相同段落结构，正文保留流式反馈', () => {
    vi.useFakeTimers();
    const text = '第一段文字。\n\n\n\n第二段包含 `code`。';
    const thought: DualTrackThoughtBlock = {
      id: 'flow', originalText: 'First paragraph.\n\nSecond paragraph.',
      translatedZhText: text, isStreaming: true, isTranslating: true,
      languageDetected: 'en', translationSource: 'local-model',
    };
    const ui = (block: DualTrackThoughtBlock) => wrapI18n(<ThinkingBlock thought={block} defaultTrack="zh" forceAnimation />);
    const view = render(ui(thought));
    act(() => { vi.advanceTimersByTime(1300); });
    const body = screen.getByTestId('thought-content-flow');
    const first = body.querySelector('p');
    expect(first?.textContent).toBe('第一段文字。');
    expect(body.querySelectorAll('p')).toHaveLength(2);
    const html = body.innerHTML;
    view.rerender(ui({ ...thought, isStreaming: false, isTranslating: false }));
    expect(body.querySelector('p')).toBe(first);
    expect(body.innerHTML).toBe(html);
    fireEvent.click(screen.getByTestId('thought-btn-raw-flow'));
    expect(first?.textContent).toContain('First paragraph');
    view.unmount();
    // 动效 3：正文吐出横向清脆滑入 + 呼吸激光游标 (.cc-body-stream-active + .cc-stream-glide-block)
    const { container } = render(
      wrapI18n(
        <Markdown
          text={'### 架构总结\n\n第一段流式输出正文内容，保持锐利无模糊。'}
          streaming
          forceAnimation
        />
      )
    );
    act(() => {
      vi.advanceTimersByTime(96);
    });
    const mdRoot = container.querySelector('.md');
    expect(mdRoot?.classList.contains('cc-body-stream-active')).toBe(true);
    expect(mdRoot?.classList.contains('cc-streaming-cursor')).toBe(true);
    expect(container.querySelector('.cc-stream-glide-block')).toBeTruthy();
    expect(container.querySelector('.cc-thought-mist-tail')).toBeNull();
  });

  it('3) 正文划词支持 Quote 引用、Codex 多处标记写入 Notation 以及右击超链接/本地文件打开', async () => {
    const openTargetMock = vi.fn().mockResolvedValue({
      opened: true,
      modeUsed: 'browser',
      resolvedTarget: 'https://ai.google.dev/gemini-api/docs',
    });
    const sendPromptMock = vi.fn().mockResolvedValue(undefined);

    const bridge = getFallbackDesktopBridge();
    const boot = await bridge.getBootstrap();
    window.agyDesktop = {
      ...bridge,
      openLinkOrFileTarget: openTargetMock,
    };

    const session: ManagedSessionSummary = {
      sessionId: 'sess-annot',
      rawCwd: 'F:\\插件-Gemini',
      pinned: false,
      isLegacyApprovalPollution: false,
      originKind: 'acp-live',
      readOnly: false,
      profileId: 'default',
      title: 'Annotation Test',
      cwd: 'F:\\插件-Gemini',
      status: 'idle',
      modelId: 'gemini-4-carbon',
      executionMode: 'default',
      reasoningEffort: 'high',
      updatedAt: new Date().toISOString(),
    };

    const messages: ChatMessageItem[] = [
      {
        id: 'msg-1',
        sessionId: 'sess-annot',
        role: 'assistant',
        content:
          '请参考 [Gemini 官方文档](https://ai.google.dev/gemini-api/docs) 并检查本地文件 `src/main/core-service.ts` 与构建产物 [Gravity.exe](file:///F:/插件-Gemini/release/Gravity.exe)。第一处关键逻辑负责权限快筛，第二处关键逻辑负责压缩窗口读取。',
        createdAt: new Date().toISOString(),
      },
    ];

    render(
      wrapI18n(
        <SessionPane
          slotIndex={0}
          layoutMode="single"
          isFocused
          session={session}
          availableSessions={[session]}
          availableModels={[{ modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]}
          messages={messages}
          pendingApprovals={[]}
          approvalConfig={boot.approvalConfig}
          defaultThoughtTrack="zh"
          telemetryDashboard={boot.telemetry}
          scrollMemoryRef={{ current: {} }}
          canTriggerDemoApproval={false}
          appIcon="gravity-claude-dark"
          onFocusPane={() => {}}
          onBindSlotSession={() => {}}
          onOpenNewSession={() => {}}
          onSendPrompt={sendPromptMock}
          onCancelPrompt={async () => {}}
          onCompactContext={async () => {}}
          onSetSessionMode={async () => {}}
          onSetSessionEffort={async () => {}}
          onSetSessionModel={async () => {}}
          onQueryWorkspaceFiles={async () => []}
          onSubmitApproval={async () => {}}
          onCycleApprovalMode={async () => {}}
          onOpenApprovalSettings={() => {}}
          onOpenSwarmInspector={() => {}}
          onOpenContextInspector={() => {}}
          onInspectDiffFile={() => {}}
          onTriggerDemoApproval={() => {}}
        />
      )
    );

    const bodyEl = screen.getByTestId('assistant-body-msg-1');

    // 模拟第 1 次划词：点击 Quote 引用
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '第一处关键逻辑负责权限快筛',
      anchorNode: bodyEl,
      rangeCount: 0,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent.mouseUp(bodyEl, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId('selection-quote-btn'));

    // 模拟第 2 次划词：添加第 1 条 Codex 标记批注
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '检查本地文件 src/main/core-service.ts',
      anchorNode: bodyEl,
      rangeCount: 0,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent.mouseUp(bodyEl, { button: 0, clientX: 220, clientY: 220 });
    fireEvent.click(screen.getByTestId('selection-annotate-btn'));
    fireEvent.change(screen.getByTestId('selection-notation-input'), {
      target: { value: '请补充空路径异常校验' },
    });
    fireEvent.click(screen.getByTestId('selection-notation-save-btn'));

    // 模拟第 3 次划词：添加第 2 条 Codex 标记批注（验证多处标记能力）
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '第二处关键逻辑负责压缩窗口读取',
      anchorNode: bodyEl,
      rangeCount: 0,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent.mouseUp(bodyEl, { button: 0, clientX: 240, clientY: 260 });
    fireEvent.click(screen.getByTestId('selection-annotate-btn'));
    fireEvent.change(screen.getByTestId('selection-notation-input'), {
      target: { value: '缓存命中后避免重复读取 SQLite' },
    });
    fireEvent.click(screen.getByTestId('selection-notation-save-btn'));

    // 消息下方应同时显示 #1 和 #2 两处批注钉
    const pins = screen.getByTestId('turn-notation-pins');
    expect(pins.textContent).toContain('#1');
    expect(pins.textContent).toContain('#2');
    expect(pins.textContent).toContain('请补充空路径异常校验');
    expect(pins.textContent).toContain('缓存命中后避免重复读取 SQLite');

    // 右击超链接 -> 在本地浏览器中打开
    const webLink = screen.getByText('Gemini 官方文档').closest('a')!;
    fireEvent.contextMenu(webLink, { clientX: 180, clientY: 180 });
    fireEvent.click(screen.getByTestId('ctx-open-browser'));
    expect(openTargetMock).toHaveBeenCalledWith({
      target: 'https://ai.google.dev/gemini-api/docs',
      action: 'browser',
      cwd: 'F:\\插件-Gemini',
      sessionId: 'sess-annot',
    });

    // 右击行内代码源码路径 -> 显示默认应用打开 & 在文件管理器中定位
    const codeSpan = screen.getByText('src/main/core-service.ts');
    fireEvent.contextMenu(codeSpan, { clientX: 200, clientY: 180 });
    expect(screen.getByTestId('ctx-open-default-app')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ctx-open-default-app'));
    expect(openTargetMock).toHaveBeenCalledWith({
      target: 'src/main/core-service.ts',
      action: 'default-app',
      cwd: 'F:\\插件-Gemini',
      sessionId: 'sess-annot',
    });

    // 右击 .exe 可执行文件超链接 -> 仅提供在文件管理器中定位，避免误执行二进制
    const exeLink = screen.getByText('Gravity.exe').closest('a')!;
    fireEvent.contextMenu(exeLink, { clientX: 220, clientY: 180 });
    expect(screen.queryByTestId('ctx-open-default-app')).toBeNull();
    fireEvent.click(screen.getByTestId('ctx-reveal-folder'));
    expect(openTargetMock).toHaveBeenCalledWith({
      target: 'file:///F:/插件-Gemini/release/Gravity.exe',
      action: 'reveal-in-folder',
      cwd: 'F:\\插件-Gemini',
      sessionId: 'sess-annot',
    });

    sendPromptMock.mockRejectedValueOnce(new Error('测试断线'));
    fireEvent.click(screen.getByTestId('send-prompt-btn-sess-annot'));
    await screen.findByText(/测试断线/);
    expect(screen.getAllByTestId(/^composer-notation-/)).toHaveLength(2);
    // 重试时完整发送同一组引用和批注。
    fireEvent.click(screen.getByTestId('send-prompt-btn-sess-annot'));
    await waitFor(() => expect(sendPromptMock).toHaveBeenCalledTimes(2));
    const sentText = sendPromptMock.mock.calls[1][0].text as string;
    await waitFor(() => expect(screen.queryAllByTestId(/^composer-notation-/)).toHaveLength(0));
    expect(sentText).toContain('> 第一处关键逻辑负责权限快筛');
    expect(sentText).toContain('【逐处标记批注 (Notations)】');
    expect(sentText).toContain('1. 针对原文「检查本地文件 src/main/core-service.ts」：请补充空路径异常校验');
    expect(sentText).toContain('2. 针对原文「第二处关键逻辑负责压缩窗口读取」：缓存命中后避免重复读取 SQLite');
  });

  it('4) AI 代审转交人工审理时清晰解析并展示代码与命令的明确用意', async () => {
    const boot = await getFallbackDesktopBridge().getBootstrap();
    const safeRuleConfig = {
      ...boot.approvalConfig,
      allowPatterns: ['^git\\s+status$'],
      askPatterns: ['^git\\s+push'],
      denyPatterns: ['^rm\\s+-rf'],
    };
    // 验证内联脚本与串联命令用意提炼
    const scriptScreening = screenCommand(
      'python -c "import urllib.request, sqlite3; print(1)"',
      'F:\\插件-Gemini',
      safeRuleConfig,
      'run_command',
      {
        CommandLine: 'python -c "import urllib.request, sqlite3; print(1)"',
        toolSummary: '拉取远程配置并校验本地数据库',
      }
    );
    expect(scriptScreening.explanation.meaning).toContain('拉取远程配置并校验本地数据库');
    expect(scriptScreening.explanation.meaning).toContain('直接执行内联脚本代码');
    expect(scriptScreening.explanation.meaning).toContain('访问 SQLite 数据库');
    expect(scriptScreening.explanation.meaning).toContain('发起网络请求');

    // 验证 edit_file 代码修改用意提炼
    const editIntent = describeOperationIntent(
      'edit_file src/main/core-service.ts',
      'F:\\插件-Gemini',
      'edit_file',
      {
        Path: 'F:\\插件-Gemini\\src\\main\\core-service.ts',
        Target: 'const oldLimit = 1048576;',
        Replacement: 'export function resolveCompaction() {\n  return 512000;\n}',
      }
    );
    expect(editIntent.meaning).toContain('修改源码文件');
    expect(editIntent.meaning).toContain('resolveCompaction');

    // 验证 InlineRequestView 在转交人工审理卡片上突出展示「代码用意」与「AI 代审说明」
    const pendingReq: PendingApprovalRequest = {
      requestId: 'req-intent-1',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'run_command',
      commandOrSummary: 'python -c "import urllib.request; ..."',
      commandPrefix: 'python',
      cwd: 'F:\\插件-Gemini',
      riskLevel: 'medium',
      screeningSource: 'ai-reviewer-fallback',
      explanation: {
        meaning: scriptScreening.explanation.meaning,
        target: scriptScreening.explanation.target,
        risk: '包含外网请求与内联脚本执行，需人工确认意图',
      },
      aiSuggestion: {
        recommended: 'ask',
        latencyMs: 15,
        reason: '该 Python 单行脚本会发起外部 HTTP 连接并查询 SQLite，转交人工核实目标地址。',
      },
      createdAt: new Date().toISOString(),
    };

    render(wrapI18n(<InlineRequestView request={pendingReq} onSubmitDecision={async () => {}} />));
    expect(screen.getByTestId('request-code-intent-req-intent-1').textContent).toContain('代码用意');
    expect(screen.getByTestId('request-code-intent-req-intent-1').textContent).toContain('直接执行内联脚本代码');
    expect(screen.getByTestId('request-ai-reason-req-intent-1').textContent).toContain(
      'AI 代审说明：该 Python 单行脚本会发起外部 HTTP 连接并查询 SQLite'
    );
  });

  it('5) 后端 openLinkOrFileTarget 按文件类型智能分流并拦截敏感凭据文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gravity-open-'));
    tempDirs.push(root);
    const mdFile = join(root, 'notes.md');
    const exeFile = join(root, 'Gravity.exe');
    const subFolder = join(root, 'subdir');
    writeFileSync(mdFile, '# Notes');
    writeFileSync(exeFile, 'MZ');
    mkdirSync(subFolder);

    const calls: Array<{ target: string; mode: string; isDir?: boolean }> = [];
    const fakeCore = {
      options: {
        openTargetHandler: async (target: string, mode: string, isDir?: boolean) => {
          calls.push({ target, mode, isDir });
        },
      },
    } as unknown as CoreService;

    const openFn = CoreService.prototype.openLinkOrFileTarget.bind(fakeCore);

    // 1. Web 超链接 -> 本地浏览器
    const rUrl = await openFn({ target: 'https://example.com/docs', action: 'browser' });
    expect(rUrl.modeUsed).toBe('browser');

    // 2. 普通文档 -> 默认应用打开
    const rMd = await openFn({ target: 'notes.md', action: 'default-app', cwd: root });
    expect(rMd.modeUsed).toBe('default-app');

    // 3. 可执行程序 (.exe) 即使请求 default-app 也自动安全降级为文件管理器定位
    const rExe = await openFn({ target: exeFile, action: 'default-app' });
    expect(rExe.modeUsed).toBe('reveal-in-folder');

    // 4. 目录自动路由至文件管理器打开
    const rDir = await openFn({ target: subFolder, action: 'default-app' });
    expect(rDir.modeUsed).toBe('reveal-in-folder');
    expect(calls.at(-1)?.isDir).toBe(true);

    // 5. 拒绝打开敏感凭据文件
    await expect(
      openFn({ target: join(root, 'oauth_creds.json'), action: 'default-app' })
    ).rejects.toThrow('拒绝打开敏感凭据');
  });
});

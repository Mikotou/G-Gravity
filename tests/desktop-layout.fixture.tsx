import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App';
import { SessionWorkspaceGrid } from '../src/renderer/components/SessionWorkspaceGrid';
import { TopBar } from '../src/renderer/components/TopBar';
import { getFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { ChatMessageItem, ManagedSessionSummary, SendPromptInput, WorkspaceSplitMode } from '../src/shared';
import '../src/renderer/styles/global.css';
import '../src/renderer/styles/design-system.css';

function picture(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#4b6381'; ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png');
}
async function main() {
  const root = createRoot(document.getElementById('root')!);
  const bridge = getFallbackDesktopBridge();
  if (location.search === '?keyboard-workspace') {
    await bridge.saveWorkspaceLayout({ openTabSessionIds: [], activePrimarySessionId: null,
      splitSecondarySessionId: null, tertiarySessionId: null, quaternarySessionId: null, layoutMode: 'single' });
    Object.assign(window, { fixtureBridge: bridge });
    root.render(<App />);
    return;
  }
  const boot = await bridge.getBootstrap();
  const session = { ...boot.sessions[0], sessionId: 'layout-test', profileId: 'fixture', status: 'idle' as const, readOnly: false };
  const scroll = { current: {} };
  const image = (id: string, width: number, height: number) => {
    const dataUrl = picture(width, height);
    return { id, name: id, mimeType: 'image/png', dataUrl, sizeBytes: atob(dataUrl.split(',')[1]).length };
  };
  const date = new Date().toISOString();
  const messages: ChatMessageItem[] = [
    { id: 'user', sessionId: session.sessionId, createdAt: date, role: 'user', content: '上一条消息', attachments: [image('portrait', 1200, 2200), image('tiny', 17, 10)] },
    { id: 'reply', sessionId: session.sessionId, createdAt: date, role: 'assistant',
      content: '第一段 **关键原文**。\n\n第二段可以另写批注。',
      attachments: [image('landscape', 2300, 1100)],
      thoughts: [{ id: 'flow', translatedZhText: '第一段思考文字。\n\n\n\n第二段包含代码 `core`。\n\n第三段已完成。',
        originalText: 'First paragraph.\n\n\n\nSecond paragraph.', translationSource: 'local-model', languageDetected: 'en', isStreaming: true }] }
  ];
  const noop = () => {};
  const done = async () => {};
  const other = { ...session, sessionId: 'fixture-other', title: '其他记录', updatedAt: '2099-01-01T00:00:00Z' };
  const state = { opened: false, calls: [] as SendPromptInput[], revised: '', streaming: true,
    mode: 'single' as WorkspaceSplitMode, long: false, quotaReads: 0, sending: false, settle: () => {},
    draw(streaming: boolean) {
      state.streaming = streaming;
      const primary: ManagedSessionSummary = { ...session, status: state.sending ? 'streaming' : 'idle' };
      const sessions = [other, primary];
      const layout = { ...boot.layout, layoutMode: state.mode,
        openTabSessionIds: state.opened ? [primary.sessionId, other.sessionId] : [],
        activePrimarySessionId: state.opened ? primary.sessionId : null, splitSecondarySessionId: other.sessionId,
        tertiarySessionId: null, quaternarySessionId: null };
      const reply = messages[1];
      const thought = { ...reply.thoughts![0], isStreaming: streaming, isTranslating: streaming };
      const transcript = [messages[0], { ...reply, thoughts: [thought] }];
      if (state.long) transcript.push({ ...reply, id: 'long-reply', attachments: [], thoughts: [],
        content: Array.from({ length: 55 }, (_, n) => '布局测试段落 ' + n).join('\n\n') });
      root.render(<div style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 }}>
        <TopBar sessions={sessions} layout={layout} focusedSessionId={primary.sessionId} pendingApprovals={[]}
          onToggleLeftSidebar={noop} onToggleRightInspector={noop} onSelectTab={noop} onCloseTab={noop} onOpenNewSessionModal={noop}
          onChangeLayoutMode={mode => { state.mode = mode; state.draw(state.streaming); }} />
        <SessionWorkspaceGrid layout={layout} focusedSessionId={primary.sessionId} sessions={sessions} availableModels={[]}
          messagesBySession={{ [primary.sessionId]: transcript, [other.sessionId]: [] }} auditLog={[]} swarmBySession={{}}
          pendingApprovals={[]} approvalConfig={boot.approvalConfig} defaultThoughtTrack="zh" telemetryDashboard={boot.telemetry}
          scrollMemoryRef={scroll} canTriggerDemoApproval={false} appIcon="gravity-claude-dark"
          onFocusPane={noop} onBindSlotSession={(_, id) => { if (id === primary.sessionId) { state.opened = true; state.draw(state.streaming); } }}
          onOpenNewSession={noop} onReviseMessage={async input => { state.revised = input.text; }}
          onSendPrompt={input => {
            state.calls.push(input); state.sending = true; state.draw(false);
            return new Promise<void>(resolve => {
              state.settle = () => { state.sending = false; state.draw(false); resolve(); };
            });
          }}
          onCancelPrompt={done} onCompactContext={done} onSetSessionMode={done} onSetSessionEffort={done}
          onSetSessionModel={done} onQueryWorkspaceFiles={async () => []} onSubmitApproval={done} onCycleApprovalMode={done}
          onOpenApprovalSettings={noop} onOpenSwarmInspector={noop} onOpenContextInspector={noop} onInspectDiffFile={noop}
          onTriggerDemoApproval={noop} />
      </div>);
    } };
  bridge.getAccountQuota = async () => {
    state.quotaReads++;
    return { profileId: session.profileId, checkedAt: new Date().toISOString(), buckets: [
      { id: '3p-5h', remainingFraction: 0 }, { id: '3p-weekly', remainingFraction: .46 },
      { id: 'gemini-5h', remainingFraction: 1 }, { id: 'gemini-weekly', remainingFraction: state.quotaReads === 1 ? .812 : .798 },
    ] };
  };
  Object.assign(window, { fixture: state });
  state.draw(true);
}
void main();

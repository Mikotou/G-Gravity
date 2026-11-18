import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App';
import { SessionPane } from '../src/renderer/components/SessionPane';
import { getFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import type { ChatMessageItem, SendPromptInput } from '../src/shared';
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
  const state = { opened: false, calls: [] as SendPromptInput[], revised: '', streaming: true,
    draw(streaming: boolean) {
      state.streaming = streaming;
      const reply = messages[1];
      const thought = { ...reply.thoughts![0], isStreaming: streaming, isTranslating: streaming };
      root.render(<SessionPane slotIndex={0} layoutMode="single" isFocused session={state.opened ? session : null} availableSessions={[session]} availableModels={[]}
        messages={[messages[0], { ...reply, thoughts: [thought] }]} pendingApprovals={[]} approvalConfig={boot.approvalConfig}
        defaultThoughtTrack="zh" telemetryDashboard={boot.telemetry} scrollMemoryRef={scroll} canTriggerDemoApproval={false} appIcon="gravity-claude-dark"
        onFocusPane={noop} onBindSlotSession={() => { state.opened = true; state.draw(state.streaming); }} onOpenNewSession={noop} onReviseMessage={async input => { state.revised = input.text; }}
        onSendPrompt={async input => { state.calls.push(input); }} onCancelPrompt={done} onCompactContext={done} onSetSessionMode={done}
        onSetSessionEffort={done} onSetSessionModel={done} onQueryWorkspaceFiles={async () => []} onSubmitApproval={done} onCycleApprovalMode={done}
        onOpenApprovalSettings={noop} onOpenSwarmInspector={noop} onOpenContextInspector={noop} onInspectDiffFile={noop} onTriggerDemoApproval={noop} />);
    } };
  Object.assign(window, { fixture: state });
  state.draw(true);
}
void main();

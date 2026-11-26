import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SwarmPanel } from '../src/renderer/components/SwarmPanel';
import { SwarmTracker } from '../src/main/swarm/swarm-tracker';
import type { SwarmHistoryCursor } from '../src/shared';
afterEach(cleanup);

let swarmCallSeq = 0;
function consumeSwarmTool(
  tracker: SwarmTracker,
  sessionId: string,
  name: string,
  rawInput: Record<string, unknown>,
  rawOutput: Record<string, unknown> = {}
) {
  tracker.consume(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: `swarm-reg-${++swarmCallSeq}`,
    name,
    rawInput,
    rawOutput,
    status: 'completed',
  });
}

it('消息板显示服务单列的接收者，不把发给不同成员的同文消息折叠为一组', () => {
  const tracker = new SwarmTracker();
  for (const recipient of ['alpha', 'beta']) {
    consumeSwarmTool(tracker, 'A', 'post_message', { sender: 'lead', channel: 'main', content: '请检查最新结果', mentions: [recipient] });
  }
  render(<SwarmPanel sessionId="A" topology={tracker.getState('A')} onLaunchSwarmTask={async () => {}} />);
  expect(screen.getByText('@alpha')).toBeTruthy();
  expect(screen.getByText('@beta')).toBeTruthy();
  expect(screen.getAllByText('请检查最新结果')).toHaveLength(2);
});

it('按聚焦会话保留草稿，失败后可重试，打开另一个会话时还原该会话的内容', async () => {
  const tracker = new SwarmTracker();
  consumeSwarmTool(tracker, 'A', 'post_message', { sender: 'lead', content: 'Message with no workers' });
  const launch = vi.fn(async (_id: string, _text: string) => {});
  launch.mockRejectedValueOnce(Error('暂时无法提交'));
  const panel = (id: string) => (
    <SwarmPanel sessionId={id} topology={tracker.getState(id)} onLaunchSwarmTask={launch} />
  );
  const view = render(panel('A'));
  expect(screen.getByText('Message with no workers')).toBeTruthy();
  const input = () => screen.getByTestId('swarm-launch-input') as HTMLInputElement;
  fireEvent.change(input(), { target: { value: 'A draft' } });
  view.rerender(panel('B'));
  expect(input().value).toBe('');
  fireEvent.change(input(), { target: { value: 'B draft' } });
  view.rerender(panel('A'));
  expect(input().value).toBe('A draft');
  await act(async () => {
    fireEvent.click(screen.getByTestId('swarm-launch-btn'));
  });
  expect(input().value).toBe('A draft');
  expect(screen.getByRole('alert').textContent).toContain('暂时无法提交');
  await act(async () => {
    fireEvent.click(screen.getByTestId('swarm-launch-btn'));
  });
  expect(input().value).toBe('');
  expect(launch.mock.calls).toEqual([
    ['A', 'A draft'],
    ['A', 'A draft'],
  ]);
  view.rerender(panel('B'));
  expect(input().value).toBe('B draft');
});

it('按页查看只有消息板的记录，切换会话后迟到的上一页不会出现在新会话', async () => {
  const tracker = new SwarmTracker();
  const messages = Array.from({ length: 103 }, (_, i) => ({
    seq: i + 1,
    sender: 'user' + i,
    content: 'record ' + i,
  }));
  consumeSwarmTool(tracker, 'A', 'read_board', {}, { messages });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi.fn(async (id: string, before: SwarmHistoryCursor) => {
    await gate;
    return tracker.getState(id, before);
  });
  const panel = (id: string) => <SwarmPanel sessionId={id} topology={tracker.getState(id)} onLoadPage={load} />;
  const view = render(panel('A'));
  expect(screen.queryByText('record 0')).toBeNull();
  fireEvent.click(screen.getByTestId('swarm-earlier'));
  view.rerender(panel('B'));
  await act(async () => {
    release();
    await gate;
  });
  expect(screen.queryByText('record 50')).toBeNull();
  view.rerender(panel('A'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('swarm-earlier'));
  });
  expect(screen.getByText('record 50')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByTestId('swarm-earlier'));
  });
  expect(screen.getByText('record 0')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByTestId('swarm-newer'));
  });
  expect(screen.getByText('record 50')).toBeTruthy();
});

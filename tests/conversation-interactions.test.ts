import { describe, expect, it, vi } from 'vitest';
import { modelMessage, restoreAnnotatedMessage } from '../src/main/session/annotation-prompt';
import { AgentQuestions } from '../src/main/session/agent-questions';
import { DEFAULT_LAYOUT } from '../src/main/services/workspace-settings';
import { placeSession, workspaceSlots, writtenQuestion, type ChatMessageItem, type WorkspaceLayoutState } from '../src/shared';

const user = (content: string): ChatMessageItem => ({ id: 'u', role: 'user', sessionId: 's', createdAt: '', content });

describe('批注记录、窗格位置和提问', () => {
  it('读入中英文旧批注时去掉模板，保留带换行的原文、意见和用户追加的正文', () => {
    const zh = restoreAnnotatedMessage(user('> 原有引用\n\n【逐处标记批注 (Notations)】\n1. 针对原文「上半段\n\n下半段」：一条评论\n\n评论续行（第 7 条消息）\n\n请严格结合以上逐处标记位置与批注说明进行修改或解答。'));
    expect(zh.content).toBe('');
    expect(zh.annotations).toEqual([{ excerpt: '原有引用' }, { excerpt: '上半段\n\n下半段', comment: '一条评论\n\n评论续行', messageNumber: 7 }]);
    const en = restoreAnnotatedMessage(user('[Multi-spot Selection Notations]\n1. Regarding "La": Explain this (message 2)\n\nMy own message'));
    expect(en.content).toBe('My own message');
    expect(en.annotations).toEqual([{ excerpt: 'La', comment: 'Explain this', messageNumber: 2 }]);
    const malformed = user('[Multi-spot Selection Notations]\nA user-authored example');
    expect(restoreAnnotatedMessage(malformed)).toBe(malformed);
    expect(restoreAnnotatedMessage(user(modelMessage(en.content, en.annotations)))).toEqual(en);
  });

  it('双栏中拖换左栏不会改变原先自动分配的右栏，旧标签保持可用', () => {
    const initial: WorkspaceLayoutState = { ...DEFAULT_LAYOUT, layoutMode: 'split-2', openTabSessionIds: ['a', 'b', 'c'], activePrimarySessionId: 'a' };
    const changed = { ...initial, ...placeSession(initial, 0, 'c') };
    expect(workspaceSlots(changed)).toEqual(['c', 'b']);
    expect(workspaceSlots({ ...changed, ...placeSession(changed, 0, 'b') })).toEqual(['b', 'c']);
    expect(changed.openTabSessionIds).toEqual(['a', 'b', 'c']);
    const onlyRight = { ...DEFAULT_LAYOUT, layoutMode: 'split-2' as const };
    expect(workspaceSlots({ ...onlyRight, ...placeSession(onlyRight, 1, 'new') })).toEqual([null, 'new']);
  });

  it('读取文本提问的列表和行内选项，忽略代码示例中的问句', () => {
    expect(writtenQuestion('请选择一个：\nA. 蓝色\nB. 绿色')?.fields[0].choices?.map(c => c.label)).toEqual(['蓝色', '绿色']);
    expect(writtenQuestion('Would you prefer Teal or Amber?')?.fields[0].choices?.map(c => c.label)).toEqual(['Teal', 'Amber']);
    expect(writtenQuestion('你想选青绿还是琥珀色？')?.fields[0].choices?.map(c => c.label)).toEqual(['青绿', '琥珀色']);
    expect(writtenQuestion('```text\nshould I stop?\n```')).toBeUndefined();
    expect(writtenQuestion('```js\n1+1\n```\n是否继续？')?.fields[0].choices?.map(c => c.label)).toEqual(['是', '否']);
  });

  it('多会话原生表单隔离。错误的字段值可纠正，也能按请求取消并忽略过期回答', async () => {
    const posted: ChatMessageItem[] = [];
    const manager = new AgentQuestions(m => posted.push(m), () => true, vi.fn());
    const question = { sessionId: 'a', message: 'Pick one', requestedSchema: { type: 'object', required: ['colors'],
      properties: { colors: { type: 'array', minItems: 1, items: { type: 'string', enum: ['red','green'] } } } } };
    const one = manager.request(question, 1);
    const two = manager.request({ ...question, sessionId: 'b' }, 2);
    const [a, b] = posted;
    expect(() => manager.answer({ sessionId: 'b', messageId: a.id, action: 'accept' })).toThrow();
    expect(() => manager.answer({ sessionId: 'a', messageId: a.id, action: 'accept', values: { colors: ['wrong'] } })).toThrow();
    manager.cancel(undefined, 2);
    expect(await two).toEqual({ action: 'cancel' });
    expect(b.question?.state).toBe('cancelled');
    manager.answer({ sessionId: 'a', messageId: a.id, action: 'accept', values: { colors: ['green'] } });
    expect(await one).toEqual({ action: 'accept', content: { colors: ['green'] } });
    expect(() => manager.answer({ sessionId: 'a', messageId: a.id, action: 'decline' })).toThrow();
  });
  it('持久化失败后自定义回复可重试且只发一次，结束连接时多个未决请求仍可释放', async () => {
    const posted: ChatMessageItem[] = [];
    const queue = vi.fn();
    let broken = false;
    const manager = new AgentQuestions(m => {
      if (broken && m.question?.state !== 'open') throw Error('磁盘忙');
      posted.push(m);
    }, () => true, queue);
    const question = { sessionId: 'a', message: '请选择', requestedSchema: { properties: {} } };
    const first = manager.request(question, 1);
    const custom = { sessionId: 'a', messageId: posted[0].id, action: 'accept' as const, customReply: '我自己填写' };
    broken = true;
    expect(() => manager.answer(custom)).toThrow('磁盘忙');
    expect(posted[0].question?.state).toBe('open');
    expect(queue).not.toHaveBeenCalled();
    broken = false;
    manager.answer(custom);
    expect(await first).toEqual({ action: 'decline' });
    expect(queue).toHaveBeenCalledTimes(1);
    const two = manager.request(question, 2);
    const three = manager.request(question, 3);
    broken = true;
    expect(() => manager.cancel()).not.toThrow();
    expect(await Promise.all([two, three])).toEqual([{ action: 'cancel' }, { action: 'cancel' }]);
  });
});

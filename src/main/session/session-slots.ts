import { AcpClient, AcpRequestNotSentError, AcpRpcError } from '../acp/acp-client';
import type { AcpSessionNewResult } from '../../shared/acp-protocol';
import { MAX_PARALLEL_ACTIVE_SESSIONS } from '../../shared/session-contract';

type Slot = {
  sessionId?: string;
  hidden: boolean;
  state: 'unsent' | 'rejected' | 'unknown' | 'active';
};

/** A reservation survives its caller when the server may still own a session. */
export class SessionSlots {
  private readonly slots = new Set<Slot>();
  constructor(private readonly client: AcpClient) {}
  get count(): number { return this.slots.size; }
  clear(): void { this.slots.clear(); }
  find(id: string) { return [...this.slots].find(slot => slot.sessionId === id); }

  reserve(hidden: boolean, sessionId?: string): Slot {
    if (sessionId && this.find(sessionId)) throw new Error('正在等待官方结算此会话');
    if (this.count >= MAX_PARALLEL_ACTIVE_SESSIONS) throw new Error('最多同时打开 4 个活动会话，请先关闭一个标签页');
    const slot: Slot = { hidden, sessionId, state: 'unsent' };
    this.slots.add(slot);
    return slot;
  }

  releaseUnused(slot: Slot): void {
    if (slot.state === 'unsent' || slot.state === 'rejected') this.slots.delete(slot);
  }

  async open(slot: Slot, method: string, params: unknown, budget?: { charge(): void; refund(): void }): Promise<AcpSessionNewResult> {
    if (!this.slots.has(slot)) throw new AcpRequestNotSentError('连接已关闭');
    budget?.charge();
    slot.state = 'unknown';
    let result: AcpSessionNewResult;
    try {
      result = await this.client.request<AcpSessionNewResult>(method, params, undefined, reply => {
        if (!this.slots.has(slot) || slot.state !== 'unknown') return;
        if (reply.error) this.slots.delete(slot);
        else if (this.identify(slot, reply.result as AcpSessionNewResult) && (slot.hidden || method === 'session/new')) {
          // Only the transport owning this reservation can close a late session.
          void this.close(slot).catch(() => this.client.emit('diagnostic', '延迟创建的会话尚未确认关闭'));
        }
      });
    } catch (error) {
      if (error instanceof AcpRequestNotSentError) {
        budget?.refund();
        slot.state = 'unsent';
      } else if (error instanceof AcpRpcError) slot.state = 'rejected';
      throw error;
    }
    if (!this.slots.has(slot)) throw new Error('会话创建期间连接已关闭');
    if (!this.identify(slot, result)) throw new Error('官方 ACP 返回了无效或重复会话 ID');
    return result;
  }

  private identify(slot: Slot, result: AcpSessionNewResult | undefined): boolean {
    const id = result?.sessionId ?? slot.sessionId;
    if (typeof id !== 'string' || !id || (slot.sessionId && id !== slot.sessionId) ||
        [...this.slots].some(other => slot !== other && other.sessionId === id)) return false;
    slot.sessionId = id;
    slot.state = 'active';
    return true;
  }

  async close(slot: Slot, onClosed?: () => void): Promise<void> {
    if (!this.slots.has(slot)) return;
    if (!this.client.initializeResult?.agentCapabilities.sessionCapabilities?.close) {
      throw new Error('当前官方 ACP 不支持关闭单个会话；请退出客户端以释放所有会话');
    }
    const settle = () => { if (this.slots.delete(slot)) onClosed?.(); };
    await this.client.request('session/close', { sessionId: slot.sessionId }, undefined, reply => {
      if ('result' in reply && !reply.error) settle();
    });
    settle();
  }
}

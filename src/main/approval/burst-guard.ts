import type { ApprovalGuardActivityEvent } from '../../shared/approval-contract';
interface SessionBurstTracker {
  timestamps: number[];
  proactiveBurstUntil: number;
  timer?: NodeJS.Timeout;
}

export const BURST_WINDOW_MS = 45_000;
const BURST_THRESHOLD = 2;
export class BurstGuard {
  private burstTrackers = new Map<string, SessionBurstTracker>();
  constructor(private now: () => number, private guardActivity: (id: string, kind: ApprovalGuardActivityEvent['kind'], message: string, activeCount: number) => void) {}
  enableBurstGuard(sessionId: string, durationMs = 120_000): void {
    const tracker = this.ensureBurstTracker(sessionId);
    if (tracker.timer) clearTimeout(tracker.timer);
    const wasActive = this.now() < tracker.proactiveBurstUntil;
    tracker.proactiveBurstUntil = Math.max(tracker.proactiveBurstUntil, this.now() + durationMs);
    tracker.timer = setTimeout(() => this.resetTurnBurstCounter(sessionId), Math.max(0, tracker.proactiveBurstUntil - this.now()));
    tracker.timer.unref();
    if (!wasActive) this.guardActivity(sessionId, 'burst-guard-enabled', '本会话已开启连续操作守卫', tracker.timestamps.length || 1);
  }

  resetTurnBurstCounter(sessionId: string): void {
    const tracker = this.burstTrackers.get(sessionId);
    if (!tracker) return;
    if (tracker.timer) clearTimeout(tracker.timer);
    this.burstTrackers.delete(sessionId);
    if (tracker.proactiveBurstUntil) this.guardActivity(sessionId, 'burst-guard-cleared', '本会话连续操作守卫已结束', 0);
  }

  private ensureBurstTracker(sessionId: string): SessionBurstTracker {
    let tracker = this.burstTrackers.get(sessionId);
    if (!tracker) {
      tracker = { timestamps: [], proactiveBurstUntil: 0 };
      this.burstTrackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /** 每个会话独立维护滑动时间窗，过期请求先移出计数。连续操作和计划触发的守卫有效期在此合并判定。 */
  recordBurstRequest(sessionId: string): void {
    const now = this.now();
    const tracker = this.ensureBurstTracker(sessionId);
    tracker.timestamps = tracker.timestamps.filter((ts) => now - ts <= BURST_WINDOW_MS);
    tracker.timestamps.push(now);
    if (tracker.timestamps.length >= BURST_THRESHOLD) this.enableBurstGuard(sessionId, BURST_WINDOW_MS);
  }

  dispose(): void { for (const id of this.burstTrackers.keys()) this.resetTurnBurstCounter(id); }
}

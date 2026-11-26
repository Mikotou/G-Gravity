import { setTimeout as delay } from 'node:timers/promises';
import type { AcpChildProcess } from './acp-types';

function firstEvent(child: AcpChildProcess, events: string[]): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      for (const event of events) child.off(event, done);
      resolve();
    };
    for (const event of events) child.on(event, done);
  });
}

async function waitAtMost(event: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([event, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}

/** Only used for a child that we launched as a new process-group leader on macOS. */
export class MacAcpProcessGroup {
  private readonly parentEnded: Promise<void>;
  private readonly pipesClosed: Promise<void>;
  constructor(private readonly child: AcpChildProcess, private readonly pid: number) {
    this.parentEnded = firstEvent(child, ['exit', 'close', 'error']);
    this.pipesClosed = firstEvent(child, ['close']);
  }

  private signal(signal: NodeJS.Signals | 0): boolean {
    try { return process.kill(-this.pid, signal); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') {
        if (this.child.exitCode != null || this.child.signalCode != null) return false;
        try { process.kill(this.pid, 0); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return false; }
      }
      throw error;
    }
  }

  async close(graceful: boolean): Promise<void> {
    try {
      if (graceful && this.child.stdin && !this.child.stdin.destroyed) {
        try {
          this.child.stdin.end();
          await waitAtMost(this.parentEnded, 700);
        } catch { /* A broken pipe can still have a live process group. */ }
      }
      // The group can outlive its leader when a tool inherits stdout or stderr.
      if (this.signal('SIGTERM')) {
        for (let attempt = 0; attempt < 10; attempt++) {
          if (!this.signal(0)) return;
          await delay(25);
        }
        if (this.signal(0)) {
          this.signal('SIGKILL');
          for (let attempt = 0; attempt < 20; attempt++) {
            if (!this.signal(0)) return;
            await delay(25);
          }
          if (this.signal(0)) throw new Error('未能确认 ACP 进程组已退出');
        }
      }
    } finally {
      // Give Node time to deliver the parent's final reply before releasing its pipes.
      await waitAtMost(this.pipesClosed, 400);
      this.child.stdin?.destroy();
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
    }
  }
}

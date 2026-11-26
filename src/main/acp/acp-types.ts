import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';

export interface AcpChildProcess extends EventEmitter {
  stdin: Writable | null; stdout: Readable | null; stderr: Readable | null;
  pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; kill(signal?: NodeJS.Signals | number): boolean;
}
export type AcpSpawn = (binary: string, args: string[], options: SpawnOptions) => AcpChildProcess;
export interface AcpClientOptions {
  binaryPath?: string; args?: string[]; processPerSession?: boolean; cwd?: string; spawn?: AcpSpawn;
  requestTimeoutMs?: number; maxLineBytes?: number;
  loginLauncher?: (binary: string, args?: string[]) => Promise<void>;
}

export interface AcpDiagnosticContext {
  lastError?: string;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  readonly cooldownUntilMs: number;
}

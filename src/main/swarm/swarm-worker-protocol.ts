import type { SwarmTopologyState } from '../../shared/swarm-contract';
import type { SwarmTracker } from './swarm-tracker';

type Method = 'trackNew' | 'beginReplay' | 'finishReplay' | 'discardReplay' | 'consume' | 'markUnconfirmed'
  | 'disconnected' | 'remove' | 'needsReplay' | 'getState' | 'flush' | 'clear';
export type SwarmCommand = { [K in Method]: { method: K; args: Parameters<SwarmTracker[K]> } }[Method];
export type SwarmRequest = SwarmCommand & { id: number };
export type SwarmReply = { id: number; value?: unknown; error?: string } | { updated: SwarmTopologyState };
export interface SwarmWorkerData { directory: string; profile: string; owned: string[] }

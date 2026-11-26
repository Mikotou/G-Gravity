import { parentPort, workerData } from 'node:worker_threads';
import { ClientStore } from '../storage/client-store';
import { SwarmTracker } from './swarm-tracker';
import type { SwarmRequest, SwarmWorkerData } from './swarm-worker-protocol';

const port = parentPort!;
const { directory, profile, owned } = workerData as SwarmWorkerData;
const tracker = new SwarmTracker(new ClientStore(directory));
tracker.setProfile(profile, new Set(owned));
tracker.on('updated', state => port.postMessage({ updated: state }));
// A single port owns this connection. Each command commits before the next read or barrier can start.
port.on('message', (request: SwarmRequest) => {
  try {
    const value = Reflect.apply(tracker[request.method], tracker, request.args);
    port.postMessage({ id: request.id, value });
  } catch (error) {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

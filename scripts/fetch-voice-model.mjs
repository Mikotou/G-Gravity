import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { model } = require('../assets/local-voice/sources.json');
const { readVerified, install } = require('../assets/local-voice/model.cjs');
const root = dirname(fileURLToPath(new URL('../assets/local-voice/worker.cjs', import.meta.url)));
const path = join(root, model.fileName);
try {
  await readVerified(path);
} catch {
  await install(root, AbortSignal.timeout(600_000));
  await readVerified(path);
}
console.log(model.fileName, model.sizeBytes, model.sha256);

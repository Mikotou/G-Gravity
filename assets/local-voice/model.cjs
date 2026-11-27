'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, mkdir, open, realpath, rename, unlink } = require('node:fs/promises');
const { join, relative, resolve } = require('node:path');
const { model } = require('./sources.json');

async function literalPath(path) {
  const full = resolve(path);
  const alias = process.platform === 'darwin' && /^\/(tmp|var|etc)(?=\/|$)/.exec(full);
  if (alias && (await lstat(alias[0])).isSymbolicLink() && await realpath(alias[0]) === '/private' + alias[0]) {
    return '/private' + full;
  }
  return full;
}

async function checkedDirectory(dir) {
  if (relative(await literalPath(dir), await realpath(dir)) !== '' || !(await lstat(dir)).isDirectory()) {
    throw Error('Voice model directory is redirected');
  }
}

async function readVerified(file) {
  const before = await lstat(file, { bigint: true });
  const valid = s => s.isFile() && s.nlink === 1n && s.size === BigInt(model.sizeBytes);
  if (!valid(before) || relative(await literalPath(file), await realpath(file)) !== '') throw Error('Invalid voice model file');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  const handle = await open(file, flags);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!valid(stat) || stat.ino !== before.ino) throw Error('Voice model changed');
    const bytes = Buffer.allocUnsafeSlow(model.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('Incomplete voice model');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (!valid(after) || !valid(current) || current.ino !== stat.ino || after.ctimeNs !== stat.ctimeNs ||
        relative(await literalPath(file), await realpath(file)) !== '' ||
        createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw Error('Voice model integrity check failed');
    return bytes;
  } finally { await handle.close(); }
}

async function install(dir, signal, progress = () => {}, fetcher = fetch) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkedDirectory(dir);
  const target = join(dir, model.fileName);
  const tmp = join(dir, '.' + randomUUID() + '.tmp');
  const handle = await open(tmp, 'wx', 0o600);
  let closed = false;
  try {
    const response = await fetcher(model.downloadUrl, { signal });
    if (!response.ok || !response.body) throw Error('Voice model download failed');
    let received = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      received += chunk.byteLength;
      if (received > model.sizeBytes) throw Error('Voice model size exceeded');
      await handle.writeFile(chunk);
      hash.update(chunk);
      progress(received);
    }
    if (received !== model.sizeBytes || hash.digest('hex') !== model.sha256) throw Error('Voice model integrity check failed');
    await handle.sync();
    await handle.close();
    closed = true;
    await checkedDirectory(dir);
    // Validate the on-disk bytes as well as the transport stream before publishing.
    await readVerified(tmp);
    signal?.throwIfAborted();
    await rename(tmp, target);
  } finally {
    if (!closed) await handle.close();
    await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

module.exports = { readVerified, install };

'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { constants, lstatSync, realpathSync } = require('node:fs');
const { mkdir, open, rename, unlink } = require('node:fs/promises');
const { dirname, join, parse, resolve, sep } = require('node:path');
const { model } = require('./sources.json');

function literalPath(path) {
  const full = resolve(path);
  const alias = process.platform === 'darwin' && /^\/(tmp|var|etc)(?=\/|$)/i.exec(full);
  if (alias && lstatSync(alias[0]).isSymbolicLink()) {
    const canonical = '/private' + alias[0].toLowerCase();
    if (realpathSync.native(alias[0]) === canonical) return canonical + full.slice(alias[0].length);
  }
  return full;
}

const sameIdentity = (a, b) => a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
function checkedPath(path) {
  const full = literalPath(path);
  const root = parse(full).root;
  const parts = full.slice(root.length).split(sep).filter(Boolean);
  let cursor = root, stat = lstatSync(root, { bigint: true });
  const identities = parts.map(name => {
    cursor = join(cursor, name);
    stat = lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw Error('Redirected voice model path');
    return stat;
  });
  const resolved = realpathSync.native(full);
  if (resolved === full) return stat;
  let right = parse(resolved).root;
  const names = resolved.slice(right.length).split(sep).filter(Boolean);
  if (root.toLowerCase() !== right.toLowerCase() || parts.length !== names.length) throw Error('Redirected voice model path');
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i], actual = names[i];
    right = join(right, actual);
    if (name === actual) continue;
    const spelling = process.platform === 'darwin' && name.normalize('NFC').toLowerCase() === actual.normalize('NFC').toLowerCase();
    const windows = process.platform === 'win32' && (name.toLowerCase() === actual.toLowerCase() ||
      [name, actual].some(n => /~\d+(?:\.|$)/.test(n)));
    const canonical = lstatSync(right, { bigint: true });
    if ((!spelling && !windows) || canonical.isSymbolicLink() || !sameIdentity(identities[i], canonical)) throw Error('Redirected voice model path');
  }
  return stat;
}

async function checkedDirectory(dir, create = false) {
  let stat;
  try { stat = checkedPath(dir); } catch (error) {
    if (!create || error.code !== 'ENOENT' || dirname(dir) === dir) throw error;
    await checkedDirectory(dirname(dir), true);
    try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    stat = checkedPath(dir);
  }
  if (!stat.isDirectory()) throw Error('Invalid voice model directory');
  return stat;
}

async function readVerified(file) {
  const before = checkedPath(file);
  const valid = s => s.isFile() && s.nlink === 1n && s.size === BigInt(model.sizeBytes);
  if (!valid(before)) throw Error('Invalid voice model file');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  const handle = await open(file, flags);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!valid(stat) || !sameIdentity(stat, before)) throw Error('Voice model changed');
    const bytes = Buffer.allocUnsafeSlow(model.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('Incomplete voice model');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = checkedPath(file);
    if (!valid(after) || !valid(current) || !sameIdentity(current, stat) ||
        current.ctimeNs !== stat.ctimeNs || after.ctimeNs !== stat.ctimeNs ||
        createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw Error('Voice model integrity check failed');
    return bytes;
  } finally { await handle.close(); }
}

async function install(dir, signal, progress = () => {}, fetcher = fetch) {
  dir = resolve(dir);
  const destination = await checkedDirectory(dir, true);
  const target = join(dir, model.fileName);
  const tmp = join(dir, '.' + randomUUID() + '.tmp');
  const handle = await open(tmp, 'wx', 0o600);
  let ownFile, closed = false;
  try {
    ownFile = await handle.stat({ bigint: true });
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
    if (!sameIdentity(destination, await checkedDirectory(dir))) throw Error('Voice model directory changed');
    // Validate the on-disk bytes as well as the transport stream before publishing.
    await readVerified(tmp);
    if (!sameIdentity(ownFile, checkedPath(tmp))) throw Error('Voice model download changed');
    signal?.throwIfAborted();
    await rename(tmp, target);
  } finally {
    if (!closed) await handle.close();
    try {
      if (ownFile && sameIdentity(destination, await checkedDirectory(dir)) && sameIdentity(ownFile, checkedPath(tmp))) await unlink(tmp);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { readVerified, install };

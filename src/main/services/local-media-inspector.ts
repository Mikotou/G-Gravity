import type { SessionOwner } from '../../shared/session-owner';
import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractTargetBaseName, isPlausibleLocalFileCandidate, isSupportedPreviewImageExt,
  stripLocalTargetAnchor, MAX_INLINE_PREVIEW_BYTES, MAX_LOCAL_INSPECT_TARGETS,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES, type InspectedLocalTarget, type InspectLocalTargetsInput,
  type InspectLocalTargetsResult,
} from '../../shared/media-contract';
import {
  isPrivateStatePath, isUnsafeLocalFile, isUnsafeLocalPath, openLocalFile, readPrefix,
  localPathMember, normalizeDarwinSystemAlias, sameLocalPath,
} from '../workspace/local-path-safety';
import { EXECUTABLE_OR_SCRIPT_EXT_RE } from '../../shared/media-contract';

const mimeTypes: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', json: 'application/json',
  html: 'text/html', css: 'text/css', js: 'text/javascript', md: 'text/markdown', txt: 'text/plain',
};
export function localImageMimeType(file: string): string | undefined {
  const mime = mimeTypes[extname(file).slice(1).toLowerCase()];
  return typeof mime === 'string' && mime.startsWith('image/') ? mime : undefined;
}

function isExecutableOrScript(file: string): boolean {
  return EXECUTABLE_OR_SCRIPT_EXT_RE.test(extname(file));
}

export function isExecutableTarget(real: string, requested: string, stat: Stats): boolean {
  return isExecutableOrScript(real) || isExecutableOrScript(requested) ||
    (process.platform !== 'win32' && stat.isFile() && (stat.mode & 0o111) !== 0);
}

export interface LocalTargetContext { homeDir?: string; appDataRoot?: string; profileId?: string; owns?: (owner: SessionOwner) => boolean }
interface ArtifactScope { root: string; anchor: string }
interface Candidate { path: string; relativeToWorkspace?: boolean; artifact?: ArtifactScope }

function localPaths(raw: string): string[] {
  const path = stripLocalTargetAnchor(raw);
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== 'localhost') return [];
      return [fileURLToPath(url)];
    } catch { return []; }
  }
  if (!path || (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) return [];
  // OS filenames can contain literal %20. Markdown links can also encode a space.
  try {
    const decoded = decodeURIComponent(path);
    if (decoded !== path) return [path, decoded];
  } catch { /* Keep a literal percent in a filename. */ }
  return [path];
}

function candidates(path: string, cwd: string | undefined, home: string, scopes: ArtifactScope[]): Candidate[] {
  if (isUnsafeLocalFile(path)) return [{ path }];
  if (/^~[\\/]/.test(path)) return [{ path: resolve(home, path.slice(2)) }];
  if (isAbsolute(path)) return [{ path: resolve(path) }];
  const result: Candidate[] = [];
  if (cwd && isAbsolute(cwd)) result.push({ path: resolve(cwd, path), relativeToWorkspace: true });
  if (!path.split(/[\\/]/).includes('..')) {
    for (const artifact of scopes) result.push({ path: resolve(artifact.root, path), artifact });
  }
  return result;
}

function expectedArtifactRoot({ root, anchor }: ArtifactScope): string {
  return resolve(realpathSync.native(anchor), relative(anchor, root));
}

/** Verify the root from its trusted anchor without accepting a redirected brain or session directory. */
function artifactMember(scope: ArtifactScope, target: string): string | undefined {
  const expected = expectedArtifactRoot(scope);
  const actual = realpathSync.native(scope.root);
  if (!sameLocalPath(expected, actual)) return;
  let root = realpathSync.native(scope.anchor);
  for (const part of relative(scope.anchor, scope.root).split(sep)) {
    root = join(root, part);
    if (lstatSync(root).isSymbolicLink()) return;
  }
  return localPathMember(actual, target);
}

function canonicalWorkspace(cwd?: string): string | undefined {
  if (!cwd || !isAbsolute(cwd) || isUnsafeLocalPath(cwd)) return;
  try {
    const root = realpathSync.native(cwd);
    if (!isUnsafeLocalPath(root)) return root;
  } catch { /* An explicit target can still exist when its workspace has gone away. */ }
}

/** Check whether a candidate path targets inside the workspace across APFS case/NFD, /tmp aliases, and symlinked cwd. */
function targetsWorkspace(candidatePath: string, cwd?: string, workspaceRoot?: string): boolean {
  if (cwd && isAbsolute(cwd) && localPathMember(cwd, candidatePath) !== undefined) return true;
  if (workspaceRoot && localPathMember(workspaceRoot, candidatePath) !== undefined) return true;
  if (!cwd || !workspaceRoot || !isAbsolute(cwd)) return false;
  const base = normalizeDarwinSystemAlias(resolve(cwd));
  const target = normalizeDarwinSystemAlias(resolve(candidatePath));
  const volume = parse(target).root;
  const depth = base.slice(parse(base).root.length).split(sep).filter(Boolean).length;
  const parts = target.slice(volume.length).split(sep).filter(Boolean);
  if (parts.length < depth) return false;
  try { return sameLocalPath(workspaceRoot, realpathSync.native(join(volume, ...parts.slice(0, depth)))); }
  catch { return false; }
}

type LocalResolution = { kind: 'found'; path: string; candidatePath: string; workspaceRoot?: string } | { kind: 'missing'; path?: string } | { kind: 'forbidden' };
export function resolveLocalTarget(raw: string, input: { cwd?: string; sessionId?: string; profileId?: string; owner?: SessionOwner }, context: LocalTargetContext, restrictWorkspaceLinks = false): LocalResolution {
  const home = context.homeDir || homedir();
  const { cwd, owner } = input;
  const sessionId = input.sessionId ?? owner?.sessionId;
  const profileId = input.profileId ?? owner?.profileId ?? context.profileId;
  const authorized = !!sessionId && !!profileId && profileId === context.profileId &&
    (!owner || (owner.sessionId === sessionId && owner.profileId === profileId)) &&
    context.owns?.({ profileId, sessionId, epoch: owner?.epoch }) === true;
  const inProfileStore = (path: string) => context.appDataRoot && localPathMember(context.appDataRoot, path) !== undefined;
  const workspaceRoot = restrictWorkspaceLinks ? canonicalWorkspace(cwd) : undefined;
  const stores = context.appDataRoot ? [context.appDataRoot] : ['antigravity-cli', 'antigravity'].map(name => join(home, '.gemini', name));
  const scopes = authorized && sessionId && /^[a-z0-9_-]{1,100}$/i.test(sessionId)
    ? stores.map(store => ({ root: join(store, 'brain', sessionId), anchor: context.appDataRoot ? dirname(store) : home })) : [];
  const choices = localPaths(raw).flatMap(path => candidates(path, cwd, home, scopes));
  const paths = [...choices.filter(c => !c.artifact), ...choices.filter(c => c.artifact)];
  for (const candidate of paths) {
    if (isUnsafeLocalFile(candidate.path)) return { kind: 'forbidden' };
    let artifact = candidate.artifact;
    if (!artifact && (isPrivateStatePath(candidate.path) || inProfileStore(candidate.path))) {
      // An explicit file URL can use either the home-directory spelling or its canonical /private path.
      artifact = scopes.find(scope => {
        if (localPathMember(scope.root, candidate.path) !== undefined) return true;
        try { return localPathMember(expectedArtifactRoot(scope), candidate.path) !== undefined; } catch { return false; }
      });
      if (!artifact) return { kind: 'forbidden' };
    }
    let real: string;
    try { real = realpathSync.native(candidate.path); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return { kind: 'forbidden' };
      continue;
    }
    if (isUnsafeLocalFile(real)) return { kind: 'forbidden' };
    if (artifact) {
      const member = artifactMember(artifact, real);
      if (member === undefined || isPrivateStatePath(member) ||
          /(?:^|[\\/])\.system_generated(?:[\\/]|$)|\.pb$/i.test(member)) return { kind: 'forbidden' };
    } else {
      if (isPrivateStatePath(real) || inProfileStore(real)) return { kind: 'forbidden' };
      if (restrictWorkspaceLinks && (candidate.relativeToWorkspace || targetsWorkspace(candidate.path, cwd, workspaceRoot)) &&
          (!workspaceRoot || localPathMember(workspaceRoot, real) === undefined)) return { kind: 'forbidden' };
    }
    return { kind: 'found', path: real, candidatePath: candidate.path, workspaceRoot };
  }
  return { kind: 'missing', path: paths[0]?.path };
}

type Dimensions = [width: number, height: number];
function headerDimensions(b: Buffer, ext: string): Dimensions | undefined {
  if (ext === 'png' && b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR')
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (ext === 'gif' && b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6)))
    return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (ext === 'bmp' && b.length >= 26 && b.toString('ascii', 0, 2) === 'BM') {
    if (b.readUInt32LE(14) === 12) return [b.readUInt16LE(18), b.readUInt16LE(20)];
    if (b.readUInt32LE(14) >= 40) return [b.readInt32LE(18), Math.abs(b.readInt32LE(22))];
  }
  if ((ext === 'jpg' || ext === 'jpeg') && b[0] === 0xff && b[1] === 0xd8) {
    let pos = 2;
    while (pos + 3 < b.length && b[pos] === 0xff) {
      while (b[pos] === 0xff) pos++;
      const marker = b[pos++];
      if (marker === 0xda || marker === 0xd9 || pos + 2 > b.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = b.readUInt16BE(pos);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc2 && length >= 7 && pos + 7 <= b.length)
        return [b.readUInt16BE(pos + 5), b.readUInt16BE(pos + 3)];
      pos += length;
    }
  }
  if (ext === 'webp' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = b.toString('ascii', 12, 16);
    if (fourcc === 'VP8X' && b.length >= 30) return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (fourcc === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    if (fourcc === 'VP8 ' && b.length >= 30 && b.readUIntLE(23, 3) === 0x2a019d)
      return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (ext === 'ico' && b.length >= 6 && b.readUInt32LE(0) === 0x10000) {
    let largest: Dimensions | undefined;
    for (let i = 0, pos = 6; i < b.readUInt16LE(4) && pos + 16 <= b.length; i++, pos += 16) {
      const width = b[pos] || 256, height = b[pos + 1] || 256;
      if (!largest || width * height > largest[0] * largest[1]) largest = [width, height];
    }
    return largest;
  }
  if (ext === 'svg') {
    const tag = /<svg\b[^>]*>/i.exec(b.toString('utf8'))?.[0] || '';
    const length = (name: string) => Number(new RegExp('\\s' + name + '\\s*=\\s*["\\x27]\\s*([\\d.]+)(?:px)?\\s*["\\x27]', 'i').exec(tag)?.[1]);
    const width = length('width'), height = length('height');
    if (width > 0 && height > 0) return [width, height];
    const box = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1].trim().split(/[\s,]+/).map(Number);
    if (box?.length === 4 && box.every(Number.isFinite)) return [box[2], box[3]];
  }
}

const previews = new Map<string, string>();
let cachedBytes = 0;
function cachePreview(key: string, data: string): void {
  cachedBytes -= previews.get(key)?.length || 0;
  previews.set(key, data);
  cachedBytes += data.length;
  while (previews.size > 64 || cachedBytes > 32 * 1024 * 1024) {
    const oldest = previews.keys().next().value!;
    cachedBytes -= previews.get(oldest)!.length;
    previews.delete(oldest);
  }
}

function parentHint(parent: string, workspaceRoot?: string): string {
  const member = workspaceRoot ? localPathMember(workspaceRoot, parent) : undefined;
  return member !== undefined ? member || '.' : basename(parent);
}

async function inspectOne(rawTarget: string, input: InspectLocalTargetsInput, context: LocalTargetContext, previewBudget: number): Promise<InspectedLocalTarget> {
  const fileName = extractTargetBaseName(rawTarget);
  const missing: InspectedLocalTarget = { rawTarget, fileName, kind: 'missing', exists: false };
  // A structured link target can contain a literal space, including in relative filenames.
  const plausible = rawTarget.replaceAll(' ', '%20');
  const directoryOnly = !isPlausibleLocalFileCandidate(plausible);
  // Explicit workspace directory names have no extension and often look like ordinary words.
  if (directoryOnly && (!(input.cwd || input.sessionId) || rawTarget.length > 400 ||
      !/^[\p{L}\p{N}_][\p{L}\p{N}_. /\\-]*$/u.test(rawTarget) ||
      !isPlausibleLocalFileCandidate('./' + rawTarget))) return missing;
  try {
    const target = resolveLocalTarget(rawTarget, input, context, true);
    if (target.kind === 'forbidden') return { ...missing, kind: 'forbidden' };
    if (target.kind === 'missing') return missing;
    const real = target.path, parent = dirname(real);
    const stat = statSync(real);
    const executable = isExecutableTarget(real, target.candidatePath, stat);
    const item: InspectedLocalTarget = { rawTarget, fileName: basename(real), exists: true, resolvedPath: real,
      fileUrl: pathToFileURL(real).href, parentHint: parentHint(parent, target.workspaceRoot), kind: 'directory', isExecutable: executable };
    if (stat.isDirectory()) return item;
    if ((directoryOnly && !executable) || !stat.isFile()) return missing;
    const ext = extname(real).slice(1).toLowerCase();
    item.ext = ext;
    item.kind = isSupportedPreviewImageExt(ext) ? 'image' : 'file';
    item.mimeType = Object.hasOwn(mimeTypes, ext) ? mimeTypes[ext] : 'application/octet-stream';
    item.sizeBytes = stat.size;
    if (item.kind !== 'image' && ext !== 'ico') return item;
    const { handle, stat: current } = await openLocalFile(real, stat);
    try {
      item.sizeBytes = current.size;
      const header = await readPrefix(handle, Math.min(current.size, 64 * 1024));
      const dims = headerDimensions(header, ext);
      if (dims && dims.every(n => Number.isFinite(n) && n > 0)) {
        [item.width, item.height] = dims;
        item.aspectRatio = dims[0] / dims[1];
      }
      if (input.includePreviewData !== false && item.kind === 'image' && current.size <= Math.min(previewBudget, MAX_INLINE_PREVIEW_BYTES)) {
        const key = JSON.stringify([real, current.dev, current.ino, current.ctimeMs, current.mtimeMs, current.size]);
        let url = previews.get(key);
        if (url !== undefined) {
          previews.delete(key);
          previews.set(key, url);
        } else {
          const bytes = header.length === current.size ? header : await readPrefix(handle, current.size);
          if (bytes.length !== current.size) return item;
          url = 'data:' + item.mimeType + ';base64,' + bytes.toString('base64');
        }
        const after = await handle.stat();
        const pathStat = lstatSync(real);
        if (current.ctimeMs !== after.ctimeMs || current.size !== after.size || current.mtimeMs !== after.mtimeMs ||
            stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.ctimeMs !== pathStat.ctimeMs ||
            relative(real, realpathSync.native(target.candidatePath)) !== '') return missing;
        cachePreview(key, url);
        item.previewDataUrl = url;
      }
    } finally { await handle.close(); }
    return item;
  } catch { return missing; }
}

export async function inspectLocalTargets(input: InspectLocalTargetsInput, context: LocalTargetContext = {}): Promise<InspectLocalTargetsResult> {
  if (!Array.isArray(input?.targets)) throw new Error('无效的本地文件列表');
  const items: InspectLocalTargetsResult['items'] = Object.create(null);
  let budget = MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES;
  for (const raw of new Set(input.targets.slice(0, MAX_LOCAL_INSPECT_TARGETS))) {
    if (typeof raw !== 'string') continue;
    const item = await inspectOne(raw, input, context, budget);
    if (input.owner && !context.owns?.(input.owner)) {
      items[raw] = { rawTarget: raw, fileName: extractTargetBaseName(raw), kind: 'forbidden', exists: false };
      continue;
    }
    if (item.previewDataUrl) budget -= item.sizeBytes!;
    items[raw] = item;
  }
  return { items };
}

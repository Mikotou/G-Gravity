// @vitest-environment node
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpClient } from '../src/main/acp/acp-client';
import { CoreService } from '../src/main/core-service';
import { registerIpcRouter } from '../src/main/ipc-router';
import { appendImage } from '../src/main/session/message-images';
import {
  extractLineAnchorBadge,
  extractTargetBaseName,
  formatByteSize,
  IPC_CHANNELS,
  isBareExtensionOrFragment,
  isPlausibleLocalFileCandidate,
  isPreviewableImagePath,
  isSupportedPreviewImageExt,
  MAX_INLINE_PREVIEW_BYTES,
  MAX_LOCAL_INSPECT_TARGETS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES,
  stripLocalTargetAnchor,
  type AcpSessionPromptParams,
  type ChatMessageItem,
} from '@shared';
import { createCoreBridge } from './helpers/core-bridge';

/* ============================================================================
 * Binary Fixtures (Real spec-compliant PNG, SVG, ICO generators)
 * ========================================================================== */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** Generate a 100% valid spec-compliant PNG buffer with exact pixel width & height. */
function createValidPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB color type
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // Each scanline: 1 filter byte (0) + width * 3 bytes
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  const compressed = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Generate a valid ICO buffer embedding a 32x32 PNG frame. */
function createValidIco(size = 32): Buffer {
  const png = createValidPng(size, size);
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(1, 4); // count: 1
  header[6] = size >= 256 ? 0 : size; // width
  header[7] = size >= 256 ? 0 : size; // height
  header[8] = 0; // colorCount
  header[9] = 0; // reserved
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bitCount
  header.writeUInt32LE(png.length, 14); // bytesInRes
  header.writeUInt32LE(22, 18); // imageOffset
  return Buffer.concat([header, png]);
}

function snapshotTree(root: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        out[rel] = { size: -1, mtimeMs: -1 };
      } else if (entry.isDirectory()) {
        out[rel] = { size: -2, mtimeMs: -2 };
        walk(full);
      } else {
        const st = statSync(full);
        out[rel] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(root);
  return out;
}

function tryCreateFileSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

/* ============================================================================
 * Test Lifecycle & CoreService Fixture
 * ========================================================================== */

const tempDirs: string[] = [];
const services: CoreService[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createCoreFixture() {
  const root = makeTempDir('gravity-v031-media-');
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const client = new AcpClient();
  const initResult = {
    protocolVersion: 1,
    agentInfo: { name: 'fixture-media', version: '1.0.0' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
  };
  client.initializeResult = initResult;
  vi.spyOn(client, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(client, 'start').mockResolvedValue(initResult);
  vi.spyOn(client, 'notify').mockImplementation(() => {});
  const prompts: AcpSessionPromptParams[] = [];
  let seq = 0;
  vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'session/new') return { sessionId: `media-sess-${++seq}` };
    if (method === 'session/prompt') {
      prompts.push(params as AcpSessionPromptParams);
      return { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
    }
    if (method === 'session/close') return {};
    return {};
  });

  const core = new CoreService({ acp: client, dataDir, homeDir });
  services.push(core);
  const session = await core.createSession({ cwd: workspace });
  return { root, dataDir, homeDir, workspace, client, core, session, prompts };
}

afterEach(async () => {
  for (const core of services.splice(0)) {
    await core.dispose().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. Exhaustive @shared media-contract.ts unit tests (Passes on Wave 0)
 * ========================================================================== */

describe('@shared media-contract.ts pure classifiers & formatters', () => {
  const bareOrFragmentInputs = [
    '.svg',
    '.png',
    '.ico',
    '.jpg',
    '.webp',
    '.ts',
    '.json',
    '-mac.png',
    '--config.json',
    '-dark.svg',
    '*.png',
    '**/*.svg',
    '<name>.svg',
    '${var}.ts',
    'foo|bar.png',
    'dir/{a,b}.png',
    '',
    '   ',
  ];

  it.each(bareOrFragmentInputs)(
    'rejects bare extension or fragment %j across isBareExtensionOrFragment / isPlausibleLocalFileCandidate / isPreviewableImagePath',
    (raw) => {
      expect(isBareExtensionOrFragment(raw)).toBe(true);
      expect(isPlausibleLocalFileCandidate(raw)).toBe(false);
      expect(isPreviewableImagePath(raw)).toBe(false);
    }
  );

  it('rejects dangerous protocols, hashes, remote URLs in local candidate check, and control characters', () => {
    for (const unsafe of [
      '#section-1',
      'javascript:alert(1).png',
      'vbscript:msgbox(1).png',
      'mailto:user@example.com',
      'blob:https://example.com/1234',
      'https://example.com/image.png',
      'http://127.0.0.1:5173/a.png',
      'file:///C:/a\0b.png',
      'line1\nline2.png',
      'a'.repeat(401) + '.png',
      'file:///.svg',
      './.png',
      '../.ico',
      '~/.svg',
      'src/.png',
      'icon-?.png',
      'plain words with spaces.png',
    ]) {
      expect(isPlausibleLocalFileCandidate(unsafe), `must reject: ${unsafe}`).toBe(false);
    }
    expect(isPreviewableImagePath('icon-?.png')).toBe(false);
    expect(isPreviewableImagePath('javascript:alert(1).png')).toBe(false);
    expect(isPreviewableImagePath('https://example.com/.png')).toBe(false);
    expect(isPreviewableImagePath('https://example.com/icon.ico')).toBe(false);
  });

  it('classifies real filenames, file:/// URIs, line anchors, directories, and remote/data images accurately', () => {
    expect(isBareExtensionOrFragment('01-gravity-lens.png')).toBe(false);
    expect(isPlausibleLocalFileCandidate('01-gravity-lens.png')).toBe(true);
    expect(isPlausibleLocalFileCandidate('01-gravity-lens.png', { allowBareFileName: false })).toBe(false);
    expect(isPreviewableImagePath('01-gravity-lens.png')).toBe(true);

    // .ico is a real local file candidate (files tray) but NOT a previewable gallery image
    expect(isPlausibleLocalFileCandidate('01-gravity-lens.ico')).toBe(true);
    expect(isPreviewableImagePath('01-gravity-lens.ico')).toBe(false);
    expect(isSupportedPreviewImageExt('ico')).toBe(false);
    expect(isSupportedPreviewImageExt('.PNG')).toBe(true);
    expect(isSupportedPreviewImageExt('svg')).toBe(true);
    expect(isSupportedPreviewImageExt(null)).toBe(false);

    // file:/// URI with line anchor
    const svgUri = 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.svg#L10';
    expect(isPlausibleLocalFileCandidate(svgUri)).toBe(true);
    expect(isPreviewableImagePath(svgUri)).toBe(true);
    expect(extractLineAnchorBadge(svgUri)).toBe('L10');
    expect(stripLocalTargetAnchor(svgUri)).toBe('file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.svg');
    expect(extractTargetBaseName(svgUri)).toBe('01-gravity-lens.svg');

    expect(extractLineAnchorBadge('file:///F:/demo/app.ts#L10-L24')).toBe('L10-L24');
    expect(extractLineAnchorBadge('src/main/core-service.ts:42:9')).toBe('L42');
    expect(extractLineAnchorBadge('01-gravity-lens.png')).toBeUndefined();

    // Directory path (Windows drive path)
    expect(isPlausibleLocalFileCandidate('C:/Workspace/DemoApp/icon-studio')).toBe(true);
    expect(isPreviewableImagePath('C:/Workspace/DemoApp/icon-studio')).toBe(false);
    expect(extractTargetBaseName('C:/Workspace/DemoApp/icon-studio/')).toBe('icon-studio');

    // Relative, tilde, POSIX, and URL-encoded Unicode filenames
    expect(isPlausibleLocalFileCandidate('./assets/hero.webp')).toBe(true);
    expect(isPreviewableImagePath('./assets/hero.webp')).toBe(true);
    expect(isPlausibleLocalFileCandidate('~/Desktop/capture.png')).toBe(true);
    expect(isPlausibleLocalFileCandidate('/Users/dev/icon-studio/01-gravity-lens.png')).toBe(true);
    expect(isPlausibleLocalFileCandidate('src/main/core-service.ts:10')).toBe(true);
    expect(extractTargetBaseName('file:///C:/Workspace/DemoApp/%E5%9B%BE%E6%A0%87%20lens.png')).toBe('图标 lens.png');

    // Data URL & valid HTTPS image URL
    expect(isPreviewableImagePath('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isPreviewableImagePath('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(true);
    expect(isPreviewableImagePath('https://cdn.example.com/assets/logo.webp?v=2')).toBe(true);
  });

  it('formats byte sizes cleanly across boundaries', () => {
    expect(formatByteSize(undefined)).toBe('');
    expect(formatByteSize(NaN)).toBe('');
    expect(formatByteSize(-5)).toBe('');
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1024)).toBe('1.0 KB');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(100 * 1024)).toBe('100 KB');
    expect(formatByteSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatByteSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

/* ============================================================================
 * 2. CoreService.inspectLocalTargets integration tests (via createCoreBridge)
 * ========================================================================== */

describe('CoreService.inspectLocalTargets via createCoreBridge (Wave 1A)', () => {
  it('inspects real PNG (1600x900 & 256x256), SVG (1024x1024), ICO, text, directory, missing, and enforces zero writes', async () => {
    const { root, workspace, core, session } = await createCoreFixture();
    const bridge = createCoreBridge(core);
    expect(typeof bridge.inspectLocalTargets).toBe('function');

    const widePngBytes = createValidPng(1600, 900);
    const squarePngBytes = createValidPng(256, 256);
    const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="400"/></svg>';
    const icoBytes = createValidIco(32);
    const mdText = '# Design Notes\nHello Gravity v0.3.1.\n';

    const widePngPath = path.join(workspace, 'gravity-icon-showcase.png');
    const squarePngPath = path.join(workspace, '01-gravity-lens-256.png');
    const svgPath = path.join(workspace, '01-gravity-lens.svg');
    const icoPath = path.join(workspace, '01-gravity-lens.ico');
    const mdPath = path.join(workspace, 'notes.md');
    const batPath = path.join(workspace, 'run-tool.bat');
    const subDir = path.join(workspace, 'icon-studio');

    writeFileSync(widePngPath, widePngBytes);
    writeFileSync(squarePngPath, squarePngBytes);
    writeFileSync(svgPath, svgText, 'utf8');
    writeFileSync(icoPath, icoBytes);
    writeFileSync(mdPath, mdText, 'utf8');
    writeFileSync(batPath, '@echo off\r\necho hi\r\n', 'utf8');
    mkdirSync(subDir, { recursive: true });

    const beforeWorkspace = snapshotTree(workspace);
    const wideUri = pathToFileURL(widePngPath).toString();
    const svgUriWithAnchor = `${pathToFileURL(svgPath).toString()}#L10`;

    const result = await bridge.inspectLocalTargets!({
      cwd: workspace,
      sessionId: session.sessionId,
      includePreviewData: true,
      targets: [
        wideUri,
        '01-gravity-lens-256.png',
        svgUriWithAnchor,
        '01-gravity-lens.ico',
        'notes.md',
        'run-tool.bat',
        'icon-studio',
        'does-not-exist.png',
        '.svg',
      ],
    });

    // 1600x900 panoramic PNG
    const wide = result.items[wideUri];
    expect(wide).toBeDefined();
    expect(wide.kind).toBe('image');
    expect(wide.exists).toBe(true);
    expect(wide.width).toBe(1600);
    expect(wide.height).toBe(900);
    expect(wide.aspectRatio).toBeCloseTo(1600 / 900, 2);
    expect(wide.sizeBytes).toBe(widePngBytes.length);
    expect(wide.ext).toBe('png');
    expect(wide.previewDataUrl).toMatch(/^data:image\/png;base64,/);

    // 256x256 square PNG
    const square = result.items['01-gravity-lens-256.png'];
    expect(square).toMatchObject({
      kind: 'image',
      exists: true,
      width: 256,
      height: 256,
      ext: 'png',
      sizeBytes: squarePngBytes.length,
    });
    expect(square.aspectRatio).toBeCloseTo(1, 2);

    // SVG with viewBox="0 0 1024 1024" and #L10 anchor
    const svg = result.items[svgUriWithAnchor];
    expect(svg).toMatchObject({
      kind: 'image',
      exists: true,
      width: 1024,
      height: 1024,
      ext: 'svg',
      sizeBytes: Buffer.byteLength(svgText, 'utf8'),
    });
    expect(svg.aspectRatio).toBeCloseTo(1, 2);
    expect(svg.previewDataUrl).toMatch(/^data:image\/svg\+xml;/);

    // ICO file (classified cleanly with real size & ext)
    const ico = result.items['01-gravity-lens.ico'];
    expect(ico).toBeDefined();
    expect(ico.exists).toBe(true);
    expect(ico.ext).toBe('ico');
    expect(ico.sizeBytes).toBe(icoBytes.length);
    expect(['file', 'image']).toContain(ico.kind);
    if (ico.width !== undefined) expect(ico.width).toBe(32);

    // Plain markdown file & executable script
    expect(result.items['notes.md']).toMatchObject({
      kind: 'file',
      exists: true,
      ext: 'md',
      sizeBytes: Buffer.byteLength(mdText, 'utf8'),
    });
    expect(result.items['notes.md'].previewDataUrl).toBeUndefined();

    expect(result.items['run-tool.bat']).toMatchObject({
      kind: 'file',
      exists: true,
      ext: 'bat',
      isExecutable: true,
    });

    // Directory
    expect(result.items['icon-studio']).toMatchObject({
      kind: 'directory',
      exists: true,
    });

    // Nonexistent & bare extension
    expect(result.items['does-not-exist.png']).toMatchObject({
      kind: 'missing',
      exists: false,
    });
    const bareSvg = result.items['.svg'];
    if (bareSvg) {
      expect(bareSvg.exists).toBe(false);
      expect(bareSvg.kind).not.toBe('image');
    }

    // Strict zero-bytes-written compliance check
    expect(snapshotTree(workspace)).toEqual(beforeWorkspace);
    // Keep root referenced for readability
    expect(root).toBeTruthy();
  });

  it('caps previewDataUrl at MAX_INLINE_PREVIEW_BYTES while still sniffing dimensions, and caps batch size at MAX_LOCAL_INSPECT_TARGETS', async () => {
    const { workspace, core, session } = await createCoreFixture();
    const bridge = createCoreBridge(core);
    expect(typeof bridge.inspectLocalTargets).toBe('function');

    // Valid 800x600 PNG padded past 4 MB so previewDataUrl must be omitted while dimensions are still sniffed from header
    const basePng = createValidPng(800, 600);
    const padSize = MAX_INLINE_PREVIEW_BYTES + 128 * 1024 - basePng.length;
    const hugePngPath = path.join(workspace, 'huge-banner.png');
    writeFileSync(hugePngPath, Buffer.concat([basePng, Buffer.alloc(padSize)]));

    const hugeRes = await bridge.inspectLocalTargets!({
      cwd: workspace,
      sessionId: session.sessionId,
      includePreviewData: true,
      targets: ['huge-banner.png'],
    });
    const huge = hugeRes.items['huge-banner.png'];
    expect(huge).toMatchObject({
      kind: 'image',
      exists: true,
      width: 800,
      height: 600,
    });
    expect(huge.sizeBytes).toBeGreaterThan(MAX_INLINE_PREVIEW_BYTES);
    expect(huge.previewDataUrl).toBeUndefined();

    // Batch limit cap (MAX_LOCAL_INSPECT_TARGETS = 48)
    const manyTargets = Array.from({ length: MAX_LOCAL_INSPECT_TARGETS + 12 }, (_, i) => `missing-${i}.png`);
    const batchRes = await bridge.inspectLocalTargets!({
      cwd: workspace,
      targets: manyTargets,
    });
    expect(Object.keys(batchRes.items).length).toBeLessThanOrEqual(MAX_LOCAL_INSPECT_TARGETS);
  });

  it('SEC-3: blocks direct and symlinked forbidden credential (.json) and .gemini/*.pb state paths without leaking content', async () => {
    const { root, workspace, core, session } = await createCoreFixture();
    const bridge = createCoreBridge(core);
    expect(typeof bridge.inspectLocalTargets).toBe('function');

    const fakeGeminiDir = path.join(root, 'outside', '.gemini', 'antigravity');
    mkdirSync(fakeGeminiDir, { recursive: true });
    const oauthFile = path.join(fakeGeminiDir, 'oauth_token.json');
    const pbFile = path.join(fakeGeminiDir, 'state.pb');
    writeFileSync(oauthFile, JSON.stringify({ access_token: 'SECRET_DO_NOT_LEAK' }));
    writeFileSync(pbFile, createValidPng(64, 64)); // Even if bytes look like PNG, .gemini/*.pb is forbidden!

    const linkOauth = path.join(workspace, 'innocent-preview.png');
    const linkPb = path.join(workspace, 'innocent-state.png');
    const createdOauthLink = tryCreateFileSymlink(oauthFile, linkOauth);
    const createdPbLink = tryCreateFileSymlink(pbFile, linkPb);

    const targets = [
      oauthFile,
      pbFile,
      ...(createdOauthLink ? ['innocent-preview.png'] : []),
      ...(createdPbLink ? ['innocent-state.png'] : []),
    ];

    const res = await bridge.inspectLocalTargets!({
      cwd: workspace,
      sessionId: session.sessionId,
      includePreviewData: true,
      targets,
    });

    for (const key of targets) {
      const item = res.items[key];
      expect(item, `entry for ${key}`).toBeDefined();
      expect(item.kind, `${key} must be forbidden`).toBe('forbidden');
      expect(item.exists, `${key} must not confirm existence`).toBe(false);
      expect(item.previewDataUrl).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain('SECRET_DO_NOT_LEAK');
    }
  });

  it('registers APP_INSPECT_LOCAL_TARGETS in registerIpcRouter with main-frame origin isolation and exposes it in preload.ts', async () => {
    const handlers = new Map<string, Function>();
    const ipcMain = {
      handle: (channel: string, cb: Function) => handlers.set(channel, cb),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const frame = { url: 'file:///trusted/index.html' };
    const trusted = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    const service = Object.assign(new EventEmitter(), {
      inspectLocalTargets: vi.fn().mockResolvedValue({ items: { 'a.png': { rawTarget: 'a.png', kind: 'missing', exists: false, fileName: 'a.png' } } }),
    }) as unknown as CoreService;

    const dispose = registerIpcRouter(ipcMain, service, trusted);
    try {
      const handler = handlers.get(IPC_CHANNELS.APP_INSPECT_LOCAL_TARGETS);
      expect(handler).toBeTypeOf('function');
      const validEvent = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
      await expect(handler!(validEvent, { targets: ['a.png'] })).resolves.toMatchObject({ items: { 'a.png': { kind: 'missing' } } });
      expect(() => handler!({ ...validEvent, sender: {} }, { targets: ['a.png'] })).toThrow('非主窗口');
      expect(() => handler!({ ...validEvent, senderFrame: { url: trusted.getURL() } }, { targets: ['a.png'] })).toThrow('非主窗口');
    } finally {
      dispose();
    }

    const preloadSource = readFileSync('src/main/preload.ts', 'utf8');
    expect(preloadSource).toContain('inspectLocalTargets');
    expect(preloadSource).toContain(IPC_CHANNELS.APP_INSPECT_LOCAL_TARGETS);
  });
});

/* ============================================================================
 * 3. appendImage (src/main/session/message-images.ts) tests (SEC-3 / B-P2-7)
 * ========================================================================== */

describe('appendImage (message-images.ts) v0.3.1 hardening', () => {
  it('supports .ico URIs and image/x-icon base64 payloads alongside standard image formats', () => {
    const msg: Pick<ChatMessageItem, 'attachments'> = {};
    const icoBase64 = createValidIco(16).toString('base64');

    appendImage(msg, { type: 'image', uri: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png' });
    appendImage(msg, { type: 'image', uri: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico' });
    appendImage(msg, { type: 'image', mimeType: 'image/x-icon', data: icoBase64, name: 'app.ico' });

    expect(msg.attachments).toHaveLength(3);
    expect(msg.attachments![0]).toMatchObject({ mimeType: 'image/png', name: '01-gravity-lens.png' });
    expect(msg.attachments![1].name).toBe('01-gravity-lens.ico');
    expect(msg.attachments![1].mimeType).toMatch(/^image\/(?:x-icon|vnd\.microsoft\.icon)$/);
    expect(msg.attachments![2].dataUrl).toMatch(/^data:image\/(?:x-icon|vnd\.microsoft\.icon);base64,/);
  });

  it('rejects bare extensions, fragment strings, unsafe protocols, and forbidden credential/state URIs', () => {
    const msg: Pick<ChatMessageItem, 'attachments'> = {};
    const rejectedPayloads = [
      { type: 'image', uri: '.svg' },
      { type: 'image', uri: '.png' },
      { type: 'image', uri: '.ico' },
      { type: 'image', uri: '-mac.png' },
      { type: 'image', uri: '*.png' },
      { type: 'image', uri: '<name>.svg' },
      { type: 'image', uri: 'javascript:alert(1).png' },
      { type: 'image', uri: 'file:///C:/Users/me/.gemini/antigravity/oauth_token.png' },
      { type: 'image', mimeType: 'image/png', uri: 'file:///C:/Users/me/.gemini/antigravity/oauth_token.json' },
      { type: 'image', mimeType: 'image/png', uri: 'file:///C:/Users/me/.gemini/antigravity/state.pb' },
      { type: 'image', mimeType: 'image/png', uri: 'file:///C:/Users/me/.ssh/id_rsa.png' },
    ];

    for (const payload of rejectedPayloads) {
      appendImage(msg, payload);
    }
    expect(msg.attachments ?? []).toHaveLength(0);
  });
});

/* ============================================================================
 * 4. CoreService.sendPrompt attachment bounds & URI-only image reading (B-P2-7)
 * ========================================================================== */

describe('CoreService.sendPrompt attachment bounds & URI-only image reading (B-P2-7)', () => {
  it('rejects prompts exceeding MAX_MESSAGE_ATTACHMENTS count', async () => {
    const { core, session, prompts } = await createCoreFixture();
    const tooMany = Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, (_, idx) => ({
      name: `note-${idx}.txt`,
      mimeType: 'text/plain',
      textContent: `hello ${idx}`,
      sizeBytes: 8,
    }));

    await expect(
      core.sendPrompt({ sessionId: session.sessionId, text: 'Inspect all', attachments: tooMany })
    ).rejects.toThrow(/附件|上限|数量|20/);
    expect(prompts).toHaveLength(0);
  });

  it('rejects prompts exceeding MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES even when each individual attachment is <= 20 MB', async () => {
    const { core, session, prompts } = await createCoreFixture();
    const halfPlus = Math.floor(MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES / 2) + 1024 * 1024; // 13 MB each -> 26 MB total > 24 MB
    await expect(
      core.sendPrompt({
        sessionId: session.sessionId,
        text: 'Two large attachments',
        attachments: [
          { name: 'a.txt', mimeType: 'text/plain', textContent: 'a', sizeBytes: halfPlus },
          { name: 'b.txt', mimeType: 'text/plain', textContent: 'b', sizeBytes: halfPlus },
        ],
      })
    ).rejects.toThrow(/附件|大小|总|限制|24/);
    expect(prompts).toHaveLength(0);
  });

  it('validates attachment mimeType cleanly instead of throwing an unhandled TypeError', async () => {
    const { core, session, prompts } = await createCoreFixture();
    let caught: unknown;
    try {
      await core.sendPrompt({
        sessionId: session.sessionId,
        text: 'Invalid mimeType test',
        attachments: [
          {
            name: 'broken.txt',
            mimeType: 123 as unknown as string,
            textContent: 'hello',
            sizeBytes: 5,
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(prompts).toHaveLength(0);
  });

  it('reads workspace URI-only image attachments as binary image blocks without failing text decoding, and rejects out-of-workspace / credential URIs', async () => {
    const { root, workspace, core, session, prompts } = await createCoreFixture();
    const pngBytes = createValidPng(64, 64);
    const pngPath = path.join(workspace, 'diagram.png');
    writeFileSync(pngPath, pngBytes);

    await core.sendPrompt({
      sessionId: session.sessionId,
      text: 'Review this diagram',
      attachments: [
        {
          name: 'diagram.png',
          mimeType: 'image/png',
          uri: pathToFileURL(pngPath).toString(),
          sizeBytes: pngBytes.length,
        },
      ],
    });

    expect(prompts).toHaveLength(1);
    const sentBlocks = prompts[0].prompt;
    const imageBlock = sentBlocks.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    if (imageBlock && imageBlock.type === 'image') {
      expect(imageBlock.mimeType).toBe('image/png');
      expect(imageBlock.data).toBe(pngBytes.toString('base64'));
    }

    // Outside workspace or forbidden credential URI must be rejected
    const secretDir = path.join(root, 'outside', '.gemini', 'antigravity');
    mkdirSync(secretDir, { recursive: true });
    const secretPng = path.join(secretDir, 'oauth_token.png');
    writeFileSync(secretPng, pngBytes);

    await expect(
      core.sendPrompt({
        sessionId: session.sessionId,
        text: 'Should block secret URI',
        attachments: [
          {
            name: 'oauth_token.png',
            mimeType: 'image/png',
            uri: pathToFileURL(secretPng).toString(),
            sizeBytes: pngBytes.length,
          },
        ],
      })
    ).rejects.toThrow();
  });
});

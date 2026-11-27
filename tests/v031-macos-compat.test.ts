// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_PRESETS,
  extractLineAnchorBadge,
  extractTargetBaseName,
  isBareExtensionOrFragment,
  isForbiddenCredentialOrStatePath,
  isPlausibleLocalFileCandidate,
  isPreviewableImagePath,
  stripLocalTargetAnchor,
} from '@shared';
import { inspectLocalTargets } from '../src/main/services/local-media-inspector';
import { isUnsafeLocalPath } from '../src/main/workspace/local-path-safety';
import { openExternalTarget } from '../src/main/services/external-opener';
import { contrastRatio, deriveAccessibleTokens, parseCssColor } from '../src/renderer/styles/theme';

/* ============================================================================
 * Spec-compliant PNG fixture generator (zero external dependencies)
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

function createValidPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((1 + width * 3) * height);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. macOS Credential & Private State Path Hard-Blocking (Cross-Platform)
 * ========================================================================== */

describe('v0.3.1 macOS 敏感凭据与私有状态路径硬阻断', () => {
  const forbiddenMacPaths = [
    '/Users/alice/.gemini/antigravity/oauth_creds.json',
    '/Users/alice/.gemini/antigravity/oauth_token.json',
    '/Users/alice/Library/Application Support/antigravity/state.vscdb',
    '/Users/alice/Library/Application Support/antigravity/state.vscdb-wal',
    '/Users/alice/Library/Application Support/Antigravity/User/globalStorage/state.vscdb',
    '/Users/alice/.gemini/antigravity/pb/state.pb',
    '/Users/alice/.gemini/antigravity-cli/session.pb',
    '/Users/alice/.gemini/antigravity/installation_id',
    '/Users/alice/.gemini/antigravity/brain/meta.pbtxt',
    '/Users/alice/.ssh/id_ed25519',
    '/Users/alice/.gnupg/secring.gpg',
    '/Users/alice/.aws/credentials',
    '/Users/alice/.config/gcloud/application_default_credentials.json',
    '/Users/alice/Library/Keychains/client-cert.p12',
    '/Users/alice/certs/private.pem',
    '/etc/passwd',
  ];

  it.each(forbiddenMacPaths)('isForbiddenCredentialOrStatePath 阻断 macOS 敏感路径：%s', (target) => {
    expect(isForbiddenCredentialOrStatePath(target)).toBe(true);
    expect(isUnsafeLocalPath(target)).toBe(true);
  });

  const allowedMacProjectFiles = [
    '/Users/alice/Code/G-Gravity/assets/logo.png',
    '/Users/alice/Code/G-Gravity/src/main/index.ts',
    '/Users/alice/My Project/设计稿/图标 01.svg',
    '/Volumes/Macintosh HD/Projects/gravity/README.md',
    '/Users/alice/Desktop/screenshot 2026-11-24.png',
  ];

  it.each(allowedMacProjectFiles)('isForbiddenCredentialOrStatePath 放行正常 macOS 项目文件：%s', (target) => {
    expect(isForbiddenCredentialOrStatePath(target)).toBe(false);
    expect(isUnsafeLocalPath(target)).toBe(false);
  });

  it('isUnsafeLocalPath 额外阻断 macOS .env 文件与非本地网络路径', () => {
    expect(isUnsafeLocalPath('/Users/alice/Code/G-Gravity/.env')).toBe(true);
    expect(isUnsafeLocalPath('/Users/alice/Code/G-Gravity/.env.local')).toBe(true);
    expect(isUnsafeLocalPath('//nas.local/share/logo.png')).toBe(true);
    expect(isForbiddenCredentialOrStatePath('/Users/alice/.gemini/antigravity/pb/state.pb')).toBe(true);
  });

  it('inspectLocalTargets 跨平台（含 Windows 运行时）对 macOS 敏感路径返回 forbidden 且绝不确认存在', async () => {
    const targets = [
      '/Users/alice/.gemini/antigravity/oauth_creds.json',
      '/Users/alice/Library/Application Support/antigravity/state.vscdb',
      '/Users/alice/.gemini/antigravity/pb/state.pb',
      '/etc/passwd',
    ];
    const res = await inspectLocalTargets({ targets, includePreviewData: true });
    for (const target of targets) {
      expect(res.items[target], `missing entry for ${target}`).toMatchObject({
        kind: 'forbidden',
        exists: false,
      });
      expect(res.items[target].previewDataUrl).toBeUndefined();
    }
  });
});

/* ============================================================================
 * 2. Shared POSIX Path Candidate, Basename & Line Anchor Utilities
 * ========================================================================== */

describe('v0.3.1 共享媒体契约在 POSIX macOS 路径上的识别、拆解与降噪', () => {
  it('准确识别带空格编码、CJK、#L10-L20、/Users/... 与 /Volumes/... 的 POSIX macOS 路径', () => {
    const validCandidates = [
      '/Users/alice/Code/G-Gravity/assets/logo.png',
      '/Users/alice/Code/G-Gravity/src/core-service.ts#L10-L20',
      '/Users/alice/My%20Project/01-gravity-lens.png',
      'file:///Users/alice/My%20Project/01-gravity-lens.png',
      'file:///Users/alice/My Project/01-gravity-lens.png',
      'file:///Users/alice/项目/图标%2001.svg#L10-L20',
      '/Users/alice/My Project/01-gravity-lens.png',
      '/Volumes/SSD/设计稿/preview.webp',
      '/Volumes/Work_Drive/docs/架构说明.md:42:5',
      '~/Desktop/屏幕截图.png',
    ];
    for (const target of validCandidates) {
      expect(isPlausibleLocalFileCandidate(target), `expected plausible: ${target}`).toBe(true);
    }

    expect(isPreviewableImagePath('file:///Users/alice/My%20Project/01-gravity-lens.png')).toBe(true);
    expect(isPreviewableImagePath('/Volumes/SSD/设计稿/preview.webp')).toBe(true);
    expect(isPreviewableImagePath('/Users/alice/Code/G-Gravity/assets/icon.icns')).toBe(false);
    expect(isPreviewableImagePath('/etc')).toBe(false);
  });

  it('严格拒绝 .svg / .png / .ico / -mac.png 等裸后缀碎片与非法 POSIX 噪声', () => {
    const rejectedNoise = [
      '.svg',
      '.png',
      '.ico',
      '.icns',
      '.ts',
      '-mac.png',
      '--config.json',
      '-dark.svg',
      '*.png',
      '<name>.svg',
      '${var}.ts',
      '/',
      '/a',
      '/.svg',
      '/.png',
      'file:///.svg',
      '~/.svg',
      '/compact now',
      '/plan step 1/2',
      'javascript:alert(1).png',
      'https://example.com/logo.png',
    ];
    for (const noise of rejectedNoise) {
      expect(isPlausibleLocalFileCandidate(noise), `must reject: ${noise}`).toBe(false);
    }

    for (const fragment of ['.svg', '.png', '.ico', '-mac.png', '/.svg']) {
      expect(isBareExtensionOrFragment(fragment), `must flag bare fragment: ${fragment}`).toBe(true);
    }
  });

  it('extractTargetBaseName / extractLineAnchorBadge / stripLocalTargetAnchor 正确处理 POSIX 路径与行号锚点', () => {
    expect(extractTargetBaseName('file:///Users/alice/My%20Project/01-gravity-lens.png')).toBe('01-gravity-lens.png');
    expect(extractTargetBaseName('file:///Users/alice/src/core-service.ts#L10-L20')).toBe('core-service.ts');
    expect(extractTargetBaseName('file:///Users/alice/%E9%A1%B9%E7%9B%AE/%E5%9B%BE%E6%A0%87%2001.png')).toBe(
      '图标 01.png'
    );
    expect(extractTargetBaseName('/Users/alice/My Project/01-gravity-lens.png')).toBe('01-gravity-lens.png');
    expect(extractTargetBaseName('/Volumes/SSD/设计稿/preview.webp')).toBe('preview.webp');
    expect(extractTargetBaseName('/Users/alice/Code/G-Gravity/')).toBe('G-Gravity');

    expect(extractLineAnchorBadge('file:///Users/alice/src/core-service.ts#L10-L20')).toBe('L10-L20');
    expect(extractLineAnchorBadge('/Users/alice/src/core-service.ts#L42')).toBe('L42');
    expect(extractLineAnchorBadge('/Volumes/Work_Drive/docs/架构说明.md:42:5')).toBe('L42');
    expect(extractLineAnchorBadge('/Volumes/SSD/设计稿/preview.webp')).toBeUndefined();

    expect(stripLocalTargetAnchor('file:///Users/alice/src/core-service.ts#L10-L20')).toBe(
      'file:///Users/alice/src/core-service.ts'
    );
    expect(stripLocalTargetAnchor('/Users/alice/My Project/app.ts:10:5')).toBe('/Users/alice/My Project/app.ts');
    expect(stripLocalTargetAnchor('</Users/alice/项目/图标 01.png#L5>')).toBe('/Users/alice/项目/图标 01.png');
  });
});

/* ============================================================================
 * 3. macOS Dark & Light Theme Presets WCAG 2.1 AA Contrast Gate
 * ========================================================================== */

describe('v0.3.1 macos-dark / macos-light 预设主题 WCAG 2.1 AA 对比度门禁', () => {
  it.each(['macos-dark', 'macos-light'] as const)(
    '%s 在 bgApp 与 bgSurface 上的核心文本、强调色与语义状态色均达到 WCAG 2.1 AA (>= 4.5:1)',
    (themeId) => {
      const preset = THEME_PRESETS.find((item) => item.id === themeId);
      expect(preset).toBeDefined();
      const { tokens, polarity } = preset!;

      const bgApp = parseCssColor(tokens.bgApp)!;
      const bgSurface = parseCssColor(tokens.bgSurface)!;
      const bgElevated = parseCssColor(tokens.bgElevated)!;
      expect(bgApp).not.toBeNull();
      expect(bgSurface).not.toBeNull();
      expect(bgElevated).not.toBeNull();

      // 1) 原始预设 Token：在 bgApp 上全部 7 个前景语义色均 >= 4.5:1
      const allFgKeys = [
        'textPrimary',
        'textSecondary',
        'textMuted',
        'accentPrimary',
        'statusSuccess',
        'statusWarning',
        'statusDanger',
      ] as const;
      for (const key of allFgKeys) {
        const fg = parseCssColor(tokens[key])!;
        const ratioApp = contrastRatio(fg, bgApp);
        expect(
          ratioApp,
          `[${themeId}] ${key} (${tokens[key]}) vs bgApp (${tokens.bgApp}) = ${ratioApp.toFixed(2)} < 4.5`
        ).toBeGreaterThanOrEqual(4.5);
      }

      // 2) 原始预设 Token：在 bgSurface 上所有正文与成功/警告/危险状态色均 >= 4.5:1；
      //    macos-light 主强调色直接 >= 4.5:1，macos-dark System Blue 满足大控件 >= 3.0 且由派生 --accent-text 保证文字 >= 4.5:1
      const surfaceRawAAKeys = [
        'textPrimary',
        'textSecondary',
        'textMuted',
        'statusSuccess',
        'statusWarning',
        'statusDanger',
      ] as const;
      for (const key of surfaceRawAAKeys) {
        const fg = parseCssColor(tokens[key])!;
        const ratioSurface = contrastRatio(fg, bgSurface);
        expect(
          ratioSurface,
          `[${themeId}] ${key} (${tokens[key]}) vs bgSurface (${tokens.bgSurface}) = ${ratioSurface.toFixed(2)} < 4.5`
        ).toBeGreaterThanOrEqual(4.5);
      }
      const rawAccentSurface = contrastRatio(parseCssColor(tokens.accentPrimary)!, bgSurface);
      expect(rawAccentSurface).toBeGreaterThanOrEqual(themeId === 'macos-light' ? 4.5 : 3.0);

      // 3) D2 WCAG AA 派生语义文字变量：accent / success / warning / danger / muted / secondary
      //    在 bgApp、bgSurface 与 bgElevated 上全部 >= 4.5:1，且主按钮文字 --on-accent 对 --accent-solid >= 4.5:1
      const derived = deriveAccessibleTokens(tokens, polarity);
      const derivedTextVars = [
        '--secondary-text',
        '--muted-text',
        '--accent-text',
        '--success-text',
        '--warning-text',
        '--danger-text',
      ] as const;
      for (const cssVar of derivedTextVars) {
        const fg = parseCssColor(derived[cssVar]);
        expect(fg, `[${themeId}] missing derived token ${cssVar}`).not.toBeNull();
        for (const [bgName, bgRgb] of [
          ['bgApp', bgApp],
          ['bgSurface', bgSurface],
          ['bgElevated', bgElevated],
        ] as const) {
          const ratio = contrastRatio(fg!, bgRgb);
          expect(
            ratio,
            `[${themeId}] derived ${cssVar} (${derived[cssVar]}) vs ${bgName} = ${ratio.toFixed(2)} < 4.5`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      const onAccent = parseCssColor(derived['--on-accent']);
      const accentSolid = parseCssColor(derived['--accent-solid']);
      expect(onAccent).not.toBeNull();
      expect(accentSolid).not.toBeNull();
      expect(contrastRatio(onAccent!, accentSolid!)).toBeGreaterThanOrEqual(4.5);
    }
  );
});

/* ============================================================================
 * 4. Real POSIX Filesystem Inspection & Symlink Escape Tests (macOS / Linux)
 * ========================================================================== */

describe('v0.3.1 POSIX 真实文件系统媒体探测、可执行权限与符号链接越权拦截', () => {
  it.skipIf(process.platform === 'win32')(
    'inspectLocalTargets 正确解析含空格、CJK、chmod 0o755 可执行脚本与 file:/// URI 的真实 POSIX 路径且零写入',
    async () => {
      const root = makeTempDir('gravity-mac-posix-inspect-');
      const workspace = path.join(root, 'My Project 设计稿');
      mkdirSync(workspace, { recursive: true });

      const iconPngPath = path.join(workspace, '重力 图标 01.png');
      const bannerPngPath = path.join(workspace, 'banner wide.png');
      const svgPath = path.join(workspace, 'vector logo.svg');
      const shPath = path.join(workspace, 'deploy tool.sh');
      const modeBitExecPath = path.join(workspace, 'run-helper.txt');
      const notesPath = path.join(workspace, 'notes.md');

      const iconBytes = createValidPng(256, 256);
      const bannerBytes = createValidPng(1600, 900);
      const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="200"/></svg>';

      writeFileSync(iconPngPath, iconBytes);
      writeFileSync(bannerPngPath, bannerBytes);
      writeFileSync(svgPath, svgText, 'utf8');
      writeFileSync(shPath, '#!/bin/sh\necho "hello macOS"\n', 'utf8');
      chmodSync(shPath, 0o755);
      writeFileSync(modeBitExecPath, '#!/bin/sh\necho "mode bit exec"\n', 'utf8');
      chmodSync(modeBitExecPath, 0o755);
      writeFileSync(notesPath, '# macOS Notes\n', 'utf8');
      chmodSync(notesPath, 0o644);

      const before = snapshotTree(workspace);
      const bannerFileUrl = pathToFileURL(bannerPngPath).href;

      const res = await inspectLocalTargets({
        cwd: workspace,
        includePreviewData: true,
        targets: [
          iconPngPath,
          bannerFileUrl,
          'vector logo.svg',
          'deploy tool.sh#L10-L20',
          'run-helper.txt',
          'notes.md',
        ],
      });

      expect(res.items[iconPngPath]).toMatchObject({
        kind: 'image',
        exists: true,
        fileName: '重力 图标 01.png',
        resolvedPath: realpathSync.native(iconPngPath),
        ext: 'png',
        width: 256,
        height: 256,
        sizeBytes: iconBytes.length,
      });
      expect(res.items[iconPngPath].previewDataUrl).toMatch(/^data:image\/png;base64,/);

      expect(res.items[bannerFileUrl]).toMatchObject({
        kind: 'image',
        exists: true,
        fileName: 'banner wide.png',
        resolvedPath: realpathSync.native(bannerPngPath),
        width: 1600,
        height: 900,
      });
      expect(res.items[bannerFileUrl].aspectRatio).toBeCloseTo(1600 / 900, 2);

      expect(res.items['vector logo.svg']).toMatchObject({
        kind: 'image',
        exists: true,
        ext: 'svg',
        width: 512,
        height: 512,
      });
      expect(res.items['vector logo.svg'].previewDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

      // chmod 0o755 的 .sh 脚本与仅通过 POSIX 执行位标记的文件均识别为可执行，普通 0o644 文档为非可执行
      expect(res.items['deploy tool.sh#L10-L20']).toMatchObject({
        kind: 'file',
        exists: true,
        ext: 'sh',
        isExecutable: true,
      });
      expect(res.items['run-helper.txt']).toMatchObject({
        kind: 'file',
        exists: true,
        ext: 'txt',
        isExecutable: true,
      });
      expect(res.items['notes.md']).toMatchObject({
        kind: 'file',
        exists: true,
        ext: 'md',
        isExecutable: false,
      });

      // openExternalTarget 对可执行脚本强制降级为 reveal-in-folder，绝不直接运行
      const openHandler = vi.fn(async () => {});
      const openSh = await openExternalTarget(
        { target: 'deploy tool.sh', action: 'default-app', cwd: workspace },
        { openTargetHandler: openHandler }
      );
      expect(openSh.modeUsed).toBe('reveal-in-folder');
      expect(openHandler).toHaveBeenCalledWith(realpathSync.native(shPath), 'reveal-in-folder', false);

      const openModeBit = await openExternalTarget(
        { target: 'run-helper.txt', action: 'browser', cwd: workspace },
        { openTargetHandler: openHandler }
      );
      expect(openModeBit.modeUsed).toBe('reveal-in-folder');

      // 严格 0 字节写入检查
      expect(snapshotTree(workspace)).toEqual(before);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'inspectLocalTargets 在真实 POSIX 环境下拦截工作区越界符号链接与指向凭据/state.vscdb/.pb 的符号链接',
    async () => {
      const root = makeTempDir('gravity-mac-posix-symlink-');
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'outside');
      const fakeGemini = path.join(outside, '.gemini', 'antigravity');
      const fakeAppSupport = path.join(outside, 'Library', 'Application Support', 'antigravity');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(fakeGemini, { recursive: true });
      mkdirSync(fakeAppSupport, { recursive: true });

      const outsidePng = path.join(outside, 'outside-secret.png');
      const oauthPath = path.join(fakeGemini, 'oauth_creds.json');
      const pbPath = path.join(fakeGemini, 'state.pb');
      const vscdbPath = path.join(fakeAppSupport, 'state.vscdb');

      writeFileSync(outsidePng, createValidPng(64, 64));
      writeFileSync(oauthPath, JSON.stringify({ access_token: 'MAC_SECRET_DO_NOT_LEAK' }));
      writeFileSync(pbPath, createValidPng(32, 32));
      writeFileSync(vscdbPath, 'SQLite format 3\0SECRET');

      symlinkSync(outsidePng, path.join(workspace, 'escape-outside.png'));
      symlinkSync(oauthPath, path.join(workspace, 'escape-oauth.png'));
      symlinkSync(pbPath, path.join(workspace, 'escape-pb.png'));
      symlinkSync(vscdbPath, path.join(workspace, 'escape-vscdb.png'));

      const targets = [
        'escape-outside.png',
        'escape-oauth.png',
        'escape-pb.png',
        'escape-vscdb.png',
        oauthPath,
        pbPath,
        vscdbPath,
      ];

      const res = await inspectLocalTargets({
        cwd: workspace,
        includePreviewData: true,
        targets,
      });

      for (const target of targets) {
        const item = res.items[target];
        expect(item, `expected forbidden item for ${target}`).toMatchObject({
          kind: 'forbidden',
          exists: false,
        });
        expect(item.previewDataUrl).toBeUndefined();
        expect(JSON.stringify(item)).not.toContain('MAC_SECRET_DO_NOT_LEAK');
      }
    }
  );
});

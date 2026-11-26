// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

const EXPECTED_PUBLIC_ICON_SVGS = [
  'gravity-claude-dark.svg',
  'gravity-claude-light.svg',
  'gravity-macos-dark.svg',
  'gravity-macos-light.svg',
  'gravity-solarized.svg',
  'gravity-ubuntu.svg',
].sort();

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

describe('Gravity v0.3.3 包体瘦身、D2-A 严格 CSP 与 D1-B 死代码/Mock 零泄露守卫', () => {
  it('DC-PKG-01：public/icons/ 仅包含 6 个原创 .svg 文件，0 个冗余 .png / .ico 副本', () => {
    const publicIconsDir = path.join(REPO_ROOT, 'public', 'icons');
    expect(fs.existsSync(publicIconsDir)).toBe(true);

    const entries = fs.readdirSync(publicIconsDir).sort();
    expect(entries).toEqual(EXPECTED_PUBLIC_ICON_SVGS);

    const forbiddenDupes = entries.filter((name) => /\.(?:png|ico|icns)$/i.test(name));
    expect(forbiddenDupes).toEqual([]);
  });

  it('DC-PKG-02 / D4：package.json 无 electronDist 与死依赖，按 OS 精确分离打包图标并排除 .map / .d.ts', () => {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      build?: {
        electronDist?: unknown;
        files?: string[];
        win?: { files?: string[] };
        mac?: { files?: string[] };
      };
    };

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(allDeps).not.toHaveProperty('rcedit');
    expect(allDeps).not.toHaveProperty('@testing-library/jest-dom');

    expect(pkg.build).toBeDefined();
    expect(pkg.build?.electronDist).toBeUndefined();

    const buildFiles = pkg.build?.files ?? [];
    expect(buildFiles.some((pattern) => /^!(?:dist\/\*\*\/|\*\*\/)\*\.map$/i.test(pattern))).toBe(true);
    expect(buildFiles.some((pattern) => /^!(?:dist\/\*\*\/|\*\*\/)\*\.d\.ts$/i.test(pattern))).toBe(true);
    expect(buildFiles.some((pattern) => /^assets\/icons\b/i.test(pattern))).toBe(false);

    const winFiles = pkg.build?.win?.files ?? [];
    expect(winFiles).toEqual(['assets/icons/*.ico', 'assets/quota/read-quota.ps1']);

    const macFiles = pkg.build?.mac?.files ?? [];
    expect(macFiles).toEqual([
      'assets/icons/*-mac.png',
      'assets/quota/read-quota-macos.sh',
      'assets/quota/status-line-macos.js',
    ]);
  });

  it('SEC-03 / D2-A：index.html 严格锁定纯本地生产 CSP，且 vite.config.ts 仅在 serve 阶段追加 127.0.0.1', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const cspMatch = /http-equiv=(["'])Content-Security-Policy\1[\s\S]*?content=(["'])([\s\S]*?)\2/i.exec(html);
    expect(cspMatch, 'index.html must declare a Content-Security-Policy meta tag').toBeTruthy();

    const csp = cspMatch![3];
    const directives = new Map<string, string>();
    for (const part of csp.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) directives.set(trimmed.toLowerCase(), '');
      else directives.set(trimmed.slice(0, spaceIdx).toLowerCase(), trimmed.slice(spaceIdx + 1).trim());
    }

    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('img-src')).toBe("'self' data: blob:");
    expect(directives.get('connect-src')).toBe("'self'");

    // 确保静态 CSP 未开放任何外部图片/脚本/连接来源
    expect(directives.get('img-src')).not.toMatch(/\b(?:http:|https:|file:)\b/i);
    expect(directives.get('connect-src')).not.toMatch(/\b(?:http:|https:|ws:|wss:)\b/i);

    // 校验 vite.config.ts 仅在 serve 阶段为本机 127.0.0.1 HMR 扩展 connect-src
    const viteCfg = fs.readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(viteCfg).toContain("apply: 'serve'");
    expect(viteCfg).toContain('http://127.0.0.1:* ws://127.0.0.1:*');
    expect(viteCfg).not.toContain('0.0.0.0');
  });

  it('D1-B：废弃只读历史视图 src/renderer/components/ReadOnlyHistoryView.tsx 已被彻底删除', () => {
    const deletedViewPath = path.join(REPO_ROOT, 'src', 'renderer', 'components', 'ReadOnlyHistoryView.tsx');
    expect(fs.existsSync(deletedViewPath)).toBe(false);
  });

  it('D1-B / DC-FE-01 / F-06：所有已构建的生产 JS Chunk（dist/renderer/assets/*.js）0 命中演示 Mock 泄露特征，GRAVITY_REQUIRE_DIST=1 时缺 dist/ fail-closed', () => {
    const requireDist =
      process.env.GRAVITY_REQUIRE_DIST === '1' ||
      process.env.GRAVITY_REQUIRE_DIST?.toLowerCase() === 'true';
    const assetsDir = path.join(REPO_ROOT, 'dist', 'renderer', 'assets');
    if (!fs.existsSync(assetsDir)) {
      if (requireDist) {
        expect(
          fs.existsSync(assetsDir),
          `F-06 fail-closed: GRAVITY_REQUIRE_DIST=1 requires built dist/renderer/assets (${assetsDir}); run "npm run build" before "npm test".`
        ).toBe(true);
      }
      // 本地开发未设置 GRAVITY_REQUIRE_DIST=1 且未构建时跳过产物扫描；Release/QA 模式严禁静默跳过
      return;
    }

    const jsChunks = fs
      .readdirSync(assetsDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(assetsDir, name));

    if (jsChunks.length === 0) {
      if (requireDist) {
        expect(
          jsChunks.length,
          `F-06 fail-closed: GRAVITY_REQUIRE_DIST=1 found 0 JS chunks under ${assetsDir}.`
        ).toBeGreaterThan(0);
      }
      return;
    }

    const forbiddenSignatures = [
      'sess-primary',
      'C:\\\\Workspace\\\\DemoProject',
      'C:\\Workspace\\DemoProject',
      'C:/Workspace/DemoProject',
      'CoreGateway',
      '演示审批',
    ];

    const leaks: Array<{ file: string; signature: string }> = [];
    for (const chunkPath of jsChunks) {
      const content = fs.readFileSync(chunkPath, 'utf8');
      for (const sig of forbiddenSignatures) {
        if (content.includes(sig)) {
          leaks.push({ file: path.basename(chunkPath), signature: sig });
        }
      }
    }

    expect(leaks, `Production renderer JS chunks leaked mock bridge code: ${JSON.stringify(leaks)}`).toEqual([]);

    // 同步确认 dist/renderer/icons 未包含任何 .png / .ico 重复图标
    const distIconsDir = path.join(REPO_ROOT, 'dist', 'renderer', 'icons');
    if (fs.existsSync(distIconsDir)) {
      const badDistIcons = fs.readdirSync(distIconsDir).filter((name) => /\.(?:png|ico|icns)$/i.test(name));
      expect(badDistIcons).toEqual([]);
    }

    // 若存在 Windows 解包产物，校验不含跨平台图标、.map、.d.ts 与 assets/icons/*.svg
    const winUnpackedApp = path.join(REPO_ROOT, 'release', 'win-unpacked', 'resources', 'app');
    if (fs.existsSync(winUnpackedApp)) {
      const packedFiles = walkFiles(winUnpackedApp).map((f) => path.relative(winUnpackedApp, f).replace(/\\/g, '/'));
      const unexpected = packedFiles.filter(
        (rel) =>
          (rel.startsWith('dist/') && (rel.endsWith('.map') || rel.endsWith('.d.ts'))) ||
          (rel.startsWith('assets/icons/') && !rel.endsWith('.ico'))
      );
      expect(unexpected).toEqual([]);
    }
  });
});

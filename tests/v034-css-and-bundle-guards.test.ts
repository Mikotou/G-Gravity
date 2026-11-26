// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(REPO_ROOT, 'src', 'renderer');
const STYLES_DIR = path.join(RENDERER_DIR, 'styles');

function walkFiles(dir: string, predicate?: (fullPath: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && (!predicate || predicate(full))) {
      results.push(full);
    }
  }
  return results;
}

function relRepo(fullPath: string): string {
  return path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface CssRuleItem {
  file: string;
  atContext: string[];
  rawSelector: string;
  selectors: string[];
  body: string;
  declarations: Array<{ prop: string; value: string }>;
}

interface KeyframesBlock {
  file: string;
  name: string;
  body: string;
  properties: string[];
}

function parseCssFile(filePath: string): { rules: CssRuleItem[]; keyframes: KeyframesBlock[] } {
  const clean = stripCssComments(fs.readFileSync(filePath, 'utf8'));
  const file = relRepo(filePath);
  const rules: CssRuleItem[] = [];
  const keyframes: KeyframesBlock[] = [];
  let i = 0;

  function parseDecls(body: string): Array<{ prop: string; value: string }> {
    const out: Array<{ prop: string; value: string }> = [];
    for (const part of body.split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const prop = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (prop && value) out.push({ prop, value });
    }
    return out;
  }

  function extractKeyframesProps(kfBody: string): string[] {
    const props: string[] = [];
    let k = 0;
    while (k < kfBody.length) {
      const open = kfBody.indexOf('{', k);
      if (open === -1) break;
      let depth = 1;
      let p = open + 1;
      while (p < kfBody.length && depth > 0) {
        if (kfBody[p] === '{') depth += 1;
        else if (kfBody[p] === '}') depth -= 1;
        p += 1;
      }
      const stepBody = kfBody.slice(open + 1, p - 1);
      for (const d of parseDecls(stepBody)) props.push(d.prop);
      k = p;
    }
    return props;
  }

  function parseBlock(atContext: string[], stopOnBrace: boolean): void {
    while (i < clean.length) {
      while (i < clean.length && /\s/.test(clean[i])) i += 1;
      if (i >= clean.length) break;
      if (clean[i] === '}') {
        if (stopOnBrace) i += 1;
        break;
      }
      const start = i;
      while (i < clean.length && clean[i] !== '{' && clean[i] !== ';' && clean[i] !== '}') i += 1;
      if (i >= clean.length) break;
      if (clean[i] === ';') {
        i += 1;
        continue;
      }
      if (clean[i] === '}') {
        if (stopOnBrace) i += 1;
        break;
      }
      const prelude = clean.slice(start, i).replace(/\s+/g, ' ').trim();
      i += 1; // skip '{'

      if (prelude.startsWith('@')) {
        if (/^@(?:media|supports|layer|container)\b/i.test(prelude)) {
          parseBlock([...atContext, prelude], true);
        } else {
          const bodyStart = i;
          let depth = 1;
          while (i < clean.length && depth > 0) {
            if (clean[i] === '{') depth += 1;
            else if (clean[i] === '}') depth -= 1;
            i += 1;
          }
          const kfBody = clean.slice(bodyStart, i - 1);
          const kfMatch = /^@(?:-webkit-)?keyframes\s+([^\s{]+)/i.exec(prelude);
          if (kfMatch) {
            keyframes.push({
              file,
              name: kfMatch[1],
              body: kfBody,
              properties: extractKeyframesProps(kfBody),
            });
          }
        }
        continue;
      }

      const bodyStart = i;
      let depth = 1;
      while (i < clean.length && depth > 0) {
        if (clean[i] === '{') depth += 1;
        else if (clean[i] === '}') depth -= 1;
        i += 1;
      }
      const body = clean.slice(bodyStart, i - 1);
      // Split selector lists only at parenthesis/bracket depth 0 so `:is(a, b)` is never mangled into standalone selectors.
      const selectors: string[] = [];
      let parenDepth = 0;
      let bracketDepth = 0;
      let selStart = 0;
      for (let p = 0; p <= prelude.length; p++) {
        const c = prelude[p];
        if (c === '(') parenDepth++;
        else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (c === '[') bracketDepth++;
        else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        if (p === prelude.length || (c === ',' && parenDepth === 0 && bracketDepth === 0)) {
          const item = prelude.slice(selStart, p).replace(/\s+/g, ' ').trim();
          if (item) selectors.push(item);
          selStart = p + 1;
        }
      }
      rules.push({
        file,
        atContext,
        rawSelector: prelude,
        selectors,
        body,
        declarations: parseDecls(body),
      });
    }
  }

  parseBlock([], false);
  return { rules, keyframes };
}

function getAllCssFiles(): string[] {
  return walkFiles(STYLES_DIR, (f) => f.endsWith('.css')).sort();
}

function isTokensCss(filePath: string): boolean {
  return path.basename(filePath).toLowerCase() === 'tokens.css';
}

describe('Gravity v0.3.4 CSS、图标规范、CSP 与包体静态守卫 (SG-01 ~ SG-11)', () => {
  /* ------------------------------------------------------------------ SG-01 */
  it('SG-01：渲染层 CSS 总字节严格 <= 230 KB（原 301.7 KB 实测收敛至 ~221 KB，生产构建 <= 210 KB）', () => {
    const cssFiles = getAllCssFiles();
    expect(cssFiles.length).toBeGreaterThan(0);

    const breakdown = cssFiles.map((f) => ({
      file: relRepo(f),
      bytes: fs.statSync(f).size,
    }));
    const totalBytes = breakdown.reduce((sum, item) => sum + item.bytes, 0);

    // 实证校准：v0.3.3 三层基线为 301.7 KB（12,672 行），单入口零跨文件重复 + 新增 U-04 7d/30d 热力图与 U-02 模型选择后，
    // 无损可读源码下限为 ~221 KB（净减 >80 KB / -26.8%），生产压缩产物为 ~203 KB（gzip ~36 KB）。
    expect(
      totalBytes,
      `Renderer CSS total ${totalBytes} bytes (${(totalBytes / 1024).toFixed(1)} KB) exceeds 230 KB cap:\n${breakdown
        .map((b) => `  - ${b.file}: ${(b.bytes / 1024).toFixed(1)} KB`)
        .join('\n')}`
    ).toBeLessThanOrEqual(230 * 1024);

    const distAssetsDir = path.join(REPO_ROOT, 'dist', 'renderer', 'assets');
    if (fs.existsSync(distAssetsDir)) {
      const builtCss = fs.readdirSync(distAssetsDir).filter((f) => f.endsWith('.css'));
      const builtTotal = builtCss.reduce((sum, f) => sum + fs.statSync(path.join(distAssetsDir, f)).size, 0);
      expect(
        builtTotal,
        `Built production CSS ${builtTotal} bytes (${(builtTotal / 1024).toFixed(1)} KB) exceeds 210 KB cap`
      ).toBeLessThanOrEqual(210 * 1024);
    }
  });

  /* ------------------------------------------------------------------ SG-02 */
  it('SG-02：跨 CSS 文件重复选择器 = 0', () => {
    const cssFiles = getAllCssFiles();
    const seen = new Map<string, Set<string>>();

    for (const filePath of cssFiles) {
      const { rules } = parseCssFile(filePath);
      const fileRel = relRepo(filePath);
      for (const rule of rules) {
        const atKey = rule.atContext.join(' | ');
        for (const sel of rule.selectors) {
          // 允许各基础/平台文件声明 :root / html / body / * 等基础元素作用域
          if (/^(?::root|html|body|\*|::?[\w-]+)$/.test(sel)) continue;
          const compositeKey = atKey ? `${atKey} :: ${sel}` : sel;
          const files = seen.get(compositeKey) ?? new Set<string>();
          files.add(fileRel);
          seen.set(compositeKey, files);
        }
      }
    }

    const duplicates = Array.from(seen.entries())
      .filter(([, files]) => files.size > 1)
      .map(([sel, files]) => `${sel} -> [${Array.from(files).join(', ')}]`);

    expect(
      duplicates,
      `Found ${duplicates.length} duplicate CSS selectors across files (showing up to 25):\n${duplicates.slice(0, 25).join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-03 */
  it('SG-03：死 CSS 类 = 0（CSS 中定义的每个类名在渲染层源码或入口 HTML 中均有引用）', () => {
    const cssFiles = getAllCssFiles();
    const definedClasses = new Map<string, string>();
    const classDefRe = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;

    for (const filePath of cssFiles) {
      const { rules } = parseCssFile(filePath);
      const fileRel = relRepo(filePath);
      for (const rule of rules) {
        for (const sel of rule.selectors) {
          let m: RegExpExecArray | null;
          classDefRe.lastIndex = 0;
          while ((m = classDefRe.exec(sel))) {
            const cls = m[1];
            if (!definedClasses.has(cls)) definedClasses.set(cls, fileRel);
          }
        }
      }
    }

    const sourceFiles = [
      ...walkFiles(RENDERER_DIR, (f) => /\.(?:ts|tsx)$/.test(f)),
      path.join(REPO_ROOT, 'index.html'),
      path.join(REPO_ROOT, 'tests', 'desktop-layout.fixture.tsx'),
    ].filter((f) => fs.existsSync(f));

    const referencedTokens = new Set<string>();
    const dynamicPrefixes = new Set<string>();

    // 从 JS/TSX 字符串字面量与模板字面量收集静态类名和动态前缀（如 `mode-${...}`, `i-${...}`）
    const tokenRe = /[a-zA-Z_][a-zA-Z0-9_-]*/g;
    const prefixRe = /([a-zA-Z][a-zA-Z0-9_-]*-)\$\{/g;

    for (const srcPath of sourceFiles) {
      const content = fs.readFileSync(srcPath, 'utf8');
      let m: RegExpExecArray | null;
      tokenRe.lastIndex = 0;
      while ((m = tokenRe.exec(content))) {
        referencedTokens.add(m[0]);
      }
      prefixRe.lastIndex = 0;
      while ((m = prefixRe.exec(content))) {
        dynamicPrefixes.add(m[1]);
      }
      // 也识别字符串拼接形式 'level-' + ... / 'is-' + ...
      const concatPrefixRe = /['"]([a-zA-Z][a-zA-Z0-9_-]*-)['"]\s*\+/g;
      while ((m = concatPrefixRe.exec(content))) {
        dynamicPrefixes.add(m[1]);
      }
    }

    // 第三方库（lucide-react）自动输出的 SVG 类名
    const externalRuntimeClasses = new Set(['lucide']);

    const deadClasses: string[] = [];
    for (const [cls, file] of definedClasses.entries()) {
      if (externalRuntimeClasses.has(cls)) continue;
      if (referencedTokens.has(cls)) continue;
      let matchedDynamic = false;
      for (const prefix of dynamicPrefixes) {
        if (cls.startsWith(prefix)) {
          matchedDynamic = true;
          break;
        }
      }
      if (!matchedDynamic) {
        deadClasses.push(`.${cls} (${file})`);
      }
    }

    expect(
      deadClasses,
      `Found ${deadClasses.length} dead CSS classes (showing up to 30):\n${deadClasses.slice(0, 30).join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-04 */
  it('SG-04 (F-16)：tokens.css 外硬编码 hex / rgb / rgba = 0（白名单：图标预览/棋盘格）', () => {
    const cssFiles = getAllCssFiles();
    const whitelistSelectorRe = /\.(?:color-swatch|theme-preview|icon-preview|checkerboard)\b/i;
    const rawColorRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\brgba?\s*\(\s*\d/i;

    const violations: string[] = [];
    for (const filePath of cssFiles) {
      if (isTokensCss(filePath)) continue;
      const { rules } = parseCssFile(filePath);
      for (const rule of rules) {
        if (rule.selectors.every((s) => whitelistSelectorRe.test(s))) continue;
        for (const decl of rule.declarations) {
          if (rawColorRe.test(decl.value)) {
            violations.push(`${rule.file} [${rule.rawSelector}] ${decl.prop}: ${decl.value}`);
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} hardcoded hex/rgb/rgba colors outside tokens.css (showing up to 25):\n${violations.slice(0, 25).join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-05 */
  it('SG-05 (F-03)：CSS 与 TSX 中直接使用 color: var(--accent-primary|--status-*) 作文字色 = 0', () => {
    const violations: string[] = [];
    const bareCssColorRe = /^var\(\s*--(?:accent-primary|status-(?:success|warning|danger))\s*\)(?:\s*!important)?$/i;

    for (const filePath of getAllCssFiles()) {
      const { rules } = parseCssFile(filePath);
      for (const rule of rules) {
        for (const decl of rule.declarations) {
          if (decl.prop === 'color' && bareCssColorRe.test(decl.value.trim())) {
            violations.push(`${rule.file} [${rule.rawSelector}] color: ${decl.value}`);
          }
        }
      }
    }

    const bareTsxInlineColorRe = /\bcolor\s*:\s*['"]var\(\s*--(?:accent-primary|status-(?:success|warning|danger))\s*\)['"]/g;
    for (const srcPath of walkFiles(RENDERER_DIR, (f) => /\.(?:ts|tsx)$/.test(f))) {
      const content = fs.readFileSync(srcPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx += 1) {
        if (bareTsxInlineColorRe.test(lines[idx])) {
          violations.push(`${relRepo(srcPath)}:${idx + 1}: ${lines[idx].trim()}`);
        }
        bareTsxInlineColorRe.lastIndex = 0;
      }
    }

    expect(
      violations,
      `Found ${violations.length} raw low-contrast semantic text colors (showing up to 25):\n${violations.slice(0, 25).join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-06 */
  it('SG-06：非合成属性动画（width/height/top/left/margin/box-shadow/filter）= 0', () => {
    const forbiddenProps = new Set([
      'width',
      'height',
      'top',
      'left',
      'margin',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'box-shadow',
      'filter',
    ]);
    const forbiddenTransitionRe = /\b(width|height|top|left|margin(?:-(?:top|right|bottom|left))?|box-shadow|filter)\b/i;

    const violations: string[] = [];

    for (const filePath of getAllCssFiles()) {
      const { rules, keyframes } = parseCssFile(filePath);
      for (const kf of keyframes) {
        const bad = kf.properties.filter((p) => forbiddenProps.has(p));
        if (bad.length > 0) {
          violations.push(`${kf.file} @keyframes ${kf.name} animates non-composited: ${Array.from(new Set(bad)).join(', ')}`);
        }
      }
      for (const rule of rules) {
        for (const decl of rule.declarations) {
          if (decl.prop === 'transition' || decl.prop === 'transition-property') {
            if (/^none\b/i.test(decl.value)) continue;
            const match = forbiddenTransitionRe.exec(decl.value);
            if (match) {
              violations.push(`${rule.file} [${rule.rawSelector}] ${decl.prop}: ${decl.value}`);
            }
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} non-composited property animations/transitions (showing up to 25):\n${violations.slice(0, 25).join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-07 */
  it('SG-07：tokens.css 外硬编码动画时长（ms/s）与 cubic-bezier = 0', () => {
    const violations: string[] = [];
    const timingPropRe = /^(?:transition|transition-duration|transition-delay|animation|animation-duration|animation-delay)$/;
    const cubicRe = /\bcubic-bezier\s*\(/i;
    const hardcodedDurationRe = /(?:^|[\s,(])(\d+(?:\.\d+)?)(m?s)\b/gi;

    for (const filePath of getAllCssFiles()) {
      if (isTokensCss(filePath)) continue;
      const { rules } = parseCssFile(filePath);
      for (const rule of rules) {
        const inReducedMotion = rule.atContext.some((ctx) => /prefers-reduced-motion\s*:\s*reduce/i.test(ctx));
        for (const decl of rule.declarations) {
          if (decl.prop.startsWith('--')) continue;
          if (cubicRe.test(decl.value)) {
            violations.push(`${rule.file} [${rule.rawSelector}] ${decl.prop}: ${decl.value} (hardcoded cubic-bezier)`);
            continue;
          }
          if (timingPropRe.test(decl.prop) && !inReducedMotion) {
            // Strip var(...) arguments before scanning for hardcoded durations
            const stripped = decl.value.replace(/var\([^)]*\)/g, '');
            hardcodedDurationRe.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = hardcodedDurationRe.exec(stripped))) {
              const num = Number(m[1]);
              if (num === 0) continue; // 0s / 0ms allowed as explicit zero delay/duration
              violations.push(`${rule.file} [${rule.rawSelector}] ${decl.prop}: ${decl.value} (hardcoded ${m[1]}${m[2]})`);
              break;
            }
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} hardcoded animation durations / cubic-bezier outside tokens.css (showing up to 25):\n${violations.slice(0, 25).join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-08 */
  it('SG-08：!important 仅允许用于 prefers-reduced-motion 与 .gv-resizing 白名单', () => {
    const violations: string[] = [];

    for (const filePath of getAllCssFiles()) {
      const { rules } = parseCssFile(filePath);
      for (const rule of rules) {
        const inReducedMotion = rule.atContext.some((ctx) => /prefers-reduced-motion\s*:\s*reduce/i.test(ctx));
        const isResizingRule = rule.selectors.every((sel) => /\.gv-resizing\b/.test(sel));
        for (const decl of rule.declarations) {
          if (/!important\b/i.test(decl.value) && !inReducedMotion && !isResizingRule) {
            violations.push(`${rule.file} [${rule.rawSelector}] ${decl.prop}: ${decl.value}`);
          }
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} disallowed !important declarations:\n${violations.join('\n')}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-09 */
  it('SG-09 (F-06 fail-closed)：生产 JS Chunk 0 Mock 泄露 & 0「演示审批」，缺失 dist/ 时强制失败', () => {
    const assetsDir = path.join(REPO_ROOT, 'dist', 'renderer', 'assets');
    expect(
      fs.existsSync(assetsDir),
      `SG-09 fail-closed: production bundle directory missing (${assetsDir}). Run "npm run build" before "npm test".`
    ).toBe(true);

    const jsChunks = fs
      .readdirSync(assetsDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(assetsDir, name));

    expect(
      jsChunks.length,
      `SG-09 fail-closed: found 0 production JS chunks in ${assetsDir}`
    ).toBeGreaterThan(0);

    const forbiddenSignatures = [
      'sess-primary',
      'CoreGateway',
      'C:\\\\Workspace\\\\DemoProject',
      'C:\\Workspace\\DemoProject',
      'C:/Workspace/DemoProject',
      '演示审批',
      'triggerDemoApproval',
      'Demo Approval',
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

    expect(leaks, `Production renderer JS chunks leaked mock/demo artifacts: ${JSON.stringify(leaks)}`).toEqual([]);

    const distIconsDir = path.join(REPO_ROOT, 'dist', 'renderer', 'icons');
    if (fs.existsSync(distIconsDir)) {
      const badDistIcons = fs.readdirSync(distIconsDir).filter((name) => /\.(?:png|ico|icns)$/i.test(name));
      expect(badDistIcons).toEqual([]);
    }
  });

  /* ------------------------------------------------------------------ SG-10 */
  it('SG-10：D2-A 纯本地 CSP 与 CSS 0 外链 url(http...) / 外部 @import', () => {
    // 1) index.html CSP
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const cspMatch = /http-equiv=(["'])Content-Security-Policy\1[\s\S]*?content=(["'])([\s\S]*?)\2/i.exec(html);
    expect(cspMatch, 'index.html must declare Content-Security-Policy meta tag').toBeTruthy();

    const directives = new Map<string, string>();
    for (const part of cspMatch![3].split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const sp = trimmed.indexOf(' ');
      if (sp === -1) directives.set(trimmed.toLowerCase(), '');
      else directives.set(trimmed.slice(0, sp).toLowerCase(), trimmed.slice(sp + 1).trim());
    }
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('img-src')).toBe("'self' data: blob:");
    expect(directives.get('connect-src')).toBe("'self'");
    expect(directives.get('img-src')).not.toMatch(/\b(?:http:|https:|file:)\b/i);
    expect(directives.get('connect-src')).not.toMatch(/\b(?:http:|https:|ws:|wss:)\b/i);

    // 2) vite.config.ts dev-only 127.0.0.1 HMR
    const viteCfg = fs.readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');
    expect(viteCfg).toContain("apply: 'serve'");
    expect(viteCfg).toContain('http://127.0.0.1:* ws://127.0.0.1:*');
    expect(viteCfg).not.toContain('0.0.0.0');

    // 3) CSS 0 external url(http/https/protocol-relative) & 0 external @import
    const externalUrlRe = /url\(\s*['"]?\s*(?:https?:|\/\/)/i;
    const externalImportRe = /@import\s+(?:url\(\s*)?['"]?\s*(?:https?:|\/\/)/i;
    const cssExternalViolations: string[] = [];

    for (const filePath of getAllCssFiles()) {
      const clean = stripCssComments(fs.readFileSync(filePath, 'utf8'));
      const lines = clean.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx += 1) {
        if (externalUrlRe.test(lines[idx]) || externalImportRe.test(lines[idx])) {
          cssExternalViolations.push(`${relRepo(filePath)}:${idx + 1}: ${lines[idx].trim()}`);
        }
      }
    }
    expect(cssExternalViolations).toEqual([]);
  });

  /* ------------------------------------------------------------------ SG-11 */
  it('SG-11：除 src/renderer/components/ui/Icon.tsx 外组件源码直接 lucide size={数字} = 0', () => {
    const iconWrapperRel = 'src/renderer/components/ui/Icon.tsx';
    const tsxFiles = walkFiles(RENDERER_DIR, (f) => f.endsWith('.tsx'));
    const violations: string[] = [];

    for (const filePath of tsxFiles) {
      const rel = relRepo(filePath);
      if (rel === iconWrapperRel) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      // 收集本文件从 'lucide-react' 导入的全部图标标识符（支持 alias: `Foo as Bar`）
      const lucideNames = new Set<string>();
      const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*['"]lucide-react['"]/g;
      let imp: RegExpExecArray | null;
      while ((imp = importRe.exec(content))) {
        for (const spec of imp[1].split(',')) {
          const trimmed = spec.replace(/^\s*type\s+/, '').trim();
          if (!trimmed) continue;
          const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
          lucideNames.add(asMatch ? asMatch[1] : trimmed);
        }
      }
      if (lucideNames.size === 0) continue;

      // 扫描本文件中直接给 lucide 图标组件传入数值 size={n} 的调用
      const jsxTagRe = /<([A-Z][A-Za-z0-9_$]*)\b([^>]*?)\bsize=\{\s*\d+(?:\.\d+)?\s*\}/g;
      let tag: RegExpExecArray | null;
      while ((tag = jsxTagRe.exec(content))) {
        const compName = tag[1];
        if (lucideNames.has(compName) || compName === 'Icon') {
          const lineNum = content.slice(0, tag.index).split(/\r?\n/).length;
          violations.push(`${rel}:${lineNum}: <${compName} ... size={...}>`);
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} direct lucide icon size={number} usages outside ${iconWrapperRel} (showing up to 25):\n${violations.slice(0, 25).join('\n')}`
    ).toEqual([]);
  });
});

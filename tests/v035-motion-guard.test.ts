// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * v0.3.5 MO-01 动效守卫：静态扫描 `src/renderer/styles/**\/*.css`
 * - 全部 @keyframes 只允许动画 GPU 合成属性（transform / opacity，及控制缓动的 animation-timing-function）；
 * - 不得出现 background-position 动画或布局属性（width / height / top / left / margin …）过渡；
 * - 每个 `animation:` 引用的关键帧名必须存在；
 * - 具备 prefers-reduced-motion 全局兜底；渲染层 TSX 不得内联 transition / animation。
 */

const ROOT = path.resolve(__dirname, '..');
const STYLES = path.join(ROOT, 'src/renderer/styles');

function walk(dir: string, ext: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 提取 @keyframes name { ... } 的完整块（处理嵌套花括号） */
function extractKeyframes(css: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const COMPOSITED = new Set(['transform', 'opacity', 'animation-timing-function']);
const LAYOUT_PROPS = /\b(?:width|height|top|left|right|bottom|inset|margin(?:-\w+)?|padding(?:-\w+)?|background-position(?:-[xy])?|background-size|font-size|line-height|border-width|max-height|max-width|min-height|min-width)\b/;

const cssFiles = walk(STYLES, '.css');
const allCss = cssFiles.map((f) => ({ file: path.relative(ROOT, f), css: stripComments(fs.readFileSync(f, 'utf8')) }));

describe('v0.3.5 MO-01 动效守卫（静态扫描全部渲染层 CSS）', () => {
  it('扫描到样式文件与关键帧', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(15);
    expect(allCss.flatMap(({ css }) => extractKeyframes(css)).length).toBeGreaterThanOrEqual(15);
  });

  it('全部 @keyframes 只动画 transform / opacity（0 非合成动画）', () => {
    const violations: string[] = [];
    for (const { file, css } of allCss) {
      for (const kf of extractKeyframes(css)) {
        const props = Array.from(kf.body.matchAll(/([a-z-]+)\s*:/g)).map((x) => x[1]);
        for (const prop of props) {
          if (!COMPOSITED.has(prop)) violations.push(`${file} @keyframes ${kf.name} → ${prop}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('5 处旧 background-position 流光（shimmer / gv-activity-flow / gv-busy-line / zh-rail-flow / gv-guardian-sweep）已改为 transform 或 opacity', () => {
    const frames = new Map(allCss.flatMap(({ css }) => extractKeyframes(css)).map((k) => [k.name, k.body]));
    expect(frames.has('shimmer')).toBe(false);
    expect(frames.get('gv-activity-flow')).toMatch(/transform:\s*translateX/);
    expect(frames.get('gv-busy-line')).toMatch(/transform:\s*translateX/);
    expect(frames.get('gv-guardian-sweep')).toMatch(/transform:\s*translateX/);
    expect(frames.get('zh-rail-flow')).toMatch(/opacity/);
    expect(allCss.some(({ css }) => /animation[^;]*\bshimmer\b/.test(css))).toBe(false);
    for (const { css } of allCss) expect(css).not.toMatch(/background-size:[^;]*;[^}]*animation:\s*(?:zh-rail-flow|gv-activity-flow|gv-busy-line|gv-guardian-sweep)/);
  });

  it('窗格与 Composer 的流光使用独立裁切装饰 span（不在窗格 / 输入框本身加 overflow: hidden）', () => {
    const pane = allCss.find((c) => c.file.endsWith('pane.css'))!.css;
    const composer = allCss.find((c) => c.file.endsWith('composer.css'))!.css;
    expect(pane).toMatch(/\.pane-activity-rail\s*\{[^}]*overflow:\s*hidden/);
    expect(composer).toMatch(/\.composer-busy-rail\s*\{[^}]*overflow:\s*hidden/);
    expect(pane).not.toMatch(/\.pane\[data-pane-state='streaming'\]::before/);
    expect(composer).not.toMatch(/\.composer\.is-busy::before/);
    const sessionPane = fs.readFileSync(path.join(ROOT, 'src/renderer/components/SessionPane.tsx'), 'utf8');
    const composerTsx = fs.readFileSync(path.join(ROOT, 'src/renderer/components/Composer.tsx'), 'utf8');
    expect(sessionPane).toContain('pane-activity-rail');
    expect(composerTsx).toContain('composer-busy-rail');
  });

  it('不存在布局属性的 transition（width / height / top / left / margin / background-position …）', () => {
    const violations: string[] = [];
    for (const { file, css } of allCss) {
      for (const m of css.matchAll(/transition(?:-property)?\s*:\s*([^;}]+)/g)) {
        const value = m[1];
        if (/^\s*none\s*$/.test(value)) continue;
        if (LAYOUT_PROPS.test(value) || /\ball\b/.test(value)) violations.push(`${file}: transition: ${value.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('每个 animation 引用的关键帧都已定义', () => {
    const names = new Set(allCss.flatMap(({ css }) => extractKeyframes(css)).map((k) => k.name));
    const missing: string[] = [];
    for (const { file, css } of allCss) {
      for (const m of css.matchAll(/animation\s*:\s*([^;}]+)/g)) {
        const first = m[1].trim().split(/[\s,]+/)[0];
        if (first === 'none' || first.startsWith('var(')) continue;
        if (!names.has(first)) missing.push(`${file}: ${first}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('具备 prefers-reduced-motion 全局兜底（* 与伪元素的动画 / 过渡时长收敛）', () => {
    const base = allCss.find((c) => c.file.endsWith(path.join('styles', 'base.css')))!.css;
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(base)?.[1] ?? '';
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(block).toMatch(/animation-duration:[^;]*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/transition-duration:[^;]*!important/);
  });

  it('渲染层 TSX 不再内联 transition / animation（含 ContextCostInspectorView 迷你圆环）', () => {
    const tsx = walk(path.join(ROOT, 'src/renderer'), '.tsx');
    const offenders = tsx.filter((f) => /\b(?:transition|animation)\s*:\s*['"`]/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    const ccv = fs.readFileSync(path.join(ROOT, 'src/renderer/components/ContextCostInspectorView.tsx'), 'utf8');
    expect(ccv).not.toMatch(/stroke-dasharray 0\.3s/);
  });

  it('全部样式文件不存在空 var() 语法残留', () => {
    const emptyVars = allCss
      .filter(({ css }) => /var\(\s*\)/.test(css))
      .map(({ file }) => file);
    expect(emptyVars).toEqual([]);
  });
});

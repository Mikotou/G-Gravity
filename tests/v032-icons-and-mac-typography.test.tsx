import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRAVITY_ICON_VARIANTS,
  type ApproveForMeConfig,
  type ClientPreferences,
  type SwarmTopologyState,
} from '@shared';
import { IconsPanel } from '../src/renderer/components/settings/AppearancePanels';
import { ApprovalsPanel } from '../src/renderer/components/settings/WorkspacePanels';
import { SwarmPanel } from '../src/renderer/components/SwarmPanel';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

const REPO_ROOT = path.resolve(__dirname, '..');

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface CssRuleBlock {
  selectors: string[];
  rawSelector: string;
  body: string;
  atContext: string[];
}

/** 轻量级 CSS 规则解析器：剥离注释，支持按嵌套 @media / @container 收集每个选择器块及其声明体。 */
function parseCssRules(css: string): CssRuleBlock[] {
  const clean = stripCssComments(css);
  const rules: CssRuleBlock[] = [];

  function walk(input: string, atContext: string[]): void {
    let i = 0;
    const len = input.length;
    while (i < len) {
      while (i < len && /[\s;]/.test(input[i])) i += 1;
      if (i >= len) break;

      const start = i;
      let braceIdx = -1;
      let semiIdx = -1;
      let inQuote: string | null = null;
      let parenDepth = 0;
      for (let j = i; j < len; j += 1) {
        const ch = input[j];
        if (inQuote) {
          if (ch === '\\') j += 1;
          else if (ch === inQuote) inQuote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === '(') {
          parenDepth += 1;
        } else if (ch === ')') {
          parenDepth = Math.max(0, parenDepth - 1);
        } else if (parenDepth === 0 && ch === '{') {
          braceIdx = j;
          break;
        } else if (parenDepth === 0 && ch === ';') {
          semiIdx = j;
          break;
        }
      }

      if (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx)) {
        i = semiIdx + 1;
        continue;
      }
      if (braceIdx === -1) break;

      const header = input.slice(start, braceIdx).trim();
      let depth = 1;
      let endIdx = braceIdx + 1;
      inQuote = null;
      while (endIdx < len && depth > 0) {
        const ch = input[endIdx];
        if (inQuote) {
          if (ch === '\\') endIdx += 1;
          else if (ch === inQuote) inQuote = null;
        } else if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        endIdx += 1;
      }

      const body = input.slice(braceIdx + 1, endIdx);
      if (header.startsWith('@')) {
        if (/^@(?:media|supports|container|layer)\b/i.test(header)) {
          walk(body, [...atContext, header]);
        }
      } else if (header) {
        const selectors = splitTopLevelCommas(header).map((s) => normalizeSelector(s));
        rules.push({
          selectors,
          rawSelector: normalizeSelector(header),
          body,
          atContext,
        });
      }
      i = endIdx + 1;
    }
  }

  walk(clean, []);
  return rules;
}

function splitTopLevelCommas(selectorList: string): string[] {
  const out: string[] = [];
  let buf = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  for (let i = 0; i < selectorList.length; i += 1) {
    const ch = selectorList[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < selectorList.length) {
        buf += selectorList[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '(') {
      parenDepth += 1;
      buf += ch;
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      buf += ch;
    } else if (ch === '[') {
      bracketDepth += 1;
      buf += ch;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      buf += ch;
    } else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function normalizeSelector(sel: string): string {
  return sel.replace(/\s+/g, ' ').replace(/\s*>\s*/g, ' > ').trim();
}

function extractDeclarations(body: string): Array<[string, string]> {
  const decls: Array<[string, string]> = [];
  let buf = '';
  let parenDepth = 0;
  let quote: string | null = null;

  const flush = () => {
    const trimmed = buf.trim();
    buf = '';
    if (!trimmed) return;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return;
    const prop = trimmed.slice(0, colon).trim().toLowerCase();
    const val = trimmed.slice(colon + 1).trim();
    if (prop && val) decls.push([prop, val]);
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < body.length) {
        buf += body[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === '(') {
      parenDepth += 1;
      buf += ch;
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      buf += ch;
    } else if (ch === ';' && parenDepth === 0) {
      flush();
    } else {
      buf += ch;
    }
  }
  flush();
  return decls;
}

function getEffectiveDeclarations(
  allRules: CssRuleBlock[],
  predicate: (selector: string, rule: CssRuleBlock) => boolean
): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of allRules) {
    if (rule.selectors.some((sel) => predicate(sel, rule))) {
      for (const [prop, val] of extractDeclarations(rule.body)) {
        map.set(prop, val);
      }
    }
  }
  return map;
}

function isBoxShadowNone(val: string | undefined): boolean {
  if (!val) return true;
  return /^(?:none|unset|initial)(?:\s*!important)?$/i.test(val.trim());
}

beforeEach(() => {
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  vi.restoreAllMocks();
});

describe('v0.3.2 双端图标视觉、macOS 排版体系与 FE-14 / FE-15 / FE-16 / FE-17 回归守卫', () => {
  // 兼容 v0.3.4 单一入口 src/renderer/styles/index.css（按 @import 递归展开）与历史三文件层叠顺序
  const stylesDir = path.join(REPO_ROOT, 'src/renderer/styles');
  const readCssRecursive = (filePath: string, seen = new Set<string>()): string => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return '';
    seen.add(resolved);
    const raw = fs.readFileSync(resolved, 'utf8');
    const dir = path.dirname(resolved);
    return raw.replace(/@import\s+(?:url\()?['"](\.[^'"]+)['"]\)?\s*;/g, (_m, rel: string) =>
      readCssRecursive(path.join(dir, rel), seen)
    );
  };
  const indexCssPath = path.join(stylesDir, 'index.css');
  const combinedRawCss = fs.existsSync(indexCssPath)
    ? readCssRecursive(indexCssPath)
    : ['global.css', 'design-system.css', 'claude-studio.css']
        .map((name) => path.join(stylesDir, name))
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p, 'utf8'))
        .join('\n');

  const allRules = parseCssRules(combinedRawCss);
  const combinedCleanCss = stripCssComments(combinedRawCss);

  it('ICON-01：.welcome-logo、.icon-card img、.about-hero img 不再使用外层矩形 box-shadow 悬浮环，改用 filter: drop-shadow', () => {
    const targets = [
      { label: '.welcome-logo', exact: '.welcome-logo' },
      { label: '.icon-card img', exact: '.icon-card img' },
      { label: '.about-hero img', exact: '.about-hero img' },
    ];

    for (const target of targets) {
      const decls = getEffectiveDeclarations(allRules, (sel, rule) => rule.atContext.length === 0 && sel === target.exact);
      const boxShadow = decls.get('box-shadow');
      const filter = decls.get('filter') ?? '';

      expect(
        isBoxShadowNone(boxShadow),
        `${target.label} 不应保留外层矩形 box-shadow，当前为: ${boxShadow}`
      ).toBe(true);
      expect(
        filter,
        `${target.label} 应使用贴合透明轮廓的 filter: drop-shadow(...)，当前为: "${filter}"`
      ).toMatch(/drop-shadow\(/i);
    }

    // 浅色主题下 .welcome-logo 同样不得使用暖棕外层矩形 box-shadow（#3d2a1a / #5a3a22）
    const lightWelcomeDecls = getEffectiveDeclarations(
      allRules,
      (sel) => /\[data-polarity=['"]light['"]\]\s+\.welcome-logo$/.test(sel)
    );
    const lightBoxShadow = lightWelcomeDecls.get('box-shadow');
    expect(
      isBoxShadowNone(lightBoxShadow),
      `[data-polarity='light'] .welcome-logo 不应保留外层矩形 box-shadow，当前为: ${lightBoxShadow}`
    ).toBe(true);
  });

  it('ICON-03：mac-inset 下 .activity-rail 不再用通栏 border-right 穿透红绿灯，改为顶栏下方局部竖线', () => {
    const macRailDecls = getEffectiveDeclarations(
      allRules,
      (sel) => /\[data-window-chrome=['"]mac-inset['"]\]\s+\.activity-rail$/.test(sel)
    );

    const borderRight = (macRailDecls.get('border-right') ?? '').trim();
    const borderRightWidth = (macRailDecls.get('border-right-width') ?? '').trim();
    const borderRightColor = (macRailDecls.get('border-right-color') ?? '').trim();

    const clearedFullBorderRight =
      /^(?:none|0(?:px)?)(?:\s*!important)?$/i.test(borderRight) ||
      /^0(?:px)?(?:\s*!important)?$/i.test(borderRightWidth) ||
      /^transparent(?:\s*!important)?$/i.test(borderRightColor);

    expect(
      clearedFullBorderRight,
      `mac-inset 下 .activity-rail 必须取消通栏 border-right（当前 border-right="${borderRight}"）`
    ).toBe(true);

    // 应通过 ::after（从 top: var(--header-h) 开始）绘制顶栏下方的右缘分隔线
    const macRailAfterDecls = getEffectiveDeclarations(
      allRules,
      (sel) => /\[data-window-chrome=['"]mac-inset['"]\]\s+\.activity-rail::after$/.test(sel)
    );
    const afterTop = macRailAfterDecls.get('top') ?? '';
    expect(
      afterTop,
      `mac-inset .activity-rail::after 应从 var(--header-h) 下方起画，当前 top="${afterTop}"`
    ).toMatch(/var\(--header-h/);
  });

  it('FE-14：.cc-bullet 行高动态绑定 var(--md-fs) 与 var(--md-lh)，不再硬编码 13.5px', () => {
    const bulletRules = allRules.filter((r) => r.selectors.includes('.cc-bullet'));
    expect(bulletRules.length).toBeGreaterThan(0);

    const combinedBulletBody = bulletRules.map((r) => r.body).join('\n');
    expect(combinedBulletBody).not.toContain('13.5px');

    const effective = getEffectiveDeclarations(allRules, (sel, rule) => rule.atContext.length === 0 && sel === '.cc-bullet');
    const metricVal = `${effective.get('line-height') ?? ''} ${effective.get('height') ?? ''}`;
    expect(metricVal).toContain('var(--md-fs');
    expect(metricVal).toContain('var(--md-lh');
  });

  it('macOS 正文排版体系：Apple 原生字体栈、text-autospace、72ch 行宽、浅色字体平滑优化与独立 macos-light/dark 阴影阶梯', () => {
    // 1) Apple 原生字体栈（SF Pro Text / PingFang SC / SF Mono）
    const macScopeRules = allRules.filter((r) =>
      r.selectors.some((sel) => /mac-inset|data-platform=['"]darwin['"]/.test(sel))
    );
    const macCssText = macScopeRules.map((r) => `${r.rawSelector} { ${r.body} }`).join('\n');

    expect(macCssText).toMatch(/SF Pro Text/i);
    expect(macCssText).toMatch(/PingFang SC/i);
    expect(macCssText).toMatch(/SF Mono/i);

    // 2) 中英混排自动微间距 text-autospace
    expect(combinedCleanCss).toMatch(/text-autospace\s*:/i);

    // 3) 黄金阅读行宽 72ch 控制
    expect(combinedCleanCss).toMatch(/\b72ch\b/i);

    // 4) mac-inset 浅色模式字体平滑优化（解决浅色黑字发灰偏细）
    const macLightSmoothingRules = allRules.filter(
      (r) =>
        r.selectors.some(
          (sel) => /mac-inset/.test(sel) && /data-polarity=['"]light['"]/.test(sel)
        ) && /-webkit-font-smoothing\s*:/i.test(r.body)
    );
    expect(
      macLightSmoothingRules.length,
      "应为 mac-inset[data-polarity='light'] 定义浅色字体平滑优化规则"
    ).toBeGreaterThan(0);

    // 5) :root[data-theme='macos-light'] 与 :root[data-theme='macos-dark'] 独立阴影阶梯，且不含暖棕 #1a1613 / #3d2a1a
    for (const themeId of ['macos-light', 'macos-dark'] as const) {
      const themeRules = allRules.filter((r) =>
        r.selectors.some((sel) => new RegExp(`data-theme=['"]${themeId}['"]`).test(sel))
      );
      expect(
        themeRules.length,
        `应声明 [data-theme='${themeId}'] 独立主题表面与阴影规则`
      ).toBeGreaterThan(0);

      const themeBody = themeRules.map((r) => r.body).join('\n');
      expect(
        themeBody,
        `[data-theme='${themeId}'] 应定义独立阴影阶梯变量（--studio-*-shadow / --shadow-*）`
      ).toMatch(/--(?:studio-[a-z-]+-shadow|shadow-[a-z-]+)\s*:/i);
      expect(themeBody.toLowerCase()).not.toContain('#1a1613');
      expect(themeBody.toLowerCase()).not.toContain('#3d2a1a');
    }
  });

  it('FE-15 (CSS 窄分屏审批卡)：.request-view .option-primary 在窄窗格下允许收缩或折行，避免溢出版面裁切', () => {
    const baseOptionPrimary = getEffectiveDeclarations(
      allRules,
      (sel, rule) => rule.atContext.length === 0 && (sel === '.request-view .option-primary' || sel === '.option-btn .option-primary')
    );
    const narrowOptionPrimaryRules = allRules.filter(
      (r) =>
        r.atContext.some((ctx) => /@container\s+pane/i.test(ctx)) &&
        r.selectors.some((sel) => /\.option-primary\b/.test(sel))
    );

    const baseAllowsShrink =
      baseOptionPrimary.get('flex-shrink') !== '0' ||
      baseOptionPrimary.has('min-width') ||
      (baseOptionPrimary.get('flex-wrap') ?? '').includes('wrap');
    const narrowOverridesShrink = narrowOptionPrimaryRules.some((r) =>
      /flex-shrink\s*:\s*1|min-width\s*:\s*0|flex-wrap\s*:\s*wrap|white-space\s*:\s*normal/i.test(r.body)
    );

    expect(
      baseAllowsShrink || narrowOverridesShrink,
      '.request-view .option-primary 应在基础规则或窄分屏容器查询下允许收缩/折行，而非始终锁死 flex-shrink: 0'
    ).toBe(true);
  });

  it('FE-16：mac-inset 悬浮 Inspector 定义顶部偏移，且 .session-actions-dialog 声明 -webkit-app-region: no-drag', () => {
    // 1) mac-inset 悬浮 Inspector 顶部偏移
    const macFloatingInspectorDecls = getEffectiveDeclarations(
      allRules,
      (sel) => /\[data-window-chrome=['"]mac-inset['"]\]\s+\.inspector\.is-floating$/.test(sel)
    );
    const floatingTop = macFloatingInspectorDecls.get('top') ?? '';
    expect(
      floatingTop,
      "mac-inset 下 .inspector.is-floating 必须声明 top 偏移（如 calc(var(--header-h) + 10px)）"
    ).toMatch(/var\(--header-h|\d+px/);

    // 2) .session-actions-dialog 声明 no-drag 热区隔离
    const sessionDialogDecls = getEffectiveDeclarations(
      allRules,
      (sel) => /\.session-actions-dialog\b/.test(sel) && !/::backdrop/.test(sel)
    );
    const appRegion = sessionDialogDecls.get('-webkit-app-region') ?? sessionDialogDecls.get('app-region') ?? '';
    expect(
      appRegion.toLowerCase(),
      '.session-actions-dialog 必须声明 -webkit-app-region: no-drag 以避免在 mac-inset 顶栏下无法点击'
    ).toContain('no-drag');
  });

  it('FE-17 (WCAG AA 语义文字色)：WorkspacePanels、AppearancePanels、SwarmPanel 不再裸用低对比度 --status-* / --accent-primary 内联文字色', async () => {
    // 1) 静态源码检查：三大组件中不得在内联 style.color 裸用未派生 AA 的 --status-* / --accent-primary
    const bareInlineColorRe = /color\s*:\s*[^,\n}]*['"]var\(--(?:status-(?:danger|success|warning)|accent-primary)\)['"]/;
    const targets = [
      'src/renderer/components/settings/WorkspacePanels.tsx',
      'src/renderer/components/settings/AppearancePanels.tsx',
      'src/renderer/components/SwarmPanel.tsx',
    ];
    for (const relPath of targets) {
      const src = readRepoFile(relPath);
      expect(
        bareInlineColorRe.test(src),
        `${relPath} 仍存在裸用低对比度 --status-* / --accent-primary 的内联文字色，请改用 --*-text 语义变量`
      ).toBe(false);
    }

    // 2) 运行时渲染验证：SwarmPanel 工作态与完成态文字不使用裸 var(--accent-primary) / var(--status-success)
    const topology: SwarmTopologyState = {
      sessionId: 'sess-fe17',
      isActive: true,
      swarmTitle: 'AA Contrast Check',
      channels: ['main'],
      workers: [
        {
          id: 'w1',
          name: 'worker-running',
          role: 'Frontend QA',
          kind: 'swarm-worker',
          model: 'gemini-4-neon',
          status: 'working',
          workspaceMode: 'share',
          channels: ['main'],
          brief: 'Verify contrast',
          currentAction: 'Auditing inline semantic colors',
          startedAt: '2026-11-25T12:00:00.000Z',
          updatedAt: '2026-11-25T12:00:00.000Z',
        },
        {
          id: 'w2',
          name: 'worker-done',
          role: 'CSS Auditor',
          kind: 'swarm-worker',
          model: 'gemini-4-neon',
          status: 'completed',
          workspaceMode: 'inherit',
          channels: ['main'],
          brief: 'Verify completed contrast',
          resultSummary: 'All WCAG AA checks passed',
          startedAt: '2026-11-25T12:00:00.000Z',
          updatedAt: '2026-11-25T12:01:00.000Z',
        },
      ],
      boardMessages: [],
      actionTimeline: [],
      stats: { total: 2, working: 1, waiting: 0, completed: 1, killed: 0 },
      updatedAt: '2026-11-25T12:01:00.000Z',
    };

    const swarmView = render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <SwarmPanel sessionId="sess-fe17" topology={topology} />
      </I18nProvider>
    );
    const workerLines = Array.from(swarmView.container.querySelectorAll<HTMLElement>('.worker-line'));
    for (const line of workerLines) {
      expect(line.style.color).not.toBe('var(--accent-primary)');
      expect(line.style.color).not.toBe('var(--status-success)');
    }
    swarmView.unmount();

    // 3) 运行时渲染验证：ApprovalsPanel 复核错误提示不使用裸 var(--status-danger)
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      testExternalReviewerConnection: vi.fn().mockRejectedValue(new Error('Invalid API key')),
    };
    const approvalCfg: ApproveForMeConfig = {
      mode: 'rules-only',
      enableSafeDownloadAutoApprove: false,
      maxDownloadSizeMB: 50,
      cacheTtlHours: 24,
      allowPatterns: [],
      askPatterns: [],
      denyPatterns: [],
      externalReviewer: {
        enabled: false,
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-invalid-test-key-1234567890',
        timeoutMs: 8000,
        maxOutputTokens: 4096,
        thinkingLevel: 'auto',
      },
    };
    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <ApprovalsPanel
          config={approvalCfg}
          auditEntries={[]}
          initialTab="reviewer"
          onUpdateConfig={vi.fn().mockResolvedValue(undefined)}
        />
      </I18nProvider>
    );
    fireEvent.click(screen.getByTestId('test-reviewer-connection-btn'));
    const feedback = await waitFor(() => {
      const el = screen.getByTestId('reviewer-activation-feedback');
      expect(el.textContent).toContain('Invalid API key');
      return el;
    });
    expect(feedback.style.color).not.toBe('var(--status-danger)');
  });

  it('ICON-02 (GRAVITY_ICON_VARIANTS 契约)：全部 6 套图标均声明唯一有效的 assetMacPngRelPath 且 IconsPanel 完整渲染', () => {
    expect(GRAVITY_ICON_VARIANTS).toHaveLength(6);

    const macPaths = new Set<string>();
    for (const variant of GRAVITY_ICON_VARIANTS) {
      expect(typeof variant.assetMacPngRelPath).toBe('string');
      expect(variant.assetMacPngRelPath).toBe(`assets/icons/${variant.id}-mac.png`);
      expect(variant.assetMacPngRelPath).toMatch(/^assets\/icons\/gravity-[a-z-]+-mac\.png$/);
      macPaths.add(variant.assetMacPngRelPath);
    }
    expect(macPaths.size).toBe(6);

    // 验证 IconsPanel 正常渲染全部 6 套图标卡片
    const prefs: ClientPreferences = {
      locale: 'zh-CN',
      theme: 'claude-code-dark',
      appIcon: 'gravity-claude-dark',
      defaultThoughtTrack: 'zh',
      processPerSession: false,
      activeProfileId: 'default',
    };
    render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
        <IconsPanel preferences={prefs} onSetAppIcon={vi.fn().mockResolvedValue(undefined)} />
      </I18nProvider>
    );
    const grid = screen.getByTestId('app-icons-grid');
    // D2 (v0.3.4): 允许首位新增 icon-variant-auto（跟随主题），此处验证 6 套静态图标变体卡片全部渲染
    expect(grid.querySelectorAll('[data-testid^="icon-variant-gravity-"]')).toHaveLength(6);
    for (const variant of GRAVITY_ICON_VARIANTS) {
      const card = screen.getByTestId(`icon-variant-${variant.id}`);
      const img = card.querySelector('img');
      expect(img?.getAttribute('src')).toBe(variant.publicSvgUrl);
    }
  });
});

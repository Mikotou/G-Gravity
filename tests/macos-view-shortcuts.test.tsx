import React from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MenuItemConstructorOptions } from 'electron';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import { Markdown } from '../src/renderer/components/Markdown';
import {
  MediaGallery,
  TargetLink,
  clearLocalTargetInspectionCache,
  decodeLocalTarget,
  deriveParentHint,
  resolveSafeHref,
  type MediaPreviewItem,
} from '../src/renderer/components/MediaGallery';
import { ImageSessionContext, ImageWorkspace, MessageImage } from '../src/renderer/components/MessageImage';
import { TurnDiagnosticCard } from '../src/renderer/components/TurnDiagnosticCard';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';
import { macApplicationMenu, macKeyboardZoom } from '../src/main/macos-menu';
import {
  buildDiagnosticBanner,
  type ClientLocale,
  type ClientPreferences,
  type DiagnosticCode,
  type GravityDesktopBridge,
  type InspectLocalTargetsInput,
  type InspectLocalTargetsResult,
  type InspectedLocalTarget,
  type UiScaleCommand,
} from '../src/shared';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjMGE4NGZmIi8+PC9zdmc+';

function mockPlatformEnvironment(platform: 'mac' | 'win') {
  const isMac = platform === 'mac';
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(isMac ? 'MacIntel' : 'Win32');
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    isMac
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) jsdom'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) jsdom'
  );
  document.documentElement.dataset.windowChrome = isMac ? 'mac-inset' : 'win-overlay';
}

afterEach(() => {
  cleanup();
  clearLocalTargetInspectionCache();
  delete window.gravityDesktop;
  delete document.documentElement.dataset.windowChrome;
  resetFallbackDesktopBridge();
  vi.restoreAllMocks();
});

describe('Mac 原生菜单、平台提示与缩放', () => {
  async function mountDelayedScaleWrites() {
    const fallback = getFallbackDesktopBridge();
    const base = await fallback.updatePreferences({ locale: 'en-US', uiScale: 1 });
    let command: ((value: UiScaleCommand) => void) | undefined;
    const writes: Array<{ scale: number; succeed: () => void; fail: () => void }> = [];
    window.gravityDesktop = {
      ...fallback,
      getBootstrap: async () => ({ ...await fallback.getBootstrap(), windowChrome: 'mac-inset' }),
      onUiScaleCommand: next => { command = next; return () => { command = undefined; }; },
      updatePreferences: patch => new Promise<ClientPreferences>((resolve, reject) => writes.push({
        scale: patch.uiScale!, succeed: () => resolve({ ...base, ...patch }), fail: () => reject(Error('Fixture save failed')),
      })),
    };
    render(<App />);
    await screen.findByTestId('agy-app-root');
    await waitFor(() => expect(command).toBeTypeOf('function'));
    return { writes, zoom: (op: UiScaleCommand) => command!(op) };
  }

  it('连续三次放大保留每一步，晚到的旧回包不能回退倍率或覆盖提示', async () => {
    const { writes, zoom } = await mountDelayedScaleWrites();
    act(() => { zoom('increase'); zoom('increase'); });
    await act(async () => writes[0].succeed());
    expect(screen.queryByTestId('app-toast')).toBeNull();
    act(() => zoom('increase'));
    expect(writes.map(w => w.scale)).toEqual([1.1, 1.2, 1.3]);
    await act(async () => writes[2].succeed());
    await act(async () => writes[1].succeed());
    expect(screen.getByTestId('app-toast').textContent).toContain('130%');
    expect(document.documentElement.style.getPropertyValue('--win-controls-w')).toBe(Math.round(138 / 1.3) + 'px');
    act(() => zoom('increase'));
    expect(writes[3].scale).toBe(1.4);
    await act(async () => writes[3].fail());
    expect(screen.getByTestId('app-toast').textContent).toContain('Fixture save failed');
    act(() => zoom('increase'));
    expect(writes[4].scale).toBe(1.4);
    await act(async () => writes[4].succeed());
    expect(screen.getByTestId('app-toast').textContent).toContain('140%');
  });

  it('滑块提交一次，快捷键从刚选的值开始，异步保存失败恢复实际倍率', async () => {
    const { writes, zoom } = await mountDelayedScaleWrites();
    fireEvent.click(screen.getByTestId('open-theme-modal-btn'));
    fireEvent.click(await screen.findByTestId('settings-tab-general'));
    const slider = await screen.findByTestId('ui-scale-range') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '1.15' } });
    fireEvent.pointerUp(slider);
    fireEvent.mouseUp(slider);
    fireEvent.blur(slider);
    fireEvent.keyUp(slider, { key: '=', metaKey: true });
    act(() => zoom('increase'));
    expect(writes.map(w => w.scale)).toEqual([1.15, 1.25]);
    await act(async () => writes[1].succeed());
    await act(async () => writes[0].fail());
    expect(slider.value).toBe('1.25');
    expect(screen.getByTestId('app-toast').textContent).toContain('125%');
    fireEvent.change(slider, { target: { value: '1.5' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    await act(async () => writes[2].fail());
    expect(slider.value).toBe('1.25');
    act(() => zoom('decrease'));
    expect(writes[3].scale).toBe(1.15);
    await act(async () => writes[3].succeed());
  });

  it.each(['zh-CN', 'en-US'] as const)('原生视图菜单含全屏和三个缩放操作，并使用 %s', locale => {
    const zoom = vi.fn();
    const menu = macApplicationMenu(locale, zoom);
    const view = menu.find(item => item.label === (locale === 'zh-CN' ? '视图' : 'View'));
    const entries = view?.submenu as MenuItemConstructorOptions[];
    expect(entries.map(item => item.id).filter(Boolean)).toEqual(['gravity-size-actual', 'gravity-size-in', 'gravity-size-out', 'gravity-fullscreen']);
    expect(entries.at(-1)?.role).toBe('togglefullscreen');
    for (const entry of entries.slice(0, 3)) Reflect.apply(entry.click!, undefined, []);
    expect(zoom.mock.calls.map(c => c[0])).toEqual(['reset', 'increase', 'decrease']);
  });

  it('只处理原生 ⌘ 缩放的按下事件', () => {
    const input = { type: 'keyDown', meta: true, control: false, alt: false, isComposing: false, key: '=' };
    expect(['=', '+', '-', '_', '0'].map(key => macKeyboardZoom({ ...input, key }))).toEqual(['increase', 'increase', 'decrease', 'decrease', 'reset']);
    for (const change of [{ type: 'keyUp' }, { alt: true }, { isComposing: true }, { control: true }, { meta: false }, { key: 'F' }]) {
      expect(macKeyboardZoom({ ...input, ...change })).toBeUndefined();
    }
  });

  it.each(['zh-CN', 'en-US'] as const)('启动后的 %s 工作台显示 ⌘，菜单与按键只保存一个步进', async (locale: ClientLocale) => {
    const fallback = getFallbackDesktopBridge();
    await fallback.updatePreferences({ locale, uiScale: 1 });
    let command: ((value: UiScaleCommand) => void) | undefined;
    const bridge: GravityDesktopBridge = {
      ...fallback,
      getBootstrap: async () => ({ ...await fallback.getBootstrap(), windowChrome: 'mac-inset' }),
      onUiScaleCommand: next => { command = next; return () => { command = undefined; }; },
    };
    window.gravityDesktop = bridge;
    const save = vi.spyOn(bridge, 'updatePreferences');
    render(<App />);
    await screen.findByTestId('agy-app-root');
    // D3 (v0.3.4): TopBar 重复 `+` 按钮移除，唯一主新建入口收敛至 ActivityRail 的 sidebar-new-session-btn
    expect(screen.getByTestId('sidebar-new-session-btn').title).toContain('⌘N');
    expect(screen.getByTestId('toggle-right-inspector-btn').title).toContain('⌘J');
    expect(screen.getByTestId('toggle-left-sidebar-btn').title).toContain('⌘B');
    expect(screen.getByTestId('open-theme-modal-btn').title).toContain('⌘,');
    await waitFor(() => expect(command).toBeTypeOf('function'));
    await act(async () => {
      command?.('increase');
      fireEvent.keyDown(window, { key: '=', metaKey: true });
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect((await bridge.getBootstrap()).preferences.uiScale).toBe(1.1);
    await act(async () => { command?.('reset'); });
    expect((await bridge.getBootstrap()).preferences.uiScale).toBe(1);
    expect(document.body.textContent).not.toMatch(/Ctrl[ +][BJ]/);
  });

  it('AST 回归守卫：src/renderer 全部用户可见字符串不得硬编码 Ctrl+，必须统一走 useI18n().shortcut()', () => {
    const rendererRoot = path.resolve(__dirname, '../src/renderer');
    const i18nContextFile = path.resolve(rendererRoot, 'i18n/I18nContext.tsx');
    const collectFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectFiles(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
      });

    const isInsideShortcutHelper = (node: ts.Node, filePath: string): boolean => {
      if (path.resolve(filePath) !== i18nContextFile) return false;
      let cur: ts.Node | undefined = node;
      while (cur) {
        if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.name.text === 'controlShortcut') {
          return true;
        }
        cur = cur.parent;
      }
      return false;
    };

    const violations: string[] = [];
    for (const file of collectFiles(rendererRoot)) {
      const source = readFileSync(file, 'utf8');
      const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)) &&
          /\bCtrl\s*\+/i.test(node.text) &&
          !isInsideShortcutHelper(node, file)
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const rel = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');
          violations.push(`${rel}:${line + 1} -> ${JSON.stringify(node.text.trim())}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(violations).toEqual([]);
  });
});

describe('v0.3.1 macOS UI — 访达标签、⌘C 复制、诊断卡片与 POSIX 路径解码', () => {
  it.each([
    { platform: 'mac' as const, locale: 'zh-CN' as const, expectedReveal: '在访达中显示', expectedCopyShortcut: '⌘C' },
    { platform: 'mac' as const, locale: 'en-US' as const, expectedReveal: 'Show in Finder', expectedCopyShortcut: '⌘C' },
    { platform: 'win' as const, locale: 'zh-CN' as const, expectedReveal: '在文件夹中显示', expectedCopyShortcut: 'Ctrl+C' },
    { platform: 'win' as const, locale: 'en-US' as const, expectedReveal: 'Reveal in folder', expectedCopyShortcut: 'Ctrl+C' },
  ])(
    'MediaGallery 与 MessageImage Lightbox 在 $platform / $locale 下展示正确的定位文案（$expectedReveal）',
    async ({ platform, locale, expectedReveal, expectedCopyShortcut }) => {
      mockPlatformEnvironment(platform);
      const isMac = platform === 'mac';
      const workspace = isMac ? '/Users/alice/My Project' : 'C:\\Workspace\\DemoApp\\icon-studio';
      const imageTarget = isMac
        ? '/Users/alice/My Project/01-gravity-lens.png'
        : 'C:\\Workspace\\DemoApp\\icon-studio\\01-gravity-lens.png';
      const fileTarget = isMac
        ? '/Users/alice/My Project/notes.md'
        : 'C:\\Workspace\\DemoApp\\icon-studio\\notes.md';

      const openSpy = vi.fn().mockResolvedValue({
        opened: true,
        modeUsed: 'reveal-in-folder',
        resolvedTarget: imageTarget,
      });
      window.gravityDesktop = {
        ...getFallbackDesktopBridge(),
        openLinkOrFileTarget: openSpy,
      };

      const items: MediaPreviewItem[] = [
        {
          key: 'img-1',
          source: isMac ? 'file:///Users/alice/My%20Project/01-gravity-lens.png' : 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png',
          displayUrl: TINY_PNG,
          label: '01-gravity-lens.png',
          kind: 'image',
          mimeType: 'image/png',
          meta: {
            resolvedPath: imageTarget,
            fileName: '01-gravity-lens.png',
            ext: 'png',
            width: 512,
            height: 512,
            aspectRatio: 1,
            sizeBytes: 12040,
          },
        },
        {
          key: 'file-1',
          source: isMac ? 'file:///Users/alice/My%20Project/notes.md' : 'file:///C:/Workspace/DemoApp/icon-studio/notes.md',
          label: 'notes.md',
          kind: 'file',
          meta: {
            resolvedPath: fileTarget,
            fileName: 'notes.md',
            parentHint: 'My Project',
            ext: 'md',
            sizeBytes: 2048,
          },
        },
      ];

      const { container } = render(
        <I18nProvider locale={locale} onChangeLocale={() => {}} macShortcuts={isMac}>
          <ImageSessionContext.Provider value="sess-mac-reveal">
            <ImageWorkspace.Provider value={workspace}>
              <MediaGallery items={items} />
            </ImageWorkspace.Provider>
          </ImageSessionContext.Provider>
        </I18nProvider>
      );

      // MediaGallery 图片卡片定位按钮
      const mediaRevealBtn = screen.getByTestId('md-media-reveal-btn');
      expect(mediaRevealBtn.getAttribute('aria-label')).toBe(expectedReveal);
      expect(mediaRevealBtn.getAttribute('title')).toBe(expectedReveal);

      fireEvent.click(mediaRevealBtn);
      await waitFor(() =>
        expect(openSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            target: imageTarget,
            action: 'reveal-in-folder',
            cwd: workspace,
            sessionId: 'sess-mac-reveal',
          })
        )
      );

      // MediaGallery 文件托盘定位按钮
      const fileRevealBtn = container.querySelector<HTMLButtonElement>('button.md-file-reveal');
      expect(fileRevealBtn).toBeTruthy();
      expect(fileRevealBtn!.getAttribute('aria-label')).toBe(expectedReveal);
      expect(fileRevealBtn!.getAttribute('title')).toBe(expectedReveal);

      // 打开 MessageImage Lightbox 并核对访达/文件夹定位按钮与复制提示快捷键
      const imgTrigger = container.querySelector<HTMLButtonElement>('button.message-image');
      expect(imgTrigger).toBeTruthy();
      fireEvent.click(imgTrigger!);

      const dialog = await waitFor(() => {
        const el = document.querySelector('dialog');
        expect(el).toBeTruthy();
        return el!;
      });

      const lightboxRevealBtn = within(dialog).getByTestId('lightbox-reveal-btn');
      expect(lightboxRevealBtn.textContent?.trim()).toBe(expectedReveal);
      expect(within(dialog).getByTestId('lightbox-copy-image-btn').getAttribute('title')).toContain(expectedCopyShortcut);

      fireEvent.click(lightboxRevealBtn);
      await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));

      // 关闭按钮仍为 dialog 内首个按钮
      const firstBtn = dialog.querySelector('button');
      expect(firstBtn).toBeTruthy();
      fireEvent.click(firstBtn!);
      await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    }
  );

  it('Lightbox 图片复制快捷键在 macOS 响应 ⌘C (metaKey: true)，在 Windows 响应 Ctrl+C (ctrlKey: true)', async () => {
    const openSpy = vi.fn().mockResolvedValue({
      opened: true,
      modeUsed: 'copy-image',
      resolvedTarget: 'data:image',
    });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      openLinkOrFileTarget: openSpy,
    };

    const entries = [
      {
        source: 'file:///Users/alice/My%20Project/01-gravity-lens.png',
        url: TINY_PNG,
        label: '01-gravity-lens.png',
        width: 512,
        height: 512,
        format: 'PNG',
        revealTarget: '/Users/alice/My Project/01-gravity-lens.png',
      },
      {
        source: 'file:///Users/alice/My%20Project/02-gravity-orbit.svg',
        url: TINY_SVG,
        label: '02-gravity-orbit.svg',
        width: 512,
        height: 512,
        format: 'SVG',
        revealTarget: '/Users/alice/My Project/02-gravity-orbit.svg',
      },
    ];

    // 1) macOS：⌘C（metaKey: true, ctrlKey: false）触发 copy-image，且翻页后复制当前张
    mockPlatformEnvironment('mac');
    const macView = render(
      <I18nProvider locale="en-US" onChangeLocale={() => {}} macShortcuts={true}>
        <ImageSessionContext.Provider value="sess-mac-lb">
          <ImageWorkspace.Provider value="/Users/alice/My Project">
            <MessageImage
              source={entries[0].source}
              displayUrl={TINY_PNG}
              alt={entries[0].label}
              gallery={entries}
              galleryIndex={0}
            />
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>
      </I18nProvider>
    );

    fireEvent.click(macView.container.querySelector('button.message-image')!);
    const macDialog = await waitFor(() => {
      const el = document.querySelector('dialog');
      expect(el).toBeTruthy();
      return el!;
    });

    const macCopyTitle = within(macDialog).getByTestId('lightbox-copy-image-btn').getAttribute('title') || '';
    expect(macCopyTitle).toContain('⌘C');
    expect(macCopyTitle).not.toMatch(/Ctrl\+/i);

    fireEvent.keyDown(window, { key: 'c', metaKey: true, ctrlKey: false });
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'copy-image',
          cwd: '/Users/alice/My Project',
          sessionId: 'sess-mac-lb',
        })
      )
    );

    // ArrowRight 切到第 2 张，再用大写 ⌘C 复制
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(macDialog.querySelector('img')?.getAttribute('alt')).toBe('02-gravity-orbit.svg'));
    fireEvent.keyDown(window, { key: 'C', metaKey: true, ctrlKey: false });
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));

    macView.unmount();

    // 2) Windows：Ctrl+C（ctrlKey: true, metaKey: false）照常触发 copy-image
    openSpy.mockClear();
    mockPlatformEnvironment('win');
    const winView = render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}} macShortcuts={false}>
        <ImageSessionContext.Provider value="sess-win-lb">
          <ImageWorkspace.Provider value={'C:\\Workspace\\DemoApp\\icon-studio'}>
            <MessageImage
              source="file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png"
              displayUrl={TINY_PNG}
              alt="01-gravity-lens.png"
            />
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>
      </I18nProvider>
    );

    fireEvent.click(winView.container.querySelector('button.message-image')!);
    const winDialog = await waitFor(() => {
      const el = document.querySelector('dialog');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(winDialog).getByTestId('lightbox-copy-image-btn').getAttribute('title')).toContain('Ctrl+C');

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true, metaKey: false });
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'copy-image',
          cwd: 'C:\\Workspace\\DemoApp\\icon-studio',
          sessionId: 'sess-win-lb',
        })
      )
    );
    winView.unmount();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'TurnDiagnosticCard 在 macOS %s 下零硬编码 Ctrl+，且主操作与关闭按钮支持键盘聚焦和触发',
    async (locale) => {
      mockPlatformEnvironment('mac');
      const codes: DiagnosticCode[] = [
        'user_cancelled',
        'max_tokens',
        'refusal',
        'rate_limited_429',
        'auth_required_401',
        'acp_disconnected',
        'context_overflow',
        'policy_blocked',
        'resume_failed',
      ];

      for (const code of codes) {
        const banner = buildDiagnosticBanner(code, {
          exitCode: code === 'acp_disconnected' ? 137 : undefined,
          technicalDetail: `macOS diagnostic sample for ${code}`,
        });
        const onContinue = vi.fn().mockResolvedValue(undefined);
        const onRetry = vi.fn().mockResolvedValue(undefined);
        const onReconnect = vi.fn().mockResolvedValue(undefined);
        const onCompact = vi.fn().mockResolvedValue(undefined);
        const onLogin = vi.fn().mockResolvedValue(undefined);
        const onAccounts = vi.fn();
        const onApprovals = vi.fn();
        const onEdit = vi.fn();
        const onNewSession = vi.fn();
        const onDismiss = vi.fn();

        const view = render(
          <I18nProvider locale={locale} onChangeLocale={() => {}} macShortcuts={true}>
            <TurnDiagnosticCard
              banner={banner}
              handlers={{
                continue_turn: onContinue,
                retry_turn: onRetry,
                reconnect_session: onReconnect,
                compact_context: onCompact,
                launch_official_login: onLogin,
                open_accounts_settings: onAccounts,
                open_approval_settings: onApprovals,
                edit_last_message: onEdit,
                new_session: onNewSession,
                dismiss: onDismiss,
              }}
            />
          </I18nProvider>
        );

        const card = screen.getByTestId('turn-diagnostic-card');
        expect(card.getAttribute('data-diagnostic-code')).toBe(code);
        expect(card.textContent).toContain(locale === 'zh-CN' ? banner.titleZh : banner.titleEn);

        // 零硬编码 Ctrl+ 文本或无障碍属性
        expect(card.textContent || '').not.toMatch(/\bCtrl\s*\+/i);
        for (const el of card.querySelectorAll('[title],[aria-label]')) {
          expect(el.getAttribute('title') || '').not.toMatch(/\bCtrl\s*\+/i);
          expect(el.getAttribute('aria-label') || '').not.toMatch(/\bCtrl\s*\+/i);
        }

        // 主操作按钮与关闭按钮支持键盘聚焦与点击激活（等待异步动作收口，避免 pending 锁阻塞或 act 警告）
        const primaryActionBtn = card.querySelector<HTMLButtonElement>('.diag-actions button');
        expect(primaryActionBtn).toBeTruthy();
        expect(primaryActionBtn!.type).toBe('button');
        const primaryActionId = primaryActionBtn!.getAttribute('data-action-id');
        expect(primaryActionId).toBeTruthy();
        primaryActionBtn!.focus();
        expect(document.activeElement).toBe(primaryActionBtn);
        await act(async () => {
          fireEvent.click(primaryActionBtn!);
        });

        const allActionSpies = [
          onContinue,
          onRetry,
          onReconnect,
          onCompact,
          onLogin,
          onAccounts,
          onApprovals,
          onEdit,
          onNewSession,
        ];
        expect(allActionSpies.reduce((sum, fn) => sum + fn.mock.calls.length, 0)).toBe(1);

        const dismissBtn = within(card).getByTestId('diagnostic-action-dismiss') as HTMLButtonElement;
        dismissBtn.focus();
        expect(document.activeElement).toBe(dismissBtn);
        await act(async () => {
          fireEvent.click(dismissBtn);
        });
        expect(onDismiss).toHaveBeenCalledTimes(1);

        view.unmount();
      }
    }
  );

  it('POSIX macOS file:/// 路径在 TargetLink 与 MediaGallery 中保留前导 /、干净展示文件名与行号徽标，绝不泄漏原始 file:///', async () => {
    mockPlatformEnvironment('mac');

    // 1) 纯路径解码与安全链接解析契约（POSIX 保留前导 /，Windows 盘符仍剥离前导 /）
    expect(decodeLocalTarget('file:///Users/alice/My%20Project/01-gravity-lens.png')).toBe(
      '/Users/alice/My Project/01-gravity-lens.png'
    );
    expect(decodeLocalTarget('file:///Users/alice/src/core-service.ts#L10-L20')).toBe(
      '/Users/alice/src/core-service.ts#L10-L20'
    );
    expect(decodeLocalTarget('file:///Users/alice/%E9%A1%B9%E7%9B%AE/%E5%9B%BE%E6%A0%87%2001.png')).toBe(
      '/Users/alice/项目/图标 01.png'
    );
    expect(decodeLocalTarget('file://localhost/Users/alice/My%20Project/notes.md')).toBe(
      '/Users/alice/My Project/notes.md'
    );
    expect(decodeLocalTarget('file:///C:/Workspace/DemoApp/icon.png')).toBe('C:/Workspace/DemoApp/icon.png');

    const safeImg = resolveSafeHref('file:///Users/alice/My%20Project/01-gravity-lens.png');
    expect(safeImg).toEqual({
      href: 'file:///Users/alice/My%20Project/01-gravity-lens.png',
      kind: 'file',
      tooltip: '/Users/alice/My Project/01-gravity-lens.png',
    });
    const safeCode = resolveSafeHref('file:///Users/alice/src/core-service.ts#L10-L20');
    expect(safeCode).toEqual({
      href: 'file:///Users/alice/src/core-service.ts#L10-L20',
      kind: 'file',
      tooltip: '/Users/alice/src/core-service.ts#L10-L20',
    });
    expect(deriveParentHint('file:///Users/alice/My%20Project/01-gravity-lens.png')).toBe('My Project');

    // 2) 直接渲染 TargetLink：展示干净文件名 + 行号徽标，data-link-path 与 title 保留 POSIX 前导 /
    const openSpy = vi.fn().mockResolvedValue({
      opened: true,
      modeUsed: 'default-app',
      resolvedTarget: '/Users/alice/src/core-service.ts',
    });
    const inspectSpy = vi.fn(async (input: InspectLocalTargetsInput): Promise<InspectLocalTargetsResult> => {
      const items: Record<string, InspectedLocalTarget> = {};
      for (const target of input.targets) {
        if (target.includes('01-gravity-lens.png')) {
          items[target] = {
            rawTarget: target,
            kind: 'image',
            exists: true,
            resolvedPath: '/Users/alice/My Project/01-gravity-lens.png',
            fileUrl: 'file:///Users/alice/My%20Project/01-gravity-lens.png',
            fileName: '01-gravity-lens.png',
            parentHint: 'My Project',
            ext: 'png',
            mimeType: 'image/png',
            sizeBytes: 32768,
            width: 512,
            height: 512,
            aspectRatio: 1,
            previewDataUrl: TINY_PNG,
          };
        } else if (target.includes('core-service.ts')) {
          items[target] = {
            rawTarget: target,
            kind: 'file',
            exists: true,
            resolvedPath: '/Users/alice/src/core-service.ts',
            fileUrl: 'file:///Users/alice/src/core-service.ts',
            fileName: 'core-service.ts',
            parentHint: 'src',
            ext: 'ts',
            mimeType: 'text/typescript',
            sizeBytes: 14200,
          };
        } else {
          items[target] = { rawTarget: target, kind: 'missing', exists: false, fileName: target };
        }
      }
      return { items };
    });

    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      openLinkOrFileTarget: openSpy,
      inspectLocalTargets: inspectSpy,
    };

    const md = [
      'macOS 本地输出清单：',
      '',
      '- [01-gravity-lens.png](file:///Users/alice/My%20Project/01-gravity-lens.png) — 应用图标',
      '- [core-service.ts](file:///Users/alice/src/core-service.ts#L10-L20) — 主进程核心服务',
    ].join('\n');

    const { container } = render(
      <I18nProvider locale="zh-CN" onChangeLocale={() => {}} macShortcuts={true}>
        <ImageSessionContext.Provider value="sess-mac-posix">
          <ImageWorkspace.Provider value="/Users/alice/My Project">
            <Markdown text={md} />
            <TargetLink safe={safeCode!} lineBadge="L10-L20">core-service.ts</TargetLink>
          </ImageWorkspace.Provider>
        </ImageSessionContext.Provider>
      </I18nProvider>
    );

    const listLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('ul li a.md-link-file'));
    const imgLink = listLinks.find(a => a.getAttribute('data-link-href')?.includes('01-gravity-lens.png'));
    const codeLink = listLinks.find(a => a.getAttribute('data-link-href')?.includes('core-service.ts'));
    expect(imgLink).toBeTruthy();
    expect(codeLink).toBeTruthy();

    // 保留 POSIX 前导 /，绝不泄漏 file:/// 到可见文案
    expect(imgLink!.querySelector('.md-link-label')?.textContent).toBe('01-gravity-lens.png');
    expect(imgLink!.textContent).not.toContain('file:///');
    expect(imgLink!.textContent).not.toContain('/Users/alice/');
    expect(imgLink!.getAttribute('data-link-path')).toBe('/Users/alice/My Project/01-gravity-lens.png');
    expect(imgLink!.getAttribute('title')).toBe('/Users/alice/My Project/01-gravity-lens.png');

    expect(codeLink!.querySelector('.md-link-label')?.textContent).toBe('core-service.ts');
    expect(codeLink!.querySelector('.md-line-badge')?.textContent).toBe('L10-L20');
    expect(codeLink!.textContent).not.toContain('file:///');
    expect(codeLink!.getAttribute('data-link-path')).toBe('/Users/alice/src/core-service.ts#L10-L20');
    expect(codeLink!.getAttribute('title')).toBe('/Users/alice/src/core-service.ts#L10-L20');

    // 左键点击透传 macOS cwd 与 sessionId
    fireEvent.click(codeLink!);
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'file:///Users/alice/src/core-service.ts#L10-L20',
          action: 'default-app',
          cwd: '/Users/alice/My Project',
          sessionId: 'sess-mac-posix',
        })
      )
    );

    // MediaGallery Zone A (图片) & Zone B (文件托盘) 均保留 POSIX 前导 / Tooltip 且无 file:/// 泄漏
    const gallery = await screen.findByTestId('md-media-gallery');
    const filesTray = await screen.findByTestId('md-files-tray');

    const mediaName = gallery.querySelector('.md-media-name');
    expect(mediaName?.textContent).toBe('01-gravity-lens.png');
    expect(mediaName?.getAttribute('title')).toBe('/Users/alice/My Project/01-gravity-lens.png');
    expect(within(gallery).getByTestId('md-media-reveal-btn').getAttribute('title')).toBe('在访达中显示');

    const trayLink = filesTray.querySelector<HTMLAnchorElement>('a.md-link-file');
    expect(trayLink).toBeTruthy();
    expect(trayLink!.querySelector('.md-link-label')?.textContent).toBe('core-service.ts');
    expect(trayLink!.querySelector('.md-line-badge')?.textContent).toBe('L10-L20');
    expect(trayLink!.textContent).not.toContain('file:///');
    expect(trayLink!.getAttribute('title')).toBe('/Users/alice/src/core-service.ts');
  });
});

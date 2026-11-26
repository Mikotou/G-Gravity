import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPlausibleLocalFileCandidate,
  isPreviewableImagePath,
  type InspectLocalTargetsInput,
  type InspectLocalTargetsResult,
  type InspectedLocalTarget,
  type MessageAttachmentPreview,
} from '@shared';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { Markdown } from '../src/renderer/components/Markdown';
import { ImageSessionContext, ImageWorkspace } from '../src/renderer/components/MessageImage';
import { looksLikePlausibleLocalTarget } from '../src/renderer/components/SelectionAnnotationTools';
import { useFluidStreamText } from '../src/renderer/hooks/useFluidStreamText';
import { getFallbackDesktopBridge, resetFallbackDesktopBridge } from '../src/renderer/services/desktop-bridge';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjZDk3NzU3Ii8+PC9zdmc+';

beforeEach(() => {
  delete window.gravityDesktop;
  resetFallbackDesktopBridge();
});

afterEach(() => {
  cleanup();
  delete window.gravityDesktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderMarkdownWithContext(
  text: string,
  options: {
    locale?: 'zh-CN' | 'en-US';
    workspace?: string;
    sessionId?: string;
    attachments?: MessageAttachmentPreview[];
  } = {}
) {
  const {
    locale = 'zh-CN',
    workspace = 'C:\\Workspace\\DemoApp\\icon-studio',
    sessionId = 'sess-v031-media',
    attachments,
  } = options;
  return render(
    <I18nProvider locale={locale} onChangeLocale={() => {}}>
      <ImageSessionContext.Provider value={sessionId}>
        <ImageWorkspace.Provider value={workspace}>
          <Markdown text={text} attachments={attachments} />
        </ImageWorkspace.Provider>
      </ImageSessionContext.Provider>
    </I18nProvider>
  );
}

/** 根据目标路径模糊匹配预置的本地探测元信息，兼容 `file:///`、正反斜杠与相对路径请求。 */
function createMockInspector(catalog: Record<string, InspectedLocalTarget>) {
  const normalize = (raw: string) =>
    raw
      .trim()
      .replace(/^file:\/\/\/?/i, '')
      .replace(/#L?\d+(?:-L?\d+)?$/i, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();

  const byNorm = new Map<string, InspectedLocalTarget>();
  const byBase = new Map<string, InspectedLocalTarget>();
  for (const [k, item] of Object.entries(catalog)) {
    byNorm.set(normalize(k), item);
    if (item.resolvedPath) byNorm.set(normalize(item.resolvedPath), item);
    if (item.fileUrl) byNorm.set(normalize(item.fileUrl), item);
    byBase.set(item.fileName.toLowerCase(), item);
  }

  return vi.fn(async (input: InspectLocalTargetsInput): Promise<InspectLocalTargetsResult> => {
    const items: Record<string, InspectedLocalTarget> = {};
    for (const target of input.targets) {
      const norm = normalize(target);
      const base = norm.split('/').filter(Boolean).at(-1) || norm;
      const hit = byNorm.get(norm) || byBase.get(base);
      if (hit) {
        items[target] = { ...hit, rawTarget: target };
      } else {
        items[target] = {
          rawTarget: target,
          kind: 'missing',
          exists: false,
          fileName: base,
        };
      }
    }
    return { items };
  });
}

describe('v0.3.1 Markdown 排版、图文文件严格分区混排与高频流式回归', () => {
  it('1) 截图 1 回归：列表中的 file:/// 链接仅渲染干净文件名、绝不重复拼接 file:/// 路径，保留 Tooltip 且左键经 gravityDesktop 透传 cwd 与 sessionId', async () => {
    const openSpy = vi.fn().mockResolvedValue({
      opened: true,
      modeUsed: 'default-app',
      resolvedTarget: 'C:\\Workspace\\DemoApp\\icon-studio\\01-gravity-lens.png',
    });
    const inspectSpy = createMockInspector({
      'C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png': {
        rawTarget: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png',
        kind: 'image',
        exists: true,
        resolvedPath: 'C:\\Workspace\\DemoApp\\icon-studio\\01-gravity-lens.png',
        fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png',
        fileName: '01-gravity-lens.png',
        ext: 'png',
        mimeType: 'image/png',
        sizeBytes: 54210,
        width: 1024,
        height: 1024,
        aspectRatio: 1,
        previewDataUrl: TINY_PNG,
      },
      'F:/proj/src/core-service.ts': {
        rawTarget: 'file:///F:/proj/src/core-service.ts#L10-L20',
        kind: 'file',
        exists: true,
        resolvedPath: 'F:\\proj\\src\\core-service.ts',
        fileUrl: 'file:///F:/proj/src/core-service.ts',
        fileName: 'core-service.ts',
        parentHint: 'src',
        ext: 'ts',
        mimeType: 'text/typescript',
        sizeBytes: 18420,
      },
    });

    // 挂载 window.gravityDesktop，验证 TargetLink 走 getDesktopBridge()
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      openLinkOrFileTarget: openSpy,
      inspectLocalTargets: inspectSpy,
    };

    const md = [
      '本次生成与修改的文件如下：',
      '',
      '- [01-gravity-lens.png](file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png) — 主应用图标',
      '- [core-service.ts](file:///F:/proj/src/core-service.ts#L10-L20) — 会话生命周期核心实现',
      '- 裸路径兼容性：C:\\demo\\one.png',
    ].join('\n');

    const { container } = renderMarkdownWithContext(md, {
      workspace: 'C:\\Workspace\\DemoApp\\icon-studio',
      sessionId: 'sess-shot1',
    });

    const listLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>('ul li a.md-link'));
    const iconLink = listLinks.find((a) => a.getAttribute('data-link-href')?.includes('01-gravity-lens.png'));
    const codeLink = listLinks.find((a) => a.getAttribute('data-link-href')?.includes('core-service.ts'));

    expect(iconLink).toBeTruthy();
    expect(codeLink).toBeTruthy();

    // 绝不在可见链接文本中重复拼接 file:/// URI，也不再出现旧版 .md-file-path 冗余代码片
    expect(iconLink!.textContent).toContain('01-gravity-lens.png');
    expect(iconLink!.textContent).not.toContain('file:///');
    expect(iconLink!.textContent).not.toContain('C:/Workspace/DemoApp/icon-studio/');
    expect(iconLink!.querySelector('code.md-file-path')).toBeNull();
    expect(iconLink!.getAttribute('data-link-href')).toBe('file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png');
    expect(iconLink!.getAttribute('title') || '').toMatch(/DemoApp[\\/]icon-studio[\\/]01-gravity-lens\.png/i);

    expect(codeLink!.textContent).toContain('core-service.ts');
    expect(codeLink!.textContent).not.toContain('file:///');
    expect(codeLink!.textContent).not.toContain('F:/proj/src/');
    expect(codeLink!.querySelector('code.md-file-path')).toBeNull();
    expect(codeLink!.getAttribute('data-link-href')).toBe('file:///F:/proj/src/core-service.ts#L10-L20');
    expect(codeLink!.getAttribute('title') || '').toMatch(/core-service\.ts/i);

    // 裸路径在原位仍然可读
    expect(container.querySelector('ul')?.textContent).toContain('C:\\demo\\one.png');

    // 左键点击通过 window.gravityDesktop.openLinkOrFileTarget 携带 cwd 与 sessionId
    fireEvent.click(iconLink!);
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.png',
          action: 'default-app',
          cwd: 'C:\\Workspace\\DemoApp\\icon-studio',
          sessionId: 'sess-shot1',
        })
      )
    );

    fireEvent.click(codeLink!);
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'file:///F:/proj/src/core-service.ts#L10-L20',
          action: 'default-app',
          cwd: 'C:\\Workspace\\DemoApp\\icon-studio',
          sessionId: 'sess-shot1',
        })
      )
    );
  });

  it('2) 裸扩展名与后缀碎片过滤：.svg/.png/.ico/-mac.png 等绝不被误判为可探测本地目标', () => {
    const noiseTokens = ['.svg', '.png', '.ico', '.ts', '-mac.png', '--config.json', '*.png', '<name>.svg', '${var}.ts'];
    for (const token of noiseTokens) {
      expect(isPlausibleLocalFileCandidate(token), `shared candidate should reject ${token}`).toBe(false);
      expect(isPreviewableImagePath(token), `shared image path should reject ${token}`).toBe(false);
      expect(looksLikePlausibleLocalTarget(token), `SelectionAnnotationTools should reject ${token}`).toBe(false);
    }

    expect(looksLikePlausibleLocalTarget('C:\\Workspace\\DemoApp\\icon-studio\\01-gravity-lens.png')).toBe(true);
    expect(looksLikePlausibleLocalTarget('file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico')).toBe(true);
    expect(looksLikePlausibleLocalTarget('src/main/core-service.ts')).toBe(true);
  });

  it('3) 截图 2 回归：严禁 .svg/.png 破图占位与 .ico 误提取，图片严格落入 md-media-gallery（宽图 .is-hero、元信息栏、超 6 张折叠），非图片文件与目录严格隔离至 md-files-tray', async () => {
    const iconFiles = [
      { name: '01-gravity-lens.png', ext: 'png', mime: 'image/png', url: TINY_PNG, size: 61440 },
      { name: '01-gravity-lens.svg', ext: 'svg', mime: 'image/svg+xml', url: TINY_SVG, size: 4320 },
      { name: '01-gravity-lens-256.png', ext: 'png', mime: 'image/png', url: TINY_PNG, size: 18944 },
      { name: '02-gravity-orbit.png', ext: 'png', mime: 'image/png', url: TINY_PNG, size: 59300 },
      { name: '02-gravity-orbit.svg', ext: 'svg', mime: 'image/svg+xml', url: TINY_SVG, size: 4120 },
      { name: '03-gravity-pulse.png', ext: 'png', mime: 'image/png', url: TINY_PNG, size: 57120 },
      { name: '04-gravity-prism.png', ext: 'png', mime: 'image/png', url: TINY_PNG, size: 58200 },
    ];

    const catalog: Record<string, InspectedLocalTarget> = {
      'C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png': {
        rawTarget: 'file:///C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png',
        kind: 'image',
        exists: true,
        resolvedPath: 'C:\\Workspace\\DemoApp\\icon-studio\\gravity-icon-showcase.png',
        fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png',
        fileName: 'gravity-icon-showcase.png',
        parentHint: 'icon-studio',
        ext: 'png',
        mimeType: 'image/png',
        sizeBytes: 348160,
        width: 2400,
        height: 1000,
        aspectRatio: 2.4,
        previewDataUrl: TINY_PNG,
      },
      'C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico': {
        rawTarget: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico',
        kind: 'file',
        exists: true,
        resolvedPath: 'C:\\Workspace\\DemoApp\\icon-studio\\01-gravity-lens.ico',
        fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico',
        fileName: '01-gravity-lens.ico',
        parentHint: 'icon-studio',
        ext: 'ico',
        mimeType: 'image/x-icon',
        sizeBytes: 42816,
      },
      'C:/Workspace/DemoApp/icon-studio': {
        rawTarget: 'C:/Workspace/DemoApp/icon-studio',
        kind: 'directory',
        exists: true,
        resolvedPath: 'C:\\Workspace\\DemoApp\\icon-studio',
        fileUrl: 'file:///C:/Workspace/DemoApp/icon-studio',
        fileName: 'icon-studio',
        parentHint: 'C:\\Workspace\\DemoApp',
      },
    };
    for (const ic of iconFiles) {
      catalog[`C:/Workspace/DemoApp/icon-studio/${ic.name}`] = {
        rawTarget: `file:///C:/Workspace/DemoApp/icon-studio/${ic.name}`,
        kind: 'image',
        exists: true,
        resolvedPath: `C:\\Workspace\\DemoApp\\icon-studio\\${ic.name}`,
        fileUrl: `file:///C:/Workspace/DemoApp/icon-studio/${ic.name}`,
        fileName: ic.name,
        parentHint: 'icon-studio',
        ext: ic.ext,
        mimeType: ic.mime,
        sizeBytes: ic.size,
        width: 1024,
        height: 1024,
        aspectRatio: 1.0,
        previewDataUrl: ic.url,
      };
    }

    const inspectSpy = createMockInspector(catalog);
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      inspectLocalTargets: inspectSpy,
    };

    const md = [
      '已导出全套 `.svg`、`.png`、`.ico` 与 `-mac.png` 图标变体，输出目录位于 `C:/Workspace/DemoApp/icon-studio`：',
      '',
      '- 全景总览：[gravity-icon-showcase.png](file:///C:/Workspace/DemoApp/icon-studio/gravity-icon-showcase.png)',
      ...iconFiles.map((f) => `- [${f.name}](file:///C:/Workspace/DemoApp/icon-studio/${f.name})`),
      '- Windows 图标包：[01-gravity-lens.ico](file:///C:/Workspace/DemoApp/icon-studio/01-gravity-lens.ico)',
    ].join('\n');

    renderMarkdownWithContext(md, { workspace: 'C:\\Workspace\\DemoApp\\icon-studio' });

    const previews = await screen.findByTestId('message-previews');
    const gallery = await screen.findByTestId('md-media-gallery');
    const filesTray = await screen.findByTestId('md-files-tray');

    // Zone A 与 Zone B 均位于 message-previews 内且严格分离（互不包含）
    expect(previews.contains(gallery)).toBe(true);
    expect(previews.contains(filesTray)).toBe(true);
    expect(gallery.contains(filesTray)).toBe(false);
    expect(filesTray.contains(gallery)).toBe(false);

    // 零破图 .svg/.png 灰色占位符、零裸扩展名假阳性芯片
    const mutedTexts = Array.from(previews.querySelectorAll('span.muted')).map((el) => (el.textContent || '').trim());
    for (const forbidden of ['.svg', '.png', '.ico', '-mac.png']) {
      expect(mutedTexts).not.toContain(forbidden);
    }
    const fileChipLabels = Array.from(filesTray.querySelectorAll('.message-file')).map((el) =>
      (el.textContent || '').trim()
    );
    expect(fileChipLabels.some((t) => /^\.(?:svg|png|ico)$/i.test(t) || /^-mac\.png$/i.test(t))).toBe(false);

    // Zone A (md-media-gallery)：仅图片、无 .message-file、全景图带 .is-hero、有 .md-media-meta 元信息栏
    expect(gallery.querySelectorAll('.message-file')).toHaveLength(0);
    expect(gallery.textContent).not.toContain('01-gravity-lens.ico');

    await waitFor(() => {
      const heroCard = gallery.querySelector('.md-media-card.is-hero');
      expect(heroCard).toBeTruthy();
      expect(heroCard!.textContent).toContain('gravity-icon-showcase.png');
    });

    const initialCards = gallery.querySelectorAll('.md-media-card');
    expect(initialCards.length).toBeLessThanOrEqual(6);
    expect(initialCards.length).toBeGreaterThanOrEqual(1);

    const firstMeta = gallery.querySelector('.md-media-card .md-media-meta');
    expect(firstMeta).toBeTruthy();
    expect(firstMeta!.textContent || '').toMatch(/PNG|SVG/i);
    expect(firstMeta!.textContent || '').toMatch(/2400|1024|KB|px/i);

    // 超 6 张（共 8 张）显示折叠展开按钮，点击后展示全部 8 张
    const expandMediaBtn = screen.getByTestId('md-media-expand-btn');
    fireEvent.click(expandMediaBtn);
    await waitFor(() => {
      expect(gallery.querySelectorAll('.md-media-card')).toHaveLength(8);
    });

    // Zone B (md-files-tray)：仅非图片文件与目录（.ico 与 icon-studio 目录），零 <img>
    expect(filesTray.querySelectorAll('img')).toHaveLength(0);
    expect(filesTray.querySelectorAll('.message-file').length).toBeGreaterThanOrEqual(2);
    expect(filesTray.textContent).toContain('01-gravity-lens.ico');
    expect(filesTray.textContent).toMatch(/icon-studio/i);
  });

  it('4) 文件托盘超 8 个文件默认折叠，且带 textContent 的文本附件不重复渲染两次文件名', async () => {
    const manyFiles = Array.from({ length: 10 }, (_, idx) => {
      const n = String(idx + 1).padStart(2, '0');
      return `module-${n}.ts`;
    });
    const catalog: Record<string, InspectedLocalTarget> = {};
    for (const f of manyFiles) {
      catalog[`F:/proj/src/${f}`] = {
        rawTarget: `file:///F:/proj/src/${f}`,
        kind: 'file',
        exists: true,
        resolvedPath: `F:\\proj\\src\\${f}`,
        fileUrl: `file:///F:/proj/src/${f}`,
        fileName: f,
        parentHint: 'src',
        ext: 'ts',
        sizeBytes: 2048,
      };
    }
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      inspectLocalTargets: createMockInspector(catalog),
    };

    const md = manyFiles.map((f) => `- [${f}](file:///F:/proj/src/${f})`).join('\n');
    const attachments: MessageAttachmentPreview[] = [
      {
        id: 'att-notes',
        name: 'release-notes.txt',
        mimeType: 'text/plain',
        uri: 'file:///F:/proj/release-notes.txt',
        textContent: 'First note line\nSecond note line',
        sizeBytes: 32,
      },
    ];

    renderMarkdownWithContext(md, { workspace: 'F:\\proj', attachments });

    const filesTray = await screen.findByTestId('md-files-tray');
    await waitFor(() => {
      expect(filesTray.querySelectorAll('.message-file').length).toBeLessThanOrEqual(8);
      expect(screen.getByTestId('md-files-expand-btn')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('md-files-expand-btn'));
    await waitFor(() => {
      expect(filesTray.querySelectorAll('.message-file')).toHaveLength(11);
    });

    // 带 textContent 的附件在对应 .message-file 卡片内只出现一次文件名，且保留 <details><pre> 内容
    const notesCard = Array.from(filesTray.querySelectorAll('.message-file')).find((el) =>
      el.textContent?.includes('release-notes.txt')
    );
    expect(notesCard).toBeTruthy();
    const nameMatches = (notesCard!.textContent || '').match(/release-notes\.txt/g) || [];
    expect(nameMatches).toHaveLength(1);
    expect(notesCard!.querySelector('details pre')?.textContent).toBe('First note line\nSecond note line');
  });

  it('5) D1 选项 A：独立成段 ![架构图](arch.png) 渲染为内联 md-inline-figure 且不在文末画廊重复；混排段落 ![图示](one.png) 和 text 保持 p img 为 null 并进入 md-media-gallery', async () => {
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      inspectLocalTargets: createMockInspector({
        'F:/proj/arch.png': {
          rawTarget: 'arch.png',
          kind: 'image',
          exists: true,
          resolvedPath: 'F:\\proj\\arch.png',
          fileUrl: 'file:///F:/proj/arch.png',
          fileName: 'arch.png',
          ext: 'png',
          mimeType: 'image/png',
          width: 1280,
          height: 720,
          aspectRatio: 16 / 9,
          sizeBytes: 92000,
          previewDataUrl: TINY_PNG,
        },
        'F:/proj/one.png': {
          rawTarget: 'one.png',
          kind: 'image',
          exists: true,
          resolvedPath: 'F:\\proj\\one.png',
          fileUrl: 'file:///F:/proj/one.png',
          fileName: 'one.png',
          ext: 'png',
          mimeType: 'image/png',
          width: 512,
          height: 512,
          aspectRatio: 1,
          sizeBytes: 24000,
          previewDataUrl: TINY_PNG,
        },
      }),
    };

    // Case A: 独立成段图片
    const standaloneMd = '架构总览如下：\n\n![架构图](arch.png)\n\n以上是三层架构关系。';
    const viewA = renderMarkdownWithContext(standaloneMd, {
      workspace: 'F:\\proj',
      attachments: [
        {
          id: 'arch',
          name: 'arch.png',
          mimeType: 'image/png',
          uri: 'file:///F:/proj/arch.png',
          dataUrl: TINY_PNG,
          sizeBytes: 120,
        },
      ],
    });

    const figure = await within(viewA.container).findByTestId('md-inline-figure');
    expect(figure.className).toContain('md-inline-figure');
    expect(figure.querySelector('img')).toBeTruthy();
    expect(figure.textContent).toContain('架构图');

    // 不应在文末 md-media-gallery 中重复出现
    const galleryInA = within(viewA.container).queryByTestId('md-media-gallery');
    if (galleryInA) {
      expect(galleryInA.textContent).not.toContain('arch.png');
      expect(galleryInA.textContent).not.toContain('架构图');
    }
    viewA.unmount();

    // Case B: 与文字混排在同一段
    const mixedMd = '![图示](one.png) 和 text 说明文字。';
    const viewB = renderMarkdownWithContext(mixedMd, {
      workspace: 'F:\\proj',
      attachments: [
        {
          id: 'one',
          name: 'one.png',
          mimeType: 'image/png',
          uri: 'file:///F:/proj/one.png',
          dataUrl: TINY_PNG,
          sizeBytes: 120,
        },
      ],
    });

    expect(viewB.container.querySelector('p img')).toBeNull();
    expect(within(viewB.container).queryByTestId('md-inline-figure')).toBeNull();
    const galleryInB = await within(viewB.container).findByTestId('md-media-gallery');
    expect(galleryInB.querySelectorAll('img')).toHaveLength(1);
  });

  it('6) Lightbox 多图翻页、首按钮关闭契约与 Ctrl+C 复制图片', async () => {
    const openSpy = vi.fn().mockResolvedValue({
      opened: true,
      modeUsed: 'copy-image',
      resolvedTarget: 'F:\\proj\\one.png',
    });
    window.gravityDesktop = {
      ...getFallbackDesktopBridge(),
      openLinkOrFileTarget: openSpy,
      inspectLocalTargets: createMockInspector({
        'F:/proj/one.png': {
          rawTarget: 'file:///F:/proj/one.png',
          kind: 'image',
          exists: true,
          resolvedPath: 'F:\\proj\\one.png',
          fileUrl: 'file:///F:/proj/one.png',
          fileName: 'one.png',
          ext: 'png',
          width: 640,
          height: 640,
          aspectRatio: 1,
          previewDataUrl: TINY_PNG,
        },
        'F:/proj/two.png': {
          rawTarget: 'file:///F:/proj/two.png',
          kind: 'image',
          exists: true,
          resolvedPath: 'F:\\proj\\two.png',
          fileUrl: 'file:///F:/proj/two.png',
          fileName: 'two.png',
          ext: 'png',
          width: 640,
          height: 640,
          aspectRatio: 1,
          previewDataUrl: TINY_SVG,
        },
        'F:/proj/three.png': {
          rawTarget: 'file:///F:/proj/three.png',
          kind: 'image',
          exists: true,
          resolvedPath: 'F:\\proj\\three.png',
          fileUrl: 'file:///F:/proj/three.png',
          fileName: 'three.png',
          ext: 'png',
          width: 640,
          height: 640,
          aspectRatio: 1,
          previewDataUrl: TINY_PNG,
        },
      }),
    };

    const attachments: MessageAttachmentPreview[] = [
      { id: 'i1', name: 'one.png', mimeType: 'image/png', uri: 'file:///F:/proj/one.png', dataUrl: TINY_PNG, sizeBytes: 100 },
      { id: 'i2', name: 'two.png', mimeType: 'image/png', uri: 'file:///F:/proj/two.png', dataUrl: TINY_SVG, sizeBytes: 120 },
      { id: 'i3', name: 'three.png', mimeType: 'image/png', uri: 'file:///F:/proj/three.png', dataUrl: TINY_PNG, sizeBytes: 140 },
    ];

    renderMarkdownWithContext('三张截图对比结果：', {
      workspace: 'F:\\proj',
      sessionId: 'sess-lb',
      attachments,
    });

    const gallery = await screen.findByTestId('md-media-gallery');
    const firstImgBtn = gallery.querySelector<HTMLButtonElement>('.md-media-card button.message-image, button.message-image');
    expect(firstImgBtn).toBeTruthy();
    fireEvent.click(firstImgBtn!);

    const dialog = await waitFor(() => {
      const el = document.querySelector('dialog');
      expect(el).toBeTruthy();
      return el!;
    });

    const copyBtn = within(dialog).getByTestId('lightbox-copy-image-btn');
    const prevBtn = within(dialog).getByTestId('lightbox-prev-btn');
    const nextBtn = within(dialog).getByTestId('lightbox-next-btn');
    expect(copyBtn).toBeTruthy();
    expect(prevBtn).toBeTruthy();
    expect(nextBtn).toBeTruthy();

    const currentLightboxAlt = () => dialog.querySelector('img')?.getAttribute('alt') || dialog.textContent || '';
    expect(currentLightboxAlt()).toContain('one.png');

    // 点击下一张按钮切换到第 2 张
    fireEvent.click(nextBtn);
    await waitFor(() => expect(currentLightboxAlt()).toContain('two.png'));

    // 键盘 ArrowRight 切换到第 3 张
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(currentLightboxAlt()).toContain('three.png'));

    // 键盘 ArrowLeft 回到第 2 张，再点上一张按钮回到第 1 张
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(currentLightboxAlt()).toContain('two.png'));
    fireEvent.click(prevBtn);
    await waitFor(() => expect(currentLightboxAlt()).toContain('one.png'));

    // Ctrl+C 复制当前图片
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'copy-image' }))
    );

    // 契约守护：dialog 内第一个 <button> 必须是关闭按钮
    const firstDialogBtn = dialog.querySelector('button');
    expect(firstDialogBtn).toBeTruthy();
    fireEvent.click(firstDialogBtn!);
    await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  });

  it('7) F-P0-1 回归 (useFluidStreamText)：每 5ms 高频分片（快于 16ms RAF 帧）到达时，流式正文持续推进绝不冻结在 0 字符', () => {
    vi.useFakeTimers();

    let nowMs = 0;
    let nextRafId = 1;
    const rafQueue = new Map<number, { dueAt: number; cb: FrameRequestCallback }>();

    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.set(id, { dueAt: nowMs + 16, cb });
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafQueue.delete(id);
    });

    function flushDueRafFrames(currentMs: number) {
      const due: Array<[number, FrameRequestCallback]> = [];
      for (const [id, entry] of rafQueue.entries()) {
        if (entry.dueAt <= currentMs) {
          due.push([id, entry.cb]);
        }
      }
      for (const [id, cb] of due) {
        if (rafQueue.has(id)) {
          rafQueue.delete(id);
          cb(currentMs);
        }
      }
    }

    function Harness({ text, streaming }: { text: string; streaming: boolean }) {
      const { visibleText } = useFluidStreamText(text, streaming, 'assistant', true);
      return <div data-testid="fluid-stream-output">{visibleText}</div>;
    }

    let streamedText = 'Start: ';
    const view = render(<Harness text={streamedText} streaming={true} />);
    const observedLengths: number[] = [];

    // 模拟 20 次每 5ms 到达一次的高频流式分片（总计 100ms，跨越 6 个 16ms 浏览器帧）
    for (let tick = 1; tick <= 20; tick++) {
      nowMs += 5;
      streamedText += `chunk${tick} `;
      act(() => {
        vi.advanceTimersByTime(5);
        flushDueRafFrames(nowMs);
        view.rerender(<Harness text={streamedText} streaming={true} />);
      });
      observedLengths.push((screen.getByTestId('fluid-stream-output').textContent || '').length);
    }

    const midLen = observedLengths[observedLengths.length - 1];
    // 修复前：每次 5ms rerender 都会 cancelAnimationFrame，导致 100ms 内始终冻结在 0 字符！
    expect(midLen).toBeGreaterThan(0);
    // 验证流式过程中持续推进，而非停滞
    const firstNonZeroIdx = observedLengths.findIndex((len) => len > 0);
    expect(firstNonZeroIdx).toBeGreaterThanOrEqual(0);
    expect(midLen).toBeGreaterThan(observedLengths[firstNonZeroIdx]);

    // 流式结束后立即完整呈现全部正文
    act(() => {
      view.rerender(<Harness text={streamedText} streaming={false} />);
    });
    expect(screen.getByTestId('fluid-stream-output').textContent).toBe(streamedText);
  });
});

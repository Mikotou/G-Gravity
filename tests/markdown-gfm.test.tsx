import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../src/renderer/i18n/I18nContext';
import { ImageWorkspace } from '../src/renderer/components/MessageImage';
import { Markdown } from '../src/renderer/components/Markdown';

function renderMd(md: string) {
  return render(
    <I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
      <Markdown text={md} />
    </I18nProvider>
  );
}

describe('GFM Markdown 与富格式全量兼容测试', () => {
  it('正确渲染 GFM 表格（含对齐、反引号内管道符、转义管道符与单元格 <br>）', () => {
    const md = [
      '| 字段 | 类型 | 金额 |',
      '| :--- | :---: | ---: |',
      '| `status` | ` "idle" | "busy" ` | \\$100 \\| 免费 |',
      '| 多行说明 | 第一行<br>第二行 | **99.5%** |',
    ].join('\n');

    const { container } = renderMd(md);
    const table = container.querySelector('table.md-table')!;
    expect(table).toBeTruthy();

    const ths = Array.from(table.querySelectorAll('thead th'));
    expect(ths.map((el) => el.textContent)).toEqual(['字段', '类型', '金额']);
    expect((ths[0] as HTMLElement).style.textAlign).toBe('left');
    expect((ths[1] as HTMLElement).style.textAlign).toBe('center');
    expect((ths[2] as HTMLElement).style.textAlign).toBe('right');

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    // 反引号内的 | 不会拆碎单元格
    expect(rows[0].querySelectorAll('td')).toHaveLength(3);
    expect(rows[0].querySelectorAll('td')[1].querySelector('code')?.textContent).toContain('|');
    expect(rows[0].querySelectorAll('td')[2].textContent).toBe('$100 | 免费');
    expect(rows[1].querySelectorAll('td')[1].querySelector('br')).toBeTruthy();
  });

  it('正确渲染标准超链接、带括号 URL、file:// 文件链接、引用链接与裸 URL，并拦截 javascript: 协议', () => {
    const md = [
      '请访问 [Gemini 文档](https://ai.google.dev/gemini-api/docs "官方文档") 或 [Wiki](https://en.wikipedia.org/wiki/Markdown_(markup))。',
      '本地文件：[core-service.ts](file:///F:/插件-Gemini/src/main/core-service.ts#L152-L170)，引用链接见 [架构说明][arch]。',
      '裸链接自动识别：https://github.com/google/genai，以及尖括号 <https://example.com/test>。',
      '危险链接：[点我](javascript:alert(1))。',
      '',
      '[arch]: https://example.com/arch "架构设计"',
    ].join('\n');

    const { container } = renderMd(md);
    const links = Array.from(container.querySelectorAll('a.md-link')) as HTMLAnchorElement[];
    const hrefs = links.map((a) => a.getAttribute('href'));

    expect(hrefs).toContain('https://ai.google.dev/gemini-api/docs');
    expect(hrefs).toContain('https://en.wikipedia.org/wiki/Markdown_(markup)');
    expect(hrefs).toContain('file:///F:/插件-Gemini/src/main/core-service.ts#L152-L170');
    expect(hrefs).toContain('https://example.com/arch');
    // 裸链接末尾的中文逗号“，”不应被吞进 href
    expect(hrefs).toContain('https://github.com/google/genai');
    expect(hrefs).toContain('https://example.com/test');
    // javascript: 绝不生成 <a>
    expect(hrefs.some((h) => h?.toLowerCase().startsWith('javascript:'))).toBe(false);
    expect(screen.getByText('点我').tagName).not.toBe('A');
  });

  it('文件路径在原位可读，图片和文档在完整正文末尾去重，代码块不会生成预览', () => {
    const body = '请看图片C:\\demo\\one.png，然后读 “C:\\demo\\with spaces.txt”。\n\n![图示](one.png) 和 `with spaces.txt`。\n\n```text\nC:\\demo\\sample-only.png\n```\n\n结束。';
    const { container } = render(<I18nProvider locale="zh-CN" onChangeLocale={() => {}}>
      <ImageWorkspace.Provider value={'C:\\demo'}><Markdown text={body} attachments={[
        { id: 'one', uri: 'file:///C:/demo/one.png', mimeType: 'image/png', name: 'one.png', sizeBytes: 120,
          dataUrl: 'data:image/png;base64,AAAA' },
        { id: 'doc', uri: 'file:///C:/demo/with%20spaces.txt', mimeType: 'text/plain', name: 'with spaces.txt',
          textContent: '附件中的内容', sizeBytes: 21 },
      ]} /></ImageWorkspace.Provider></I18nProvider>);
    const message = container.querySelector('.md')!;
    const previews = message.lastElementChild!;
    expect(previews.getAttribute('data-testid')).toBe('message-previews');
    expect(previews.previousElementSibling?.textContent).toBe('结束。');
    expect(message.querySelector('p')?.textContent).toContain('C:\\demo\\one.png');
    expect(message.querySelector('p')?.textContent).toContain('“C:\\demo\\with spaces.txt”');
    expect(message.querySelector('p img')).toBeNull();
    expect(previews.querySelectorAll('img')).toHaveLength(1);
    expect(previews.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(previews.querySelectorAll('.message-file')).toHaveLength(1);
    expect(previews.textContent).toContain('with spaces.txt');
    expect(previews.querySelector('details pre')?.textContent).toBe('附件中的内容');
  });

  it('正确渲染多级嵌套列表、保留有序列表起始序号及 GFM 任务复选框', () => {
    const md = [
      '3. 第三步主任务',
      '   - 子任务 A',
      '   - 子任务 B',
      '4. 第四步主任务',
      '',
      '- [x] 已完成构建',
      '- [ ] 待验证打包',
    ].join('\n');

    const { container } = renderMd(md);
    const ol = container.querySelector('ol')!;
    expect(ol).toBeTruthy();
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelector('ul')).toBeTruthy();
    expect(ol.querySelectorAll('ul li')).toHaveLength(2);

    const checkboxes = Array.from(container.querySelectorAll('input.md-task-checkbox')) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });

  it('正确渲染 GitHub Alerts、4 反引号嵌套代码块、删除线、斜体（不破坏 snake_case）与 LaTeX 数学公式', () => {
    const md = [
      '> [!IMPORTANT]',
      '> 请保持 `snake_case_name` 与 `__init__` 不被误判为斜体，同时支持 *真斜体*、**单字加粗 **与 ~~删除线~~。',
      '',
      '````markdown',
      '```ts',
      'const x = 1;',
      '```',
      '````',
      '',
      '时间复杂度为 $O(N \\log N)$，求和公式：',
      '$$\\sum_{i=1}^{n} \\frac{i}{2}$$',
      '普通价格 $100 不应误触发公式。',
    ].join('\n');

    const { container } = renderMd(md);
    expect(container.querySelector('.md-alert.is-important')).toBeTruthy();
    expect(container.querySelector('del')?.textContent).toBe('删除线');
    expect(container.querySelector('em')?.textContent).toBe('真斜体');
    expect(container.textContent).toContain('snake_case_name');
    expect(container.textContent).toContain('__init__');

    // 4 反引号代码块内部完整保留 3 反引号内容
    const pre = container.querySelector('.code-block pre');
    expect(pre?.textContent).toContain('```ts');

    // 数学公式渲染分式与求和号
    expect(container.querySelector('.md-math-inline')?.textContent).toContain('log');
    expect(container.querySelector('.md-math-block .md-frac')).toBeTruthy();
    expect(container.textContent).toContain('普通价格 $100');
  });
});

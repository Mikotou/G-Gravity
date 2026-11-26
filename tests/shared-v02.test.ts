// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeStyleApprovalOptions, calculateTokenCost, computeUnifiedLineDiff,
  GRAVITY_ICON_VARIANTS, isForbiddenCredentialOrStatePath,
  isSafePluginTarget, isSafeMcpServerName, isValidCssColorToken,
  resolveModelRateCard, THEME_PRESETS, validateCustomThemeConfig,
} from '../src/shared';

describe('四维 Token × 单价精确计算', () => {
  const rate = { inputPerMillionUsd: 1.25, cachedInputPerMillionUsd: .31, outputPerMillionUsd: 10, thinkingPerMillionUsd: 10 };
  it('input/cachedInput/output/thinking 四项分别相乘，不二次计数', () => {
    const cost = calculateTokenCost({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 20_000, thinkingTokens: 30_000 }, rate);
    expect(cost.inputCostUsd).toBeCloseTo(1.25, 12); expect(cost.cachedInputCostUsd).toBeCloseTo(.155, 12);
    expect(cost.outputCostUsd).toBeCloseTo(.2, 12); expect(cost.thinkingCostUsd).toBeCloseTo(.3, 12);
    expect(cost.totalCostUsd).toBeCloseTo(1.905, 12); expect(cost.totalTokens).toBe(1_550_000);
  });
  it('零用量、负数与小额浮点精度', () => {
    expect(calculateTokenCost({ inputTokens: -1, cachedInputTokens: 0, outputTokens: NaN, thinkingTokens: 0 }, rate).totalCostUsd).toBe(0);
    expect(calculateTokenCost({ inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, thinkingTokens: 1 }, rate).totalCostUsd).toBeCloseTo(.00002156, 14);
  });
  it('不允许无穷大计数或 NaN 单价污染费用输出', () => {
    for (const [counts, prices] of [
      [{ inputTokens: Infinity, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 }, rate],
      [{ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, thinkingTokens: 0 }, { ...rate, inputPerMillionUsd: NaN }],
    ] as const) {
      try { expect(Number.isFinite(calculateTokenCost(counts, prices).totalCostUsd)).toBe(true); }
      catch (error) { if (!(error instanceof Error) || error.name === 'AssertionError') throw error; }
    }
  });
  it('模型匹配优先 exact，再 fuzzy，未知用 default', () => {
    const cards = [ { ...rate, modelId: 'default', displayName: 'Default' }, { ...rate, modelId: 'gemini-pro', displayName: 'Pro' } ];
    expect(resolveModelRateCard('GEMINI-PRO', cards).modelId).toBe('gemini-pro');
    expect(resolveModelRateCard('models/gemini-pro-preview', cards).modelId).toBe('gemini-pro');
    expect(resolveModelRateCard('unknown', cards).modelId).toBe('default');
  });
});

describe('行级 Diff 真实性与边界', () => {
  it('修改一行保持上下文与两套行号', () => {
    const diff = computeUnifiedLineDiff('a.ts', 'a\nb\nc', 'a\nB\nc', 'tool');
    expect(diff.addedLines).toBe(1); expect(diff.removedLines).toBe(1);
    expect(diff.lines.map((line) => line.type)).toEqual(['context', 'remove', 'add', 'context']);
    expect(diff.lines.at(-1)).toMatchObject({ content: 'c', oldLineNumber: 3, newLineNumber: 3 });
    expect(diff.toolCallId).toBe('tool');
  });
  it('空文件新增和删除不能制造不存在的空行变更', () => {
    const created = computeUnifiedLineDiff('new', '', 'hello');
    expect(created.addedLines).toBe(1); expect(created.removedLines).toBe(0);
    const deleted = computeUnifiedLineDiff('old', 'hello', '');
    expect(deleted.removedLines).toBe(1); expect(deleted.addedLines).toBe(0);
  });
  it('超长文件内容完全相同时不虚构整文件增删', () => {
    const contents = Array.from({ length: 401 }, (_, n) => `line ${n}`).join('\n');
    const diff = computeUnifiedLineDiff('large', contents, contents);
    expect(diff.addedLines).toBe(0); expect(diff.removedLines).toBe(0);
  });
  it('CRLF/LF 规范化及原始文本保留', () => {
    const diff = computeUnifiedLineDiff('windows', 'a\r\nb', 'a\nb');
    expect(diff.addedLines + diff.removedLines).toBe(0); expect(diff.oldText).toBe('a\r\nb');
  });
  it('一万行文件仅改中间一行，仍保持精确增删与可逆文本', () => {
    const oldLines = Array.from({ length: 10_000 }, (_, n) => `line ${n}`);
    const newLines = [...oldLines]; newLines[5000] = 'changed';
    const diff = computeUnifiedLineDiff('large-local-edit', oldLines.join('\n'), newLines.join('\n'));
    expect(diff.addedLines).toBe(1); expect(diff.removedLines).toBe(1);
    expect(diff.lines.filter((line) => line.type !== 'add').map((line) => line.content)).toEqual(oldLines);
    expect(diff.lines.filter((line) => line.type !== 'remove').map((line) => line.content)).toEqual(newLines);
  });
});

describe('自定义颜色 JSON 安全白名单', () => {
  it.each(['#abc', '#aabbcc', '#aabbccdd', 'rgb(1, 2, 3)', 'rgba(1, 2, 3, .5)', 'hsl(180, 50%, 50%)'])('接受合法色值 %s', (value) => expect(isValidCssColorToken(value)).toBe(true));
  it.each(['url(https://example.org)', '#fff; background:url(x)', 'expression(alert(1))', 'var(--secret)', '<script>', 'red}', '', null, 123])('拒绝注入或非白名单值 %s', (value) => expect(isValidCssColorToken(value)).toBe(false));
  it('导入 partial tokens 补全且不修改原对象', () => {
    const input = { name: ' 我的主题 ', polarity: 'light', baseThemeId: 'macos-light', tokens: { accentPrimary: ' #123456 ' } };
    const result = validateCustomThemeConfig(input);
    expect(result.tokens.accentPrimary).toBe('#123456'); expect(Object.keys(result.tokens)).toHaveLength(23);
    expect(result.name).toBe('我的主题'); expect(input.tokens.accentPrimary).toBe(' #123456 ');
    expect(validateCustomThemeConfig(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(() => validateCustomThemeConfig({ tokens: { bgApp: 'url(https://example.org)' } })).toThrow('非法');
  });
});

describe('编号审批与插件参数', () => {
  it.each(['zh-CN', 'en-US'] as const)('%s 提供 1–4 决策且无前缀时禁用第2项', (locale) => {
    const options = buildClaudeStyleApprovalOptions({}, locale);
    expect(options.map((option) => option.index)).toEqual([1, 2, 3, 4]);
    expect(options.map((option) => option.decision)).toEqual(['allow_once', 'allow_session_prefix', 'approve_for_me_ai', 'reject_with_feedback']);
    expect(options[1].disabled).toBe(true); expect(options[1].disabledReason).toBeTruthy();
    expect(buildClaudeStyleApprovalOptions({ commandPrefix: ' npm test ' }, locale)[1]).toMatchObject({ disabled: false, primaryText: "2. Yes, and don't ask again for npm test" });
  });
  it.each(['plugin-name', 'plugin@marketplace', '@scope/plugin', 'org/plugin', 'plugin:stable'])('合法插件目标 %s', (target) => {
    // @scope 不是冻结目标白名单允许的开头，不把任意合法 npm 形式当成 agy 契约。
    expect(isSafePluginTarget(target)).toBe(!target.startsWith('@'));
  });
  it.each(['--force', '-x', 'plugin --force', 'plugin; rm -rf /', 'plugin\n--flag', 'a\0b', '', '../plugin'])('阻断危险目标 %s', (target) => expect(isSafePluginTarget(target)).toBe(false));
  it('MCP 名称与前缀约束', () => {
    expect(isSafeMcpServerName('server-1')).toBe(true); expect(isSafeMcpServerName('--config')).toBe(false);
    expect(isSafeMcpServerName('a/b')).toBe(false); expect(isSafeMcpServerName('a'.repeat(65))).toBe(false);
  });
});

describe('敏感凭据与官方状态路径阻断', () => {
  it.each([
    'C:/Users/test/.gemini/antigravity/brain/abc/.system_generated/logs/transcript.jsonl',
    'C:\\Users\\test\\.gemini\\antigravity-cli\\brain\\abc\\.system_generated\\logs\\transcript_full.jsonl',
    'C:/Users/test/antigravity-cli/conversations/abc.jsonl',
    'C:/Users/test/antigravity-cli/history/abc/history.json',
    'C:/Users/test/.gemini/antigravity/conversation_summaries.db',
  ])('普通非敏感内容文件不被误判为凭据 %s', (file) => {
    expect(isForbiddenCredentialOrStatePath(file)).toBe(false);
  });
  it.each(['oauth_token.json', 'refresh_token.json', 'cookies.json', 'installation_id', 'state.pbtxt', 'private.key', 'secret.enc', 'state.vscdb', 'application_default_credentials.json'])('敏感诱饵不允许读取 %s', (name) => {
    const file = `C:/test/.gemini/antigravity/${name}`;
    expect(isForbiddenCredentialOrStatePath(file)).toBe(true);
  });
});

describe('Gravity 原创图标资产格式与 D4 打包瘦身一致性', () => {
  it.each(GRAVITY_ICON_VARIANTS)('$id 的 assets SVG/PNG/ICO 有效，public 仅保留与 assets 一致的 SVG（无 PNG/ICO 副本）', (icon) => {
    expect(GRAVITY_ICON_VARIANTS).toHaveLength(6);
    expect(THEME_PRESETS.some((theme) => theme.recommendedIconId === icon.id)).toBe(true);
    for (const extension of ['svg', 'png', 'ico'] as const) {
      const asset = readFileSync(`assets/icons/${icon.id}.${extension}`);
      expect(asset.length).toBeGreaterThan(100);
      if (extension === 'svg') {
        const published = readFileSync(`public/icons/${icon.id}.svg`);
        expect(asset.equals(published)).toBe(true);
        const svg = asset.toString('utf8'); expect(svg).toMatch(/<svg\b/); expect(svg).toContain('viewBox');
        expect(svg).not.toMatch(/<script|<foreignObject|(?:href|src)=["']https?:/i);
      } else if (extension === 'png') {
        expect(existsSync(`public/icons/${icon.id}.png`)).toBe(false);
        expect(asset.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(asset.toString('ascii', 12, 16)).toBe('IHDR'); expect(asset.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
      } else {
        expect(existsSync(`public/icons/${icon.id}.ico`)).toBe(false);
        expect(asset.subarray(0, 4).toString('hex')).toBe('00000100');
        const count = asset.readUInt16LE(4); expect(count).toBeGreaterThan(0);
        for (let n = 0; n < count; n++) { const offset = 6 + 16 * n; expect(asset.readUInt32LE(offset + 12) + asset.readUInt32LE(offset + 8)).toBeLessThanOrEqual(asset.length); }
      }
    }
  });
});

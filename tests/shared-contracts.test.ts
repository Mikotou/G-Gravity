import { describe, expect, it } from 'vitest';
import {
  ALLOWED_AGY_ACP_FLAGS, APPROVAL_MODE_ORDER, FORBIDDEN_AGY_FLAGS,
  IPC_CHANNELS, MAX_PARALLEL_ACTIVE_SESSIONS, THEME_PRESETS,
  THEME_TOKEN_KEYS, getCanonicalToolName,
  isLegacyPollutionSessionTitle, normalizeWorkspacePath,
} from '../src/shared';

describe('工作区路径规范化', () => {
  it.each([
    ['/d%3A/gemini', 'D:\\gemini'],
    ['/C:/Users/dev/project', 'C:\\Users\\dev\\project'],
    ['C:\\Workspace\\DemoProject', 'C:\\Workspace\\DemoProject'],
    ['  d:/目录/项目/  ', 'D:\\目录\\项目'],
    ['/f%3A/%E6%8F%92%E4%BB%B6', 'F:\\插件'],
    ['C:/', 'C:\\'], ['/c:/', 'C:\\'],
    ['/home/user/project/', '/home/user/project'], ['/', '/'],
    ['', ''], ['   ', ''], ['/tmp/bad%ZZ/', '/tmp/bad%ZZ'],
    ['\\\\server\\share\\项目', '\\\\server\\share\\项目'],
  ])('%s → %s，并保持幂等', (input, expected) => {
    expect(normalizeWorkspacePath(input)).toBe(expected);
    expect(normalizeWorkspacePath(expected)).toBe(expected);
  });
});

describe('污染会话识别', () => {
  it.each([
    "You are 'Approve for Me' and must review a command",
    '  You are "Approve for Me" reviewer',
    'you are Approve for Me',
    'An automated tool-approval security reviewer',
    'automated tool-approval reviewer',
    '根据输入数据为每条对话整理标题，返回 JSON',
  ])('隐藏旧插件提示词：%s', (title) => expect(isLegacyPollutionSessionTitle(title)).toBe(true));
  it.each([null, undefined, '', '安全审批｜完善 Approve for Me 设置',
    '请解释 Approve for Me 的使用方法', 'You are a helpful assistant',
    '标题整理功能研发'])('保留正常会话：%s', (title) => expect(isLegacyPollutionSessionTitle(title)).toBe(false));
});

describe('主题、工具语义和安全常量', () => {
  it('六套 v0.2 经典主题各包含二十三个有效颜色并提供双语描述', () => {
    expect(THEME_PRESETS).toHaveLength(6);
    expect(new Set(THEME_PRESETS.map((theme) => theme.id)).size).toBe(6);
    expect(THEME_PRESETS.map((theme) => theme.id)).toEqual(['claude-code-dark', 'claude-code-light', 'ubuntu-aubergine', 'macos-dark', 'macos-light', 'solarized-dark']);
    expect(THEME_PRESETS.filter((theme) => theme.polarity === 'dark')).toHaveLength(4);
    expect(THEME_PRESETS.filter((theme) => theme.polarity === 'light')).toHaveLength(2);
    const tokenKeys = Object.keys(THEME_PRESETS[0].tokens).sort();
    expect(tokenKeys).toHaveLength(23);
    expect(tokenKeys).toEqual([...THEME_TOKEN_KEYS].sort());
    for (const theme of THEME_PRESETS) {
      expect(Object.keys(theme.tokens).sort()).toEqual(tokenKeys);
      for (const value of Object.values(theme.tokens)) expect(value).toMatch(/^(#[0-9a-f]{6}|rgba\([\d., ]+\))$/i);
      expect(theme.nameZh + theme.descriptionZh).toMatch(/[\u4e00-\u9fff]/);
      expect(theme.nameEn.length).toBeGreaterThan(0);
      expect(theme.descriptionEn.length).toBeGreaterThan(0);
      expect(theme.tokens.bgApp).not.toBe(theme.tokens.textPrimary);
    }
  });
  it.each([['run_command', 'Bash'], ['powershell', 'Bash'], ['read_file', 'Read'], ['edit_file', 'Edit'], ['write_file', 'Write'], ['grep_search', 'Grep'], ['find_by_name', 'Glob'], ['search_web', 'WebSearch'], ['swarm', 'Swarm'], ['post_message', 'Swarm'], ['invoke_subagent', 'Subagent']])('工具 %s 按术语策略规范化为 %s', (name, expected) => {
    expect(getCanonicalToolName(` ${name.toUpperCase()} `)).toBe(expected);
    expect(getCanonicalToolName(name)).toBe(expected);
  });
  it('未知和空工具名有可读回退', () => {
    expect(getCanonicalToolName('')).toBe('Tool');
    expect(getCanonicalToolName('custom_tool')).toBe('custom_tool');
  });
  it('危险参数黑名单完整且与允许参数无交集', () => {
    expect(FORBIDDEN_AGY_FLAGS).toEqual(expect.arrayContaining([
      '--dangerously-skip-permissions', '--override_user_agent_name', '--cloud_code_endpoint',
      '--use_stubby_auth', '--is_google3_workspace', '--is_google_internal',
    ]));
    expect(ALLOWED_AGY_ACP_FLAGS.filter((flag) => (FORBIDDEN_AGY_FLAGS as readonly string[]).includes(flag))).toEqual([]);
    expect(MAX_PARALLEL_ACTIVE_SESSIONS).toBe(4);
    expect(APPROVAL_MODE_ORDER).toEqual(['hybrid', 'rules-only', 'manual']);
  });
  it('IPC 通道唯一且全部处于应用命名空间', () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel).toMatch(/^gravity:/);
  });
});

// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const BINARY_EXT_RE = /\.(?:png|jpe?g|ico|icns|webp|gif|bmp|svg|woff2?|ttf|wasm|bin|gz)$/i;

function listTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('仓库隐私与个人数据零泄露守卫', () => {
  it('严禁向仓库提交任何 QA 截图、内部编排计划或本地 QA 日志', () => {
    const tracked = listTrackedFiles();
    const forbiddenPaths = tracked.filter(
      (rel) =>
        rel.startsWith('tests/screenshots/') ||
        /^docs\/v\d+\.\d+\.\d+-(?:parallel-plan|qa-test-plan)\.md$/i.test(rel) ||
        /^tests\/QA-.*\.md$/i.test(rel)
    );
    expect(forbiddenPaths).toEqual([]);
  });

  it('文档与 README 不得包含本机绝对路径 file:/// 链接', () => {
    const tracked = listTrackedFiles();
    const docFiles = tracked.filter(
      (rel) => rel === 'README.md' || rel === 'CLAUDE.md' || rel.startsWith('docs/')
    );
    const violations: string[] = [];
    for (const rel of docFiles) {
      if (BINARY_EXT_RE.test(rel)) continue;
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/file:\/\/\/[A-Za-z]:\//i.test(line)) {
          violations.push(`${rel}:${idx + 1}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('全仓库追踪源码、测试与文档不得包含个人路径、内网共享 IP、机器标识、个人邮箱或真实私聊文本', () => {
    const tracked = listTrackedFiles();
    const rules: Array<{ name: string; re: RegExp }> = [
      { name: 'personal-win-user-dir', re: /\bUsers[\\/]Admin\b/i },
      { name: 'personal-worktree-path', re: new RegExp('\\.pas' + 'eo[\\\\/]', 'i') },
      { name: 'personal-smb-lan-share', re: /\/\/192\.168\.\d+\.\d+\// },
      { name: 'personal-mesh-node-id', re: /\b(?:srv|peer)_[A-Za-z0-9]{10,}\b/ },
      { name: 'personal-drive-agy-cli', re: /\bD:[\\/]agy\s+cli\b/i },
      { name: 'personal-drive-folder', re: /\b[D-Z]:[\\/][^\\/\s"'`<>)\]]*-Gemini\b/i },
      { name: 'personal-network-repo-path', re: /\bZ:[\\/]G-Gravity\b/i },
      { name: 'personal-email', re: /@(?:gmail|qq|163|outlook)\.com\b/i },
      { name: 'private-chat-infra-config', re: new RegExp('/etc/x' + 'ray\\b', 'i') },
    ];

    const violations: string[] = [];
    for (const rel of tracked) {
      if (BINARY_EXT_RE.test(rel) || rel === 'tests/privacy-guard.test.ts') continue;
      const fullPath = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(fullPath)) continue;
      const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const rule of rules) {
          if (rule.re.test(line)) {
            violations.push(`${rel}:${idx + 1} [${rule.name}]`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});

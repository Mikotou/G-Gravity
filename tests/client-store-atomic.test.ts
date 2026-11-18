// @vitest-environment node
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientStore } from '../src/main/storage/client-store';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});

describe('客户端快照替换', () => {
  let dir: string;
  let store: ClientStore;
  const rename = vi.mocked(renameSync);
  const busy = Object.assign(new Error('file sharing conflict'), { code: process.platform === 'win32' ? 'EPERM' : 'EBUSY' });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gravity-storage-'));
    store = new ClientStore(dir);
    store.write('messages.json', { turn: 1 });
    rename.mockClear();
  });
  afterEach(() => {
    rename.mockReset();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('文件短暂占用时沿用原快照，解除后提交最新会话', () => {
    rename.mockImplementationOnce(() => {
      expect(store.read('messages.json', {})).toEqual({ turn: 1 });
      throw busy;
    });
    store.write('messages.json', { turn: 2 });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(store.read('messages.json', {})).toEqual({ turn: 2 });
    expect(readdirSync(dir)).toEqual(['messages.json']);
  });

  it('持续占用时有界重试，保留旧会话并清理临时文件', () => {
    rename.mockImplementation(() => { throw busy; });
    expect(() => store.write('messages.json', { turn: 2 })).toThrow(busy);
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(store.read('messages.json', {})).toEqual({ turn: 1 });
    expect(readdirSync(dir)).toEqual(['messages.json']);
  });

  it('其他磁盘错误直接返回，旧快照仍可读取', () => {
    const fault = Object.assign(new Error('device error'), { code: 'EIO' });
    rename.mockImplementationOnce(() => { throw fault; });
    expect(() => store.write('messages.json', { turn: 2 })).toThrow(fault);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(store.read('messages.json', {})).toEqual({ turn: 1 });
    expect(readdirSync(dir)).toEqual(['messages.json']);
  });
});

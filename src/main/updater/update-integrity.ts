import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AppUpdateAssetInfo } from '../../shared/ipc-channels';
import { withWindowsRetryAsync } from '../storage/client-store';

export interface DownloadReceipt {
  releaseTag: string; downloadUrl: string; name: string; size: number; sha256: string;
}
export async function verifyFile(path: string, size: number, sha256: string): Promise<void> {
  const before = await fs.lstat(path);
  if (!before.isFile() || !size || before.size !== size) throw new Error('更新包大小已改变，请重新下载');
  const file = await fs.open(path, 'r');
  try {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(size, 256 * 1024));
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new Error('更新包读取不完整，请重新下载');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await fs.lstat(path);
    if (digest.digest('hex') !== sha256 || before.ino !== after.ino || before.dev !== after.dev ||
        before.ctimeMs !== after.ctimeMs || size !== after.size) throw new Error('更新包 SHA-256 校验失败，请重新下载');
  } finally { await file.close(); }
}
export async function cachedReceipt(path: string, tag: string, asset: AppUpdateAssetInfo, expected?: string): Promise<DownloadReceipt | undefined> {
  try {
    const receiptPath = path + '.receipt.json';
    if ((await fs.lstat(receiptPath)).size > 8192) return;
    const receipt: DownloadReceipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    if (receipt.releaseTag !== tag || receipt.downloadUrl !== asset.downloadUrl || receipt.name !== asset.name ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256) || (expected && expected !== receipt.sha256) ||
        (asset.sizeBytes && asset.sizeBytes !== receipt.size)) return;
    await verifyFile(path, receipt.size, receipt.sha256);
    return receipt;
  } catch { return; }
}

export async function saveReceipt(path: string, receipt: DownloadReceipt): Promise<void> {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    await withWindowsRetryAsync(() => fs.rename(temp, path + '.receipt.json'));
  } finally { await fs.unlink(temp).catch(() => {}); }
}

export async function readChecksum(response: Response, name: string, single: boolean): Promise<string> {
  if (!response.ok || !response.body) throw new Error('无法获取发布方 SHA-256 校验清单');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 256 * 1024) throw new Error('发布方校验清单过大');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const sums = new Set<string>();
  for (const line of Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})(?:\s+\*?(.+))?$/i.exec(line.trim());
    if (match && (match[2] === name || (single && !match[2]))) sums.add(match[1].toLowerCase());
  }
  if (sums.size !== 1) throw new Error('发布方校验清单缺少唯一匹配的更新包');
  return [...sums][0];
}

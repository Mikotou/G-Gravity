import { withWindowsRetryAsync } from '../storage/client-store';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { cachedReceipt, saveReceipt, readChecksum, type DownloadReceipt } from './update-integrity';
import { promises as fs } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { APP_BRAND } from '../../shared/theme-i18n-contract';
import type { AppUpdateAssetInfo, AppUpdateState } from '../../shared/ipc-channels';

const ALLOWED_GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

const MAX_UPDATE_BYTES = 600 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 6;

const DOWNLOAD_STALL_MS = 30_000;

function decodeReleaseComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { return ''; }
}

/** Each header or body read has its own deadline, regardless of the total transfer time. */
async function whileReceiving<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error('下载更新包已停滞 30 秒');
      controller.abort(reason);
      reject(reason);
    }, DOWNLOAD_STALL_MS);
  });
  try { return await Promise.race([operation(), stalled]); }
  finally { clearTimeout(timer); }
}

export interface GitHubUpdaterOptions {
  currentVersion: string;
  updatesDir: string;
  repoSlug?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  canInstallDirectly?: boolean;
  fetcher?: typeof fetch;
  installHandler?: (filePath: string, state: AppUpdateState, receipt: DownloadReceipt) => Promise<{ launched: boolean; message: string }>;
}

/** 仅允许访问 GitHub 官方与 Release 资产下载域名，严禁降级 HTTP 或重定向至任意外部站点。 */
export function isAllowedGitHubUpdateUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return ALLOWED_GITHUB_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

interface ParsedSemver {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string;
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = String(raw || '').trim().replace(/^v/i, '');
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(cleaned);
  if (!m) return null;
  if (m[4]?.split('.').some(id => /^0\d+$/.test(id))) return null;
  return {
    major: BigInt(m[1]),
    minor: BigInt(m[2]),
    patch: BigInt(m[3]),
    prerelease: m[4] || '',
  };
}

/** 比较两个语义化版本号：a > b 返回 1，a < b 返回 -1，相等或不可解析返回 0。 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease === pb.prerelease) return 0;
  const left = pa.prerelease.split('.');
  const right = pb.prerelease.split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i], y = right[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return Math.sign(left.length - right.length);
}

/** 按当前操作系统与 CPU 架构从 Release 资产列表中选出最匹配的更新包。 */
export function selectReleaseAsset(
  assets: readonly AppUpdateAssetInfo[],
  platform: NodeJS.Platform,
  arch: string
): AppUpdateAssetInfo | undefined {
  const valid = assets.filter((a) => a?.name && a.downloadUrl && isAllowedGitHubUpdateUrl(a.downloadUrl));
  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') return;
    const label = arch === 'x64' ? /^(?:x64|amd64|x86_64)$/i : /^(?:arm64|aarch64)$/i;
    const tagged = valid.find(asset => {
      if (!/\.exe$/i.test(asset.name)) return false;
      const tags = asset.name.match(/(?<![a-z0-9])(?:x86_64|x64|amd64|arm64|aarch64|ia32|x86|armv7l)(?![a-z0-9])/gi);
      return tags?.length === 1 && label.test(tags[0]);
    });
    // The historical untagged portable Gravity.exe is built for Windows x64.
    return tagged ?? (arch === 'x64' ? valid.find(asset => /^Gravity\.exe$/i.test(asset.name)) : undefined);
  }
  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') return;
    const match = new RegExp('^Gravity-(?:v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9a-z-]+(?:\\.[0-9a-z-]+)*)?-)?mac-' + arch + '\\.(zip|dmg)$', 'i');
    const compatible = valid.filter(asset => match.test(asset.name));
    return compatible.find(asset => /\.zip$/i.test(asset.name)) ?? compatible[0];
  }
  return undefined;
}

function sanitizeAssetName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!base || base === '.' || base === '..') throw new Error('更新包文件名无效');
  return base;
}

interface ReleasePayload {
  tag: string;
  version: string;
  name: string;
  notes: string;
  htmlUrl: string;
  publishedAt?: string;
  assets: (AppUpdateAssetInfo & { digest?: string })[];
}

export class GitHubUpdater extends EventEmitter {
  private readonly repoSlug: string;
  private readonly repoUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetcher: typeof fetch;
  private state: AppUpdateState;
  private expectedDigest?: string;
  private receipt?: DownloadReceipt;
  private checkInFlight?: Promise<AppUpdateState>;
  private downloadInFlight?: Promise<AppUpdateState>;

  constructor(private readonly options: GitHubUpdaterOptions) {
    super();
    this.repoSlug = (options.repoSlug || APP_BRAND.repoSlug).trim();
    this.repoUrl = `https://github.com/${this.repoSlug}`;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.fetcher = options.fetcher || fetch;
    this.state = {
      status: 'idle',
      currentVersion: options.currentVersion.replace(/^v/i, ''),
      repoUrl: this.repoUrl,
      canInstallDirectly: Boolean(options.canInstallDirectly),
    };
  }

  getState(): AppUpdateState {
    return structuredClone(this.state);
  }

  private setState(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch };
    const snap = this.getState();
    this.emit('state', snap);
    return snap;
  }

  private async fetchGitHubSafe(url: string, headers: Record<string, string>, timeout: number | AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      if (!isAllowedGitHubUpdateUrl(current)) {
        throw new Error('更新地址不在受信任的 GitHub 域名白名单内');
      }
      const res = await this.fetcher(current, {
        method: 'GET',
        headers: {
          'User-Agent': `Gravity/${this.state.currentVersion}`,
          ...headers,
        },
        redirect: 'manual',
        signal: typeof timeout === 'number' ? AbortSignal.timeout(timeout) : timeout,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc) throw new Error('GitHub 更新重定向缺少目标地址');
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    throw new Error('更新下载重定向次数过多');
  }

  private async fetchLatestViaApi(): Promise<ReleasePayload | { rateLimited: true }> {
    const apiUrl = `https://api.github.com/repos/${this.repoSlug}/releases/latest`;
    const res = await this.fetchGitHubSafe(
      apiUrl,
      { Accept: 'application/vnd.github+json' },
      15_000
    );
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel();
      return { rateLimited: true };
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new Error('仓库尚未发布可用的 GitHub Release');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`检查 GitHub 更新失败（HTTP ${res.status}）`);
    }
    const data = (await res.json()) as {
      tag_name?: string;
      name?: string;
      body?: string;
      html_url?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string }>;
    };
    const tag = String(data.tag_name || '').trim();
    const version = tag.replace(/^v/i, '');
    if (!parseSemver(version)) {
      throw new Error(`无法解析最新 Release 版本号：${tag || '未知'}`);
    }
    const assets: ReleasePayload['assets'] = (Array.isArray(data.assets) ? data.assets : [])
      .filter((a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string')
      .map((a) => ({
        name: a.name!, digest: a.digest,
        downloadUrl: a.browser_download_url!,
        sizeBytes: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0,
      }));
    return {
      tag,
      version,
      name: String(data.name || tag),
      notes: String(data.body || '').trim(),
      htmlUrl:
        typeof data.html_url === 'string' && isAllowedGitHubUpdateUrl(data.html_url)
          ? data.html_url
          : `${this.repoUrl}/releases/tag/${encodeURIComponent(tag)}`,
      publishedAt: typeof data.published_at === 'string' ? data.published_at : undefined,
      assets,
    };
  }

  /** 当 GitHub API 受共享 IP 匿名限流（403/429）时，降级读取公开 Releases 最新重定向页与附件清单。 */
  private async fetchLatestViaWebFallback(): Promise<ReleasePayload> {
    const latestUrl = `${this.repoUrl}/releases/latest`;
    let current = latestUrl;
    let finalTag = '';
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      if (!isAllowedGitHubUpdateUrl(current)) throw new Error('更新跳转域名不受信任');
      const res = await this.fetcher(current, {
        method: 'GET',
        headers: { 'User-Agent': `Gravity/${this.state.currentVersion}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc) break;
        current = new URL(loc, current).toString();
        if (!isAllowedGitHubUpdateUrl(current)) throw new Error('更新跳转域名不受信任');
        const tagMatch = /\/releases\/tag\/([^/?#]+)/.exec(current);
        if (tagMatch?.[1]) {
          finalTag = decodeReleaseComponent(tagMatch[1]);
          break;
        }
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`访问 GitHub Releases 页面失败（HTTP ${res.status}）`); }
      const html = await res.text();
      const m = /\/releases\/tag\/(v?\d+\.\d+\.\d+[^"'\s<>/?#]*)/.exec(html);
      if (m?.[1]) finalTag = decodeReleaseComponent(m[1]);
      break;
    }
    const version = finalTag.replace(/^v/i, '');
    if (!finalTag || !parseSemver(version)) {
      throw new Error('未能从 GitHub Releases 识别最新版本号');
    }
    const assets: AppUpdateAssetInfo[] = [];
    const expUrl = `${this.repoUrl}/releases/expanded_assets/${encodeURIComponent(finalTag)}`;
    const expRes = await this.fetchGitHubSafe(expUrl, {}, 15_000);
    if (expRes.ok) {
      const expHtml = await expRes.text();
      const escapedTag = encodeURIComponent(finalTag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`/${this.repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/download/${escapedTag}/([^"\\s<>]+)`, 'gi');
      const seen = new Set<string>();
      for (const m of expHtml.matchAll(re)) {
        const fileName = decodeReleaseComponent(m[1]);
        if (!fileName || seen.has(fileName)) continue;
        seen.add(fileName);
        assets.push({
          name: fileName,
          downloadUrl: `https://github.com/${this.repoSlug}/releases/download/${encodeURIComponent(finalTag)}/${encodeURIComponent(fileName)}`,
          sizeBytes: 0,
        });
      }
    } else await expRes.body?.cancel();
    return {
      tag: finalTag,
      version,
      name: `Gravity ${finalTag}`,
      notes: '',
      htmlUrl: `${this.repoUrl}/releases/tag/${encodeURIComponent(finalTag)}`,
      assets,
    };
  }

  async checkForUpdates(): Promise<AppUpdateState> {
    if (this.checkInFlight) return this.checkInFlight;
    if (this.state.status === 'downloading' || this.state.status === 'installing') {
      return this.getState();
    }
    this.setState({ status: 'checking', errorMessage: undefined });
    this.checkInFlight = (async () => {
      try {
        const apiResult = await this.fetchLatestViaApi();
        const release = 'rateLimited' in apiResult ? await this.fetchLatestViaWebFallback() : apiResult;
        const checkedAt = new Date().toISOString();
        const newer = compareSemver(release.version, this.state.currentVersion) > 0;
        const asset = selectReleaseAsset(release.assets, this.platform, this.arch);

        this.receipt = undefined;
        this.expectedDigest = undefined;
        if (newer && !asset && (this.platform === 'win32' || this.platform === 'darwin')) {
          throw new Error(`没有匹配 ${this.platform === 'win32' ? 'Windows' : 'macOS'} ${this.arch} 架构的更新包`);
        }
        let existingPath: string | undefined;
        if (newer && asset) {
          const digest = release.assets.find(item => item === asset)?.digest;
          if (digest) {
            if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) throw new Error('发布方摘要格式无效');
            this.expectedDigest = digest.slice(7).toLowerCase();
          }
          const sidecar = release.assets.find(item => item.name === asset.name + '.sha256');
          const manifest = sidecar ?? release.assets.find(item => /^(?:sha256sums(?:\.txt)?|checksums\.txt)$/i.test(item.name));
          if (manifest) {
            const res = await this.fetchGitHubSafe(manifest.downloadUrl, {}, 15_000);
            const sum = await readChecksum(res, asset.name, Boolean(sidecar));
            if (this.expectedDigest && this.expectedDigest !== sum) throw new Error('发布方摘要不一致');
            this.expectedDigest = sum;
          }
          const path = join(resolve(this.options.updatesDir), sanitizeAssetName(release.tag), sanitizeAssetName(asset.name));
          this.receipt = await cachedReceipt(path, release.tag, asset, this.expectedDigest);
          if (this.receipt) existingPath = path;
        }
        const existingSize = this.receipt?.size;

        return this.setState({
          status: !newer ? 'up-to-date' : existingPath ? 'downloaded' : 'available',
          latestVersion: release.version,
          releaseTag: release.tag,
          releaseName: release.name,
          releaseNotes: release.notes,
          releaseUrl: release.htmlUrl,
          publishedAt: release.publishedAt,
          asset,
          downloadedFilePath: existingPath,
          downloadedBytes: existingSize,
          totalBytes: existingSize || asset?.sizeBytes,
          progressPercent: existingPath ? 100 : undefined,
          checkedAt,
          errorMessage: undefined,
        });
      } catch (error) {
        return this.setState({
          status: 'error',
          asset: undefined,
          releaseTag: undefined,
          downloadedFilePath: undefined,
          checkedAt: new Date().toISOString(),
          errorMessage: error instanceof Error ? error.message : '检查更新失败，请检查网络连接',
        });
      } finally {
        this.checkInFlight = undefined;
      }
    })();
    return this.checkInFlight;
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (!this.downloadInFlight) {
      this.downloadInFlight = this.performDownload().finally(() => { this.downloadInFlight = undefined; });
    }
    return this.downloadInFlight;
  }

  private async performDownload(): Promise<AppUpdateState> {
    if (this.state.status === 'installing') return this.getState();
    if (!this.state.releaseTag || this.checkInFlight) {
      const checked = await this.checkForUpdates();
      if (checked.status === 'error') return checked;
    }
    const { asset, releaseTag, latestVersion, currentVersion, downloadedFilePath } = this.state;
    if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) return this.getState();
    if (!asset || !releaseTag) return this.setState({ status: 'error', errorMessage: '当前平台暂无匹配的 GitHub Release 安装包，请前往发布页手动下载' });
    if (!isAllowedGitHubUpdateUrl(asset.downloadUrl)) return this.setState({ status: 'error', errorMessage: '更新包下载地址不在 GitHub 白名单内' });
    if (this.state.status === 'downloaded' && downloadedFilePath) {
      if (await cachedReceipt(downloadedFilePath, releaseTag, asset, this.receipt?.sha256 ?? this.expectedDigest)) return this.getState();
    }

    let partPath: string | undefined;
    const controller = new AbortController();
    try {
      this.setState({
        status: 'downloading',
        downloadedFilePath: undefined,
        downloadedBytes: 0,
        totalBytes: asset.sizeBytes || undefined,
        progressPercent: 0,
        errorMessage: undefined,
      });

      const targetDir = join(resolve(this.options.updatesDir), sanitizeAssetName(releaseTag));
      const finalPath = join(targetDir, sanitizeAssetName(asset.name));
      partPath = `${finalPath}.part`;
      await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
      await fs.rm(partPath, { force: true });
      const res = await whileReceiving(controller, () => this.fetchGitHubSafe(asset.downloadUrl, { Accept: 'application/octet-stream' }, controller.signal));
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new Error(`下载更新包失败（HTTP ${res.status}）`);
      }
      const encoding = res.headers.get('content-encoding');
      const rawLength = res.headers.get('content-length')?.trim();
      const length = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
      const headerLen = (!encoding || encoding === 'identity') && Number.isSafeInteger(length) ? length : undefined;
      const totalBytes = asset.sizeBytes || headerLen || 0;
      if (totalBytes > MAX_UPDATE_BYTES || (asset.sizeBytes > 0 && headerLen !== undefined && asset.sizeBytes !== headerLen)) {
        await res.body.cancel().catch(() => {});
        throw new Error('更新包大小与发布记录不符或超过限制');
      }
      const writer = await fs.open(partPath, 'wx', 0o600);
      const reader = res.body.getReader();
      const hash = createHash('sha256');
      let downloaded = 0;
      let lastEmit = 0;

      try {
        while (true) {
          const { done, value } = await whileReceiving(controller, () => reader.read());
          if (done) break;
          if (!value || !value.byteLength) continue;
          downloaded += value.byteLength;
          if (downloaded > MAX_UPDATE_BYTES) {
            throw new Error('更新包下载体积超过安全限制');
          }
          hash.update(value);
          await writer.writeFile(value);
          const now = Date.now();
          if (now - lastEmit >= 120) {
            lastEmit = now;
            const pct = totalBytes > 0 ? Math.min(99, Math.round((downloaded / totalBytes) * 100)) : undefined;
            this.setState({
              status: 'downloading',
              downloadedBytes: downloaded,
              totalBytes: totalBytes || undefined,
              progressPercent: pct,
            });
          }
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        await writer.close();
      }

      if (!downloaded || (totalBytes > 0 && downloaded !== totalBytes)) throw new Error('更新包下载不完整，请重试');
      const sha256 = hash.digest('hex');
      if (this.expectedDigest && sha256 !== this.expectedDigest) throw new Error('下载包与发布方 SHA-256 摘要不符');
      const completedPart = partPath;
      await withWindowsRetryAsync(() => fs.rename(completedPart, finalPath));
      const receipt = { name: asset.name, releaseTag, downloadUrl: asset.downloadUrl, sha256, size: downloaded };
      await saveReceipt(finalPath, receipt);
      this.receipt = receipt;

      return this.setState({
        status: 'downloaded',
        downloadedBytes: downloaded,
        totalBytes: totalBytes || downloaded,
        progressPercent: 100,
        downloadedFilePath: finalPath,
        errorMessage: undefined,
      });
    } catch (error) {
      controller.abort();
      if (partPath) await withWindowsRetryAsync(() => fs.unlink(partPath!)).catch(() => {});
      return this.setState({ status: 'error', downloadedFilePath: undefined, errorMessage: error instanceof Error ? error.message : '下载更新包失败' });
    }
  }

  async installUpdate(): Promise<{ launched: boolean; message: string }> {
    const filePath = this.state.downloadedFilePath;
    if (this.state.status !== 'downloaded' || !filePath) {
      throw new Error('尚未下载可用的更新包，请先点击下载更新');
    }
    if (!this.options.installHandler) {
      throw new Error('当前运行环境不支持直接安装更新');
    }
    this.setState({ status: 'installing', errorMessage: undefined });
    try {
      const { asset, releaseTag } = this.state;
      const receipt = this.receipt && asset && releaseTag && await cachedReceipt(filePath, releaseTag, asset, this.receipt.sha256);
      if (!receipt) throw new Error('更新包校验失败，请重新下载');
      const result = await this.options.installHandler(filePath, this.getState(), receipt);
      if (!result.launched) this.setState({ status: 'downloaded' });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : '启动更新安装失败';
      this.receipt = undefined;
      this.setState({ status: 'error', downloadedFilePath: undefined, progressPercent: undefined, errorMessage: msg });
      throw error;
    }
  }
}

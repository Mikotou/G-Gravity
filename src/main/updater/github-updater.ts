import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
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

export interface GitHubUpdaterOptions {
  currentVersion: string;
  updatesDir: string;
  repoSlug?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  canInstallDirectly?: boolean;
  fetcher?: typeof fetch;
  installHandler?: (filePath: string, state: AppUpdateState) => Promise<{ launched: boolean; message: string }>;
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
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = String(raw || '').trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
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
  return pa.prerelease > pb.prerelease ? 1 : -1;
}

/** 按当前操作系统与 CPU 架构从 Release 资产列表中选出最匹配的更新包。 */
export function selectReleaseAsset(
  assets: readonly AppUpdateAssetInfo[],
  platform: NodeJS.Platform,
  arch: string
): AppUpdateAssetInfo | undefined {
  const valid = assets.filter((a) => a?.name && a.downloadUrl && isAllowedGitHubUpdateUrl(a.downloadUrl));
  if (platform === 'win32') {
    return (
      valid.find((a) => /^gravity\.exe$/i.test(a.name)) ||
      valid.find((a) => /win.*\.exe$/i.test(a.name)) ||
      valid.find((a) => /\.exe$/i.test(a.name))
    );
  }
  if (platform === 'darwin') {
    const targetArch = arch === 'arm64' ? 'arm64' : 'x64';
    const otherArch = targetArch === 'arm64' ? 'x64' : 'arm64';
    const archMatch = (name: string) =>
      name.toLowerCase().includes(targetArch) && !name.toLowerCase().includes(otherArch);
    // macOS 优先选择 .zip 以便原地解压替换 Gravity.app，其次回退 .dmg 挂载安装
    return (
      valid.find((a) => archMatch(a.name) && /\.zip$/i.test(a.name)) ||
      valid.find((a) => archMatch(a.name) && /\.dmg$/i.test(a.name)) ||
      valid.find((a) => /mac.*\.zip$/i.test(a.name) && !a.name.toLowerCase().includes(otherArch)) ||
      valid.find((a) => /mac.*\.dmg$/i.test(a.name) && !a.name.toLowerCase().includes(otherArch))
    );
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
  assets: AppUpdateAssetInfo[];
}

export class GitHubUpdater extends EventEmitter {
  private readonly repoSlug: string;
  private readonly repoUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetcher: typeof fetch;
  private state: AppUpdateState;
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

  private async fetchGitHubSafe(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
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
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
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
      return { rateLimited: true };
    }
    if (res.status === 404) {
      throw new Error('仓库尚未发布可用的 GitHub Release');
    }
    if (!res.ok) {
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
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
    };
    const tag = String(data.tag_name || '').trim();
    const version = tag.replace(/^v/i, '');
    if (!parseSemver(version)) {
      throw new Error(`无法解析最新 Release 版本号：${tag || '未知'}`);
    }
    const assets: AppUpdateAssetInfo[] = (Array.isArray(data.assets) ? data.assets : [])
      .filter((a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string')
      .map((a) => ({
        name: a.name!,
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
        if (!loc) break;
        current = new URL(loc, current).toString();
        if (!isAllowedGitHubUpdateUrl(current)) throw new Error('更新跳转域名不受信任');
        const tagMatch = /\/releases\/tag\/([^/?#]+)/.exec(current);
        if (tagMatch?.[1]) {
          finalTag = decodeURIComponent(tagMatch[1]);
          break;
        }
        continue;
      }
      if (!res.ok) throw new Error(`访问 GitHub Releases 页面失败（HTTP ${res.status}）`);
      const html = await res.text();
      if (!finalTag) {
        const m = /\/releases\/tag\/(v?\d+\.\d+\.\d+[^"'\s<>/?#]*)/.exec(html);
        if (m?.[1]) finalTag = decodeURIComponent(m[1]);
      }
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
      const escapedTag = finalTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`/${this.repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/download/${escapedTag}/([^"\\s<>]+)`, 'gi');
      const seen = new Set<string>();
      for (const m of expHtml.matchAll(re)) {
        const fileName = decodeURIComponent(m[1]);
        if (seen.has(fileName)) continue;
        seen.add(fileName);
        assets.push({
          name: fileName,
          downloadUrl: `https://github.com/${this.repoSlug}/releases/download/${encodeURIComponent(finalTag)}/${encodeURIComponent(fileName)}`,
          sizeBytes: 0,
        });
      }
    }
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

        // 若目标版本的安装包此前已经完整下载到本地，直接保留 downloaded 状态方便立即安装
        let existingPath: string | undefined;
        if (newer && asset) {
          const candidate = join(resolve(this.options.updatesDir), sanitizeAssetName(release.tag), sanitizeAssetName(asset.name));
          if (existsSync(candidate)) {
            const st = await fs.stat(candidate).catch(() => null);
            if (st && st.isFile() && st.size > 0 && (!asset.sizeBytes || st.size === asset.sizeBytes)) {
              existingPath = candidate;
            }
          }
        }

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
          downloadedBytes: existingPath ? asset?.sizeBytes : undefined,
          totalBytes: asset?.sizeBytes,
          progressPercent: existingPath ? 100 : undefined,
          checkedAt,
          errorMessage: undefined,
        });
      } catch (error) {
        return this.setState({
          status: 'error',
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
    if (this.downloadInFlight) return this.downloadInFlight;
    if (this.state.status === 'downloaded' && this.state.downloadedFilePath && existsSync(this.state.downloadedFilePath)) {
      return this.getState();
    }
    if (!this.state.asset || !this.state.releaseTag) {
      await this.checkForUpdates();
    }
    const asset = this.state.asset;
    const tag = this.state.releaseTag;
    if (!asset || !tag) {
      return this.setState({
        status: 'error',
        errorMessage: '当前平台暂无匹配的 GitHub Release 安装包，请前往发布页手动下载',
      });
    }
    if (!isAllowedGitHubUpdateUrl(asset.downloadUrl)) {
      return this.setState({ status: 'error', errorMessage: '更新包下载地址不在 GitHub 白名单内' });
    }

    this.downloadInFlight = (async () => {
      const targetDir = join(resolve(this.options.updatesDir), sanitizeAssetName(tag));
      const finalPath = join(targetDir, sanitizeAssetName(asset.name));
      const partPath = `${finalPath}.part`;
      await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
      await fs.unlink(partPath).catch(() => {});

      this.setState({
        status: 'downloading',
        downloadedBytes: 0,
        totalBytes: asset.sizeBytes || undefined,
        progressPercent: 0,
        errorMessage: undefined,
      });

      try {
        const res = await this.fetchGitHubSafe(asset.downloadUrl, { Accept: 'application/octet-stream' }, 180_000);
        if (!res.ok || !res.body) {
          throw new Error(`下载更新包失败（HTTP ${res.status}）`);
        }
        const headerLen = Number(res.headers.get('content-length') || 0);
        const totalBytes = headerLen > 0 ? headerLen : asset.sizeBytes || 0;
        if (totalBytes > MAX_UPDATE_BYTES) {
          throw new Error('更新包体积超过安全限制');
        }

        const writer = createWriteStream(partPath, { mode: 0o600 });
        const reader = res.body.getReader();
        let downloaded = 0;
        let lastEmit = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || !value.byteLength) continue;
            downloaded += value.byteLength;
            if (downloaded > MAX_UPDATE_BYTES) {
              throw new Error('更新包下载体积超过安全限制');
            }
            if (!writer.write(Buffer.from(value))) {
              await new Promise<void>((resDrain, rejDrain) => {
                writer.once('drain', resDrain);
                writer.once('error', rejDrain);
              });
            }
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
          await new Promise<void>((resolveEnd, rejectEnd) => {
            writer.once('error', rejectEnd);
            writer.end(() => resolveEnd());
          });
        } catch (streamErr) {
          writer.destroy();
          await fs.unlink(partPath).catch(() => {});
          throw streamErr;
        }

        if (downloaded <= 0) {
          await fs.unlink(partPath).catch(() => {});
          throw new Error('下载的更新包为空文件');
        }
        await fs.unlink(finalPath).catch(() => {});
        await fs.rename(partPath, finalPath);

        return this.setState({
          status: 'downloaded',
          downloadedBytes: downloaded,
          totalBytes: totalBytes || downloaded,
          progressPercent: 100,
          downloadedFilePath: finalPath,
          errorMessage: undefined,
        });
      } catch (error) {
        await fs.unlink(partPath).catch(() => {});
        return this.setState({
          status: 'error',
          errorMessage: error instanceof Error ? error.message : '下载更新包失败',
        });
      } finally {
        this.downloadInFlight = undefined;
      }
    })();
    return this.downloadInFlight;
  }

  async installUpdate(): Promise<{ launched: boolean; message: string }> {
    const filePath = this.state.downloadedFilePath;
    if (this.state.status !== 'downloaded' || !filePath || !existsSync(filePath)) {
      throw new Error('尚未下载可用的更新包，请先点击下载更新');
    }
    if (!this.options.installHandler) {
      throw new Error('当前运行环境不支持直接安装更新');
    }
    this.setState({ status: 'installing', errorMessage: undefined });
    try {
      return await this.options.installHandler(filePath, this.getState());
    } catch (error) {
      const msg = error instanceof Error ? error.message : '启动更新安装失败';
      this.setState({ status: 'downloaded', errorMessage: msg });
      throw error;
    }
  }
}

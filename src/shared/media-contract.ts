/**
 * Gravity v0.3.1 — 本地媒体与文件引用安全校验、元信息探测与混排分类共享契约
 *
 * 合规约束：
 * 1. 所有本地文件探测（`APP_INSPECT_LOCAL_TARGETS`）必须纯只读（0 字节写入），且在主进程先执行
 *    `realpath` + `isForbiddenCredentialOrStatePath()` 拦截敏感凭据与内部状态文件；
 * 2. 本模块为纯无副作用函数与类型定义，供主进程、渲染层与测试共享。
 */

export const MAX_LOCAL_INSPECT_TARGETS = 48;
export const MAX_INLINE_PREVIEW_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 20;
export const MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES = 24 * 1024 * 1024;

export type LocalTargetKind = 'image' | 'file' | 'directory' | 'missing' | 'forbidden';

export interface InspectedLocalTarget {
  rawTarget: string;
  kind: LocalTargetKind;
  exists: boolean;
  resolvedPath?: string;
  fileUrl?: string;
  fileName: string;
  /** 相对于当前工作区或父目录的精简路径提示，用于卡片副标题与悬停说明 */
  parentHint?: string;
  /** 不含前导点号的小写扩展名，例如 `png`、`svg`、`ico`、`ts` */
  ext?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  /** 通过安全与体积校验的受控内联预览 data URL（规避 dev 模式跨域与本地 SVG/WebP 剪贴板污染） */
  previewDataUrl?: string;
  isExecutable?: boolean;
}

export interface InspectLocalTargetsInput {
  targets: string[];
  cwd?: string;
  sessionId?: string;
  includePreviewData?: boolean;
}

export interface InspectLocalTargetsResult {
  items: Record<string, InspectedLocalTarget>;
}

const PREVIEWABLE_IMAGE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'svg',
] as const;

const PREVIEWABLE_IMAGE_EXT_SET = new Set<string>(PREVIEWABLE_IMAGE_EXTENSIONS);

/** 点击本地链接时不可直接用默认程序执行的可执行/脚本/安装包后缀（一律降级为在文件夹/访达中显示）。 */
export const EXECUTABLE_OR_SCRIPT_EXT_RE =
  /\.(?:exe|msi|msp|bat|cmd|com|scr|pif|ps1|psm1|psd1|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|hta|reg|lnk|cpl|dll|ocx|sys|jar|msc|chm|appref-ms|scf|inf|sh|bash|zsh|command|tool|app|pkg|mpkg|dmg|action|workflow)$/i;

const KNOWN_DOTFILE_NAMES = new Set<string>([
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.npmrc',
  '.nvmrc',
  '.yarnrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.browserslistrc',
  '.dockerignore',
  '.eslintignore',
  '.prettierignore',
  '.stylelintrc',
  '.env.example',
  '.env.sample',
  '.env.template',
]);

const KNOWN_LOCAL_FILE_EXT_RE =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonl|jsonc|md|markdown|txt|log|csv|tsv|pdf|png|jpg|jpeg|gif|webp|avif|bmp|svg|ico|icns|html|htm|css|scss|less|yml|yaml|toml|ini|cfg|conf|xml|sql|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|swift|dart|vue|svelte|zip|7z|tar|gz|mp3|wav|mp4|webm|doc|docx|xls|xlsx|ppt|pptx|exe|msi|bat|cmd|ps1|dll|sh|dmg|pkg)$/i;

/** 剥离行号锚点（#L10 / #L10-L20 / :10:5）与 URL 查询串，仅保留路径本体。 */
export function stripLocalTargetAnchor(raw: string): string {
  return raw
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[?#].*$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '');
}

/** 从链接或路径尾部提取可读行号徽标（如 `L10` 或 `L10-L20`）。 */
export function extractLineAnchorBadge(raw: string): string | undefined {
  const hashMatch = /#(L\d+(?:-L?\d+)?)$/i.exec(raw.trim());
  if (hashMatch) return hashMatch[1].toUpperCase();
  const colonMatch = /:(\d+)(?::\d+)?$/.exec(raw.trim());
  if (colonMatch) return `L${colonMatch[1]}`;
  return undefined;
}

/** 提取路径末段文件名（兼容 Windows `\` 与 POSIX `/` 以及 `file:///` URI）。 */
export function extractTargetBaseName(raw: string): string {
  let clean = stripLocalTargetAnchor(raw);
  if (/^file:\/\//i.test(clean)) {
    clean = clean.replace(/^file:\/\/\/?/i, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {
      /* keep raw */
    }
  }
  clean = clean.replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || clean;
}

/** 判断扩展名是否属于视觉画廊可直接展示的图片格式。 */
export function isSupportedPreviewImageExt(ext?: string | null): boolean {
  if (!ext) return false;
  return PREVIEWABLE_IMAGE_EXT_SET.has(ext.replace(/^\./, '').toLowerCase());
}

/**
 * 识别明显不应被提取为本地文件预览的碎片文本：
 * - 裸扩展名：`.svg`、`.png`、`.ico`、`.ts`
 * - 连字符前缀后缀/CLI 参数片段：`-mac.png`、`--config.json`
 * - 通配符或模板占位符：`*.png`、`<name>.svg`、`${var}.ts`、`foo[0].png`
 */
export function isBareExtensionOrFragment(raw: string): boolean {
  const clean = stripLocalTargetAnchor(raw);
  if (!clean) return true;
  if (/[*?<>{}$|]/.test(clean)) return true;
  const base = extractTargetBaseName(clean);
  if (!base) return true;
  if (KNOWN_DOTFILE_NAMES.has(base.toLowerCase())) return false;
  if (/^\.[a-z0-9]{1,12}$/i.test(clean)) return true;
  // 没有路径分隔符且以 `-` 开头（如 `-mac.png`、`--out.json`），属于命名后缀或 CLI 参数片段
  if (!/[\\/]/.test(clean) && clean.startsWith('-')) return true;
  if (/^\.[a-z0-9]{1,12}$/i.test(base)) return true;
  return false;
}

/**
 * 判断一段文本或链接目标是否是“合理可探测的本地文件/目录引用候选”。
 * 严格排除裸扩展名（`.svg`/`.png`/`.ico`）、后缀片段（`-mac.png`）、危险协议与普通命令词。
 */
export function isPlausibleLocalFileCandidate(
  rawText: string,
  options: { allowBareFileName?: boolean } = {}
): boolean {
  const { allowBareFileName = true } = options;
  const trimmed = rawText.trim().replace(/^<|>$/g, '');
  if (!trimmed || trimmed.length > 400 || /[\r\n\x00-\x1f]/.test(trimmed)) return false;
  if (trimmed.startsWith('#')) return false;
  if (/^(?:javascript|vbscript|mailto|data|blob):/i.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;

  const clean = stripLocalTargetAnchor(trimmed);
  if (isBareExtensionOrFragment(clean)) return false;

  if (/^file:\/\//i.test(trimmed)) {
    const body = clean.replace(/^file:\/\/\/?/i, '');
    return body.length >= 2 && !isBareExtensionOrFragment(body);
  }
  if (/^[A-Za-z]:[\\/]/.test(clean)) {
    return clean.length >= 4;
  }
  if (/^(?:\.{1,2}[\\/]|~[\\/])/.test(clean)) {
    const rest = clean.replace(/^(?:\.{1,2}[\\/]|~[\\/])+/, '');
    return rest.length >= 1 && !isBareExtensionOrFragment(rest);
  }
  if (/^\/[^/]/.test(clean)) {
    if (clean.length < 3) return false;
    if (/\s/.test(clean)) {
      // 允许含空格的 POSIX 绝对路径（如 macOS 截图或空格工程目录），但拒绝首段即带空格的 slash 命令（如 `/compact now`）
      const firstSpace = clean.indexOf(' ');
      const secondSlash = clean.indexOf('/', 1);
      return secondSlash > 1 && firstSpace > secondSlash;
    }
    return true;
  }

  // 相对路径或裸文件名不允许包含未引号包裹的空格或以 `-` 开头
  if (/\s/.test(clean) || clean.startsWith('-')) return false;

  if (/[\\/]/.test(clean)) {
    const base = extractTargetBaseName(clean);
    if (!base) return false;
    if (KNOWN_DOTFILE_NAMES.has(base.toLowerCase())) return true;
    if (/^\.[a-z0-9]+$/i.test(base)) return false;
    return (
      KNOWN_LOCAL_FILE_EXT_RE.test(clean) ||
      /^(?:src|tests|test|docs|scripts|public|assets|release|dist|build|packages|apps|config)[\\/]/i.test(clean)
    );
  }

  if (!allowBareFileName) return false;
  if (KNOWN_DOTFILE_NAMES.has(clean.toLowerCase())) return true;

  // 裸文件名必须具有有效主干（至少 1 个非点/非横杠字符）+ 已知扩展名
  const dotIdx = clean.lastIndexOf('.');
  if (dotIdx <= 0) return false;
  const stem = clean.slice(0, dotIdx);
  if (!/[A-Za-z0-9\u3400-\u9fff]/.test(stem)) return false;
  return KNOWN_LOCAL_FILE_EXT_RE.test(clean);
}

/**
 * 判断 URL 或本地路径是否指向可预览图片（彻底杜绝 `.svg` / `.png` / `-mac.png` 误匹配）。
 */
export function isPreviewableImagePath(rawUrl: string): boolean {
  const trimmed = rawUrl.trim().replace(/^<|>$/g, '');
  if (!trimmed || /^(?:javascript|vbscript|mailto):/i.test(trimmed)) return false;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,/i.test(trimmed)) return true;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const base = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
      const match = /^([^/]+)\.([a-z0-9]{2,5})$/i.exec(base);
      return Boolean(match && match[1] && /[A-Za-z0-9\u3400-\u9fff]/.test(match[1]) && isSupportedPreviewImageExt(match[2]));
    } catch {
      return false;
    }
  }

  if (!isPlausibleLocalFileCandidate(trimmed)) return false;
  const base = extractTargetBaseName(trimmed);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return false;
  const stem = base.slice(0, dotIdx);
  const ext = base.slice(dotIdx + 1).toLowerCase();
  return /[A-Za-z0-9\u3400-\u9fff]/.test(stem) && isSupportedPreviewImageExt(ext);
}

/** 格式化文件字节数（紧凑易读）。 */
export function formatByteSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

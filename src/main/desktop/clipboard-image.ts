import { BrowserWindow, nativeImage } from 'electron';
import { localImageMimeType } from '../services/local-media-inspector';
import { readBoundedLocalFile } from '../workspace/local-path-safety';

// Chromium can decode formats that the platform NativeImage loader does not support. Load
// validated data only as an image in an isolated world. SVG never becomes a document.
export async function clipboardImage(target: string, owner?: BrowserWindow): Promise<Electron.NativeImage> {
  let dataUrl = target;
  if (!/^data:image\//i.test(target)) {
    const mime = localImageMimeType(target);
    if (!mime) throw new Error('无法解码图片，请检查文件格式');
    // Read the checked file once. NativeImage path loading can also probe sibling @2x files.
    const bytes = await readBoundedLocalFile(target, 20 * 1024 * 1024);
    dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
  }
  const native = /^data:image\/svg\+xml;/i.test(dataUrl) ? undefined : nativeImage.createFromDataURL(dataUrl);
  if (native && !native.isEmpty()) {
    const { width, height } = native.getSize();
    if (width * height > 16777216) throw new Error('图片尺寸超过剪贴板限制');
    // Decode the original ICO pixels when a renderer is available.
    if (!owner || !/^data:image\/x-icon;/i.test(dataUrl)) return native;
  }
  if (!owner) throw new Error('无法读取图片，请打开图片预览后再复制');
  const png = await owner.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();
    const width = img.naturalWidth, height = img.naturalHeight;
    if (!width || !height || width * height > 16777216) throw new Error('图片无法解码或尺寸超过限制');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  })()` }]).catch(() => undefined);
  if (!png) {
    if (native && !native.isEmpty()) return native;
    throw new Error('无法解码图片或图片尺寸超过剪贴板限制');
  }
  const image = nativeImage.createFromDataURL(png);
  if (image.isEmpty()) throw new Error('无法读取图片数据以复制到剪贴板');
  return image;
}

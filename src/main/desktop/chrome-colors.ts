// Electron's Windows overlay accepts an opaque RGB color. Flatten CSS alpha
// against the actual window surface before checking the native glyph contrast.
function rgb(value: string, base: number[]): number[] {
  const hex = /^#([\da-f]{3,8})$/i.exec(value)?.[1];
  let channels: number[], alpha: number;
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
    channels = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
    alpha = full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1;
  } else {
    const parts = Array.from(value.match(/[+-]?(?:\d*\.)?\d+%?/g) ?? []) as string[];
    if (parts.length < 3) return base;
    const number = (part: string, max: number) => parseFloat(part) * (part.endsWith('%') ? max / 100 : 1);
    if (value.startsWith('hsl')) {
      const hue = ((parseFloat(parts[0]) % 360) + 360) % 360 / 30;
      const saturation = number(parts[1], 1), light = number(parts[2], 1);
      channels = [0, 8, 4].map(n => {
        const k = (n + hue) % 12;
        return 255 * (light - saturation * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
      });
    } else channels = parts.slice(0, 3).map(p => number(p, 255));
    alpha = parts[3] ? number(parts[3], 1) : 1;
  }
  alpha = Math.min(1, Math.max(0, alpha));
  return channels.map((c, i) => Math.round(Math.min(255, Math.max(0, c)) * alpha + base[i] * (1 - alpha)));
}
function luminance(channels: number[]): number {
  const linear = channels.map(c => c / 255 <= 0.04045 ? c / 3294.6 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
const hex = (channels: number[]) => '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');

export function chromeColors(bgApp: string, textSecondary: string, light: boolean) {
  const bg = rgb(bgApp, Array(3).fill(light ? 255 : 0));
  const fg = rgb(textSecondary, bg);
  const l1 = luminance(bg) + 0.05, l2 = luminance(fg) + 0.05;
  return { backgroundColor: hex(bg), symbolColor: Math.max(l1, l2) / Math.min(l1, l2) >= 4.5
    ? hex(fg) : l1 * l1 > 0.0525 ? '#000000' : '#ffffff' };
}

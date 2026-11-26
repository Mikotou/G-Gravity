/**
 * 渲染层本地时区时间格式化（纯函数，无副作用）。
 *
 * FE-10：审计日志与 Swarm 面板过去直接 `.slice(11, 19)` 截取 UTC ISO 字符串，
 * 东八区等用户看到的时间会慢 8 小时。这里统一按用户本机时区与界面语言格式化。
 */

function parseTimestamp(ts: string | number | Date | undefined | null): Date | null {
  if (ts === undefined || ts === null || ts === '') return null;
  const date = ts instanceof Date ? ts : new Date(ts);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** 本地时区 24 小时制时间，`withSeconds` 为 true 时显示到秒（HH:mm:ss），否则 HH:mm。 */
export function formatLocalClock(
  ts: string | number | Date | undefined | null,
  locale: string,
  withSeconds = true
): string {
  const date = parseTimestamp(ts);
  if (!date) return typeof ts === 'string' ? ts : '';
  return date.toLocaleTimeString(locale, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
  });
}

/** 本地时区「月-日 时:分」，用于审计记录等需要日期上下文的列表。 */
export function formatLocalDateTime(ts: string | number | Date | undefined | null, locale: string): string {
  const date = parseTimestamp(ts);
  if (!date) return typeof ts === 'string' ? ts : '';
  return date.toLocaleString(locale, {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

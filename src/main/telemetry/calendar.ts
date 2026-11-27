const pad = (value: number) => String(value).padStart(2, '0');

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Use elapsed minutes so the repeated local hour retains its own offset.
 * A half-hour spring transition can start a bucket at :30 instead of :00. */
function hourStart(time: number): number {
  const date = new Date(time);
  let start = time - (date.getMinutes() * 60 + date.getSeconds()) * 1000 - date.getMilliseconds();
  if (new Date(start).getTimezoneOffset() !== date.getTimezoneOffset()) {
    let end = time;
    while (start + 1 < end) {
      const middle = Math.floor((start + end) / 2);
      if (new Date(middle).getTimezoneOffset() === date.getTimezoneOffset()) end = middle;
      else start = middle;
    }
    start = end;
  }
  return start;
}
function utcKey(start: number): string {
  return new Date(start).toISOString().slice(0, 16).replace(/:00$/, '');
}
export function ledgerHour(time: number): string { return utcKey(hourStart(time)); }

export function calendarFor(time: number) {
  const now = new Date(time);
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29 + index);
    return dayKey(date);
  });
  const hours = [];
  let cursor = time;
  for (let i = 0; i < 24; i++) {
    const start = hourStart(cursor);
    const date = new Date(start);
    const offset = -date.getTimezoneOffset();
    const hourLabel = pad(date.getHours()) + ':' + pad(date.getMinutes());
    const zone = (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
    hours.unshift({ hourKey: utcKey(start), hourLabel, startIso: dayKey(date) + 'T' + hourLabel + ':00' + zone });
    cursor = start - 1;
  }
  return { days, hours, time };
}

/** Visit stored buckets once. Local days can contain 23 or 25 elapsed hours. */
export function calendarBuckets<T extends { hourKey: string }>(records: Iterable<T>, calendar: ReturnType<typeof calendarFor>) {
  const hours = new Map<string, T[]>(), days = new Map<string, T[]>(), slots = new Map<string, T[]>();
  const append = (map: Map<string, T[]>, key: string, value: T) => {
    const group = map.get(key);
    if (group) group.push(value);
    else map.set(key, [value]);
  };
  for (const row of records) {
    const time = Date.parse(row.hourKey + (row.hourKey.length === 13 ? ':00:00Z' : ':00Z'));
    if (!Number.isFinite(time) || time > calendar.time) continue;
    const local = new Date(time), date = dayKey(local);
    append(hours, ledgerHour(time), row);
    append(days, date, row);
    append(slots, `${date}/${local.getHours()}`, row);
  }
  return {
    hour: (key: string) => hours.get(key) ?? [],
    day: (key: string) => days.get(key) ?? [],
    slot: (date: string, hour: number) => slots.get(`${date}/${hour}`) ?? [],
    range: (scope: 'today' | '7d' | '30d') => calendar.days.slice(scope === 'today' ? -1 : scope === '7d' ? -7 : -30)
      .flatMap(date => days.get(date) ?? []),
  };
}

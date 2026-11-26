const HOUR = 3_600_000;
const pad = (value: number) => String(value).padStart(2, '0');

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Absolute keys survive timezone changes and distinguish the two hours repeated at the end of DST. */
export function ledgerHour(time: number): string {
  const date = new Date(time);
  const start = time - (date.getMinutes() * 60 + date.getSeconds()) * 1000 - date.getMilliseconds();
  return new Date(start).toISOString().slice(0, 16).replace(/:00$/, '');
}

export function calendarFor(time: number) {
  const now = new Date(time);
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29 + index);
    return dayKey(date);
  });
  const hours = Array.from({ length: 24 }, (_, index) => {
    const point = time - (23 - index) * HOUR;
    return { hourKey: ledgerHour(point), hourLabel: `${pad(new Date(point).getHours())}:00` };
  });
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

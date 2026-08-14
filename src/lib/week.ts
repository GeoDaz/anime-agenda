import {
  addDays,
  endOfDay,
  endOfWeek,
  format,
  isSameDay,
  isToday,
  startOfDay,
  startOfWeek,
} from 'date-fns';
import { fr } from 'date-fns/locale';

export interface DayBucket {
  date: Date;
  label: string;
  shortLabel: string;
  dayNumber: string;
  isToday: boolean;
}

export interface WeekRange {
  from: number;
  to: number;
  days: DayBucket[];
  /** Libelle "4 - 10 aout 2026". */
  label: string;
}

/** Semaine contenant `ref`, decalee de `offset` semaines. */
export function buildWeek(ref: Date, offset = 0, mondayFirst = true): WeekRange {
  const opts = { weekStartsOn: (mondayFirst ? 1 : 0) as 0 | 1, locale: fr };
  const base = addDays(ref, offset * 7);
  const start = startOfWeek(base, opts);
  const end = endOfWeek(base, opts);

  const days: DayBucket[] = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    return {
      date: d,
      label: format(d, 'EEEE d MMMM', { locale: fr }),
      shortLabel: format(d, 'EEE', { locale: fr }).replace('.', ''),
      dayNumber: format(d, 'd'),
      isToday: isToday(d),
    };
  });

  const sameMonth = format(start, 'MM') === format(end, 'MM');
  const label = sameMonth
    ? `${format(start, 'd', { locale: fr })} – ${format(end, 'd MMMM yyyy', { locale: fr })}`
    : `${format(start, 'd MMM', { locale: fr })} – ${format(end, 'd MMM yyyy', { locale: fr })}`;

  return {
    from: startOfDay(start).getTime(),
    to: endOfDay(end).getTime(),
    days,
    label,
  };
}

/** Regroupe des entrees datees par jour de la semaine, ordre chronologique. */
export function groupByDay<T extends { airsAt: number }>(
  entries: T[],
  days: DayBucket[]
): { day: DayBucket; entries: T[] }[] {
  return days.map((day) => ({
    day,
    entries: entries
      .filter((e) => isSameDay(new Date(e.airsAt), day.date))
      .sort((a, b) => a.airsAt - b.airsAt),
  }));
}

export function formatTime(ts: number): string {
  return format(new Date(ts), 'HH:mm');
}

/** Format `YYYY-MM-DD` en heure locale (l'API ADN attend ce format). */
export function toApiDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

/** Toutes les dates ISO couvertes par un intervalle, bornes incluses. */
export function datesInRange(from: number, to: number): string[] {
  const out: string[] = [];
  let cursor = startOfDay(new Date(from));
  const last = startOfDay(new Date(to));
  while (cursor.getTime() <= last.getTime()) {
    out.push(toApiDate(cursor));
    cursor = addDays(cursor, 1);
  }
  return out;
}

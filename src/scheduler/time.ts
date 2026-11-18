// Date and shift-time arithmetic. Dates are handled as UTC calendar days so time zones and
// daylight saving never shift a date; shift times become absolute minutes for comparisons.

import type { DateStr, MonthStr, Settings, Shift, ShiftSpec, TimeStr } from './types';

const MS_PER_DAY = 86_400_000;

export const toMinutes = (t: TimeStr): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Days since 1970-01-01. */
export const dayIndex = (d: DateStr): number => Math.round(Date.parse(`${d}T00:00:00Z`) / MS_PER_DAY);
export const fromDayIndex = (n: number): DateStr => new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
export const addDays = (d: DateStr, n: number): DateStr => fromDayIndex(dayIndex(d) + n);

/** JS weekday: 0 = Sunday … 6 = Saturday. */
export const weekday = (d: DateStr): number => new Date(`${d}T00:00:00Z`).getUTCDay();
export const isWeekend = (d: DateStr): boolean => weekday(d) === 0 || weekday(d) === 6;

export const monthOf = (d: DateStr): MonthStr => d.slice(0, 7);

export const daysInMonth = (month: MonthStr): DateStr[] => {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};

export const addMonths = (month: MonthStr, n: number): MonthStr => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

/** The Monday of the Monday–Sunday week containing `d`. */
export const weekStart = (d: DateStr): DateStr => addDays(d, -((weekday(d) + 6) % 7));

export const isOpen = (d: DateStr, settings: Settings): boolean => settings.closing[weekday(d)] != null;

/** Closing time that day (23:00 if the bar is marked closed but a shift was added anyway). */
export const closingTime = (d: DateStr, settings: Settings): TimeStr => settings.closing[weekday(d)] ?? '23:00';

export const inRange = (d: DateStr, from?: DateStr, to?: DateStr): boolean => (!from || d >= from) && (!to || d <= to);

/** Absolute minutes since 1970-01-01. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * When a shift really runs. "close" ends at that weekday's closing time; an end at or before
 * the start (e.g. 18:00–01:00) is on the next day.
 */
export const shiftInterval = (s: Pick<Shift, 'date' | 'start' | 'end'>, settings: Settings): Interval => {
  const base = dayIndex(s.date) * 1440;
  const start = base + toMinutes(s.start);
  let end = base + toMinutes(s.end === 'close' ? closingTime(s.date, settings) : s.end);
  if (end <= start) end += 1440;
  return { start, end };
};

export const shiftHours = (s: Pick<Shift, 'date' | 'start' | 'end'>, settings: Settings): number => {
  const { start, end } = shiftInterval(s, settings);
  return (end - start) / 60;
};

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Hours between two intervals that don't overlap (whichever comes first). */
export const restHours = (a: Interval, b: Interval): number =>
  (a.end <= b.start ? b.start - a.end : a.start - b.end) / 60;

export type ShiftKind = 'day' | 'evening' | 'close';

/** "close" = runs until closing; "day" = starts before 15:00; anything else is "evening". */
export const shiftKind = (s: Pick<ShiftSpec, 'start' | 'end'>): ShiftKind =>
  s.end === 'close' ? 'close' : toMinutes(s.start) < 15 * 60 ? 'day' : 'evening';

/** Late = until close, or past midnight. Used for fair share. */
export const isLate = (s: Pick<Shift, 'date' | 'start' | 'end'>, settings: Settings): boolean =>
  s.end === 'close' || shiftInterval(s, settings).end > (dayIndex(s.date) + 1) * 1440;

export const formatTimes = (s: Pick<ShiftSpec, 'start' | 'end'>): string =>
  `${s.start}–${s.end === 'close' ? 'close' : s.end}`;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Sat 12 Dec" */
export const formatDate = (d: DateStr): string =>
  `${WEEKDAY_SHORT[weekday(d)]} ${Number(d.slice(8, 10))} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1]}`;

/** "December 2026" */
export const formatMonth = (m: MonthStr): string => `${MONTH_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** "Sat 12 Dec" or "Sat 12 – Mon 14 Dec" */
export const formatRange = (from: DateStr, to: DateStr): string => (from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`);

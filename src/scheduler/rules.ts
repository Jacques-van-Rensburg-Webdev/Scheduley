// Rule-type registry. Every rule the manager can create is an instance of one of these types.
// A type declares its form fields (the UI builds the editor from them), a one-line summary, and
// a check that says why one assignment breaks the rule. Adding a rule type = adding one entry.

import type { DateStr, Employee, ID, MonthStr, Priority, Rule, Settings, Shift } from './types';
import {
  dayIndex, daysInMonth, inRange, isWeekend, restHours, shiftKind, toMinutes, weekStart, weekday,
  type Interval,
} from './time';

export type FieldKind = 'number' | 'weekdays' | 'time' | 'employee' | 'skill' | 'shiftKind' | 'shiftKinds';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  optional?: boolean;
  default: unknown;
}

/** One of the person's shifts, with its times worked out. */
export interface Placed {
  shift: Shift;
  interval: Interval;
  hours: number;
}

export interface CheckContext {
  employee: Employee;
  shift: Shift;
  interval: Interval;
  hours: number;
  /** The person's other shifts this month (not this one). */
  others: Placed[];
  /** People already on this shift (not the person being checked). */
  coworkers: ID[];
  settings: Settings;
  month: MonthStr;
}

export type ScopeKind = 'all' | 'team' | 'employee';

export interface RuleTypeDef {
  id: string;
  name: string;
  description: string;
  /** Who a rule of this type can be made for. */
  scopes: ScopeKind[];
  fields: FieldDef[];
  /** Can only be Preferred (a wish, never a hard rule). */
  softOnly?: boolean;
  /** Judged per shift (how many people with a skill), not per person. */
  coverage?: boolean;
  /** Judged on the whole month only (no per-assignment check). */
  monthly?: boolean;
  /** Returns why putting the person on the shift breaks the rule, or null. */
  check?: (p: any, c: CheckContext) => string | null;
  summary: (p: any, nameOf: (id: ID) => string) => string;
}

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday-first order for day pickers. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const KIND_NAMES: Record<string, string> = { day: 'day shifts', evening: 'evening shifts', close: 'until-close shifts', any: 'all shifts' };

const dayList = (ws: number[] = []) =>
  WEEKDAY_ORDER.filter((w) => ws.includes(w)).map((w) => WEEKDAY_NAMES[w]).join(', ') || 'no days';
const kindList = (ks: string[] = []) => ks.map((k) => KIND_NAMES[k] ?? k).join(', ') || 'no shifts';

/** Weekends of the month (Saturday and Sunday both inside it) with no work on either day. */
export const freeWeekends = (month: MonthStr, workedDates: Set<DateStr>): number => {
  const dates = new Set(daysInMonth(month));
  let free = 0;
  for (const d of dates) {
    if (weekday(d) !== 6) continue;
    const sun = `${month}-${String(Number(d.slice(8)) + 1).padStart(2, '0')}`;
    if (dates.has(sun) && !workedDates.has(d) && !workedDates.has(sun)) free++;
  }
  return free;
};

/** Length of the run of consecutive worked days through `day`. */
const runThrough = (days: Set<number>, day: number): number => {
  let n = 1;
  for (let d = day - 1; days.has(d); d--) n++;
  for (let d = day + 1; days.has(d); d++) n++;
  return n;
};

export const RULE_TYPES: RuleTypeDef[] = [
  {
    id: 'min_rest_hours',
    name: 'Min rest between shifts',
    description: 'At least N hours between the end of one shift and the start of the next.',
    scopes: ['all', 'team', 'employee'],
    fields: [{ key: 'hours', label: 'Hours of rest', kind: 'number', min: 0, max: 24, default: 11 }],
    check: (p, c) => {
      for (const o of c.others) {
        const gap = restHours(c.interval, o.interval);
        if (gap >= 0 && gap < p.hours) return `only ${Math.round(gap * 10) / 10} h rest (min ${p.hours} h)`;
      }
      return null;
    },
    summary: (p) => `At least ${p.hours} h between shifts`,
  },
  {
    id: 'max_consecutive_days',
    name: 'Max consecutive working days',
    description: 'No more than N working days in a row.',
    scopes: ['all', 'team', 'employee'],
    fields: [{ key: 'days', label: 'Days in a row', kind: 'number', min: 1, max: 14, default: 5 }],
    check: (p, c) => {
      const days = new Set(c.others.map((o) => dayIndex(o.shift.date)));
      days.add(dayIndex(c.shift.date));
      const run = runThrough(days, dayIndex(c.shift.date));
      return run > p.days ? `${run} days in a row (max ${p.days})` : null;
    },
    summary: (p) => `No more than ${p.days} days in a row`,
  },
  {
    id: 'max_shifts_per_week',
    name: 'Max shifts per week',
    description: 'No more than N shifts in a Monday–Sunday week.',
    scopes: ['all', 'team', 'employee'],
    fields: [{ key: 'count', label: 'Shifts', kind: 'number', min: 0, max: 14, default: 5 }],
    check: (p, c) => {
      const wk = weekStart(c.shift.date);
      const n = 1 + c.others.filter((o) => weekStart(o.shift.date) === wk).length;
      return n > p.count ? `${n} shifts that week (max ${p.count})` : null;
    },
    summary: (p) => `No more than ${p.count} shifts a week`,
  },
  {
    id: 'min_shifts_per_week',
    name: 'Min shifts per week',
    description: 'At least N shifts in each full week of the month. Checked once the month is planned.',
    scopes: ['employee'],
    monthly: true,
    fields: [{ key: 'count', label: 'Shifts', kind: 'number', min: 0, max: 14, default: 2 }],
    summary: (p) => `At least ${p.count} shifts a week`,
  },
  {
    id: 'max_hours_per_day',
    name: 'Max hours per day',
    description: 'No more than N hours of shifts starting on the same day.',
    scopes: ['all', 'team', 'employee'],
    fields: [{ key: 'hours', label: 'Hours', kind: 'number', min: 1, max: 24, default: 10 }],
    check: (p, c) => {
      const total = c.hours + c.others.filter((o) => o.shift.date === c.shift.date).reduce((a, o) => a + o.hours, 0);
      return total > p.hours ? `${total} h that day (max ${p.hours} h)` : null;
    },
    summary: (p) => `No more than ${p.hours} h a day`,
  },
  {
    id: 'max_hours_per_shift',
    name: 'Max hours per shift',
    description: 'No single shift longer than N hours.',
    scopes: ['all', 'team', 'employee'],
    fields: [{ key: 'hours', label: 'Hours', kind: 'number', min: 1, max: 24, default: 10 }],
    check: (p, c) => (c.hours > p.hours ? `${c.hours} h shift (max ${p.hours} h)` : null),
    summary: (p) => `No shift longer than ${p.hours} h`,
  },
  {
    id: 'weekends_off',
    name: 'Full weekends off per month',
    description: 'At least N weekends (Saturday and Sunday) completely free each month.',
    scopes: ['all', 'team', 'employee'],
    fields: [{ key: 'count', label: 'Weekends', kind: 'number', min: 0, max: 5, default: 1 }],
    check: (p, c) => {
      if (!isWeekend(c.shift.date)) return null;
      const worked = new Set(c.others.map((o) => o.shift.date));
      worked.add(c.shift.date);
      const free = freeWeekends(c.month, worked);
      return free < p.count ? `only ${free} free weekend${free === 1 ? '' : 's'} left (min ${p.count})` : null;
    },
    summary: (p) => `${p.count} full weekend${p.count === 1 ? '' : 's'} off a month`,
  },
  {
    id: 'min_skill_on_shift',
    name: 'Min people (with a skill) on a shift',
    description: 'Matching shifts need at least N people, optionally with a skill such as Keyholder.',
    scopes: ['all', 'team'],
    coverage: true,
    fields: [
      { key: 'count', label: 'At least', kind: 'number', min: 1, max: 10, default: 1 },
      { key: 'skill', label: 'With skill', kind: 'skill', optional: true, default: '' },
      { key: 'kind', label: 'On', kind: 'shiftKind', default: 'close' },
      { key: 'weekdays', label: 'On these days', kind: 'weekdays', default: [0, 1, 2, 3, 4, 5, 6] },
    ],
    summary: (p) =>
      `${KIND_NAMES[p.kind] ?? p.kind} have at least ${p.count} ${p.skill || (p.count === 1 ? 'person' : 'people')}` +
      ((p.weekdays ?? []).length === 7 ? '' : ` (${dayList(p.weekdays)})`),
  },
  {
    id: 'unavailable_weekdays',
    name: 'Unavailable on weekdays',
    description: 'Never scheduled on these days.',
    scopes: ['employee'],
    fields: [{ key: 'weekdays', label: 'Days', kind: 'weekdays', default: [1] }],
    check: (p, c) => ((p.weekdays ?? []).includes(weekday(c.shift.date)) ? `isn't available on ${WEEKDAY_NAMES[weekday(c.shift.date)]}` : null),
    summary: (p) => `Unavailable on ${dayList(p.weekdays)}`,
  },
  {
    id: 'unavailable_times',
    name: 'Unavailable at times',
    description: 'Not before a start time and/or not after an end time.',
    scopes: ['employee'],
    fields: [
      { key: 'notBefore', label: 'Not before', kind: 'time', optional: true, default: '' },
      { key: 'notAfter', label: 'Not after', kind: 'time', optional: true, default: '23:00' },
    ],
    check: (p, c) => {
      const base = dayIndex(c.shift.date) * 1440;
      if (p.notBefore && c.interval.start < base + toMinutes(p.notBefore)) return `isn't available before ${p.notBefore}`;
      if (p.notAfter) {
        // Early-morning limits ("not after 01:00") mean the night after the shift's date.
        const limit = base + toMinutes(p.notAfter) + (toMinutes(p.notAfter) < 6 * 60 ? 1440 : 0);
        if (c.interval.end > limit) return `isn't available after ${p.notAfter}`;
      }
      return null;
    },
    summary: (p) => [p.notBefore && `Not before ${p.notBefore}`, p.notAfter && `not after ${p.notAfter}`].filter(Boolean).join(', ') || 'No time limits',
  },
  {
    id: 'only_shift_kinds',
    name: 'Only certain shift types',
    description: 'Only day shifts (starting before 15:00), evening shifts and/or until-close shifts.',
    scopes: ['employee'],
    fields: [{ key: 'kinds', label: 'Shift types', kind: 'shiftKinds', default: ['day'] }],
    check: (p, c) => ((p.kinds ?? []).includes(shiftKind(c.shift)) ? null : `only works ${kindList(p.kinds)}`),
    summary: (p) => `Only ${kindList(p.kinds)}`,
  },
  {
    id: 'prefers',
    name: 'Prefers days or shifts',
    description: 'Scheduled on these days / shift types where possible.',
    scopes: ['employee'],
    softOnly: true,
    fields: [
      { key: 'weekdays', label: 'Preferred days', kind: 'weekdays', default: [5, 6] },
      { key: 'kinds', label: 'Preferred shift types', kind: 'shiftKinds', default: ['day', 'evening', 'close'] },
    ],
    check: (p, c) => {
      const dayOk = !(p.weekdays ?? []).length || p.weekdays.includes(weekday(c.shift.date));
      const kindOk = !(p.kinds ?? []).length || p.kinds.includes(shiftKind(c.shift));
      return dayOk && kindOk ? null : 'not a preferred day or shift';
    },
    summary: (p) => `Prefers ${dayList(p.weekdays)}${(p.kinds ?? []).length && p.kinds.length < 3 ? ` · ${kindList(p.kinds)}` : ''}`,
  },
  {
    id: 'avoid_employee',
    name: "Don't schedule with…",
    description: 'Never on the same shift as another person.',
    scopes: ['employee'],
    fields: [{ key: 'employeeId', label: 'Person', kind: 'employee', default: '' }],
    check: (p, c) => (c.coworkers.includes(p.employeeId) ? 'is on the same shift as someone to avoid' : null),
    summary: (p, nameOf) => `Not on the same shift as ${nameOf(p.employeeId)}`,
  },
  {
    id: 'pair_with',
    name: 'Must work with…',
    description: 'Only scheduled on shifts where this other person also works (e.g. a trainee with a trainer).',
    scopes: ['employee'],
    fields: [{ key: 'employeeId', label: 'Person', kind: 'employee', default: '' }],
    check: (p, c) => (c.coworkers.includes(p.employeeId) ? null : 'needs their partner on the same shift'),
    summary: (p, nameOf) => `Always on a shift with ${nameOf(p.employeeId)}`,
  },
];

export const RULE_TYPE: Record<string, RuleTypeDef> = Object.fromEntries(RULE_TYPES.map((t) => [t.id, t]));

/** Cost of breaking a Preferred rule, by priority. */
export const PRIORITY_WEIGHT: Record<Priority, number> = { low: 10, medium: 30, high: 80 };

export const isHard = (r: Rule): boolean => r.strength === 'required' && !RULE_TYPE[r.type]?.softOnly;
export const ruleWeight = (r: Rule): number => (isHard(r) ? 0 : PRIORITY_WEIGHT[r.priority]);

// ---------------------------------------------------------------- precedence

const specificity = (r: Rule): number => (r.scope.kind === 'employee' ? 2 : r.scope.kind === 'team' ? 1 : 0);

export const appliesTo = (r: Rule, e: Employee): boolean =>
  r.scope.kind === 'all' ||
  (r.scope.kind === 'team' && r.scope.teamId === e.teamId) ||
  (r.scope.kind === 'employee' && r.scope.employeeId === e.id);

/**
 * Of several rules of one type, only the most specific level counts: the person's own rules beat
 * their team's, which beat the rules for everyone. Rules at the same level all count.
 */
const mostSpecific = (rules: Rule[]): Rule[] => {
  const best = new Map<string, number>();
  for (const r of rules) best.set(r.type, Math.max(best.get(r.type) ?? -1, specificity(r)));
  return rules.filter((r) => specificity(r) === best.get(r.type));
};

const active = (r: Rule, date: DateStr) => r.enabled && !!RULE_TYPE[r.type] && inRange(date, r.from, r.to);

/** The person rules (not coverage) that apply to one person on one date. */
export const effectiveRules = (rules: Rule[], e: Employee, date: DateStr): Rule[] =>
  mostSpecific(rules.filter((r) => active(r, date) && !RULE_TYPE[r.type].coverage && appliesTo(r, e)));

/** Coverage rules for a shift (a team's rule beats the rule for everyone). */
export const coverageRules = (rules: Rule[], s: Shift): Rule[] =>
  mostSpecific(
    rules.filter((r) => {
      if (!active(r, s.date) || !RULE_TYPE[r.type].coverage || r.scope.kind === 'employee') return false;
      if (r.scope.kind === 'team' && r.scope.teamId !== s.teamId) return false;
      const p = r.params as { kind?: string; weekdays?: number[] };
      return (p.kind === 'any' || p.kind === shiftKind(s)) && (p.weekdays ?? []).includes(weekday(s.date));
    }),
  );

export interface RuleOverride {
  /** The more specific rule that wins… */
  rule: Rule;
  /** …over this broader one of the same type. */
  overridden: Rule;
}

/** Pairs where a team or person rule replaces a broader rule of the same type (shown in the UI). */
export const ruleOverrides = (rules: Rule[], employees: Employee[]): RuleOverride[] => {
  const out: RuleOverride[] = [];
  for (const r of rules) {
    if (!r.enabled || r.scope.kind === 'all') continue;
    for (const o of rules) {
      if (o === r || !o.enabled || o.type !== r.type || specificity(o) >= specificity(r)) continue;
      if (r.scope.kind === 'team') {
        if (o.scope.kind === 'all') out.push({ rule: r, overridden: o });
      } else {
        const id = r.scope.employeeId;
        const e = employees.find((x) => x.id === id);
        if (e && appliesTo(o, e)) out.push({ rule: r, overridden: o });
      }
    }
  }
  return out;
};

export const describeRule = (r: Rule, nameOf: (id: ID) => string): string =>
  RULE_TYPE[r.type]?.summary(r.params, nameOf) ?? r.type;

export const scopeLabel = (r: Rule, teamName: (id: ID) => string, nameOf: (id: ID) => string): string =>
  r.scope.kind === 'all' ? 'Everyone' : r.scope.kind === 'team' ? teamName(r.scope.teamId) : nameOf(r.scope.employeeId);

export const defaultParams = (type: string): Record<string, unknown> =>
  Object.fromEntries((RULE_TYPE[type]?.fields ?? []).map((f) => [f.key, structuredClone(f.default)]));

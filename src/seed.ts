// Demo data: the bar's staff and the shift pattern from the weekly sheet. Contract hours and
// vacation allowances are placeholders to be edited on each profile.

import {
  addMonths, daysInMonth, generate, weekday,
  type Employee, type Rule, type Schedule, type Settings, type Shift, type ShiftSpec, type ShiftTemplate,
  type Team, type TimeOffRequest,
} from './scheduler';
import type { AppState } from './store';

const TEAMS: Team[] = [
  { id: 'bar', name: 'Bar', roles: ['Bartender', 'Closing'] },
  { id: 'runners', name: 'Runners', roles: ['Runner'] },
];

// Mon closed · Tue/Wed/Sun until 23:00 · Thu–Sat until 01:00
const SETTINGS: Settings = { closing: ['23:00', null, '23:00', '23:00', '01:00', '01:00', '01:00'] };

const staff = (
  id: string, name: string, teamId: string, hours: number, per: 'week' | 'month',
  roles: string[], skills: string[] = [], vacationAllowance = 24,
): Employee => ({ id, name, teamId, roles, skills, contract: { hours, per }, vacationAllowance, email: `${id}@example.com`, phone: '' });

const EMPLOYEES: Employee[] = [
  staff('gianpaolo', 'Gianpaolo', 'bar', 35, 'week', ['Bartender', 'Closing'], ['Keyholder', 'Trainer'], 28),
  staff('ryan', 'Ryan', 'bar', 30, 'week', ['Bartender', 'Closing'], ['Keyholder'], 28),
  staff('jacques', 'Jacques', 'bar', 30, 'week', ['Bartender', 'Closing'], ['Keyholder'], 28),
  staff('federico', 'Federico', 'bar', 30, 'week', ['Bartender']),
  staff('romina', 'Romina', 'bar', 25, 'week', ['Bartender']),
  staff('alamea', 'Alamea', 'bar', 25, 'week', ['Bartender']),
  staff('ecci', 'Ecci', 'bar', 15, 'week', ['Bartender']),
  staff('patrick', 'Patrick', 'bar', 12, 'week', ['Bartender']),
  staff('savva', 'Savva', 'bar', 40, 'month', ['Bartender'], [], 20),
  staff('amanda', 'Amanda', 'runners', 35, 'week', ['Runner'], [], 28),
  staff('baran', 'Baran', 'runners', 35, 'week', ['Runner'], [], 28),
  staff('felipe', 'Felipe', 'runners', 35, 'week', ['Runner'], [], 28),
  staff('nikita', 'Nikita', 'runners', 30, 'week', ['Runner']),
  staff('roman', 'Roman', 'runners', 15, 'week', ['Runner'], [], 20),
];

const sh = (start: string, end: string, staffNeeded = 1, extra: Partial<ShiftSpec> = {}): ShiftSpec => ({ start, end, staffNeeded, ...extra });
const CLOSING = { role: 'Closing', label: 'Until close' };
const DAY_RUNNER = { label: 'Day runner' };
const GLASS = { label: 'Glass shift' };

/** The weekly sheet: shifts per team per JS weekday (Monday closed). */
const PATTERN: Record<string, Partial<Record<number, ShiftSpec[]>>> = {
  bar: {
    2: [sh('11:00', '18:00'), sh('17:00', '22:00'), sh('18:00', '23:00', 2)],
    3: [sh('11:00', '18:00'), sh('17:00', '22:00'), sh('18:00', '23:00', 2)],
    4: [sh('11:00', '18:00'), sh('17:00', '23:00', 2), sh('18:00', '23:00', 2)],
    5: [sh('11:00', '18:00'), sh('17:00', '23:00', 2), sh('18:00', '00:00'), sh('18:00', 'close', 2, CLOSING)],
    6: [sh('10:30', '16:00'), sh('12:00', '18:00'), sh('15:00', '22:00'), sh('17:00', '23:00'), sh('18:00', 'close', 2, CLOSING)],
    0: [sh('11:00', '17:00'), sh('12:00', '18:00'), sh('17:00', '22:00'), sh('18:00', '23:00', 2)],
  },
  runners: {
    2: [sh('10:30', '18:30', 1, DAY_RUNNER), sh('17:00', '23:00'), sh('18:00', '00:00')],
    3: [sh('10:30', '18:30', 1, DAY_RUNNER), sh('17:00', '23:00'), sh('18:00', '00:00')],
    4: [sh('10:30', '18:30', 1, DAY_RUNNER), sh('17:00', '23:00', 2), sh('18:00', '00:00')],
    5: [sh('10:30', '18:30', 1, DAY_RUNNER), sh('17:00', '23:00'), sh('18:00', '23:00', 1, GLASS), sh('18:00', '00:00'), sh('18:30', '01:00')],
    6: [sh('10:30', '18:30', 1, DAY_RUNNER), sh('14:00', '22:00'), sh('18:00', '23:00', 1, GLASS), sh('18:00', '00:00'), sh('18:30', '01:00')],
    0: [sh('10:30', '18:30', 1, DAY_RUNNER), sh('14:00', '20:00'), sh('17:00', '23:00'), sh('18:00', '00:00')],
  },
};

const TEMPLATE_DAYS: [number, string][] = [[2, 'Tue/Wed'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];

const TEMPLATES: ShiftTemplate[] = TEAMS.flatMap((t) =>
  TEMPLATE_DAYS.map(([w, name]) => ({ id: `tpl-${t.id}-${w}`, teamId: t.id, name: `${t.name} · ${name}`, shifts: PATTERN[t.id][w] ?? [] })));

const shiftsFor = (month: string, skipDates: string[] = []): Shift[] =>
  daysInMonth(month).flatMap((date) =>
    skipDates.includes(date) ? [] : TEAMS.flatMap((t) =>
      (PATTERN[t.id][weekday(date)] ?? []).map((spec, i) => ({ ...spec, id: `sh-${t.id}-${date}-${i}`, teamId: t.id, date }))));

const rule = (id: string, type: string, scope: Rule['scope'], params: Record<string, unknown>, o: Partial<Rule> = {}): Rule =>
  ({ id, type, scope, params, strength: 'required', priority: 'medium', enabled: true, ...o });

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const RULES: Rule[] = [
  rule('rule-rest', 'min_rest_hours', { kind: 'all' }, { hours: 11 }),
  rule('rule-consecutive', 'max_consecutive_days', { kind: 'all' }, { days: 5 }),
  rule('rule-shift-length', 'max_hours_per_shift', { kind: 'all' }, { hours: 10 }),
  rule('rule-keyholder', 'min_skill_on_shift', { kind: 'team', teamId: 'bar' }, { count: 1, skill: 'Keyholder', kind: 'close', weekdays: ALL_DAYS }),
  rule('rule-weekend', 'weekends_off', { kind: 'all' }, { count: 1 }, { strength: 'preferred', priority: 'high' }),
  rule('rule-week', 'max_shifts_per_week', { kind: 'all' }, { count: 5 }, { strength: 'preferred' }),
  rule('rule-gianpaolo-dec', 'max_consecutive_days', { kind: 'employee', employeeId: 'gianpaolo' }, { days: 6 }, { from: '2026-12-01', to: '2026-12-31' }),
  rule('rule-savva', 'unavailable_weekdays', { kind: 'employee', employeeId: 'savva' }, { weekdays: [2, 3, 4, 5] }),
  rule('rule-patrick', 'prefers', { kind: 'employee', employeeId: 'patrick' }, { weekdays: [5, 6, 0], kinds: [] }, { strength: 'preferred' }),
  rule('rule-baran', 'only_shift_kinds', { kind: 'employee', employeeId: 'baran' }, { kinds: ['day'] }, { strength: 'preferred', priority: 'high' }),
  rule('rule-roman', 'unavailable_weekdays', { kind: 'employee', employeeId: 'roman' }, { weekdays: [2, 3, 4] }),
];

const request = (
  id: string, employeeId: string, type: TimeOffRequest['type'], from: string, to: string,
  status: TimeOffRequest['status'], note?: string, managerComment?: string,
): TimeOffRequest => ({
  id, employeeId, type, from, to, status, note, managerComment, createdAt: '2026-11-10T10:00:00Z',
  ...(status === 'pending' ? {} : { decidedAt: '2026-11-12T10:00:00Z' }),
});

const REQUESTS: TimeOffRequest[] = [
  request('q1', 'romina', 'vacation', '2026-12-11', '2026-12-13', 'approved', 'Family visit'),
  request('q2', 'ryan', 'day_off', '2026-12-12', '2026-12-12', 'approved'),
  request('q3', 'gianpaolo', 'day_off', '2026-12-12', '2026-12-12', 'rejected', undefined, 'Ryan is already off — we need you on closing.'),
  request('q4', 'alamea', 'vacation', '2026-12-17', '2026-12-20', 'approved'),
  request('q5', 'savva', 'day_off', '2026-12-20', '2026-12-20', 'approved'),
  request('q6', 'baran', 'vacation', '2026-12-24', '2026-12-27', 'approved'),
  request('q7', 'felipe', 'vacation', '2026-12-25', '2026-12-27', 'approved'),
  request('q8', 'amanda', 'vacation', '2026-12-22', '2026-12-26', 'pending', 'Flying to see family — flights already booked.'),
  request('q9', 'nikita', 'day_off', '2026-12-19', '2026-12-19', 'pending', "My sister's wedding."),
  request('q10', 'federico', 'day_off', '2026-12-31', '2026-12-31', 'pending'),
  request('q11', 'gianpaolo', 'vacation', '2027-01-04', '2027-01-08', 'pending', 'Skiing with friends.'),
];

/**
 * A fresh demo: this month planned and published (so the employee view has shifts), next month
 * set up but not planned yet, with its last two Tue/Wed left empty to show "no shifts".
 */
export function seed(today = new Date().toISOString().slice(0, 10)): AppState {
  const thisMonth = today.slice(0, 7);
  const next = addMonths(thisMonth, 1);
  const emptyDays = daysInMonth(next).filter((d) => [2, 3].includes(weekday(d))).slice(-2);
  const shifts = [...shiftsFor(thisMonth), ...shiftsFor(next, emptyDays)];
  const base = { employees: EMPLOYEES, shifts, requests: REQUESTS, rules: RULES, settings: SETTINGS };
  const schedules: Schedule[] = TEAMS.map((t) => ({
    teamId: t.id, month: thisMonth, status: 'published',
    assignments: generate({ ...base, teamId: t.id, month: thisMonth }).assignments,
    generatedAt: today, publishedAt: today,
  }));
  return {
    version: 1,
    teams: structuredClone(TEAMS), settings: structuredClone(SETTINGS), employees: structuredClone(EMPLOYEES),
    shifts, templates: structuredClone(TEMPLATES), requests: structuredClone(REQUESTS), rules: structuredClone(RULES),
    schedules,
    notifications: [
      { id: 'n1', employeeId: 'gianpaolo', text: 'Your day off on Sat 12 Dec was rejected: “Ryan is already off — we need you on closing.”', createdAt: '2026-11-12T10:00:00Z', read: false },
      { id: 'n2', employeeId: 'ryan', text: 'Your day off on Sat 12 Dec was approved.', createdAt: '2026-11-12T10:00:00Z', read: false },
    ],
  };
}

// The scheduling engine. Plans one team for one month (see README "How the scheduling
// algorithm works"), re-checks hand-edited schedules, and works out the numbers the UI shows.
// Pure functions over plain data: the same input always gives the same output.

import type {
  Assignment, DateStr, Employee, EmployeeStats, ID, Issue, MonthStr, Rule, ScheduleInput,
  ScheduleResult, Settings, Shift, TimeOffRequest, Unfilled, Violation,
} from './types';
import {
  addDays, daysInMonth, isLate, isOpen, isWeekend, monthOf, overlaps, shiftHours, shiftInterval,
  weekStart, weekday, formatTimes, type Interval,
} from './time';
import { RULE_TYPE, coverageRules, effectiveRules, isHard, ruleWeight, type Placed } from './rules';

// ---------------------------------------------------------------- time off, targets, balances

export const approvedTimeOff = (requests: TimeOffRequest[], employeeId: ID, date: DateStr): TimeOffRequest | undefined =>
  requests.find((r) => r.employeeId === employeeId && r.status === 'approved' && r.from <= date && date <= r.to);

/** Open days (the bar isn't closed) a request covers, optionally only those in one year. */
export const requestDays = (r: Pick<TimeOffRequest, 'from' | 'to'>, settings: Settings, year?: string): number => {
  let n = 0;
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) if (isOpen(d, settings) && (!year || d.startsWith(year))) n++;
  return n;
};

export interface VacationBalance {
  allowance: number;
  used: number;
  pending: number;
  remaining: number;
}

export const vacationBalance = (e: Employee, year: string, requests: TimeOffRequest[], settings: Settings): VacationBalance => {
  const mine = requests.filter((r) => r.employeeId === e.id && r.type === 'vacation');
  const sum = (status: TimeOffRequest['status']) =>
    mine.filter((r) => r.status === status).reduce((a, r) => a + requestDays(r, settings, year), 0);
  const used = sum('approved');
  return { allowance: e.vacationAllowance, used, pending: sum('pending'), remaining: e.vacationAllowance - used };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Weekly hours, for monthly contracts averaged over the year. */
export const weeklyHours = (e: Employee): number => (e.contract.per === 'week' ? e.contract.hours : (e.contract.hours * 12) / 52);

/**
 * Hours to aim for in a month: the contract converted to the month (weekly hours × days ÷ 7, or
 * the monthly figure) minus approved vacation, each open vacation day worth weekly hours ÷ 5.
 */
export const targetHours = (e: Employee, month: MonthStr, requests: TimeOffRequest[], settings: Settings): number => {
  const days = daysInMonth(month);
  const base = e.contract.per === 'month' ? e.contract.hours : (e.contract.hours * days.length) / 7;
  const vacationDays = days.filter((d) => isOpen(d, settings) && approvedTimeOff(requests, e.id, d)?.type === 'vacation').length;
  return Math.max(0, round1(base - vacationDays * (weeklyHours(e) / 5)));
};

// ---------------------------------------------------------------- the plan being built

const slotKey = (shiftId: ID, slot: number) => `${shiftId}#${slot}`;
const shiftName = (s: Shift) => `${s.label ? s.label + ' ' : ''}${formatTimes(s)}`;

/** @internal The month being planned (shared with the optimiser in solver.ts). */
export class Plan {
  readonly shifts: Shift[];
  readonly team: Employee[];
  readonly people = new Map<ID, Employee>();
  private readonly shiftById = new Map<ID, Shift>();
  private readonly times = new Map<ID, Interval>();
  private readonly lengths = new Map<ID, number>();
  /** Who is in each slot of each shift. */
  readonly slots = new Map<ID, (ID | null)[]>();
  /** The shifts each person works. */
  private readonly worked = new Map<ID, Set<ID>>();
  readonly fixed = new Set<string>();

  constructor(readonly input: ScheduleInput) {
    const { teamId, month, settings } = input;
    this.shifts = input.shifts
      .filter((s) => s.teamId === teamId && monthOf(s.date) === month)
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    for (const s of this.shifts) {
      this.shiftById.set(s.id, s);
      this.times.set(s.id, shiftInterval(s, settings));
      this.lengths.set(s.id, shiftHours(s, settings));
      this.slots.set(s.id, Array.from({ length: Math.max(0, s.staffNeeded) }, () => null));
    }
    for (const e of input.employees) this.people.set(e.id, e);
    this.team = input.employees.filter((e) => e.teamId === teamId);
  }

  shift(id: ID) { return this.shiftById.get(id); }
  interval(id: ID) { return this.times.get(id)!; }
  hours(id: ID) { return this.lengths.get(id)!; }

  put(shiftId: ID, slot: number, employeeId: ID | null) {
    const arr = this.slots.get(shiftId);
    if (!arr || slot < 0 || slot >= arr.length) return;
    const before = arr[slot];
    if (before) this.worked.get(before)?.delete(shiftId);
    arr[slot] = employeeId;
    if (employeeId) {
      if (!this.worked.has(employeeId)) this.worked.set(employeeId, new Set());
      this.worked.get(employeeId)!.add(shiftId);
    }
  }

  load(assignments: Assignment[], asFixed: boolean) {
    for (const a of assignments) {
      if (!this.shiftById.has(a.shiftId)) continue;
      this.put(a.shiftId, a.slot, a.employeeId);
      if (asFixed && a.employeeId) this.fixed.add(slotKey(a.shiftId, a.slot));
    }
  }

  isFixed(shiftId: ID, slot: number) { return this.fixed.has(slotKey(shiftId, slot)); }

  /** A person's shifts this month, except `skip`. */
  placed(employeeId: ID, skip?: ID): Placed[] {
    return [...(this.worked.get(employeeId) ?? [])]
      .filter((id) => id !== skip)
      .map((id) => ({ shift: this.shiftById.get(id)!, interval: this.times.get(id)!, hours: this.lengths.get(id)! }));
  }

  onShift(shiftId: ID, except?: ID): ID[] {
    return (this.slots.get(shiftId) ?? []).filter((id): id is ID => !!id && id !== except);
  }

  openSlots(shiftId: ID): number {
    return (this.slots.get(shiftId) ?? []).filter((id) => !id).length;
  }

  hoursOf(employeeId: ID): number {
    return this.placed(employeeId).reduce((a, p) => a + p.hours, 0);
  }

  assignments(): Assignment[] {
    return this.shifts.flatMap((s) =>
      this.slots.get(s.id)!.map((employeeId, slot) => ({
        shiftId: s.id, slot, employeeId, ...(this.isFixed(s.id, slot) ? { manual: true } : {}),
      })));
  }
}

// ---------------------------------------------------------------- checks

/**
 * Everything wrong with `e` working `s`, given the rest of the plan: built-in rules, every rule
 * that applies to them, and "don't schedule with" rules of the people already on the shift.
 */
export function violations(plan: Plan, e: Employee, s: Shift, opts: { ignorePartner?: boolean } = {}): Violation[] {
  const { requests, rules, settings, month } = plan.input;
  const out: Violation[] = [];
  const builtIn = (code: string, message: string) => out.push({ code, message, hard: true, weight: 0 });

  if (e.teamId !== s.teamId) builtIn('team', 'is in another team');
  if (s.role && !e.roles.includes(s.role)) builtIn('role', `can't work as ${s.role}`);
  const off = approvedTimeOff(requests, e.id, s.date);
  if (off) builtIn('time_off', off.type === 'vacation' ? 'is on approved vacation' : 'has an approved day off');

  const interval = plan.interval(s.id);
  const others = plan.placed(e.id, s.id);
  if (others.some((o) => overlaps(o.interval, interval))) builtIn('overlap', 'already has an overlapping shift');

  const coworkers = plan.onShift(s.id, e.id);
  const ctx = { employee: e, shift: s, interval, hours: plan.hours(s.id), others, coworkers, settings, month };
  for (const r of effectiveRules(rules, e, s.date)) {
    const check = RULE_TYPE[r.type].check;
    if (!check || (opts.ignorePartner && r.type === 'pair_with')) continue;
    const msg = check(r.params, ctx);
    if (msg) out.push({ code: r.type, message: msg, hard: isHard(r), ruleId: r.id, weight: ruleWeight(r) });
  }
  // "Don't schedule with" counts both ways.
  for (const id of coworkers) {
    const other = plan.people.get(id);
    if (!other) continue;
    for (const r of effectiveRules(rules, other, s.date))
      if (r.type === 'avoid_employee' && (r.params as { employeeId?: ID }).employeeId === e.id)
        out.push({ code: r.type, message: `is on a shift with ${other.name}, who shouldn't work with them`, hard: isHard(r), ruleId: r.id, weight: ruleWeight(r) });
  }
  return out;
}

export const hard = (v: Violation[]) => v.filter((x) => x.hard);
const softCost = (v: Violation[]) => v.reduce((a, x) => a + (x.hard ? 0 : x.weight), 0);

interface Need { rule: Rule; skill: string; count: number }

const needsOf = (plan: Plan, s: Shift): Need[] =>
  coverageRules(plan.input.rules, s).map((rule) => {
    const p = rule.params as { skill?: string; count?: number };
    return { rule, skill: p.skill ?? '', count: Number(p.count ?? 0) };
  });

const hasSkill = (plan: Plan, id: ID, skill: string) => !skill || !!plan.people.get(id)?.skills.includes(skill);

/**
 * Required coverage: if the shift still needs N people with a skill and only N slots are left,
 * someone without the skill can't take one of them.
 */
function blockedByCoverage(plan: Plan, s: Shift, e: Employee): Need | null {
  const open = plan.openSlots(s.id);
  for (const n of needsOf(plan, s)) {
    if (!isHard(n.rule) || !n.skill || e.skills.includes(n.skill)) continue;
    const have = plan.onShift(s.id).filter((id) => hasSkill(plan, id, n.skill)).length;
    if (n.count - have >= open) return n;
  }
  return null;
}

/** The Required "must work with" partner for a person on a date, if any. */
const partnerOf = (plan: Plan, e: Employee, date: DateStr): ID | null => {
  const r = effectiveRules(plan.input.rules, e, date).find((x) => x.type === 'pair_with' && isHard(x));
  return r ? String((r.params as { employeeId?: ID }).employeeId ?? '') || null : null;
};

/** Does anyone on the shift need `id` there (a Required "must work with" pointing at them)? */
const neededAsPartner = (plan: Plan, s: Shift, id: ID) =>
  plan.onShift(s.id, id).some((other) => {
    const e = plan.people.get(other);
    return !!e && partnerOf(plan, e, s.date) === id;
  });

// ---------------------------------------------------------------- scoring

/**
 * How far someone is from their target, relative to the size of their contract: the same 10 h
 * gap counts more on a small contract, so shortfalls are shared in proportion.
 */
const distance = (hours: number, target: number) => ((hours - target) ** 2 / Math.max(target, 8)) * 10;

const tieBreak = (a: string, b: string) => {
  let h = 7;
  for (const ch of `${a}|${b}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 1000) / 100_000;
};

interface Scorer {
  plan: Plan;
  targets: Map<ID, number>;
}

const countWhere = (plan: Plan, id: ID, pick: (s: Shift) => boolean) => plan.placed(id).filter((p) => pick(p.shift)).length;

const teamAverage = (plan: Plan, pick: (s: Shift) => boolean) =>
  plan.team.length ? plan.team.reduce((a, e) => a + countWhere(plan, e.id, pick), 0) / plan.team.length : 0;

function score(c: Scorer, e: Employee, s: Shift, soft: Violation[]): number {
  const { plan } = c;
  const { settings, rules } = plan.input;
  const now = plan.hoursOf(e.id);
  const target = c.targets.get(e.id) ?? 0;
  let points = distance(now, target) - distance(now + plan.hours(s.id), target);

  // Fair share of weekend and late shifts.
  const weekend = (x: Shift) => isWeekend(x.date);
  const late = (x: Shift) => isLate(x, settings);
  if (weekend(s)) points -= 6 * (countWhere(plan, e.id, weekend) - teamAverage(plan, weekend));
  if (late(s)) points -= 6 * (countWhere(plan, e.id, late) - teamAverage(plan, late));

  points -= softCost(soft);

  // Bonus: a skill the shift still needs.
  for (const n of needsOf(plan, s)) {
    if (!n.skill || !e.skills.includes(n.skill)) continue;
    const have = plan.onShift(s.id).filter((id) => hasSkill(plan, id, n.skill)).length;
    if (have < n.count) points += isHard(n.rule) ? 60 : ruleWeight(n.rule);
  }
  const mine = effectiveRules(rules, e, s.date);
  // Bonus: keep weekends whole. If a weekends-off rule applies and they already work the other
  // day of this weekend, this shift doesn't cost them another free weekend.
  if (isWeekend(s.date) && mine.some((r) => r.type === 'weekends_off')) {
    const otherDay = addDays(s.date, weekday(s.date) === 6 ? 1 : -1);
    if (plan.placed(e.id).some((p) => p.shift.date === otherDay || p.shift.date === s.date)) points += 40;
  }
  // Bonus: still below their minimum shifts that week.
  const week = weekStart(s.date);
  for (const r of mine) {
    if (r.type !== 'min_shifts_per_week') continue;
    const n = plan.placed(e.id).filter((p) => weekStart(p.shift.date) === week).length;
    if (n < Number((r.params as { count?: number }).count ?? 0)) points += 50;
  }
  return points + tieBreak(e.id, s.id);
}

interface Candidate { e: Employee; partner?: Employee; points: number }

/** Everyone who can take an open slot on `s` right now, best first. */
function candidates(c: Scorer, s: Shift): Candidate[] {
  const { plan } = c;
  const on = new Set(plan.onShift(s.id));
  const out: Candidate[] = [];
  for (const e of plan.team) {
    if (on.has(e.id)) continue;
    const v = violations(plan, e, s, { ignorePartner: true });
    if (hard(v).length || blockedByCoverage(plan, s, e)) continue;
    let partner: Employee | undefined;
    const pid = partnerOf(plan, e, s.date);
    if (pid && !on.has(pid)) {
      // Placed only together with their partner, who must be able to take a second slot.
      const p = plan.people.get(pid);
      if (!p || on.has(p.id) || plan.openSlots(s.id) < 2 || hard(violations(plan, p, s, { ignorePartner: true })).length) continue;
      partner = p;
    }
    out.push({ e, partner, points: score(c, e, s, v) });
  }
  return out.sort((a, b) => b.points - a.points || a.e.id.localeCompare(b.e.id));
}

function fillShift(c: Scorer, s: Shift) {
  const arr = c.plan.slots.get(s.id)!;
  for (let slot = 0; slot < arr.length; slot++) {
    if (arr[slot]) continue;
    const best = candidates(c, s)[0];
    if (!best) return;
    c.plan.put(s.id, slot, best.e.id);
    if (best.partner) {
      const free = arr.findIndex((x) => !x);
      if (free >= 0) c.plan.put(s.id, free, best.partner.id);
    }
  }
}

/**
 * One improvement pass: for every assignment, try handing the shift to someone else when that
 * brings both closer to their targets or breaks fewer Preferred rules, without breaking a hard
 * rule. Returns whether anything moved.
 */
function improve(c: Scorer, order: Shift[]): boolean {
  const { plan, targets } = c;
  const dist = (id: ID, extra = 0) => distance(plan.hoursOf(id) + extra, targets.get(id) ?? 0);
  let moved = false;
  for (const s of order) {
    const arr = plan.slots.get(s.id)!;
    for (let slot = 0; slot < arr.length; slot++) {
      const a = arr[slot];
      if (!a || plan.isFixed(s.id, slot) || neededAsPartner(plan, s, a)) continue;
      const ea = plan.people.get(a)!;
      const h = plan.hours(s.id);
      const costA = softCost(violations(plan, ea, s));
      const beforeA = dist(a);
      plan.put(s.id, slot, null);
      const gainA = beforeA - dist(a);
      let best: { id: ID; gain: number } | null = null;
      for (const eb of plan.team) {
        if (eb.id === a || plan.onShift(s.id).includes(eb.id)) continue;
        const v = violations(plan, eb, s);
        if (hard(v).length || blockedByCoverage(plan, s, eb)) continue;
        const gain = gainA + (dist(eb.id) - dist(eb.id, h)) + (costA - softCost(v));
        if (gain > 2 && (!best || gain > best.gain)) best = { id: eb.id, gain };
      }
      plan.put(s.id, slot, best ? best.id : a);
      if (best) moved = true;
    }
  }
  return moved;
}

/** Plans one team's month. Manual assignments in `input.fixed` are kept as they are. */
export function generate(input: ScheduleInput): ScheduleResult {
  const plan = new Plan(input);
  plan.load(input.fixed ?? [], true);
  const targets = new Map(plan.team.map((e) => [e.id, targetHours(e, input.month, input.requests, input.settings)]));
  const c: Scorer = { plan, targets };

  // Hardest shifts first: the fewest people who could ever work them, per slot needed.
  const empty = new Plan({ ...input, fixed: [] });
  const possible = (s: Shift) => empty.team.filter((e) => !hard(violations(empty, e, s, { ignorePartner: true })).length).length;
  const slack = new Map(plan.shifts.map((s) => [s.id, possible(s) - s.staffNeeded]));
  const order = [...plan.shifts].sort((a, b) => slack.get(a.id)! - slack.get(b.id)!);

  order.forEach((s) => fillShift(c, s));
  for (let pass = 0; pass < 4; pass++) {
    const moved = improve(c, order);
    order.forEach((s) => fillShift(c, s)); // moves can free people up for empty slots
    if (!moved) break;
  }
  return summarise(plan, targets);
}

// ---------------------------------------------------------------- results

function whyEmpty(plan: Plan, s: Shift): string[] {
  if (!plan.team.length) return ['Nobody is in this team'];
  if (s.role && !plan.team.some((e) => e.roles.includes(s.role!))) return [`Nobody in the team can work as ${s.role}`];
  const on = new Set(plan.onShift(s.id));
  const reasons: string[] = [];
  for (const e of plan.team) {
    if (on.has(e.id)) continue;
    const h = hard(violations(plan, e, s, { ignorePartner: true }));
    if (h.length) reasons.push(`${e.name} ${h[0].message}`);
    else if (blockedByCoverage(plan, s, e)) reasons.push(`${e.name} doesn't have the skill the last slot needs`);
    else if (partnerOf(plan, e, s.date)) reasons.push(`${e.name} can't be placed together with their partner`);
  }
  return reasons.length ? reasons : ['Nobody left who can take it'];
}

/** Rules that can only be judged on the whole month: coverage and minimum shifts per week. */
function shortfalls(plan: Plan): Issue[] {
  const out: Issue[] = [];
  for (const s of plan.shifts) {
    for (const n of needsOf(plan, s)) {
      const have = plan.onShift(s.id).filter((id) => hasSkill(plan, id, n.skill)).length;
      if (have < n.count)
        out.push({
          hard: isHard(n.rule), date: s.date, shiftId: s.id, ruleId: n.rule.id,
          message: `${shiftName(s)}: ${have} of ${n.count} ${n.skill || 'people'} needed`,
        });
    }
  }
  const days = daysInMonth(plan.input.month);
  const mondays = days.filter((d) => weekday(d) === 1 && days.includes(addDays(d, 6)));
  for (const e of plan.team) {
    for (const mon of mondays) {
      const r = effectiveRules(plan.input.rules, e, mon).find((x) => x.type === 'min_shifts_per_week');
      if (!r) continue;
      const min = Number((r.params as { count?: number }).count ?? 0);
      const n = plan.placed(e.id).filter((p) => weekStart(p.shift.date) === mon).length;
      if (n < min) out.push({ hard: isHard(r), employeeId: e.id, ruleId: r.id, date: mon, message: `${e.name}: ${n} shift${n === 1 ? '' : 's'} that week (min ${min})` });
    }
  }
  return out;
}

export function summarise(plan: Plan, targets?: Map<ID, number>): ScheduleResult {
  const { month, requests, settings } = plan.input;
  const unfilled: Unfilled[] = [];
  for (const s of plan.shifts)
    plan.slots.get(s.id)!.forEach((id, slot) => {
      if (!id) unfilled.push({ shiftId: s.id, slot, date: s.date, reasons: whyEmpty(plan, s) });
    });
  const stats: EmployeeStats[] = plan.team.map((e) => {
    const p = plan.placed(e.id);
    return {
      employeeId: e.id,
      hours: round1(p.reduce((a, x) => a + x.hours, 0)),
      target: targets?.get(e.id) ?? targetHours(e, month, requests, settings),
      shifts: p.length,
      weekendShifts: p.filter((x) => isWeekend(x.shift.date)).length,
      lateShifts: p.filter((x) => isLate(x.shift, settings)).length,
    };
  });
  return { assignments: plan.assignments(), unfilled, stats, issues: shortfalls(plan) };
}

// ---------------------------------------------------------------- validation

export interface AssignmentWarning {
  shiftId: ID;
  slot: number;
  employeeId: ID;
  violations: Violation[];
}

export interface ValidationResult extends Omit<ScheduleResult, 'assignments'> {
  warnings: AssignmentWarning[];
}

/** Re-checks a schedule as it stands (e.g. after manual changes). Lists problems; blocks nothing. */
export function validate(input: ScheduleInput, assignments: Assignment[]): ValidationResult {
  const plan = new Plan(input);
  plan.load(assignments, false);
  const warnings: AssignmentWarning[] = [];
  for (const s of plan.shifts)
    plan.slots.get(s.id)!.forEach((id, slot) => {
      const e = id ? plan.people.get(id) : undefined;
      if (!e) return;
      const v = violations(plan, e, s);
      if (v.length) warnings.push({ shiftId: s.id, slot, employeeId: e.id, violations: v });
    });
  const { unfilled, stats, issues } = summarise(plan);
  return { warnings, unfilled, stats, issues };
}

/** What would be wrong with putting one person in one slot (for the reassign menu). */
export function checkCandidate(input: ScheduleInput, assignments: Assignment[], shiftId: ID, slot: number, employeeId: ID): Violation[] {
  const plan = new Plan(input);
  plan.load(assignments.filter((a) => !(a.shiftId === shiftId && a.slot === slot)), false);
  const s = plan.shift(shiftId);
  const e = plan.people.get(employeeId);
  if (!s || !e) return [];
  if (plan.onShift(shiftId).includes(employeeId)) return [{ code: 'duplicate', message: 'is already on this shift', hard: true, weight: 0 }];
  plan.put(shiftId, slot, employeeId);
  return violations(plan, e, s);
}

// ---------------------------------------------------------------- rule changes

export interface FeasibilityReport {
  /** Slots that are only empty with the change. */
  newUnfilled: { teamId: ID; shiftId: ID; date: DateStr }[];
  /** Required shortfalls that only appear with the change. */
  newIssues: Issue[];
}

/** Generates each month with the old and new rules and reports what the change makes impossible. */
export function feasibilityDelta(inputs: ScheduleInput[], before: Rule[], after: Rule[]): FeasibilityReport {
  const report: FeasibilityReport = { newUnfilled: [], newIssues: [] };
  for (const input of inputs) {
    const a = generate({ ...input, rules: before, fixed: [] });
    const b = generate({ ...input, rules: after, fixed: [] });
    const emptyPerDay = new Map<DateStr, number>();
    for (const u of a.unfilled) emptyPerDay.set(u.date, (emptyPerDay.get(u.date) ?? 0) + 1);
    for (const u of b.unfilled) {
      const left = emptyPerDay.get(u.date) ?? 0;
      if (left > 0) emptyPerDay.set(u.date, left - 1);
      else report.newUnfilled.push({ teamId: input.teamId, shiftId: u.shiftId, date: u.date });
    }
    const known = new Set(a.issues.filter((i) => i.hard).map((i) => i.message));
    report.newIssues.push(...b.issues.filter((i) => i.hard && !known.has(i.message)));
  }
  return report;
}

// ---------------------------------------------------------------- calendar

export type DayStatus = 'closed' | 'none' | 'set' | 'full' | 'under';

/**
 * Colour of a calendar day: closed, no shifts yet, shifts set (not planned), fully staffed,
 * or understaffed.
 */
export function dayStatus(date: DateStr, shiftsThatDay: Shift[], assignments: Assignment[] | undefined, settings: Settings): DayStatus {
  if (!shiftsThatDay.length) return isOpen(date, settings) ? 'none' : 'closed';
  if (!assignments) return 'set';
  const ids = new Set(shiftsThatDay.map((s) => s.id));
  const filled = assignments.filter((a) => ids.has(a.shiftId) && a.employeeId).length;
  const needed = shiftsThatDay.reduce((n, s) => n + s.staffNeeded, 0);
  return filled >= needed ? 'full' : 'under';
}

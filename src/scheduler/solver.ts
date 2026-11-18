// The optimiser: the whole month as one mixed-integer program, solved with HiGHS (compiled to
// WebAssembly, so it runs in the browser). Required rules become constraints; Preferred rules,
// hours targets and fair share go into one weighted objective. It starts from the greedy plan,
// so by the model's measure it's never worse, and every result is re-checked with the same
// rule check the greedy engine uses before it's returned.
//
// It's slower than `generate()` (seconds rather than milliseconds), so the app runs it in a Web
// Worker behind the "Optimise" button. The search stops after a fixed number of branch-and-bound
// nodes, not after a time, so the same input gives the same plan on any machine.

import type { Highs } from 'highs';
import type { DateStr, Employee, ID, Rule, ScheduleInput, ScheduleResult, Shift } from './types';
import { addDays, daysInMonth, isLate, isWeekend, overlaps, restHours, weekStart, weekday } from './time';
import { PRIORITY_WEIGHT, coverageRules, effectiveRules, isHard } from './rules';
import { Plan, generate, hard, summarise, targetHours, violations } from './engine';

// ---------------------------------------------------------------- weights

/** Cost of one empty slot. Dominates everything else, so a slot is only empty if it must be. */
const UNFILLED = 10_000;
/** Cost per missing person under a Required coverage rule (it can't always be met). */
const HARD_COVERAGE = 2_000;
/** Cost per missing shift under a Required "min shifts per week" rule. */
const HARD_MIN_SHIFTS = 500;
/** Hours: a piecewise version of the greedy engine's curve, deviation² × 10 ÷ target, in 4 h steps. */
const HOUR_STEP = 4;
const HOUR_STEPS = 12;
/** Fair share: n weekend (or late) shifts cost 3 × n², so each extra one costs about 6 × n. */
const FAIR_STEPS = 12;
const FAIR_WEIGHT = 3;

/** Soft rules judged exactly per assignment (the rest are sums over the month, modelled below). */
const PER_ASSIGNMENT = new Set([
  'unavailable_weekdays', 'unavailable_times', 'only_shift_kinds', 'prefers', 'max_hours_per_shift',
  'min_rest_hours', 'avoid_employee',
]);

// ---------------------------------------------------------------- LP text builder

const num = (c: number) => {
  const s = c.toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

type Term = [coef: number, name: string];

class Lp {
  private n = 0;
  private obj = new Map<string, number>();
  private rows: string[] = [];
  private bins: string[] = [];
  private ints: string[] = [];
  private bounds: string[] = [];

  bin(prefix: string): string {
    const v = `${prefix}${this.n++}`;
    this.bins.push(v);
    return v;
  }

  /** A continuous variable in [0, ub]. */
  cont(prefix: string, ub = Infinity): string {
    const v = `${prefix}${this.n++}`;
    this.bounds.push(ub === Infinity ? `0 <= ${v} <= +inf` : `0 <= ${v} <= ${num(ub)}`);
    return v;
  }

  int(prefix: string, ub: number): string {
    const v = this.cont(prefix, ub);
    this.ints.push(v);
    return v;
  }

  cost(v: string, c: number) {
    if (c) this.obj.set(v, (this.obj.get(v) ?? 0) + c);
  }

  row(terms: Term[], op: '<=' | '>=' | '=', rhs: number) {
    const t = terms.filter(([c]) => c !== 0);
    if (!t.length) return;
    const lhs = t.map(([c, v]) => `${c < 0 ? '-' : '+'} ${num(Math.abs(c))} ${v}`).join(' ');
    this.rows.push(` c${this.rows.length}: ${lhs} ${op} ${num(rhs)}`);
  }

  text(): string {
    const obj = [...this.obj].map(([v, c]) => `${c < 0 ? '-' : '+'} ${num(Math.abs(c))} ${v}`).join(' ') || '0';
    return [
      'Minimize', ` obj: ${obj}`,
      'Subject To', ...(this.rows.length ? this.rows : [' c0: 0 x_dummy >= 0']),
      'Bounds', ...this.bounds.map((b) => ` ${b}`),
      ...(this.bins.length ? ['Binary', ` ${this.bins.join(' ')}`] : []),
      ...(this.ints.length ? ['General', ` ${this.ints.join(' ')}`] : []),
      'End',
    ].join('\n');
  }
}

/** A sum that must stay ≤ limit (Required), or costs its priority weight per unit over (Preferred). */
const capped = (lp: Lp, terms: Term[], limit: number, rule: Rule) => {
  if (!terms.length) return;
  if (isHard(rule)) lp.row(terms, '<=', Math.max(0, limit));
  else {
    const over = lp.cont('sl');
    lp.cost(over, PRIORITY_WEIGHT[rule.priority]);
    lp.row([...terms, [-1, over]], '<=', limit);
  }
};

const rulesOfType = (rules: Rule[], e: Employee, dates: Iterable<DateStr>, type: string): Rule[] => {
  const out = new Map<ID, Rule>();
  for (const d of dates) for (const r of effectiveRules(rules, e, d)) if (r.type === type) out.set(r.id, r);
  return [...out.values()];
};

const tieBreak = (a: string, b: string) => {
  let h = 7;
  for (const ch of `${a}|${b}`) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (Math.abs(h) % 100) / 10_000;
};

const param = (r: Rule, key: string) => Number((r.params as Record<string, unknown>)[key] ?? 0);

// ---------------------------------------------------------------- model

interface Model {
  lp: Lp;
  /** Assignment variables per shift: [employee, variable]. */
  x: Map<ID, [ID, string][]>;
  /** Empty-slot count per shift (shifts with open slots only). */
  u: Map<ID, string>;
}

function buildModel(plan: Plan, targets: Map<ID, number>): Model {
  const { rules, settings, month } = plan.input;
  const lp = new Lp();
  const x = new Map<ID, [ID, string][]>();
  const u = new Map<ID, string>();
  const xOf = new Map<string, string>();
  const v = (s: ID, e: ID) => xOf.get(`${s}|${e}`);
  const days = daysInMonth(month);
  const monthDays = new Set(days);

  // 1. A variable for everyone who could take the shift given only the manual assignments.
  //    Every hard rule except "must work with" only gets stricter as more is planned, so anyone
  //    who already breaks one can never take the shift.
  for (const s of plan.shifts) {
    const on = new Set(plan.onShift(s.id));
    const open = plan.openSlots(s.id);
    const list: [ID, string][] = [];
    if (open > 0) {
      for (const e of plan.team) {
        if (on.has(e.id)) continue;
        const vs = violations(plan, e, s, { ignorePartner: true });
        if (hard(vs).length) continue;
        const name = lp.bin('x');
        list.push([e.id, name]);
        xOf.set(`${s.id}|${e.id}`, name);
        const soft = vs.filter((y) => !y.hard && PER_ASSIGNMENT.has(y.code)).reduce((a, y) => a + y.weight, 0);
        lp.cost(name, soft + tieBreak(e.id, s.id));
      }
      // Fill every open slot, or pay for leaving it empty.
      const empty = lp.int('u', open);
      lp.cost(empty, UNFILLED);
      u.set(s.id, empty);
      lp.row([...list.map(([, n]): Term => [1, n]), [1, empty]], '=', open);
    }
    x.set(s.id, list);
  }

  for (const e of plan.team) {
    const mine = plan.shifts.filter((s) => v(s.id, e.id));
    const fixed = plan.placed(e.id);
    const terms = (ss: Shift[], coef: (s: Shift) => number = () => 1): Term[] => ss.map((s) => [coef(s), v(s.id, e.id)!]);

    // 2. Pairs of shifts: never overlapping; enough rest in between.
    const sorted = [...mine].sort((a, b) => plan.interval(a.id).start - plan.interval(b.id).start);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const ia = plan.interval(a.id);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        const ib = plan.interval(b.id);
        if (ib.start - ia.end > 24 * 60) break; // rest rules go up to 24 h
        const pair: Term[] = [[1, v(a.id, e.id)!], [1, v(b.id, e.id)!]];
        if (overlaps(ia, ib)) { lp.row(pair, '<=', 1); continue; }
        const gap = restHours(ia, ib);
        const broken = rulesOfType(rules, e, [a.date, b.date], 'min_rest_hours').filter((r) => gap < param(r, 'hours'));
        if (!broken.length) continue;
        if (broken.some(isHard)) { lp.row(pair, '<=', 1); continue; }
        const both = lp.cont('p', 1);
        lp.cost(both, Math.max(...broken.map((r) => PRIORITY_WEIGHT[r.priority])));
        lp.row([...pair, [-1, both]], '<=', 1);
      }
    }

    // 3. Max hours per day (manual shifts that day are already used up).
    const byDate = new Map<DateStr, Shift[]>();
    for (const s of mine) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
    for (const [d, ss] of byDate)
      for (const r of rulesOfType(rules, e, [d], 'max_hours_per_day')) {
        const used = fixed.filter((p) => p.shift.date === d).reduce((a, p) => a + p.hours, 0);
        capped(lp, terms(ss, (s) => plan.hours(s.id)), param(r, 'hours') - used, r);
      }

    // 4. Max shifts per Monday–Sunday week.
    const byWeek = new Map<DateStr, Shift[]>();
    for (const s of mine) byWeek.set(weekStart(s.date), [...(byWeek.get(weekStart(s.date)) ?? []), s]);
    for (const [wk, ss] of byWeek) {
      const already = fixed.filter((p) => weekStart(p.shift.date) === wk).length;
      for (const r of rulesOfType(rules, e, ss.map((s) => s.date), 'max_shifts_per_week')) capped(lp, terms(ss), param(r, 'count') - already, r);
    }

    // 5. Max consecutive days: no N+1 days in a row may all be working days.
    const busy = new Set(fixed.map((p) => p.shift.date));
    const works = new Map<DateStr, string>(); // date → "works that day"
    for (const [d, ss] of byDate) {
      if (busy.has(d)) continue; // already working that day
      const w = lp.cont('w', 1);
      for (const s of ss) lp.row([[1, v(s.id, e.id)!], [-1, w]], '<=', 0);
      works.set(d, w);
    }
    const windows = new Set<string>();
    for (const d of byDate.keys())
      for (const r of rulesOfType(rules, e, [d], 'max_consecutive_days')) {
        const n = param(r, 'days');
        for (let start = -n; start <= 0; start++) {
          const key = `${addDays(d, start)}|${r.id}`;
          if (windows.has(key)) continue;
          windows.add(key);
          const win: Term[] = [];
          let constant = 0;
          let possible = true;
          for (let i = 0; i <= n; i++) {
            const day = addDays(d, start + i);
            if (busy.has(day)) constant++;
            else if (works.has(day)) win.push([1, works.get(day)!]);
            else possible = false; // a day that can't be worked breaks the run
          }
          if (possible) capped(lp, win, n - constant, r);
        }
      }

    // 6. Full weekends off per month.
    const weekends = days.filter((d) => weekday(d) === 6 && monthDays.has(addDays(d, 1)));
    const weekendShifts = mine.filter((s) => isWeekend(s.date));
    const weekendRules = rulesOfType(rules, e, weekendShifts.map((s) => s.date), 'weekends_off');
    if (weekendRules.length) {
      const free: Term[] = [];
      let alwaysFree = 0;
      for (const sat of weekends) {
        const both = [sat, addDays(sat, 1)];
        if (both.some((d) => busy.has(d))) continue; // can't be free any more
        const ss = mine.filter((s) => both.includes(s.date));
        if (!ss.length) { alwaysFree++; continue; }
        const f = lp.cont('f', 1);
        for (const s of ss) lp.row([[1, f], [1, v(s.id, e.id)!]], '<=', 1);
        free.push([1, f]);
      }
      for (const r of weekendRules) {
        const need = param(r, 'count');
        if (isHard(r) && need > weekends.length) {
          for (const s of weekendShifts) lp.row([[1, v(s.id, e.id)!]], '<=', 0);
        } else if (isHard(r)) lp.row(free, '>=', need - alwaysFree);
        else {
          const short = lp.cont('sl');
          lp.cost(short, PRIORITY_WEIGHT[r.priority]);
          lp.row([...free, [1, short]], '>=', need - alwaysFree);
        }
      }
    }

    // 7. Don't schedule with / must work with, per shift.
    for (const s of mine) {
      const xe = v(s.id, e.id)!;
      for (const r of effectiveRules(rules, e, s.date)) {
        const other = String((r.params as { employeeId?: ID }).employeeId ?? '');
        const xo = v(s.id, other);
        if (r.type === 'avoid_employee' && xo) {
          if (isHard(r)) lp.row([[1, xe], [1, xo]], '<=', 1);
          else { const y = lp.cont('p', 1); lp.cost(y, PRIORITY_WEIGHT[r.priority]); lp.row([[1, xe], [1, xo], [-1, y]], '<=', 1); }
        }
        if (r.type === 'pair_with' && !plan.onShift(s.id).includes(other)) {
          const t: Term[] = xo ? [[1, xe], [-1, xo]] : [[1, xe]];
          if (isHard(r)) lp.row(t, '<=', 0);
          else { const y = lp.cont('p', 1); lp.cost(y, PRIORITY_WEIGHT[r.priority]); lp.row([...t, [-1, y]], '<=', 0); }
        }
      }
    }

    // 8. Min shifts per full week (Mon–Sun inside the month), as a shortfall with a cost.
    for (const mon of days.filter((d) => weekday(d) === 1 && monthDays.has(addDays(d, 6)))) {
      const r = effectiveRules(rules, e, mon).find((y) => y.type === 'min_shifts_per_week');
      if (!r) continue;
      const week = new Set(Array.from({ length: 7 }, (_, i) => addDays(mon, i)));
      const have = fixed.filter((p) => week.has(p.shift.date)).length;
      const short = lp.cont('sh');
      lp.cost(short, isHard(r) ? HARD_MIN_SHIFTS : PRIORITY_WEIGHT[r.priority]);
      lp.row([...terms(mine.filter((s) => week.has(s.date))), [1, short]], '>=', param(r, 'count') - have);
    }

    // 9. Hours close to target, relative to the size of the contract.
    const target = targets.get(e.id) ?? 0;
    const fixedHours = fixed.reduce((a, p) => a + p.hours, 0);
    const deviation: Term[] = [];
    for (const sign of [1, -1]) {
      for (let k = 0; k < HOUR_STEPS; k++) {
        const seg = lp.cont(sign > 0 ? 'ho' : 'hu', k === HOUR_STEPS - 1 ? Infinity : HOUR_STEP);
        lp.cost(seg, (10 * HOUR_STEP * (2 * k + 1)) / Math.max(target, 8));
        deviation.push([-sign, seg]);
      }
    }
    lp.row([...terms(mine, (s) => plan.hours(s.id)), ...deviation], '=', target - fixedHours);

    // 10. Fair share of weekend and late shifts.
    for (const pick of [(s: Shift) => isWeekend(s.date), (s: Shift) => isLate(s, settings)]) {
      const ss = mine.filter(pick);
      if (!ss.length) continue;
      const base = fixed.filter((p) => pick(p.shift)).length;
      const steps: Term[] = [];
      for (let k = 0; k < FAIR_STEPS; k++) {
        const seg = lp.cont('fs', k === FAIR_STEPS - 1 ? Infinity : 1);
        lp.cost(seg, FAIR_WEIGHT * (2 * (base + k) + 1));
        steps.push([-1, seg]);
      }
      lp.row([...terms(ss), ...steps], '<=', 0);
    }
  }

  // 11. Coverage: at least N people (with a skill) on matching shifts.
  for (const s of plan.shifts)
    for (const r of coverageRules(rules, s)) {
      const skill = String((r.params as { skill?: string }).skill ?? '');
      const has = (id: ID) => !skill || !!plan.people.get(id)?.skills.includes(skill);
      const need = param(r, 'count') - plan.onShift(s.id).filter(has).length;
      if (need <= 0) continue;
      const short = lp.cont('cv');
      lp.cost(short, isHard(r) ? HARD_COVERAGE : 2 * PRIORITY_WEIGHT[r.priority]);
      lp.row([...(x.get(s.id) ?? []).filter(([id]) => has(id)).map(([, n]): Term => [1, n]), [1, short]], '>=', need);
    }

  return { lp, x, u };
}

// ---------------------------------------------------------------- solve

export interface OptimiseOptions {
  /** Branch-and-bound nodes to search after the greedy start (a work limit, so results are deterministic). */
  maxNodes?: number;
  /** Wall-clock safety limit in seconds; only reached on a very slow device. */
  timeLimit?: number;
}

export const DEFAULT_MAX_NODES = 100;

/** Size of the optimisation model for an input (for tests and diagnostics). */
export function modelSize(input: ScheduleInput): { variables: number; constraints: number } {
  const plan = new Plan(input);
  plan.load(input.fixed ?? [], true);
  const targets = new Map(plan.team.map((e) => [e.id, targetHours(e, input.month, input.requests, input.settings)]));
  const text = buildModel(plan, targets).lp.text();
  return {
    variables: new Set(text.match(/\b[a-z]{1,2}\d+\b/g) ?? []).size,
    constraints: (text.match(/^ c\d+:/gm) ?? []).length,
  };
}

/**
 * Plans the month with the optimiser, keeping manual assignments in `input.fixed`. Returns null
 * if the solver fails or its plan doesn't pass the rule check; the caller keeps the greedy plan.
 */
export function optimise(highs: Highs, input: ScheduleInput, opts: OptimiseOptions = {}): ScheduleResult | null {
  const plan = new Plan(input);
  plan.load(input.fixed ?? [], true);
  const targets = new Map(plan.team.map((e) => [e.id, targetHours(e, input.month, input.requests, input.settings)]));
  const { lp, x, u } = buildModel(plan, targets);

  // The greedy plan is the starting solution.
  const start = new Set(generate(input).assignments.filter((a) => a.employeeId && !a.manual).map((a) => `${a.shiftId}|${a.employeeId}`));

  const model = highs.createModel({ format: 'lp', data: lp.text() });
  const chosen = new Set<string>();
  try {
    model.options.set({
      output_flag: false,
      random_seed: 0,
      mip_max_nodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
      time_limit: opts.timeLimit ?? 30,
    });
    const indices: number[] = [];
    const values: number[] = [];
    for (const [sid, list] of x) {
      let filled = 0;
      for (const [eid, name] of list) {
        const on = start.has(`${sid}|${eid}`);
        if (on) filled++;
        indices.push(model.getColByName(name));
        values.push(on ? 1 : 0);
      }
      const empty = u.get(sid);
      if (empty) {
        indices.push(model.getColByName(empty));
        values.push(Math.max(0, plan.openSlots(sid) - filled));
      }
    }
    if (indices.length) model.setSolution({ indices, values });
    model.run();
    const col = model.getSolution().colValue;
    if (!col?.length) return null;
    for (const [sid, list] of x)
      for (const [eid, name] of list) if (col[model.getColByName(name)] > 0.5) chosen.add(`${sid}|${eid}`);
  } catch {
    return null;
  } finally {
    model.dispose();
  }

  for (const s of plan.shifts) {
    const who = (x.get(s.id) ?? []).filter(([eid]) => chosen.has(`${s.id}|${eid}`)).map(([eid]) => eid);
    const slots = plan.slots.get(s.id)!;
    for (let slot = 0; slot < slots.length && who.length; slot++) if (!slots[slot]) plan.put(s.id, slot, who.shift()!);
    if (who.length) return null; // more people than slots: the model and the plan disagree
  }

  // Safety net: every new assignment must pass the same hard-rule check the greedy engine uses.
  for (const s of plan.shifts)
    for (const [slot, id] of (plan.slots.get(s.id) ?? []).entries()) {
      if (!id || plan.isFixed(s.id, slot)) continue;
      if (hard(violations(plan, plan.people.get(id)!, s)).length) return null;
    }
  return summarise(plan, targets);
}

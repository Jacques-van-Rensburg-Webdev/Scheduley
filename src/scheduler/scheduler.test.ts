import { describe, expect, it } from 'vitest';
import {
  checkCandidate, dayStatus, daysInMonth, effectiveRules, feasibilityDelta, generate, restHours,
  ruleOverrides, shiftHours, shiftInterval, shiftKind, targetHours, validate, vacationBalance, weekday,
  RULE_TYPES, defaultParams, describeRule,
  type Employee, type Rule, type ScheduleInput, type ScheduleResult, type Settings, type Shift, type TimeOffRequest,
} from './index';

// The bar's hours: Mon closed · Tue/Wed/Sun 23:00 · Thu–Sat 01:00.
const settings: Settings = { closing: ['23:00', null, '23:00', '23:00', '01:00', '01:00', '01:00'] };

const person = (id: string, o: Partial<Employee> = {}): Employee => ({
  id, name: id[0].toUpperCase() + id.slice(1), teamId: 'bar', roles: ['Bartender'], skills: [],
  contract: { hours: 30, per: 'week' }, vacationAllowance: 25, ...o,
});

let seq = 0;
const shift = (date: string, start: string, end: string, o: Partial<Shift> = {}): Shift => ({
  id: `s${++seq}`, teamId: 'bar', date, start, end, staffNeeded: 1, ...o,
});

const rule = (type: string, params: Record<string, unknown>, o: Partial<Rule> = {}): Rule => ({
  id: `r${++seq}`, type, params, scope: { kind: 'all' }, strength: 'required', priority: 'medium', enabled: true, ...o,
});

const timeOff = (employeeId: string, type: TimeOffRequest['type'], from: string, to = from, status: TimeOffRequest['status'] = 'approved'): TimeOffRequest =>
  ({ id: `q${++seq}`, employeeId, type, from, to, status, createdAt: '2026-11-01' });

const REST = rule('min_rest_hours', { hours: 11 });

const input = (o: Partial<ScheduleInput>): ScheduleInput => ({
  teamId: 'bar', month: '2026-12', employees: [], shifts: [], requests: [], rules: [REST], settings, ...o,
});

/** One evening shift on every open day of December 2026. */
const evenings = (o: Partial<Shift> = {}) =>
  daysInMonth('2026-12').filter((d) => weekday(d) !== 1).map((d) => shift(d, '18:00', '23:00', o));

const on = (res: Pick<ScheduleResult, 'assignments'>, shiftId: string) =>
  res.assignments.filter((a) => a.shiftId === shiftId).map((a) => a.employeeId);

const shiftsOf = (res: ScheduleResult, id: string) => res.assignments.filter((a) => a.employeeId === id).map((a) => a.shiftId);

const noHardWarnings = (inp: ScheduleInput, res: ScheduleResult) =>
  validate(inp, res.assignments).warnings.filter((w) => w.violations.some((v) => v.hard));

// ---------------------------------------------------------------- time

describe('shift times', () => {
  it('ends until-close shifts at that weekday’s closing time', () => {
    expect(shiftHours(shift('2026-12-11', '18:00', 'close'), settings)).toBe(7); // Fri → 01:00
    expect(shiftHours(shift('2026-12-08', '18:00', 'close'), settings)).toBe(5); // Tue → 23:00
  });

  it('runs shifts past midnight into the next day', () => {
    expect(shiftHours(shift('2026-12-11', '18:30', '01:00'), settings)).toBe(6.5);
  });

  it('measures rest between shifts across midnight', () => {
    const late = shiftInterval(shift('2026-12-11', '18:00', 'close'), settings); // ends Sat 01:00
    const early = shiftInterval(shift('2026-12-12', '10:30', '16:00'), settings);
    expect(restHours(late, early)).toBe(9.5);
  });

  it('classifies day, evening and until-close shifts', () => {
    expect(shiftKind({ start: '11:00', end: '18:00' })).toBe('day');
    expect(shiftKind({ start: '17:00', end: '23:00' })).toBe('evening');
    expect(shiftKind({ start: '18:00', end: 'close' })).toBe('close');
  });
});

// ---------------------------------------------------------------- targets and balances

describe('hours targets and vacation', () => {
  it('converts a weekly contract to the month', () => {
    expect(targetHours(person('ana'), '2026-12', [], settings)).toBe(Math.round((30 * 31 / 7) * 10) / 10);
  });

  it('uses the monthly figure for a monthly contract', () => {
    expect(targetHours(person('ana', { contract: { hours: 40, per: 'month' } }), '2026-12', [], settings)).toBe(40);
  });

  it('takes weekly hours ÷ 5 off for each open vacation day', () => {
    // Fri 11 – Mon 14 Dec: Monday is closed, so 3 vacation days count.
    const reqs = [timeOff('ana', 'vacation', '2026-12-11', '2026-12-14')];
    expect(targetHours(person('ana'), '2026-12', reqs, settings)).toBe(Math.round((30 * 31 / 7 - 3 * 6) * 10) / 10);
  });

  it('counts used and pending vacation against the allowance on open days only', () => {
    const reqs = [
      timeOff('ana', 'vacation', '2026-12-11', '2026-12-14'),
      timeOff('ana', 'vacation', '2026-12-22', '2026-12-23', 'pending'),
      timeOff('ana', 'day_off', '2026-12-02'),
    ];
    expect(vacationBalance(person('ana'), '2026', reqs, settings)).toEqual({ allowance: 25, used: 3, pending: 2, remaining: 22 });
  });
});

// ---------------------------------------------------------------- built-in rules

describe('built-in rules', () => {
  it('never schedules approved time off', () => {
    const s = shift('2026-12-12', '18:00', '23:00');
    const res = generate(input({ employees: [person('ryan'), person('ana')], shifts: [s], requests: [timeOff('ryan', 'day_off', '2026-12-12')] }));
    expect(on(res, s.id)).toEqual(['ana']);
  });

  it('ignores time off that is only pending or was rejected', () => {
    const s = shift('2026-12-12', '18:00', '23:00');
    const res = generate(input({ employees: [person('ryan')], shifts: [s], requests: [timeOff('ryan', 'day_off', '2026-12-12', '2026-12-12', 'pending')] }));
    expect(on(res, s.id)).toEqual(['ryan']);
  });

  it('matches the shift’s role and keeps teams apart', () => {
    const close = shift('2026-12-11', '18:00', 'close', { role: 'Closing' });
    const res = generate(input({
      employees: [person('ana'), person('ben', { roles: ['Bartender', 'Closing'] }), person('cy', { teamId: 'runners', roles: ['Closing'] })],
      shifts: [close],
    }));
    expect(on(res, close.id)).toEqual(['ben']);
  });

  it('never gives one person two overlapping shifts', () => {
    const a = shift('2026-12-11', '17:00', '23:00');
    const b = shift('2026-12-11', '18:00', '00:00');
    const res = generate(input({ employees: [person('ana')], shifts: [a, b], rules: [] }));
    expect(res.unfilled).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- required rules

describe('required rules', () => {
  it('keeps the minimum rest between shifts', () => {
    const late = shift('2026-12-11', '18:00', 'close');
    const early = shift('2026-12-12', '10:30', '16:00');
    const res = generate(input({ employees: [person('ana')], shifts: [late, early] }));
    expect(res.unfilled).toHaveLength(1);
    expect(res.unfilled[0].reasons[0]).toMatch(/Ana only 9.5 h rest \(min 11 h\)/);
  });

  it('limits consecutive working days', () => {
    const shifts = evenings();
    const inp = input({ employees: [person('ana', { contract: { hours: 60, per: 'week' } }), person('ben')], shifts, rules: [REST, rule('max_consecutive_days', { days: 3 })] });
    const res = generate(inp);
    expect(res.unfilled).toHaveLength(0);
    expect(noHardWarnings(inp, res)).toEqual([]);
  });

  it('limits shifts per week', () => {
    const shifts = evenings();
    const inp = input({ employees: [person('ana', { contract: { hours: 60, per: 'week' } }), person('ben')], shifts, rules: [REST, rule('max_shifts_per_week', { count: 2 })] });
    const res = generate(inp);
    expect(noHardWarnings(inp, res)).toEqual([]);
  });

  it('respects unavailable weekdays and times', () => {
    const fri = shift('2026-12-11', '18:00', '23:00');
    const lateFri = shift('2026-12-11', '18:30', '01:00');
    const rules = [
      rule('unavailable_weekdays', { weekdays: [5] }, { scope: { kind: 'employee', employeeId: 'ana' } }),
      rule('unavailable_times', { notBefore: '', notAfter: '00:00' }, { scope: { kind: 'employee', employeeId: 'ben' } }),
    ];
    const res = generate(input({ employees: [person('ana'), person('ben'), person('cy')], shifts: [fri, lateFri], rules }));
    expect(on(res, fri.id)).not.toContain('ana');
    expect(on(res, lateFri.id)).not.toContain('ben');
  });

  it('keeps people with a "don’t schedule with" rule apart, both ways', () => {
    const s = shift('2026-12-11', '18:00', '23:00', { staffNeeded: 2 });
    const rules = [rule('avoid_employee', { employeeId: 'ben' }, { scope: { kind: 'employee', employeeId: 'ana' } })];
    const res = generate(input({ employees: [person('ana'), person('ben')], shifts: [s], rules }));
    expect(on(res, s.id).filter(Boolean)).toHaveLength(1);
  });

  it('places a trainee only together with their trainer', () => {
    const solo = shift('2026-12-10', '18:00', '23:00');
    const pair = shift('2026-12-11', '18:00', '23:00', { staffNeeded: 2 });
    const rules = [rule('pair_with', { employeeId: 'gp' }, { scope: { kind: 'employee', employeeId: 'tia' } })];
    const res = generate(input({
      employees: [person('tia', { contract: { hours: 60, per: 'week' } }), person('gp', { contract: { hours: 1, per: 'month' } })],
      shifts: [solo, pair], rules,
    }));
    expect(on(res, solo.id)).not.toContain('tia');
    expect(on(res, pair.id).sort()).toEqual(['gp', 'tia']);
  });

  it('keeps a full weekend free', () => {
    const shifts = daysInMonth('2026-12').filter((d) => [0, 6].includes(weekday(d))).map((d) => shift(d, '12:00', '18:00'));
    const team = [person('ana', { contract: { hours: 60, per: 'week' } }), person('ben'), person('cy')];
    const inp = input({ employees: team, shifts, rules: [REST, rule('weekends_off', { count: 2 })] });
    const res = generate(inp);
    expect(noHardWarnings(inp, res)).toEqual([]);
    expect(res.unfilled).toHaveLength(0);
    // With only one person, they work at most the 2 weekends the rule leaves them.
    const alone = generate({ ...inp, employees: [person('ana')] });
    expect(alone.assignments.filter((a) => a.employeeId).length).toBeLessThanOrEqual(4);
  });

  it('saves the last slot for a Keyholder when one is still needed', () => {
    const close = shift('2026-12-11', '18:00', 'close', { staffNeeded: 2 });
    const rules = [rule('min_skill_on_shift', { count: 1, skill: 'Keyholder', kind: 'close', weekdays: [0, 1, 2, 3, 4, 5, 6] })];
    const res = generate(input({
      employees: [person('ana', { contract: { hours: 60, per: 'week' } }), person('ben', { contract: { hours: 60, per: 'week' } }), person('kim', { skills: ['Keyholder'], contract: { hours: 2, per: 'month' } })],
      shifts: [close], rules,
    }));
    expect(on(res, close.id)).toContain('kim');
    expect(res.issues).toEqual([]);
  });

  it('reports coverage it can’t meet as a shortfall', () => {
    const close = shift('2026-12-11', '18:00', 'close');
    const rules = [rule('min_skill_on_shift', { count: 1, skill: 'Keyholder', kind: 'close', weekdays: [5] })];
    const res = generate(input({ employees: [person('ana')], shifts: [close], rules }));
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]).toMatchObject({ hard: true, message: expect.stringMatching(/0 of 1 Keyholder/) });
  });
});

// ---------------------------------------------------------------- preferences and fairness

describe('scoring', () => {
  it('gives the shift to whoever is furthest below their target', () => {
    const s = shift('2026-12-11', '18:00', '23:00');
    const res = generate(input({ employees: [person('ana', { contract: { hours: 5, per: 'month' } }), person('ben', { contract: { hours: 40, per: 'week' } })], shifts: [s] }));
    expect(on(res, s.id)).toEqual(['ben']);
  });

  it('shares a shortage of shifts in proportion to contract size', () => {
    const shifts = evenings();
    const res = generate(input({ employees: [person('big', { contract: { hours: 40, per: 'week' } }), person('small', { contract: { hours: 20, per: 'week' } })], shifts }));
    const st = Object.fromEntries(res.stats.map((s) => [s.employeeId, s.hours / s.target]));
    expect(Math.abs(st.big - st.small)).toBeLessThan(0.15);
  });

  it('avoids breaking Preferred rules when someone else can work', () => {
    const fri = shift('2026-12-11', '18:00', '23:00');
    const rules = [REST, rule('unavailable_weekdays', { weekdays: [5] }, { scope: { kind: 'employee', employeeId: 'ana' }, strength: 'preferred', priority: 'high' })];
    const res = generate(input({ employees: [person('ana', { contract: { hours: 60, per: 'week' } }), person('ben')], shifts: [fri], rules }));
    expect(on(res, fri.id)).toEqual(['ben']);
  });

  it('breaks a Preferred rule rather than leave a slot empty', () => {
    const fri = shift('2026-12-11', '18:00', '23:00');
    const rules = [rule('unavailable_weekdays', { weekdays: [5] }, { scope: { kind: 'employee', employeeId: 'ana' }, strength: 'preferred' })];
    const res = generate(input({ employees: [person('ana')], shifts: [fri], rules }));
    expect(on(res, fri.id)).toEqual(['ana']);
    expect(validate(input({ employees: [person('ana')], shifts: [fri], rules }), res.assignments).warnings[0].violations[0].hard).toBe(false);
  });

  it('spreads weekend and late shifts fairly', () => {
    const shifts = daysInMonth('2026-12').filter((d) => weekday(d) !== 1).map((d) => shift(d, '18:00', 'close'));
    const team = ['ana', 'ben', 'cy', 'dee'].map((id) => person(id));
    const res = generate(input({ employees: team, shifts }));
    const weekends = res.stats.map((s) => s.weekendShifts);
    expect(Math.max(...weekends) - Math.min(...weekends)).toBeLessThanOrEqual(2);
  });

  it('is deterministic', () => {
    const inp = input({ employees: ['ana', 'ben', 'cy'].map((id) => person(id)), shifts: evenings({ staffNeeded: 2 }) });
    expect(generate(inp)).toEqual(generate(inp));
  });
});

// ---------------------------------------------------------------- precedence

describe('rule precedence', () => {
  const team = rule('max_consecutive_days', { days: 4 }, { scope: { kind: 'team', teamId: 'bar' } });
  const all = rule('max_consecutive_days', { days: 5 });
  const mine = rule('max_consecutive_days', { days: 6 }, { scope: { kind: 'employee', employeeId: 'ana' } });

  it('uses the person’s own rule over the team’s and everyone’s', () => {
    expect(effectiveRules([all, team, mine], person('ana'), '2026-12-11')).toEqual([mine]);
    expect(effectiveRules([all, team, mine], person('ben'), '2026-12-11')).toEqual([team]);
    expect(effectiveRules([all], person('ben'), '2026-12-11')).toEqual([all]);
  });

  it('ignores disabled rules and rules outside their date range', () => {
    const later = { ...mine, from: '2027-01-01' };
    expect(effectiveRules([all, later], person('ana'), '2026-12-11')).toEqual([all]);
    expect(effectiveRules([all, { ...mine, enabled: false }], person('ana'), '2026-12-11')).toEqual([all]);
  });

  it('lists which rules override which', () => {
    const o = ruleOverrides([all, team, mine], [person('ana'), person('ben')]);
    expect(o.map((x) => [x.rule.id, x.overridden.id])).toEqual(expect.arrayContaining([[team.id, all.id], [mine.id, all.id], [mine.id, team.id]]));
  });
});

// ---------------------------------------------------------------- manual changes

describe('manual changes', () => {
  it('keeps manual assignments when the month is generated again', () => {
    const s = shift('2026-12-11', '18:00', '23:00');
    const res = generate(input({
      employees: [person('ana', { contract: { hours: 1, per: 'month' } }), person('ben', { contract: { hours: 60, per: 'week' } })],
      shifts: [s], fixed: [{ shiftId: s.id, slot: 0, employeeId: 'ana', manual: true }],
    }));
    expect(res.assignments).toEqual([{ shiftId: s.id, slot: 0, employeeId: 'ana', manual: true }]);
  });

  it('validate() lists every rule a hand-made schedule breaks', () => {
    const late = shift('2026-12-11', '18:00', 'close');
    const early = shift('2026-12-12', '10:30', '16:00');
    const inp = input({ employees: [person('ana')], shifts: [late, early], requests: [timeOff('ana', 'day_off', '2026-12-12')] });
    const v = validate(inp, [{ shiftId: late.id, slot: 0, employeeId: 'ana' }, { shiftId: early.id, slot: 0, employeeId: 'ana' }]);
    const codes = v.warnings.flatMap((w) => w.violations.map((x) => x.code));
    expect(codes).toEqual(expect.arrayContaining(['time_off', 'min_rest_hours']));
  });

  it('checkCandidate() explains what a reassignment would break', () => {
    const a = shift('2026-12-11', '17:00', '23:00');
    const b = shift('2026-12-11', '18:00', '00:00');
    const inp = input({ employees: [person('ana'), person('ben')], shifts: [a, b] });
    const asg = [{ shiftId: a.id, slot: 0, employeeId: 'ana' }, { shiftId: b.id, slot: 0, employeeId: 'ben' }];
    expect(checkCandidate(inp, asg, b.id, 0, 'ana').map((v) => v.code)).toContain('overlap');
    expect(checkCandidate(inp, asg, a.id, 0, 'ana')).toEqual([]);
  });
});

// ---------------------------------------------------------------- the rest

describe('feasibility of a rule change', () => {
  it('warns when a new rule leaves slots empty', () => {
    const shifts = evenings();
    const inp = input({ employees: [person('ana', { contract: { hours: 60, per: 'week' } })], shifts });
    const before = [REST];
    const after = [REST, rule('max_shifts_per_week', { count: 3 })];
    const rep = feasibilityDelta([inp], before, after);
    expect(rep.newUnfilled.length).toBeGreaterThan(0);
    expect(feasibilityDelta([inp], before, before).newUnfilled).toEqual([]);
  });
});

describe('minimum shifts per week', () => {
  it('reports weeks below the minimum', () => {
    const shifts = [shift('2026-12-08', '18:00', '23:00')];
    const rules = [REST, rule('min_shifts_per_week', { count: 2 }, { scope: { kind: 'employee', employeeId: 'ana' } })];
    const res = generate(input({ employees: [person('ana')], shifts, rules }));
    expect(res.issues.some((i) => i.employeeId === 'ana' && /1 shift that week \(min 2\)/.test(i.message))).toBe(true);
  });
});

describe('calendar status', () => {
  it('tells closed, empty, set, full and under-staffed days apart', () => {
    const s = shift('2026-12-11', '18:00', '23:00', { staffNeeded: 2 });
    expect(dayStatus('2026-12-07', [], undefined, settings)).toBe('closed');
    expect(dayStatus('2026-12-08', [], undefined, settings)).toBe('none');
    expect(dayStatus('2026-12-11', [s], undefined, settings)).toBe('set');
    expect(dayStatus('2026-12-11', [s], [{ shiftId: s.id, slot: 0, employeeId: 'a' }], settings)).toBe('under');
    expect(dayStatus('2026-12-11', [s], [{ shiftId: s.id, slot: 0, employeeId: 'a' }, { shiftId: s.id, slot: 1, employeeId: 'b' }], settings)).toBe('full');
  });
});

describe('rule registry', () => {
  it('gives every rule type a summary for its default parameters', () => {
    for (const t of RULE_TYPES) {
      const r = rule(t.id, defaultParams(t.id));
      expect(describeRule(r, (id) => id || 'someone')).toBeTruthy();
    }
  });
});

describe('a realistic month', () => {
  it('fills a 9-person month quickly without breaking a hard rule', () => {
    const days = daysInMonth('2026-12').filter((d) => weekday(d) !== 1);
    const shifts = days.flatMap((d) => [shift(d, '11:00', '18:00'), shift(d, '17:00', '23:00', { staffNeeded: 2 }), shift(d, '18:00', 'close', { staffNeeded: 2 })]);
    const team = Array.from({ length: 9 }, (_, i) => person(`p${i}`, { contract: { hours: 25 + (i % 3) * 5, per: 'week' } }));
    const inp = input({ employees: team, shifts, rules: [REST, rule('max_consecutive_days', { days: 5 })] });
    const t = performance.now();
    const res = generate(inp);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(noHardWarnings(inp, res)).toEqual([]);
    expect(res.unfilled.length).toBeLessThan(5);
    expect(shiftsOf(res, 'p0').length).toBeGreaterThan(0);
  });
});

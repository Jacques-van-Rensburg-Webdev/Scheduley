import { beforeAll, describe, expect, it } from 'vitest';
import loadHighs, { type Highs } from 'highs';
import {
  daysInMonth, generate, optimise, validate, weekday,
  type Employee, type Rule, type ScheduleInput, type ScheduleResult, type Settings, type Shift,
} from './index';

const settings: Settings = { closing: ['23:00', null, '23:00', '23:00', '01:00', '01:00', '01:00'] };
const person = (id: string, o: Partial<Employee> = {}): Employee => ({
  id, name: id, teamId: 'bar', roles: ['Bartender'], skills: [], contract: { hours: 30, per: 'week' }, vacationAllowance: 25, ...o,
});
let seq = 0;
const shift = (date: string, start: string, end: string, o: Partial<Shift> = {}): Shift => ({ id: `s${++seq}`, teamId: 'bar', date, start, end, staffNeeded: 1, ...o });
const rule = (type: string, params: Record<string, unknown>, o: Partial<Rule> = {}): Rule => ({
  id: `r${++seq}`, type, params, scope: { kind: 'all' }, strength: 'required', priority: 'medium', enabled: true, ...o,
});
const input = (o: Partial<ScheduleInput>): ScheduleInput => ({
  teamId: 'bar', month: '2026-12', employees: [], shifts: [], requests: [], rules: [rule('min_rest_hours', { hours: 11 })], settings, ...o,
});
const hardWarnings = (inp: ScheduleInput, res: ScheduleResult) => validate(inp, res.assignments).warnings.filter((w) => w.violations.some((v) => v.hard));

let highs: Highs;
beforeAll(async () => { highs = await loadHighs(); });

describe('optimiser', () => {
  it('fills a tight month the greedy engine can’t', () => {
    // 4 weekends, 2 people, each must keep 2 weekends free: only works if nobody splits a weekend.
    const shifts = daysInMonth('2026-12').filter((d) => [0, 6].includes(weekday(d))).map((d) => shift(d, '12:00', '18:00'));
    const inp = input({ employees: [person('ana'), person('ben')], shifts, rules: [rule('weekends_off', { count: 2 })] });
    const greedy = generate(inp);
    const best = optimise(highs, inp, { maxNodes: 50 })!;
    expect(best.unfilled.length).toBe(0);
    expect(best.unfilled.length).toBeLessThanOrEqual(greedy.unfilled.length);
    expect(hardWarnings(inp, best)).toEqual([]);
  });

  it('keeps manual assignments', () => {
    const s = shift('2026-12-11', '18:00', '23:00');
    const inp = input({ employees: [person('ana', { contract: { hours: 1, per: 'month' } }), person('ben')], shifts: [s], fixed: [{ shiftId: s.id, slot: 0, employeeId: 'ana', manual: true }] });
    expect(optimise(highs, inp)!.assignments).toEqual([{ shiftId: s.id, slot: 0, employeeId: 'ana', manual: true }]);
  });

  it('never breaks a hard rule and never leaves more slots empty than greedy', () => {
    const days = daysInMonth('2026-12').filter((d) => weekday(d) !== 1);
    const shifts = days.flatMap((d) => [shift(d, '11:00', '18:00'), shift(d, '18:00', 'close', { staffNeeded: 2 })]);
    const team = Array.from({ length: 5 }, (_, i) => person(`p${i}`, { contract: { hours: 20 + i * 5, per: 'week' } }));
    const inp = input({ employees: team, shifts, rules: [rule('min_rest_hours', { hours: 11 }), rule('max_consecutive_days', { days: 4 }), rule('weekends_off', { count: 1 })] });
    const greedy = generate(inp);
    const best = optimise(highs, inp, { maxNodes: 20 })!;
    expect(best).not.toBeNull();
    expect(hardWarnings(inp, best)).toEqual([]);
    expect(best.unfilled.length).toBeLessThanOrEqual(greedy.unfilled.length);
  }, 60_000);

  it('is deterministic', () => {
    const shifts = daysInMonth('2026-12').filter((d) => weekday(d) !== 1).map((d) => shift(d, '18:00', '23:00', { staffNeeded: 2 }));
    const inp = input({ employees: ['ana', 'ben', 'cy'].map((id) => person(id)), shifts });
    expect(optimise(highs, inp, { maxNodes: 10 })).toEqual(optimise(highs, inp, { maxNodes: 10 }));
  }, 60_000);
});

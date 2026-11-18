import { useMemo, useState } from 'react';
import {
  checkCandidate, daysInMonth, formatDate, formatMonth, formatTimes, generate, validate,
  type Assignment, type ID, type MonthStr, type Shift, type Violation,
} from '../scheduler';
import { findSchedule, notify, nowIso, scheduleInput, useStore, type AppState } from '../store';
import { Empty, Modal, MonthPicker, Pill, TeamPicker, cx, hoursText, useNames } from './common';

interface Props {
  teamId: ID;
  setTeamId: (id: ID) => void;
  month: MonthStr;
  setMonth: (m: MonthStr) => void;
}

interface SlotRef { shiftId: ID; slot: number }

/** Every slot of the month's shifts, filled from the saved assignments. */
const slotsFor = (shifts: Shift[], assignments: Assignment[]) => {
  const byKey = new Map(assignments.map((a) => [`${a.shiftId}#${a.slot}`, a]));
  return new Map(shifts.map((s) => [s.id, Array.from({ length: s.staffNeeded }, (_, slot) =>
    byKey.get(`${s.id}#${slot}`) ?? { shiftId: s.id, slot, employeeId: null })]));
};

export function ScheduleView({ teamId, setTeamId, month, setMonth }: Props) {
  const { state, update } = useStore();
  const { nameOf } = useNames();
  const [picking, setPicking] = useState<SlotRef | null>(null);
  const [dragging, setDragging] = useState<SlotRef | null>(null);
  const [message, setMessage] = useState('');

  const schedule = findSchedule(state, teamId, month);
  const input = useMemo(() => scheduleInput(state, teamId, month), [state, teamId, month]);
  const shifts = useMemo(
    () => state.shifts.filter((s) => s.teamId === teamId && s.date.startsWith(month))
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)),
    [state.shifts, teamId, month],
  );
  const assignments = schedule?.assignments ?? [];
  const slots = useMemo(() => slotsFor(shifts, assignments), [shifts, assignments]);
  const check = useMemo(() => (schedule ? validate(input, schedule.assignments) : null), [input, schedule]);

  const warningsBySlot = new Map((check?.warnings ?? []).map((w) => [`${w.shiftId}#${w.slot}`, w.violations]));
  const emptyReasons = new Map((check?.unfilled ?? []).map((u) => [`${u.shiftId}#${u.slot}`, u.reasons]));
  const hardWarnings = (check?.warnings ?? []).filter((w) => w.violations.some((v) => v.hard));
  const totalSlots = shifts.reduce((n, s) => n + s.staffNeeded, 0);
  const filled = assignments.filter((a) => a.employeeId && slots.get(a.shiftId)).length;

  /** Saves new assignments for this team's month; tells people when a published plan changes. */
  const saveAssignments = (change: (list: Assignment[]) => Assignment[], touched: ID[] = []) =>
    update((d) => {
      let sc = findSchedule(d, teamId, month);
      if (!sc) {
        sc = { teamId, month, status: 'draft', assignments: [] };
        d.schedules.push(sc);
      }
      sc.assignments = change(structuredClone(sc.assignments));
      if (sc.status === 'published')
        for (const id of new Set(touched)) notify(d, id, `Your shifts for ${formatMonth(month)} were changed. Check your schedule.`);
    });

  const onGenerate = () => {
    const keep = assignments.filter((a) => a.manual && a.employeeId);
    const t = performance.now();
    const res = generate({ ...input, fixed: keep });
    const ms = Math.round(performance.now() - t);
    update((d) => {
      const sc = findSchedule(d, teamId, month);
      if (sc) Object.assign(sc, { assignments: res.assignments, generatedAt: nowIso() });
      else d.schedules.push({ teamId, month, status: 'draft', assignments: res.assignments, generatedAt: nowIso() });
    });
    setMessage(`Generated in ${ms} ms${keep.length ? `, keeping ${keep.length} manual change${keep.length === 1 ? '' : 's'}` : ''}. ` +
      (res.unfilled.length ? `${res.unfilled.length} slot${res.unfilled.length === 1 ? '' : 's'} couldn't be filled.` : 'Every slot is filled.'));
  };

  const onPublish = () => update((d) => {
    const sc = findSchedule(d, teamId, month);
    if (!sc) return;
    sc.status = 'published';
    sc.publishedAt = nowIso();
    for (const e of d.employees.filter((x) => x.teamId === teamId))
      notify(d, e.id, `Your schedule for ${formatMonth(month)} is out.`);
  });

  const onUnpublish = () => update((d) => {
    const sc = findSchedule(d, teamId, month);
    if (sc) sc.status = 'draft';
  });

  const onClear = () => {
    if (!confirm('Remove every assignment that was not made by hand?')) return;
    saveAssignments((list) => list.filter((a) => a.manual));
  };

  const setSlot = (ref: SlotRef, employeeId: ID | null) => {
    const before = slots.get(ref.shiftId)?.[ref.slot]?.employeeId ?? null;
    saveAssignments((list) => [
      ...list.filter((a) => !(a.shiftId === ref.shiftId && a.slot === ref.slot)),
      { ...ref, employeeId, manual: true },
    ], [before, employeeId].filter((x): x is ID => !!x));
    setPicking(null);
  };

  /** Drag one slot onto another: the two people swap (both become manual). */
  const swap = (from: SlotRef, to: SlotRef) => {
    if (from.shiftId === to.shiftId && from.slot === to.slot) return;
    const a = slots.get(from.shiftId)?.[from.slot]?.employeeId ?? null;
    const b = slots.get(to.shiftId)?.[to.slot]?.employeeId ?? null;
    const same = (x: Assignment, r: SlotRef) => x.shiftId === r.shiftId && x.slot === r.slot;
    saveAssignments((list) => [
      ...list.filter((x) => !same(x, from) && !same(x, to)),
      { ...from, employeeId: b, manual: true },
      { ...to, employeeId: a, manual: true },
    ], [a, b].filter((x): x is ID => !!x));
  };

  const days = daysInMonth(month).filter((d) => shifts.some((s) => s.date === d));
  const team = state.employees.filter((e) => e.teamId === teamId);
  const statsById = new Map((check?.stats ?? []).map((s) => [s.employeeId, s]));

  return (
    <div className="page">
      <div className="toolbar">
        <TeamPicker teamId={teamId} onChange={setTeamId} />
        <MonthPicker month={month} onChange={(m) => { setMonth(m); setMessage(''); }} />
        <div className="toolbar-status">
          {!schedule ? <Pill>Not planned</Pill> : schedule.status === 'published' ? <Pill tone="good">Published</Pill> : <Pill tone="info">Draft</Pill>}
        </div>
        <div className="toolbar-actions">
          <button className="btn primary" onClick={onGenerate} disabled={!shifts.length}>Generate</button>
          {schedule && schedule.status === 'draft' && <button className="btn" onClick={onPublish}>Publish</button>}
          {schedule && schedule.status === 'published' && <button className="btn" onClick={onUnpublish}>Back to draft</button>}
          {schedule && <button className="btn ghost" onClick={onClear}>Clear</button>}
        </div>
      </div>

      {message && <div className="banner info" role="status">{message}</div>}

      {!shifts.length ? (
        <Empty>No shifts set up for {formatMonth(month)} yet. Add them in <strong>Shift setup</strong>, then generate the schedule.</Empty>
      ) : (
        <div className="schedule-layout">
          <section className="days" aria-label="Shifts by day">
            <div className="summary">
              <span><strong>{filled}</strong> of {totalSlots} slots filled</span>
              {check && check.unfilled.length > 0 && <Pill tone="bad">{check.unfilled.length} empty</Pill>}
              {hardWarnings.length > 0 && <Pill tone="bad">{hardWarnings.length} rule break{hardWarnings.length === 1 ? '' : 's'}</Pill>}
              {check && check.warnings.length > hardWarnings.length && <Pill tone="warn">{check.warnings.length - hardWarnings.length} preference{check.warnings.length - hardWarnings.length === 1 ? '' : 's'} missed</Pill>}
              <span className="muted small">Click a name to reassign, or drag it onto another slot to swap.</span>
            </div>
            {days.map((d) => (
              <article key={d} className="day">
                <h3 className="day-title">{formatDate(d)}</h3>
                {shifts.filter((s) => s.date === d).map((s) => (
                  <div key={s.id} className="shift-row">
                    <div className="shift-meta">
                      <span className="time">{formatTimes(s)}</span>
                      {(s.label || s.role) && <span className="muted small">{[s.label, s.role].filter(Boolean).join(' · ')}</span>}
                    </div>
                    <div className="slots">
                      {(slots.get(s.id) ?? []).map((a) => {
                        const k = `${a.shiftId}#${a.slot}`;
                        const v = warningsBySlot.get(k) ?? [];
                        const isHard = v.some((x) => x.hard);
                        const reasons = emptyReasons.get(k);
                        const ref = { shiftId: a.shiftId, slot: a.slot };
                        return (
                          <button
                            key={k}
                            className={cx('slot', !a.employeeId && 'empty', isHard && 'bad', !isHard && v.length > 0 && 'warn', a.manual && 'manual')}
                            draggable={!!a.employeeId}
                            onDragStart={() => setDragging(ref)}
                            onDragEnd={() => setDragging(null)}
                            onDragOver={(e) => dragging && e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); if (dragging) swap(dragging, ref); setDragging(null); }}
                            onClick={() => setPicking(ref)}
                            title={a.employeeId ? v.map((x) => `${nameOf(a.employeeId!)} ${x.message}`).join('\n') || undefined : reasons?.join('\n')}
                          >
                            {a.employeeId ? nameOf(a.employeeId) : 'Empty'}
                            {a.manual && <span className="pin" aria-label="set by hand" title="Set by hand; kept when generating">●</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </article>
            ))}
          </section>

          <aside className="side">
            <section className="card">
              <h3>Hours</h3>
              {!check ? <p className="muted small">Generate the schedule to see hours against each target.</p> : (
                <table className="table compact">
                  <thead><tr><th>Name</th><th>Hours</th><th title="Weekend shifts">We</th><th title="Late shifts">Late</th></tr></thead>
                  <tbody>
                    {team.map((e) => {
                      const st = statsById.get(e.id);
                      if (!st) return null;
                      const share = st.target ? st.hours / st.target : 1;
                      return (
                        <tr key={e.id}>
                          <td>{e.name}</td>
                          <td>
                            <div className="meter" title={`${hoursText(st.hours)} of ${hoursText(st.target)}`}>
                              <span style={{ width: `${Math.min(100, share * 100)}%` }} className={cx(share > 1.1 && 'over', share < 0.8 && 'under')} />
                            </div>
                            <span className="small">{Math.round(st.hours)}/{Math.round(st.target)}</span>
                          </td>
                          <td>{st.weekendShifts}</td>
                          <td>{st.lateShifts}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
            {check && (check.unfilled.length > 0 || check.issues.length > 0 || check.warnings.length > 0) && (
              <section className="card">
                <h3>Needs attention</h3>
                <ul className="issues">
                  {check.unfilled.map((u) => {
                    const s = shifts.find((x) => x.id === u.shiftId)!;
                    return (
                      <li key={`${u.shiftId}#${u.slot}`} className="bad">
                        <button className="link" onClick={() => setPicking({ shiftId: u.shiftId, slot: u.slot })}>{formatDate(u.date)} {formatTimes(s)}</button> is empty
                        <details><summary>Why</summary><ul>{u.reasons.map((r) => <li key={r}>{r}</li>)}</ul></details>
                      </li>
                    );
                  })}
                  {check.issues.map((i, n) => <li key={`i${n}`} className={i.hard ? 'bad' : 'warn'}>{i.date && `${formatDate(i.date)}: `}{i.message}</li>)}
                  {check.warnings.flatMap((w) => w.violations.map((v, n) => {
                    const s = shifts.find((x) => x.id === w.shiftId)!;
                    return (
                      <li key={`${w.shiftId}#${w.slot}#${n}`} className={v.hard ? 'bad' : 'warn'}>
                        <button className="link" onClick={() => setPicking({ shiftId: w.shiftId, slot: w.slot })}>{formatDate(s.date)} {formatTimes(s)}</button>: {nameOf(w.employeeId)} {v.message}
                      </li>
                    );
                  }))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}

      {picking && (
        <ReassignModal
          state={state}
          teamId={teamId}
          month={month}
          target={picking}
          assignments={assignments}
          current={slots.get(picking.shiftId)?.[picking.slot]}
          onPick={(id) => setSlot(picking, id)}
          onRelease={() => {
            saveAssignments((list) => list.map((a) => (a.shiftId === picking.shiftId && a.slot === picking.slot ? { ...a, manual: false } : a)));
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

function ReassignModal({ state, teamId, month, target, assignments, current, onPick, onRelease, onClose }: {
  state: AppState; teamId: ID; month: MonthStr; target: SlotRef; assignments: Assignment[];
  current?: Assignment; onPick: (id: ID | null) => void; onRelease: () => void; onClose: () => void;
}) {
  const shift = state.shifts.find((s) => s.id === target.shiftId);
  const input = scheduleInput(state, teamId, month);
  const options = state.employees
    .filter((e) => e.teamId === teamId)
    .map((e) => ({ e, v: checkCandidate(input, assignments, target.shiftId, target.slot, e.id) }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.e.name.localeCompare(b.e.name));
  if (!shift) return null;
  return (
    <Modal title={`${formatDate(shift.date)} · ${formatTimes(shift)}`} onClose={onClose}
      footer={<>
        {current?.manual && <button className="btn ghost" onClick={onRelease} title="Let Generate change this slot again">Unpin</button>}
        <button className="btn" onClick={() => onPick(null)}>Leave empty</button>
      </>}>
      <p className="muted small">Nothing is blocked. Rule breaks are listed so you can decide.</p>
      <ul className="pick-list">
        {options.map(({ e, v }) => (
          <li key={e.id}>
            <button className={cx('pick', current?.employeeId === e.id && 'on')} onClick={() => onPick(e.id)}>
              <span className="pick-name">{e.name}</span>
              {v.length === 0 ? <Pill tone="good">OK</Pill> : (
                <span className="pick-why">
                  {v.map((x, i) => <Pill key={i} tone={x.hard ? 'bad' : 'warn'}>{x.message}</Pill>)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

const rank = (v: Violation[]) => (v.some((x) => x.hard) ? 2 : v.length ? 1 : 0);

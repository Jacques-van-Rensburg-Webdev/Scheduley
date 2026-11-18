// What an employee sees: their published shifts, notifications, and time-off requests.
// (Prototype: anyone can pick who they are; there are no accounts.)

import { useState } from 'react';
import {
  formatDate, formatMonth, formatRange, formatTimes, requestDays, shiftHours, vacationBalance,
  type ID, type RequestType,
} from '../scheduler';
import { newId, nowIso, useStore } from '../store';
import { Empty, Field, Pill, hoursText, useNames } from './common';

export function EmployeeApp() {
  const { state } = useStore();
  const [me, setMe] = useState<ID>(state.employees[0]?.id ?? '');
  const employee = state.employees.find((e) => e.id === me);
  return (
    <div className="page narrow">
      <div className="toolbar">
        <label className="row gap">
          <span className="muted">Viewing as</span>
          <select value={me} onChange={(e) => setMe(e.target.value)}>
            {state.teams.map((t) => (
              <optgroup key={t.id} label={t.name}>
                {state.employees.filter((e) => e.teamId === t.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      {employee ? <EmployeeHome key={employee.id} id={employee.id} /> : <Empty>No employees yet.</Empty>}
    </div>
  );
}

function EmployeeHome({ id }: { id: ID }) {
  const { state, update } = useStore();
  const { nameOf } = useNames();
  const e = state.employees.find((x) => x.id === id)!;
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);

  const notes = state.notifications.filter((n) => n.employeeId === id);
  const unread = notes.filter((n) => !n.read).length;

  const published = state.schedules.filter((sc) => sc.teamId === e.teamId && sc.status === 'published');
  const shiftById = new Map(state.shifts.map((s) => [s.id, s]));
  const mine = published
    .flatMap((sc) => sc.assignments.filter((a) => a.employeeId === id).map((a) => ({ a, sc, s: shiftById.get(a.shiftId) })))
    .filter((x) => x.s && x.s.date >= today)
    .sort((x, y) => (x.s!.date + x.s!.start).localeCompare(y.s!.date + y.s!.start));
  const coworkers = (shiftId: ID) =>
    published.flatMap((sc) => sc.assignments).filter((a) => a.shiftId === shiftId && a.employeeId && a.employeeId !== id).map((a) => nameOf(a.employeeId!));

  const myRequests = state.requests.filter((r) => r.employeeId === id).sort((a, b) => b.from.localeCompare(a.from));
  const balance = vacationBalance(e, year, state.requests, state.settings);

  const [type, setType] = useState<RequestType>('day_off');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const end = to || from;
  const days = from ? requestDays({ from, to: end }, state.settings, year) : 0;
  const invalid = !from || end < from || from < today;
  const overAllowance = type === 'vacation' && days > balance.remaining - balance.pending;

  const submit = () => {
    update((d) => {
      d.requests.push({ id: newId('q'), employeeId: id, type, from, to: end, note: note.trim() || undefined, status: 'pending', createdAt: nowIso() });
    });
    setFrom(''); setTo(''); setNote('');
  };

  return (
    <>
      <section className="card">
        <div className="row between">
          <h3>Notifications {unread > 0 && <span className="count">{unread}</span>}</h3>
          {unread > 0 && (
            <button className="btn ghost small" onClick={() => update((d) => { d.notifications.forEach((n) => { if (n.employeeId === id) n.read = true; }); })}>Mark all read</button>
          )}
        </div>
        {!notes.length ? <p className="muted small">Nothing new.</p> : (
          <ul className="notes">
            {notes.slice(0, 8).map((n) => (
              <li key={n.id} className={n.read ? 'read' : ''}>{n.text} <span className="muted small">{formatDate(n.createdAt.slice(0, 10))}</span></li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>My shifts</h3>
        {!mine.length ? <p className="muted small">No upcoming shifts in a published schedule.</p> : (
          <ul className="my-shifts">
            {mine.slice(0, 30).map(({ a, s }) => (
              <li key={`${a.shiftId}#${a.slot}`}>
                <span className="date">{formatDate(s!.date)}</span>
                <span className="time">{formatTimes(s!)}</span>
                <span className="muted small">{shiftHours(s!, state.settings)} h{s!.label ? ` · ${s!.label}` : ''}{coworkers(s!.id).length ? ` · with ${coworkers(s!.id).join(', ')}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
        {published.length > 0 && (
          <p className="muted small">
            Published: {published.map((sc) => formatMonth(sc.month)).join(', ')} · this month {hoursText(
              mine.filter((x) => x.s!.date.startsWith(today.slice(0, 7))).reduce((n, x) => n + shiftHours(x.s!, state.settings), 0))} still to work
          </p>
        )}
      </section>

      <section className="card">
        <h3>Request time off</h3>
        <p className="muted small">Vacation {year}: {balance.used} used · {balance.pending} pending · {balance.remaining} of {balance.allowance} days left</p>
        <div className="form-grid">
          <Field label="Type">
            <select value={type} onChange={(ev) => setType(ev.target.value as RequestType)}>
              <option value="day_off">Day off</option><option value="vacation">Vacation</option>
            </select>
          </Field>
          <Field label="From"><input type="date" min={today} value={from} onChange={(ev) => setFrom(ev.target.value)} /></Field>
          <Field label="Until" hint="Leave empty for a single day"><input type="date" min={from || today} value={to} onChange={(ev) => setTo(ev.target.value)} /></Field>
          <Field label="Note for your manager"><input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Optional" /></Field>
        </div>
        {from && <p className="small">{days} open day{days === 1 ? '' : 's'}{overAllowance && <span className="warn-text"> · more than your remaining vacation</span>}</p>}
        <button className="btn primary" disabled={invalid} onClick={submit}>Send request</button>
      </section>

      <section className="card">
        <h3>My requests</h3>
        {!myRequests.length ? <p className="muted small">No requests yet.</p> : (
          <ul className="list">
            {myRequests.map((r) => (
              <li key={r.id} className="row between wrap">
                <span>
                  {r.type === 'vacation' ? 'Vacation' : 'Day off'} · {formatRange(r.from, r.to)}
                  {r.managerComment && <span className="muted small"> · “{r.managerComment}”</span>}
                </span>
                <span className="row gap">
                  <Pill tone={r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'warn' : 'neutral'}>{r.status}</Pill>
                  {r.status === 'pending' && (
                    <button className="btn ghost small" onClick={() => update((d) => { const q = d.requests.find((x) => x.id === r.id); if (q) q.status = 'cancelled'; })}>Cancel</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

import { useState } from 'react';
import {
  addDays, formatRange, requestDays, vacationBalance,
  type RequestStatus, type TimeOffRequest,
} from '../scheduler';
import { notify, nowIso, useStore } from '../store';
import { Empty, Pill, cx, useNames } from './common';

const TYPE_LABEL = { day_off: 'Day off', vacation: 'Vacation' };
const STATUS_TONE: Record<RequestStatus, 'warn' | 'good' | 'bad' | 'neutral'> = { pending: 'warn', approved: 'good', rejected: 'bad', cancelled: 'neutral' };

export function RequestsView() {
  const { state } = useStore();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const list = state.requests
    .filter((r) => filter === 'all' || r.status === 'pending')
    .sort((a, b) => a.from.localeCompare(b.from));
  return (
    <div className="page narrow">
      <div className="toolbar">
        <div className="segmented">
          <button className={cx(filter === 'pending' && 'on')} onClick={() => setFilter('pending')}>Waiting</button>
          <button className={cx(filter === 'all' && 'on')} onClick={() => setFilter('all')}>All requests</button>
        </div>
      </div>
      {!list.length ? <Empty>{filter === 'pending' ? 'No requests waiting for a decision.' : 'No requests yet.'}</Empty> : (
        <ul className="requests">{list.map((r) => <RequestCard key={r.id} r={r} />)}</ul>
      )}
    </div>
  );
}

function RequestCard({ r }: { r: TimeOffRequest }) {
  const { state, update } = useStore();
  const { nameOf } = useNames();
  const [comment, setComment] = useState('');
  const e = state.employees.find((x) => x.id === r.employeeId);
  const days = requestDays(r, state.settings);
  const balance = e ? vacationBalance(e, r.from.slice(0, 4), state.requests, state.settings) : null;

  // Teammates already off on any of these days: helps the decision.
  const alsoOff = new Set<string>();
  for (let d = r.from; d <= r.to; d = addDays(d, 1))
    for (const o of state.requests)
      if (o.id !== r.id && o.status === 'approved' && o.from <= d && d <= o.to && state.employees.find((x) => x.id === o.employeeId)?.teamId === e?.teamId)
        alsoOff.add(o.employeeId);

  const decide = (status: 'approved' | 'rejected') => update((d) => {
    const q = d.requests.find((x) => x.id === r.id);
    if (!q) return;
    Object.assign(q, { status, decidedAt: nowIso(), managerComment: comment.trim() || undefined });
    const what = `${TYPE_LABEL[q.type].toLowerCase()} ${formatRange(q.from, q.to)}`;
    notify(d, q.employeeId, `Your ${what} was ${status}${comment.trim() ? `: “${comment.trim()}”` : '.'}`);
  });

  return (
    <li className="card request">
      <div className="row between">
        <div>
          <strong>{nameOf(r.employeeId)}</strong> · {TYPE_LABEL[r.type]} · {formatRange(r.from, r.to)}
          <span className="muted small"> ({days} open day{days === 1 ? '' : 's'})</span>
        </div>
        <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>
      </div>
      {r.note && <p className="quote">“{r.note}”</p>}
      <div className="row gap wrap small muted">
        {r.type === 'vacation' && balance && <span>Vacation: {balance.used} used, {balance.pending} pending, {balance.remaining} of {balance.allowance} left in {r.from.slice(0, 4)}</span>}
        {alsoOff.size > 0 && <span className="warn-text">Also off then: {[...alsoOff].map(nameOf).join(', ')}</span>}
      </div>
      {r.managerComment && <p className="small">Your comment: “{r.managerComment}”</p>}
      {r.status === 'pending' && (
        <div className="row gap wrap">
          <input className="grow" placeholder="Comment for the employee (optional)" value={comment} onChange={(ev) => setComment(ev.target.value)} />
          <button className="btn primary" onClick={() => decide('approved')}>Approve</button>
          <button className="btn danger" onClick={() => decide('rejected')}>Reject</button>
        </div>
      )}
    </li>
  );
}

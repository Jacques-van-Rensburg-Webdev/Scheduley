import { useState } from 'react';
import {
  WEEKDAY_NAMES, WEEKDAY_ORDER, dayStatus, daysInMonth, formatDate, formatMonth, formatTimes, isOpen, shiftHours, weekday,
  type DateStr, type ID, type MonthStr, type ShiftSpec, type ShiftTemplate,
} from '../scheduler';
import { findSchedule, newId, pruneAssignments, useStore } from '../store';
import { Empty, Field, Modal, MonthPicker, Pill, TeamPicker, cx } from './common';

interface Props {
  teamId: ID;
  setTeamId: (id: ID) => void;
  month: MonthStr;
  setMonth: (m: MonthStr) => void;
}

const STATUS_LABEL = { closed: 'Closed', none: 'No shifts', set: 'Shifts set', full: 'Fully staffed', under: 'Understaffed' };

export function ShiftSetup({ teamId, setTeamId, month, setMonth }: Props) {
  const { state, update } = useStore();
  const [selected, setSelected] = useState<DateStr[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [editing, setEditing] = useState<ShiftTemplate | null>(null);

  const team = state.teams.find((t) => t.id === teamId);
  const templates = state.templates.filter((t) => t.teamId === teamId);
  const schedule = findSchedule(state, teamId, month);
  const shiftsOn = (d: DateStr) => state.shifts.filter((s) => s.teamId === teamId && s.date === d).sort((a, b) => a.start.localeCompare(b.start));

  const days = daysInMonth(month);
  const lead = (weekday(days[0]) + 6) % 7; // Monday-first grid

  const toggle = (d: DateStr, range: boolean) => {
    if (range && selected.length) {
      const last = selected[selected.length - 1];
      const [a, b] = last < d ? [last, d] : [d, last];
      setSelected([...new Set([...selected, ...days.filter((x) => x >= a && x <= b)])]);
    } else setSelected(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d]);
  };

  const apply = (replace: boolean) => {
    const tpl = templates.find((t) => t.id === (templateId || templates[0]?.id));
    if (!tpl) return;
    update((d) => {
      if (replace) d.shifts = d.shifts.filter((s) => !(s.teamId === teamId && selected.includes(s.date)));
      for (const date of selected)
        for (const spec of tpl.shifts) d.shifts.push({ ...structuredClone(spec), id: newId('sh'), teamId, date });
      pruneAssignments(d);
    });
  };

  const clearDays = () => {
    if (!confirm(`Remove all ${team?.name} shifts on ${selected.length} day${selected.length === 1 ? '' : 's'}?`)) return;
    update((d) => {
      d.shifts = d.shifts.filter((s) => !(s.teamId === teamId && selected.includes(s.date)));
      pruneAssignments(d);
    });
  };

  const single = selected.length === 1 ? selected[0] : null;

  return (
    <div className="page">
      <div className="toolbar">
        <TeamPicker teamId={teamId} onChange={(id) => { setTeamId(id); setTemplateId(''); }} />
        <MonthPicker month={month} onChange={(m) => { setMonth(m); setSelected([]); }} />
      </div>

      <div className="setup-layout">
        <section className="card">
          <div className="legend">
            {(['none', 'set', 'full', 'under', 'closed'] as const).map((k) => <span key={k} className={cx('legend-item', `st-${k}`)}>{STATUS_LABEL[k]}</span>)}
          </div>
          <div className="calendar" role="grid" aria-label={`${formatMonth(month)} shifts`}>
            {WEEKDAY_ORDER.map((w) => <div key={w} className="cal-head">{WEEKDAY_NAMES[w]}</div>)}
            {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
            {days.map((d) => {
              const list = shiftsOn(d);
              const st = dayStatus(d, list, schedule?.assignments, state.settings);
              return (
                <button key={d} role="gridcell" aria-selected={selected.includes(d)}
                  className={cx('cal-day', `st-${st}`, selected.includes(d) && 'selected')}
                  onClick={(e) => toggle(d, e.shiftKey)} title={STATUS_LABEL[st]}>
                  <span className="cal-num">{Number(d.slice(8))}</span>
                  {list.length > 0 && <span className="cal-info">{list.length} shift{list.length === 1 ? '' : 's'}</span>}
                </button>
              );
            })}
          </div>
          <p className="muted small">Click days to select them; Shift-click selects a range.</p>
          <div className="row gap wrap">
            <button className="btn ghost" onClick={() => setSelected(days.filter((d) => isOpen(d, state.settings)))}>Select open days</button>
            {WEEKDAY_ORDER.filter((w) => state.settings.closing[w] != null).map((w) => (
              <button key={w} className="btn ghost small" onClick={() => setSelected(days.filter((d) => weekday(d) === w))}>All {WEEKDAY_NAMES[w]}</button>
            ))}
            {selected.length > 0 && <button className="btn ghost" onClick={() => setSelected([])}>Clear selection</button>}
          </div>
        </section>

        <section className="card">
          {!selected.length ? (
            <Empty>Select one or more days to add shifts from a template, or one day to edit its shifts.</Empty>
          ) : (
            <>
              <h3>{single ? formatDate(single) : `${selected.length} days selected`}</h3>
              <div className="row gap wrap">
                <select value={templateId || templates[0]?.id || ''} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.shifts.length})</option>)}
                </select>
                <button className="btn primary" disabled={!templates.length} onClick={() => apply(true)}>Replace with template</button>
                <button className="btn" disabled={!templates.length} onClick={() => apply(false)}>Add template</button>
                <button className="btn ghost danger" onClick={clearDays}>Remove shifts</button>
              </div>
              {single && <DayEditor teamId={teamId} date={single} onSaveTemplate={(shifts) => setEditing({ id: '', teamId, name: `${team?.name ?? ''} · ${WEEKDAY_NAMES[weekday(single)]}`, shifts })} />}
            </>
          )}
        </section>

        <section className="card">
          <div className="row between">
            <h3>Templates</h3>
            <button className="btn small" onClick={() => setEditing({ id: '', teamId, name: `${team?.name ?? ''} · New`, shifts: [] })}>New template</button>
          </div>
          {!templates.length ? <p className="muted small">No templates for this team yet.</p> : (
            <ul className="list">
              {templates.map((t) => (
                <li key={t.id} className="row between">
                  <span>{t.name} <span className="muted small">· {t.shifts.length} shift{t.shifts.length === 1 ? '' : 's'}</span></span>
                  <button className="btn ghost small" onClick={() => setEditing(structuredClone(t))}>Edit</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {editing && <TemplateEditor template={editing} roles={team?.roles ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function DayEditor({ teamId, date, onSaveTemplate }: { teamId: ID; date: DateStr; onSaveTemplate: (shifts: ShiftSpec[]) => void }) {
  const { state, update } = useStore();
  const team = state.teams.find((t) => t.id === teamId);
  const list = state.shifts.filter((s) => s.teamId === teamId && s.date === date).sort((a, b) => a.start.localeCompare(b.start));
  const change = (id: ID, patch: Partial<ShiftSpec>) => update((d) => {
    const s = d.shifts.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
    pruneAssignments(d);
  });
  return (
    <div className="day-editor">
      {!list.length && <p className="muted small">No shifts on this day.</p>}
      {list.map((s) => (
        <ShiftFields key={s.id} spec={s} roles={team?.roles ?? []} hours={shiftHours(s, state.settings)}
          onChange={(p) => change(s.id, p)}
          onRemove={() => update((d) => { d.shifts = d.shifts.filter((x) => x.id !== s.id); pruneAssignments(d); })} />
      ))}
      <div className="row gap">
        <button className="btn small" onClick={() => update((d) => { d.shifts.push({ id: newId('sh'), teamId, date, start: '18:00', end: '23:00', staffNeeded: 1 }); })}>Add shift</button>
        {list.length > 0 && <button className="btn ghost small" onClick={() => onSaveTemplate(list.map(({ start, end, staffNeeded, role, label }) => ({ start, end, staffNeeded, role, label })))}>Save as template</button>}
      </div>
    </div>
  );
}

function ShiftFields({ spec, roles, hours, onChange, onRemove }: {
  spec: ShiftSpec; roles: string[]; hours?: number; onChange: (p: Partial<ShiftSpec>) => void; onRemove: () => void;
}) {
  const untilClose = spec.end === 'close';
  return (
    <div className="shift-fields">
      <Field label="Start"><input type="time" value={spec.start} onChange={(e) => onChange({ start: e.target.value })} /></Field>
      <Field label="End">
        <div className="row gap">
          {untilClose ? <span className="pseudo-input">Close</span> : <input type="time" value={spec.end} onChange={(e) => onChange({ end: e.target.value })} />}
          <label className="check small"><input type="checkbox" checked={untilClose} onChange={(e) => onChange({ end: e.target.checked ? 'close' : '23:00' })} /> until close</label>
        </div>
      </Field>
      <Field label="Staff"><input type="number" min={1} max={10} value={spec.staffNeeded} onChange={(e) => onChange({ staffNeeded: Math.max(1, Number(e.target.value) || 1) })} /></Field>
      <Field label="Role">
        <select value={spec.role ?? ''} onChange={(e) => onChange({ role: e.target.value || undefined })}>
          <option value="">Any</option>
          {roles.map((r) => <option key={r}>{r}</option>)}
        </select>
      </Field>
      <Field label="Label"><input value={spec.label ?? ''} placeholder="Optional" onChange={(e) => onChange({ label: e.target.value || undefined })} /></Field>
      <div className="shift-fields-end">
        {hours != null && <Pill>{formatTimes(spec)} · {hours} h</Pill>}
        <button className="icon-btn" onClick={onRemove} aria-label="Remove shift">×</button>
      </div>
    </div>
  );
}

function TemplateEditor({ template, roles, onClose }: { template: ShiftTemplate; roles: string[]; onClose: () => void }) {
  const { update } = useStore();
  const [draft, setDraft] = useState(template);
  const isNew = !template.id;
  const save = () => {
    update((d) => {
      if (isNew) d.templates.push({ ...draft, id: newId('tpl') });
      else d.templates = d.templates.map((t) => (t.id === draft.id ? draft : t));
    });
    onClose();
  };
  const remove = () => {
    if (!confirm(`Delete the template “${draft.name}”? Shifts already added stay.`)) return;
    update((d) => { d.templates = d.templates.filter((t) => t.id !== draft.id); });
    onClose();
  };
  const setShift = (i: number, p: Partial<ShiftSpec>) => setDraft({ ...draft, shifts: draft.shifts.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  return (
    <Modal title={isNew ? 'New template' : 'Edit template'} onClose={onClose} wide
      footer={<>
        {!isNew && <button className="btn ghost danger" onClick={remove}>Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!draft.name.trim()}>Save</button>
      </>}>
      <Field label="Name"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      {draft.shifts.map((s, i) => (
        <ShiftFields key={i} spec={s} roles={roles} onChange={(p) => setShift(i, p)} onRemove={() => setDraft({ ...draft, shifts: draft.shifts.filter((_, j) => j !== i) })} />
      ))}
      <button className="btn small" onClick={() => setDraft({ ...draft, shifts: [...draft.shifts, { start: '18:00', end: '23:00', staffNeeded: 1 }] })}>Add shift</button>
    </Modal>
  );
}

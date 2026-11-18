import { useState } from 'react';
import {
  appliesTo, effectiveRules, targetHours, vacationBalance,
  type Employee, type ID, type Rule,
} from '../scheduler';
import { newId, useStore } from '../store';
import { Empty, Field, ListInput, Pill, cx, hoursText } from './common';
import { RuleEditor, blankRule } from './RuleEditor';
import { RuleRow } from './RulesView';

export function EmployeesView() {
  const { state, update } = useStore();
  const [selectedId, setSelectedId] = useState<ID | null>(state.employees[0]?.id ?? null);
  const selected = state.employees.find((e) => e.id === selectedId) ?? null;
  const month = new Date().toISOString().slice(0, 7);

  const add = () => {
    const id = newId('emp');
    const teamId = selected?.teamId ?? state.teams[0]?.id ?? '';
    const roles = state.teams.find((t) => t.id === teamId)?.roles.slice(0, 1) ?? [];
    update((d) => {
      d.employees.push({ id, name: 'New employee', teamId, roles, skills: [], contract: { hours: 20, per: 'week' }, vacationAllowance: 24 });
    });
    setSelectedId(id);
  };

  return (
    <div className="page">
      <div className="people-layout">
        <aside className="card">
          <div className="row between">
            <h3>People</h3>
            <button className="btn small" onClick={add}>Add</button>
          </div>
          {state.teams.map((t) => (
            <div key={t.id}>
              <h4 className="muted">{t.name}</h4>
              <ul className="people">
                {state.employees.filter((e) => e.teamId === t.id).map((e) => (
                  <li key={e.id}>
                    <button className={cx('person', e.id === selectedId && 'on')} onClick={() => setSelectedId(e.id)}>
                      <span>{e.name}</span>
                      <span className="muted small">{e.contract.hours} h/{e.contract.per === 'week' ? 'wk' : 'mo'} · {hoursText(targetHours(e, month, state.requests, state.settings))} this month</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>
        {selected ? <Profile key={selected.id} employee={selected} onDeleted={() => setSelectedId(null)} /> : <Empty>Pick someone, or add a new employee.</Empty>}
      </div>
    </div>
  );
}

function Profile({ employee, onDeleted }: { employee: Employee; onDeleted: () => void }) {
  const { state, update } = useStore();
  const [tab, setTab] = useState<'profile' | 'rules'>('profile');
  const [editing, setEditing] = useState<Rule | null>(null);
  const year = new Date().getFullYear().toString();
  const balance = vacationBalance(employee, year, state.requests, state.settings);
  const team = state.teams.find((t) => t.id === employee.teamId);

  const set = (patch: Partial<Employee>) => update((d) => {
    const e = d.employees.find((x) => x.id === employee.id);
    if (e) Object.assign(e, patch);
  });

  const remove = () => {
    if (!confirm(`Remove ${employee.name}? Their shifts become empty and their own rules and requests are deleted.`)) return;
    update((d) => {
      d.employees = d.employees.filter((e) => e.id !== employee.id);
      d.rules = d.rules.filter((r) => !(r.scope.kind === 'employee' && r.scope.employeeId === employee.id));
      d.requests = d.requests.filter((r) => r.employeeId !== employee.id);
      d.notifications = d.notifications.filter((n) => n.employeeId !== employee.id);
      for (const sc of d.schedules)
        for (const a of sc.assignments) if (a.employeeId === employee.id) a.employeeId = null;
    });
    onDeleted();
  };

  // Rules for this person today: their own, plus team/everyone rules, with what's in force marked.
  const today = new Date().toISOString().slice(0, 10);
  const inForce = new Set(effectiveRules(state.rules, employee, today).map((r) => r.id));
  const own = state.rules.filter((r) => r.scope.kind === 'employee' && r.scope.employeeId === employee.id);
  const inherited = state.rules.filter((r) => r.scope.kind !== 'employee' && appliesTo(r, employee) && r.type !== 'min_skill_on_shift');

  return (
    <section className="card profile">
      <div className="row between">
        <h2>{employee.name}</h2>
        <div className="segmented">
          <button className={cx(tab === 'profile' && 'on')} onClick={() => setTab('profile')}>Profile</button>
          <button className={cx(tab === 'rules' && 'on')} onClick={() => setTab('rules')}>Rules ({own.length})</button>
        </div>
      </div>

      {tab === 'profile' ? (
        <>
          <div className="form-grid">
            <Field label="Name"><input value={employee.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Team">
              <select value={employee.teamId} onChange={(e) => set({ teamId: e.target.value })}>
                {state.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Roles" hint={team ? `This team uses: ${team.roles.join(', ')}` : undefined}>
              <ListInput key={`r${employee.id}`} value={employee.roles} onChange={(roles) => set({ roles })} placeholder="Bartender, Closing" />
            </Field>
            <Field label="Skills" hint="e.g. Keyholder, Trainer. Used by coverage rules.">
              <ListInput key={`s${employee.id}`} value={employee.skills} onChange={(skills) => set({ skills })} placeholder="Keyholder" />
            </Field>
            <Field label="Contract hours">
              <div className="row gap">
                <input type="number" min={0} max={80} value={employee.contract.hours} onChange={(e) => set({ contract: { ...employee.contract, hours: Number(e.target.value) } })} />
                <select value={employee.contract.per} onChange={(e) => set({ contract: { ...employee.contract, per: e.target.value as 'week' | 'month' } })}>
                  <option value="week">per week</option><option value="month">per month</option>
                </select>
              </div>
            </Field>
            <Field label="Vacation days per year"><input type="number" min={0} max={60} value={employee.vacationAllowance} onChange={(e) => set({ vacationAllowance: Number(e.target.value) })} /></Field>
            <Field label="Email"><input type="email" value={employee.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Phone"><input type="tel" value={employee.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
          </div>
          <div className="row gap wrap">
            <Pill tone="info">Vacation {year}: {balance.used} used · {balance.pending} pending · {balance.remaining} of {balance.allowance} left</Pill>
          </div>
          <div className="row end"><button className="btn ghost danger" onClick={remove}>Remove employee</button></div>
        </>
      ) : (
        <>
          <div className="row between">
            <h3>{employee.name}'s own rules</h3>
            <button className="btn small primary" onClick={() => setEditing(blankRule({ kind: 'employee', employeeId: employee.id }))}>Add rule</button>
          </div>
          {!own.length ? <p className="muted small">No personal rules. The team and everyone rules below apply.</p> : (
            <ul className="rules">{own.map((r) => <RuleRow key={r.id} rule={r} onEdit={() => setEditing(r)} />)}</ul>
          )}
          <h3>From the team and everyone</h3>
          <ul className="rules">
            {inherited.map((r) => (
              <RuleRow key={r.id} rule={r} onEdit={() => setEditing(r)}
                note={!inForce.has(r.id) && r.enabled ? `Doesn't apply to ${employee.name} today: a more specific rule replaces it, or it's outside its dates.` : undefined} />
            ))}
          </ul>
        </>
      )}
      {editing && <RuleEditor rule={editing} lockScope={editing.scope.kind === 'employee'} onClose={() => setEditing(null)} />}
    </section>
  );
}

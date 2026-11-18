import { useState } from 'react';
import {
  KIND_NAMES, RULE_TYPE, RULE_TYPES, defaultParams, feasibilityDelta, formatDate, formatTimes,
  type FeasibilityReport, type FieldDef, type ID, type Priority, type Rule, type RuleScope,
} from '../scheduler';
import { newId, scheduleInput, useStore } from '../store';
import { ChipToggles, Field, Modal, WeekdayPicker, useNames } from './common';

/** A blank rule for the editor; `scope` presets who it's for. */
export const blankRule = (scope: RuleScope = { kind: 'all' }): Rule => {
  const type = RULE_TYPES.find((t) => t.scopes.includes(scope.kind))!.id;
  return { id: '', type, scope, params: defaultParams(type), strength: 'required', priority: 'medium', enabled: true };
};

const KIND_OPTIONS: [string, string][] = [['day', 'Day'], ['evening', 'Evening'], ['close', 'Until close']];

export function RuleEditor({ rule, lockScope, onClose }: { rule: Rule; lockScope?: boolean; onClose: () => void }) {
  const { state, update } = useStore();
  const { nameOf } = useNames();
  const [draft, setDraft] = useState<Rule>(structuredClone(rule));
  const [report, setReport] = useState<FeasibilityReport | null>(null);
  const isNew = !rule.id;
  const type = RULE_TYPE[draft.type];
  const types = RULE_TYPES.filter((t) => t.scopes.includes(draft.scope.kind));

  const set = (patch: Partial<Rule>) => { setDraft({ ...draft, ...patch }); setReport(null); };
  const setParam = (key: string, value: unknown) => set({ params: { ...draft.params, [key]: value } });
  const setType = (id: string) => set({ type: id, params: defaultParams(id), strength: RULE_TYPE[id].softOnly ? 'preferred' : draft.strength });
  const setScope = (scope: RuleScope) => {
    const allowed = RULE_TYPE[draft.type].scopes.includes(scope.kind);
    const next = allowed ? draft.type : RULE_TYPES.find((t) => t.scopes.includes(scope.kind))!.id;
    setDraft({ ...draft, scope, type: next, params: allowed ? draft.params : defaultParams(next) });
    setReport(null);
  };

  const missing = type.fields.some((f) => !f.optional && f.kind === 'employee' && !draft.params[f.key]);

  const commit = () => {
    update((d) => {
      if (isNew) d.rules.push({ ...draft, id: newId('rule') });
      else d.rules = d.rules.map((r) => (r.id === draft.id ? draft : r));
    });
    onClose();
  };

  /** Re-plans the affected teams' upcoming months with and without the change before saving. */
  const save = () => {
    if (report) return commit();
    const after = isNew ? [...state.rules, { ...draft, id: '__new' }] : state.rules.map((r) => (r.id === draft.id ? draft : r));
    const teamIds = draft.scope.kind === 'all' ? state.teams.map((t) => t.id)
      : draft.scope.kind === 'team' ? [draft.scope.teamId]
      : [state.employees.find((e) => e.id === (draft.scope as { employeeId: ID }).employeeId)?.teamId].filter((x): x is ID => !!x);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const months = [...new Set(state.shifts.map((s) => s.date.slice(0, 7)))].filter((m) => m >= thisMonth).sort().slice(0, 2);
    const inputs = teamIds.flatMap((t) => months.map((m) => scheduleInput(state, t, m)));
    const rep = feasibilityDelta(inputs, state.rules, after);
    if (!rep.newUnfilled.length && !rep.newIssues.length) return commit();
    setReport(rep);
  };

  const remove = () => {
    if (!confirm('Delete this rule?')) return;
    update((d) => { d.rules = d.rules.filter((r) => r.id !== rule.id); });
    onClose();
  };

  const field = (f: FieldDef) => {
    const v = draft.params[f.key];
    switch (f.kind) {
      case 'number':
        return <input type="number" min={f.min} max={f.max} value={Number(v ?? 0)} onChange={(e) => setParam(f.key, Number(e.target.value))} />;
      case 'time':
        return <input type="time" value={String(v ?? '')} onChange={(e) => setParam(f.key, e.target.value)} />;
      case 'weekdays':
        return <WeekdayPicker value={(v as number[]) ?? []} onChange={(x) => setParam(f.key, x)} />;
      case 'shiftKinds':
        return <ChipToggles options={KIND_OPTIONS} value={(v as string[]) ?? []} onChange={(x) => setParam(f.key, x)} />;
      case 'shiftKind':
        return (
          <select value={String(v)} onChange={(e) => setParam(f.key, e.target.value)}>
            {[...KIND_OPTIONS.map(([k]) => k), 'any'].map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
          </select>
        );
      case 'skill': {
        const skills = [...new Set(state.employees.flatMap((e) => e.skills))].sort();
        return (
          <select value={String(v ?? '')} onChange={(e) => setParam(f.key, e.target.value)}>
            <option value="">Anyone</option>
            {skills.map((s) => <option key={s}>{s}</option>)}
          </select>
        );
      }
      case 'employee': {
        const self = draft.scope.kind === 'employee' ? draft.scope.employeeId : '';
        return (
          <select value={String(v ?? '')} onChange={(e) => setParam(f.key, e.target.value)}>
            <option value="">Choose…</option>
            {state.employees.filter((e) => e.id !== self).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        );
      }
    }
  };

  return (
    <Modal title={isNew ? 'New rule' : 'Edit rule'} onClose={onClose} wide
      footer={<>
        {!isNew && <button className="btn ghost danger" onClick={remove}>Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={report ? 'btn danger' : 'btn primary'} onClick={save} disabled={missing}>{report ? 'Save anyway' : 'Save'}</button>
      </>}>
      <div className="form-grid">
        {!lockScope && (
          <Field label="Applies to">
            <select
              value={draft.scope.kind === 'all' ? 'all' : draft.scope.kind === 'team' ? `team:${draft.scope.teamId}` : `emp:${draft.scope.employeeId}`}
              onChange={(e) => {
                const [k, id] = e.target.value.split(':');
                setScope(k === 'all' ? { kind: 'all' } : k === 'team' ? { kind: 'team', teamId: id } : { kind: 'employee', employeeId: id });
              }}>
              <option value="all">Everyone</option>
              <optgroup label="Team">{state.teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name}</option>)}</optgroup>
              <optgroup label="Person">{state.employees.map((e) => <option key={e.id} value={`emp:${e.id}`}>{e.name}</option>)}</optgroup>
            </select>
          </Field>
        )}
        <Field label="Rule" hint={type.description}>
          <select value={draft.type} onChange={(e) => setType(e.target.value)} disabled={!isNew}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        {type.fields.map((f) => <Field key={f.key} label={f.label}>{field(f)}</Field>)}
        <Field label="Strength" hint={type.softOnly ? 'This kind of rule is always a preference.' : draft.strength === 'required' ? 'Never broken by the scheduler.' : 'Avoided where possible.'}>
          <div className="segmented">
            <button type="button" className={draft.strength === 'required' ? 'on' : ''} disabled={type.softOnly} onClick={() => set({ strength: 'required' })}>Required</button>
            <button type="button" className={draft.strength === 'preferred' ? 'on' : ''} onClick={() => set({ strength: 'preferred' })}>Preferred</button>
          </div>
        </Field>
        {draft.strength === 'preferred' && (
          <Field label="Priority">
            <select value={draft.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </Field>
        )}
        <Field label="From (optional)"><input type="date" value={draft.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} /></Field>
        <Field label="Until (optional)"><input type="date" value={draft.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} /></Field>
        <label className="check"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
      </div>

      {report && (
        <div className="banner bad" role="alert">
          <strong>This change makes the schedule harder to fill.</strong>
          {report.newUnfilled.length > 0 && (
            <p>{report.newUnfilled.length} more slot{report.newUnfilled.length === 1 ? '' : 's'} would stay empty, e.g. {report.newUnfilled.slice(0, 3).map((u) => {
              const s = state.shifts.find((x) => x.id === u.shiftId);
              return s ? `${formatDate(u.date)} ${formatTimes(s)}` : formatDate(u.date);
            }).join(', ')}.</p>
          )}
          {report.newIssues.slice(0, 4).map((i, n) => <p key={n}>{i.message}{i.employeeId ? ` (${nameOf(i.employeeId)})` : ''}</p>)}
          <p className="small">Save anyway, or change the rule.</p>
        </div>
      )}
    </Modal>
  );
}

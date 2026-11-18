import { useState } from 'react';
import { RULE_TYPE, describeRule, formatDate, ruleOverrides, scopeLabel, type Rule } from '../scheduler';
import { useStore } from '../store';
import { Empty, Pill, cx, useNames } from './common';
import { RuleEditor, blankRule } from './RuleEditor';

/** One rule as a row: what it says, who it's for, how strong, and any override notice. */
export function RuleRow({ rule, onEdit, overriddenBy, note }: { rule: Rule; onEdit: () => void; overriddenBy?: Rule[]; note?: string }) {
  const { update } = useStore();
  const { nameOf, teamName } = useNames();
  const toggle = () => update((d) => {
    const r = d.rules.find((x) => x.id === rule.id);
    if (r) r.enabled = !r.enabled;
  });
  return (
    <li className={cx('rule', !rule.enabled && 'off')}>
      <label className="switch" title={rule.enabled ? 'Enabled' : 'Disabled'}>
        <input type="checkbox" checked={rule.enabled} onChange={toggle} aria-label="Enabled" />
        <span />
      </label>
      <button className="rule-main" onClick={onEdit}>
        <span className="rule-text">{describeRule(rule, nameOf)}</span>
        <span className="rule-meta">
          <Pill>{scopeLabel(rule, teamName, nameOf)}</Pill>
          {rule.strength === 'required' && !RULE_TYPE[rule.type]?.softOnly
            ? <Pill tone="info">Required</Pill>
            : <Pill tone="warn">Preferred · {rule.priority}</Pill>}
          {(rule.from || rule.to) && <Pill>{rule.from ? formatDate(rule.from) : '…'} – {rule.to ? formatDate(rule.to) : '…'}</Pill>}
        </span>
        {overriddenBy && overriddenBy.length > 0 && (
          <span className="notice">Replaced for {overriddenBy.map((r) => scopeLabel(r, teamName, nameOf)).join(', ')} by a more specific rule.</span>
        )}
        {note && <span className="notice">{note}</span>}
      </button>
    </li>
  );
}

export function RulesView() {
  const { state } = useStore();
  const { nameOf } = useNames();
  const [editing, setEditing] = useState<Rule | null>(null);
  const overrides = ruleOverrides(state.rules, state.employees);
  const overriddenBy = (r: Rule) => overrides.filter((o) => o.overridden.id === r.id).map((o) => o.rule);

  const groups: [string, Rule[]][] = [
    ['Everyone', state.rules.filter((r) => r.scope.kind === 'all')],
    ...state.teams.map((t): [string, Rule[]] => [`Team: ${t.name}`, state.rules.filter((r) => r.scope.kind === 'team' && r.scope.teamId === t.id)]),
    ['People', state.rules.filter((r) => r.scope.kind === 'employee')
      .sort((a, b) => nameOf((a.scope as { employeeId: string }).employeeId).localeCompare(nameOf((b.scope as { employeeId: string }).employeeId)))],
  ];

  return (
    <div className="page narrow">
      <div className="toolbar">
        <p className="muted grow">The most specific rule wins: a person's own rule, then their team's, then the rule for everyone.</p>
        <button className="btn primary" onClick={() => setEditing(blankRule())}>New rule</button>
      </div>
      {!state.rules.length && <Empty>No rules yet.</Empty>}
      {groups.filter(([, list]) => list.length).map(([title, list]) => (
        <section key={title} className="card">
          <h3>{title}</h3>
          <ul className="rules">
            {list.map((r) => <RuleRow key={r.id} rule={r} onEdit={() => setEditing(r)} overriddenBy={overriddenBy(r)} />)}
          </ul>
        </section>
      ))}
      <p className="muted small">Person rules are also on each employee's Rules tab.</p>
      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

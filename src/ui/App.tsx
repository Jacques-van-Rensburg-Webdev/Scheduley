import { useCallback, useMemo, useState } from 'react';
import { seed } from '../seed';
import { StoreContext, loadState, saveState, type AppState, type Update } from '../store';
import { cx } from './common';
import { ScheduleView } from './ScheduleView';
import { ShiftSetup } from './ShiftSetup';
import { RequestsView } from './RequestsView';
import { EmployeesView } from './EmployeesView';
import { RulesView } from './RulesView';
import { SettingsView } from './SettingsView';
import { EmployeeApp } from './EmployeeApp';

type Tab = 'schedule' | 'shifts' | 'requests' | 'employees' | 'rules' | 'settings';

const TABS: [Tab, string][] = [
  ['schedule', 'Schedule'],
  ['shifts', 'Shift setup'],
  ['requests', 'Requests'],
  ['employees', 'Employees'],
  ['rules', 'Rules'],
  ['settings', 'Settings'],
];

export function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? seed());
  const [saveFailed, setSaveFailed] = useState(false);
  const update: Update = useCallback((change) => {
    setState((prev) => {
      const draft = structuredClone(prev);
      change(draft);
      setSaveFailed(!saveState(draft));
      return draft;
    });
  }, []);
  const store = useMemo(() => ({ state, update }), [state, update]);

  const [mode, setMode] = useState<'manager' | 'employee'>('manager');
  const [tab, setTab] = useState<Tab>('schedule');
  const [teamId, setTeamId] = useState(state.teams[0]?.id ?? '');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const pending = state.requests.filter((r) => r.status === 'pending').length;

  return (
    <StoreContext.Provider value={store}>
      <div className="app">
        <header className="topbar">
          <div className="brand"><span className="logo" aria-hidden>▦</span> Scheduley</div>
          {mode === 'manager' && (
            <nav className="tabs" aria-label="Sections">
              {TABS.map(([id, label]) => (
                <button key={id} className={cx('tab', tab === id && 'on')} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
                  {label}
                  {id === 'requests' && pending > 0 && <span className="count">{pending}</span>}
                </button>
              ))}
            </nav>
          )}
          <div className="segmented mode" aria-label="View">
            <button className={cx(mode === 'manager' && 'on')} onClick={() => setMode('manager')}>Manager</button>
            <button className={cx(mode === 'employee' && 'on')} onClick={() => setMode('employee')}>Employee view</button>
          </div>
        </header>
        {saveFailed && <div className="banner bad">Couldn't save to this browser's storage. Changes will be lost when the page closes.</div>}
        <main className="content">
          {mode === 'employee' ? <EmployeeApp /> : (
            <>
              {tab === 'schedule' && <ScheduleView teamId={teamId} setTeamId={setTeamId} month={month} setMonth={setMonth} />}
              {tab === 'shifts' && <ShiftSetup teamId={teamId} setTeamId={setTeamId} month={month} setMonth={setMonth} />}
              {tab === 'requests' && <RequestsView />}
              {tab === 'employees' && <EmployeesView />}
              {tab === 'rules' && <RulesView />}
              {tab === 'settings' && <SettingsView />}
            </>
          )}
        </main>
      </div>
    </StoreContext.Provider>
  );
}

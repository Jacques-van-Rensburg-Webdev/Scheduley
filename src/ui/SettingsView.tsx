import { useRef } from 'react';
import { WEEKDAY_NAMES, WEEKDAY_ORDER } from '../scheduler';
import { seed } from '../seed';
import { useStore, type AppState } from '../store';
import { Field, ListInput } from './common';

export function SettingsView() {
  const { state, update } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const setClosing = (w: number, value: string | null) => update((d) => { d.settings.closing[w] = value; });

  const exportData = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scheduley-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importData = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as AppState;
      if (data.version !== 1 || !Array.isArray(data.employees) || !Array.isArray(data.shifts)) throw new Error('not a Scheduley file');
      if (!confirm('Replace all current data with this file?')) return;
      update((d) => Object.assign(d, data));
    } catch (e) {
      alert(`Couldn't import: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page narrow">
      <section className="card">
        <h3>Opening hours</h3>
        <p className="muted small">"Until close" shifts end at that day's closing time. Closed days get no shifts by default.</p>
        <table className="table">
          <tbody>
            {WEEKDAY_ORDER.map((w) => {
              const value = state.settings.closing[w];
              return (
                <tr key={w}>
                  <th>{WEEKDAY_NAMES[w]}</th>
                  <td>
                    <label className="check"><input type="checkbox" checked={value != null} onChange={(e) => setClosing(w, e.target.checked ? '23:00' : null)} /> Open</label>
                  </td>
                  <td>{value != null && <label className="row gap">closes <input type="time" value={value} onChange={(e) => setClosing(w, e.target.value)} /></label>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Teams</h3>
        <p className="muted small">Teams never share people. Roles are what a shift can ask for.</p>
        {state.teams.map((t, i) => (
          <div key={t.id} className="form-grid">
            <Field label="Team name"><input value={t.name} onChange={(e) => update((d) => { d.teams[i].name = e.target.value; })} /></Field>
            <Field label="Roles"><ListInput value={t.roles} onChange={(roles) => update((d) => { d.teams[i].roles = roles; })} /></Field>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>Data</h3>
        <p className="muted small">Everything is saved in this browser only. Export a copy to keep it safe or move it to another device.</p>
        <div className="row gap wrap">
          <button className="btn" onClick={exportData}>Export JSON</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])} />
          <button className="btn danger" onClick={() => confirm('Replace everything with the demo data?') && update((d) => Object.assign(d, seed()))}>Reset demo data</button>
        </div>
      </section>
    </div>
  );
}

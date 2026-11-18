// Small shared building blocks for the screens.

import { useEffect, useRef, type ReactNode } from 'react';
import {
  WEEKDAY_NAMES, WEEKDAY_ORDER, addMonths, formatMonth, type ID, type MonthStr,
} from '../scheduler';
import { useStore } from '../store';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/** Looks up a person's name by id ("someone" if they no longer exist). */
export function useNames() {
  const { state } = useStore();
  const people = new Map(state.employees.map((e) => [e.id, e.name]));
  const teams = new Map(state.teams.map((t) => [t.id, t.name]));
  return {
    nameOf: (id: ID) => people.get(id) ?? 'someone',
    teamName: (id: ID) => teams.get(id) ?? 'a team',
  };
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.icon-btn)')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function MonthPicker({ month, onChange }: { month: MonthStr; onChange: (m: MonthStr) => void }) {
  return (
    <div className="month-picker">
      <button className="btn ghost" onClick={() => onChange(addMonths(month, -1))} aria-label="Previous month">‹</button>
      <strong>{formatMonth(month)}</strong>
      <button className="btn ghost" onClick={() => onChange(addMonths(month, 1))} aria-label="Next month">›</button>
    </div>
  );
}

export function TeamPicker({ teamId, onChange }: { teamId: ID; onChange: (id: ID) => void }) {
  const { state } = useStore();
  return (
    <div className="segmented" role="tablist" aria-label="Team">
      {state.teams.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === teamId} className={cx(t.id === teamId && 'on')} onClick={() => onChange(t.id)}>
          {t.name}
        </button>
      ))}
    </div>
  );
}

export function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="chips">
      {WEEKDAY_ORDER.map((w) => {
        const on = value.includes(w);
        return (
          <button type="button" key={w} className={cx('chip', on && 'on')} aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== w) : [...value, w].sort())}>
            {WEEKDAY_NAMES[w]}
          </button>
        );
      })}
    </div>
  );
}

export function ChipToggles({ options, value, onChange }: { options: [string, string][]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="chips">
      {options.map(([key, label]) => {
        const on = value.includes(key);
        return (
          <button type="button" key={key} className={cx('chip', on && 'on')} aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== key) : [...value, key])}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Comma-separated text input for small lists (roles, skills). */
export function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <input
      defaultValue={value.join(', ')}
      placeholder={placeholder}
      onBlur={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
    />
  );
}

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export const Pill = ({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode; title?: string }) =>
  <span className={cx('pill', tone)} title={title}>{children}</span>;

export const hoursText = (h: number) => `${Math.round(h * 10) / 10} h`;

// App state and its persistence in localStorage. Every change goes through `update`, which
// works on a copy and saves it, so screens never mutate shared state directly.

import { createContext, useContext } from 'react';
import type {
  Employee, ID, MonthStr, Rule, Schedule, ScheduleInput, Settings, Shift, ShiftTemplate, Team, TimeOffRequest,
} from './scheduler';

export interface Notification {
  id: ID;
  employeeId: ID;
  text: string;
  createdAt: string;
  read: boolean;
}

export interface AppState {
  version: 1;
  teams: Team[];
  settings: Settings;
  employees: Employee[];
  shifts: Shift[];
  templates: ShiftTemplate[];
  requests: TimeOffRequest[];
  rules: Rule[];
  schedules: Schedule[];
  notifications: Notification[];
}

export const STORAGE_KEY = 'scheduley';

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as AppState) : null;
    return data?.version === 1 ? data : null;
  } catch {
    return null;
  }
}

export function saveState(state: AppState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export type Update = (change: (draft: AppState) => void) => void;

export const StoreContext = createContext<{ state: AppState; update: Update } | null>(null);

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside <StoreContext>');
  return ctx;
}

let counter = 0;
export const newId = (prefix: string): ID => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

export const nowIso = () => new Date().toISOString();

export const notify = (draft: AppState, employeeId: ID, text: string) => {
  draft.notifications.unshift({ id: newId('n'), employeeId, text, createdAt: nowIso(), read: false });
};

export const findSchedule = (state: AppState, teamId: ID, month: MonthStr) =>
  state.schedules.find((s) => s.teamId === teamId && s.month === month);

/** The scheduler input for one team's month. */
export const scheduleInput = (state: AppState, teamId: ID, month: MonthStr): ScheduleInput => ({
  teamId, month,
  employees: state.employees, shifts: state.shifts, requests: state.requests, rules: state.rules, settings: state.settings,
});

/** Drops assignments that point at shifts (or slots) that no longer exist. */
export function pruneAssignments(draft: AppState) {
  const need = new Map(draft.shifts.map((s) => [s.id, s.staffNeeded]));
  for (const sc of draft.schedules)
    sc.assignments = sc.assignments.filter((a) => a.slot < (need.get(a.shiftId) ?? 0));
}

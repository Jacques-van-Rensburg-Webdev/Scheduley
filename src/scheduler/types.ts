// Data models shared by the scheduler and the app. Plain data only, so everything can be
// saved as JSON and the scheduler stays independent of the UI.

export type ID = string;
/** Calendar date, "YYYY-MM-DD". */
export type DateStr = string;
/** Calendar month, "YYYY-MM". */
export type MonthStr = string;
/** Clock time, "HH:MM". */
export type TimeStr = string;

export interface Team {
  id: ID;
  name: string;
  /** Roles a shift in this team can ask for (e.g. Bartender, Closing). */
  roles: string[];
}

export interface Settings {
  /** Closing time per JS weekday (0 = Sunday … 6 = Saturday); null = closed that day. */
  closing: (TimeStr | null)[];
}

export interface Contract {
  hours: number;
  per: 'week' | 'month';
}

export interface Employee {
  id: ID;
  name: string;
  teamId: ID;
  roles: string[];
  /** Skills such as Keyholder or Trainer, used by coverage rules. */
  skills: string[];
  email?: string;
  phone?: string;
  contract: Contract;
  /** Vacation days per calendar year. */
  vacationAllowance: number;
}

/** A shift without a date: what templates are made of. */
export interface ShiftSpec {
  start: TimeStr;
  /** A clock time, or "close" for a shift that runs until that day's closing time. */
  end: TimeStr | 'close';
  staffNeeded: number;
  role?: string;
  label?: string;
}

export interface Shift extends ShiftSpec {
  id: ID;
  teamId: ID;
  date: DateStr;
}

export interface ShiftTemplate {
  id: ID;
  teamId: ID;
  name: string;
  shifts: ShiftSpec[];
}

export type RequestType = 'day_off' | 'vacation';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface TimeOffRequest {
  id: ID;
  employeeId: ID;
  type: RequestType;
  from: DateStr;
  to: DateStr;
  note?: string;
  status: RequestStatus;
  managerComment?: string;
  createdAt: string;
  decidedAt?: string;
}

export type RuleScope =
  | { kind: 'all' }
  | { kind: 'team'; teamId: ID }
  | { kind: 'employee'; employeeId: ID };

/** Required = a hard rule the scheduler never breaks; Preferred = a cost it tries to avoid. */
export type Strength = 'required' | 'preferred';
export type Priority = 'low' | 'medium' | 'high';

export interface Rule {
  id: ID;
  /** A rule type id from the registry in rules.ts. */
  type: string;
  scope: RuleScope;
  params: Record<string, unknown>;
  strength: Strength;
  priority: Priority;
  enabled: boolean;
  /** Optional date range the rule applies in (inclusive). */
  from?: DateStr;
  to?: DateStr;
}

export interface Assignment {
  shiftId: ID;
  slot: number;
  /** null = the slot is empty. */
  employeeId: ID | null;
  /** Set by the manager by hand; kept when the month is generated again. */
  manual?: boolean;
}

export interface Schedule {
  teamId: ID;
  month: MonthStr;
  status: 'draft' | 'published';
  assignments: Assignment[];
  generatedAt?: string;
  publishedAt?: string;
}

/** Everything the scheduler needs to plan one team for one month. */
export interface ScheduleInput {
  teamId: ID;
  month: MonthStr;
  employees: Employee[];
  shifts: Shift[];
  requests: TimeOffRequest[];
  rules: Rule[];
  settings: Settings;
  /** Assignments to keep as they are (the manual ones). */
  fixed?: Assignment[];
}

export interface Violation {
  /** Rule type id, or a built-in code: team, role, time_off, overlap, duplicate. */
  code: string;
  /** Reads after the person's name, e.g. "has an approved day off". */
  message: string;
  /** true = built-in or Required; false = Preferred. */
  hard: boolean;
  ruleId?: ID;
  /** Cost of a Preferred violation (0 for hard ones). */
  weight: number;
}

export interface Unfilled {
  shiftId: ID;
  slot: number;
  date: DateStr;
  /** Why each person was ruled out, e.g. "Ryan has an approved day off". */
  reasons: string[];
}

export interface EmployeeStats {
  employeeId: ID;
  hours: number;
  target: number;
  shifts: number;
  weekendShifts: number;
  lateShifts: number;
}

/** A shortfall that can only be judged on the whole month (coverage, minimum shifts). */
export interface Issue {
  message: string;
  hard: boolean;
  date?: DateStr;
  shiftId?: ID;
  employeeId?: ID;
  ruleId?: ID;
}

export interface ScheduleResult {
  assignments: Assignment[];
  unfilled: Unfilled[];
  stats: EmployeeStats[];
  issues: Issue[];
}

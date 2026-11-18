# Scheduley

Staff scheduling for a bar: set up the month's shifts, generate a fair schedule that respects every rule, adjust it by hand, publish it, and handle time-off requests.

**Live demo:** https://jacques-van-rensburg-webdev.github.io/Scheduley/

Browser-only: React + TypeScript + Vite, with all data saved in the browser (localStorage). The scheduler is a separate, framework-free module in `src/scheduler/` with its own tests.

```
npm install
npm run dev        # local dev server
npm test           # scheduler unit tests (Vitest)
npm run build      # type-check + build: dist/index.html (the app) + dist/highs.wasm (the optimiser)
```

Every push to `main` runs the tests, builds, and deploys to GitHub Pages (`.github/workflows/deploy.yml`).

## What it does

- **Shift setup:** a month calendar coloured by status (no shifts, set, fully staffed, understaffed, closed). Select days and fill them from a template, or edit a day's shifts: times, "until close", staff needed, role, label.
- **Schedule:** generate a month for one team (instant), optionally **Optimise** it (a few seconds, finds better plans for tight months), see each person's hours against their target and their weekend and late shifts, and fix things by hand. Click a name to reassign it (the menu shows what each choice would break), or drag it onto another slot to swap. Empty slots and rule breaks are flagged with the reason. Publish when it's ready.
- **Requests:** approve or reject days off and vacation, with a comment. Shows the person's vacation balance and who else is already off.
- **Employees:** profiles with team, roles, skills, contract and vacation allowance, plus a Rules tab with the person's own rules and the ones they inherit.
- **Rules:** a registry of rule types (rest, consecutive days, shifts per week, hours per day or shift, weekends off, coverage, availability, shift types, preferences, don't-schedule-with, must-work-with). Each rule is Required or Preferred (with a priority), and can be limited to a date range.
- **Employee view:** what staff see: their published shifts and who they work with, notifications, time-off requests and vacation balance.
- **Settings:** opening hours, teams and roles, JSON export/import, and a reset to the demo data.

## Layout

| Path | What it is |
|---|---|
| `src/scheduler/types.ts` | Data models: Team, Settings, Employee, Shift, ShiftTemplate, TimeOffRequest, Rule, Schedule, Assignment |
| `src/scheduler/time.ts` | Dates, shift times, until-close shifts, overlaps, rest gaps, formatting |
| `src/scheduler/rules.ts` | **Rule-type registry**: fields, summary text and check for every rule type; rule precedence and overrides |
| `src/scheduler/engine.ts` | `generate`, `validate`, `checkCandidate`, `feasibilityDelta`, hours targets, vacation balance, calendar status |
| `src/scheduler/solver.ts` | `optimise`: the month as a mixed-integer program solved with HiGHS (WebAssembly) |
| `src/scheduler/solver.test.ts` | Optimiser tests |
| `src/scheduler/scheduler.test.ts` | Unit tests |
| `src/store.ts` | App state, localStorage persistence, notifications |
| `src/seed.ts` | Demo data: the bar's staff and the shift pattern from the weekly sheet (placeholder contracts) |
| `src/ui/optimiser*.ts` | Runs the optimiser in a Web Worker so the page stays responsive |
| `src/ui/*` | Screens: schedule, shift setup, requests, employees, rules (+ rule editor), settings, employee view |

To add a rule type, add one entry to `RULE_TYPES` in `rules.ts` (fields, summary, check) with a test. The rule editor builds its form from the fields.

## How the scheduling algorithm works

The scheduler plans **one team for one month**. Teams never share people.

1. **Collect the slots.** Each shift needs `staffNeeded` people, so a shift with 2 staff is two slots. An "until close" shift ends at that weekday's closing time (Thu–Sat 01:00, otherwise 23:00).
2. **Work out each person's target.** The target is the contract converted to the month, minus approved vacation:
   - weekly hours × days in month ÷ 7, or the monthly figure for a monthly contract;
   - each approved vacation day on an open day is worth weekly hours ÷ 5.
3. **Hardest shifts first.** For every shift, count how many people could ever work it: right team, right role, no approved time off, and their rules allow it. The shifts with the fewest possible people per slot are filled first, so they don't lose their only candidates to easier shifts.
4. **Fill each slot greedily.** For each slot, drop every candidate who would break a **hard rule**, checked against everything planned so far:
   - Built in: approved day off or vacation; team and role match; no overlapping shift.
   - Every **Required** rule that applies to the person: rest hours, max consecutive days, max shifts per week, max hours per day or per shift, weekends off, unavailable days or times, shift types, don't-schedule-with, must-work-with.
   - Required coverage: if the shift still needs a Keyholder and the remaining slots are only just enough, only Keyholders may take this one.

   The remaining candidates are scored, and the highest score gets the slot:
   - **Hours:** the biggest gain goes to whoever is furthest below their target, measured relative to the size of their contract. When there are more contract hours than shifts, everyone falls short by about the same share of their contract.
   - **Fair share:** a penalty for people who already have more weekend (Sat/Sun) or late (until close / past midnight) shifts than the team average.
   - **Preferred rules:** each broken Preferred rule costs points by priority (low 10, medium 30, high 80). A matching "prefers" rule costs nothing.
   - **Bonuses:** for someone below their minimum shifts that week; for someone with a skill the shift still needs; and, when a weekends-off rule applies, for someone who already works the other day of that weekend (so weekends stay whole instead of each Sat/Sun pair using up two people's free weekends).
   - A tiny fixed tie-break, so the same input always gives the same schedule.

   A trainee with a Required "must work with" rule is only placed when their trainer can be put on the same shift too, and the two are placed together.
5. **Improve.** Up to four passes over the plan. Each tries handing a shift from one person to another when that brings both closer to their targets, or breaks fewer Preferred rules, without breaking any hard rule. After each pass it tries the empty slots again.
6. **Flag what's left.** A slot nobody can take stays **empty and flagged**, with the reason each person was ruled out (e.g. "Ryan has an approved day off", "Jacques only 9.5 h rest (min 11 h)"). Rules that can only be judged on the whole month are listed as shortfalls: coverage, and minimum shifts per week.

**Rule precedence.** For each rule type, the most specific enabled rule in its date range wins: the person's own rule, then their team's, then the rule for everyone. The UI shows a notice wherever one rule overrides another.

**Manual changes.** Dragging or reassigning is never blocked. `validate()` re-checks the whole schedule and lists every assignment that breaks a rule as a warning. Changes made by hand are marked `manual` and kept when the schedule is generated again (unpin one to let Generate change it).

**Saving a rule.** `feasibilityDelta()` generates the upcoming months with and without the change, and warns if the change leaves more slots empty or makes a Required rule impossible to meet.

**Speed.** A month for one team (about 130 slots, 9 people) takes roughly 50–200 ms in the browser.

## The optimiser

**Optimise** (next to Generate) plans the same month again with an exact method instead of the greedy one. The whole month becomes one mixed-integer program, solved by [HiGHS](https://highs.dev/) compiled to WebAssembly, so it still runs entirely in the browser:

- **Required rules are constraints:** time off, roles, overlaps, rest, consecutive days, shifts per week, hours per day, weekends off, availability, don't-schedule-with, must-work-with.
- **Everything else is one cost to minimise:** empty slots (by far the most expensive), required coverage and minimum-shift shortfalls, Preferred rules by priority, distance from each person's hours target (relative to contract size, as in the greedy engine), and fair share of weekend and late shifts.
- **It starts from the greedy plan,** so by its own measure it's never worse, and it keeps manual assignments. Every result is re-checked with the same rule check as `validate()` before it's used. The app only keeps it if it leaves no more slots empty than the current plan.
- **It's deterministic:** the search stops after a fixed number of branch-and-bound nodes (`DEFAULT_MAX_NODES`), not after a time.
- **It runs in a Web Worker,** and the 3.5 MB solver (`highs.wasm`) is only downloaded the first time someone presses Optimise.

It helps most in tight months. On the demo data, December for the understaffed Runners team goes from 10 empty slots to 9, and total hours off target drops from 51 h to 39 h, in about 3 seconds. When the greedy plan is already as good as it gets (the Bar team in the demo), Optimise keeps it. It's slower than Generate (seconds, not milliseconds) and doesn't prove its plan is the best possible. It searches a fixed amount and keeps the best plan it found.

## Limitations

- **Generate is greedy, not optimal.** Filling in order plus local improvement gives good schedules quickly, but not the provably best one. A tight month can leave a slot empty that a full search would fill; that's what **Optimise** is for (see above).
- **"Must work with" is one-directional and greedy.** It only works when the partner can be placed on the same shift at that moment.
- **Minimum shifts per week and coverage rules** are encouraged while filling and reported afterwards. They can't be guaranteed while a slot is being filled.
- **Weeks and months:** rules are judged within the month being planned. Rest time and consecutive days at the boundary with the previous month aren't checked against last month's schedule.
- **Vacation value:** a vacation day counts as weekly hours ÷ 5 against the target, and the allowance counts open days only. A real contract may define these differently.
- **Fair share** counts weekend shifts as Saturday and Sunday, and "late" as until-close or past midnight.
- **Prototype storage:** data lives in one browser (localStorage). There are no accounts, no server and no real notifications (they're shown in the employee view). Clearing browser data loses everything; export a JSON copy in Settings, or use *Settings → Reset demo data* to restore the example.
- **Placeholder numbers:** contract hours and vacation allowances in the demo data are made up and should be edited on each profile.

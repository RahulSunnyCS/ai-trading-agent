# BL-211 — Day-type list rules in Settings › Automation (an account trades a different list on a given day type)

| | |
|---|---|
| **Priority** | P1 — routes real money: the owner wants Shoonya on AlgoTest to trade Adaptive Classic on a SENSEX expiry day and Adaptive Tuned otherwise, without editing the row by hand the evening before |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options / scheduler / dashboard / broker-login |
| **Created** | 2026-11-05 |
| **Depends on** | BL-140 (the settings page and its versions), BL-197 (the evening export is what trades on AlgoTest), BL-209 (the T1 split reads the same rows; its PR 422 is open) |
| **TODO.md row** | — (filled in when started) |

## Context

Settings › Automation (BL-140) gives each account row (AlgoTest · Shoonya, AlgoTest · Angel One,
Quantiply · Angel One, Quantiply · Shoonya) **one** list: None, Adaptive Classic (`core`) or
Adaptive Tuned (`t1`). Every job reads that list for every session: the evening exports and
uploads (16:40 / 16:45, for tomorrow), the 08:11 activation, the 09:16 / 09:19 top-ups, the
08:10 clientwise MTM SL, the 09:25 deploy check, the 15:35 check, the live capture, the live
board, the lot plans, the margin block and the capital lines of the 16:00 message.

The owner (2026-11-05) wants the list to depend on the **day type**: "on a SENSEX expiry day
AlgoTest · Shoonya trades Adaptive Classic, otherwise Adaptive Tuned". The day types the system
already knows are the weekdays to expiry per index on the weekday basis (BL-109: `NIFTY 2 DTE ·
SENSEX 0 DTE` in the 09:16 message, `dte` in every export manifest, `rotation/expiry.py` and
`rotation/live_lots.py` read the same labels) and the weekday itself (`tomorrow.py`'s
conditions). Nothing in the settings can say "on this day type, this list" today; the owner
would have to change the row by hand before 16:40 and change it back after.

What exists and is reused:

- The settings shapes and validation in three places that must agree: `apps/scheduler/src/automation.ts`
  (the store, the API, the versions), `apps/dashboard/src/lib/automation.ts` (the page's copy, `withDefaults`,
  `describeChanges`), `packages/broker-login/src/automation-settings.ts` (what the TypeScript jobs
  read) and `packages/option-backtesting/src/option_backtesting/rotation/automation_settings.py`
  (what the exports, messages, live board and lot plans read).
- Every reader goes through a few functions: Python `upload_books`, `_uploading_rows`,
  `addon_wanted`, `dir_boost_wanted`, `book_capital`, and the direct `row.get("list")` reads in
  `plan.py`, `margin_lines.py`, `live_board.py`, `deliver.py`; TypeScript `effectiveRow`,
  `uploadBooks`, `algotestDeployBrokers`, `algotestAddon`, `quantiplyDeploy`, and the direct
  `row.list` reads in `trade-monitor.ts`, `stop-button.ts`, `live-capture-plan.ts`,
  `strategy-plan.ts`, `local-login.ts` (the 08:10 MTM SL keep).
- The day's DTE labels: the 09:16 pick computes today's, the evening export computes tomorrow's
  (`algtst_export.DayPicks.dte`, `manifest_block`), both on the weekday basis.
- BL-209 (PR 422) adds `splitT1`, which applies "while both AlgoTest rows upload T1". With rules,
  that is a per-session fact.

## Goal

- A rule in Settings › Automation says: **for this account row, when this day-type condition
  holds, trade this list** (None, Adaptive Classic or Adaptive Tuned). Rules are ordered; the
  first matching rule for a row wins; a row with no matching rule trades its base list as today.
- Two condition kinds, both on the session being traded: **days to expiry** of one index on the
  weekday basis (`NIFTY` or `SENSEX`, `0` … `6`, `7+`), and **weekday** (Mon–Fri).
- Every job that reads a row's list reads the list **resolved for its session** (tomorrow for
  the evening export, upload and margin block; today for the activation, top-ups, MTM SL keep,
  checks, live board, capture, lot plans and the result message), through one resolver per
  language, so the jobs never disagree.
- The page shows, under the rules, what each row trades **today and tomorrow** with the day
  types it read, and each rule in plain English. Save history names rules added, changed or removed.
- A session whose day type cannot be established while a rule exists is refused loudly
  (Telegram, non-zero exit), never traded on the base list silently.
- Nothing changes for settings without a rule: a missing `rules` reads as `[]`, every export,
  message and manifest is byte-for-byte what it was.

## Out of scope

- Rules on anything but the list (multiplier, Dir ×2, add-on, MTM SL stay the row's; see Open
  questions for the MTM SL).
- Conditions on VIX, the ranking, the previous day's result or anything not known the evening
  before. A rule is a calendar fact, decidable at 16:40 for tomorrow.
- Per-strategy rules (which picks of a list), which is BL-209's split and the lists' own research.
- Changing how a list is ranked or picked (BL-122's expiry-only filter stays as it is).

## Plan

### Phase 1 — The rule in the settings and on the page
- **Tasks:**
  - Shapes (the same in the four copies): `rules: Rule[]` on `AutomationSettings`;
    `Rule = { row: RowKey; when: When; list: List; note?: string }`;
    `When = { kind: 'dte'; index: 'NIFTY' | 'SENSEX'; dte: '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7+' } | { kind: 'weekday'; weekday: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' }`.
    Validation in the scheduler: a known row, a known kind, index, DTE label or weekday, a known
    list; at most 20 rules; a rule whose condition can never be reached because an earlier rule on
    the same row has the same condition is refused with a message naming both.
  - `withDefaults` (dashboard, scheduler, broker-login's `load`, Python `read`): `rules ?? []`.
  - A pure resolver in the dashboard lib and the scheduler (`resolveRows(settings, dayType)` →
    `Record<RowKey, Row>` with `list` replaced, and which rule decided each row), used by the page
    preview and by the scheduler's `effective` block.
  - `describeChanges`: `Rule added: AlgoTest · Shoonya on SENSEX 0 DTE → Adaptive Classic`,
    `Rule removed: …`, `Rule 2 changed: …`, `Rules reordered`.
  - The page: an **Advanced rules** section (collapsed by default, header shows the count) under
    the platform rows: a table of rules (row select, condition kind select, index + DTE selects or
    weekday select, list select, a note field, up/down and remove), an **Add a rule** button, a
    plain-English line under each rule, and a **What trades** preview: today and tomorrow with
    their day types and each row's resolved list and the rule that decided it. Mock-up:
    `backlog/assets/BL-211-advanced-rules-mockup.html` (the shape, not the final styling; tokens
    and `components/ui/` controls as `apps/dashboard/CLAUDE.md` says).
  - The scheduler's `GET /settings/automation` view gains `day_types: { today, tomorrow }` (each
    `{ day, weekday, dte: { NIFTY, SENSEX } } | null`) read from Phase 2's day-type files, and
    `effective_by_session: { today, tomorrow }`; `null` until Phase 2 writes them, and the page
    then says "day types not known yet" instead of a preview.
  - Guide page `operations/settings.md`: the section, the first-match rule, the preview.
  - Tests: scheduler validation and resolver, dashboard lib (`withDefaults`, `describeChanges`,
    resolver) and card (add, reorder, remove, save, the preview), broker-login `load`.
- **Deliverables:** the four shapes, the page section, the guide, the tests.
- **Done when:** a rule saves as a new version and reads back on the page; a settings file
  without `rules` loads everywhere; the preview shows the resolved lists once Phase 2 feeds it.

### Phase 2 — The day type of a session, and the resolvers the jobs use
- **Tasks:**
  - Python `rotation/day_type.py`: `for_day(day) -> DayType(day, weekday, dte={'NIFTY','SENSEX'})`
    from the same weekday-basis DTE code the pick and the exports use (one source; no second
    expiry computation), and `write(day)` to `TRADING_DATA_ROOT/rotation/day-type/<day>.json`.
    `obt rotation daytype [--day D] [--write] [--json]`. The evening job writes tomorrow's as its
    first step; the 09:16 pick writes today's before anything else (idempotent, same content).
  - Python `automation_settings.for_session(settings, day_type) -> settings` (rows' `list`
    replaced, `rules_applied: {row: rule index}` recorded) and `read_for_session(day)` which
    reads the settings and the day-type file; **with rules and no day-type file it raises**
    `DayTypeUnknown`, with no rules it returns the settings as read.
  - TypeScript `automation-settings.ts`: `loadForSession(day)` with the same contract (read the
    file, apply the rules, refuse when a rule exists and the file is missing or for another day);
    `effectiveRow` takes the resolved settings.
  - One JSON fixture of cases (`packages/option-backtesting/tests/fixtures/automation_rules_cases.json`:
    settings + day type → expected lists and deciding rule) run by the Python, the broker-login
    and the dashboard tests alike, so the resolvers cannot drift.
  - The scheduler reads the day-type files for Phase 1's preview.
- **Deliverables:** `day_type.py`, the command, the two resolvers, the fixture, the scheduler steps.
- **Done when:** both resolvers pass the fixture; `obt rotation daytype --day 2026-11-06 --json`
  prints `SENSEX 0` for a Thursday; the evening and 09:16 jobs write the file; a settings with a
  rule and no file makes `read_for_session` raise and `loadForSession` throw.

### Phase 3 — Every reader resolves for its session
- **Tasks:**
  - Python: `algotest-export` / `quantiply-export --from-settings` (tomorrow with `--next` /
    `--preview`, today otherwise), `margin_lines.py` (tomorrow), `book_capital` and the capital
    lines (the result's day), `plan.py` lot plans, `live_board.py` (today), `deliver.py`. The
    export manifest records `day_type` and `rules_applied` beside `dte`.
  - TypeScript: `strategy-upload` / `strategy-plan` (tomorrow), `strategy-deploy --morning` and
    `--check` (today), `quantiply-upload` evening / topup, `quantiply-deploy`, `local-login.ts`'s
    08:10 MTM SL keep (today), `trade-monitor.ts` (today), `stop-button.ts` (today),
    `live-capture-plan.ts` (the captured day).
  - Messages: where a rule decided a row, one line says so (`AlgoTest · Shoonya: Adaptive Classic
    today (rule 1: SENSEX 0 DTE)`), in the evening upload report, the 08:10 message and the 16:00
    message's capital / margin lines.
  - BL-209: `splitApplies` evaluated on the resolved rows of the session (a rule that moves one
    AlgoTest account off T1 that day turns the split off for that day, and the report says so).
  - A grep gate: no `row.list` / `row.get("list")` read outside the resolvers (a unit test over
    the source tree, as the dashboard's Tailwind class test is).
- **Deliverables:** the readers, the manifest fields, the message lines, the grep test.
- **Done when:** with a rule `AlgoTest · Shoonya, SENSEX 0 DTE → Adaptive Classic`, a dry run of
  the evening export for a Thursday (`--next` on a Wednesday, or `--day` of a past Thursday)
  writes Classic for Shoonya and Tuned for Angel One on AlgoTest, the manifests say which rule,
  the activation plan (`--morning` without apply) names each account's list, and a run for a
  Tuesday changes nothing; every existing golden and manifest test is unchanged.

### Phase 4 — Live
- **Tasks:** the first session with a rule on, watched by the owner: the evening upload report,
  the 08:11 activation, the 09:25 check (when `DEPLOY_CHECK=on`) and the 15:40 capture all name
  the resolved list; `live-compare` attributes the day's live results to the resolved list.
  Restart the scheduler after the merge (`.env` and code snapshots).
- **Done when:** one SENSEX-expiry session traded Classic on the ruled account and Tuned on the
  other, each message said so, and the capture's `list` matches.

## Risks

- **A stale or missing day-type file** → a job trades the base list. Mitigation: with rules
  present, no file (or a file for another day) refuses and alerts; the file is written by two jobs
  (evening, 09:16) and is idempotent.
- **Two resolvers drift** (TypeScript and Python). Mitigation: the shared fixture, run by both.
- **One export serves every account of a platform** (BL-140 Phase 4): when the rule gives Shoonya
  Classic and Angel One Tuned on AlgoTest, the export must carry both lists that day.
  `upload_books` already returns several; the activation already deploys per broker. Check the
  add-on and Dir ×2 "mixed" logic still reads per list.
- **The 08:10 MTM SL keep** is sized to the row's list (₹9,000 T1 / ₹8,000 Classic by default).
  A rule changing the list leaves the stop as the row's unless the owner answers otherwise (below).
- **BL-209's split** reads the same rows; land this after PR 422 or rebase it, and resolve the
  split per session.
- **The 09:16 pick's expiry-only filter (BL-122)** is independent: on a SENSEX-only expiry day
  both lists hold SENSEX strategies only; a rule does not change that.

## Open questions

1. **MTM SL on a ruled day (Quantiply rows):** keep the row's figure, or follow the list traded
   that day (₹8,000 for Classic, ₹9,000 for Tuned, when the row is at its list's default)?
   Proposed: keep the row's figure in Phase 1; a per-rule `mtmSl` can come later.
2. **Condition on both indices at once** (`NIFTY 0 and SENSEX 0`)? Proposed: not in Phase 1; two
   rules on the same row with the same list cover "either"; "both" is rare (none this quarter).
3. **A rule for a row whose base list is None** (an account that trades only on expiry days)?
   Proposed: allowed; the row's login must still be on for anything to happen, and the page says so.
4. **Should the rule also pick `splitT1` on or off for the day?** Proposed: no; the split follows
   the resolved rows, and the report says when a rule turned it off.
5. The rule the owner named first: `AlgoTest · Shoonya, SENSEX 0 DTE → Adaptive Classic`. Is
   Angel One on AlgoTest to stay on Tuned that day (so AlgoTest carries both lists), and do the
   Quantiply rows get any rule?

## Log

- 2026-11-05 — created from the owner's idea ("on a SENSEX expiry day, AlgoTest Shoonya should be
  Adaptive Core, not Adaptive Tuned; add a rule from the instrument and its days to expiry, or
  the weekday"). Plan written for a later session to build; mock-up of the page section in
  `backlog/assets/BL-211-advanced-rules-mockup.html`.

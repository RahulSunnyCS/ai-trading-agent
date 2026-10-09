# BL-058 — Options rotation: forward paper journal, and the Options Lab screens it needs

| | |
|---|---|
| **Priority** | P0 — owner, 2026-10-09: the forward record must start before Monday 2026-10-12 09:15 |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options / dashboard / scheduler |
| **Created** | 2026-10-09 |
| **Depends on** | BL-057 (the rule), BL-054 / BL-056 (variant files), BL-012 (scheduler), BL-024 (journal pattern) |
| **TODO.md row** | — (added when started) |

## Context

BL-057's daily four-criteria rotation over the 66 NIFTY + SENSEX start-time variants beat 98% of
random picks and earned 36% more than the equal-weight line on 2025-12 → 2026-10, with the same
drawdown (−₹57k, 4.8% of ₹12 lakh). It was scored on a year already studied, so its only
remaining question is whether it holds on days nobody has seen. The owner (2026-10-09) wants that
answered with a forward paper journal — picks written down *before* each day, scored after —
starting Monday, and, alongside it, an evaluation of the dashboard: which Options Lab screens and
widgets this strategy actually needs, which stay, and which can wait.

Nothing here places or changes a trade. AlgoTest is untouched.

## Goal

- From Monday 2026-10-12, every trading day has a journal entry recorded before 09:17 with the
  day's picks, and every evening the entry is scored from the collected data.
- A written evaluation of the Options Lab UI for this strategy: keep / hide / later per screen
  and widget, plus the minimal rotation view to build next.

## Out of scope

Live execution or AlgoTest changes; any change to the BL-057 rule (a new rule is a new dated
block in BL-057 or a new item); building the new view before Monday (Phase 4 follows); the
2024-10 → 2025-08 period; Momentum.

## Plan

### Phase 0 — Pre-register the forward test (before any code)
- **Rule:** BL-057 Case A + Buy add-on exactly, as in `research/bl057/rotate.py` at the commit
  that adds this item (recorded here when committed). Universe, criteria, weights, lookbacks,
  constraints unchanged. Picks use history through the previous trading day plus the day's own
  weekday, days to expiry and 09:15 VIX open.
- **Forward window:** from 2026-10-12. **Evaluation point:** 60 trading days (about early
  January 2027), scored once with BL-057's pass rule (R P90, beats E, beats B2, drawdown no
  worse). Weekly reports are read-only: nothing in the rule changes because of them.
- **Will not:** switch to Case B, retune weights, drop the Buy add-on, or start from a later date
  after seeing early results.
- **Done when:** this block is filled in and committed.

### Phase 1 — Nightly: results for all 66 variants (after `options-daily`)
- **Tasks:**
  - A command (proposed `obt rotation update`) runs the 66 variant YAMLs for the newly collected
    day (one-day `run_legwise` each; NIFTY files from `research/bl054/variants/`, SENSEX from
    `research/bl056/variants/`, moved to a committed home such as `research/rotation/variants/`)
    and stores per-variant per-day P&L in a new catalog table (`trading-data` migration 012,
    `options_rotation_results`). It never writes into the legwise strategy store, so Options Lab
    "Daily results" is not flooded with 66 strategies.
  - Backfill the table from the existing per-day CSVs (2024-10-09 → 2026-10-08), checked equal.
  - Score yesterday's journal entry (realised P&L of the picks; E and B2 for the same day).
  - Scheduler job `options-rotation-nightly` after `options-daily` (e.g. 19:45 trading days,
    same `catalog` group), with retries like `options-daily`.
- **Done when:** the table matches the CSVs for every backfilled day; a manual run for
  2026-10-09 (after its data is collected at the normal time) fills one new day.

### Phase 2 — Morning: record the picks (before 09:17)
- **Tasks:**
  - Command `obt rotation pick` at 09:16 IST on trading days: read the 09:15 INDIAVIX open live
    from Fyers (the lake only has it after 16:15), take weekday and days to expiry from the
    listed expiries, score the 66 from `options_rotation_results`, select (Case A + Buy).
  - Record the entry in a hash-chained, insert-only journal table (`options_rotation_journal`),
    copying the design of `momentum_backtesting/forward_journal.py` (`record`, `verify`, `head`;
    rerun = no-op or a superseding row). Store the picks, every criterion's rank for the picked
    variants, the VIX open, the code commit and the recording time.
  - Telegram the picks and the chain head through the package's `notify.py` (the outside witness
    of when the entry existed, as BL-024 does).
  - `obt rotation verify` and `obt rotation show`; a fallback: if Fyers is unreachable at 09:16,
    record nothing and alert (a late entry would not be forward).
  - Scheduler job `options-rotation-pick` (09:16, trading days, no catch-up after 09:17).
- **Done when:** a dry run against a past day reproduces `rotate.py`'s picks for that day (as
  `research/bl057/today.py` did for 8 Oct: ₹11,786); `verify` passes; the job is registered.

### Phase 3 — UI evaluation (written, before Monday)
- **Tasks:** go through every Options Lab screen and widget — Strategies, Builder (Form / YAML),
  Runs, Daily results (`DayGrid`, `ComparisonTable`, `EveningRunBar`), Regimes
  (`CalendarHeatmap`, `ShareChart`, `RegimeBadge`), `DayForensics`, `DayTypeCard`, `PnlScatter`,
  anatomy — and mark each **keep** (used in the rotation workflow), **hide** (not needed now) or
  **later**, with one line why. Only what the rotation strategy needs counts as keep.
- Define the minimal rotation view, reusing the analytics page pattern
  (`apps/dashboard/CLAUDE.md`) and `components/ui/`:
  1. **Today:** the picks, each with its four criterion ranks and composite, the VIX band and
     days to expiry, and the time the entry was recorded.
  2. **Journal:** one row per day — picks, realised P&L, E and B2 that day; running totals and
     drawdown for the rotation, E and B2; the chain status from `verify`.
  3. **Variant table:** the 66 by recent P&L and by fit to today's weekday / days to expiry / VIX
     band (the BL-056 tables, live).
  Each with the API endpoint it needs on `obt-api` and its Guide page.
- **Deliverable:** the evaluation and the view spec written into this item.
- **Done when:** the owner has read it (before Monday).

### Phase 4 — Build the rotation view (after Monday; not part of the P0 deadline)
- Endpoints, the view, Guide page, hide the "hide" items. Separate review.

### Phase 5 — Review at 60 trading days
- Score once against the Phase 0 rule; write the Result here and in BL-057's Log.

## Risks

- **Two minutes between the VIX criterion and the first entry (09:15 → 09:17).** Fine for a paper
  journal recorded by a job; impossible for hand edits in AlgoTest. Live use would need the
  picks earlier (for example from the previous close's VIX), which is a different rule and needs
  its own dated block and test. Decide before any money.
- **Fyers login:** the 08:05 `fyers-login` job failed on 2026-10-09 (the token still came from
  the `mbt login` cache). The 09:16 pick job depends on a valid token; check this before Monday.
- **Charges and effort:** the rule swaps about 3 of 5 core strategies a day. The journal records
  picks before charges; a per-day charges estimate should be added to the review.
- **Weekday and days to expiry are the same information within one expiry regime for each index,**
  so half the score weight sits on one factor. Known; not changed (Phase 0).
- **Variant files** live under `research/` today and are not committed; Phase 1 moves the ones
  the rule needs to a committed, fixed location so the forward test cannot drift.

## Open questions

- Telegram the picks every morning, or only record and show them on the dashboard?
- Which scheduler time for the nightly update: right after `options-daily` (retries until 23:00)
  or a fixed 23:45 after everything else?

## Log

- 2026-10-09 — created from the owner's request; P0 with a Monday 2026-10-12 09:15 deadline for
  Phases 0–3.

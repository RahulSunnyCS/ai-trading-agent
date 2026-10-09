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
- **Deliverable:** the evaluation and the view spec written into this item (done below, 2026-10-09).
- **Done when:** the owner has read it (before Monday).

### Phase 3 result — Options Lab evaluation for the rotation (2026-10-09, read-only review)

Almost nothing in Options Lab is rotation-specific: the rotation view should be a **new, separate
section**; only the evening-run bar and the Daily results grid are needed as they are.

| Screen / widget (`components/optionslab/`) | Verdict | Why |
|---|---|---|
| Strategies (`StrategiesPanel`) | KEEP | Lists the live mix (`strategies/legwise/*.yaml`); must never list the 66 variants |
| Builder, Form (`StrategyBuilder`, `builder/*`) | HIDE | Variants are fixed YAMLs; Backtest spends a credit |
| Builder, YAML (`yaml/*`) | HIDE | Different engine and data source |
| Runs (`RunsPanel`, `runs/`) | HIDE | One row per saved result; would balloon if variants were saved |
| Daily results, `EveningRunBar` | KEEP | Fyers token and last-run status; the nightly scoring and the 09:16 pick depend on both |
| Daily results, `ComparisonTable` + cumulative chart | KEEP | Live mix only |
| Daily results, `DayGrid` | KEEP (live mix) | Its day-context columns (weekday, days to expiry, VIX open) are the rotation's day features; cannot scale to 33 columns per index |
| `DayForensics` | LATER | Drill-down on a journal pick, not in the first view |
| `DayTypeCard`, `PnlScatter`, `anatomy.tsx` | HIDE | Bucket by index shape (QUIET/CHOP/TREND), not weekday / expiry / VIX; reuse only the bucket-table pattern |
| Regimes (`RegimesPanel`, `RegimeViews`, `regimes/*`) | HIDE | Labels are only known after the day |

Hiding a sub-tab means removing it from `OPTIONS_LAB_SECTIONS` (`lib/routes.ts`), `nav.ts` children
and the guide registry together (a test keeps them in step); hiding Strategies / Builder / Results
breaks their `?load=` and `?strategy=` deep links, so hide them together or keep the links.

**Minimal rotation view** — new route `/optionslab/rotation`, added to `isAnalyticsPage`; analytics
page pattern from `apps/dashboard/CLAUDE.md` (run bar with window and index chips, headline strip of
StatCards: rotation vs equal-weight vs live mix, total / max drawdown / days / gap badge; widgets
loaded after the chart with `useWidgetActivation`). Endpoints go under `/legwise/rotation/*` (the
`OBT_DIRECT` rewrite only covers `/legwise/*`) in a new `api/rotation_routes.py` included from
`app.py`, plus one `requireAccess` route per path, no credit, in
`apps/server/src/server/routes/backtest.ts`; hooks in a new `hooks/useRotation.ts` on
`usePolledResource`.

| Part | Endpoint | Copy from |
|---|---|---|
| Today | `GET /legwise/rotation/today?day=` → recorded time, weekday, VIX open and band, days to expiry per index, entry id and row hash, code commit, picks with the four criterion ranks and composite | `MomentumWeeklyView`, `StatCard` |
| Journal | `GET /legwise/rotation/journal?from&to` → one row per day (picks, P&L, equal-weight, live mix, scored?), totals with max drawdown per line, chain `{entries, head, problems}` | `components/momentum/MomentumJournalView.tsx`, `lib/legwiseStats.ts` `statsOf`, `CumulativeLines` |
| Variants | `GET /legwise/rotation/variants?day=` → the 66 with recent P&L, three fit values, ranks, composite, picked flag | `results/ComparisonTable.tsx` sort header, `Sparkline` |
| Breakdowns | `GET /legwise/rotation/breakdown?by=weekday\|dte\|vix\|start\|window` | `DayTypeCard` bucket table, `lib/legwiseJoin.ts` (`MIN_BUCKET_N` greys thin cells), `lib/plotly.ts` for the curve |

One Guide page (`optionslab/rotation.md`, registered for `{tab:'optionslab', rest:['rotation']}`;
the registry test requires it) and glossary entries: VIX band, composite score, hash chain,
equal-weight, live mix, lots per window.

**What this session's analysis adds to the view (all within the same view, none built yet):**
- **Breakdown tables** by weekday, days to expiry and VIX band (BL-056), for a one-year window per
  expiry regime; thin cells (< 30 days) flagged, not hidden.
- **Whole-day start-time curve** per index and family, 24 start times to 15:02 (BL-059), with the
  first-half vs second-half average beside it, because a single best time did not repeat.
- **Lots by start-time window** (09:17–09:47 / 10:02–10:47 / 11:02–11:47): share of lots, P&L and
  average per lot, for the day, the week and the whole run.
- **Rule settings side by side**: Widesl minimum 0 / 1 / 2 / 3 and the 5-lot vs 3-lot (3 core + 1
  Buy) versions as selectable lines, with their random-picks percentile, so the owner can see which
  setting holds up on unseen days.
- **Comparison lines**: equal weight and the live mix at the same lot count (5-lot: 3 Widesl + 2 Dir;
  3-lot: 2 Widesl + 1 Dir) and the fixed benchmarks B1–B4 from BL-054/055.
- **Data coverage strip**: market days vs days with data for each index (209 market days in the
  3 Dec 2025 – 8 Oct 2026 run, 202 usable; 16–24 Sep missing, BL-040), because the rule skips a day
  either index lacks.
- **Switching cost**: members changed per day (about 3 of 5), and an estimated charges line, so the
  effort of re-setting AlgoTest is visible next to the P&L.
- **Later**: portfolio stop-loss levels (₹8k / ₹10k / ₹12.5k, BL-055) need a portfolio mark-to-market
  series that does not exist in the UI yet (`DayForensics` is per strategy).

**Fixes to make in the same change:**
- The `DayGrid` tooltip (`results/DayGrid.tsx`) and the glossary entry `dte` (`guide/glossary.ts`)
  say "trading days"; `legwise/anatomy.py` computes **calendar** days to expiry (as in BL-056).
  Correct both, and say calendar days in the rotation view and Guide.
- `lib/chartTheme.ts` has `SERIES_COUNT = 4`: with more than four lines (rotation, equal weight,
  live mix, setting variants) colours repeat; limit the chart to four lines or extend the palette
  per `docs/dashboard-design-tokens.md`.
- `/legwise/anatomy` rescans index history on each call; the rotation view should not use it or its
  T-33 overlay (needs `DATABASE_URL` in the API process) — compute weekday, days to expiry and VIX
  band in the rotation endpoints.
- The journal and results tables share the catalog the nightly job writes: keep reads short and
  retried, as `/results` already needs.
- Never save the 66 variants into the legwise store: `load_daily` loads every trade for every run,
  `GET /legwise/results` is unpaginated and uncached against the Fastify proxy's 30 s timeout, and
  `load_strategy_files` runs every YAML in `strategies/legwise/` in the evening job.

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

- Also record the other rule settings (Widesl minimum 0, 1, 3; the 3-lot version) as shadow entries
  next to the real one, at no cost? It would show which setting holds on unseen days; the verdict
  stays tied to the pre-registered one.
- The 3-lot owner version (3 core + 1 Buy, minimum 0 or 1 Widesl) is not pre-registered as the
  journal rule: decide which lot count the journal records as the main line before Monday.
- Telegram the picks every morning, or only record and show them on the dashboard?
- Which scheduler time for the nightly update: right after `options-daily` (retries until 23:00)
  or a fixed 23:45 after everything else?

## Log

- 2026-10-09 — Phase 3 UI evaluation written in (read-only review of Options Lab) with the views the
  analysis discussion needs; owner asked that the discussion's UI needs be added here.
- 2026-10-09 — created from the owner's request; P0 with a Monday 2026-10-12 09:15 deadline for
  Phases 0–3.

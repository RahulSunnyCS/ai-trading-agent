# BL-058 — Options rotation: forward paper journal, and the Options Lab screens it needs

| | |
|---|---|
| **Priority** | P0 — owner, 2026-10-09: the forward record must start before Monday 2026-10-12 09:15 |
| **Status** | In progress — journal built 2026-10-10 (Phases 0b, 1, 2); UI waits (Phase 4) |
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
- **Added 2026-10-10 (owner: any UI change goes to the backlog; none is built with the journal):** the
  view must show the four forward lists (A, B, C, REF) side by side, not one rule: per list the day's
  three strategies and Buy strategy with their composite scores, the running gross and max drawdown, the
  share of random same-shape picks it has beaten, and the difference to REF with its bootstrap
  interval; a single "chain intact" badge from `obt rotation verify` and the chain head; the days
  waiting on results (nightly update not yet run) and any day not recorded because the VIX open could
  not be read. Data comes from `rotation/` files via new `/legwise/rotation/*` endpoints (the files are
  read-only to the API). Also a per-list "what changed since yesterday" strip (members swapped) for the
  effort of re-setting AlgoTest.
- **Owner decisions for the view, 2026-10-10** (from the five-widget plan: rotation page with Today's baskets,
  Why this pick? and rank correlation, Daily log, Strategy Matrix, Shadow scoreboard):
  - Default benchmark on the headline strip: the **fixed base** (see the Phase 0b amendment); REF second,
    the random-basket median third. Comparisons in ₹ per lot-day.
  - Default focus list for the headline: **A**.
  - The dashboard may write a **placement record** (placed / changed / not placed, with a note), append-only
    to its own file under `rotation/`, behind the dashboard password; the hash-chained journal is never
    edited.
  - The 2022–24 results for the Strategy Matrix are imported **after** its first version, into a separate
    read-only folder the morning pick never reads.
  - Today's baskets and the other rotation screens are **owner-only** on the hosted dashboard until
    showing daily picks to friends has been checked against the signal-sharing note in `business.md`.
- **Widgets 6–10, 2026-10-10** (owner: add them here, recommended options taken; design in the plan page
  https://claude.ai/artifact/KF4EvYf9f63uNco3MZ4oKm). Built after the five above, one reviewed PR each:
  - **6. Today's basket on the Correlation tab** (BL-090). A preset that fills the tab with one list's
    picks for one day, with a list toggle that includes the fixed base (its doubled Widesl drawn as one
    4-lot line), windows P1 / P2 / last 63 / Forward, and a link from the Daily log drawer. No new maths:
    `GET /legwise/correlation?selectors=<the three picks>`. Muted below 20 common days; a pick without
    results is listed, never zero. Done when it equals `obt rotation corr` for the same names and window.
    Starts straight after the rotation page. Example from the stored results: N_wide_0932, S_dir_1202,
    S_wide_1347 correlate −0.05 to +0.17 in P1 and P2, and together their worst drawdown is 28% (P1) and
    59% (P2) shallower than the three run alone.
  - **7. Forward days vs research periods.** A panel showing the forward window's mix of opening VIX band,
    NIFTY and SENSEX DTE and weekday against P1, P2 and P3 (after the import), with VIX open and each
    index's day range as P10 / median / P90, and the total-variation distance to each period. Needs a
    day-range column in `days.csv`, written by the nightly update from the lake's 1-minute index bars, and
    `GET /legwise/rotation/regime`. **Lands before the 60-day read-out**, so the read-out can say what kind
    of market it tested. Already visible in the real columns: NIFTY and SENSEX swapped expiry weekdays
    between P2 and P1, so a DTE fit from one period describes a different weekday in the other.
  - **8. Drawdown episodes.** Underwater chart per list against the fixed base (per lot or basket), an
    episode table (peak, trough, back, depth per lot, sessions down, sessions to recover, the base over the
    same days, stops) and the peak-to-trough loss by family × start band. **An episode is a fall of at least
    ₹500 per lot below the running peak.** `GET /legwise/rotation/drawdowns`, a pure function in
    `rotation/report.py`. Readable from about 60 sessions; before that it lists without ranking.
  - **9. Selection drift.** Share of core picks by family, index, strike method and start band for history
    (P1, reconstructed), last 63 and last 21, plus a concentration table (distinct variants, most-picked
    variant, single-band baskets, Widesl minimum and Buy counts). **A share is flagged when the last 21
    sessions fall outside that list's own rolling 21-session P10–P90 in P1**, not a fixed number of points.
    Descriptive only; nothing changes. `GET /legwise/rotation/drift`. Readable from about 60 sessions.
  - **10. Paper vs real.** A waterfall from paper gross through charges, days not placed, the owner's
    changes and execution to the real P&L, a day table, and a Real column in the Daily log. Waits for three
    things: the placement record; **the BL-063 charge model applied to stored results in the nightly update,
    as its own registered change** (the `costs` column is zero today, so net equals gross); and the
    contract-notes cutover (TODO §2). **The rotation trades on one broker account used for nothing else**, so
    its contract notes are the real figure without filtering; until that holds, a day whose rotation
    contracts cannot be told apart is marked "mixed" and left out of the gap.
  - Not scheduled: basket-level day replay (built when a real losing day raises a question; the Daily log
    drawer opens Day forensics per pick until then) and the two premium widgets (wait for BL-091 and an
    intraday collector).

### Phase 5 — Review at 60 trading days
- Score once against the Phase 0 rule; write the Result here and in BL-057's Log.

### Phase 0b — what the journal records (dated 2026-10-10, registered before the first entry)
**Amendment 2026-10-10 (owner, before the first entry): the universe is 298 variants, not 248** — the 248
below plus the 50 Dir ITM1 variants (`N_ditm1_*`, `S_ditm1_*`, BL-080; family "dir" for the Widesl minimum
and the family-band recent score). BL-080's read-out passed (A / B / C ≥ their 248 gross in 2 of 3
periods, all above random P90; REF unchanged). Weights, lookbacks and rule are untouched; the journal
records the universe size and a hash in every entry. Parity (`scripts/rotation-parity.py --ext-dir`)
reproduces `rotate.py --ext-dir` on 202 of 202 days for each list.
Supersedes the 66-variant rule of Phase 0 for the forward test; Phase 0's discipline (picks before
09:17, scored after, no change from reports) stands.
- **Lists (all DRB-6W3L2 shape):** 3 strategies × 2 lots from the whole-day list (298 variants, see the amendment above), at
  least 2 Widesl strategies, the Buy add-on (one 2-lot Buy strategy) when a Buy variant ranks in the
  overall top 10; per-strategy stops as in the variant files; every list ranks with fit lookbacks
  5:30, 21:25, 63:25, 126:20 except REF. Weights are own-recent / weekday / dte / VIX / family-band
  recent (BL-074 type × start-band family):

  | List | Own | Weekday | DTE | VIX | Family | Notes |
  |---|---|---|---|---|---|---|
  | **A** | 5 | 34 | 33 | 23 | 5 | BL-075 stage 1, safest cell |
  | **B** | 0 | 36 | 35 | 24 | 5 | BL-075, best Jan–Aug 2025 |
  | **C** | 15 | 30 | 30 | 20 | 5 | BL-075, best in the 2025-26 regime |
  | **REF** | 33 | 25 | 25 | 17 | 0 | the live baseline, lookbacks 5:40, 21:30, 63:30 |
- **Entry (one per trading day, 09:16 IST):** the day, weekday, 09:15 India VIX open and band,
  days to expiry per index, each list's three strategies and Buy strategy (with their composite
  scores), the code commit, the universe size and hash, a digest of the stored results it was scored
  on (`inputs_sha`), the time written, the previous entry's hash and its own SHA-256. Appended
  to an insert-only hash-chained log under `TRADING_DATA_ROOT/rotation/`; `obt rotation verify`
  re-computes the chain. The picks are Telegrammed with the chain head. If the 09:15 VIX open cannot
  be read by 09:20 nothing is recorded for that day and an alert is sent (a late entry is not forward).
- **Scoring (every evening, after `options-daily`):** the day's result for all 298 variants is
  computed (one-day `run_legwise` per variant, same strategy files), stored, and each list's recorded
  picks scored: gross for the day, the random-pick percentile for that day, and the running totals
  and drawdowns per list.
- **Evaluation point:** 60 trading days from 2026-10-12. Per list: gross, max drawdown, and the share
  of random same-shape picks it beats (cumulative), with REF as the comparator and a 5-day
  block-bootstrap interval of each list minus REF (the owner's fixed base, amended below, is now the
  primary reference and REF the second). Weekly read-only reports; nothing changes.
- **Will not:** change a list's weights, add a list, drop one, or switch the rule after seeing
  results; start from a later date.
- **Deviation from Phase 1–2 as written:** the journal is a hash-chained JSONL file, not a catalog
  table, and the results store is per-variant CSV files under the same directory: the catalog
  allows one writer, the migration ledger is mid-repair (see BL-071 Log), and the file form keeps
  `obt daily` unaffected. The variant YAMLs now live in `packages/option-backtesting/strategies/
  rotation/` (committed), not under `research/`.

**Amendment 2026-10-10 (owner, before the first entry): the fixed base is the primary reference, REF the
second.** The owner's base answers the basic question: does rotating at all beat the simple rule that would
otherwise be traded? It is the default yardstick, reported first. REF stays registered as the second
reference and answers "did the new weights beat the old rotation?". Nothing in the lists, the ranking or the 298-variant universe changes.

- **Base:** 2 × NIFTY Widesl OTM1 at 09:17 + 1 × NIFTY Dir ATM at 09:24, every trading day, no ranking.
  - Widesl OTM1 09:17 is the rotation variant `N_wide_0917` (OTM1 strikes, ₹2,500 overall stop), identical
    to the live `strategies/legwise/nifty_widesl_917_otm1.yaml`.
  - Dir ATM 09:24 is a new file: the live `nifty_dir_924_itm1_sl21_recost.yaml` with the strike changed from
    ITM1 to ATM and nothing else (09:24 entry, 21% stop per leg, ₹3,000 overall stop, RE COST ×1, 15:28 exit). The owner chose ATM;
    the live file and the earlier benchmarks B1–B3 use ITM1.
  - 2 lots per strategy, so 6 lots a day, lots sized at `SIZING_DATE` exactly like the lists.
- **Unit:** ₹ per lot-day is the headline unit for every comparison with the base and with REF. A list holds
  6 lots, or 8 when the Buy add-on fires, so totals would reward holding more lots; totals at the stated lots
  are reported beside.
- **Read-out addition, per list (A, B, C and REF):** the daily series list minus base in ₹ per lot-day; its
  mean and a two-sided 90% percentile interval from a circular 5-day block bootstrap, 2,000 resamples,
  seed 20261012. **The REF comparison uses the same parameters;** Phase 0b named the bootstrap but not its
  settings, and fixing them here, before the first entry, keeps both from being chosen after the data. **A list "beats the base" when the interval's lower bound is above zero and the list's max drawdown
  per lot (of the cumulative ₹-per-lot-day series) is no worse than the base's.** No minimum size: the owner
  chose "reliably ahead, any size" over a fixed 10% or 20% margin. The base's own gross, drawdown and ₹ per
  lot-day are reported with the lists. All four lists are reported against the base; with four tries, one
  list passing alone is read as weaker evidence than several passing. Sixty days give twelve 5-day blocks, so
  the interval will be wide: only a clear edge passes, which is the point of the rule.
- **Scoring:** the base is scored nightly with the lists from the same results store. Its strategy files
  live outside `strategies/rotation/` (proposed `strategies/rotation_base/`) so the universe, its hash and the
  morning pick are untouched. The Dir ATM 09:24 history over the stored period (2024-10-09 onward) is run
  once for context; the verdict uses forward days only.
- **If the scoring code lands after the first entry,** the base is scored from 2026-10-12 retroactively. That
  is allowed because the base is a fixed rule with no discretion and this block is committed before the
  first entry; the margin rule above cannot change after it.
- **Will not:** change the base's legs, strikes, times or lots; add a minimum margin; or swap the base for
  another mix after the first entry.

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
- 2026-10-10 — owner chose the 298 universe (Dir ITM1 added) before the first entry; 50 variant files + results seeded, parity 202/202 on all four lists.
- 2026-10-10 — owner chose lists A, B and C (BL-075 stage 1) plus the live baseline as REF; Phase 0b registered; build started.
- 2026-10-10 — journal build is backend-only (CLI + two scheduler jobs + files); UI needs for the four lists added to Phase 4.
- 2026-10-10 — **Built:** `obt rotation update|pick|verify|show` (`src/option_backtesting/rotation/`),
  the 248 variant files committed under `strategies/rotation/` (5 of 5 sampled reproduce their stored
  2026-10-08 result to the rupee), scheduler jobs `options-rotation-nightly` (19:45, retries to 23:00,
  catalog group) and `options-rotation-pick` (09:16, no catch-up), 15 unit tests, and
  `scripts/rotation-parity.py`: lists A, B, C and REF pick **202 of 202** selection days identically to
  rotate.py (a weekend session — the Budget Sunday 2026-02-01 — had to be excluded from the history to
  get there). Store seeded from the research results (248 files, 487 days) and 2026-10-09 run through
  the nightly path (248 variants in 4.6 s, idempotent). The live VIX fetch returned 15.28 for
  2026-10-09, equal to the lake. Dry run for Monday: A/B pick N_dir_0947, N_wide_1347, N_wide_1317.
  **Before Monday:** the scheduler process must be restarted to load the two jobs; the code lives on this
  branch only, so the main checkout must stay on it (or PR #154 merge first); the Fyers token for the
  09:16 read depends on the 08:05 login.
- 2026-10-10 — **Amendment (before the first entry): the 09:15 VIX open's source.** Fyers needs a human
  login each day (BL-076 / BL-077 / BL-079), so a morning without it would leave no entry. The pick now
  reads the same quantity (the open of the 09:15 India VIX 1-minute bar) from Fyers first and from Angel
  One (unattended login, BL-078 / BL-079's module) when Fyers has no token or no bar; the entry records
  `vix_source` (fyers / angelone / given). Checked on 2026-10-09: both return 15.28. If neither source
  answers by 09:20 nothing is recorded and an alert is sent, as before.
- 2026-10-10 — **Amendment (before the first entry): the fixed base as a second reference.** Owner: the
  reference should be the basic rule, 2 × Widesl OTM1 09:17 + 1 × Dir ATM 09:24, and the lists should beat
  it. Decisions: Dir leg ATM at 09:24 (a new file; the live one is ITM1); added beside REF, not replacing
  it; compared in ₹ per lot-day because the lists carry 6 or 8 lots; "beats the base" = block-bootstrap
  90% lower bound of list minus base above zero with drawdown per lot no worse, no minimum size. Built in
  PR #171 (`obt rotation base | readout`): the Dir ATM 09:24 file under `strategies/rotation_base/`, its
  scoring inside `rotation update` (isolated), the random-basket percentile and the bootstrap. History run
  2026-10-10: 488 base days 2024-10-09 .. 2026-10-09, ₹349 per lot-day, ₹1,70,248 cumulative per lot.
- 2026-10-10 — **Context finding for the base (research periods, reconstructed picks, not a verdict).** Per
  lot-day, gross, list minus base with the registered 5-day block bootstrap 90% interval: Jan–Aug 2025 (157
  days, base ₹496): A −₹153 [−352, +40], B −₹157, C −₹153, REF −₹282 [−478, −88]. Dec 2025–Oct 2026 (202 days,
  base ₹208, in-sample for the lists): A +₹156 [−94, +410], B +₹120, C +₹173 [−77, +424], REF +₹104. Both
  periods (359 days, base ₹334): A +₹21, B −₹1, C +₹31, REF −₹65, every interval contains zero. The lists'
  edge is drawdown per lot (about −₹10k to −₹14k against the base's −₹30k on Dec 2025–Oct 2026), not return.
  **The rule as registered is close to unpassable in 60 days:** the typical 90% half-width on a 60-day window
  is ₹320–410 per lot-day, more than the base's own mean; over every 60-day window of the research history
  a list passes 0 of 33 windows in Jan–Aug 2025 and 1 to 6 of 48 in Dec 2025–Oct 2026. A "no" at day 60
  would mostly mean "not enough days", not "the lists do not beat the base". Owner decision before the first
  entry, if wanted: keep the rule as the verdict and also read the drawdown per lot and the interval at day
  120; or register a second, descriptive read-out. Nothing here changes the rule.
- 2026-10-10 — Owner: the fixed base is the **default** reference and REF the second (amendment heading
  updated, before the first entry). View decisions recorded under Phase 4: base as headline benchmark, focus
  list A, placement record allowed (append-only, separate file), 2022–24 matrix import after the first
  version, rotation screens owner-only on the hosted dashboard.
- 2026-10-10 — Widgets 6–10 added under Phase 4 (today's basket on the Correlation tab, forward days vs
  research periods, drawdown episodes, selection drift, paper vs real), with the recommended choices: ₹500
  per lot as the smallest episode, drift flagged against the list's own P1 band, the BL-063 charge model as
  its own registered change, one broker account used only for the rotation. UI only; nothing about the
  journal, the lists or the read-out changes.

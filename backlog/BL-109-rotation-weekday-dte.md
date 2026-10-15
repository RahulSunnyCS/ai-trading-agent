# BL-109 — Rotation days to expiry: count weekdays only, not calendar days

| | |
|---|---|
| **Priority** | P1 — the owner asked for it; it changes the registered rotation rule's DTE input |
| **Status** | Done |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-058 (the rotation lists and forward journal) |
| **TODO.md row** | 3.11.25 |

## Context

The rotation's days-to-expiry label (`dte_n`, `dte_s`) is the number of **calendar** days from
the session to the nearest listed expiry, capped as `7+` (`rotation/score.py: dte_label`; built
from the lake in `rotation/attrs.py`, from Fyers' symbol master for the 09:16 pick in
`rotation/live.py`). A Friday before a Monday expiry is therefore `3`.

The owner (2026-10-15): "while calculating DTE don't calculate Saturday and Sunday", and then
"let's do backtesting 1 year with the change and then finalise". With weekdays only, Friday
before a Monday expiry is `1`, and tomorrow (Fri 16 Oct 2026) reads NIFTY 1 / SENSEX 4 instead
of 3 / 6. Exchange holidays are not excluded (the owner named Saturday and Sunday only).

The DTE fit is one of the five scoring criteria (weights 25–35% in lists A/B/C), so this changes
the picks, not just a label.

## Goal

A decision, from one registered 12-month re-score, on whether the rotation's DTE labels move
to weekday counting. If adopted: history labels, live labels and the Tomorrow header all use it.

## Out of scope

- The Options Lab anatomy `dte` (`legwise/anatomy.py: dte_for`) and the YAML engine's
  `days_to_expiry` feature stay calendar days.
- Excluding exchange holidays from the count.
- Re-fitting any list's weights or lookbacks on the new labels (that would be a new search).

## Plan

### Phase 0 — Pre-register
Committed before any run of `research/bl109/`.

- **Hypothesis:** counting weekdays instead of calendar days gives Steady (list A) and Adaptive
  (list C) results that are no worse than the calendar-day labels over the last 12 months.
  The change is wanted for its meaning, not because it is expected to be better.
- **Universe:** the same 298 rotation variants and the stored per-day results; the same lists
  A and C with their registered weights and lookbacks (unchanged). Point in time: a day's
  scores use only results from days before it, exactly as `daylog.reconstruction` does.
- **Window:** the 12 months to the last scored session: 2025-10-16 to 2026-10-15 (the days of
  `rec.days_available()` in that range, expected about 245). The earlier days only supply
  history.
- **Method:** two re-scores that differ in one input. *Older*: stored calendar-day labels.
  *Newer*: every stored label `k` (0 to 6) replaced by the number of Monday-to-Friday dates in
  `(day, day + k days]`; `7+` and `unknown` kept. The live label is converted the same way.
  Nothing else changes. Gross ₹ per lot-day of the picked basket is read as in the daily log
  (`list_block`).
- **Look-ahead check:** a day's label depends only on that day and the nearest expiry's date,
  both known before the open; no result enters it. The history labels use the same expiry. The
  picker sees only results before the day in both arms. The expiries come from the same
  contracts that traded that day, as for the existing labels.
- **Metrics (per list):** days, win rate, mean ₹ per lot-day, cumulative ₹ per lot, maximum
  drawdown per lot, number of days whose picks differ; and **newer minus older** daily
  difference with a 90% interval from the readout's circular 5-day block bootstrap (2,000
  resamples, seed 20261012). Also the same by half-year, descriptive only.
- **Pass / kill rule:** the change is **not adopted** if, for Adaptive, the 90% interval of
  newer minus older mean ₹ per lot-day lies entirely below zero, or its maximum drawdown per
  lot is more than 20% deeper. Otherwise it is adopted and the result is recorded as
  "no worse", **not** as "better". Steady is reported, and is not part of the rule.
- **Hold-out:** none. The lists' weights were fitted (BL-075) on the calendar-day labels over
  2025-26, so the older arm has a home advantage; "no worse" is therefore a fair bar and any
  gain for the newer arm is not evidence of an edge.
- **Will not run:** a different window, other lists (B, REF), a re-fit of weights on the new
  labels, or a holiday-excluding variant. Running one needs `override: <reason>` in the Log.

### Phase 1 — Run and decide
- **Tasks:** `research/bl109/rescore.py` (read-only; writes only under its own folder), commit
  the result CSV and the numbers below.
- **Deliverables:** the result table in this item's Log; a decision.
- **Done when:** the rule above has been applied and the owner has the table.

### Phase 2 — Make the change (only if adopted)
- **Tasks:** one shared weekday-count helper; `attrs.day_attributes`, `live.listed_dte_labels`,
  `live.calendar_dte_labels` use it; a one-time, idempotent relabel of `rotation/days.csv`
  (backup kept, basis marker); journal entries 2026-10-12 to 2026-10-15 are marked calendar
  basis and converted wherever they are re-scored; new entries carry `dte_basis: weekdays`;
  guide, `technical.md`, package CLAUDE.md and TODO updated in the same commit.
- **Done when:** `obt rotation verify` is intact, the tests pass, and a dry run of `obt rotation
  pick` for tomorrow reproduces the newer arm's picks.

## Risks

- The registered forward test (BL-058) changes its input mid-way: the four journal entries so
  far are on the calendar basis, later ones on weekdays. They are reported separately.
- Friday (before a Monday expiry) and Monday (before a Tuesday expiry) both read `1`; the
  weekday criterion still separates them.
- A relabel run twice would double-convert: the marker and a test guard it.

## Open questions

- None open for Phase 0. The owner chose the weekday definition and the 12-month window.

## Log

- 2026-10-15 — created. Owner decision (chat): DTE skips Saturday and Sunday, scope "rule and
  history too", then "backtest 1 year with the change and then finalise". Before this item
  was registered, an exploratory read-only comparison over the full 427 re-scored days was run
  (Steady +₹367 older / +₹370 newer per lot-day; Adaptive +₹375 / +₹378; picks differ on
  about 15% of days). It is disclosed here and is **not** the registered test: the window,
  rule and interval above are.
- 2026-10-15 — **Phase 1 run** (`research/bl109/rescore.py`; `rescore_2026-10-15.json`, daily
  rows in `rescore_daily_2026-10-15.csv`). 238 scored days, 2025-10-16 to 2026-10-15, gross ₹ per
  lot-day, older = calendar-day labels, newer = weekdays only:

  | | Older | Newer | Newer minus older (90% block bootstrap) | Days picks differ |
  |---|---|---|---|---|
  | **Adaptive** mean | +₹406 | +₹430 | +₹25 [-₹6, +₹63] | 26 of 238 |
  | win rate / cumulative / max drawdown | 65.1% / +₹96,548 / -₹10,089 | 65.1% / +₹102,408 / -₹10,688 | | |
  | **Steady** mean | +₹395 | +₹406 | +₹11 [-₹16, +₹46] | 33 of 238 |
  | win rate / cumulative / max drawdown | 63.4% / +₹94,003 / -₹11,073 | 63.0% / +₹96,650 / -₹11,610 | | |

  By half-year (descriptive): Adaptive +₹377 to +₹425, then +₹434 to +₹436; Steady +₹437 to
  +₹471, then +₹353 to +₹341.
  **Rule applied:** Adaptive's interval is not entirely below zero and its drawdown is 6%
  deeper (limit 20%), so the change is **adopted as "no worse"**. It is **not** shown to be
  better: both intervals include zero, the lists were fitted on the calendar labels, and all
  of it is in-sample. Steady's second half is slightly lower; reported, not part of the rule.
- 2026-10-15 — **Phase 2 done.** `rotation/dte.py` (weekday count, `from_calendar_label`,
  `entry_labels`); `store.read_days` converts the stored calendar labels on read and the file is
  never rewritten (so there is no relabel step to run twice); `live.listed_dte_labels` and
  `live.calendar_dte_labels` count weekdays; `pick.record` writes `dte_basis: weekdays`; the daily
  log, the explain view and the overview read journal entries through `entry_labels`. Tomorrow's
  header and rows say "weekdays to expiry". Guide, `technical.md`, package CLAUDE.md and TODO
  updated. The four forward entries (12 to 15 Oct) stay on the calendar basis as recorded.
- 2026-10-15 — **Review follow-up** (PR #233). Disclosed plainly: the registration was **not blind**.
  The exploratory full-history look above covered the registered window before Phase 0 was
  written; the rule and window were fixed before the registered run, and its numbers reproduce
  exactly from the merged code (`rescore.py` now reads both bases straight from the store).
  Phase 2 differs from its plan: instead of a one-time relabel of `days.csv`, the file is never
  rewritten and labels are converted on read (`store.read_days(basis=...)`), so there is nothing
  to run twice; the "done when" dry run of `obt rotation pick` is recorded in the PR. Entries
  recorded before the change are checked on the calendar days they were scored on
  (`entry_basis`), and every other reader converts them to weekdays. Fixed from the review:
  rank IC, regime forward mix and the selection view now read entries through `entry_labels`;
  live and history labels both go through `from_calendar_label` (a 7 or 8 day gap stays `7+`);
  `scripts/rotation-parity.py` and `research/bl100/replay_lastyear.py` stay on `basis="calendar"`.
  **Open for the owner:** `obt rotation readout` still pools every forward entry from 12 Oct, so
  its 60-day count spans both bases (the first four entries are calendar-day). Split it at
  16 Oct, or restart the count?


# BL-177 — Momentum: re-run each favourite with its end pinned to the anchor (data changed, result same / changed)

| | |
|---|---|
| **Priority** | P2 — the history check already says when stored data changed; this adds whether a favourite's result moved with it |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | momentum |
| **Created** | 2026-10-28 |
| **Depends on** | [BL-001](BL-001-momentum-result-integrity.md) Phase 4 (`mbt verify history`, scheduler job `momentum-history`) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-001's Phase 4 was re-scoped on 2026-10-22 to a weekly check that re-runs each favourite with
its end pinned to the last accepted anchor and names the instruments whose history changed. On
2026-10-28 the owner chose to build only the second half for now: `mbt verify history` fingerprints
every price series, stock bar and corporate action up to a fixed anchor Friday and names each one
whose history changed (Fri 22:00 scheduler job `momentum-history`). It does not re-run any strategy,
so it says *what* data changed, not *whether a result moved*.

What BL-052 already gives: every saved run stores its data and code versions, and a moved result is
labelled `data_revised`, `intended`, `check` or `not_reproducible`. But it has no pinned end date, so
every Friday's new week reads as `data_revised`, and a restated old close hides in that noise. Only
`not_reproducible` sends a Telegram.

`scripts/result-baseline.py capture | compare` re-runs every favourite on live data by hand, also
without a pinned end.

## Goal

A weekly re-run of every favourite (groups as their sleeves) with `end` pinned to the history
check's anchor, classified against a stored result at that anchor:

| Data up to the anchor | Result | Outcome |
|---|---|---|
| same | same | OK |
| changed | same | information: data changed, no effect on this favourite |
| changed | changed | Telegram: per favourite, CAGR / max drawdown / Sharpe before and after, and the changed instruments (from `verify history`) |
| same | changed | Telegram: the result changed with identical data. Cause is a code change the goldens missed (add a scenario), look-ahead or non-determinism; shows the baseline commit against the current one |

## Out of scope

- Changing how `mbt verify history` fingerprints data (BL-001, done).
- Accepting anything automatically: a change stays until `--accept --reason`.
- Saved runs that are not favourites.

## Plan

### Phase 1 — Pinned re-run and classification
- **Tasks:** store, per favourite, the result at the history check's anchor (KPIs, a hash of the
  equity curve and of the trades, code commit), next to the history baseline in the Momentum state
  folder or in an append-only catalog table (decide when started); re-run each favourite through the
  real API with `end` = the anchor; classify with the table above, reading the data side from
  `verify.run`'s diff; `--accept --reason` re-baselines both; re-anchor with the history baseline when
  it advances. Run with no catalog connection held across a backtest (the package's catalog rule).
- **Deliverables:** a `mbt verify favourites` command (or a `--favourites` option on `verify
  history`), unit tests for the classification, and the scheduler step.
- **Done when:** on a scratch copy of `TRADING_DATA_ROOT`, editing one close before the anchor gives
  "data changed" naming that instrument and the favourites that read it; with the copy restored,
  patching a cost constant gives the "identical data" outcome.

### Phase 2 — Schedule and messages
- **Tasks:** add it to the Friday `momentum-history` job (or its own job after it), with the
  history check's exit rules (a finding is its own Telegram and exits 0; exit 1 only when it cannot
  run); update the Jobs guide page, the scheduler's CLAUDE.md and technical.md.
- **Done when:** one Friday's run reports every favourite OK on live data.

## Risks

- **Run time.** Each favourite is a full backtest (Broad about 20 s cold); a few minutes in all.
  Keep the job's timeout and the `catalog` group in mind.
- **A pinned end is not quite today's result.** The weekly signal reads the newest week; this checks
  the history only.

## Open questions

BL-001's original Phase 4 questions, still open:

1. If a favourite's result changes with identical data in the week it is the headline, should that
   week's Telegram signal be held back, or sent with a warning?
2. Is advancing the anchor with the history baseline (a clean check more than 28 days behind) right
   for results too?
3. Should Saved runs also badge a favourite whose pinned re-run no longer matches?

## Log

- 2026-10-28 — created from BL-001 Phase 4 (owner: build the history check only for now; the pinned
  favourite re-run later). P2, `Planned`.

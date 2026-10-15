# BL-106 — Picker POC: Steady, Calendar and Adaptive over a candidate pool

| | |
|---|---|
| **Priority** | P1 — tells whether a wider, safer universe improves the live rotation's lists |
| **Status** | In progress (Phase 0 registered 2026-10-15) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-104 (Stage 1 results, scorecard, tail gate); BL-058 (the registered lists A / B / C / REF) |
| **TODO.md row** | 3.10.28 |

## Names used in this item (owner, 2026-10-15)

| Name | What it is |
|---|---|
| **Core-298** | The live rotation's 298 variants in `strategies/rotation/` (frozen; one fixed configuration per family, repeated at every entry time) |
| **New-536** | The candidate pool selected from the first year only: 91 sets, 536 variants, settings differing by time band |
| **New-556** | New-536 plus the ITM amendment (three NIFTY Dir ITM1 sets, 20 variants) |

A list over a universe is written "Steady on Core-298", "Adaptive on New-556".

## Context

The owner (2026-10-15) asked for a proof of concept: run the rotation's registered lists — Steady (A),
Calendar (B), Adaptive (C) and Baseline (REF), with their weights and 5 / 21 / 63 / 126-day lookbacks
unchanged (`rotation/lists.py`, `rotation/score.py`) — over the candidate pool from BL-104 instead of
the 298 variants, and see whether that gives a clear winner. Owner choices: test the last year only;
choose the pool from the first year only; compare without charges, the same basis as the 298's stored
results (charges may follow overnight); four workers; keep it basic and fast.

## Goal

For each list, whether choosing from the pool beats choosing from the 298 over the test year.

## Out of scope

Changing the registered lists or the live rotation; the frozen 298; re-simulating the 298 with charges;
unverified re-entry types; any adoption from this item alone.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** a list choosing from the pool earns more per lot-day than the same list choosing
  from the 298, without a deeper drawdown, over a year neither the pool nor the lists were fitted on.
- **Windows:** pool selection on 2024-10-09 → 2025-10-08 (first year); test on 2025-10-09 →
  2026-10-09 (weekday sessions). History for the lists' lookbacks starts 2025-04-01 for the pool
  (126 days before the test) and 2024-10-09 for the 298 (its stored results).
- **Pool selection (from the first year only):** BL-104 Stage 1 cells, first-year figures computed
  from the stored day × cell series (after charges, as the BL-104 gates are defined); day-stop rate
  and entry rate are not in the series and are taken from the full two-year Stage 1 summary (a small,
  disclosed leak: behaviour rates, not P&L). Gates: net > 0, Calmar ≥ 1, day-level profit factor ≥
  1.05 (the series has no trades; a disclosed approximation of the trade-level gate), day-stop rate ≤
  30 % (Widesl, Dir) / ≤ 60 % (Buy), entry rate ≥ 95 % (Widesl, Dir), Buy hit rate ≥ 40 %, the
  worst-day gate (worst day and five worst days ≤ 1.5 × the cohort template's, floors ₹3,000 /
  ₹15,000), the plateau rule; plus a required day MTM stop, Widesl leg stop ≤ 100 %, no RE COST ×2 or
  RE ASAP. Per family × index × band, up to four band candidates, best robust score first, each
  differing from those already taken in at least two settings; each taken set is applied at every
  rotation slot of its band (25 slots; Buy has no 15:17).
- **Simulation:** the pool at every slot of its band from 2025-04-01 to 2026-10-09 with the legwise
  engine (`lot_sizing: current`, no slippage); the result used is gross (before charges), with net
  after the BL-096 charge model reported alongside.
- **Lists:** `pick.score_history` with the registered `LISTS` unchanged; the pool's variant names are
  mapped to the picker's families (Widesl / Dir / Buy) and start bands; picks 3 core (at least 2
  Widesl) + 1 Buy when in the top 10, 2 lots each, as registered. The 298 lists are reconstructed with
  the same function over the stored results.
- **Pass rule, per list:** pool list minus the same list over the 298, daily gross per lot: 5-day
  circular block bootstrap (2,000 resamples, seed 20261012) 90 % lower bound > 0 **and** the pool
  list's maximum drawdown per lot no worse than the 298 list's. A list passing this is a **winner**.
  Also reported, not gating: each against the owner's fixed base, the pool's after-charges figures.
- **Hold-out:** the test year is unseen by the pool selection. It was used by BL-099 to pick the
  BL-104 families' earlier winners, which shaped the grid's axes; disclosed.
- **Will not run:** other lookbacks or weights, other pool sizes after seeing the result, more than one
  pool. Any of these needs `override: <reason>` in the Log.

### Phase 1 — Build and run
- **Tasks:** first-year scoring from the stored series, pool selection, pool simulation, list replay,
  read-out.
- **Done when:** the four lists have a pass / fail against the rule above.

## Risks

- The pool and the 298 differ in family mix (the pool has no NIFTY Buy and no unverified re-entries),
  so a difference may come from the mix, not from robustness.
- Twelve months is short for a list that trades three or four strategies a day.

## Log

- 2026-10-15 — created and registered from the owner's request (test year only, no charges, pool
  from the first year, four workers).
- 2026-10-15 — **Amendment before any list replay (owner):** each NIFTY Dir band whose four
  first-year-selected sets hold no ITM1 / ITM2 gets one extra set, the strongest ITM candidate by
  first-year robust score that passes the same gates, has a day stop and a verified re-entry
  (`research/bl106/pool_ext.py`). Bands A, B and C each gain one ITM1 set (SL 15 / 25 / 20, trail
  10/5, MTM ₹4,000 / ₹4,000 / ₹2,000, re-entry at cost once); band D already had ITM1. Reason: in
  first-year scoring ITM1 / ITM2 ranked a few points below ATM and OTM1 for NIFTY Dir and fell out of
  the top four, so the pool had no ITM exposure on NIFTY. +3 sets, +20 variants (556 in all). The
  main simulation had started; the extras run as a separate job set and are merged in the replay.

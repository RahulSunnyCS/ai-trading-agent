# BL-082 — Re-run the hourly-checkpoint study with a real VWAP from futures bars

| | |
|---|---|
| **Priority** | P3 — waits for data |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-081 (step 1 and its state table), the daily collector's futures bars |
| **TODO.md row** | — |

## Context

BL-081 tests market-state variables at 10:30 / 11:30 / 12:30 / 13:30. A true VWAP is not available for its
backtest: the lake's index bars carry volume 0 before 2026-09 and the nearest / next futures bars exist only
from 2026-09-23 (collected daily since, `bars_1m/asset=future`). BL-081 uses two substitutes: spot against
its time-weighted average, and the ATM straddle against its volume-weighted average built from option bars.
The owner (2026-10-10) asked to run the real thing once enough futures history exists.

## Goal

BL-081's step 1 repeated with VWAP of the nearest-month NIFTY and SENSEX futures since 09:15, so the
question "does price vs VWAP at the hour order the afternoon strategies" is answered on real volume.

## Out of scope

Rule building (that is BL-081 step 2), changing any other variable, back-filling futures history (the
vendor has none in the lake).

## Plan

### Phase 0 — Pre-register (before the run, when the data is ready)
- **Not before 2027-03-23** (six months of futures bars from 2026-09-23, about 120 sessions). First check
  `bars_1m/asset=future` coverage: nearest-month contract per day, volume non-zero, no gaps.
- **Variable:** futures price vs futures VWAP since 09:15 at h; bands below / near (±0.10%) / above;
  the same 20-shuffle read-out, one period only (the futures window), so the bar is *report only*: the
  result cannot count under BL-081's three-period rule and is judged against the substitutes' result on
  the same days.
- **Done when:** the table is recorded here and BL-081's variable table is updated if it changes which
  variable counts.

## Risks

Six months is about 120 sessions: a single-period result, thin for four hourly checkpoints. It supplements,
it does not replace, BL-081's three-period evidence.

## Log

- 2026-10-10 — created at the owner's request (re-run with real VWAP after six months of futures data).

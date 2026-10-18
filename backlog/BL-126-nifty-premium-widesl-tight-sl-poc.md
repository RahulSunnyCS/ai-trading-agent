# BL-126 — POC: NIFTY Widesl ₹100 at SL 75 % and ₹120 at SL 60 %

| | |
|---|---|
| **Priority** | P3 — owner's idea, a quick look before anything is planned |
| **Status** | In progress — POC |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (rotation lists, results store), BL-104 (the sweep the idea came from) |
| **TODO.md row** | — (POC only; a row is added if it goes further) |

## Context

Owner (2026-10-18): "I was thinking of trying N_100 with 75 % SL widesl", then "lets create a 120 with 60 % too",
"Backtest first", "initially do poc". Core's `N_p100_*` sells the CE and PE closest to ₹100 with SL 115 %,
trail 15 %/10 %, no re-entry, ₹2,500 overall max loss. Before choosing, the owner saw BL-104 stage-1 summaries
for NIFTY ₹100 Widesl (trail 15/10, no re-entry, MTM ₹2,000/₹3,000, 7 sampled slots, 2024-10 → 2026-10, net):
SL 80 % about +₹79–83 per lot-day against SL 120 % about +₹53–54, uneven by slot. Those summaries cover every
window used below, so this POC is **not** an independent test of that observation.

## Goal

Say, descriptively, whether the two settings do better than Core's ₹100 Widesl at the same entry times, and
whether Adaptive would have done better with them in its universe. Nothing is adopted from a POC.

## Out of scope

Changing Core-298, T1 or the live lists; a forward track (proposed separately, only if the POC reads positive);
other premiums, SENSEX, other stops.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Arms (owner-chosen, no data selection):** X1 = NIFTY Widesl closest premium ₹100, SL 75 %; X2 = NIFTY
  Widesl closest premium ₹120, SL 60 %. Everything else as Core's `N_p100`: sell CE + PE, 1 lot each, weekly
  expiry, trail 15 %/10 % (percent), no re-entry, overall max loss ₹2,500, exit 15:28, partial square-off,
  current lot sizing. Each at the 25 rotation entry times (50 variants). Comparator: Core `N_p100_<slot>`.
- **Simulation:** the same leg-wise engine, costs and data-quality exclusions as `obt rotation update`
  (results in this item's research folder only; the live results store, journal and strategy folders are
  never written).
- **Q1 (standalone, net of charges):** per day, the mean over the 25 slots of (arm minus Core `N_p100`) at the
  same slot; mean per lot-day with a two-sided 90 % circular block bootstrap (5-day blocks over ordered days,
  2,000 resamples, seed 20261018), on every collected day from 2024-10-09 to the latest scored day. Also per
  slot (descriptive) and max drawdown of the slot-averaged series.
- **Q2 (Adaptive):** list C (registered weights and lookbacks, no expiry rule), replayed over Core-298 + the
  50 variants against Core-298 on the same days (2025-01-10 → latest), gross per lot-day as the read-out
  defines it, paired difference with the same bootstrap; max drawdown; how many days and slots a new variant
  is picked. One replay with both arms added, and one each.
- **Reading (descriptive, in-sample):** "positive" = the 90 % interval above zero and the drawdown no deeper
  than the comparator's. A positive Q2 only allows proposing a pre-registered forward-only track; it does not
  change any live list.
- **Look-ahead check:** the strategy is chosen at entry from that minute's chain (engine rule); Adaptive's
  composite on day d uses results before d only (the existing replay code).
- **Hold-out:** none: every window was seen by the owner's sweep summary. Recorded as a known weakness.
- **Will not run:** other stop levels, other premiums, SENSEX, a selection among slots, a net-of-charges
  Adaptive replay beyond what the read-out already does.

### Phase 1 — POC run

- **Tasks:** strategy YAMLs and a runner in `packages/option-backtesting/research/bl126/`; Q1 and Q2 scripts;
  write `results/` (git-ignored) and a short JSON summary.
- **Done when:** the Log has Q1 and Q2 with intervals, drawdowns and pick counts, read under the rule above.

## Log

- 2026-10-18 — Created and Phase 0 registered before any run (owner chose the two settings).

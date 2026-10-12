# BL-100 — Rotation lists A/B/C restricted to the BL-099 families, tested on 2022–24

| | |
|---|---|
| **Priority** | P2 — find out whether narrowing the candidate pool to the post-charge winners helps or hurts the daily ranking |
| **Status** | Planned (pre-registration; not run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-12 |
| **Depends on** | BL-058 (lists A/B/C/REF, journal), BL-096–098 (sweeps), BL-099 (combined final list), BL-034 (vendor history) |
| **TODO.md row** | — (add when started) |

## Context

Lists A, B, C and REF rank the 298 whole-day variants each morning and pick three
strategies of two lots (at least two Widesl; a Buy add-on when one is in the top ten).
BL-099 names one Directional or Widesl configuration per index and timing band after
charges. Those cells were chosen on the 2025-10-09 → 2026-10-09 holdout, and the lists'
weights were fitted on 2024–26, so neither has been seen on earlier years.

## Goal

Does restricting the pool the lists rank to the BL-099 families change the lists'
net result against the fixed base and against the unrestricted lists, on sessions neither
was tuned on?

## Out of scope

- Any change to a registered list, the journal, the 298 universe or a stored result.
- SENSEX before 2023-07 (no options data); SENSEX is not tested here.
- New parameters: the pool uses the registered baseline-parameter variants, not the
  BL-096 tuned stops. A tuned-parameter pool is a separate item.

## Registered experiment

- **Window:** P3, 2022-04-05 → 2024-10-08, NIFTY only, sessions that `data_quality`
  marks usable. The first 63 sessions are warm-up and are not scored.
- **Variants:** the 149 NIFTY rotation variants (`N_*`), simulated with the registered
  YAMLs and `lot_sizing: current` into a separate store under `research/bl100/`.
- **Pools (three, no others):**
  - `full`: all 149 NIFTY variants (the unrestricted comparator);
  - `fam`: `N_dir_*` and `N_p100_*` (the BL-099 NIFTY families);
  - `fam_band`: `N_dir_*` entries before 13:00 plus `N_p100_*` entries from 13:00.
- **Lists:** A, B, C, REF exactly as in `rotation/lists.py`; the rule, lookbacks, lots
  and Widesl minimum are unchanged. The Buy add-on is available only in `full`.
- **Metric:** ₹ per lot-day net of the BL-063 charge model, before slippage; maximum
  drawdown per lot; list minus fixed base with a 5-day block bootstrap 90% interval
  (seed 20261012), as the readout does.
- **Look-ahead control:** each day's ranking reads only results before that day plus
  that day's weekday, VIX band and days to expiry; the pools are fixed before the run.
- **Decision rule:** descriptive. A restricted pool is "better" only if its
  list-minus-full interval has a lower bound above zero in P3 and its drawdown per lot is
  no worse. Nothing is adopted automatically; forward days remain the test.

## Risks

- Three pools × four lists is twelve comparisons on one window; read the intervals, not
  the point estimates.
- Vendor history may differ from the Fyers/Angel data the lists were built on; check the
  data-quality verdicts and lot-size history before reading the result.
- The `fam` pool forces at least two Widesl picks from `p100` variants, which changes the
  lists' mix; report the pick frequencies with the P&L.

## Log

- 2026-10-12 — drafted from the owner's request ("run A/B/C restricted to the BL-099
  families, on previous years"). Not committed; the research gate needs the committed
  pre-registration before any run.

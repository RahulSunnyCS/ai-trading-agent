# BL-096 — Directional stop, re-entry, trailing and exit sweep

| | |
|---|---|
| **Priority** | P2 — improve the understanding of the existing Directional family without changing the live baseline |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-11 |
| **Depends on** | BL-034, BL-058 |
| **TODO.md row** | 3.10.23 |

## Context

The existing Directional family is a two-leg short CE+PE strategy, not the separate
Buy family. The committed rotation universe contains 100 Directional variants:
NIFTY and SENSEX × ATM and ITM1 × 25 start times from 09:17 through 15:17.
They currently use a 21% per-leg stop, one cost re-entry, a ₹3,000 overall MTM
stop and a 15:28 exit. The owner asked to compare alternative per-leg stops,
overall MTM stops and exit times, then include the other non-asymmetric controls
that may materially change the result.

## Goal

Produce a reproducible two-year parameter map for all 100 existing Directional
variants, with the current 21% / ₹3,000 / cost×1 / 15:28 setup kept as the
baseline. Report gross and all available execution metrics by index, strike type,
start time, parameter set and two chronological periods. Do not modify the live
strategy files or adopt a winner automatically.

## Out of scope

- Asymmetric CE/PE rules; both legs always share the same stop and re-entry rule.
- New moneyness families such as ITM2 or OTM1; ATM and ITM1 are already represented.
- Any ranking or live rotation rule change.
- Selection based on the full two-year result without a chronological hold-out.

## Plan

### Phase 0 — Pre-register

- **Hypothesis:** the best Directional performance may come from a different
  combination of per-leg stop, overall MTM stop and exit time, while re-entry and
  trailing rules may explain part of the difference between variants.
- **Universe:** the 100 committed files under `strategies/rotation/` matching
  `N_dir_*`, `N_ditm1_*`, `S_dir_*` and `S_ditm1_*`; common collected sessions
  from 2024-10-09 through 2026-10-09, using the point-in-time reference data and
  the existing Fyers/lake bars. The 2024-10-09 through 2025-10-08 period is the
  fit period; 2025-10-09 through 2026-10-09 is the chronological hold-out.
- **Primary grid:** per-leg SL `{10, 15, 21, 25, 30, 35}%`; overall MTM SL
  `{₹2,000, ₹2,500, ₹3,000, ₹3,500, ₹4,000}`; exit time `{14:50, 15:00,
  15:10, 15:20, 15:28}`. This is 150 combinations per existing variant.
- **Secondary grid:** re-entry `{none, cost×1, cost×2, asap×1, asap×2}`;
  re-entry cutoff `{none, 11:00, 12:00, 13:00}`; trailing SL `{none,
  [5%,5%], [10%,5%], [15%,5%]}`. Secondary interactions are evaluated first
  against the baseline and then for the pre-registered primary candidates, not
  as an unrestricted cross-product.
- **Look-ahead check:** every configuration uses the same day set and only bars
  from its own entry through its configured exit; no result from the hold-out is
  used to choose a candidate. Existing strategy files and the point-in-time
  reference tables are read-only inputs.
- **Pass / kill rule:** this is a descriptive study; no configuration passes to
  production from this run alone. A candidate is only marked *stable candidate*
  if it beats the baseline on fit-period net P&L per strategy-day without a
  worse fit-period max drawdown, and keeps the same direction of improvement on
  the hold-out. Otherwise it is reported as exploratory or killed. The baseline
  remains the live choice regardless.
- **Hold-out:** the second chronological year remains unseen for candidate
  selection and is reported separately at the end.
- **Will not run:** asymmetric CE/PE stops, new strike families, unrestricted
  all-factor Cartesian combinations, or live-file replacement. Any addition
  requires a dated superseding pre-registration and an `override: <reason>` in
  this item's Log.

### Phase 1 — Primary stop/exit map

- **Tasks:** run the 150 primary combinations on all 100 existing variants;
  compare against the unchanged baseline; calculate net/gross P&L, max
  drawdown, win rate, stop frequency, average daily P&L, and worst day for fit,
  hold-out and full windows.
- **Deliverables:** machine-readable result table, summary tables by index,
  strike type and start-time band, and a short baseline-relative readout.
- **Done when:** all 15,000 primary configurations have either a result or an
  explicit data/error status, with no silent row loss.

### Phase 2 — Secondary controls

- **Tasks:** evaluate re-entry, cutoff and trailing controls as registered above,
  first against the baseline and then against the stable primary candidates.
- **Deliverables:** secondary result table and hold-out comparison.
- **Done when:** each tested control reports whether it improves both periods or
  only one.

## Risks

- The grid contains many trials; the fit/hold-out split and descriptive framing
  are required to avoid treating the best historical cell as a discovered edge.
- Wider stops can reduce stop frequency while increasing tail losses; report
  drawdown and worst day beside return.
- More re-entries increase transaction count; the initial map must retain gross
  and costs separately, and finalists should be rechecked with the owner’s real
  charge/slippage model before any live decision.

## Open questions

- None blocking the registered run. The actual charge/slippage model is a
  separate finalist check because the owner has not specified its levels here.

## Log

- 2026-10-11 — created and pre-registered from the owner’s request. Confirmed
  the 100-file universe and 490 common sessions (2024-10-09..2026-10-09).

# BL-111 — Switch the strategy mix by the range regime: more Dir when ranges are expanding, more Widesl when they are quiet

| | |
|---|---|
| **Priority** | P2 — owner's idea; builds on BL-110; a close cousin of BL-053 (killed) |
| **Status** | Idea |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-110 (range persistence), BL-058 (the lists and their stored results) |
| **TODO.md row** | — |

## Context

Owner (2026-10-15, chat): "if there is a big range happening, then we can have either directional or
buy opportunities, which is better during the large-range thing. So if we are having six, we can
increase the directional up to three. And during non-directional, when the range contracts, maybe we
can switch to four or five wider (Widesl) sells."

What the repo already says:

- **BL-110:** NIFTY's day range persists. After an expanded session (range ≥ 1.25× the 20-session
  median) the next five sessions average 1.2 to 1.3× the norm. After a quiet session (≤ 0.80×)
  they are about normal (0.95 to 1.09×), not smaller; only the chance of another quiet day is
  higher (0.42 to 0.44 vs 0.32). About half of the persistence is also in VIX.
- **BL-053 (killed):** a 10:00 VIX-move switch between 2 Dir + 2 Buy + 2 Widesl and 4 Widesl +
  1 Dir + 1 Buy beat each fixed mix by only +7.6% (needed 10%) with a worse drawdown, and most of
  its gain came from starting at 10:00, not from switching. Per lot, VIX-up days vs quiet days:
  Widesl ₹66 vs ₹241, Dir ₹453 vs ₹374, Buy −₹77 vs −₹17 (Buy lost on both).
- **BL-081 / BL-083:** triggers that find "more movement" suit Dir and Buy shapes and hurt
  short-volatility Widesl, but no hourly state variable passed, and the Dir lead is regime-dependent
  (from mid-2024).
- The lists already carry a VIX-band fit (20 to 24% of the score) and a days-to-expiry fit.

## Goal

An answer, on days not used to choose the rule, to: does setting the Dir / Widesl split by the
previous session's range state earn more, with no worse drawdown, than the list's own basket and
than any fixed split of the same size?

## Out of scope

- Any change to the live lists, weights or the journal (this is a recombination of stored results).
- A new entry time (BL-053 showed a later start is a separate question).
- Buy as an extra "directional" lever unless the owner says so (it lost on both kinds of day in
  BL-053).

## Plan

### Phase 0 — Pre-register (draft: to be confirmed by the owner before any run)

- **Hypothesis:** on days following an expanded session, a basket with 3 Dir + 3 Widesl earns more
  than 1 Dir + 5 Widesl of the same 6 lots; on days following a quiet session the reverse holds
  or the difference is small; and the state-based switch earns more than both fixed splits.
- **Signal, known at 09:16:** `E = R_{t-1} / median(R over the 20 sessions before t-1)` from the
  NIFTY index bars of the previous session (as BL-110). **Expanded** if `E ≥ 1.25`, **range-bound**
  if `E ≤ 0.80`, otherwise **normal**. Thresholds are the BL-110 ones, not tuned here.
- **Baskets (6 lots, NIFTY variants only):**
  - *Switch:* expanded → 3 Dir + 3 Widesl; range-bound → 1 Dir + 5 Widesl; normal → the list's
    own mix (A and C each).
  - Within a kind, the variants are the highest-scoring ones of that kind under the list's own
    composite on that day (the same ranking the 09:16 job already computes), no new fit.
  - *Controls:* the list's own basket; always 3 Dir + 3 Widesl; always 1 Dir + 5 Widesl; and a
    **placebo** in which the state labels are shuffled across days (500 shuffles) to see whether
    the state matters at all.
- **Data / periods:** stored per-variant daily results. Rule fixed on 2025-01-10 → 2026-10-08
  (P2 + P1, already seen). Hold-out: **2022-04-05 → 2024-10-08 (P3, NIFTY only)**, unseen, run
  once, only if the rule is fixed first. If P3 per-variant results are not in the store, they
  are built from the lake by the same variant files before the rule is run (to be confirmed).
- **Look-ahead check:** the signal uses only the previous session's bars; the ranking uses only
  results before day `t`; the hold-out is not read until the rule and thresholds are committed.
- **Pass / kill rule:** pass only if, on the hold-out, the switch beats the list's own basket
  and both fixed splits in total gross ₹ by at least 10%, with maximum drawdown no worse, **and**
  beats the median of the 500 placebo shuffles. Otherwise killed.
- **Will not run:** other thresholds, other splits, 2-day or VIX-based signals, intraday signals,
  Buy as a lever. Each needs a new dated block and `override: <reason>`.

## Risks

- BL-053 is a close precedent that failed on exactly this kind of switch; the previous-day range
  is information VIX largely already carries (BL-110).
- The range-bound side has the weakest footing: BL-110 found quiet sessions are not followed by
  smaller ranges.
- Dir's edge appears only from mid-2024 (BL-083); a hold-out in 2022 to 2024 may simply not have
  it, which would kill a rule that works now.

## Open questions

1. What does "six" mean: 6 strategies at 1 lot, or today's 3 strategies × 2 lots (6 lots)?
   Draft above assumes 6 lots, as in BL-053.
2. Dir only, or Dir + Buy, as the "directional" lever? Draft: Dir only.
3. Range-bound mix: 1 Dir + 5 Widesl, or 2 Dir + 4 Widesl?
4. Signal: previous session's range only, or also today's 09:15 VIX band?

## Log

- 2026-10-15 — created from the owner's chat idea; drafted against BL-110 and BL-053.

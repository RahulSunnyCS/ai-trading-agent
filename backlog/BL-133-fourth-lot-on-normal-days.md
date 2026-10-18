# BL-133 — A fourth lot on non-expiry days: which pick in T1 (Widesl) and in Core (Dir)

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each, ₹8.5 lakh per account) |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (lists, results store), BL-113 (T1), BL-129 (rank 1 vs rank 2), BL-111 (H1 lot ladder, not run) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18): one ₹8.5 lakh broker account runs T1 (3 lots), another runs Core-298 (3 lots). A fourth lot
does not fit the expiry-day margin (≈ ₹10.2 lakh), so: 3 lots on expiry days, 4 on other days. Where should the
fourth lot go? Owner's idea: in T1 on a Widesl ("add one more Widesl, or put one Widesl at two lots"), in Core on the
Dir ("add one more directional, or make that directional two"). And what does it do to drawdown.

## Goal

For each book, the result, drawdown and worst day of each fourth-lot placement against 3 lots and against the same 4
lots spread evenly; nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Picks:** Adaptive list C (registered weights and lookbacks, no expiry rule) replayed day by day from the stored
  results over Core-298 and over T1 (Core-298 + 223 T1 variants), as in BL-129: the day's composite (`pick._rank`),
  core picks (Buy add-on left out), the runners-up from `score.runners_up` (best unpicked Widesl and Dir).
- **Expiry day:** NIFTY or SENSEX weekday days to expiry `0` in `days.csv` → 3 lots (one per pick) in every book.
  Other days → 4 lots as below.
- **T1 placements (owner's):** T-W1 = second lot on the higher-composite Widesl pick; T-W2 = second lot on the
  lower-composite Widesl pick; T-W+ = the best unpicked Widesl added as a fourth strategy.
- **Core placements (owner's):** C-D2 = second lot on the Dir pick (a three-Widesl day: the best unpicked Dir is
  added instead); C-D+ = the best unpicked Dir added as a fourth strategy.
- **Comparators:** B3 = 3 lots every day (today); B4 = 4 lots on non-expiry days spread as 4/3 of each pick (the same
  extra size with no choice of pick, the fair yardstick for "does this placement beat an average lot").
- **Measures (gross per one-lot results × lots):** per-day total, annualised; max drawdown; worst day; and, per
  placement, the extra lot's own result on non-expiry days (placement − B3), its 90 % circular block bootstrap over
  all days (5-day blocks, 2,000 resamples, seed 20261025), and placement − B4 with the same interval.
- **Charges, stated not modelled exactly:** a second lot of a picked strategy adds no brokerage (same orders), an
  added strategy adds about ₹94 a day of brokerage (2 orders × the stored `n_trades` × ₹20 × 1.18); turnover charges
  scale with lots in every arm alike. Net lines subtract the brokerage only.
- **Windows:** 2025-01-10 → 2026-10-16 and the last year 2025-10-09 → 2026-10-16.
- **Reading:** a placement "earns its lot" if placement − B4 has its interval above zero; "costs" if below. Drawdown
  and worst day reported, not judged. Descriptive, in-sample (days read by BL-115 and others; T1's two-year window
  overlaps its selection year). It changes no list.
- **Look-ahead check:** day d is ranked on results before d; runners-up come from day d's composite only.
- **Will not run:** other placements, 5+ lots, Buy, the 2-2-1-1 ladder (BL-111 H1, registered separately).

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl133/fourth_lot.py`; JSON; Log.
- **Done when:** the Log has every placement and comparator for both books and windows.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the placements).

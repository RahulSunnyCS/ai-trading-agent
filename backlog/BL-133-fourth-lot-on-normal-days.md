# BL-133 — A fourth lot on non-expiry days: which pick in T1 (Widesl) and in Core (Dir)

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each, ₹8.5 lakh per account) |
| **Status** | Done — informative: Core's extra lot on the Dir beat an even spread; T1's extra Widesl lot did not |
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
- 2026-10-18 — **Run as registered** (`research/bl133/fourth_lot.py`; `fourth_lot_2026-10-18.json`). Gross per
  one-lot results × lots; 3 lots on expiry days (181 of 428 days; 104 of 244 in the last year), 4 on the others.
  "Extra lot" = placement − B3 per day (all days); "vs B4" = placement − the same extra size spread 4/3 over the picks.

  | Book, window | Arm | Per day | Max drawdown | Worst day | Extra lot (90 %) | vs B4 (90 %) | vs B4 after added brokerage |
  |---|---|---|---|---|---|---|---|
  | Core, two years | B3 / B4 | +1,216 / +1,332 | −35,457 / −45,741 | −10,532 / −12,547 | | | |
  | | **C-D2 Dir ×2** | **+1,494** | −38,550 | −13,098 | +277 [+143, +407] | **+161 [+28, +292]** | +149 [+14, +279] |
  | | C-D+ add a Dir | +1,359 | −40,565 | −13,219 | +143 [+3, +273] | +27 [−116, +169] | −43 [−188, +100] |
  | Core, last year | B3 / B4 | +1,393 / +1,505 | −31,486 / −38,622 | −9,919 / −12,099 | | | |
  | | **C-D2 Dir ×2** | **+1,744** | −32,815 | −11,986 | +351 [+196, +501] | **+239 [+100, +388]** | +230 [+90, +379] |
  | | C-D+ add a Dir | +1,672 | −34,439 | −12,096 | +279 [+129, +425] | +167 [+2, +333] | +98 [−68, +265] |
  | T1, two years | B3 / B4 | +1,885 / +2,103 | −23,300 / −30,526 | −13,809 / −18,412 | | | |
  | | T-W1 top Widesl ×2 | +2,071 | −32,943 | −19,510 | +186 [+59, +298] | −31 [−110, +47] | −31 [−110, +47] |
  | | T-W2 2nd Widesl ×2 | +2,047 | −28,334 | −18,844 | +162 [+54, +265] | −56 [−130, +14] | −56 [−130, +14] |
  | | T-W+ add a Widesl | +1,973 | −30,867 | −19,026 | +88 [−23, +199] | **−129 [−234, −20]** | −185 [−291, −76] |
  | T1, last year | B3 / B4 | +2,100 / +2,363 | −23,300 / −27,903 | −13,809 / −18,412 | | | |
  | | T-W1 | +2,305 | −29,001 | −19,510 | +205 [+52, +345] | −58 [−159, +41] | −58 [−159, +41] |
  | | T-W2 | +2,333 | −28,334 | −18,844 | +233 [+110, +360] | −30 [−113, +52] | −30 [−113, +52] |
  | | T-W+ | +2,169 | −30,867 | −19,026 | +68 [−82, +214] | **−194 [−318, −73]** | −250 [−374, −129] |

  **Read under the rule.** Core C-D2 (the Dir at two lots) **earns its lot** in both windows (vs B4 above zero, also
  after brokerage), with a drawdown between B3's and B4's. Core C-D+ is above zero against B4 on the last year only.
  T1's Widesl placements do not beat an even spread (T-W1 / T-W2 include zero; T-W+ costs). Every fourth lot adds
  money against 3 lots and deepens the drawdown and the worst day. Weaknesses: in-sample (days read by BL-115, BL-129
  and others; T1 overlaps its selection year), gross, turnover charges taken as equal across arms. Consistent with
  BL-129's per-pick means (Core: Dir +580 vs Widesl +227 / +409 per lot-day; T1: other pick +745 vs Widesl +470 /
  +670), which also suggests T1's Dir as a candidate for the fourth lot; that placement was not registered here.

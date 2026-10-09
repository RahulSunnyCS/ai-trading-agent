# BL-055 — Daily portfolio stop-loss on the NIFTY benchmark mixes

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-054 |
| **Status** | Done (exploratory: owner override, no hold-out) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-054 (its benchmarks B1–B3) |
| **TODO.md row** | — |

## Context

Owner's idea (2026-10-09 chat): cap the loss on any single day at about 1% of the capital behind
the book (₹12.5k for 5 lots), by closing everything once the combined P&L of the day reaches the
stop. Each strategy already has its own overall stop (₹2,500–₹3,000 for 1 lot); this adds one
stop over the whole mix. Question: how bad are the worst days, and what do three stop levels do
to total P&L and drawdown?

## Experiments

### 2026-10-09 — Daily portfolio stop at ₹8,000 / ₹10,000 / ₹12,500
- **Hypothesis:** a stop on the combined P&L of the day cuts the worst days and the max drawdown
  clearly more than it cuts total profit.
- **Universe:** the three benchmark mixes from BL-054, at their live times, every day:
  **B1** 5 × Widesl OTM1 09:17; **B2** 3 × Widesl OTM1 09:17 + 2 × Dir ITM1 09:24; **B3**
  4 × Widesl OTM1 09:17 + 1 × Dir ITM1 09:24 + 1 × Buy 09:35. Strategies as in
  `strategies/legwise/` (their own per-strategy stops stay). 2024-10-09 → 2026-10-08, usable days,
  1-minute bars, today's lot size, before charges. Each lot is an independent copy of its
  strategy (P&L = 1-lot curve × lots, as in BL-054).
- **Rule:** per minute, the combined mark-to-market of all lots is the sum of the strategies'
  curves (0 before a strategy starts, its realised P&L after it ends). The first minute the sum
  is ≤ −X (X = 8,000, 10,000 or 12,500), everything is closed at that minute's value and nothing
  re-enters that day. The day's P&L is then that value. No stop on days the sum never reaches −X.
- **Look-ahead check:** the stop minute depends only on the curve up to that minute.
- **Pass / kill rule:** a level **helps** a mix if its max drawdown is at least 25% smaller than
  with no stop and its total P&L is at most 10% lower. Pass if some level helps B2 (the primary)
  and the same level does not hurt B1 or B3 by either measure. Kill if no level helps B2.
  Otherwise inconclusive.
- **Reported alongside, not in the rule:** the 10 worst days of each mix and what each level
  would have done on them; days stopped; days stopped that would have finished better without the
  stop (whipsaws) and what they cost; average stopped-day loss against X (minute-bar overshoot);
  winning days %; worst week.
- **Hold-out:** none. Owner override (below).
- **Will not run:** other levels, a trailing or time-based stop, re-entry after the stop, a stop
  on the BL-054 rotation, per-lot-count scaling of the per-strategy stops.
- **Result:** **inconclusive** under the rule. 489 days, 2024-10-09 → 2026-10-08, before charges;
  stop closes everything at the first minute the combined P&L is ≤ −X (minute-close value).
  Total P&L / max drawdown (no stop → 8k / 10k / 12.5k):
  **B2** ₹9,47,039 / −₹1,67,246 → ₹10,61,722 (+12.1%) / −₹96,829 (−42%); ₹10,34,463 (+9.2%) /
  −₹1,31,435 (−21%); ₹9,60,386 (+1.4%) / −₹1,69,014 (+1%). **B1** ₹8,72,687 / −₹2,25,807 →
  ₹7,66,668 (−12.1%) / −₹1,48,038 (−34%); ₹8,13,267 (−6.8%) / −₹2,03,011 (−10%); 12.5k no change.
  **B3** ₹9,29,984 / −₹2,10,009 → ₹8,94,013 (−3.9%) / −₹1,34,560 (−36%); ₹9,75,090 (+4.9%) /
  −₹1,63,066 (−22%); ₹9,73,335 (+4.7%) / −₹1,90,369 (−9%). Level 8k "helps" B2 and B3 under the
  rule but cuts B1's total by 12.1% (> 10%), so the pass condition on B1 fails; no other level
  clears the 25% drawdown bar. Worst day: B2 −₹19,167 → −₹13,315 (8k), −₹15,941 (10k and 12.5k);
  B1 −₹21,710 → −₹16,673 (8k). Days stopped at 8k: B1 224, B2 151, B3 180 of 489; days that
  would have finished better unstopped: 59, 65, 73. 12.5k does nothing for B1 because 5 identical
  copies each carry their own ₹2,500 stop (5 × 2,500 = 12,500) and all stop in the same minute.
  Average stopped-day loss: −₹8.6k to −₹9.2k at 8k, −₹13.3k to −₹13.9k at 12.5k (minute-bar
  overshoot of 8–11%). Scripts: `packages/option-backtesting/research/bl055/`.

### 2026-10-09 (later) — Mix B4 and closest-premium Widesl versions
Added after the first block's result was read (above). It extends the test and changes none of
the first block's rule, levels or result.
- **Hypothesis:** the same daily stop helps a mix built from the best start times, and the
  Widesl strike choice (OTM1, closest ₹80, closest ₹100) changes how much the stop helps.
- **Universe:** window, data, stop rule and levels (8,000 / 10,000 / 12,500) as above. New mix
  **B4** (6 lots): Widesl at 09:17 + Widesl at 09:32 + Widesl at 10:02 (1 lot each), Dir ATM at
  11:17 + Dir ATM at 11:32 (1 lot each), Buy 09:35 (1 lot). Dir ATM is
  `nifty_dir_924_itm1_sl21_recost.yaml` with ATM strikes and the entry time changed (as in
  BL-054). **Widesl versions**, applied to every Widesl lot of every mix at the same start
  times: **OTM1** (as now), **P80** and **P100** — `nifty_widesl_917_otm1.yaml` with both legs'
  strike replaced by `closest_premium: 80` or `100`; SL 115% trailed 15/10 percent, ₹2,500
  overall stop, exit 15:28 unchanged. Mixes B1, B2, B3, B4 × 3 Widesl versions = 12
  combinations, each at no stop and the three levels.
- **Look-ahead / selection note:** the 09:17, 09:32, 10:02 Widesl slots and the 11:17, 11:32 Dir
  ATM slots were chosen by the owner from the BL-054 whole-window results on this same window.
  B4 is therefore optimistic by construction; its numbers say what the stop does to a
  hindsight-picked mix, not what the mix would have earned.
- **Pass / kill rule:** the first block's "helps" test (max drawdown ≥ 25% smaller and total ≤ 10%
  lower than the same combination with no stop), reported per combination. No new verdict beyond
  that; the per-combination table is the result.
- **Reported alongside:** the no-stop totals and drawdowns of all 12 combinations (does P80 or
  P100 beat OTM1 without any stop?), 10 worst days of B4, days stopped, whipsaws.
- **Hold-out:** none (same override).
- **Will not run:** other premiums (₹65 exists in the repo and is not used), other slots, other
  stop levels, premium versions of Dir or Buy.
- **Result:** the stop rarely "helps" under the rule: 3 of 36 combinations × levels (OTM1 B2 and B3
  at 8k, P80 B1 at 10k); never for P100 or B4. No-stop totals / max drawdown, OTM1 | P80 | P100 —
  **B1** ₹8.73L / −₹2.26L | ₹7.02L / −₹1.99L | ₹7.37L / −₹1.76L; **B2** ₹9.47L / −₹1.67L | ₹8.45L /
  −₹1.05L | ₹8.66L / −₹1.01L; **B3** ₹9.30L / −₹2.10L | ₹7.94L / −₹1.49L | ₹8.22L / −₹1.28L;
  **B4** ₹10.49L / −₹0.91L | ₹8.93L / −₹0.95L | ₹9.25L / −₹0.97L. Total return over max drawdown,
  OTM1 | P80 | P100: B1 3.9 | 3.5 | 4.2; B2 5.7 | 8.0 | 8.6; B3 4.4 | 5.3 | 6.4; B4 11.6 | 9.4 | 9.5.
  Premium versions earn 4–19% less than OTM1 in every mix and have the smaller drawdown in B1–B3
  (not in B4). B4 with OTM1 had the highest total and the smallest drawdown of the 12, worst day
  −₹17,438; the stop changed its total by ≤ 1% and its drawdown by 2–12% (stopped 82 / 53 / 26 days
  at 8k / 10k / 12.5k). Across all 12 combinations the stop moved total P&L by −19.7% to +12.1% and
  drawdown by −42% to +11%, with no pattern that holds across Widesl versions (B2 at 8k: drawdown
  −42% with OTM1, +3% with P80, −18% with P100). The stop reliably trims the worst day (B2 −₹19.2k →
  −₹13.3k at 8k, −₹15.9k at 10k) and little else. B4's picks are hindsight (see the note above),
  so its lead is partly built in. Scripts: `packages/option-backtesting/research/bl055/`.

## Log

- 2026-10-09 — override: owner asked for the same two years already looked at; exploratory, and
  cannot by itself justify putting a stop into live trading.
- 2026-10-09 — owner asked for mix B4 (3 Widesl, 2 Dir ATM, 1 Buy) and ₹80 / ₹100 closest-premium
  Widesl versions of every mix; owner chose 11:17 and 11:32 for the Dir ATM lots and applying
  the premium versions to all four mixes.
- 2026-10-09 — levels: owner listed 8k, 10k, 12k and 12.5k; three were asked for, so 8k, 10k and
  12.5k are used (12k is within 4% of 12.5k).

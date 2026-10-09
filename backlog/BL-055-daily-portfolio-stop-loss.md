# BL-055 — Daily portfolio stop-loss on the NIFTY benchmark mixes

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-054 |
| **Status** | In progress (exploratory: owner override, no hold-out) |
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
- **Result:** (after the run)

## Log

- 2026-10-09 — override: owner asked for the same two years already looked at; exploratory, and
  cannot by itself justify putting a stop into live trading.
- 2026-10-09 — levels: owner listed 8k, 10k, 12k and 12.5k; three were asked for, so 8k, 10k and
  12.5k are used (12k is within 4% of 12.5k).

# BL-064 — DRB: the Daily Ranked Basket (6 core lots, at least 2 or 3 Widesl, up to 2 Buy)

| | |
|---|---|
| **Priority** | P2 — options research; names the BL-062 rule and runs it at 6 lots |
| **Status** | In progress (descriptive; same already-seen window, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-062 (the whole-day rule), BL-063 (charges) |
| **TODO.md row** | — |

## Context

The owner (2026-10-09 chat) wants the daily four-criteria ranked basket run with **6 core lots**, at
least 2 and at least 3 Widesl, up to 2 Buy lots on top, and a name to call it by.

## The name: DRB (Daily Ranked Basket)

DRB is the BL-062 rule: every trading day, rank all 248 NIFTY + SENSEX variants (start times
09:17–15:17; Widesl with the OTM strike and with closest premium, Dir ATM, Buy) on four criteria, take
the top lots, and trade them. Variants of it are written **DRB-<core lots>W<minimum Widesl>**:
**DRB-6W2** and **DRB-6W3** here; the BL-062 run is DRB-5W2.

- **Criteria and weights:** 33% recent P&L (⅔ last 5 days + ⅓ the 5 before); 25% fit to the day's weekday;
  25% fit to the day's days to expiry; 17% fit to the day's VIX band at the 09:15 open. Fit = average P&L
  on matching days over the last 5 / 21 / 63 days weighted 40 / 30 / 30. Each criterion is a percentile
  rank across the variants.
- **Core lots:** the top N of the Widesl and Dir variants; "Widesl" is any Widesl, OTM or closest
  premium; if fewer than the minimum, the lowest-scoring Dir picks are swapped for the next-best Widesl.
- **Buy add-on:** up to 2 Buy variants that are in the overall top 10 of the list, on top of the core.
- **Run it:** `uv run python research/bl057/rotate.py --basket DRB-6W2` (backtest) and
  `uv run python research/bl057/today.py --basket DRB-6W2 YYYY-MM-DD` (one day's picks and result).

## Goal

DRB-6W2 and DRB-6W3: total, drawdown, monthly return on ₹13 lakh, before and after charges, and where
the lots go.

## Plan

### Phase 0 — Pre-register
- **Universe, window, rule:** BL-062's (248 variants, 265 common weekdays from 2025-09-01, selection from
  the 64th day, 202 days, before charges), with **6 core lots** and the Widesl minimum 2 (DRB-6W2) or 3
  (DRB-6W3). Buy: up to 2 lots on top, so 6 to 8 lots a day.
- **Comparators:** R random picks (1,000 runs, 6 core lots under the same minimum, the same number of random
  Buy lots on the days DRB added Buy); E equal weight (6 lots over the Widesl/Dir variants + the Buy
  lots); **B** the live mix at 6 lots: 4 × Widesl OTM1 09:17 + 2 × Dir ITM1 09:24 (60/40, rounded). BL-062's
  5-lot run is shown beside them.
- **Pass / kill rule:** BL-057's three conditions, read from each case separately; neither replaces
  BL-062's verdict.
- **Charges:** BL-063's model (brokerage ₹13 per lot per order, STT, exchange, SEBI, stamp, GST), with ₹7
  and ₹20 shown as sensitivities.
- **Outputs:** the BL-057 tables and share of lots by start-time window; monthly return on ₹13 lakh
  before and after charges; beside the owner's real sheet.
- **Hold-out:** none (owner override, same year). **Will not run:** other lot counts, other minimums, tuning.
- **Result:** (after the run)

## Log

- 2026-10-09 — created from the owner's request; named DRB.

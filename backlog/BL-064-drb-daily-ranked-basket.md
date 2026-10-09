# BL-064 — DRB: the Daily Ranked Basket (6 core lots, at least 2 or 3 Widesl, up to 2 Buy)

| | |
|---|---|
| **Priority** | P2 — options research; names the BL-062 rule and runs it at 6 lots |
| **Status** | Done (passes BL-057's rule; exploratory: same already-seen year, owner override) |
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
- **Result:** **both baskets PASS** BL-057's three conditions (exploratory: same already-seen year, owner
  override). `--basket DRB-5W2` reproduces BL-062 exactly (₹3,36,113, drawdown −₹50,636). 202 selection
  days; Buy lots on 48 days (20 × 1, 28 × 2); 6.38 lots a day. **DRB-6W2:** gross ₹3,53,009 (+27.2% of ₹13
  lakh), max drawdown −₹55,784 (4.3%), worst day −₹19,317, ₹274 per lot-day; R (6 core lots, ≥2 Widesl)
  P50 ₹1,88,726 / P90 ₹2,57,854, beats 100% of random runs; E ₹1,86,657 / DD −₹64,662; live mix at 6 lots
  (4 Widesl 09:17 + 2 Dir 09:24) ₹2,32,014 / DD −₹2,08,439. **DRB-6W3:** gross ₹3,77,386 (+29.0%), max drawdown
  −₹60,251 (4.6%), worst day −₹19,317, ₹293 per lot-day; R P90 ₹2,52,361, beats 100%; same E and live mix.
  (No minimum: ₹3,49,598 / −₹54,548.) **After charges** (BL-063 model, brokerage ₹13 a lot per order): DRB-6W2
  net ₹2,20,934 (+17.0%), charges ₹1,32,075 (37% of gross), drawdown −₹82,980 (6.4%), 7 of 11 months positive,
  worst month −1.71%; DRB-6W3 net **₹2,49,942 (+19.2%)**, charges ₹1,27,445 (34%), drawdown −₹72,220 (5.6%), 8 of 11
  months positive, worst month −1.79%; DRB-5W2 for comparison net ₹2,26,707 (+17.4%), drawdown −₹62,354.
  Net at brokerage ₹7 / ₹13 / ₹20 per lot per order: DRB-5W2 ₹2,61,626 / ₹2,26,707 / ₹1,85,969; DRB-6W2
  ₹2,62,947 / ₹2,20,934 / ₹1,71,920; DRB-6W3 ₹2,90,765 / ₹2,49,942 / ₹2,02,315; morning-only 66 variants
  ₹2,51,816 / ₹2,14,122 / ₹1,70,146. The sixth lot adds gross profit but, after charges, only helps with the
  3-Widesl minimum. Scripts: `rotate.py --basket DRB-<lots>W<min>`, `today.py --basket …`, `research/bl063/`.

## Log

- 2026-10-09 — created from the owner's request; named DRB.
- 2026-10-09 — DRB-6W2 and DRB-6W3 ran (Result above); BL-063's trades and charges extended to them.

# BL-221 — Fridays by family: how Widesl, Dir and Buy behave on the day furthest from expiry

| | |
|---|---|
| **Priority** | P2 — explains BL-220's pattern and tells which family carries it; descriptive, no rule |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-12 |
| **Depends on** | none. Shares its trigger with [BL-220](BL-220-friday-size-down.md) and must not read BL-220's hold-out |
| **TODO.md row** | — (filled in when started) |

## Context

The owner asked (2026-11-12), after the weekday read in BL-220, for "another research on Friday on how
widesl, dir, and buy works". The first look, over the 298 stored strategies (2025-01-10 → 2026-11-11,
0.5 % slippage after costs, ₹ per strategy-day), already split by family:

| Family | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Widesl NIFTY | 140 | 372 | −39 | 14 | 47 |
| Widesl SENSEX | −34 | 195 | −150 | 20 | −90 |
| Dir ATM NIFTY | 162 | 220 | −97 | 106 | 79 |
| Dir ATM SENSEX | 46 | 442 | −111 | 227 | 37 |
| Dir ITM1 NIFTY | 195 | 228 | −118 | 121 | 76 |
| Dir ITM1 SENSEX | 74 | 507 | −92 | 308 | 39 |
| Premium (₹80–₹320) NIFTY | 87 | 318 | −15 | −73 | −2 |
| Premium SENSEX | −37 | 163 | −140 | −60 | −52 |
| Buy NIFTY | −122 | −60 | −17 | 62 | −19 |
| Buy SENSEX | −27 | −3 | 11 | 14 | 15 |

So on Fridays the selling families are near zero and SENSEX Widesl is negative. Dir stays slightly
positive and Buy is flat, as it is every day. The family research pages (`research/options/strategies/*/weekday.md`)
hold BL-056's one-regime weekday means and say that within one regime weekday equals days to expiry.
This item asks **how** each family loses its edge on Fridays, not **whether** to act on it.

## Goal

A findings section per family (Widesl, Dir ATM / ITM1, Buy, and the premium-picked Widesl), stating for
Fridays against the other days:

- where in the session the money is made or lost (09:17–10:00, 10:00–13:00, 13:00–15:28), from the stored
  per-day results and the minute paths;
- how the exits happen (leg SL, MTM SL, trail, time exit) and how often;
- the premium collected at entry and its decay by 15:28, by weekdays to expiry;
- whether entry time changes the Friday picture (morning vs afternoon starts);
- VIX band and opening gap on Fridays against other days, to rule out a Friday-specific market;
- each of the above before and after the Sep 2025 expiry change.

## Out of scope

- Any trading rule or Friday size change (BL-220 owns that).
- **NIFTY 2022-04-05 → 2024-10-08 and any day from 2026-11-13 on**: BL-220's hold-outs. This item reads
  only 2024-10-09 → 2026-11-12, which is already spent.
- New engine sweeps. It reads stored results and replayed paths only.

## Plan

### Phase 0 — Pre-register
Descriptive only: no pass / kill rule, no verdict that changes a setting.
- **Hypothesis (to describe, not test):** selling families earn less on Fridays because intraday decay is
  slow far from expiry, so the leg SLs take a larger share of the day's result.
- **Universe:** the 298 stored strategies (Core-298) and T1's extra strategies, 2024-10-09 → 2026-11-12,
  point-in-time expiries from `ref_expiries`.
- **Look-ahead check:** none needed for a description; every split uses only the day's own data.
- **Hold-out:** none here, on purpose: BL-220's two hold-outs are not to be read.
- **Will not run:** anything on 2022–24 NIFTY or after 2026-11-12; any rule test.

### Phase 1 — Tables from stored results
- **Tasks:** per family × weekday × regime: mean, median, win rate and share of days stopped, after costs
  and 0.5 % slippage; exit-reason counts from the trade-level results (`--trades`).
- **Deliverables:** the tables in this file.
- **Done when:** every family has its Friday row with a standard error.

### Phase 2 — Intraday path and premium
- **Tasks:** from the replayed minute paths (the portfolio path cache), the P&L by session window and the
  premium at entry versus 15:28, by weekdays to expiry.
- **Deliverables:** one short findings paragraph per family.
- **Done when:** each paragraph says where on a Friday that family's result comes from.

### Phase 3 — Close
- **Tasks:** add a "Fridays" section to `research/options/strategies/{widesl,directional,buy-breakout}/weekday.md`
  citing this item, in the same commit as the item's close.
- **Done when:** the pages cite this item and INDEX shows Done.

## Risks

- About 90 Fridays over two regimes: cells split by family, window and regime get small. Report the
  standard error with every mean and say when a gap is under the ~₹700 noise bar.
- Reading these days again adds to the multiple-testing count for any future rule built on them; that is
  why BL-220 tests on other days.

## Open questions

1. Include the premium-picked Widesl (₹80 / ₹250 / ₹285 / ₹320) as its own family, or under Widesl?
2. Any other split worth adding (Friday before a holiday, the monthly-expiry week)?

## Log

- 2026-11-12 — created at the owner's request alongside BL-220. Nothing run.

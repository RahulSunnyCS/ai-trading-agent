# BL-149 — Do we need Fyers' Greeks? Validate our own IV and Greeks against the expired-F&O API

| | |
|---|---|
| **Priority** | P2 — settles a question; blocks nothing, so it waits behind the data repair and BL-148 |
| **Status** | Planned |
| **Type** | research |
| **Area** | options / trading-data |
| **Created** | 2026-10-21 |
| **Depends on** | none: daily candles with Greeks are available on the Standard plan (checked 2026-10-21) |
| **TODO.md row** | — (filled in when started) |

## Context

The new Fyers expired-F&O historical endpoint takes `include_greeks=1` and then returns
`implied_volatility` (the live column name; the docs' sample says `iv`; percent), `delta`, `gamma`, `theta` and
`vega` beside each candle, computed "at candle close". There is no rho. The page does not say
which underlying price, rate or model it uses, and says Greeks are **not available for MCX**.

The repo already derives its own: `trading_data/derived.py` builds, for NIFTY and SENSEX, 5-minute
chain snapshots with IV, delta, gamma, theta and vega (Black-76 on a put-call-parity forward,
RBI repo rate from `rates.csv`, `iv_quality` flags such as `low_premium`, `stale`,
`parity_gap`). So the question is not "do we want Greeks" but "does the vendor's version add
anything our own does not": a cross-check of ours, coverage where ours is missing, or both.

## Goal

A written verdict, backed by numbers, for each of three uses:

1. **Cross-check:** do our IV and delta agree with the vendor's on liquid strikes?
2. **Coverage:** are there contracts or days the vendor prices that our derivation cannot
   (stock options, which have no chain build; far-OTM strikes with no parity pair)?
3. **MCX:** since the vendor gives none, what must BL-148 derive itself?

## Out of scope

- Storing vendor Greeks in the lake. Not before the verdict says they are needed.
- Changing `derived.py`'s model. A disagreement is investigated here; any fix is its own item.
- Any strategy test that uses IV or Greeks.

## Plan

### Phase 0 — Pre-register
Committed before the first Greeks request. Edits after a run are a new, dated rule.

- **Hypothesis:** our Black-76 IV and delta equal the vendor's on liquid contracts to within a
  tolerance small enough that nothing we do would change.
- **Universe:** NIFTY and SENSEX expired contracts on 10 sessions, chosen by a fixed rule (the
  first trading day of each month from 2025-12 to 2026-09, plus 2026-10-15 and 2026-10-16),
  strikes ATM ±5 steps, CE and PE, the two nearest expiries. Point-in-time contract lists come
  from the expired-contracts API, not today's chain.
- **Look-ahead check:** both sides are read at the same candle close; our IV uses only the
  window's own bars and the forward from that window (`derived.py` states this); the vendor's is
  "at candle close".
- **Pass / kill rule** (compare minutes where the contract traded and our `iv_quality` is
  clean): median |our IV − vendor IV| ≤ 0.5 vol point, 95th percentile ≤ 2.0 points, median
  |Δdelta| ≤ 0.02, and the same per DTE bucket (0–1, 2–5, 6+ days). All hold → **vendor Greeks
  not needed**; keep local derivation. Median IV gap > 1.0 point in any bucket → investigate
  which input differs (underlying, rate, day count) before deciding anything.
- **Hold-out:** none needed (no fitting); the 10 days are fixed in advance.
- **Will not run:** any comparison on days chosen after seeing a gap, and any threshold change.

### Phase 1 — Pull and compare
- **Tasks:** fetch the sample once at daily resolution (`include_greeks=1`, `include_oi=1`, read columns by name),
  cache raw responses under `TRADING_DATA_ROOT/raw/fyers-expired/greeks-sample/`; align to our
  5-minute snapshots by bucket close; report the Phase 0 numbers.
- **Deliverables:** `packages/option-backtesting/research/bl149/` script and a findings page
  `research/options/common/greeks.md` (rules in `research/README.md`).
- **Done when:** the verdict for use 1 is written against the Phase 0 rule.

### Phase 2 — Coverage and MCX
- **Tasks:** count contracts with vendor Greeks where ours are NaN or flagged; for MCX, state
  the model BL-148 will need (Black-76 on the MCX future, rate source, expiry time) and whether
  `derived.py` can be generalised.
- **Done when:** uses 2 and 3 have a written answer, and BL-148 is edited if it needs more.

## Risks

- The vendor may not use the model or the underlying we assume, so a gap can be a definition
  difference rather than an error. The verdict says which.
- Docs and sample disagree on the IV column name (`iv` vs `implied_volatility`): parse by name,
  fail loudly on neither.
- Greeks come back `null` for some candles (the docs say so; nothing is filled). Seen 2026-10-21 on
  Standard: NIFTY contracts of the 22 Sep expiry have null Greeks on every candle from 14 to 22 Sep
  (daily and 5-minute, ATM and not); the 30 Jun expiry has them on 19 of 21 daily candles, null on
  the last two sessions. So coverage depends on date: the sample must be drawn from days where they
  exist, and the null rate is itself a Phase 1 result.
- Request budget: daily candles are not part of Standard's 10-a-day intraday cap (5/s, 50/min,
  5,000/day), so the sample uses daily candles and compares at the session's last 5-minute bucket;
  only an intraday cross-check needs the 10-a-day quota (or Prime).

## Open questions

1. Are 10 sessions enough, or does the owner want every month back to 2024-10?
2. The sample rule picks days by calendar; if Greeks are null for the recent months, do we draw from the newest months that have them (rule changed and logged before the first run)?

## Log

- 2026-10-21 — created from the owner's request to decide, from the data available, whether the
  vendor's Greeks are needed.
- 2026-10-21 — checked on the owner's Standard token before any run: daily expired candles with
  `include_greeks=1` work and return the Greeks columns; values null for 14–22 Sep 2026, present
  for June 2026 (see Risks). Also seen, for the data audit in BL-148: the 30 Jun 2026 NIFTY 23900 CE
  daily candle on expiry day has close 23865.75, the index level rather than an option price.

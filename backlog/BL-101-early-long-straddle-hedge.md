# BL-101 — Early long ATM straddle as a hedge for the selling base

| | |
|---|---|
| **Priority** | P2 — a cheap, parameter-free test of the book's main open risk (fast moves hurting short premium) |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-12 |
| **Depends on** | BL-058 (the fixed base), BL-090 (correlation), `docs/options-strategy-diversification-brief.md` §4.1 |
| **TODO.md row** | — |

## Context

The owner proposed (2026-10-12) buying one ATM call and one ATM put at 09:16 on the nearest
weekly expiry and holding both to 15:28, with no stop, trail, VIX or breakout filter. The
diversification brief (§4.1) lists a two-sided long-volatility sleeve as the family most likely
to pay on the days the short-premium book is damaged. A mirror of a no-stop short ATM straddle
is already known to lose when that short profits before costs, so the open hypothesis is the
narrower one below.

## Goal

A yes/no answer, on NIFTY from 2024-01-01, to whether this sleeve buys tail protection for the
base more cheaply than simply running less of the base.

## Out of scope

Any other entry time, strike, stop, filter, underlying or expiry choice (see "Will not run").

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** adding 1 lot of a long ATM weekly straddle (09:16 to 15:28, no stops) to the
  owner's fixed base lowers the base's daily 95% expected shortfall and drawdown by more than
  scaling the base down until it gives up the same average rupees would.
- **Universe:** NIFTY weekly options, nearest listed expiry, every day `backtest_days` returns
  from 2024-01-01 to 2026-10-09 (the last complete session when this was written). Days
  data_quality excludes are left out for every portfolio alike. Index only: no survivorship.
- **Portfolios (same days, same starting capital, NIFTY lot sizing `current` like the base):**
  - **B** — the base: 2 × `nifty_widesl_917_otm1` + 1 × `rotation_base/N_dir_atm_0924.yaml`
    (one-lot results, summed in rupees).
  - **L** — the straddle: `research/bl101/nifty_long_straddle_916.yaml`, 1 lot (primary).
    2 lots is reported as a sensitivity only and cannot be selected.
  - **B+L** — B plus L.
  - **kB** — B scaled by the factor k that gives it the same mean net daily P&L as B+L
    (carry-matched de-risking); **0.75 B** is also reported (the owner's suggested comparator).
- **Costs:** the BL-096 charge model (brokerage, STT, exchange, SEBI/IPFT, stamp, GST), applied
  to every trade of every portfolio. Friction scenarios on all strategies: slippage 0%
  (charges only), 1% and 2% of price on every fill.
- **Look-ahead check:** L's strike is the ATM at the 09:16 bar from spot at that bar; nothing
  after 09:16 enters the entry. The weekly expiry is the nearest listed expiry on that day from
  the reference expiry list. B uses its registered files unchanged. No parameter of L is fitted
  to any data: there is one rule and it was written before any run.
- **Pass / kill rule** (all on the full window, daily net P&L; ES95 = mean of the worst 5% of
  days; MDD = max peak-to-trough of cumulative net P&L):
  1. B+L improves ES95 and MDD against B by at least 15% each (less negative);
  2. B+L is better than kB on both ES95 and MDD;
  3. the same direction of 1 and 2 holds in each half: 2024-01-01..2025-06-30 and
     2025-07-01..2026-10-09;
  4. 2 still holds under 2% slippage on every fill.
  Any failure kills the idea as specified. Passing means "worth a forward paper test", not
  "adopt".
- **Also reported, not gating:** L's P&L on B's worst 5% of days and worst 10 days; the
  intraday worst MTM (minute-summed) of B versus B+L; share of days L loses; incremental ES95
  gained per rupee of mean P&L given up.
- **Hold-out:** L has no fitted parameter, so none is held back. B's own rules were chosen
  in-sample on part of this window (BL-054..BL-058), so B's level is not evidence; only the
  with/without difference is. The second half is the "later" check in rule 3.
- **Will not run:** other entry times or strikes, stops or trails, VIX or breakout filters,
  0DTE-only or non-weekly expiry, SENSEX or other underlyings, more than 1 and 2 lots. Running
  one needs `override: <reason>` in the Log.

## Risks

- B is in-sample; a hedge that looks good against an over-fitted B may be hedging noise.
- Daily P&L over ~680 sessions has only a few dozen tail days; ES95 is a noisy statistic.
- Weekly expiry-day (0DTE) premiums behave differently from earlier days; they are pooled here.

## Log

- 2026-10-12 — created from the owner's request; Phase 0 written before any run.

# BL-101 — Early long ATM straddle as a hedge for the selling base

| | |
|---|---|
| **Priority** | P2 — a cheap, parameter-free test of the book's main open risk (fast moves hurting short premium) |
| **Status** | Dropped — killed by its pre-registered rule (2026-10-12) |
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

### Phase 0b — Variant: long OTM4 strangle (registered 2026-10-12, before its run)
- override: owner asked for it in chat on 2026-10-12 after the ATM straddle was killed; it lifts
  only the "other strikes" line of "Will not run".
- **Change:** buy 1 lot of the OTM4 CE and the OTM4 PE at 09:16 (nearest weekly, exit 15:28, no
  stops or filters), file `research/bl101/nifty_long_strangle_otm4_916.yaml`. Nothing else
  differs: same days, same B, same charges, same slippage scenarios, same comparators, same
  pass / kill rules 1 to 4, 1 lot primary and 2 lots as sensitivity only.
- **Multiplicity:** this is the second trial on one idea. A pass is not adjusted for that, so a
  pass here means only "worth a forward paper test"; other strike depths are not run.

## Risks

- B is in-sample; a hedge that looks good against an over-fitted B may be hedging noise.
- Daily P&L over ~680 sessions has only a few dozen tail days; ES95 is a noisy statistic.
- Weekly expiry-day (0DTE) premiums behave differently from earlier days; they are pooled here.

## Log

- 2026-10-12 — created from the owner's request; Phase 0 written before any run.
- 2026-10-12 — run once, as registered (`research/bl101/run.py`, report in `report.txt`,
  daily rows in `daily.csv`). 680 NIFTY sessions, 2024-01-01..2026-10-09, none skipped. Engine
  note: `lot_sizes.csv` starts 2024-10-03, so the runner falls back to the sizing-date lot for
  earlier days (only a mismatch note uses the per-contract lot in `current` sizing; quantity is
  unchanged). Result, net of charges, slippage 0:

  | | mean/day | ES95 | MDD | worst day |
  |---|---|---|---|---|
  | B (base) | 829 | -9,831 | -124,096 | -11,407 |
  | B+L (1 lot) | 263 | -12,874 | -173,423 | -20,572 |
  | 0.75 B | 622 | -7,373 | -93,072 | -8,555 |
  | L alone | -566 | -9,783 | -421,202 | -25,500 |

  L wins on 33% of days, correlates -0.46 with B, but pays only +277 on average on B's worst 5%
  of days (+1,962 on the worst 10) while losing its whole premium on flat days. ES95 and MDD
  both get worse (-31%, -40%), in both halves and in every year; with slippage the base itself
  turns negative (1%: -57/day) so the carry-matched comparator degenerates to cash. All four
  rules fail. Not run, needs `override`: smaller straddle sizes (1 lot is a ~₹20k premium
  against a base whose worst day is ~₹11k), or a conditional entry.
- 2026-10-12 — Phase 0b (OTM4 strangle) run once, as registered (`report_otm4.txt`,
  `daily_otm4.csv`). Killed: all four rules fail. Full window, net, slippage 0: B mean 829/day,
  ES95 -9,831, MDD -124,096; B+L mean 406, ES95 -11,757 (-19.6%), MDD -164,776 (-32.8%), worst
  day -17,668; L alone -423/day, wins 27.5% of days, corr(B,L) -0.42. Worse than B in both
  halves and every year; carry-matched kB (k=0.49) and 0.75 B both beat it on tail risk. L
  averages -4 on B's worst 5% of days (positive on only 24% of them, +1,208 on the worst 10).
  Cheaper than the ATM straddle (-423 vs -566/day) but protects less. Both strike depths
  tested; no other depth is run without a further override.

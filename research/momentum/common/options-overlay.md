# Momentum: holding the picks as bought options

**Status:** Tested · **Last updated:** 2026-11-15

## What it is

Instead of buying a momentum strategy's stocks, buy each held stock's call option (ATM, OTM1 or OTM2 on
its listed strikes) and swap it every week; in a down-trend, perhaps buy the weakest stocks' puts. Only F&O
stocks have options, so it needs the point-in-time F&O list ([universe](universe.md), `fno`). Code:
`packages/momentum-backtesting/scripts/bl226_options_book.py` over NSE's daily F&O bhavcopy
(`obt nse fo-fetch`).

## Live value

Not used. The live Momentum book holds shares on Kite.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-226](../../../backlog/BL-226-fno-momentum-stock-options.md) Phase 3 | three F&O candidates (Four-Strategy Mix, 12-month top-10 weekly, Trio Fortnightly) × ATM / OTM1 / OTM2 calls, ₹10 lakh ÷ N of premium per stock, weekly; double slippage and an IV cap as variants | NSE daily closes, learning 2020-01 to 2024-06, confirmation 2024-07 to 2026-11, after costs, 1–3 % slippage and 31.2 % tax | **Killed**: no book passes on the confirmation weeks | Learning +511 % to +1,190 % on ₹10 lakh (shares +229 to +289 %), only Trio ATM met all rules; confirmation Trio ATM +42 % (shares +27 %) with a −82 % drawdown, Mix ATM −182 %, grid ATM −444 %; 7 of 9 lose |
| BL-226 Phase 4 | puts on the weakest N (market gate; long-short) | — | Not run (its gate: a passing call book) | — |

## What we know

- The gain in 2020-24 was leverage, not convexity: in every book the calls' delta held in shares earned
  more before tax than the calls (registered; after charges).
- A book spending ₹2–11 lakh of premium a week on ₹10 lakh turns a weak year of the signal into losses
  beyond the capital: the stock signal fell to 5–11 % a year after tax in 2024-26 (descriptive).
- Trio ATM's confirmation profit came from 21 trades (5 %); without them it lost ₹22.6 lakh before tax
  (descriptive).
- OTM1 and OTM2 were worse than ATM in every candidate and both periods.

## Not yet tested

- A smaller premium budget (a fixed share of capital each week) or delta-sized positions: a different
  question (leverage control), not run here.
- Monthly options held to near expiry instead of a weekly swap; skipping results weeks (needs a results
  calendar).

## Related

- [Universe](universe.md) (the `fno` universe), [cadence](cadence.md), [tax](tax.md).

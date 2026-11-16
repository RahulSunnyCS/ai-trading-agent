# Momentum: holding the picks as bought options

**Status:** Tested · **Last updated:** 2026-11-15 (BL-228)

## What it is

Instead of buying a momentum strategy's stocks, buy each held stock's call option (ATM, OTM1 or OTM2 on
its listed strikes) and swap it every week; in a down-trend, buy the weakest stocks' puts (BL-228). Only F&O
stocks have options, so it needs the point-in-time F&O list ([universe](universe.md), `fno`). Code:
`packages/momentum-backtesting/scripts/bl226_options_book.py` over NSE's daily F&O bhavcopy
(`obt nse fo-fetch`).

## Live value

Not used. The live Momentum book holds shares on Kite.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-226](../../../backlog/BL-226-fno-momentum-stock-options.md) Phase 3 | three F&O candidates (Four-Strategy Mix, 12-month top-10 weekly, Trio Fortnightly) × ATM / OTM1 / OTM2 calls, ₹10 lakh ÷ N of premium per stock, weekly; double slippage and an IV cap as variants | NSE daily closes, learning 2020-01 to 2024-06, confirmation 2024-07 to 2026-11, after costs, 1–3 % slippage and 31.2 % tax | **Killed**: no book passes on the confirmation weeks | Learning +511 % to +1,190 % on ₹10 lakh (shares +229 to +289 %), only Trio ATM met all rules; confirmation Trio ATM +42 % (shares +27 %) with a −82 % drawdown, Mix ATM −182 %, grid ATM −444 %; 7 of 9 lose; **not re-scored**: run without the F&O ban-period rule, four registered checks not run (BL-230) |
| BL-226 Phase 4 | puts on the weakest N (market gate; long-short) | — | Not run (its gate: a passing call book) | — |
| [BL-228](../../../backlog/BL-228-fno-falling-stock-puts.md) Phase 0 | ATM / OTM1 / OTM2 puts, one lot each, on the 5 or 10 weakest F&O stocks (rank-sum of 1–52-week returns) whose own trend is down (26-week return < 0, below the 40-week average), every week or only when NIFTY is below its 200-day average; against cash | same data, costs, slippage, tax, ₹10 lakh; learning 2020-01 to 2024-06 | **Killed at learning**: all 12 books lose; confirmation not read | every-week books −₹11 to −₹28 lakh after tax (−113 % to −277 % of ₹10 lakh), NIFTY-gated −₹1.3 to −₹6.4 lakh; win rate 26–32 % |
| BL-228 Phase 0b | the mirror pool (owner's idea): every F&O stock's chart and its inverse ranked together, the top 5 or 10 with their own trend up, ATM call for a stock and ATM put for an inverse, one lot each; against cash | as above | **Killed at learning**: both make money but fail the interval and the −40 % drawdown rule; confirmation not read | top 5 +₹15.8 lakh after tax, drawdown −46 %, 90 % interval −0.13 to +1.48 % a week; top 10 +₹27.3 lakh, −58 %, −0.09 to +2.45 %; the calls earned +₹24.6 / +₹44.4 lakh before tax, the puts lost ₹1.7 / ₹4.7 lakh |

## What we know

- The gain in 2020-24 was leverage, not convexity: in every book the calls' delta held in shares earned
  more before tax than the calls (registered; after charges).
- A book spending ₹2–11 lakh of premium a week on ₹10 lakh turns a weak year of the signal into losses
  beyond the capital: the stock signal fell to 5–11 % a year after tax in 2024-26 (descriptive).
- Trio ATM's confirmation profit came from 21 trades (5 %); without them it lost ₹22.6 lakh before tax
  (descriptive).
- OTM1 and OTM2 were worse than ATM in every candidate and both periods.
- Bought puts on falling F&O stocks lost money in every form tried, in 2020-24, even when gated to NIFTY's
  falling weeks (registered, BL-228): a stock already down on 1 to 52 weeks and below its average tends not
  to keep falling fast enough within a week to pay for the put.
- Ranking stocks and their inverse charts together (BL-228 Phase 0b) tilts the book to puts in falling years
  (37–43 % of positions in 2020 and 2022; 3–7 % in 2021 and 2024), but its puts lost money and its
  gain was its calls' (descriptive split of the registered books); its top 5 % of trades made more than all
  of its net.

## Not yet tested

- A smaller premium budget (a fixed share of capital each week) or delta-sized positions: a different
  question (leverage control), not run here.
- Monthly options held to near expiry instead of a weekly swap; skipping results weeks (needs a results
  calendar).

## Related

- [Universe](universe.md) (the `fno` universe), [cadence](cadence.md), [tax](tax.md).

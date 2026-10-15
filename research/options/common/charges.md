# Options: charges

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Everything paid per trade besides the option premium: brokerage, STT, exchange transaction charge,
SEBI turnover fee, NSE investor protection fund (IPFT), stamp duty and GST. Slippage and spread are
**not** in any of the charge models below. Stored variant results carry costs 0, so every rotation
figure is gross unless a page says net.

## The two charge models in use

| Part | BL-063 model (rotations, BL-063 → BL-075) | BL-096 model (sweeps BL-096 → BL-099, BL-101) |
|---|---|---|
| Brokerage | ₹13 **per order** (one entry, one exit; a 2-lot order pays once) | ₹20 per order |
| STT | 0.10% of sell-side premium; 0.15% from 2026-04-01 | same |
| Exchange | NIFTY (NSE) 0.03503%, SENSEX (BSE) 0.0325%, both sides | same |
| SEBI / IPFT | ₹10 a crore both sides / ₹50 a crore, NSE only | same |
| Stamp | 0.003% of buy side | same |
| GST | 18% on brokerage + exchange + SEBI + IPFT | same |
| AlgoTest fee | about ₹19 a strategy-day, shown as a separate optional line | not included |

BL-063 first assumed ₹13 per lot; the owner confirmed on 2026-10-09 that it is flat per order. For
1-lot strategies the two are the same; only 2-lot baskets differ ([BL-063][bl063], [BL-065][bl065]).
Code: `research/bl063/charges.py`; `research/bl097/run_family_sweep.py` (`BROKERAGE_PER_ORDER = 20`).
Rates are to be checked against the owner's contract notes.

## Tested

| Item | What | Before → after charges | Evidence |
|---|---|---|---|
| BL-063 | Whole-day rotation DRB-5W2, P1, 1,086 lots | ₹3,36,113 → charges ₹1,09,405 (33%) → net ₹2,26,707 (+17.4% of ₹13 lakh); brokerage ₹64,116, STT ₹20,612, GST ₹13,474, exchange ₹10,619 | [BL-063][bl063] |
| BL-063 | Morning-only rotation, 66 variants | ₹3,31,842 → charges ₹1,17,720 (35%) → ₹2,14,122 (+16.5%) | [BL-063][bl063] |
| BL-063 | Owner's real sheet, same window | gross +21.3%, charges ₹1,03,429, net +13.3% | [BL-063][bl063] |
| BL-064 | DRB-6W3 at brokerage ₹7 / ₹13 / ₹20 | net ₹2,90,765 / ₹2,49,942 / ₹2,02,315 | [BL-064][bl064] |
| BL-065 | Same 6 lots as 3 strategies × 2 lots (DRB-6W3L2), flat per order | charges ₹80,461 (19% of gross), net ₹3,50,407 (+27.0%) | [BL-065][bl065] |
| BL-075 | Journal lists, P1, flat ₹13 an order | charges ₹80–81k each; net A ₹3,09,081, B ₹2,71,698, C ₹3,47,179, REF ₹3,50,407 | [BL-075][bl075] |
| BL-099 | Best configuration per index and band, holdout 2025-10 → 2026-10, ₹20 an order | Dir +₹12,975 to +₹61,149 net a year; Widesl +₹5,697 to +₹27,683; Buy −₹1,005 to −₹16,419 | [BL-099][bl099] |
| BL-097 | Buy baseline, 48 files, holdout | gross ₹1.31 lakh → charges ₹8.72 lakh → net −₹7.42 lakh; 3 of 48 files positive (computed from the git-ignored CSV) | [BL-097][bl097] |
| BL-101 | Fixed base (2 Widesl + 1 Dir ATM), BL-096 model plus slippage | ₹829 a day at 0 slippage; −₹57 at 1%; −₹1,033 at 2% | [BL-101][bl101] |

## What we know

- **Which families survive charges.** Directional and Widesl do, thinly: their best holdout rows have
  profit factors of 1.01–1.13 and pay ₹27k–₹39k a year in charges per strategy. Buy does not: its best
  row in every index and band is negative, and in the baseline brokerage alone (₹6.68 lakh) is about
  five times its gross ([BL-099][bl099], [BL-097][bl097]).
- In the rotations charges take 19–37% of gross; the owner's real sheet shows 37%. Brokerage is the
  largest item; STT second.
- Anything that trades less looks better after charges. Re-entries (Buy: +₹11k–₹27k of charges a file)
  lose; breakout deadlines and gaps "gain" only by skipping trades. A filter must be judged against a
  random skip at the same rate.
- Fills, not fees, may be the bigger unknown: 1% slippage on every fill turns the fixed base negative
  ([BL-101][bl101]). No rotation result includes slippage; BL-062's late-start lots are the most
  exposed (a rough ₹100–₹300 extra per late lot takes DRB-5W2 from ₹3.36 lakh to ₹3.05–2.43 lakh,
  [BL-062][bl062]).

## Not yet tested

- The charge model inside the nightly update and the paper-vs-real waterfall ([BL-093][bl093], blocked
  on the contract-notes cutover).
- A slippage or spread model for the rotation, especially for late starts.

## Related

- [Buy re-entry](../strategies/buy-breakout/re-entry.md), [Buy breakout validity](../strategies/buy-breakout/breakout-validity.md),
  [rotation ranking](rotation-ranking.md).

[bl062]: ../../../backlog/BL-062-whole-day-rotation.md
[bl063]: ../../../backlog/BL-063-rotation-after-charges.md
[bl064]: ../../../backlog/BL-064-drb-daily-ranked-basket.md
[bl065]: ../../../backlog/BL-065-drb-two-lots-per-strategy.md
[bl075]: ../../../backlog/BL-075-drb-final-map-and-structural-switches.md
[bl093]: ../../../backlog/BL-093-rotation-paper-vs-real.md
[bl097]: ../../../backlog/BL-097-buy-parameter-sweep.md
[bl099]: ../../../backlog/BL-099-combined-final-qualified-list-post-charge.md
[bl101]: ../../../backlog/BL-101-early-long-straddle-hedge.md

# BL-096 Directional qualified list

Qualified Directional configurations by entry-time band, using the 2025-10-09
to 2026-10-09 holdout. Rankings balance holdout return, drawdown, Ulcer Index,
CVaR, win rate, expectancy and MTM-stop frequency. Values are averages across
the bases in each band and are **before brokerage, statutory charges and
slippage**.

The current Directional universe contains ATM and ITM1 only. Calculated-premium
strikes are not included in this list yet.

## Underlying-specific rankings

The rankings below use the same balanced score as the pooled list, but rank
NIFTY and SENSEX separately. This changes some names: pooled averages can hide
instrument-specific behavior. Values are holdout averages for that underlying
and time band, before brokerage, statutory charges and slippage.

### NIFTY — 09:15–11:00

| Rank | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | CVaR95/day | Expectancy | Stop rate |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹381 | 61.0% | -₹24,243 | ₹7,045 | -₹4,273 | ₹139 | 7.9% |
| 2 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹345 | 59.4% | -₹18,591 | ₹5,624 | -₹4,343 | ₹125 | 9.2% |
| 3 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹395 | 59.8% | -₹24,553 | ₹7,655 | -₹4,412 | ₹150 | 12.1% |

### NIFTY — 11:00–13:00

| Rank | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | CVaR95/day | Expectancy | Stop rate |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹481 | 63.4% | -₹17,192 | ₹5,062 | -₹4,222 | ₹195 | 5.2% |
| 2 | ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹394 | 64.6% | -₹16,286 | ₹4,674 | -₹4,034 | ₹161 | 3.9% |
| 3 | ATM | 25% / ₹4,000 / RE COST×2 / no trail | ₹431 | 63.9% | -₹18,431 | ₹5,045 | -₹3,908 | ₹156 | 3.9% |

### NIFTY — 13:00–15:30

| Rank | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | CVaR95/day | Expectancy | Stop rate |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹217 | 64.4% | -₹10,416 | ₹3,629 | -₹2,800 | ₹93 | 1.5% |
| 2 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹218 | 62.8% | -₹9,160 | ₹2,987 | -₹2,621 | ₹90 | 1.5% |
| 3 | ATM | 25% / ₹4,000 / RE COST×1 / trail [15%,5%] | ₹208 | 61.5% | -₹11,160 | ₹3,981 | -₹2,614 | ₹85 | 1.4% |

### SENSEX — 09:15–11:00

| Rank | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | CVaR95/day | Expectancy | Stop rate |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | ATM | 21% / ₹3,000 / RE COST×1 / trail [10%,5%] | ₹516 | 61.3% | -₹14,437 | ₹4,292 | -₹3,330 | ₹174 | 11.6% |
| 2 | ITM1 | 25% / ₹3,500 / RE COST×1 / trail [15%,5%] | ₹535 | 63.1% | -₹17,498 | ₹5,021 | -₹3,899 | ₹198 | 12.4% |
| 3 | ITM1 | 25% / ₹4,000 / RE COST×2 / no trail | ₹521 | 63.2% | -₹16,782 | ₹4,632 | -₹4,440 | ₹186 | 9.2% |

### SENSEX — 11:00–13:00

| Rank | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | CVaR95/day | Expectancy | Stop rate |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹457 | 64.8% | -₹17,468 | ₹4,181 | -₹3,619 | ₹182 | 2.7% |
| 2 | ITM1 | 30% / ₹4,000 / RE COST×2 / no trail | ₹473 | 65.3% | -₹15,166 | ₹4,095 | -₹4,104 | ₹192 | 4.6% |
| 3 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹399 | 64.6% | -₹16,018 | ₹3,975 | -₹3,831 | ₹157 | 3.5% |

### SENSEX — 13:00–15:30

| Rank | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | CVaR95/day | Expectancy | Stop rate |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | ITM1 | 25% / ₹4,000 / RE COST×2 / no trail | ₹231 | 64.2% | -₹14,477 | ₹4,993 | -₹3,085 | ₹96 | 1.7% |
| 2 | ITM1 | 30% / ₹4,000 / RE COST×2 / no trail | ₹228 | 64.1% | -₹13,724 | ₹4,698 | -₹3,133 | ₹98 | 2.1% |
| 3 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹213 | 63.1% | -₹13,603 | ₹4,979 | -₹2,878 | ₹92 | 1.2% |

**Read-through:** NIFTY stays mostly ATM-led, with ITM1 strongest in the
midday return-oriented slot. SENSEX is different: it favors ATM in the
morning and midday, but ITM1 in the afternoon. Therefore one pooled ranking
should not be treated as the best configuration for both instruments.

## Exact entry-time leaders

The 1,200-row diagnostics already contain the exact 15-minute entry grid. The
following are the best balanced configuration at each entry time, ranked
separately within each underlying. Starting at 09:17 in 15-minute increments
ends at 15:17; an exact 15:15 entry would be a different offset and is not in
the current sweep.

The full top-three table for every exact time is in [BL-096 exact-time
qualified list](BL-096-directional-qualified-list-exact-times.md).

For the full primary-sweep result, see [BL-096 full 15k exact-time qualified
list](BL-096-directional-qualified-list-primary-15k-exact-times.md). The table
above is the 1,200-row detailed-diagnostic shortlist.

### NIFTY

| Entry | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | Stop rate |
|---|---|---|---:|---:|---:|---:|---:|
| 09:17 | ITM1 | 30% / ₹4,000 / RE COST×1 / no trail | ₹256 | 54.2% | -₹22,820 | ₹8,812 | 19.6% |
| 09:32 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹278 | 60.0% | -₹18,642 | ₹6,703 | 9.6% |
| 09:47 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹456 | 63.3% | -₹21,421 | ₹5,844 | 6.2% |
| 10:02 | ATM | 25% / ₹4,000 / RE COST×1 / no trail | ₹457 | 62.9% | -₹15,753 | ₹4,212 | 8.8% |
| 10:17 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹401 | 59.2% | -₹15,896 | ₹4,683 | 7.9% |
| 10:32 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹390 | 61.7% | -₹20,517 | ₹5,383 | 7.5% |
| 10:47 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹590 | 67.1% | -₹7,944 | ₹2,470 | 4.6% |
| 11:02 | ITM1 | 25% / ₹4,000 / RE COST×2 / no trail | ₹778 | 70.0% | -₹15,372 | ₹3,322 | 7.5% |
| 11:17 | ATM | 25% / ₹4,000 / RE COST×2 / no trail | ₹619 | 63.7% | -₹9,487 | ₹2,689 | 2.9% |
| 11:32 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹550 | 60.4% | -₹11,758 | ₹4,602 | 5.8% |
| 11:47 | ATM | 25% / ₹4,000 / RE COST×2 / no trail | ₹536 | 68.3% | -₹10,696 | ₹3,172 | 1.2% |
| 12:02 | ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹444 | 67.5% | -₹12,870 | ₹2,988 | 4.2% |
| 12:17 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹499 | 65.0% | -₹17,602 | ₹4,565 | 4.6% |
| 12:32 | ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹299 | 66.7% | -₹20,300 | ₹4,967 | 4.6% |
| 12:47 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹342 | 64.2% | -₹11,985 | ₹3,397 | 2.5% |
| 13:02 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹355 | 66.7% | -₹19,936 | ₹5,641 | 3.8% |
| 13:17 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹278 | 60.0% | -₹9,763 | ₹3,276 | 1.7% |
| 13:32 | ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹190 | 60.8% | -₹14,880 | ₹5,634 | 2.1% |
| 13:47 | ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹277 | 67.1% | -₹8,193 | ₹2,353 | 1.7% |
| 14:02 | ITM1 | 30% / ₹4,000 / RE COST×2 / no trail | ₹180 | 60.4% | -₹13,413 | ₹4,289 | 2.9% |
| 14:17 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹218 | 62.9% | -₹8,642 | ₹2,856 | 1.2% |
| 14:32 | ATM | 25% / ₹3,500 / RE COST×1 / trail [15%,5%] | ₹142 | 57.1% | -₹7,465 | ₹2,483 | 0.8% |
| 14:47 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹365 | 72.1% | -₹5,424 | ₹882 | 0.4% |
| 15:02 | ATM | 21% / ₹3,000 / RE COST×1 / no trail | ₹197 | 62.9% | -₹3,789 | ₹1,344 | 0.0% |
| 15:17 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹180 | 68.8% | -₹2,577 | ₹614 | 0.0% |

### SENSEX

| Entry | Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | Stop rate |
|---|---|---|---:|---:|---:|---:|---:|
| 09:17 | ATM | 25% / ₹3,500 / RE COST×1 / trail [15%,5%] | ₹449 | 66.2% | -₹16,203 | ₹4,872 | 13.3% |
| 09:32 | ATM | 25% / ₹4,000 / RE COST×1 / trail [15%,5%] | ₹546 | 64.2% | -₹16,850 | ₹4,586 | 5.0% |
| 09:47 | ATM | 21% / ₹3,000 / RE COST×1 / trail [10%,5%] | ₹678 | 62.1% | -₹14,322 | ₹2,943 | 8.8% |
| 10:02 | ITM1 | 25% / ₹3,500 / RE COST×2 / no trail | ₹499 | 63.3% | -₹13,222 | ₹4,691 | 10.0% |
| 10:17 | ITM1 | 25% / ₹3,500 / RE COST×2 / no trail | ₹625 | 64.2% | -₹13,162 | ₹2,984 | 9.2% |
| 10:32 | ITM1 | 25% / ₹4,000 / RE COST×2 / no trail | ₹671 | 68.3% | -₹10,465 | ₹2,734 | 7.9% |
| 10:47 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹656 | 66.7% | -₹14,299 | ₹3,296 | 7.1% |
| 11:02 | ITM1 | 30% / ₹4,000 / RE COST×2 / no trail | ₹622 | 68.3% | -₹8,496 | ₹2,126 | 5.4% |
| 11:17 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹558 | 66.2% | -₹13,677 | ₹3,157 | 3.8% |
| 11:32 | ITM1 | 30% / ₹4,000 / RE COST×2 / no trail | ₹698 | 71.7% | -₹17,293 | ₹3,244 | 3.8% |
| 11:47 | ITM1 | 30% / ₹4,000 / RE COST×2 / no trail | ₹555 | 67.5% | -₹12,785 | ₹2,768 | 3.8% |
| 12:02 | ATM | 25% / ₹4,000 / RE COST×1 / no trail | ₹404 | 62.5% | -₹12,299 | ₹3,347 | 1.7% |
| 12:17 | ATM | 21% / ₹3,000 / RE COST×1 / no trail | ₹440 | 66.2% | -₹17,340 | ₹4,675 | 6.7% |
| 12:32 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹382 | 64.2% | -₹15,212 | ₹3,303 | 1.7% |
| 12:47 | ATM | 25% / ₹3,500 / RE COST×1 / no trail | ₹394 | 65.0% | -₹15,852 | ₹3,471 | 2.9% |
| 13:02 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹304 | 61.3% | -₹17,534 | ₹4,607 | 1.7% |
| 13:17 | ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹348 | 61.3% | -₹20,462 | ₹4,857 | 1.7% |
| 13:32 | ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹324 | 61.3% | -₹8,876 | ₹2,931 | 0.4% |
| 13:47 | ITM1 | 25% / ₹4,000 / RE COST×1 / no trail | ₹193 | 60.8% | -₹15,302 | ₹4,756 | 2.5% |
| 14:02 | ATM | 25% / ₹4,000 / RE COST×2 / no trail | ₹160 | 61.3% | -₹12,671 | ₹4,756 | 0.4% |
| 14:17 | ATM | 25% / ₹4,000 / RE COST×1 / no trail | ₹150 | 62.5% | -₹18,780 | ₹7,245 | 1.2% |
| 14:32 | ATM | 25% / ₹4,000 / RE COST×2 / no trail | ₹132 | 62.9% | -₹15,727 | ₹5,330 | 0.8% |
| 14:47 | ITM1 | 25% / ₹3,500 / RE COST×2 / no trail | ₹374 | 68.3% | -₹5,830 | ₹1,572 | 0.4% |
| 15:02 | ATM | 30% / ₹4,000 / RE COST×2 / no trail | ₹202 | 65.8% | -₹6,875 | ₹1,805 | 0.0% |
| 15:17 | ATM | 25% / ₹3,500 / RE COST×1 / trail [15%,5%] | ₹169 | 66.2% | -₹3,663 | ₹776 | 0.0% |

## 09:15–11:00

| Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | Stop rate |
|---|---|---:|---:|---:|---:|---:|
| ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹392 | 62.2% | -₹21,491 | ₹6,325 | 7.6% |
| ATM | 25% / ₹4,000 / RE COST×2 / no trail | ₹402 | 61.6% | -₹18,417 | ₹5,635 | 8.9% |
| ITM1 | 25% / ₹4,000 / RE COST×2 / no trail | ₹449 | 60.7% | -₹19,396 | ₹6,262 | 11.0% |

Early entries have higher return potential but materially higher stop frequency and
tail risk. ATM is preferable when risk control is more important than peak return.

## 11:00–13:00

| Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | Stop rate |
|---|---|---:|---:|---:|---:|---:|
| ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹495 | 63.9% | -₹18,411 | ₹5,015 | 4.4% |
| ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹425 | 63.6% | -₹17,421 | ₹4,413 | 3.0% |
| ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹395 | 65.4% | -₹16,893 | ₹4,550 | 3.8% |

Midday is the strongest band. The 30% / ₹4,000 / trail [10%,5%] configuration
is the leading choice, with ITM1 for return and ATM for lower risk.

## 13:00–15:30

| Strike | Configuration | Avg/day | Win rate | Max DD | Ulcer | Stop rate |
|---|---|---:|---:|---:|---:|---:|
| ATM | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹194 | 62.4% | -₹12,599 | ₹4,595 | 1.2% |
| ATM | 30% / ₹4,000 / RE COST×1 / no trail | ₹200 | 64.0% | -₹13,785 | ₹4,958 | 1.6% |
| ITM1 | 30% / ₹4,000 / RE COST×1 / trail [10%,5%] | ₹213 | 63.4% | -₹13,008 | ₹4,508 | 1.7% |

Afternoon return is lower, but risk is also lower. ATM is the more defensive
choice; ITM1 gives a modest return lift.

## Recommended shortlist

1. Midday ITM1 — 30% / ₹4,000 / RE COST×1 / trail [10%,5%].
2. Midday ATM — 30% / ₹4,000 / RE COST×1 / trail [10%,5%].
3. Early ATM — 25% / ₹4,000 / RE COST×2 / no trail.
4. Afternoon ATM — 30% / ₹4,000 / RE COST×1 / trail [10%,5%].

Source: `packages/option-backtesting/research/bl096/results/diagnostic_metrics.csv`.

# BL-097 Buy qualified list — post-charge sweep

Qualified Buy configurations from the registered one-factor sweep, ranked separately by underlying, family and entry-time band.
The holdout is 2025-10-09 through 2026-10-09; values are averages across the exact entry-time files in each section.
Results include ₹20 per order, STT, exchange charges, SEBI/IPFT, stamp duty and GST; slippage is not included.

## Ranking contract

Buy prioritizes post-charge return, drawdown, Ulcer Index, CVaR, expectancy, profit factor and entry quality.
Positive-day rate is secondary to entry-hit rate and payoff because no-entry days are part of the daily result.
Candidates still require fit-to-holdout stability and a separate owner decision before deployment.

## NIFTY

### 09:15–11:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `range_plus_30` | ₹13,353 | ₹17,742 | -₹4,388 | -₹18 | 38.4% |
| 2 | `leg_sl_20` | ₹2,748 | ₹20,985 | -₹18,237 | -₹75 | 37.0% |
| 3 | `exit_1450` | ₹776 | ₹20,885 | -₹20,109 | -₹83 | 37.4% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | -₹248 | -₹21,768 | -₹2,157 | ₹11,687 | -₹1,787 | -₹13 | 96.9% | 3.1% | 49.96m |
| 2 | -₹299 | -₹31,109 | -₹1,887 | ₹16,443 | -₹1,484 | -₹47 | 99.7% | 0.3% | 33.27m |
| 3 | -₹310 | -₹37,197 | -₹2,116 | ₹21,099 | -₹1,763 | -₹53 | 99.7% | 0.3% | 51.79m |

### 11:00–13:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `leg_sl_20` | ₹15,054 | ₹21,275 | -₹6,221 | -₹26 | 39.3% |
| 2 | `exit_1450` | ₹15,578 | ₹20,931 | -₹5,353 | -₹22 | 39.2% |
| 3 | `mtm_1000` | ₹14,325 | ₹21,146 | -₹6,822 | -₹28 | 38.8% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | -₹259 | -₹22,516 | -₹1,816 | ₹13,465 | -₹1,417 | -₹16 | 99.9% | 0.1% | 37.53m |
| 2 | -₹250 | -₹23,528 | -₹2,122 | ₹14,264 | -₹1,690 | -₹14 | 99.8% | 0.2% | 51.84m |
| 3 | -₹296 | -₹24,568 | -₹1,756 | ₹14,962 | -₹1,325 | -₹18 | 99.9% | 0.1% | 50.47m |

### 13:00–15:30

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `exit_1450` | ₹1,106 | ₹17,525 | -₹16,419 | -₹68 | 37.2% |
| 2 | `leg_sl_15` | -₹1,155 | ₹17,203 | -₹18,358 | -₹76 | 32.0% |
| 3 | `exit_1500` | -₹5,891 | ₹16,825 | -₹22,716 | -₹94 | 33.8% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | -₹158 | -₹23,649 | -₹2,443 | ₹11,630 | -₹1,533 | -₹50 | 95.3% | 4.7% | 25.13m |
| 2 | -₹184 | -₹23,268 | -₹1,631 | ₹12,159 | -₹1,075 | -₹61 | 89.9% | 10.1% | 13.92m |
| 3 | -₹176 | -₹28,010 | -₹2,283 | ₹13,790 | -₹1,529 | -₹74 | 90.9% | 9.1% | 25.24m |

## SENSEX

### 09:15–11:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `exit_1528` | ₹6,216 | ₹17,635 | -₹11,419 | -₹47 | 34.0% |
| 2 | `range_plus_30` | ₹9,301 | ₹14,329 | -₹5,028 | -₹21 | 33.5% |
| 3 | `range_plus_20` | ₹8,645 | ₹15,607 | -₹6,962 | -₹29 | 33.6% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | -₹128 | -₹12,682 | -₹757 | ₹7,294 | -₹600 | -₹32 | 97.5% | 2.5% | 51.03m |
| 2 | -₹91 | -₹8,295 | -₹860 | ₹4,866 | -₹642 | -₹17 | 91.7% | 8.3% | 45.26m |
| 3 | -₹107 | -₹8,428 | -₹845 | ₹5,021 | -₹633 | -₹22 | 94.2% | 5.8% | 47.99m |

### 11:00–13:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `range_plus_30` | ₹13,908 | ₹14,913 | -₹1,005 | -₹4 | 33.9% |
| 2 | `range_plus_20` | ₹11,815 | ₹16,314 | -₹4,499 | -₹19 | 33.8% |
| 3 | `leg_sl_30` | ₹12,112 | ₹18,161 | -₹6,049 | -₹25 | 34.7% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | -₹82 | -₹9,257 | -₹864 | ₹4,450 | -₹627 | -₹4 | 93.4% | 6.6% | 41.10m |
| 2 | -₹100 | -₹10,953 | -₹830 | ₹6,057 | -₹617 | -₹14 | 96.3% | 3.7% | 46.05m |
| 3 | -₹126 | -₹12,821 | -₹1,094 | ₹7,045 | -₹708 | -₹17 | 98.8% | 1.2% | 64.32m |

### 13:00–15:30

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `exit_1450` | ₹4,248 | ₹14,974 | -₹10,726 | -₹44 | 27.2% |
| 2 | `leg_sl_15` | ₹5,443 | ₹14,743 | -₹9,299 | -₹38 | 27.4% |
| 3 | `exit_1528` | ₹3,807 | ₹16,082 | -₹12,276 | -₹51 | 30.0% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | -₹84 | -₹12,192 | -₹722 | ₹6,873 | -₹529 | -₹35 | 92.1% | 7.9% | 22.74m |
| 2 | -₹77 | -₹10,366 | -₹626 | ₹5,622 | -₹418 | -₹32 | 87.6% | 12.4% | 14.27m |
| 3 | -₹98 | -₹13,721 | -₹889 | ₹6,367 | -₹600 | -₹38 | 93.6% | 6.4% | 27.64m |

## Source

Machine-readable results: `research/bl097/results/buy_sweep_postcharge.csv`.
Invalid configurations are retained in the CSV with an error and excluded from ranking.

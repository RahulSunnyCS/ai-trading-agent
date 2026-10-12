# BL-098 Widesl qualified list — post-charge sweep

Qualified Widesl configurations from the registered one-factor sweep, ranked separately by index and entry-time band.
The holdout is 2025-10-09 through 2026-10-09; values are averages across the exact entry-time files in each section.
Results include ₹20 per order, STT, exchange charges, SEBI/IPFT, stamp duty and GST; slippage is not included.

## Ranking contract

Widesl shows the best four configurations across all strike/premium families for each index and time band, prioritizing post-charge return, tail loss, CVaR, maximum drawdown, Ulcer Index and expectancy.
Win rate is secondary; MTM stops, re-entry turnover and the loss tail must remain controlled.
Candidates still require fit-to-holdout stability and a separate owner decision before deployment.

## NIFTY

### 09:15–11:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `NIFTY P100 / leg_sl_90` | ₹57,179 | ₹29,497 | ₹27,683 | ₹114 | 60.8% |
| 2 | `NIFTY P80 / trail_5_5` | ₹52,147 | ₹28,157 | ₹23,989 | ₹99 | 60.4% |
| 3 | `NIFTY P100 / leg_sl_80` | ₹61,524 | ₹29,495 | ₹32,029 | ₹132 | 59.8% |
| 4 | `NIFTY P80 / leg_sl_100` | ₹49,337 | ₹28,159 | ₹21,178 | ₹88 | 59.8% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹584 | -₹34,102 | -₹3,652 | ₹12,989 | -₹3,135 | ₹57 | 1.04 | 23.4% | 0.0 |
| 2 | ₹481 | -₹28,430 | -₹3,576 | ₹11,318 | -₹3,112 | ₹50 | 1.04 | 22.4% | 0.0 |
| 3 | ₹538 | -₹36,676 | -₹3,796 | ₹13,503 | -₹3,100 | ₹66 | 1.05 | 21.4% | 0.0 |
| 4 | ₹485 | -₹29,051 | -₹3,589 | ₹12,043 | -₹3,108 | ₹44 | 1.04 | 20.9% | 0.0 |

### 11:00–13:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `NIFTY OTM1 / leg_sl_80` | ₹44,206 | ₹28,964 | ₹15,242 | ₹63 | 61.4% |
| 2 | `NIFTY OTM1 / leg_sl_90` | ₹39,949 | ₹28,966 | ₹10,983 | ₹45 | 60.6% |
| 3 | `NIFTY OTM1 / leg_sl_100` | ₹35,786 | ₹28,968 | ₹6,817 | ₹28 | 59.9% |
| 4 | `NIFTY OTM1 / mtm_none` | ₹42,220 | ₹28,965 | ₹13,255 | ₹55 | 60.1% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹360 | -₹28,615 | -₹3,905 | ₹13,157 | -₹3,156 | ₹32 | 1.03 | 12.5% | 0.0 |
| 2 | ₹345 | -₹34,028 | -₹3,997 | ₹16,926 | -₹3,185 | ₹23 | 1.02 | 13.3% | 0.0 |
| 3 | ₹317 | -₹36,962 | -₹3,997 | ₹19,599 | -₹3,211 | ₹14 | 1.02 | 14.5% | 0.0 |
| 4 | ₹320 | -₹37,107 | -₹8,125 | ₹17,369 | -₹4,900 | ₹28 | 1.03 | 0.0% | 0.0 |

### 13:00–15:30

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `NIFTY P100 / mtm_none` | ₹52,299 | ₹29,501 | ₹22,798 | ₹94 | 60.6% |
| 2 | `NIFTY P100 / mtm_3500` | ₹50,075 | ₹29,502 | ₹20,573 | ₹85 | 60.5% |
| 3 | `NIFTY P100 / mtm_4000` | ₹50,098 | ₹29,502 | ₹20,596 | ₹85 | 60.5% |
| 4 | `NIFTY P80 / leg_sl_150` | ₹48,129 | ₹28,165 | ₹19,964 | ₹82 | 60.2% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹172 | -₹16,770 | -₹5,021 | ₹5,775 | -₹2,653 | ₹47 | 1.06 | 0.0% | 0.0 |
| 2 | ₹171 | -₹16,814 | -₹3,994 | ₹6,039 | -₹2,651 | ₹43 | 1.05 | 2.6% | 0.0 |
| 3 | ₹172 | -₹16,862 | -₹4,254 | ₹6,026 | -₹2,729 | ₹43 | 1.05 | 1.8% | 0.0 |
| 4 | ₹193 | -₹18,698 | -₹3,654 | ₹6,626 | -₹2,488 | ₹41 | 1.06 | 6.0% | 0.0 |

## SENSEX

### 09:15–11:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `SENSEX P250 / leg_sl_80` | ₹33,388 | ₹27,692 | ₹5,697 | ₹24 | 58.1% |
| 2 | `SENSEX P250 / re_cost1` | ₹33,445 | ₹28,035 | ₹5,410 | ₹22 | 56.2% |
| 3 | `SENSEX P250 / re_cost2` | ₹33,445 | ₹28,035 | ₹5,410 | ₹22 | 56.2% |
| 4 | `SENSEX P250 / mtm_4000` | ₹39,407 | ₹27,689 | ₹11,718 | ₹48 | 57.7% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹426 | -₹32,996 | -₹4,385 | ₹16,152 | -₹3,136 | ₹12 | 1.01 | 17.6% | 0.0 |
| 2 | ₹323 | -₹44,316 | -₹3,832 | ₹22,165 | -₹3,104 | ₹11 | 1.01 | 23.2% | 6.0 |
| 3 | ₹323 | -₹44,316 | -₹3,832 | ₹22,165 | -₹3,104 | ₹11 | 1.01 | 23.2% | 6.0 |
| 4 | ₹376 | -₹43,807 | -₹4,865 | ₹21,383 | -₹4,352 | ₹24 | 1.02 | 6.9% | 0.0 |

### 11:00–13:00

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `SENSEX P250 / leg_sl_80` | ₹38,806 | ₹27,687 | ₹11,119 | ₹46 | 60.6% |
| 2 | `SENSEX OTM2 / leg_sl_80` | ₹22,706 | ₹28,326 | -₹5,620 | -₹23 | 58.6% |
| 3 | `SENSEX P250 / leg_sl_90` | ₹22,014 | ₹27,694 | -₹5,680 | -₹23 | 59.1% |
| 4 | `SENSEX P320 / leg_sl_80` | ₹32,530 | ₹29,071 | ₹3,458 | ₹14 | 60.3% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹314 | -₹34,070 | -₹4,886 | ₹17,749 | -₹3,166 | ₹23 | 1.02 | 12.1% | 0.0 |
| 2 | ₹223 | -₹42,540 | -₹4,141 | ₹24,956 | -₹3,091 | -₹12 | 0.99 | 11.8% | 0.0 |
| 3 | ₹279 | -₹41,996 | -₹5,289 | ₹23,950 | -₹3,219 | -₹12 | 0.99 | 14.4% | 0.0 |
| 4 | ₹347 | -₹40,914 | -₹6,248 | ₹21,493 | -₹3,329 | ₹7 | 1.01 | 16.5% | 0.0 |

### 13:00–15:30

| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `SENSEX P250 / leg_sl_80` | ₹42,387 | ₹27,685 | ₹14,702 | ₹61 | 58.3% |
| 2 | `SENSEX P250 / baseline` | ₹41,568 | ₹27,685 | ₹13,883 | ₹57 | 57.7% |
| 3 | `SENSEX P250 / mtm_2000` | ₹42,014 | ₹27,685 | ₹14,329 | ₹59 | 57.6% |
| 4 | `SENSEX P250 / mtm_4000` | ₹45,717 | ₹27,683 | ₹18,034 | ₹75 | 58.0% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹193 | -₹16,932 | -₹4,285 | ₹7,713 | -₹2,523 | ₹31 | 1.04 | 5.2% | 0.0 |
| 2 | ₹185 | -₹18,819 | -₹3,767 | ₹8,740 | -₹2,576 | ₹29 | 1.03 | 4.9% | 0.0 |
| 3 | ₹183 | -₹16,899 | -₹3,342 | ₹7,738 | -₹2,334 | ₹30 | 1.03 | 7.5% | 0.0 |
| 4 | ₹188 | -₹19,035 | -₹4,116 | ₹8,784 | -₹2,676 | ₹37 | 1.05 | 1.1% | 0.0 |

## Source

Machine-readable results: `packages/option-backtesting/research/bl097/results/widesl_sweep_postcharge.csv`.
Invalid configurations are retained in the CSV with an error and excluded from ranking.

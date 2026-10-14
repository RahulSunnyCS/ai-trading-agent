# Combined final qualified list — Directional, Buy and Widesl

One final configuration selected after comparing Directional, Buy and Widesl for every index and timing band. This is the compact final list; it does not repeat every family or every sweep variation.

Holdout: 2025-10-09 through 2026-10-09. Charges include ₹20 per order,
STT, exchange charges, SEBI/IPFT, stamp duty and GST. Slippage is not
included. Rankings use each strategy's registered balanced criteria.

## NIFTY — 09:15–11:00

| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---|---|---|---:|---:|---:|---:|---:|
| Directional | ATM | `SL 30% / MTM ₹3000 / exit 15:28 / RE cost1` | ₹75,598 | ₹38,440 | ₹37,158 | ₹155 | 57.7% |

| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Directional | ₹419 | -₹29,219 | -₹4,198 | ₹12,556 | -₹3,663 | ₹62 | 1.06 | 18.0% | 130.9 |

## NIFTY — 11:00–13:00

| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---|---|---|---:|---:|---:|---:|---:|
| Directional | ATM | `SL 25% / MTM ₹2500 / exit 15:28 / RE cost1` | ₹95,451 | ₹37,399 | ₹58,052 | ₹242 | 59.0% |

| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Directional | ₹370 | -₹22,164 | -₹3,612 | ₹8,034 | -₹3,109 | ₹96 | 1.11 | 12.9% | 125.5 |

## NIFTY — 13:00–15:30

| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---|---|---|---:|---:|---:|---:|---:|
| Widesl | P100 | `mtm_none` | ₹52,299 | ₹29,501 | ₹22,798 | ₹94 | 60.6% |

| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Widesl | ₹172 | -₹16,770 | -₹5,021 | ₹5,775 | -₹2,653 | ₹47 | 1.06 | 0.0% | 0.0 |

## SENSEX — 09:15–11:00

| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---|---|---|---:|---:|---:|---:|---:|
| Directional | ATM | `SL 25% / MTM ₹3000 / exit 15:28 / RE cost1` | ₹97,093 | ₹39,434 | ₹57,659 | ₹240 | 60.7% |

| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Directional | ₹541 | -₹21,991 | -₹4,316 | ₹7,279 | -₹3,649 | ₹91 | 1.09 | 15.5% | 156.4 |

## SENSEX — 11:00–13:00

| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---|---|---|---:|---:|---:|---:|---:|
| Directional | ATM | `SL 21% / MTM ₹2500 / exit 15:28 / RE cost1` | ₹99,500 | ₹38,351 | ₹61,149 | ₹255 | 59.8% |

| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Directional | ₹450 | -₹23,532 | -₹3,318 | ₹8,082 | -₹3,035 | ₹98 | 1.13 | 12.3% | 147.0 |

## SENSEX — 13:00–15:30

| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---|---|---|---:|---:|---:|---:|---:|
| Widesl | P250 | `leg_sl_80` | ₹42,387 | ₹27,685 | ₹14,702 | ₹61 | 58.3% |

| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Widesl | ₹193 | -₹16,932 | -₹4,285 | ₹7,713 | -₹2,523 | ₹31 | 1.04 | 5.2% | 0.0 |

## Interpretation

This report keeps only the combined winner in each index/timing section. The winner is selected from the best Directional, Buy and Widesl candidate using the balanced post-charge criteria. It is not an automatic live recommendation; fit-to-holdout stability, tail risk and forward validation still apply.

## Note (2026-10-14)

The holdout above was used to choose these rows, so it is no longer unseen for any later
selection. BL-102 fits on the full 2024-10-09 → 2026-10-09 window and says so.

## Sources

- `packages/option-backtesting/research/bl096/results/primary_diagnostics_charged.csv`
- `packages/option-backtesting/research/bl097/results/buy_sweep_postcharge.csv`
- `packages/option-backtesting/research/bl097/results/widesl_sweep_postcharge.csv`

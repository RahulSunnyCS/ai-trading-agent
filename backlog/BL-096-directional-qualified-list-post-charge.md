# BL-096 Directional qualified list — post-charge 15k sweep

Current qualified Directional configurations from the complete 15,000-cell
primary sweep. The ranking is separated by underlying and broad entry-time
band, using the 2025-10-09 to 2026-10-09 chronological holdout.

The current full diagnostic run uses the baseline secondary setting:
RE COST×1, no cutoff and no trailing stop. It includes ATM and ITM1. Values
below are averages across the exact entry-time cohorts in each band and are
**after brokerage and statutory charges, but before slippage**.

## Selection criteria

Candidates are ranked with an equal-weight balanced score across:

- holdout net return, average daily P&L and median daily P&L;
- positive-day rate (the report's holdout win-rate field) and trade expectancy;
- maximum drawdown, worst day and 95% daily CVaR;
- Ulcer Index and MTM-stop frequency, where lower is better.

Return is not selected by itself. The detailed diagnostic contract also
requires review of profit factor, payoff ratio, losing streak, recovery time,
CE/PE contribution, one-leg versus both-leg stop behaviour, re-entry impact,
fit-to-holdout degradation and instrument stability before any live change.

## NIFTY — 09:15–11:00

| Rank | Strike | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | ATM | 30% / ₹3,000 / 15:28 | ₹75,598 | ₹38,440 | ₹37,158 | ₹155 | 57.7% |
| 2 | ATM | 25% / ₹3,500 / 15:28 | ₹81,904 | ₹41,026 | ₹40,878 | ₹170 | 57.9% |
| 3 | ATM | 35% / ₹3,500 / 15:28 | ₹72,137 | ₹37,221 | ₹34,916 | ₹145 | 58.4% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Expectancy | MTM stops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹419 | -₹29,219 | -₹4,198 | ₹12,556 | -₹3,663 | ₹62 | 18.0% |
| 2 | ₹443 | -₹28,150 | -₹4,850 | ₹11,259 | -₹4,164 | ₹64 | 13.2% |
| 3 | ₹449 | -₹30,756 | -₹4,568 | ₹12,850 | -₹4,122 | ₹59 | 13.3% |

## NIFTY — 11:00–13:00

| Rank | Strike | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | ATM | 25% / ₹2,500 / 15:28 | ₹95,451 | ₹37,399 | ₹58,052 | ₹242 | 59.0% |
| 2 | ATM | 30% / ₹3,000 / 15:28 | ₹90,237 | ₹36,048 | ₹54,189 | ₹226 | 60.6% |
| 3 | ATM | 30% / ₹3,500 / 15:28 | ₹90,636 | ₹36,278 | ₹54,358 | ₹226 | 60.8% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Expectancy | MTM stops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹370 | -₹22,164 | -₹3,612 | ₹8,034 | -₹3,109 | ₹96 | 12.9% |
| 2 | ₹356 | -₹20,676 | -₹4,019 | ₹6,981 | -₹3,527 | ₹93 | 8.8% |
| 3 | ₹361 | -₹20,122 | -₹4,401 | ₹7,010 | -₹3,952 | ₹93 | 6.3% |

## NIFTY — 13:00–15:30

| Rank | Strike | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | ATM | 35% / ₹4,000 / 15:28 | ₹52,161 | ₹33,564 | ₹18,597 | ₹77 | 57.8% |
| 2 | ATM | 35% / ₹3,500 / 15:28 | ₹51,327 | ₹33,532 | ₹17,795 | ₹74 | 57.8% |
| 3 | ATM | 30% / ₹4,000 / 15:28 | ₹52,032 | ₹34,234 | ₹17,798 | ₹74 | 57.3% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Expectancy | MTM stops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹156 | -₹15,691 | -₹4,288 | ₹7,087 | -₹2,966 | ₹34 | 1.3% |
| 2 | ₹154 | -₹16,971 | -₹4,088 | ₹7,631 | -₹2,919 | ₹32 | 1.9% |
| 3 | ₹144 | -₹17,375 | -₹4,338 | ₹7,799 | -₹2,985 | ₹32 | 1.5% |

## SENSEX — 09:15–11:00

| Rank | Strike | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | ATM | 25% / ₹3,000 / 15:28 | ₹97,093 | ₹39,434 | ₹57,659 | ₹240 | 60.7% |
| 2 | ATM | 25% / ₹2,500 / 15:28 | ₹95,349 | ₹39,015 | ₹56,333 | ₹235 | 59.5% |
| 3 | ITM1 | 25% / ₹2,500 / 15:28 | ₹106,606 | ₹39,631 | ₹66,975 | ₹279 | 58.5% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Expectancy | MTM stops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹541 | -₹21,991 | -₹4,316 | ₹7,279 | -₹3,649 | ₹91 | 15.5% |
| 2 | ₹502 | -₹23,520 | -₹4,021 | ₹8,129 | -₹3,238 | ₹90 | 20.4% |
| 3 | ₹548 | -₹21,149 | -₹4,390 | ₹6,975 | -₹3,300 | ₹109 | 23.5% |

## SENSEX — 11:00–13:00

| Rank | Strike | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | ATM | 21% / ₹2,500 / 15:28 | ₹99,500 | ₹38,351 | ₹61,149 | ₹255 | 59.8% |
| 2 | ITM1 | 21% / ₹2,500 / 15:28 | ₹116,952 | ₹38,903 | ₹78,049 | ₹325 | 59.3% |
| 3 | ITM1 | 21% / ₹3,000 / 15:28 | ₹116,969 | ₹39,188 | ₹77,781 | ₹324 | 60.2% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Expectancy | MTM stops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹450 | -₹23,532 | -₹3,318 | ₹8,082 | -₹3,035 | ₹98 | 12.3% |
| 2 | ₹497 | -₹22,333 | -₹3,687 | ₹7,623 | -₹3,170 | ₹128 | 15.9% |
| 3 | ₹521 | -₹23,412 | -₹4,063 | ₹7,902 | -₹3,650 | ₹126 | 11.4% |

## SENSEX — 13:00–15:30

| Rank | Strike | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | ATM | 35% / ₹2,000 / 15:28 | ₹45,470 | ₹32,496 | ₹12,975 | ₹54 | 57.1% |
| 2 | ITM1 | 35% / ₹2,000 / 15:28 | ₹49,410 | ₹32,949 | ₹16,461 | ₹69 | 56.7% |
| 3 | ATM | 35% / ₹2,500 / 15:28 | ₹46,695 | ₹32,569 | ₹14,126 | ₹59 | 57.5% |

| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Expectancy | MTM stops |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | ₹162 | -₹16,659 | -₹2,968 | ₹7,634 | -₹2,335 | ₹24 | 8.8% |
| 2 | ₹185 | -₹16,260 | -₹3,145 | ₹7,047 | -₹2,450 | ₹31 | 10.5% |
| 3 | ₹169 | -₹16,717 | -₹3,288 | ₹7,367 | -₹2,592 | ₹26 | 5.4% |

## Read-through

- NIFTY is ATM-led in all three broad bands. Its strongest post-charge band is
  11:00–13:00; afternoon entries have much lower net return.
- SENSEX has the strongest post-charge results in the 11:00–13:00 band, where
  ITM1 with 21% SL and ₹2,500–₹3,000 MTM is the return leader, but the higher
  stop rate must be accepted.
- Morning SENSEX ITM1 has higher return than the ATM leaders but also a 23.5%
  MTM-stop rate; it is not automatically the safer choice.
- All broad-band leaders use a 15:28 exit in this baseline sweep. This is a
  screening result and needs forward validation before being treated as a
  deployment rule.
- Exact-time rankings are more exposed to multiple-testing risk. Late entries,
  especially 15:02 and 15:17, have small effective holding windows and should
  not be selected solely because their percentage win rate looks high.

The machine-readable source is
`packages/option-backtesting/research/bl096/results/primary_diagnostics_charged.csv`.
The older [pre-charge qualified list](BL-096-directional-qualified-list.md)
is retained for historical comparison. Detailed exact-time screening should
be followed by the same CE/PE, leg-stop, re-entry, CVaR, Ulcer and
fit-to-holdout review before any live change.

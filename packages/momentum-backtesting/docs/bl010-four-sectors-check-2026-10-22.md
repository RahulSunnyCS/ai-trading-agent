# Four Sectors Monthly, No Tilt, all Fridays: does it hold up under the real trade? (2026-10-22)

Pre-registered in `search_spaces/bl010_criteria_addendum_6.json` (committed before any run).
Result file: `search_spaces/bl010_four_sectors_result.json`. Script:
`scripts/bl010_four_sectors_check.py`. Window 2017-01-06 to 2026-10-16 (511 weeks), run id
`fbb7ab054238`, four Fridays at Rs 50,000 each, equal capital reset each April. 512 backtests.

**Verdict: MIXED.** It clears the minimum bar and three of the four robustness tests, and fails the
drawdown basket and the bad-year rule. It does not turn on the Monday-open estimate.

## The headline moves from 44.9% to about 26%

| Case | CAGR | Worst fall |
|---|---|---|
| A0, as ranked on 2026-10-08 (curated tags, pre-tax) | 44.9% | -27.0% |
| A1, extended tags | 35.7% | -32.4% |
| A2, curated tags, after tax | 34.6% | -27.6% |
| A3, extended tags and tax | 27.7% | -32.8% |
| E, A3 plus buying at Monday's open with whole shares (audit replay) | 26.1% | -33.2% |
| Nifty200 Momentum 30 TRI, same weeks | 16.5% | |

A0 reproduces the 2026-10-08 row exactly (44.21%) when cut at 2026-10-02 and averaged without the
April reset; the 0.7-point difference to 44.9% is two extra weeks (+0.3) and the April reset (+0.3).
The tags cost 9 points, tax 10, the fill day and whole shares 1.6. They do not add up to the total
because they overlap. The tax is the same 8-9 points BL-085 measured.

## The gates

| Gate | Result | Number |
|---|---|---|
| G1 minimum bar, 5 points over Mom30 after tax | **pass** | E is +9.5 points (+11.2 with no Monday cost) |
| G2 medium drawdown basket | **fail** | worst fall -32.8% (E -33.2%): past the 30% fixed limit and the Smallcap 250 rule; inside the -40% ceiling; passes the aggressive basket (reported) |
| G3 no year more than 10 points behind Mom30 | **fail** | FY2024: 47.5% against Mom30's 70.0%, 22.5 points behind |
| G4 plateau | pass | all 22 one-step neighbours are 32-45%, median 44.5% (-0.4); 7 of them are copies of A0 (this score ignores lookbacks and weights, 6 neighbours, and `coverage_floor 0.0013` does not bind); without them 15 neighbours, median -0.9, lowest `score ranksum` 32.2% |
| G5 alpha | pass, barely | 12.2% a year, t 2.03 against the 2.0 line; market beta 0.87, size 0.65, momentum 0.31 |
| G6 fair placebo | pass | 44.9% against the placebo's 95th percentile 23.9%, +21 points |

## What the rest says (reported, not judged)

- **The result leans on a few names.** The five largest realised profits are 57% of the total
  (flag above 50%): KIRLOSENG 14%, Silver 12%, ANANTRAJ 12%, Gold 10%, WABAG 10%.
- **A resampled history is wider than the backtest.** CAGR 5th percentile 12.2% (below Mom30's
  16.5%), median 27.7%, 95th 45.6%; the 1-in-20 worst fall is -48% to -50%, against -32.8% seen.
- **Rolling windows:** two-year returns worst -9.0%, median 28.7%, best 76.2%; the worst two years
  trail Mom30 by 15.8 points; three-year worst +3.5%.
- **The four Fridays differ:** 41.1% to 49.1% as ranked, worst falls -29.9% to -31.5% each.
- **On the whole portfolio:** a -32.8% fall in a slice is -3.3% of the portfolio at 10%, -4.9% at
  15%, -6.5% at 20%.
- **Selection:** the config is in the top 0.8% of the 8,003 over the whole window (98th percentile
  in 2017-04 to 2022-03, 93rd in 2022-04 to 2026-03). The median config makes 28.1% pre-tax. The
  2017-2026 numbers are a selected result, so read E as an upper-leaning estimate.
- **Monday open:** 1.6 points of CAGR and 0.5 of drawdown on the registered (signal-delay-1)
  runs; on the signal-delay-0 runs that match your trade (signal Friday, buy Monday) it is 1.9
  points and 1.1 of drawdown (supplement below). It comes from the independent replay, not the
  engine; the engine still fills at the Friday close (BL-010 E13 stays open).

## What it cannot say

No clean hold-out is left for this config, so this is not an out-of-sample return. The extended
tags are today's classification; delisted names stay untagged; today's tax rates apply to all
years; the account ramps in over four Mondays while the backtest starts all four sleeves at once.
Smallcap 250, Midcap 150 and Nifty 500 TRIs end 2026-10-02, so G2, G5 and those comparator lines
are judged to that week; G1 and G3 use all of the window.

## Notes on how the run went

- The first attempt of the Monday-open step crashed on a missing week key; fixed and re-run. The
  report step was edited once after it failed on the shorter benchmark series (the cutoff above) and
  once to add the A0 reproduction and the G4 figures without copies of A0. No gate, threshold or
  variant changed.

## Supplement (addendum 7): the same on signal-delay-0 runs

Code review found that the registered Monday-open measure used delay-1 runs, so its "next open" was
a week and three days after the signal, not the Monday after it. Addendum 7 (committed before the run)
repeats the variants with signal delay 0, which is your trade; the registered result above stays the record.
Result: `search_spaces/bl010_four_sectors_supplement.json`.

| | Registered (delay 1) | Supplement (delay 0) |
|---|---|---|
| Extended tags and tax | 27.7%, -32.8% | 27.4%, -32.8% |
| Monday open, whole shares | -1.6 pts, -0.5 | -1.9 pts, -1.1 |
| Expected case | 26.1%, -33.2% | **25.5%, -33.9%** |
| Over Mom30 TRI (16.5%) | +9.5 pts | +9.0 pts |
| Alpha (t) | 12.2% (2.03) | 11.9% (1.94) |
| Worst year against Mom30 | FY2024, -22.5 pts | FY2024, -26.8 pts |
| Verdict | MIXED | MIXED |

The picture does not change: the minimum bar passes, the drawdown basket and the bad-year rule fail.
Alpha now falls just under the t = 2 line (1.94), so it no longer passes; the registered G5 is a bare pass either way.

Output addendum 6 listed and the first result left out:

- **Falls of 10% or more (S3):** the long ones are Jan 2018 to Jan 2019 (-32.8%, 54 weeks down, 80 weeks
  back to the old peak, about 2.6 years under water in all), Oct 2021 to Jun 2022 (-30.8%, 36 down, 22
  back) and Jan to May 2025 (-22.6%, 17 down, 34 back). Registered A3 is similar (the 2018 fall: 41 down, 90 back).
- **The Smallcap 250's five worst weeks:** 20 Mar 2020 (index -15.8%, strategy -7.8%), 13 Mar 2020 (-12.7%, -9.5%),
  14 Feb 2025 (-9.6%, -8.6%), 28 Sep 2018 (-9.2%, -15.0%), 2 Feb 2018 (-8.5%, -11.9%). It fell more than the
  index in the 2018 weeks and less in the 2020 and 2025 ones. The Midcap 150's worst weeks are in the result file.
- Dropped: the financial-year table "of E". E is an estimate of two numbers, not a curve (addendum 7).

Counts: the registered run recorded 512 backtests; it assumed four sleeves for every neighbour but one used two
(about 510), and the reproduce stage added 8. The supplement ran 16.

## After review (PR 285)

The gate numbers are now read from `search_spaces/bl010_criteria_addendum_8.json` (they restate
addendum 6's words; nothing changed), the verdict rule and the plateau gate are plain functions with
tests (`tests/test_bl010_four_sectors_check.py`), and the result file's recorded commit is the one
before its last edits: the script that wrote `bl010_four_sectors_result.json` is the one committed in
`6660d31a`, which also holds the result. The check runs once, so the file is not rewritten.

## Correction found while building the Monday-fill option (BL-036 Phase 2)

The "Monday open" cost of 1.6 to 1.9 points mixes two things. The replay prices the same decisions
three ways on the signal-delay-0 runs (extended tags, four Fridays, pre-tax):

| Fill | CAGR | Max drawdown |
|---|---|---|
| Friday close, fractional shares | 35.4% | -30.9% |
| Monday open, fractional shares | 34.7% | -31.7% |
| Monday open, whole shares at Rs 50,000 a sleeve | 33.5% | -32.0% |

So **the Monday fill itself costs about 0.7 points** (0.83 in the new engine option), and **rounding to
whole shares on a Rs 50,000 sleeve costs another 1.2 points**. The expected case of 25.5% already
includes both; the split matters for what can be fixed: the second part shrinks with a larger lot or
by topping up the leftover cash next week, the first does not.

# BL-116 — Does the sector a pick came from tell winners from losers?

| | |
|---|---|
| **Priority** | P1 — BL-115 found the stock's own numbers say little; the sector choice decides most of a Broad portfolio |
| **Status** | Phase 1 done — H1 (sector position) passes; H2 (sector score) killed. Phase 2 needs its own pre-registration |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-17 |
| **Depends on** | BL-115 (trades, outcome definition, the owner's average-weekly score) |
| **TODO.md row** | — |

## Context

BL-115 (killed): measures from a stock's own history at the buy week barely sort the picks of Trio
Fortnightly and Four Sectors Monthly, No Tilt. Its descriptive follow-up found no difference by pick
order inside a sector, but a clear one by the sector's place: picks from the best-placed sector held
beat Nifty 500 47% (Trio) and 60% (Four Sectors) of the time, against 38-54% for the others. The owner
(2026-10-17) asked to test the sector level: the sector's position, and the sector's own
average-weekly score.

That position pattern was seen on those two strategies' 2017-2022 trades, so testing it there again
would only confirm what was looked at. Its verdict comes from the other nine saved Broad groups'
2017-2022 trades, which nobody has looked at for this question.

## Goal

Two pre-registered answers on 2017-2022: (H1) do best-placed-sector picks beat the index more often;
(H2) does the chosen sector's own average-weekly score separate winning from losing picks?

## Out of scope

Changing the engine or the live signal (only after a pass, under its own pre-registration); other
sector measures; reading 2023 onwards.

## Plan

### Phase 0 — Pre-register (committed before any run)

The binding rule is `packages/momentum-backtesting/search_spaces/bl116_criteria.json`. In words:

- **Trades:** as in BL-115 (closed positions filled 2017-01-06 to 2022-12-30, outcome = return over
  Nifty 500 TRI, winner if above zero); stocks only (Gold, Silver and the foreign indices counted and
  left out); the sector is the category the engine bought the stock through, and its position is the
  category's place in that week's held list (fresh positions only).
- **H1, sector position (decides on the nine other groups, 36 sleeves):** position-1 picks' beat rate
  minus the other fresh positions', above zero in at least 7 of 9 groups AND at least 5 points over
  all nine with a 90% block-bootstrap interval above zero. Trio and Four Sectors are shown, not judged.
- **H2, sector score (decides on Trio and Four Sectors):** the mean over the sector's point-in-time
  members of the owner's score (sum over the strategy's lookbacks of return / weeks). Passes when, in
  BOTH strategies, its rank correlation with the excess is positive at t >= 3 AND its lowest fifth has
  at least 10 points more losers than overall.
- **Look-ahead check:** a test recomputes the sector score with every later price removed.
- **Hold-out:** 2023-01-06 onwards sealed. All eleven groups were chosen on 2017-2026 results, and the
  nine share sectors and stocks with the two, so the nine are unseen trades, not independent evidence.
- **Will not run / report only:** listed in the JSON.

### Phase 1 — Run on 2017-2022
- **Tasks:** `scripts/bl116_sector_tests.py` (re-run the sleeves to 2022, read each pick's sector
  and position from the run, the sector score point-in-time, both tests, the report-only tables); a
  look-ahead test.
- **Deliverables:** `search_spaces/bl116_result.json`, the trade table under `data/search/bl116/`,
  the result below, the findings pages.
- **Done when:** both verdicts are written here under the rule.

### Phase 2 — More money for the best-placed sector (pre-registered 2026-10-17)

The binding rule is `search_spaces/bl116_criteria_addendum_1.json`, committed before any Phase 2
run. One setting: a buy week's money goes to picks from the best-placed sector at twice the share of
the others (`top_sector_weight=2.0`, a new opt-in engine hook that is off by default). All eleven
saved groups, after tax at Rs 5 lakh, judged on 2017-2022:

- **Passes** when the median CAGR gain is at least +0.5 pts and CAGR is not lower in at least 7 of 11,
  AND the worst fall is no more than 2 pts deeper in at least 9 of 11 with the median Ulcer change at
  most +0.01.
- **Then one check on 2023-01-06 to 2026-10-16:** median CAGR change at least 0 and the worst fall no
  more than 2 pts deeper in at least 8 of 11. Passing both makes it a candidate for the owner; nothing
  in the live signal changes by itself.

## Result (2026-10-17)

`search_spaces/bl116_result.json` (rule: `bl116_criteria.json`, committed and pushed before the run,
371911fa); trades `data/search/bl116/trades.csv` (git-ignored; regenerate with
`uv run python scripts/bl116_sector_tests.py`). 2017-2022 only.

### H1 — sector position: PASS

Nine groups, 5,244 stock picks from fresh sector positions. Beat rate of picks from the best-placed
sector minus that of the other fresh positions:

| Group | Position 1 minus the rest |
|---|---|
| Five Sectors, Wide Pool | +20.5 pts |
| Six Sectors Monthly, No Tilt | +19.0 |
| Six Sectors, Make Room | +17.9 |
| Five Sectors Monthly | +14.1 |
| Phase 6 ensemble | +13.4 |
| Four Sectors, Half Tilt | +11.4 |
| Five Sectors, Stock Tilt | +9.9 |
| Four Sectors, Quick Exit | +9.9 |
| Five Sectors, Rank Sum | +1.3 |

Above zero in 9 of 9; over all nine **+13.4 pts (90% interval +7.3 to +19.6)**. Rule: at least 7 of 9
and at least +5 pts with the interval above zero, so it passes.

| Position (all nine) | Picks | Beat Nifty 500 | Mean excess |
|---|---|---|---|
| 1 | 689 | 58% | +7.3% |
| 2 | 829 | 45% | +2.3% |
| 3 | 940 | 42% | +2.1% |
| 4 | 1,095 | 46% | +2.7% |
| 5 | 1,044 | 46% | +0.7% |
| 6 | 577 | 44% | +0.4% |

Shown, not judged (already seen): Four Sectors Monthly, No Tilt +11.6 pts (63% / 50% / 48% / 55%);
Trio +2.7 pts (47% / 41% / 46%), so Trio does not show it.

### H2 — the sector's own average-weekly score: KILLED

| | Four Sectors Monthly, No Tilt | Trio |
|---|---|---|
| Picks with a score | 191 (247 missing: fewer than 3 members with a full year of prices) | 137 (142 missing) |
| Rank correlation / t | +0.12 / 1.7 | -0.09 / -1.1 |
| Lowest fifth: losers vs overall | 59% vs 50% | 61% vs 58% |

Neither strategy passes. Report only: within the same week it is -0.04 and -0.25; it correlates
+0.81 / +0.74 with the stock's own score (BL-115), so it adds little; winners' and losers' medians
are 7.4 vs 7.5 and 5.7 vs 6.3.

### What the run found about the engine (affects reading these tables)

Picks from sector positions beyond the fresh ones were excluded, as registered, on the belief that a
lingering sector never buys. That belief is wrong under a stock tilt (`broad_reversal_tilt` > 0):
the engine re-ranks every stock of every held sector by the tilt score and buys the top of that list,
so lingering sectors do buy. Excluded picks: Phase 6 281, Rank Sum 174, Five Sectors Monthly 166,
Wide Pool 153, Stock Tilt 145, Half Tilt 130, Make Room 67, Quick Exit 46, Six Sectors Monthly No Tilt
39 (Trio 93, Four Sectors 20). The tilt explains most of them; the few in the untilted groups are not
explained yet. H1 compares fresh positions only, as registered; it does not say how lingering-sector
picks did.

### What it means

Picks from the best-placed sector beat Nifty 500 clearly more often than the rest (58% vs 42-46%,
+7.3% vs +0.4-2.7% average excess), in every one of the nine unseen groups, though not in Trio. Two
caveats: position 1 is by construction the sector with the strongest momentum, so this says where
the edge sits rather than that a change would help; and the nine groups share sectors and stocks.
A Phase 2 (for example more weight on the best-placed sector, tested in the backtest on 2017-2022,
then once on the sealed window) needs its own pre-registration. The sector score adds nothing.

## Risks

- Position 1 is also the sector with the strongest momentum, so H1 may just restate that momentum
  works; a pass says where the edge sits, not that a change helps.
- The nine groups overlap heavily with the two (and with each other), so 7 of 9 is a weaker bar than
  it looks.

## Open questions

Answered by the owner on 2026-10-17: test the sector position and the sector's own average-weekly
score against beating Nifty 500, on 2017-2022.

## Log

- 2026-10-17 — created; Phase 0 pre-registration committed and pushed before any sector score was computed (371911fa).
- 2026-10-17 — Phase 1: H1 passes (+13.4 pts, 9 of 9 groups), H2 killed. Found that a stock tilt lets lingering sectors buy; BL-115's Trio pick-order table corrected.

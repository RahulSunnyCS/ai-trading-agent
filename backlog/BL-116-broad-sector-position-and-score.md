# BL-116 — Does the sector a pick came from tell winners from losers?

| | |
|---|---|
| **Priority** | P1 — BL-115 found the stock's own numbers say little; the sector choice decides most of a Broad portfolio |
| **Status** | In progress — Phase 0 committed |
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

### Phase 2 — Only if a hypothesis passes
Pre-registered as an addendum before it runs (for example more weight on the best-placed sector, or a
sector-score floor), backtested on 2017-2022, then one check on the sealed window.

## Risks

- Position 1 is also the sector with the strongest momentum, so H1 may just restate that momentum
  works; a pass says where the edge sits, not that a change helps.
- The nine groups overlap heavily with the two (and with each other), so 7 of 9 is a weaker bar than
  it looks.

## Open questions

Answered by the owner on 2026-10-17: test the sector position and the sector's own average-weekly
score against beating Nifty 500, on 2017-2022.

## Log

- 2026-10-17 — created; Phase 0 pre-registration committed before any sector score was computed.

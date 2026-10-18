# Broad Momentum: category tags (curated, extended, dated)

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Which category each stock belongs to. The category layer can only pick tagged stocks, so the
tags decide what Broad can hold.

| Setting | Default (where) | Mechanism |
|---|---|---|
| `broad_category_tags` | `curated` (API) | `curated`: the original tag file for the 755-name Total Market. `extended`: also tags stocks outside it (BSE-derived sectors). Both are today's classification applied to every year |
| Forward-dated categories (`curated/stock_groups_dated.csv`, BL-092) | used by `run_broad_backtest` | A category with a `launch_date` scores NaN for weeks before it launched, so it is never ranked, held or picked earlier |
| Shared stock (BL-010 E3) | the worse-placed category's slot stays empty | A stock in two held categories used to take the later category's (worse) rank; 65 symbols sit in two categories |

## Live value

Curated tags. Every category-mode Broad result also carries an extended-tags companion figure,
shown muted under the CAGR ([BL-036](../../../../backlog/BL-036-momentum-ui-from-bl010.md)
Phase 1). New themes go into `pending_themes.csv` (read by no code) until they get a launch date
([BL-092](../../../../backlog/BL-092-forward-dated-themes-bess.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-010](../../../../backlog/BL-010-momentum-evaluation-review.md) F2 | today's 113 subgroups, written on 2026-09-29 from current thematic indices and StockScans themes | Broad, arms A and B | Must fix: hindsight | Tags carry no dates. Median H1: A 25.1% vs B 31.4%; median H2: A 39.9% vs B 25.8% |
| BL-010 F3 | survivorship through tagging (C1) | all-liquid universe | Must fix | Of 176 liquid names that stopped trading before 2026, 0 have curated tags and 77 have curated + wide tags, against 1,503 of 1,524 for names still trading |
| BL-010 Phase 3 step 3 | label-shuffle placebo (100 permutations keeping sizes and multi-membership) | six configs | Category layer kill undecided | Four of six beat the shuffle's 95th percentile; the launch-dated taxonomy was not built ([`bl010_criteria.json`](../../../../packages/momentum-backtesting/search_spaces/bl010_criteria.json)) |
| BL-010 Log, 2026-10-10 | the five highest-CAGR favourites, curated vs extended tags vs today's list | 2017-01-06 to 2026-10-09, pre-tax, point-in-time universe | All clear the owner's 30% line on every variant; tags are the remaining hindsight | CAGR as saved / extended / today's list, worst fall saved to extended: Five Sectors Monthly 45.8 / 35.0 / 39.4 (-27 to -41); Five Sectors, Stock Tilt 45.9 / 37.9 / 35.1 (-37 to -43); Six Sectors Monthly, No Tilt 44.5 / 33.4 / 36.4 (-27 to -34); Four Sectors, Half Tilt 43.4 / 39.4 / 33.5 (-32 to -44); Trio Fortnightly 42.2 / 35.9 / 45.5 (-27 to -36). Tags cost 4-11 points and 7-14 points of drawdown |
| BL-036 Phase 1 | default Broad run, curated vs extended | 2017-01-06 to 2026-10-09, point in time | Descriptive | 33.3% curated; 24.2% extended (-9.1 points), worst fall -24.3% |

## What we know

- The curated taxonomy is built from 2026 themes and has no dates; results on it are upper
  estimates. The extended-tags figure is the closest to an expected return, but still today's
  classification.
- Whether the category layer adds anything beyond a random grouping is undecided: four of six
  configs beat the shuffle, and the launch-dated test was never run.
- Recommended fair check (BL-010 open question 3, still the owner's call): the exchange's own
  industry classification applied to every year. That is
  [BL-074](../../../../backlog/BL-074-point-in-time-categories-nse-basic-industry.md).

## Not yet tested

- A launch-dated taxonomy, or NSE Basic Industry categories applied point in time (BL-074).

## In plain words

A category is a group like "Defence" or "Railways". The groups were written this year, from
themes that are popular now, and applied to every past year. That lets the backtest "know" which
themes would matter. Using a wider, less hand-picked set of tags cuts the best saved strategies
by 4 to 11 points a year. The upper-bound warning on Broad results stays until categories come
from NSE's own classification.

## Related

- [Broad funnel](funnel.md), [universe](../../common/universe.md), [Broad strategy](README.md).

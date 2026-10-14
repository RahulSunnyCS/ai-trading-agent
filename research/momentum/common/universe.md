# Momentum: universe, dates and weekly data

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Which names can be ranked, over which dates, and how daily prices become weekly ones.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `start` | 2017-01-01 (Config, API, Live) | First week of the backtest. History is fetched from 2016-01-01 so 52-week returns exist from January 2017: a full 52-week look-back before the first trade | R |
| `end` | None = latest (Config) | Last week of the backtest. Used to define evaluation windows | R |
| `universe` / `include_optional` | every `core` row, optional off (Config) | Which instruments are ranked. Core is 21 rows in `universe.csv` (4 broad, 13 sector/thematic, gold, silver, Nasdaq 100, Hang Seng). Optional rows have ETF turnover below about 2 crore a day or overlap heavily with a core row | R |
| Weekly close | last trading day of each Mon-Fri week, labelled Friday | Turns daily data into the signal frequency: one decision per week | R |
| `broad_universe` (Broad only) | `total_market` in the request model; `turnover_rank` for a new dashboard run since 2026-10-10 | `total_market`: today's ~755 Nifty Total Market names for every year. `all_liquid`: every NSE equity, narrowed weekly by the tradability gate. `turnover_rank`: the top 750 by turnover as known each January (point in time), gated like `all_liquid` | M, BL-010 Phase 3 |

## Live value

- ETF rotation: the 21 core rows, from 2017-01-01 (`live_config.toml`, `universe.csv`).
- Broad: a new dashboard run uses `turnover_rank` with the liquidity gate forced on (`api.py`
  meta defaults; [BL-036](../../../backlog/BL-036-momentum-ui-from-bl010.md) Phase 1). A saved run
  keeps its own universe.
- Broad search arms ([`round7_*.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)):
  A = Total Market pool, categories on; B = Total Market, categories off; C1 = all-liquid
  (~4,000 names), categories on; C2 = all-liquid, categories off. Fixed tradability gate:
  Rs 2 cr a day turnover, Rs 30 minimum price, floor ratio 0.25, circuit run 3. Round 7 was
  stopped after A 8,003 runs, C1 4,000 and C2 754 (C2 dropped; Phase 3's point-in-time runs
  replace it).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-010](../../../backlog/BL-010-momentum-evaluation-review.md) F1 | today's Total Market list for every year | Broad, 2016-2026 | Must fix: survivorship | 371 of the 755 have no prices before 2016, so the 2017 universe is about 380 names, all survivors into today's index; 78 are renames whose earlier history is invisible |
| BL-010 Phase 3 | the 50 best configs re-run on the point-in-time universe | Broad, 2017-2026, pre-tax | **Arm A's headline killed** by the committed rule ([`bl010_criteria.json`](../../../packages/momentum-backtesting/search_spaces/bl010_criteria.json)) | Median loss 22 to 25 points of CAGR; 45 of 50 lose more than 10. The typical top config still returns 31-34% pre-tax against 17.1% for the momentum index |
| BL-010 Phase 4 | all 8,003 configs re-scored on the point-in-time universe | same | Single-winner selection killed (PBO) | Median 28.1%, best 56.0% (today's list 33.4% / 77.3%; Mom30 TRI 17.0%). PBO 0.69, 0.53 within the 40% drawdown ceiling (today's list 0.48 / 0.20). 82% of configs still beat Mom30 TRI by 5 points pre-tax |
| BL-036 Phase 1 | default Broad run, today's list vs point in time | 2017-01-06 to 2026-10-09, pre-tax, circuit locks and tradability filter on | Point in time made the default | Today's list 41.4%, worst fall -29.3%, Sharpe 1.28; point in time 33.3%, -33.6%, Sharpe 1.09 |

## What we know

- Using today's index list for every past year inflates Broad's CAGR by tens of points for the
  best configs and by about 5 points for the typical one
  ([BL-036](../../../backlog/BL-036-momentum-ui-from-bl010.md) Context).
- All 14 saved favourites were already on `turnover_rank` when checked on 2026-10-10 (BL-010 Log),
  so the stock universe is no longer the hindsight in them; the category tags are
  ([category tags](../strategies/broad/category-tags.md)).
- The ETF universe has no survivorship issue of this kind, but `universe.csv` was chosen today.
  Defence starts in 2018-04 and Capital Markets in 2019-04
  ([BL-088](../../../backlog/BL-088-own-history-sector-relative-strength.md) Context).
- The weekly table (`api.DATA`) starts in 2016, so runs before 2016 lack the cash and
  gold / silver / international columns (BL-042 caveat; BL-050 patched the cash series with the
  stock layer's before 2016).

## Not yet tested

- Optional ETF rows (`include_optional`) under the rolling-window rule.
- Point-in-time category membership from NSE's industry classification
  ([BL-074](../../../backlog/BL-074-point-in-time-categories-nse-basic-industry.md)).

## In plain words

The ETF strategy chooses among about 21 things every Friday: Indian sector indexes, gold, silver,
the Nasdaq and Hang Seng. The stock strategies choose from a much bigger list. If that list is
today's list applied to every past year, the backtest only ever picks companies we already know
survived, which flatters it. "As each year saw it" (`turnover_rank`) fixes that and is now the
default for a new Broad run.

## Related

- [Benchmarks](benchmarks.md), [Broad funnel](../strategies/broad/funnel.md),
  [category tags](../strategies/broad/category-tags.md), [Stock strategy](../strategies/stock/README.md).

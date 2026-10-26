# Momentum research: strategies and parameters

**Last updated:** 2026-10-24

A durable record of every parameter the momentum lab uses: its shipped default and where that
default lives, what it does, why it is set that way, and the evidence. One page per variable
(or per small group of related variables). This folder replaced
`docs/momentum-parameters-reference.md` and `docs/momentum-parameters-plain-english.md` on
2026-10-14; each page keeps the precise wording and, under "In plain words", the everyday version.

Findings here summarise the record; the record is the backlog item (`backlog/BL-NNN-*.md`) and
[`TODO.md`](../../TODO.md). Status words and the page template: [research/README.md](../README.md).

## The four strategies

| Strategy | What it is | Page |
|---|---|---|
| ETF rotation | Weekly rotation across 21 index ETFs, gold, silver, Nasdaq 100 and Hang Seng; the live Friday signal | [strategies/etf-rotation](strategies/etf-rotation/README.md) |
| Broad Momentum | Weekly stock funnel: pool, categories, picks, over a point-in-time universe of about 750 stocks | [strategies/broad](strategies/broad/README.md) |
| Custom Index | Each category becomes a home-made fund of its top stocks; the funds are rotated against each other | [strategies/custom-index](strategies/custom-index/README.md) |
| Stock | Weekly rotation across Nifty 50 stocks from a survivorship-free data layer | [strategies/stock](strategies/stock/README.md) |

All four run on the same engine (`packages/momentum-backtesting/src/momentum_backtesting/engine.py`).

## Every variable page

Status: **Tested**, **Descriptive** or **Not tested** (see [research/README.md](../README.md#status-words)).
Pages tested on one strategy only live in that strategy's folder.

| Page | Applies to | Status | Default | Verdict in one line |
|---|---|---|---|---|
| [Universe, dates, weekly data](common/universe.md) | all | Tested | 2017-01-01 start; 21 core ETFs; Broad `turnover_rank` (new runs) | Today's list for every year inflates Broad by 22-25 points for the best configs; point in time is now the default |
| [Benchmarks](common/benchmarks.md) | all | Descriptive | Nifty 50; Nifty 50 TRI and Nifty200 Momentum 30 TRI lines | ETF +13.2 / +8.7 a year over them, Broad +19.1 / +14.6; ETF mode is not inflated by dividends |
| [Lookbacks, weights, tie-break](common/lookbacks.md) | all | Tested | 1 / 4 / 13 / 26 / 52 weeks, equal weights | Keep equal weights: the 1-week window helps on ETFs |
| [Skip-month](common/skip-month.md) | all | Tested | no skip (ranksum); `voladj` "skip" on | Skipping loses on ETFs; the `voladj` skip does not actually skip, and fixing it loses on Broad |
| [Score](common/score.md) | all | Tested | `ranksum` | `voladj` a tax-efficient ETF candidate only; lookback-following `voladj`, residual momentum and swapping the favourites to rank-sum or Blend killed; grouped tilt wins on ETFs, pending |
| [Top N and exit rank](common/top-n-exit-rank.md) | ETF, Custom Index, Stock | Tested | 5 / 10 (Custom Index 8 / 16) | 10 is the sweet spot; ETF top 3 wins most but concentrates |
| [Portfolio rule and entry](common/portfolio-entry.md) | all | Tested | `buffer`, `wait` | Do not flip to `make_room`: the earlier win was a gapped-engine artefact |
| [Caps, band, price ceiling, minimum trade](common/caps.md) | all | Tested | 35% (Broad 15%, 30% per category), 5-point band, Rs 20,000 ceiling | A risk/return dial, not free money |
| [Gates and defensive filter](common/gates.md) | ETF, Broad | Tested | all off | `exclude_high_vol=0.2` is the one robust ETF win (a disaster on stocks); every weak-market gate lost |
| [Sizing and exposure overlays](common/sizing.md) | ETF, Broad | Tested | all off | Every rule gives up return; vol targeting and the ETF blend are risk dials |
| [Costs](common/costs.md) | all | Descriptive | flat 0.10% per side | Itemised costs take 0.7 (ETF) and 2.3 (Broad) points; the edge survives |
| [Tax and the tax hold](common/tax.md) | all | Tested | off | Tax takes 4.9 points (ETF) and 8-9 (Broad); the tax hold is neutral on ETF and never fires in Broad |
| [Execution: delay, fill, track](common/execution.md) | all | Tested | delay 0, Friday close, ETF track live | Friday close is right for ETFs; a one-week delay wins on Broad, but moves single configs by a median 3.4 pts either way (BL-161); a Monday-open fill is built (BL-036 Phase 2) and was killed against the followed group (BL-158) |
| [Cadence, phase, tranches](common/cadence.md) | all | Tested | weekly | Weekly for ETFs; every 2 or 4 weeks wins on Broad; slower than 4 loses after tax; split across Fridays to remove luck |
| [Reversal sleeve](common/reversal-sleeve.md) | Stock pool, ETF | Tested | not used | A slightly better cash substitute, not alpha |
| [Sector relative strength](strategies/etf-rotation/sector-rs.md) | ETF | Not tested | — | BL-088 idea; waiting on the post's exact rule |
| [Simulate every week](strategies/broad/min-ranked.md) | Broad | Descriptive | on | A correctness fix: the skipped-week curve overstated Broad by about 6 points |
| [Broad funnel](strategies/broad/funnel.md) | Broad | Tested | pool 200 / 250, coverage 0.40, categories 4 / 8, 2 picks | Defaults hold; 3 picks wins most; return is flat from 2 to 24 holdings |
| [Category tags](strategies/broad/category-tags.md) | Broad | Tested | curated | Tags are hindsight: extended tags cost 4-11 points; the category-layer test is undecided |
| [Stop-loss](strategies/broad/stop.md) | Broad | Tested | off | Killed, weekly (0 of 30 cells) and daily |
| [Stock filters](strategies/broad/filters.md) | Broad | Tested | off | No survivor (PBO 0.72) |
| [Chart patterns](strategies/broad/patterns.md) | Broad pool | Tested | off | Killed in BL-042 and BL-043; BL-035 tightness feature not yet tested |
| [Inner and outer rotation](strategies/custom-index/inner-outer-rotation.md) | Custom Index | Descriptive | inner 2 / 8, outer 8 / 16, copies 1 | Outer 8 / 16 beat 5 / 10; the inner settings were never isolated |

## How to read the numbers

**Evidence grades** (kept from the old reference doc): **M** = measured in a logged real-data
backtest (cited to its `TODO.md` row or backlog item); **R** = reasoned from the code, not
isolated by a backtest. No row is graded **D** (dry run pending) any more: the 2026-10-01 dry run
(TODO 3.9.23, `scripts/param_dry_run.py`, `scripts/alpha_experiments.py`,
`scripts/reversal_experiment.py`) measured every one.

**Where a default lives:** `Config` = `engine.py`; `API` = `BacktestRequest` in `api.py`;
`Broad` = `categories/broad.py`; `Live` = `live_config.toml`.

**How the 2026-10-01 numbers read.** Two baselines, one parameter changed at a time: the live
ETF strategy ([ETF rotation](strategies/etf-rotation/README.md)) and Broad Momentum with the
dashboard defaults, every week simulated ([Broad](strategies/broad/README.md)). Cells give
full-window CAGR / Sharpe / MaxDD, then "rolling X / Y / Z%": the share of 28 rolling 3-year
windows (fresh start each, 2017-01 to 2026-09) in which the variant beat its baseline on CAGR /
Sharpe / MaxDD, then the median CAGR change across windows. A lever "wins most" only when it
beats the baseline on both CAGR and Sharpe in more than half the windows. Windows overlap, so a
share is a robustness score, not 28 independent tests, and about 90 variants were tried in total,
so expect one or two chance "wins". The rule "must win in most rolling windows" was written in
`docs/handover-momentum-alpha.md` before the run; it is not a committed criteria file.

**Broad numbers logged before 2026-10-01 (TODO 3.9.13, 3.9.18, 3.9.20) came from an engine that
skipped thin weeks and overstated CAGR by about 6 points and Sharpe by about 0.6**; they are kept
only where marked "gapped engine" ([simulate every week](strategies/broad/min-ranked.md)).

**Later items (BL-084 to BL-086, BL-050)** were pre-registered in committed JSON
(`packages/momentum-backtesting/search_spaces/bl0NN_criteria*.json`) and judged on 11 Broad
strategies after tax at Rs 5 lakh, choosing on FY2018-22 and confirming on FY2023-26. Their JSON
files carry their old numbers (BL-053, BL-054, BL-055): the items were renumbered on 2026-10-10
and the contents left unchanged.

## The 2026-10-01 dry run

Reproduce from `packages/momentum-backtesting`:
`uv run python scripts/param_dry_run.py` (one parameter at a time; writes
`data/backtests/param_dry_run_{etf,broad}.csv` and `_rolling.csv`),
`uv run python scripts/alpha_experiments.py [--plateau]` (new levers),
`uv run python scripts/reversal_experiment.py --rank-on momentum` (reversal sleeve).

What the study supports, in order of strength:

1. Broad Momentum: simulate every week (`broad_every_week`). A correctness fix, not a lever.
2. Broad Momentum: trade every 2 weeks (or 4), or with a one-week signal delay: +4 to +5 CAGR
   points and better Sharpe in 89-100% of windows. All three cut the same thing, a 3.6-week
   average hold and 115 buys a year. Prefer the 2-tranche blend or every 4 weeks: one
   every-2-weeks phase alone ranges from +1.4 to +8.5 points by luck of the Fridays.
3. ETF: `exclude_high_vol=0.2`: +2.1 points, Sharpe 0.99 to 1.12, plateau-robust, sector-concentrated.
4. ETF `top_n=3` and Broad `picks_per_category=3` win most but concentrate or widen the bet.
5. Everything else is a dial (caps, vol targeting) or a loss, and `make_room` should not become
   the default.

The real Friday walked through end to end (2026-09-18) is on the
[ETF rotation page](strategies/etf-rotation/README.md#a-real-friday-2026-09-18).

## In plain words

Who this is for: you, in six months, when you have forgotten why a setting is what it is.

Status markers used in the plain-words sections:
- **Measured** means a real backtest in `TODO.md` section 3.9 showed it, and the section is cited.
- **Reasoned** means it follows from how the code works, but no backtest isolated it.

"Measured" results from 1 October 2026 (TODO 3.9.23) were tested the strict way: the same
change restarted from scratch in 28 overlapping three-year stretches between 2017 and 2026, and
a change only counts as better if it wins most of those stretches, not just the one big
nine-year run. "ETF strategy" means the one the Friday Telegram signal follows; "Broad" means
the Broad Momentum tab with its default settings.

### What has and has not been proven

Proven on real data, in the repo's own logs: more names on Custom Index (top N 8), the exit-rank
buffer, caps as a risk dial, itemised costs still profitable, and (TODO 3.9.23):

- The ETF strategy beats Nifty with dividends by about 13 points a year and the Momentum 30
  index by about 9. Broad beats them by about 19 and 15.
- Broad must count every week (the skipped-week bug).
- Broad does better trading every 2 or 4 weeks, or a week late, than every week.
- The ETF strategy does better if it never buys the jumpiest fifth of ETFs.

Tried and dropped: sizing by recent wins, mass-exit throttle, the cash filter, trend and breadth
filters, 52-week-high and smooth-path filters, skipping the last month, volatility timing of
the whole portfolio (a comfort dial only), waiting for long-term tax, and "make room" as a
default. Since then (BL-042 to BL-086): chart patterns, stock filters, stop-losses, inverse-vol
sizing, residual momentum, slower cadences, an ETF blend and a lookback-following `voladj`, all
killed under committed rules.

Not proven: anything that only won on the single nine-year run. About 90 variations were tried,
so one or two "wins" could be luck; the ones listed above won in nearly every stretch, which
luck rarely does. Broad's high numbers are upper estimates: its categories are today's, and its
frozen strategy made far less on the unseen 2012-2016 years.

## Sources

- Backlog: [BL-010](../../backlog/BL-010-momentum-evaluation-review.md) ·
  [BL-035](../../backlog/BL-035-consolidation-tightness-feature.md) ·
  [BL-036](../../backlog/BL-036-momentum-ui-from-bl010.md) ·
  [BL-042](../../backlog/BL-042-chart-pattern-poc.md) ·
  [BL-043](../../backlog/BL-043-daily-pattern-trading-system.md) ·
  [BL-050](../../backlog/BL-050-momentum-filter-poc.md) ·
  [BL-084](../../backlog/BL-084-momentum-stop-loss.md) ·
  [BL-085](../../backlog/BL-085-momentum-improvement-levers.md) ·
  [BL-086](../../backlog/BL-086-voladj-follows-lookbacks.md) ·
  [BL-087](../../backlog/BL-087-momentum-all-fridays-split.md) ·
  [BL-088](../../backlog/BL-088-own-history-sector-relative-strength.md) ·
  [BL-161](../../backlog/BL-161-favourites-score-and-friday-fill.md)
- Criteria and results: [`packages/momentum-backtesting/search_spaces/`](../../packages/momentum-backtesting/search_spaces/)
- Write-ups: [`evaluation-review.md`](../../packages/momentum-backtesting/docs/evaluation-review.md),
  [`bl085-levers-2026-10-09.md`](../../packages/momentum-backtesting/docs/bl085-levers-2026-10-09.md),
  [`top-strategies-2026-10-08.md`](../../packages/momentum-backtesting/docs/top-strategies-2026-10-08.md)
- The 2026-10-01 study plan: [`docs/handover-momentum-alpha.md`](../../docs/handover-momentum-alpha.md);
  its log: `TODO.md` row 3.9.23.

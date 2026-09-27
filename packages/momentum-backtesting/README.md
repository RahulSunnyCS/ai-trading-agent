# momentum-backtesting

Weekly momentum rotation across Indian sector/broad indices, gold, silver, Nasdaq 100,
Hang Seng and a defensive cash/gilt pair, from 2017.

## Setup

```bash
cd packages/momentum-backtesting
uv sync
uv run mbt login     # once per day - Fyers tokens expire daily
uv run mbt fetch     # ~5 minutes; writes data/weekly_closes.csv and .xlsx
```

`mbt` reads `FYERS_APP_ID`, `FYERS_APP_SECRET` and `FYERS_REDIRECT_URI` from the repo-root
`.env`. The Fyers access token comes from, in order: `FYERS_ACCESS_TOKEN` in `.env`, the
token cached by `mbt login`, or the dashboard's stored token (`broker_tokens`, via
`DATABASE_URL`). `uv run mbt token-status` shows which one will be used.

## Data

- **Universe** — `src/momentum_backtesting/universe.csv`: the index, the ETF you would
  actually trade, and where its price history comes from. `core` rows are ranked,
  `optional` rows are fetched but not yet ranked, `defensive` rows are cash and gilt.
- **Indian indices** use the index itself from Fyers (`NSE:NIFTYPHARMA-INDEX`), since many
  ETFs listed after 2017. Where Fyers' history starts late (Midcap 150 and Smallcap 250 in
  2019, Chemicals in 2025, Defence in 2022, ...), the `backfill` column extends it with NSE's
  official history from niftyindices.com, scaled to join without a jump. The join level ratio is
  printed by `mbt fetch` and was 1.0000 for every index, i.e. the two sources agree exactly.
  Capital Markets and Defence only exist from their NSE base dates (Apr 2019, Apr 2018).
- **Gold** uses GOLDBEES (it tracks its NAV closely). **Nasdaq 100 and Hang Seng** use the
  foreign index x exchange rate from Yahoo, not their ETFs: MON100 and HNGSNGBEES trade at
  premiums to NAV that come and go, which showed up as false crashes (MON100 fell 12.3% on
  13 Nov 2018 when the index fell 3.6%). US indices use the previous US close, since US markets
  close after India; Hong Kong closes before India so uses the same day.
- **Gilt** uses NSE's 8-13 yr G-Sec index (interest included, from May 2017); you'd trade
  LTGILTBEES.
- **Silver** is COMEX silver x USD/INR before SILVERBEES listed (Feb 2022), SILVERBEES
  after. Each Indian day uses the previous US close, because COMEX settles after India
  closes. Against SILVERBEES on 2022-26 it correlates 0.83 weekly, 0.92 monthly.
- **Cash** is UTI Liquid Fund Direct Growth NAV from AMFI, adjusted for its 10:1 unit split
  on 2026-06-20. LIQUIDBEES can't be used as a price series - its price stays at ~1,000.
- **Weekly close** is the last trading day's close of each Mon-Fri week, labelled Friday.
- `data/` is gitignored; delete it and re-run `mbt fetch` to rebuild.

## Signal prices vs trade prices

The ranking always uses the **index** (the columns above). What you actually earn is the
**ETF's** price, at the time you actually trade, and that differs in three ways:

- **Expense ratio and tracking error.** The ETF lags its index by its fees, give or take.
- **Premium or discount to NAV.** Thin sector ETFs, and the international ETFs whenever the
  RBI's overseas-investment limit stops new units, trade above or below NAV. Momentum tends to
  buy when inflows have pushed the premium up and to sell after it has shrunk, so this is a
  steady drag, not noise.
- **Dividends.** Fyers' `-INDEX` series are price-return; ETFs keep dividends in their NAV.

Two switches, on every backtest command (`--track`, `--execution`) and in the UI ("P&L on",
"Fill at"):

| | |
|---|---|
| `--track index` (default) | P&L on the index - the original assumption |
| `--track etf` | P&L on the ETF. Before it listed, the index stands in, scaled to meet the ETF and slowed by `ter_pct` a year; those trades are marked "index proxy" in the UI |
| `--execution fri_close` (default) | fill at the signal's own Friday close |
| `--execution mon_open` | fill at the next trading day's open |
| `--execution mon_10am` | fill at ~10:00 on that day (needs `mbt fetch --intraday`; otherwise falls back to the open, with a warning) |

```bash
uv run mbt amfi-codes        # once: pick each ETF's AMFI scheme (for premium to NAV) -> universe.csv
uv run mbt fetch             # now also fetches the ETFs, their NAVs and premiums
uv run mbt fetch --intraday  # + 10:00 prices from Fyers 15-minute candles (slow, ~10 min)
uv run mbt tracking          # data/backtests/tracking.xlsx
```

`mbt tracking` runs the same strategy six ways (index/ETF x Friday close/Monday open/Monday
10:00). The ranks, and so the trades, are identical in every run; only the fills differ. It
reports:

- per ETF, over the weeks it existed: its tracking difference and tracking error, and its
  premium to NAV (mean, 5th and 95th percentile, max);
- the average premium the strategy paid on buys vs received on sells;
- P&L per instrument, index vs ETF;
- a verdict. **Decision rule:** if the ETF run's CAGR is within 0.5 points a year of the index
  run and the premium lost per round trip is under 0.5%, index P&L was a fair approximation.
  Otherwise use `--track etf`.

New columns in `universe.csv`:

- `etf_source`: `NSE:<ETF>-EQ`, fetched from Fyers with Yahoo `<ETF>.NS` as a fallback, or
  `SAME` when the ranked series already is what you'd hold (gold, silver, the liquid fund).
- `amfi_code`: filled by `mbt amfi-codes`.
- `ter_pct`: the expense ratio from the AMC factsheet. Blank means no drag on the pre-listing
  proxy.

ETF unit splits are detected against the index (a day's move more than about 45% away from the
index's) and undone.

## UI

```bash
uv run mbt ui        # opens http://127.0.0.1:8765 - local only, reads data/weekly_closes.csv
```

Pick which ETFs to rank, the date range, the lookbacks and their weights (e.g. the "recency
tilt" preset 1.5/1.25/1/1/0.8), top N and sell rank, the portfolio rule, crash protection,
costs, signal delay, tax and the benchmark. Results: KPI cards (CAGR, edge, drawdown, Sharpe,
churn, exits, holding time, win rate, largest position), a growth chart with a dot on every
rotation week - hover it to see what was sold (weeks held, return, why), what was bought or
topped up, and what's held after - plus drawdown and trailing 52-week edge, and tabs for this
week's signal, trades (CSV), a holdings timeline, per-ETF attribution, yearly returns and the
benchmark's worst falls. Recent runs are kept and can be overlaid on the chart. The charting
library is downloaded once into `data/vendor/`, after which the UI works offline.

## Portfolio rules

- **buffer** (default) - buy the top N; keep anything bought until its rank is worse than the
  sell rank, so holdings float between N and the sell rank. When something is sold, the money
  is split equally across the current top N (topping up those already held). A new top-N name
  when nothing was sold either **waits** for the next sale (default) or, with **make room**, is
  bought at once as an equal share by trimming every holding by the same percentage.
- **slots** - exactly N positions from equal starting slots; a sale's money buys the best name
  not held; nothing is topped up.

**Position cap (buffer rule, default 35%).** No ETF is bought or topped up past the cap; money
that doesn't fit goes to the other top-N names, or waits in the liquid fund if they're all full.
A holding that grows past cap + band (default 5 points, so 40%) is trimmed back to the cap and
the proceeds go to the top N. The band keeps small drifts from causing a trade - and a tax
bill - every week. Without a cap the buffer rule concentrated heavily into long-running leaders
(one ETF reached 84% of the portfolio in the default backtest); at 35% the largest position
stays at or under 40%, for ~1.3 points less CAGR and a slightly better Sharpe. `--max-position
0` (or 0 in the UI) turns the cap off. Fixed slots ignore it.

Each purchase (including top-ups) is taxed separately, with its own date.

## Backtest

```bash
uv run mbt compare                      # off / ranked / filter side by side -> data/backtests/compare.xlsx
uv run mbt compare --portfolio slots    # the fixed-slots rule (--entry make_room for the buffer variant)
uv run mbt backtest --defensive filter  # one run, full detail -> data/backtests/<label>.xlsx
uv run mbt compare --cost-pct 0.25 --signal-delay 1   # stress: dearer trades, a week late
```

Each Friday close, every eligible index is ranked on each lookback's return, and the ranks are
multiplied by their weights and summed (lowest = strongest). Buying and selling then follow the
portfolio rule above. `--cost-pct` (default 0.10) is charged per side; `--signal-delay 1` trades
a week after the signal instead of at the same close. Money not invested earns the liquid
fund's return.

Defensive modes: `off` always invested; `ranked` cash and the gilt are ranked like any index;
`filter` a slot only holds an index whose `--filter-lookback` (13) week return beats cash.

Workbook sheets: summary, settings, yearly, crashes (strategy vs Nifty 50's three worst falls),
equity, holdings (what each slot held each week), trades (with the rank that triggered each),
ranks, scores. No parameters have been tuned - the defaults are the rules as first specified.

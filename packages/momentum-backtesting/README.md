# momentum-backtesting

Weekly momentum rotation across Indian sector/broad indices, gold, silver, Nasdaq 100,
Hang Seng and a defensive cash/gilt pair, from 2017.

## Setup

```bash
cd packages/momentum-backtesting
uv sync
uv run mbt login     # standalone login if not using the dashboard
uv run mbt fetch     # ~5 minutes; writes data/weekly_closes.csv and .xlsx
```

`mbt` reads `FYERS_APP_ID`, `FYERS_APP_SECRET` and `FYERS_REDIRECT_URI` from the repo-root
`.env`. When `DATABASE_URL` is configured, a valid dashboard token in `broker_tokens`
takes priority for CLI, scheduled and API runs. If it is missing, expired or the database
is unavailable, the resolver falls back to `FYERS_ACCESS_TOKEN`, `FYERS_TOKEN_FILE`, then
the local `mbt login` cache. Without a database, these standalone sources work as before.
`uv run mbt token-status` shows which source will be used.

## On-demand rebalance preview

The shared dashboard's **Momentum Backtesting → Rebalance now** tab and the CLI use
the same read-only calculation. They support Nifty 50 Stocks and Broad Momentum,
collect Fyers LTPs during NSE market hours, and compare the model's live-week target
with your actual holdings in percentages. Fyers login is managed from the shared
dashboard's Broker logins tab. The access token is AES-256 encrypted server-side in
`broker_tokens` until the expiry Fyers reports, and the app secret stays in server
environment configuration, never browser storage. The preview
never submits orders. Keep `mbt stocks fetch` and, for Broad,
`mbt categories fetch-universe` data current before using it.

For a local dashboard preview without Fastify/Postgres, set `MOMENTUM_DIRECT=1`
and `MOMENTUM_DIRECT_API_URL=http://127.0.0.1:3000` when starting Next, then run
`uv run mbt serve --port 3000`. The Fyers app's registered
`FYERS_REDIRECT_URI` must point to the local service on port 3000 (either
`/callback` or `/api/auth/fyers/callback`) for this setup. In direct mode,
the local API stores the access token in `data/.fyers_token.json` with file mode
`0600` until Fyers expiry; the app secret still stays in the server-side `.env`.

For CLI use, save strategy settings (the same JSON shape accepted by `/api/backtest`)
and actual holdings percentages in two files, for example:

```json
{"dataset":"stock","universe":["C0001","C0002","Gold"],"start":"2017-01-01","top_n":2,"exit_rank":4}
```

```json
{"C0001":40,"C0002":30,"Gold":10}
```

The remaining 20% is assumed to be idle cash. Then run:

```bash
uv run mbt rebalance --config strategy.json --holdings holdings.json --portfolio-value 100000
```

`--json` emits the full response. Whole-share counts are indicative, exclude fees,
taxes and order-book liquidity, and the target is based on the strategy's simulated
historical holdings rather than a broker portfolio sync. For Broad Momentum, use
`"dataset":"broad","universe":["broad_momentum"]` and asset identifiers from
the Broad model (including `#N` suffixes where a split segment is active).

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

## Weekly Friday signal (Telegram)

`mbt weekly --run preview|final` refreshes prices and evaluates every favourited strategy from
one shared snapshot. The dashboard shows every result; only the one globally active favourite
is sent to Telegram. Until a favourite exists, the checked-in `live_config.toml` strategy is
the fallback. It runs from a `launchd` job on the owner's own laptop (`scripts/install-
launchd.sh`; see "Scheduling" below) — it used to run from GitHub Actions
(`MOMENTUM_DATABASE_URL`/Neon), retired 2026-09-30. It can also be triggered manually any
time from the dashboard's Momentum tab ("Weekly signal") or the CLI directly:

| Run | When (IST) | Prices | Purpose |
|---|---|---|---|
| `preview` | Fri 14:40 | live: Fyers quotes, or each ETF's Yahoo quote (~15 min delayed) turned into its index level | trade 15:05-15:25, i.e. at (nearly) the Friday close the backtest assumes |
| `final` | Fri 16:45 | official closes | lists anything the close changed versus the preview |

The message lists SELL / TRIM / BUY and TOP UP / HOLD / WAITING. It flags a buy whose ETF
trades above NAV (1%, or 2% for international ETFs; see `live_config.toml`), shows the
biggest rank moves, and ends with a data-health line.

The positions are each saved strategy's model portfolio, not your actual holdings. Every saved
strategy retains its initial start date. `live_config.toml` supplies only the no-favourites
fallback.

Guards:

- A Friday market holiday uses Thursday's official close (or walks back to the latest NSE
  session for consecutive holidays) while keeping the normal Friday week label.
- Stock, Custom Index and Broad favourites run only when the processed bhavcopy-backed stock
  dataset reaches that Friday-labelled week. Otherwise they are shown as blocked in the UI;
  the weekly trigger does not download or partially rebuild bhavcopy data.
- If more than 25% of the ranked series have no close for the day, you get a data-health
  alert and no signal.
- A preview that starts after 15:15 says it's too late to trade today.
- Preview prices are never stored.

**Sources, best first:**

1. Fyers, when a token is available.
2. niftyindices.com, for indices that have a `backfill` name.
3. An estimate from the ETF: the last index close x the ETF's move since.

Every estimate is named in the message.

**Storage** is the shared local database (`packages/trading-data`, `TRADING_DATA_ROOT`) — the
`momentum_prices`/`momentum_signals` tables it already has (see that package's own docs). No
separate setup: the first `mbt weekly` run creates the catalog if it doesn't exist yet.

```bash
uv run mbt weekly --run final --no-db --no-send   # try it locally, printed not sent
uv run mbt sources-check                  # can this machine reach every source?
```

**Scheduling.** `scripts/install-launchd.sh` installs two `launchd` LaunchAgents (Friday
14:40 preview, 16:45 final IST — assumes the Mac's clock is set to IST; see the plists'
own comments) into `~/Library/LaunchAgents` and loads them. `scripts/uninstall-launchd.sh`
removes them. `launchd` only fires while the machine is awake — a missed run (laptop
asleep) has no catch-up; re-run manually via the dashboard's Momentum tab ("Weekly signal")
or `mbt weekly --run <preview|final>` on the CLI. Logs land in
`data/launchd-weekly-<preview|final>.log`.

**Fyers.** The dashboard login is preferred when available; `mbt login` (browser) or
`FYERS_ACCESS_TOKEN` remains a standalone fallback. The job falls
back to public sources (niftyindices.com, Yahoo) if none is available or it's rejected —
see "Sources, best first" above. No CI secrets needed any more; this all runs locally.

**Telegram.** Set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in the environment `mbt weekly`
runs in (e.g. your shell profile, or the plist's own `EnvironmentVariables` if launchd's
inherited environment doesn't already have them) — unset, it prints the message instead of
sending it.

Use a Fyers API app dedicated to this job. On the Fyers dashboard, either keep order placement
locked to a static IP or turn order permission off: GitHub runners have no static IP, so a
leaked token can't place API orders.

Then:

1. Run "Momentum sources check" once.
2. Run "Momentum weekly signal" by hand for `preview` and for `final`.
3. Only then uncomment its `schedule:`.

## Dashboard and API

```bash
uv run mbt serve     # private FastAPI service on 127.0.0.1:8765
```

Open the shared Next.js dashboard (`apps/dashboard`) and select Momentum. The
FastAPI service exposes `/api/meta`, `/api/backtest`, `/api/momentum-scores`,
saved runs, weekly signals, and rebalance preview through Fastify's
`/api/momentum/*` proxy. `MOMENTUM_DIRECT=1` in Next.js development connects
directly to this private service. The retired local HTML/JavaScript UI and its
Plotly download endpoint are no longer served.

## Portfolio rules

- **buffer** (default) - buy the top N; keep anything bought until its rank is worse than the
  sell rank, so holdings float between N and the sell rank. When something is sold, the money
  is split equally across the current top N (topping up those already held). A new top-N name
  when nothing was sold either **waits** for the next sale (default) or, with **make room**, is
  bought at once as an equal share by trimming every holding by the same percentage.
- **slots** - exactly N positions from equal starting slots; a sale's money buys the best name
  not held; nothing is topped up.

**Broad Momentum concentration controls.** Broad holds up to 16 stocks, so the ETF-tuned 35% cap
rarely binds; its UI defaults are 15% per stock and 30% per category (everything held through one
category, `Config.max_group`, category mode ON only). It also has a buy-price ceiling (default
Rs 20,000, 0 = off) so a small budget is never asked to buy one very expensive share (MRF): a stock
priced above it that week cannot be newly bought and the next-best stock takes the slot. It only
gates entry - a stock already held is kept, and topped up, even after it rises past the ceiling.
The result's "Trade split" tab is the per-stock timeline (green bar = a holding that made money, red
= one that lost), followed by the latest holdings scaled to a capital you type, in whole shares for
Broad. `mbt categories broad-sweep-caps` sweeps the caps and trim band across several windows.

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

## Stocks data (Nifty 50, survivorship-free)

`src/momentum_backtesting/stocks/` builds a from-scratch, corporate-action-adjusted daily and
weekly price/total-return history for every company that has ever been a Nifty 50 member,
including the ones that delisted, merged or renamed - so a future stock-level strategy can be
backtested without survivorship bias. It is a **data layer only**: nothing in the ranking
engine (`engine.py`) or the CLI's `backtest`/`compare`/`weekly` commands reads it yet. That
wiring, and the `--score`/`--rebalance` engine changes it would need, are deferred - see
`docs/roadmap.md` for the case for and against.

### Commands

```bash
uv run mbt stocks fetch                          # full run: download + rebuild everything
uv run mbt stocks fetch --skip-download           # no network - rebuild from the raw cache only
uv run mbt stocks fetch --from 2015-01-01         # shorter CA-history / bhavcopy window
uv run mbt stocks fetch --accept-ca-diff reviewed.csv  # accept a reviewed >30-day-old CA diff
uv run mbt stocks pin-manifest                    # commit the current raw cache as the baseline
uv run mbt stocks validate                        # re-run just the dividend verifier
```

`fetch` (unless `--skip-download`) refreshes the benchmark raw files, downloads any missing
bhavcopy sessions, fetches a fresh corporate-actions snapshot, rebuilds `daily.parquet`, then
always runs the full guard pipeline and the dividend verifier from the raw cache - so
`--skip-download` and a full fetch produce the same outputs given the same raw cache. It exits
non-zero if any guard fails (a 🔴 in the table below), and prints a summary: session/company
counts, events by kind and source, guard F/G counts, dividend-verifier flags, and every file
written.

### Data sources

| Source | What | Politeness |
|---|---|---|
| NSE bhavcopy (`nsearchives.nseindia.com`) | Daily EQ/BE/BZ OHLC per symbol, 2011-. Old CM format until 2024-07-05, UDiFF format from 2024-07-08 | Cookie warm-up, ≥0.35s throttle, bounded retries |
| NSE corporate actions API (`nseindia.com/api/corporates-corporateActions`) | Whole-market bonus/split/dividend/rights/demerger/... feed, fetched by calendar quarter | Same client, same throttle |
| niftyindices.com (`getTotalReturnIndexString` / `getHistoricaldatatabletoString`) | Nifty 50 TRI, Nifty200 Momentum 30 TRI, Nifty50 Equal Weight TRI and price index | ≤1 year per request (the site's own limit) |
| AMFI (`mfapi.in`) | UTI Liquid Fund NAV (Direct + Regular plan), spliced for the cash backfill to 2011 | via `fetch.backfill` |

Raw responses are cached under `data/stocks/raw/` (gitignored, ~3,900 bhavcopy zips +
corporate-action snapshots + benchmark JSON); every run reproduces its outputs from that cache,
so a re-run with `--skip-download` never touches the network.

### Outputs (`data/stocks/`)

- `daily.parquet` - every EQ/BE/BZ symbol's OHLC, 2011-
- `events.parquet` - every resolved corporate-action event, attached to a session
- `nifty50_weekly_tr.csv` / `nifty50_weekly_price.csv` - week x company, total-return and
  price-only factor series
- `nifty50_membership_weekly.csv`, `last_trade.csv`, `benchmarks_weekly.csv`
- `cash_weekly.csv`, `raw_manifest.csv`, `fetch_report.csv`, `dividend_check.csv`

### Guard / warning model

Every run's `fetch_report.csv` carries a severity per finding:

- 🔴 **F (fail)** - the run exits non-zero. Session-calendar gaps, broken price continuity, an
  unresolved corporate-action row for an ever-member, an unparsed/manual-only subject with no
  `actions_manual.csv` row, membership-count invariants, an unexplained >20% move with no cited
  allowlist entry, and a corporate-action event diff older than 30 days (unless
  `--accept-ca-diff`) are all F.
- 🟡 **G (flag)** - logged in `fetch_report.csv` but doesn't fail the run: a synthetic-close
  fill for a single missing session, a suspension (>3 sessions with no trade), a dividend yield
  outside 0-15%, an `unverifiable` factor-vs-move check, and a re-key-only corporate-action diff
  (symbol/ISIN changed, value didn't).
- The dividend verifier (`validate.dividend_check`, `dividend_check.csv`) and the Yahoo
  `adjclose` cross-check are always review-only flags, never run-failing.

`mbt stocks pin-manifest` is how a reviewed state becomes the new baseline: it copies the raw
cache's content-hash manifest into `curated/raw_manifest.pinned.csv` and advances
`curated/events_baseline.csv.gz` to the current events, so the next run (and CI) compares
against what was just reviewed rather than re-flagging it.

### Curated files (`src/momentum_backtesting/stocks/curated/`, committed to git)

These are the hand-curated, cited facts the pipeline can't derive from NSE's feeds alone:
company identity (`companies.csv`, `aliases.csv`), Nifty 50 membership history
(`nifty50_membership.csv`), corporate actions the automatic parser can't handle
(`actions_manual.csv` - rights, demergers, schemes, bonus debentures/preference shares, a
handful of amount-less dividends), and cited exceptions to the guards
(`crash_allowlist.csv`, `continuity_exceptions.csv`, `no_ca_rows.csv`, `yahoo_exceptions.csv`).
`raw_manifest.pinned.csv` and `events_baseline.csv.gz` are the reproducibility baseline (see
above) rather than hand-curated facts. Maintaining them means: adding a row (with a source URL)
when a guard flags something genuinely new, then running `mbt stocks fetch` again to confirm it
resolves the flag, and `mbt stocks pin-manifest` once the new state is reviewed.

### Known limitations

- Membership effective dates come from one source per change (a second source is optional);
  a date with no press release is snapped to the scheduled review's effective date, so it may
  be off by a few days. Four membership rows are single-source and unverified.
- Symbol renames are derived automatically (same ISIN + the new symbol's PREVCLOSE matching the
  old symbol's last CLOSE), not researched by hand.
- A delisted or merged company that never reappears under a new symbol exits the series at its
  last traded close - a merger's swap value is not modelled, so the true swap-ratio value isn't
  captured.
- Demergers, rights issues and schemes of arrangement use a **neutral ex-day rule**: that day's
  return is set to zero instead of a researched factor, costing roughly one ordinary day's market
  move (~1-2%) per event, a handful of times across 15 years.
- Three `actions_manual.csv` dividend rows use a `dividend_basis` of `pre_bonus` by assumption
  (the formula's native basis), not independently verified against the original filing.
- The Tata Motors DVR (a separate, thinly-traded share class) is not modelled - only the
  ordinary shares are.
- The dividend verifier routinely flags large/special dividends: NSE divisor-adjusts the index
  for those, so a day where our reconstructed spread diverges from the index's is often expected
  and reviewed, not a bug.
- The Yahoo `adjclose` cross-check is flag-only and not independent of survivorship (Yahoo has no
  delisted tickers), and is best-effort - a blocked or rate-limited Yahoo request is skipped, not
  retried.

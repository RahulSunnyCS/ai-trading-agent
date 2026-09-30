# US market data for `mbt` — plan

Status: **parked, not started** (written 2026-09-30). Tracked in `TODO.md` §3.8.
This is a plan, not a commitment — nothing here starts until someone picks it up.

Goal: run the same weekly momentum research (`packages/momentum-backtesting`)
on the US market. First on a hand-picked set of ETFs, then on individual stocks
(the S&P 500 — roughly "the top 500"), with the same care the Nifty 50 stock
layer (`stocks/`) got: no survivorship bias, prices adjusted for corporate
actions, and a check that proves the index membership is right.

---

## 1. Is there a "US bhavcopy"?

**No — not a free, official one.** NSE publishes a free file every day with
the closing price of every listed security. That file is the bhavcopy, and
`stocks/bhavcopy.py` downloads it. US exchanges (NYSE, Nasdaq) sell their
end-of-day data instead of giving it away, so every US source is a reseller.
The real choice is which reseller, and whether it keeps **delisted** tickers.

Several vendors come close to the bhavcopy's shape: **one file or call per
trading day, containing every ticker**.

| Source | Cost (check before buying) | Delisted tickers? | Bhavcopy-like bulk? | Fit |
|---|---|---|---|---|
| **Yahoo Finance** (already in `sources.py`) | Free, unofficial | **No** — dead tickers disappear | No, per symbol | ETFs only. Useless for stocks: survivorship bias |
| **Stooq** | Free | Mostly no | Yes — bulk daily ZIP of all US listings | Second source to cross-check ETFs |
| **Tiingo** | Free tier; paid ~US$10–30/mo | Yes (`supported_tickers.csv` has start/end dates) | No, per symbol | Good for ETFs, workable for stocks |
| **EODHD** | ~US$20–60/mo | Yes | **Yes** — bulk EOD API, a whole exchange for one date | Closest thing to a bhavcopy |
| **Polygon.io** | Free tier (short history); paid for more | Yes | **Yes** — "grouped daily" call and daily flat files on S3 | Also bhavcopy-like; free history is too short |
| **Nasdaq Data Link — Sharadar** (SEP + SFP + SP500 tables) | Paid, personal licence ~a few hundred US$/yr | **Yes, from 1998** | Bulk table export | **Best for the stock stage** — ships S&P 500 membership history too |
| **Norgate Data** | Paid, ~a few hundred US$/yr | Yes | Local database | Excellent, but the Python API needs its Windows app |
| **CRSP (via WRDS)** | University access only | Yes | — | The academic gold standard; out of reach |

Indian brokers that offer US investing (Vested, INDmoney) and Fyers have no US
market-data API that is useful here.

### Recommendation

- **Stage 1 (ETFs):** Yahoo as the main source, since `yahoo_candles()` already
  exists, with **Stooq or Tiingo-free as the cross-check** (the Nifty layer's
  "two sources must agree" rule). Cost: zero. Survivorship bias doesn't matter
  for a fixed ETF list that we pick ourselves. Selection bias still does: see §5.
- **Stage 2 (stocks):** **Sharadar** (price table + S&P 500 membership table,
  one vendor, one licence), with **EODHD as the cheaper fallback** (bulk
  per-day download plus delisted tickers, but we'd assemble membership
  ourselves). Don't build the stock stage on Yahoo. The Nifty layer exists
  because survivorship-biased stock backtests are wrong, and that applies here
  too.

Buy nothing until Stage 1 is done and the ETF results justify Stage 2.

---

## 2. What's different from India (the traps)

| Topic | India (today) | US | Consequence |
|---|---|---|---|
| Company identity | ISIN + curated `companies.csv` | **Tickers get reused** (a dead company's ticker goes to a new one), and a ticker can change without the company changing | Identity = **SEC CIK** (or FIGI via OpenFIGI), never the ticker. `trading-data`'s `instrument_aliases.valid_from/valid_to` already models this |
| Index membership | Curated `nifty50_membership.csv`, checked against the NIFTY50 Equal Weight index | S&P membership data is licensed by S&P | Take it from Sharadar/Norgate. Free fallback: Wikipedia's S&P 500 "changes" table + the `fja05680/sp500` GitHub reconstruction. Same check as India: rebuild the **S&P 500 Equal Weight** index (tradeable as RSP) from member prices and compare |
| Corporate actions | NSE feed + manual file, parsed by us | Vendors supply split/dividend-adjusted prices | Store raw + adjustment factors anyway (as `adjust.py` does), so a vendor's adjustment can be audited |
| Calendar | `ref_holidays` (NSE) | NYSE holidays, early closes | Use `exchange_calendars` (`XNYS`); don't hand-maintain a holiday list |
| Timezone | Friday 15:30 IST close | Friday 16:00 ET = **Saturday ~01:30/02:30 IST** (depends on US daylight saving) | The weekly Telegram signal runs Saturday morning IST. The "Friday 14:40 live preview" has no US equivalent |
| Currency | INR | USD | Backtest in USD **and** in INR (USDINR from FRED `DEXINUS` or the RBI reference rate). `index_in_inr()` in `sources.py` already does this for Nasdaq 100 |
| Tax for an Indian resident | `tax.py`: equity / debt classes | Foreign shares: different holding period for long-term, taxed at slab rate when short-term, 25% US withholding on dividends (treaty), LRS limit and TCS on remittance | New `foreign` tax class in `tax.py`. Check the rules at implementation time: Indian tax on foreign assets changed in Budget 2024 and may change again |
| Execution | NSE ETFs via Indian broker | US ETFs via a US-access broker; costs are FX spread + brokerage, not STT | Separate cost model; `cost_pct` default differs |

---

## 3. Where it lives in the repo

- **Fetching & storage:** the new `packages/trading-data` lake is already
  market-neutral. `instruments.exchange` is free text, `asset_class` has
  `etf`/`stock`, and `instrument_aliases` is vendor-keyed and dated. US rows
  use keys like `US:ETF:SPY`, `US:STK:<CIK or FIGI>`, plus a daily-bar path
  next to `bars_1m` (e.g. `lake/bars_1d/asset=stock/symbol=…`). No schema
  change is expected beyond possibly a `currency` column on `instruments`.
- **Research:** `packages/momentum-backtesting` gets a **market** dimension
  (`IN` | `US`). It picks the universe file, the calendar, the currency, the
  tax rules and the benchmark. The engine (`engine.py`) shouldn't need to know.
- **UI:** a market toggle in `mbt ui`, not a second app.

---

## 4. Phases

Each phase ends with something that runs and has been checked. Each one can
stop there if the results say so.

### U0 — Decide (½ day, repo owner)
- Confirm the ETF list size and the benchmark (SPY total return, or 60/40?).
- Confirm the result is shown in INR, USD, or both.
- Don't pick the Stage 2 vendor yet.

### U1 — Market abstraction in `mbt` (no US data yet)
- Add a `Market` config: calendar, currency, timezone, tax rules, benchmark,
  universe file. `IN` must reproduce today's numbers exactly (regression test:
  the current ETF backtest's CAGR/drawdown unchanged to the paisa).
- Add `exchange_calendars` for `XNYS`.
- `tax.py`: add the `foreign` tax class, with unit tests of the holding-period
  boundary.

### U2 — US ETF universe (Stage 1)
- `universe_us.csv`, shaped like `universe.csv`. A starting set:
  - Broad: SPY (or VOO), QQQ, IWM, MDY
  - Sectors: XLK, XLF, XLV, XLE, XLI, XLY, XLP, XLU, XLB (all since 1998);
    XLRE (2015) and XLC (2018) with history before listing proxied, as the
    Indian ETFs already are via `--track etf`
  - Factor/other: MTUM, USMV, QUAL (optional)
  - Defensive: GLD, SLV, TLT, IEF, SHY/BIL as cash
- `mbt fetch --market us`: Yahoo main, Stooq/Tiingo cross-check. Flag any day
  where the two sources' daily returns differ by >5 bp.
- Weekly closes → the existing engine → the report, in USD and INR.

### U3 — Validate Stage 1
- Our SPY total-return series vs the published S&P 500 TR index.
- Look-ahead check: signal on Friday close, fill on Monday open, same as
  India's `--execution` modes.
- Walk-forward: pick parameters on 2017–21, judge them on 2022–26 (the rule
  `TODO.md` §3.8 already uses).
- **Gate:** only go to Stage 2 if the ETF rotation shows an edge over SPY
  after costs and tax that is worth chasing.

### U4 — Survivorship-free S&P 500 stock layer (Stage 2)
Same shape as `stocks/`, at 10× the scale (~1,000 ever-members since 2016
instead of 95):
- Buy the vendor licence (Sharadar recommended, EODHD fallback). The **repo
  owner** does this; Claude never enters payment details.
- Identity: `companies_us.csv` keyed by CIK, with ticker history dated.
- Membership: vendor's S&P 500 table; checked by rebuilding S&P 500 EW and
  comparing with the published index (reuse `membership_check.py`'s method,
  but quarterly rebalance is the 3rd Friday of Mar/Jun/Sep/Dec).
- Prices: raw + split/dividend factors stored separately; total-return series
  built by us from them and checked against the vendor's adjusted close.
- Guards: port `guards.py` (price jumps with no corporate action, gaps,
  zero-volume runs) with a US allow-list.
- Wire into the ranking engine and the UI stock tab with `market=us`.

### U5 — Weekly signal for US
- `mbt weekly --market us` → Telegram via the existing notify path, Saturday
  ~08:00 IST. History in the same Neon tables with a `market` column.
- Schedule stays disabled until one manual dispatch passes (same rule as India).

### U6 — Later, only if U4 is worth it
- Sector/category layer (the `categories/` idea) on GICS sectors.
- Russell 1000 / Nasdaq 100 universes (need more membership data).

---

## 5. Risks and how each is handled

- **Selection bias in the ETF list.** Picking ETFs that exist and look good
  today flatters the past. Mitigation: pick the list by rule (every Select
  Sector SPDR + fixed broad/defensive set), write the rule down in the CSV
  header, and don't tune it after seeing results.
- **Vendor lock-in.** Everything goes through the `trading-data` lake with
  vendor aliases, so swapping Sharadar for EODHD is a fetcher change, not a
  research change.
- **Licence terms.** Paid data is usually personal-use only. It can't be
  redistributed through the SaaS product (`business.md`) without a
  commercial licence. Keep US data out of anything that paying users see
  until that's checked.
- **Yahoo breaking.** The endpoint is unofficial and has broken before.
  Stage 1's cross-check source also works as the fallback.
- **FX.** Weekly USDINR moves can be larger than weekly rank differences
  between two ETFs. Rank in USD (the market's own currency) and only
  *report* in INR, unless a test shows otherwise.
- **This is research, not advice.** Same as the rest of the repo: it measures
  strategies and doesn't place trades.

# Momentum evaluation review — evidence log

The plan, findings (F1–F16, E1–E9), phases and pass/kill thresholds live in
[`backlog/BL-010-momentum-evaluation-review.md`](../../../backlog/BL-010-momentum-evaluation-review.md)
and `search_spaces/bl010_criteria.json`. This file only records **what has been measured**, phase
by phase, and what has not yet been re-verified.

## What is and is not re-verified (2026-10-05)

| Claim | State |
|---|---|
| Engine bugs E1–E7 | Each reproduced by a test that fails on the old code and passes on the fix |
| E8 (trade log could not be audited) | Fixed; a test rebuilds the final portfolio from the trade log alone |
| Stored round 7 arm A results | The unfixed code reproduces all six configs below to 5 decimals |
| F11 (live Rebalance ranking rebuilt its pool with the legacy series rule) | Fixed in Phase 1b; `verified` is now the default rule everywhere |
| E9 (API / CLI / search defaults differ) | Series rule and the CLI's skipped weeks fixed. Still different: Broad's API default signal delay is 0 and circuit locks are off, the search uses 1 and on |
| Findings F1–F10, F12–F16 and their numbers | Taken from the 2026-10-04 review session; **not** independently re-verified, and the queries that produced them are not captured here yet |

## Phase 1a — what each engine fix does to round 7 arm A

Six configs from `data/search/round7_A` (8,003 runs): the three tier winners under round 7's own
criteria and the three runs nearest the median CAGR. Each fix was applied **alone** to the
pre-fix code, then all together. Pre-tax, itemised costs, ₹2 lakh, circuit locks on, one-week
signal delay — round 7's settings, unchanged.

**CAGR, %**

| Config | Before | E1 gate | E2 UC top-up | E3 two categories | E4 `SYM#2` | E5 parked cash | E6 mass exit | All fixes |
|---|---|---|---|---|---|---|---|---|
| Aggressive winner `884b2f79a917` | 63.42 | 53.32 | 63.42 | 63.42 | 55.08 | 63.98 | 63.42 | **52.17** |
| Midway winner `e53e99105fd9` | 61.29 | 61.04 | 61.29 | 61.29 | 54.29 | 61.50 | 61.29 | **52.86** |
| Conservative winner `58e63db1cf9d` | 55.58 | 54.29 | 55.58 | 55.58 | 49.01 | 55.63 | 55.58 | **45.99** |
| Median `153ce705139a` | 32.06 | 31.86 | 32.06 | 32.06 | 34.36 | 32.06 | 32.06 | **34.88** |
| Median `b5c261648aa5` | 32.06 | 29.81 | 32.06 | 32.06 | 32.78 | 32.17 | 32.06 | **32.53** |
| Median `f49871588e07` | 32.06 | 31.43 | 32.06 | 32.15 | 32.55 | 32.06 | 32.06 | **32.40** |

**Max drawdown, %** (before → all fixes): aggressive −47.72 → −44.86; midway −30.40 → −29.10;
conservative −29.69 → −33.03; medians −28.50 → −25.88, −47.07 → −45.39, −39.99 → −38.96.

**Turnover, × per year** (E7 changes the definition, not the trades):

| Config | Old (first-time buys only) | New (everything sold), same trades | New, all fixes |
|---|---|---|---|
| Aggressive winner | 6.03 | 6.40 | 6.63 |
| Midway winner | 2.66 | 3.90 | 4.32 |
| Conservative winner | 1.37 | 2.85 | 3.01 |
| Medians | 2.74 / 11.54 / 1.49 | 5.33 / 14.12 / 2.89 | 5.15 / 14.35 / 2.96 |

### Reading it

- **The three winners lose 8–11 points of CAGR; the three median configs gain 0.3–2.8.** Two
  fixes do almost all of it: E1 (a stock failing the liquidity gate now leaves that week, not a
  week later) and E4 (stocks whose price series restarted after a demerger are pickable again in
  category mode — 34 such columns across 31 symbols; never two live at once; 30 of the midway
  winner's 654 trades).
- Six configs cannot separate "the fix removed a real advantage" from "the top result out of
  8,003 falls when anything is perturbed". The median configs moving slightly **up** while
  every winner moves **down** is what finding F4/F5 (winner's curse) predicts. Phase 4's
  re-scored search is what settles it.
- **The conservative winner no longer fits its own tier**: drawdown −33.0% against round 7's −30%
  cap, and turnover 3.0× against its 2.5× cap once turnover counts what was actually sold.
- E2 and E6 changed nothing here: none of the six ever topped up a holding locked at the upper
  circuit, and none uses the mass-exit throttle. E3 moved one median config by 0.09 points.
- E5 is a small gain (0.0–0.6 points), as expected for a cost that was overcharged.

Reproduce: `impact.py` + `picks.json` (kept with the PR description), run once per source tree
with `PYTHONPATH` pointing at that tree and `MOMENTUM_DATA_DIR` at the data directory.

## Phase 1b — live preview against the backtest (2026-10-05)

- The Rebalance preview runs the same `_run_broad` function as the backtest on the stored
  ranking plus one flat week, so its target for week t is what the backtest holds after trading
  at t. For a strategy with `signal_delay = 1` that means the target comes from the ranking at
  t−1 — exactly what was backtested, and one week older than the freshest ranking. Whether live
  trading should act on the fresher ranking is an operating decision, not a bug; it is open.
- The Friday Telegram signal (`mbt weekly`) runs the ETF strategy in `live_config.toml`. No
  Broad Momentum config feeds it.
- Not yet done: replaying the preview week by week over the last 12 weeks against the backtest
  (needs data truncated at each week — the Phase 2 harness).

## Phase 2 — proving the arithmetic (2026-10-05)

Code: `src/momentum_backtesting/audit/`. `bundle.py` writes a run's orders and what the backtest
claims came of them. `replay.py` rebuilds prices, share counts, costs, tax and the weekly equity
curve from the orders and the lake's raw daily bars; it imports nothing from the package, and a
test enforces that. Thresholds: `search_spaces/bl010_criteria.json` and
`bl010_criteria_addendum_1.json`. Run on commit `34786e3`; stock data to 2026-10-01 (catalog
modified 2026-10-05 19:28).

Six configs (`search_spaces/bl010_phase2_picks.json`: round 7 arm A's three tier winners and
three nearest the median), each run four ways:

| Config | As searched (₹2 lakh, pre-tax, delay 1) | ₹5 lakh pre-tax | ₹5 lakh after tax | Delay 0, pre-tax |
|---|---|---|---|---|
| Aggressive winner | 52.17% / −44.9% | 52.23% / −44.9% | 40.16% / −45.4% | 47.97% / −65.0% |
| Midway winner | 52.86% / −29.1% | 52.91% / −29.1% | 42.32% / −31.4% | 57.08% / −41.0% |
| Conservative winner | 45.99% / −33.0% | 46.04% / −33.0% | 37.15% / −36.9% | 51.24% / −33.1% |
| Median 1 | 34.87% / −25.9% | 35.02% / −25.8% | 28.11% / −26.6% | 36.65% / −30.8% |
| Median 2 | 32.53% / −45.4% | 32.81% / −45.0% | 24.77% / −45.0% | 28.30% / −40.0% |
| Median 3 | 32.40% / −39.0% | 32.64% / −38.6% | 26.34% / −38.9% | 32.23% / −35.4% |

CAGR / max drawdown. The first column equals Phase 1a's "All fixes" column. Tax costs 6 to 12
points. Changing the signal delay moves single configs by −4 to +5 points in both directions.

### Step 1 — independent replay: pass (24 of 24)

Every fill price equals the exchange's adjusted close to float precision, as do share counts,
costs, tax per sale, the weekly price of everything held, the equity curve, CAGR and max
drawdown. Cash balances to zero after every buying week. The one visible gap: a taxed run's
last week differs by up to 0.006% because the engine charges the ₹16 depository fee once per
lot when it sells everything at the end, not once per stock (under 0.001 point of CAGR).

What the replay does not prove: that the orders are the ones the rules call for (step 4), or
that the lake's prices are right (step 2). Order sizes and the dates of split price series are
taken from the backtest; the four index-level instruments and the liquid fund are priced from
their stored weekly series.

Data notes the replay raised:

- **A sale while the stock was not trading.** FORCEMOT did not trade on NSE from 2023-10-26 to
  2024-02-13 (Yahoo shows zero volume too). Four of the six runs sold it in that gap at the
  last close before it, up to 23.6% of the portfolio. An NSE account could not have sold; it
  reopened 32% higher.
- **Buying a retired price series.** After VEDL's price series was split at its April 2026
  demerger, one run kept adding to the old series at its frozen price for 11 weeks.
- **Silver before February 2022** is a synthetic series (no silver ETF existed), stored 3.7%
  apart in the daily and weekly tables. Returns are unaffected.
- The final week's prices are the broker top-up closes, not the exchange's file.

### Step 2 — ten holdings against Yahoo Finance: 9 of 10 pass (fails as pre-registered)

Chosen by rule before any outside price was fetched (`outside.pick_sample`, seed 20261005). No
sale was blocked by a lower circuit in any of the six runs, so the nearest case stands in.

| # | Run | Stock | Bought | Lake close | Outside close | Sold | Lake close | Outside close | Share changes (lake / outside) | Return (lake / outside) | Result | Why chosen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | midway | [CUPID](https://finance.yahoo.com/quote/CUPID.NS/history/) | 2025-10-03 | 214.73 | 214.73 | 2026-10-01 (still held) | 312.50 | 312.50 | x5 on 2026-03-09 / x5 on 2026-03-09 | +627.66% / +627.66% | pass | one of the five largest contributors of the midway run |
| 2 | midway | [GRAVITA](https://finance.yahoo.com/quote/GRAVITA.NS/history/) | 2023-04-21 | 511.60 | 511.60 | 2024-01-12 | 1,017.00 | 1,017.00 | none / none | +98.79% / +98.79% | pass | one of the five largest contributors of the midway run |
| 3 | midway | [PGEL](https://finance.yahoo.com/quote/PGEL.NS/history/) | 2024-08-23 | 558.15 | 558.15 | 2025-04-04 | 871.65 | 871.65 | none / none | +56.17% / +56.17% | pass | one of the five largest contributors of the midway run |
| 4 | midway | [DIXON](https://finance.yahoo.com/quote/DIXON.NS/history/) | 2024-05-17 | 8,938.40 | 8,938.40 | 2024-07-12 | 12,410.00 | 12,410.00 | none / none | +38.84% / +38.84% | pass | one of the five largest contributors of the midway run |
| 5 | midway | [TRENT](https://finance.yahoo.com/quote/TRENT.NS/history/) | 2024-04-19 | 4,158.95 | 4,158.95 | 2024-11-14 | 6,463.00 | 6,463.00 | none / none | +55.40% / +55.40% | pass | one of the five largest contributors of the midway run |
| 6 | aggressive | [JUBLFOOD](https://finance.yahoo.com/quote/JUBLFOOD.NS/history/) | 2018-03-23 | 2,277.05 | 2,277.05 | 2018-08-10 | 1,521.40 | 1,521.40 | x2 on 2018-06-21 / x2 on 2018-06-21 | +33.63% / +33.63% | pass | spans a filed action the lake adjusted for (Bonus 1:1, ex-date 2018-06-21) |
| 7 | midway | [PFC](https://finance.yahoo.com/quote/PFC.NS/history/) | 2023-08-25 | 270.05 | 270.05 | 2023-10-06 | 246.30 | 246.30 | none / x1.25 on 2023-09-21 | -8.79% / +14.01% | **fail** | spans a filed action the lake missed (Bonus 1:4, ex-date 2023-09-21) |
| 8 | conservative | [RVNL](https://finance.yahoo.com/quote/RVNL.NS/history/) | 2022-11-25 | 73.30 | 73.30 | 2023-01-06 | 72.45 | 72.45 | none / none | -1.16% / -1.16% | pass | held through a lower-circuit lock (no sale was blocked in any of the six runs) |
| 9 | median2 | [CRISIL](https://finance.yahoo.com/quote/CRISIL.NS/history/) | 2020-11-06 | 1,996.80 | 1,996.80 | 2020-11-20 | 2,000.65 | 2,000.65 | none / none | +0.19% / +0.19% | pass | drawn at random |
| 10 | median3 | [SOUTHBANK](https://finance.yahoo.com/quote/SOUTHBANK.NS/history/) | 2026-01-23 | 45.00 | 45.00 | 2026-04-17 | 38.93 | 38.93 | none / none | -13.49% / -13.49% | pass | drawn at random |

| Day | Stock | Move in the lake | Move outside | Result |
|---|---|---|---|---|
| 2018-02-02 | [PCJEWELLER](https://finance.yahoo.com/quote/PCJEWELLER.NS/history/) | -24.79% | -24.79% | pass |
| 2020-03-23 | [TRENT](https://finance.yahoo.com/quote/TRENT.NS/history/) | -20.00% | -20.00% | pass |
| 2020-03-25 | [MANAPPURAM](https://finance.yahoo.com/quote/MANAPPURAM.NS/history/) | +20.88% | +20.88% | pass |
| 2023-05-11 | [NEULANDLAB](https://finance.yahoo.com/quote/NEULANDLAB.NS/history/) | +20.00% | +20.00% | pass |
| 2024-01-11 | [POLYCAB](https://finance.yahoo.com/quote/POLYCAB.NS/history/) | -21.04% | -21.04% | pass |
| 2024-06-04 | [RECLTD](https://finance.yahoo.com/quote/RECLTD.NS/history/) | -25.19% | -25.19% | pass |
| 2022-12-23 | [RVNL](https://finance.yahoo.com/quote/RVNL.NS/history/) | -4.97% | -4.97% | pass |

PFC fails: the lake missed its 1:4 bonus, so the backtest booked a 20% fall that did not
happen. TRENT passes on raw closes; Yahoo itself has not applied TRENT's June 2026 bonus to its
2024 prices. CUPID's 7.3-fold rise in a year is real.

### Step 3 — days that could be data artefacts

The plan's test ("where the exchange's previous close equals the prior close") cannot work:
the file's previous close is the literal prior close on all but 84 rows since 2017, split days
included. The scan was run on the adjusted series the backtest saw instead, which is stricter,
and filed splits and bonuses were checked against the adjustment factors.

- **Days over 20% while held:** six distinct days across the six runs (listed above). All six
  match Yahoo; four are falls. Taking them out moves CAGR by −0.7 to +2.4 points. The
  pre-registered kill trips on the letter (a top-20 contributor has such a day in four runs;
  the conservative run moves 2.44 points, upward). Its purpose, finding gains that rest on
  unverified jumps, is not met by any of them.
- **Missed bonuses:** inside holdings, PFC 1:4 (2023, three runs) and CUB 1:10 (2017, one run).
  Adjusting them raises CAGR by 0.1 to 0.3 points. Across the 755-stock universe since 2016,
  15 of 292 filed splits and bonuses are not adjusted, all small bonuses: ASTRAL, BEL,
  BERGEPAINT, CONCOR (twice), CUB (twice), CUPID, ICICIBANK, KARURVYSYA (twice), KTKBANK, NTPC,
  PFC, SONATSOFTW. Each also depresses that stock's momentum rank for up to a year.
- Demergers, rights issues and schemes inside holdings (four, all in one median run) move value
  the price series cannot follow.

### Step 4 — look-ahead truncation test: pass (18 of 18)

Each of the six configs stopped at 2019-06-28, 2021-06-25 and 2024-03-28, twice: on the full
database, and on a copy holding nothing after that date (`audit/truncate.py`). Orders and the
equity curve are identical in all 18 pairs. BL-001's `tests/golden/test_lookahead.py` does the
same on frozen data for all four datasets and fails on a planted `shift(-1)`.

It cannot see hindsight stored without a date: today's index list and the category tags
(findings F1 to F3, Phase 3).

```bash
uv run mbt audit lookahead search_spaces/round7_A.toml data/search/round7_A \
  --picks search_spaces/bl010_phase2_picks.json \
  --cut 2019-06-28 --cut 2021-06-25 --cut 2024-03-28
```

### Step 5 — where the profit came from: flag trips in five of six runs

| Config | Top five companies' share of compounded return | CUPID alone | Largest financial year |
|---|---|---|---|
| Aggressive | 70% | 33% | FY2020-21, 26% |
| Midway | 81% | 26% | FY2020-21, 30% |
| Conservative | 78% | 27% | FY2020-21, 23% |
| Median 1 | 52% | 17% | FY2023-24, 23% |
| Median 2 | 56% | 20% | FY2020-21, 33% |
| Median 3 | 42% | 19% | FY2020-21, 25% |

Flag level: top five over 50%, or one year over 40%. No year trips it. CUPID is the largest
contributor in all six runs, and in the three winners it is most of the final rupees (the
midway run's open CUPID position alone is worth 40 times the starting capital). Its category,
"FMCG :: Stationery & Other FMCG", is the largest category in every run for that reason.

### Step 6 — could a ₹5 lakh account have placed the orders: yes

| Config (after tax) | Orders over 5% of a day's trade | Largest | CAGR | Whole shares | Whole shares, 1% cap |
|---|---|---|---|---|---|
| Aggressive | 1 of 412 | 5.1% | 40.16% | 40.14% | 41.53% |
| Midway | 1 of 620 | 5.3% | 42.32% | 42.29% | 41.72% |
| Conservative | 0 of 483 | 1.9% | 37.15% | 36.96% | 36.94% |
| Median 1 | 0 of 1,744 | 0.7% | 28.11% | 27.84% | 27.84% |
| Median 2 | 0 of 2,186 | 1.1% | 24.77% | 24.64% | 24.64% |
| Median 3 | 0 of 2,588 | 0.6% | 26.34% | 26.23% | 26.23% |

The flag (any order over 5%) trips for two runs on one order each (pre-tax: six and two). Whole
shares cost up to 0.3 points; a 1% cap moves results by −0.6 to +1.4 points. Finding F15's
worry about capacity does not hold at this capital. The what-if keeps the backtest's decisions
and caps buys only; unspent money earns the liquid fund's return.

### Step 7 — filling at Monday's open: flag trips (two of six)

Delay-0 runs, pre-tax, the same decisions filled at Friday's close and at the next open:

| Config | At the close | At the next open | Change | Max drawdown change |
|---|---|---|---|---|
| Aggressive | 47.97% | 47.18% | −0.79 | −1.2 |
| Midway | 57.08% | 55.05% | **−2.03** | −5.2 |
| Conservative | 51.24% | 51.80% | +0.57 | +0.5 |
| Median 1 | 36.65% | 36.04% | −0.62 | +0.6 |
| Median 2 | 28.30% | 25.24% | **−3.07** | +0.0 |
| Median 3 | 32.23% | 32.21% | −0.02 | −0.6 |

Mean −1.0 point. Buys fill 0.1% to 0.4% higher at Monday's open on average. On the delay-1
runs (reference only) the same change is −1.3 to +0.8, mean −0.1. By the committed rule, Broad
gets a Monday-fill option and delay-0 results are quoted on it. That is an engine change, so it
waits for BL-001's harness.

### Reproduce

```bash
cd packages/momentum-backtesting
P=search_spaces/bl010_phase2_picks.json; SP=search_spaces/round7_A.toml
R=data/search/round7_A; A=data/audit/bl010; B=$A/bundles
uv run mbt audit bundle $SP $R --picks $P --out $B
uv run mbt audit bundle $SP $R --picks $P --out $B --variant pretax_5lakh --capital 500000
uv run mbt audit bundle $SP $R --picks $P --out $B --variant taxed_5lakh --capital 500000 --tax
uv run mbt audit bundle $SP $R --picks $P --out $B --variant delay0 --signal-delay 0
uv run mbt audit replay $B/*.json --out $A/replay
uv run mbt audit study $B/*__as_searched.json --what contribution,jumps --out $A/studies
uv run mbt audit study $B/*_5lakh.json --what realism --out $A/studies
uv run mbt audit study $B/*__delay0.json $B/*__as_searched.json --what monday-open --out $A/studies
uv run mbt audit outside $B/{aggressive,midway,conservative,median1,median2,median3}__as_searched.json \
  --primary midway --also "conservative:RVNL:2022-12-23:held through a lower-circuit lock" \
  --day PCJEWELLER:2018-02-02 --day TRENT:2020-03-23 --day MANAPPURAM:2020-03-25 \
  --day NEULANDLAB:2023-05-11 --day POLYCAB:2024-01-11 --day RECLTD:2024-06-04 \
  --day RVNL:2022-12-23 --out $A
```

## Phase 2 follow-up — fixes E10 to E12 (2026-10-06)

Each has a test that fails on the old code (`tests/test_phase2_fixes.py`) and went through the
frozen-results accept step (`tests/golden/CHANGELOG.md`). All twelve re-runs below still
reconcile in the independent replay.

| Config | As searched: before → after | ₹5 lakh after tax: before → after |
|---|---|---|
| Aggressive winner | 52.17% → 52.17% | 40.16% → 40.16% |
| Midway winner | 52.86% → 52.94% | 42.32% → 42.42% |
| Conservative winner | 45.99% → 45.92% | 37.15% → 37.09% |
| Median 1 | 34.87% → 34.69% | 28.11% → 27.98% |
| Median 2 | 32.53% → 32.53% | 24.77% → 24.77% |
| Median 3 | 32.40% → 32.91% | 26.34% → 26.74% |

- **E10:** with circuit locks respected, a stock that had no session in a week can be neither
  bought nor sold. FORCEMOT is now held through its 3.5 months off NSE; no order fills at a
  stale price in five of the six runs.
- **E11:** a price series that has ended leaves the pool the week after its last real price.
- **E12:** one depository charge per stock when a taxed run sells everything at the end.
- **E13 (Monday-fill option) is not done.** It is a new execution mode, not a fix.

## Phase 3 step 2 (first part) — small bonuses adjusted (2026-10-06)

`stock_actions.scan_and_store` now also confirms a split or bonus from the exchange's filing
when the price on the ex-date moved more like the filed multiple than like no change. The
scan was re-run on the shared database (backup:
`~/TradingData/backups/catalog-2026-10-06-before-small-bonus-fix.duckdb`): 41 new confirmed
factors, 13 of them for Total Market stocks; no existing row changed.

Still unadjusted, because the price on the filed ex-date does not show them: CUPID 1:5
(2018-10-11), KARURVYSYA 1:10 (2018-08-14), KTKBANK 1:10 (2020-03-17). They need a manual look.

| Config | As searched: before → after | ₹5 lakh after tax: before → after |
|---|---|---|
| Aggressive winner | 52.17% → 52.16% | 40.16% → 40.15% |
| Midway winner | 52.94% → 53.54% | 42.42% → 43.04% |
| Conservative winner | 45.92% → 44.65% | 37.09% → 36.10% |
| Median 1 | 34.69% → 35.43% | 27.98% → 28.33% |
| Median 2 | 32.53% → 31.82% | 24.77% → 24.24% |
| Median 3 | 32.91% → 32.55% | 26.74% → 26.42% |

"Before" is after fixes E10 to E12. The changes come mostly from rankings: a stock no longer
shows a fall it never had, so it is ranked, bought and sold differently. No filed split or
bonus inside any holding of the six runs is unadjusted now, and all twelve runs reconcile.
Every earlier number in this file was measured before this data change.

## Phase 3 — removing hindsight (2026-10-06)

All numbers: round 7 arm A configs, pre-tax, ₹2 lakh, as searched, on the engine after fixes
E10 to E12 and the data after both action-scan fixes below.

### Step 2 — data fixes

- Small bonuses are confirmed from exchange filings (above).
- **Renamed symbols:** the exchange files an old action under a company's current symbol. A
  filing now answers to every symbol that shared an ISIN with it. Applied to the shared
  database (backup `catalog-2026-10-06-before-rename-match.duckdb`): 61 falls that were under
  review are now confirmed splits or bonuses (MCDOWELL-N 2018, MINDAIND 2016/2018/2022,
  MOTHERSUMI five times, INFIBEAM three times, TATAMOTORS 2011 and others). No confirmed or
  crash row changed.
- Not done: a split that also changed the ISIN under a renamed symbol with no later shared
  ISIN; the 2,155 falls still under review; the extension to 2011–2016 for Phase 6.

### Step 1 and 4 — the same configs on a point-in-time universe

`turnover_rank`: each year's 750 most-traded stocks, ranked on the six months before
(`liquidity.turnover_rank_members_by_year`). It is a stand-in for the index, which NSE builds
on free-float market value. In 2017, 405 of those 750 are not in today's list; in 2026, 110.

| Config | Today's list (as searched) | Point-in-time, curated tags | Point-in-time, extended tags |
|---|---|---|---|
| Aggressive winner | 52.2% / −44.9% | 38.0% / −48.1% | 21.6% / −60.6% |
| Midway winner | 53.5% / −29.1% | 39.4% / −38.6% | 46.9% / −30.8% |
| Conservative winner | 44.7% / −33.0% | 36.2% / −37.3% | 34.7% / −26.2% |
| Median 1 | 35.4% / −25.9% | 29.8% / −29.2% | 25.1% / −35.8% |
| Median 2 | 31.8% / −45.3% | 20.2% / −40.1% | 17.4% / −52.0% |
| Median 3 | 32.6% / −39.2% | 23.3% / −36.8% | 16.0% / −27.9% |

CAGR / max drawdown. The curated tags name only today's 755 stocks, so under them a stock
that later left the index can be ranked but never picked through a category; the extended
tags cover the others, with coarser categories.

**The 50 best stored configs** (`mbt search pit-rerun --top 50`):

| | Today's list | Point-in-time, curated | Point-in-time, extended |
|---|---|---|---|
| Median CAGR | 54.7% | 34.2% | 31.0% |
| Range | 34.4% to 74.3% | 14.6% to 53.6% | 0.1% to 52.8% |
| Lose more than 10 points | | 45 of 50 | 43 of 50 |
| Below Nifty200 Momentum 30 TRI + 5 (22.1%) | 0 | 4 | 9 |

Median loss: 21.9 points (curated), 24.9 (extended).

**Kill, arm A as a headline: tripped.** The committed level is a loss of more than 10 points
or a fall below the momentum index plus 5. Nine in ten of the best configs lose more than 10.
No arm A CAGR measured on today's list should be quoted as a result.

What survives: on the point-in-time universe the typical top config still returns 31–34% a
year before tax against 17.1% for the momentum index. That is before tax (6 to 12 points in
Phase 2), before the Monday-fill cost (about 1 point), and these 50 were chosen on the biased
universe, so even this is an upper reading.

### Step 3 — do the category tags carry information?

**Label shuffle** (`mbt search category-shuffle`, 100 shuffles each): the stocks dealt out to
the same categories at random.

| Config | Real tags | Shuffled median | Shuffled 95th percentile | Shuffles at or above real |
|---|---|---|---|---|
| Aggressive winner | 52.2% | 20.6% | 36.1% | 0 |
| Midway winner | 53.5% | 26.6% | 42.9% | 2 |
| Conservative winner | 44.7% | 28.2% | 41.4% | 3 |
| Median 1 | 35.4% | 27.5% | 37.6% | 8 |
| Median 2 | 31.8% | 19.5% | 28.4% | 3 |
| Median 3 | 32.6% | 25.5% | 34.2% | 10 |

Four of six beat the shuffle's 95th percentile; Median 1 and Median 3 do not. The three
winners were chosen on the real tags, so they are a biased sample; of the three median
configs, one passes. **Kill, the category layer: not decided.** The second half of the test,
a taxonomy in which a theme is usable only from the date it publicly existed, needs launch
dates for 113 themes and has not been built. On this evidence the tags help the winners and
do little for an ordinary config.

## Phase 4 — the evaluation method (2026-10-06, partial)

### Step 2 — a fair random baseline: pass (6 of 6)

`mbt search fair-placebo`: random rankings that change every 13 weeks, 100 seeds, the config's
stock tilt off on both sides.

| Config | Real | Random median | Random 95th percentile | Margin | Turnover real / random |
|---|---|---|---|---|---|
| Aggressive winner | 54.6% | 13.0% | 29.4% | +25.2 | 6.6× / 3.0× |
| Midway winner | 53.5% | 16.1% | 35.7% | +17.8 | 4.1× / 4.4× |
| Conservative winner | 41.3% | 16.8% | 29.6% | +11.7 | 3.0× / 4.2× |
| Median 1 | 35.7% | 17.7% | 27.3% | +8.4 | 4.8× / 4.4× |
| Median 2 | 31.8% | 15.6% | 26.5% | +5.3 | 14.4× / 5.1× |
| Median 3 | 32.6% | 16.9% | 24.2% | +8.3 | 3.0× / 2.9× |

Pass level: 5 points over the 95th percentile. Measured on today's list: it shows momentum
ranking beats random ranking among survivors, nothing about the survivorship.

### Steps 1 and 3 — every config on all its rebalance phases, and the overfitting measure

`mbt search score`: all 8,003 round 7 arm A configs re-run on the fixed engine and corrected
data, each on every rebalance phase it could have traded on (one, two or four), as equal
tranches; the blended weekly curves are kept in `data/search/round7_A/scored/`. Today's stock
list, pre-tax, as searched. About 5.5 hours on four workers.

**Averaging out the rebalance week** (step 1). 5,322 configs trade every two or four weeks.
Their best and worst phase differ by a median 5.0 points of CAGR. 656 configs (8%) score
more than 3 points above their phase average on the phase the search drew; the committed kill
for a finalist is exactly that gap.

| Config | Stored (round 7) | Its own phase, now | All phases blended | Best / worst phase |
|---|---|---|---|---|
| Aggressive winner | 63.4% | 51.9% | **46.1%** (killed: 5.8 pts below) | 51.9% / 39.4% |
| Midway winner | 61.3% | 53.5% | 52.8% | 53.5% / 52.2% |
| Conservative winner | 55.6% | 44.6% | 44.1% | 44.6% / 43.7% |
| Median 1 | 32.1% | 35.2% | 35.0% | 35.2% / 34.8% |
| Median 2 | 32.1% | 31.4% | 30.7% | 31.4% / 30.0% |
| Median 3 | 32.1% | 31.5% | 31.3% | 31.5% / 30.9% |

The aggressive winner trades every four weeks and the search drew its best Friday; on the
average Friday it is a 46% config, not a 52% one. Of the ten best configs by their own phase,
four lose 7 to 12 points when blended and four gain.

**Probability of backtest overfitting** (step 3), on weekly log excess return over Nifty200
Momentum 30 TRI, 16 blocks, 12,870 splits:

| Configs | PBO | In-sample best is below the index out of sample | Slope |
|---|---|---|---|
| All 8,003 | **0.48** (kill above 0.30) | 16% of splits | −0.58 |
| The 2,924 within the 40% drawdown ceiling | 0.20 | 3% | −0.40 |

Picking the single best config on half the history lands below the median config on the other
half in 48% of splits: a coin flip. The slope is negative: the better the best looked, the
worse it did later. **Kill tripped: stop selecting a single winner**; Phase 5 picks a cluster
and a lower bound instead. Within the drawdown ceiling the baskets impose, selection is less
overfit (0.20), which is a reason to select inside a basket, not across the whole space.

These are on today's stock list. The honest version, on the point-in-time universe, follows.

**The same scoring on the point-in-time universe** (`--universe turnover_rank --tags curated`,
`data/search/round7_A/scored_pit/`, finished 2026-10-06, about 12 hours on four workers). All
8,003 configs, every rebalance phase blended, pre-tax, as searched:

| | Today's list | Point in time |
|---|---|---|
| Median CAGR | 33.4% | **28.1%** |
| 90th percentile | 42.1% | 35.5% |
| Best | 77.3% | 56.0% |
| PBO, all 8,003 | 0.48 | **0.69** (kill above 0.30) |
| In-sample best below the index out of sample | 16% of splits | 45% |
| Slope | −0.58 | −1.02 |
| Configs within the 40% drawdown ceiling | 2,924 | 3,011 |
| PBO within the ceiling | 0.20 | **0.53** |
| … in-sample best below the index | 3% | 17% |
| … slope | −0.40 | −0.88 |

Nifty200 Momentum 30 TRI over the same weeks (2017-01-06 to 2026-10-02): 17.0%.

- **Every config loses, the best lose most.** The median config loses 5.4 points; the 50 best
  on today's list lose a median 23.7 (46 of 50 lose more than 10), as Phase 3 found on its
  sample. Rank agreement between the two lists is 0.55; of the top 100 on each, 16 are the
  same configs.
- **Selection is worse than a coin flip on the honest list.** The best half-history pick lands
  below the median config in 69% of splits, below the index in 45%, and the slope says the
  better it looked the worse it did. Inside the drawdown ceiling it is still 0.53: the basket
  alone does not make single-winner selection safe on the honest universe.
- **The category of strategy still has an edge.** 82% of configs beat the momentum index by 5
  points pre-tax; the typical config is 28% against 17%. What is not there is a way to tell,
  in advance, which config will be the good one.

Consequence for Phase 5: choose by cluster and by a lower bound, as planned, and judge the
choice by walking the selection rule forward, not by its in-sample rank. Expect the honest
answer to sit near the median config, not near the best.

### Steps 4 to 6 — built (2026-10-06)

- **Step 4:** `criteria.py` reads `bl010_criteria.json` and its addenda; the drawdown baskets
  are code (`basket_passes`: each fall within the fixed limit, or within the index's own fall
  over the same window, never past the 40% ceiling). A search run's id now includes a data
  snapshot (last bar, last weekly close, a digest of the confirmed split factors, all capped
  at the space's fixed end date), and a results folder records the snapshot it was started
  on: resuming it on different data stops with a message instead of adding a second copy of
  every config. The drawdown baskets need Nifty Midcap 150 TRI and Nifty Smallcap 250 TRI,
  which `reference_benchmarks` does not load yet: a Phase 5 prerequisite.
- An addendum may change an existing threshold only if it says what it `supersedes`;
  otherwise loading the criteria raises.
- **Step 5:** `robust.nudges` reads the neighbours of every searched dimension from the space
  file. Round 7's winners are now nudged on entry, stock tilt, weight scheme and the bands,
  which the Round 2 tables never covered; arms B and C2 no longer raise a KeyError.
- **Step 6:** `search_spaces/bl010_criteria_addendum_2.json` and `criteria.check_windows`: a
  window used to select may not meet one used to validate (13-week embargo), and the
  2012–2016 hold-out is sealed until Phase 6.

**Phase 4 is done (2026-10-06).** The point-in-time PBO is 0.69 (0.53 within the drawdown
ceiling); the single-winner rule stays killed on both universes.

## Phase 5 — robustness over time, then choose (2026-10-06)

`mbt search choose data/search/round7_A` (`choose.py`, `phase5.py`) applies the rule committed
in `search_spaces/bl010_criteria_addendum_3.json` before any Phase 5 number was computed: per
drawdown basket, rank each config by its third-worst financial year against Nifty200 Momentum
30 TRI, group configs whose weekly returns correlate at 0.9 or more, take the medoid of the
best-scoring group, prefer 8–12 holdings. All 8,003 configs on the point-in-time universe,
pre-tax at ₹2 lakh, today's curated tags, every rebalance phase blended. The full report is
`data/search/round7_A/phase5/report.md`.

**Process notes.** A timing run on 800 configs, with the Midcap 150 and Smallcap 250 *price*
indices standing in for the TRIs, was looked at before the full run; the rule was not changed
after it. A Fable model checked the code against the criteria files without seeing results: no
look-ahead in the walk-forward, the rule implemented as written, and five report-side
corrections (all applied): FY2019 was silently missing from the walk-forward, the latest event
window was blank, the factor kill was not coded, the random sample excluded the top configs,
and the holdings check reported one reading of an unspecified test.

### The walk-forward of the rule: killed in all three baskets

Each year from FY2020, the rule is applied to the data that ended 13 weeks before the year
started, and its pick is held through the year:

| Basket | The rule's picks | Median config | Nifty200 Momentum 30 TRI | Kill |
|---|---|---|---|---|
| Conservative | 18.6% | 31.2% | 15.0% | **killed** |
| Medium | 28.5% | 31.9% | 15.0% | **killed** |
| Aggressive | 28.5% | 31.9% | 15.0% | **killed** |

FY2020–FY2026, annualised, pre-tax. The kill is "not 3 points a year above the median config,
or not above the index". The picks beat the index in every basket, but the median config beats
the picks. The committed rule cannot rank FY2019 (no complete financial year ends before its
cut). Adding it, ranked on January–December 2017, as a sensitivity: picks 17.6% / 26.1% /
26.1%, median 26.1% / 26.8% / 26.8%, index 14.6%. FY2019 was the small-cap bear: the index
+11.6%, the median config −4.0%.

**Choosing a config on its past does not beat picking a typical one.** That was Phase 4's
finding (PBO 0.69); the walk-forward confirms it with the rule chosen to resist it.

### The other checks

| Check | Conservative | Medium | Aggressive |
|---|---|---|---|
| Configs in the basket | 409 | 1,960 | 2,761 |
| Clusters (single-config) | 146 (106) | 416 (293) | 628 (437) |
| Top 100 by CAGR beat 100 random, share of FYs | 77% | 77% | 79% |
| Rank top-50 also in CAGR top-50 (kill below 20%) | 42% | **14%, killed** | **18%, killed** |
| Holdings: 8–12 preference (2–6 must win by 3 pts at similar Ulcer) | holds | holds | holds |

- **Top 100 vs random** passes, but it is the full-history top 100 scored on the same history:
  a consistency check, not evidence (the walk-forward is the evidence).
- **Ranking by CAGR is noise** in two baskets: the configs that hold up best in their bad
  years are mostly not the ones with the best CAGR.
- **Clusters are mostly single configs** (73–78%). At 0.9 correlation the space does not
  form families, so the clustering adds little protection beyond the third-worst-year rank.
- **Fewer holdings buy nothing.** Within each basket the median 8–12-holding config earns
  more than the median 2–6-holding one (by 1.2 to 3.0 points a year), and the rule's 8–12
  picks fell far less than its 2–6 picks (Ulcer index 9–12% against 16–17%).

### What the rule picks on the full history (reported, not frozen)

| Basket | Config | Holdings, rebalance | CAGR | Max DD | Third-worst FY vs index | Worst FY vs index | Alpha (t) |
|---|---|---|---|---|---|---|---|
| Conservative | `ce6723a197b9` | 7, every 2 weeks | 44.8% | −32.3% | +12.5 | −11.0 | 23.5% (3.8) |
| Medium | `981d611037eb` | 3, weekly | 39.6% | −36.6% | +21.0 | −16.2 | 20.7% (3.0) |
| Aggressive | `fc31a2912213` | 3, weekly | 45.7% | −39.3% | +13.0 | −20.0 | 25.6% (3.3) |

All three **fail** the per-config test: each has a financial year more than 10 points behind
the index. The factor check passes for all three (alpha well above 5% a year, |t| > 2, with
market, size and momentum betas of about 0.9, 0.55–0.7 and 0.4–0.55), but they are in-sample
picks, so their alpha is inflated by the selection. The bootstrap's 1-in-20 drawdown is 44–53%,
deeper than every basket's 40% ceiling.

### Verdict

**Phase 5 names no config.** The committed rule fails its own walk-forward. What survives:

- The strategy family has an edge. The median config of each basket earned about 31–32% a
  year pre-tax over FY2020–FY2026 (about 26–27% including FY2019), against 15% for Nifty200
  Momentum 30 TRI. This is an upper estimate: before tax, on today's curated tags, inside a
  search space whose bounds were set after seeing earlier results.
- No rule tried here picks a better-than-typical config in advance.
- 8–12 holdings is as good as 2–6 in return, with much shallower falls.

What to follow is now the owner's decision (BL-010 open question 4), not a ranking result.

## Phase 6 step 0 — what Phase 6 follows (2026-10-06)

Phase 5 named no config, so the owner chose what to follow instead: money split equally
across 3–4 typical Medium-basket configs with 8–12 holdings, rebalancing every 2 or 4 weeks.
The rule (`search_spaces/bl010_criteria_addendum_4.json`, committed before the pick was
computed):
1. Skip configs whose third-worst financial year against the index is below the group's median.
2. Take the most typical of the rest (highest average weekly-return correlation with the
   others), each correlated below 0.9 with those already taken, up to four.
3. Split capital equally and reset it each April.

The rule had to pass its own walk-forward before anything was frozen. `mbt search ensemble
data/search/round7_A --space search_spaces/round7_A.toml --freeze` (`choose.py`, `phase6.py`).

### Walk-forward of the picking rule: passes

| | FY2020–FY2026 | With FY2019 (sensitivity) |
|---|---|---|
| The ensemble, picked each year on data ending 13 weeks earlier | **36.7%** | 30.9% |
| Median config of the same group | 32.6% | 27.5% |
| Nifty200 Momentum 30 TRI | 15.0% | 14.6% |

Annualised, pre-tax. Pass: no more than 2 points below the group median (bar 30.6%) and at
least 5 points above the index (bar 20.0%). The ensemble beat the group median in 6 of 7
years; the miss is FY2026 (3.7% against 9.8%). It fell less than the median in FY2020 (−19.2%
against −23.0%).

A Fable model checked the code against the addendum: no look-ahead, every unspecified
judgement neutral, and the same four picks re-derived independently. Its fixes are in:
- a flag when fewer than three configs are found;
- a missing year fails rather than counting as 0%;
- each pick's range across rebalance phases is reported;
- the freeze records what a phase means for live trading;
- a look-ahead test.

### Frozen: `search_spaces/bl010_phase6_frozen.json`

| Config | Holdings | Rebalance | Phase (rebalance_offset) | CAGR, phases blended | Worst to best phase |
|---|---|---|---|---|---|
| `1281e8ed6824` | 12 | every 4 weeks | 0 | 34.2% | 30.9% to 36.2% |
| `08c4307d7aa9` | 8 | every 4 weeks | 1 | 32.9% | 29.8% to 35.4% |
| `535b17b44ba5` | 12 | every 4 weeks | 2 | 31.6% | 26.3% to 36.2% |
| `bad83df3821a` | 12 | every 2 weeks | 1 | 28.4% | 26.8% to 29.8% |

Ensemble, equal capital reset each April, full history (2017-01 to 2026-10, pre-tax, ₹2
lakh): CAGR 32.3%, max drawdown −31.5%, Ulcer index 10.4%. Over the same period the group's
median config made 31.0% and Nifty200 Momentum 30 TRI 17.0%.

The record holds:
- each config's full parameters and the space's fixed settings;
- the code commit (`d21141c`);
- the data snapshot (last bar 2026-10-01, factor digest `4d066205752f`);
- a SHA-256 of the scored curves.

A phase is the engine's `rebalance_offset`: the Fridays whose week number since 2016-01-01
equals the phase mod `rebalance_every`. The phases were assigned to spread trading days, never
by performance; no Friday has more than two configs trading.

**What to expect, honestly.** The four configs are correlated 0.85–0.89 with each other, so
the split smooths results only modestly. Phase 6 trades one phase per config, and single
phases ranged several points either side of the blended figures. All of it is pre-tax, on
today's curated tags, inside a search space designed with hindsight: an upper estimate. The
after-tax re-check and the fair category check are in Phase 7.

**Next (Phase 6):**
1. Live-signal parity: the API, CLI and live preview use the frozen settings, and the last 12
   weeks of live signals equal the backtest's.
2. The one-shot 2012–2016 backcast of the frozen ensemble.
3. Paper-track it for 6–12 months next to the group's median config and Nifty200 Momentum 30
   TRI, with failure defined in advance in `bl010_criteria.json` `phase_6_holdout`.

## Phase 6 step 2 — the one-shot 2012–2016 backcast: fails (2026-10-07)

The four frozen configs were run once on 2012–2016, years nothing had been tuned on, exactly
as criteria addendum 5 fixes it (committed before the run). Pre-tax, ₹2 lakh per config, equal
capital reset each April. The result is recorded in
`search_spaces/bl010_phase6_backcast_result.json`; `mbt search backcast` refuses to run again.

| | Yearly return | Worst fall | Excess (pts) | Fall vs benchmark | Verdict |
|---|---|---|---|---|---|
| **Ensemble** | 20.1% | −24.0% | | | **fails** |
| Nifty 500 TRI | 12.3% | −19.4% | +7.8 | 1.24× | passes |
| Nifty Midcap 150 TRI | 17.7% | −22.7% | +2.5 | 1.06× | fails |
| Nifty200 Momentum 30 TRI (reported) | 21.1% | −21.5% | | | |
| Nifty Smallcap 250 TRI (reported) | 15.9% | −30.1% | | | |

Pass: at least 5 points a year ahead of **each** benchmark and no deeper a fall than 1.5× its
own. The ensemble beat the broad market by 7.8 points but the Midcap 150 by only 2.5, so it
fails. The Nifty200 Momentum 30 index fund, which needs no stock picking, made as much.

**The window.** The rules say to measure from the first Friday of 2012. The harness measured
from the first week with an equity value, 6 April 2012 (the configs hold nothing until their
first quarterly pool forms). Counting the cash weeks as the rules say, with no new run: the
ensemble 19.6% against Nifty 500 TRI 14.9% (+4.7) and Midcap 150 TRI 21.9% (−2.3). **A fail
under either window.**

| Config | Yearly return | Worst fall |
|---|---|---|
| `1281e8ed6824` | 18.1% | −26.5% |
| `08c4307d7aa9` | 22.1% | −31.4% |
| `535b17b44ba5` | 24.0% | −25.2% |
| `bad83df3821a` | 15.1% | −27.7% |

All four replay-reconcile against raw data; the jump scan changes nothing (the ensemble is
20.1% either way). The configs could pick from about 280–330 tagged names a year; the first
trades came between 6 and 27 April 2012.

**What it means.**
- In 2017–2026 the same four made 32% a year against 17% for the momentum index fund. In the
  five unseen years they made 20% against 21% for it. The edge seen in-sample did not show up
  out of sample, though the unseen window is short and was a different market.
- Biases in the backcast favour the strategy (tags are survivors; today's category list), so
  this is, if anything, flattering.
- Caveats that cut the other way: about half as many pickable names in 2012–13; one five-year
  window is one draw.
- The pre-registered rule says this is reported, not tuned around. Paper tracking is not
  blocked by it, but the owner should decide whether to follow these configs with money.

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

`mbt search score` is running over all 8,003 configs. Results are added when it finishes.

### Not started

Step 4 (criteria as code, data snapshot in the run id), step 5 (generic nudges), step 6.

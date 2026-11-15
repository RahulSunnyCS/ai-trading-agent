# BL-229 — Options overlay sweep: hold, deeper strikes, stops and exposure sizing on the F&O momentum books

| | |
|---|---|
| **Priority** | P2 — the owner asked for an overnight sweep (2026-11-15); research only, no money on it |
| **Status** | In progress |
| **Type** | research |
| **Area** | momentum / options |
| **Created** | 2026-11-15 |
| **Depends on** | [BL-227](BL-227-options-overlay-backtest.md) (the overlay engine and page), [BL-226](BL-226-fno-momentum-stock-options.md) (data, candidates), [BL-228](BL-228-fno-falling-stock-puts.md) (puts, mirror pool) |
| **TODO.md row** | 3.10.78 |

## Context

BL-226 killed weekly calls on the F&O momentum picks: the gains were leverage, and the calls lost to the shares
after mid-2024. BL-228 killed bought puts and found the mirror pool earned only from its calls. Neither tried the
settings that change how an options book behaves: keeping a contract while its stock stays picked (BL-226 sold
and re-bought every week, paying 2–4 % of premium a week in slippage and costs), deeper strikes (ITM, a delta
target) that behave more like the stock, a later expiry with less weekly decay, a daily stop and target, sizing by
delta exposure instead of premium, and a market filter on the calls. The owner, 2026-11-15, asked for these
settings on the Options overlay page and an overnight sweep over them.

## Goal

A ranked table of the settings on a train window, a test-window verdict for the few chosen there, and the
Sweeps table on the page to read every run.

## Out of scope

Selling options, intraday data, new strategies (the three BL-226 candidates only), profit booking (a money
rule on top of a book; tried by hand on the page), live or paper orders.

## Plan

### Phase 0 — Pre-register
Committed before any sweep run (the grid file and this section in one commit).

- **Hypothesis:** at least one combination of hold, strike depth, expiry, exits and sizing turns a momentum
  call (or mirror) book on F&O stocks into one that makes money after costs and tax on weeks it was not chosen
  on, with a drawdown a person could hold.
- **Grid** (`packages/momentum-backtesting/search_spaces/bl229_overlay_grid.json`, 1,320 runs):
  - strategies: BL-226's three candidates as they were chosen on 2020-01 → 2024-06 (Four-Strategy Mix, Trio
    Fortnightly, 12-month top 10 weekly), re-run on F&O stocks;
  - mode: calls; calls only while NIFTY is above its 200-day average; the market switch (calls / the weakest
    5's puts by NIFTY's 200-day average); the mirror pool at N 5 and N 10 (the last two read no strategy);
  - strike: ITM2, ITM1, ATM, OTM1, delta 0.7;
  - expiry: the nearest with ≥ 10 sessions left, or the one after;
  - hold while picked: off / on;
  - exits: none; stop at −50 % of premium; stop −50 % with target +100 % (daily closes);
  - size: 20 % of capital in premium a week; delta exposure of 100 % of capital a week.
  Fixed: ₹15 lakh capital, tax on (30 % + cess, a loss carried), BL-226's costs and slippage (1 % ITM/ATM/delta,
  2 % OTM1 of premium each way), OI ≥ 10 lots, ban list, re-struck contracts followed.
- **Windows:** train = weeks ending by 2023-12-29 (2020-01 → 2023-12); test = weeks from 2023-12-29 to
  2026-11-13. A week across the split counts in neither.
- **Selection (train only):** among runs with at least 150 train trades and a positive train total, rank by
  train after-tax total ÷ |train max drawdown|; carry the top 5 that differ in strategy or mode (no two from
  the same strategy and mode).
- **Pass (test, per carried run):** test after-tax total above zero, test max drawdown no worse than −50 % of
  the ₹15 lakh, and the 90 % block-bootstrap interval of the weekly test return above zero (5,000 draws on the
  page's 2,000-draw routine re-run for the five, 4-week blocks). Shown beside each: the same strategy's shares on
  the test weeks.
- **Kill / keep:** any carried run passing → a candidate for a forward paper journal (a new item, BL-226's
  Phase 5 shape: 20 forward weeks before any money). None → this round is killed and the page stays a viewing
  tool.
- **Look-ahead check:** every input is the engine's (signals at the previous week's close, F&O list and bans
  of the entry day, daily closes for stops on days after entry, sessions calendar known in advance); the delta
  is read from the entry day's own option price. Unit tests in `tests/test_options_overlay.py`.
- **Snooping caveats (read the verdict with them):** the three strategies were chosen by BL-226 on 2020-01 →
  2024-06, which overlaps the train window; the test window's 2024-07 → 2026-11 weeks were read by BL-226's and
  BL-228's confirmations; 1,320 runs are tried, so a few test rows will look good by chance. A pass here is a
  reason for a forward test, not a finding.
- **Will not run:** other strategies, N, capitals, profit booking, other stop or target levels, puts alone
  (BL-228 killed them). Each needs `override: <reason>` in the Log.

### Phase 1 — Run
- **Tasks:** `mbt overlay-sweep search_spaces/bl229_overlay_grid.json --workers 3` overnight (resumable;
  results under `<data>/overlay-sweeps/bl229-round1/`); the Sweeps table on Momentum › Options overlay.
- **Done when:** all 1,320 runs are in (failures listed).

### Phase 2 — Selection and verdict
- **Tasks:** the train ranking and the five carried, written here before their test columns are read; the
  test verdict; the findings page (`research/momentum/common/options-overlay.md`).
- **Done when:** verdict in Result; INDEX and TODO closed.

## Risks

- **Memory and time:** three workers on an 8 GB Mac (about 0.7 GB each); a run that fails is recorded and the
  sweep goes on; it resumes where it stopped.
- **Daily closes:** stops on settle prices of thin strikes can fire on a stale price; the counts show how often.

## Log

- 2026-11-15 — created at the owner's request ("we will start the overnight sweep today"); settings built on
  the BL-227 page (PR #452's branch); Phase 0 and the grid committed before any sweep run.
- 2026-11-15 22:54 — round 1 started (3 workers, `caffeinate`, detached). 23:08 — stopped after 7 runs to make
  runs faster (one delta read per week; the sweep skips the one-lot pass behind the page's "capital it
  needed"; commit `22a68a17`; results unchanged), resumed from the 7 done.
- 2026-11-15 — disclosure: while checking that the Sweeps table rendered, the page read-out returned one
  row's test figures (Trio Fortnightly, calls, ITM2, exposure 100 %: train +₹23.9 lakh / −47 %, test
  +₹9.5 lakh / −44 %). No other test figure was read; the selection is still made on train columns only.

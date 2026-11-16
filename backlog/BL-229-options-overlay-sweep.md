# BL-229 — Options overlay sweep: hold, deeper strikes, stops and exposure sizing on the F&O momentum books

| | |
|---|---|
| **Priority** | P2 — the owner asked for an overnight sweep (2026-11-15); research only, no money on it |
| **Status** | Done — round 1 killed (2026-11-16) |
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

## Result

**Review amendment (2026-11-16): round 1 is void until it is re-run.** The sweep ran on an engine with two
sizing bugs the PR #453 review found: *exposure* sizing gave every leg the whole exposure (a four-sleeve
favourite at "100 % exposure" carried about 400 %), and with *hold* the week's budget went to the new picks
alone, so a week with kept contracts overweighted the new ones (hold runs were levered against runs that sell
weekly). All five carried runs use hold, and the first carried run was a four-sleeve exposure run. Two more
engine bugs touched every hold run: a held contract that did not continue was dropped with no exit slippage or
costs, and `weeks_won` was counted on positions, not weeks. All four are fixed and tested; **every figure
below (the table, the verdict, "hold helps most", "exposure halves the drawdown", the grid-wide read) was
computed before the fix and is void.** The re-run is [BL-230](BL-230-options-overlay-rescore.md): a new sweep
name, the same frozen grid and selection rule. The Sweeps table used to open sorted on the test window; it
now opens on train and keeps the test columns shut until they are opened, so a re-run's selection reads
train only. The test weeks were also read once for the five carried runs and by the grid-wide read, so a
re-run on them is a check of the fix, not a fresh test.

**Round 1 killed (2026-11-16), void as above.** None of the five runs carried from the train window passes on the test weeks
(2024-01 → 2026-11, ₹15 lakh, after costs, slippage and tax). Every one fails the weekly 90 % interval (5,000
draws: its lower bound is below zero), three also fail the −50 % drawdown limit, and one loses money.

| Carried (train rank) | Test total | CAGR | Test DD | Weekly 90 % | Trades | Without top 5 % | Shares, same weeks |
|---|---|---|---|---|---|---|---|
| 1 Mix, calls, OTM1, hold, exposure 100 % | +₹35.1 L | 52.6 % | −66 % | −1.58 to +4.83 % | 740 | −₹75.3 L | +57 %, −22 % |
| 2 Mix, calls if NIFTY > 200-DMA, OTM1, hold, 20 %/wk | +₹11.5 L | 22.1 % | −63 % | −0.68 to +1.82 % | 384 | −₹22.0 L | +57 %, −22 % |
| 3 Trio, calls, ITM2, hold, 20 %/wk | +₹17.8 L | 31.6 % | −60 % | −0.88 to +2.44 % | 123 | −₹3.8 L | +88 %, −28 % |
| 4 Trio, calls if NIFTY > 200-DMA, ITM1, hold, stop −50 %, 20 %/wk | +₹18.6 L | 32.7 % | **−39 %** | −0.74 to +2.43 % | 109 | −₹0.3 L | +88 %, −28 % |
| 5 12m top 10, calls, ATM, hold, 20 %/wk | −₹6.2 L | −17.0 % | −78 % | −2.04 to +1.33 % | 809 | −₹74.6 L | +33 %, −19 % |

- **The nearest miss is #4** (Trio, calls only while NIFTY is above its 200-day average, ITM1, hold, a −50 %
  stop): +124 % on ₹15 lakh against +88 % for the same picks as shares, drawdown −39 % (limit −50 %), but the
  weekly interval spans zero and its top 5 % of trades are all of its profit (−₹28,000 without them).
- **In four of five the profit is the top 5 % of trades or more**; without them they lose.

**What the whole grid says (descriptive, read after the verdict; medians over the runs with that setting):**
- **Hold while picked helps most:** train median +₹16.0 lakh against +₹4.3 lakh selling weekly; test +₹2.2 lakh
  against −₹2.4 lakh; 56 % of hold runs made money on test against 37 %.
- **The calls filter (NIFTY above its 200-day average) is the best mode on test:** 64 % positive, median test
  drawdown −36 %, against 54 % and −54 % for calls always and 52 % / −56 % for the market switch.
- **The mirror pool fails on test:** 0–2 % of its runs made money, median drawdown −76 % to −85 % (BL-228's
  learning-only pass did not survive).
- **Deeper strikes hold up better:** ITM1 and delta 0.7 made money on test in 61–62 % of runs (median drawdown
  −45 % / −34 %), OTM1 and ATM in 32–33 % (−81 % / −65 %).
- **Trio Fortnightly is the strongest strategy** (81 % of runs positive on test, median drawdown −35 %); the
  Four-Strategy Mix and 12m top 10 are near coin-flips.
- **Little difference:** next expiry against the nearest, the stop or stop-and-target against none, exposure
  against 20 % of capital (exposure halves the drawdown, −46 % against −62 %, for the same median).
- **Train rank says little about test rank:** Spearman 0.34 over the 1,320 runs.

**Caveats:** the strategies were chosen on 2020-01 → 2024-06; the test weeks were read by BL-226's and
BL-228's confirmations; one test row was seen before selection (Log); daily closes, not quotes.

**What it leaves:** the settings that helped are clear (hold, the NIFTY filter on calls, ITM1 / delta 0.7,
Trio). A round 2 would need a new pre-registration and, honestly, data not yet seen: a forward paper journal
of #4's settings is the cleaner test.

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
- 2026-11-16 08:20 — round 1 finished at 00:38 (1,320 runs, no failures). Train selection (written before any
  test column was read; 533 runs had ≥ 150 train trades and a positive train total; ranked by train after-tax
  total ÷ |train drawdown|, one per strategy and mode), ₹15 lakh:
  1. `deb0f923` Four-Strategy Mix, calls, OTM1, hold, exposure 100 %: train +₹122.5 lakh, DD −53 %.
  2. `3c66b189` Four-Strategy Mix, calls while NIFTY > 200-DMA, OTM1, hold, 20 % a week: +₹71.0 lakh, −32 %.
  3. `625db05a` Trio Fortnightly, calls, ITM2, hold, 20 % a week: +₹78.4 lakh, −43 %.
  4. `9267a0db` Trio Fortnightly, calls while NIFTY > 200-DMA, ITM1, hold, stop −50 %, 20 % a week: +₹74.4
     lakh, −45 %.
  5. `2293eef6` 12m top 10 weekly, calls, ATM, hold, 20 % a week: +₹62.7 lakh, −55 %.
  All five hold while picked and use the nearest expiry; no mirror or market-switch run made the five.
- 2026-11-16 — test read for the five (5,000-draw interval): none passes; round 1 killed. Result written; the
  grid-wide descriptive read added after the verdict.
- 2026-11-16 — PR #453 review (9 bugs, 6 nits). Fixed in code, with tests: exposure sizing uses the leg's own
  share (`leg.weekly_total`), and a held week splits the budget over kept plus new contracts; a held contract
  is not kept past the run's last week or the next week's position cap (it is sold, with costs); the refill
  trial no longer changes the hold state; two sleeves' positions no longer share a `pos_id`; `weeks_won` is
  counted on weeks; a resumed sweep asks failed runs again (`failed_ids`; the table shows one row a run, a
  result over a failure); the Sweeps table opens on train with the test columns shut. The recorded round 1
  is void (Result above) and BL-230 re-runs it. Not done, noted: a week across the train / test split is
  counted in the test weeks (not hit by this grid); the selection and the 5,000-draw verdict are not
  reproducible from committed code; the grid-wide read used the 2024-26 weeks; no multiple-testing
  adjustment on the five carried runs.

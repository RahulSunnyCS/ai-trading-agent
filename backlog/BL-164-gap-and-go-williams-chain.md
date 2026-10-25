# BL-164 — NIFTY gap-and-go opening-range band → Williams back-up chain, 150-point ITM weekly buys (POC)

| | |
|---|---|
| **Priority** | P2 — the owner's idea from a public source (OptionsBuyer.in); evidence only, nothing waits on it; the repo's prior is against intraday option buying (BL-152, BL-097), so the value is a clean verdict, not a candidate |
| **Status** | In progress (Phase 1; pre-registration settled 2026-10-25, nothing run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-25 |
| **Depends on** | BL-120 (the rule tester: grammar, placebo and random-time controls, ledger, locked confirmation period), BL-063 (the charge model), BL-152 (the breakout grammar and the verdict this must beat) |
| **TODO.md row** | 3.10.43 |

## Context

The owner (2026-10-25) pasted the published rules of a NIFTY intraday option-buying chain from
OptionsBuyer.in ("research data only, not investment advice") and asked for an opinion and a POC. The
strategy is fully mechanical and close-based, which is exactly what the BL-120 rule tester judges. It is
recorded here in full so the item is the record, not the web page.

### The strategy as published

**1. Gap-and-go bot (the 10% opening-range band).**
- Opening range (OR): the highest and lowest 1-minute **closing** prices from 09:15 to 09:45, both
  minutes included (31 bars). Candle highs and lows are not used. Width W = OR high − OR low.
- Triggers: a 1-minute close above OR high + 0.10 × W (buy CE) or below OR low − 0.10 × W (buy PE),
  checked from 09:46 to 12:00.
- Direction from the gap: gap = NIFTY's 09:15 price against the previous day's **15:15** close. After a
  gap-up only the upside break is taken, after a gap-down only the downside.
- Stands down when: the opposite band breaks first (`opposite_first`); at the break NIFTY has already
  touched yesterday's 15:15 close earlier in the day (`filled`); nothing breaks by 12:00 (`no_break`).
- Entry: the next 1-minute bar after the signal, the 150-point in-the-money weekly option (CE up, PE
  down).

**2. Williams levels (the back-up bot).**
- Prior day's range R = yesterday's highest minus lowest 1-minute close.
- Levels: today's open + 0.5 × R (buy CE), today's open − 0.5 × R (buy PE). First 1-minute close beyond
  either, from the hand-over minute until 14:29.
- Trades only when the gap-and-go bot stood down with `opposite_first` or `filled`, and only when the
  gap is under 0.2% or 0.5% and above. Never after `no_break`, never on 0.2–0.5% gap days.
- Entry: next 1-minute bar, 150-point ITM weekly option.

**3. Exits (both bots, on the option premium).**
- Stop-loss at 70% of entry (−30%). Trailing stop: once the premium has been above 105% of entry, exit
  when it falls to 80% of its highest point. Time exit 15:15. Stops checked on 1-minute closes, the exit
  fills on the next bar. One position a day at most.
- Published costs: 0.1% a side plus brokerage, taxes and fees; also shown at an extra 0.2% a side.

### What the repo already knows

- **Buying NIFTY options on an intraday breakout has just been killed.** BL-152 ran 192 variants of a
  5-minute breakout (levels: 09:15–09:44 opening range, rolling 30-minute, held day high, previous day)
  on 2024-10-09 → 2026-10-08 after charges: buying the ATM averaged −₹71 a trade and the 1%-premium
  option −₹16; the opening-range level was the worst of the four (−₹157 a trade across its 48 variants);
  stops and exits moved the result little; PBO 0.51 failed the grid. The Buy range-breakout family loses
  after charges too (BL-097: 3 of 48 files positive). `research/options/strategies/breakout/`,
  `research/options/strategies/buy-breakout/`.
- **The gap has carried no information for the sellers' day quality:** BL-069 B2 (gap as a ranking
  criterion) dropped; BL-154's opening-gap label killed; BL-162 found no usable gap rule for lists A / B /
  C / REF. None of those tested a *directional continuation* after a gap, which is what this chain claims.
- **The opening range does predict the rest of the day's range** (BL-110, both periods, Spearman 0.30 /
  0.33), and BL-162 found that wide opening-range days are the sellers' worst days while the Dir family
  earned more there. A buyer's edge, if there is one, lives on exactly those days; the 10% band is one
  way to find them early.
- The rule tester has everything but three pieces (Phase 1): the previous session's value at a clock
  (`prev_close` is the 15:29 close, not 15:15, and `prev_high` / `prev_low` use bar highs and lows, not
  closes), a "has this held at any earlier minute today" operator for the stand-down rules, and a
  peak-pullback premium trail with an activation level (the legwise `trail_sl` is AlgoTest's step form
  `[X, Y]`, which cannot say "80% of the highest point once above 105%").

### Assessment (why it is a POC and not a candidate)

For it: mechanical, close-based (fewer wick artefacts than BL-152's levels), one trade a day, a time
exit, and two selectivity rules (gap direction, `filled`) that BL-152's grid did not have. Buying 150
points in the money (about ITM3 at today's 50-point step) is the most sensible part: a delta near 0.75
and little time value make the option behave like a leveraged index position, so the trade is a bet on
the move rather than on volatility. Against it: the published parameters (10% band, 150 points, −30% /
105% / 80%, the Williams gap bands) were chosen by the source after seeing the data, so the learning
period will flatter them and only the locked confirmation period counts; the Williams gap rule (trade
below 0.2% and at or above 0.5%, never between) is non-monotonic, a classic mark of fitting; a deep ITM
weekly has a wider spread than the ATM, so the 1% slippage row matters more than usual; and a published
pattern with exact rules is one everyone can trade.

## Goal

A registered verdict on NIFTY for the chain exactly as published: does each bot, and the chain, earn
money after charges, beat entering the same trade at a random trend-matched minute, survive slippage, and
hold on the locked confirmation period. Three tests, every one counted in the ledger.

## Out of scope

- SENSEX, BANKNIFTY, stocks.
- Any parameter other than the published ones: band width, OR length, ITM depth, stop and trail levels,
  the 12:00 / 14:29 windows, the Williams factor and gap bands. A later item if this one passes.
- An ATM or 1%-premium comparator, re-entry after a stop, scaling in, more than one trade a day.
- The source's own figures (not reproduced, not compared).
- Any live, paper or AlgoTest form. A passing chain becomes a forward-tracking proposal, a new item.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypotheses.**
  - **H1 (gap-and-go):** buying the 150-point ITM weekly in the gap's direction on the first 1-minute
    close through the 10% band, with the `opposite_first` and `filled` stand-downs, earns more after
    charges than the same trade entered at a random later minute while the index is still beyond the band.
  - **H2 (Williams back-up):** on the days the gap-and-go bot stood down with `opposite_first` or
    `filled` and the gap is outside 0.2–0.5%, buying the 150-point ITM weekly on the first 1-minute close
    beyond open ± 0.5 × R earns more after charges than the same trade at a random later minute beyond
    the level.
  - **H3 (the chain):** H1's trade, else H2's, one position a day, earns more after charges than its
    trend-matched random-time control.
- **Definitions fixed here.** The "09:15 price" is the 09:15 bar's open (`session_open`). "Touched" the
  previous 15:15 close means a bar whose low ≤ that close ≤ high at any minute before the break minute.
  The gap is `(session_open − prev_1515) / prev_1515`; a gap of exactly 0 takes no trade. Today's open for
  the Williams levels is `session_open`. The band is checked on closes 09:46–12:00, the Williams level on
  closes from the stand-down minute + 1 to 14:29. R is the previous session's `max(close) − min(close)`
  over its 375 bars. The strike is `ITM3` of the nearest weekly expiry (150 points at a 50-point step;
  if NIFTY's step changes, the points stay 150 and the item is amended by a dated rule). One lot, today's
  lot size, as every BL-120 test.
- **Fills and stops.** Entry fills at the signal minute's close (the BL-083 / BL-120 convention, a minute
  earlier than "the next bar"); the published "next bar" fill is covered by the 0.5% and 1% slippage rows.
  The −30% stop and the 105% / 80% peak trail are checked on the option's 1-minute close and fill at that
  close, not on the bar's high / low (owner, 2026-10-25: as published, although BL-156 found
  close-checked stops worse for the sellers' legs); the time exit is 15:15.
- **Costs:** the BL-063 model only (owner, 2026-10-25); the source's 0.1% a side is not shown.
- **Universe:** NIFTY index 1-minute bars and the NIFTY weekly option chain of each day from the
  trading-data lake (expired contracts included; days `data_quality` excludes are skipped and counted).
  The index has no constituents to be survivorship-biased.
- **Look-ahead check:** every new operator (Phase 1) reads only stamps ≤ j and earlier sessions and is
  added to the grammar's causality test; the OR is read only from 09:46; the gap, R and the previous
  15:15 close use the previous session only; the stand-down flags use only minutes before the break;
  the trail reads the premium's running maximum up to the current close. Entry at the signal close is the
  registered optimism, bounded by the slippage rows.
- **Controls:** trend-matched (`control_when`): the random minute and the placebo day count only where the
  band (H1) or the level (H2) exists and the index closed beyond it the minute before. 200 random-time
  draws on the 5-minute grid, the 20 nearest placebo days, as the tester does.
- **Pass / kill rule** (learning period, NIFTY 2024-10-09 → 2026-10-08, after BL-063 charges, one lot):
  1. A test with fewer than 40 events is **thin** and cannot advance.
  2. A **candidate** has mean net per trade > 0, t ≥ 2.0, and an event mean at or above the 90th
     percentile of its random-time draws; and keeps mean net > 0 at 0.5% slippage.
  3. Every candidate (at most three) is revealed once on the **confirmation period** (NIFTY 2022-01-03 →
     2024-10-08) and **passes** with mean net > 0, t ≥ 2.0 and the random-time percentile ≥ 0.90 there.
  4. **Verdict:** *passed* if H3 passes, or H1 passes alone (the chain's back-up then drops); *killed* if
     no test is a candidate or none passes confirmation; *inconclusive* if H1 or H3 is thin. H2 passing
     alone is reported, not adopted (it only trades on H1's stand-down days).
  Three tests, so no PBO or plateau step; the price of a small grid is no robustness map, and the
  half-year, weekday and expiry-day splits the tester prints stand in, as description only.
- **Hold-out:** the confirmation period stays locked until step 3 (`obt rule reveal`, once per spec
  hash). Sessions after 2026-10-08 are forward only and never tested.
- **Will not run** (each needs `override: <reason>` in the Log): SENSEX; any other band, OR length, ITM
  depth, stop, trail, window or gap band; an ATM or premium-based strike; re-entry; a second look at the
  confirmation period for any spec; the Williams bot on `no_break` days or on 0.2–0.5% gap days.

### Phase 1 — Grammar and engine additions (BL-120 extension)
- **Tasks:** in `ruletest/expr.py`, `{prev_at: {x, clock}}` (the previous session's value of `x` at that
  clock, constant over the session) and `{prev_agg: {x, how: max|min}}` (the previous session's max / min
  of `x` over its 375 bars), plus `{ever: a}` (true from the first stamp `a` held in the session; a
  bool `cum_max`). In `legwise/schema.py` + `engine.py`, an optional leg field `trail_peak:
  {activate_percent, exit_percent}` (off unless set, so every golden stays byte-identical) checked on
  the option's 1-minute close, and an optional leg field `stop_on: tick | close` (default `tick`, left
  out of the dump at its default so no strategy gets a new version) that judges the leg's stop on the
  1-minute close and fills it at that close. The engine has no such mode today: BL-156's candle-close
  stops live only in `research/bl156/`. Causality test for each operator, unit tests,
  `scripts/ruletest-acceptance.py` still ACCEPTANCE OK, legwise goldens unchanged.
- **Deliverables:** the operators and the field, tests, the package `CLAUDE.md` lines.
- **Done when:** the three Phase 2 specs validate, read back in plain words, and `obt rule validate`
  prints the chain as written above.

### Phase 2 — The three tests (learning period)
- **Tasks:** `packages/option-backtesting/research/bl164/specs.py` writes the three rule specs (H1, H2,
  H3) from one set of defines; `run.py` runs each through `study.run_test` on the learning period only
  and records them in the ledger (three tries); outputs under `research/bl164/out/` (git-ignored). A
  pilot on one month first, to look at the event list by hand (stand-down reasons, gap sign, the strike
  chosen) before the full run.
- **Deliverables:** `out/summary.csv` (one row per test), the event lists, the ledger rows.
- **Done when:** the three tests have a result or a recorded error.

### Phase 3 — Judge, confirm, write up
- **Tasks:** `research/bl164/judge.py` applies steps 1–4 (reveals at most three specs), prints the
  verdict; record it in the Log and Result; update `INDEX.md`, `TODO.md`, and the findings pages: a new
  family `research/options/strategies/gap-and-go/` (README, `band-and-gap.md`, `williams-backup.md`,
  `itm-strike-and-premium-stops.md`), cross-linked from `breakout/README.md`.
- **Done when:** the verdict is in the Log with its numbers, and the pages cite it.

## Risks

- **Parameters chosen on the data by the source:** the learning period overlaps the period the source
  most likely tuned on; the confirmation period (2022–24) is the real test, and a learning-period pass
  alone is not a verdict.
- **Fill and spread on a deep ITM weekly:** the quoted spread on ITM3 is wider than the ATM's; the 1%
  slippage row is the number to read, and a candidate that dies at 0.5% is recorded as such.
- **Thin Williams sample:** it trades only on stand-down days outside the 0.2–0.5% gap band; it may be
  thin (< 40 events) over two years, which is reported, not forced.
- **Grammar drift:** adding operators for one item grows the grammar; each is small, causal and tested,
  and `ever` and `prev_at` are general.

## Decisions (owner, 2026-10-25)

- Stops and the trail are judged on the option's 1-minute close, as published (Phase 1 adds `stop_on:
  close` to the engine).
- The 09:15 price is the 09:15 bar's open (`session_open`).
- Costs: BL-063 only; no row at the source's 0.1% a side.
- If H1 passes and the chain does not, the forward proposal is H1 alone (as registered).
- SENSEX: a separate, pre-registered item after a NIFTY pass, not part of BL-164.

## Log

- 2026-10-25 — created from the owner's request ("What do you think of the strategies? Let's do a POC");
  the published rules recorded in full, the assessment written, Phase 0 drafted. Nothing run, no code.
  Next: the owner's answers to the open questions, then Phase 1.
- 2026-10-25 — started. Owner's answers recorded under Decisions: close-checked stops as published
  (the engine gains `stop_on: close`; today only BL-156's research replay has one), 09:15 open, BL-063
  costs only, SENSEX as its own item later. TODO 3.10.43. Phase 1 begins.
- 2026-10-25 — **Phase 1 done** (nothing run on market data). `expr.py`: `prev_at`, `prev_agg`, `ever`,
  each in the causality test. Legwise: `trail_peak: {activate_percent, exit_percent}` (renamed from
  `pullback_percent`, which read as "falls by 80%"; bought legs only; reason TRAIL; with the SL on one
  tick-mode bar the higher level wins) and `stop_on: tick | close`, both off and out of the dump by
  default; the `.algtst` / Quantiply exporters refuse them. 1,719 package tests pass, legwise goldens
  unchanged, `ruletest-acceptance.py` ACCEPTANCE OK. `research/bl164/specs.py` writes the three specs;
  all validate and read back (H1 `b8c5d30f8f1b`, H2 `dcbd546a7420`, H3 `b7628a83dfe5`, first 12 of the
  spec hashes).
  **Definitions written out in the specs, registered here before any run:** "touched before the break"
  = a bar with low ≤ prev 15:15 close ≤ high whose first stamp is earlier than the break stamp; the
  stand-down minute is the opposite band's first break with no gap-direction break before it
  (`opposite_first`), or the gap-direction first break after a touch (`filled`), both within
  09:46–12:00; H2 fires from the stamp after it (window 09:47–14:29). H3's direction is the gap's on an
  H1 event, else the side of the Williams level the close is beyond; H3's trend-matched control takes a
  minute where the close is beyond either the band or the Williams level on the trade's side. Next:
  Phase 2's one-month pilot.
- 2026-10-25 — **Phase 2 pilot** (`research/bl164/pilot.py`, 2024-10-09 → 2024-11-08, 22 sessions,
  all usable; nothing in the ledger, no simulation cache written). The grammar's H1 / H2 / H3 stamps
  equal a plain-Python restatement of the rules on every session (0 mismatches; both written from the
  registered definitions, so this checks the implementation, not the reading of the source). Day
  reasons: H1 2, opposite_first 3, filled 3, no_break 3, and 11 stand-downs on 0.2–0.5% gap days
  (Williams skipped). Events: H1 2, H2 5, H3 7. Checked by hand: every strike is ITM3 of the nearest
  weekly (139–173 points in the money at the entry spot; 2024-11-07 the same-day expiry), stops fill
  at the 1-minute close below 70% of entry, the trail exits (TRAIL) at 80% of the closing peak, the
  time exit at 15:15. One month's gross is not read as evidence. Next: the full learning-period run of
  the three tests (three ledger tries).

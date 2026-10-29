# BL-186 — Directional: stop-and-reverse on a leg stop (buy the stopped option)

| | |
|---|---|
| **Priority** | P0 — the owner's call (2026-10-28) |
| **Status** | Done (2026-10-29): killed — no filtered reversal beats the plain exit; keep the plain leg stop. Amendment 1 (2026-10-29, owner's request): a cheaper ₹50 long, its stop and a re-sale toggle, pre-registered and run: all six cells killed, nothing changes |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-096 (the leg-stop sweep), BL-156 Amendment 1 (leg stops on tick, not the candle close) |
| **TODO.md row** | 3.10.47 |

## Context

Directional (Dir) sells a CE and a PE at the same strike with a 21% leg stop
(`legs[].stop_loss: { percent: 21 }`, in the live file and all 100 rotation bases;
[leg stop page](../research/options/strategies/directional/leg-sl.md)). Today a stopped leg just closes
(partial square-off), and RE COST ×1 may sell it again once if its price comes back to the entry.

Owner, 2026-10-28: "when a leg SL is hit we buy the options. i.e. if CE SL hit, CE buy is done." The leg
stop fires when the index has moved against that leg. On a real breakout the option just bought back
keeps expanding, so turning long at the stop would capture that tail instead of only cutting the loss.

The leg-wise engine cannot do this today: `reentry_on_sl` only sells the same leg again (`asap` or
`cost`), and none of the captured AlgoTest or Quantiply forms (`tests/fixtures/algtst/`,
`tests/fixtures/quantiply/`) has a reversing re-entry. Phase 1 adds it to the engine, off by default.

## Goal

A verdict, under rules fixed before the run, on whether a long bought on the stopped leg at the stop price
adds net ₹ a day to the Dir book after charges, against a plain exit, and under which filter and exit rule.

## Out of scope

- Live use: a conditional buy on the leg-stop fill in Quantiply or AlgoTest. Only after a verdict that keeps
  the idea, as its own item.
- Widesl and Buy picks; Dir legs only.
- A different strike or expiry for the long (it is the same contract that was just bought back).
- Changing the stored rotation results, the registered lists or `strategies/legwise/`.

## Plan

### Phase 0 — Pre-register
Filled in and committed **before any run** (owner's answers of 2026-10-28, see the Log). A rule is never
edited after a run: a new, dated rule supersedes it with a logged reason, and both stay here.
- **Hypothesis:** the long bought on a stopped Dir leg has a positive standalone expectancy after charges on
  trend days, and a filter at the stop removes enough whipsaw days for the Dir book to net more than a plain
  exit.
- **Universe and period:** the same picks and period as BL-156: T1's Adaptive picks, 2025-01-10 → 2026-10-22,
  1 lot a pick; only the Dir picks change (Widesl and Buy picks are carried unchanged so the book totals
  compare). Leg stops on tick (BL-156 Amendment 1). Net after brokerage, as BL-156; BL-063 statutory charges
  reported beside it, because a long adds premium bought.
- **Arms:**
  - **A. Baseline** — plain exit, at the overall stop of ₹5,000 (A5, the primary comparator) and at the live
    ₹3,000 (A3, reported beside it).
  - **B. Blanket reverse** — buy the same strike, same lots, at the stop fill, on every leg stop.
  - **C. Filtered reverse** — buy only if a confirmation holds at the stop minute; three filters, each its
    own arm:
    - **C1 opening-range break:** the index's last completed 5-minute close is beyond the 09:15–09:30 range
      on the side that stopped the leg (above the high for a stopped CE, below the low for a stopped PE).
    - **C2 VWAP side:** the index is beyond the session VWAP (from 09:15) on that side.
    - **C3 IV rising:** ATM IV at the stop minute is above its value at the pick's entry minute.
  - **D. Half size** — the primary arm at 0.5× lots. NIFTY and SENSEX lots are whole, so 0.5× is computed on
    paper as half of the long's 1-lot result and labelled as such.
- **The book:** the long counts toward the overall MTM stop, raised to **₹5,000** for every reversal arm
  (owner); a leg that has reversed is not sold again by RE COST (the reverse replaces the re-entry for that
  leg); legs that did not stop keep RE COST ×1 as today.
- **Exit rules for the long** (crossed with B to D; the long's own **30% stop** on its premium applies in
  every cell): a time stop at 20, 30 or 45 minutes; a trail (`trail_peak`: activate at 150% of the long's
  entry, exit at 80% of its highest); hold to the Dir exit time (15:28).
- **Primary comparisons:** C1, C2 and C3, each with the **30-minute time stop**, against A5, on the mean daily
  net of the Dir book; Holm over the three, 90% paired block-bootstrap intervals as BL-156. Every other cell
  is secondary and descriptive.
- **Look-ahead check:** every filter input comes from bars at or before the stop minute (the last *completed*
  5-minute bar, VWAP and IV through that minute); a test feeds a day with a later shock and checks the
  decision does not change.
- **Pass / kill rule:** the reversal leg is logged as its own trade. **Kill** if its standalone net ₹ a pick
  is ≤ 0 over the full period, **or** if the primary arm does not beat A on both net ₹ a day **and** maximum
  drawdown. Read with the stop rate, CVaR and the Ulcer index (the BL-096 convention).
- **Hold-out:** the last 3 months of the period (2026-07-23 → 2026-10-22), not read until the rest is
  reported and the primary arm is fixed.
- **Expiry days:** included in the main result; an expiry-days-excluded line is a secondary read.
- **Will not run:** other strikes or expiries for the long, Widesl legs, more than one reversal per leg a
  day, re-entry of the long after its own stop. Running one needs `override: <reason>` in the Log.

### Phase 1 — Engine: a leg that turns long on its stop
- **Tasks:** add an off-by-default leg option to `legwise/schema.py` (e.g. `reverse_on_sl` with `lots_ratio`
  and the long's own stop / time stop / trail), left out of the dump at its default so no strategy gets a new
  version (the `trail_peak` / `stop_on` convention); implement it in `legwise/engine.py` (the buy fills at the
  short's stop fill price; the long's own exits; its P&L in the leg's and the book's MTM, per the Phase 0
  answer); make `legwise/algtst.py` and `legwise/quantiply.py` refuse it by name until a platform form is
  captured.
- **Deliverables:** the option, unit tests (a hand-built day where the CE stops and the index runs on; a
  whipsaw day; the MTM interaction), and the 30 golden leg-wise scenarios unchanged.
- **Done when:** `uv run pytest` passes, `scripts/update-legwise-goldens.py` reports no change, and a stored
  T1 Dir day reproduces its stored result with the option off.

### Phase 2 — Run and report
- **Tasks:** `research/bl186/` script, run with **one worker process** (owner, 2026-10-28: overnight, one
  worker), that replays the T1 Dir picks for every arm × exit cell over the period
  (hold-out excluded until the end); per cell: book net ₹ a day, the reversal leg's standalone net ₹ a pick,
  worst day, maximum drawdown, stop rate, CVaR, Ulcer; then the hold-out for the primary arm.
- **Deliverables:** the result in this item's Log, a findings page under
  `research/options/strategies/directional/` (and its README row), `research/` pages updated in the same
  commit as the result.
- **Done when:** the registered verdict is written, with the hold-out read last.

## Result, main period (2026-10-29): killed — no reversal arm beats the plain exit

T1's Adaptive picks, 1 lot a pick, **2025-01-10 → 2026-07-22**: 375 days, 321 Dir pick-days (108 days with a
Dir pick on its own index's expiry). Net after ₹20 + GST an order. The A3 cell (each file as it is) reproduced
all 1,167 stored pick-day results of the period (0 mismatches; 1,345 of 1,345 with the hold-out). Leg stops on
tick, the overall stop at each bar's close (the engine).

**Primary comparisons** (each arm with the 30-minute time stop, the T1 book's mean daily net minus A5's; Holm
over the three at α 0.10):

| Arm | Book ₹ / day | − A5, 90% interval | p | Holm | Max drawdown | Long's net a Dir pick | Verdict |
|---|---|---|---|---|---|---|---|
| A5 (plain exit, ₹5,000) | +1,543 | — | | | −26,213 | — | comparator |
| A3 (plain exit, files' own stop) | +1,519 | −24 [−84, +33] | 0.57 | | −25,806 | — | reported |
| **C1** opening-range break | +1,588 | **+45 [−123, +226]** | 0.64 | no | −41,238 | **+104** | **killed** |
| **C2** VWAP side | +1,390 | **−153 [−393, +88]** | 0.30 | no | −46,036 | **+135** | **killed** |
| **C3** IV rising | +1,498 | **−45 [−206, +118]** | 0.64 | no | −32,763 | **+116** | **killed** |

**Verdict under the registered rule: kill.** The long's own net is positive in all three arms, but none beats
A5 on net a day (no interval clears zero, none passes Holm) and every one has a deeper maximum drawdown
(−₹32.8k to −₹46.0k against −₹26.2k). D (the same three at half size) is no better: −25, −220 and −114 a
day against A5.

Read with (main period; A5: +1,543 a day, CVaR −9,816, Ulcer 8,014, stop rate 3.7%):

| Cell | ₹ / day | Worst day | CVaR 95 | Ulcer | Stop rate | Reversals | Long's net a reversal | Long wins |
|---|---|---|---|---|---|---|---|---|
| C1_T30 | +1,588 | −14,396 | −10,273 | 9,671 | 6.2% | 145 | +230 | 46% |
| C2_T30 | +1,390 | −14,441 | −10,236 | 12,089 | 12.1% | 374 | +116 | 44% |
| C3_T30 | +1,498 | −14,160 | −9,474 | 9,130 | 8.1% | 173 | +216 | 43% |
| B_T30 (blanket) | +1,373 | −14,441 | −10,200 | 11,548 | 12.5% | 441 | +124 | 43% |

Secondary lines for the primary arms (− A5, ₹ / day, 90% interval):

| Arm | + BL-063 statutory charges | 1% slippage on the buy | Expiry days excluded |
|---|---|---|---|
| C1_T30 | +42 [−137, +216] | +10 [−162, +187] | +43 [−142, +252] |
| C2_T30 | −157 [−392, +88] | −239 [−475, −2] | −236 [−450, −28] |
| C3_T30 | −47 [−206, +113] | −84 [−246, +68] | −23 [−154, +116] |

**Where the money goes** (descriptive): the long itself earns (+₹89 to +₹145 a day across C1, C2, C3 and B
at 30 minutes), but the rest of the Dir book loses more: −₹44 (C1), −₹268 (C2), −₹144 (C3), −₹315 (B) a day.
Two things cost it: the reversed leg is no longer re-sold by RE COST, which today recovers many stops, and the
long's loss on a whipsaw (its 30% stop) pushes the book into the ₹5,000 stop, closing the surviving short leg
early (2025-06-03, `S_ditm1_0947`: +₹3,873 with a plain exit, −₹5,858 under C1).

**Secondary cells** (each against A5; none is a finding): no blanket (B) cell is positive (−170 to −302 a
day). The best is **C1 held to 15:28, +₹231 [−28, +491], p 0.17** (long +₹305 a Dir pick, max drawdown
−₹50.0k); C1's net rises with how long the long is held (T20 −7, T30 +45, T45 +53, trail +91, hold +231), and
so does its drawdown. C2's VWAP proxy and a plain TWAP give the same answer (−153 and −158). By half-year
(₹ / day, A5 → C1_T30): 2025H1 1,921 → 1,787; 2025H2 1,104 → 1,217; 2026H1 1,470 → 1,481; 2026H2 (16 days)
2,791 → 3,849.

**Evidence:** `packages/option-backtesting/research/bl186/`: `sar.py` (the arms and filters), `run.py`
(`simulate`, `report --period main|holdout`), `test_filters.py` (look-ahead, 66 cases); `out/main.json`,
`out/sims.jsonl`, `out/picks.json` (not committed; regenerate with `run.py simulate`, about 30 minutes with one
worker).

## Hold-out (2026-07-23 → 2026-10-22), read after the verdict above

56 days, 42 Dir pick-days; A3 reproduced all 178 stored pick-days. Descriptive: the verdict is the main
period's.

| Arm | Book ₹ / day | − A5, 90% interval | p | Max drawdown | Long's net a Dir pick | Reversals |
|---|---|---|---|---|---|---|
| A5 | +1,590 | — | | −24,293 | — | 0 |
| C1_T30 | +1,675 | +85 [−191, +411] | 0.71 | −29,166 | +6 | 18 |
| C2_T30 | +1,884 | +294 [−155, +816] | 0.31 | −31,654 | +350 | 45 |
| C3_T30 | +1,293 | −297 [−677, +16] | 0.12 | −33,796 | −270 | 26 |

- No arm is significant (Holm: none) and every one draws down deeper than A5, as in the main period.
- C2 turns positive and C3 negative over these 56 days: the signs move from one period to the next, which is
  what noise looks like. C3's long nets −₹270 a pick here; over the whole registered period (main + hold-out)
  it is still positive (+₹71), so the first kill clause does not fire for any arm over the full period.
- C1 held to 15:28 (the best secondary cell in the main period) is +₹342 a day here, long +₹338 a pick, with
  a max drawdown of −₹29.3k against −₹24.3k: still deeper.

## Risks

- A whipsaw costs about twice a plain stop (the stop loss, then the long's premium decay and its own stop),
  so B is expected to lose; the filter has to earn its place.
- The engine fills at the stop on 1-minute bars with no spread; a long bought in a fast move would fill
  worse live. Report a slippage line (e.g. 1% of premium on the buy).
- Expiry-day theta on a bought option is severe late in the day.
- Many cells (arms × exits) invite picking the best after the fact: hence one pre-registered primary
  comparison, Holm, and the hold-out.

## Open questions

None open; answered 2026-10-28 (Log).

## Log

- 2026-10-28 — created from the owner's idea; P0 at the owner's request. Asked for as BL-184; BL-184 and BL-185
  were already used by open work (PR 380's Directional split session, the `research/bl185-two-session-sweep`
  branch), so it is BL-186. Engine checked: no reversing re-entry exists (`reentry_on_sl` is `asap` / `cost`,
  same side), hence Phase 1. Claude's prior: blanket reverse negative, a filtered one worth measuring.
- 2026-10-28 — Phase 0 answered by the owner: filters — all three (opening-range break, VWAP side, IV rising),
  each pre-registered as its own arm C1 / C2 / C3; primary — C + a 30-minute time stop (so three primary
  comparisons, Holm); MTM — "Increase mtm to 5000": the long counts toward a ₹5,000 overall stop, and so that
  the reversal is not credited with the wider stop (BL-096 found ₹4,000 beating ₹3,000), the baseline is run at
  ₹5,000 too and is the primary comparator (₹3,000 reported beside it) — Claude's reading, recorded here; RE COST
  for a reversed leg: not re-sold (Claude's default, unopposed); expiry days included with an excluded line; the
  long's stop 30%, trail 150% / 80%, D halves the primary arm. To run overnight with one worker.
- 2026-10-28 — Phase 1 built (`legwise/schema.py` `reverse_on_sl`, `legwise/engine.py`; refused by name by
  `legwise/algtst.py` and `legwise/quantiply.py`): 7 engine tests (trend day, whipsaw, MTM, the long's 30%
  stop, time stop, trail with half size and a gapped stop, the filter hook), the 30 leg-wise goldens
  unchanged, the full suite green (1,823 passed), and stored T1 days re-simulated with the option off equal
  their stored results (the first 86 Dir pick-days of Phase 2's A3 cell, 343 pick-days in all, 0 mismatches;
  the full count is in the Result).
- 2026-10-28 — how Phase 2 reads the registered rules, written before any result was read (no rule changed;
  the engine and the data force these choices):
  - **Dir picks** are the `dir` and `ditm1` families, including T1's own Dir settings (`N_dir-t1s29`,
    `N_ditm1-t1s36`, `S_ditm1-t1s44`), each in its own file: their leg stops (40%, 20% and 15% with a trail),
    RE COST ×2 and ₹4,000 stops stay. **A3** is each pick's file as it is (₹3,000 for Core's Dir; ₹3,000 or
    ₹4,000 for T1's Dir settings); **A5** and every reversal arm set the overall stop to ₹5,000.
  - The long is bought on any SL fill of a sold Dir leg (a trailed SL too), at most once per leg a day. A stop
    the filter turns down arms RE COST as today, and a later stop of the re-sold leg is judged again.
  - **"At the stop minute"**: the stop fills inside bar m, so every filter reads bars that end at or before
    m − 1 (`research/bl186/sar.py`; `test_filters.py` shocks every bar from m on and checks that no decision
    changes, 66 cases).
  - **C1:** no 5-minute bar after 09:30 has closed yet = no reversal.
  - **C2 VWAP:** the index has no traded volume and 1-minute futures are in the lake only from 2026-09, so
    each minute's typical index price is weighted by that minute's traded volume of the stopped leg's expiry
    across the collected chain (a volume proxy). A plain time-weighted mean (`C2twap_T30`) is reported beside
    it, secondary.
  - **C3:** ATM IV from bar m − 1's closes vs bar entry − 1's (the closes the pick entered on); ATM = the
    collected strike nearest the index with both a call and a put, forward from put-call parity, Black-76 IV
    of the call (`trading_data.derived.implied_vol`); no solution at either end = no reversal.
  - **D:** the engine at `lots_ratio: 0.5` (a fractional quantity: the long's P&L and its weight in the
    ₹5,000 stop halved), for every filter × exit; "the primary arm at 0.5×" is D-C1/C2/C3_T30.
  - **Kill rule:** "beats A on net ₹ a day" = a positive mean difference significant under Holm (two-sided
    bootstrap p, 2,000 circular 5-session blocks, α 0.10); "on max drawdown" = a shallower maximum drawdown
    than A5. The long's standalone net is its P&L less ₹20 + GST on its two orders, per Dir pick-day.
  - **Lines:** statutory = BL-063's charges less its brokerage, on top of the ₹20 + GST an order; slippage =
    1% of the long's entry premium, taken off after the fact; expiry-excluded = the days a Dir pick trades
    on its own index's expiry (weekday label 0) dropped from both sides. Stop rate = the share of Dir
    pick-days whose overall MTM stop fired; CVaR = the mean of the worst 5% of days; Ulcer = the RMS of the
    rupee underwater curve (BL-096's definitions).
  - T1 only (the item's universe); Core is not run.
- 2026-10-29 — Phase 2 main period (2025-01-10 → 2026-07-22) run with one worker and read. **Primary verdict:
  kill.** C1, C2 and C3 with the 30-minute time stop against A5: +₹45 [−123, +226], −₹153 [−393, +88] and
  −₹45 [−206, +118] a day, none significant under Holm, and all three with a deeper maximum drawdown
  (−₹41.2k, −₹46.0k, −₹32.8k against −₹26.2k). The long's own net is positive (+₹104, +₹135, +₹116 a Dir
  pick), so the kill is on the second clause. Written and committed before the hold-out was read.
- 2026-10-29 — hold-out (2026-07-23 → 2026-10-22, 56 days) read after the primary verdict was committed:
  C1_T30 +₹85 [−191, +411], C2_T30 +₹294 [−155, +816], C3_T30 −₹297 [−677, +16] a day against A5; none
  significant, all with a deeper drawdown. The verdict stands: **killed**. Keep the plain leg stop (with
  RE COST); no live work follows. If the idea is ever revived, the descriptive lead is C1 held to the exit
  (main +₹231 [−28, +491], hold-out +₹342), which needs its own pre-registration and a drawdown answer. Item
  closed; findings in `research/options/strategies/directional/stop-and-reverse.md`.

## Amendment 1 (2026-10-29): a cheaper long (about ₹50 premium), the long's stop, a re-sale toggle

Written and committed **before any amendment cell is run**. Phase 0, the main-period result, the hold-out and the
**killed** verdict above are not edited; they stay the item's verdict whatever this amendment finds.

`override: owner asked 2026-10-29 to test a cheaper long (about ₹50 premium) and another long stop; Phase 0 had
listed other strikes for the long under 'Will not run'`

**Why.** The killed arms bought back the same contract, which by then is about 21% above its entry and decays
fast; the long itself earned (+₹104 to +₹135 a Dir pick) but the book lost more (a whipsawed long pushes it into
the ₹5,000 stop, and the reversed leg is not re-sold). A cheap long should lose less on a whipsaw. One narrow
test, not a new sweep. Claude's prior: a modest chance; the drawdown that killed C1 is mostly the
bought leg's size in the MTM and a cheaper long may not fix it.

**What changes.** Only the long's contract, its stop and the re-sale toggle. Everything else is BL-186's:
T1's Adaptive picks, Dir picks changed (Widesl and Buy carried), 1 lot, leg stops on tick, overall stop ₹5,000,
net after ₹20 + GST an order, the **C1 opening-range-break filter only** (the only arm that held up), the
comparator **A5**. No other filter, no other size, no trail, no 20 / 45-minute stop.

### Cells (6 new, all registered here; BL-186 simulated 43)

| Cell | The long | Its stop | Its exit |
|---|---|---|---|
| `L50_S30_T30` | ~₹50 strike | 30% | 30-minute time stop |
| `L50_S30_HOLD` | ~₹50 strike | 30% | held to 15:28 |
| `L50_S50_T30` | ~₹50 strike | 50% | 30-minute time stop |
| `L50_S50_HOLD` | ~₹50 strike | 50% | held to 15:28 |
| `R-<best>` | the best L50 cell above, **chosen on the main period only** (largest point-estimate book ₹ a day minus A5, 2025-01-10 → 2026-07-22) | as that cell | as that cell, **plus** RE COST re-sells the stopped leg after the long has closed |
| `R-C1_T30` | the same contract (BL-186's C1_T30) | 30% | 30-minute time stop, **plus** the re-sale |

Reference cells, **not re-run**, taken from BL-186's stored simulations (`out/sims.jsonl`): A5, `C1_T30`
(same contract, 30%, 30 minutes) and `C1_HOLD` (same contract, 30%, held to 15:28).

### Rules of the long (fixed now)

- **Which contract (L50).** At the stop minute m (the stopped sold leg's stop fills inside bar m), among the
  collected strikes of the stopped leg's **expiry and option type**, those with a price at m (`price_at(m)` =
  the close of bar m − 1; nothing from bar m on is read): pick the one **closest to ₹50**, an exact tie to the
  lower premium (the engine's closest-premium rule), if its price is within **₹35–₹70**. No strike in that
  band, or the pick is the stopped contract itself: **no reversal** (RE COST arms as for a plain stop; these
  days are counted and reported).
- **Fill.** At the picked contract's **close of bar m** (`price_at(m + 1)`), not at the pre-stop price: the
  stopped leg moved inside bar m and its option moved with it, so the earlier price would be optimistic. The
  long is judged from bar m + 1; its time stop is N minutes after that fill (m + 1 + N). No price at m + 1 (or
  m + 1 past the session) = no reversal, counted.
- **Size.** 1 lot of the same expiry (the stopped leg's lot size); `lots_ratio` 1.
- **The re-sale toggle.** The stopped leg arms RE COST as its file says (count as in the file), but it
  does not re-sell until the long has closed. A re-sold leg's later stop is not reversed again (one reversal a
  leg a day, as in BL-186).
- **The 1% slippage-on-the-buy, BL-063 statutory-charges and expiry-days-excluded lines** are reported for each
  cell as in BL-186.

### The primary measure and the family

- **Primary:** the T1 book's mean daily net ₹ (after ₹20 + GST an order) minus A5's, per cell; 90% paired
  circular block bootstrap (5-session blocks, 2,000 resamples, seed 20261028), two-sided p.
- **Holm family:** the nine primary comparisons against A5 now registered: BL-186's C1_T30, C2_T30, C3_T30 (their
  stored cells, recomputed on this amendment's period) and this amendment's six. α 0.10. The new cells are
  counted in the family; the family does not restart.
- **Ledger count:** 49 cells simulated across BL-186 and this amendment (43 + 6); nine primary comparisons.
  Cells of the original 43 that were secondary stay descriptive.

### Which data judges it (the hold-out is burnt)

The hold-out (2026-07-23 → 2026-10-22) was read for this idea in BL-186, so it cannot be an unseen test here.
**The amendment is judged on the full period, 2025-01-10 → 2026-10-22.** The main-period and hold-out figures are
reported beside it separately, the hold-out **labelled exploratory**. The "best" L50 cell is chosen on the main
period alone, before the toggle cell is run.

### Kill rule

A cell is **killed** unless all four hold over the full period:

1. the long's own net is above zero per Dir pick (after its two orders);
2. the book's mean daily net is above A5's and the difference is significant under Holm (nine comparisons);
3. its maximum drawdown is shallower than A5's;
4. the hold-out difference against A5 does not have the opposite sign to the full-period one (a sign flip kills).

The amendment's verdict is the best-cell verdict. **Even a cell that passes is only a lead:** the hold-out is
spent, so it needs a forward shadow (paper picks recorded before the open) before anything live, and the live
platforms have no form for a conditional buy on a stop fill. BL-186's verdict stays "killed".

### Engine (Phase 3, off by default)

`legs[].reverse_on_sl` gains `strike_premium` (the target premium; the band is 0.7× to 1.4× of it, ₹35–₹70 for
₹50) and `resell_after_reverse`. Neither changes the engine's behaviour when unset, they stay out of the dump at
their defaults, and the AlgoTest and Quantiply exports refuse them (they refuse `reverse_on_sl` already).

### Result (2026-10-29): all six cells killed

Run with one worker: four L50 cells over the main period (375 days, 96 s wall), the best chosen on it
(`L50_S50_HOLD`, +₹111 a day against A5, the largest of four), then the two toggle cells (94 s), then the
hold-out (8 s). Same data, picks, charges and bootstrap as the original result. The engine re-run with the
new options unset reproduced BL-186's stored `C1_T30` on 36 sampled Dir pick-days (0 differences). On
**363 Dir pick-days** (full period, 2025-01-10 → 2026-10-22; 431 days) the C1 filter allowed **168** stops in
the L50 cells, and **14** of them (8%) had no reversal because no strike priced ₹35–₹70 (or the closest was the
stopped contract); the other 154 reversed.

Full period, the judged one (A5: +₹1,549 a day, max drawdown −₹26,213, 3.3% of Dir pick-days stopped by the
overall stop). ₹ a day; "− A5" is the book's mean daily net minus A5's, 90% block-bootstrap interval; Holm over
the nine comparisons (α 0.10, smallest p 0.164 against 0.011 needed):

| Cell | Book ₹ / day | − A5 [90%] | p | Max drawdown | Long's net a Dir pick | Main − A5 | Hold-out − A5 (exploratory) |
|---|---|---|---|---|---|---|---|
| `L50_S30_T30` | +1,588 | +39 [−60, +135] | 0.48 | −36,184 | +41 | +34 | +67 |
| `L50_S30_HOLD` | +1,660 | +111 [−25, +249] | 0.18 | −38,202 | +131 | +101 | +177 |
| `L50_S50_T30` | +1,591 | +42 [−61, +137] | 0.50 | −36,184 | +43 | +39 | +58 |
| `L50_S50_HOLD` (best on main) | +1,682 | +133 [−24, +289] | 0.16 | −39,011 | +163 | +111 | +283 |
| `R-L50_S50_HOLD` (+ re-sale) | +1,661 | +112 [−36, +266] | 0.23 | −37,384 | +163 | +93 | +237 |
| `R-C1_T30` (same contract, + re-sale) | +1,643 | +94 [−44, +231] | 0.29 | −31,717 | +93 | +109 | −11 |
| *reference, not re-run:* `C1_T30` | +1,599 | +50 [−109, +205] | 0.60 | −41,238 | +93 | +45 | +85 |
| *reference:* `C1_HOLD` | +1,794 | +245 (not in the family) | | −49,987 | +309 | | |

**Kill rule, per cell (full period): every cell fails clause 2 (nothing is significant under Holm) and clause
3 (every drawdown is deeper than A5's −26,213).** Clause 1 (the long nets above zero) holds for all six, clause
4 (the hold-out sign) holds for five; `R-C1_T30`'s hold-out is −₹11 against +₹94 over the full period, a flip.
**Verdict: killed; no lead survives.** BL-186's verdict stands.

Read (descriptive, not new tests):

- **The cheap long does what was asked of it and it is not enough.** Against the same contract held to the exit
  (`C1_HOLD`: long +₹309 a pick, drawdown −₹50.0k), the ₹50 long earns less (+₹163) and draws down less
  (−₹39.0k), and its win rate is 28% to 42%. The book's drawdown is still ₹10k to ₹13k deeper
  than A5's: a reversal adds a leg to the MTM that a plain exit does not have, however cheap.
- **The long's own stop hardly matters:** `S30` and `S50` give the same book to within ₹3 a day at 30 minutes and
  ₹22 a day held (why was not investigated).
- **Holding to 15:28 beats 30 minutes in every pair** (+₹72 to +₹91 a day), as with the same-contract C1; and the
  extra drawdown grows with it (−₹36.2k → −₹38.2k / −₹39.0k).
- **The re-sale toggle** moves the same-contract cell the most (`R-C1_T30` +₹94 against `C1_T30` +₹50 a day,
  drawdown −₹31.7k against −₹41.2k, the shallowest of any reversal cell), but its hold-out difference is −₹11 and its
  drawdown is still deeper than A5's. On `L50_S50_HOLD` it lowers the net (+₹112 against +₹133).
- **The hold-out is burnt and all but one cell read positive there** (+₹58 to +₹283), which changes no verdict:
  nothing is significant over 56 days either, and the full-period figures are the registered ones.
- Counts: 49 cells simulated across BL-186 and this amendment (43 + 6); nine primary comparisons in the Holm
  family; the amendment's own hold-out was read once, after the main-period result and the best cell were fixed.

Evidence: `research/bl186/amend1.py` (`simulate`, `best`, `report --period main|holdout|full`, `parity`);
outputs `out/amend1.jsonl`, `out/amend1_{main,holdout,full,kill}.json` and `out/amend1_best.json` (not committed;
`amend1.py` reads BL-186's `out/sims.jsonl` and `out/picks.json`, so regenerate those first with `run.py
simulate`, about 30 minutes, then `amend1.py simulate`, about 4 minutes).

### Log

- 2026-10-29 — Amendment 1 pre-registered before any run, at the owner's request (the `override:` above).
- 2026-10-29 — Amendment 1 run (one worker, about 4 minutes in all) and read: **all six cells killed**. Full
  period, − A5 per day: +39, +111, +42, +133 (best on main), +112 with the re-sale, +94 for the same contract with
  the re-sale; none significant under Holm over nine (smallest p 0.16), every drawdown deeper than A5's; one
  hold-out sign flip (`R-C1_T30`). No lead; BL-186 stays killed. Also done with it: day forensics now lists the
  `<leg>_rev` trades as an attribution row (PR 382's review), and the run-time note above is corrected to the
  file times (about 30 minutes, not 70).

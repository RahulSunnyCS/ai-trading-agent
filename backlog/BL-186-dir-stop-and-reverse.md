# BL-186 — Directional: stop-and-reverse on a leg stop (buy the stopped option)

| | |
|---|---|
| **Priority** | P0 — the owner's call (2026-10-28) |
| **Status** | Done (2026-10-29): killed — no filtered reversal beats the plain exit; keep the plain leg stop |
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
`out/sims.jsonl`, `out/picks.json` (not committed; regenerate with `run.py simulate`, about 70 minutes with one
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

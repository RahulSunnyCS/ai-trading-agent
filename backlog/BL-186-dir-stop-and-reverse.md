# BL-186 — Directional: stop-and-reverse on a leg stop (buy the stopped option)

| | |
|---|---|
| **Priority** | P0 — the owner's call (2026-10-28) |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-096 (the leg-stop sweep), BL-156 Amendment 1 (leg stops on tick, not the candle close) |
| **TODO.md row** | — (filled in when started) |

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

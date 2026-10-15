# BL-111 — Switch the strategy mix by the range regime: more Dir when ranges are expanding, more Widesl when they are quiet

| | |
|---|---|
| **Priority** | P2 — owner's idea; builds on BL-110; a close cousin of BL-053 (killed) |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-110 (range persistence), BL-058 (the lists and their stored results) |
| **TODO.md row** | — |

## Context

Owner (2026-10-15, chat): "if there is a big range happening, then we can have either directional or
buy opportunities, which is better during the large-range thing. So if we are having six, we can
increase the directional up to three. And during non-directional, when the range contracts, maybe we
can switch to four or five wider (Widesl) sells."

What the repo already says:

- **BL-110 (as corrected in its review):** NIFTY's day range persists in both directions. Against
  the all-session average, the next day's range is about 0.14 of the baseline higher after an
  expanded session (range ≥ 1.25× the 20-session median) and 0.12 to 0.15 lower after a quiet one
  (≤ 0.80×), for several days. The coefficient on the previous range roughly halves once VIX is in
  the model (R² 0.17 → 0.28), so VIX carries part of it and the range keeps the rest.
- **BL-053 (killed):** a 10:00 VIX-move switch between 2 Dir + 2 Buy + 2 Widesl and 4 Widesl +
  1 Dir + 1 Buy beat each fixed mix by only +7.6% (needed 10%) with a worse drawdown, and most of
  its gain came from starting at 10:00, not from switching. Per lot, VIX-up days vs quiet days:
  Widesl ₹66 vs ₹241, Dir ₹453 vs ₹374, Buy −₹77 vs −₹17 (Buy lost on both).
- **BL-081 / BL-083:** triggers that find "more movement" suit Dir and Buy shapes and hurt
  short-volatility Widesl, but no hourly state variable passed, and the Dir lead is regime-dependent
  (from mid-2024).
- The lists already carry a VIX-band fit (20 to 24% of the score) and a days-to-expiry fit.

## Goal

An answer, on days not used to choose the rule, to two separate questions, at the owner's real
sizes (3 lots on ordinary days, 6 lots on expiry days):

1. **Lots by rank:** does splitting the lots 2-2-1-1 over the top four strategies (6 lots) or 2-1
   over the top two (3 lots) earn more, with no worse drawdown, than today's 3 strategies × 2 lots?
2. **Lots by range regime:** does moving lots between Dir and Widesl by the previous session's
   range state beat the same basket held fixed?

## Out of scope

- Any change to the live lists, weights or the journal (this recombines stored results).
- A new entry time (BL-053 showed a later start is a separate question).
- Buy as a lever (decision below). The list's own Buy add-on is left as the list makes it.
- Margin and cash: noted under Risks; sized in Phase 1 with the repo's margin model.

## Plan

### Phase 0 — Pre-register (draft: decisions below were taken by the assistant at the owner's
request, 2026-10-15; the owner can overrule any of them before a run)

**Decisions**

- **Directional lever = Dir only.** Buy lost on both quiet and expanding days in BL-053 (−₹77 vs
  −₹17 per lot) and would be given more lots on exactly the days it did worse. The owner first
  chose "Dir and Buy"; the later instruction was to decide, so this is the decision, with the
  reason.
- **Quiet-range mix: stage it, 4 Widesl lots first, 5 later.** The primary arm is 4 Widesl + 2
  Dir lots (the BL-053 quiet shape, so it can be compared). 5 Widesl + 1 Dir is reported as a
  second arm, descriptive only, and is the step to take only after the 4-lot step has held
  forward.
- **Sizes tested:** 3 lots and 6 lots, both reported, because the owner trades 3 on ordinary days
  and 6 on expiry days. An *expiry day* is a day the traded index expires (NIFTY basket: NIFTY
  expiry, label `dte_n = 0` on the weekday basis).

**Ladders (lots per ranked slot)**

| Size | Fixed ladder (question 1) | Expanded regime (question 2) | Quiet regime (question 2) |
|---|---|---|---|
| 6 lots | top 4 by the list's composite: 2, 2, 1, 1 | Dir#1 ×2, Widesl#1 ×2, Dir#2 ×1, Widesl#2 ×1 (3 Dir + 3 Widesl) | Widesl#1 ×2, Widesl#2 ×2, Dir#1 ×1, Dir#2 ×1 (4 Widesl + 2 Dir) |
| 3 lots | top 2 by composite: 2, 1 | Dir#1 ×2, Widesl#1 ×1 | Widesl#1 ×2, Dir#1 ×1 |

"Dir#k" and "Widesl#k" are the k-th highest-scoring variant of that kind under the list's own
composite on that day (the ranking the 09:16 job already computes); no new fit.

**Signal, known at 09:16:** `E = R_{t-1} / median(R over the 20 sessions before t-1)` from the
NIFTY index bars of the previous session (as BL-110). Expanded `E ≥ 1.25`; range-bound `E ≤ 0.80`;
otherwise normal (the list's own basket in the same ladder). Thresholds are BL-110's, not tuned.

**Hypotheses**

- H1 (question 1): the 2-2-1-1 / 2-1 ladder earns at least as much per lot as 3 × 2 with no
  deeper drawdown.
- H2 (question 2): the regime switch beats both the fixed split of the same size and the list's own
  basket.

**Controls:** the list's own 3 × 2 basket; the fixed 2-2-1-1 (2-1) ladder on the list's own top
ranks; always-expanded and always-quiet mixes; and a **placebo** in which the regime labels are
shuffled across days (500 shuffles) to check that the state matters at all.

**Data / periods:** stored per-variant, per-lot daily results. Rule fixed on 2025-01-10 →
2026-10-08 (already seen). Hold-out: **2022-04-05 → 2024-10-08 (P3, NIFTY only)**, unseen, read
once, only after this block is committed. If per-variant P3 results are not in the store they are
built from the lake with the same variant files before the rule is run.

**Look-ahead check:** the signal uses only the previous session; the ranking uses only results
before day `t`; the hold-out is untouched until the rule is committed.

**Pass / kill rule** (each of H1 and H2 on the hold-out, at each size, expiry days and ordinary
days reported separately): pass only if the arm beats its comparators in total gross ₹ by at least
10% with maximum drawdown no worse, and (H2) beats the median placebo shuffle. A pass at one size
only is reported as such, not generalised. Otherwise killed.

**Will not run:** other thresholds or ladders, 2-day or VIX-based signals, intraday signals, Buy
as a lever, the 5 Widesl arm as a decision arm. Each needs a new dated block and `override:`.

## Risks

- **BL-053 is a close precedent that failed** on a similar switch; the previous day's range is
  information VIX largely carries (BL-110: the coefficient on the range roughly halves with VIX
  in the model, R² rises 0.17 to 0.28).
- **Both sides have support, but only the expanded side has a precedent of failing.** BL-110
  reviewed: after a quiet session the next day's range is lower than after an average session
  (about −0.12 to −0.15 of the baseline), so quiet persists too; but "lower range" does not by
  itself mean Widesl earns more.
- **Dir's edge appears only from mid-2024** (BL-083); a 2022-24 hold-out may not have it.
- **Cash.** Widesl is short premium: its margin per lot is larger than a long Dir. A switch toward
  4 to 5 Widesl lots raises margin on quiet days. Phase 1 reports peak margin per day with the
  repo's margin model, and a rule that does not fit the owner's cash is not usable whatever it
  earns.
- **Small samples.** Expanded days are about 30% of sessions, expiry days about 1 in 5; at 6 lots
  on expiry days only, the hold-out has on the order of 120 days.

## Open questions

None blocking. The owner may overrule the decisions above; the signal and thresholds are the
BL-110 ones.

## Log

- 2026-10-15 — created from the owner's chat idea; drafted against BL-110 and BL-053.
- 2026-10-15 — owner clarified: today's live basket is 3 strategies × 2 lots; the owner meant
  splitting the 6 lots as 2-2-1-1 (top two get 2 lots, next two get 1), and trades 3 lots on
  ordinary days and 6 lots on expiry days because of cash. Asked the assistant to take the
  decisions and to stage the quiet mix "four, then five". Decisions recorded in Phase 0.


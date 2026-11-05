# BL-212 — Dir ×2 only when the Dir's score is high: a gate on the fourth lot

| | |
|---|---|
| **Priority** | P2 — research; the owner's question of 2026-11-05, answered once over the last two years |
| **Status** | Done — killed by the registered rule (Phase 1, 2026-11-05); the VIX rule is a lead, not a finding |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-05 |
| **Depends on** | BL-204 / BL-207's book replay, BL-210's confidence definition, the T1 track (BL-113) |
| **TODO.md row** | 3.10.62 |

## Context

T1's fourth lot is the Dir pick doubled on a non-expiry day (BL-133 A2, live as BL-183's per-row
toggle). At two copies of T1 that is four Dir lots, and a bad Dir day is four times its ₹3,000–4,000
MTM stop on the Dir alone, ₹16k before the Widesl. Owner, 2026-11-05: "the gate need not beat Dir
×2 always … I was thinking to put the second Dir only whenever we can, so it can reduce the CAGR,
but it should also reduce the drawdown." Take the second Dir lot only on days the Dir pick's own
score is high; otherwise 1 Dir + 2 Widesl. "Not only when the directional score is in the top
half, maybe the top third also; different measurements you should test, and let me know."

What exists: BL-210 defined and tested an absolute confidence for the basket (killed as a
predictor of the basket's day, ρ ≈ 0.08; the per-pick figure it set aside is what a Dir gate
needs). BL-204 and BL-207 replay T1's books under the book stop (`research/bl207/dir_spacing.py`:
Dir ×2 = N4, stop ₹9k + the Dir's MTM SL). BL-207 found every spaced second Dir lot earns less
than Dir ×2 with no smaller drawdown.

## Goal

Over the last two years, know whether a causal gate on the Dir pick's score keeps most of Dir
×2's extra return over Dir ×1 while shedding most of its extra drawdown, for several predictors
and thresholds, so the owner can decide whether a gate is worth running. Nothing changes in the
product.

## Out of scope

- Any change to the picks, the lot plans, the exports or the messages.
- A per-order or intraday gate; the gate is decided at 16:00 the evening before on the expected
  picks (AlgoTest trades the evening list), so every predictor reads data to the previous close.
- A gate for the Widesl lots, or for Core.

## Plan

### Phase 0 — Pre-register
Committed before any run (2026-11-05).

- **Hypothesis:** the Dir pick's bad days cluster where its own score is low, so a book that takes
  the second Dir lot only when the score is in its upper part keeps most of ×2's extra net over
  ×1 and takes on less than half of ×2's extra drawdown.
- **Book and days:** T1's list C (Core-298 + `strategies/rotation_t1/`), picks re-derived as live
  (`pick._rank`, the expiring-index filter, the SL150 % cap), exactly as BL-207's `run`; the
  normal days with a Dir pick only (an expiry day or a three-Widesl day has no second Dir lot).
  2025-01-10 → the run day. Net = gross under the book stop at 0 % slippage − brokerage (₹20 × 1.18
  per trade per leg pair, as BL-204/207); second reading `net_slip` = the 0.5 % slippage stored
  nets × lots − brokerage, no book stop.
- **Arms:**
  - `x1`: 2 Widesl + 1 Dir, book stop ₹9,000.
  - `x2`: 2 Widesl + 2 Dir, book stop ₹9,000 + the Dir's MTM SL (BL-207's N4, what runs today).
  - `gate(p, q)`: `x2`'s book on a day predictor p is at or above its trailing q-quantile, `x1`'s
    book otherwise.
- **Predictors** (every one reads only days before D):
  - `conf`: the Dir pick's own BL-210 confidence (blend of win rate and ₹/lot on list C's matched
    days and windows; the one-variant basket), from its own stored history. SCALE ₹3,000 as
    registered there, so the figure is BL-210's with one pick.
  - `rank`: the Dir pick's composite percentile among the 521 variants that day
    (`score.pct_rank` of list C's composite).
  - `dirwin`: the Dir pick's share of positive days over its last 21 stored days.
  - `vix`: the day's VIX open at or below 15 (the three lowest bands), no quantile; one dumb
    rule beside the scored ones.
- **Thresholds:** for `conf`, `rank` and `dirwin`, the trailing quantile of that predictor's own
  values over the previous 250 trading days that had a Dir pick (at least 63 of them, else the gate
  is on, i.e. `x2`), at **50 %, 67 % and 75 %** (the owner's "top half", "top third", and one
  more). Trailing, so every gate is one the 16:00 run could have applied. 3 × 3 + 1 = 10 gate arms,
  declared here; no other threshold or predictor is run.
- **Primary arm:** `gate(conf, 50 %)`. The others are reported, descriptive.
- **Statistics,** per arm, on the whole period, the two halves (fit ≤ 2025-10-08, test after, the
  BL-202/207 split) and the last year: days on, net per day, total, max drawdown, worst day, worst
  week, book-stop days; the *extra net kept* = mean(arm − x1) / mean(x2 − x1); the *extra drawdown
  taken* = (DD(arm) − DD(x1)) / (DD(x2) − DD(x1)), and the same for the worst day; mean(arm − x1)
  with a 5-day block-bootstrap 90 % interval (2,000 resamples, seed 20261105).
- **Pass / kill rule** (the primary arm, all days): *pass* when extra net kept ≥ 0.5 with
  mean(arm − x1)'s interval above zero, extra drawdown taken ≤ 0.5 and extra worst day taken ≤ 0.5,
  and the test half shows the same signs (kept > 0, taken < 1). *Kill* otherwise. A pass of another
  arm is a lead for its own item, never this item's verdict.
- **Look-ahead check:** picks and predictors use rows strictly before D (`rec.values[:i]`, as
  BL-207); the quantile is over earlier days' predictor values only; the day's own result is read
  after the book is chosen. The script asserts the predictor of day D does not change when the
  results of D or later are removed (spot-checked on 20 random days).
- **Hold-out:** the test half (2025-10-09 →) reported beside the fit half; no fitting is done on
  either (all thresholds are declared), so the halves are a stability check, not a tune-and-test.
- **Will not run:** other thresholds, other predictors, a Widesl gate, a gate on Core, a trailing
  window other than 250 days, or a book stop other than BL-204's. Running one needs `override:
  <reason>` in the Log.

### Phase 1 — The test
- **Tasks:** `research/common/confidence.py` (BL-210's blend and matched-day confidence, moved so
  two items share it; `research/bl210/confidence.py` imports it and its 2026-11-05 output is
  checked unchanged), `research/bl212/dir_gate.py` (BL-207's replay with the arms above), its
  results JSON, the verdict here, and `research/options/common/dir-second-lot-gate.md`.
- **Done when:** the verdict and the table of every arm over every window are written here.
- **Result (2026-11-05, `research/bl212/dir_gate_2026-11-05.json`): killed.** 220 normal days with
  a Dir pick, 2025-01-10 → 2026-11-04 (187 expiry days, 33 three-Widesl days left out; the first 63
  Dir days are the trailing gates' warm-up, gate on). Net under the book stop, 0 % slippage:

  | Arm (all 220 days) | On | ₹/day | Max DD | Worst day | Worst week | Extra net kept | Extra DD taken | Extra worst day taken | vs ×1 [90 %] |
  |---|---|---|---|---|---|---|---|---|---|
  | ×1 | — | +829 | −40,047 | −9,513 | −21,405 | — | — | — | — |
  | ×2 (live) | — | +1,363 | −47,455 | −14,130 | −30,610 | — | — | — | +534 [+235, +812] |
  | **conf @ 50 % (primary)** | 65 % | +1,094 | −47,455 | −14,130 | −30,610 | 0.50 | 1.00 | 1.00 | +264 [+27, +491] |
  | conf @ 67 % | 51 % | +928 | −47,455 | −14,130 | −30,610 | 0.18 | 1.00 | 1.00 | +98 [−95, +287] |
  | conf @ 75 % | 46 % | +906 | −47,455 | −14,130 | −30,610 | 0.14 | 1.00 | 1.00 | +76 [−105, +264] |
  | rank @ 50 / 67 / 75 % | 93 % | +1,265 | −47,455 | −14,130 | −30,610 | 0.82 | 1.00 | 1.00 | +436 [+153, +711] |
  | dirwin @ 50 % | 77 % | +1,137 | −47,455 | −14,130 | −30,610 | 0.58 | 1.00 | 1.00 | +308 [+55, +555] |
  | dirwin @ 67 % | 66 % | +1,071 | −47,455 | −14,130 | −30,610 | 0.45 | 1.00 | 1.00 | +242 [+14, +475] |
  | dirwin @ 75 % | 64 % | +1,081 | −47,455 | −14,130 | −30,610 | 0.47 | 1.00 | 1.00 | +252 [+31, +467] |
  | VIX ≤ 15 | 69 % | +1,222 | −37,568 | −14,130 | −25,354 | 0.74 | −0.33 | 1.00 | +392 [+163, +622] |

  Test half (2025-10-10 →, 129 days; ×1 +1,327/day DD −21,405 worst −9,498; ×2 +2,074 DD −28,272
  worst −13,845): conf @ 50 % kept 0.52, took 0.25 of the extra DD and 1.00 of the extra worst day;
  conf @ 67 / 75 % kept 0.18 / 0.13 and took 0.06 and 0.00 (they are ×1 with the lot on a third of the
  days); dirwin @ 50 % kept 0.59, took 0.53 / 1.00; dirwin @ 75 % kept 0.51, took 0.77 / 0.39; VIX kept
  0.70, took **1.20** of the extra DD (−29,621, deeper than ×2 in this window) and 0.25 of the worst
  day. The 0.5 % slippage reading without the stop orders the arms the same way.

  Primary arm's checks: kept ≥ 0.5 — no (0.50 rounds to 0.4996); vs ×1 above zero — yes; DD taken
  ≤ 0.5 — no; worst day taken ≤ 0.5 — no; test-half signs — yes. **Killed.**

  Reading: (1) **no scored gate avoided the worst Dir day**: at every 50 % threshold, and for every
  gate over all days, the second lot was ON on the −₹14,130 day and on the −₹30,610 week; the Dir's
  own recent record said nothing about them. (2) The confidence and win-rate gates behave like a
  dimmer: they shed return and drawdown in about the same proportion (conf @ 50 % on the test half:
  0.52 of the return, 0.25 of the drawdown but all of the worst day), which is what a weak predictor
  looks like. (3) `rank` is unusable as a gate: a picked Dir is in the top percentile by construction,
  so its trailing quantile gates are on 89–99 % of days. (4) **The VIX rule is the one lead**: over all
  days it kept 74 % of the extra return with a max drawdown *smaller than ×1's* (it was off through
  April–May 2025, where the ×1 and ×2 drawdowns came from) and a shallower worst week; but in the test
  half it was deeper than ×2 (one episode in 2026 came at a low VIX), and it never dodged the worst day.
  One episode decides its drawdown figure, so it is a lead for its own pre-registered item
  (a VIX-conditioned second lot, with the warm-up question moot since it needs none), not a finding.
  (5) The warm-up matters for every trailing gate: the biggest drawdown of the period (Jan–May 2025)
  falls inside the 63 days they are forced on, so their all-days drawdown figures equal ×2's by
  construction; the test half is the fair window for them, and there none took less than a quarter of
  the extra drawdown while keeping half the return.

### Phase 2 — Only on a pass
- A shadow line beside the lot plans (BL-135's pattern) for 60 forward days, then, as its own item,
  a per-row setting in Settings › Automation and the export's `dir_boost` reading it.

## Risks

- **A weak predictor:** BL-210's basket figure barely correlated with the day (ρ ≈ 0.08); the
  Dir's own figure may do no better, in which case the gate sheds return and drawdown in the same
  proportion and fails the rule honestly.
- **Few bad Dir days:** the drawdown comes from a handful of days; a gate that misses them by one
  day looks no better than ×2. The worst-day and worst-week columns show this.
- **In-sample universe,** as every rotation item: the T1 variants were chosen on this history.

## Open questions

Answered 2026-11-05 (owner): the aim is drawdown, not net; test several thresholds (top half, top
third, more) and several measurements; report, do not build.

## Log

- 2026-11-05 — created from the owner's question; Phase 0 registered.
- 2026-11-05 — Phase 1 run once (the ten declared arms, no sweep): killed; table and reading above,
  page `research/options/common/dir-second-lot-gate.md`. The VIX ≤ 15 rule is noted as a lead for
  a new item. BL-210's confidence moved to `research/common/pick_confidence.py` (BL-210's output
  re-run and unchanged).

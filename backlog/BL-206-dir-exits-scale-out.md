# BL-206 — Directional exits, wide: per-leg targets, profit lock and trail, and a two-lot scale-out, on the Dir settings Adaptive picks, at 0.5 % slippage

| | |
|---|---|
| **Priority** | P2 — the owner's ask of 2026-11-04 after a Dir day that went to about ₹3,000 a lot and gave it back; most of the ground is already covered by BL-105 (killed) and BL-096, so the value is in the parts those did not reach: per-leg targets, the scale-out at two lots, T1's Dir settings and slippage |
| **Status** | Planned — Phase 0 drafted 2026-11-04, waiting for the owner's answers to the open questions before anything runs |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-04 |
| **Depends on** | BL-104 / BL-202 (the runner, scorer and plateau machinery), BL-105 (the per-strategy profit-rule results this extends), BL-183 (Dir ×2 days: the scale-out is only meaningful at two lots) |
| **TODO.md row** | — |

## Context

The owner (2026-11-04): *"on our directional, check if any target or TSL or lock and TSL or lock
profit will have impact; make it very wide and try all of the things; or if we are putting two lots,
one lot can have a target. Today it went up to about ₹2,500 and then came down."* That day T1's
`S_dir_ITM1` (SL15 % · TSL10 %/5 % · RECOST2 · MTMSL4000, 3 lots live) peaked at about +₹3,296 a lot
around 09:54 on the Live board, still stood at +₹3,214 at 10:58, and closed at −₹3,560 a lot (the close
is known only after this draft's first commit at 11:02 IST). The day is outside the registered window,
which ends 2026-11-03.

What the repo already knows (findings pages under `research/options/strategies/directional/`):

- **Profit target, lock and lock-and-trail on the day's profit, per strategy — tested and killed
  ([BL-105][bl105], 2026-10-15; [profit-lock.md](../research/options/strategies/directional/profit-lock.md)).**
  On ATM / ITM1 / ITM2 bases with and without a 10/5 leg trail, seven slots, both indices,
  2024-10-09 → 2026-10-09, after charges, 1 lot, mean change against the same strategy without the rule
  in ₹ per lot-day:

  | Rule | NIFTY ₹2k / 3k / 4k | SENSEX ₹2k / 3k / 4k |
  |---|---|---|
  | Target | −79 / −35 / −10 | −103 / −16 / −2 |
  | Lock at half | −15 / −1 / +5 | −25 / −2 / −3 |
  | Lock and trail | −17 / +2 / +5 | −28 / −2 / −2 |

  A one-lot day reaches ₹2,000 of open profit on 31–41 % of days, ₹3,000 on 16–28 %, ₹4,000 on 8–18 %,
  so the rules rarely act, and cutting at a target gives up the decay that is the strategy's profit.
- **The leg trail ([BL-096][bl096], [trail.md](../research/options/strategies/directional/trail.md)):**
  descriptive, one hold-out year; helps only with a 30 % leg stop (₹170 → ₹187 a day), mixed elsewhere.
- **A lock on a morning-closed Dir ([BL-184][bl184] E2):** the one lead, its own registration; not this item.
- **Early exits:** 14:55 hurts on every Dir family ([BL-147][bl147]); 15:28 is the best exit after charges.
- **Not tested anywhere:** a **per-leg target** (buy a sold leg back once its premium has fallen by X %
  from its entry, `legs[].target: {percent: X}`: the engine's distance is entry × X %; BL-104's Dir grid had no target axis, only Buy's did); the **scale-out**
  (two lots, one managed and one plain: BL-183 trades the Dir at two lots on non-expiry days; BL-207 tests
  the second lot entered later, BL-204 runs the Dir at three lots and more on some days); profit rules on
  **T1's own Dir settings** (`N_dir-t1s29`: ATM, SL 40 %, RECOST ×2, MTM ₹3,000; `N_ditm1-t1s36`: ITM1, the
  T1 journal picked it twice; `S_ditm1-t1s44`: ITM1, SL 15 %, trail 10/5 %, RECOST ×2, MTM ₹4,000);
  anything under **slippage**; arm levels above ₹4,000.

Why the scale-out is largely derivable: a two-lot book of one managed lot and one plain lot earns, per
lot, the mean of the managed and the plain one-lot results, so BL-105's −₹35 a lot-day at a ₹3,000 target
becomes about −₹17 a lot-day on the two-lot book. It only beats the plain book if the managed lot does,
unless the rule on the running lot changes once the first lot is out (a lock armed by the first lot's
target), which is the one genuinely new combination here.

## Goal

A registered answer to: does any exit rule on the Dir, alone or on one of two lots, beat the plain
strategy on the unseen half after charges and 0.5 % slippage, without a deeper drawdown? The answer
updates `profit-lock.md`, `trail.md`, a new `leg-target.md` and a new `scale-out.md`, and, if anything
passes, becomes a T1 setting variant for the owner to consider (the frozen T1 files are never edited).

## Out of scope

- Leg stops, strikes, entry and exit times, re-entry counts (BL-096, BL-104, BL-147, BL-181).
- The portfolio (book) stop and locks on the whole basket (BL-095, BL-194).
- The morning-closed Dir lock (BL-184 E2's lead): its own item.
- Any change to the live or T1 files from this item's results.

## Plan

### Phase 0 — Pre-register

Committed before any run. A rule is never edited after a run: a new, dated rule supersedes it with a
logged reason, and both stay here.

- **Hypothesis.** No exit rule on the Dir beats the plain strategy after charges and slippage: targets
  and per-leg targets lose the decay that is the profit, locks and trails rarely act. Expected direction
  per axis: per-leg target negative at 30 and 50 %, near zero at 70 %; leg trail near zero except with
  wide leg stops; overall target negative, smaller at higher levels; lock and lock-and-trail near zero on
  net, drawdown slightly shallower; the scale-out half of the managed lot's effect; the armed-lock
  scale-out the only open question.
- **Bases.** The Dir settings Adaptive actually picks, at every rotation slot: Core-298's `N_dir`,
  `N_ditm1`, `S_dir`, `S_ditm1` and T1's `N_dir-t1s29`, `N_ditm1-t1s36`, `S_ditm1-t1s44`, 25 slots
  each (175 bases; T1's pick pool also holds Core's files, and its journal picked Core's `S_dir` once),
  loaded as they are; a cell changes only the axes below, symmetrically on both legs.
- **Axes (one family, full product per base; the exact cell list and its SHA committed before the
  run, as `research/bl202/grid.py` does).**

  | Axis | Values | Engine field |
  |---|---|---|
  | Per-leg target (bought back once the premium has fallen by X % from entry) | none, 30, 50, 70 | `legs[].target: {percent: X}`, `reentry_on_target` unset |
  | Leg trail | as the file, none, [10, 5] %, [15, 10] % | `legs[].trail_sl` (needs the file's stop) |
  | Overall target (₹ a lot) | none, 2,000, 3,000, 4,000, 6,000 | `overall.target_inr` |
  | Lock (arm → floor, ₹ a lot) | none, 2k→1k, 3k→1.5k, 4k→2k, 6k→3k | replayed on the engine's per-minute path (`rotation/portfolio.apply_book`, `lock:A,B`) |
  | Lock and trail (arm, floor, then +X of profit raises the floor by Y) | none, (3k, 1.5k, 1k, 0.5k), (4k, 2k, 1k, 0.5k), (6k, 3k, 1k, 0.5k) | `locktrail:A,B,X,Y` on the same path |
  | Scale-out (two lots) | none; lot A takes {overall target T, lock L} from the rows above and lot B runs plain; lot A takes T and lot B switches to lock-and-trail (4k, 2k, 1k, 0.5k) once A is out | composed from the one-lot paths: book = A + B, the overall stop on the book at 2 × the file's |

  Overall target and lock / lock-and-trail are mutually exclusive in one cell (one rule on the day's
  profit). A cell whose per-leg target is below its leg trail's first step is kept (they can both act).
  The overall stop, re-entry and exit stay the file's. Levels are rupees per lot for one lot; for the
  two-lot rows, per lot of the managed lot.
- **Window and halves.** 2024-10-09 → 2026-11-03 (the collected days; 504 NIFTY sessions). Fit half
  through 2025-10-08, test half after it, as BL-202. T1's three bases were chosen by BL-113 on the fit
  half.
- **What the test half has already seen (it is not blind for every axis).** BL-105 scored the overall
  target, lock and lock-and-trail at ₹2k / 3k / 4k on Core's Dir bases over 2024-10-09 → 2026-10-09;
  BL-184 E2 replayed locks to 2026-10-27; BL-096's trail hold-out year lies inside the test half. So, as
  BL-202 words it: a pass on the overall-target, lock, lock-and-trail or leg-trail axes **for Core's bases**
  is only a candidate for the forward journal, never a finding. Only the per-leg target, the scale-out and
  the three T1 bases are blind on the test half.
- **Costs.** The BL-096 charge model (brokerage ₹20 an order, STT, exchange, SEBI, stamp, GST) and
  0.5 % adverse slippage on every fill (the dashboard's and Telegram's paper basis, owner 2026-10-30)
  inside the cell; 0 % and 1 % beside for the finalists only.
- **Look-ahead check.** Every rule reads only the day's own path up to the minute it acts; the
  lock replay is checked against the engine's own `overall.target_inr` exit on 100 random cell-days
  (0 mismatches required, as BL-105 did with 75). A regression anchor: every base at
  "none" on every axis reproduces its stored rotation result to the rupee at 0 % slippage.
- **Scoring.** Per base and cell, paired against the base's plain cell: the mean difference in ₹ per
  lot-day on the test half with a 90 % block-bootstrap interval (5-day circular blocks, 2,000 resamples,
  seed 20261104; `research/bl202/score.py`'s machinery), the drawdown change, and the share of days the
  rule acted. Pooled per axis value over all bases (A: breadth) and over Adaptive's recorded Dir pick-days
  of each book from 2025-01-10 (B: the picks, through the journal; re-scored days labelled).
- **Pass rule (an axis value or a scale-out row passes only if ALL hold on the test half).** (1) pooled
  lower bound of managed − plain > 0 over A and over B; (2) max drawdown per lot no deeper than plain on
  both pools; (3) the fit half agrees in sign; (4) it acts on at least 10 % of days (a rule that never
  acts is not a finding); (5) the sign holds on at least 70 % of bases (slots × settings); (6) the
  0 % and 1 % reruns keep the sign. Anything else is killed; a value that passes becomes a T1 setting
  variant proposal in the Log, never an edit of a live file.
- **Hold-out.** The test half (2025-10-09 → 2026-11-03) is scored once, for every cell at once, after
  the fit-half tables are in the Log; no cell is chosen on it. There is no second hold-out. Within it,
  only the axes and bases named blind above can give a finding.
- **Will not run.** Leg stops, strikes, slots, exits, re-entry (done elsewhere); rules on the whole
  basket; a target or lock on the Widesl family; any level not in the table. Running one needs
  `override: <reason>` in the Log.

### Phase 1 — Harness and anchor
- **Tasks:** `research/bl206/grid.py` (bases, axes, cells, SHA; a unit test holds the counts),
  `run_grid.py` (BL-202's runner over the Dir files with the per-minute path kept for the lock replay),
  `locks.py` (the lock / lock-and-trail / scale-out composition over the paths, checked against the
  engine's target exit), `score.py` (paired tables). The regression anchor at 0 %.
- **Deliverables:** the committed cell list and SHA; the anchor's 0-mismatch line in the Log.
- **Done when:** every base reproduces its stored result at "none" and the lock replay matches the
  engine's target exit on 100 random cell-days.

### Phase 2 — Fit half
- **Tasks:** run every cell; per-axis tables and the scale-out rows on the fit half; the Log entry.
- **Done when:** the fit-half tables are committed before any test-half figure exists.

### Phase 3 — Test half and verdict
- **Tasks:** score the test half for every cell at once; 0 % and 1 % reruns of anything that passed;
  findings pages (`profit-lock.md`, `trail.md`, new `leg-target.md`, new `scale-out.md`, the README
  table); the verdict in the Log; a T1 setting variant proposal if anything passed.
- **Done when:** the pages cite this item and `INDEX.md` says Done with the one-line verdict.

## Risks

- **Most of it is a re-test with a different costing.** BL-105's answer may simply repeat; the item
  is still worth its one run because the scale-out and the per-leg target are new and the owner trades
  the Dir at two lots now.
- **Many cells, one hold-out.** The per-axis pooling and the plateau-style "share of bases" rule keep
  a single lucky cell from passing, but they are not a multiple-testing correction: one is still to be
  registered (open question 9), and a pooled figure is not a deflated one.
- **Lock replay on 1-minute closes** overshoots fast days (BL-066, BL-156); the live platforms watch
  ticks, so a lock that passes by a hair is not a finding.

## Open questions

1. **Bases:** Core's four Dir settings and T1's two, as above, or T1's two only (the lists that carry
   money)?
2. **Slippage basis:** 0.5 % inside the cell (the paper basis) with 0 % and 1 % beside, or 1 % as BL-202?
3. **Levels:** the rupee lists above are per lot at one lot; confirm them, or name the ones you watch
   (today's ₹2,500 would sit between the 2k and 3k arms).
4. **The scale-out's second lot:** plain, or lock-and-trail armed once the first lot is out (both are
   registered above; strike one if you want fewer cells).
5. **What counts as a win:** net per lot-day with no deeper drawdown (registered), or would a smaller
   drawdown at the same net be enough for you to trade it?
6. **Run slot:** overnight on the Mac after the 21:00 jobs (BL-202's Stage 1 took three hours on two
   workers; this grid is of the same order), or a quiet weekend.

Questions 7–11 came from the code review of 2026-11-04. Each leaves a choice that could otherwise be made
after seeing results, so Phase 0 is not complete, and nothing runs, until each has a registered answer.
The review's proposed answer is beside each.

7. **The scale-out's construction.** A "2 × book stop" cannot be built from one-lot paths that already
   carry the file's 1× stop; what stop lot B runs under after lot A exits is not said; Context arms B's
   lock by A's target while the table arms it at a fixed ₹4k; whether the scale-out rows cross the
   per-leg target and leg-trail axes is not said. *Proposed:* two one-lot strategies, each under the
   file's own 1× stop, summed (exact, and deployable on AlgoTest / Quantiply as two strategies); B's lock
   armed at A's exit minute; scale-out rows not crossed with the leg axes; an anchor that "none" on both
   lots equals 2 × the one-lot result to the rupee.
8. **The pools.** The pooled series and pool A's drawdown series have no formula, and the journals start
   2026-10-12 (Core) and 2026-10-19 (T1), so pool B's picks before then are reconstructed, not recorded.
   *Proposed:* pool A = the mean over bases of each day's paired difference; pool B's earlier picks
   rebuilt with `pick.load_history` / `pick.score_history` and labelled; each book must pass on its own.
9. **Which cells are scored and how many tests.** Whether an axis value is scored with the other axes
   held at none or averaged over them; which combination is proposed if several values pass; the trial
   count (about 29 axis values and scale-out rows, about 33.6k one-lot cells). *Proposed:* each axis value
   with the others at none; Holm over the ~29 at a family-wise 10 %; if several pass, only the one with the
   highest fit-half mean is proposed, chosen before the test half is read.
10. **The cost of a day cut by a replayed lock.** *Proposed:* positions closed at the cut take the cut
    minute's close with 0.5 % adverse slippage, trades after the cut are dropped with their charges, and
    an anchor at 0.5 % against the stored `slip-0.5/` copies.
11. **Duplicate cells.** "As the file" equals "none" on five bases and "[10, 5]" on two, so cells are
    counted twice. *Proposed:* deduplicate cells by their resolved settings before the count and the SHA.

## Log

- 2026-11-04 — created from the owner's ask after the day's Dir path (T1's `S_dir_ITM1` +₹3,214 a lot
  at 10:58, back down by the close); BL-105, BL-096, BL-184 E2 and BL-147 read first and summarised
  above; Phase 0 drafted, nothing run, questions open.
- 2026-11-04 — code review (PR #416): the base list corrected (three T1 Dir settings, 25 slots each,
  175 bases), the per-leg target worded as the engine reads it (fallen by X %), the test half no longer
  called blind for the axes BL-105, BL-184 E2 and BL-096 already scored on Core's bases, the motivating
  day's close added; the review's remaining gaps (scale-out construction, pools, test count and
  correction, cut-day costing, duplicate cells) added as open questions 7–11, which gate the run.

[bl096]: BL-096-directional-parameter-sweep.md
[bl105]: BL-105-dir-trade-management-tests.md
[bl147]: BL-147-directional-early-exit.md
[bl184]: BL-184-directional-split-session.md

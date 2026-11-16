# BL-232 — Family-band weight 15% with three stop-loss families (Dir, Widesl ≤ 100%, Widesl > 100%)

| | |
|---|---|
| **Priority** | P2 — a ranking change to T1's Adaptive, one pre-registered test, no live change |
| **Status** | Done — killed on the fit window (pass rule 3 failed); the confirmation window was left unread |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-16 |
| **Depends on** | BL-074 (family-band, type × start band, weights 10 / 20 tested), BL-075 (the weight map; list C's 5%), BL-113 (T1 pool), BL-191 / BL-192 (the SL150% Widesl question) |
| **TODO.md row** | — |

## Context

Adaptive (list C) scores every variant on own-recent 15, weekday 30, days-to-expiry 30, VIX band 20 and
**family-band 5** (`rotation/lists.py`). The family-band term is the mean of the "recent" score over the
variant's family, ranked as a percentile. A family is today strategy type (Widesl, Dir, Buy) × start-time
band (four bands: 09:17–10:02, 10:17–12:02, 12:17–14:02, 14:17–15:17), pooled across index and strike
(`score.family_index`).

BL-074 tested that key at 10 and 20 percent: 10 percent with own-recent at 0 was above chance in all three
periods, 20 percent did not travel (0.68 of the best row in P2). 15 percent itself and any other key were
never run. The owner (2026-11-16) asks: raise the weight to 15 percent and let the family be the stop-loss
level instead of the start time: **Dir**, **Widesl with leg stop-loss ≤ 100 %**, **Widesl with leg stop-loss
> 100 %**. The reason is T1's contested setting, the 150 % Widesl (BL-191 killed dropping it, BL-192 capped it
at one a day): a family key on the stop-loss would let the ranking see whether wide-stop or tight-stop Widesl
is doing better lately.

## Goal

An answer to one question, read once: does Adaptive over the **T1 pool** earn more per lot-day with the
family-band weight at 15 percent on the three stop-loss families than list C as it is, without a deeper drawdown.

## Out of scope

Any live change (the owner decides after the result), other weights, other stop-loss cut-offs, the Core-only
pool, lookback changes, the BL-122 expiry rule and the BL-192 cap (ranking only).

## Plan

### Phase 0 — Pre-register (committed before any run, 2026-11-16)

- **Hypothesis:** over the T1 pool, ranking with family-band 15 % on three stop-loss families picks better than
  list C (family-band 5 % on type × start band).
- **Pool and day set:** the 521 variants of T1 (Core-298 + the 223 frozen `strategies/rotation_t1/` files), stored
  one-lot results at 0 % slippage as stored (`rotation/results`, `rotation/track_t1/results`). Days: those every
  variant has, Monday to Friday, with the 63-day warm-up (`WARMUP`), as `store.load_matrix`. The pool, every
  strategy file and every label below are fixed before any result is read; no label uses a result.
- **Families (new key "SL3"):** Dir = base family `dir` or `ditm1`; Widesl ≤ 100 = a Widesl (`variants.is_wide`)
  whose legs' largest `stop_loss.percent` is ≤ 100 (read from the strategy file: T1 settings 60 and 40, i.e.
  `wide-t1s8`, `p150-t1s11`, `p285-t1s22`); Widesl > 100 = every other Widesl (115, 114, 150). Buy strategies are
  not in the owner's three: they form their own fourth group for the family term, so Buy is neither helped nor
  penalised by the three. The family term is computed as today: the group's mean of the "recent" score, then a
  percentile rank over all variants (`crit["rfam"]` in `score.composite`).
- **Weights of the new arm:** family-band 0.15; the other four criteria keep list C's ratios, scaled by
  0.85 / 0.95 (own-recent 0.1342, weekday 0.2684, days-to-expiry 0.2684, VIX 0.1789). Lookbacks 5/21/63/126 with
  0.30/0.25/0.25/0.20, selection (top 3, at least 2 Widesl, Buy when in the top 10) all as list C.
- **Arms (4 runs in all; this is the whole test count):**
  - **V0** list C as it is (5 %, type × band): the comparator. Must equal `pick.score_history`'s list C on
    every day (checked before anything is read).
  - **V1 (the proposal, the only adoption candidate):** 15 %, key SL3.
  - **V2** 15 %, key type × band (the weight alone); **V3** 5 %, key SL3 (the key alone). Diagnostic only: they
    say which half of V1 carries a difference. Neither can be adopted from this item.
  - **V4** 15 %, key SL3 × start band (the combination). Diagnostic only.
- **Look-ahead check:** `score.composite` reads P rows before the target day only; weekday, VIX band
  (the day's 09:15 open, as every earlier rotation study), and days to expiry are the target day's own
  attributes known before 09:17. V0's equality with `score_history` shows the replay adds no input. A script
  assertion also fails the run if any family label is derived from a result.
- **Survivorship:** none beyond the T1 pool itself, which was fixed before the days it is tested on, with one
  exception stated below.
- **Data snooping (disclosed):** the nine T1 settings were chosen on 2024-10-09 → 2025-10-08, so the fit window
  below is in-sample for the pool. The idea itself came after the SL150 % studies (BL-191, BL-192), which read
  the confirmation window for a different question, and that window is also the one on which T1 was shown to beat
  Adaptive. A pass here is therefore weaker than a pass on untouched days; the forward days are the only fresh
  evidence and are too few to decide (below). Only V1 is adoptable, so there is one primary comparison, not four.
- **Windows:** fit window **F** = 2025-01-10 (first pick after the warm-up) → 2025-10-08; confirmation window **K**
  = 2025-10-09 → 2026-11-16 (the last stored day at registration). **Forward** = the T1 journal's days from
  2026-10-19, read descriptively only.
- **Measure:** the picks' summed one-lot net P&L per day (the stored results, 0 % slippage; the same arms are
  repeated on the 0.5 % slippage copy as a check, not a second test), ₹ per lot-day, V1 minus V0 on the same days.
  Uncertainty: the circular 5-day block bootstrap of the daily difference, 2,000 draws, seed 20261116, two-sided
  90 % interval (the T1 read-out's method). Drawdown: the largest peak-to-trough fall of the cumulative daily
  P&L, in ₹ per lot.
- **Pass rule (all three, read once on K):** (1) the lower end of V1 − V0's 90 % interval on K is above 0;
  (2) V1's drawdown on K is no more than 10 % deeper than V0's; (3) the V1 − V0 mean on F is not negative. Any
  other result: killed, and the findings page says so. Not read early; K is read after F and only once.
- **Will not run:** other family weights (the BL-074 rule), other stop-loss cut-offs (e.g. at 60 or 115), other
  start bands, the Core-only pool, a different Buy rule, changed lookbacks, a search over the arms' weights.
  Each needs `override: <reason>` in the Log first.

### Phase 1 — Replay script

- **Tasks:** `packages/option-backtesting/research/bl232/run.py`: build the matrix, the four rankers, parity check of
  V0 against `score_history`, the window / bootstrap / drawdown arithmetic, write a dated JSON.
- **Deliverables:** the script and `parity` output.
- **Done when:** V0 equals `score_history` list C on every day, and the family counts per key are printed and
  match the file reading (Widesl ≤ 100: 75 variants; Dir; Buy; the rest).

### Phase 2 — Run and record

- **Tasks:** read F, then K once; record both with the pass rule's three tests; update `research/options/` pages
  for the variables tested (the family weight and the family key on the ranking); update `INDEX.md`.
- **Done when:** the result, the verdict and the findings pages are committed (done 2026-11-16).

## Result (2026-11-16)

Parity first: V0 equalled the production list C (`pick._rank`, and `score_history` before the BL-192 cap) on all
69 days checked, in a span before and a span after 2026-10-30. SL3 family sizes: Dir 175, Widesl > 100 175,
Widesl ≤ 100 75 (60 % and 40 % stop-loss variants, T1 settings only), Buy 96.

**Fit window F, 2025-01-10 → 2025-10-08, 184 days, one lot per pick, stored 0 % slippage.** Mean ₹ per lot-day,
total, largest drawdown per lot, and the arm minus V0 on the same days with the 90 % block-bootstrap interval:

| Arm | Mean | Total | Max drawdown | Minus V0 [90 %] |
|---|---|---|---|---|
| V0 list C (5 %, type × band) | +1,634 | +3,00,615 | 21,340 | — |
| **V1 15 %, SL3 (the proposal)** | +1,566 | +2,88,130 | 24,403 | **−68 [−462, +377]** |
| V2 15 %, type × band | +1,301 | +2,39,444 | 29,708 | −332 [−632, −35] |
| V3 5 %, SL3 | +1,599 | +2,94,267 | 22,382 | −34 [−372, +316] |
| V4 15 %, SL3 × band | +1,635 | +3,00,850 | 22,382 | +1 [−219, +227] |

On the 0.5 % slippage copy (a check, not a second test) every arm is below V0: V1 −278 [−653, +104], V2 −220,
V3 −138, V4 −36.

**Verdict: killed.** The registered pass rule needs the V1 − V0 mean on F to be non-negative; it is −₹68 (and −₹278 at
0.5 % slippage), with a deeper drawdown (24,403 against 21,340). Rule (3) fails, so no reading of K can change the
verdict, and **K (2025-10-09 → 2026-11-16) was not read**; it stays unused for this question.

What the arms say (descriptive, F only, none adoptable):
- The weight alone hurts: raising the family term to 15 % on today's key (V2) is the worst arm, −₹332 [−632, −35],
  the only interval wholly below zero, in line with BL-074's 20 % row.
- The stop-loss key alone is neutral (V3 −34 [−372, +316]).
- Adding the start band back to the stop-loss key at 15 % (V4) matches list C (+1 [−219, +227]): the start band
  carries what the three-family key loses.

## Risks

- The ≤ 100 % Widesl group holds only T1 settings (no Core strategy has a stop-loss that low), so its family
  mean moves with the nine settings the owner chose on the fit window; on F it is in-sample by construction.
- Three groups with the start band removed mix 09:17 and 15:17 strategies in one mean (the dilution BL-074's
  earlier key suffered); V4 shows what the bands add back.
- About 290 days in K: the interval will be wide, and a "no evidence" result is the likely one.

## Open questions

None open; the owner asked for the test as written (2026-11-16).

## Log

- 2026-11-16 — created from the owner's question (family-band 15 % with Dir, Widesl ≤ 100, Widesl > 100);
  Phase 0 registered before any run; arms, windows and pass rule fixed above.
- 2026-11-16 — Phase 1: script parity with list C passed (69 days). Phase 2: F read once; V1 − V0 = −₹68 [−462, +377], so pass rule (3) failed; killed. K left unread. Findings page `research/options/common/rotation-ranking.md` updated.

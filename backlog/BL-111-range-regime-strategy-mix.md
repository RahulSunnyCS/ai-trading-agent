# BL-111 — Lots by rank (2-2-1-1) and by range regime: more Dir when ranges expand, more Widesl when quiet

| | |
|---|---|
| **Priority** | P2 — owner's idea; builds on BL-110; a close cousin of BL-053 (killed) |
| **Status** | Planned (Phase 0); Amendment A1 (T1 rank ladder) killed 2026-10-17 |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-110 (range persistence), BL-058 (the lists), BL-109 (weekday DTE) |
| **TODO.md row** | — |

## Context

Owner (2026-10-15, chat): "if there is a big range happening … we can have directional or buy, which
is better during the large-range thing. If we are having six, we can increase the directional up to
three. And when the range contracts, switch to four or five wider sells." Then: the 6 lots should be
split **2-2-1-1** (top two strategies 2 lots each, next two 1 lot each) instead of 3 strategies × 2
lots; the owner trades **3 lots on ordinary days and 6 lots on expiry days** (cash), and asked the
assistant to take the open decisions and to stage the quiet mix "four, then five".

What the repo already says:

- **What "Dir" is.** The rotation's Dir strategies are **short** ATM (or ITM1) CE + PE with a 21%
  stop per leg and one re-entry, not long options (`strategies/rotation/N_dir_*.yaml`). Widesl is a
  short wide strangle. So the premise "directional buyers gain when the range is large" does not
  apply literally; only the measured per-lot behaviour matters.
- **BL-110 (as corrected in its review).** The day range persists in both directions. Against the
  all-session average, the next day's range is about 0.14 of the baseline higher after an expanded
  session (≥ 1.25× the 20-session median) and 0.12 to 0.15 lower after a quiet one (≤ 0.80×), for
  several days. The coefficient on the previous range roughly halves once VIX is in the model
  (R² 0.17 → 0.28 in the first period, 0.12 → 0.23 in the second).
- **BL-053 (killed).** A 10:00 VIX-**move** switch between 2 Dir + 2 Buy + 2 Widesl and 4 Widesl +
  1 Dir + 1 Buy beat each fixed mix by +7.6% (needed 10%) with a worse drawdown, and most of its
  gain came from the 10:00 start. Per lot at a 10:00 entry, VIX-up days vs quiet days: Widesl ₹66
  vs ₹241, Dir ₹453 vs ₹374, Buy −₹77 vs −₹17. Those are VIX-move states, not range states.
- **BL-081 / BL-083.** No hourly state variable passed; the Dir **trigger** lead (not Dir in
  general) appears from mid-2024.
- The lists already carry a VIX-band fit (20 to 24% of the score) and a days-to-expiry fit.

## Goal

An answer to two separate questions, at the owner's real sizes:

1. **Lots by rank:** does 2-2-1-1 over the top four (6 lots), or 2-1 over the top two (3 lots),
   earn more than today's equal split?
2. **Lots by range regime:** does moving lots between Dir and Widesl by the previous session's range
   state beat the same ladder held fixed?

## Out of scope

- Any change to the live lists, weights or the journal (this recombines stored results).
- A new entry time (BL-053: a later start is a separate question).
- Buy as a lever and the Buy add-on (decision below): every arm is Dir and Widesl only.
- SENSEX (the hold-out data is NIFTY only).

## Plan

### Phase 0 — Pre-register
Committed before any run. The decisions were taken by the assistant at the owner's request
(2026-10-15) and may be overruled by the owner before a run.

- **Hypotheses.** H1: the rank ladder earns more than the equal split. H2: the range-regime switch
  earns more than the fixed ladder, than the equal split, and than the always-expanded and
  always-quiet mixes.
- **Universe.** NIFTY variants only: the 149 `N_*` variants (both periods). Dir = `is_dir`
  (including ITM1 variants), Widesl = `is_wide` (including closest-premium). The Buy add-on is
  excluded from every arm, including the baseline, which is recomputed without it (the live list's
  own basket is shown for reference only).
- **List.** Ranking = **list C (Adaptive)**, the public one. List A is reported descriptively and
  is not part of the decision. Within a kind, "#k" is the k-th highest composite of that kind on
  that day (the 09:16 ranking, no new fit). The list's minimum of 2 Widesl strategies is kept in
  every ladder (a Dir slot is swapped for the next Widesl, as `score.select` does).
- **Sizes and ladders (lots per ranked slot).**

  | Size | Equal split (baseline) | Rank ladder (H1) | Expanded regime (H2) | Quiet regime (H2) |
  |---|---|---|---|---|
  | 6 lots (expiry days) | top 3 non-Buy × 2 | top 4 × (2, 2, 1, 1) | Dir#1 ×2, Widesl#1 ×2, Dir#2 ×1, Widesl#2 ×1 | Widesl#1 ×2, Widesl#2 ×2, Dir#1 ×1, Dir#2 ×1 |
  | 3 lots (ordinary days) | top 3 non-Buy × 1 | top 2 × (2, 1) | Dir#1 ×2, Widesl#1 ×1 | Widesl#1 ×2, Dir#1 ×1 |

  Quiet-regime staging: **4 Widesl lots first** (the arm above). 5 Widesl + 1 Dir is a second arm,
  descriptive, taken as a step only after the 4-lot step has held forward.
- **Signal, known at 09:16.** `E = R_{t-1} / median(R over the 20 sessions before t-1)` from the
  previous session's NIFTY index bars (BL-110). Expanded `E ≥ 1.25`, range-bound `E ≤ 0.80`,
  otherwise normal (the fixed ladder). If the previous session is missing or excluded the day is
  normal. Thresholds are BL-110's, not tuned.
- **Expiry day.** A day on which NIFTY expires: label `dte_n = 0` on the weekday basis (BL-109).
- **The book.** The owner's real sizing as one daily series: ordinary days at 3 lots, expiry days at
  6 lots. This is the **primary endpoint** for H1 and for H2. The two day types are reported
  separately, descriptively.
- **Data and periods.**
  - *In-sample (rule fixed here):* 2025-01-10 → 2026-10-08, the live rotation store (298 variants,
    NIFTY ones used).
  - *Confirmation, not a blind hold-out:* 2022-04-05 → 2024-10-08 (P3). P3 has been read for other
    questions (BL-071, BL-075, BL-081, BL-083, and BL-110's first sub-period measured this very
    signal); what it has not seen is P&L by range state and these lot ladders. Per-variant, per-lot
    P3 results already exist for the 149 NIFTY variants (`research/bl071/results/`, the Dir ITM1
    files from `research/bl080/results/`); no engine run is needed. They are read into a separate
    research root under `research/bl111/` with a P3 day file on the **weekday** DTE basis built
    from `rotation.score` / `rotation.dte` (not from `research/bl057/rotate.py`, which counts
    calendar days). Nothing is ever written to the live append-only store.
  - *Real confirmation:* forward journal days after this item is committed (Phase 3).
- **Costs.** Net of the repo's charge model (BL-063: flat per order, as in
  `research/options/common/charges.md`); the 4-slot ladder pays for more orders per lot.
- **Look-ahead check.** The signal uses only the previous session's bars; the ranking uses only
  results before day `t`; P3 is read once, after this block is committed; the placebo uses the
  same signal series shifted, not new data.
- **Comparators.** Equal split at the same size; the fixed rank ladder; always-expanded; always-
  quiet (the BL-053 lesson: a switch must beat both fixed mixes).
- **Placebo.** The regime labels circularly shifted by every offset of at least 20 sessions
  (keeps their persistence; BL-081's design). The switch must beat the **90th percentile** of the
  shifted totals.
- **Pass / kill rule.** H1 and H2 are each judged once, on the book, on the confirmation period,
  in the same units: pass only if (a) net total of the arm is at least 10% above each comparator
  (if a comparator's total is zero or negative, the arm must be positive and exceed it by at least
  10% of its absolute value), (b) maximum drawdown no worse, (c) the 90% circular block-bootstrap
  interval (5-day blocks, 2,000 resamples, seed 20261015) of the daily difference to the
  best comparator is above zero, and (d) for H2, it also beats the placebo P90. In-sample results
  are reported but never decide. Otherwise killed. Two endpoints (H1, H2) share one rule; no
  per-size or per-day-type cell decides.
- **Will not run:** other thresholds, ladders or lists, 2-day or VIX-based signals, intraday
  signals, Buy as a lever, SENSEX, the 5-Widesl arm as a decision arm. Each needs a new dated block
  and `override: <reason>`.

### Phase 1 — Build the research root and rerun the baseline
- **Tasks:** `research/bl111/` loader for the P3 per-variant results and the in-sample store; the
  weekday-basis P3 day file; a check that the equal-split baseline reproduces BL-100's / BL-071's
  Adaptive totals within rounding; peak margin per day with the repo's margin model (Dir and Widesl
  are both short premium, so lots moved between them are roughly margin-neutral; the cash limit is
  total lots, reported anyway).
- **Done when:** the baseline reproduces and the P3 day file passes a label check against BL-109's.

### Phase 2 — Run once and decide
- **Tasks:** run H1 and H2 on the confirmation period exactly as registered; record the table.
- **Done when:** the rule is applied and the owner has the table.

### Phase 3 — Forward read-out (only if Phase 2 passes)
- Record the signal and both arms' picks in a shadow log from the commit date; read out after 60
  journal days, as BL-058 does.

### Amendment A1 (2026-10-17) — the rank ladder on the T1 universe (registered before any run)

`override: owner, 2026-10-17 chat — "yes, register and run it under BL-111": a universe (T1, both
indices) that Phase 0's will-not-run list excludes.` Phase 0's H1 and H2 (NIFTY only, P3) are
unchanged and still pending; this arm neither replaces nor decides them.

- **Question.** On T1, the universe now tracked forward (BL-113; built in BL-115), do 6 lots as
  2-2-1-1 over Adaptive's top four earn more after charges than today's 3 picks × 2 lots?
- **Universe.** T1 = Core-298 + the 223 time-generic day-type variants (BL-115), NIFTY and SENSEX.
  Core from the stored rotation results; the 223 from BL-115's simulations
  (`research/bl107/results/sim_early/t1t2`, `results/sim`).
- **Ranking.** List C (Adaptive), registered weights and lookbacks, history from 2024-10-09, the
  63-day warm-up; the composite computed once per day; `score.select` with `N_CORE` and
  `MIN_WIDE_N` set per arm. The ladder's ranks are the selected picks ordered by composite (highest
  first) after the Widesl swap. **The Buy add-on is excluded from every arm**, as in Phase 0.
- **Arms, 6 lots every trading day.**

  | Arm | Selection | Lots by rank |
  |---|---|---|
  | E (comparator) | 3 picks, ≥ 2 Widesl (today's list C) | 2, 2, 2 |
  | L2 | 4 picks, ≥ 2 Widesl | 2, 2, 1, 1 |
  | L1 | 4 picks, ≥ 1 Widesl | 2, 2, 1, 1 |

- **P&L.** Every pick re-simulated on its day with the legwise engine (current lot sizing at
  `SIZING_DATE`); k lots = k × the one-lot gross, minus charges at k lots under the BL-096 model
  (brokerage ₹20 per order + GST is flat per order, every other charge scales with lots). The re-
  simulated one-lot gross is checked against the stored results (difference > ₹1 counted).
- **Periods.** First year 2025-01-10 → 2025-10-08, reported only. Test year 2025-10-09 →
  2026-10-09, which decides. **Not blind:** the chat estimate of this ladder on 2026-10-16
  (2-2-1-1 ≈ ₹667 vs ₹640 per lot-day, gross) used each rank's P&L in both years, and T1 itself was
  compared with Core-298 on the test year. The real confirmation is forward (the T1 track journal).
- **Pass rule (Phase 0's, on the test year, net).** L2 passes against E only if (a) its net total is
  ≥ 1.10 × E's, (b) the maximum drawdown of its daily net is no worse, and (c) the 90 % circular
  block-bootstrap interval (5-day blocks, 2,000 resamples, seed 20261015) of the daily net
  difference is above zero. L1 is judged against E in the same way, and is preferred to L2 only if
  it passes and its interval against L2 is also above zero. Otherwise killed: keep 3 × 2.
- **Descriptive, never decides.** The owner's book (3 lots on ordinary days: E's top 3 × 1 vs its top
  2 × (2, 1); 6 lots on a day either index has its weekly expiry, arms as above); gross figures; the
  same arms over Core-298; the first year.
- **Script.** `packages/option-backtesting/research/bl107/lot_ladder.py` (BL-115's replay harness and
  simulations live in that folder).

- **Result (2026-10-17): killed — keep 3 picks × 2 lots.** 423 replay days (184 first year, 239 test
  year); 3,184 picks re-simulated, none differing from the stored one-lot result by more than ₹1.

  | T1, 6 lots every day, test year | Net total | Net / lot-day | Gross / lot-day | Max DD (net) | Net vs E / day, 90 % |
  |---|---|---|---|---|---|
  | E: 3 picks (≥ 2 Widesl) × 2 | ₹8,26,402 | 576 | 671 | −₹50,267 | |
  | L2: 4 picks (≥ 2 Widesl), 2-2-1-1 | ₹7,77,717 | 542 | 667 | −₹66,002 | −204 [−682, +265] |
  | L1: 4 picks (≥ 1 Widesl), 2-2-1-1 | ₹6,84,344 | 477 | 610 | −₹64,166 | −594 [−1,205, −11] |

  L2 fails all three parts (−5.9 % total, deeper drawdown, interval straddles zero); L1 fails all three
  and is worse than L2 (−391 / day [−630, −157]). Before charges the ladder ties E (667 vs 671): the two
  1-lot picks pay a full brokerage each, so charges rise from ₹95 to ₹125 per lot-day. First year
  (descriptive): E 443, L2 436, L1 428 net per lot-day. The owner's book (3 lots ordinary, 6 expiry),
  net, test year: E ₹6,68,001, L2 ₹6,56,267, L1 ₹5,97,766. Over Core-298 (descriptive) the ladder
  helped a little in the test year (net per lot-day E 351, L2 366, L1 395; intervals straddle zero) and
  hurt in the first year (250, 210, 209), with deeper drawdowns: on T1, where the top three are already
  strong, a fourth pick dilutes them.

- **Addendum (2026-10-17, after A1's result; descriptive only, decides nothing).** Owner asked about
  2-2-1-1 with at least 4 Widesl. Two arms added to the same script and run once: L3 = 4 picks (≥ 3
  Widesl) and L4 = 4 picks (all 4 Widesl), both 2-2-1-1. The test year is already read, so neither can
  pass; a strong showing would only justify a new item with a forward check.
  **Result:** both worse than today's split, and worse than L2. T1, 6 lots, net per lot-day (first
  year / test year): E 443 / 576, L2 436 / 542, L3 (≥ 3 Widesl) 388 / 496 (−484 / day vs E, 90 %
  [−726, −238]), L4 (all 4 Widesl) 355 / 444 (−795 / day [−1,270, −312]); test max DD −₹56,428 and
  −₹68,696 vs −₹50,267. Gross tells the same story (L3 608, L4 542 vs E 671), so it is not charges: the
  extra Widesl forced in are weaker than the Dir picks they replace. Same on Core-298 (L3 311, L4 233 vs
  E 351). A1's rows reproduced exactly on the rerun.
- **Addendum 2 (2026-10-17, descriptive only, decides nothing).** The owner meant a cap on Dir **lots**
  inside 2-2-1-1: D2 = at most 2 Dir lots (Dir only in the two 1-lot slots, 1 + 1); D3 = at most 3 Dir
  lots (one Dir may take a 2-lot slot and one a 1-lot slot, 2 + 1). Slots filled in rank order (no Buy)
  with the best pick allowed; both caps leave at least 2 Widesl. Same script, run once.
  **Result:** both below today's split, and below plain 2-2-1-1 (L2). T1, 6 lots, net per lot-day (first
  year / test year): E 443 / 576, L2 436 / 542, D2 401 / 504 (−433 / day vs E, 90 % [−640, −210]), D3
  410 / 507 (−416 / day [−691, −147]); test max DD −₹52,372 and −₹56,672 vs −₹50,267. Gross: E 671,
  D2 623, D3 629. Over Core-298 D3 ties E (353 vs 351 net) and D2 trails (321). Capping Dir pushes a
  lower-ranked Widesl into a 2-lot slot, and on T1 that costs more than it saves.
- **Addendum 3 (2026-10-17, descriptive only, decides nothing).** No limit on the mix: pure rank order,
  no Widesl minimum (`MIN_WIDE_N = 0`). E0 = top 3 × 2 lots; L0 = top 4 × (2, 2, 1, 1). Same script,
  run once.
  **Result:** on T1 both are worse than today's rule: net per lot-day (first year / test year) E 443 /
  576, E0 392 / 498 (−471 / day [−1,132, +203]), L0 436 / 487 (−537 / day [−1,232, +154]); max DD
  −₹69,557 and −₹65,620 vs −₹50,267. On Core-298 the opposite: E0 beats E in both years (291 vs 250
  first year, 450 vs 351 test year; +594 / day [−128, +1,347], gross +702 [−24, +1,451]) with a deeper
  drawdown (−₹76,252 vs −₹69,758); L0 371. Not significant, read after the test year, and the Widesl
  minimum is part of the registered live list, so nothing changes; a note for any future Core-298 list
  revision. On T1 the minimum protects the strong added Widesl sets from Dir variants that rank high on
  short streaks.

## Risks

- **BL-053 is a close precedent that failed** on a similar switch; VIX already carries part of the
  range information (BL-110), and the lists carry a VIX-band fit.
- **Low power.** Expiry days are about 1 in 5 and expanded days about 30% of sessions; the lot
  switch changes the basket on only a part of roughly 124 expiry days in P3. A failure may be
  "cannot tell", which the rule treats as killed.
- **Ranks inside a kind are close.** BL-090 found Widesl variants near-copies (0.85 to 0.92
  correlation); a 2-2-1-1 ladder over near-copies may be little more than 3 × 2 with fewer
  strategies.
- **Regime dependence.** The Dir trigger lead appears only from mid-2024 (BL-083); P3 may not have
  it.
- **Cash.** The cash limit is total lots, not the Dir/Widesl split; the real constraint is the
  number of lots on each day type, which this keeps at the owner's 3 and 6.

## Open questions

None for Phase 0: the owner delegated the decisions above. The owner may overrule any of them, and
should say if the 3-lot ordinary-day basket is not "top 3 non-Buy × 1 lot".

## Log

- 2026-10-15 — created from the owner's chat idea; drafted against BL-110 and BL-053.
- 2026-10-15 — owner clarified: today's basket is 3 strategies × 2 lots; the idea is 2-2-1-1 by
  rank; the owner trades 3 lots on ordinary days and 6 on expiry days because of cash, and asked
  the assistant to decide and to stage the quiet mix "four, then five".
- 2026-10-15 — Opus review (PR #235): P3 is not blind (reworded as confirmation, forward read-out
  added); the hold-out comes from `research/bl071/results` and `research/bl080/results`, not the
  live store; list C named; NIFTY-only; ladders tied to `score.select` (Widesl minimum kept, no
  Buy add-on); one primary endpoint (the book); net of charges; placebo made a circular shift
  with a P90 bar; the margin premise corrected (Dir is short premium too).
- 2026-10-17 — Amendment A1 registered at the owner's request (chat: "yes, register and run it under
  BL-111"): the 2-2-1-1 rank ladder on the T1 universe, net, test year decides; run after this commit.
- 2026-10-17 — A1 run once: killed (L2 −5.9 % net, deeper drawdown; L1 worse). Keep 3 × 2.

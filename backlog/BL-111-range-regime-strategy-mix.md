# BL-111 — Lots by rank (2-2-1-1) and by range regime: more Dir when ranges expand, more Widesl when quiet

| | |
|---|---|
| **Priority** | P2 — owner's idea; builds on BL-110; a close cousin of BL-053 (killed) |
| **Status** | Planned; H3 (Amendment 1) run 2026-10-18: exploratory, positive but fragile |
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

An answer to three separate questions, at the owner's real sizes:

1. **Lots by rank:** does 2-2-1-1 over the top four (6 lots), or 2-1 over the top two (3 lots),
   earn more than today's equal split?
2. **Lots by range regime:** does moving lots between Dir and Widesl by the previous session's range
   state beat the same ladder held fixed?
3. **Expiring index only (H3, Amendment 1, exploratory):** on an expiry day, does drawing the basket only
   from the expiring index's variants change the result against the unrestricted Adaptive basket?

## Out of scope

- Any change to the live lists, weights or the journal (this recombines stored results).
- A new entry time (BL-053: a later start is a separate question).
- Buy as a lever and the Buy add-on (decision below): every arm is Dir and Widesl only.
- SENSEX in H1 and H2 (the confirmation period is NIFTY-only). H3 (Amendment 1) is the one exception.

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

### Phase 0 — Amendment 1 (2026-10-18, before any run): H3, the expiring-index-only basket

Owner request (chat, 2026-10-18): "on expiry days we will be only using the expiry things; let me
know whether this increases or decreases" our result, and how much of the current basket is
non-expiring items.

`override: owner request 2026-10-18 (chat: "on expiry days we will be only using the expiry things; let
me know whether this will increase or decrease our thing")` for the two things this block does that Phase 0 excluded:
it adds a third hypothesis, and it uses SENSEX results ("Will not run" left SENSEX out because the
P3 confirmation period is NIFTY-only). H3 therefore has **no confirmation period**: it is
exploratory, in-sample, and cannot decide anything by itself.

- **H3 (two-sided):** on a day an index expires, a basket drawn only from that index's variants earns
  a different amount, more or less, than the unrestricted Adaptive basket (list C) of the same size.
- **Expiry day for an index:** the day its nearest weekly expiry is that day (label `0` on the
  weekday basis: `dte_n = 0` for NIFTY, `dte_s = 0` for SENSEX). A day on which both expire is left
  unrestricted.
- **Arm EXP is a filter, not a re-ranking:** the list's composite is computed over the full universe
  exactly as for the comparator, and the selection (`select`: top by composite, at least 2 Widesl, same
  ladder and size, no Buy add-on) then runs over the expiring index's variants only. Re-computing the
  composite over the restricted set would change picks even on days when the basket is already all from
  the expiring index (the composite pools one criterion across both indices), so it is not used.
  **Comparator:** the same list C over the same full universe, unrestricted, equal split of the same
  size (it is not the H1 / H2 baseline, which is NIFTY-only). The primary universe is Core-298; T1
  (Core-298 + 223) is repeated as a descriptive second run.
- **Context recorded before any outcome (picks only, no P&L):** on the reconstructed Adaptive picks
  of 2025-01-10 → 2026-10-16 (428 days), Core-298 takes 90.8 % of its NIFTY-expiry-day picks from
  NIFTY and 78.9 % of its SENSEX-expiry-day picks from SENSEX; T1 (Core-298 + 223) 89.3 % and 83.5 %.
  (Those shares count the Buy add-on too.) Counting **core picks only**, as both arms do (no Buy add-on),
  a day carries at least one non-expiring pick on 21 of 91 NIFTY-expiry days and 32 of 90 SENSEX-expiry
  days for Core (22 and 26 for T1), so only **about 50 days** (Core 53, T1 48) can differ between EXP and
  the comparator, and the test is small. The core-only SENSEX-expiry share from NIFTY is 18.5 % for Core
  (14.1 % for T1). The composition window ends 2026-10-16; H3's window ends 2026-10-08.
- **Data / period:** 2025-01-10 → 2026-10-08 only (SENSEX results exist from 2024-10; before that
  the restriction is vacuous because P3 holds NIFTY only).
- **Read-out (exploratory):** H3 uses the equal split and is **not** judged on the book (SENSEX-expiry
  days are 3-lot days in the book). "Gross per lot" is the basket's gross P&L per one-lot strategy, as
  the daily log's `per_lot_day`. On the days where EXP's basket differs from the comparator's, EXP minus
  the comparator per day: mean and 90 % circular block bootstrap (5-day blocks run over the ordered
  differing days, 2,000 resamples, seed 20261015), NIFTY-expiry days, SENSEX-expiry days and both
  together (together is the primary). Outcomes: **positive** if the lower bound is above zero,
  **negative** if the upper bound is below zero, otherwise **inconclusive**. Net of charges is reported
  beside it.
- **What follows:** nothing is adopted from this. A positive outcome may earn a proposal for a forward
  track for EXP, as a **new backlog item** (a forward journal is outside BL-111), read out on its
  **differing days**, not on expiry days (60 expiry days hold only about 18 informative ones). A negative
  or inconclusive outcome is recorded and EXP is not pursued.
- **Will not run:** restrictions on non-expiry days, other index rules, other lists.

### Phase 0 — Amendment 2 (2026-10-18, before any run): H3b, at most one non-expiring pick

Owner request (chat, 2026-10-18): "there are three lots, so maybe we can also do a POC: what if the
maximum permitted non-expiry strategy will be only one?"

`override: owner request 2026-10-18 (chat: "what if the maximum permitted non-expiry strategy will be
only one?")` for a fourth question (same status as Amendment 1: exploratory, in-sample, nothing adopted
from it).

- **H3b (two-sided):** on a day an index expires, a basket with **at most one** non-expiring core pick
  earns a different amount than the unrestricted basket (and than the expiring-only basket of H3).
- **Arm EXP1 is a capped filter of the same ranking:** the unrestricted list-C composite over the full
  universe, then the selection takes the top non-Buy variants by composite in order, accepting an
  expiring-index variant always and a non-expiring variant only while fewer than one is already in the
  basket, until 3 core picks are in; the Widesl minimum is applied as `score.select` does (the lowest
  scoring Dir is swapped for the next best Widesl that respects the cap). No Buy add-on, one lot each, the
  same population, window, days and read-out as H3 (Amendment 1).
- **Comparators, all on the same expiry days:** the unrestricted basket (FREE), the expiring-only basket
  (EXP0, H3's arm), and EXP1.
- **Primary:** EXP1 minus FREE on the days where the two baskets differ (days where FREE holds two or
  more non-expiring picks), both indices together, Core-298; 90 % circular block bootstrap (5-day blocks
  over the ordered differing days, 2,000 resamples, seed 20261015); positive / negative / inconclusive as
  in H3. **Secondary (descriptive):** EXP1 minus EXP0 on the days they differ (days where EXP1 keeps one
  non-expiring pick that EXP0 replaces); each arm's mean gross per lot-day over **all** expiry days; the
  number of days by how many non-expiring picks FREE holds (0, 1, 2, 3); NIFTY- and SENSEX-expiry days
  separately; T1 repeated. Net of charges is not computed (as in H3); mean trades per differing day are
  reported.
- **What follows:** nothing is adopted. If EXP1 is positive against FREE and not worse than EXP0, a
  proposal for it can be made as a new backlog item, as for H3.
- **Will not run:** caps other than one, caps on non-expiry days, other lists.

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
- 2026-10-18 — owner asked to add the expiring-index-only basket (H3) and to report how much of
  the current basket is non-expiring on expiry days. Amendment 1 registered before any run with an
  `override:` for SENSEX use; H3 is exploratory (no confirmation period). Composition measured
  (picks only): Core-298 non-expiring-index picks 9.2 % on NIFTY-expiry days and 21.1 % on
  SENSEX-expiry days; T1 10.7 % and 16.5 %.
- 2026-10-18 — review of PR #240: the EXP arm is a filter of the unrestricted ranking, not a re-ranking;
  informative days counted on core picks only (about 50: Core 53, T1 48); H3 two-sided; contradictions in
  Goal and Out of scope fixed; read-out definitions added. The override line, copied here as written in
  the amendment: `override: owner request 2026-10-18 (chat: "on expiry days we will be only using the
  expiry things; let me know whether this will increase or decrease our thing")` for the third hypothesis
  and the use of SENSEX results. **The owner confirms it on PR #240.**
- 2026-10-18 — **H3 run** (`research/bl111/h3_expiring_index.py`; `h3_expiring_index_2026-10-18.json`), as
  registered in Amendment 1: exploratory, in-sample 2025-01-10 → 2026-10-08, arm EXP = filter of the
  unrestricted list-C ranking to the expiring index (core picks, one lot each), 179 expiry days, no day with
  both indices expiring. Per-lot gross is the mean of the picks' one-lot gross. **EXP minus unrestricted on
  the days where the baskets differ, 90 % circular block bootstrap (5-day blocks, 2,000, seed 20261015):**

  | Universe | Days differing | Mean per lot-day | Interval | Reading |
  |---|---|---|---|---|
  | Core-298, both indices | 53 of 179 | +427 | [+112, +733] | **positive** |
  | Core-298, NIFTY expiry days | 21 of 90 | +449 | [-2, +900] | inconclusive |
  | Core-298, SENSEX expiry days | 32 of 89 | +413 | [+88, +704] | positive |
  | T1, both indices | 48 of 179 | +513 | [+259, +781] | **positive** |
  | T1, NIFTY expiry days | 22 of 90 | +182 | [-245, +538] | inconclusive |
  | T1, SENSEX expiry days | 26 of 89 | +793 | [+405, +1,205] | positive |

  EXP was better on 72 % of Core's differing days (67 % NIFTY, 75 % SENSEX) and 69 % of T1's. The summed
  difference is +₹22,646 per lot on Core and +₹24,639 on T1 over the window. Net of charges was **not**
  computed (it needs the BL-096 per-trade model; the registration said to report it beside the gross):
  the mean number of trades on the differing days is in the JSON instead. **Reading under the registered
  rule: positive (together, both universes).** It is exploratory and in-sample with about 50 informative
  days, so nothing is adopted from it. Under the registered next step a positive outcome may earn a
  proposal for a forward track for EXP as a new backlog item (read out on differing days); that proposal
  is the owner's decision.
- 2026-10-18 — **H3 review (PR #240); the table above is unchanged and reproduces byte for byte. Read it with
  these.** (1) **Net of charges was NOT computed** (the registration asked for it beside the gross). A rough
  bound from the trade counts (EXP trades 0.06 more per strategy on Core, 0.30 more on T1) is about ₹5 to
  ₹40 per lot-day, an estimate; the sign probably survives. (2) **The primary Core reading is fragile.**
  Leave-one-out: the worst single day (2026-01-22) still leaves the lower bound at +54; dropping the top 2
  days gives [+26, +656]; **dropping the top 3 gives +295 [-18, +618], which includes zero**; the top 5
  [-70, +500]. Calendar 2025 alone is [-147, +841], 2026 alone [+148, +872]. The top 5 of the 53 days carry
  55 % of the summed difference. (3) **"The SENSEX days drive it" holds for T1, not for Core.** On Core the
  NIFTY mean is +449 and the SENSEX one +413; each Core split fails leave-one-out on its own (SENSEX
  without 2026-01-22: lower bound -25; NIFTY without 2025-10-20: -64, and its top 5 days carry 94 % of its
  sum). T1 NIFTY without its top 5 days is -290 [-583, -37]. (4) **T1 is not an independent replication:** it
  is a superset of Core and its 223 extra variants were chosen on 2024-10-09 → 2025-10-08, which overlaps
  the first nine months of the window. Up to 2025-10-08 T1 reads +751 [+246, +1,301]; after it +383 [+145,
  +667]; after dropping its top 5 days +206 [+37, +397] (more robust than Core). (5) **+427 is per lot-day on
  the differing days only.** Averaged over all 179 expiry days the effect is +₹127 per lot-day on Core and
  +₹138 on T1. (6) Six readings were taken (2 universes × 3 splits); only the "both indices" rows are the
  registered primary. 19 of 179 Core expiry days (16 on T1) also had a Buy add-on, which both arms leave
  out as registered; SENSEX and NIFTY lots are not normalised for margin. **Reading under the registered
  rule stays "positive (together)", but it is a fragile, exploratory, in-sample lead.** Script nits fixed
  without changing any number (a bad trade count no longer drops a day's gross; skipped days counted: 0).
- 2026-10-18 — Amendment 2 registered before any run: H3b, at most one non-expiring core pick (EXP1),
  with the owner's `override:` line quoted above. Same exploratory, in-sample status as H3.
- 2026-10-18 — **H3b run** (`research/bl111/h3b_max_one_off.py`; `h3b_max_one_off_2026-10-18.json`), as
  registered in Amendment 2: exploratory, in-sample 2025-01-10 → 2026-10-08, the same 179 expiry days, core
  picks only, one lot each; EXP1 allows at most one non-expiring core pick, EXP0 none (H3's arm), FREE any.
  **How many non-expiring picks FREE holds on the 179 expiry days (Core): 0 on 126, 1 on 33, 2 on 17, 3 on
  3** (T1: 131, 33, 10, 5). **Mean gross per lot-day over all 179 expiry days, Core: FREE +677, EXP1 +711,
  EXP0 +804** (T1: +958, +992, +1,096): fewer non-expiring picks, higher result, in-sample.
  Paired, on the days where the two baskets differ, 90 % circular block bootstrap (5-day blocks over the
  ordered days, 2,000, seed 20261015; an interval needs at least two blocks, i.e. 10 differing days, else
  "too few days"). "w/o 3" drops the three days most favourable to the observed sign (descriptive; date
  order kept). Corrected after review: the first write-up dropped the largest days whatever the sign, which
  flattered the negative EXP1 minus EXP0 claim.

  | Comparison (together) | Core-298 | T1 |
  |---|---|---|
  | **EXP1 minus FREE (primary)** | 20 days: **+302 [+44, +552], positive**; median +340, better on 65 %, top 3 days = 57 % of the sum; w/o 3: +151 [-64, +356] | 15 days: +411 [+4, +794], positive; median -267, better on 47 %, top 3 days = 124 % of the sum; w/o 3: -125 [-524, +321] |
  | EXP1 minus EXP0 (secondary) | 53 days: **-313 [-544, -79], negative**; w/o 3: **-196 [-414, +24], inconclusive** | 48 days: -385 [-564, -201], negative; w/o 3: -262 [-437, -102], negative |
  | EXP0 minus FREE (H3, for reference) | 53 days: +427 [+112, +733]; w/o 3: +295 [-18, +618] | 48 days: +513 [+259, +781]; w/o 3: +303 [+144, +488] |

  Splits: Core NIFTY-expiry days EXP1 minus FREE has only 5 differing days (+491, too few days); SENSEX-expiry
  days 15 days, +239 [-34, +503], inconclusive. T1 splits have 6 and 9 differing days (too few days).
  Mean trades per strategy-day on the differing days (registered output): Core EXP1 2.28 vs FREE 2.27 and
  vs EXP0 2.29 / 2.34; T1 EXP1 2.62 vs FREE 2.49, EXP1 2.61 vs EXP0 2.87. EXP1 minus EXP0 is not independent
  of H3: by how many non-expiring picks FREE holds (Core, 1 / 2 / 3 picks): -162 (33 days), -481 (17),
  -1,024 (3); T1: -277 (33), -837 (10), -192 (5): the more non-expiring picks the full filter removes, the
  more it gains over the capped basket.
  **Reading** (no "not worse than EXP0" rule was registered; applied here: worse = the EXP1 minus EXP0
  interval lies entirely below zero): on **Core only**, EXP1 beats FREE (positive, fragile: +151 [-64, +356]
  without three days, 20 days differ, top 3 = 57 % of the sum). **T1's primary rests on three days** (median
  negative, better on 47 %, falls to -125 without them): read it as not supported. EXP1 does worse than EXP0
  on the full sample in both tracks, but on Core that is **inconclusive** once the three most favourable
  days are dropped. In plain terms, in this window allowing one non-expiring pick recovers about a quarter of
  the full filter's gain (+34 against +127 per lot-day over all expiry days on Core). Exploratory, in-sample,
  net of charges not computed; nothing adopted.
  A bug in the first draft of the "w/o top 3" check (sorting scrambled the date order the block bootstrap
  needs) was fixed before this entry; the main intervals were not affected.


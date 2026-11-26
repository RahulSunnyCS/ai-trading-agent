# BL-244 — Does the ranking's order predict results? Top against bottom, rank by rank, and who fills the bottom

| | |
|---|---|
| **Priority** | P1 — real money follows T1's ranking; this asks whether its order means anything |
| **Status** | Done — top against bottom not shown (T1, both kinds); order rule passed by Widesl only, narrowly and not on 2021-24; no strategy owns the bottom of the ranking |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-26 |
| **Depends on** | BL-058 (ranking, results store), BL-113 (T1); BL-214 (older NIFTY store, for Phase 3) |
| **TODO.md row** | 3.10.79 |

## Context

Owner (chat, 2026-11-26), two parts, over "the last two years or a couple of years":

1. Each day take the top 10 Widesl and top 5 Dir ("YSL" in the dictated message is read as Widesl), and
   the worst 10 Widesl and worst 5 Dir, see how each set does day by day, and judge whether the top
   predictions make sense. Also see whether the worst performers come from a particular strategy; that may
   need further research.
2. For ranks 1 to 5 of each kind, find the median, the performance and the drawdown of each rank, and
   judge whether the order makes sense (rank 1 should be the better preference).

What already touches this (none answers it for today's T1 list):

- BL-068: picking the **lowest** composite earned ₹1.44 lakh against ₹4.31 lakh for the highest, below the
  random median of ₹1.68 lakh (older weights 33/25/25/17, 248 variants, 202 days, gross).
- `rotation/rankic.py` (Rotation page, "Does rank predict results?"): daily Spearman between composite and
  gross, and the top 30 minus bottom 30. Not split by Widesl / Dir, no per-rank view.
- BL-129: among Adaptive's picks, Widesl rank 1 earned **less** than rank 2 (−₹200 [−388, −1] a lot-day on
  T1; rank 2 is usually the Widesl the minimum swapped in).
- BL-210: an absolute confidence figure beside the rank was killed (ρ +0.07 to +0.08).

## View before the run (2026-11-26, an expectation, not a finding)

- Top against bottom will probably show a real gap, given BL-068's reverse control.
- Ranks 1 to 5 will probably not be cleanly ordered: the gaps between neighbours are small against daily
  noise, and neighbouring ranks are often the same strategy a few minutes apart.
- A median alone flatters option selling (many small wins, a few large losses), so mean, total, drawdown
  and worst day are read beside it.
- A bad bottom set does not show a good top set; both are also compared with the average of all strategies
  of that kind that day.
- Removing a strategy because it filled the bottom, then scoring on the same days, would be data-snooping.

## Goal

Say, per kind (Widesl, Dir): whether the top set beats the bottom set and the pool average; whether ranks
1 to 5 are ordered; and whether some families, indices or start times are over-represented at the bottom.

## Out of scope

Any change to the live lists, weights, universe or journal.

## Plan

### Phase 0 — Pre-register (final; committed before any run)

- **Hypothesis:** on a given day, a higher composite goes with a higher net result per lot.
- **Universe and books:** T1 (list C over Core-298 + the T1 variants; primary) and Core-298 (sign check).
  Widesl and Dir ranked separately; Buy left out. The ranking is the plain composite order: no Widesl
  minimum, expiry-day rule or SL150% cap. Days that are an expiry day for either index are also shown
  separately (descriptive).
- **Sets:** top 10 and bottom 10 Widesl; top 5 and bottom 5 Dir; single ranks 1 to 5 of each kind. Equal
  weight, one lot each.
- **Window:** 2025-01-10 → 2026-10-09 (423 days, about 21 months; all that the stored results allow after the 63-day
  warm-up). Halves split at 2025-10-09: T1's settings were chosen on data up to
  2025-10-08. Only days on which every variant has a stored result are in the ranking history (4 weekdays of
  September 2026 are not).
- **Outcome:** net per lot after estimated costs and 0.5 % slippage (the ranking itself reads the stored
  unslipped net, as live does); gross beside it. A day a strategy did not trade is a real zero; its share is
  reported.
- **Peers:** for each set, also the set minus the average of all same-kind strategies on the same index and
  start band (the set's own peers), so a gap that only comes from the mix of index and time of day is seen.
- **Per set and rank:** mean, median, total, win rate, worst day, maximum drawdown of the running total.
  Also top − pool average and pool average − bottom, and the number of distinct strategies (ignoring start
  time) in the top 5.
- **Clones:** the per-rank table is repeated with only the best-ranked start time of each strategy kept.
- **Pass rule, set level (per kind, T1):** the 95 % interval (two kinds; 5-day circular block bootstrap,
  2,000, seed 20261126) of top − bottom a day is above zero, positive in both halves, and still positive
  without the 10 most favourable days. If it passes but the 95 % interval of (top − its peers) includes
  zero, the verdict says the gap is mostly the mix of index and start time.
- **Pass rule, order (per kind, T1):** the 95 % interval of (mean of ranks 1–2 − mean of ranks 4–5) is above
  zero and positive in both halves. Otherwise "no usable order inside the top 5".
- **Look-ahead check:** day D is ranked from results before D only (`daylog.reconstruction` /
  `explain.rank_day`); the rebuild must match the registered pick function on every day (asserted).
- **Hold-out:** sessions after 2026-10-09 are not read (BL-174's forward read-out).
- **Known weaknesses:** in-sample (Core-298 and T1 were chosen on this history; the lists' weights too);
  the research ranks on the day's opening VIX, live on the previous close (BL-180). List C's weights were
  picked as the best of 2025-26 (BL-075), so the window favours the ranking in both halves.
- **Will not run:** other set sizes, other weights or lists, dropping or re-weighting any strategy.

### Phase 1 — Top against bottom, and rank by rank
- **Tasks:** `packages/option-backtesting/research/bl244/`; the two tables per book, with the verdicts.
- **Deliverables:** results JSON committed; a day-by-day CSV (git-ignored) and a running-total chart of top,
  pool and bottom per kind.
- **Done when:** both pass rules have a verdict per kind in the Log.

### Phase 2 — Who fills the bottom (descriptive)
- **Tasks:** for (a) the bottom-ranked sets and (b) each day's worst realised 10 Widesl and 5 Dir: share by
  strategy family (index + family + setting), index and start band against that group's share of the pool;
  each half separately. The same for the top set and the day's best realised, so a group that is only more
  volatile (often both best and worst) is not called bad. A group is "over-represented" when its share is at
  least 1.5 times its pool share and at least 10 % of the set, in both halves.
- **Deliverables:** a table of over-represented groups, and which of them hold in both halves.
- **Done when:** the Log names the groups, or says none holds. A group that holds is a **lead**: acting on it
  needs a new item that picks it on the first half and tests it on the second.

### Phase 3 — Older period check
- **Tasks:** Phase 1 on BL-214's NIFTY-only store (`TRADING_DATA_ROOT/_bl214`), every day it can rank up to
  2024-10-08.
- **Done when:** the Log says whether each Phase 1 verdict repeats. NIFTY only, and already read by BL-214 /
  BL-215, so it supports a verdict but does not make it a clean out-of-sample test.

Closing the item updates `research/options/common/rotation-ranking.md` in the same commit.

## Risks

- A rank 1–5 table invites reading noise as order. The pass rule above is the only reading.

## Open questions

None open. Answered by the owner, 2026-11-26:

- "Worst": both. The bottom of the ranking decides the verdict; the day's worst realised are listed
  (Phase 2).
- Pool: T1 decides, Core-298 is the cross-check.
- Lists: the plain ranking, without the live expiry-day rule or SL150% cap.

## Log

- 2026-11-26 — created from the owner's message; Phase 0 drafted, nothing run.
- 2026-11-26 — started; owner answered the three questions. Before any result was read, the evaluation was
  red-teamed and Phase 0 changed: halves now split at 2025-10-09 (T1's selection year ends there) instead of
  2025-11-30; the peers comparison added (index and time-of-day mix); "over-represented" given a threshold
  and the best sets listed beside the worst; list C's in-sample weights named as a weakness. Look-ahead: the
  rank for day D reads results before D and D's 09:15 VIX and calendar labels only. Survivorship: the pool
  is fixed settings run on every day, but chosen with hindsight (in-sample). Only coverage and strategy
  counts were looked at, no P&L.
- 2026-11-26 — **Run as registered** (`research/bl244/rank_order.py`; `results_new.json`, `results_old.json`;
  per-day CSVs git-ignored under `research/bl244/out/`). The rebuilt ranking matched the pick job's own on
  every 20th day (22 days in 2025-26, 37 in 2021-24; all days after the review, below). One fix between runs, not to a rule: Core's Dir pool
  has 4 strategies, so its one-per-strategy table stops at 4. ₹ per lot-day, net of costs and 0.5 %
  slippage, 95 % intervals.
- 2026-11-26 — PR 469 review: the order verdict is now reported as registered (Widesl passes); the lead's
  strategy ids corrected to the T1 settings measured; the look-ahead check now runs on every day, as
  Phase 0 says, not every 20th (both periods rerun); the history fallback limited to BL-214's store. The
  running-total charts were shown in chat and are not committed.
- 2026-11-26 — every-day check run: the rebuild matched on all 423 and 722 days and every result is
  unchanged. On 1 day of 2025-26 `pick.load_history` itself refuses (September 2026's missing results) and
  on 647 days of BL-214's store (no lake of its own); those days are compared through the same two reads.

## Result

**T1, 2025-01-10 → 2026-10-09 (423 days, the deciding run)**

| | Top | Pool average | Bottom | Top − bottom | Halves | Verdict |
|---|---|---|---|---|---|---|
| Widesl (10) | ₹262 | ₹72 | ₹125 | +137 [−16, +288] | +100 / +166 | not passed |
| Dir (5) | ₹290 | ₹114 | ₹192 | +98 [−81, +277] | −18 / +187 | not passed |

- Without the 10 most favourable days: Widesl +8, Dir −32. Top ahead of bottom on 53 % / 50 % of days.
- Top − pool average (not a pass rule): Widesl +191 [+71, +309], Dir +175 [+42, +310].
- Top − its peers (same index and start band): Widesl +59 [−22, +134], Dir +93 [+6, +192]. 45 % / 37 % of
  top Widesl picks start 09:17–10:02 (16 % of the pool): much of the Widesl lead is the time-of-day mix.
- Bottom − its peers: Widesl +19 [−39, +73], Dir +89 [+5, +175]. A low rank is not a warning.
- Expiry days (179 of 423, descriptive): top − bottom Widesl +326 against −2 on other days, Dir +99 against
  +97. The Widesl split did not repeat on 2021-24 (+42 against +115).

**Ranks 1 to 5 (T1)** — mean / median per day, total, maximum drawdown:

| Rank | Widesl 2025-26 | Dir 2025-26 | Widesl mean 2021-24 | Dir mean 2021-24 |
|---|---|---|---|---|
| 1 | 309 / 534 · 1,30,782 · −25,358 | 321 / 476 · 1,35,850 · −21,821 | 124 | 291 |
| 2 | 528 / 718 · 2,23,304 · −15,965 | 285 / 494 · 1,20,515 · −37,158 | 108 | 159 |
| 3 | 307 / 485 · 1,29,969 · −26,717 | 177 / 331 · 74,994 · −29,995 | 141 | 202 |
| 4 | 192 / 417 · 81,388 · −30,707 | 413 / 686 · 1,74,791 · −13,891 | 112 | 180 |
| 5 | 267 / 507 · 1,12,864 · −34,477 | 253 / 394 · 1,06,862 · −32,907 | 193 | 151 |

- Order rule (ranks 1–2 minus 4–5), the registered verdict: **Widesl passes**, +189 [+11, +364], halves
  +4 / +332. **Dir does not**, −30 [−193, +126].
- Caveats on the Widesl pass (read after the result; they do not change the verdict): almost nothing in the
  first half, rank 1 earns less than rank 2, the one-per-strategy version includes zero
  (+148 [−21, +332]), and on 2021-24 it is −36 [−133, +66]. Not enough to prefer or size up a pick by rank.
- The top 5 holds about 3 distinct strategies (3.0 Widesl, 3.1 Dir); the rest are the same ones at other
  times.

**Who fills the bottom (Phase 2)**

- Bottom-ranked: no strategy and no index is over-represented, in T1, in either period. Dir only, 2025-26: early
  starts (30 % / 31 % against 16 %), which also fill the top and the day's best, so they only swing more.
- Day's worst realised, over-represented in both halves: `N_p150-t1s11` (T1's NIFTY ₹150 premium Widesl,
  SL 60 %) 17 / 19 % against a 10 % share (best 11 / 11 %), and 27 / 28 % against 17 % in 2021-24
  (best 17 / 17 %); `S_p285-t1s22` 17 / 19 % (best 14 / 19 %, 2025-26 only); `N_ditm1-t1s36` (T1's NIFTY ITM1
  Dir) 26 / 28 % against 14 % but 24 / 24 % of the best too. **Lead:** `N_p150-t1s11` lands among the day's
  worst more often than among its best in both periods. This counts days, not money, so it does not say the
  strategy loses.

**Older period (Phase 3, NIFTY only, 2021-11-02 → 2024-10-08, 722 days)**

| T1-NIFTY | Top − bottom | Halves | Verdict | Order (1–2 minus 4–5) |
|---|---|---|---|---|
| Widesl | +100 [+4, +201] | +223 / −23 | not passed (repeats) | −36 [−133, +66]: no order (does **not** repeat) |
| Dir | +87 [−33, +213] | +111 / +63 | not passed (repeats) | +59 [−67, +178]: no order (repeats) |

Top − pool: Widesl +84 [+15, +158] (second half −12), Dir +62 [−30, +155].

**Core-298 cross-check.** 2025-26: top − bottom Widesl +86 [−54, +229], Dir +137 [−18, +296]; neither
passes or is ordered; Widesl top − peers −11 [−50, +26]. Core-NIFTY 2021-24: Widesl passes
(+138 [+59, +220], ordered); Dir does not.

**Reading.** The top of the ranking averaged more than the bottom in all eight cells (+86 to +138 a
lot-day; the cells share days and strategies, so they are not eight proofs), but on T1, the book that is
traded, it is within noise. The firmer part is top against the average strategy, much of it from preferring
morning starts. The registered order rule passed for Widesl only; with the caveats above, the order inside the top
5 should not be used to prefer one pick or size it up (agrees with BL-129). In-sample, as Phase 0 says. Nothing changed live.


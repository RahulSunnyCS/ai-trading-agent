# BL-179 — Two Wide SL a day: the top morning one and the top afternoon one, against Adaptive

| | |
|---|---|
| **Priority** | P2 — a direct owner question about the live picks; two fixed rules, no search |
| **Status** | Done (a, b killed; c inconclusive) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-058 (the rotation lists and stored results), BL-113 (the T1 track), BL-178 |
| **TODO.md row** | — |

## Context

The owner (2026-10-28): trade two Wide SL strategies a day, the best-ranked one entering in the
morning (09:30–12:00) and the best-ranked one entering in the afternoon (13:00–15:30), leaving
12:00–13:00 out. Then the same without the break. On Core and on Adaptive tuned (T1).

## Goal

For each pool and each rule, the daily net beside Adaptive's over the same days, with the same
costs, and a verdict under the rule below.

## Out of scope

Changing the live pick. Other windows, other ranks, a third strategy, lots other than one.

## Plan

### Phase 0 — Pre-register

#### 2026-10-28 — Morning + afternoon Wide SL vs Adaptive
- **Hypothesis:** one Wide SL from the morning and one from the afternoon, each the best by
  Adaptive's own ranking, earn more per strategy-lot than Adaptive's three picks.
- **Ranking:** Adaptive's composite (list C, `pick._rank`), computed over the whole pool on the
  history before each day, unchanged.
- **Wide SL:** what Adaptive counts as Widesl (`variants.is_wide`): `wide` and the
  closest-premium families (Core p80, p100, p250, p320; T1's wide-t1s4, wide-t1s8, p150, p285).
- **Rule G (with the break):** the highest-composite Wide SL entering 09:30–11:59 (slots 0932 to
  1147) plus the highest entering 13:00–15:30 (1302 to 1517). 09:17 is outside both.
- **Rule N (no break):** the same morning pick, plus the highest entering 12:00–15:30 (1202 to
  1517).
- **Expiring-index rule:** on the days Adaptive applies it (from 2026-10-19, one index expiring),
  both picks come from that index only, as Adaptive's picks do. Ties broken by name.
- **Universe:** Core = Core-298; T1 = Core-298 plus the T1 track's variants, as `pick --track t1`.
- **Comparator:** Adaptive's three core picks re-scored for the same day (checked against the
  journal in BL-178).
- **Measure:** one lot each, net of estimated brokerage (`lot_plans.brokerage`). Primary: net per
  strategy-lot a day (the day's net divided by its number of picks: 2 for G and N, 3 for
  Adaptive), so the comparison holds the money per lot equal. The day's total is reported too.
- **Period:** 2025-10-28 to 2026-10-27, the sessions every variant of the pool has (239).
- **Look-ahead check:** the composite reads only rows before the day; the window is fixed by the
  variant's entry time, known before the open.
- **Pass / kill rule (per pool, per rule):** difference = rule minus Adaptive, per strategy-lot,
  daily. Pass: mean > 0 and the 5-day block-bootstrap 90% interval (5,000 resamples, seed 179)
  above zero. Kill: mean ≤ 0. Otherwise inconclusive. Four tests (2 rules × 2 pools); a pass on
  one of four is weak evidence. G against N is reported, not tested.
- **Hold-out:** none. The period was already looked at (the Wide SL entry-window table and BL-178,
  both 2026-10-28), and Adaptive's weights were chosen on P1 (Dec 2025 – Oct 2026), which favours
  Adaptive. The window edges are the owner's, set after seeing that table.
- **Will not run:** other window edges, 09:17 in the morning window, top-2 per window, other
  rankings. Each needs a new block, or `override: <reason>` in the Log.

#### 2026-10-28 (b) — Adaptive's Directional kept, its Wide SL chosen by window
The owner's clarification after block (a): keep Adaptive's Directional, and choose the Wide SL by
window. Block (a) stands as run; this is a new test, not a change to it.
- **Hypothesis:** Adaptive with its Wide SL replaced by the best morning and the best afternoon
  Wide SL earns more than Adaptive as it is.
- **Rule, each day, from Adaptive's three core picks:**
  - Adaptive picked a Directional (it picks at most one, since it keeps at least two Wide SL):
    keep it, and replace its two Wide SL with the best Wide SL entering in the morning window and
    the best entering in the afternoon window.
  - Adaptive picked three Wide SL (no Directional): the best morning, the best afternoon, and as
    the third the best remaining Wide SL entering in either window.
- **Windows:** morning 09:30–11:59 (0932–1147); afternoon G 13:00–15:30 (1302–1517) or N
  12:00–15:30 (1202–1517). 09:17 is outside both.
- **Everything else as block (a):** "best" = Adaptive's list C composite; Wide SL = `is_wide`; the
  expiring-index rule restricts the Wide SL picks on the days it applies (the Directional is
  Adaptive's, already restricted); Core-298 and T1; one lot each, net of estimated brokerage;
  2025-10-28 to 2026-10-27; the Buy add-on is not part of either book.
- **Measure:** net a day (three picks on both sides).
- **Pass / kill rule (per pool, per window):** difference = rule minus Adaptive, net a day. Pass:
  mean > 0 and 5-day block-bootstrap 90% interval (5,000 resamples, seed 1792) above zero. Kill:
  mean ≤ 0. Otherwise inconclusive. Four tests; block (a)'s four count towards the same family.
- **Hold-out:** none, as block (a), and block (a)'s numbers were seen before this rule was set.
- **Will not run:** other windows, 09:17 in the morning window, a different Directional.

#### 2026-10-28 (c) — Block (b) on non-expiry days, Adaptive on expiry days
The owner's follow-up to a descriptive line of Result (b): on non-expiry days block (b)'s rule was
ahead of Adaptive on Core over 2025-10-28 → 2026-10-27, and behind on expiry days.
- **Hypothesis:** the hybrid (block (b)'s rule on days when neither index expires, Adaptive's
  picks unchanged on days when NIFTY or SENSEX expires) earns more than Adaptive.
- **Expiry day:** `dte_n == "0"` or `dte_s == "0"` (weekday basis, `rotation/days.csv`).
- **Windows:** HG = block (b) with afternoon 13:00–15:30; HN = afternoon 12:00–15:30. Everything
  else as block (b).
- **Test period (decides):** 2025-01-10 → 2025-10-27, the sessions before the year the idea came
  from (Core-298's first scored day after 63 days of warm-up; P2 plus Sep–Oct 2025). Adaptive's
  weights were chosen on P1 (Dec 2025 – Oct 2026), so this period is outside that too.
- **The year the idea came from (reported, decides nothing):** 2025-10-28 → 2026-10-27. Its result
  is known by construction from Result (b): about +₹42 (HG) and +₹62 (HN) a day on Core.
- **Pools:** Core-298 decides. T1 is reported only: its variants were chosen on 2024-10-09 →
  2025-10-08, which covers the test period, and on T1 the rule was behind on non-expiry days too.
- **Pass / kill rule (Core, per window, test period):** difference = hybrid minus Adaptive, net a
  day. Pass: mean > 0 and 5-day block-bootstrap 90% interval (5,000 resamples, seed 1793) above
  zero. Kill: mean ≤ 0. Otherwise inconclusive. Two tests; blocks (a) and (b) count towards the
  same family, so a pass of one of the two is weak evidence.
- **Will not run:** other expiry definitions (one index only, DTE ≤ 1), other windows, a T1 verdict.

#### Result (a)
**Kill on all four** (2026-10-28). 239 sessions, 2025-10-28 → 2026-10-27, one lot each, net after
estimated brokerage.

| Pool | Book | Picks | Net a day | Per strategy-lot | Year | Days up | Max drawdown |
|---|---|---|---|---|---|---|---|
| Core | Adaptive | 3 | ₹993 | ₹331 | ₹2,37,394 | 60% | −₹35,929 |
| Core | G (13:00–15:30) | 2 | ₹200 | ₹100 | ₹47,881 | 58% | −₹42,366 |
| Core | N (12:00–15:30) | 2 | ₹295 | ₹147 | ₹70,499 | 60% | −₹40,360 |
| T1 | Adaptive | 3 | ₹1,674 | ₹558 | ₹4,00,100 | 68% | −₹25,672 |
| T1 | G (13:00–15:30) | 2 | ₹620 | ₹310 | ₹1,48,288 | 62% | −₹27,073 |
| T1 | N (12:00–15:30) | 2 | ₹488 | ₹244 | ₹1,16,606 | 61% | −₹28,627 |

- Rule minus Adaptive, per strategy-lot a day: Core G −₹231 [−₹357, −₹112], Core N −₹184 [−₹320,
  −₹53], T1 G −₹248 [−₹388, −₹114], T1 N −₹314 [−₹454, −₹177]. All four intervals wholly
  below zero.
- The legs: Core morning ₹58, afternoon ₹142 (G) / ₹237 (N); T1 morning ₹333, afternoon ₹287 (G)
  / ₹155 (N), per pick a day. The break helps T1 (+₹133 a day for G) and hurts Core (−₹95).
- Why, descriptive: Adaptive's money comes partly from strategies the two rules leave out. Its
  Directional picks are 204 of 717 (Core) and 202 of 717 (T1) and bring 39% and 35% of its total
  (₹480 and ₹633 a pick in 09:30–12:00). Its 09:17 Wide SL bring 12% in both pools. And Adaptive
  takes a Wide SL from a window only when one ranks near the top overall: its own 13:00–15:30
  Wide SL picks averaged ₹532 (Core) and ₹1,026 (T1) a pick, against ₹142 and ₹287 when the best
  afternoon Wide SL is taken every day.
- Script and per-day picks: the session's scratchpad (`bl179/run.py`, `Core_daily.json`,
  `T1_daily.json`), not committed.

#### Result (b)
**Kill on all four** (2026-10-28): every mean below Adaptive. Same 239 sessions, three picks a day
on both sides, one lot each, net after estimated brokerage.

| Pool | Book | Net a day | Per strategy-lot | Year | Days up | Max drawdown | Same picks as Adaptive |
|---|---|---|---|---|---|---|---|
| Core | Adaptive | ₹993 | ₹331 | ₹2,37,394 | 60% | −₹35,929 | — |
| Core | G (13:00–15:30) | ₹660 | ₹220 | ₹1,57,772 | 60% | −₹43,381 | 14 days |
| Core | N (12:00–15:30) | ₹750 | ₹250 | ₹1,79,187 | 61% | −₹38,019 | 32 days |
| T1 | Adaptive | ₹1,674 | ₹558 | ₹4,00,100 | 68% | −₹25,672 | — |
| T1 | G (13:00–15:30) | ₹1,318 | ₹439 | ₹3,14,959 | 68% | −₹27,248 | 19 days |
| T1 | N (12:00–15:30) | ₹1,178 | ₹393 | ₹2,81,462 | 64% | −₹31,722 | 34 days |

- Rule minus Adaptive, net a day: Core G −₹333 [−₹624, −₹69], Core N −₹244 [−₹551, +₹31],
  T1 G −₹356 [−₹724, −₹17], T1 N −₹496 [−₹851, −₹169].
- By Adaptive's shape: on its Directional days (204 Core, 202 T1) the rule earned ₹682 / ₹776
  (Core G / N) against ₹1,026, and ₹1,263 / ₹1,108 (T1) against ₹1,492; on its three-Wide-SL days
  (35, 37) ₹531 / ₹597 against ₹803, and ₹1,616 / ₹1,560 against ₹2,668.
- Descriptive, not tested: on days with no expiry the rule was ahead on Core (₹364 G, ₹400 N
  against ₹291 a day, 137 days) and behind on T1 (₹1,046 / ₹941 against ₹1,178); on expiry days it
  was behind in both pools (Core NIFTY expiry ₹794 against ₹1,913).
- Script: the session's scratchpad (`bl179/run_b.py`, `b/Core_daily.json`, `b/T1_daily.json`),
  not committed.

#### Result (c)
**Inconclusive** (2026-10-28): on the test period the hybrid was ahead of Adaptive on Core with both
windows, but the intervals include zero. Not adopted under the rule.

Test period 2025-01-10 → 2025-10-27, Core, 195 sessions (113 without an expiry), net a day, one
lot each, after estimated brokerage:

| Book | Net a day | Total | Days up | Max drawdown | Non-expiry days only |
|---|---|---|---|---|---|
| Adaptive | ₹741 | ₹1,44,473 | 54% | −₹42,326 | ₹372 |
| HG (13:00–15:30) | ₹860 | ₹1,67,695 | 56% | −₹33,648 | ₹577 |
| HN (12:00–15:30) | ₹839 | ₹1,63,657 | 56% | −₹33,648 | ₹542 |

- Hybrid minus Adaptive, net a day: HG +₹119 [−₹156, +₹412], HN +₹98 [−₹166, +₹377]:
  inconclusive both. On the non-expiry days alone the gap is +₹205 (HG) and +₹170 (HN) a day,
  the same direction as the year the idea came from (+₹73 / +₹109).
- The year the idea came from (2025-10-28 → 2026-10-27, decides nothing): Core HG +₹42
  [−₹136, +₹214], HN +₹63 [−₹115, +₹235], as expected from Result (b); drawdown slightly
  deeper (−₹39,357 / −₹40,438 against −₹35,929).
- T1, reported only: test period HG +₹76 [−₹179, +₹339], HN +₹71 [−₹175, +₹319] (its variants
  were chosen on this period); the idea year HG −₹76 [−₹255, +₹93], HN −₹136 [−₹303, +₹29], behind
  on non-expiry days (₹1,046 / ₹941 against ₹1,178).
- Reading: on Core the edge on non-expiry days appeared in both years, about +₹100 to +₹200 a
  non-expiry day, which is a lead worth watching forward, not a finding. On T1 it does not hold.
- Script: the session's scratchpad (`bl179/run_c.py`, `c/test/`, `c/idea/`), not committed.

## Risks

One year; the windows were proposed after a table of this same year.

## Log

- 2026-10-28 — created and pre-registered at the owner's request.
- 2026-10-28 — run; killed on both pools, both rules (Result above); `research/options/common/rotation-ranking.md` updated.
- 2026-10-28 — block (b) pre-registered at the owner's request: Adaptive's Directional kept, Wide SL by window.
- 2026-10-28 — block (b) run; killed on both pools, both windows (Result (b)); findings page updated.
- 2026-10-28 — block (c) pre-registered at the owner's request: block (b) on non-expiry days, Adaptive on expiry days, tested on 2025-01-10 → 2025-10-27.
- 2026-10-28 — block (c) run: inconclusive on Core (ahead, intervals include zero); findings page updated.

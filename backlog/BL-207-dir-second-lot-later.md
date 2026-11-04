# BL-207 — The doubled Dir's second lot taken later: the same Dir 30 / 60 minutes on, or the best-ranked Dir at least 30 / 60 minutes later, against Dir ×2 at one minute

| | |
|---|---|
| **Priority** | P2 — the owner's T1 accounts trade the picked Dir at 2 lots on every non-expiry day (BL-183); if a spaced second lot does as well with a smaller worst day, it is a one-line change to what is uploaded |
| **Status** | Done — informative: no spaced second lot beats Dir ×2; every arm earns ₹260–785 a day less, wins 34–43 % of days, and neither the drawdown nor the worst day is reliably smaller (see Log) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-04 |
| **Depends on** | BL-183 (Dir ×2 live), BL-194 (book stop on Dir ×2 days), BL-204 (the lot ladder's replay, reused), BL-122 (expiring-index rule), BL-192 (SL150% cap) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-11-04): "So directional, we are taking two at a time, right? ... maybe a directional with
at least half an hour difference as a first and second, then how would it be?"

What is live (T1, both AlgoTest accounts since 3 Nov): on a day neither index expires the picked Dir
trades 2 lots at its slot (09:17 on most days) and the two Widesl 1 lot each, under a book stop of
₹9,000 plus the Dir's own MTM SL (BL-183, BL-194). Both Dir lots enter at the same minute, carry the
same stop and leave together.

What the repo already knows: the Dir is the best home for a fourth lot (BL-133 Amendment 2: Dir ×2
+₹96 a day over an even spread for T1) and for a fifth and sixth (BL-204: Dir ×3, Dir ×4). BL-204's
`N5+D` arm added the best-ranked *other* Dir as a **fifth** lot on top of Dir ×2; it did not swap the
doubled lot for a later one. Nothing has read the fourth lot as a second, later Dir entry. The
Adaptive ranking already scores every Dir at every 15-minute slot from 09:17 to 15:17 (Core's
`N_dir`, `N_ditm1`, `S_dir`, `S_ditm1`, T1's `N_dir-t1s29`, `N_ditm1-t1s36`, `S_ditm1-t1s44`), so a
later Dir is a stored variant, not a new strategy.

## Goal

For T1 on non-expiry days with a Dir pick: the net, drawdown and worst day of taking the second Dir
lot at a later slot, against the live Dir ×2 and the even spread. Nothing live changes.

## Out of scope

Core-298; expiry days (3 lots, nothing doubled); three-Widesl days (no Dir to double); the Widesl
lots; 5+ lots (BL-204); a later entry chosen on the morning's move (that is a trigger, BL-083's
territory); any change to a list, an export or a setting.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** the Dir's profit is decay collected from the open; a second lot entered 30 or 60
  minutes later has less decay left to collect and the day's drift already in the price, so on
  average it earns less than the doubled 09:17 lot (expected ₹100–300 a day less for the same
  setting), but the two lots no longer stop out at the same minute, so the worst day and the
  drawdown should be smaller. The ranked later Dir is expected close to Dir ×2 with the same
  drawdown gain. Neither is expected to beat Dir ×2 on net.
- **Book:** T1, list C (registered weights and lookbacks) reconstructed day by day from the stored
  results (`daylog.reconstruction` over Core-298 + the T1 variants, `pick._rank`), as BL-204: the
  expiring-index rule (`expiry.filter_picks`) and the SL150% cap (`sl150_cap.cap_picks`) applied as
  if live throughout; core picks only, Buy left out. Day d's composite is built from results before
  d only.
- **Days:** *normal with a Dir* = neither index expires, both labels known
  (`live_lots.lots_for_day` would double), and the core holds a Dir (D). Every other day is counted
  and left out: live trades 3 lots there and nothing is doubled.
- **Picks named:** D = the core Dir pick at slot t; W1, W2 = the two Widesl picks. The second lot:
  - **same+30** = D's own setting (same index, family and track tag) at slot t + 30 min;
  - **same+60** = the same at t + 60 min;
  - **rank+30** = the best-ranked unpicked Dir (any index or setting in T1's universe, by the day's
    composite, ties by name) whose slot is ≥ t + 30 min;
  - **rank+60** = the same with ≥ t + 60 min;
  - **rank-any** = the best-ranked unpicked Dir at any slot, t itself included (BL-204's D+): the
    control that separates "a different Dir" from "a later Dir".
  A second lot that does not exist (t + 30 past 15:17) leaves that arm missing on the day; missing
  days are counted and the arm's comparisons run over its own days.
- **Arms (4 lots each):** **N4** (live) = D ×2, W1, W2; each arm above = D, its second Dir, W1, W2;
  **B4** (even spread) = the 3-lot book × 4/3.
- **Book stop:** ₹9,000 plus the extra lot's strategy's own `overall.stop_loss_inr` (₹4,000 if
  none): N4 adds D's, an arm adds its second Dir's; B4's stop is ₹12,000 on paths × 4/3. Replayed
  per minute with `rotation/portfolio.apply_book` over `one_lot_path` (the per-lot stop scaling the
  owner confirmed in BL-194). A day whose path cannot be replayed is skipped and listed.
- **Money (primary):** gross from the replayed paths × lots under the stop at 0 % slippage;
  brokerage = 2 orders × the stored `n_trades` × ₹20 × 1.18 once per strategy placed (N4 places
  three strategies, a spaced arm four: the spaced arm pays one more strategy's orders, as it would
  live); net = gross − brokerage. **Second reading:** no book stop, 0.5 % slippage on every fill,
  from the store's `slip-0.5` copies (net = Σ lots × slipped net − brokerage).
- **Measures (net):** per day and per lot-day; max drawdown; worst day; worst 5-day week; share of
  losing days; book-stop days. Intervals: 90 % circular block bootstrap, 5-day blocks, 2,000
  resamples, seed 20261104, of arm − N4 and arm − B4 in date order; the share of days the arm beats
  N4; arm − N4 with the 5 and 10 best days of the difference removed and their share of the excess.
- **Windows:** all = 2025-01-10 → 2026-11-03; last year = 2025-11-03 → 2026-11-03; the halves
  ≤ 2025-10-08 and after (BL-202's split), each reported on its own.
- **Reading:** an arm "beats live" only if arm − N4 is above zero in the all window, its mean is
  above zero in the last year and in both halves, and its max drawdown is no deeper than N4's. An
  arm "matches live with less risk" if arm − N4 includes zero and both its max drawdown and worst
  day are at least 20 % smaller than N4's. Anything else is "no evidence". Descriptive and
  in-sample: T1's universe was selected on part of these days. With five arms, one interval
  clearing zero by chance is possible; nothing is adopted here. A live change needs BL-135's
  forward rule (60 scored days, interval above zero, drawdown per lot no deeper).
- **Look-ahead check:** day d's ranking uses results before d; the slots are fixed names; the
  second lot's choice (by composite or by setting) uses nothing from the day; the expiry labels are
  known before the day; the stop levels are the strategy files' own; the anchor: N4 reproduces
  BL-204's N4 series on the shared days.
- **Hold-out:** none (descriptive, in-sample, as BL-133 / BL-194 / BL-204).
- **Will not run:** spacings other than 30 / 60 min; a later slot chosen on the morning's move;
  spacing the Widesl; expiry days; 5+ lots; Core-298; Buy; any day after 2026-11-03.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl207/dir_spacing.py`; JSON beside it; Log.
- **Done when:** the Log has every arm over every window with both money readings.

## Risks

In-sample; a stop fills at the minute's close with no slippage in the primary reading; the second
reading has no book stop; runner-ups are rebuilt from the stored composites, not journal entries;
on days D is not at 09:17 the "+30" slot is a later-day slot whose decay profile differs.

## Open questions

None before the run (the owner asked for the read today). After it: whether a spaced second lot is
worth a BL-183-style toggle.

## Log

- 2026-11-04 — Created; Phase 0 registered before any run (the owner's question, the arms chosen here).
- 2026-11-04 — **Run as registered** (`research/bl207/dir_spacing.py`; `dir_spacing_2026-11-04.json`). 439 T1 days
  reconstructed (2025-01-10 → 2026-11-02, the newest stored day): 186 one-index expiry days, 1 other (2026-09-30), 33
  three-Widesl days, **219 normal days with a Dir pick**, all kept, none skipped. The D was `S_ditm1-t1s44_0917` on 24
  days, `N_ditm1-t1s36_0932` / `_0947` on 12 each, then later slots; the +60 arms miss 3 days (D after 14:17). Anchor:
  N4 reproduces BL-204's N4 net on all 218 shared normal-with-Dir days to the paisa. Net per day after brokerage; "vs
  N4" = arm − Dir ×2 (90 % interval, 5-day blocks); "win" = share of days the arm beats N4.

  **Primary reading (book stop, 0 % slippage), all 219 days:**

  | Arm | Net/day | Max DD | Worst day | Loss days | vs N4 | Win | vs even |
  |---|---:|---:|---:|---:|---|---:|---|
  | N4 (Dir ×2, live) | +1,576 | −42,829 | −13,941 | 35 % | — | — | +294 [+91, +502] |
  | B4 (even spread) | +1,282 | −50,014 | −12,573 | 34 % | −294 [−502, −91] | 47 % | — |
  | same+30 | +1,317 | −58,868 | −13,699 | 37 % | −259 [−538, +12] | 38 % | +35 [−207, +277] |
  | same+60 | +1,209 | −53,542 | −13,751 | 38 % | −371 [−694, −51] | 40 % | −71 [−320, +179] |
  | rank+30 | +1,195 | −36,546 | −12,924 | 36 % | −381 [−734, −46] | 43 % | −88 [−356, +165] |
  | rank+60 | +1,016 | −36,555 | −12,550 | 37 % | −564 [−905, −241] | 43 % | −264 [−520, +5] |
  | rank-any (control) | +1,269 | −49,617 | −13,000 | 37 % | −307 [−611, −36] | 39 % | −13 [−264, +221] |

  Last year (120 days): N4 +2,378/day, DD −27,281; same+30 −440 [−770, −126], same+60 −576 [−990, −190], rank+30
  −642 [−1,094, −213], rank+60 −785 [−1,212, −392], rank-any −533 [−908, −200]; every arm's drawdown as deep or deeper
  (−25k to −32k) and the worst day within ₹1k of N4's. Fit half (91 days, 2025-01-10 → 2025-10-08): every arm within
  ±₹200 of N4, all intervals include zero; test half (128 days): every arm below zero (−428 to −831). **Second reading
  (no book stop, 0.5 % slippage):** the same order, every arm below zero over all 219 days (same+30 −321 [−607, −49],
  rank+30 −425 [−799, −76], rank+60 −599 [−952, −257]) and in the last year.

  **Verdict: no evidence** for every arm, by the registered reading. The hypothesis held on net (a later lot has less
  decay to collect; the ranked later Dir did no better than the same setting) and failed on risk: the spaced lots
  did not make the worst day or the drawdown smaller, because the Dir's bad days are trend days that hit a later
  entry too (the control, the best other Dir at any slot, loses as much as the spaced ones, so the loss is "a
  different Dir", not "a later Dir"). The edge of Dir ×2 over the even spread (+₹294 [+91, +502]) sits where BL-133
  found it. Nothing to adopt; Dir ×2 at the pick's slot stays. In-sample, descriptive.

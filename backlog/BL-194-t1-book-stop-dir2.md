# BL-194 — T1's book stop on Dir ×2 days: is ₹13,000 the right level?

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 with Dir ×2 on Quantiply (Angel One and Shoonya) from 2026-11-02 |
| **Status** | Done — informative: no level beats today's rule (₹9k + the Dir's stop, ₹13k on most days); tighter levels lean negative (₹9k and ₹11k below zero on the last year), looser only deepens the worst day |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-02 |
| **Depends on** | BL-131 (book stop levels), BL-133 Amendment 2 (Dir ×2 under the book stop), BL-183 (Dir ×2 live), BL-192 (SL150% cap) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-11-02): "now we are putting dir*2 in weekdays. how much would be the ideal SL. Currently putting 9k+4k =
13k for T1. Can you check for optimum." Live (BL-183): on a non-expiry day the picked Dir trades 2 lots and the
clientwise MTM SL is ₹9,000 plus the Dir's own stop (T1's Dirs mostly ₹4,000, so ₹13,000); a day with no Dir pick
or an expiry day stays 3 lots under ₹9,000. BL-131 read levels only for the 3-lot book; BL-133 Amendment 2 read Dir
×2 only at 9k + the Dir's stop.

## Goal

What each book-stop level on T1's 4-lot (Dir ×2) days would have done against today's rule. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Book:** T1, list C (registered weights and lookbacks) reconstructed day by day from the stored results
  (`daylog.reconstruction` over Core-298 + the T1 variants, `pick._rank`), as BL-133 Amendment 2, with the rules
  live today applied as if live throughout: the expiring-index rule (`expiry.filter_picks`) and, on a day NIFTY's
  label is known and not `0` and the expiry rule did not apply, the SL150% cap (`sl150_cap.cap_picks`). Core picks
  only, Buy add-on left out.
- **Lots, as BL-183 trades:** a non-expiry day with a Dir among the core picks → that Dir at 2 lots, the other two at
  1 (a "4-lot day"); every other day → 1 lot each, book stop ₹9,000 in every arm.
- **Arms (4-lot days only):** a book stop of ₹9k, ₹10k, ₹11k, ₹12k, ₹13k, ₹14k, ₹15k, ₹16k, ₹18k, ₹20k, and none;
  plus **rule** = ₹9,000 + the Dir's own `overall.stop_loss_inr` (₹4,000 if none), today's live setting. The
  reference is **rule**.
- **Replay:** `rotation/portfolio.apply_book` over `one_lot_path` (the nightly update's engine call and sizing date;
  a 2-lot Dir = 2 × its one-lot path, the per-lot stop scaling the owner confirmed); a day whose path cannot be
  replayed is listed and left out.
- **Money:** net = gross − brokerage (2 orders × stored `n_trades` × ₹20 × 1.18 per strategy, as BL-133). Gross
  only otherwise: no slippage (fills at the stop minute's close), turnover charges alike across arms.
- **Windows:** all T1 days from 2025-01-10 to the newest stored day; and the last year, 2025-11-03 → newest.
- **Measures per arm and window:** per day net; change vs **rule** per day with a 90 % circular block bootstrap (5-day
  blocks, 2,000 resamples, seed 20261102); max drawdown (`readout.max_drawdown`); worst day; mean of the worst 5 % of
  days; 4-lot days the stop fired; and against **none**, the days a stop closed a book that ended better than the stop
  ("cost", sum) and worse ("saved", sum). How deep the 4-lot book goes with no stop (its intraday low, percentiles
  P50 / P90 / P99 / min) as context for where a level bites.
- **Reading:** a level "beats the rule" only if its change vs **rule** has a 90 % interval above zero in BOTH windows.
  With 11 levels read on the same days one interval above zero in one window is expected by chance, so a single
  window does not count. Without a beat, the choice is protection (worst day, worst 5 %, drawdown) against any cost,
  stated as the owner's judgement, not a finding. In-sample: T1's universe was selected on part of these days.
- **Look-ahead check:** day d's picks come from results before d; the stop acts on the minute paths in time order.
- **Will not run:** trailing or profit locks, levels for 3-lot days, Core, other lot plans.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl194/dir2_book_stop.py`; results JSON committed; Log entry.
- **Done when:** the Log has the read-out for both windows and every arm.

## Log

- 2026-11-02 — Created; Phase 0 registered before any run.
- 2026-11-02 — **Run as registered** (`research/bl194/dir2_book_stop.py`; `dir2_book_stop_2026-11-02.json`). 437 T1
  days replayed (2025-01-10 → 2026-10-30), none skipped: 218 4-lot days, 186 expiry days (a day with an unknown DTE label counts
  as one, as live does), the rest 3-lot days with no Dir pick. The rule's level was ₹13,000 or ₹12,000 (a Dir with a ₹3,000 stop). Net per day after brokerage, change
  vs the rule with its 90 % interval.

  How deep the 4-lot book goes with no stop (its lowest MTM of the day): median −₹2,459, 10th percentile −₹8,622,
  1st −₹13,308, lowest −₹17,598 (last year: −₹2,099 / −₹8,342 / −₹11,881 / −₹12,116).

  | Stop on 4-lot days | All days: per day, change vs rule (90 %), drawdown, worst day, fired | Last year: per day, change, drawdown, fired |
  |---|---|---|
  | rule (₹12–13k) | +2,016, —, −32,648, −13,941, 3 d | +2,215, —, −27,026, 0 d |
  | ₹9k | +1,965, −51 [−129, +15], −32,126, −13,229, 19 d | +2,111, **−104 [−232, −1]**, −27,026, 8 d |
  | ₹10k | +2,002, −15 [−48, +16], −33,824, −13,229, 15 d | +2,182, −33 [−77, +5], −27,026, 5 d |
  | ₹11k | +1,987, −29 [−66, +2], −33,854, −13,229, 12 d | +2,168, **−47 [−91, −7]**, −27,026, 5 d |
  | ₹12k | +2,007, −10 [−37, +9], −32,122, −13,229, 5 d | +2,191, −24 [−73, +0], −27,026, 1 d |
  | ₹13k | +2,015, −1 [−3, +0], −32,648, −13,941, 3 d | +2,215, 0, −27,026, 0 d |
  | ₹14k | +2,025, +9 [−3, +30], −32,648, −14,532, 1 d | as the rule, 0 d |
  | ₹15k | +2,023, +7 [−7, +28], −32,648, −15,355, 1 d | as the rule |
  | ₹16k | +2,020, +4 [−13, +25], −32,648, −16,678, 1 d | as the rule |
  | ₹18k / ₹20k / none | +2,018, +1 [−18, +22], −32,648, −17,929, 0 d | as the rule |

  **Read under the rule:** no level beats the rule (no interval above zero in either window). Two tight levels are
  below zero on the last year (₹9k, ₹11k), with ₹9k's point estimate negative in both: a stop at or under the 3-lot
  ₹9,000 on a 4-lot day closes days that recover (₹9k: 10 such days −₹43,072 against 9 saved +₹20,177). Levels of
  ₹14k and up differ from the rule on two days in 437: on 2025-05-14 the rule (₹12k that day) fired and the day
  recovered (+₹4,566 to them), which is all of their +₹4 to +₹9 a day; on 2025-04-07 they only make the worst day
  deeper (−₹14.5k to −₹17.9k against −₹13.9k). The
  rule's ₹13,000 is a disaster stop: it fired on 3 of 218 4-lot days (1 %), because the picks' own stops (Widesl
  ₹2,500–3,000 a lot, the 2-lot Dir ₹8,000) already cap most days. **Keep 9k + the Dir's stop.** Weaknesses:
  in-sample (T1's universe was selected on part of these days), fills at the stop minute's close with no slippage
  (a live stop fills worse, which matters most for the rare day it fires), 218 4-lot days and only 3 fires at the
  rule's level; brokerage is charged on the full day's orders in every arm, as registered, though a stop that
  fires early also saves the later re-entry orders (tight levels slightly penalised).
- 2026-11-03 — **Corrected after review** (PR #394). The replay doubled the Dir on any day without a `0` DTE label,
  so 2026-09-30 (SENSEX label unknown) was booked as a 4-lot day; live (`rotation/live_lots.py`) counts an unknown
  label as an expiry day and doubles nothing. The replay now calls `live_lots.lots_for_day` and keeps the first run's
  days (to 2026-10-30); the figures above are the re-run. One day moved: 4-lot days 219 → 218. ₹9k's last-year change
  went from −₹131 [−271, −9] to −₹104 [−232, −1] (all days −₹66 [−152, +8] → −₹51 [−129, +15]) and its drawdown
  from −₹34,714 to −₹32,126; every other level's change is as before. The reading stands: no level beats the rule.
  Also corrected: ₹14k and up change two days, not one (above).

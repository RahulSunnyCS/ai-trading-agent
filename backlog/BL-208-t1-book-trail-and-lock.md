# BL-208 — T1's book stop with a 3:2 trail and a lock at break-even after +₹5,000

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 on AlgoTest in both accounts and is weighing a change to the book stop |
| **Status** | In progress (Phase 0 registered) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-04 |
| **Depends on** | BL-095 (trailing modes in `rotation/portfolio.py`), BL-194 (the T1 book-stop replay this reuses), BL-066 (a trail on another mix) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-11-04): today the book went up to about +₹11,000 and then down to about −₹22,000. Two ideas on top of
today's ₹9,000 book stop: (1) a 3:2 trail, for every ₹3 of profit the stop moves up ₹2; (2) once the book is
+₹5,000, lock the profit at ₹0. BL-066 found no trail that helps on a different mix (DRB-6W3L2) and BL-105 none on
the Dir alone; neither tested T1's book, the owner's 3:2 ratio or a break-even lock.

## Goal

What each idea would have done to T1's book against today's stop. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Book:** T1 list C reconstructed day by day exactly as BL-194 (`daylog.reconstruction`, `pick._rank`, the
  expiry rule, the SL150% cap, core picks only, no Buy add-on), with the same replay (`portfolio.one_lot_path`).
- **Two book shapes, read apart** (Settings v10, 2026-11-03):
  - **Dir ×2** (Shoonya: `dirBoost` on): `live_lots.lots_for_day`; base stop ₹9,000 on 3-lot days and ₹9,000 + the
    doubled Dir's own stop on 4-lot days (BL-194's rule).
  - **3 lots** (Angel One: `dirBoost` off): one lot per pick every day; base stop ₹9,000.
- **Arms**, each on top of that day's base stop S (the level only moves up; everything closes at the close of the
  first minute at or below it; `best` = the day's highest book MTM at a minute close so far, never below 0):
  - **base**: S alone (the reference).
  - **trail 3:2** (owner): level = −S + 2 × floor(best / 3), i.e. `Trail("sl", x=3, y=2)`.
  - **trail 3:2 stepped**: x = ₹3,000, y = ₹2,000 (a platform that moves in steps).
  - **lock 5k→0** (owner): once best ≥ ₹5,000, level ≥ ₹0 (`Trail("lock", a=5000, b=0)`).
  - **both** (owner's two together): level = the higher of trail 3:2 and lock 5k→0.
  - Neighbours, descriptive only (none can be adopted from this item): trail 1:1, trail 3:1, lock 3k→0,
    lock 8k→0, lock 5k→2.5k.
- **Money:** net = gross − brokerage, as BL-194 (2 orders × stored `n_trades` × ₹20 × 1.18 per pick, the full day's
  orders in every arm, which slightly penalises a stop that fires early). No slippage on the paths.
- **Windows:** 2025-01-10 → the newest stored day (2026-11-04), and the last year 2025-11-04 → newest. Each also read
  without 2026-11-04, the day that prompted the idea.
- **Measures per book, arm and window:** net per day; change vs **base** per day with a 90 % circular block
  bootstrap (5-day blocks, 2,000 resamples, seed 20261104); max drawdown (`readout.max_drawdown`); worst day; mean of
  the worst 5 % of days; days the arm fired before the base stop would; on those days the sum given up (the day
  ended better without it) and saved. Context, per book: how often the base book reaches +₹3k / +₹5k / +₹8k at
  some minute, and of those days how often it ends the day below ₹0 and below −₹5,000.
- **Reading:** an owner arm "beats base" only if its change vs **base** has a 90 % interval above zero in BOTH windows,
  read per book. With four owner arms on two books, one interval above zero in one window is expected by chance and
  does not count. Without a beat the choice is protection (worst day, worst 5 %, drawdown) against cost, the owner's
  judgement, not a finding.
- **Red-team, stated up front:**
  - Look-ahead: day d's picks use only results before d; `best` and the level use minute closes up to the current
    minute; the fill is that minute's close (as BL-194).
  - Minute closes understate the intraday peak, so a live trail ratchets higher and fires sooner than this replay;
    and a live stop fills past its level (BL-066: 7–26 % overshoot). Both make a live trail look worse than here on
    the days it fires; the replay is the favourable case for the trail.
  - Data snooping: the idea comes from one day (2026-11-04), hence the read without it; 9 arms on the same days.
  - In-sample: T1's universe was selected on part of these days.
- **Will not run:** other levels of the base stop, Core, other lot plans, per-strategy trails.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl208/book_trail.py`; results JSON committed; Log entry; the
  portfolio-stop findings page updated.
- **Done when:** the Log has the read-out for both books, both windows and every arm, and 2026-11-04 replayed.

## Log

- 2026-11-04 — Created; Phase 0 registered before any run.

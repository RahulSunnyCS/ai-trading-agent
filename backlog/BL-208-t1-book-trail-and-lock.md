# BL-208 — T1's book stop with a 3:2 trail and a lock at break-even after +₹5,000

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 on AlgoTest in both accounts and is weighing a change to the book stop |
| **Status** | Done — informative: the 3:2 trail is about neutral (+₹12 to +₹45 a day, every interval but one includes zero) and trims the worst days a little; the lock at ₹0 after +₹5,000 costs ₹58–163 a day, because the book dips back to ₹0 and recovers far more often than it collapses |
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
- 2026-11-04 — **Run as registered** (`research/bl208/book_trail.py`; `book_trail_2026-11-04.json`). 440 T1 days
  (2025-01-10 → 2026-11-04), none skipped, 220 of them 4-lot days on the Dir ×2 book. The script's own replay matched
  `portfolio.apply_book` on all 4,400 arm-days it can replay. Net per day after brokerage; change vs **base** with its
  90 % interval; "early" = days the arm closed the book before the base stop would.

  How often the book gets to +₹5,000 at some minute, and how it ends those days (base):

  | Book | Reaches +₹5k | of those, ends below ₹0 | ends below −₹5k |
  |---|---|---|---|
  | Dir ×2 | 205 of 440 (47 %) | 14 | 7 |
  | 3 lots | 164 of 440 (37 %) | 11 | 6 |

  **Dir ×2 book** (base +₹1,895 a day all days, +₹2,042 last year):

  | Arm | All days: change [90 %], early days, given up / saved | Last year: change [90 %] | Max drawdown all days (base −33,784) |
  |---|---|---|---|
  | trail 3:2 | +16 [−47, +82], 26 d, −₹30.8k / +₹38.0k | +33 [−49, +112] | −29,339 |
  | trail 3:2 stepped | +24 [−15, +66], 18 d, −₹15.0k / +₹25.4k | +23 [−38, +79] | −33,904 |
  | lock 5k→0 | −133 [−296, +19], 38 d, −₹132.3k / +₹73.8k | −94 [−274, +97] | −33,214 |
  | both | −153 [−322, +9], 54 d, −₹148.9k / +₹81.8k | −110 [−291, +90] | −31,343 |
  | trail 1:1 · 3:1 | −70 [−221, +58] · +15 [−13, +42] | −32 · **+36 [+11, +66]** | −35,493 · −31,810 |
  | lock 3k→0 · 8k→0 · 5k→2.5k | −224 · **−92 [−192, −6]** · −115 | −200 · **−78 [−161, −19]** · −165 | |

  **3-lot book** (base +₹1,628 a day all days, +₹1,669 last year):

  | Arm | All days: change [90 %], early days, given up / saved | Last year: change [90 %] | Max drawdown all days (base −25,013) |
  |---|---|---|---|
  | trail 3:2 | +12 [−47, +71], 28 d, −₹28.7k / +₹33.8k | +45 [−15, +109] | −25,004 |
  | trail 3:2 stepped | **+25 [+1, +52]**, 13 d, −₹6.0k / +₹17.0k | **+39 [+3, +79]** | −25,013 |
  | lock 5k→0 | −58 [−198, +72], 27 d, −₹87.2k / +₹61.8k | −72 [−233, +98] | −29,038 |
  | both | −76 [−220, +62], 47 d, −₹106.2k / +₹72.9k | −73 [−239, +97] | −29,029 |
  | trail 1:1 · 3:1 | −44 · +12 [−15, +38] | +5 · **+33 [+10, +60]** | |
  | lock 3k→0 · 8k→0 · 5k→2.5k | −133 · −18 · −32 | −2 · −8 · −52 | |

  Without 2026-11-04: the stepped 3:2 trail on the 3-lot book falls to +22 [−3, +48] (all days) and +33 [−0, +70] (last
  year); the lock 5k→0 on the Dir ×2 book to **−163 [−316, −17]** and "both" to **−183 [−342, −30]**, below zero.

  2026-11-04 itself (paper, minute closes): the Dir ×2 book peaked at +₹7,831 at a minute close and fell to −₹13,090,
  closed by the ₹13,000 stop at 12:25 (net −₹13,845); the 3-lot book peaked at +₹4,535 and closed at the ₹9,000
  stop at 12:25 (−₹9,498). Together that is about +₹12.4k to −₹22.1k, the owner's two accounts. Under trail 3:2 they
  close at −₹8,774 and −₹6,622; under lock 5k→0 at −₹808 and −₹9,498 (the 3-lot book never reached +₹5,000).

  **Read under the rule:** one owner arm passes, narrowly: the stepped 3:2 trail (₹2,000 per ₹3,000) on the 3-lot book,
  +₹25 and +₹39 a day with both intervals just above zero. It is not counted as a finding: both lower bounds are +₹1
  and +₹3, it is one pass in eight owner tests, it fails on the Dir ×2 book, and without the day that prompted the idea
  both intervals include zero. The continuous 3:2 trail passes nowhere. The trails are about neutral on money and
  protective at the edges (Dir ×2 trail 3:2: drawdown −33.8k → −29.3k, worst 5 % −11.1k → −10.5k; 3-lot: worst day
  −12.1k → −10.2k); the replay is their favourable case (minute closes understate the peak, fills at the level).
  **The lock at ₹0 after +₹5,000 costs money in every window and both books** (−₹58 to −₹163 a day; on the Dir ×2
  book below zero over all days once today is left out): of the 205 Dir ×2 days that reach +₹5k only 14 end below ₹0, so a break-even lock mostly
  closes days that dip and recover (27 days −₹132k against 11 saved +₹74k). A later lock, at +₹8,000, costs less a day but
  its interval is below zero in both windows on the Dir ×2 book; a looser trail, 3:1, is the one arm above zero on the last year in
  both books (descriptive only, not adoptable from this item). Weaknesses: in-sample, no slippage, minute closes, 9
  arms on the same days.

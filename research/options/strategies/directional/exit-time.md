# Directional: exit time

**Status:** Tested (14:55 exit, BL-147); otherwise Descriptive · **Last updated:** 2026-10-28

## What it is

The minute any leg still open is bought back. Set by `exit_time` (HH:MM).

## Live value

15:28 in the live file, the fixed base and every rotation Dir file.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-096 primary | 14:50, 15:00, 15:10, 15:20, 15:28 × leg stop × MTM, all 100 Dir bases | holdout 2025-10-09 → 2026-10-09, before and **after charges** (15k charged grid) | Descriptive: 15:28 clearly best after charges | [BL-096][bl096] |
| BL-147 | 14:55 vs 15:28, all else unchanged: the 710 T1 + Core Dir pick-days (A) and all 161 Dir variants (B) | A 2025-01-10 → 2026-10-19 (re-scored, not forward); B 2024-10-09 → 2026-10-19; gross per lot, no charges | Pre-registered: **closing at 14:55 hurts**, −122 per trade-day [−168, −76], 0 of 161 variants improve, drawdown −33,379 → −41,322 (can be understated, see page). A conditional exit (14:55 only when the index is down ≥ 0.6%) is **not better**; that part is **post-hoc, exploratory** (owner override recorded after the run, 2026-10-24) | [BL-147][bl147]; [page](../../common/directional-early-exit.md) |
| [BL-184][bl184] | A 13:00 exit, as the morning half of a two-set day (a fresh Dir 13:02–15:28 follows) | 434 Adaptive pick days 2025-01-10 → 2026-10-27, after charges, seen data | A Dir closed at 13:00 earns ₹81 a day net alone (drawdown −42,574); with the afternoon set the pair reads +₹31 [−214, +251] against the whole day, drawdown deeper. Killed | [Session split](session-split.md) |
| [BL-187][bl187] | Dir ended 2 minutes before the strongest late Widesl enters (14:00 to 15:15, set daily by Adaptive's morning ranking), that Widesl run in its place | 434 Adaptive pick days 2025-01-10 → 2026-10-27, T1 and Core books, after charges, seen data | Not adopted: cutting the Dir alone costs −₹43 [−68, −20] net per margin lot-day; with the Widesl added the book gains +₹32 [−11, +74], drawdown deeper, gone at about ₹115 late-fill cost per swapped lot | [BL-187][bl187] |

Full 15k charged grid, mean net ₹ per day by exit ([BL-096][bl096] Log): 15:28 ₹136, 15:10 ₹62, 15:20 ₹45,
15:00 ₹32, 14:50 −₹23.

## What we know

- After charges, holding to 15:28 earns about twice the next-best exit, and every post-charge band leader
  exits at 15:28 ([post-charge list][bl096pc]).
- 15:20 below 15:10 is odd; the item flags it for a check of late-bar fills.
- Before charges, a few single start times rank an earlier exit first (for example NIFTY 11:02 ITM1 25% /
  ₹4,000 / 15:00, ₹658 a day; [15k exact-time list][bl096x]). These are many-trial cells.
- Late-session fills use 1-minute prices with no spread ([BL-059][bl059]).
- Before charges too, BL-147 found 14:55 worse than 15:28 on the picks and on every Dir family; it helps on
  roughly 16% of days (a late recovery after a fall, or a late fade after a rise), too rare to pay for the
  rest ([BL-147][bl147]).
- Ending the Dir early to free its lot for a late Widesl (BL-187): the Dir's last hour is worth about ₹43 a margin lot-day net, as BL-147 found at 14:55; the Widesl that replaces it earns more (+₹75) but the book's net gain is inside the noise and inside a plausible late-fill cost ([BL-187][bl187]).

## Not yet tested

- The late-bar fill check behind the 15:20 / 15:10 ordering.
- Exit time with a trail or other re-entry settings (the charged grid kept COST ×1, no trail).

## Related

- [Widesl exit time](../widesl/exit-time.md); [closing Dir at 14:55](../../common/directional-early-exit.md).
- Results: `research/bl096/results/primary_diagnostics_charged.csv` (git-ignored; regenerate with
  `research/bl096/run_enriched.py --full-primary`).

[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl147]: ../../../../backlog/BL-147-directional-early-exit.md
[bl184]: ../../../../backlog/BL-184-directional-split-session.md
[bl096pc]: ../../../../backlog/BL-096-directional-qualified-list-post-charge.md
[bl096x]: ../../../../backlog/BL-096-directional-qualified-list-primary-15k-exact-times.md
[bl187]: ../../../../backlog/BL-187-dir-cut-late-widesl.md

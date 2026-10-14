# Directional: exit time

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The minute any leg still open is bought back. Set by `exit_time` (HH:MM).

## Live value

15:28 in the live file, the fixed base and every rotation Dir file.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-096 primary | 14:50, 15:00, 15:10, 15:20, 15:28 × leg stop × MTM, all 100 Dir bases | holdout 2025-10-09 → 2026-10-09, before and **after charges** (15k charged grid) | Descriptive: 15:28 clearly best after charges | [BL-096][bl096] |

Full 15k charged grid, mean net ₹ per day by exit ([BL-096][bl096] Log): 15:28 ₹136, 15:10 ₹62, 15:20 ₹45,
15:00 ₹32, 14:50 −₹23.

## What we know

- After charges, holding to 15:28 earns about twice the next-best exit, and every post-charge band leader
  exits at 15:28 ([post-charge list][bl096pc]).
- 15:20 below 15:10 is odd; the item flags it for a check of late-bar fills.
- Before charges, a few single start times rank an earlier exit first (for example NIFTY 11:02 ITM1 25% /
  ₹4,000 / 15:00, ₹658 a day; [15k exact-time list][bl096x]). These are many-trial cells.
- Late-session fills use 1-minute prices with no spread ([BL-059][bl059]).

## Not yet tested

- The late-bar fill check behind the 15:20 / 15:10 ordering.
- Exit time with a trail or other re-entry settings (the charged grid kept COST ×1, no trail).

## Related

- [Widesl exit time](../widesl/exit-time.md).
- Results: `research/bl096/results/primary_diagnostics_charged.csv` (git-ignored; regenerate with
  `research/bl096/run_enriched.py --full-primary`).

[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl096pc]: ../../../../backlog/BL-096-directional-qualified-list-post-charge.md
[bl096x]: ../../../../backlog/BL-096-directional-qualified-list-primary-15k-exact-times.md

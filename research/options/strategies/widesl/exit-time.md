# Widesl: exit time

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

The minute any leg still open is bought back. Set by `exit_time` (HH:MM); it must be after `entry_time`.

## Live value

15:28 on NIFTY OTM1, SENSEX OTM2 and every rotation Widesl file. The live NIFTY closest-₹65 file exits at
15:25.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-098 Phase 2 | 14:50, 15:00, 15:10, 15:20, 15:28 (baseline) | holdout 2025-10-09 → 2026-10-09, **after charges** | Descriptive; no earlier exit reached any top-four list | [BL-098][bl098], [report][bl098q] |
| [BL-182][bl182] | A 12:00 exit, as the morning half of a two-set day (a fresh set 13:00–15:28 follows) | 2024-10-09 → 2026-10-27, 501 days, after charges, seen data | A 09:17–12:00 set alone earns +141 (NIFTY) / +266 (SENSEX) net a day against +239 / +260 for the whole day; with the afternoon set added the pair beats the whole day on point but not on the registered interval. Killed | [Session split](session-split.md) |

## What we know

- No exit earlier than 15:28 ranks in the top four of any index × band list after charges. The item
  prints no exit-time table, so the size of the difference is not known from the record.
- The Directional sweep, which does print it, found 15:28 clearly best for Dir (see
  [Directional exit time](../directional/exit-time.md)). A short strangle earns its decay into the close,
  so the same direction is plausible here; it is not shown.
- Late-session prices are the weakest part of the engine (1-minute bars, no spread; [BL-059][bl059]).
  Exits at 15:28 are filled at the 15:28 bar.

## Not yet tested

- An exit-time table for Widesl: the rows exist in the raw sweep file and only need summarising.
- A midday exit on its own (without the afternoon re-entry) as a rule: BL-182 reports the morning half only as a
  component.
- Exit × MTM stop interaction (BL-098 Phase 3, now BL-104).
- 15:25 (the ₹65 file) against 15:28.

## Related

- Raw rows: `research/bl097/results/widesl_sweep_postcharge.csv` (git-ignored; regenerate with
  `research/bl097/run_family_sweep.py --family widesl`).

[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl098]: ../../../../backlog/BL-098-widesl-parameter-sweep.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
[bl182]: ../../../../backlog/BL-182-widesl-split-session.md

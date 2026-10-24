# Buy: exit time

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The minute any open leg is sold, and the last minute a breakout can still enter (no `valid_until` is
set, so the breakout stays armed until the exit). Set by `exit_time`.

## Live value

15:14, live and rotation (earlier than Widesl and Dir, which exit at 15:28).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | 14:50, 15:00, 15:10, 15:20, 15:28 (base 15:14) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; 14:50 leads both 13:00–15:30 bands and is in the top three of NIFTY morning and midday; 15:28 leads SENSEX 09:15–11:00 | [BL-097][bl097], [report][bl097q] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ gross | Fit Δ net | Holdout Δ gross | Holdout Δ net | Files ≥ base (fit) | Files ≥ base (holdout) |
|---|---|---|---|---|---|---|---|
| 14:50 | 44 | −3,054 | −2,327 | +3,577 | +4,323 | 25% | 95% |
| 15:00 | 46 | −2,114 | −1,437 | +1,601 | +2,375 | 33% | 89% |
| 15:10 | 46 | −1,201 | −1,119 | +54 | +155 | 4% | 50% |
| 15:20 | 48 | −1,857 | −2,136 | −561 | −867 | 10% | 25% |
| 15:28 | 48 | −537 | −1,041 | −130 | −649 | 56% | 58% |

Files missing from a row are start times the exit makes invalid (the range would end after the exit).

## What we know

- Exiting at 14:50 or 15:00 helped on almost every file in the holdout year and hurt on most files in
  the fit year. The two years point opposite ways, so this is not a finding.
- Holding later than 15:14 (15:20, 15:28) is worse in both years on most files.
- The ranked report's afternoon leaders are 14:50 rows, but they still lose ₹44–₹68 a day per file
  after charges ([BL-097 report][bl097q]).

## Not yet tested

- Trail × exit time, a registered BL-097 Phase 3 interaction, now BL-104.

## Related

- [Widesl exit time](../widesl/exit-time.md), [Directional exit time](../directional/exit-time.md),
  [breakout validity](breakout-validity.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

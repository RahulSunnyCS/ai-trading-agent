# Buy: breakout validity (deadline)

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The last minute a breakout may still buy the leg. With `valid_until: "HH:MM"` a leg that has not
broken out by then is done for the day with no entry; without it the breakout stays armed until the
exit. It removes late, tired breakouts. Added to `RangeBreakout` for BL-097 (`legwise/schema.py`);
it must fall after `until` and no later than the exit.

## Live value

None (armed until 15:14), live and rotation.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | range end + 15, + 30, + 60, + 120 minutes (`valid_plus_N`; base none) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; no validity row in a top-three list | [BL-097][bl097], [report][bl097q] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ gross | Fit Δ net | Holdout Δ gross | Holdout Δ charges | Holdout Δ net | Files ≥ base | No-entry days |
|---|---|---|---|---|---|---|---|---|
| + 15 | 46 | −1,835 | +4,508 | −1,894 | −6,669 | +4,775 | 76% | 15.5% |
| + 30 | 44 | −1,710 | +2,557 | −2,552 | −4,477 | +1,925 | 68% | 7.4% |
| + 60 | 40 | −1,543 | +939 | −2,397 | −2,715 | +318 | 58% | 3.6% |
| + 120 | 32 | −1,172 | +36 | −2,117 | −1,450 | −667 | 59% | 2.1% |

Baseline no-entry days 4.9% over all 48 files. Files drop out when the deadline would fall after the
15:14 exit (16 invalid at + 120), so each row covers a different set of mostly earlier start times;
compare rows with care.

## What we know

- A deadline lowers gross in both years at every length: late breakouts made money on average. Cutting
  them never improved the strategy before charges.
- Net improves at + 15 and + 30 only because skipped legs pay no charges (no-entry days rise to 15.5%
  at + 15). The gross loss is smaller than the charges saved.
- That is a charges effect, not a better breakout. A random-skip control with the same entry rate
  would be needed before reading anything into it.

## Not yet tested

- A random-skip comparator at the same entry rate.
- Validity × range window (a short deadline after a longer range).

## Related

- [Exit time](exit-time.md), [breakout window](breakout-window.md), [breakout gap](breakout-gap.md),
  [charges](../../common/charges.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

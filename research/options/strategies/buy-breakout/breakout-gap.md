# Buy: breakout gap (buffer)

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

How far beyond the range high the premium must go before the leg is bought. With `gap_percent: g`
the trigger is `range high × (1 + g/100)`, rounded to the 0.05 tick for an option premium; the fill
is at that level, or the bar's open if it gapped through. It asks the breakout to show some
follow-through before paying for it. Added to `RangeBreakout` for BL-097 (`legwise/schema.py`); the
default 0 is left out of the saved spec so existing files keep their hash.

## Live value

0 (the plain range high), live and rotation.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | 0.5%, 1%, 2% above the range high (`gap_<g>pct`; base 0) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; no gap row in a top-three list | [BL-097][bl097], [report][bl097q] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ gross | Fit Δ net | Holdout Δ gross | Holdout Δ charges | Holdout Δ net | Files ≥ base | No-entry days |
|---|---|---|---|---|---|---|---|---|
| 0.5% | 48 | −29 | +258 | −720 | −264 | −456 | 48% | 5.2% |
| 1% | 48 | −201 | +381 | −508 | −576 | +68 | 50% | 5.7% |
| 2% | 48 | −33 | +1,167 | −580 | −1,156 | +575 | 62% | 6.7% |

Baseline no-entry days 4.9%.

## What we know

- A gap never raises gross: it is flat in the fit year and lower in the holdout at every size. Paying
  a little more to confirm the breakout buys nothing before charges.
- Any net gain is from trading less: a 2% gap skips some marginal breakouts (no-entry days 4.9% →
  6.7%), which saves about ₹1,156 of charges a file in the holdout.
- A 2% buffer on a ₹50 option is ₹1, about 20 ticks; 0.5% is 5 ticks. Points (₹0.5, ₹1, ₹2) were an
  open alternative in BL-097 and were not run.

## Not yet tested

- Range window × gap (a registered BL-097 Phase 3 interaction).
- An absolute gap in points.
- A random-skip control: dropping the same share of entries at random would show how much of any net
  gain is just fewer charges.

## Related

- [Breakout window](breakout-window.md), [breakout validity](breakout-validity.md),
  [candle position](candle-position.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

# Buy: leg stop

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

Each bought leg is closed when its premium falls the stated percentage below the entry price
(`stop_loss: { percent: 25 }`). The trail (see [trail](trail.md)) then lifts that stop as the premium
rises. The stop is checked on 1-minute bars; a gap through it fills at the bar's open.

## Live value

25% on both legs, live and rotation.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | 15%, 20%, 30%, 35%, 40% (base 25%) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; 20% and 15% reach top-three lists | [BL-097][bl097], [report][bl097q] |
| BL-070 | Overall stop removed (leg stop kept) | 2024-10 → 2026-10, before charges | Buy's ₹2,000 overall stop fired on about 1 day (NIFTY) and 0 (SENSEX) per variant; the leg stop acts first | [BL-070][bl070] |
| BL-156 Amendment 1 | Leg stop checked on every tick (the engine: bar high / low) vs at the 1-minute close (exit at that close), crossed with the MTM rule | T1's Adaptive picks, 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **Tick is better**: candle-close leg stops cost −₹432 a day on the book (−₹591 to −₹272), in every half-year; Buy: −₹197 a pick (52 picks, descriptive) | [BL-156][bl156] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ net | Holdout Δ net | Holdout Δ drawdown | Files ≥ base | Files net > 0 |
|---|---|---|---|---|---|---|
| 15% | 48 | +848 | +2,059 | +5,266 (shallower) | 67% | 3 |
| 20% | 48 | −713 | +1,643 | +2,650 | 65% | 4 |
| 30% | 48 | +1,024 | −529 | −2,362 | 46% | 3 |
| 35% | 48 | −190 | −2,337 | −4,505 | 44% | 4 |
| 40% | 48 | −990 | −1,135 | −3,929 | 54% | 8 |

Charges hardly move (a leg stop does not add trades); the gross and net changes are the same within
₹10 a file. In the ranked report 20% leads NIFTY 11:00–13:00 (−₹26 a day) and is second in NIFTY
09:15–11:00; 15% is second in both 13:00–15:30 bands ([BL-097 report][bl097q]).

## What we know

- In the holdout year tighter stops (15%, 20%) did better than 25% on about two thirds of the files and
  had shallower drawdowns; wider stops (30–40%) did worse.
- The fit year does not agree cleanly: 15% is slightly better, 20% slightly worse, 30% better. So the
  direction "tighter is better" rests on one year.
- No stop level turns Buy positive after charges: the best rows are still −₹26 to −₹76 a day per
  file in the bands where they rank.
- About 85% of the baseline's holdout trades end at the leg stop (computed from the CSV), so this is
  the setting that shapes almost every Buy trade.

## Not yet tested

- BL-097 Phase 3: leg stop × overall stop, and the reserved trailing-percent rows.

## Related

- [Widesl leg stop](../widesl/leg-sl.md), [Directional leg stop](../directional/leg-sl.md),
  [overall stop](mtm-sl.md), [trail](trail.md).

[bl070]: ../../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md
[bl156]: ../../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md

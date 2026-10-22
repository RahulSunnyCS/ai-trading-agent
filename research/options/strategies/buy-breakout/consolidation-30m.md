# Buy: 30-minute consolidation before the breakout

**Status:** Not tested · **Last updated:** 2026-10-14

## What it is

The owner's idea (2026-10): buy a breakout only after the price has been **quiet and contained** for
about 30 minutes. A breakout out of a tight band is expected to follow through more often than one
out of a wide, noisy range. The definitions below are proposals for the owner to confirm; nothing has
been run.

**Proposed definition.** Take the 30 one-minute bars that end at the minute the breakout is armed
(the end of the range). Measure how tight they are. Arm the breakout only if the band is tight;
otherwise the leg does not trade that day.

Choices to confirm:

| Choice | Option 1 | Option 2 |
|---|---|---|
| Price watched | the leg's own premium (as the breakout is today) | the index (one measure for both legs) |
| Where the 30 minutes sit | the range window itself, lengthened to 30 minutes (entry → entry + 30) | a rolling 30 minutes ending at any minute: the first tight band of the day sets the level |
| Tightness measure | **width:** (highest high − lowest low) of the 30 bars ÷ the premium at the start, in % | **containment:** count of bars whose high and low stay inside a band of ±X% around the 30 bars' median close |
| Also possible | the widest and narrowest 5-bar sub-range (max/min band ratio): is the band narrowing? | |

A rule then reads, for example: "arm only if width ≤ W%" or "arm only if at least K of 30 bars stay
inside ±X%". W, X and K are not chosen; a test would fix a small grid of them in advance.

## How it differs from what was tested

- **Breakout window** (`range_plus_30`, [page](breakout-window.md)) sets the range *length* to 30
  minutes but buys on any break of its high, however wide the range was. Consolidation adds a
  *tightness* condition on top; option 1 above is exactly `range_plus_30` plus a filter.
- **Gap** ([page](breakout-gap.md)) asks the breakout bar to go X% beyond the level: it judges the
  move *after* the range. Consolidation judges the range *before* it.
- **Validity** ([page](breakout-validity.md)) limits *when* a breakout may still happen; it says
  nothing about the range's shape.

## Live value

None; no Buy file has a tightness condition.

## What the engine supports today

`RangeBreakout` (`legwise/schema.py`) has `until`, `gap_percent`, `valid_until`, `side` and `source`.
The engine (`_step_range` in `legwise/engine.py`) keeps only the running range high and low; it keeps
no per-bar record, no width test and no rolling window. So:

- Option 1 (fixed 30-minute range) can be studied **without an engine change**: compute the width from
  the lake's 1-minute bars before `until`, then filter per-day results of `range_plus_30` runs. BL-097
  kept only per-file summaries, so those runs must be repeated with per-day rows saved. A live rule
  would still need a new field (for example `max_width_percent`).
- Option 2 (rolling band) changes the entry minute, so it needs an engine extension and fresh runs.

## What a test would need

- A backlog item with a committed Phase 0 (`backlog/_TEMPLATE.md`) before any run: hypothesis, the
  fixed grid (two or three widths), the comparator, pass / kill rule and "will not run" list
  (CLAUDE.md research gate).
- Red-team first: **look-ahead** (only bars before the arming minute; a rolling window must not peek at
  the breakout bar); **survivorship** (index options, so little, but days with missing contracts must
  be logged, not zero-filled); **data snooping** (the Buy family has already been swept 48 ways in
  [BL-097][bl097]; count those trials).
- Comparators: `range_plus_30` unfiltered on the same files, and a random-skip control that drops the
  same share of entries at random. Any filter cuts trades and therefore charges, which alone lifts net
  (see [breakout validity](breakout-validity.md)); the control separates that from a real effect.
- Report before and after charges, entry-hit rate and no-entry days.
- Hold-out: the BL-097 years have been read many times; NIFTY 2022–24 (in the lake since BL-071) is the
  cleaner unseen period. SENSEX has no options data before 2023-07.

## Related

- [Candle position](candle-position.md), the other half of the owner's idea.
- [BL-035][bl035] (Momentum) has the same "tightness" idea for weekly prices; it is a separate item.

[bl035]: ../../../../backlog/BL-035-consolidation-tightness-feature.md
[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
- The same ideas on the index with a 1-minute entry, tested in [BL-152](../breakout/README.md) (killed).

# Buy: candle position before the breakout

**Status:** Not tested · **Last updated:** 2026-10-14

## What it is

The owner's idea (2026-10): before a breakout, look at **where the 1-minute candles close inside the
range**. If most closes sit near the top, buyers are pressing against the level and a break is more
likely to carry on; if they sit low and one spike made the high, the break is weaker. The
definitions below are proposals for the owner to confirm; nothing has been run.

**Proposed measure.** Over the pre-breakout window (the range window, [entry, until)), count the
1-minute candles whose close is in the upper part of the range, and divide by the number of candles.
Arm the breakout only if that share is high enough.

Choices to confirm:

| Choice | Option 1 | Option 2 |
|---|---|---|
| "Upper part" | close in the upper half: close ≥ (range low + range high) / 2 | close within X% of the breakout level: close ≥ range high × (1 − X/100) |
| Candles counted | all candles in the window | only the last K candles (pressure *just before* the break) |
| Price watched | the leg's own premium (as the breakout is today) | the index (needs a direction per leg: upper half for the call, lower half for the put) |

A rule then reads, for example: "arm only if at least 60% of closes are in the upper half". The cut
(60 / 70 / 80%) and X are not chosen; a test would fix a small grid in advance.

**Window length matters.** The live range is 10 minutes, so the share moves in steps of 10% and a
single candle changes it. With a 30-minute range (`range_plus_30`, the strongest BL-097 lead) the
share is steadier. The two ideas combine naturally with [30-minute consolidation](consolidation-30m.md).

## How it differs from what was tested

- **Breakout window** (`range_plus_N`, [page](breakout-window.md)) changes how long the range is; it
  does not look inside it.
- **Gap** ([page](breakout-gap.md)) asks the breakout bar to go beyond the level; candle position is
  read *before* the breakout bar, from candles already closed.
- **Validity** ([page](breakout-validity.md)) is a deadline after the range; it ignores the range's
  shape.
- **Consolidation** measures how *narrow* the range is; candle position measures where the closes
  *sit* within it. A wide range can still have most closes near the top.

## Live value

None.

## What the engine supports today

Nothing. `RangeBreakout` (`legwise/schema.py`) has `until`, `gap_percent`, `valid_until`, `side` and
`source`; the engine keeps only the running range high and low (`_step_range`), not closes. As with
consolidation, a first study can compute the share from the lake's bars before `until` and filter
per-day results re-run with per-day rows saved; a live rule would need a new field (for example
`min_upper_close_share`).

## What a test would need

- A committed Phase 0 in a backlog item before any run, per the CLAUDE.md research gate, with the
  grid, comparator and pass / kill rule fixed; a dated `override:` for anything outside it.
- Look-ahead: only candles that closed before the arming minute; the breakout bar itself never counts.
- Comparators: the same files without the filter, and a random-skip control at the same entry rate,
  because a filter that skips trades saves charges whatever it measures.
- Report before and after charges, entry-hit rate and no-entry days.
- Hold-out: NIFTY 2022–24 (unseen for Buy); the BL-097 years are already heavily used
  ([BL-097][bl097]).
- If tested together with consolidation, count every combination as a trial.

## Related

- [30-minute consolidation](consolidation-30m.md), [breakout window](breakout-window.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md

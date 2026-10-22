# Five-minute breakout: the breakout level

**Status:** Tested (killed) · **Last updated:** 2026-10-23

## What it is

The level the 5-minute candle must break, up or down. Four were tested, each used by all 48 combinations of
stop, trade and exit (`research/bl152/specs.py`, `levels()`):

| Id | Level (up side; the down side mirrors it) |
|---|---|
| `or30` | the 09:15 to 09:44 high; breakouts count from the 09:45 candle |
| `roll30` | the high of the 30 one-minute bars ending 5 minutes before the breakout candle |
| `held30` | the day's high before the candle, which was already the day's high 30 minutes earlier |
| `prevday` | the previous session's high |

## Live value

None. Nothing trades this.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| Level | `or30`, `roll30`, `held30`, `prevday` x 48 combinations each | NIFTY, 2024-10-09 to 2026-10-08, after charges, 1 lot | Killed: no variant has t >= 2 | [BL-152][bl152] (Phase 3 Log) |

## What we know

- Trades per level: `or30` 200, `roll30` 370, `held30` 52, `prevday` 113 (the same events for every
  combination of that level).
- Average net per trade across a level's 48 variants, and how many of the 48 are positive:
  `or30` −₹157 (8), `roll30` −₹52 (14), `prevday` −₹97 (13), **`held30` +₹267 (42)**.
- `held30` looks good but rests on 52 trades over two years. Its best variants have t about 1.2 to 1.6,
  and the four trades that BL-153 found supported produced a mean of +₹4,083, which is a handful of days.
  Descriptive, not a finding.
- Every level's trade beat 94% to 100% of random entries at other minutes after the same breakout, so
  entering at the breakout is better than entering later in the same move (the same direction as the
  DD Nifty video's delay test). That alone does not make the trade profitable.

## Not yet tested

- A longer history for `held30`: the 2022 to 2024 period was never opened, because nothing advanced.
- Other level lengths (45 or 60 minutes), other body shares than 60%, other indices.

## Related

- [Buy breakout: 30-minute consolidation](../buy-breakout/consolidation-30m.md) and
  [candle position](../buy-breakout/candle-position.md): the same ideas on an option's premium, not the index.

[bl152]: ../../../../backlog/BL-152-five-minute-breakout-hold-entry.md

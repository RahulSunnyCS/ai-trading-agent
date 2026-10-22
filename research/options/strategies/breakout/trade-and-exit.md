# Five-minute breakout: the trade, the stop and the exit

**Status:** Tested (killed) · **Last updated:** 2026-10-23

## What it is

What is traded on a breakout, and how it is closed. Three trades, four stops and four exits were crossed with
every level (192 variants); the trade is 1 lot of the nearest weekly.

| Variable | Values |
|---|---|
| Trade | `atm`: buy the ATM CE (up) or PE (down). `pct1`: buy the strike whose premium is about 1% of the index. `sellopp`: sell the ATM PE on an up breakout, the ATM CE on a down one |
| Stop | `lvl`: a 1-minute close back through the frozen level. `cndl`: a close beyond the breakout candle's far end. `prem30`: the option's premium moves 30% against the leg. `atr03`: a close 0.3 x ATR-14 from the entry close |
| Exit | `eod`: hold to 15:15. `trail`: the 5-minute Supertrend (10, 3) turns. `tgt2r`: twice the risk (a 60% premium target with `prem30`). `t60`: 60 minutes after entry |

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| Trade, stop, exit | 3 x 4 x 4 per level | NIFTY, 2024-10-09 to 2026-10-08, after charges, 1 lot | Killed | [BL-152][bl152] |

## What we know

- Average net per trade, and how many variants are positive: `atm` −₹71 (15 of 64), `pct1` −₹16 (22 of 64),
  **`sellopp` +₹59 (40 of 64)**. Before charges the same trades average −₹26, +₹47 and +₹104.
- Selling the opposite side is the only trade type with a positive average, but its best variant is
  `roll30_prem30_sellopp_trail` at +₹156 a trade, t = 1.65 over 370 trades: not significant.
- Stops and exits matter little: average net by stop `atr03` +₹19, `lvl` −₹37, `cndl` −₹14, `prem30` −₹7; by exit
  `tgt2r` +₹14, `eod` +₹3, `trail` −₹21, `t60` −₹34. The differences are inside the noise of 48 variants each.
- Slippage of 0.5% per fill leaves 49 of 192 variants positive, 1% leaves 28.
- Direction of the finding matches the rest of this repo: premium selling does better than option buying
  ([Buy breakout](../buy-breakout/README.md) loses after charges too).

## Not yet tested

- Re-entry after a stop (one trade a day was the registered limit), scaling in, a trailing stop on the premium.

## Related

- [Breakout level](level.md), [Index support](index-support.md).

[bl152]: ../../../../backlog/BL-152-five-minute-breakout-hold-entry.md

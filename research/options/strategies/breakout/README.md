# Five-minute breakout, hold, 1-minute entry (NIFTY)

**Last updated:** 2026-10-23 · **Status:** Tested (killed) · Items: [BL-152][bl152], [BL-153][bl153]

## Definition

The owner's idea of 2026-10-22, written as a BL-120 rule (`packages/option-backtesting/research/bl152/specs.py`):

1. A 5-minute NIFTY candle opens on one side of a level, closes beyond it, and at least 60% of its body
   (open to close, wicks ignored) is beyond the level. It must close by 13:59.
2. The level is frozen at that candle. No 1-minute close may come back through it afterwards.
3. The trade is taken on the first 1-minute close beyond the breakout candle's high (low, for a down
   breakout), filled at that minute's close. At most one trade a day, 09:19 to 14:15, one lot, out by 15:15.

Left open by the owner, so every combination was tested: 4 levels x 4 stops x 3 trades x 4 exits = 192
variants, registered before any run in [BL-152][bl152] Phase 0.

## What we know in one paragraph

No variant passed. Over 2024-10-09 to 2026-10-08, after charges, none of the 192 reached the registered
t-statistic of 2.0 (best 1.65), the overfitting check failed (PBO 0.51 over 8 blocks, limit 0.5; deflated
Sharpe of the best variant 0.27), and the locked 2022 to 2024 period was never opened because nothing
advanced. Buying the option lost on average; selling the opposite side was the best trade type but is not
distinguishable from zero. A follow-up asked whether Bank Nifty, Nifty IT and Reliance also being beyond
their own levels makes a breakout better: it does not, in any of the four reference variants
([BL-153][bl153]).

## Variables

| Variable | Status | One-line takeaway |
|---|---|---|
| [Breakout level](level.md) | Tested (killed) | Only the held day high looks good (+₹267 a trade on average), on 52 trades; the other three average negative |
| [Trade, stop and exit](trade-and-exit.md) | Tested (killed) | Selling the opposite side beats buying (+₹59 vs −₹71 / −₹16 a trade); stop and exit choices move little |
| [Index support (Bank Nifty, Nifty IT, Reliance)](index-support.md) | Tested (killed) | Two of three beyond their own level made no reliable difference |

## Reproduce

The result files are git-ignored. `packages/option-backtesting/research/bl152/`: `specs.py` (the 192
rules), `run_grid.py` (one ledger test per variant), `judge.py` (the registered rule); BL-153 is
`research/bl153/support.py`. Needs NIFTY 1-minute bars and the weekly option chain for 2024-10 to 2026-10.

[bl152]: ../../../../backlog/BL-152-five-minute-breakout-hold-entry.md
[bl153]: ../../../../backlog/BL-153-breakout-support-from-bank-it-reliance.md

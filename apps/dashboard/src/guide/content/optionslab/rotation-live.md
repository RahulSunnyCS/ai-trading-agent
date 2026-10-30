## What it is for

The strategies you run on AlgoTest and Quantiply are the same ones the backtest scores every
evening. This card puts the two side by side, so you can see how much the real fills cost compared
with the paper result. That gap is **slippage**. The paper side here never carries the Rotation
page's 0.5% Slippage switch, so the gap is the whole difference the real fills made.

At 15:40 on each trading day the scheduler reads what each platform shows for the day's tool
strategies and writes one file per day. This card reads those files and the stored paper results.
It never places, changes or deletes anything, and it does not change a pick, a list or a message.

## How the gap is worked out

For each strategy the tool ran, on each platform and list:

- **Live** is what the platform made, divided by the lots it ran (two copies at 1x count as two
  lots, so a copy you run on purpose is a count, never slippage).
- **Paper** is the engine's result for the same strategy and day at one lot.
- The same estimated costs come off both sides.
- **Slippage = live − paper.** A **+** figure means live did better than paper; a **−** figure means
  it did worse.

The percentage is the gap as a share of the premium at the first entry, per lot. It needs the
fills, which AlgoTest shows and Quantiply does not, so Quantiply rows have no percentage (a dash,
not a zero).

## What you see

| Part | What it shows |
|---|---|
| **Totals** | Per platform and list: the days compared, live and paper added up, and the slippage. The last row is your own (discretionary) trades. |
| **Chart** | Cumulative slippage, one line per platform and list. Falling means live keeps doing worse than paper. |
| **Day by day** | Each captured day, newest first, per platform and list, with flags. Closed until you open it; Adaptive Classic's figure per day is also a column of the Daily log. |
| **Slippage by shape** | The gap added up by platform, side (sell or buy) and entry time band. A shape with few days is marked *thin*. |

## Flags on a day

A flagged strategy is kept out of the gap and listed on its own.

| Flag | Meaning |
|---|---|
| **Not captured** | There is no file for the day (the scheduler was off, or a platform could not be read). It is a gap in the data, not a zero. |
| **did not trade** | Deployed or enabled, but nothing filled. |
| **off-slot** | The first fill was away from the strategy's entry minute (deployed late, say), so it is not the backtested trade. |
| **with legs open** | Legs were still open when read, so the P&L is not final. |
| **no paper result** | The engine has no stored result for that strategy and day yet. |
| **unrecognised** | A tool copy whose name could not be read as a list and strategy. |

## Discretionary trades

Trades you added by hand on these platforms are summed on their own line and never compared with
anything. Trades placed straight at the broker are not seen here.

## How far to trust it

Contract notes are the ground truth for what you made. Check a week of days against them before
relying on this card, and treat any shape with only a few days as noise.

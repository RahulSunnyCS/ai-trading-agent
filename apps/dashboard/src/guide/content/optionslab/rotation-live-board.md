## What it is for

The Live board shows how today's picks are doing while the market is open. It takes the picks
recorded at 09:16, for Adaptive Classic and Adaptive Tuned, and runs them through the same backtest
that scores the day in the evening, on Angel One's 1-minute prices so far. If the evening's prices
agree with Angel One's, the evening result will match the board's last figures.

These are paper figures. They are not what your broker shows: real fills differ by slippage, and
the [Live vs paper](guide:optionslab/rotation-live) card measures that gap after the day.

## When it refreshes

- **Every 5 minutes**, from 09:18 to 15:31 on trading days, by the scheduler's `rotation-live-board` job.
- **When you press Refresh.** With the 5-minute job running, it refreshes within a few seconds.
  Otherwise the dashboard logs in to Angel One once and refreshes itself, which takes about a minute.
  Before the day's picks are recorded at 09:16 there is nothing to read, so the card only says so
  and no Angel One login is made.
- The card checks for new figures every minute, and every few seconds while a refresh runs.

The header says how fresh the prices are ("Prices to 15:15") and when the next refresh is due.
Angel One's minute prices can run a few minutes behind the clock.

## What you see

| Part | What it shows |
|---|---|
| **Index line** | NIFTY, SENSEX and India VIX at the last minute read, with the change from the open. |
| **One panel per list** | The list's total so far, then one row per pick: its state, each leg's entry and its exit or current price, and the pick's P&L. |
| **State** | **Enters 09:47** before the pick's entry time. **Open** while any leg is held, marked at the last minute's price. **Closed** once every leg has exited (a stop-loss or the exit time). A Widesl pick that re-enters after a stop shows its new leg too. |
| **Through the day** | Each list's running P&L minute by minute, before slippage. |
| **Notes** | Anything to know about this refresh, such as a strike near the edge of the prices read. |

## The switches

- **A lot each / Your lots.** A lot each is one lot per strategy, as in the 16:00 message. Your lots
  multiplies each pick by the lots your accounts trade it at, from
  [Settings › Automation](app:/settings): each account's list, its multiplier, Dir ×2 on non-expiry
  days, and the Buy add-on. The line under the list's name says which accounts those are. While
  the settings are paused, or uploads are off, nothing trades, so every list shows 0 lots.
- **Slippage** follows the Rotation page's switch: on, every entry and exit is filled 0.5% against
  the trade, which is the figure the 16:00 message gives.

## When Angel One says no

Angel One limits how often its prices can be read and sometimes refuses well within its published
limits. When it refuses during a refresh, the board keeps the last good figures, says "Last refresh
failed", and tries again at the next 5-minute slot. It logs in once a day. After four refused or
expired sessions it stops for the day, and the scheduler alerts you.

## What it never does

It reads prices only. It places, changes and squares off nothing, sends no message, and adds
nothing to the research database. Its figures live in small files under
`TRADING_DATA_ROOT/rotation/live-board/`.

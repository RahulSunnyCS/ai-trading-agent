This walkthrough builds a simple NIFTY short straddle with stops, backtests it, and saves it so
the evening run tracks it.

## 1. Start from the template

Open [Builder](app:/optionslab/builder) and choose the **Short straddle** template. It has two
legs: sell the ATM call and sell the ATM put, weekly expiry.

## 2. Set the times

Entry **09:20**, exit **15:15**. Leave **Square off** on **Partial** for now: if the call's stop
is hit, the put stays open.

## 3. Add stops

On each leg, set **Stop loss** to **25%** (of the entry premium). Leave targets off.

## 4. Set realistic costs

Under execution, set **Slippage %** to **0.5** and **Cost per order** to a figure close to your
broker's per-order charges plus taxes. Do not skip this.

## 5. Backtest

Pick a date range covering all the collected data and press **Backtest**. Read, in order:
**Net / lot**, **Worst day**, **Max drawdown**, **Profit factor**.

## 6. Try one change

Change **Square off** to **Complete** and run again. Now one stop closes both legs. The
previous run is shown alongside so you can see the difference. Keep whichever you understand
better, not just whichever made more; over a short sample the difference may be luck.

## 7. Save

Give it a clear file name and **Save**. It appears under [Strategies](app:/optionslab/strategies),
and from the next evening run its daily result shows in
[Daily results](app:/optionslab/results).

> [!TIP]
> To see how it would have done on every day already collected, ask for a re-run of all
> strategies (the owner runs it from the command line), or simply backtest the full range here.

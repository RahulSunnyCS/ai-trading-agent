This walkthrough runs the default ETF Rotation strategy, changes one thing, and compares the
two. It takes about five minutes.

## 1. Open the Backtest screen

Open [Momentum › Backtest](app:/momentum/backtest) and choose **ETF Rotation** in the dataset
switch at the top.

## 2. Run the defaults

Leave every setting alone and press **Run momentum backtest**. After a few seconds the result
appears.

## 3. Read the headline

Look at four cards first, in this order:

1. **Edge vs benchmark** — did it beat the index at all?
2. **Max drawdown** — how bad was the worst stretch?
3. **CAGR** — the yearly return.
4. **Churn** — how much it trades.

Then open the **Returns** tab and count the years it lost to the benchmark.

## 4. Make it realistic

Open **Costs, timing & tax**, switch on **Apply capital-gains tax**, and press **Run again**.
CAGR drops noticeably: almost every holding is sold within a year, so gains are taxed as
short-term. This is the number to keep in mind if you would hold the strategy in a taxable
account.

## 5. Change one setting

In **Portfolio rule**, change **Top N** from 5 to 3 and run again. Fewer names means bigger
bets: expect a different return and a different drawdown.

## 6. Compare

Both runs were saved automatically. Open the result's **Compare** tab, or
[Saved runs](app:/momentum/saved), and put them side by side.

> [!WARNING]
> If the change looks better, do not stop there. Try the neighbouring values (2 and 4), and a
> different start date. A real improvement holds up across them; a lucky one does not. See
> [Limits & caveats](guide:start/limits).

## 7. Keep the one you care about

In [Saved runs](app:/momentum/saved), rename it and mark it a **favourite** if you want its
weekly signal recorded in the [Journal](guide:momentum/journal) from now on.

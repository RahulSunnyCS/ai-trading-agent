This walkthrough runs the default ETF Rotation strategy, changes one thing, and compares the
two. It takes about five minutes.

## 1. Open the Backtest screen

Open [Momentum › Backtest](app:/momentum/backtest) and choose **ETF Rotation** in the dataset
switch at the left of the run bar.

## 2. Run the defaults

Leave every setting alone and press **Run momentum backtest**. After a few seconds the result
appears.

## 3. Read the headline

The headline card compares the run with **Nifty 200 Momentum 30**, a momentum index you could
simply buy. Look at these first, in this order:

1. **CAGR** and its badge: the edge over the index. Did it beat it at all?
2. **Max drawdown**: how bad was the worst stretch, against the index's?
3. **Sharpe**: was the extra return worth the extra risk?

Then switch the benchmark picker to **Nifty 50**, the plain market, and back. Nothing re-runs;
only the comparison changes. Scroll to **Yearly returns** and count the years it lost.

## 4. Make it realistic

Press **Settings** in the run bar, open **Costs, timing & tax**, switch on **Apply capital-gains tax**, and press **Run again**.
CAGR drops noticeably: almost every holding is sold within a year, so gains are taxed as
short-term. This is the number to keep in mind if you would hold the strategy in a taxable
account.

## 5. Change one setting

Open **Settings**, and in **Portfolio rule** change **Top N** from 5 to 3, then run again. Fewer names means bigger
bets: expect a different return and a different drawdown.

## 6. Compare

Both runs were saved automatically. Scroll to the result's **Compare runs** section, or
[Saved runs](app:/momentum/saved), and put them side by side.

> [!WARNING]
> If the change looks better, do not stop there. Try the neighbouring values (2 and 4), and a
> different start date. A real improvement holds up across them; a lucky one does not. See
> [Limits & caveats](guide:start/limits).

## 7. Keep the one you care about

In [Saved runs](app:/momentum/saved), rename it and mark it a **favourite** if you want its
weekly signal recorded in the [Journal](guide:momentum/journal) from now on.

## What it is for

The sweep (see the [Sweep verdict](guide:commodity/sweep-verdict)) found exactly one commodity setting that survived an untouched test year: **gold Dir in the expiry week**. It was a gold bull run, so it proves little. This page tracks a forward paper test that gives it a fair, unseen trial. **Nothing is ever ordered.**

## The rule (frozen)

- **Sell** the in-the-money call and put of the nearest gold option expiry at **18:00**, one lot each.
- **21% stop** on each leg, and **re-enter once** at cost after a stop.
- Hold to 15 minutes before the close: 23:15 on a 23:30-close day, 23:40 on a 23:55-close day.
- Only in the **expiry week**: the last five sessions up to and including expiry day.
- **1% slippage on every fill** and the MCX charges, as in the sweep.

The rule, the window and the start expiry (27 Nov 2026) were fixed before the first session, and nothing from the forward period feeds back into them.

## Reading the page

- **Headline cards**: the net so far at 1% slippage (the registered basis), at 0.5% and with none, the profit factor and the expiries that finished up.
- **The pass rule**: after the **sixth expiry** (about April 2027), the test passes if the net is above zero after charges and 1% slippage **and** at least four of the six expiries are up. Before then it says it is not decided: a few sessions prove nothing.
- **Window**: the five sessions of the next expiry. *Journaled* is scored; *today* is the session in progress; *waiting for data* means the session has passed but the collector has not delivered its bars (alerted, never skipped); *to come* is still ahead.
- **Running net**: one lot, cumulative, drawn at three slippage levels. It needs two sessions to draw a line.
- **Journal**: each session newest first, with gross, charges, net and what each leg did (entry price → exit price, and why it exited: SL for a stop, EXIT_TIME for the close). An entry is written at 01:30 the next morning, hash-chained, and never edited. If the chain stops verifying the page says so.
- **Real bid-ask spread**: at 18:00 on each window weekday the entry contracts' bid and ask are read, read-only. The median half-spread is the cost of crossing the market once; compare it with the 1% a fill the backtest charged. If it is far above 1%, the backtest was too kind.

> [!WARNING]
> About thirty sessions is a small sample. A pass here is still not proof, and it is not a recommendation to trade real money.

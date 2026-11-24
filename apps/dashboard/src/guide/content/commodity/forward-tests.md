## What it is for

Two paper tests run in the Commodity Lab, each a frozen setting scored every night on days nobody had seen. **Nothing is ever ordered.** Pick one with the switch at the top of the page (the address keeps the choice, `?rule=`).

| Test | Why it is here |
|---|---|
| **Gold Dir, expiry week** | The one setting that survived the sweep's untouched test year (see the [Sweep verdict](guide:commodity/sweep-verdict)). It was a gold bull run, so it proves little: this gives it a fair, unseen trial. |
| **Silver Dir, week before expiry** | Added at the owner's request although it **did not clear the sweep**: it made money in the test year but one expiry gave most of it and its lower bound was below zero. It is a test of a setting the data did not endorse. |

## The rules (frozen)

Both sell the call and put of the nearest option expiry, one lot each, with a stop on each leg, held to 15 minutes before the close (23:15 on a 23:30-close day, 23:40 on a 23:55-close day), with **1% slippage on every fill** and the MCX charges, as in the sweep.

- **Gold:** in-the-money strike, entry **18:00**, 21% stop, re-enter once at cost. Window: the **expiry week**, the last five sessions up to and including expiry day, from the 27 Nov 2026 expiry.
- **Silver:** at-the-money strike, entry **17:05**, 21% stop, **no re-entry**. Window: the **week before the expiry week**, the five sessions before the last five, from the 28 Dec 2026 expiry. Sessions are counted without market holidays, so the window is only fixed once the expiry day has traded; its five sessions are then scored together (the first window is 14–18 Dec if MCX is shut on 25 Dec).

The rule, the window and the start expiry were fixed before the first session, and nothing from the forward period feeds back into them.

## Reading the page

- **Headline cards**: the net so far at 1% slippage (the registered basis), at 0.5% and with none, the profit factor and the expiries that finished up.
- **The pass rule** (the same for both): after the **sixth expiry** the test passes if the net is above zero after charges and 1% slippage **and** at least four of the six expiries are up. Before then it says it is not decided: a few sessions prove nothing. Gold's sixth is April 2027, silver's May 2027.
- **Window**: the five sessions of the next expiry's window. *Journaled* is scored; *today* is the session in progress; *waiting for data* means the session has passed but the collector has not delivered its bars (alerted, never skipped); *to come* is still ahead.
- **Running net**: one lot, cumulative, drawn at three slippage levels. It needs two sessions to draw a line.
- **Journal**: each session newest first, with gross, charges, net and what each leg did (entry price → exit price, and why it exited: SL for a stop, EXIT_TIME for the close). An entry is written at 01:30 the next morning, hash-chained, and never edited. If the chain stops verifying the page says so.
- **Real bid-ask spread**: at the entry minute (18:00 gold, 17:05 silver) on each window weekday the entry contracts' bid and ask are read, read-only. The median half-spread is the cost of crossing the market once; compare it with the 1% a fill the backtest charged. If it is far above 1%, the backtest was too kind.

> [!WARNING]
> About thirty sessions is a small sample. A pass here is still not proof, and it is not a recommendation to trade real money. Silver in particular is a setting the sweep rejected: a pass would be a surprise worth a second look, not a green light.

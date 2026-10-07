## The question it answers

*If I had run this intraday options strategy every day, what would it have made, and what
kind of days hurt it?* Options Lab answers it by replaying the strategy minute by minute over
real 1-minute option prices, the way [AlgoTest](glossary:algotest) runs a strategy live.

## A strategy is a set of legs

A [leg](glossary:leg) is one option position: for example *sell 1 lot of the NIFTY ATM call,
weekly expiry*. A short [straddle](glossary:straddle) is two legs (sell the ATM call, sell the
ATM put); an iron condor is four. On top of the legs a strategy has:

- an **entry time** and an **exit time** (for example 09:20 and 15:15);
- optional **overall** stop loss and target in rupees for the whole position;
- **execution costs**: [slippage](glossary:slippage) as a % of price, and a flat cost per order.

Each leg has its own rules:

| Rule | Meaning |
|---|---|
| Strike | [ATM, OTM1…OTM10, ITM1…ITM3](glossary:atm), or [closest premium](glossary:closest-premium) to a rupee amount. |
| Expiry | Nearest [weekly or the monthly](glossary:expiry) contract. |
| [Stop loss and target](glossary:stop-loss) | In points or % of the entry premium. |
| [Trailing stop](glossary:trailing-sl) | Every X of favourable move, tighten the stop by Y. |
| [Re-entry](glossary:re-entry) | After a stop or target: RE COST or RE ASAP, a set number of times. |
| [Range breakout](glossary:range-breakout) | Wait for the price to break the range set since entry before entering. |

And one strategy-wide rule: [square off](glossary:square-off) **Partial** (only the leg that
hit its stop closes) or **Complete** (any leg hitting closes them all).

## How a day is simulated

The session is 375 one-minute bars, 09:15 to 15:29. For each day:

1. **Entry.** At the entry time, each leg's strike is chosen from that minute's open (the
   index's open for ATM/OTM, each option's open for closest premium), and the leg fills at the
   option's open.
2. **Every minute after.** Each open leg's stop and target are checked against the minute's
   high and low. A hit fills at the stop price, or at the minute's open if the price gapped
   through it. If one minute touches both stop and target, the **stop wins**, because the
   order inside a minute is unknown and that is the cautious choice.
3. **Trailing and re-entry** update after the minute's checks.
4. **Overall stop/target** is checked on the whole position's
   [MTM](glossary:mtm) at each minute's close.
5. **Exit.** Anything still open closes at the exit time's open.

Slippage is applied against you on every fill; the cost per order is charged on every entry
and every exit.

## Results are in ₹ per lot

A strategy's "lot" is its smallest leg. Results are shown in rupees **per lot**, so a strategy
trading 2 lots and one trading 1 lot can be compared fairly. Multiply by your own lot count.

## Where the data comes from

Every trading day at 16:15 the [evening run](glossary:evening-run) downloads that day's
[1-minute data](glossary:one-minute-data) for the index and its options from Fyers, then runs
every saved strategy over it. Option contracts disappear after expiry, so a day that was not
collected cannot be backtested later. The number of days a strategy has been tested on is
always shown; a few weeks of days is a small sample.

## Saved strategies and versions

A saved strategy is a file. Each version of the file has a fingerprint. When you edit a
strategy, results from the older version are kept but marked
[stale](glossary:stale-version): greyed out and left out of totals. Re-running the strategy
over every collected day fills in results for the new version.

## Two engines

The **Form** builder uses the leg-wise engine described here. The **YAML** mode is an older
rule engine that reads a cache of AlgoTest data; it is kept for experiments that need its
richer condition language. See [Builder: YAML mode](guide:optionslab/builder-yaml).

Next: [the Strategies screen](guide:optionslab/strategies).

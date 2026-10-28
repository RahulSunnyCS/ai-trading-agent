## What it is for

A backtest can always be re-run with hindsight. The [forward journal](glossary:forward-journal)
cannot: it records each Friday's signal when it is produced and never changes it. Over months
it becomes the honest record of what each favourite strategy actually said in real time.

## Before you start

Nothing. The journal fills itself from the Friday runs: the 14:40 preview (ETF favourites),
the 16:45 final, and the 19:30 run for stock-based favourites.

## The screen

| Part | What it shows |
|---|---|
| Signal week, Recorded this week | Which week is shown, and how many entries it has. |
| Weekly check ("what should be here") | One row per expected signal. When every one is recorded it stays folded to its counter (**43 / 43 recorded**); click it to see the rows. When any is missing or labelled another week it opens by itself, so the gap stands out. A check at 21:00 every Friday reports gaps on Telegram. |
| Tamper check, Chain fingerprint | Each entry includes a fingerprint of the one before it, like a chain. If any old entry were edited, removed or reordered, the check would fail. |
| Entries | Oldest first. Click one for its full actions and holdings. "Held before" is the model portfolio before that signal's own trades; next week's entry shows the result. A **SKIP (premium)** chip is a top-ranked name an ETF favourite did not buy because its ETF traded too far above NAV; the entry keeps the premium, the limit and the reason, so the record shows what the strategy wanted and why it did not get it (see [This week](guide:momentum/this-week)). |

On your **paper start Friday** (set with `mbt paper-start`, see [This week](guide:momentum/this-week)) the page shows **First week**: "Held before" is *Nothing* and every name a strategy holds after is a Buy, and sleeves are numbered from that Friday. This is only how the page reads the entries; the recorded entries and their hash chain are unchanged.

## Forward score

Below the weekly check, **Forward score** says what each recorded signal earned the week after
it. The Friday 20:30 job (`mbt journal score`) scores the week that has just finished, once the
19:30 run has recorded the next week's entries.

| Column | What it shows |
|---|---|
| Live, Fri close | The signal's portfolio (the model's holdings after that week's trades) bought at that Friday's close and valued at the next Friday's close, after the backtest's own costs (its itemised charges and 15 bps slippage a side). The *ideal* fill: the final signal is recorded after the close. |
| Live, Mon open | The same at the Monday opens after each Friday: the price you can actually get. It lands a week later than the Friday figure, once that Monday has happened. |
| Backtest as recorded | How much the backtest that produced the two entries moved over the same week. Shown only when both entries come from the same ranking. |
| Backtest, today's code | The same settings re-run now. Entries recorded before 28 Oct 2026 come from the ranking before the BL-001 F6 fix (Broad now ranks only the stocks that were in the universe that week), so this can differ from "as recorded". |
| Gap | Live at Friday close minus the backtest as recorded, in points. |
| Mom30 TRI | The Nifty200 Momentum 30 TRI over the same week, from the journal's benchmark level. |

The top table shows each followed group, its sleeves weighted by their value since the April reset,
as the group itself is. **Every favourite** lists each sleeve and week: *Waiting* (next week's
entry not in yet), *Mismatch* (a recorded buy is not in next week's portfolio, or a sell is still
there: shown, never scored), *Recorded late* (every entry came after the fill). A rerun recorded
after the fill is a correction and is never scored in place of the entry that could have been
traded.

## Real fills (Kite)

**Real fills** reconciles each lot's rebalance (see [This week](guide:momentum/this-week)) against
its journal entry. Your fills come from the Kite contract notes, read each night; which lot each
share belongs to comes from the lot ledger, or, until the next Friday run books them, from the
14:15 orders.

| Column | What it shows |
|---|---|
| Signal | The journal's action and target weight. A new lot is bought from cash, so every name it holds is a Buy. |
| Model shares, Orders | Whole shares at the target weight of the lot's budget at Friday's close; what the 14:15 orders said. |
| Done, Diff | Shares bought (or sold) for the lot, and the difference from the orders (or from the model when there were none). Shares added later in the week are counted here and shown in the tooltip. |
| vs Fri close, vs Mon open, vs orders | The first day's average fill against the model's fill prices and the orders' price, in basis points; positive means you paid more on a buy, or got less on a sell. |
| Charges | Your note's charges, shared by trade value; the tooltip has the model's charges on the same trades. |
| Status | *done*, *shares differ*, *missed* (asked for, nothing done), *extra* (done, not asked for: a name bought in place of a skipped one, with the ledger's note). |

Fills no lot books (a stock outside the strategy) are listed under the table.

## Common questions

**What if a signal was wrong and re-run?** A rerun with the same signal adds nothing. A changed
one is added as a **correction**, next to the original, never replacing it.

**Why does it note the code version?** So a later reader knows exactly which version of the
strategy produced each signal.

## What it does not tell you

Whether a strategy has an edge yet. A few scored weeks are a check that the live signals behave
like their backtest, not evidence for or against it. Tax is left out (the favourites are pre-tax),
and only Broad favourites are scored today, as they are the only ones journalled.

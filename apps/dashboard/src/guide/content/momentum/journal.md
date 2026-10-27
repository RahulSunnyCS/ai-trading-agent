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

## Common questions

**What if a signal was wrong and re-run?** A rerun with the same signal adds nothing. A changed
one is added as a **correction**, next to the original, never replacing it.

**Why does it note the code version?** So a later reader knows exactly which version of the
strategy produced each signal.

## What it does not tell you

Real fills. The journal records the model's decisions at its assumed prices, not what you paid.

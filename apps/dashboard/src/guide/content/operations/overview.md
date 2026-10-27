## What it is for

The landing screen: the morning board. Six cards answer what you would otherwise open six
screens for, and the link at the top right of each card opens the screen with the detail. Every
figure comes from the same place that screen reads; the Overview works nothing out on its own.

## The cards

| Card | What it tells you | Opens |
|---|---|---|
| Rotation today | Today's 09:16 entry (due, recorded on time, late or missing). The last scored session's result for **Adaptive Classic** on paper (gross, one lot a strategy, as the read-out counts it), and under it the live result the [live capture](guide:operations/jobs) read for that session, next to the paper result of the same trades with the same costs. **Day N of 60** of the forward read-out, and the total since the first day. | [Today](app:/optionslab/rotation) |
| Momentum this week | The headline favourite, which of its sleeves trades next and on which Friday, the state of your live-money rules (all clear, needs you or breached, with the drawdown against the cut line), whether Kite is logged in today (amber only on a Friday before the 14:15 orders, the one time it is needed), and any Momentum alert waiting for you. | [This week](app:/momentum/week) |
| Trade book | The day the contract notes are in through, the latest day's net, this month so far, and this financial year so far with its percent of capital. F&O accounts, after charges and algo fees. | [Trade book › F&O](app:/tradebook/fno) |
| Jobs | Every job whose latest run **failed in the last 24 hours**, newest first, with one line on why (the run's error, or the error line of its log); then any job still failing from earlier (its latest run failed before that and it has not run since); then a count of the rest: succeeded, running, not run in the last 24 hours. | [Jobs](app:/jobs) |
| Logins | Fyers (the market-data token and when it expires), Angel One (its last login check), Kite (logged in today or not) and the 08:02 morning broker login's latest run. | [Broker logins](app:/brokerLogins) |
| Data | The Today page's health checks: the latest stored session and its results, the VIX open and where it came from, the journal chain, the fixed base. | [Today](app:/optionslab/rotation) |

A dot before a line is green when it is fine, amber when it needs a look, red when something
failed, and grey when there is nothing to judge. Hover a line for the longer explanation, where
there is one.

## How to read it

- **A dash is never a zero.** A figure that does not exist yet shows a dash and why: "live not
  captured", "no note this month yet", "no live trades".
- **Compare live with the paper figure on its own line.** The live figure is Adaptive Classic's
  book on every account the live capture read for that session, per lot after costs; the figure
  after "vs" is the same trades on paper on that same basis. The read-out's gross figure above
  it is the forward test's own count and is not meant to match live. When an account could not
  be read, the line says so.
- **Each card loads on its own.** A service that is down blanks only its card, with one sentence
  saying so. When a refresh fails but older figures are on screen, the card says it is showing
  the last figures loaded.

## Common questions

**A job is red. What now?** Open [Jobs](app:/jobs) and click the job: the panel under the table
has what it does in full and the end of its latest log.

**The Jobs card says it cannot reach the scheduler.** The Jobs page and this card read the
scheduler on the laptop, which the dashboard reaches only when it runs with the research stack
(`bun run start`).

**Where did the market clock, the Feed, Paper trading and Credits go?** They were removed: the
top bar already says whether the market is open, and the other three belonged to the paused
paper-trading engine (now under the sidebar's Archived engine, hidden by default).

**Can I land somewhere else?** Yes: Settings › Defaults › Landing tab.

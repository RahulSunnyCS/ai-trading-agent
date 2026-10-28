## What it is for

Every recurring job the owner's laptop runs, in one table: when it runs, when it ran last and
how that went, and its log. You can also run a job now.

## Before you start

The jobs run on the owner's laptop through a scheduler service. If the screen says
**Scheduler not reachable**, the laptop (or its scheduler) is off; nothing is lost, jobs catch up
when it is back.

## The table

| Column | Meaning |
|---|---|
| Job | Its id, such as `options-daily`, and the first sentence of what it does (hover for the rest). |
| Schedule | When it runs, in IST: "trading days 15:45", "Fri 14:40", "1st Sunday of the month 10:00". |
| Next run, Last run | When it will run next; when it last ran and whether it succeeded. |
| Group | Jobs in the same group never run at the same time (for example, two jobs that write the same data). |
| Needs | What it depends on, such as the laptop or a broker login. |
| Action | **Run now**. Some jobs ask you to confirm first. |

Click a job to read, under the table, what it does in full and the last 200 lines of its latest
log. The [Overview](guide:operations/overview)'s Jobs card lists the jobs that failed in the last
24 hours.

## The main jobs

| Job | What it does |
|---|---|
| `broker-login` (08:02) | Logs in, on this Mac, what [Settings](app:/settings) asks for: the AlgoTest brokers (from 08:16, AlgoTest's window) and Quantiply through Angel One and Shoonya (at once), with the passwords in the repo `.env`. One Telegram report says which logged in. A part that fails for a reason another machine could fix (the browser would not start, the network) is tried again on GitHub's "Daily broker login", that part only, and a second message links the run; a refused password or PIN is never sent again. Once the Mac has run, GitHub's own 08:15 backup does nothing that day. |
| `angel-login-check` (08:00) | One Angel One login, nothing fetched, to check the evening run's fallback source works. The result shows on [Broker logins](app:/brokerLogins). A network failure is tried once more 5 minutes later; a login Angel One refused is not sent again for 15 minutes with the same settings (wrong attempts count toward a lockout). |
| `fyers-login-reminder` (trading days 08:05) | When Fyers does not accept today's token, a Telegram reminder with a link to [Broker logins](app:/brokerLogins) on the hosted dashboard, so you can log in from your phone. Silent otherwise. |
| `fyers-login-recheck` (trading days 15:30) | The same, again, before the evening collection, if you still have not logged in. |
| `kite-login-reminder` (Fri 13:30) | When Kite is the Momentum holdings source and you have not logged in to Kite that day, a Telegram reminder to log in on [Broker logins](app:/brokerLogins) before the 14:15 orders, with the link for a phone login. Silent otherwise. |
| `kite-login-reminder-monday` (trading Mondays 08:45) | The same before the Monday open. |
| `morning-summary` (09:00) | One Telegram message, **only when something needs a look** (a failed check, or a pause in Settings): on a clean day the 08:10 message is your confirmation. It says: did the logins work, is the data current. Its Fyers line asks Fyers whether today's token works, and says to log in on [Broker logins](app:/brokerLogins) if not. It also lists the previous trading day's jobs that ran late because the laptop was asleep at their time ("Ran late after sleep"). |
| `trade-monitor` (09:04 to 15:30) | Watches the day's real trades and **only reads**: it never clicks, changes or squares off anything. Three parts, each off until its switch in the laptop's `.env` is `on`: from 09:05 to 09:10 the free margin of each broker account against what the day's picks need, roughly (`MARGIN_CHECK`); at 09:25 one line per platform, such as "AlgoTest T1 3/3 · Quantiply Core 3/3 ✅", saying whether each holds exactly the day's picks at 1 lot on the right broker, with what is missing or extra (`DEPLOY_CHECK`); and from 09:25 to 15:30 the combined profit or loss of the day on both platforms, read every minute, with a warning at -₹5,000 and an alert at -₹8,000, each sent once a day (`LOSS_ALERTS`). Between 09:10 and 09:25 it is logged out of both platforms, so it never gets in the way of the deploys. If it cannot read a platform it says so once ("cannot read"), and that platform is left out of the total. If the laptop or the scheduler restarts during the session, it starts again. |
| `options-evening` (15:45) | The [evening run](glossary:evening-run), in five steps: collects the day from Fyers when you are logged in (otherwise from Angel One, and says which in its Telegram message), stores the rotation results, builds any missing 5-minute snapshots and IV tables, stores the T1 parallel track's results, then sends the rotation result, but only from 16:00, so on a normal day the 16:00 job sends it. If the run only succeeds on a later retry (17:15 and so on), this last step sends the result as soon as the data is in. A problem in either of the last two steps sends its own alert and never fails the run. |
| `options-rotation-result` (16:00) | One Telegram message: the day's net paper gain for Adaptive and the T1 track (one lot per strategy, after costs) and tomorrow's strategies in full. If the evening run has not finished it tries again every 5 minutes; at 16:25 it sends what exists (T1 follows on its own if it was missing). If Adaptive's result never completes, the job fails and you are alerted. |
| `options-rotation-pick` (09:16) | Records the day's rotation picks before the first entry, then the T1 track's Adaptive pick in its own journal, and sends one Telegram message: Adaptive, then the T1 track as "Tuned Adaptive (In Testing phase)". The friends' group gets the same message as you. It waits for T1 until 09:16:50 at most; if T1 is later, Adaptive comes alone with "… · follows in a separate message", and T1 follows as its own message, to the group too. "… · not recorded today" means T1 failed: you get an alert and the job tries again. |
| `options-rotation-t1-update` (21:00) | Catch-up: first sends whatever part of the day's result has not gone out yet, then stores any T1 day the evening run missed, then sends the T1 part if it was not ready at 16:00. If storing T1 fails, the job fails and tries again at 22:00 and 23:00; the result already sent is never held back. The live rotation results are never touched. |
| `live-capture` (15:40) | Reads, on AlgoTest and Quantiply, every strategy that ran today on the platforms and brokers [Settings](app:/settings) has on: the tool's own and the ones you added by hand ([discretionary](glossary:discretionary-trade)), with the live ₹, the multiplier and the fills where the platform shows them. It only reads, never changes anything. The 16:00 result message then shows each list's live result beside paper, with the [slippage](glossary:slippage) (your message only, never the friends' group). Both platforms keep a day's results after its strategies are deleted, so a day it missed is read the next evening (up to 5 trading days back). Platforms or brokers switched off in Settings are not read, so a trade you add there is not seen. |
| `live-capture-retry` (15:55) | Reads again only what the 15:40 read missed, until about 16:30. If the day is still not read, you get one alert, and the next evening reads it. |
| `quantiply-disable` (15:40) | Switches off, on Quantiply, the algos the tool made for today that are still on; its message comes only when something went wrong (Telegram alerts: failures only). A Quantiply algo that stays on runs again on the same weekday next week. Only the tool's own algos, and only once they have finished. This is the safety net, so it always runs, even with `QUANTIPLY_DEPLOY` or **Automated deployment** off. |
| `quantiply-deploy` (08:10) | After the morning login, on each Quantiply account: first keeps the clientwise MTM SL at the figure in [Settings](app:/settings) (sets it only when it differs, and reads it back), then switches on today's algos the evening upload made: this trades real money. It sets each algo to your broker account and reads the list again to check that only those algos changed. One Telegram message for both accounts says each account's MTM SL and what was switched on, every morning, also when nothing was (and why). Needs `QUANTIPLY_DEPLOY=on`, **Automated deployment** and the account's block uploading a list. |
| `quantiply-deploy-topup` (09:21) | After the 09:19 top-up: when the 09:16 pick changed the list, switches on the new strategy and switches off the one it replaced (if it has not started). The 09:16 pick changes only what starts after 09:17: last evening's 09:17 strategy keeps running, a new 09:17 pick is not made, and the rest is chosen again by the 09:16 score (2 Widesl and 1 directional, the highest scorers). Quiet on a day nothing changed. An algo that starts within 90 seconds is left off and reported as too late. |
| `momentum-preview` (Fri 14:40) | The momentum preview on live prices. |
| `momentum-final` (Fri 16:45) | The momentum final signal. |
| `momentum-stock-ingest` (Fri 19:30) | Refreshes NSE stock data, then the stock-based finals. |
| `momentum-journal-check` (Fri 21:00) | Checks the journal recorded every favourite. |
| `momentum-live-rules` (Fri 21:30) | Checks your live-money rules (drawdown, trailing, the money gate) and messages you. A rule that is hit always sends; it never trades. |
| `momentum-history` (Fri 22:00) | Checks that the stored market history up to a fixed Friday (the anchor: two to six weeks back; it moves forward after clean checks, and stays put while a change is unaccepted) has not changed since it was recorded: a restated close, replaced stock bars, a corporate action added with a past date. New weeks never trip it. It messages you only when something changed, naming each series and the earliest year that moved; backtest results that read those series may have moved too. The change keeps being reported each Friday until it is accepted (`mbt verify history --accept --reason "..."`). Silent when nothing changed. If a change could not be messaged (Telegram off or unreachable), the job shows as failed here. |
| `backup` (1st Sunday) | Copies the research database to the external disk. |
| `weekly-digest` | A weekly summary message. |
| `check-…`, reminders | Quiet checks (lot sizes, index membership, stock data, calendar, credentials) that message only when something needs attention. |

## Missed vs failed

- **Catch-up:** if the laptop was asleep at a job's time, the job runs when it wakes.
- **Missed:** the job could not run in its window at all. Telegram says so.
- **Failed:** it ran and returned an error. The log says why. Failures and missed runs always
  alert, whatever your Telegram settings.

## What it does not tell you

Whether a successful job produced *sensible* data. That is what the quiet checks and the
morning summary are for.

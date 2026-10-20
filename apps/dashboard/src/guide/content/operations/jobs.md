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
| Job | Its id, such as `options-daily`. |
| Schedule | When it runs, in IST: "trading days 15:45", "Fri 14:40", "1st Sunday of the month 10:00". |
| Next run, Last run | When it will run next; when it last ran and whether it succeeded. |
| Group | Jobs in the same group never run at the same time (for example, two jobs that write the same data). |
| Needs | What it depends on, such as the laptop or a broker login. |
| Action | **Run now**. Some jobs ask you to confirm first. |

Click a job to read the last 200 lines of its latest log.

## The main jobs

| Job | What it does |
|---|---|
| `broker-login` (08:00) | Logs the broker accounts into [AlgoTest](glossary:algotest). |
| `angel-login-check` (08:00) | One Angel One login, nothing fetched, to check the evening run's fallback source works. The result shows on [Broker logins](app:/brokerLogins). A network failure is tried once more 5 minutes later; a login Angel One refused is not sent again for 15 minutes with the same settings (wrong attempts count toward a lockout). |
| `kite-login-reminder` (Fri 13:30) | When Kite is the Momentum holdings source and you have not logged in to Kite that day, a Telegram reminder to log in on [Broker logins](app:/brokerLogins) before the 14:15 orders. Silent otherwise. |
| `morning-summary` (09:00) | One Telegram message: did the logins work, is the data current. |
| `options-evening` (15:45) | The [evening run](glossary:evening-run), in five steps: collects the day from Fyers when you are logged in (otherwise from Angel One, and says which in its Telegram message), stores the rotation results, builds any missing 5-minute snapshots and IV tables, stores the T1 parallel track's results, then sends the rotation result, but only from 16:00, so on a normal day the 16:00 job sends it. If the run only succeeds on a later retry (17:15 and so on), this last step sends the result as soon as the data is in. A problem in either of the last two steps sends its own alert and never fails the run. |
| `options-rotation-result` (16:00) | One Telegram message: the day's net paper gain for Adaptive and the T1 track (one lot per strategy, after costs) and tomorrow's strategies in full. If the evening run has not finished it tries again every 5 minutes; at 16:25 it sends what exists (T1 follows on its own if it was missing). If Adaptive's result never completes, the job fails and you are alerted. |
| `options-rotation-pick` (09:16) | Records the day's rotation picks before the first entry, then the T1 track's Adaptive pick in its own journal, and sends one Telegram message: Adaptive, then T1 marked as a testing phase and not traded. The friends' group gets Adaptive alone, as soon as it is recorded. Your message waits for T1 until 09:16:50 at most; if T1 is later, Adaptive comes alone with "T1 · follows in a separate message", and T1 follows as its own message. "T1 · not recorded today" means T1 failed: you get an alert and the job tries again. |
| `options-rotation-t1-update` (21:00) | Catch-up: first sends whatever part of the day's result has not gone out yet, then stores any T1 day the evening run missed, then sends the T1 part if it was not ready at 16:00. If storing T1 fails, the job fails and tries again at 22:00 and 23:00; the result already sent is never held back. The live rotation results are never touched. |
| `quantiply-disable` (15:40) | Switches off, on Quantiply, the algos the tool made for today that are still on. A Quantiply algo that stays on runs again on the same weekday next week. Only the tool's own algos, and only once they have finished. Off until `QUANTIPLY_DEPLOY=on`. |
| `quantiply-deploy` (16:55) | Switches on, on Quantiply, tomorrow's picks the 16:45 upload made: this trades real money. It waits for the upload to finish, sets each algo to your broker account, and reads the list again to check that only those algos changed. Needs `QUANTIPLY_DEPLOY=on`, **Automated deployment** and the account's block uploading a list ([Settings](app:/settings)). |
| `quantiply-deploy-topup` (09:21) | The same for today after the 09:19 top-up: switches on a pick that changed at 09:16 and switches off the one it replaced. An algo that starts within 90 seconds is left off and reported as too late. |
| `momentum-preview` (Fri 14:40) | The momentum preview on live prices. |
| `momentum-final` (Fri 16:45) | The momentum final signal. |
| `momentum-stock-ingest` (Fri 19:30) | Refreshes NSE stock data, then the stock-based finals. |
| `momentum-journal-check` (Fri 21:00) | Checks the journal recorded every favourite. |
| `momentum-live-rules` (Fri 21:30) | Checks your live-money rules (drawdown, trailing, the money gate) and messages you. A rule that is hit always sends; it never trades. |
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

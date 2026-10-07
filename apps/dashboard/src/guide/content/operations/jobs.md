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
| Schedule | When it runs, in IST: "trading days 16:15", "Fri 14:40", "1st Sunday of the month 10:00". |
| Next run, Last run | When it will run next; when it last ran and whether it succeeded. |
| Group | Jobs in the same group never run at the same time (for example, two jobs that write the same data). |
| Needs | What it depends on, such as the laptop or a broker login. |
| Action | **Run now**. Some jobs ask you to confirm first. |

Click a job to read the last 200 lines of its latest log.

## The main jobs

| Job | What it does |
|---|---|
| `broker-login` (08:00) | Logs the broker accounts into [AlgoTest](glossary:algotest). |
| `fyers-login` (08:05) | Gets the day's [Fyers token](glossary:fyers-token). |
| `morning-summary` (09:00) | One Telegram message: did the logins work, is the data current. |
| `options-daily` (16:15) | The [evening run](glossary:evening-run). |
| `options-derived` (23:30) | Builds any missing 5-minute snapshots and IV tables the evening run left out. |
| `momentum-preview` (Fri 14:40) | The momentum preview on live prices. |
| `momentum-final` (Fri 16:45) | The momentum final signal. |
| `momentum-stock-ingest` (Fri 19:30) | Refreshes NSE stock data, then the stock-based finals. |
| `momentum-journal-check` (Fri 21:00) | Checks the journal recorded every favourite. |
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

Most of the work happens on its own, on the owner's laptop, at fixed times (all IST). This page
says what runs when, and when it is worth looking.

## Every trading day

| Time | What happens | Where to check |
|---|---|---|
| 06:00 | Yesterday's [Fyers token](glossary:fyers-token) expires. | — |
| 08:00 | The broker accounts are logged into [AlgoTest](glossary:algotest) automatically. | [Jobs](app:/jobs) |
| 08:05 | A fresh Fyers token is fetched automatically. | [Broker logins](app:/brokerLogins) |
| 09:00 | One Telegram message: did the logins work, is the data current. | Telegram |
| 16:15 | The [evening run](glossary:evening-run): today's 1-minute option data is collected and every saved options strategy is run over it. A summary goes to Telegram. | [Daily results](app:/optionslab/results) |

## Every Friday

| Time | What happens | Where to check |
|---|---|---|
| 14:40 | Momentum **preview**: the ETF ranking on live prices, so a trade can be placed before the close. | [Weekly signal](app:/momentum/weekly) |
| 16:45 | Momentum **final**: the same ranking on the official close. The Telegram-active strategy's signal is sent. | [Weekly signal](app:/momentum/weekly) |
| 19:30 | Stock data is refreshed from NSE, then the stock-based strategies (Broad Momentum) get their final. | [Weekly signal](app:/momentum/weekly) |
| 21:00 | A check that the [journal](guide:momentum/journal) recorded a signal for every favourite. | [Journal](app:/momentum/journal) |

## Every month and week

- **First Sunday, 10:00** — the research database is backed up to an external disk.
- **Saturday** — a weekly digest message on Telegram.
- Several small checks (lot sizes, calendar, stock data) run quietly and only message when
  something is wrong.

> [!NOTE]
> If the laptop was asleep at a job's time, the job runs when it wakes up ("catch-up"). A job
> that could not run at all is reported on Telegram as **missed**; one that ran and failed is
> reported as **failed**. See [Jobs](guide:operations/jobs).

## When to look

- **Weekday evening:** glance at [Daily results](app:/optionslab/results) to see how the
  options strategies did today.
- **Friday afternoon:** read the momentum signal (Telegram or
  [Weekly signal](app:/momentum/weekly)). The walkthrough
  [Read this week's signal](guide:momentum/walkthrough-weekly-signal) covers it.
- **When Telegram says something failed:** open [Jobs](app:/jobs) and read that job's log.

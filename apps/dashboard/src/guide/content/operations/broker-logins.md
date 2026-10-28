## What it is for

The dashboard reads market data from **Fyers**. Fyers requires a fresh login every day; this
screen shows whether today's login is valid and lets you log in by hand. Below it, the
**Angel One** card shows whether the fallback data source can log in, and the **Kite** card
connects the Zerodha account that holds the Momentum money.

## Why it expires every day

A Fyers token dies at **06:00 IST** the next morning, whenever you logged in. Fyers put a
human-verification check on its login page, and its "refresh token" way of renewing a login is
switched off under SEBI's rule of one two-step login a day, so no scheduled job can log in for you:
use **Log in again** once a trading day, any time before the evening data collection.

## Logging in from your phone

You do not need the laptop. At **08:05** on trading days a job (`fyers-login-reminder`, see
[Jobs](app:/jobs)) checks whether Fyers accepts today's token; if not, it sends a Telegram message
with a link to this screen on the hosted dashboard. Open it on your phone, tap **Log in again**,
tick Fyers' human check yourself, enter your TOTP and PIN, and you are done: Fyers sends the
browser back to the hosted dashboard, which passes the login to the laptop. At **15:30** a second
job (`fyers-login-recheck`) asks again if you still have not logged in, before the evening
collection. Each says nothing when the login is fine.

A phone login needs the laptop awake with two things running: the Momentum service and the
Cloudflare tunnel. Both are kept running all the time (see the launchd notes in the repository).
When either is down, the reminder says so; log in on the laptop instead.

## When you did not log in

If no Fyers login is valid when the evening run starts, it collects that day's options data from
**Angel One** instead, so the day is not lost. Angel One's data has known gaps: the NIFTY index has no
bars from 15:15 to 15:28, SENSEX options have no open interest, and minutes with no trade are carried
forward. A banner under the top bar names the days that came from Angel One and what each lacks.
Logging in here is the repair: the next evening run re-collects those days from Fyers for every
contract that is still listed.

## The states

| State | Meaning |
|---|---|
| Not configured | No Fyers app is set up on the server. |
| Connected | A valid token, with a countdown to 06:00. |
| Expiring soon | Two hours or less left before the 06:00 expiry. |
| Expired / No API token | Log in again. Data collection and live prices will fail until you do. |

**Log in again** opens Fyers' own login page in a new tab. The token is stored encrypted on the
server; the browser never sees it.

## Angel One connection

Angel One has no login page to visit: the server logs in by itself with the Angel One settings in
its `.env` (API key, client code, PIN and TOTP seed). The card shows whether that works.

| What you see | Meaning |
|---|---|
| Not configured | One or more of the four required settings is missing; the card names which. `ANGELONE_PUBLIC_IP` is optional. Values are never shown, only whether each is set. |
| Not tested yet | Configured, but no check has been recorded. |
| Login works | The last check logged in. The client code is shown masked (`R1•••56`). |
| Last check failed | The last check did not log in. The line under it says why: **Login refused** (Angel One rejected the client code, PIN or TOTP), **Could not reach Angel One** (network), **Angel One unavailable** (their server error), or **Login error**. |

**Last check** is the newest Angel One login: the automatic check (the `angel-login-check` job,
08:00 on trading days, see [Jobs](app:/jobs)), your own **Test connection**, or the evening
collection's login, with the time and how long it took. **Last collection from Angel One** is the
last day the evening run actually collected from it.

**Test connection** makes one login now. Nothing is fetched or traded, and the session is thrown
away at once. The result appears on the card a few seconds later. Angel One limits logins and
locks an account after repeated wrong attempts, so every Angel One login here (your test, the
08:00 check and the evening collection) shares a few rules, and the button says which one applies:

| Button | Why |
|---|---|
| Testing… | A test is running (yours, or the 08:00 check). |
| Collection running | The evening run is collecting from Angel One and is logged in; test when it finishes. |
| Wait N s | One minute must pass after each login; the button counts it down. |
| Held until HH:MM | Angel One refused the last login. The same settings are not tried again for 15 minutes; the card says why. |

After a **Login refused**, fix the `ANGELONE_*` settings in the `.env` file. The server reads them
again on every check, so no restart is needed, and changed settings lift the 15-minute hold at
once. The 08:00 check follows the same rules: if you test just before 08:00 it waits rather than
fails. A failed 08:00 check sends a Telegram alert.

## Kite connection

Kite (Zerodha) holds the Momentum money. This tool reads two things from it, never trading:
your holdings and your free cash, for Momentum's [Your orders](app:/momentum/week). It is set up
with `KITE_API_KEY` and `KITE_API_SECRET` in the `.env` file. The Kite app's redirect URL is
the hosted dashboard's `/api/momentum/kite/callback`, so a login works from your phone.

| What you see | Meaning |
|---|---|
| Not configured | The two settings are missing from `.env`. |
| Connected | Today's login is valid, until 06:00 IST tomorrow. The account ID is shown. |
| Not logged in today | Log in before Friday's 14:15 orders, or before Monday's open. |

On Fridays and trading Mondays the 08:02 morning login can log in to Kite for you
(`KITE_AUTO_LOGIN=on` in `.env`, with your Kite user ID, password and TOTP key; off by default).
Its result is in the 08:10 message, and a failure is sent at once; the card then shows Not logged
in today and the reminders below still come. Zerodha says automating its login is not allowed, so
switching it on is a risk to the Kite account you accept.

**Login with Kite** opens Kite's own login page in a new tab. After you log in, Kite sends the
browser back to the hosted dashboard, which passes the login to the Momentum service on the laptop.
That service keeps the token (in a private file, never shown) and, when Kite is the holdings source,
reads your holdings straight away. It works from your phone, with the same two things running on
the laptop as for Fyers.

The card's last line shows the last read: how many holdings, the free cash, and what was left
out as options margin (LIQUIDBEES and gold bonds). A **13:30 Friday** job (`kite-login-reminder`)
and an **08:45 Monday** job (`kite-login-reminder-monday`, trading Mondays; see [Jobs](app:/jobs))
send a Telegram reminder, with a link to this screen, when Kite is the holdings source and you
have not logged in that day; they say nothing otherwise.

## AlgoTest logins

The broker accounts (Angel One, Finvasia) are logged into [AlgoTest](glossary:algotest) by the
08:00 `broker-login` job, not from this screen. See [Jobs](app:/jobs). The Angel One card above
checks this tool's own data login, not AlgoTest's.

When it is switched on, the same job also logs in to Quantiply, Angel One's algo platform, with the
same Angel One account. Its result is a line of its own in the job's Telegram report.

## Common questions

**Is Fyers used for trading?** No. This tool uses Fyers for market data only and places no
orders. The same goes for Angel One: its login here only reads 1-minute data. And for Kite: it
reads holdings and free cash, never an order.

## What it is for

The dashboard reads market data from **Fyers**. Fyers requires a fresh login every day; this
screen shows whether today's login is valid and lets you log in by hand. Below it, the
**Angel One** card shows whether the fallback data source can log in.

## Why it expires every day

A Fyers token dies at **06:00 IST** the next morning, whenever you logged in. Fyers put a
human-verification check on its login page, so no scheduled job can log in for you: use **Log in
again** once a trading day, any time before the evening data collection.

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

**Last check** is the newest of the automatic check (the `angel-login-check` job, 08:00 on
trading days, see [Jobs](app:/jobs)) and your own **Test connection**, with the time and how long
the login took. **Last collection from Angel One** is the last day the evening run actually
collected from it.

**Test connection** makes one login now. Nothing is fetched or traded, and the session is thrown
away at once. Angel One limits logins and locks an account after repeated wrong attempts, so
only one test runs at a time and there is a one-minute wait after each login (the button counts
it down). The 08:00 check shares the same limit: if you test just before 08:00, it waits rather
than fails. A failed 08:00 check sends a Telegram alert; a refused login is not retried
automatically, so fix the setting and use Test connection.

## AlgoTest logins

The broker accounts (Angel One, Finvasia) are logged into [AlgoTest](glossary:algotest) by the
08:00 `broker-login` job, not from this screen. See [Jobs](app:/jobs). The Angel One card above
checks this tool's own data login, not AlgoTest's.

## Common questions

**Is Fyers used for trading?** No. This tool uses Fyers for market data only and places no
orders. The same goes for Angel One: its login here only reads 1-minute data.

## What it is for

The dashboard reads market data from **Fyers**. Fyers requires a fresh login every day; this
screen shows whether today's login is valid and lets you log in by hand.

## Why it expires every day

A Fyers token dies at **06:00 IST** the next morning, whenever you logged in. The scheduled
`fyers-login` job logs in again at 08:05 on trading days, so normally you never touch this.

## The states

| State | Meaning |
|---|---|
| Not configured | No Fyers app is set up on the server. |
| Connected | A valid token, with a countdown to 06:00. |
| Expiring soon | Two hours or less left before the 06:00 expiry. |
| Expired / No API token | Log in again. Data collection and live prices will fail until you do. |

**Log in again** opens Fyers' own login page in a new tab. The token is stored encrypted on the
server; the browser never sees it.

## AlgoTest logins

The broker accounts (Angel One, Finvasia) are logged into [AlgoTest](glossary:algotest) by the
08:00 `broker-login` job, not from this screen. See [Jobs](app:/jobs).

## Common questions

**Is Fyers used for trading?** No. This tool uses Fyers for market data only and places no
orders.

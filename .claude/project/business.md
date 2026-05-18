# Business & Product Context

AI Trading Agent is a **personal research tool** with no commercial product, no paying users, no revenue, and no billing infrastructure. All usage is by the project owner(s) directly.

## Offering

- Fully free, no tiers, no paywall
- Not deployed as a public-facing service
- No user accounts or authentication — single-operator tool

## Tiers

None. There are no pricing tiers.

## Payment / Billing

None. No Stripe, no Paddle, no payment provider of any kind is integrated or planned.

## Compliance & Legal Notes

- **No PCI scope** — no payment data is ever handled
- **No GDPR / PII scope** — no user data is collected or stored; the only "data subjects" are market prices
- **SEBI / NSE regulatory note:** Paper trading only. The system explicitly does not execute real trades. Fyers credentials are used for market data subscription only (read-only WebSocket), not for order placement. Quantiply API is used for simulated paper trade tracking only
- **Indian market calendar awareness:** The system blocks trading on RBI policy days, budget days, and F&O expiry mornings — this is a risk management rule, not a compliance obligation

## Pipeline Scope (applies to every pipeline run)

- **pricing-reviewer:** NOT APPLICABLE — no billing, no tiers, no Stripe. Skip on every run
- **auth risk flag:** NOT APPLICABLE — no user authentication, no sessions, no PII
- **Risk profile:** The system handles financial logic (P&L calculations, position sizing, risk rules) and connects to external broker APIs, so backend + infra specialist lenses apply for architecture review. Security review should focus on secrets management (Fyers/Quantiply credentials, `.env` hygiene) and safe handling of broker WebSocket data, not on user auth or payment flows

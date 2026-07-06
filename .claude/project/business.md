# Business & Product Context

AI Trading Agent started as a personal research tool and is now a **commercial SaaS product** with India-only subscription billing. Access is gated by a single-instance license (one active subscription unlocks the deployed instance — no per-user accounts). All usage is by the project owner(s) and paying subscribers directly.

## Offering

- Subscription-gated access — India only (Phase 1)
- Two payment products: **Monthly Access Pass** (one-time UPI payment → 30 days access) and **Feature-Token Credits Pack** (one-time UPI payment → N credits, consumed per feature call e.g. backtest run)
- Payment via Razorpay (UPI / Indian debit-credit cards) — one-time Orders API, no mandate/autopay
- International payments deferred to Phase 2 (Stripe planned)
- `PAYMENT_ENABLED` is derived from `RAZORPAY_KEY_ID` presence — omit the key for free/open access (development mode)

## Tiers

| Tier | Price | Access |
|---|---|---|
| Monthly Access Pass | ₹X/month (set in Razorpay dashboard) | 30-day access window per payment |
| Credits Pack (50) | ₹Y one-time | 50 feature tokens (e.g. backtest runs) |
| Credits Pack (200) | ₹Z one-time | 200 feature tokens |

Prices are defined in Razorpay's dashboard and in `RAZORPAY_*_PRICE_PAISE` env vars (display only — Razorpay is the source of truth).

## Payment / Billing

- **Processor:** Razorpay (India UPI, Indian debit/credit cards)
- **Payment model:** One-time Razorpay Orders — no recurring mandate, no autopay
- **India-only Phase 1:** UPI requires an Indian bank account (Indian KYC); this is the primary anti-spoofing mechanism. IP geolocation is used only to display the UPI option — it provides no security guarantee.
- **Credits = feature tokens:** consumed atomically per feature call (e.g. 1 credit per backtest run); balance tracked in `credit_transactions` table
- **Silent fail:** if `RAZORPAY_KEY_ID` is absent, the entire payment subsystem is disabled and the app runs freely (development / self-hosted mode)

## Compliance & Legal Notes

- **PCI / PII boundary:** Razorpay stores all card/UPI credentials and is PCI-compliant on their side. This application stores only `razorpay_order_id`, `razorpay_payment_id`, `grant_type`, and credit transaction records. No raw payment instrument (card number, UPI PIN, VPA) is ever written to our database.
- **GST:** Deferred to Phase 2. For Phase 1, prices are quoted exclusive of tax. Operator must register for GST if annual turnover exceeds ₹20L. Razorpay's dashboard handles GST display for Indian transactions.
- **DPDP Act 2023 (India):** No card/UPI credentials stored locally. Razorpay is the data processor for payment instruments. Full DPDP compliance review deferred to Phase 2.
- **SEBI / NSE regulatory note:** Paper trading only. The system explicitly does not execute real trades. Fyers credentials are used for market data subscription only (read-only WebSocket), not for order placement. Quantiply API is used for simulated paper trade tracking only.
- **Indian market calendar awareness:** The system blocks trading on RBI policy days, budget days, and F&O expiry mornings — this is a risk management rule, not a compliance obligation.

## Pipeline Scope (applies to every pipeline run)

- **pricing-reviewer:** APPLICABLE — billing and payment logic now present (Razorpay UPI, access grants, feature-token credits). Run in Phase 1 constraint round and Phase 4 review on any run that touches payment code.
- **auth risk flag:** NOT APPLICABLE — single-instance tool, no user sessions or accounts; Razorpay holds PCI/PII scope for payment instruments. No per-user authentication is implemented or planned for Phase 1.
- **Risk profile:** The system handles financial logic (P&L calculations, position sizing, risk rules), payment/billing logic (Razorpay Orders, webhook signature verification, credit consumption), and connects to external broker APIs. Backend + infra specialist lenses apply for architecture review. Security review should focus on: secrets management (Fyers/Quantiply/Razorpay credentials, `.env` hygiene), webhook HMAC verification (raw-body requirement), and safe handling of broker WebSocket data.

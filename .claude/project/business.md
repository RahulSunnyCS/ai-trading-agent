# Business & Product Context

A **personal research tool**: used by the owner and two or three friends, free, self-hosted on
the owner's laptop (a home Mac mini later). There are no paying users. Selling access is not
planned; it may come later, if at all (BL-028 makes the call at month 3).

## Real money

Real trades happen outside this repo, placed by the owner by hand or through AlgoTest. The
owner plans to put 10–20% of their portfolio into Momentum once BL-010's validation passes; the
rules for that money are BL-025. Friends see the owner's results and rules for information
only; their own money is their decision.

## Compliance & Legal Notes

- **SEBI / NSE:** this repo places no orders. Fyers credentials are used for market data
  (read-only WebSocket, history and quotes) and, since BL-051 Phase 3, to read the owner's own
  holdings (read-only `/holdings`) for Momentum's "Your orders"; never for order placement.
  AlgoTest strategies run on the owner's own broker accounts.
- **Offering signals to others (check before doing it):** sharing buy/sell recommendations
  with people outside the owner's own use, especially for a fee, can fall under SEBI's
  Research Analyst or Investment Adviser regulations. Get that checked before the workbench or
  its signals go beyond the current friends (BL-028). This is a note for later, not legal advice.
- **Indian market calendar awareness:** the frozen engine blocks trading on RBI policy days,
  budget days and F&O expiry mornings. A risk rule, not a compliance obligation.

## Frozen: SaaS billing

Built for an earlier plan to sell access, now frozen with the personality engine
(`overview.md` → Frozen). Kept and tested in CI, not extended.

- **Model:** a single-instance licence (one active subscription unlocks the deployed instance;
  no per-user accounts), India only. Two one-time Razorpay Orders products (no mandate or
  autopay):

  | Product | Price | Access |
  |---|---|---|
  | Monthly Access Pass | ₹X/month (set in Razorpay's dashboard) | 30 days per payment |
  | Credits Pack (50) | ₹Y one-time | 50 feature tokens (e.g. backtest runs) |
  | Credits Pack (200) | ₹Z one-time | 200 feature tokens |

  Prices live in Razorpay's dashboard; `RAZORPAY_*_PRICE_PAISE` env vars are display only.
- **Surface:** `POST /payment/create-order`, `POST /payment/webhook` (HMAC-verified on the raw
  body), `GET /payment/balance`; access-gate middleware for subscription and credit checks.
  `POST /api/backtest/runs` is access-gated and costs one credit (feature `backtest_run`);
  `validate`/`presets`/`coverage`/`health` are free. Credits are consumed atomically and
  recorded in `credit_transactions`.
- **Off by default:** `PAYMENT_ENABLED` derives from `RAZORPAY_KEY_ID`. Without the key the
  payment subsystem is disabled and the app runs openly, which is how it runs today.
- **India-only anti-spoofing:** UPI needs an Indian bank account (Indian KYC). IP geolocation
  only decides whether to show the UPI option; it is not a security control.
- **PCI / PII boundary:** Razorpay holds every card/UPI credential. This repo stores only
  `razorpay_order_id`, `razorpay_payment_id`, `grant_type` and credit transactions, never a
  card number, UPI PIN or VPA.
- **Deferred with it:** GST (register if annual turnover exceeds ₹20 lakh), a DPDP Act 2023
  review, and international payments (Stripe).

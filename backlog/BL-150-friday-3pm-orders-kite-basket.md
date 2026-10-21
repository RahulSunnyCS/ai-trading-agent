# BL-150 — Friday 15:00 Momentum orders, one tap into a pre-filled Kite basket

| | |
|---|---|
| **Priority** | P1 — Momentum is this month's goal; the Monday-open fill costs about 1.6 to 1.9 points a year against the backtest's Friday-close fill (BL-010 addendum 6), and the orders are keyed in by hand |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum + scheduler + dashboard |
| **Created** | 2026-10-22 |
| **Depends on** | BL-142 (Kite lots and per-lot orders), BL-051 (Your orders), BL-010 addendum 6 (the Monday-open cost) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner, 2026-10-22: "rebalance can happen at 3 o'clock, and once the rebalance happens there should be
a Kite button, or a Telegram message; once I click it, the transaction should happen: this gets sold
and I buy the new stock." Today the orders job (`momentum-orders`, Fri 14:15) plans the headline's
orders and sends them; the owner places them by hand, on Monday (BL-142). BL-010's check of the
followed strategy put that Monday fill at about 1.6 to 1.9 points of CAGR and 0.5 to 1.1 of drawdown against the
Friday-close fill the backtest assumes. A Friday 15:00 to 15:25 fill sits much closer to the
backtest's assumption, but plans from 15:00 prices, not the final close.

Chosen design (owner, 2026-10-22, "as per your recommendation"): the tool plans and sends; the
**owner places the orders inside Kite** from a basket the tool pre-fills. This keeps the repo's rule
that it never places an order (`business.md`: Kite is read-only here), and the exchange and SEBI
rules on API orders stay out of the picture.

## Goal

- Fridays at 15:00 the owner gets one Telegram message: the lots due, sells first, then buys, with
  quantities, the cash used and each name's last price.
- One tap opens Kite with those orders as a basket already filled in; the owner presses the final
  confirm inside Kite. Nothing is sent to Kite's order API by this repo.
- After the close, the 15:00 plan is compared with the plan from the final Friday close, so the cost
  of planning at 15:00 is measured, not assumed.

## Out of scope

- Placing orders from this repo (Kite's order API, or the Telegram button placing them). Recorded as
  the alternative the owner did not choose. If it is ever wanted it needs its own item: Zerodha's
  plan terms for order placement, the exchange's retail algo rules for API orders (static IP,
  registration), the two-tap confirm and order caps of BL-143's stop button, and a compliance note
  in `business.md`.
- Changing the strategy, the lot logic or what is planned: only when and how the plan is delivered.

## Plan

### Phase 0 — Confirm the facts (no code)
- **Tasks:** read Kite's own documentation and check, on the owner's account, that: (a) a basket link
  can be built for a Kite Connect Personal app and what it needs (the app's key, the order list as
  form data), and that the final confirm stays with the owner; (b) which order types it takes for
  delivery (CNC; market or limit) and any order-count limit; (c) whether the money from a sale is
  available for a buy placed straight after, since the plan spends Kite's free cash (`net` minus
  collateral); (d) the last time an order can go in before the 15:30 close and what happens to a
  limit order that does not fill; (e) whether the link works from a phone.
- **Deliverables:** a short note in this item with the answers and links.
- **Done when:** each of (a) to (e) is answered from the documentation or a test with the owner, or
  marked unknown with what blocks it.

### Phase 1 — The 15:00 plan and message
- **Tasks:** move the Friday orders step to 15:00 (scheduler job; the 14:40 Broad preview stays as
  the early look), re-plan the due lot with live prices from Kite or Fyers (whichever token is
  valid), list sells before buys, and send one Telegram message through `@trading/notify`'s
  Python mirror. A lot not due or no change: say so in one line. A missing Kite login at 15:00 is
  reported as a problem, not silence (there is already a 13:30 login reminder).
- **Deliverables:** the job, the message, tests with a fake Kite and fixed prices.
- **Done when:** a dry run on a past Friday's data produces the message the owner would have acted on.

### Phase 2 — The Kite basket button
- **Tasks:** build the basket from the plan (Phase 0's format) and a page that opens it in Kite. The
  notify rule is that buttons are `callback_data`, never URLs, because Telegram pre-fetches links; a
  basket link only loads a page and places nothing, but the first version puts the link on the
  dashboard's Your orders page ("Open in Kite") and in the message as plain text, then tests whether
  a Telegram URL button is safe before using one. The hosted dashboard is needed to tap it from a
  phone (`docs/remote-dashboard.md`).
- **Deliverables:** the basket builder, the page, a test that the basket equals the plan's orders.
- **Done when:** the owner opens the basket on a real Friday and every order matches the message.

### Phase 3 — Measure what 15:00 costs
- **Tasks:** after each Friday's final run, store the 15:00 plan beside the plan from the final
  close, and the fills the owner reports (or Kite's holdings change on Monday). Report how often
  the two plans differ, in names and in rupees, and the fill price against the Friday close.
- **Deliverables:** a stored comparison per Friday and a short read-out after 8 Fridays.
- **Done when:** 8 Fridays are recorded and the read-out says whether 15:00 planning keeps most of
  the 1.6 to 1.9 points the Monday fill loses.

## Risks

- A stale plan: prices move between the message and the tap. The basket carries the quantities
  planned at 15:00; the owner can edit in Kite. The message states its time.
- Thin or circuit-locked names near the close: a limit order may not fill. Phase 0 (d).
- A Friday with a missed Kite login or a late Fyers token: the plan must say which prices it used.
- Time pressure between 15:00 and 15:25. The message goes out at 15:00 sharp; a later start is a
  question for the owner (below).

## Open questions

1. Is 15:00 right, or earlier (14:45) to leave more room before 15:25?
2. A link in the Telegram message, or only the dashboard button (needs the hosted dashboard on the phone)?
3. When a sale's money is not usable at once, should the message split buys into "now" and "after
   the sell fills"?

## Log

- 2026-10-22 — created from the owner's idea; the owner chose the Kite basket (owner places the
  order in Kite) over orders sent by this repo. Not started.

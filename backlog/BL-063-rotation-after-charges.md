# BL-063 — The rotations after brokerage and statutory charges

| | |
|---|---|
| **Priority** | P2 — options research; turns BL-057 / BL-061 / BL-062 into after-charges numbers |
| **Status** | In progress (descriptive calculation on existing results) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-057, BL-061, BL-062 (the daily picks), BL-054 / 056 / 059 / 060 / 061 / 062 (variant files) |
| **TODO.md row** | — |

## Context

Every rotation result so far is before charges, while the owner's real sheet is after charges and
showed ₹1,03,429 of charges (37% of gross profit) over 3 Dec 2025 – 7 Oct 2026. The owner
(2026-10-09 chat) asked to assume ₹13 brokerage per lot plus STT and the other statutory charges and
to work out the after-charges value.

## Goal

Per-day and per-month charges and after-charges P&L for the BL-062 whole-day rotation and the BL-057
66-variant rotation, as % of ₹13 lakh, beside the owner's real sheet.

## Out of scope

Changing any rule or pick; slippage or spread; AlgoTest's own per-strategy fee (shown as a separate,
optional line); tax on profits.

## Plan

### Phase 0 — Pre-register the charge model
- **Trades:** each day's picked variants (5 core lots, plus the Buy lots when added) are re-run one day
  at a time with the same engine, to read every trade's side, quantity, entry and exit price; the
  re-run's gross P&L must equal the stored per-day result for every pair (checked, else stop).
- **Charges per trade** (1 lot, one entry order and one exit order; a re-entry is a new trade):
  - **Brokerage:** ₹13 per lot per order (owner's assumption), so ₹26 per trade.
  - **STT:** on the sell side premium turnover: 0.10% for trades dated before 2026-04-01, 0.15% from
    2026-04-01 (Finance Act 2026; [Zerodha](https://support.zerodha.com/category/account-opening/resident-individual/ri-charges/articles/how-is-the-securities-transaction-tax-stt-calculated), [ICICI Direct](https://www.icicidirect.com/ilearn/futures-and-options/articles/stt-changes-in-budget-2026-what-f-o-traders-should-know)).
  - **Exchange transaction charge**, both sides: NIFTY (NSE) 0.03503% of premium; SENSEX (BSE) 0.0325%
    (revision of 1 Oct 2024; no later change found).
  - **SEBI turnover fee:** ₹10 per crore (0.0001%) both sides. **NSE investor protection fund:**
    ₹50 per crore (0.0005%), NIFTY only. **Stamp duty:** 0.003% on the buy side.
  - **GST:** 18% on brokerage + exchange charge + SEBI fee + IPFT.
  - Rates differ slightly between brokers; the owner's contract notes decide. Turnover = price × quantity
    (current lot sizes, as the backtest).
- **Optional line, shown separately:** AlgoTest's per-strategy fee, about ₹19 a strategy-day (₹75 for 4
  strategies in the owner's sheet), for the lots actually run.
- **Outputs:** total and monthly charges and after-charges P&L (₹ and % of ₹13 lakh), the charges split
  by item, charges as a share of gross profit, per lot-day, and a rough break-even; beside the owner's
  real net (+13.3%) and gross (+21.3%).
- **Pass / kill rule:** none; arithmetic. Reconciliation: re-run gross equals stored gross per pair.
- **Hold-out / Will not run:** not applicable; no slippage, no other charge models.
- **Result:** (after the run)

### Phase 1 — Re-run the picked (variant, day) pairs and record trades (8 in parallel)
### Phase 2 — Apply the charge model; table and chart

## Log

- 2026-10-09 — created from the owner's request: ₹13 brokerage per lot, plus STT and other charges.

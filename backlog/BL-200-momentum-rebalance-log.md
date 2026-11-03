# BL-200 — Momentum rebalance log in the Trade book

| | |
|---|---|
| **Priority** | P1 — the real Momentum money is followed lot by lot, and the Trade book only lists raw fills |
| **Status** | In progress |
| **Type** | feature |
| **Area** | momentum / dashboard |
| **Created** | 2026-11-02 |
| **Depends on** | BL-142 (lot ledger), BL-024 Phase 3 (Kite fills reconciled per lot) |
| **TODO.md row** | 3.13.12 |

## Context

The Trade book's Momentum tab lists every Zerodha fill (26 rows for one Friday: NAZARA four
times, CUPID twice). The owner wants one block per rebalance instead: the week, the lot that was
due, whether it was done, one line per stock (shares, value, buy or sell) and what the lot holds
after it. Every piece exists already: the lot ledger (BL-142), the Friday 14:15 orders, and
`forward_fills.reconcile` (BL-024 Phase 3), which matches each due week of each lot to the
contract-note fills and gives every stock a status. This item is a view over them.

## Goal

The Trade book › Momentum tab opens on a rebalance log: one block per lot per due week, newest
first, readable without the fills table.

## Out of scope

- Changing how orders are planned. A lot that misses its Friday is caught up the next time it is
  due, as today (owner answer 2).
- Cash per lot (the ledger books shares, not cash).

## Plan

### Phase 1 — The log
- **Tasks:** a pure builder (`rebalance_log.py`) over `forward_run.compute_fills()`'s rebalances
  and the ledger events; `GET /api/lots/rebalances` (proxied at `/api/momentum/lots/rebalances`);
  the dashboard block per week, the fills table kept below, collapsed; guide page.
- **Deliverables:** merged PR.
- **Done when:** the tab shows Week 2 (Fri 23 Oct) as one block whose lines match the 26 fills
  netted per stock, and the holding after matches the ledger.

## Risks

- A Friday whose notes have not arrived must not read "not done": it reads "waiting for notes"
  until a note dated on or after that Friday is in.

## Open questions

Answered 2026-11-02 (owner, in chat):
1. **Done:** on a rebalance Friday, every buy and sell since the lot's last booking is first booked
   from the contract notes, up to the latest note; the week is done when those fills cover the
   orders made for the lot.
2. **Missed weeks:** shown as not done and said to be folded into the lot's next due week. Orders
   are not changed (option a).
3. **Week numbering:** from the paper start, Fri 16 Oct 2026 = week 1, one week per Friday.
4. **Fills table:** kept below the log, collapsed, for checking a figure against a note.
5. **Holding after:** per lot.

## Log

- 2026-11-02 — created and started (owner asked in chat with a sketch of the block); questions
  answered above.
- 2026-11-02 — every fill of the week shown, in a lot or not (owner; PR #398).
- 2026-11-03 — a block lists only what the contract notes show was traded, never what the strategy
  suggested (owner: "only whatever we have purchased in that particular week"). Suggested stocks
  nobody traded are counted under the table for the status, not listed.

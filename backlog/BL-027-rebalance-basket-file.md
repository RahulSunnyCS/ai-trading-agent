# BL-027 — Weekly rebalance as a broker basket-order file

| | |
|---|---|
| **Priority** | P2 — removes hand-typed orders once real money is in; not needed before |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-024 (the journal's target holdings are the source), BL-025 (rules decide whether a rebalance runs) |
| **TODO.md row** | — (filled in when started) |

## Context

The weekly signal and the Rebalance page say what to buy and sell; the owner then types each order
into the broker by hand. With 10–20 stocks a week, a typo in a symbol or quantity is easy and
costly. Brokers accept basket or bulk orders from a file.

Approved by the owner on 2026-10-06 (from the review PR #27).

## Goal

The Rebalance page and the Friday signal produce a file the owner's broker imports as a basket of
orders, with quantities computed from the owner's current holdings and capital.

## Out of scope

- Placing orders through a broker API. The owner reviews and submits the basket.

## Plan

### Phase 1 — One broker's format
- **Tasks:** from the target holdings and the owner's current holdings (entered or imported),
  compute sells first, then buys, in whole shares, rounding down; export in the chosen broker's
  basket format, with a summary of cash left and shares not bought because of rounding.
- **Done when:** a real weekly rebalance imports into the broker without edits.

### Phase 2 — Record what was sent
- **Tasks:** store each exported basket next to the journal entry (BL-024 Phase 3), so actual
  fills can be reconciled against it.
- **Done when:** one week's basket and fills are reconciled.

## Open questions

1. Which broker, and which of its basket formats?
2. How are current holdings entered: a holdings CSV from the broker, or typed in?

## Log

- 2026-10-06 — created; owner approved the idea on PR #27.

# BL-026 — Options: realised P&L against the backtest of the same days

| | |
|---|---|
| **Priority** | P1 — the only direct measure of whether the options strategies make money after real costs |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options, contract-notes |
| **Created** | 2026-10-06 |
| **Depends on** | TODO §2 (contract-notes cutover, owner steps 2.1–2.6), BL-009 Phase 1 (engine vs AlgoTest) |
| **TODO.md row** | — (filled in when started) |

## Context

The strategies the owner runs through AlgoTest produce contract notes, and `packages/contract-notes`
turns them into realised F&O P&L (cutover still pending, TODO §2). The leg-wise engine can replay
the same strategies on the same days from the collected 1-minute data. Nothing compares the two,
so slippage, missed fills and cost differences are assumed, not measured. TODO 3.3.3 plans this
comparison for the personality engine, which is frozen (BL-019); this item does it for the
strategies that actually trade.

## Goal

For every trading day, each live strategy's realised P&L sits next to its backtest P&L for the same
day, with the gap broken down into entry/exit price, costs and missed or extra trades.

## Plan

### Phase 1 — Join
- **Tasks:** read realised P&L per strategy per day (after cutover, from 2.8's
  `realised-pnl.schema.json`); run `obt legwise` for the same days; store both in the catalog.
- **Done when:** ten trading days are joined.

### Phase 2 — Explain the gap
- **Tasks:** per day and per strategy: price slippage, costs, trades only in one of the two; an
  Options Lab view and a weekly Telegram summary.
- **Done when:** the average gap per lot is known per strategy, and fed back into the engine's
  slippage settings.

## Open questions

1. Which strategies run live today, and on which broker accounts?
2. Can AlgoTest's own order log be exported, to tell "missed by AlgoTest" from "different in the
   backtest"?

## Log

- 2026-10-06 — created in the overnight review; not discussed with the owner yet.

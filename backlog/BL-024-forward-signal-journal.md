# BL-024 — Forward-signal journal: record every weekly signal from now on

| | |
|---|---|
| **Priority** | P0 — time-critical: every Friday not recorded is out-of-sample evidence lost for good, and real money is planned |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum (+ trading-data) |
| **Created** | 2026-10-06 |
| **Depends on** | none; BL-010 Phase 6 uses it |
| **TODO.md row** | — (filled in when started) |

## Context

Every Momentum number so far is a backtest, and BL-010 shows how far a backtest can flatter. The
only evidence nothing can flatter is a signal recorded *before* the week it trades, then compared
with what happened. BL-010 Phase 6 plans 6–12 months of paper tracking, but only after Phases
3–5, which are weeks away. Weeks that pass before tracking starts cannot be recorded afterwards.

The owner said on 2026-10-04 that real money on the weekly signal was planned "from tomorrow",
and is sharing the tool with friends this month.

## Goal

From the next Friday on, every weekly signal of every tracked config is stored unchangeably with
its timestamp, and a page and a weekly Telegram line compare it with the realised result and with
the benchmark.

## Out of scope

- Choosing which config to trade (BL-010).
- Broker integration or order placement.

## Plan

### Phase 1 — Record (before the next Friday)
- **Tasks:** an append-only `momentum_forward_journal` table in the shared catalog: config ID,
  settings hash, code commit, data fingerprint, signal time, target holdings and weights. Written
  by `mbt weekly` for: the configs the owner may trade, the BL-010 median config, and the Nifty200
  Momentum 30 index. Rows are never updated; a correction is a new row that points to the old one.
- **Deliverables:** table, writer, test that an existing row cannot be changed.
- **Done when:** the next Friday's 16:45 run writes its rows.

### Phase 2 — Score
- **Tasks:** each week, compute each journal portfolio's realised return from the next session's
  prices onward, with the same cost and tax model as the backtest; compare with what the backtest
  says for the same weeks.
- **Deliverables:** weekly scoring job (BL-012), a Momentum "Forward" page, one Telegram line.
- **Done when:** four weeks are scored and the live-vs-backtest gap is shown per config.

### Phase 3 — Real fills (when money is in)
- **Tasks:** let the owner record actual fills (manual entry or broker CSV) next to the journal,
  so slippage and missed trades are measured, not assumed.
- **Done when:** one real rebalance is reconciled.

## Risks

- A journal that can be edited is worthless as evidence. Enforce append-only in the database.

## Open questions

1. Which configs to journal (the favourites, or a fixed shortlist)?

## Log

- 2026-10-06 — created in the overnight review; not discussed with the owner yet.

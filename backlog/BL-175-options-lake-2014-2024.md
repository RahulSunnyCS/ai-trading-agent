# BL-175 — Options history lake: load the 2014–2024 expiry-week history (BL-034 Phase 5)

| | |
|---|---|
| **Priority** | P2 — widens the backtest window; nothing current waits on it |
| **Status** | Planned |
| **Type** | feature |
| **Area** | trading-data (+ options) |
| **Created** | 2026-10-28 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) (the loader and lake it extends) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-034 loaded two years of vendor 1-minute index options into the lake (Phases 0–4). Its Phase 5 — the older 2014–2024 history, expiry weeks only — was marked "later, after the owner widens the window" and split out here when BL-034 closed on 2026-10-28.

## Goal

Every 2014–2024 day the vendor has is in the lake with a `coverage='expiry_week'` mark in `data_quality`, and the derived tables refuse DTE features where a contract's life is not present.

## Plan

- **Phase 1 — Load with coverage marks.** The same loader on the expiry-week-only history; `coverage='expiry_week'` in `data_quality`; monthly-only NIFTY before 2019; sparse-bar handling per BL-009's findings (traded flag, duplicate rows, off-session bars, missing expiry day). **Done when:** every imported day carries its coverage mark and the derived tables refuse DTE features where the contract's life is not present.

Open questions (ask when started): the slippage assumption until spreads are recorded (fixed ticks vs % of premium scaled by volume); whether derived tables cover BANKNIFTY; disk-image headroom.

## Log

- 2026-10-28 — created when the owner closed its parent item (2026-10-28). Status `Planned`.

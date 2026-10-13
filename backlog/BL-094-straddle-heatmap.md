# BL-094 — Straddle heatmap: ATM short-straddle P&L by time, date and stop loss, for every index and F&O stock

| | |
|---|---|
| **Priority** | P2 — the owner's AlgoTest-style daily view of which entry time and stop work; becomes the Options Lab default |
| **Status** | Done |
| **Type** | feature |
| **Area** | options / dashboard |
| **Created** | 2026-10-11 |
| **Depends on** | BL-034 (1-minute option lake, derived tables), BL-090 (Correlation tab, changed in Phase 4) |
| **TODO.md row** | 3.25 |

## Context

Owner (2026-10-11), with three AlgoTest Heatmap screenshots: a short ATM straddle grid of rupee P&L, colour-banded
green/red, with a TOTAL row and column. It should be the default Options Lab page. Correlation stays, but as its own
widget and not mixed with it; it should open on only the three live 09:17 strategies (Widesl 09:17, Dir 09:17,
Buy 09:17) because the owner plans five or six more strategies next month and the matrix would clutter. Any of the
~286 / 330 rotation variants and other strategies must be addable for comparison through a multiselect.

Data (checked 2026-10-11 in `bars_1m_option`): NIFTY from 2022-01, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX from
2023, all through 2026-10-09; **46 F&O stocks with about 600 days each (2023-09 → 2026-08-25) from the vendor import**,
so the owner's "only a couple of days" is wrong; stock data after 2026-08-25 arrives with BL-038 from 2026-10-27.
BANKEX is not in the lake. This is a new surface: the legwise engine runs a handful of fixed strategies, whereas the
heatmap needs a grid of (entry time x stop) simulations per day and underlying.

## Goal

- A heatmap page with the three AlgoTest views, all computed from the lake and the same fill rules as the legwise engine:
  1. **Time vs SL** for one date (rows entry times, columns SL 10..100%).
  2. **Date vs Time** for a date range at a chosen SL.
  3. **Date vs SL** for a date range at a chosen entry time.
- Cell = rupee P&L of one lot, short ATM CE + PE sold at the entry time, **SL per leg as % of that leg's entry
  premium**, exit at **15:30**, the close of the last 1-minute bar (owner, 2026-10-11, second answer; supersedes 15:20).
  SL columns are 10, 20 ... 100 as in the AlgoTest screenshots. (2026-10-12, owner: one more column, **No SL**:
  the same straddle with no stop, both legs held to the exit time; `sl = 0` in the store, last in every SL axis.)
- **Expiry rule:** NIFTY and SENSEX use the nearest weekly; every other index and every stock uses the monthly expiry only. TOTAL row and column, split PE/CE toggle, CSV download.
- Underlying picker for every index in the lake plus a stock picker (and "all F&O stocks aggregated").
- Stock filter by **week of the monthly expiry cycle** (week 1-4 / expiry week) and by date range.
- Opens as the Options Lab default tab. Correlation is a separate widget with a strategy multiselect.

## Out of scope

Share to X/Telegram/LinkedIn buttons. Combined-premium stops (owner chose per-leg). Strategies other than the plain
short straddle (a leg-wise builder already exists). Placing orders.

## Plan

### Phase 1 — Grid engine
- **Tasks:** `heatmap/grid.py`: for each day, entry time (09:16, then every 30 min to 14:45, as in the screenshots) and SL, simulate the short ATM straddle on 1-minute bars with the legwise engine's fill, slippage, cost and lot-size rules (lot size by the contract's expiry); store the result per (underlying, day, time, SL, leg) in the catalog or a derived Parquet table so views are lookups; incremental over new days (`obt daily` and the derived-rebuild job).
- **Deliverables:** `obt heatmap build` and `obt heatmap show`; tests including a hand-computed day and parity with an equivalent legwise strategy (the 09:17 Widesl-like straddle without a wide SL reproduces to the rupee).
- **Done when:** NIFTY 09:16 / 26 Aug 2026 reproduces the owner's AlgoTest grid within the stated cost and fill differences, and the differences are written down.

### Phase 2 — API
- **Tasks:** `GET /legwise/heatmap?view=time_sl|date_time|date_sl&underlying=&from=&to=&sl=&time=&split=`, plus the Fastify proxy route with whitelisted params; stock `expiry_week` filter.
- **Done when:** the three views return in under a second from the stored grid.

### Phase 3 — Dashboard
- **Tasks:** Options Lab › Heatmap (default tab), table with colour bands from tokens (never a hex), view selector, SL / time / date controls, underlying tabs, stock picker, expiry-week filter, split PE/CE, CSV; Guide page and `registry.ts` entry.
- **Done when:** checked in the browser at desktop and phone width on live data.

### Phase 4 — Correlation as its own widget
- **Tasks:** Correlation tab defaults to Widesl 09:17, Dir 09:17, Buy 09:17; a multiselect adds any strategy with results (variants, other strategies); the selection is remembered.
- **Done when:** a strategy created tomorrow appears in the multiselect with no code change.

## Result (2026-10-11)

All four phases built. Grid cells are pinned to `simulate_day` by `tests/unit/test_heatmap.py` (every time x exit x SL
on four random series, stops included). Against the owner's AlgoTest NIFTY grid for 26 Aug 2026 the structure and
steps match; cells agree within about ₹100 when the exit is **15:15**, which is where AlgoTest squares off, and are
~₹1,100 off at 15:30 on rows where the call keeps decaying into the close. So the grid is built for both exits and the
page defaults to the owner's 15:30 with 15:15 one click away. Stocks: 46 underlyings, about 600 days each. Left out and
counted: days data_quality excludes, and days where the chosen monthly contracts were not in the vendor chain
(BANKNIFTY 2023-09 to 2024-12 has weekly contracts only on many days).

## Risks

- The grid is about 13 times x 10 SLs per day per underlying; over 600 days x 46 stocks that is a lot of simulations, so compute incrementally and on 1-minute bars once per (day, time) and derive every SL from the same minute path.
- A stock's daily range and lot size change by expiry; ATM must use the stock's own strike step and the point-in-time lot.
- SL columns at or above where the stop never fires repeat the same number, as in the screenshots; that is correct, not a bug.
- Data after 2026-08-25 for stocks is missing until BL-038 runs.

## Open questions

- Which entry times for stocks (the index grid has 09:16, then every 30 minutes to 14:45)?
- Does the owner want the ₹ P&L per lot or per fixed-quantity?

## Log

- 2026-10-11 — answers: Phase 1 first builds the plain ATM short straddle with no stop loss, held to the close (15:20); NIFTY and SENSEX use weekly expiry, other indices and stocks monthly only.
- 2026-10-11 — correction: no separate "No SL" baseline, the grid is the SL columns 10-100; exit 15:30 (replaces 15:20). Phase 1 data decisions: stocks have no spot bars, no strike step and mostly no lot size in the lake, so the ATM is the strike with the smallest |CE - PE| at the entry minute (put-call parity), the step comes from the chain's strike spacing, and stock P&L is stored in points per share (indices in rupees per lot at the current lot size, as the legwise engine's `lot_sizing: current`).
- 2026-10-11 — created from the owner's request and three AlgoTest screenshots. Owner answers: cell is a short ATM straddle, 1 lot, per-leg SL as % of premium; all three views; stock picker plus week-of-expiry filter; Correlation separate, default three strategies with a multiselect.
- 2026-10-11 — built: `heatmap/` package, `obt heatmap`, `/legwise/heatmap*`, Options Lab › Heatmap as the default tab, Correlation on three strategies with a multiselect, Guide page, grids built for every index and stock in the lake, nightly update inside `obt daily` (indices; stocks follow BL-038's pulls through `obt heatmap build --stocks`).

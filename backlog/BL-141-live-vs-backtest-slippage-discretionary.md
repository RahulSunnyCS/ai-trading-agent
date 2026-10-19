# BL-141 — Live vs backtest: each day's slippage on AlgoTest and Quantiply, and the owner's discretionary trades

| | |
|---|---|
| **Priority** | P1 — real money runs on these picks every day; how far live results drift from the backtest decides whether the backtest can be trusted |
| **Status** | Planned — capture timing answered 2026-10-19 |
| **Type** | feature (Phase 4 is research) |
| **Area** | broker-login + options + dashboard |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 / BL-139 (the tool's strategies and their ledgers), BL-140 (which list runs where), BL-093 / BL-026 (contract notes, the realised record) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner, 2026-10-19:
- Each evening, before the tool deletes the day's strategies, go to AlgoTest and Quantiply and compare their results with our backtest. The difference is slippage, which can be tracked as a percentage and used going forward.
- "I might add one trade in between": trades the owner adds by hand beside the tool's picks.
  - The tool should leave them alone.
  - It should track them in the UI as **discretionary trades**, with their impact.

Today nothing reads the live results. Each evening the uploaders delete the day's finished strategies, and with them the platforms' per-strategy P&L. The engine's paper results per variant and day are in the rotation results, and the Rotation page shows them.

## Answers (owner, 2026-10-19)

| Question | Answer |
|---|---|
| When to read live results | **A separate job at 15:40**. Every position is squared off by then (exits 15:14–15:28). It runs before the 16:40 / 16:45 jobs delete anything, so a failed evening run loses nothing |

## Goal

- Every trading day at 15:40, for each platform + broker row (BL-140), the tool records:
  - each strategy that ran, with live P&L, multiplier, entry and exit fills where the platform shows them;
  - whether the tool made it (in its ledger) or not (**discretionary**).
- For each tool strategy, live is compared with the engine's paper result for that variant and day:
  - **slippage ₹ per lot** = live P&L per lot − paper P&L per lot, after the same costs;
  - **slippage %** = the gap as a share of the entry premium, where fills are known.
- At 16:00 the owner's Telegram result carries the day's slippage, signed (+ live beat paper, − it lost to paper), per platform and list. It goes to the owner only.
- The dashboard shows each day and the running totals: tool P&L, discretionary P&L, total, and slippage per platform, list and strategy shape.

## Out of scope

- Changing the picks because of the live results.
- Putting slippage into the backtests automatically: that is Phase 4, behind the research gate.

## Plan

### Phase 1 — Capture what the platforms show (with the owner)
- **Tasks:**
  - **Quantiply:** `/algos/day-wise` already carries `pnl` and `status` per algo. Capture, in the browser as for BL-139:
    - the positions and orders calls behind an algo (entry and exit prices, quantities);
    - the client-wise P&L.
  - **AlgoTest:** the /live cards show ₹ per deployed strategy, with cut names. Look for the JSON call behind them, and for the order book or trade history page (fills).
  - Write the contracts down in `docs/algotest-execution.md`, with fixtures and secrets removed.
- **Done when:** both platforms' per-strategy P&L and fills can be read for a finished day.

### Phase 2 — The 15:40 capture job
- **Tasks:**
  - Add a job `live-capture` at 15:40 on trading days, with retries until 16:30.
  - Log in to each enabled platform + broker row (BL-140) and read every strategy listed for today, whether the tool's or not.
  - Write `TRADING_DATA_ROOT/rotation/live/<day>.jsonl`, one row per strategy:
    - platform, broker, name, variant (if the tool's), multiplier;
    - live ₹, and fills where known;
    - `source: tool | discretionary`.
  - Re-running the job for a day replaces that day's file; nothing else is ever changed.
  - The tool's evening jobs check that the capture for today exists before deleting. If it does not, they delete nothing and alert.
- **Done when:** a day's file lists every strategy that ran, tool and discretionary, with live P&L that matches the platform's screen.

### Phase 3 — Compare and show
- **Tasks:**
  - `obt rotation live-compare [--day]` puts each tool row beside the engine's paper result for that variant and day.
    - Compare per lot: live ÷ multiplier, against paper at 1 lot after the same costs.
    - Report slippage ₹ per lot and % of entry premium.
  - Discretionary rows are summed apart. "With and without discretionary" shows their impact on the day and on the running total.
  - Copies the owner runs on purpose (for example two copies of a 09:17 pick) are visible as multiplier or count, not as slippage.
  - **Dashboard:** a card on the Rotation page, or a "Live vs paper" page, showing:
    - each day: tool live, paper, gap, discretionary;
    - a running chart;
    - slippage by platform, list and shape.
  - The Guide page explains slippage and discretionary trades.
  - **Telegram, every day at 16:00, in the owner's own message only** (never the friends' group): the day's slippage, signed. For each platform + list:
    - live ₹ vs paper ₹;
    - slippage as **+₹ / −₹** and %, where + means live did better than paper;
    - the discretionary P&L on its own line.
    It goes in the existing 16:00 result message (`obt rotation result`, the owner's copy) as a few lines after today's summary. A day whose capture is missing says "live not captured".
- **Done when:** a week of days is shown and the numbers reconcile with the platforms and with the contract notes, which are the ground truth.

### Phase 4 — Slippage into the backtests (research; pre-register first)
- **Tasks:**
  - After 20 forward days, estimate slippage per shape (sell vs buy, entry time band), with a 90% interval.
  - Pre-register (`backlog/_TEMPLATE.md` Phase 0):
    - the rule for setting `execution.slippage_pct` per shape;
    - the check that the picks' ranking is unchanged or better with it.
  - Per the research gate, red-team it for look-ahead: only days before the decision are used.
- **Done when:** the owner accepts a slippage value per shape, or the item records that slippage is too noisy to use yet.

## Risks

- **Pre-run losses:** the evening jobs delete the day's strategies, and the platform's P&L with them. Phase 2 makes them wait for the capture.
- **Cut names on AlgoTest /live cards:** match by the tool's ledger and the full name from the JSON call, not by the card text.
- **Multipliers and partial fills:** compare per lot, and flag a strategy whose fills do not match its multiplier.
- **Discretionary trades outside these platforms** (placed directly at the broker) are not seen here. Contract notes (BL-093) cover them later.

## Open questions

- Should a discretionary trade be compared with anything? Proposed: no; it is shown with its own P&L only.

## Log

- 2026-10-19 — Owner: report the slippage every day, signed (positive or negative), on Telegram at 16:00 with the day's summary, to the owner only.
- 2026-10-19 — Created from the owner's request. Capture timing answered: a separate 15:40 job, before the evening deletes.

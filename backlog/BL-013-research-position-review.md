# BL-013 — Research-position review: decide which of five measurement upgrades are required

| | |
|---|---|
| **Priority** | P1 — each candidate either turns calendar time into evidence or protects an asset the evidence depends on; this activity decides which, before any of them is built |
| **Status** | Planned |
| **Type** | research |
| **Area** | cross-cutting (momentum, options, trading-data, infra) |
| **Created** | 2026-10-05 |
| **Depends on** | Reads BL-001, BL-009, BL-010, BL-012 and TODO 3.3 / 3.10 for what already exists; builds nothing until the decision step is done |
| **TODO.md row** | — (filled in when started) |

## Context

On 2026-10-05 the owner restated the project's purpose: automate every piece of market
analysis currently done by hand so backtests and signals are produced without emotion, with
no intention of building an execution platform like Quantiply or Tradetron. Analysis first:
momentum backtesting now, options backtesting as the 1-minute data accumulates.

A review session read `TODO.md`, the backlog and both backtesting packages and agreed with
that approach, with one caution and five candidate upgrades. The owner asked for the five to
be added **as a single activity whose first job is to decide which are actually required**,
rather than committing to all five. This item is that activity.

### The caution (not a candidate — already covered)

BL-010 reports that the 55–63% momentum CAGR rests on hindsight universes (F1–F3) and a
selection rule that does not persist out of sample (F4), and that the Friday signal is computed
with different defaults from the backtest (F11, E9). Nothing in this item is worth doing before
BL-010 Phase 1 and the engine bugs E1–E3 land; the candidates below are the layer that sits on
top of trusted numbers, not a substitute for them.

### Where the project stands

```
Data ──► Engine ──► Evaluation ──► Forward ledger ──► GATE (TODO 3.3) ──► Execution (AlgoTest)
 ✔         ✔          partial         missing
```

### The five candidates

| # | Candidate | What exists today | Gap |
|---|---|---|---|
| C1 | **Forward shadow ledger** — every Friday, freeze what the momentum system would have bought (names, prices, costs, tax) into an append-only table; reconcile a week later against realised prices; record separately what the owner actually did by hand | `momentum_signals` stores the weekly signal; `tracking.py` measures index-vs-ETF execution drift; TODO 3.3.3 reconciles options paper vs realised P&L | No frozen "would-have-done" portfolio, no weekly reconciliation, no system-vs-owner comparison. Forward out-of-sample is the only evidence that no amount of CSCV/DSR can fake |
| C2 | **Protect the irreplaceable 1-minute dataset** — unattended evening collection, a Telegram alert when a session is missing by 20:00 IST, scheduled monthly backup | Fyers option bars vanish when contracts expire (TODO 3.10.2: "a missed expiry day is lost for good"); collection needs a daily manual `mbt login`; `packages/broker-login` has a headless `fyers-token` script; `tdata backup` exists but is manual; BL-012 is the scheduler home | Collection depends on a human remembering every evening; 30 Sep 2026 is already missing; nothing alerts on a missed session |
| C3 | **Automatic trial counting** — every backtest run through `mbt`/`obt` CLI, FastAPI or MCP increments a per-hypothesis trial counter in the trading-data registry; PBO and deflated Sharpe read that counter | BL-010 F8: `final.py`'s `n_trials` is typed by hand (20,866/22,000) against ~44.6k logged runs; F12: run ids carry no data snapshot; `engine/registry.py` already logs options runs; `obt-mcp` exposes `propose_strategy`/`run_backtest`/`check_overfit` | The overfitting guard cannot see every trial burned, so an agentic propose→run→check loop is unsafe today. This is the one candidate that compounds toward the owner's applied-AI trajectory (eval harnesses and agent guardrails) |
| C4 | **Slippage as a kill criterion for option sellers** — report every legwise result at three fill assumptions (touch, worst-of-bar, worst-of-bar + fixed tick); an edge that survives only at touch price is dead before vendor data is bought | `legwise/schema.py` has a single `slippage_pct` (default 0); `engine/fills.py` in the DSL engine has `worst_of_bar`; BL-009 Phase 1 compares against AlgoTest's own fills; TODO 3.3.4 feeds real fills in later | Short-option SL fills on 1-minute bars are systematically optimistic (gap through SL, spread widening at 09:17 and expiry afternoons); no result today shows the edge's sensitivity to the fill assumption |
| C5 | **One book, not many strategies** — daily P&L of the momentum book and the options book on one timeline; correlation conditioned on the four regime tags; the worst five days of the combined book | BL-009 item 3 asks for combined drawdown across the intraday options strategies only; regime tags exist (`RANGING`/`TRENDING_STRONG`/`VOLATILE_REVERTING`/`EVENT_DAY`); Options Lab joins strategy × day type | Weekly equity momentum and intraday short volatility are both long calm markets; nothing shows their combined worst day, which is the number that sizes capital between them |

### First-pass cost and value (to be confirmed in Phase 1)

| # | Cost | Removes | Compounds toward the AI track |
|---|---|---|---|
| C1 | Days | Backtest-only evidence | Partly (eval data) |
| C2 | Days | Silent data loss | No |
| C3 | ~1 week | F8, F12, unsafe agent loops | Strongly |
| C4 | Days | Optimistic seller edges | No |
| C5 | 1–2 weeks | Hidden regime concentration | Partly |

## Goal

- Each of C1–C5 has a recorded decision: **Required** (with a priority and a home — a new BL item,
  a phase of an existing one, or a `TODO.md` row), **Deferred** (with the trigger that would
  revive it), or **Dropped** (with the reason).
- Every decision is grounded in a cheap measurement from the repo, not an argument: e.g. how
  many trials were actually logged vs typed (C3), how many 1-minute sessions have been missed
  since 2026-09-23 (C2), how much a legwise strategy's net ₹/lot moves between touch and
  worst-of-bar fills on the six collected days (C4).
- The required items are sequenced against BL-010 Phase 1 so none of them lands on untrusted
  numbers.

## Out of scope

- Building any of the five here. This item ends at the decision; each Required candidate is
  then built under its own BL item or an existing one's phase.
- Re-opening the approach itself (analysis first, no execution platform, AlgoTest gate for
  eventual execution). That is settled.
- Anything already planned in BL-001, BL-009, BL-010 or BL-012 — where a candidate overlaps,
  the decision says "goes into BL-NNN Phase N", it does not duplicate the plan.

## Plan

### Phase 1 — Measure before deciding
- **Tasks:** for each candidate, run the one read-only check that settles its value:
  - C1: list the Friday signals in `momentum_signals` since the first one; for each, compute what
    the following week returned at the backtest's cost model vs what the saved favourite's
    backtest predicted for that week. Count how many weeks of forward evidence already exist
    unused.
  - C2: list collected sessions in `~/TradingData` (`tdata status`) against the NSE trading
    calendar since 2026-09-23; count missed sessions and expiry days lost. Confirm whether
    `packages/broker-login`'s `fyers-token` path can mint a token headlessly from the laptop.
  - C3: count logged runs per search round in the trading-data catalog vs the `n_trials`
    values typed into `final.py`/`round7_criteria.json`; recompute the deflated Sharpe of the
    current favourites with the logged count.
  - C4: run the four `strategies/legwise/*.yaml` over the six collected days at
    `slippage_pct ∈ {0, 0.5, 1.0}` and, if cheap to add, a worst-of-bar fill; tabulate net
    ₹/lot per strategy per assumption.
  - C5: join the momentum backtest's daily equity and the legwise daily net on the overlapping
    days (only ~6 so far); note how many days of overlap would be needed for the correlation to
    mean anything, and whether the Options Lab regime labels can be reused as the conditioning
    key.
- **Deliverables:** one short table per candidate in this file's Log, each with the number
  that was measured and the query or command that produced it.
- **Done when:** every candidate has a measured number beside it, or a written reason why it
  cannot be measured yet (C5 likely).

### Phase 2 — Decide and route
- **Tasks:** with the owner, mark each candidate Required / Deferred / Dropped using the
  measurements. For each Required one, choose its home: new BL item (copy `_TEMPLATE.md`),
  a phase appended to BL-001 / BL-009 / BL-010 / BL-012, or a `TODO.md` row if it is small
  enough to just do. Sequence them explicitly against BL-010 Phase 1 ("after" unless the
  measurement shows it is independent of the momentum numbers, as C2 and C4 probably are).
- **Deliverables:** the decision table below filled in; new BL items created and indexed;
  existing items' plans amended in the same commit; this item moved to Done in `INDEX.md`.
- **Done when:** the decision table has no empty cells and every Required row links to the
  file that now owns it.

#### Decision table (filled in Phase 2)

| # | Decision | Priority | Home | Reason / trigger |
|---|---|---|---|---|
| C1 | | | | |
| C2 | | | | |
| C3 | | | | |
| C4 | | | | |
| C5 | | | | |

## Risks

- **Deciding by argument instead of measurement.** All five sound reasonable; that is exactly
  why Phase 1 insists on a number first. If a candidate cannot be measured yet, say so and
  defer it rather than approving it on narrative.
- **Scope creep into building.** C4's "if cheap to add, a worst-of-bar fill" is the obvious
  leak. Cap Phase 1 at read-only runs and existing parameters; anything needing engine code
  becomes part of the Required item's own plan.
- **Landing on untrusted numbers.** C1 and C5 consume the momentum engine's output. If they are
  built before BL-010 Phase 1, the forward ledger freezes F11's wrong defaults as "what the
  system would have done". The sequencing rule in Phase 2 exists for this.
- **C2 is time-critical in a way the others are not.** Every missed expiry day is permanently
  lost. If Phase 1 finds more than one missed session, C2 should be pulled forward into BL-012
  immediately, without waiting for the rest of Phase 2.

## Open questions

1. C1: should the owner's own weekly decisions be recorded in the ledger too (system-vs-owner
   comparison), or only the system's? Recording the owner's requires a weekly habit; is that
   acceptable?
2. C2: is the laptop acceptable as the machine that mints the headless Fyers token each
   evening (it already dispatches the broker login at 08:00), or must the token come from the
   dashboard login?
3. C3: one counter per *hypothesis* needs a definition of hypothesis — per search round, per
   strategy family, or per owner-named question? Who names it?
4. C4: which fill assumption should be the *default* in Options Lab once several are reported —
   the conservative one, or AlgoTest's convention for comparability with BL-009 Phase 1?
5. C5: is a combined book even the intended end state, or will momentum and options be sized
   independently? If independent, C5 is Dropped.

## Log

- 2026-10-05 — created from the research-position review; five candidates recorded with the
  existing-vs-gap analysis; owner asked that the activity itself decide which are required.

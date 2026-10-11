# BL-092 — Portfolio MTM stop-loss on the Rotation page (lists, replay, curves, drawdowns)

| | |
|---|---|
| **Priority** | P1 — the owner trades the lists with a portfolio stop (about ₹10k on 6 lots); the Rotation log today shows losses that book could not reach |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options / dashboard |
| **Created** | 2026-10-11 |
| **Depends on** | BL-058 (the Rotation page and its daily log), BL-055 (the portfolio-stop rule and its numbers) |
| **TODO.md row** | — (filled in when started) |

## Context

On the Daily log, Fri 11 Sep 2026 shows list A at −₹2,998 per lot-day: about −₹18,000 for the
list's 6 lots (3 picks × 2 lots). The owner runs the basket with a portfolio stop of about ₹10k,
so the real loss that day was capped near ₹10k, plus how far the price moved past the level before
the stop filled. Nothing in the repo models that stop:

- Every strategy carries only its own **overall stop, per lot**. Across the 298 rotation variants
  and the 5 `strategies/legwise/` files: ₹2,500 for Widesl and the closest-premium families
  (wide, p80, p100, p250, p320), ₹3,000 for Dir and Dir ITM1, ₹2,000 for Buy. A 6-lot list can
  lose about 2 × (2,500 + 2,500 + 3,000) = ₹16,000 on these alone, plus overshoot, before any
  of them stops.
- A list's day in `rotation/daylog.py::list_block` is `lots_per × Σ one-lot gross`: no combined
  intraday path, so no portfolio stop can be applied to it.
- BL-058 says the portfolio stop levels "need a portfolio mark-to-market series that does not
  exist in the UI yet"; `DayForensics` replays one strategy only.
- BL-055 tested the rule on the NIFTY benchmark mixes (₹8k / ₹10k / ₹12.5k, 2024-10 → 2026-10).
  Result: inconclusive. At ₹10k: B2 total +9.2%, drawdown −21%; B1 total −6.8%. Worst day:
  B2 −₹19,167 → −₹15,941, because the stop fills at the minute's close.

What already exists: `legwise/engine.py` builds each strategy's MTM at every simulated minute
(`DayResult.mtm`), and its own overall stop closes every open leg at that minute's close. The
engine is deterministic, so a day can be replayed instead of storing curves. BL-055 added the
same strategies' curves together with the same rule.

## Owner's decisions

- **2026-10-11 — the control:** the portfolio stop is a number the owner types, in rupees. Empty
  means no portfolio stop, and so does 0 or anything below 0. No preset levels, no on/off switch
  next to it.

## Goal

With a portfolio stop typed in, the Rotation page shows what each list's book did under that stop.
That covers every day's figure, a replay of the basket's combined MTM, the equity curve and the
drawdowns. With the field empty, everything is exactly as today. The stored variant results and the
registered read-out are never changed.

## Out of scope

- Changing a pick, a list, the stored variant-day results (`rotation/store.py`) or the journal.
- The registered 60-day read-out (`rotation readout`, the read-out banner and the verdict). They
  stay on their registered basis with no portfolio stop, and say so.
- Choosing a stop level. The owner types the level they use; the page does not search, rank or
  recommend levels (see Risks).
- Placing or enforcing anything. The real stop lives in AlgoTest; this repo places no orders.
- Portfolio target and trailing portfolio stop (open question 5).

## Plan

### Phase 1 — The shared calculation
- **Tasks:**
  - A module, `rotation/portfolio.py` (or `legwise/portfolio.py` if the Options Lab reuses it):
    `book_day(members, day, stop_inr)`. `members` is a list of (strategy, lots). It replays each
    member with `simulate_day` and builds each member's per-minute P&L: 0 before it enters, its
    MTM while open, its realised P&L after it exits. It scales each by its lots and sums them.
  - The rule, as the engine's overall stop and BL-055: at the first minute the combined MTM is
    ≤ −stop, every member exits at that minute's close. A member that has not entered yet (e.g.
    Dir 09:24, Buy 09:35) does not enter that day. Stop empty, 0 or below → no portfolio stop.
  - Output: the combined curve, each member's curve, the stop minute (or none), the book's gross
    with and without the stop, and each member's P&L at the stop.
  - A list-day whose picks lack data, or a pick still waiting, gets no figure, the same as
    `list_block` today.
- **Deliverables:** the module and its unit tests.
- **Done when:**
  1. A book of one strategy, with the stop set to its own overall stop × lots, reproduces the
     engine's result.
  2. BL-055's totals for B1 / B2 / B3 at ₹8k / ₹10k / ₹12.5k are reproduced to the rupee.
  3. With the stop empty, every list-day in the reconstructed history equals today's
     `list_block` gross.

### Phase 2 — API and proxy
- **Tasks:**
  - `GET /legwise/rotation/portfolio/day?day=&list=&stop=`: one list's basket replayed (combined
    and member curves, stop line, stop minute, with and without).
  - `GET /legwise/rotation/portfolio/days?from=&to=&stop=`: per day and list, the gross with the
    stop and the stop minute.
  - An in-process cache keyed on (day, basket, the members' file hashes, stop); identical baskets
    across lists are replayed once.
  - Fastify proxy routes and their tests, as the other `/legwise/rotation/*` routes.
- **Deliverables:** the routes, the proxy and the tests. The time for the full history (114 days ×
  4 lists, cold and warm) goes in the Log.
- **Done when:** the routes return Phase 1's numbers, and a stop of empty, 0 or −5 returns the
  no-stop figures.

### Phase 3 — Daily log: days table, calendar and "Replay the list"
- **Tasks:**
  - A "Portfolio stop ₹" `NumberField` on the Rotation page, held at page level so one value
    drives every widget below. It is kept in the URL (`?pfstop=`) and remembered per viewer.
  - Days table and calendar: with a stop set, each list's figure is the stopped one, with a
    "PF stop 11:42" flag on days it fired. Hover shows both figures and the lots. The calendar
    shading follows.
  - The day drawer gets "Replay the list" beside the per-pick replay: the basket's combined MTM,
    the −stop line, a marker at the stop minute, each pick as a thin line, and the end value with
    and without the stop. It reuses the DayForensics chart helpers.
  - Guide: `rotation-daily-log.md` and a glossary entry "Portfolio stop", in the same commit.
- **Deliverables:** the components, tests and Guide pages.
- **Done when:** on Fri 11 Sep 2026 with 10000 typed, list A shows the stopped total and its stop
  minute, and the replay's end value equals the table's figure. With the field empty, the page is
  unchanged.

### Phase 4 — Hero curve, headline and Drawdowns
- **Tasks:**
  - Hero chart: with a stop set, each list's curve uses the stopped figures, with the no-stop
    curve kept as a faint line.
  - Headline strip: figures follow the stop and carry a "with ₹X portfolio stop" label.
  - Drawdowns widget: drawdown with and without the stop, side by side.
  - The read-out banner and verdict are untouched, labelled "registered basis, no portfolio stop".
  - The Guide pages for the three widgets.
- **Done when:** the three widgets agree with Phase 2's day figures, and the read-out shows the
  same numbers whatever is typed.

### Phase 5 — Later (only if asked)
- The fixed base (3 lots) and the Shadow scoreboard.
- An Options Lab "book" of the `strategies/legwise/` files on Daily results.
- Computing the figure nightly in `rotation update` (a scheduler job) instead of on demand.
- A Telegram line in the evening summary.

## Risks

- **Choosing a level on the history:** typing several levels and keeping the best is a search on
  in-sample data. BL-055 was inconclusive and showed the stop is not free (whipsaw days). The page
  labels every stopped figure as in-sample, offers no level comparison, and the read-out never uses
  it. A study of levels would be its own pre-registered research item.
- **Overshoot:** the fill is the minute's close, so a fast day ends past the level, as in BL-055.
  AlgoTest checks the stop on live prices, so its fills land closer to the level; the figures here
  are the conservative side.
- **Speed:** each figure is up to 4 replays per list-day. The cache and de-duplicating identical
  baskets should keep the full history to a few seconds; if not, a derived file under
  `TRADING_DATA_ROOT` (a new store, never the variant results) is the fallback.
- **Repaired days:** a day repaired from Fyers after the nightly update (BL-079) replays on the new
  bars while the stored result keeps the old ones. The existing "replayed gross differs from the
  stored" notice (`RotationReplayStatus`) covers the list replay too.

## Open questions

Pending — discuss when this item is picked up. Claude's proposal is beside each one; none is a
decision.

1. **One amount for every list, whatever its lots?** A list is 6 lots, 8 with the Buy add-on.
   *Proposal:* the typed amount applies to the whole book as typed, with the lot count shown next
   to it.
2. **After the stop:** does the AlgoTest portfolio stop square off everything and block strategies
   that have not entered yet that day? *Proposal:* yes, as the engine's overall stop and BL-055.
3. **Per-strategy stops at 2 lots:** is each strategy's own stop per lot (₹2,500 → ₹5,000 at
   2 lots), as the log assumes? *Proposal:* keep per lot, as now.
4. **Fill:** the minute's close (can overshoot) or exactly at the level? *Proposal:* the close.
5. **Portfolio target or trailing stop too?** *Proposal:* stop only for now.
6. **When it is computed:** on demand with a cache, or nightly in `rotation update` (a scheduler
   job)? *Proposal:* on demand first.
7. **Default value:** empty (no stop) for every viewer, or the owner's 10000? *Proposal:* empty,
   so the page shows the registered basis unless a level is typed.

## Log

- 2026-10-11 — created from the owner's question about Fri 11 Sep (list A about −₹18k on 6 lots
  against a ₹10k portfolio stop). Owner's decision recorded: the stop is a typed amount; empty,
  0 or below = none. Widgets in scope: Daily log (table, calendar, list replay), hero and
  headline, Drawdowns. Left alone: Why this pick, Pulse, Regime, Drift, Rank IC, Matrix and
  Correlation, which rank single strategies; the stop does not change a pick.

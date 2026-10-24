# BL-095 — Portfolio MTM stop-loss on the Rotation page (lists, replay, curves, drawdowns)

| | |
|---|---|
| **Priority** | P1 — the owner trades the lists with a portfolio stop (about ₹10k on 6 lots); the Rotation log today shows losses that book could not reach |
| **Status** | In progress (Phases 1–4 built and merged, #190; trailing modes to confirm against AlgoTest) |
| **Type** | feature |
| **Area** | options / dashboard |
| **Created** | 2026-10-11 |
| **Depends on** | BL-058 (the Rotation page and its daily log), BL-055 (the portfolio-stop rule and its numbers) |
| **TODO.md row** | 3.27 |

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
- **2026-10-11 — answers to the open questions:**
  1. The typed amount applies to the whole book as typed; the owner changes it when a list's lots
     differ (8 with the Buy add-on).
  2. After the portfolio stop fires, strategies that have not entered yet do not enter that day.
  3. Each strategy keeps its own overall stop, per lot, as the engine already does.
  4. The portfolio stop fills at the minute's close.
  5. A **trailing** portfolio stop is wanted as an option. A portfolio **target** is not.
  6. Computed on demand (with a cache), not in the nightly scheduler job.
  7. The default is **₹10,000**.
- **2026-10-11 — trailing:** the settings open in a pop-up from a "Portfolio stop" button. Three
  trailing modes, as AlgoTest's: **Trail SL** (when profit moves ₹X, the stop moves ₹Y), **Lock
  profit** and **Lock and trail**.

## Goal

The Rotation page shows what each list's book did under a portfolio stop (₹10,000 by default,
editable, with an optional trailing stop). That covers every day's figure, a replay of the
basket's combined MTM, the equity curve and the drawdowns. With the field emptied (or 0 or
below), everything is exactly as today. The stored variant results and the
registered read-out are never changed.

## Out of scope

- Changing a pick, a list, the stored variant-day results (`rotation/store.py`) or the journal.
- The registered 60-day read-out (`rotation readout`, the read-out banner and the verdict). They
  stay on their registered basis with no portfolio stop, and say so.
- Choosing a stop level. The owner types the level they use; the page does not search, rank or
  recommend levels (see Risks).
- Placing or enforcing anything. The real stop lives in AlgoTest; this repo places no orders.
- A portfolio target (owner, 2026-10-11: not required).

## Plan

### Phase 1 — The shared calculation
- **Tasks:**
  - A module, `rotation/portfolio.py` (or `legwise/portfolio.py` if the Options Lab reuses it):
    `book_day(members, day, stop_inr, trail)`. `members` is a list of (strategy, lots). It replays each
    member with `simulate_day` and builds each member's per-minute P&L: 0 before it enters, its
    MTM while open, its realised P&L after it exits. It scales each by its lots and sums them.
  - The rule, as the engine's overall stop and BL-055: at the first minute the combined MTM is
    ≤ the stop level, every member exits at that minute's close. A member that has not entered yet
    (e.g. Dir 09:24, Buy 09:35) does not enter that day. Stop empty, 0 or below → no portfolio stop.
  - Optional trailing, one of AlgoTest's three modes. `best` is the book's highest combined MTM
    so far that day (at minute closes); the level is recomputed each minute and never moves down:
    - **Trail SL [X, Y]:** level = −stop + Y × ⌊best / X⌋ (from the first rupee of profit).
      Needs a stop; without one it does nothing.
    - **Lock profit [A, B]** (B ≤ A): once best ≥ A, level = max(level, +B).
    - **Lock and trail [A, B, X, Y]:** once best ≥ A, level = max(level, B + Y × ⌊(best − A) / X⌋).
    - Lock and Lock and trail also work with the stop cleared (a profit lock with no stop
      below). Any field empty, 0 or below → that mode is off.
    - The exit is the same as the stop: every member closes at the first minute's close at or
      below the level; nothing enters afterwards.
  - Output: the combined curve, the stop level at each minute (it moves when trailing), each
    member's curve, the stop minute (or none) and whether it was the trailed level, the book's
    gross with and without the stop, and each member's P&L at the stop.
  - A list-day whose picks lack data, or a pick still waiting, gets no figure, the same as
    `list_block` today.
- **Deliverables:** the module and its unit tests.
- **Done when:**
  1. A book of one strategy, with the stop set to its own overall stop × lots, reproduces the
     engine's result.
  2. BL-055's totals for B1 / B2 / B3 at ₹8k / ₹10k / ₹12.5k are reproduced to the rupee.
  3. With the stop empty, every list-day in the reconstructed history equals today's
     `list_block` gross.
  4. Each trailing mode on synthetic curves: Trail SL — a book that rises ₹3X then falls stops at
     −stop + 3Y, one that never rises stops at −stop; Lock — a book that touches ₹A then falls
     exits at +B, one that peaks below A is unaffected; Lock and trail — A reached then +2X more
     exits at B + 2Y. In every mode the level never moves down.

### Phase 2 — API and proxy
- **Tasks:**
  - `GET /legwise/rotation/portfolio/day?day=&list=&stop=&trail=…`: one list's basket replayed
    (combined and member curves, the stop level per minute, stop minute, with and without).
  - `GET /legwise/rotation/portfolio/days?from=&to=&stop=&trail=…`: per day and list, the gross
    with the stop and the stop minute.
  - `trail` is one of `sl:X,Y`, `lock:A,B`, `locktrail:A,B,X,Y`; absent = none. A malformed value
    is a 422, never silently ignored.
  - An in-process cache keyed on (day, basket, the members' file hashes, stop, trail); identical baskets
    across lists are replayed once.
  - Fastify proxy routes and their tests, as the other `/legwise/rotation/*` routes.
- **Deliverables:** the routes, the proxy and the tests. The time for the full history (114 days ×
  4 lists, cold and warm) goes in the Log.
- **Done when:** the routes return Phase 1's numbers, and a stop of empty, 0 or −5 returns the
  no-stop figures.

### Phase 3 — Daily log: days table, calendar and "Replay the list"
- **Tasks:**
  - A **"Portfolio stop" button** in the Rotation page's run bar, showing the current setting
    ("Portfolio stop ₹10,000 · trail 1,000 → 500", or "Portfolio stop off"). Clicking it opens a
    **pop-up** (a new `components/ui/Dialog.tsx`, since `components/ui` has no dialog yet; the
    analytics pattern's settings `Drawer` is the fallback if a dialog does not fit) with:
    - **Stop loss ₹** — a `NumberField`, **10000 by default**; cleared, 0 or below = no stop.
    - **Trailing** — `RadioCards`: None (default) / Trail SL / Lock profit / Lock and trail,
      each showing only its own fields: Trail SL "every ₹X of profit, move the stop ₹Y"; Lock
      profit "when profit reaches ₹A, lock ₹B"; Lock and trail "when profit reaches ₹A, lock
      ₹B, then every ₹X more, raise it ₹Y". A one-line plain-English summary under the fields.
    - Apply / Reset to default. Field checks inline (B below A, Y not above X, positive amounts).
  - One setting drives every widget below it; it is kept in the URL (`?pfstop=&pftrail=`) and
    remembered per viewer.
  - Days table and calendar: with a stop set, each list's figure is the stopped one, with a
    "PF stop 11:42" flag on days it fired. Hover shows both figures and the lots. The calendar
    shading follows.
  - The day drawer gets "Replay the list" beside the per-pick replay: the basket's combined MTM,
    the stop level (a step line when trailing), a marker at the stop minute, each pick as a thin line, and the end value with
    and without the stop. It reuses the DayForensics chart helpers.
  - Guide: `rotation-daily-log.md` and a glossary entry "Portfolio stop", in the same commit.
- **Deliverables:** the components, tests and Guide pages.
- **Done when:** on Fri 11 Sep 2026 at the default 10000, list A shows the stopped total and its
  stop minute, and the replay's end value equals the table's figure. With the field cleared, the
  page shows today's figures.

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

- **Choosing a level on the history:** typing several levels (or trail numbers) and keeping the
  best is a search on in-sample data. BL-055 was inconclusive and showed the stop is not free (whipsaw days). The page
  labels every stopped figure as in-sample, offers no level comparison, and the read-out never uses
  it. A study of levels would be its own pre-registered research item.
- **Default on:** with ₹10,000 as the default, the page opens on stopped figures while the
  read-out stays on its registered basis. Every stopped figure carries "with ₹X portfolio stop",
  and the read-out says "no portfolio stop", so the two are never read as one number.
- **Trailing semantics:** the three modes are written from AlgoTest's wording (Phase 1). If the
  owner's AlgoTest screen behaves differently, the rule is changed here first (open question 1),
  before any figure is shown.
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
decision. (Questions 1–7 of 2026-10-11 are answered: see Owner's decisions.)

1. **Match AlgoTest exactly:** when this is started, compare the three modes with the owner's
   AlgoTest portfolio settings screen (a screenshot), field by field, before Phase 1 is written.
   In particular: does Trail SL count profit from 0 or from the first lock, and may Lock / Lock and
   trail be used with the stop amount cleared? *Proposal:* from 0, and yes (a profit lock without
   a stop), as written in Phase 1.

## Log

- 2026-10-11 — created from the owner's question about Fri 11 Sep (list A about −₹18k on 6 lots
  against a ₹10k portfolio stop). Owner's decision recorded: the stop is a typed amount; empty,
  0 or below = none. Widgets in scope: Daily log (table, calendar, list replay), hero and
  headline, Drawdowns. Left alone: Why this pick, Pulse, Regime, Drift, Rank IC, Matrix and
  Correlation, which rank single strategies; the stop does not change a pick.
- 2026-10-11 — owner answered the seven open questions: the typed amount applies as typed (the
  owner changes it per book); after the stop nothing else enters; per-strategy stops stay per lot;
  minute-close fills; a trailing portfolio stop wanted, no portfolio target; on demand; default
  ₹10,000. Plan updated (trailing in Phases 1–3). New open questions: the trailing form and start.
- 2026-10-11 — owner on trailing: the settings open in a pop-up from a "Portfolio stop" button,
  with the stop amount and three trailing modes, AlgoTest's: Trail SL (every ₹X of profit moves
  the stop ₹Y), Lock profit and Lock and trail. Both trailing questions closed by that; plan
  updated (rule in Phase 1, `trail=` in Phase 2, the pop-up in Phase 3).
- 2026-10-11 — started. Phase 1 built (`rotation/portfolio.py`, `tests/unit/test_rotation_portfolio.py`,
  `research/bl095/`). Done-when checks: (1) a book of one strategy with the stop at its own overall
  stop reproduces the engine's result (unit test); (2) BL-055's 12 totals and max drawdowns
  (B1 / B2 / B3 × none / 8k / 10k / 12.5k) are reproduced to the rupee from its curves
  (`research/bl095/reproduce_bl055.py`, 489 days); (3) with no stop, 80 reconstructed list-days
  (24 Aug – 30 Sep 2026, lists A / B / C / REF) replay to the log's gross (`check_log_gross.py`, 0 differ); (4) each
  trailing mode on synthetic paths, and the level never moves down (unit tests). The trailing rules
  are written from AlgoTest's wording; open question 1 (compare with the owner's AlgoTest screen)
  is still to do before any figure is shown. First look at the data, not a result: at ₹10,000 the
  stop fires on 18 of the 80 list-days; Fri 11 Sep 2026 A −₹17,986 → −₹10,361 at 11:14, and Thu
  27 Aug 2026 A −₹890 → −₹10,580 at 15:24 (a stop that cost a day that ended near flat).
- 2026-10-11 — Phase 2 built: `rotation/portfolio_log.py`, `api/rotation_portfolio_routes.py`
  (`GET /legwise/rotation/portfolio/day`, `/days`), the Fastify proxy and their tests. `stop`
  empty / 0 / below is none and a malformed `trail` is a 422. Timing on the real lake, full
  reconstructed history (116 days, 4 lists): 45 s cold, 1.2 s warm and for any other stop or
  trail (the cache holds the one-lot paths, 561 of them). First look, not a result: at ₹10,000,
  list totals with / without the stop over those 116 days — A 227,085 / 231,305 (fired 23 days),
  B 203,865 / 217,709 (26), C 308,378 / 293,492 (17), REF 221,203 / 216,501 (21), gross,
  in-sample. The stop cuts A and B and adds to C and REF: it is not free (as BL-055 found).
  The 45 s first call is why Phase 3 shows a loading state; a warm-up at API start is Phase 5.
- 2026-10-11 — Phase 3 first part built. The "Portfolio stop" button sits in the Rotation page's
  run bar and opens a pop-up (new `ui/Modal`): stop loss (10,000 by default; empty, 0 or below is
  none) and None / Trail SL / Lock profit / Lock and trail, with a plain-English line and inline
  checks. One setting drives the Days table (stopped figure per lot-day, the log's own struck
  through, a "PF stop 11:14" flag, both totals on hover), the calendar shading and the filters,
  through `overlayBook` so neither component has a second path. `usePolledResource` got an
  `enabled` option (nothing is fetched while the setting changes nothing). Deviations from the plan,
  both small: the setting is kept in this browser (localStorage), not in the URL; and the log's
  own figures stay on screen with a note while the stopped ones are replayed (about 45 s the first
  time). Still to do in Phase 3: "Replay the list" in the day drawer. Tests: 14 + 5 + 6 + 3 new
  dashboard tests, 1,620 dashboard tests pass.
- 2026-10-11 — Phase 3 finished: "Replay the list" in the day drawer (the basket's combined P&L,
  the stop level as a step line when trailing, a marker where it closed, the dotted no-stop line,
  each pick as a thin line; says when the replay without a stop differs from the log).
- 2026-10-11 — Phase 4 built. Drawdowns: `GET /legwise/rotation/drawdowns` takes `stop` / `trail`
  and returns `with_stop` (worst fall, total per lot with and without, days stopped, replay errors)
  and `per_lot_with` / `underwater_with` per day; the widget draws the second line and three
  figures, the episode table and drivers stay registered. Headline and hero: `overlaySummary`
  recomputes cumulative gross, ₹ per lot-day and the two max drawdowns from the stopped days;
  "beats random baskets", the verdict and its intervals stay on the registered basis and a line
  says so. The hero keeps no faint no-stop curve (the plan had one): the registered figures are
  the read-out and the Daily log shows both numbers per day. The forward read-out has no scored
  sessions yet (first entry Mon 12 Oct), so the headline and hero overlay is unit-tested and
  has not been looked at on real data. Still open: compare the three trailing modes with the
  owner's AlgoTest screen (open question 1), and whether the fixed base / Shadow scoreboard
  should follow the stop (Phase 5).
- 2026-10-11 — Real-data look, Drawdowns (list A, P1, 202 sessions, gross, in-sample, ₹10,000 stop,
  no trailing): worst fall −₹11,073 per lot registered, −₹10,467 with the stop; total +₹73,690 per
  lot registered, +₹75,149 with it; the stop closed the book on 40 of 202 days; 20 episodes of at
  least ₹500 either way. A small improvement on this history, not a result: the history is what the
  weights were chosen on and BL-055 found the sign differs by mix. Speed: replaying the whole P1
  window cold takes ~3.5 min (202 days, ~640 pick-days); the replayed paths are now also kept in
  a disposable disk cache (`~/.cache/ai-trading-agent/portfolio-paths`, 4 MB), after which the same
  request takes ~2 s even after an API restart; `obt rotation portfolio-warm` fills it ahead of the
  first view. Nothing is added to the scheduler (not asked); running it nightly after
  `rotation update` is Phase 5.
- 2026-10-11 — PR review fixes. Renumbered from BL-092 (taken by forward-dated themes on main) and the TODO row to 3.27 (3.26 went to BL-091 on main). The setting is now in the URL (`pfstop`, `pftrail`) with localStorage as a fallback read after mount; the path cache stamp covers the reference CSVs, symbol master, VIX bars, `SIZING_DATE` and a `CACHE_VERSION`, in one folder per data root, with one replay per key at a time; a cold `/portfolio/days` or `/drawdowns?stop=` answers within 20 s (202 warming / `with_stop_pending`) and the page asks again, so nothing waits past the proxy's 30 s; a list-day whose replay no longer matches the log keeps the log's figure and is counted; `source` on `/portfolio/day` is a filter; `Trail.text()` no longer uses `:g`.

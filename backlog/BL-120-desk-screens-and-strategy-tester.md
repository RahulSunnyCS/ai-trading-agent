# BL-120 — Desk screens: everything we can see about the live market and the paper trades, and a tester where saying a strategy runs it over history

| | |
|---|---|
| **Priority** | P1 — the owner asked for the screens on 2026-10-18, apart from strategy work |
| **Status** | Planned |
| **Type** | feature |
| **Area** | dashboard, options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-117 (feed Phase 2, the Live page already built on replay, paper desk Phase 4), BL-102 (the Options Lab workspaces), BL-083 (trigger code the tester generalises) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner, 2026-10-18: "Just do the screens. Don't go into strategy for now; make that a separate backlog.
What all things can we actually see? And if I say a strategy, it should be able to test it."

Strategies are [BL-119](BL-119-rule-agents-paper-and-retrospection.md)'s. This item holds **no strategy
content**: it is the screens, and the one mechanism that lets any strategy be stated and tested. The
agents' own logic, the evening post-mortem logic and the live feed are BL-119 and BL-117.

### What exists today (read 2026-10-18)

- **Live** (`/live`, BL-117 Phase 3, built early on replay): spot, India VIX, ATM strike, the rolling and
  the 09:15-held straddle and the legs, for NIFTY or SENSEX, with a day picker and play / pause / speed /
  slider. Replays a collected day until live capture exists. Other tabs in the Live group (Trades, P&L,
  Personalities, Regimes) belong to the frozen engine.
- **Options Lab** (BL-102): Today (rotation lists), Explore data (Heatmap, Matrix, Correlation),
  Build and test (Strategies and baskets, Builder, Runs), Advanced (Regimes).
- **Builder** (Form | YAML): states a strategy as legs with a **clock entry time**, stops, trail, re-entry,
  an option-level range breakout; shows it "in plain words" (`ReadBack`); runs it over collected days
  (`POST /legwise/backtest`) and keeps each run. It cannot say "enter when the index does X".
- **No rule strategy.** The legwise schema has no condition field. The old YAML engine has a condition
  grammar but runs on its own small bar cache (BL-058's UI review hid it for that reason). The MCP
  server's tools (`run_backtest`, `propose_strategy`, ...) drive that old engine, not the legwise one.
- **Event-versus-placebo exists only as research scripts** (`rotation/triggers.py`, `research/bl083/`):
  nobody can state a condition on a screen and get BL-083's table.

## Goal

1. A written inventory of what each screen shows, where its data comes from, and what we cannot show.
2. Screens built in an order that follows the data: those that can run on replay now, then those that wait
   for the live feed or the paper desk, each with a "done when".
3. **A strategy tester:** the owner states a strategy (in words to Claude, in a form, or as a spec), sees it
   read back, and gets a result over the collected history that always sits beside its placebo, its random-
   time control and the charges, with every test counted.

## Out of scope

- Any particular strategy or its research (BL-119); agents, personalities, post-mortem logic (BL-119).
- The live feed itself (BL-117 Phase 2) and the paper desk's engine (BL-117 Phase 4).
- Orders (BL-118). The frozen tabs' content (Trades, P&L, Personalities, Regimes).
- Showing any of it to anyone but the owner; the screens are owner-only like the rotation screens
  (`business.md`).

## What we can see

| # | Screen | What it shows | Data it reads | State |
|---|---|---|---|---|
| S1 | **Live** | Spot, VIX, ATM, rolling and held straddle, legs | collected day now; `live/<day>/` once capture runs | Exists on replay. Left: live reader, 1-minute polling, IV, latency check |
| S2 | **Day strip** (on S1) | Weekday, weekday-DTE, VIX band and change, gap, range so far against the 20-session median, previous session expanded or quiet (BL-110), expiry day, calendar events | lake bars, `days.csv`, a dates CSV | Range and DTE exist on S1; the rest is new, on replay |
| S3 | **Chain** | Strikes around ATM at a chosen minute: CE and PE price, volume, open interest and its change since the open, IV; bid and ask only live | lake option bars (OI from Fyers; Angel carries NFO OI only), derived IV tables (NIFTY, SENSEX) | New, on replay; bid / ask when the feed exists |
| S4 | **Replay a strategy** | Any past day played minute by minute with a strategy's firings, entries, stops and exits drawn on the chart and its MTM beside it | S1's replay plus a tested strategy | New, on replay; the first place the owner sees a strategy "trade" |
| S5 | **Signals** | A log of firings, today and by day, each with the minute's chart: the bars the rule saw, its level lines, the entry minute | the tester's saved strategies, replay or nightly scoring | New |
| S6 | **Paper desk** | Open paper legs per strategy: entry, price, stop and trail level, MTM, today's fills (bar-rule fill beside quote fill) | BL-117 Phase 4 | Waits for the paper desk |
| S7 | **Paper ledger** | Day-by-day P&L per strategy against Clockwork and the placebo band | BL-117 Phase 5 / BL-119 | Waits for forward days |
| S8 | **Review** | Evening post-mortem cards and the counted-tag table | BL-119 Phase 3 | Waits for BL-119 |
| S9 | **Feed and system health** | Source in use, latency, minutes present, gaps, the evening reconcile, the session job, token status | BL-117 Phase 2, scheduler | Waits for capture |
| S10 | **Strategy tester** | State a strategy, read it back, test it, see the verdict beside the controls | below | New; the core of this item |
| S11 | **Tested strategies** | The ledger: every strategy tested, its spec, period, numbers and verdict, with a running count | the tester's store | New, with S10 |

**What we cannot see, and why.** Market depth (the five-level book) is not stored and may not exist on our
feeds (BL-117 Phase 0a measures what each mode carries); bid and ask have no history, only from the day
capture starts; ticks before capture; a futures-based VWAP before BL-082's date; SENSEX open interest
from Angel One (its `getOIData` rejects BFO, BL-078) and SENSEX options before 2023-07 / 2024-10;
news and flows. A screen that would need one of these says so on the screen instead of showing a blank.

**Placement (proposal).** Live tab: sub-routes Now (S1, S2), Chain (S3), Signals (S5), Paper desk (S6, S7),
Review (S8), Health (S9). Options Lab › Build and test: Rule tester (S10), Tested strategies (S11), and S4
reached from both. The frozen tabs (Trades, P&L, Personalities, Regimes) stay where they are.

## The strategy tester (S10, S11)

**One idea:** a strategy is **when** (a condition on bars up to now, once a day, inside a time window) →
**what** (the Builder's own legs) → **how it is managed** (the Builder's own stops, trail, exit). The
tester finds the minutes the condition fires, runs the legwise engine from the next minute, and sets the
result against the controls. Nothing about any particular condition is decided here.

- **Three ways to say it.** (1) In words, to Claude in a Claude Code session: Claude writes the spec and
  calls an MCP tool; the result appears in S11. Works with no API key and before any screen exists.
  (2) A form of building blocks with the Builder's `ReadBack` ("in plain words") and its validator.
  (3) A spec file. (4) Later: a text box on the page that runs `claude -p` on the owner's plan to turn words
  into the spec, behind a setting, failing closed when `claude` is not available. Whichever way it is said,
  the **validated spec is shown in full and read back before anything runs**, and the translator never sees
  a result.
- **Condition grammar v0 (fixed, small):** series (index OHLC, India VIX, the ATM straddle, an option's
  premium); windows (the last N bars, the session so far, the previous session, the same window on the
  previous N sessions); statistics (high, low, range, mean, median, ATR, RSI, percent change); comparisons
  and crosses; AND / OR / NOT; "first time today". Acceptance (below) is that it can say BL-083's four
  triggers.
- **Engine.** Events from the lake's bars, vectorised as in `rotation/triggers.first_firings`; trades by
  `simulate_day` from the minute after the bar completes; no engine change.
- **Controls always on, never optional:** the **placebo** (the same template at the same minute on the 20
  nearest non-event days), the **random-time** control (the same template at random minutes on the event
  days), and **charges** (the BL-063 model; slippage at 0.5% and 1% as a sensitivity line). The result page
  puts them next to the number.
- **A simulation cache** keyed by (template hash, day, entry minute) makes placebo and random-time draws
  lookups after the first fill. The first test of a new template fills it in the background; later tests of
  that template are minutes. Estimate, to measure in Phase 1: BL-083 timed 0.2 s per simulation, so one
  template over four years on a 5-minute entry grid is about 115,000 simulations, around an hour on 8
  workers.
- **The result page:** a verdict strip (events, net per trade after charges, win rate, event minus placebo
  with its t, the random-time percentile), the cumulative curve by event, by half-year, by weekday and
  days-to-expiry, the event table with each event's chart (S5's), the slippage line. The strip is headed
  "a screen, not a finding" unless the test carries a committed pre-registration (BL-119 style).
- **Keeping the tester honest (S11).** Every test is saved with the spec's hash, period and numbers. Every
  result shows "test N this week, M this month" and one plain sentence on how many lucky results to expect
  among that many tries. A sweep of K variants is one test that counts K. The **confirmation period stays
  locked by default**: the tester runs on the learning period; "Reveal confirmation" is once per spec hash
  and is logged; "open all data" is a labelled exploratory mode. A changed spec is a new hash linked to its
  parent.
- **Paper-trade this** (later): registers the spec as an agent for BL-119's nightly scoring and BL-117's live
  paper. Marked *exploratory* unless it has a committed pre-registration, then *registered*.

## Plan

### Phase 0 — Decisions (answers recorded here before any code)
The owner's answers to the open questions below; the screen order and placement above confirmed or changed.
- **Done when:** the answers are in the Log.

### Phase 1 — Rule spec and test engine (Python, no screen)
- **Tasks:** the spec schema and validator (pydantic, like the legwise schema; line-numbered errors); event
  detection; the simulation cache; placebo, random-time and charges; the store for specs, tests and the
  ledger; `obt rule test <spec> --from D --to D`; API `POST /legwise/rules/validate`, `POST /legwise/rules/test`
  (a background job with progress, like the evening run), `GET /legwise/rules/tests`.
- **Acceptance (written before the code):** (i) the grammar says BL-083's T1 to T4 and the tester reproduces
  BL-083's published event-minus-placebo cells for T1 → Dir and T4 → Dir in the exploration set (+₹754 and
  +₹403 per lot as recorded there) to the rupee, using the same engine path; (ii) no condition reads a bar
  after its stamp (asserted); (iii) a placebo is never the event day nor an event day of the same spec;
  (iv) one trade's charges equal a hand calculation; (v) the second test of a template is at least 10 times
  faster than its first.
- **Done when:** the five checks pass and a one-year test of one rule returns in about 5 minutes with a warm
  cache.

### Phase 2 — Say it in chat (MCP tool)
- **Tasks:** `test_rule`, `validate_rule` and `list_rule_tests` on `obt-mcp`; the tool returns the read-back
  and the ledger count with the result.
- **Done when:** the owner says a strategy in a Claude Code session and gets the result and its S11 row,
  with the confirmation locked.

### Phase 3 — Tester and ledger screens (S10, S11)
- **Tasks:** Options Lab › Build and test › Rule tester: the form, `ReadBack`, a run bar with period and
  slippage, the result page above, the ledger; the analytics page pattern, `components/ui/`, `format.ts`,
  tokens; `usePolledResource` for the job; a Guide page and glossary entries in the same commit.
- **Done when:** a strategy built in the form and one said in chat show the same result page; the lock,
  the count and the reveal log work; the page reads at phone width.

### Phase 4 — Replay a strategy and the Signals log (S4, S5)
- **Tasks:** S1's playback with a strategy's firings, entries, stops and exits drawn on the chart and its MTM
  beside it; the Signals page with a chart per firing.
- **Done when:** a tested strategy can be played on any collected day and its trades on the chart equal the
  tester's event table for that day.

### Phase 5 — Chain and the day strip (S3, S2) on replay
- **Tasks:** the chain at a chosen minute with OI, OI change, volume and IV from the derived tables, stale
  or missing strikes shown as gaps, never carried; the day strip's remaining items.
- **Done when:** the chain for a day equals the derived chain snapshot for that minute, and each missing
  item says why.

### Phase 6 — Screens that wait for the feed and the paper desk (S6, S7, S8, S9, and S1's live reader)
- **Tasks:** built as BL-117 Phase 2 and 4 and BL-119 deliver their data, each behind the same URL as its
  replay version where there is one.
- **Done when:** per screen, once its source exists: it matches that source's own report for 5 sessions.

### Phase 7 — Say it on the page, and Paper-trade this
- **Tasks:** the `claude -p` text box behind a setting; the "Paper-trade this" button wired to BL-119's
  runtime.
- **Done when:** words typed on the page produce the same read-back as the chat route, and a registered
  versus exploratory label shows on every paper strategy.

## Risks

- **A tester is a data-snooping machine.** The ledger, the count, the lock and the always-on controls are the
  mitigation; they are part of the product, not extras. Without them the screen would be a way to find a lucky
  rule in minutes.
- **Compute.** The first test of a template is slow until its cache fills; the page says so and runs it as a
  job.
- **Grammar creep.** Each added operator is a new reason a test cannot be compared with an old one; additions
  are dated and versioned in the spec.
- **A wrong translation of words.** The read-back and the validator come before any run, and the translator
  sees no results.
- **`claude -p` from the API process** may not run (login, plan limits); the form and the chat route do not
  depend on it.
- **A live number on screen invites interference with the real trades** (as BL-117 notes). The screens show;
  nothing acts.

## Open questions (for the owner, when started)

1. **Placement:** screens under the Live tab and the tester under Options Lab › Build and test, as proposed,
   or one new "Desk" section holding all of them?
2. **Which screens first?** The proposal builds the tester (chat route first), then Replay a strategy and
   Signals, then Chain and the day strip, because those run on data we already have. Reorder?
3. **The confirmation lock:** on by default with a labelled "open all data" mode (proposed), or open by
   default?
4. **Chat first:** is "say it in a Claude Code session and see it in the ledger" good enough until the text
   box on the page exists?
5. **The frozen Live-group tabs** (Trades, P&L, Personalities, Regimes) need the frozen server and show
   nothing useful: leave, or hide them?

## Log

- 2026-10-18 — created from the owner's request to separate the screens from strategy work, after reading
  the dashboard nav and routes, the new Live page and `live/session.py`, the Builder and its `ReadBack`, the
  legwise `/backtest` route, the MCP server's tools, and BL-083, BL-117, BL-119. Planning only: no code.

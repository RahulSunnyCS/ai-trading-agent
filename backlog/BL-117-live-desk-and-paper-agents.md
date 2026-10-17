# BL-117 — Live desk: a live NIFTY/SENSEX feed, a live straddle view, a paper desk that runs the day's picks on live data, and agents tested over history first

| | |
|---|---|
| **Priority** | P1 — the owner asked for it on 2026-10-17. Phases 0 and 1 are cheap and decide the rest; the live feed is also needed by BL-118 (orders), BL-083 Phase 3 (the live trigger poller) and the slippage question that `research/options/common/charges.md` leaves open |
| **Status** | Planned (Opus draft 2026-10-17, reworked by Fable the same day; owner to read before "Start BL-117") |
| **Type** | feature + research |
| **Area** | options, data, dashboard, scheduler |
| **Created** | 2026-10-17 |
| **Depends on** | BL-078 (Angel One as a source), BL-034 (lake), BL-058 (journal, fixed base, pass rule, random baskets), BL-111 (lot ladder and range mix: its arms are roster members here, tested there), BL-023 (this item answers its two open questions: Python, and none of the 10 personalities as they stand) |
| **TODO.md row** | — (filled in when started) |

## How to read this plan

Two models wrote it. Opus 5.5 drafted it from the owner's voice note; Fable 5.1 read the research
pages and the code and reworked it. Each design choice is written as **Decision (who, confidence)**
with the alternative next to it; the owner may overrule any of them before a run. Fable's changes
to the Opus draft are listed in "What Fable changed" and in the Log. The only fixed things are the
constraints: no orders from this repo (BL-118 owns orders, gated), the research gate, the frozen
parts stay frozen, and the registered BL-058 journal, lists, universe and read-out are not touched.

Words: the live run of the day's picks is the **paper desk** ("shadow" is the BL-083 scoreboard,
"track" is BL-113's T1). An **agent** is a pre-open policy: given everything known before 09:16,
it names the day's variants and lots. Nothing here places an order.

## Context

### What the owner asked for (2026-10-17, paraphrased)

1. Live data from Angel One or Fyers, by WebSocket or polling (tick-by-tick is not needed).
2. A live view of the basics: the NIFTY feed, the options to track (perhaps only ATM), the ATM
   straddle plotted.
3. The project's original idea: two or three agents that take trades on signals. One aggressive and
   adaptive, one conservative. They change a little each time and get better, using what the
   research found.
4. Backtests of all of it over the collected 1-minute history.

### What already exists (read 2026-10-17)

**The research stack is where every verified result lives, and it is Python.**
- `legwise/engine.py`: a per-minute state machine (`_DaySim`) over a 375-slot day grid
  (`market.Series`, `price_at(T)` = close of the bar ending at T), golden-verified against AlgoTest.
  `run()` is a 50-line loop that calls the per-leg steps minute by minute. **It can be stepped as
  bars arrive; nothing in it needs the whole day up front** except the loader.
- `rotation/`: 298 variants scored nightly into `rotation/results/<variant>.csv` (net, gross,
  worst MTM, stops) with `days.csv` (weekday, VIX open, DTE). The 09:16 pick (`pick.py`,
  `score.py`, `lists.py`) writes lists A / B / C / REF into a hash chain; `readout.py` already
  computes each list against the **fixed base** and against **random same-shape baskets** (2,000
  draws). The T1 track (BL-113) runs beside it from 2026-10-19. `rotation/live.py` is only the
  09:15 VIX read. **A pre-open agent needs nothing but these files**: `research/bl057/rotate.py`
  is exactly such a replay.
- Collectors (`fyers/`, `angelone/`): 1-minute REST history after the close. The Angel One client
  logs in by REST with TOTP (no human check), paces at 0.4 s a call (about 3 a second), carries
  OI for NFO only, drops the index's 15:15–15:28 minutes and is about ₹0.30 off Fyers on option
  OHLC (BL-078). **No WebSocket code exists in Python.**
- The scheduler (`apps/scheduler`) runs short jobs; the only one inside the session is the 09:16
  pick. There is no long-running session job type and no `caffeinate`.

**The frozen TypeScript engine** (`apps/server`, BL-019) is the original version of this idea:
`BrokerFeed`, a Fyers WS adapter, an Angel One `WebSocketV2` adapter (LTP only, NIFTY and VIX only,
`subscribe()` a no-op), a 15-second straddle calculator, peak detection, 10 personalities behind a
5-stage filter, and a `/live` page fed from Redis streams. It needs Redis plus TimescaleDB, neither
of which runs on the laptop. Its seeds include `conservative_learner` / `medium_learner` /
`aggressive_learner`; their learning parameters are read by no code, and the only thing that ever
evolved was `min_probability`. Nothing in it was calibrated or deployed.

**What the research says an agent may use** (`research/options/common/`):
- The 09:16 ranking with weekday / DTE / VIX fits beat random baskets on the 2022–24 hold-out:
  "the most solid result here". Own recent return (short-term momentum over variants) worked in
  P1 and **subtracted** in P2 and P3; PBO 0.42–0.49; no weight cell is robust across periods.
  The lists differ only in how much recent they use (A 5%, B 0%, C 15%, REF 33%).
- **Every intraday idea was killed**: VIX at 10:00 (BL-053), hourly state and a no-trade gate
  (BL-081), event triggers (BL-083, two Dir leads only in 2024–26), straddle exhaustion (BL-091),
  Dir trade management (BL-105). Daily and portfolio stops help no mix (BL-055, BL-066). The long
  straddle hedge is killed (BL-101).
- Range persists in both directions (BL-110), descriptive; BL-111 is its registered test as a lot
  mix and a 2-2-1-1 ladder, not run.
- Charges take 19–37% of gross. **No slippage model exists**; at 1% slippage the fixed base is
  negative. A filter must be judged against a random skip at the same rate.
- BL-058's Log: a 60-day forward read-out with the registered rule is "close to unpassable" (a list
  passed 0 of 33 and 1–6 of 48 historical windows).

**The honest reading for this item.** BL-058 is already an agent tournament: Clockwork (the fixed
base), Placebo (random baskets), and four fixed-weight personalities from "steady" (A) to
"aggressive" (REF), judged forward. What is missing is (a) any live view, (b) a paper run of the
day's picks on live prices, (c) a measured fill gap, and (d) an answer to whether *adapting* the
weights helps, which BL-067–075 answered mostly "no" on seen data. So the agent part of this item is
small and conditional; the feed and the paper desk are the sure parts.

### The execution item

`backlog/BL-118-order-adapter-gated.md` (was the uncommitted `BL-113-own-execution-engine-shadow-first.md`,
renumbered 2026-10-17 because BL-113 is the T1 track). Its Phase 1 (live paper run) and Phase 2
(three-way reconciliation) move into this item's Phase 4; it keeps only the order adapter, gated.

## What Fable changed from the Opus draft

| Opus | Fable | Why |
|---|---|---|
| Paper broker re-runs `simulate_day` on the bars so far at each minute | **Step the existing `_DaySim`** (`run()` → `step(minute)` + `finish()`), feed a `Series` filled in place | The engine is already a per-minute state machine; a re-run per minute is 375× the work and needs the engine to accept a truncated day; stepping it is the same code path, so parity holds by construction |
| Agents tested over history need the replay `BarSource` (Phase 3a) first | **The agent tournament needs no engine at all**: pre-open agents over `rotation/results/` + `days.csv`, a research script like `rotate.py` | Phase 1 can run in days, before any live plumbing, and decides how much agent work there is |
| Conservative and Aggressive are one new adaptive algorithm (Hedge / bandit) with two settings | The lists **are** the conservative-to-aggressive ladder (recent 0 → 33%). One new agent, **Meta** (Hedge over the four lists, one dial η), is the only adaptive hypothesis; Conservative and Aggressive are its two settings | Hedge over 298 variants is recent-return momentum, which failed in P2 and P3; re-fitting the five weights is BL-067–075, which found nothing robust. Four experts and one dial is the smallest adaptive hypothesis left |
| Risk rules (daily ₹ cap, drawdown step-down) differ per agent | **Uniform desk rules** for every agent; sizing is BL-111's test, not a per-agent trait | Otherwise the roster confounds "who picks better" with "who sizes smaller"; stops do not help any mix (BL-055/066) |
| LLM picker and LLM filter, both forward-only | **LLM filter only**, with a **Calendar-veto** code agent as its control, both judged against a random skip at the same rate | A picker on the same numbers is a noisier scorer; a filter is the one thing that can read what the code cannot (news). If it only knows what the calendar knows, the calendar is cheaper |
| Weekly learning loop, Claude proposes challengers | **Monthly**, at most two live challengers at a time, each a committed `_EXPERIMENT.md` block, every one counted | Weekly proposals are 50 experiments a year; a 60-day verdict each caps the honest rate near eight |
| `/live` with a replay mode; `/agents` page in Phase 7 | `/live` without UI replay (the engine keeps replay); **no `/agents` page until an agent passes Phase 1**; a Telegram line and a CSV until then | Owner value is the live view; the agent page is work for a roster that may be Clockwork, Placebo and Incumbent only |
| "Shadow engine", "shadow scoring" | **Paper desk**, **live paper** | "Shadow" is the BL-083 scoreboard; BL-113 renamed itself for the same reason |

Kept from Opus: agents decide before the open and leave the intraday to the legwise rules; a
structural change is a new challenger, never an edit to a running agent; Python, not the TS
engine; decisions on closed 1-minute bars with the feed settled by a spike; live data kept out of
the lake; the agent journal recorded before 09:16; Clockwork and Placebo as the two yardsticks.

## Goal

1. **A dependable live feed.** Every trading day an unattended process captures 1-minute bars and
   per-minute quotes (bid/ask) for NIFTY and SENSEX spot, VIX, the nearest future and a defined
   option band, into `TRADING_DATA_ROOT/live/`, reconciled against the collector's bars each
   evening.
2. **A live desk view.** Spot, VIX, future, ATM CE/PE, the rolling-ATM straddle and the straddle
   fixed at the 09:15 ATM, IV, DTE and feed health, for both indices, within about 5 s of each
   minute close.
3. **Live = replay.** The same engine object runs a past day from the lake and a live day from the
   feed. On a past day it equals the stored result to the rupee. On a live day it runs the day's
   list C picks and the fixed base and records both a bar-rule fill and a quote fill: **the first
   measured slippage.**
4. **Agents, tested cheaply first.** A pre-registered replay tournament over the stored results
   decides which agents, if any, deserve a forward run. The forward run is 60 days beside BL-058,
   with Clockwork and Placebo as the yardsticks and a capped challenger loop.

## Out of scope

- Any order, or any write to a broker order endpoint (BL-118, gated).
- Unfreezing `apps/server`; borrowing its ideas is fine.
- Changing the BL-058 lists, universe, pass rule or journal, or the T1 track.
- Mixing live-captured bars into the research lake.
- Intraday discretion for agents (no intraday signal has passed; a new one is its own research
  item first). Rule-triggered intraday agents, the owner's own rules and the evening post-mortems
  are [BL-119](BL-119-rule-agents-paper-and-retrospection.md). This item's agent tournament
  (Phases 0b, 1, 5) tests the pre-open pickers and is complementary to it; BL-119's live paper runs
  on this item's Phase 2 feed and Phase 4 paper desk.
- Showing any of this to anyone but the owner (`business.md`).

## Architecture (proposal)

```
 Angel One SmartWebSocketV2 ─┐                       ┌─> TRADING_DATA_ROOT/live/<day>/ (bars, quotes, events)
 Angel One REST candles ─────┼─> feed ─> 1m bars ────┤
 Fyers WS (token valid) ─────┘   + quotes + health   └─> BarSource(live)  ─┐
                                                                            ├─> market state ─> /live desk
 lake (a past day) ──────────────────────────────────> BarSource(replay) ──┘        │
                                                                                    v
            agents (pre-open, journalled) ──> day plan ──> paper desk (_DaySim stepped) ──> live paper log
                                                                                    │
                              evening: live paper vs stored legwise result vs quote fills vs real (BL-093)
```

- **Decision (Opus, high; Fable keeps):** one `BarSource` with a live and a replay implementation;
  everything downstream cannot tell them apart.
- **Decision (Fable, high):** the paper desk is `_DaySim` stepped. The refactor of `run()` into
  `step` / `finish` must leave the 30 golden scenarios and `rotation-parity.py` unchanged.
- **Decision (Fable, high):** live data under `live/`, never in the lake; a day the evening
  reconcile flags is excluded from live-paper scoring, never repaired from memory.
- **Decision (Fable, medium):** Angel One is the primary live source (unattended REST login, BL-078);
  Fyers is the fallback only on days its token is valid. The spike may reverse this.

## Plan

### Phase 0a — Feed spike (read-only; writes only under `research/bl117/`)
- **Tasks:** over one full session each,
  - **Angel One SmartWebSocketV2** (`smartapi-python`): modes LTP / Quote / SnapQuote and which carry
    bid/ask, depth, volume, OI; tokens per connection and connections per account (the docs say
    1,000 and 3; verify); NFO **and BFO** (SENSEX); tick rate and gaps; disconnect / reconnect; the
    session token's life through the day; whether the 15:15–15:28 index minutes arrive.
  - **Angel One REST `getCandleData` at minute close:** seconds after hh:mm:00 until the closed bar
    is served; whether the current bar is partial; calls per minute for a 60-instrument band
    against the 3-a-second limit.
  - **Fyers WS** on a day with a valid token: the same.
  - **Ticks → 1-minute bars** compared with that evening's lake bars: OHLC difference, missing
    minutes.
- **Deliverable:** a table in the Log per source and mode (latency, coverage, fields, limits,
  failures), and the choice written with its numbers.
- **Done when:** one session captured each way and the choice is written.
- **Decision (Fable, medium):** expect WS for breadth and bid/ask, REST once a minute on a small
  anchor set (spot, VIX, ATM CE/PE) as the cross-check. Polling 60 instruments a minute at 3 a
  second leaves no headroom and never gives bid/ask.

### Phase 0b — Pre-register the replay tournament (committed before any run)
A research block in the sense of `_TEMPLATE.md` Phase 0; the owner may overrule before the run.
- **Hypothesis:** at least one agent earns more net ₹ per lot-day than Clockwork and than the 95th
  percentile of Placebo, with drawdown per lot no worse than Clockwork, in P2 **and** P3.
- **Universe:** Core-298 only, from the stored results (`rotation/results/`, `days.csv`), the shape
  DRB-6W3L2 (3 × 2 lots, ≥ 2 Widesl, Buy add-on) for every agent, so only the picker differs.
  SENSEX has no P3 data; P3 is NIFTY only, as in BL-071.
- **Agents (v0 roster):**

  | Agent | Definition | Yardstick or hypothesis |
  |---|---|---|
  | **Clockwork** | The fixed base (2 × N_wide 09:17 + Dir ATM 09:24, 2 lots each); never changes | Primary yardstick (BL-058) |
  | **Placebo** | Random same-shape baskets, 2,000 draws (`readout.py`'s) | Luck; an agent below its P95 has nothing to report |
  | **Steady**, **Calendar**, **Adaptive**, **Baseline** | Lists A, B, C, REF exactly as `lists.py` | The fixed personalities, recent 5 / 0 / 15 / 33%; Adaptive is the Incumbent |
  | **Meta-slow / Meta-fast** | Hedge over the four lists: each day follow the list with the highest weight; weights × exp(η · that list's net per lot-day yesterday), normalised. η fixed on P1 only: slow = the η that changes the leader at most once a month on P1, fast = at most once a week. One dial, two settings | The owner's conservative / aggressive adaptive agents, in the smallest form the evidence allows |
  | **Calendar-veto** | Adaptive, skipping RBI policy days, Union Budget day and the day after a US FOMC decision (dates from a committed CSV) | Control for the LLM filter; judged against a random skip at the same rate |

  BL-111's arms (2-2-1-1 ladder; range-regime mix) are **not** re-tested here: when BL-111 runs,
  its surviving arm joins the roster as **Regime** with BL-111's own result as its evidence.
- **Look-ahead:** an agent on day D reads results and attributes of days < D only, plus D's weekday,
  DTE and 09:15 VIX open (`pick.load_history`'s rule); a test asserts it.
- **Costs:** net = gross minus the BL-063 charge model (₹13 an order, flat); slippage at 0 / 0.5 /
  1% reported as a sensitivity line, not in the rule (every agent trades the same lot count and
  the same families, so slippage moves them together; Buy's re-entries are the exception, shown).
- **Pass / kill rule, per agent:** the 5-day circular block-bootstrap 90% interval (2,000 resamples,
  seed 20261012, BL-058's) of (agent − Clockwork) net per lot-day has its lower bound above zero,
  **and** the agent's net per lot-day is above Placebo's P95, **and** its max drawdown per lot is no
  worse than Clockwork's, in **both** P2 and P3. P1 is reported, never judged (the lists and Meta's
  η were fitted on it).
- **Honesty note:** P3 was read by BL-071/075 when the lists were chosen, so for the four lists
  nothing here is pristine; only Meta and Calendar-veto have an unseen P3. The forward run is the
  only clean test for the lists, and BL-058 already runs it.
- **Data-snooping:** every agent and setting tried is counted here; PBO over the roster is
  reported (`analytics/overfit.py`).
- **Will not run:** any intraday agent, any per-agent risk rule, any pool but Core-298, any agent
  whose rule was changed after seeing P2 or P3 (such an agent is a new, dated row).
- **Done when:** this block is in a commit, named in the Log, before `research/bl117/` holds a run.

### Phase 1 — Replay tournament (`research/bl117/`, no engine change)
- **Tasks:** `agents.py` (the roster as pure functions over the stored tables, Clockwork and the
  lists reproducing `rotate.py` / `pick.score_history` picks exactly), `tournament.py` (periods,
  costs, bootstrap, Placebo draws, PBO), `readout.md`.
- **Deliverables:** a scoreboard per period; `research/options/common/agents.md` (findings page);
  the kill or keep reason per agent written in this item.
- **Done when:** P2 read, then P3 read once; every agent marked kept or killed. **If no agent
  passes, that is a valid finish**: Phase 5's roster is Clockwork, Placebo, Incumbent and the
  forward-only contestants, and no agent UI is built.

### Phase 2 — Live capture service
- **Tasks:**
  - Subscription set per index: spot, VIX, nearest future; nearest-weekly options **ATM ± N**
    re-centred as spot moves (strikes added, never dropped intraday); every strike any list C or
    fixed-base pick could select that morning (the closest-premium Widesl variants can sit far OTM:
    the band comes from the 09:15 chain, not a fixed N); every strike a paper position holds.
  - Bar builder (1-minute OHLCV, OI when the feed has it) and one quote snapshot (bid/ask/LTP) at
    each minute close. Health: heartbeat, stale-instrument check, fallback to the second source
    (recorded), a private Telegram alert for a gap over X minutes on the anchor set.
  - Scheduler: a **session job type** (start 09:05, stop 15:35, restart on crash, heartbeat
    checked, `caffeinate -i` while it runs). New scheduler work (BL-012).
  - Crash and resume: a restart resumes the day's files, never rewrites earlier minutes.
  - Evening reconcile against the collector's bars (missing minutes, worst-of-OHLC difference,
    volume ratio) into the feed-health record and the `options-evening` Telegram.
- **Deliverables:** `obt live capture`, the scheduler job, `TRADING_DATA_ROOT/live/<day>/`, the
  reconcile report, `technical.md` lines (commands, env, gotchas) in the same commit.
- **Done when:** 10 consecutive trading days unattended, ≥ 99.5% of minutes present on the anchor
  set, the reconcile report written each evening.

### Phase 3 — Live desk view
- **Tasks:**
  - Market state each minute: ATM strike; **rolling-ATM straddle** and the **straddle fixed at the
    09:15 ATM**; change from open in % and ₹; synthetic future and basis; ATM IV (BL-034's derived
    IV code); day range so far against the 20-session median, labelled descriptive (BL-110); DTE
    in weekdays (BL-109).
  - A small live API on `obt-api` (`/live/*`), polled once a minute through `usePolledResource`.
    **Decision (Opus, medium; Fable keeps):** polling, not SSE, unless Phase 0a shows latency
    matters.
  - Dashboard `/live` rebuilt on it (reuse `StraddlePanel` / `LiveLineChart` where their props
    allow; analytics page pattern, tokens, `format.ts`): tabs NIFTY / SENSEX; hero chart of both
    straddles with spot; strip of VIX, IV, DTE, range state; feed-health banner; a Guide page in the
    same commit.
- **Done when:** for 5 sessions both indices show within about 5 s of each minute close, and the
  rolling straddle series for a finished day equals the derived straddle table for that day.

### Phase 4 — Paper desk: live = replay (absorbs BL-118's old Phases 1–2)
- **4a, the engine:** `_DaySim.run()` split into `step(minute)` / `finish()` with `run()` kept as
  the loop; a `Series` filled in place by the live `BarSource`; `BarSource(replay)` over a lake day.
  **Parity:** the 30 golden scenarios and `rotation-parity.py` unchanged; for 20 past days every
  Core-298 variant through replay equals the stored result to the rupee.
- **4b, live paper:** each day the list C picks and the fixed base run on the live `BarSource`;
  every entry, stop, re-entry and exit logged with the bar-rule fill **and** the quote fill (bid for
  a sell, ask for a buy, at that minute). Evening: per pick, live paper vs the stored legwise result
  vs the quote fill; the real fill joins when BL-093 lands. One Telegram line at the close, private.
- **4c, slippage:** from 20+ live-paper days, the spread and fill gap per family, strike distance
  and time of day; written to `research/options/common/charges.md` (or `slippage.md`) and offered
  to BL-058's read-out as a labelled sensitivity line (the registered read-out itself is unchanged).
- **Done when:** 4a parity passes; 10 live days match the evening result within the tolerance
  Phase 0a measured, each difference explained; the slippage page has 20 days behind it.
- **Red-team note:** an intraday P&L on screen invites interference with the real AlgoTest trades.
  The desk shows; the registered journal is still scored by the evening engine; the live-paper
  series is a second, labelled line.

### Phase 5 — Forward paper tournament and the challenger loop
- **Roster:** Clockwork, Placebo, Incumbent (list C as journalled), the Phase 1 survivors, and the
  forward-only contestants: **Calendar-veto** and **LLM filter**.
- **LLM filter (forward-only, never backtested):** a scheduler job at 09:05 runs `claude -p` on the
  owner's plan (no API key; memory: use plan routes) with a committed prompt file (its hash and the
  model id in the entry), inputs fetched by a script, not by the model browsing: today's calendar
  events and a fixed set of headline feeds. Output strict JSON `{action: trade | half | skip,
  reason}`, recorded in the agent journal by 09:10, applied to the Incumbent's picks as the line
  "Incumbent + LLM". A parse failure or a late answer = `trade`, counted. Stateless: it never sees
  its own past decisions (a version with memory is a challenger). Judged against Incumbent,
  Calendar-veto and a random skip at its realised skip rate. One call a day; expect months.
- **Daily:** each agent's decision journalled before 09:16 (hash chain, `rotation/journal.py`
  reused, a late record labelled and never scored forward); evening scoreboard (bar-rule ₹, quote
  fill ₹, net of charges) as a CSV and one private Telegram line. **No `/agents` page** unless an
  agent passed Phase 1.
- **Challenger loop, monthly:** a Claude session (MCP + `obt`) reads the scoreboard and writes at
  most two proposals as `_EXPERIMENT.md` blocks; the owner approves; an approved one runs as a
  challenger beside its parent; it replaces the parent only by passing the forward rule; at most
  two live challengers at a time; every birth and death logged and counted toward PBO.
- **Pass rule:** BL-058's, on the first 60 forward days, read once: lower bound of the 90%
  block-bootstrap interval of (agent − Clockwork) per lot-day above zero and drawdown no worse;
  Placebo P95 as the second bar. **Expectation (BL-058 Log):** close to unpassable in 60 days; the
  forward run is evidence and a behaviour test, not a quick verdict.
- **Done when:** 60 forward days, the read-out written per the rule, recorded here and in
  `research/options/common/agents.md`.

### Orders — not here
BL-118, gated on BL-058's read-out passing **and** Phase 4 parity **and** an owner decision on
record.

## Order of work (Decision, Fable, high)

1. **Phase 0a and Phases 0b → 1 in parallel**, both days of work, no engine change: the feed choice
   with numbers, and the answer to "do agents add anything over the lists?"
2. **Phase 2, then 3**: the live feed and the live view, which the owner wants to see and BL-118 and
   BL-083 Phase 3 need regardless of Phase 1's answer.
3. **Phase 4**: the paper desk and the slippage measure.
4. **Phase 5** only with what Phase 1 left standing, plus the forward-only contestants.

## Answers to BL-023's open questions (Decision, Fable, medium)

1. Python, next to the legwise engine. The TS engine stays frozen; its ideas (Clockwork, learner
   tiers, benchmark comparison) are borrowed.
2. None of the 10 personalities as they stand: their signals are the straddle peak rule that
   BL-091 could not make pass. The learner tiers survive as Meta-slow / Meta-fast.

## Risks

- **Laptop asleep or offline in the session.** `caffeinate` in the session job, a heartbeat alert, a
  missed decision skipped and alerted, never recorded late. The Mac mini removes most of it.
- **Feed limits or token life differ from the docs.** Phase 0a measures before anything depends
  on them. Static-IP whitelisting (BL-078) can break a login when the home IP changes.
- **Tick-to-bar gap.** The live `price_at(T)` is the bar closing at T:00; a real fill is on the next
  tick. Phase 4b measures the gap; both fills are recorded.
- **Meta-overfitting the roster.** Every agent, setting and challenger counted; PBO reported; P3
  read once; the challenger rate capped.
- **Confounding picks with sizing.** Uniform desk rules; sizing is BL-111's test.
- **Scope creep into orders.** Out of scope; BL-118 is gated.
- **Owner attention.** Two private Telegram lines a day at most; the monthly loop is the only
  scheduled human step.
- **Overlap with BL-058 and T1.** This item reads the journal and never writes it; the Incumbent
  replays list C and does not replace it.

## Open questions (for the owner, when started)

1. Is the laptop on and awake 09:05–15:35 on trading days, or only some days?
2. The paper lot budget per agent: 6 lots a day (the lists' shape), or the owner's real 3 ordinary
   / 6 expiry?
3. Telegram: one line at the close and one morning plan, or a line per fill as well?
4. The LLM filter's headline sources (a fixed list of feeds), and whether it runs at all.
5. The Calendar-veto dates: RBI, Budget, FOMC-next-day as proposed, or another set?
6. Do friends see `/live`? (Fable: no, per `business.md`, until the signal-sharing note is checked.)

## Log

- 2026-10-17 — created by Opus 5.5 from the owner's voice note as a draft for Fable's review.
- 2026-10-17 — reworked by Fable 5.1 after reading `research/options/common/*`, BL-058, BL-113,
  `legwise/engine.py`, `legwise/market.py`, `rotation/{score,lists,pick,store,live,shadow}.py` and
  the Angel One client. Changes in "What Fable changed": the paper desk steps the existing state
  machine instead of re-running it; the agent tournament runs over the stored results first, with
  no engine work; the lists are the conservative-to-aggressive ladder and Meta (Hedge over the four
  lists) is the one adaptive hypothesis; uniform desk risk rules; LLM filter only, with Calendar-veto
  as its control; monthly capped challenger loop; no agent UI before a pass; "shadow" renamed "paper
  desk". Phase 0b written as a pre-registration block (not yet committed as such: this item is
  uncommitted; the block counts from the commit that adds it). The execution item renumbered to
  BL-118 and its Phases 1–2 moved here (Phase 4). No code, no runs.

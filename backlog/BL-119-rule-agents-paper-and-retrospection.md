# BL-119 — Rule agents: the owner's rules trade on the index as paper trades, a post-mortem every evening, and agents that are replaced by better ones

| | |
|---|---|
| **Priority** | P1 — the owner's main aim for the live work (2026-10-18): agents that follow rules he gives, trade them on live data as paper, retrospect, improve |
| **Status** | In progress (started 2026-10-18: Phase 0 and Amendment 1 registered, owner's answers recorded; nothing run) |
| **Type** | feature + research |
| **Area** | options, agents, scheduler |
| **Created** | 2026-10-18 |
| **Depends on** | BL-083 (event-versus-placebo method, trigger code), BL-022 (analog days), BL-110 (range persistence), BL-117 Phases 2 and 4 (live feed, paper desk: needed only for Phase 4 here), BL-063 charge model |
| **TODO.md row** | 3.41.1 |

## Context

Owner, 2026-10-18 (paraphrased): "Give agents rules. For example trade when a range breakout
happens after a consolidation of about 60 one-minute candles. They run as live paper trades. I want
to make them better agents: every evening they retrospect on why a trade failed. Decide what
strategies: range or pattern breakouts, or momentum exhaustion. Should an LLM be used? Maybe store
each day's 1-minute candles as an embedding and, when today looks like a past day, assume the rest
follows." I had narrowed BL-117's agents to pre-open pickers; this item is the broader original
idea. BL-117's agent tournament (Phases 0b, 1, 5) stays: it tests the pre-open pickers. BL-119 owns
rule-triggered intraday agents.

### What already exists

- **The method.** `rotation/triggers.py` and `research/bl083/` already fire a strategy the minute a
  condition is met, simulate it with the legwise engine, and set each event against the same
  template at the same minute on the 20 nearest non-event days (day-clustered t, explore and confirm
  periods, random-time and random-day controls). A new rule is a new trigger in that framework. The
  nightly `rotation update` already scores BL-083's triggers on new days with no live process.
- **The data.** NIFTY 1-minute index bars from 2015 and option bars from 2022-01 (BL-071 import);
  `research/bl081/state.py` loaders for ATR, RSI and the straddle. SENSEX options only from 2023-07 /
  2024-10, so SENSEX has no 2022–24 confirmation.
- **The frozen engine's design.** `apps/server`: signal → 5-stage personality filter (hard filters,
  daily state, VIX context, signal quality, profit gate) → paper trade → evening retrospection →
  proposed adjustment awaiting approval (`EVOLUTION_REQUIRE_APPROVAL` defaults true, 20-trade
  minimum, 7-day cooldown, frozen Clockwork). Never calibrated. This item rebuilds the shape in
  Python beside the engine that has the data; it does not unfreeze it.

### What the research says about the owner's three ideas

| Idea | Status | Consequence |
|---|---|---|
| Range breakout after a consolidation | **Not tested on the index.** The Buy strategy breaks its own option's 10-minute premium range; `research/options/strategies/buy-breakout/consolidation-30m.md` is "Not tested" and `breakout-source.md` found the natural index version (CE on a break up, PE on a break down) never run. BL-110: a narrow opening range is followed by a quieter rest of the day (rest-of-day range 0.95× against 1.31× for the widest third; Spearman 0.30) | A real open question, with a modest prior: long options like movement, and a narrow range predicts less of it. The control arms below separate "breakout" from "narrow" |
| Momentum exhaustion | **Tested and not found.** BL-091: 31 straddle-premium arms, none passed; BL-083 T4 (5-minute RSI exhaustion): a Dir lead in 2024–26 only, partly "a Dir in place of that pick" | Not in the first rules. It needs a form those did not test (open question 4) |
| "Days like today" | **BL-022, an Idea, never run.** About 2,400 sessions, non-stationary rules | Worth one test, on the raw price path, not an LLM embedding (below) |

### Where an LLM fits

- **Live decisions: no.** A rule has to behave the same every day to be judged at all, and a past-data
  score of an LLM is contaminated by what it learned in training.
- **Embeddings: no.** A text model's embedding of a price series is a poor picture of the series.
  The analog search uses the series itself (the first 60 minutes as scaled returns, nearest
  neighbours by distance), which is BL-022's v0 and needs no model.
- **Evening post-mortem: yes.** Writing why a trade failed is qualitative work outside market hours,
  with no look-ahead problem because it does not trade. It runs as `claude -p` on the owner's plan, no
  API key. Its text is not evidence (see Phase 3): proposals are driven by counted tags.

## Defaults taken for the owner's open questions (overrule before any run)

1. **Trade template:** one long **ATM** option, a call after a break up and a put after a break down,
   with the Buy strategy's management (leg stop 25% trailed 1 point per 1, ₹2,000 overall per lot,
   exit 15:14). The Buy shape on its own is negative after charges (`charges.md`), so the rule has to
   pay for them. A ₹50-premium strike is a different template and is not run.
2. **First rules (NIFTY, 1-minute bars, fixed definitions in Phase 0):** (a) breakout of the
   09:15–10:15 range after a narrow range; (b) the same on a 30-minute range, as its control; (c) rule
   (a) with an analog-day filter on top. Momentum exhaustion waits (open question 4).
3. **NIFTY only.** SENSEX has no 2022–24 confirmation.

## Goal

1. A verdict, under a rule written first, on whether any of the owner's first rules beats entering at
   a time of the same day or on ordinary days, after charges, in two periods.
2. For any rule that passes: agents (a rule, a personality of filters, a template, the legwise
   management) scored on new days every night, then run as live paper trades on BL-117's feed.
3. A post-mortem every evening, and a monthly step that turns counted failure patterns into at most
   two challenger agents, which replace a parent only by passing a forward rule.

## Out of scope

- Orders (BL-118, gated). Unfreezing `apps/server`.
- An LLM in any live decision or any backtest; LLM embeddings.
- SENSEX, other windows, a rolling window, other templates, momentum exhaustion (each is a dated block
  or a new item, never added after a run).
- Changing BL-058's lists or journal, the T1 track, or BL-117's agent tournament.
- Showing any of this to anyone but the owner (`business.md`).
- The screens and the page where a strategy is stated and tested: [BL-120](BL-120-desk-screens-and-strategy-tester.md).
  This item's Phase 1 study is a research script; BL-120's tester generalises the same method to any
  stated rule.

## What an agent is

| Part | What it is |
|---|---|
| **Rule** | A pure function of the index's 1-minute bars up to the current bar, and the day's context known before 09:16 (weekday, weekday-DTE, VIX open). Fires at most once per side per day |
| **Personality** (filters, from the frozen engine's stages) | Time window, blocked dates (RBI policy, Budget, expiry-day mornings), VIX ceiling, trades a day, stop after N losses. Conservative and aggressive are the same rule with different filters (table below) |
| **Template** | The single long ATM leg above |
| **Management** | The legwise engine's stops, trail and exit; nothing discretionary |
| **Retrospection** | Phase 3 |

| Personality | Window | Blocked dates | VIX open cap | Trades a day | Stop after |
|---|---|---|---|---|---|
| Conservative | 10:15–13:00 | RBI, Budget, expiry day | 18 | 1 | 1 loss |
| Aggressive | 10:15–14:00 | none | none | 2 (the opposite break may re-arm) | 2 losses |

The personalities are fixed here and not tuned. Historically they are two subsets of rule (a)'s events,
reported but not judged; they are judged forward.

## Plan

### Phase 0 — Pre-register (committed before any run; research gate)

- **Hypothesis:** a close of the NIFTY 1-minute bar beyond a narrow, completed range is followed by
  more movement in its direction than on ordinary days, enough for a long ATM option to pay its
  charges.
- **Definitions (one each; a second definition is a new dated block):**
  - *Range, rule (a):* high and low of the 60 one-minute bars stamped 09:15 to 10:14 (the closed
    09:15–10:15 window). *Rule (b):* the 30 bars stamped 09:15 to 09:44.
  - *Narrow:* that window's high − low is below the median of the same quantity over the previous 20
    sessions. *Controls* (a0, b0): the same break with no narrow condition.
  - *Break:* the first completed bar, from the end of the window to 14:00, whose **close** is above
    the range high (up) or below the range low (down). One event per day; the first break only.
  - *Entry:* the minute after the breaking bar completes (entry_time = that bar's stamp + 1 minute,
    the BL-083 convention); the engine's price at T is the close of the bar ending at T.
  - *Analog filter, rule (c):* at the end of the 09:15–10:15 window, the path x_i = ln(close_i /
    open_0915) for the 60 bars, divided by the 14-session mean true range as a fraction of price.
    Pool: all earlier NIFTY sessions in the lake with a complete path (2015 on), at least 250 of them.
    The 20 nearest by Euclidean distance. For each, the move from its 10:15 price to its 15:14 close,
    signed by today's break direction. Analog score = the share of the 20 that continue. Keep an event
    when the score is at least 0.60.
- **Universe:** NIFTY, weekly expiry; sessions in the lake with option data and a `data_quality`
  verdict of usable. Days with a missing contract are logged, never zero-filled. Periods: **A**
  2022-01-03 → 2024-10-08, **B** 2024-10-09 → 2026-10-08 (*superseded 2026-10-28, before any run: B ends
  2025-12-02; see the Log*). Sessions after the data cut-off (the last
  collected day when "Start BL-119" is said) are forward only and are never read here.
- **Look-ahead check:** a rule at stamp j reads bars stamped ≤ j (asserted on the maximum timestamp);
  the 20-session median and the ATR use completed prior sessions; analog neighbours are all dated
  before the event day (asserted); placebo days are matched on calendar position only, never on
  outcome; entry is at j + 1.
- **Comparators:** (1) *placebo:* the same single-leg template, same side, same entry minute, on the
  20 nearest days (10 before, 10 after) with no event of that arm; (2) *random time:* the same
  template and side on the same event days at a random minute in the arm's window, 200 draws; (3) for
  (c), a *random skip* dropping the same share of rule (a)'s events, 200 draws.
- **Costs:** net = gross minus the BL-063 charge model (₹13 an order flat, STT by date, exchange,
  SEBI, IPFT, stamp, GST; `research/bl063/charges.py`) on the recorded trades. Slippage 0.5% and 1% of
  price per fill are reported as a sensitivity, not in the rule.
- **Pass / kill rule, primary arm (a), judged in A and in B separately:**
  1. net mean P&L per trade > 0;
  2. event minus placebo, per-day mean, day-clustered t ≥ 2.0;
  3. the event mean above the 95th percentile of the 200 random-time means.
  **Pass** = all three in both periods. **Kill** = (1) or (2) fails in either period. **Inconclusive**
  = (1) and (2) hold in both and (3) fails, or a period has under 40 event days (then it is reported,
  not judged).
- **Secondary arms:** (b) and (c) are judged by the same three tests with t ≥ 2.5 (three judged arms).
  (c) has a gate first: across event days the Spearman correlation between the analog score and the
  realised signed move to 15:14 must have a 90% day-block bootstrap lower bound above zero and exceed
  the 95th percentile of the same correlation with 200 draws of 20 random earlier sessions as
  neighbours, in A and in B. If the gate fails, (c)'s trades are not run. Controls a0 and b0 are
  reported only: they say whether "narrow" adds anything (net per trade of a minus a0, per period); if
  a0 would pass and a does not, a0 is a new dated block, not an adoption.
- **Counted tries:** the arms a, a0, b, b0, c, plus the two personality subsets, seven cells; the
  count stays in this item and any later block adds to it. PBO is not computed for seven fixed cells;
  the count is the disclosure.
- **Hold-out:** every historical day is in the sample, and BL-083 already looked at these days for other
  triggers, so no period is unseen. The rules have no tuned parameter, so there is nothing to fit. The
  unseen test is the forward run (Phases 2–4): a rule that passes Phase 1 is still unproven until
  its forward read-out.
- **Will not run:** a rolling window, windows other than 60 and 30 minutes, other narrowness
  thresholds or k, a ₹50-premium or a short template, SENSEX, the exhaustion rule, any LLM in the
  loop, any search over parameters, (c)'s trades if its gate fails.
- **Done when:** this block is in a commit, named in the Log, before `research/bl119/` holds a run.

### Phase 0b — Amendment 1 (2026-10-18, the owner's answers on "Start BL-119"; committed before any run)

Owner's answers (numbered as the open questions below): Q1 "60 candles" means **a rolling 60-bar range at any
time**, not only the opening window; Q2 the template is **both**, as two separate arms; Q3 **NIFTY only**
(default kept); Q4 momentum exhaustion is **left out for now**. A fifth question, raised by the assistant:
**add 2019-02-11 → 2021-12-31 as an unread confirmation period**, answered yes. This amendment replaces Phase 0's
rule definitions with the rolling rule below. Everything else in Phase 0 stands (universe filters, costs,
look-ahead discipline, the hold-out idea) except where restated here. Nothing had been run when it was
committed.

**What it replaces.** Phase 0's opening-window arms (a and b), their controls (a0, b0), the analog filter (c)
and the two personality subsets are **not run in Phase 1**; each is a dated block if wanted later (the
personalities need the blocked-dates CSV, open question 6). The default "Template" and "First rules"
paragraphs above are superseded by this block.

- **Hypotheses.** L: a close beyond a narrow, just-completed 60-bar range is followed by more movement in its
  direction than on ordinary days, enough for a long ATM option to pay its charges. S: the same break is a
  premium spike that decays, so selling a Widesl at it beats selling the same Widesl at that minute on
  ordinary days. They are opposite bets on the same events.
- **Definitions (one each; any other value is a new dated block):**
  - *Bars:* NIFTY index 1-minute bars, completed bars only; bar index j, 09:15 = 0.
  - *Window:* for bar j, W(j) is the 60 completed bars j − 60 … j − 1, all inside the session (so j ≥ 60,
    the bar stamped 10:15). H(j) is the highest high in W(j), L(j) the lowest low, width w(j) = H(j) − L(j).
  - *Baseline:* b(j) is the median of w at the same bar index j (the 60-bar window ending at the same minute)
    over the previous 20 sessions. A session without that bar is skipped; with fewer than 15 usable
    sessions there is no event that day (counted). Only index bars of earlier sessions are read, including
    sessions outside a judged period; no trade outcome is read for the baseline.
  - *Narrow:* w(j) < **0.70** × b(j). The 0.70 is the assistant's choice for "clearly tighter than usual"
    and is not tuned; control a0 shows what the condition adds.
  - *Break:* the close of bar j is above H(j) (up) or below L(j) (down).
  - *Event (arm a):* the first bar j from 60 to 285 (stamps 10:15 to 14:00) at which the window is narrow
    and a break holds. One event per day; its direction is the side of the break. *Entry:* the minute after
    the breaking bar (entry label = bar j + 1, last 14:01; the engine prices an entry at T with the close of
    the bar ending at T).
  - *Control a0:* the first break in the same window with no narrowness condition. Reported, not judged.
- **Templates (the same events traded two ways, so each arm has the same comparators):**
  - **Arm L, long:** buy one ATM option of the nearest weekly, a call after an up-break and a put after a
    down-break; leg stop 25 % of the entry premium, trailing stop [1, 1] points, overall stop ₹2,000, exit
    15:14 (the Buy family's management, without its own range-breakout leg).
  - **Arm S, short premium:** the live Widesl (`strategies/rotation/N_wide_1202.yaml`: OTM1 call and put sold,
    115 % leg stops trailed 15/10, overall stop ₹2,500, exit 15:28), 1 lot a leg, entered at the same
    minute whatever the direction. *This is the assistant's reading of "both"*: the opposite trade on the
    same events. If the owner meant "sell when the range holds" (no break at all), that is a different
    hypothesis and a dated block, not this arm.
  - Legwise engine, `lot_sizing: current`, sizing date 2026-10-12, the early reference wrapper before
    2024-10-03. Rupees per strategy.
- **Periods.** **A** 2022-01-03 → 2024-10-08 and **B** 2024-10-09 → 2026-10-08 (*superseded 2026-10-28,
  before any run: B ends 2025-12-02 for both arms; Log*): the screening periods
  (BL-083, BL-091 and BL-110 read these days for other rules, so neither is unseen; the rule has no tuned
  parameter, so nothing is fitted on them). **C** 2019-02-11 → 2021-12-31: weekly expiries begin in the
  lake on 2019-02-11 (nearest expiry 2019-02-14); about 740 usable weekday sessions; **read once**, only
  for an arm that screen-passes in A and B, and unread by this programme. 2015-01 → 2019-02-08 is
  monthly-expiry only (100-point strikes in 2016) and is not used. Data caveats for C: vendor option bars
  imported later (BL-034); `lot_sizing: current` makes a rupee stop a different number of points at 2019
  index levels; COVID in 2020. Before C is read: five days inspected by hand against the raw bars and the
  ATM contract coverage at the entry minute counted; a day with no priced ATM contract is excluded and
  counted, never filled.
- **Comparators (amended from Phase 0; same method, causal):**
  1. **Causal placebo:** the same template and side at the same entry minute on the 20 nearest days (10
     before, 10 after) of the same period on which the rule had **not fired at or before the event's fire
     minute** (no event all day, or a later one). Phase 0's "days with no event of that arm" reads the rest of
     the day and was shown to bias a short-premium placebo (BL-091 review); it is replaced.
  2. **Random minute:** the same template and side on the event days at an entry minute drawn from the
     pooled entry minutes of the cell's own events (time of day matched), 200 draws, seed 20261018 plus a
     per-cell offset. It is conditioned on the event day, so a random minute before the break benefits from
     hindsight (BL-124 Log): test 3 is informative and the kill rests on tests 1 and 2.
- **Costs:** as Phase 0: net = gross minus the BL-063 charge model on the recorded trades; slippage 0.5 % and
  1 % a fill as a sensitivity, not in the rule. If `charges.py`'s date table does not cover 2019–2021, C is
  read after ₹20 an order and labelled so.
- **Pass / kill rule (two judged arms, so the t bar is 2.5), for each of L and S, in A and in B
  separately:**
  1. mean **net** per trade > 0;
  2. event minus the causal placebo > 0, day-clustered t ≥ **2.5**;
  3. the event mean above the 95th percentile of the 200 random-minute means.
  **Screen pass** = all three in A **and** in B. **Kill** = test 1 or the sign of test 2 fails in A or in B.
  **Inconclusive** = a period has fewer than 40 event days, or tests 1 and the sign of 2 hold but t < 2.5 or
  test 3 fails. A screen-passed arm is read **once** on C with the same three tests (t ≥ 2.5); the C verdict
  stands, and **pass = screen pass and C pass**. A killed or inconclusive arm does not read C.
- **Look-ahead check (adds to Phase 0):** a rule at bar j reads bars ≤ j and earlier sessions only; a
  truncation test (the detector on the series cut at j gives the same event, cut at j − 1 none); the
  baseline never reads the event day or later; placebo selection reads bars up to the entry minute; an
  independently written implementation must agree on real days; entry is at j + 1.
- **Counted tries:** eight cells (arms aL, aS, a0L, a0S in A and B; four judged), plus one read of C per
  screen-passed arm. Lineage disclosed: BL-083 (four triggers), BL-091 (31 arms), BL-101, BL-123 and BL-124
  read these days for other rules; BL-124 found a tight-stop long straddle loses on ordinary days
  (−₹170 to −₹381 per straddle), which is the bar arm L's placebo sets.
- **Reported, not judged:** events by year, half-year, hour and direction; expiry day versus other days;
  share of days with an event; the share of windows that are narrow; arms a0L and a0S.
- **Will not run:** other window lengths (60), other narrow thresholds (0.70), other baselines, the
  opening-window arms, the analog filter, the personalities, momentum exhaustion, SENSEX, other templates
  or stops, a short arm on days the range holds, C before the screen, any parameter search.
- **Done when:** this amendment is in a commit, named in the Log, before `research/bl119/` holds a run.
- **Review notes, 2026-10-24 (nothing above is changed; see the Log):** the random-minute test favours short
  trades, so for arm S test 3 is easier to pass than it reads; period B contains P1 (**answered 2026-10-28:
  B ends 2025-12-02 for both arms**, see the Log); and arm S sells at the break, which may not be what the
  owner meant by "both" (still open).

### Phase 1 — Event study (research only, a few hours of compute)

- **Tasks:** `research/bl119/events.py` (the five arms' first break per day from the lake's index
  bars), `analog.py` (path vectors, neighbours, the gate), `simulate.py` (the single-leg template at
  each event, placebo and random-time minute, reusing `research/bl083/simulate.py`'s per-day loading;
  trades recorded for charges), `study.py` (the read-out). Templates live under `research/bl119/`,
  never in `strategies/legwise/` (which `obt daily` runs in full). No engine change.
- **Sanity checks before any result is read:** (i) the maximum bar timestamp a rule read is ≤ its
  firing stamp; (ii) a placebo is never the event day or an event day of the same arm; (iii) five
  events checked by hand against the raw bars: break minute, side, entry price; (iv) one trade's
  charges equal a hand calculation; (v) every analog neighbour is dated before the event.
- **Deliverables:** `out/events.csv` (how often each fires, hour, side, by year), the read-out tables,
  the verdict per arm in this item, and `research/options/common/rule-agents.md` (the findings page,
  per the research README) in the same commit.
- **Done when:** the verdict for (a) is written, period A then B read once each; arms b and c as the
  rule says. **If (a) is killed, nothing in Phases 2–5 starts for it**; (b) or (c) passing alone makes
  it that arm's item. A kill is a valid finish.

### Phase 2 — Agent runtime and nightly forward scoring (only for arms that passed)

- **Tasks:** `src/option_backtesting/agents/`: an `Agent` with `on_bar(state) -> Order | None`, the
  personality filters as a pure function (the frozen engine's stages, ported), the rule as registered,
  the template. A scheduler job `agents-nightly` (after `options-rotation-nightly` 19:45 and the T1
  update 21:00; about 21:15) runs every agent over each new collected day, and records each firing and
  its result hash-chained (`journal.py` reused) under `TRADING_DATA_ROOT/agents/`, with the rule's
  commit and a fingerprint of its settings. Private Telegram, one evening line.
- **Honest limit:** nightly scoring recomputes the firing after the close, so it is forward in time but
  not recorded before the entry; only Phase 4's live record is.
- **Done when:** a past day replayed through `on_bar` gives the same event and entry as Phase 1's
  study for 20 days, and the job has run 10 evenings.

### Phase 3 — Evening retrospection

- **Per trade, by code (the evidence).** The data pack: the rule's state at the break (range, width
  against the 20-session median, minutes since the window ended, VIX open, DTE, analog score), the
  path after entry (best and worst excursion in ₹ and in index points, time to the best, exit reason
  and time), the index's move to 15:14, the day's placebo mean, and day context (previous day
  expanded or quiet per BL-110, expiry day, calendar event). **Tags**, defined here before any run:
  `FALSE_BREAK` (the index closes back inside the range within 10 minutes), `STOP_TIGHT` (stopped out,
  and the same leg held to 15:14 would have finished above entry), `THETA_BLEED` (the index moved with
  the trade, held to the exit, and the premium still lost), `NO_FOLLOW_THROUGH` (the index's best
  excursion after entry under half the range width), `LATE_ENTRY` (entered after 12:30),
  `OPPOSITE_BREAK` (the other side of the range also broke that day), `EXPIRY_DAY`, `EVENT_DAY`.
- **Per trade, by an LLM (the narrative).** `claude -p` (owner's plan, no key) reads the data pack and
  the tags and returns strict JSON: at most 120 words on why, and at most two free-text hypotheses.
  The prompt file's hash and the model id are stored with the output. It never sees a later day and
  never changes anything. A failure to run costs the narrative only; tags are written first.
- **The rule that stops a story becoming a rule:** a proposal must rest on a tag from the list above
  that has at least 20 trades with a different net mean from the rest. An LLM hypothesis alone never
  creates a proposal. A new tag is a dated block and counts forward from its commit.
- **Deliverables:** `agents/retro/<day>.json`, a weekly tag table in the evening message, a section on
  the Live page when BL-117's page can carry it.
- **Done when:** 10 evenings written, and the tags for a replayed past day match a hand reading on 5
  trades.

### Phase 4 — Live paper (needs BL-117 Phases 2 and 4)

- **Tasks:** the same `Agent` on BL-117's live `BarSource` and paper desk: the firing is journalled
  **before** the entry fill, with the bar-rule fill and the quote fill (bid for a sell, ask for a buy)
  both logged. The slippage page of BL-117 Phase 4c is the cost input.
- **Done when:** 10 live days match the nightly scoring on event, side and entry minute, each
  difference explained.

### Phase 5 — Forward read-out and the challenger loop

- **Forward read-out:** Phase 1's three tests on forward events only, read once at the later of 60
  trading days and 30 events per agent, t ≥ 2.0, never earlier. Expect it to be hard (BL-058's Log
  says the same of a 60-day rule); the run is evidence and a behaviour test first.
- **Monthly step:** at most two proposals, each an `_EXPERIMENT.md` block resting on a counted tag,
  approved by the owner, then run as a **challenger beside its parent** from the block's commit. A
  challenger replaces its parent only when, over at least 30 paired events and 60 sessions, the 90%
  lower bound of the paired difference per trade is above zero and its drawdown is no worse. At most
  two challengers per parent. Running agents never edit themselves: the frozen engine's approval path
  is kept in spirit, and every birth and death is logged and counted.
- **Done when:** the first read-out is written here and in `rule-agents.md`.

## Risks

- **Few events.** If a rule fires on a quarter of days, that is about 15 events a month: every
  forward verdict is slow, and a month's post-mortems hold only a few trades. The 20-trade minimum on a
  tag means the first proposals arrive after months.
- **The breakout is a detector of movement.** BL-083 found the triggers that worked caught days with
  more range, and the gain depended on the template. A pass here may be "a day with movement" and not
  "an entry timing"; the random-time control exists to tell them apart.
- **A narrow range is a prior against.** BL-110 reads a narrow opening range as a quieter day; arm a0
  tells us whether narrow helps or hurts the long option.
- **Charges.** The Buy shape alone loses after charges; the rule must beat them with one trade a day.
- **Narrative over evidence.** The LLM's post-mortems are persuasive by construction; the counted-tag
  rule is the guard.
- **`claude -p` unattended.** It may not run under the scheduler (login, plan limits); the tags do not
  depend on it.
- **Regime dependence.** BL-083's Dir edge appeared only from mid-2024; each rule's result is shown by
  half-year as well as by period.

## Open questions (for the owner, when started)

**Answered 2026-10-18 (on "Start BL-119"; recorded in Phase 0b):** 1 → a rolling 60-bar range at any time;
2 → both templates as two arms; 3 → NIFTY only (default kept); 4 → left out for now. A fifth question the
assistant raised, whether to use the 2019–2021 data as an unread confirmation period, was answered yes.
Questions 5 (the evening post-mortem) and 6 (blocked dates) belong to later phases and stay open.


1. **"60 candles":** 60 one-minute bars from the open (my default), 60-minute candles (a daily-scale
   consolidation, far fewer events), or a rolling 60 bars ending at any minute (closer to your words;
   needs a fixed definition of "tight" and is a dated block 2 if (a) shows any life)?
2. **Template:** a long ATM option (default), or sell something when the range holds?
3. **NIFTY only** at first (default)?
4. **Exhaustion:** a form BL-091 and BL-083 did not test, for example the **failed breakout**: a break
   whose close returns inside the range within N minutes, then trading the other way. Name one, or
   leave it out for now.
5. **The evening post-mortem on your plan** (`claude -p` at about 21:30): yes, and is one Telegram line
   a day enough?
6. **Blocked dates** (RBI policy, Budget): one committed CSV shared with BL-117's Calendar-veto. Who
   keeps it current?

## Log

- 2026-10-18 — created from the owner's voice note. Owner left the three template, rule and index
  questions open and said to pick; the defaults above are mine and may be overruled before any run.
  Written after reading BL-083, BL-091, BL-022, BL-110, `research/options/common/intraday-state.md`,
  the Buy research pages, `rotation/triggers.py`, `research/bl083/`, the frozen personality filter
  and evolution engine, and BL-117. Planning only: no code, no runs.
- 2026-10-18 — **Started by the owner** ("park BL-120 and BL-121 and move on to the BL-119 range-breakout
  rules"; those two were renumbered BL-123 and BL-124 and parked). Read before starting: this item, BL-083,
  BL-091, BL-110, `research/bl123` and `research/bl124` (the series, placebo and trade helpers), the lake's
  coverage. Findings that changed the plan: the lake holds NIFTY option bars back to 2014 with weekly
  expiries from 2019-02-11, so 2019-02-11 → 2021-12-31 (about 740 usable sessions) is unread by this
  programme and becomes the confirmation period C; the strategy tester another session is building
  (`ruletest/`, uncommitted in the main checkout) is not needed for Phase 1, which stays a research script.
  Owner's answers recorded in Phase 0b. Amendment 1 committed before any run.
- 2026-10-24 — **Review of PR #307 (Opus); caveats and open questions added, no registered rule or result
  changed, nothing run.**
  - **Caveat on test 3 for arm S.** The random-minute draws are taken on the event days. For a long trade a
    random minute before the break buys before the move (hindsight, BL-124 Log), which makes test 3 hard to
    pass. For a **short** trade it works the other way: a random minute that falls before the break sells
    before the rise, so the random-minute means come out low and test 3 is **easier** to pass for arm S. The
    amendment's comparator 2 note covers only the long direction. Until the owner decides otherwise, read a
    pass of test 3 on arm S as weak evidence (it can veto arm S; it adds little when it holds). Options, both
    rule changes and so a dated block before Phase 1: test 3 can only veto arm S and never counts toward its
    pass, or S's random minutes are taken from non-event days.
  - **Open question for the owner: period B contains P1.** B runs 2024-10-09 to 2026-10-08, which includes P1
    (2025-12-03 to 2026-10-08), the one period BL-091 (R3 / F1450, TODO row 3.26.6) and BL-123 keep unread.
    Arm S trades that same live Widesl across P1. Choose one before Phase 1: **(a)** end B at 2025-12-02 for
    arm S (and keep it so for L, or only for S), or **(b)** record in BL-091 and BL-123 that P1 is consumed
    for Widesl rules. Phase 0 on `main` already had this B; the Widesl arm is what makes it matter. Not
    decided here. **Answered by the owner 2026-10-28: (a) for both arms** (Log, 2026-10-28).
  - **Confirm with the owner: does arm S sell at the break?** Open question 2 asked "a long ATM option
    (default), or sell something when the range holds?" and the answer was "both". Arm S sells **at the
    break**, which is the assistant's reading (Phase 0b says so); "sell when the range holds" (no break) is a
    different hypothesis that Phase 0b leaves to a later block. Confirm before Phase 1 that arm S is wanted
    as registered.
  - **Pre-registration evidence for the lineage cited above:** BL-123 and BL-124 were registered in commits
    `8e5918e4`, `321680aa` (BL-123) and `dee24559` (BL-124), which exist on
    `origin/research/bl121-opening-straddle-break` (this PR squashes them).
- 2026-10-28 — Owner answered the period B question (asked in chat, 2026-10-28): **end period B at
  2025-12-02 for both arms**, L and S, so P1 (2025-12-03 → 2026-10-08) stays unread for BL-091 and BL-123.
  This supersedes B's end date of 2026-10-08 in Phase 0 and Amendment 1 (B is now 2024-10-09 → 2025-12-02);
  nothing has run, so no result is affected. Still open, not answered here: whether arm S sells at the break
  or when the range holds, the test 3 caveat for arm S, and open questions 5 and 6. Status unchanged.

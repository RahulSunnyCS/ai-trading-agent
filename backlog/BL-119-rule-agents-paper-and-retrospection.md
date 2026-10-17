# BL-119 — Rule agents: the owner's rules trade on the index as paper trades, a post-mortem every evening, and agents that are replaced by better ones

| | |
|---|---|
| **Priority** | P1 — the owner's main aim for the live work (2026-10-18): agents that follow rules he gives, trade them on live data as paper, retrospect, improve |
| **Status** | Planned (pre-registration in Phase 0; nothing run) |
| **Type** | feature + research |
| **Area** | options, agents, scheduler |
| **Created** | 2026-10-18 |
| **Depends on** | BL-083 (event-versus-placebo method, trigger code), BL-022 (analog days), BL-110 (range persistence), BL-117 Phases 2 and 4 (live feed, paper desk: needed only for Phase 4 here), BL-063 charge model |
| **TODO.md row** | — (filled in when started) |

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
  2022-01-03 → 2024-10-08, **B** 2024-10-09 → 2026-10-08. Sessions after the data cut-off (the last
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

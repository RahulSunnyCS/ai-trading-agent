# BL-083 — Event-triggered intraday entries: fire a strategy the minute a condition is met, overriding the next scheduled pick

| | |
|---|---|
| **Priority** | P2 — options research; a new object (entry timing), not another weighting of the fixed grid |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-081 (state table and its negative on fixed-start variants), BL-058 (journal), the legwise engine, BL-071 data (2022–24 NIFTY) |
| **TODO.md row** | — |

## Context

The owner's idea (2026-10-10). After 10:30 a background process watches the market every minute: pivot
levels reached with a trend, VIX direction and exhaustion (RSI), the ATM straddle's direction over the
last 30 minutes, the range stabilising. Each condition scores; when the score crosses a threshold the
matching strategy (Widesl, Dir, Buy) is entered **right then** — at 11:38 if that is when it happened —
and it replaces the next pick the 09:16 ranking had scheduled for later (say a Dir at 12:02). Nothing
else changes: same lots, same stops, same 15:28 exit.

Why this is a different test from BL-081. BL-081 asked "given the state at 10:30, which *fixed-start*
variant is best" and found nothing that repeats. The variants start on a 15-minute grid, so an 11:38
entry does not exist in the stored results. Entry timing can only be tested by re-simulating each day
with the engine from the trigger minute (`legwise` `simulate_day`, `entry_time` set per day), which costs
about 0.2 s per day-strategy and is well within reach: about 1,160 days × 3 strategy templates ×
(trigger + 3 placebo entries) ≈ 14,000 simulations ≈ 1 hour.

What is already in the repo: 1-minute NIFTY / SENSEX / India VIX bars (2015 / 2018 / 2015 →), NIFTY option
bars 2022-01 → and SENSEX 2024-10 → (so the ATM straddle at any minute is computable), the BL-081 state
table (`research/bl081/out/state_raw.csv`, bars ≤ the hour) and its label code, the engine with
per-minute MTM, the forward journal with hash-chained entries, the scheduler, Telegram. Live minute bars
come from Fyers' history endpoint (`FyersClient.minute_candles`), polled; there is no websocket in the
Python package (apps/server's websocket is frozen).

## Goal

A recorded answer, in this order:
1. **Event study.** When each trigger fires, what does the index do and what does each strategy type
   make from that minute to 15:28, against the same strategy entered at the same minute on days the
   trigger did not fire? This decides *which* strategy a trigger should fire, from data, not by hand.
2. **Override rule.** On trigger days, does the triggered strategy beat the pick the 09:16 ranking had
   scheduled next (lots conserved)? Does the basket with overrides beat the plain basket, in both the
   exploration and the confirmation set?
3. **Live POC.** If (2) holds for at least one trigger: a minute-poller from 10:30 to 14:00 that evaluates
   the triggers from completed bars, records a hash-chained journal entry when one fires (before any
   entry), sends the Telegram alert, and is then scored like any pick.

## Out of scope

Order placement (the repo places none; the owner deploys by hand on AlgoTest), a websocket feed,
tuned thresholds (one definition per trigger; a second definition is a new dated block), ITM/OTM
variations of the templates, the combined score before the single triggers have been read.

## Plan

### Phase 0 — Pre-register (before any run)

**Templates (3, the live shapes, 1 lot each in simulation):** Widesl = the `N_wide_*` / `S_wide_*`
strangle (OTM1, 115% SL trailed 15/10, ₹2,500 overall); Dir = the `*_dir_*` ATM pair (21% SL, one
re-entry at cost, ₹3,000 overall); Buy = the `*_buy_*` template. Entry = the minute after the trigger
bar completes (trigger on bar t means entry at the open of t+1); exit 15:28; `lot_sizing: current`,
sizing date 2026-10-12 as the journal.

**Triggers (4 singles, fixed definitions; all from bars ≤ t; index of the strategy's own underlying,
VIX shared):**

| id | fires at minute t when | owner's reading |
|---|---|---|
| T1 pivot-with-trend | spot crosses yesterday's classic P, R1 or S1 (first touch of that level today) **and** the move since open ÷ 14-session ATR has the same sign as the cross direction with magnitude ≥ 0.3 | "reaches a pivot level with a trend: reversal, breakdown or stall" |
| T2 VIX turn | VIX ≥ +2% vs its 09:15 open **and** VIX's 30-minute change ≤ −1% (it was up, it is now coming off) | "VIX went up, last 30 minutes decreasing" |
| T3 straddle turn + range stabilising | ATM straddle (09:20-ATM, nearest expiry) was up ≥ +5% vs 10:00 at some point since, is now ≤ −3% from its high **and** the last-30-minute spot range ÷ 14-session ATR is below the trailing-252-session median of that quantity at that hour | "straddle was going up, now decreasing, range stabilising → Widesl" |
| T4 RSI exhaustion | 5-minute RSI-14 crosses back below 70 after being above it, or back above 30 after being below, within the last 15 minutes | "exhaustion" |

Window: triggers are evaluated 10:30–14:00; the **first** firing of each trigger per day is the event
(one event per trigger per day); a trigger that never fires that day is "no event". Multiple triggers on
the same day are separate events in the event study; the override rule uses one per day (the earliest).

**Event study read-out (registered).** Per trigger × template × set: the mean P&L per lot from the
trigger entry to 15:28 on event days versus the **time-matched placebo** — the same template entered at
the same minute on the 20 nearest non-event days (10 before, 10 after) — reported with the number of
events and a day-clustered t. Also the index's forward move (to 15:28) and the straddle's forward change,
to see *what* the trigger catches. A (trigger, template) is a **lead** if the event-minus-placebo
difference has |t| ≥ 3 in the exploration set and the same sign with |t| ≥ 2 in the confirmation set.
With no lead the item closes at this phase.

**Sets.** Exploration = 2024-10-09 → 2026-10-08, both indices (≈ 480 days). Confirmation = NIFTY
2022-01-03 → 2024-10-08 (≈ 680 days), read only for leads. SENSEX has no confirmation data and is
reported as supporting evidence only.

**Override rule read-out (registered, phase 2).** For each lead (trigger → template), on list A's picks
(and B, C, REF): on an event day, the earliest lead trigger's template is entered at the trigger minute
and replaces the **next not-yet-started core pick** (the pending pick with the earliest start; if none is
pending the event is ignored); lots conserved; the Widesl minimum must still hold or the override is
skipped. Reported: events used per set, P&L of the overrides vs the picks they replaced, basket gross
and max drawdown vs the plain list, against two comparators: (a) a **random-time** control (the same
template entered at a random minute 10:30–14:00 on the same days, 200 draws), (b) a **random-day**
control (the override applied on 200 random day sets of the same size). **Keep** only if the basket
beats the plain list and both comparators' P90 in exploration **and** confirmation, and the replaced
picks' P&L is below the overrides' in both. Anything kept is a journal candidate, not an adoption.

**Combined score (phase 2b, only if ≥ 2 leads).** Score = number of lead triggers active at t (no
weights); fire at score ≥ 2. Same read-out. No other thresholds.

**Look-ahead check.** Trigger inputs are bars ≤ t (asserted); pivots and ATR use completed prior
sessions; the straddle series uses option bars ≤ t; entry is at t+1; the engine never reads beyond the
day. Placebo days are matched on calendar position only, never on outcome.

**Will not run:** other trigger definitions or thresholds, trigger windows beyond 10:30–14:00, entry
templates other than the three, per-variant fits, any live use before phase 3's own gate.

### Phase 1 — Triggers and the event study (research only, ≈ 1 h compute)
- **Tasks:** `research/bl083/triggers.py` (per day × index: the first firing minute of T1–T4, from the
  lake's 1-minute bars; reuses `research/bl081/state.py`'s loaders, ATR and RSI); `research/bl083/
  simulate.py` (engine runs: the template with `entry_time` = trigger + 1 minute, cached per day ×
  template × minute in `research/bl083/results/`; the placebo entries likewise); `event_study.py`
  (the table above, both sets).
- **Deliverables:** `out/triggers.csv` (how often each fires, at what hour, by year), `out/event_study.csv`,
  the leads table recorded in this item.
- **Done when:** three sanity checks pass — (i) a template simulated with `entry_time` 11:32 on a day
  reproduces the stored `*_1132` variant's P&L for that day (the engine path is the same); (ii) no trigger
  reads a bar after its minute (assert on max timestamp); (iii) the placebo for an event is never the
  same day.

### Phase 2 — The override rule (research only, ≈ 1 h)
- **Tasks:** `research/bl083/override.py` over lists A / B / C / REF's picks files for both sets; the two
  comparators; the combined score if ≥ 2 leads.
- **Done when:** the read-out table is in this item with the keep / drop verdict per (trigger, list).

### Phase 3 — Live POC (only if phase 2 keeps something; code, no money)
- **Poller:** a scheduler job `options-rotation-watch`, weekdays 10:30–14:00, every minute: pulls the
  day's 1-minute NIFTY / SENSEX / VIX candles (`FyersClient.minute_candles`, completed bars only) and the
  ATM CE / PE candles for the straddle (re-resolving the ATM when spot moves a strike), recomputes the
  kept triggers, and on the first firing writes a journal entry (`kind: override`, the trigger, the
  minute, the template, the pick it replaces, the hash chain as `obt rotation pick`) **before** sending
  the Telegram alert. Idempotent per day; if Fyers is down it logs and does nothing (an alert is never
  back-dated).
- **Scoring:** the nightly update scores the override from its entry minute with the same engine, next to
  the 09:16 basket; `obt rotation show` lists both.
- **Operational truth to state in the item:** the alert → owner → AlgoTest path takes minutes; the
  journal records the trigger minute and the owner records the actual fill time; the gap is measured, not
  assumed away. If the gap is routinely > 5 minutes, phase 2 must be re-read with entry at t + 6.
- **Done when:** a dry-run week records triggers with no money, the chain verifies, and the measured
  alert-to-fill gap is in the item.

## Technicalities to decide before phase 1 (answers to be recorded here)

1. **Straddle definition live vs backtest.** Backtest uses the 09:20-ATM straddle of the nearest expiry
   with bars; live must use the same contracts (resolved at 09:20, not re-centred) or the trigger drifts.
2. **ATM re-centring for the Dir template.** Dir enters ATM at the trigger minute; the simulation does
   this naturally; live needs the strike chosen at fill time, which AlgoTest does.
3. **Expiry days.** T3's straddle thresholds are percentage-based; on expiry day the straddle is small and
   noisy. Report expiry days separately in the event study rather than excluding them.
4. **Multiple events.** First event per trigger per day; earliest lead trigger wins the override. Record
   how often two triggers fire within 15 minutes (a combined-score symptom).
5. **One override per day.** Registered. A second override is phase-2b material at most.
6. **Minimum lead time.** An override needs a pending pick starting at least 15 minutes later than the
   trigger; otherwise the pick is already in play and the event is ignored.
7. **Sample size.** Expect each trigger to fire on 15–40% of days: 70–190 events in exploration. Enough
   for pooled means, not for per-variant fits. If a trigger fires on < 30 days it is reported, not judged.

## Risks

- **Many definitions, one chance.** Four triggers × three templates × two sets is already 24 cells;
  the exploration / confirmation split and the |t| ≥ 3 then ≥ 2 bar are the control. A second round of
  definitions needs a new dated block.
- **Engine time.** 14,000 simulations ≈ 1 hour if each day's bars are loaded once per index
  (`research/bl080/run_batch.py` pattern); loading per simulation would take a day.
- **The human in the loop.** Minutes of latency can erase an entry-timing edge; phase 3 measures it.
- **BL-081's finding.** Pooled morning states did not order the fixed-start variants; a trigger can
  still work because it moves the entry minute, but the prior is modest.

## Open questions

- Should T1's level set include R2 / S2 and the previous day's high / low? (Registered as P, R1, S1 only.)
- Does the owner want Buy as a trigger template at all, or only Widesl and Dir?

## Log

- 2026-10-10 — created from the owner's event-triggered idea (plan only; Fable designs, Sonnet runs).

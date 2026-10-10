# BL-083 — Event-triggered intraday entries: fire a strategy the minute a condition is met, overriding the next scheduled pick

| | |
|---|---|
| **Priority** | P2 — options research; a new object (entry timing), not another weighting of the fixed grid |
| **Status** | Done (phases 1–2): two Dir leads on the last two years, not in 2022–24; phase 3 (live poller) not started |
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
(trigger + placebo entries) ≈ 14,000 simulations ≈ 1 hour.

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

## Result (2026-10-10, phases 1 and 2; re-run after the code review of PR 163)

**Review corrections applied.** The first run evaluated the confirmation set only from 2022-09-09 (the 252-session
history T3's median needs was not loaded before 2022-01-03); the history now starts 2020-09 and the confirmation
set is the full 2022-01-03 → 2024-10-08. t is now day-clustered as registered (same-day NIFTY and SENSEX events
are one observation); the random-day control is the registered one (the random day's own pending pick is
replaced); random minutes run 10:31–14:00; the SENSEX 11:32 reproduction was added to the sanity check.

**Triggers** (first firing per day, 10:30–14:00; entry the next minute):

| trigger | explore NIFTY | explore SENSEX | confirm NIFTY | median entry |
|---|---|---|---|---|
| T1 pivot cross with trend | 109 | 99 | 152 | 12:07 |
| T2 VIX turn | 148 | 149 | 193 | 11:08 |
| T3 straddle turn + range stabilising | 272 | 249 | 347 | 11:22 |
| T4 RSI exhaustion | 292 | 283 | 396 | 11:40 |

Sanity checks passed: each template simulated at 11:32 reproduces the stored 11:32 variant on 12 days for both
indices and all three families (72 of 72); trigger inputs are slices that end at the firing minute (by
construction, and the entry minute is asserted to exist).

**Event study** (event minus the same template at the same minute on the 20 nearest non-event days; ₹ per lot;
t day-clustered). Explore = 2024-10-09 → 2026-10-08, both indices; confirm = NIFTY 2022-01-03 → 2024-10-08.

| trigger → template | explore diff (t) | confirm diff (t) |
|---|---|---|
| T1 → Dir | **+754 (3.5)**, 130 days; NIFTY only +631 (2.6) | −20 (−0.1) |
| T4 → Dir | **+403 (3.95)**, 312 days; NIFTY only +440 (3.4) | +156 (1.7) |
| T4 → Buy | +84 (1.8) | **+287 (4.0)** |
| T1 → Buy | +58 (0.7) | −209 (−2.5) |
| T2 → Widesl | −215 (−1.3) | −139 (−1.1) |
| T2 → Dir / Buy | +76 (0.4) / −34 (−0.6) | −210 (−1.4) / −157 (−1.6) |
| T4 → Widesl | +108 (1.3) | −199 (−2.5) |
| T3, all templates | |t| ≤ 0.6 | |t| ≤ 1.4 |
| T1 → Widesl | +199 (1.1) | +58 (0.4) |

Registered bar (|t| ≥ 3 in explore, same sign with |t| ≥ 2 in confirm): **no lead**. Owner's rule (the last two
years decide, confirmation is information): the leads are **T1 → Dir and T4 → Dir**.

### Why some worked and some did not (analysis.py)

| trigger | range after entry vs placebo (explore / confirm) | what it catches |
|---|---|---|
| T1 pivot with trend | ×1.20 / ×1.19 | a trend day that is continuing |
| T2 VIX turn | ×1.27 / ×1.09 | a volatility day: the straddle rises 2.3% afterwards |
| T4 RSI exhaustion | ×1.21 / ×1.13 | a stretched move that keeps going |
| T3 straddle turn | ×1.03 / ×1.03 | nothing: same range as ordinary days |

- **The triggers that work as detectors find more movement, not less.** After T1, T2 and T4 the index's
  realised range to 15:28 is 9–27% larger than on placebo days; T3 is indistinguishable (×1.03), which is why
  it shows no edge in any template. The failure of T3 is a failure of the trigger, not of the templates.
- **Whether a strategy gains from that movement depends on its shape.** Dir (ATM straddle sold with 21% stops
  and one re-entry) behaves as a trend harvester: it gained +754 / +403 per lot after T1 / T4 in explore, with
  the stop-out share no higher than on ordinary days (T1 5% vs 8%, T4 8% vs 10%) and a milder worst excursion
  (−946 vs −1,005; −1,025 vs −1,081). The OTM1 Widesl (115% stops) is the short-volatility shape the extra
  movement hurts: after T2 it is stopped out 27% of the time against 15% (worst excursion −1,305 vs −1,016) and
  loses −215; after T4 it is stopped out 15% vs 10%. Buy is a long-movement shape: it gains after T4 in both sets
  (+84, +287) because its placebo is poor (12–25% of ordinary entries win).
- **Where the Dir gain comes from (T1).** Continuations through the level: S1 broken downward +1,166 per lot
  (71 events), R1 broken upward +782 (63), P broken downward +621 (28); crosses against the day's direction
  are small (S1 up +55 on 9 events, P up +92 on 27). Timing: entries 10:31–11:30 +882 and 12:31–13:30 +1,394; after
  13:30 about 0. It is a broad effect, not a few days: 67% of T1 events and 57% of T4 events beat their
  placebo, the top five events are 29% and 20% of the total, and the mean without them is +549 and +326.
- **Why the confirmation failed.** The Dir edge is regime-dependent. T1 → Dir by half-year (₹ per event):
  2022H1 −1,162, 2022H2 +30, 2023H1 −84, 2023H2 +24, 2024H1 +686, 2024H2 +1,355, 2025H1 +1,169, 2025H2 +238,
  2026H1 +577. It appears from mid-2024. T4 → Dir is positive in 7 of 10 half-years but small before 2024H2.
  Ordinary Widesl entries also changed character: the 2022–24 placebo for T4 → Widesl won 91% of the time,
  so any event entry looked worse (−199), while in 2024–26 it won 88% and the event still beat it (+108).
- **What this does not show.** It does not show a timing edge as such. A Dir placed at a random minute
  10:31–14:00 replacing the same pick also gains for some lists in explore (median −₹1k A, +₹13k B, +₹11k C,
  −₹4k REF), so part of the gain is "a Dir in place of that Widesl or Buy in this regime", not the trigger minute. The two leads were
  chosen from 12 cells in the same two years they are judged on.

**Override rule** (phase 2): the earliest lead event of the day fires a Dir on its index at the entry minute and
replaces the next not-yet-started core pick (lots conserved, Widesl minimum kept; 54–57 of 302 explore events and
56–64 of 395 confirm events could be applied, the rest had no pending pick or would break the minimum). Random
controls: 200 draws each; random time = a random minute 10:31–14:00 on the same days; random day = the same
minute on a random non-event day, replacing that day's own next pending pick.

| set | list | plain | with override | gain | max DD (plain) | random-time P90 | random-day P90 | above both |
|---|---|---|---|---|---|---|---|---|
| explore | A | 8,00,921 | 8,20,902 | +19,981 (+2.5%) | −72,667 (−72,667) | +30,383 | +14,562 | no |
| explore | B | 8,08,532 | 8,87,921 | +79,389 (+9.8%) | −82,706 (−82,706) | +45,514 | +9,604 | **yes** |
| explore | C | 8,40,846 | 8,62,340 | +21,494 (+2.6%) | −74,104 (−83,817) | +39,352 | +19,822 | no |
| explore | REF | 7,20,873 | 7,75,428 | +54,556 (+7.6%) | −86,485 (−88,366) | +27,457 | +23,301 | **yes** |
| confirm | A | 12,20,482 | 12,10,009 | −10,473 | −64,181 (−66,632) | +18,416 | +7,124 | no |
| confirm | B | 12,39,935 | 12,13,186 | −26,749 | −63,238 (−64,402) | +14,340 | +10,848 | no |
| confirm | C | 11,58,525 | 11,48,553 | −9,972 | −53,755 (−55,282) | +20,366 | +9,425 | no |
| confirm | REF | 10,13,627 | 10,29,895 | +16,268 | −53,378 (−56,329) | +43,828 | +15,424 | no |

**Read-out under the owner's rule.** On the last two years the override beats both controls for list B (+₹79k)
and REF (+₹55k) and does not clear the random-time control for A and C. In 2022–24 it loses −₹10k to −₹27k for A,
B and C and gains +₹16k for REF, below the controls everywhere. A journal candidate for a forward shadow run
(B and REF), not an adoption: the evidence is two years of one regime.

**Next (not done):** phase 3 (a minute-poller that records the trigger before any alert) is the way to get
unseen days; a cheaper first step is to score the triggers each evening from the day's bars in the nightly
update, so events accumulate without any live process.

Files: `research/bl083/triggers.py`, `simulate.py`, `event_study.py`, `override.py`, `analysis.py`.

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

None. Settled on 2026-10-10:
- **T1 levels: P, R1, S1 only** (my call, owner delegated). R2 / S2 and yesterday's high / low are a dated
  block 2 if T1 is a lead.
- **Templates: Widesl, Dir and Buy, all three from phase 1** (owner's call: there are situations where a
  trigger would point to Buy, so it is tested from the start). Buy as an override replaces a pending core
  pick like the other two, lots conserved; the Widesl minimum still applies.

## Log

- 2026-10-10 — created from the owner's event-triggered idea (plan only; Fable designs, Sonnet runs).
- 2026-10-10 — open questions settled (P / R1 / S1 only; Widesl and Dir templates first).
- 2026-10-10 — owner: keep Buy as a third template from phase 1 (reverses my earlier call).
- 2026-10-10 — **Owner's decision: "whatever wins in the last 2 years can be taken."** Leads are read on the
  exploration set alone (|t| >= 3), the 2022–24 confirmation is information only. That makes **Dir after
  T1 (pivot with trend)** and **Dir after T4 (RSI exhaustion)** the two leads (event minus placebo +₹754 and
  +₹403 per lot, t 4.3 and 4.5; confirmation +₹282 / +₹86, t 1.5 / 0.8). Phase 2 (override rule on lists A /
  B / C / REF) therefore runs for those two on the exploration set, against the random-time and random-day
  controls; the confirmation set is run alongside as information.
- 2026-10-10 — phases 1 and 2 run (results above).
- 2026-10-10 — `override: the owner (2026-10-10) decided that whatever wins in the last two years can be taken; the
  registered keep rule (explore AND confirm) is relaxed to the exploration set, confirmation is information.`
  Phase 2 ran past the registered lead bar under this override.
- 2026-10-10 — code review of PR 163 (Opus): 2 blocking findings fixed (confirmation set started 2022-09-09; a
  wrong sentence in the Result), non-blocking items applied (day-clustered t, registered random-day control,
  random minutes to 14:00, SENSEX in the 11:32 check, corrected random-time text); the pipeline was re-run and
  the Result rewritten, with the mechanism analysis added.
- 2026-10-10 — the nightly scoring step (the "cheaper first step" above) is built: `obt rotation triggers`, run by `obt rotation update` and isolated from it; parity with this study's trigger table is exact over 1,063 events (2025-06 → 2026-10); the forward store is `rotation/triggers/`. Reading the first verdict needs months of days: about 14 pivot events and 37 RSI events per index every three months.

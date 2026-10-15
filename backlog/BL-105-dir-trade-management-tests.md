# BL-105 — Directional trade management: profit lock/trail, roll the decayed leg, restart

| | |
|---|---|
| **Priority** | P2 — three management ideas for the Dir family; informative whatever the answer |
| **Status** | In progress (Phase 1 closed by the Phase 0 rule; engine roll built and reviewed; Phase 2 roll screen running) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-104 (the Dir cohorts, the scorecard, the tail gate, the pool); BL-009 (re-entry parity, for engine-exact Stage 2) |
| **TODO.md row** | 3.10.27 |

## Context

The owner (2026-10-15) asked to test three things on top of Directional, "first stage run and
analyse, then stage 2 if anything is good":

1. **Profit lock and trail.** Once the open profit of the day reaches a level (example: ₹4,000),
   put a stop at a locked profit (example: ₹2,000) and trail it as profit grows.
2. **Roll the exhausted leg.** When a sold leg has decayed to almost nothing, close it and sell the
   new ATM of the same side, so the straddle is whole again at the new spot ("get that leverage").
3. **Restart at a limit.** When a profit limit is reached, book everything and restart the
   directional algorithm at the new ATM.

What already exists and shapes the design:

- The engine has **no** overall trailing and no roll; the schema rejects both by design
  (`legwise/schema.py` header). It does have `overall.target_inr` (a flat profit exit) and a
  per-minute MTM curve on every `DayResult` (`mtm`, not persisted).
- `rotation/portfolio.py` already implements **lock / trail on a basket's path**
  (`apply_book`, `Trail`: `lock:A,B`, `locktrail:A,B,X,Y`, BL-095). One strategy is a basket of one,
  so idea 1 reuses it and needs no engine change for a screen.
- Idea 3 can be **composed from the existing engine**: run the strategy, cut it at the minute the
  limit is hit, then run the same strategy again with `entry_time` = the next minute (fresh ATM,
  fresh stops, same exit). No engine edit.
- Idea 2 **needs engine support** (a leg-level action on an index or premium trigger, with the
  overall stop still coupling the legs). It cannot be composed exactly from independent runs.
- The BL-104 machinery is reusable as is: `grid.py`'s cohort / cell / SHA pattern, `run_grid.py`
  (resumable, signed parts, day × cell series), `score.py` (gates, Martin, tail gate),
  `robust.py` (PBO, bootstrap vs the base, half-years, DTE / VIX / weekday strata).

Is it worth testing or a fluke of an idea? Worth testing, with low expectations. All three are
standard trade management with a mechanism, but none is a known edge, and each tends to trade
return for something else:

- **Lock / trail** on a short-premium day clips profit that is building by decay, so it usually
  gives up return for a smaller tail. It may help trend days. It is cheap and has few parameters.
- **Roll** puts risk back on after one leg has earned its money, which lifts both return and tail.
  It will likely fail the worst-day gate unless it is limited. It is the expensive one to build.
- **Restart** overlaps with what the rotation already does by entering at later slots, and it
  doubles charges. Lowest prior.

The defence against fooling ourselves is the same as BL-104: few cells, a fixed base, a registered
comparator, the bootstrap, the tail gate, and a count of every trial.

## Goal

For each of the three ideas, a yes / no on whether it improves the Dir family against its own
unmodified base, after charges, on the registered gates, and with what it costs in tail risk.
Nothing is adopted from this item; a survivor goes to Stage 2 (engine-exact) and then the paper pool.

## Out of scope

- Buy and Widesl (Dir only); changes to any strategy file under `strategies/rotation/`.
- Intraday triggers on index structure (BL-083's area); position sizing; hedging legs.
- Choosing a different base after seeing results.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** for the Dir family, each of (a) a rupee profit lock with a trail, (b) rolling a
  decayed leg to the current ATM, (c) restarting at the current ATM after a profit limit improves
  net ₹ per lot-day or reduces drawdown without worsening the worst-day tail, against the same
  strategy with no management.
- **Universe and bases (approved by the owner 2026-10-15):** NIFTY and SENSEX Dir at the seven
  BL-104 slots (09:17, 09:32, 09:47, 10:17, 11:32, 13:02, 14:32). Six bases per index and slot:
  strike {ATM, ITM1, ITM2} × leg trail {none, 10/5 %}, with leg stop 21 %, MTM stop ₹3,000,
  re-entry at cost once, exit 15:28, weekly expiry (the template's settings; ITM2 is added
  because it appears in 4 of the 8 tail-gated BL-104 Dir winners). Each variant is compared with
  its own unmanaged base at the same index and slot. All rupee levels are per one lot, day profit
  = realised plus open (the engine's MTM).
- **Variants (every value registered):**

  | Idea | Setting | Values | Variants |
  |---|---|---|---|
  | A1 cut at a profit target | T (₹) | 2,000, 3,000, 4,000 | 3 |
  | A2 profit lock | arm A, then close when profit falls back to A / 2 | A = 2,000, 3,000, 4,000 | 3 |
  | A3 lock and trail | as A2, then the lock rises A / 4 for every A / 2 more profit | A = 2,000, 3,000, 4,000 | 3 |
  | B roll the decayed leg | leg price ≤ f × its entry | f = 15 %, 25 %, 35 %, 45 %, 50 %, 70 % (owner, 2026-10-15) | |
  | | only after day profit ≥ ₹3,000, or at any time | 2 | |
  | | fresh stop on the new leg | 21 %, 30 % | |
  | | new leg strike | the base's own strike type (ATM bases roll to ATM, ITM1 to ITM1, ITM2 to ITM2) | 24 |
  | B′ roll to ATM | as B with the new leg at ATM, 21 %, profit ≥ ₹3,000; ITM1 and ITM2 bases only (an ATM base already rolls to ATM) | f = 15 %, 25 %, 35 %, 45 %, 50 %, 70 % | 6 |
  | C restart after a cut | after A1 target T, 1 or 2 restarts | T = 2,000, 3,000, 4,000 | 6 |
  | | after an A2 lock cut, 1 or 2 restarts | A = 3,000, 4,000 | 4 |

  A restart enters at the next minute with fresh stops at the base's settings (its own ₹3,000 MTM
  stop applies afresh); no restart or roll after 14:00 (roll: 13:30); one roll per leg. The
  restart comparator also includes the same strategy entered at the next later slot. The MTM stop
  is not varied here; a survivor's ₹2,000 / ₹3,000 / ₹4,000 sensitivity is a Phase 3 check.
  About 19 screen variants (A, C) per base now, 24 more roll variants per base (plus 6 roll-to-ATM on
  ITM bases) in Phase 2: about 4,000 cells in all. ATM, ITM1 and ITM2 are all bases: the screen is
  not ITM only.
- **Look-ahead check:** a trigger reads only the minute's own bar and earlier; a roll / restart
  enters at the next minute's open, as RE ASAP does. No trigger reads the day's final result.
- **Charges:** the BL-096 model on every order, including the extra ones from rolls and restarts.
  Slippage 0 in the screen; Stage 2 repeats at 0.25 % and 0.5 %.
- **Pass rule per idea, per cohort:** against its own base (same slot, same index): (1) block
  bootstrap (5-day circular blocks, 2,000 resamples, seed 20261012) 90 % lower bound of the daily
  difference > 0; (2) max drawdown and Ulcer no worse than the base's by more than 10 %;
  (3) worst day and worst-five-days no worse than 1.5 × the base's (the BL-104 tail gate);
  (4) at least 3 of 4 half-years not worse than the base; (5) the chosen parameters are on a
  plateau (neighbouring registered values within 70 % of its Martin); (6) the pooled PBO of the
  idea's cells ≤ 0.5. An idea passes if its best plateau passes in **at least 4 of the 7 slots of
  at least one index**, with the same parameters shared across those slots.
- **Kill rule:** an idea that fails the tail gate in most cohorts, or whose best cell is not on a
  plateau, or whose gain is under ₹25 per lot-day against its charges, is closed.
- **Hold-out:** none unseen (the same 2024-10-09 → 2026-10-09 window as BL-104). The protection is
  the pass rule, the trial count (~26 cells × the bases × 14 cohorts, stated in the Log), and a
  forward paper test for any survivor.
- **Will not run:** per-slot parameters; weekday-specific parameters; values outside the table;
  an engine change merged before the screen's verdict.

### Phase 1 — Screen on existing machinery (no engine change)

- **Tasks:**
  1. **Is there anything to act on?** From the stored day curves, the share of days on which open
     profit reaches each arm level A and each decay level f. If a trigger fires on fewer than 10 %
     of days, that idea is closed at this step with the numbers.
  2. Build `research/bl105/`: `paths.py` runs each base once per cohort and stores the per-minute
     MTM path and trades (the BL-095 path-cache pattern); `lock_trail.py` applies
     `portfolio.apply_book` to those paths; `restart.py` composes a second engine run from the cut
     minute; both feed the BL-104 scorecard and gates through a thin adapter.
  3. Charges for a cut day: the trades entered before the cut keep their two orders; positions
     closed at the cut are priced at the cut minute's close; trades entered after the cut are
     dropped (replay approximation, flagged `approx`).
  4. Run lock / trail and restart. Roll is not in this phase.
  5. Score with the BL-104 scripts (gates, Martin, tail gate, plateau); expiry-day vs other-day
     columns on every row; PBO per idea.
- **Deliverables:** `results/` tables per idea and a one-page read-out in this item's Log.
- **Done when:** each of lock / trail and restart has a pass or kill against the Phase 0 rule.

### Phase 2 — Engine support for roll, then verify the survivors exactly

- **Tasks:**
  1. Add an optional leg-level `roll` action to the legwise schema (trigger fraction, max rolls,
     cutoff), omitted from the spec hash while unset (the `RangeBreakout` serializer pattern) so no
     existing strategy or golden changes version.
  2. Implement it in `legwise/engine.py`: close the decayed leg at the bar's close, select the new
     ATM by the leg's own rule, enter at the next minute's open; the overall stop keeps coupling the
     legs. Frozen scenarios (`tests/golden/test_legwise_scenarios.py`) stay byte-identical.
  3. New golden scenarios for roll, including a roll that is stopped out and the overall stop
     firing across a rolled leg.
  4. Re-run Phase 1's survivors **through the engine** (lock / trail as an overall-trail field if it
     survives) and compare with the replay to the rupee; differences are logged.
  5. Run roll over the Phase 0 table.
- **Done when:** the golden suite is unchanged, the new scenarios pass, and the survivors have
  engine-exact numbers.

### Phase 3 — Robustness on survivors only

- **Tasks:** all 25 rotation slots with the shared parameters; slippage 0 / 0.25 / 0.5 %;
  `lot_sizing: historical` once; half-years; DTE, VIX and weekday strata; correlation of the managed
  strategy with its base and with the pool; NIFTY advisory run on 2022-01 → 2024-10.
- **Done when:** each survivor has a pass or fail on every Phase 0 condition.

### Phase 4 — Decision

- **Tasks:** a short owner read-out; a survivor becomes a variant in the BL-104 pool's paper
  universe (separate from the frozen 298), never an edit to a registered file.

## Risks

- **A replay is not the engine.** Phase 1 numbers are screens; only Phase 2's engine run is
  authoritative. The item says so on every Phase 1 table.
- **Roll adds risk, not edge.** It raises exposure after one leg has already paid. The tail gate and
  the "max rolls" cap exist for that; expect it to be the idea most likely to be killed.
- **Restart double-counts the rotation.** The rotation already enters at later slots; a restart may
  mostly reproduce a later-slot entry at higher charges. The read-out compares a restart cohort
  with the same-day later-slot base.
- **Re-entry parity (BL-009) is still open.** Bases that rely on re-entry at cost twice or ASAP are
  excluded; the restart's own re-entry follows the base's.
- **More cells on the same two years.** Nothing here is out-of-sample; a pass is a candidate for
  the forward test, not a result.

## Open questions

- The base set: only the templates, or also the BL-104 band winners (default: both).
- Whether the profit lock should act on **realised plus open** profit (default, matching BL-095's
  basket path) or on the open profit of the current legs only.
- Whether a rolled leg keeps the original leg's remaining stop level or gets a fresh stop % from the
  new entry (default: fresh, as RE ASAP does).

## Log

- 2026-10-15 — plan written from the owner's three ideas; nothing run; Phase 0 values registered in
  this item's table before any run.
- 2026-10-15 — owner approved the plan above with the defaults (profit levels ₹2,000 to ₹4,000,
  realised plus open, immediate restart at the next minute, decay 15 / 25 / 35 %). Strike axis
  widened to ATM / ITM1 / ITM2 from the BL-104 winners. Phase 0 values frozen here; Phase 1
  (A and C) builds first, B waits for engine support.
- 2026-10-15 — owner amended the roll trigger before any run: f = 15 / 25 / 35 / 45 / 50 / 70 %
  (was 15 / 25 / 35), and confirmed the screen runs ATM bases as well as ITM1 / ITM2, not ITM only.
  Phase 2 roll count rises from 12 + 3 to 24 + 6 per base.
- 2026-10-15 — **Phase 1 screen done** (1,680 cells, 488 days, 2024-10-09 → 2026-10-09; run
  12:28 IST). The cut replay was first checked against the engine's own profit-target exit: 75
  checks, 34 fired, 0 mismatches. How often the unmanaged base's open profit reaches a level (mean
  of 7 slots): ≥ ₹2,000 on 31–41 % of days, ≥ ₹3,000 on 16–28 %, ≥ ₹4,000 on 8–18 %, ≥ ₹6,000 on
  1–6 % (ATM lowest, ITM2 highest; NIFTY and SENSEX alike).

  | Idea | Result (mean change vs the base, per lot-day, 42 base-slot cases per index) | Pass rule |
  |---|---|---|
  | A1 cut at a target | NIFTY −79 / −35 / −10 at T = 2,000 / 3,000 / 4,000; SENSEX −103 / −16 / −2 | fails: gain < ₹25 and negative |
  | A2 lock at A / 2 | NIFTY −15 / −1 / +5 at A = 2,000 / 3,000 / 4,000; SENSEX −25 / −2 / −3 | fails: gain < ₹25 |
  | A3 lock and trail | NIFTY −17 / +2 / +5; SENSEX −28 / −2 / −2 | fails: gain < ₹25 |
  | C restart after a target | NIFTY −20 to −44; SENSEX −56 / −51 at T = 2,000, +26 / +33 at 3,000, +18 / +19 at 4,000 | fails: no setting passes in 4 of 7 slots (best 2 of 7, bootstrap lower bound below 0) |
  | C restart after a lock cut | −2 to −9 on both indices | fails: gain < ₹25 |

  **No setting passed the registered rule (0 of 228 index × base × setting cases; reproduced by
  `score_screen.py` from the stored series, which now also computes the cross-slot rule, the
  ₹25 kill, the neighbour plateau and a pooled PBO where an idea has at least six cells; the
  restart-vs-later-slot comparator is not computed).** The worst-day
  gate bound in 2 of 1,596 cases (SENSEX 09:17 ITM1 no-trail restart after a lock cut: worst day
  −6,970 against a base of −4,564; a restart re-opens risk, so it can lengthen the tail); every
  other variant is within 1.5 × its base.
  Lock / trail change almost nothing because the arm level is reached on a minority of days and
  the lock often sits near where the base would end anyway; cutting at a target gives up the
  decay that is the strategy's profit. One lead, **not a result**: SENSEX restart after a ₹3,000
  target gains ₹100–240 per lot-day in the 09:17–10:17 slots and loses ₹25–90 from 11:32 on,
  in both ITM1 and ITM2 and without the leg trail; its bootstrap lower bound includes zero, and a
  morning-only rule would be a choice made after seeing the result, so it needs its own registered
  item and the forward test before it counts. Roll (B, B′) is untested and still needs the Phase 2
  engine feature; it is the owner's remaining idea.
- 2026-10-15 — **PR 229 review (Opus)**: fixes and clarifications.
  - *Engine:* the roll's fresh stop and ATM override applied to every later entry of a rolled leg
    (an SL re-entry would inherit them). They now apply to the roll's own entry only, and a roll
    honours `no_reentry_after` like any re-entry. The first Phase 2 screen ran on the buggy engine
    for about an hour and was discarded; Phase 2 reruns on the fixed engine from zero.
  - *Tests:* the registered Phase 2 "done when" asked for new golden scenarios. The golden catalog
    is a fixed thirty named scenarios and unchanged; the roll is covered by ten unit tests
    (trigger, strike rule, ATM override, day-profit gate, cutoff, cap, fresh stop, re-entry
    interaction, failed selection, two legs in one minute, last minute, overall stop across a
    rolled leg) on top of the unchanged goldens and the byte-identical spec hashes of all 987
    existing strategy files.
  - *Phase 0 wording, as run:* a restart enters at the close of the cut minute (the engine's
    fixed-time entry convention, which is the next minute's start) and only when the cut is
    before 14:00, not at 14:00. Rolled legs share the leg's SL re-entry counter.

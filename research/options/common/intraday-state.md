# Options: intraday market state

**Status:** Tested · **Last updated:** 2026-10-22

## What it is

Using what the market has done since the open to change what is traded: pick the mix later in the
morning, re-time or drop picks that have not started, or enter a strategy the minute a condition
fires. State variables tried: India VIX's move, trend since open ÷ ATR, VWAP, ATR, RSI, pivot levels
and zones, the ATM straddle's move, and pairs of these. Every input uses bars up to the decision
minute only.

## Live value

None. The journal lists pick once at 09:16 and never look again ([BL-058][bl058]). BL-083's triggers
are scored each evening (`obt rotation triggers`, run by `rotation update`) to build a forward record;
nothing acts on them.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | At 10:00, VIX up ≥ 0.25 since 09:15 → 2 Dir + 2 Buy + 2 Widesl, else 4 Widesl + 1 Dir + 1 Buy | NIFTY, 2025-10-09 → 2026-10-08, before charges | **Killed** (+7.6% over always-directional, needed 10%; drawdown worse) | [BL-053][bl053] |
| BL-081 step 1 | 14 state variables + 3 pairs at 10:30, 11:30, 12:30, 13:30 for pending picks | P1, P2, P3 | **None passes**: no variable beats both label permutations and circular shifts in all three periods | [BL-081][bl081] |
| BL-081 block 1 | A "no-trade" column and a rupee sit-out gate | same | Inert: the no-trade column is picked on 0 days | [BL-081][bl081] |
| BL-081 block 3 | Re-score pending picks at each hour; swap / drop (owner's override) | explore 2025-01 → 2026-10; confirm 2022-04 → 2024-10 | Nothing kept under the registered rule (0 of 252 versions); state-blind re-timing does as well as state | [BL-081][bl081] |
| BL-083 | Enter at a trigger (pivot with trend, VIX turn, straddle turn, RSI exhaustion), replacing the next pending pick | explore 2024-10 → 2026-10 both indices; confirm NIFTY 2022-01 → 2024-10 | **No lead** under the registered bar; owner's rule keeps two Dir leads (below) | [BL-083][bl083] |
| BL-022 | The 20 nearest earlier sessions (path since the open ÷ ATR, gap, range so far, VIX, days to expiry; Euclid and DTW) at 10:30 / 11:00 / 12:00 as a rest-of-day range forecast, gating a skip / heatmap swap of Adaptive's pending picks | NIFTY, decide 2025-01 → 2026-10 (recent period decides, owner); 2022–24 and SENSEX reported | **Killed at the gate**: ρ 0.38–0.44 vs opening range 0.49–0.52 and VIX-implied 0.43–0.45; the replay was not run | [BL-022][bl022] |
| BL-155 | Morning type at 11:00 (range so far vs the last 20 mornings) sets the straddle's leg stop: quiet 100 %, normal 80 %, wide 60 % | Heatmap ATM straddles 11:15–14:45; NIFTY 2025-01 → 2026-10 decides | **Killed**: no better than a fixed stop or the reversed rule | [BL-155][bl155] |

BL-083 event study, trigger minus the same template at the same minute on the 20 nearest non-event
days, ₹ per lot (t): pivot-with-trend → Dir +754 (3.5) explore, −20 (−0.1) confirm; RSI exhaustion →
Dir +403 (3.95), +156 (1.7); RSI exhaustion → Buy +84 (1.8), +287 (4.0); straddle turn: |t| ≤ 1.4
everywhere. Override rule (lead fires a Dir in place of the next pending pick): 2024–26 list B +₹79,389
and REF +₹54,556, above both random controls; 2022–24 −₹10k to −₹27k for A, B, C.

## What we know

- Waiting until 10:00 helped Dir and Widesl in BL-053's year (Dir ₹56,583 → ₹96,628), but most of the
  switch's gain came from the later start, not the VIX switch. A later start is a separate, untested
  question on unseen days.
- No hourly state adds to what the 09:16 fit already knows. Directions flip between periods: a VIX
  rise of more than 2% by 10:30 is the worst state for pending Widesl in P1 and the best in P2 and P3.
- Triggers that work as detectors find **more movement** (range after entry 9–27% larger than placebo):
  good for Dir and Buy shapes, bad for short-volatility Widesl. The straddle turn (T3) finds nothing.
- The Dir trigger edge is regime-dependent (appears from mid-2024) and partly "a Dir instead of that
  pick", since a Dir at a random minute also gains for some lists. Forward shadow only.

- Similar mornings do not share a similar afternoon (BL-022). The 20 nearest earlier sessions by
  path shape forecast the rest-of-day range worse than one number does: today's range so far against
  recent mornings (BL-110). A range forecast is not P&L, and that number did not help pending picks
  in BL-081 either.

## Not yet tested

- A real VWAP from futures bars ([BL-082][bl082], not before 2027-03-23).
- Started picks' live P&L as a state (BL-081 stage 2, not registered).
- Triggers on unseen days: evening scoring accumulates events; a live minute-poller (BL-083 phase 3) is
  not started.

## Related

- Strategy pages: [Widesl VIX](../strategies/widesl/vix.md), [Buy VIX](../strategies/buy-breakout/vix.md),
  [Buy entry time](../strategies/buy-breakout/entry-time.md).
- [Straddle exhaustion](../strategies/straddle-exhaustion/README.md) (BL-091 builds on T3).
- Scripts: `research/bl081/` (`state.py`, `ck_*.py`), `research/bl083/` (`triggers.py`,
  `event_study.py`, `override.py`, `analysis.py`). Outputs (`out/`) are git-ignored; regenerate with
  those scripts.

[bl022]: ../../../backlog/BL-022-analog-day-search.md
[bl155]: ../../../backlog/BL-155-stop-by-morning-type.md
[bl053]: ../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl058]: ../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl081]: ../../../backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md
[bl082]: ../../../backlog/BL-082-hourly-checkpoint-futures-vwap.md
[bl083]: ../../../backlog/BL-083-event-triggered-intraday-entries.md

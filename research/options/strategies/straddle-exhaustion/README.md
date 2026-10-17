# Straddle premium exhaustion

**Status:** Tested (learning periods only; the one-time P1 test is unread) · **Last updated:** 2026-10-18

## What it is

The owner's idea: watch the rolling NIFTY (and SENSEX) ATM straddle, with its first and second time
derivatives, and spot when a premium spike is running out of steam. Two uses were studied: when to
sell into a spike (Widesl, Dir), and how to stop the owner's stopped wide sell from re-entering into a
spike that keeps going. The target is exhaustion of **straddle-premium expansion**, not of the index.

Working definitions ([BL-091][bl091], registered 2026-10-11):

- **Held spike:** the rolling ATM straddle rises at least 25 points (SENSEX 90) above its low and stays
  at least that high for 5 consecutive minutes; any entry is the next minute.
- **Size category** at entry, by VIX at the 09:15 open (cut points from P2 + P3 only).
- **Arms:** Widesl (`{N|S}_wide_1202` shape) with MTM stops ₹650 / ₹1,300 / ₹1,950 and re-entry rules
  R0 (at once), R2 (after a give-back), R3 (not before 13:30), R5 (20-minute wait), R6 (at most 3
  tries); Directional D1 (at the spike) and D2 (at a support / resistance reaction).
- **Comparator:** the same arm at the same minute on the 10 nearest days with no held spike.

## Periods

Learning: P2 (Jan–Aug 2025) and P3 (NIFTY 2022-04 → 2024-10). Test once: P1 (2025-12-03 → 2026-10-08),
**not yet read**. P1 is not pristine (the rotation lists, BL-081 and BL-083 were built with it in view),
so a forward shadow (trigger T5 in the nightly scoring) is the only unseen test.

## Tested

| Stage | What | Verdict | Evidence |
|---|---|---|---|
| 1 | Episode census and R0 replay | Counts only | [BL-091][bl091] |
| 1a | 18 arms (Widesl × 3 stops × 5 re-entry rules; Dir D1 × 3) | **No arm passes** the screening bar; in 2025 every arm did worse after a held spike than on non-spike days (NIFTY −₹166 to −₹1,259 per spike) | [BL-091][bl091] |
| 1b | Dir D2 at a level rejection or break | **No arm passes** (NIFTY 2025 −₹716 to −₹840 vs comparator) | [BL-091][bl091] |
| 2 | 32 parameters to tell a true top from a pause | One separates for NIFTY (5-minute change of the ATM IV approximation, AUC 0.627 / 0.603); rule R1 built from it **does not pass** (2025: −₹1,234 vs comparator, t −3.6) | [BL-091][bl091] |
| Time gates | 13 extra arms: no re-entry before 13:30 / 14:00 / 14:30 / 14:50 (G), or no entry at all before the gate (F) | **Post-hoc lead:** F1450 meets the screening bar (NIFTY 2025 +₹241 vs comparator, t 2.45; 2022–24 +₹160; +₹195 at ₹20 an order; SENSEX +₹349, t 2.46) | [BL-091][bl091] |
| Late give-back (BL-120) | After 14:30, the straddle up 20 (SENSEX 50) from the day's low, held 5 minutes, then down 15 from its high: Widesl with a ₹1,000 stop. Causal placebo and random-minute comparators | **Inconclusive** on NIFTY P2 + P3 pooled (36 events, +₹151 per Widesl after ₹20 an order, +₹126 over the placebo, t 0.94, above the random-minute P95); SENSEX P2 18 events reported only; the rule as first stated (rise measured from 14:30) fired on 4 / 8 / 7 tradable days and was inconclusive by construction | [BL-120][bl120] |

## What we know

- No registered arm passed. F1450 (every Widesl entry on a spike day at or after 14:50) cleared the bar,
  but it is one of **31 Stage 1 arms tried** (18 registered + 13 time gates), run after Stage 1a on the
  owner's chat request without the `override:` line the research gate requires. It is a lead for a
  registered P1 test, not a result.
- On spike days, waiting before re-entering helps: re-entering at once made +₹372 per spike (NIFTY
  2025) against +₹846 with no re-entry before 13:30 (R3), and gates roughly halve the average losing
  spike.
- The registered comparator is not causal: "no spike later today" reads bars after the entry minute
  and flatters the short-premium placebo. Read Stage 1 / 1b / R1 as spike day versus quiet day; "no
  arm passes" is not evidence of harm. A P1 registration should use a causal comparator.
- Some code fixes after the logged numbers (VIX-missing days, Dir no-entry days, 15:13 entries) were
  not re-run; the expected effect is small and a re-run is owed before any P1 test.
- All rupees are per strategy at cost 0 and at ₹20 an order; no slippage.

- BL-120 (2026-10-18): the owner's late-day version, a held rise from the day's low then a 15-point
  give-back after 14:30, was positive but not distinguishable from the same Widesl at the same minute on
  ordinary days (36 NIFTY events, t 0.94). About 160 events would be needed to see an effect this size.
  P1 is unread. Splits by hold-before-14:30 and entry-before-14:45 look better but are post hoc leads on
  16 to 21 events each.

## Not yet tested

- P1, once, for a frozen arm (owner to choose: R3, F1450, or close the idea). Any P1 registration must
  count all 31 arms.
- Expiry-day spikes on their own; SENSEX below VIX 13 (1–4 spikes, inconclusive).

## Related

- BL-083's straddle-turn trigger T3 found nothing (same range as ordinary days):
  [intraday state](../../common/intraday-state.md).
- [Widesl re-entry](../widesl/re-entry.md), [Widesl entry time](../widesl/entry-time.md).
- Scripts: `packages/option-backtesting/research/bl091/` (`sustained.py`, `stage1.py`, `stage1b.py`,
  `stage2.py`, `report_stages.py`); BL-120: `packages/option-backtesting/research/bl120/`. Outputs (`out/stage1.md`, `out/gates.csv`) are git-ignored;
  regenerate with those scripts.

[bl091]: ../../../../backlog/BL-091-straddle-premium-exhaustion-study.md
[bl120]: ../../../../backlog/BL-120-late-straddle-giveback-widesl.md

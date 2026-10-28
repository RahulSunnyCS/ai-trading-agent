# BL-184 — Directional split session: one Dir 09:17–13:00 plus one 13:02–15:28 against one whole-day

| | |
|---|---|
| **Priority** | P1 — the owner trades the Dir with real money on Core and T1; BL-182's method applied to it at the owner's request |
| **Status** | In progress — Phase 0 registered 2026-10-28, run the same day |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-182 (the method, the shared replay in `research/common/split_replay.py`), BL-058 (the Core files and stored results) |
| **TODO.md row** | §3.10.47 |

## Context

BL-182 tested the Widesl as two sets a day (09:17–12:00 and 13:00–15:28) against the whole day, first as
fixed files, then with Adaptive picking two morning and two afternoon Widesl. Both failed the registered
rule after charges (the gain clears zero before charges, the drawdown halves, the edge sits in one year
only). The owner (2026-10-28): "lets do the same with 1 directional research. split one morning 9:15 - 1,
evening 1 - 3:30" — the Dir as one morning set closed at 13:00 and one fresh afternoon set from 13:02 to
the close, Adaptive picking one of each, against Adaptive's one whole-day Dir.

The Dir (`N_dir`, `S_dir`: short ATM straddle, 21 % leg stop, one re-entry at cost, ₹3,000 MTM stop, no
target; `N_ditm1`, `S_ditm1` the same at ITM1) is the pick Adaptive doubles on non-expiry days and the
one the owner's fixed base holds at 09:24. Unlike the Widesl it is a tight-stop, re-entering shape: a
half-day set gives each leg's one re-entry less time, and the afternoon set re-strikes at the money after
the morning's move.

## Goal

A verdict, against the rule below, on whether one morning plus one afternoon Dir beats one whole-day Dir
per margin lot-day after charges, with Adaptive picking; the fixed 09:17 files' split as a descriptive
read.

## Out of scope

Any change to a live file, list or pick. Other split times, two-plus-two Dir books, other stops or
targets, T1's Dir setting, a conditional afternoon entry. Anything traded.

## Plan

### Phase 0 — Pre-register (committed 2026-10-28 before any run)

- **Hypothesis:** Adaptive choosing one Dir for the morning (entries 09:17–12:47, exit 13:00) and one for
  the afternoon (entries 13:02–15:02, exit 15:28) earns more per margin lot-day after charges than
  Adaptive choosing one whole-day Dir (entries 09:17–15:17, exit 15:28) from the same families, with a
  max drawdown no worse.
- **Universe and data:** Core's four Dir families — NIFTY ATM and ITM1, SENSEX ATM and ITM1
  (`strategies/rotation/N_dir, N_ditm1, S_dir, S_ditm1`). Morning variants = the family's Core slot file
  with only `exit_time` changed to 13:00, at the 15 slots 09:17 … 12:47 (60 files); afternoon = the Core
  files at 13:02 … 15:02 unchanged (36; they exit 15:28); whole-day comparator = the families' 25 Core
  slots (100). All re-simulated in one batch (BL-182's engine, fills, sizing `current` at 2026-10-12,
  charges from `ruletest/charges.py` on each run's own trades) on every usable lake day 2024-10-09 →
  2026-10-27; the whole-day re-simulations checked against the stored `rotation/results/` gross. Widesl
  and Buy are out on both sides. Our exit is 15:28 (every live file, the engine's last reliable bar) and
  the first slot 09:17 (the rotation grid), for the owner's "9:15" and "3:30".
- **Ranking:** list C's composite exactly as the 09:16 job computes it (`score.composite`, C's weights and
  lookbacks, `family_index`, attributes from `rotation/days.csv`, ranked on gross as the live store's
  `net` is), on three pools — morning (60), afternoon (36), whole-day (100) — and in each the top one by
  composite (ties by name). Both half-day picks at 09:16 on history to the previous day. No expiry-day
  rule on either side. Picks from the 64th day of results (`WARMUP` 63): about 2025-01-10 → 2026-10-27.
- **Measure:** book net per day = the sum of its picks' one-lot net after charges (split: morning +
  afternoon; comparator: the whole-day pick). Per margin lot-day = book net ÷ 1: a morning and an
  afternoon set use one lot of margin in turn, as the whole-day set does. Difference = split −
  comparator; its mean and 90 % interval from `readout.block_bootstrap_mean` (circular 5-day blocks,
  2,000 resamples, seed 20261028); max drawdown per margin lot (`readout.max_drawdown`); days in profit;
  gross beside net; ₹13 an order and, reported only, Shoonya's ₹5. Also reported, descriptive: the same
  over T1's selection year (pick days to 2025-10-08) and the year after; the morning and afternoon books
  alone; the picks' family and slot shares; Core Adaptive as traded (gross, from the stored results) for
  context; and the fixed files `N_dir_0917` and `S_dir_0917` split at 13:00 against their whole day.
- **Pass / kill rule:** pass if the difference's 90 % lower bound is above zero after charges at ₹13 AND
  the split's max drawdown per margin lot is no deeper than the comparator's, over the whole pick span. A
  pass earns a forward paper track, never a trade. Fail → recorded, not adopted.
- **Look-ahead:** every composite reads rows before the pick day only; the attributes are the day's own
  as the live job uses them. The 13:00 split and the one-plus-one shape are fixed above and come from the
  owner's instruction after BL-182, which saw these same days: the whole phase is seen data.
- **Will not run:** other split times (12:00, 12:30, 13:30), two-plus-two or two-plus-one Dir books, an
  afternoon pick at 12:55, the expiry-day rule, T1's Dir setting, other stops or targets, any reweighting
  of the composite, a per-period selection. Any of these needs `override: <reason>` in the Log.

### Phase 1 — Run and write up

- **Tasks:** `research/common/split_replay.py` (BL-182 Phase 2's machinery, generalised: families, slots,
  the morning exit, picks per pool, the margin divisor); `research/bl184/run.py` (the configuration above,
  plus the fixed-file read); this Log; findings page `research/options/strategies/directional/session-split.md`
  and rows in the Directional README, `exit-time.md`, `entry-time.md` and the options matrix.
- **Done when:** the rule has its verdict and the pages are updated.

## Risks

- A 13:00 exit on a 21 % stop shape: the morning set's re-entry has less time to recover; the afternoon
  set re-strikes ATM into the afternoon trend (good for a straddle only if it then ranges).
- All seen data; a 13:00 split chosen after BL-182's 12:00 one.

## Open questions

- None blocking: the owner set the split time, the one-plus-one shape and the comparator.

## Log

- 2026-10-28 — created at the owner's request after BL-182; Phase 0 registered and committed before any
  run.

# BL-184 — Directional split session: one Dir 09:17–13:00 plus one 13:02–15:28 against one whole-day

| | |
|---|---|
| **Priority** | P1 — the owner trades the Dir with real money on Core and T1; BL-182's method applied to it at the owner's request |
| **Status** | Done 2026-10-28: not adopted. Adaptive's one morning + one afternoon Dir against its one whole-day Dir: +₹31 [−214, +251] net per margin lot-day, drawdown deeper (−31,740 vs −26,486), the gain in T1's selection year only (+255) and negative after (−133); FAIL on both conditions. Descriptive lead: the fixed NIFTY `N_dir_0917` split reads +₹203 [+58, +348] |
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

## Result (2026-10-28)

434 pick days 2025-01-10 → 2026-10-27; pools of 60 morning (exit 13:00), 36 afternoon and 100 whole-day
variants; one pick each. The 100 whole-day re-simulations match the stored rotation results on all 50,100
variant-days. Full table: `research/bl184/out/split_summary.md` (git-ignored; `uv run python
research/bl184/run.py --analyse-only` rebuilds it).

| Book | Net / margin lot-day | Gross | Net at ₹5 an order | Days in profit | Max DD (net) |
|---|---|---|---|---|---|
| One whole-day Dir (comparator) | +326 | +451 | +379 | 58 % | −26,486 |
| One morning Dir alone (09:17–12:47 → 13:00) | +81 | +201 | +131 | 57 % | −42,574 |
| One afternoon Dir alone (13:02–15:02 → 15:28) | +276 | +387 | +324 | 60 % | −16,944 |
| Split: one morning + one afternoon | +357 | +588 | +455 | 58 % | −31,740 |

Split − comparator per margin lot-day: **net +31 [−214, +251]**; gross +137 [−106, +356]; at ₹5 an order
+76 [−168, +295]. Max drawdown −31,740 vs −26,486. **FAIL on both conditions.**

| Period | Pick days | Split | Comparator | Difference [90 %] |
|---|---|---|---|---|
| T1 selection year (to 2025-10-08) | 184 | +513 | +258 | +255 [−88, +595] |
| The year after | 250 | +242 | +376 | −133 [−460, +201] |

Fixed files, descriptive (the 09:17 Core file split at 13:00 plus the 13:02 file, against the 09:17 whole
day, 501 days): `N_dir` whole +141 → split +343 net a day, **+203 [+58, +348]** (gross +309 [+165, +453]),
max drawdown −44,390 → −46,750; `S_dir` whole +322 → split +420, +98 [−56, +265], max drawdown −18,590 →
−55,766.

What the numbers say:

- **With Adaptive picking, the split is a wash with a deeper drawdown.** The Dir split's interval is twice
  as wide as the Widesl's (±230 against ±130): a 21 % stop shape with re-entry is far noisier across a
  day boundary, and the morning Dir alone is poor (+81 net, −42,574 drawdown, the morning's move stopping
  it before its re-entry can earn). The afternoon Dir alone (+276, −16,944) is nearly the whole-day's
  earnings at two-thirds of its drawdown.
- **The gain is in one year and reverses in the other:** +255 in T1's selection year, −133 after, with
  2026 H1 the split's worst half (−23,531 against the whole day). The same instability BL-182 found.
- **The fixed NIFTY file is the one positive reading** (+203 net, lower bound +58), but it is not the
  registered comparison, its drawdown is deeper, and SENSEX's fixed split triples the drawdown. A lead for
  a registration of its own, not a result.
- Adaptive takes the ITM1 Dir 70–80 % of the time in every pool; the whole-day pick spreads over more
  slots than the halves do.
- Core Adaptive as traded makes ₹394 gross per lot-day; the whole-day Dir comparator ₹451, the split ₹588
  gross, which the charges and the drawdown take back.

Not adopted. No forward track. Leads kept on the findings page: the afternoon-only Dir (as the afternoon-
only Widesl in BL-182) and the fixed NIFTY Dir split.

## Experiments

### E1 — the morning Dir's overall stop, ₹500 → ₹4,000 (registered 2026-10-28, before the run)

- **Override:** `override: owner, 2026-10-28 — "... in directional, we can go with 500, 1000, 1500, 2000,
  2500, 3000, 3500, 4000 ... Do only morning now"`: a sweep over stop levels, listed under "will not run".
- **Change:** only the morning Dir sets (09:17–12:47 → 13:00) carry `overall.stop_loss_inr` at each of
  ₹500, 1,000, 1,500, 2,000, 2,500, 3,500 and 4,000 in turn (₹3,000 is the files' own, the Phase 0 run);
  the afternoon sets and the whole-day comparator keep ₹3,000 (`research/bl184/stops.py`).
- **Read, descriptive (no pass rule):** as BL-182 E2 — per level, Adaptive's morning Dir alone (net per
  margin lot-day, gross, days in profit, max drawdown, stops hit), the split with it against the
  comparator, and the fixed `N_dir_0917` / `S_dir_0917` morning half alone. A level "helps" if the
  morning book's net rises AND its drawdown is shallower than at ₹3,000, over the whole span and in both
  periods. Nothing adopted; a lead at most, and with eight levels the best one is expected to look good
  by chance.
- **Not now (owner: "maybe"):** a trailing overall MTM stop on the morning sets; the engine's `overall`
  has no trail (see BL-182 E2).
- **Will not run:** stops on the afternoon sets, other levels, a stop by family or index.

## Risks

- A 13:00 exit on a 21 % stop shape: the morning set's re-entry has less time to recover; the afternoon
  set re-strikes ATM into the afternoon trend (good for a straddle only if it then ranges).
- All seen data; a 13:00 split chosen after BL-182's 12:00 one.

## Open questions

- None blocking: the owner set the split time, the one-plus-one shape and the comparator.

## Log

- 2026-10-28 — created at the owner's request after BL-182; Phase 0 registered and committed before any
  run.
- 2026-10-28 — run (`research/bl184/run.py` over `research/common/split_replay.py`): +₹31 [−214, +251] net per
  margin lot-day, drawdown deeper, FAIL; fixed `N_dir_0917` split +₹203 [+58, +348] descriptive. Closed,
  not adopted.
- 2026-10-28 — E1 registered (owner override: the morning Dir's overall stop at eight levels ₹500 → ₹4,000,
  descriptive) before its run.

# BL-222 — Trend-side wide leg stop on T1's Dir picks: the leg that rises with the trend gets 50%, the other keeps its stop

| | |
|---|---|
| **Priority** | P2 — the owner's idea (2026-11-15) from the BL-221 follow-up split; cheap to test on the engine and T1's own picks, no live change until it passes |
| **Status** | In progress (pre-registered 2026-11-15, before any run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-15 |
| **Depends on** | BL-221 (the hourly EMA 20/50 trend state and the T1 Dir split), BL-113 (T1's picks), BL-096 (Dir stop findings) |
| **TODO.md row** | 3.11.31 |

## Context

The BL-221 follow-up split T1's Dir picks (351 days, 2025-01-10 → 2026-10-08) by the hourly EMA 20/50 state known
before each session: up-trend 47% of sessions, down-trend 53%; Dir earned ₹598 a day in up-trend and ₹241 in
down-trend (0.5% slippage, before brokerage); the short calls made ₹192,557 of ₹217,486 and the short puts
₹24,929 (−₹2,067 on down-trend days, stopped 256 times in 190 days). The owner's idea (2026-11-15): on a
down-trend day keep the call (CE) leg's stop and give the put (PE) leg a **wide stop of about 40–50%**, and the
mirror on an up-trend day (CE wide, PE kept). In words: the leg whose premium **rises with the trend** is given
room; the other leg keeps today's stop.

What is already known (research pages read 2026-11-15): the leg stop is a mapped variable, the live 21% is the
weakest shortlisted cell and 25–30% did better after charges for both legs ([leg stop](../research/options/strategies/directional/leg-sl.md)); trailing and
re-entry settings are descriptive ([trail](../research/options/strategies/directional/trail.md), [re-entry](../research/options/strategies/directional/re-entry.md)); stop-and-reverse was killed (BL-186). T1's
Dir picks already differ in stop: `N_dir-t1s29` 40%, `N_ditm1-t1s36` 20% with a trail, `S_ditm1-t1s44` 15% with a
trail, the Core Dir files 21%. On down-trend days NIFTY fell on 58 of 190, rallied on 61 and was flat on 71: the
state says little about the day's direction, which is the main reason to doubt the idea.

## Goal

Know whether giving the trend-side leg a wide stop earns more than T1's Dir picks as they are, and more than the
same wide stop on both legs (which would say "wider stops" and not "the trend").

## Out of scope

Any live change, the exporters and `.algtst` / Quantiply mappings, SENSEX's own trend state (NIFTY's hourly state
is used for every pick), other stop values than the grid, trails, re-entry counts, per-pick tuning.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** setting the stop of the trend-side leg (up-trend: CE; down-trend: PE) to X% and leaving the other
  leg as the pick has it earns more per pick-day than the pick as it is, and more than X% on both legs.
- **Universe:** T1's Dir picks per day (`research/common/adaptive_picks.py`: recorded from 2026-10-19, reconstructed
  before, as in the BL-221 follow-up; names matching `^[NS]_(dir|ditm1)`), 2025-01-10 → 2026-10-08 (the fit
  window: the last two years minus the 63-session ranking warm-up), 351 days with one Dir pick each. Each pick's own
  YAML is re-run by `simulate_day`; only the leg stops named below change, every other setting (strike, entry,
  trail, re-entry, MTM stop, exit) stays. Sessions after 2026-10-08 are never read.
- **Look-ahead check:** the trend state is EMA 20 vs EMA 50 of hourly NIFTY closes completed before the session
  opens (the BL-221 function, moved to `research/common/trend_state.py` with a test that it equals BL-221's
  stored states); it picks the stop before the session starts, so nothing from the day is used. The picks are
  the ranking's, from earlier days only. The picks' own settings were tuned on part of this window (BL-113: t1s29 on
  2024-10-09 → 2025-10-08), so the baseline is flattered in-sample; every arm is run on the same days.
- **Arms, per pick-day (one lot), ₹23.6 an order and 0.5% slippage on all of them, so more stops and re-entries cost
  what they cost:** A0 the pick as it is; S(X) both legs at X%; W(X) the trend-side leg at X%, the other as picked
  (the owner's rule); M(X) the mirror, the **counter**-trend leg at X%, the other as picked (reported, never a
  candidate); P(X) W(X) with a random trend state per day (probability = the share of up-trend days, 2,000 draws,
  seed 20261115). X ∈ {30, 40, 50}. A pick whose stop on that leg is already at or above X is unchanged.
- **Primary cell:** X = 50 (the upper end of the owner's 40–50; at 40 the most-picked Dir, t1s29, is already 40% and
  would be unchanged). X = 30 and 40 are sensitivity rows.
- **Pass / kill rule (primary cell, after charges and 0.5% slippage):** (i) W(50) minus A0 and W(50) minus S(50)
  each have a circular 5-day block-bootstrap 90% interval (2,000 resamples, seed 20261115) whose 5th percentile is
  above zero; (ii) W(50) beats 95% of the P(50) draws' mean per pick-day; (iii) the 351 days split into 4 equal
  consecutive blocks, W(50) above A0 in at least 3; (iv) W(50)'s maximum drawdown and worst 5-day sum are no worse
  than A0's. Anything else: killed. Reported beside it: orders, stop-outs, the same on the up-trend and the
  down-trend days separately, and 0% and 1% slippage.
- **Hold-out / confirmation:** sessions after 2026-10-08 unread. Only if the primary cell passes: the fixed base Dir
  (`strategies/rotation_base/N_dir_atm_0924.yaml`) with the same arms on NIFTY 2022-01-03 → 2024-10-08, opened once.
- **Will not run:** stops outside {30, 40, 50}, a trend state other than hourly 20/50, trails or re-entries changed,
  SENSEX's own state, per-index splits as a candidate; each needs `override: <reason>` in the Log.

### Phase 1 — Arms and the runner

- **Tasks:** move the trend-state code to `research/common/trend_state.py` (BL-221's runner imports it; its stored
  states must be reproduced exactly); `research/bl222/run.py` re-runs every Dir pick under the 10 arms (A0; S, W, M at
  three X) and stores per pick-day nets, orders and stop-outs.
- **Deliverables:** the runner, a test of the stop override and the trend module.
- **Done when:** A0 reproduces the stored T1 result for each pick-day at 0% slippage with zero charges, to the rupee.

### Phase 2 — Judge

- **Tasks:** the rule above, the sensitivity rows, the splits.
- **Deliverables:** a verdict in the Log, a findings page (`research/options/strategies/directional/trend-side-stop.md`)
  and the `leg-sl.md` row.
- **Done when:** the verdict is recorded.

## Risks

- **Whipsaw, not direction, may be the real cost.** Calls were stopped 216 times and puts 256 on down-trend days;
  a wide stop on one leg changes only part of that.
- **A wider stop on the side the market is moving toward raises the loss on the days it keeps moving.** Dir earned
  ₹104,503 of ₹142,040 on fall days, where the put's tight stop does its work.
- **The trend state hardly predicts the day** (58 / 61 / 71 of 190 down-trend days fell / rallied / were flat).
- **In-sample picks:** t1s29, t1s36 and t1s44 were chosen on 2024-10 → 2025-10; the baseline is not neutral.
- **Operational:** a stop that changes per day needs two versions of each Dir at the evening export and a pick by the
  15:30 state; not built, not part of this item.

## Open questions

None needed to start: the owner chose the legs and the 40–50% range; "vice versa" read as the mirror for an up-trend.

## Log

- 2026-11-15 — created and pre-registered before any run, from the owner's idea and its mirror ("and vice versa").

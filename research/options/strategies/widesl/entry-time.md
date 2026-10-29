# Widesl: entry time

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

The minute both short legs are sold. Set by `entry_time` (HH:MM). The research grid is every 15 minutes
from 09:17 to 15:17; the exit stays 15:28, so a 15:17 start holds for 11 minutes.

## Live value

09:17 in all three live files (`strategies/legwise/nifty_widesl_917_otm1.yaml`,
`sensex_widesl_917_otm2.yaml`, `nifty_widesl_917_closest_premium.yaml`). The rotation has all 25 start
times for each family.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | NIFTY OTM1 09:17 vs 10:00 | 2025-10-09 → 2026-10-08, 1 lot, before charges | Side finding of a killed rule: 10:00 ₹43,655 vs ₹37,523, drawdown −₹33k vs −₹45k; on data already seen | [BL-053][bl053] |
| BL-054 | NIFTY OTM1, 11 times 09:17–11:47 | 2024-10-09 → 2026-10-08, before charges | Descriptive: best 09:17–10:02 (₹1.73–1.75 lakh), weakest 11:02–11:47 (₹0.60–0.84 lakh) | [BL-054][bl054] |
| BL-059 | NIFTY OTM1 and SENSEX OTM2, 24 times 09:17–15:02 | 2025-09-01 → 2026-10-08, before charges | Descriptive: flat across the day; shape does not repeat between halves | [BL-059][bl059] |
| BL-062 | Whole-day rotation (all families) | same year, before charges | Lots starting 12:02 or later made ₹470 a lot against ₹251 for morning starts; rests on late fills | [BL-062][bl062] |
| BL-083 | Entry at the minute a pivot, VIX-turn, straddle or RSI trigger fires (10:30–14:00) | explore 2024-10 → 2026-10 both indices; confirm NIFTY 2022-01 → 2024-10 | **No lead** for Widesl; the VIX-turn entry loses (−₹215 explore, −₹139 confirm) | [BL-083][bl083] |
| BL-098 | Best configuration per band, all families | holdout 2025-10-09 → 2026-10-09, **after charges** | Descriptive ranking (below) | [BL-098 report][bl098q] |
| BL-145 Q4 | NIFTY OTM1 entering 09:47 (`N_wide_0947`), split by the opening range 09:15 to 09:44 on quiet-week days (R7 lowest third) | learning 2025-10-20 → 2026-10-19 (80 days), confirmation 2024-10-09 → 2025-10-17 (46); gross per lot-day, no charges | Low-OR days beat high-OR days: +1,446 [+426, +2,578] (46 vs 7 days), confirmed thinly +723 [−92, +1,879] (22 vs 5 days); the registered rule is met | [BL-145][bl145] |
| [BL-182][bl182] | A 13:00 entry (exit 15:28) as the afternoon half of a two-set day, beside the 09:17 whole day | 2024-10-09 → 2026-10-27, 501 days, after charges, seen data | A 13:00–15:28 set alone earns +138 (NIFTY OTM1) / +83 (SENSEX OTM2) net a day, stopped a third as often as a whole-day set; T1's OTM1 settings +187 / +232. Not adopted as part of the split (interval includes zero) | [Session split](session-split.md) |
| BL-187 | Strongest Widesl by Adaptive's morning ranking among starts from 14:02, run in place of the picked Dir (cut 2 minutes before) | 434 pick days 2025-01-10 → 2026-10-27, T1 and Core, after charges, seen data | The late Widesl earns +₹75 [+44, +106] net per margin lot-day and beats a random late Widesl by +₹44 [+8, +79]; entered 14:02 on half the days; the book gain of +₹32 [−11, +74] is gone at ₹115 late-fill cost per lot; not adopted | [BL-187][bl187] |

Average ₹ per day per lot, mean of the start-time means, before charges ([BL-059][bl059]):

| Index | 09:17–11:47 | 12:02–13:47 | 14:02–15:02 | Start times positive in both halves |
|---|---|---|---|---|
| NIFTY OTM1 | 158 | 178 | 182 | 9/11, 4/8, 3/5 |
| SENSEX OTM2 | 67 | 94 | 103 | 5/11, 4/8, 2/5 |

After charges, the band leaders earn (₹ per day, [BL-098 report][bl098q]): NIFTY 114 (09:15–11:00,
₹100 leg 90%), 63 (11:00–13:00, OTM1 leg 80%), 94 (13:00–15:30, ₹100 no MTM stop); SENSEX 24, 46 and
61 (₹250 leg 80% in every band). Profit factors are 1.01–1.06.

## What we know

- Before charges no time of day is reliably better. NIFTY's two-year view (BL-054) favours the early
  morning; the one-year whole-day view (BL-059) is flat, and the rank correlation of start-time averages
  between the two halves is −0.45 (NIFTY) and −0.01 (SENSEX).
- SENSEX OTM2 is weakest in the morning, before charges; its closest-premium ₹250 version is stronger in
  the afternoon (see [strike-premium](strike-premium.md)).
- After charges Widesl margins are thin in every band. One holdout year; BL-098 Phase 3 went to BL-104: no Widesl band passed its rules ([Widesl › Full-factorial sweep](README.md#full-factorial-sweep-bl-104)).
- Late starts rely on 1-minute fills with no spread. All Widesl and Dir curves jump at 14:47 (NIFTY
  ₹268 a day) and fall back at 15:02; a spot check did not explain it (BL-059). A ₹100–₹300 extra cost
  per late lot takes the BL-062 rotation from ₹3.36 lakh to ₹3.05–2.43 lakh (rough, not registered).
- Widesl is a short-volatility shape: triggers that mark more movement hurt it. After the VIX turn it
  was stopped out 27% of the time against 15% on placebo days (BL-083).

- Waiting for the opening range before a 09:47 entry (BL-145 Q4): in quiet weeks the Widesl made +162 per
  lot-day when the opening range was in the lowest third and −1,284 when in the highest, but only 7 days were
  in the highest (5 in the year before), and the cuts are whole-window. A lead, gross and before charges.

## Not yet tested

- A fixed later start for the live 09:17 (for example 10:00), pre-registered, on unseen days: NIFTY
  2022–24 is now in the lake (BL-053's open question).
- Late-session fills with a spread or slippage model.

## Related

- [Directional entry time](../directional/entry-time.md); [intraday state](../../common/intraday-state.md).
- Scripts: `packages/option-backtesting/research/bl054/`, `bl059/`, `bl062/`, `bl083/`; the BL-098 sweep
  writes into `research/bl097/` (`run_family_sweep.py --family widesl`; BL-098 has no folder of its own).
  Outputs are git-ignored; regenerate with those scripts.

[bl053]: ../../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl054]: ../../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl062]: ../../../../backlog/BL-062-whole-day-rotation.md
[bl083]: ../../../../backlog/BL-083-event-triggered-intraday-entries.md
[bl145]: ../../../../backlog/BL-145-t1-robustness-lag-opening-range.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
[bl182]: ../../../../backlog/BL-182-widesl-split-session.md
[bl187]: ../../../../backlog/BL-187-dir-cut-late-widesl.md

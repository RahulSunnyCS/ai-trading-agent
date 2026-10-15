# Directional: entry time

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

The minute both short legs are sold. Set by `entry_time` (HH:MM). The research grid is every 15 minutes
from 09:17 to 15:17, exit 15:28. BL-083 also tested entry at the minute an intraday trigger fires.

## Live value

09:24 (`strategies/legwise/nifty_dir_924_itm1_sl21_recost.yaml` and the fixed base
`strategies/rotation_base/N_dir_atm_0924.yaml`). The rotation has all 25 start times per family.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | NIFTY ITM1 09:24 vs 10:00 | 2025-10-09 → 2026-10-08, 1 lot, before charges | Side finding of a killed rule: 10:00 ₹96,628 vs ₹56,583, drawdown −₹19k vs −₹36k; on data already seen | [BL-053][bl053] |
| BL-054 | NIFTY ATM, 11 times 09:17–11:47 | 2024-10-09 → 2026-10-08, before charges | Descriptive: best 11:02–11:47 (₹2.2–2.6 lakh, drawdown −₹12k to −₹25k) | [BL-054][bl054] |
| BL-059 | NIFTY and SENSEX ATM, 24 times 09:17–15:02 | 2025-09-01 → 2026-10-08, before charges | Descriptive: positive almost everywhere; best slot does not repeat between halves | [BL-059][bl059] |
| BL-083 | Entry at the minute a trigger fires (10:30–14:00) | explore 2024-10 → 2026-10 both indices; confirm NIFTY 2022-01 → 2024-10 | **No lead** under the registered bar; two leads under the owner's rule (below) that fail in 2022–24 | [BL-083][bl083] |
| BL-096 | Best configuration per band and per start time, ATM and ITM1 | holdout 2025-10-09 → 2026-10-09, before and **after charges** | Descriptive ranking | [post-charge list][bl096pc], [pre-charge list][bl096q] |

Average ₹ per day per lot, mean of the start-time means, before charges ([BL-059][bl059]):

| Index | 09:17–11:47 | 12:02–13:47 | 14:02–15:02 | Start times positive in both halves |
|---|---|---|---|---|
| NIFTY ATM | 367 | 247 | 152 | 11/11, 5/8, 5/5 |
| SENSEX ATM | 409 | 285 | 156 | 11/11, 8/8, 5/5 |

After charges, the band leaders (15k-cell sweep, baseline re-entry, no trail) earn ₹ per day: NIFTY 155
(09:15–11:00), 242 (11:00–13:00), 77 (13:00–15:30); SENSEX 240, 255, 54 ([BL-096 post-charge][bl096pc]).
On the charged shortlist, entries from 13:00 net ₹1–76 a day ([BL-096][bl096]).

## What we know

- Before charges Dir makes money at almost every start time; SENSEX Dir is positive in both halves at all
  24. Averages fall through the day.
- Which start time is best does not hold up: the two-year view favoured 11:02–11:47 (BL-054), the
  one-year view favours the morning, and the rank correlation of start-time averages between halves is
  +0.02 (NIFTY) and −0.03 (SENSEX) (BL-059).
- After charges the midday band (11:00–13:00) is the strongest on both indices and the afternoon is close
  to breakeven before slippage (BL-096). One holdout year.
- **Triggered entries.** Dir after a pivot break with the trend (T1) gained ₹754 a lot over its placebo
  (t 3.5) and after RSI exhaustion (T4) ₹403 (t 3.95) in 2024–26, but −₹20 and +₹156 in NIFTY 2022–24.
  The gain appears from mid-2024 and a Dir placed at a random minute also gains for some lists, so part of
  it is "a Dir instead of that pick in this regime", not the minute (BL-083).
- B4 in BL-055 used Dir ATM at 11:17 and 11:32, picked with hindsight from BL-054's results.

## Not yet tested

- A fixed later start for the live 09:24, pre-registered, on unseen days (BL-053's open question; NIFTY
  2022–24 is now in the lake).
- BL-083 phase 3: the live trigger poller, judged on forward days.

## Related

- [Widesl entry time](../widesl/entry-time.md); [intraday state](../../common/intraday-state.md).
- Scripts: `research/bl054/`, `bl059/`, `bl083/`, `bl096/run_enriched.py`. Outputs git-ignored; regenerate
  with those scripts.

[bl053]: ../../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl054]: ../../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl083]: ../../../../backlog/BL-083-event-triggered-intraday-entries.md
[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl096q]: ../../../../backlog/BL-096-directional-qualified-list.md
[bl096pc]: ../../../../backlog/BL-096-directional-qualified-list-post-charge.md

# Buy: entry time

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The minute the strike is chosen and the 10-minute opening range starts. Set by `entry_time`; the
range end `until` moves with it (entry + 10 minutes) in every rotation file. The research grid is every
15 minutes from 09:17 to 15:02. Exit stays 15:14, so a 14:47 start has under 30 minutes and a 15:02
start (range ends 15:12) can barely trade ([BL-059][bl059]).

## Live value

09:35 (range to 09:45) in `strategies/legwise/nifty_buy_range_breakout.yaml`. The rotation has 24 start
times per index (`N_buy_*`, `S_buy_*`); there is no 09:35 rotation file.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | NIFTY 09:35 vs 10:00 (range 10:00–10:10) | 2025-10-09 → 2026-10-08, 1 lot, before charges | Side finding of a killed mix rule: ₹8,538 → −₹9,158 | [BL-053][bl053] |
| BL-054 | NIFTY, 11 times 09:17–11:47 | 2024-10-09 → 2026-10-08, before charges | Descriptive: positive but small, never beats Dir or Widesl at any start time | [BL-054][bl054] |
| BL-059 | NIFTY and SENSEX, 24 times 09:17–15:02 | 2025-09-01 → 2026-10-08, before charges | Descriptive (table below); shape does not repeat between halves | [BL-059][bl059] |
| BL-083 | Entry at the minute an RSI-exhaustion or pivot trigger fires | explore 2024-10 → 2026-10; confirm NIFTY 2022-01 → 2024-10 | No lead under the registered bar | [BL-083][bl083] |
| BL-097 | Baseline at all 24 times, by band | holdout 2025-10-09 → 2026-10-09, **after charges** | Every band negative (below) | [BL-097 report][bl097q] |

Average ₹ per day per lot, mean of the start-time means, before charges ([BL-059][bl059]):

| Index | 09:17–11:47 | 12:02–13:47 | 14:02–15:02 | Start times positive in both halves |
|---|---|---|---|---|
| NIFTY | 41 | −2 | −41 | 4/11, 0/8, 0/5 |
| SENSEX | 34 | 22 | 8 | 10/11, 3/8, 2/5 |

Rank correlation of start-time averages between the two halves of the year: NIFTY −0.24, SENSEX −0.20.

After charges even the least negative of each band's three ranked rows loses, ₹ per day per file
averaged over the band ([BL-097 report][bl097q]): NIFTY −18 (09:15–11:00), −22 (11:00–13:00), −68
(13:00–15:30); SENSEX −21, −4, −38.

## What we know

- Before charges Buy is at best a small morning effect on NIFTY and flat on SENSEX. The halves of the
  year disagree on the shape, so no start time is better than another on this evidence.
- Charges, not timing, decide the sign: at ₹20 an order the baseline pays more in charges than it
  earns gross at 45 of the 48 index × start-time files in the holdout ([BL-097][bl097] CSV).
- Starting at 10:00 instead of 09:35 turned NIFTY Buy from +₹8,538 to −₹9,158 in one year (before
  charges, data already seen, [BL-053][bl053]).
- After an RSI-exhaustion trigger Buy beat its placebo by +₹84 (t 1.8) in 2024–26 and +₹287 (t 4.0) in
  2022–24; it misses the registered bar (|t| ≥ 3 in the exploration set). The placebo is weak: 12–25%
  of ordinary Buy entries win ([BL-083][bl083]).

## Not yet tested

- A time-of-day rule for Buy on unseen days (NIFTY 2022–24 is in the lake).
- RSI-exhaustion → Buy as a pre-registered forward shadow.

## Related

- [Widesl entry time](../widesl/entry-time.md), [Directional entry time](../directional/entry-time.md),
  [intraday state](../../common/intraday-state.md).
- Scripts: `research/bl054/`, `bl059/`, `bl083/`, `bl097/run_family_sweep.py`. Outputs git-ignored;
  regenerate with those scripts.

[bl053]: ../../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl054]: ../../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl083]: ../../../../backlog/BL-083-event-triggered-intraday-entries.md
[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

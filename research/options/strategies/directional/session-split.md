# Directional: session split (two sets a day)

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

Running the Dir as two trades a day: a set sold in the morning and closed at 13:00, then a fresh set
(strikes chosen again from spot) sold from the 13:02 slot and closed at 15:28; no gap but the two minutes
between. Each half carries its own leg stops, re-entry and overall MTM stop. In the YAML it is the slot
file with `exit_time: "13:00"` for the morning half and the unchanged 13:02–15:02 Core files for the
afternoon. The Widesl's version, with a 12:00–13:00 gap, is [Widesl › session split](../widesl/session-split.md).

## Live value

One set a day, 09:17–15:28 (the rotation files) or 09:24–15:28 (the owner's fixed base).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-184][bl184] | Adaptive (list C) picking one morning Dir (09:17–12:47 → 13:00) and one afternoon Dir (13:02–15:02 → 15:28) from Core's four Dir families (ATM and ITM1, both indices), against its one whole-day Dir from the same families | 434 pick days 2025-01-10 → 2026-10-27, after charges, per margin lot-day, 90 % block bootstrap, seen data | **Killed on the rule.** Net +₹31 [−214, +251], gross +137 [−106, +356]; drawdown −31,740 vs −26,486 (deeper); the gain in T1's selection year only (+255) and negative after (−133). The morning Dir alone +81 (DD −42,574); the afternoon Dir alone +276 (DD −16,944) against the whole day's +326 (DD −26,486) | BL-184 Result |
| BL-184, fixed files (descriptive) | `N_dir_0917` and `S_dir_0917` split at 13:00 plus their 13:02 file, against the 09:17 whole day | 501 days, after charges | NIFTY +₹203 [+58, +348] net a day (whole +141 → split +343), drawdown −44,390 → −46,750; SENSEX +98 [−56, +265], drawdown −18,590 → −55,766. A lead on NIFTY, not the registered comparison | BL-184 Result |
| [BL-185][bl185] | The same sweep and replay with Dir cohorts included (tight stops, ITM3–OTM3 and premiums) | 250 test days, after charges, per margin lot-day | Killed with the Widesl result: the combined split reads +₹16 [−201, +224] over its whole-day control and −₹260 [−446, −85] against T1 as traded; the Dir winners on other days transferred worst on the whole-day side (NIFTY Dir band A +220 → −65) | [Two-session sweep](../../common/two-session-sweep.md) |

## What we know

- With Adaptive picking, the Dir split is a wash with a deeper drawdown, and its interval is twice the
  Widesl's (±230 against ±130): a 21 % stop with re-entry is far noisier across a day boundary (BL-184,
  seen data).
- The morning half is the problem: a Dir closed at 13:00 earns ₹81 a day with a ₹42,574 drawdown, the
  morning's move stopping it before its one re-entry can earn. The afternoon Dir alone is nearly the whole
  day's earnings at two-thirds of its drawdown, as the afternoon Widesl pair was in BL-182.
- The gain, where there is one, sits in T1's selection year and reverses after it; 2026 H1 is the split's
  worst half-year (−23,531 against the whole day).
- The fixed NIFTY 09:17 file split at 13:00 does clear zero (+₹203 a day, lower bound +58) at a slightly
  deeper drawdown; SENSEX's fixed split triples the drawdown. Descriptive; a registration of its own
  would be needed.
- Adaptive takes ITM1 70–80 % of the time in every pool.
- No overall stop fixes the morning Dir (BL-184 E1, eight levels ₹500–4,000 on seen data): ₹1,500 reads
  +186 a day with the drawdown halved, but ₹1,000 (+93) and ₹2,000 (+80) sit at the files' +81 and the
  fixed `N_dir` 09:17 morning half at ₹1,500 earns +16 with an −85k drawdown; no level makes the split's
  interval clear zero.
- A profit lock does move the morning Dir (BL-184 E2, nineteen target / lock / lock-trail overlays on the
  recorded MTM paths): targets are noise, but six of eight locks and lock-trails beat the plain morning's
  net and all eight its drawdown, and the fixed `N_dir` / `S_dir` 09:17 files agree (+83–130 against +88,
  +261–332 against +252). The ₹3,000 → ₹2,000 lock reads +131 / −35,146 against +81 / −42,574 and helps in
  both periods; the second year stays near zero for every overlay; no overlay makes the split pass. The
  lead is a lock on a morning-closed Dir only: BL-105 already found locks change nothing on the whole day.

## Not yet tested

- An afternoon-only Dir (13:02–15:02 → 15:28, no morning set) as a rule of its own.
- The fixed NIFTY 09:17 → 13:00 + 13:02 → 15:28 Dir as a pre-registered comparison on its own.
- Other split times (12:00, 12:30, 13:30), two-plus-one books, an afternoon pick made at 12:55 — all
  "will not run" in BL-184 Phase 0.

## Related

- [Exit time](exit-time.md) (15:28 clearly best for a whole-day Dir; BL-147: a 14:55 close hurts);
  [Entry time](entry-time.md) (afternoon starts positive before charges, near breakeven after).
- [Widesl › session split](../widesl/session-split.md) (BL-182: the same shape, same verdict).
- Script: `packages/option-backtesting/research/bl184/run.py` over `research/common/split_replay.py`
  (outputs git-ignored; regenerate with it).

[bl184]: ../../../../backlog/BL-184-directional-split-session.md
[bl185]: ../../../../backlog/BL-185-two-session-sweep.md

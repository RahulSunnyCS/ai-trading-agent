# BL-192 — T1: at most one SL150% Widesl on a non-expiry day (live)

| | |
|---|---|
| **Priority** | P1 — owner's live change to the T1 book, from Fri 2026-10-30 |
| **Status** | Done |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-30 |
| **Depends on** | BL-191 (Amendment 2, arm D2), BL-113 (T1 track), BL-122 (the filter pattern), BL-172 (the morning rule) |
| **TODO.md row** | 3.10.55 |

## Context

BL-191 tested T1's SL150% NIFTY OTM1 Widesl (`N_wide-t1s4`). Removing it costs money; limiting T1 to one
copy on a day NIFTY does not expire (Amendment 2, D2) gave +₹40 a day [+8, +77] on 2025-10 → 2026-10,
changing 8 of 435 days, and removed every non-expiry day with two copies (those 8 days averaged −₹4,208
in T1). By BL-191's registered rule it is "no difference" (the drawdown bar was not reached). The owner,
2026-10-30, after comparing it with the C2 swap: "Let's do D2 cap from tomorrow."

## Goal

From the 09:16 pick of Fri 2026-10-30, T1's Adaptive picks hold at most one `N_wide-t1s4` on any day NIFTY
does not expire, exactly as BL-191's D2 replayed it; everything before that day reproduces as recorded.

## What was built

- `rotation/sl150_cap.py`: `applies(day, dte_n)`, `cap_picks` (the filter), `capped_runners_up`;
  kill switch `ROTATION_SL150_CAP_FROM` (`YYYY-MM-DD` | `off`).
- `pick.score_history` / `next_best` apply it to the rule lists (C); a capped block carries
  `sl150_capped` (the core before the cap). `pick.record` reads the switch before any wait.
- `morning._reproduces` / `choose` apply it, so the 09:19 / 09:21 top-up switches off last evening's
  second copy and switches on its replacement (a kept 09:17 copy stays).
- The T1 block of the 09:16 message adds "✂️ One SL150% Widesl only (non-expiry day)" when the cap changed the picks.
- Tests: `tests/unit/test_rotation_sl150_cap.py`.

## Checks (2026-10-30, before merge)

- The last 12 journal entries re-score to their recorded picks with the cap in place: Core 48 list
  blocks, T1 8, none differ.
- Tomorrow's expected T1 picks (VIX close 15.12, NIFTY 2 to expiry): `S_ditm1-t1s44_0917`,
  `N_wide-t1s4_1017`, `N_wide_1032` (was `N_wide-t1s4_1032`). Core unchanged.

## Risks

- The evening upload of 2026-10-29 put both SL150% copies on Shoonya's Quantiply account. The 09:21
  top-up switches the new pick on before the old one off; if Shoonya's algos-a-day limit (3) refuses
  the new one, the old copy runs and the top-up's message says so.
- T1's 60-day forward test (BL-113) now reads T1 with the cap from 2026-10-30 (logged there).

## Log

- 2026-10-30 — owner chose D2 over the C2 swap; built and tested the same night, PR 389. After review: an unknown NIFTY label is left uncapped (as BL-122), and the T1 message says when the cap acted.

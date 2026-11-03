# BL-113 — T1 parallel track: Adaptive over Core-298 plus the time-generic settings

| | |
|---|---|
| **Priority** | P1 — the only forward test of the research result that Adaptive improves with T1 |
| **Status** | In progress — build 2026-10-16; first forward entry Mon 2026-10-19 09:16 |
| **Type** | feature + research (forward test) |
| **Area** | options |
| **Created** | 2026-10-16 |
| **Depends on** | BL-058 (the live journal, lists and read-out), BL-104 (the sweep), the research item "day-type variants vs Adaptive" (T1 defined and replayed; on branch research/bl106-pool-poc, numbered when it merges) |
| **TODO.md row** | 3.10.29 |

## Context

The research item (day-type variants vs Adaptive, 2026-10-16) found that Adaptive choosing from **T1** — Core-298 plus nine
time-generic settings chosen on 2024-10-09 → 2025-10-08 only (each at the 25 rotation entry times,
223 extra variants) — beat Adaptive on Core-298 over the unseen year 2025-10-09 → 2026-10-09:
+₹223 per lot-day gross (90 % interval [+82, +361]), +₹204 net, with a shallower drawdown. Its
first-year (in-sample) edge was the same size (+₹216). Every pruning tried lowered it. The owner
(2026-10-16): track T1 forward, unchanged — no day-type weight, no filter, no pruning.

## Owner answers (2026-10-16)

- Lists: **Adaptive only** (list C).
- Telegram: **private chat only, labelled T1 TRACK** (never the rotation group; first asked as "SHADOW", renamed with the code to avoid the BL-083 Shadow scoreboard's name).
- Pass rule: **60 trading days, BL-058 style** (below).
- Start: **Mon 2026-10-19, 09:16**.

## Plan

### Phase 0 — Pre-register (this file, committed before the first entry)

- **Hypothesis:** Adaptive over T1 earns more per lot-day than the live Adaptive over Core-298, with
  a drawdown no worse, on forward days.
- **What runs:** each trading day, right after the live pick and before 09:17, `obt rotation pick
  --track t1` scores Core-298 + `strategies/rotation_t1/` (223 frozen files) with the registered
  Adaptive weights and lookbacks, and appends the Adaptive picks to its own hash-chained journal
  (`TRADING_DATA_ROOT/rotation/track_t1/journal.jsonl`). Each evening (21:00) `obt rotation update
  --track t1` stores the extra variants' results in `rotation/track_t1/results/` for every day
  Core-298 has that the track lacks, and the 09:16 job repeats it as a catch-up before the track
  pick; the track pick refuses (alert) rather than rank on fewer days than the live list. The live
  journal, results folder, read-out and dashboard pages are untouched.
- **Read-out (`obt rotation track-readout --track t1`):** over forward days both journals hold
  (each recorded before 09:17) and whose picks are scored: track Adaptive minus live Adaptive, ₹ per
  lot-day (mean of the picks' one-lot gross), two-sided 90 % interval from the circular 5-day block
  bootstrap (2,000, seed 20261012).
- **Pass rule, read once on the first 60 forward days (later days are descriptive only):** the interval's lower bound above zero AND the track's max
  drawdown per lot no worse than the live list's. Otherwise the live list stays as it is. Not read
  early for a decision.
- **Frozen:** the 223 files are never edited; the history before the first entry was backfilled with
  the same engine (parity checked against the research simulation, 28 of 28 variant-days equal).
- **Will not:** trade, change the live list, add a weight or filter, or swap settings mid-test.

### Phase 1 — Build (2026-10-16)

- Track names `<N|S>_<base>-t1s<set>_<HHMM>` (`rotation/variants.py`: `track_of`, `base_family`,
  `strategy_path`); results and journal routed to `rotation/track_t1/` (`store.result_path`,
  `journal_path(track=)`); `update --track t1 [--backfill]`, `pick --track t1`,
  `track-readout` (`rotation/track.py`); scheduler: `options-rotation-t1-update` (21:00)
  and a second step in `options-rotation-pick`.
- **Done when:** tests pass, the backfill covers every Core-298 day, a dry-run pick for the next day
  succeeds, merged, and the live checkout runs the new code.

### Phase 2 — Forward (from 2026-10-19)

- Read-out at 60 forward days; result recorded here and in the research item.

## Risks

- Re-entry RE COST ×2 (three of the nine settings) is not yet matched against an AlgoTest export
  (BL-009); the track measures our engine's fills, not AlgoTest's.
- No slippage in either list; T1 re-enters more often.

## Log

- 2026-10-16 — created; owner answers recorded; Phase 1 built and backfilled.
- 2026-10-16 — code review (Opus) of PR 239: live path verified unchanged; fixed: catch-up of missed days and a refusal when the track's days differ from Core's, the verdict read on the first 60 days only, track hints in errors, a retry answering "already recorded" before any VIX read, no live `days.csv` writes from the track, the dirty flag covering `strategies/rotation_t1`, the track journal's chain checked in the read-out.
- 2026-10-16 — owner: track T1 only; BL-112's Group Leaders (New-556) track is superseded (test year: New-556 −₹98 per lot-day vs Core, T1 +₹223). Renamed "shadow" → "parallel track" before merge (the repo's word; "Shadow" is the BL-083 scoreboard).
- 2026-10-30 — owner: T1 amended from the 09:16 pick of Fri 2026-10-30: at most one `N_wide-t1s4` (SL150% NIFTY OTM1 Widesl) on a day NIFTY does not expire (BL-192, from BL-191 Amendment 2). The 60-day read-out keeps counting from 2026-10-19; read it with the change on this day in mind (the cap changed 8 of 435 replayed days).

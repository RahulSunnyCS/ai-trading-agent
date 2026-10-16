# BL-117 — T1 edge monitor: is the track's edge still there?

| | |
|---|---|
| **Priority** | P1 — the T1 track (BL-113) starts 2026-10-19; the alarm rules must be fixed before its days are seen |
| **Status** | Planned |
| **Type** | feature + research |
| **Area** | options |
| **Created** | 2026-10-17 |
| **Depends on** | BL-113 (track journal and results), BL-115 (T1), BL-058 (read-out arithmetic, `rankic.py`) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner (2026-10-17, chat): a way to tell whether T1's edge is fading — e.g. each day, where T1's picks rank
(percentile) among the whole universe, with an alarm when that falls (the owner's example: 93–94 normally,
alarm at 84–85).

Measured on the history (2025-01-10 → 2026-10-09, T1's Adaptive picks inside the 521-variant T1 universe,
`scratchpad` check 2026-10-17, gross):

| | First year | Test year |
|---|---|---|
| Mean pick percentile (day to day sd) | 56.1 (24.7) | 59.2 (22.9) |
| Share of random same-size baskets beaten | 57.9 | 62.6 |

- 60-day rolling mean percentile over both years: min 53.2, median 57.7, max 64.6. With no skill it would
  be 50, 90 % of 60-day windows between 46.4 and 53.7. So the useful scale is 50 → 60, not 85 → 95.
- By quarter the percentile stayed 54–65, including Jul–Oct 2026, when frozen T1 only tied Core-298
  (−10 per lot-day): the percentile measures the **picker's skill inside the universe**, not whether the
  added settings beat Core. Both need watching.

## Goal

A nightly, read-only monitor with alarm rules fixed before the track's first day, answering three separate
questions: is the picker still choosing above-average variants; do the added T1 settings still beat their
Core templates; is T1 still ahead of Core-298's Adaptive.

## Out of scope

- Changing the track, its sets or the live lists (an alarm is information for the owner, not an action).
- The formal verdict: BL-113's 60-day read-out stays the decision; this is the early warning.

## Plan

### Phase 0 — Pre-register (before 2026-10-19 09:16)
- **Signals (forward track days only, gross per lot-day):**
  1. **Pick percentile:** mean percentile of the day's T1 picks among the 521 T1 variants; 60-day rolling
     mean. Alarm: below 53.7 (the no-skill 95th percentile) on two weekly checks in a row.
  2. **Rank IC:** Spearman between the 09:16 composite and the day's P&L across all 521 (BL-058's
     `rankic.py`, the continuous form of signal 1, more power). Alarm: 60-day mean IC ≤ 0 with its 90 %
     interval below the history's 10th percentile.
  3. **Setting edge:** each T1 setting's day P&L minus its Core template at the same entry time, averaged
     over the 223; 60-day rolling. Alarm: rolling mean below zero with the 90 % interval below zero.
  4. **Gap to Core:** T1 Adaptive minus Core-298 Adaptive per lot-day, CUSUM against the expected
     +₹100 (the walk-forward-adjusted estimate). Alarm: the CUSUM crosses −2 standard errors of the gap.
- **Context, not alarms:** each signal split by VIX band and expiry / non-expiry, so "edge gone" can be
  told from "a regime where T1 never had an edge".
- **Calibration:** the thresholds are set from the 2025-01 → 2026-10 history above and written here
  before the first track day; never edited after.

### Phase 1 — Build
- **Tasks:** `obt rotation track-monitor --track t1` (read-only; reads both journals and the stored
  results); a weekly Telegram line (private) after the Friday results; tests on synthetic series.
- **Done when:** it reproduces the history figures above and runs on the first track week.

## Risks

- Early days are noise: no alarm is read before 20 track days.
- Signals 1 and 2 can stay healthy while signal 4 fails (the picker is fine but the added sets no longer
  beat Core), as in Jul–Oct 2026; that is why all four are kept.

## Open questions

1. The four signals and thresholds as drafted, or simpler (signals 1 and 4 only)?
2. Weekly Telegram line, or only on an alarm?

## Log

- 2026-10-17 — created from the owner's idea (percentile of the picks); history measured; P1.

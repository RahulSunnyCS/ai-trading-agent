# BL-121 — Holiday-shifted expiry days: does the rotation earn less on them?

| | |
|---|---|
| **Priority** | P2 — owner's question ahead of Mon 2026-10-19 (NIFTY expiry moved a day earlier by Dussehra); descriptive |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (the lists and stored results), BL-113 (T1), BL-109 (weekday DTE) |
| **TODO.md row** | — |

## Context

Owner (2026-10-18): tomorrow's NIFTY expiry is moved a day earlier by a holiday (Dussehra on Tuesday
20 Oct, so the Tuesday expiry falls on Monday 19 Oct). "Go through the previous 4 years and 2 years,
and whenever the expiry changed, see how Core and T1 worked: do our strategies make less profit on
those days compared with a proper expiry?" The rotation never looks at whether an expiry was moved.

## Goal

A measured answer, with the small sample stated, to: on holiday-shifted weekly expiry days, do the
strategies, and Adaptive on Core-298 and on T1, earn less per lot-day than on ordinary expiry days of
the same index? Descriptive: no list, weight or trade changes.

## Out of scope

- Any rule built on the answer (skip, shrink or re-weight a moved-expiry day): a new registered test.
- Other index events (budget, results, policy days).

## Plan

### Phase 0 — Pre-register
Committed before `research/bl121/moved_expiry.py` (the P&L script) is written or run. Only
`events.py`, which lists dates and reads no results, has run.

- **Hypothesis:** a holiday-shifted expiry day earns less per lot-day than an ordinary expiry day of the
  same index. (Direction asked by the owner; no direction is assumed to hold.)
- **Events** (`research/bl121/events_2026-10-18.json`, from the option files' nearest weekly expiry per
  day, 2022-01-03 onward): an expiry is **moved** when its weekday is earlier than the index's regular
  weekday (the most common weekday of the 8 expiries before and after) and the regular date was not a
  full trading session (no 1-minute index bars, or a short Muhurat session). A **normal expiry day** is an
  expiry on the regular weekday. One regime change (NIFTY 2025-09-02, Thursday to Tuesday) is dropped.
  - NIFTY, 13 moved: 2022-04-13, 2023-01-25, 2023-03-29, 2023-06-28, 2024-04-10, 2024-08-14,
    2025-04-09, 2025-04-30, 2025-10-20, 2026-03-02, 2026-03-30, 2026-04-13, **2026-10-19** (outcome not
    yet known: excluded from every result below, read out separately on the evening of 2026-10-19).
  - SENSEX, 7 moved: 2024-10-31, 2024-11-14, 2025-10-01, 2025-12-24, 2026-01-14, 2026-03-25, 2026-05-27.
  - Normal expiry days: 237 NIFTY, 97 SENSEX.
- **Windows and data:**
  - *Four years, NIFTY only:* the 149 NIFTY variants of Core-298, per-day gross per lot, from the P3
    research results (`research/bl071/results`, 124 variants, 2022-01-03 → 2024-10-08; the 25 Dir ITM1
    variants from `research/bl080/results`) joined to the live store from 2024-10-09. Family means
    (Widesl, Dir, Buy) per day over that index's variants.
  - *Two years, both indices:* the live store (Core-298) and the T1 results, 2024-10-09 → 2026-10-16;
    **Adaptive** (list C) picks reconstructed by the registered `score_history` over the stored results
    (2025-01-10 → 2026-10-16, after the 63-day warm-up), the basket's gross per lot-day as in the daily
    log. T1's settings were chosen on 2024-10-09 → 2025-10-08, so T1 is in-sample for part of this.
- **Metrics:**
  1. **Primary:** Adaptive on Core-298, moved expiry days minus normal expiry days of the same index
     (both indices pooled; each day compared with the mean of its own index's normal expiry days in the
     same window), in gross ₹ per lot-day. Difference of means with a 90 % bootstrap interval over days
     (5,000 resamples, seed 20261018; days are not treated as a time series).
  2. The same for Adaptive on T1.
  3. Family view (four years, NIFTY): moved minus normal for each family, with the same interval.
  4. A table of every event: the day's Core and T1 Adaptive result and the mean of its comparators.
- **Reading rule (fixed now):** moved days are **worse** only if the primary interval lies entirely below
  zero; **not worse** only if its lower bound is at or above zero; otherwise **inconclusive**. With 11 or
  fewer moved days in the two-year window the interval is expected to be wide, and the result will be
  stated as inconclusive if it is.
- **Look-ahead check:** this is an after-the-fact description of days, not a selection rule; the picks are
  the registered ranking on results before each day.
- **Hold-out:** none; descriptive.
- **Will not run:** another event definition, another window, dropping an event after seeing its result,
  any basket rule. Each needs a new dated block and `override: <reason>`.

## Risks

- **Tiny sample:** 13 NIFTY and 7 SENSEX events over the whole period, about 11 in the Adaptive window.
- Moved days often coincide with other conditions (holiday weeks, low volume); not separated.
- Core-298's stored results and the P3 research results are two runs of the same engine; the seam at
  2024-10-08 / 09 is checked in the script.

## Open questions

None.

## Log

- 2026-10-18 — created from the owner's request; events listed before any result was read.

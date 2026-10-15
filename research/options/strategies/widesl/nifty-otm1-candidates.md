# Widesl: NIFTY OTM1 candidate settings (watch list)

**Status:** Descriptive (the registered rule killed every candidate; these are kept as leads) ·
**Last updated:** 2026-10-15

## What it is

Two settings the owner chose to keep from the BL-104 NIFTY Widesl OTM1 experiment. Neither is
adopted: the registered rule (5 of 7 times, risk gates, bootstrap, luck line, plateau) passed 0 of
216 candidates, so the Core-298 template stands. This page holds them so the idea is not lost and so
a later test, or the forward journal, can be pointed at them.

The template is `N_wide_*`: leg SL 115%, trail 15/10, overall MTM ₹2,500, exit 15:28, no re-entry.

## The two settings

| | Setting | Where it is meant to be used (owner, 2026-10-15) |
|---|---|---|
| **A** | Leg SL **150%**, trail **25/15**, MTM **₹4,000**, exit 15:28, re-entry at cost ×1 | Expiry days |
| **B** | Leg SL **120%**, trail **15/10**, MTM **₹3,000**, exit 15:28, re-entry at cost ×1 | Other days |

The use column is the reading of the owner's note ("for this we can use [A]; second, keep [B]")
after the expiry-day split below. It is not a registered rule; confirm before any test.

## Numbers (net after charges, ₹ per lot-day, 7 entry times averaged, 488 days)

NIFTY weekly expiry days from `expiries_observed.csv`: 104 of 488 (53 in the first year, 51 in the
test year). Gain is the setting minus the template on the same day.

| | Expiry days | Other days | Gain on expiry days | Gain on other days |
|---|---:|---:|---:|---:|
| Template | 517 | 35 | n/a | n/a |
| A | 634 | 78 | +117 | +43 |
| B | 567 | 59 | +50 | +24 |

By year (gain over the template, expiry days / other days):

| | First year (2024-10 → 2025-10) | Test year (2025-10 → 2026-10) |
|---|---:|---:|
| A | −28 / +67 | +268 / +18 |
| B | −4 / +31 | +107 / +17 |

Registered-experiment figures, test year, 7 times pooled (from the BL-104 OTM1 result):

| | Test-year gain | 90% interval | Times better (of 7) | Max DD vs template | Worst day vs template |
|---|---:|---|---:|---:|---:|
| A | +70 | [−2, +140] | 7 | 0.94× | 1.39× |
| B | +36 | [−9, +82] | 6 | 0.95× | 1.07× |

## What we know

- About 80% of the template's profit comes from the 21% of days that are expiry days; the other
  days are close to flat (₹35 a lot-day).
- A adds the most on expiry days but has a fatter single-day tail (worst day 1.39× the template);
  B keeps the tail within 1.1× and gives a smaller gain.
- **The gain does not come from the same days in both years.** A lost to the template on expiry days
  in the first year (−28) and made +268 in the test year, on 51 days; on other days it was +67 then
  +18. Treat "A on expiry days, B otherwise" as a hypothesis, not a result: it was formed after
  looking at both years, so it is in-sample.
- The two settings' daily P&L correlate 0.92 (0.80–0.87 per slot), so running both side by side
  adds almost no diversification; a 50/50 mix lands between them.
- None passes the luck line: the best of 216 by chance is about +₹197 a lot-day.

## Not yet tested

- An expiry-day switch (A on expiry days, B or the template otherwise) as a pre-registered rule,
  forward-only or on the 2022-24 NIFTY vendor days as an advisory check.
- Whether the expiry-day effect holds on SENSEX (its expiry weekday differs, Thursday).
- Re-entry parity with AlgoTest (BL-009): both settings use RE cost ×1, which is unverified.

## Related

- [Leg stop](leg-sl.md), [Overall MTM stop](mtm-sl.md), [Trail](trail.md), [Re-entry](re-entry.md),
  [Days to expiry](days-to-expiry.md)
- Record: [BL-104](../../../../backlog/BL-104-full-parameter-sweep.md) → Experiments, 2026-10-15.
- Code and results: `packages/option-backtesting/research/bl104/otm1_one_setting.py`; the ranked
  tables are written under `research/bl104/results/otm1/` (git-ignored, regenerate with the script).

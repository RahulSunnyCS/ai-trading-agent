# Options: shared findings

**Last updated:** 2026-10-15

These pages hold findings that belong to no single strategy: they concern the basket, the money, the
ranking that picks strategies each day, or the market state that might time them. A strategy's
variable page links here instead of repeating them.

| Page | Status | One-line takeaway |
|---|---|---|
| [Portfolio stop](portfolio-stop.md) | Tested | A daily stop on the whole book trims the worst day; its effect on total and drawdown changes sign from mix to mix; no level passes |
| [Charges](charges.md) | Descriptive | Charges take 19–37% of gross in the rotations; at ₹20 an order Buy turns negative, Dir and Widesl survive thinly |
| [Rotation ranking](rotation-ranking.md) | Tested | The ranked basket beats random picks on the 2022–24 hold-out when the weekday / expiry / VIX fits carry it; recent return helps in one year and hurts in 2½ |
| [Intraday state](intraday-state.md) | Tested | No hourly market-state variable or VIX reading passes; two Dir trigger leads hold only in 2024–26 |
| [Index range persistence](index-range-persistence.md) | Tested | NIFTY's daily range persists: an expanded session is followed by ranges about 1.2–1.3× normal for days; a quiet one only raises the chance of another quiet day; VIX carries about half of it; confirmed on 2016–21 with a close-to-close proxy |
| [Correlation](correlation.md) | Descriptive | Widesl variants are near-copies (0.85–0.92); Buy moves against Widesl; a correlation cap is registered, not run |

## The periods these pages use

| Name | Dates | Index | Used as |
|---|---|---|---|
| P1 | 2025-12-03 → 2026-10-08 (202 selection days) | NIFTY + SENSEX | the year the rotation rule was built on |
| P2 | 2025-01-10 → 2025-08-29 (157 days) | NIFTY + SENSEX | out-of-period slice (BL-071 part A) |
| P3 | 2022-04-05 → 2024-10-08 (618 days) | NIFTY only | the hold-out (BL-071 part B; imported vendor data) |
| BL-096–099 split | fit 2024-10-09 → 2025-10-08, holdout 2025-10-09 → 2026-10-09 | NIFTY + SENSEX | the parameter sweeps |

Most rotation results are **before charges** (stored variant results carry costs 0). Each page says
which.

## Related

- Strategy pages: [Widesl](../strategies/widesl/README.md), [Directional](../strategies/directional/README.md),
  [Buy](../strategies/buy-breakout/README.md).
- The forward journal that judges the lists on unseen days: [BL-058][bl058].

[bl058]: ../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md

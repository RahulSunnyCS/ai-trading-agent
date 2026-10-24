# Buy: strike / premium

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Which call and put are bought. Either a target premium (`strike: { closest_premium: 50 }`, the option
whose price is nearest ₹50 at the entry time) or a fixed moneyness (`strike: { strike_type: ATM }`,
`OTM1`, `OTM2`). Both legs always use the same rule.

## Live value

`closest_premium: 50` in the live file and all 48 rotation files, NIFTY and SENSEX alike.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | ATM, OTM1, OTM2; closest ₹30, ₹40, ₹60, ₹75, ₹100 (base ₹50) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; no row in a top-three list | [BL-097][bl097], [report][bl097q] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ gross | Fit Δ net | Holdout Δ gross | Holdout Δ net | Holdout Δ drawdown | Files ≥ base | Files net > 0 |
|---|---|---|---|---|---|---|---|---|
| ATM | 48 | +18,296 | +14,356 | +11,679 | +6,860 | −16,178 (deeper) | 50% | 17 |
| OTM1 | 48 | +20,389 | +17,574 | +8,891 | +5,268 | −12,144 | 58% | 17 |
| OTM2 | 48 | +15,465 | +13,482 | +10,562 | +7,975 | −7,822 | 62% | 16 |
| ₹30 | 48 | −3,138 | −2,058 | −148 | +987 | +4,651 | 54% | 2 |
| ₹40 | 48 | −2,055 | −1,567 | +300 | +833 | +2,727 | 50% | 2 |
| ₹60 | 48 | +860 | +420 | −1,271 | −1,793 | −2,840 | 40% | 3 |
| ₹75 | 48 | +2,941 | +1,848 | −535 | −1,775 | −6,133 | 48% | 6 |
| ₹100 | 48 | +7,109 | +5,078 | −2,983 | −5,291 | −12,405 | 33% | 4 |

The baseline (₹50) has 3 files net positive in the holdout.

## What we know

- Fixed strikes (ATM, OTM1, OTM2) buy dearer options and lift gross P&L in **both** periods; after
  charges they are the only rows with a positive fit year in aggregate and the most files net
  positive in the holdout (16–17 of 48). This is the strongest before-charges lead in the Buy sweep.
- They also deepen the holdout drawdown by ₹7.8k–₹16.2k a file and pay ₹2.6k–₹4.8k more charges. The
  pass rule allows no more than 5% deeper drawdown, so as they stand they would fail it.
- Cheaper premiums (₹30, ₹40) earn less gross in the fit year and gain a little net in the holdout,
  mostly through lower charges, with shallower drawdowns. Dearer premiums (₹60–₹100) gain in the fit year and lose in the
  holdout: a sign flip, so no premium is reliably better than ₹50.
- One holdout year, one-factor screen, no interaction run. BL-097 asked whether ₹100 has enough chain
  coverage; all 48 files ran for every premium, but per-day coverage was not reported.

## Not yet tested

- BL-097 Phase 3, now BL-104: strike × breakout window and strike × leg stop, with the drawdown gate.
- A SENSEX-specific premium (SENSEX uses NIFTY's ₹50; [BL-056][bl056] kept the NIFTY rupee values).

## Related

- [Widesl strike / premium](../widesl/strike-premium.md), [Directional strike / premium](../directional/strike-premium.md),
  [charges](../../common/charges.md).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

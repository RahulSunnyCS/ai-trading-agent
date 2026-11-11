# Directional: MCX commodity options (evening)

**Status:** Tested · **Last updated:** 2026-11-11

## What it is

The same Dir — sell the CE and PE at ITM1 or ATM, leg stop, optional one re-entry at cost — run
on MCX commodity mini options in the **evening session** (17:00–close), on the expiring monthly
contract, in the **expiry week** (the 5 sessions ending on expiry day) and the **week before**
(the 5 before those). Strikes are picked off the future the option settles on. 1 lot, 1% slippage
on every fill, MCX charges (₹20 an order, CTT 0.05% on sells, MCX 0.0418%, stamp, GST)
([BL-218][bl218]). Set by `underlying: CRUDEOILM | NATGASMINI | GOLDM | SILVERM`.

## Live value

None: nothing trades MCX.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-218 | entry 17:05/18:00/19:00/20:00 × ITM1/ATM × leg SL 15/21/30% × re-entry none/cost×1 × exit 22:00/close (96 cells) on CRUDEOILM, NATGASMINI, GOLDM, SILVERM, expiry week and week before | fit = expiries Nov 2024–Oct 2025, test = Nov 2025–Oct 2026 (~60 sessions a cohort a year; SILVERM 40 in the fit year); **after charges, 1% slippage** | **One pass: GOLDM, expiry week**, 18:00 ITM1, SL 21%, cost×1, held to the close. Every other cohort killed or failed the test year | [BL-218][bl218] |

## What we know

- **Gold mini, expiry week, passed all five registered rules** on the untouched year: ₹96,369 a lot
  (₹1,606 a session, PF 2.80, LB +₹653), ₹120,279 at 0.5% slippage, ₹135,980 at 0%; fit year
  ₹60,979; up in 10 of 12 fit and 9 of 12 test expiries; 6 of its 7 neighbouring cells positive
  on the test year (descriptive). Caveats: both years were a gold bull run, the test-year gain
  leans on Jan–Mar 2026, ~60 sessions a year, one pass among 8 finalists of 48 cohorts.
- Gold mini, **week before**, passed the fit year (PF 9.9) and lost ₹26,732 on the test year.
- Silver mini passed the fit year in both weeks and failed the test (expiry week −₹37,572; week
  before +₹26,536 with LB −₹513, 72% of it from one expiry).
- **Crude and gas minis are gross-positive but charge-negative**: on one lot (₹10 / ₹250 a point)
  four orders of ₹20 brokerage + GST (~₹94) outweigh a gross of +₹40 (crude) / +₹82 (gas) a
  session. Gas expiry week passed the fit year and failed the test (−₹6,966).

## Not yet tested

- A forward paper test of the gold expiry-week cell (no live money on this evidence).
- More lots per order, or the standard contracts (spreads brokerage over more rupees a point):
  outside BL-218's pre-registration.
- Option margin per lot on MCX; the real bid-ask spread on gold and silver mini options.

## Related

- [Widesl on MCX](../widesl/mcx-commodities.md), [Buy on MCX](../buy-breakout/mcx-commodities.md).

[bl218]: ../../../../backlog/BL-218-mcx-commodity-options-sweep.md

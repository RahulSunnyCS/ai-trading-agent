# Widesl: MCX commodity options (evening)

**Status:** Tested · **Last updated:** 2026-11-11

## What it is

The same Widesl — sell an OTM1 or OTM2 CE and PE, wide leg stop, optional trail — run on MCX
commodity mini options in the evening session, expiry week and week before, on the expiring
contract, strikes off the settling future; 1 lot, 1% slippage, MCX charges ([BL-218][bl218]).

## Live value

None: nothing trades MCX.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-218 | entry 17:05/18:00/19:00/20:00 × OTM1/OTM2 × leg SL 80/115/150% × trail none/15-10% × exit 22:00/close (96 cells) on CRUDEOILM, NATGASMINI, GOLDM, SILVERM, expiry week and week before | fit Nov 2024–Oct 2025, test Nov 2025–Oct 2026; **after charges, 1% slippage** | **No pass.** Crude, gas and silver killed on the fit year; gold's two finalists failed the test year | [BL-218][bl218] |

## What we know

- Gold mini: expiry week (17:05 OTM1, SL 115%, trail 15/10, to close) ₹92,266 on the fit year,
  then ₹32,861 on the test year with LB −₹138, 56% of it from one expiry, and its cohort's PBO 0.55;
  week before (17:05 OTM1, SL 115%, out 22:00) ₹70,339 then **−₹61,402**.
- Silver mini is strongly gross-positive (+₹397 a session) but no cell had a stable plateau.
- Crude and gas minis are gross-positive (+₹28 / +₹50 a session) and charge-negative (~₹96–100).

## Not yet tested

- More lots per order, or the standard contracts (outside BL-218).

## Related

- [Directional on MCX](../directional/mcx-commodities.md), [Buy on MCX](../buy-breakout/mcx-commodities.md).

[bl218]: ../../../../backlog/BL-218-mcx-commodity-options-sweep.md

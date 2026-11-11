# Buy: MCX commodity options (morning and evening)

**Status:** Tested · **Last updated:** 2026-11-11

## What it is

Two buys on MCX commodity mini options, morning (09:00–17:00, out 16:55) and evening (17:00–
close), expiry week and week before, the expiring contract, strikes off the settling future, 1 lot,
1% slippage, MCX charges ([BL-218][bl218]):

- **Range breakout**: CE and PE, each bought when it breaks its range (the option's own high, or
  the future's high for the CE and low for the PE).
- **Timed buy**: CE + PE, CE only or PE only, bought at a fixed time, with stop and target.

## Live value

None: nothing trades MCX.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-218 | breakout: ATM/OTM1 × range start (09:15/10:30/12:00, evening 17:00/18:30/20:00) × range 10/15/30 min × source instrument/underlying × SL 25/40% × target none/100% × trail none/20-10% (288 a session); timed: every 30 min (09:15–12:45, evening 17:00–21:00) × ATM/OTM1 × CE+PE/CE/PE × SL 25/40% × target none/50/100% (288 / 324) | fit Nov 2024–Oct 2025, test Nov 2025–Oct 2026; **after charges, 1% slippage** | **No pass.** Every cohort killed on the fit year except GOLDM's evening breakout in expiry week, which then lost on the test year | [BL-218][bl218] |

## What we know

- The buys lose **before** charges on most roots and sessions: evening breakout and evening timed
  buys on crude are gross-negative on all 612 cells; gold and silver evening timed buys average
  −₹418 / −₹475 a session gross.
- GOLDM evening breakout, expiry week (OTM1, range 18:30 + 15 min on the option, SL 25%, target
  100%, trail 20/10): ₹31,657 on the fit year, **−₹25,016** on the test year.

## Related

- [Directional on MCX](../directional/mcx-commodities.md), [Widesl on MCX](../widesl/mcx-commodities.md).

[bl218]: ../../../../backlog/BL-218-mcx-commodity-options-sweep.md

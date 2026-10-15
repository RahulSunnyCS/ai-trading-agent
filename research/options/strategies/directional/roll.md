# Directional: roll the decayed leg

**Status:** Tested · **Last updated:** 2026-10-15

## What it is

When a sold leg's premium has decayed to a fraction f of its entry price, close it at that bar's close
and sell a fresh leg at the next minute's open, at the new strike chosen by the leg's own rule (or at
ATM), with its own stop. Set per leg by `roll` in `legwise/schema.py` (`decay`, `min_day_profit`,
`stop_loss_percent`, `to_atm`, `max_rolls`, `not_after`), added in PR 229; unset by default and
omitted from saved specs, so no existing strategy changed.

## Live value

None (the field exists in the engine; no strategy file uses it).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-105 Phase 2 | f = 15 / 25 / 35 / 45 / 50 / 70 %; any time or only after ₹3,000 day profit; new-leg stop 21 % or 30 %; roll to the base's strike type, and to ATM on ITM bases; one roll, not after 13:30; ATM / ITM1 / ITM2 bases with and without a 10/5 trail; 7 slots; NIFTY and SENSEX | 2024-10-09 → 2026-10-09, 1 lot, **after charges** | **Killed**: 0 of 336 settings passed the registered rule | [BL-105][bl105] |

Mean change against the unrolled base, ₹ per lot-day, 21 % stop on the new leg ([BL-105][bl105]):

| Trigger f | NIFTY any time / after ₹3k | SENSEX any time / after ₹3k |
|---|---|---|
| 15 % | +5 / +7 | −1 / +2 |
| 25 % | +1 / +2 | −13 / −5 |
| 35 % | −15 / −6 | −15 / −10 |
| 50 % | −21 / −18 | −30 / −8 |
| 70 % | −35 / −31 | −33 / +6 |

## What we know

- Rolls are rare at tight triggers (4 % of days at f = 15 %) and common at loose ones (53 % at 70 %);
  tight triggers change nothing, loose ones lose money.
- The risk is bounded as the owner expected: the worst single day is slightly better than the base's
  and the maximum drawdown is 1–17 % deeper. There is simply no edge: the other leg's decay is already
  the profit, and a roll adds two orders and re-opens risk at a new strike.
- A 30 % stop on the new leg, and rolling to ATM, change the mean gain by only a few rupees either way.

## Not yet tested

- Rolling on an index-move trigger instead of premium decay.

## Related

- [Re-entry](re-entry.md) (a roll uses the ASAP re-entry path), [profit rules](profit-lock.md).

[bl105]: ../../../../backlog/BL-105-dir-trade-management-tests.md
[bl095]: ../../../../backlog/BL-095-portfolio-mtm-stop-in-rotation.md

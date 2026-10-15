# Directional: restart after a profit cut

**Status:** Tested · **Last updated:** 2026-10-15

## What it is

After the day's profit rule closes everything (a target T, or a lock at A / 2 after reaching A), start
the same strategy again from the next minute with fresh strikes and stops, once or twice, and not after
14:00. Built by running the engine again from the cut minute; no engine field.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-105 Phase 1 | after a target T = ₹2,000 / ₹3,000 / ₹4,000, or a lock A = ₹3,000 / ₹4,000; 1 or 2 restarts; same bases, slots and indices as the profit rules | 2024-10-09 → 2026-10-09, 1 lot, **after charges** | **Killed**: no setting passed the registered rule | [BL-105][bl105] |

## What we know

- NIFTY loses ₹20–44 per lot-day against the base after a target; SENSEX gains ₹18–33 at T = ₹3,000 or
  ₹4,000 on average, with at most 2 of 7 slots passing.
- **Lead, not a result:** SENSEX restart after a ₹3,000 target gains ₹100–240 per lot-day in the
  09:17–10:17 slots and loses ₹25–90 from 11:32 on (ITM1 and ITM2 bases, no leg trail). Its bootstrap
  interval includes zero, and a morning-only rule would be chosen after seeing the result: it needs its
  own registered test.
- Unlike a cut, a restart re-opens risk: the worst-day gate bound in 2 of the 1,596 cases.
- Not computed: restart against simply entering at a later slot the same day (the registered
  comparator), so overlap with the rotation's later slots is unmeasured.

## Not yet tested

- The SENSEX morning lead as its own pre-registered test; the later-slot comparator.

## Related

- [Profit target, lock and trail](profit-lock.md), [entry time](entry-time.md).

[bl105]: ../../../../backlog/BL-105-dir-trade-management-tests.md
[bl095]: ../../../../backlog/BL-095-portfolio-mtm-stop-in-rotation.md

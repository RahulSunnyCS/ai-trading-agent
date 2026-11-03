# Directional: profit target, lock and trail on the day's profit

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

A rule on the strategy's combined profit for the day (realised plus open, per lot). Three forms were
tested: a **target** that closes everything when profit reaches T (`overall.target_inr`); a **lock**
that, once profit reaches A, closes everything if it falls back to A / 2; and a **lock and trail** that
also raises the lock by A / 4 for every A / 2 of further profit (the BL-095 basket logic applied to one
strategy). The engine has the target field; lock and trail are not engine fields and were replayed on
the engine's per-minute profit path, checked against the engine's own target exit (75 checks, 0
mismatches).

## Live value

None: the live file, the fixed base and the rotation files have no profit rule.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-184][bl184] E2 | target ₹500 … ₹4,000 (11 levels), lock (arm → lock) at 2k→1k, 3k→1.5k, 3k→2k, 4k→2k, 4k→3k, lock-and-trail (arm, breakeven, 1:1) at 2k / 3k / 4k — on a **morning-only** Dir (09:17–12:47 → 13:00, Adaptive's one pick from Core's four Dir families), replayed on the engine's per-minute profit path | 434 pick days 2025-01-10 → 2026-10-27, after charges, seen data, descriptive sweep | Targets noise; six of eight locks / lock-trails beat the plain morning's net (+81) and all eight its drawdown (−42,574), the fixed `N_dir` / `S_dir` 09:17 morning halves agreeing; ₹3,000 → ₹2,000 lock +131 / −35,146, helping in both periods; the second year near zero for every overlay. A lead for a morning-closed Dir only; the whole-day verdict above stands | [Session split](session-split.md) |
| BL-105 Phase 1 | target T, lock A, lock-and-trail A, each at ₹2,000 / ₹3,000 / ₹4,000; on ATM, ITM1, ITM2 bases with and without a 10/5 leg trail; 7 entry slots; NIFTY and SENSEX | 2024-10-09 → 2026-10-09, 1 lot, **after charges** | **Killed**: no setting passed the registered rule (bootstrap gain over the base, drawdown, worst day, half-years, in 4 of 7 slots) | [BL-105][bl105] |

Mean change against the same strategy without the rule, ₹ per lot-day ([BL-105][bl105]):

| Rule | NIFTY (₹2k / 3k / 4k) | SENSEX (₹2k / 3k / 4k) |
|---|---|---|
| Target | −79 / −35 / −10 | −103 / −16 / −2 |
| Lock at half | −15 / −1 / +5 | −25 / −2 / −3 |
| Lock and trail | −17 / +2 / +5 | −28 / −2 / −2 |

## What we know

- A one-lot day reaches ₹2,000 of open profit on 31–41 % of days, ₹3,000 on 16–28 %, ₹4,000 on 8–18 %
  (ATM least, ITM2 most), so the rules rarely act.
- Cutting at a target gives up the decay that is the strategy's profit; the tighter the target, the
  bigger the loss. Lock and trail change almost nothing.
- A cut can only shorten the tail: the worst-day gate never bound for these rules.

## Not yet tested

- Profit rules on the whole basket rather than one strategy: see the portfolio stop ([BL-095][bl095]).

## Related

- [Restart after a cut](restart.md), [roll the decayed leg](roll.md), [overall MTM stop](mtm-sl.md).

[bl105]: ../../../../backlog/BL-105-dir-trade-management-tests.md
[bl095]: ../../../../backlog/BL-095-portfolio-mtm-stop-in-rotation.md
[bl184]: ../../../../backlog/BL-184-directional-split-session.md

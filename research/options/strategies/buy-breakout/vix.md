# Buy: India VIX

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

India VIX, read either as the level at the 09:15 open (a band) or as its move during the day. Not a
setting in any Buy file. The idea is that a long-option breakout should do better when volatility is
high or rising. The rotation lists use the 09:15 VIX band as one ranking criterion.

## Live value

No VIX filter. The rotation lists weight a VIX-band fit at 17–24% of the composite
([rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | Mix switch at 10:00 on VIX 09:15 → 10:00 (+0.25 = "rose"); Buy got 2 lots on rising days | NIFTY, 2025-10-09 → 2026-10-08, before charges | Rule **killed**; Buy lost on both kinds of day: −₹77 a lot on rising days, −₹17 on quiet | [BL-053][bl053] |
| BL-056 | VIX band at the 09:15 open (<10.5, 10.5–11.5, 11.5–13, 13–15, 15–18, 18+) | 2025-09-01 → 2026-10-08, 11 start times, before charges | Descriptive (below) | [BL-056][bl056] |
| BL-081 | VIX up more than 2% since the open, at 10:30 and 11:30, for not-yet-started picks | P1 2025-12 → 2026-10, P2 Jan–Aug 2025, P3 2022-04 → 2024-10 | No state variable passes the three-period bar; direction flips (below) | [BL-081][bl081] |
| BL-083 | Enter at a VIX turn (up ≥ 2% on the day, then down ≥ 1% in 30 minutes) | explore 2024-10 → 2026-10; confirm NIFTY 2022-01 → 2024-10 | No lead: Buy −₹34 (t −0.6) explore, −₹157 (t −1.6) confirm against placebo | [BL-083][bl083] |

BL-056, Buy family mean ₹ per day per lot by VIX band at the open:

| Band | <10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 | 18+ |
|---|---|---|---|---|---|---|
| NIFTY (days) | −24 (35) | 269 (50) | −94 (70) | 201 (45) | 62 (24, thin) | −128 (43) |
| SENSEX | 1 | 91 | −4 | 36 | 60 | 37 |

BL-081, mean ₹ per pending Buy strategy-day at 10:30, VIX up > 2% / flat / down: P1 33 / −3 / 53,
P2 −44 / 11 / −7, P3 16 / 23 / 87.

## What we know

- No VIX reading helps Buy consistently. The NIFTY bands zig-zag (best and worst cells sit next to each
  other), SENSEX is flat, and the 18+ band is negative for NIFTY.
- A rising VIX did not help Buy in any test: −₹77 a lot (BL-053), mixed signs across periods (BL-081),
  negative after a VIX turn (BL-083).
- VIX's move up to 10:00 does not predict its move after 10:00 (rank correlation about 0.01,
  [BL-053][bl053] context).
- Everything here is before charges; Buy is negative after charges in every band of the day.

## Not yet tested

- A registered VIX filter for Buy alone, on unseen days.
- Expiry-specific implied volatility instead of India VIX (BL-091's Stage 2 used an ATM IV
  approximation for straddle tops, not for Buy).

## Related

- [Widesl VIX](../widesl/vix.md), [Directional VIX](../directional/vix.md),
  [intraday state](../../common/intraday-state.md), [rotation ranking](../../common/rotation-ranking.md).

[bl053]: ../../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl081]: ../../../../backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md
[bl083]: ../../../../backlog/BL-083-event-triggered-intraday-entries.md

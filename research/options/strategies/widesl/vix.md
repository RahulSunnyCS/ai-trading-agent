# Widesl: India VIX

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

The level or the move of India VIX, used to decide whether or how much Widesl to trade. BL-056 bands the
day by the 09:15 open of INDIAVIX: `<10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 | 18+`. No YAML field sets
it; a VIX rule sits outside the strategy (a gate, a mix switch, or a ranking criterion).

## Live value

None: the live strategies trade at any VIX. The rotation lists use a VIX-band fit as one ranking criterion
(17% in the REF weights; see [rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | Switch the 10:00 mix on VIX's 09:15 → 10:00 move (≥ 0.25 → 2 Widesl, else 4) | NIFTY, 2025-10-09 → 2026-10-08, before charges | **Killed** (+7.6% over the fixed mix, needed 10%); exploratory | [BL-053][bl053] |
| BL-056 | VIX band at the open, 11 morning start times | 2025-09-01 → 2026-10-08, before charges | Descriptive | [BL-056][bl056] |
| BL-060 | SENSEX ₹250 / ₹320 / OTM2 by VIX band | same | Descriptive: 15–18 worst for all three (about −₹330 to −₹376 a day) | [BL-060][bl060] |
| BL-081 | VIX change since the morning and 13 other states at 10:30–13:30, for picks not yet started | P1, P2, P3 (NIFTY 2022–24) | **Gate failed**: no state variable passes in all three periods | [BL-081][bl081] |
| BL-083 | Enter Widesl when VIX turns (T2) | explore 2024-10 → 2026-10, confirm NIFTY 2022-01 → 2024-10 | **No lead**: −₹215 (t −1.3) explore, −₹139 (t −1.1) confirm | [BL-083][bl083] |

**By VIX band at the open, ₹ per day per lot, family mean over 11 start times** ([BL-056][bl056]):

| Band | <10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 | 18+ |
|---|---|---|---|---|---|---|
| Days (NIFTY / SENSEX) | 35 / 34 | 50 / 49 | 70 / 70 | 45 / 47 | 24 / 24 | 43 / 43 |
| NIFTY OTM1 | 231 | 74 | 375 | 227 | 68 | −179 |
| SENSEX OTM2 | 112 | 82 | 175 | 254 | −401 | −104 |

## What we know

- In this one year Widesl was weak at VIX 18+ on both indices and SENSEX was weakest at 15–18 (24 days,
  thin). The two indices trade the same days, so that is not independent confirmation; cell differences
  under about ₹700 are noise (BL-056).
- A rising VIX in the morning goes with a weaker Widesl in one period only. At 10:00 in 2025–26 a 10:00
  Widesl made ₹66 a lot on VIX-up days against ₹241 on quiet days (BL-053). At 10:30, VIX up more than
  2% gave pending Widesl −₹44 vs ₹223 flat in P1, but ₹262 vs ₹175 in P2 and ₹226 vs ₹167 in P3
  (BL-081): the direction flips between periods.
- VIX's move up to 10:00 does not predict its move after 10:00 (rank correlation about 0.01, BL-053).
- Entering Widesl after a VIX turn loses: it is stopped out 27% of the time against 15% (BL-083).

## Not yet tested

- A pre-registered "no Widesl at VIX 18+" (or 15+) gate on unseen days, including NIFTY 2022–24.
- The futures-VWAP and real-volume states (BL-082).

## Related

- [Directional VIX](../directional/vix.md); [intraday state](../../common/intraday-state.md);
  [rotation ranking](../../common/rotation-ranking.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_vix.csv`; BL-081 states under `research/bl081/out/`.
  Git-ignored; regenerate with `research/bl056/analyse.py` and `research/bl081/state.py`.

[bl053]: ../../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl060]: ../../../../backlog/BL-060-sensex-widesl-closest-premium.md
[bl081]: ../../../../backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md
[bl083]: ../../../../backlog/BL-083-event-triggered-intraday-entries.md

# Directional: India VIX

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

The level or the move of India VIX, used to decide whether or how much Dir to trade. BL-056 bands the day
by the 09:15 open of INDIAVIX: `<10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 | 18+`. No YAML field sets it.

## Live value

None. The rotation lists use a VIX-band fit as one ranking criterion
([rotation ranking](../../common/rotation-ranking.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-053 | Switch the 10:00 mix on VIX's 09:15 → 10:00 move (≥ 0.25 → 2 Dir ITM1, else 1) | NIFTY, 2025-10-09 → 2026-10-08, before charges | **Killed**; exploratory | [BL-053][bl053] |
| BL-056 | VIX band at the open, Dir ATM, 11 morning start times | 2025-09-01 → 2026-10-08, before charges | Descriptive | [BL-056][bl056] |
| BL-081 | VIX change since the morning and 13 other states at 10:30–13:30, for picks not yet started | P1, P2, P3 (NIFTY 2022–24) | **Gate failed**: no state variable passes in all three periods | [BL-081][bl081] |
| BL-083 | Enter Dir when VIX turns (T2) | explore 2024-10 → 2026-10, confirm NIFTY 2022-01 → 2024-10 | **No lead**: +₹76 (t 0.4) explore, −₹210 (t −1.4) confirm | [BL-083][bl083] |

**By VIX band at the open, ₹ per day per lot, family mean over 11 start times** ([BL-056][bl056]):

| Band | <10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 | 18+ |
|---|---|---|---|---|---|---|
| Days (NIFTY / SENSEX) | 35 / 34 | 50 / 49 | 70 / 70 | 45 / 47 | 24 / 24 | 43 / 43 |
| NIFTY Dir ATM | 625 | 449 | 381 | 383 | −248 | 366 |
| SENSEX Dir ATM | 537 | 407 | 530 | 409 | −126 | 412 |

## What we know

- In this one year Dir was positive in every VIX band except 15–18 (24 days, thin), on both indices, and
  did well at 18+, where Widesl lost. Same-day markets, so the two indices are not independent; gaps under
  about ₹700 are noise (BL-056).
- A morning VIX rise did not hurt Dir. At 10:00, Dir made ₹453 a lot on VIX-up days against ₹374 on quiet
  days (BL-053). At 10:30, VIX up more than 2% gave pending Dir ₹307 vs ₹246 flat in P1, ₹206 vs ₹276 in
  P2, ₹154 vs ₹246 in P3 (BL-081): no stable direction.
- Most of the BL-053 gain came from starting at 10:00, not from switching on VIX.

## Not yet tested

- A pre-registered VIX 15–18 rule for Dir on unseen days (the cell is thin and may be noise).
- Dir ITM1 by VIX band (BL-056 ran ATM only).

## Related

- [Widesl VIX](../widesl/vix.md); [intraday state](../../common/intraday-state.md).
- Tables: `research/bl056/out/{nifty,sensex}_by_vix.csv` (git-ignored; regenerate with
  `research/bl056/analyse.py`).

[bl053]: ../../../../backlog/BL-053-vix-at-10am-strategy-mix.md
[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl081]: ../../../../backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md
[bl083]: ../../../../backlog/BL-083-event-triggered-intraday-entries.md

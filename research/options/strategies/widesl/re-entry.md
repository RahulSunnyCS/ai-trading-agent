# Widesl: re-entry

**Status:** Descriptive · **Last updated:** 2026-10-29

## What it is

Selling a leg again after its stop is hit. `legs[].reentry_on_sl: { mode: cost | asap, count: N }`:
`cost` re-sells the same contract when its price comes back to the original entry; `asap` re-selects the
strike by the leg's own rule and sells at the next minute. `no_reentry_after` (HH:MM) stops re-entries
after a cut-off.

## Live value

None. No live or rotation Widesl file re-enters.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-098 Phase 2 | none, RE COST ×1, ×2, RE ASAP ×1, ×2; cut-offs none / 11:00 / 12:00 / 13:00 with the re-entry rows | holdout 2025-10-09 → 2026-10-09, **after charges** | Descriptive; re-entry rows rank only on SENSEX ₹250 mornings | [BL-098][bl098], [report][bl098q] |

SENSEX 09:15–11:00, post-charge holdout: RE COST ×1 and ×2 give identical results (₹5,410 net, ₹22 a
day, about 6 re-entries over the year, drawdown −₹44,316), ranked second and third, against the leader (₹250 leg stop 80%,
no re-entry) at ₹5,697 and drawdown −₹32,996.

## What we know

- Re-entry adds turnover and charges for no visible gain: its only top-four rows are SENSEX ₹250 mornings,
  where it nets about the same as the leader with a 34% deeper drawdown.
- COST ×1 and ×2 being identical suggests a second re-entry never triggered on those files in the holdout.
- No NIFTY re-entry row reached a top-four list. ASAP and cut-off rows are in the raw file, not summarised
  in the item.

- A different strategy in place of a pick that stopped out by 12:15 (BL-190, book level, not this strategy's own re-entry): the strongest later Widesl or Dir adds nothing on T1 (−₹9 / −₹10 a margin lot-day, 95 % intervals ±₹45) and deepens the drawdown; slightly positive on NIFTY 2022-24 ([BL-190](../../../../backlog/BL-190-replace-early-stopped-pick.md)).

## Not yet tested

- Re-entry together with a different leg stop (BL-098 Phase 3, now BL-104, if a candidate needs it).
- Engine/AlgoTest parity for some re-entry details is incomplete ([BL-098][bl098] risks).

## Related

- [Directional re-entry](../directional/re-entry.md), where re-entry is part of the live design.
- Raw rows: `research/bl097/results/widesl_sweep_postcharge.csv` (git-ignored; regenerate with
  `research/bl097/run_family_sweep.py --family widesl`).

[bl098]: ../../../../backlog/BL-098-widesl-parameter-sweep.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md

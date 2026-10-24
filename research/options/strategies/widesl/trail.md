# Widesl: trail

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

A trailing leg stop. `[X, Y]` means every X in the leg's favour moves its stop Y in the same direction.
Set by `legs[].trail_sl: { percent: [X, Y] }` (percent of the entry premium) or `{ points: [X, Y] }`.

## Live value

`percent: [15, 10]` on NIFTY OTM1, SENSEX OTM2 and every rotation Widesl file. The live NIFTY closest-₹65
file uses `points: [15, 10]`, a different rule. The NIFTY OTM1 file was first transcribed in points and
corrected to percent against the owner's AlgoTest PDF (BL-009 Phase 1, noted in the file header).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-098 Phase 2 | none, [5,5]%, [10,5]%, [15,10]% (baseline), [20,10]%, [20,15]% | holdout 2025-10-09 → 2026-10-09, **after charges** | Descriptive; one trail row reached a top-four list | [BL-098][bl098], [report][bl098q] |

The one trail row in the post-charge top four: NIFTY ₹80, [5,5]%, 09:15–11:00: ₹23,989 net (₹52,147
before charges), ₹99 a day, 60.4% positive days, drawdown −₹28,430, the shallowest of that band's four
leaders (the others −₹29.1k to −₹36.7k).

## What we know

- No trail setting stands out after charges. A tighter trail ([5,5]%) appears once, on NIFTY ₹80
  mornings, ranked second, with a slightly shallower drawdown.
- The removal of the trail ("none") never reaches a top-four list, so there is no evidence against
  keeping a trail. That is a ranking reading, not a test.
- One holdout year, one factor at a time.

## Not yet tested

- Point trails `[1,1]`, `[2,1]`, `[3,1]` (BL-098 Phase 3, not carried to BL-104, whose Widesl trails are percent only).
- Trail × MTM stop interaction (BL-098 Phase 3, now BL-104).
- Points vs percent for the live ₹65 file.

## Related

- [Directional trail](../directional/trail.md); [leg stop](leg-sl.md).
- Raw rows: `research/bl097/results/widesl_sweep_postcharge.csv` (git-ignored; regenerate with
  `research/bl097/run_family_sweep.py --family widesl`).

[bl098]: ../../../../backlog/BL-098-widesl-parameter-sweep.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md

# Options: an absolute confidence beside the rotation rank

**Status:** Tested (killed) · **Last updated:** 2026-11-05

## What it is

The rotation's composite ([rotation ranking](rotation-ranking.md)) is a sum of percentile ranks, so
its top is always near the maximum and it cannot say "nothing looks good today". [BL-210][bl210]
asked whether a 0–100 figure built from the picked basket's own absolute history predicts the
basket's net on the day. Definition (registered before the run, owner's choices): for day D's three
core picks, their summed net per lot on each earlier day is the basket series; on the days the
ranking's own criteria match (last 10 days; same weekday, same days to expiry, same VIX band, in
list C's lookback windows 5 / 21 / 63 / 126), per criterion W = win rate × 100 and R = 50 + 50 ×
mean ₹ / ₹3,000 clipped to 0–100, c = (W + R) / 2, and C(D) = the criteria's c weighted as list C
weights them (recent 15, weekday 30, dte 30, VIX 20, renormalised). Nothing in the product computes
or shows it.

## Live value

None. Not shown, not traded on.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-210][bl210] Phase 1 | one definition (above), no sweeps; Spearman of C(D) vs the basket's net on D and the top-minus-bottom tercile of C, each with a 5-day block-bootstrap 90 % interval | Core (list C over Core-298) and T1 (list C over Core-298 + T1), 423 days 2025-01-10 → 2026-10-09 from the stored results, picks re-derived; the 18 forward journal days (2026-10-12 →) held out | **Killed** by the registered rule: Core ρ +0.081 [+0.008, +0.152], tercile spread +₹741 [−44, +1,734] a basket-day; T1 ρ +0.066 [−0.010, +0.144], spread +₹689 [−260, +1,687]. A pass needed both intervals above 0 on both books | `research/bl210/confidence_2026-11-05.json` (tracked); per-day CSVs git-ignored, regenerate with `confidence.py` |

## What we know

- **The sign is consistently positive but small.** ρ is +0.02 to +0.12 on every half of both
  books and +0.22 (Core, 18 days) / +0.45 [+0.12, +0.76] (T1, 13 days: its five journal days before the
  track went live do not match the re-derived picks and are left out) on the forward days. The bottom tercile of C earned
  ₹846 (Core) and ₹1,322 (T1) a day against ₹1,587 and ₹2,011 for the top tercile. A lead, not a
  finding: the intervals include zero, and the second half carries it (Core first half ρ +0.04
  [−0.06, +0.14], T1 first half spread −₹544).
- **As defined, the figure never reads low.** C ranged 51–97 (mean 83 Core, 86 T1); the one
  declared rule, skip when C < 40, fired on no day in 441. The ₹3,000 scale and the 50 % floor of
  the rupee score put every day above 50, so "the topper reaches only 70 in a bad era" does not
  happen with this definition: the bottom third is C ≤ 82 (Core) / ≤ 85 (T1). A different scale or
  a within-history percentile would spread it, but that is a sweep BL-210's Phase 0 ruled out; it
  needs a new item with its own pre-registration.
- **In-sample caveat, as for every rotation item:** both universes were chosen on this history;
  the test is of the figure given the universe.

## Not yet tested

- A rescaled or percentile version of C (new item, new Phase 0).
- The per-pick alternative (average of the three picks' figures) the owner set aside.

## Related

- [Rotation ranking](rotation-ranking.md) (the composite C is built beside), [portfolio stop](portfolio-stop.md)
  (the book stop, the current backward-looking "bad day" instrument).
- Code: `packages/option-backtesting/research/bl210/confidence.py` (reads the live store, writes beside itself).

[bl210]: ../../../backlog/BL-210-rotation-absolute-confidence.md

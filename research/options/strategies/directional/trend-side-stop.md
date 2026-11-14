# Directional: a wide stop on the trend-side leg

**Status:** Tested (killed) · **Last updated:** 2026-11-15 · Item: [BL-222][bl222]

## What it is

On a day the hourly EMA 20 is above EMA 50 (state known before the session), raise the CE leg's stop to X% and leave
the PE as the pick has it; on a down-trend day raise the PE leg's. The leg whose premium rises with the trend gets
room. Run on T1's Dir picks, each re-run by the engine with only that stop changed (a stop already at or above X is
unchanged); X = 30 / 40 / 50, primary 50.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-222 | Trend-side leg at X = 30 / 40 / 50% against the pick as it is (A0), both legs at X, the counter-trend leg at X, and a random trend | 351 T1 Dir pick-days, 2025-01-10 → 2026-10-08, ₹23.6 an order + 0.5% slippage | **Killed**: fails 3 of 5 rules | [BL-222][bl222] |

## What we know

₹ per Dir pick-day (one lot), primary X = 50: the picks as they are +244 (max drawdown ₹26,759); trend-side wide
+279 (₹28,331); both legs at 50% +8 (₹68,713); counter-trend leg at 50% −38 (₹52,790).

- **Against the picks as they are the gain is noise:** +₹34 a day [−118, +191]; above them in 2 of 4 blocks (+752
  vs +296, +195 vs +42, then +9 vs +266 and +164 vs +374), a slightly deeper drawdown.
- **The trend does matter against the other ways of widening:** +₹271 a day [+91, +446] over both legs at 50%,
  and above 97.9% of random-trend draws. The counter-trend leg at 50% is the worst arm (−₹282 against the picks). Wider
  stops on both legs lose at every X; the direction of the room is what carries it.
- **It works on one half only.** Up-trend days (CE wide, 161 days): +₹158 a day against the picks (₹599 vs ₹441).
  Down-trend days (PE wide, 190): −₹70 (₹7 vs ₹77). The half the owner proposed first is the half that loses.
- At X = 30 and 40 the trend-side arm is −₹31 and −₹28 against the picks.
- The 2022–24 confirmation was never opened.

## Not yet tested

- CE wide on up-trend days only, as its own registered rule (a lead found after the fact in this run).

## Related

- [Leg stop](leg-sl.md), [trend-aligned range break](trend-range-break.md), [BL-221 split of T1's Dir by trend](trend-range-break.md).

[bl222]: ../../../../backlog/BL-222-trend-side-wide-leg-stop.md

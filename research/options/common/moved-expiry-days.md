# Options: holiday-shifted expiry days

**Status:** Tested · **Last updated:** 2026-10-18

## What it is

When a weekly expiry falls on a holiday its expiry moves to the previous trading day (NIFTY: 13 times
since 2022 and 7 for SENSEX, for example the Dussehra move to Monday 19 Oct 2026). The rotation never
looks at whether an expiry was moved. [BL-121][bl121] asks whether the strategies, and Adaptive on
Core-298 and on T1, earn less on those days than on ordinary expiry days of the same index.

## Live value

None. Nothing in the rotation reads it.

## Tested

Moved minus normal expiry days, gross ₹ per lot-day, 90 % bootstrap interval (5,000 resamples, seed
20261018). Inputs: the live store, the T1 results and the git-ignored P3 research results
(`research/bl071/results`, `research/bl080/results`); regenerate with
`uv run python research/bl121/moved_expiry.py` in the checkout that holds them.

| Question | Moved days | Moved minus normal | Reading | Evidence |
|---|---|---|---|---|
| Adaptive on Core-298, 2025-01-10 → 2026-10-16 | 11 (6 NIFTY, 5 SENSEX) | +217 [-1,014, +1,618] | Inconclusive | [BL-121][bl121] Log |
| Same, without NIFTY 2025-04-09 | 10 | -562 [-1,270, +183] | Inconclusive | same |
| Adaptive on T1 (partly in-sample) | 11 | +457 [-1,057, +2,021] | Inconclusive | same |
| Same, without 2025-04-09 | 10 | -258 [-1,411, +935] | Inconclusive | same |
| NIFTY Widesl, 2022 → 2026 | 12 | +272 [-203, +719] | Inconclusive | same |
| NIFTY Dir | 12 | +174 [-178, +546] | Inconclusive | same |
| NIFTY Buy | 12 | -168 [-337, -1] | **Worse, borderline** (upper bound -1; other seeds and a variant of the normal set read inconclusive) | same |
| All 149 NIFTY variants | 12 | +168 [-158, +467] | Inconclusive | same |

## What we know

Leads, not findings.

- **Inconclusive.** Eleven moved days cannot show whether Adaptive earns less, the same or more on them: the
  intervals are about ±₹1,000 to 1,500.
- **The positive point estimate rests on one day.** NIFTY 2025-04-09 (+₹8,506 for the Adaptive basket) carries
  it; without it the pooled result is negative (Core -562, T1 -258, both inconclusive). On Core, SENSEX moved
  days average +₹14 against ₹818 on normal days, and 7 of the 11 moved days are below their own index's
  normal mean.
- **NIFTY Buy is the only family reading worse**, and only just.
- On the moved days Adaptive took 20.6 % of its picks (Core) and 11.8 % (T1) from the non-expiring index,
  against 9.2 % and 21.1 % on ordinary NIFTY and SENSEX expiry days for Core.

## Not yet tested

- Whether the rotation should treat a moved expiry day differently (a new registered test).
- Monday 2026-10-19, the live forward event, is read out after the day.

## Related

- [Rotation ranking](rotation-ranking.md) (the days-to-expiry fit), [BL-111](../../../backlog/BL-111-range-regime-strategy-mix.md)
  (the expiry-day basket arm).
- Scripts: `packages/option-backtesting/research/bl121/` (`events.py`, `moved_expiry.py`) and their JSON.

[bl121]: ../../../backlog/BL-121-moved-expiry-days.md

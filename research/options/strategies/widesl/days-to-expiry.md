# Widesl: days to expiry

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

Calendar days from the trading day to the expiry of the weekly contract being sold: 0 = expiry day.
BL-056 reads it from the contract expiries in the lake (the nearest `contracts_daily.expiry` on or after
the day), cross-checked against the calendar. No YAML field sets it: a days-to-expiry rule would be a gate
or a sizing rule outside the strategy, or an ingredient of the rotation's ranking.

Expiry weekdays in the window: NIFTY Tuesday on every day (so Tue = 0, Mon = 1, Fri = 4, Thu = 5,
Wed = 6); SENSEX Thursday on every day (Thu = 0, Wed = 1, Tue = 2, Mon = 3, Fri = 6). NIFTY moved from
Thursday to Tuesday about Sep 2025; SENSEX went Fri → Tue → Thu, about Aug 2025 ([BL-056][bl056] Log).

## Live value

None: the live strategies trade every day. The forward journal's lists weight a days-to-expiry fit heavily: A 33%, B 35%, C 30%, REF 25%
(`packages/option-backtesting/src/option_backtesting/rotation/lists.py`); in A and B it is one of the
two largest weights. See [rotation ranking](../../common/rotation-ranking.md).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-056 | DTE 0–6, NIFTY OTM1 and SENSEX OTM2, family mean over the 11 start times 09:17–11:47 | 2025-09-01 → 2026-10-08, one expiry regime per index, about 53 days a cell, 1 lot, ₹ per day, **before charges** | Descriptive, no verdict | [BL-056][bl056] |
| BL-059 | Same tables for start times 12:02–15:02 | same | Descriptive; morning patterns agree with BL-056 | [BL-059][bl059] |
| BL-060 | SENSEX ₹250 / ₹320 vs OTM2, 24 start times | same | Descriptive: expiry day best for all three rules | [BL-060][bl060] |
| BL-061, BL-062 | Which Widesl the rotation picks, by DTE | rotation, 2025-12 → 2026-10 | Descriptive: closest premium takes 47–51% of core lots at DTE 0, 10–20% at DTE 2–3 | [BL-061][bl061], [BL-062][bl062] |
| BL-159 read 8 (monthly-expiry week) | The five trading days ending on the month's last NIFTY weekly expiry vs the other days, the live Widesl OTM1 09:17 (stored rotation results, gross per lot) | NIFTY, 2024-10-09 → 2026-10-08 | Screen, **no lead**: not a skip for both base strategies (bar: mean in group minus out of group of −₹500 or worse with t ≤ −2 for both) | [BL-159][bl159] |

**NIFTY OTM1, ₹ per day per lot** (BL-056):

| DTE | 0 (Tue) | 1 (Mon) | 4 (Fri) | 5 (Thu) | 6 (Wed) |
|---|---|---|---|---|---|
| Days-to-expiry table | 616 | 216 | 17 | −57 | −52 |
| Weekday table, same days mapped | 673 | 190 | 40 | −39 | −73 |

Within one regime the two should be the same split (BL-056); they differ a little, probably because a
holiday-shifted expiry puts a few days into DTE 2 or 3, which are not printed. The item does not say.

**SENSEX OTM2, ₹ per day per lot** (BL-056 prints only the weekday row; mapped here to DTE):

| DTE | 0 (Thu) | 1 (Wed) | 2 (Tue) | 3 (Mon) | 6 (Fri) |
|---|---|---|---|---|---|
| Weekday table | 264 | 51 | 426 | −204 | −191 |

Over all 24 start times (BL-060), SENSEX is best on Thursday and expiry day (OTM2 ₹328, ₹250 ₹390 on
expiry day) and negative on Monday and Friday.

## What we know

- **NIFTY falls steadily away from expiry,** from ₹616 a day on expiry day to about zero or below 4–6
  days out. Descriptive, one year, before charges.
- **SENSEX shows no gradient** in the morning start times: the best day is DTE 2 (Tuesday), DTE 1 is
  weak, and the two days furthest from expiry are both negative.
- **The gaps are at the edge of the noise.** A cell's standard error is roughly ₹300–400 a day, so
  differences under about ₹700 cannot be told from noise (BL-056). The largest NIFTY gap in the
  days-to-expiry table (DTE 0 vs 5, ₹673) is just under it; in the weekday table Tue vs Wed (₹746) is just
  over. Every SENSEX gap is under it. The steady ordering over five cells is the more notable feature, but
  it was found by looking: about 1,100 cells were examined in BL-056, and NIFTY and SENSEX trade the same
  market days, so agreement between them is not independent confirmation.
- **As a ranking ingredient** (all families pooled, not Widesl alone), the days-to-expiry fit is small
  and unstable: its rank correlation with the day's P&L across variants is +0.013 ([BL-057][bl057]),
  +0.001 ([BL-061][bl061]), +0.028 ([BL-062][bl062]); +0.028 / +0.029 / +0.083 in the three periods
  ([BL-081][bl081]). Used alone it is killed; dropping it from the blend costs 36% of net (one year, after
  charges, [BL-067][bl067]). Shuffling the weekday / DTE / VIX labels together leaves the rule inside the
  shuffled range ([BL-068][bl068]). On the NIFTY
  2022–24 hold-out the three fit criteria together carry the rule (the no-recent row is best,
  [BL-071][bl071]); a DTE-heavy split was above chance in all three periods in 6 of 25 weightings
  ([BL-075][bl075]) and 16 of 25 on the 298 list ([BL-080][bl080]). DTE has never been isolated on the
  hold-out.

## Not yet tested

- A pre-registered DTE gate or sizing rule for Widesl (for example: trade only at DTE ≤ 1, or double
  the lots on expiry day), judged on days not used to find it.
- The NIFTY 2022–24 hold-out, when NIFTY expired on Thursday. The OTM1, ₹80 and ₹100 results for those
  days already exist (run for BL-071), so the table needs analysis, not new backtests. BL-071's caveat
  says the expiry weekday changed inside its period, while BL-056's Log dates the move to about Sep 2025:
  check which days carry which expiry first.
- The earlier regime on both indices (2024-10-09 → 2025-08-31): the SENSEX runs already cover it
  (BL-056).
- Why expiry day differs: near expiry a closest-premium strike sits much nearer the money (BL-061's
  reading, not tested).

## Related

- [Weekday](weekday.md) (the same split within one regime); [Directional days to expiry](../directional/days-to-expiry.md);
  [rotation ranking](../../common/rotation-ranking.md).
- Tables per start time: `research/bl056/out/{nifty,sensex}_by_dte.csv` and `research/bl059/out/`
  (git-ignored; regenerate with `research/bl056/analyse.py` and `research/bl059/analyse.py`).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl057]: ../../../../backlog/BL-057-daily-four-criteria-rotation.md
[bl159]: ../../../../backlog/BL-159-eight-poc-reads.md
[bl059]: ../../../../backlog/BL-059-whole-day-start-time-curve.md
[bl060]: ../../../../backlog/BL-060-sensex-widesl-closest-premium.md
[bl061]: ../../../../backlog/BL-061-rotation-with-closest-premium-widesl.md
[bl062]: ../../../../backlog/BL-062-whole-day-rotation.md
[bl067]: ../../../../backlog/BL-067-drb-weight-map.md
[bl068]: ../../../../backlog/BL-068-drb-recent-controls-and-label-placebo.md
[bl071]: ../../../../backlog/BL-071-drb-out-of-period-and-2022-import.md
[bl075]: ../../../../backlog/BL-075-drb-final-map-and-structural-switches.md
[bl080]: ../../../../backlog/BL-080-drb-wider-closest-premium-families.md
[bl081]: ../../../../backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md

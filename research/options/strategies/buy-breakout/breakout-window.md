# Buy: breakout window (range length)

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

How long the opening range is measured before a breakout can trigger: from `entry_time` to
`range_breakout.until`. The range high is the highest 1-minute high of the leg's premium over
[entry, until); from `until` on, the first bar above it buys the leg. A longer window gives a higher
bar to beat and a later earliest entry.

## Live value

10 minutes (09:35 → 09:45 live; entry + 10 in every rotation file).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | entry + 5, + 15, + 20, + 30 minutes (`range_plus_N`; base + 10) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; + 30 leads NIFTY 09:15–11:00 and SENSEX 11:00–13:00; + 20 and + 30 fill SENSEX's morning top three | [BL-097][bl097], [report][bl097q] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ net | Holdout Δ gross | Holdout Δ charges | Holdout Δ net | Files ≥ base | Files net > 0 | No-entry days |
|---|---|---|---|---|---|---|---|---|
| + 5 | 48 | −5,273 | −1,219 | +1,792 | −3,011 | 35% | 1 | 2.0% |
| + 15 | 46 | +855 | +1,196 | −1,365 | +2,561 | 72% | 2 | 4.5% |
| + 20 | 46 | +1,825 | +2,333 | −2,540 | +4,873 | 76% | 7 | 7.7% |
| + 30 | 44 | +5,117 | +4,056 | −4,012 | +8,067 | 84% | 11 | 9.7% |

Baseline no-entry days 4.9%. Missing files are late start times where the range would end after the
15:14 exit.

Ranked report, + 30 minutes after charges: NIFTY 09:15–11:00 −₹18 a day per file (−₹4,388 over the
year, positive days 38.4%); SENSEX 11:00–13:00 −₹4 a day (−₹1,005), SENSEX 09:15–11:00 −₹21 a day
([BL-097 report][bl097q]).

## What we know

- A longer range is the most consistent Buy lead in the sweep: + 20 and + 30 improve net on three
  quarters or more of the files in the holdout **and** are better in the fit year too; + 5 is worse in
  both. + 30 also raises gross in both years and makes the holdout drawdown shallower (+₹5,586 a
  file), which the strike rows (more gross, deeper drawdown) do not.
- About half of the holdout gain is charges saved: a higher range high is broken less often (no-entry
  days 4.9% → 9.7%), so fewer orders are paid. The other half is gross (+₹4,056 a file at + 30).
- It does not make Buy profitable after charges. Summed over its 44 files, + 30 made ₹3.13 lakh gross
  and −₹3.49 lakh net in the holdout. Its best ranked sections are still slightly negative.
- One-factor screen; BL-097 Phase 3 (which would combine it with premium and gap) has not run, so no
  verdict.

## Not yet tested

- Range window × premium and range window × gap (registered BL-097 Phase 3 interactions).
- Windows longer than 30 minutes; a range that must also be tight
  ([30-minute consolidation](consolidation-30m.md)).

## Related

- [Breakout gap](breakout-gap.md), [breakout validity](breakout-validity.md),
  [candle position](candle-position.md), [charges](../../common/charges.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

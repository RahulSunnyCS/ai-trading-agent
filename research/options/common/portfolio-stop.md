# Options: portfolio stop

**Status:** Tested · **Last updated:** 2026-11-02

## What it is

One stop on the combined P&L of everything traded that day. Each minute the day's mark-to-market is
the sum of the strategies' curves (0 before a strategy starts, its realised P&L after it ends). The
first minute it is at or below −X, everything is closed at that minute's value and nothing else starts
or re-enters that day. Each strategy keeps its own per-lot overall stop (Widesl ₹2,500, Dir ₹3,000,
Buy ₹2,000). A trailing form moves −X up behind the day's best combined P&L.

## Live value

AlgoTest has no portfolio-wide stop. On Quantiply each T1 book runs a clientwise MTM SL of ₹9,000 on 3-lot
days and ₹9,000 + the doubled Dir's own stop (mostly ₹13,000) on Dir ×2 days ([BL-183][bl183], [BL-194][bl194]); the Rotation page's "Portfolio stop" button replays any typed level (default
₹10,000; empty, 0 or below = none) with Trail SL, Lock profit or Lock and trail.

## Tested

"Helps" (registered in BL-055, reused in BL-066): max drawdown at least 25% smaller and total P&L at
most 10% lower than with no stop.

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-055 | ₹8k, ₹10k, ₹12.5k on mixes B1–B3 (5–6 NIFTY lots) | 2024-10-09 → 2026-10-08, 489 days, before charges | **Inconclusive**: ₹8k helps B2 (total +12.1%, drawdown −42%) and B3 but cuts B1's total by 12.1% | [BL-055][bl055] |
| BL-055 (later block) | same levels, mix B4 and ₹80 / ₹100 Widesl versions (12 combinations) | same | Helps in 3 of 36; never for ₹100 or B4; no pattern across versions | [BL-055][bl055] |
| BL-066 | ₹10k, 12k, 15k, 17k, 20k on DRB-6W3L2 (3 × 2 lots + Buy) | P1, 202 days, gross and net | **No level helps**; effect on total not monotonic | [BL-066][bl066] |
| BL-066 | ₹8k, 6k, 4k | same | **No level helps**; the tighter the worse (₹4k: total −28.3%, drawdown +39%) | [BL-066][bl066] |
| BL-066 | best-case fill exactly at −X | same | No level reaches the 25% bar; ₹6k closest (drawdown −15.7%, total +1.3%) | [BL-066][bl066] |
| BL-066 | trailing ₹12k / ₹16k / ₹20k, and trailing only after +₹5k | same | **No level passes**; ₹12k trail best-case drawdown −20.5% | [BL-066][bl066] |
| BL-095 | ₹10,000 on lists A / B / C / REF (a feature, not a test) | reconstructed list-days, gross, in-sample | First looks only (below) | [BL-095][bl095] |
| BL-131 | ₹6k, 7k, 8k, 9k, 10k, 12k on each 3-lot book: Core-298 and T1 Adaptive (one lot per pick) | 2025-01-10 → 2026-10-16 (428 days) and the last year, gross, minute replay | **No level clearly changes the result** (24 cells, one interval above zero, chance-level; Core point estimates ≥ 0, T1 at ₹6k–7k < 0); ₹9k+ never binds on Core; trims the worst day (T1 −13.8k → ~−9k), maximum drawdown mostly unchanged | [BL-131][bl131] |
| BL-132 | Stop = the 85 / 90 / 93 / 95th percentile of each 3-lot book's day low, set on 2025-01 → 2025-10, checked on the next year | Core-298 and T1 Adaptive, gross, minute replay | Levels ₹6.5k–9.5k; in the calmer test year hit 2–10 points less often than targeted (none "holds"); protective at P90–95, no clear money effect. Whole-period (in-sample) P95 ≈ ₹8,500, P90 ≈ ₹7,000 for both books | [BL-132][bl132] |
| BL-194 | ₹9k–16k, ₹18k, ₹20k, none on T1's Dir ×2 (4-lot) days, against ₹9k + the Dir's stop (₹12–13k) | T1 Adaptive with the expiry rule and SL150% cap, 2025-01-10 → 2026-10-30 (437 days, 218 4-lot), net of brokerage, minute replay | **No level beats ₹9k + the Dir's stop**; ₹9k −₹51 a day [−129, +15] (−₹104 [−232, −1] on the last year), ₹11k −₹47 [−91, −7] on the last year; ₹14k+ change 2 days, gain only from one the rule stopped, and deepen the worst day; the rule fires on 1 % of 4-lot days | [BL-194][bl194] |

## What we know

- The stop reliably trims the worst day (B2 −₹19,167 → −₹13,315 at ₹8k) and little else. Across all
  combinations it moved total P&L by −19.7% to +12.1% and drawdown by −42% to +11%, with no pattern
  that holds across mixes or strike versions ([BL-055][bl055]).
- Bar-close fills overshoot: a stopped day averages 7–26% beyond the level, because single minutes
  can fall ₹5k–₹14k when two strategies hit their own stops together (DRB-6W3L2, 2026-07-15:
  −₹4,128 → −₹13,696 in one bar, [BL-066][bl066]).
- Identical copies stop together: 5 × ₹2,500 per-lot stops already equal a ₹12.5k book stop, so that
  level does nothing for five identical lots ([BL-055][bl055]).
- On the forward lists' reconstructed history, ₹10,000 cut A and B and added to C and REF (116 days,
  gross, in-sample; [BL-095][bl095] Log). The sign depends on the mix, as BL-055 found.
- On a 4-lot (Dir ×2) T1 day the picks' own stops keep most days shallow (lowest MTM: median −₹2.5k, 1 % of
  days below −₹13.3k, the worst −₹17.6k), so ₹9k + the Dir's stop acts as a disaster stop; a level at the 3-lot ₹9,000
  closes days that recover ([BL-194][bl194]).
- All exploratory: same years already seen, owner override, no hold-out.

## Not yet tested

- A portfolio stop on the forward journal's unseen days (BL-095 keeps the registered read-out on its
  no-stop basis).
- BL-095's trailing modes against the owner's AlgoTest screen (its open question 1).

## Related

- Per-strategy stops: [Widesl overall stop](../strategies/widesl/mtm-sl.md),
  [Directional overall stop](../strategies/directional/mtm-sl.md), [Buy overall stop](../strategies/buy-breakout/mtm-sl.md);
  BL-070 found per-strategy stops worth keeping only for SENSEX Widesl OTM ([BL-070][bl070]).
- Code: `rotation/portfolio.py`, `research/bl055/`, `research/bl066/` (`curves.py`, `stops.py`),
  `research/bl095/` (reproduces BL-055 to the rupee). Curves are git-ignored; regenerate with
  `curves.py`.

[bl055]: ../../../backlog/BL-055-daily-portfolio-stop-loss.md
[bl066]: ../../../backlog/BL-066-drb-6w3l2-daily-stop.md
[bl070]: ../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl095]: ../../../backlog/BL-095-portfolio-mtm-stop-in-rotation.md
[bl183]: ../../../backlog/BL-183-dir-double-non-expiry-live.md
[bl194]: ../../../backlog/BL-194-t1-book-stop-dir2.md
[bl131]: ../../../backlog/BL-131-book-daily-stop.md
[bl132]: ../../../backlog/BL-132-mtm-stop-from-day-lows.md

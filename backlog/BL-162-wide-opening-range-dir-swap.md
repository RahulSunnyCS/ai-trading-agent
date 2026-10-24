# BL-162 — Wide opening-range days: swap not-yet-entered Widesl picks for Dir (shadow rule)

| | |
|---|---|
| **Priority** | P0 — set by the owner on 2026-10-14 for exploration; Claude's own judgement was P3 (small, in-sample effect on about 9% of days) |
| **Status** | Planned (pre-registration drafted; nothing run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-14 |
| **Depends on** | BL-058 (the lists and journal), BL-090 (correlation), BL-069 (overnight gap, already tested and dropped) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner question (2026-10-14): do opening-range and gap conditions separate good days from bad days for lists
A / B / C / REF? A read-only study over the 425 scored days (Jan 2025 – Oct 2026, 63-day warm-up excluded) found:

- **Gap:** no usable day rule. Normal gaps (within ±0.5%) give 56–65% wins, in line with the 60% baseline; the
  extreme buckets have 6–7 days each. BL-069 B2 (gap as a ranking criterion) was already dropped.
- **Opening range** (NIFTY 09:17–09:29 high minus low): above 100 points on 39 of 425 days (9%). On those days
  the lists win about 30% (A 33%, B 28%, C 31%, REF 31%) and average −4 / −129 / −73 / −185 per lot-day, against
  +176 to +666 on quieter days. Rank correlation between the composite score and the day's result is −0.05 on
  those days and +0.06 on the others: the ranking carries no information there.
- **Where the loss sits:** 72–77% of the picks on those days start at 09:32 or later, and they carry the whole
  loss (09:17 picks: +4k to +14k; 09:32+ picks: −11k to −32k, one lot per strategy, over the 39 days).
- **By family:** on those days the average Dir variant earned +125 and the average Widesl −114 per variant-day;
  the list's top-10 is 65% Dir and 34% Widesl as on any other day, so it is the choice within a family, not the
  family mix, that fails. SENSEX 09:17 Widesl entries are the worst repeat scorer (S_wide_0917: top-10 on 13
  days, mean −1,433).
- **Expiry split:** expiry days (NIFTY or SENSEX weekly, 180 of 425) are the better days in every range bucket.
  Wide range hurts on both; non-expiry wide days are worse (win 36–41%, −112 to −230 for the lists).
- **Out of sample:** the previous two years (Oct 2022 – Oct 2024) could only be tested on the NIFTY strategies
  (SENSEX options start 2023-07-26). There were only 15 wide days and the 09:32+ NIFTY variants earned +252 per
  variant-day with 53% wins, so the finding did not repeat there. In the recent period the NIFTY-only pool on
  wide days is still positive (+65), so the losses belong to what the lists pick plus SENSEX.

Rules tried at 09:30 (picks starting 09:17 are locked; only picks starting 09:32+ change; **at least 1 Widesl
kept**; the registered base keeps its minimum of 2). Gross, one lot per strategy, 425 days:

| Rule | All days vs registered | The 39 wide days | Max drawdown |
|---|---|---|---|
| Re-rank at 09:30 with a range-bucket fit at weight 0.20 (others x0.8) | A −1, B +60, C −10, REF −9 (all intervals include 0) | A −133, B −56, C −17, REF +222 | 20–50k deeper; basket changes on ~80% of days |
| Same, fitted separately for expiry / non-expiry days | +15, +54, −17, +1 | +132, +108, +119, +143 | 20–50k deeper |
| **Wide day: replace each not-yet-entered Widesl pick with the best-ranked Dir (start 09:32+), keep at least 1 Widesl** | **A +9, B +4, C +11, REF +24** (REF 90% CI −0 … +49) | **A +103, B +48, C +123, REF +258** | about the same (A −74k → −74k, B −83k → −79k, C −72k → −72k, REF −79k → −82k); changes 32–34 days; worst wide day −2.7k → −3.4k |
| Same, keeping at least 2 Widesl (the registered minimum) | about 0 (−1 … +2) | −11 … +26 | unchanged |
| Same, no Widesl minimum | +25, +32, +31, +43 (REF +7 … +83) | +276, +344, +337, +470 | A −74k → −75k, REF −79k → −87k; worst wide day −3.7k |
| Wide day: skip every not-yet-entered pick | +2, +13, +7, +8 | +21 … +142 (all intervals include 0) | unchanged |

The owner's fear that swapping every Widesl for Dir "could end badly" is borne out in the tails: with no minimum
the worst wide day is about 1k worse and REF's drawdown 8k deeper, so the rule keeps a Widesl floor of 1.

**Index used for the flag:** the study used NIFTY's range (above 100 points) for all four lists, SENSEX picks
included. With SENSEX's own range above 300 points (52 days; 37 of them also NIFTY-wide, 15 SENSEX-only) the swap
is flat to negative on the wide days (A −60, B −71, C −68, REF +42 per lot-day), and the registered lists are
less bad on those days (A −62, B −225, C +2, REF −50). So the finding belongs to NIFTY-defined wide days only.

**Correction (2026-10-14):** an earlier version of this table, and the figures quoted in the conversation
(+12 … +24 all days, +126 … +262 on wide days, and +330 … +462 without a minimum), double-counted the 09:17 picks
in the swapped basket. The figures above are from the corrected computation.

**Caveats that make this a shadow candidate, not a change:** the rule was found on the same 39 days it is
scored on; only one wide-day interval clears zero (REF); the 100-point threshold was chosen after seeing the
buckets; roughly ten variants were looked at on the same data; and it did not repeat in 2022–24 (NIFTY only).

Scripts for this study lived in a scratch folder and are not in the repo (Phase 1 ports them to
`packages/option-backtesting/research/bl162/`).

## Goal

Know, from forward days only, whether replacing the not-yet-entered Widesl picks with Dir on wide-opening-range
days beats the registered lists, without touching a registered list. Nothing about A / B / C / REF changes.

## Out of scope

- Any change to the registered lists, their weights or the 298 universe (never edited after the first entry).
- The 09:30 re-rank with a range criterion (rejected above; it can be revisited only with a new, dated rule).
- Gap rules (BL-069) and the day-of-expiry rule below (a separate idea, see Open questions).

## Plan

### Phase 0 — Pre-register
Committed before any forward day is scored. A rule is never edited after a run.
- **Hypothesis:** on days where NIFTY's 09:17–09:29 range exceeds 100 points, replacing each pick that has not
  yet started (start 09:32+) and is Widesl by the best-ranked Dir variant starting 09:32+ (not already in the
  basket, at least 1 Widesl kept in the basket) earns more per lot-day than the registered basket.
- **Universe:** the 298 registered variants and lists A / B / C / REF as recorded in the journal; the wide-day
  flag is computed from the lake's NIFTY 1-minute bars the same evening (point-in-time, known at 09:30).
- **Look-ahead check:** the range uses bars to 09:29 only; the replacement uses the composite already recorded
  for the day; no result of the day enters either. The counterfactual basket is built from stored results after
  the close, so nothing is fed back into a pick.
- **Pass / kill rule:** with at least 30 forward wide days, mean (swap basket − registered basket) per lot-day
  above +100 for the average of A / B / C and a 5-day block-bootstrap 90% lower bound above 0 for the average
  of the four lists, and no more than 10k deeper drawdown on the wide days. Kill if the mean is at or below 0
  with at least 20 wide days. Between the two: keep collecting.
- **Hold-out:** every day from the first journal date after this item is started; nothing before it counts.
- **Will not run:** other range thresholds (80 / 90 / 120), other families, the skip rule, any re-rank, and the
  range-bucket criterion; each needs `override: <reason>` in the Log.

### Phase 1 — Shadow record
- **Tasks:** a read-only evening step that, for every journal day, stores the range, the wide-day flag, and the
  counterfactual basket and its result (from `rotation/results/*.csv`), next to the registered one. Port the
  study scripts to `research/bl162/`. No pick is changed; no registered list is edited.
- **Deliverables:** a small file under `TRADING_DATA_ROOT/rotation/` (append-only, like the journal's
  companions) and a read-out line in `obt rotation readout`.
- **Done when:** the file reproduces the 39-day figures above on the research days and records the next live day.

### Phase 2 — Forward read-out
- **Tasks:** wait for 30 forward wide days (about 9% of sessions, so roughly 14 months) and apply the Phase 0
  rule.
- **Deliverables:** the read-out and a decision logged here (adopt as a rule / keep shadowing / drop).
- **Done when:** the pass or kill rule has fired, or the owner drops it.

## Risks

- **Too few wide days:** about two a month, so a decision takes over a year. Mitigation: it costs nothing to
  keep running, and the SENSEX history to 2023 could add earlier days to a NIFTY-and-SENSEX replay.
- **Regime dependence:** the earlier two years did not repeat the loss; the effect may belong to 2025–26.
- **Selection:** the threshold and the swap were chosen after looking; the pre-registration above limits further
  tuning, but the first result is optimistic by construction.

## Open questions

- Should a day-of-expiry split be added as a second shadow (expiry days are the better days overall) or kept out?
- Should the shadow also count the swap for REF only (the one list whose interval cleared zero)?
- Is a replay of 2023-07 – 2024-10 with both indices worth the simulation time (needs lot sizes before
  2024-10 in the reference table)?

## Log

- 2026-10-14 — created from the opening-range / gap / expiry study; pre-registration drafted, nothing run.
- 2026-10-14 — figures corrected (the swapped basket double-counted the 09:17 picks); SENSEX-range flag (300 points) tested and does not support the rule; Widesl floor kept at 1.
- 2026-10-14 — priority set to P0 by the owner for exploration purposes (was P3 by Claude's judgement; the evidence is unchanged).
- 2026-10-24 — renumbered from BL-104 (that number is the full parameter sweep on `main`) to BL-162; content otherwise unchanged.

# BL-166 — Directional ITM2 and ITM3, with the overall stop widened to match ITM1's stop rate

| | |
|---|---|
| **Priority** | P2 — a new Directional strike family; the rotation carries ATM and ITM1 only |
| **Status** | In progress (POC run; larger time frames await the owner) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-26 |
| **Depends on** | BL-080 (ITM1 joined the rotation, ITM2 "not run"), BL-096 (the stop grid), BL-058 (rotation) |
| **TODO.md row** | — |

## Context

Owner, 2026-10-26: the system carries ITM1 and ATM for Directional. Add ITM2 and ITM3 and see how they
go, as a proof of concept over the last two years; if it is fine, go to larger time frames. Second
message, same day: first measure how often the overall MTM stop fires for ATM and ITM1. A deeper
strike may stop out more often (the owner's example: 20% of days against 30 to 40%). If so, widen the
overall MTM stop for ITM2 and ITM3 until their stop rate comes down to the ITM1 / ATM range, and
check how they do. NIFTY and SENSEX both.

Directional here is the short pair of the live file (`nifty_dir_924_itm1_sl21_recost.yaml`): sell a
weekly CE and PE at the same strike distance, 21% leg stop, one re-entry at cost, overall stop
₹3,000 per lot, exit 15:28. BL-080 registered "ITM2 is not run"; this item runs it on the owner's
request (that line is overridden here, not edited).

## Goal

Say, with numbers: (1) how often the overall stop fires for ATM and ITM1, and for ITM2 and ITM3 at the
same ₹3,000; (2) what overall stop makes ITM2 and ITM3 stop out about as often as ITM1 / ATM; (3)
whether ITM2 or ITM3 at that stop earns more than ITM1, on the year held out.

## Out of scope

Adding anything to the 298-variant rotation or its ranking, margin and capital sizing, ITM4 and
deeper, OTM, any other leg stop, re-entry, exit time or entry-time rule, windows before 2024-10-09.
The larger time frames come only if this proof of concept passes, as a new item or an addendum.

## Plan

### Phase 0 — Pre-register
Written and committed **before the full run**. A rule is never edited after a run: a new, dated rule
supersedes it with a logged reason.

- **Hypothesis:** selling the pair deeper in the money (ITM2, ITM3) with everything else unchanged
  earns more per slot-day than ITM1 once the overall stop is widened to ITM1's stop rate. Null: no
  difference after charges.
- **Variants** (`research/bl166/make_variants.py`): for NIFTY and SENSEX, the 25 start times of the
  rotation (09:17 to 15:17 every 15 minutes), the ITM1 rotation file with ONLY the strike type
  changed to ITM2 / ITM3 and ONLY `overall.stop_loss_inr` set to one of the grid
  **{3,000, 4,000, 5,000, 6,000, 8,000, 10,000}** rupees per lot. Baselines: the rotation's own ATM
  (`N_dir_*`, `S_dir_*`) and ITM1 (`*_ditm1_*`) files at the live ₹3,000, re-simulated in the same run.
  700 variants.
- **Universe and window:** NIFTY and SENSEX weekly, every collected session 2024-10-09 → the last
  stored day. **Fit year** 2024-10-09 → 2025-10-08; **hold-out** 2025-10-09 → the last stored day.
  Lot sizing 'current' (today's lot on every day), the engine's 1-minute-bar assumptions, as BL-080.
- **Stop rate:** the share of variant-days on which the overall stop fires (`stopped_by` begins
  "overall SL"), over the 25 start times, counting days the variant traded. Per index, per family,
  per stop level, per period. Context only: the same count for the Core and T1 books' recorded days.
- **Matched stop (fit year only):** per index and per depth k, the target is the higher of the ATM and
  ITM1 stop rates at ₹3,000 in the fit year. The matched stop is the **smallest grid level whose
  fit-year rate is at or below the target**; ₹3,000 if it already is; the largest level, flagged
  "not matched", if none is. Chosen without looking at the hold-out.
- **Outcome:** net ₹ per lot after charges, `gross - lot_plans.brokerage(n_trades)` (₹20 x 1.18 per
  order, 2 orders a trade), averaged over the 25 start times per day to one daily series.
- **Primary metric (4 comparisons: NIFTY and SENSEX x ITM2 and ITM3):** hold-out mean daily
  difference (ITM_k at its matched stop minus ITM1 at ₹3,000), with the 90% circular block-bootstrap
  interval (`readout.block_bootstrap_mean`, 5-day blocks, 2,000 resamples, seed 20261026). No
  multiplicity correction; stated.
- **Pass / kill rule, per comparison:** *pass* if the hold-out interval is wholly above zero AND the
  fit-year mean difference is above zero AND the hold-out maximum drawdown of the cumulative daily
  series is no more than 25% deeper than ITM1's. *Kill* if the hold-out mean difference is zero or
  below. Anything else is *inconclusive*. The proof of concept **passes** if at least one comparison
  passes, and only then are larger time frames planned.
- **Secondary, fixed now, descriptive only:** the same comparison at the common ₹3,000 stop; the
  stop-rate table for every family and level; win rate; mean worst MTM; the number of the 25 slots in
  which the matched ITM_k beats ITM1 on the hold-out; the whole two-year difference; the full grid
  of mean net by level (a lead only: it is in-sample for any level it would suggest).
- **Look-ahead check:** the strike is chosen from the index spot at entry by the engine; stops and
  re-entries act in the trade; the matched stop uses the fit year only and is fixed before the hold-out
  is read; no input uses a bar after the decision minute.
- **No-trade days:** a variant-day with no trade (strike data missing) is dropped for that variant and
  counted; more than 5% of a family's days without trades is flagged in the result.
- **Known biases, stated now:** ATM and ITM1 carry settings (21% leg stop, the entry times, re-entry)
  that were chosen for them; ITM2 and ITM3 inherit those and nothing else is tuned for them, which
  leans against the deeper strikes. Against that, the engine fills with no spread, so deeper
  in-the-money options (wider quotes, thinner books) look better than they would trade. The SENSEX lot
  is much smaller than NIFTY's, so the rupee stops bind less often on SENSEX. Sold deep ITM options
  can also carry more early-assignment and margin cost than modelled (none is).
- **Hold-out:** the year 2025-10-09 → the last stored day; not read for any choice.
- **Will not run:** ITM4 and deeper, OTM, other leg stops or re-entries, grid levels outside the six,
  pre-2024-10-09 windows, rotation ranking with the new families, margin sizing. Running one needs
  `override: <reason>` in the Log.

### Phase 1 — Run and report
- **Tasks:** `packages/option-backtesting/research/bl166/run_batch.py` over the 700 variants;
  `analyse.py` for the stop rates, the matched stops and the comparisons; a findings page under
  `research/options/strategies/directional/` and an update to its strike page.
- **Deliverables:** the scripts, result tables in this Log, the page.
- **Done when:** every number in the pre-registration is in the Log, whatever it shows.

## Risks

- Deeper strikes may have thin or missing bars on some days: counted and flagged above.
- With 25 start times that overlap in time, the slots are not independent; the interval is taken on
  the daily series, not across slots.
- A wider stop raises the worst day. The drawdown clause in the pass rule is there for that.

## Open questions

Answered by default, to be corrected by the owner if wrong:
- "T1 and T2" in the second message is read as the two Directional families already live, ATM and ITM1
  (and, as context, the Core and T1 books' recorded stop days).
- ITM4 is read as an example, not a request.
- "Last 2 years" is 2024-10-09 → 2026-10-23, the longest the stored option data allows.

## Log

- 2026-10-26 — created from the owner's two messages; Phase 0 written and committed before the full run
  (700 variants generated; a six-day smoke run of the ITM3 / ₹3,000 variants loaded both indices with
  no missing reference data).
- 2026-10-26 — **POC run** (`research/bl166/run_batch.py`, `analyse.py`; results and `analysis.json` git-ignored). 700 variants, 499 sessions each index (2024-10-09 → 2026-10-23), no missing reference data; no-trade share at most 0.07% (NIFTY) and 0.41% (SENSEX), none near the 5% flag. **Stop rates** (share of variant-days the overall ₹3,000 stop fired, fit year / hold-out): NIFTY ATM 9.5% / 9.8%, ITM1 13.7% / 14.5%, ITM2 15.9% / 17.0%, ITM3 16.6% / 18.2%; SENSEX ATM 8.7% / 8.3%, ITM1 10.5% / 10.9%, ITM2 12.4% / 13.5%, ITM3 13.6% / 15.1%. The deeper strikes stop out only 2 to 4 points more often than ITM1, not the 30 to 40% the owner used as an example. At ₹4,000: NIFTY ITM2 10.6% / 10.7%, ITM3 11.7% / 11.9%; SENSEX ITM2 7.0% / 7.9%, ITM3 7.7% / 9.5%. **Matched stop** (fit year, target = the higher of ATM and ITM1: NIFTY 13.7%, SENSEX 10.5%): **₹4,000** for ITM2 and ITM3 on both indices, none "not matched". **Primary (ITM_k at ₹4,000 minus ITM1 at ₹3,000, net ₹ per lot per slot-day, 90% block-bootstrap interval):** NIFTY ITM2 hold-out +36 [−21, +98], fit −11 [−55, +31], two-year +13: *inconclusive*, drawdown 9,852 against 8,608; NIFTY ITM3 hold-out +44 [−39, +133], fit −19 [−88, +51]: *inconclusive*, drawdown 11,132 against 8,608; SENSEX ITM2 hold-out **+54 [+22, +86]**, fit +8 [−28, +44], drawdown 6,255 against 7,873: ***pass***; SENSEX ITM3 hold-out **+78 [+25, +136]**, fit +43 [−13, +99], drawdown 5,925 against 7,873: ***pass***. Slots (of 25) where the matched ITM_k beat ITM1 on the hold-out: NIFTY 17 and 16, SENSEX 19 and 20. **The POC passes** (two of four comparisons, both SENSEX). **Secondary, at the common ₹3,000 stop:** NIFTY ITM2 hold-out +2 [−50, +56], ITM3 +34 [−43, +115]; SENSEX ITM2 +32 [+6, +58], ITM3 +49 [+1, +100]; so on SENSEX the gain is mostly the deeper strike, not the wider stop. Mean net per slot-day on the hold-out: NIFTY ATM 154, ITM1 207, ITM2 210 / 243 / 261 / 265 / 263 / 263 and ITM3 241 / 252 / 288 / 288 / 296 / 293 at ₹3,000 / 4,000 / 5,000 / 6,000 / 8,000 / 10,000; SENSEX ATM 197, ITM1 255, ITM2 287 / 309 / 315 / 323 / 329 / 326 and ITM3 304 / 333 / 341 / 346 / 353 / 355 (a lead only: net keeps rising with the stop, in-sample, and the drawdown rises with it). **Context:** the Core book's recorded days (2026-10-12 → 23) had 4 of 27 core picks stopped by the overall stop (3 of 9 Dir picks); T1's (19 → 23 Oct) 3 of 12 (0 of 4 Dir). **Caveats, as registered:** four comparisons with no multiplicity correction; the fit-year intervals all include zero; the engine fills with no spread, which flatters deeper in-the-money options; the hold-out year is one year. Page: `research/options/strategies/directional/strike-depth.md`.
- 2026-10-26 — after review (PR 331): `analyse.py` now also prints the hold-out interval at **97.5%** (Bonferroni for the four registered comparisons) and counts the Core and T1 books' stop picks itself (`book_context`, same numbers: Core 4 of 27 core picks, 3 of 9 Dir; T1 3 of 12, 0 of 4). At 97.5%: NIFTY ITM2 +36 [−41, +119], ITM3 +44 [−68, +165] (still inconclusive); SENSEX ITM2 +54 [+13, +98], ITM3 +78 [+3, +154] (still above zero, ITM3 narrowly). Verdicts unchanged. Not done, stated: zero-volume (forward-filled) minutes on the deeper strikes were not checked; the daily mean is over the slots that traded (at most 0.41% of days differ); the batch runner is a copy of BL-080's.

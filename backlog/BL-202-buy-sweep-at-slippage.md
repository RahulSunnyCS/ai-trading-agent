# BL-202 — Buy-only sweep scored at 1 % slippage: settings, new axes and when to take a Buy

| | |
|---|---|
| **Priority** | P2 — Buy is the one Adaptive family the owner has no evidence for after slippage; the pick rule still takes it on the ranking's word |
| **Status** | In progress (Phase 0 answered and Phase 1 built 2026-11-03; Stage 1 queued for that night; nothing scored) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-03 |
| **Depends on** | BL-104 (the Buy grid and its archive), BL-164 (peak trail, `stop_on: close`), the `slip_store` copies (owner, 2026-10-30); CPU free of BL-176 |
| **TODO.md row** | 3.10.57 |

## Context

The Buy family is a symmetric CE + PE long-option range breakout: at the start time pick the
option whose premium is closest to a target (₹50 in the rotation files, ₹75 in T1's s47 / s48),
watch each option's own high for ten minutes, buy a leg when it breaks that high, leg stop 25 %
(T1: 20 %) trailed point for point, ₹2,000 day stop, out at 15:14. 24 start times per index in
`strategies/rotation/` (48 files) and 48 more in `strategies/rotation_t1/`.

Adaptive (Core-298 and the T1 track) adds **one Buy a day, only when the best Buy ranks in the
overall top 10** of the day's composite (`lists.BUY_TOP`), and on an expiry day keeps it only if it
is on the expiring index (BL-122). Three read-only looks on 2026-11-03 (the T1 ranking rebuilt
day by day from the stored results, each day's best Buy re-run on its own bars at 1 % slippage,
brokerage ₹20 + 18 % GST per order, two orders a trade; scratch scripts, not committed):

| Rule, 10 Jan 2025 → 2 Nov 2026 (438 days) | Days taken | ₹/lot-day at 1 % slip, after brokerage | Win % | Total |
|---|---:|---:|---:|---:|
| Best Buy when in the top 10 (live rule) | 53 (12 %) | −99 | 36 | −5,239 |
| … top 25 / 50 / 75 / 100 | 114 / 198 / 242 / 281 | −175 / −131 / −93 / −66 | 39–41 | −19,900 to −25,899 |
| Best Buy every day | 438 | −163 | 36 | −71,557 |
| Best two Buys every day (one lot each) | 438 | −309 | 36 | −1,35,323 |

Before slippage and brokerage the same picks average +₹30 to +₹164 a day; 1 % slippage removes
about ₹120–160 and brokerage about ₹70. The rank itself does not sort Buy days: ranks 1–10 made
−₹99 a day, ranks 76–100 +₹105. October 2026 (+₹28k from the top Buy over 20 days) was a good
month, not the norm.

What already exists:

- **BL-097** (one-factor, after charges, 2026-10-24): premium, leg SL, MTM, trail, window and
  exit, one axis at a time. Not carried anywhere: the ₹100 premium, the gap, valid-until, percent
  trails and trail × exit.
- **BL-104** (full factorial, closed 2026-10-28): 22,680 Buy cells — strike {ATM, OTM1, ₹30/50/75
  NIFTY, ₹90/150/225 SENSEX} × range {10, 15, 30 min} × source {instrument, underlying} × leg SL
  {20, 30, 40 %} × target {none, 50, 100 %} × trail {none, 1/1, 3/1 pts} × MTM {₹1,000, ₹2,000}
  at seven slots × two indices, **exit fixed at 15:14, gap 0, no valid-until, slippage 0**. No
  NIFTY Buy cell cleared its gates in any band; one band passed all eight rules, Buy SENSEX
  09:17–10:02 (₹150 premium, range 30, SL 30 %, trail 1/1, MTM ₹2,000: ₹158 a lot-day against the
  template's −₹33, in-sample). Its raw results (summaries and day × cell series) are at
  `/Volumes/TradingData/research-archive/bl104/`. The Buy 60 % day-stop cap was never registered.
- **BL-164**: a peak trail for bought legs (`trail_peak`) and stops judged on the bar close
  (`stop_on: close`), both after BL-104's grid was fixed. **BL-186**'s stop-and-reverse is a sold-leg
  option and is not a Buy axis.
- Findings pages per Buy variable under `research/options/strategies/buy-breakout/` (gap,
  source, validity, window, entry and exit time, leg SL, MTM, re-entry, premium, trail, VIX,
  weekday, days-to-expiry); each one this item tests is updated at closure.

The data is the lake's NIFTY and SENSEX weekly options from 2024-10-09 (about 500 usable sessions
each). BL-099 spent the 2025-10-09 → 2026-10-09 holdout and BL-104 fitted on the whole window, so
**no period is unseen by every earlier selection**; this item says so and uses the strongest
split left (below) plus the forward journal.

## Goal

Answer three questions, each pre-registered, with 1 % slippage and brokerage in every figure:

1. **Settings.** Is there a Buy parameter region (per index and start band) that beats the
   rotation template after slippage, robustly (plateau, both halves, the 25 slots, PBO)?
2. **New axes.** Do the levers BL-104 never moved (exit time, gap beyond the range edge,
   valid-until, peak trail, percent trail, stop on close, one re-entry at cost) add to it?
3. **When to take a Buy.** Does any pre-registered day rule (expiry day of the index, a VIX band,
   a gap open, a weekday, the ranking's top N) pick the paying Buy days, against "every day" and
   "never"?

Done when each question has a pass / kill under the rules in Phase 0, the findings pages are
updated, and the owner has a one-page verdict. The item changes no rotation file, no T1 file and
no pick rule: a change to the live Buy rule is a separate item that cites this one.

## Out of scope

- Changing any file under `strategies/rotation/` or `strategies/rotation_t1/`, the 298 / 521
  universes, the journal or the pick rule (`lists.py`, `score.select`).
- CE/PE-asymmetric settings, a second underlying, more than two legs, lots per leg other than 1,
  monthly or next-weekly expiry, the Buy as a hedge to a sold strategy (BL-101).
- The Widesl and Dir families (BL-104 stands for them).
- Portfolio stops, intraday triggers (BL-083), the BL-095 book stop.

## Plan

### Phase 0 — Pre-register (written 2026-11-03, before any run beyond a smoke of ≤ 5 cells)

- **Hypothesis:** the Buy family, scored after 1 % slippage and brokerage, has at least one
  index × band region whose cells all beat the template with a positive block-bootstrap lower
  bound; among the new axes a gap above the range edge and an earlier exit are the ones that
  move it; and Buy pays on the expiring index's expiry days and not elsewhere. The default, if
  nothing holds, is that Buy stays as it is and the verdict says it does not pay after slippage.
- **Universe:** NIFTY and SENSEX weekly options from the lake, per-underlying day lists from
  `data_quality` (the same lists BL-104 used, extended to the last collected day before the run
  starts); the rotation file of each (index, slot) as the cohort's template. Both legs symmetric;
  weekly expiry; partial square-off; `lot_sizing: current` at `SIZING_DATE` 2026-10-12.
  **Execution in every cell: `slippage_pct: 1.0`** on every entry and exit (the figure the owner
  trades on since 2026-10-30, doubled); charges = the BL-096 model (₹20 per order, STT 0.10 % →
  0.15 % from 2026-04-01, exchange, SEBI/IPFT, stamp, 18 % GST). The 0 % and 0.5 % figures of a
  finalist are reported beside it (0 % from the BL-104 archive where the cell exists, else a
  re-run of the finalist only) as a sensitivity, never as the score.
- **Window and hold-out:** fit on **2024-10-09 → 2025-10-08** (the BL-113 fit window, 244
  sessions); test on **2025-10-09 → the last collected day before the run** (about 260
  sessions). Honest about the test half: BL-099 and BL-104 read it when they chose, so it is
  unseen by *this* grid's selection but not by every earlier one. Every pass rule below is judged
  on the test half alone, with the fit half reported beside it. The forward journal from the day
  this item's verdict is written is the only period unseen by everyone; a finalist that goes live
  (another item) is scored there by `rotation readout`.
- **Grid, Stage 1** (`research/bl202/grid.py`, version `bl202-stage1-2026-11-03`, **SHA
  `5f6d9595a141c13c`**, recorded 2026-11-03 before any run beyond the 5-cell smoke; the SHA
  covers the axes, chains, slots, slippage, the split, the Stage-2 values, the exit exclusion
  and the day-rule list; counts held by `tests/unit/test_bl202_grid.py`). One slot per band, the band's first rotation slot: **09:17 (A), 10:17 (B), 12:17 (C),
  14:17 (D)** × NIFTY, SENSEX = 8 cohorts. Axes, a full Cartesian product:

  | Axis | Values | BL-104 had |
  |---|---|---|
  | Premium (closest) | NIFTY ₹30, 50, 75, 100; SENSEX ₹90, 150, 225, 300 | ₹30/50/75, ₹90/150/225 (+ ATM, OTM1, dropped here: the family and both tracks pick by premium) |
  | Range window | 5, 10, 15, 30 min | 10, 15, 30 |
  | Range source | option's own premium, the index | same |
  | Leg stop | 15, 20, 30, 40, 50 % | 20, 30, 40 |
  | Target | none, 50, 100, 200 % | none, 50, 100 |
  | Trail | none, 1/1 pts, 3/1 pts, 20/10 % | none, 1/1, 3/1 (SENSEX ×3) |
  | Day stop (MTM) | ₹1,000, 2,000, 3,000, none | ₹1,000, 2,000 |

  4 × 4 × 2 × 5 × 4 × 4 × 4 = **10,240 cells per cohort, 81,920 in all**, plus the 8 template
  cells (the rotation file as-is at 1 % slippage) as anchors. SENSEX point trails are ×3 as in
  BL-104. Exit 15:14, gap 0, no valid-until, stop on tick, no re-entry, no peak trail in Stage 1.
  Expected direction, registered: a higher premium lowers the hit rate and raises ₹ a hit and
  lowers brokerage drag per rupee; a 5-minute window raises hits and false breaks; the index as
  source lowers hits; a tighter stop lowers the worst day and raises stop-outs; a target caps the
  few big days that carry Buy (200 % expected best of the three); the percent trail keeps more of
  a big move than 1/1; no day stop raises the worst day. The template's figures must reproduce
  BL-104's template cell to the rupee once slippage is set to 0 (regression anchor).
- **Grid, Stage 2** (the new axes; `research/bl202/stage2.py` writes the cells, committed dated):
  for each cohort, its Stage-1 top five plateau cells (rule below) and its template, each crossed
  with exit {13:00, 14:30, 15:14, 15:28; a slot's own exit never earlier than start + 60 min} ×
  gap {0, 1, 2 % beyond the range edge} × valid-until {none, start + 60, start + 120 min} ×
  stop judged on {tick, close} × re-entry on stop {none, once at cost} × peak trail {none,
  activate 150 % / exit 70 % of the high} = up to 288 per base cell, **≤ 13,824 cells** (dropped
  duplicates: a 14:17 slot with exit 13:00 or 14:30). Expected direction: a gap and a valid-until
  lower the hit rate and raise ₹ a hit; an earlier exit cuts the afternoon losers and the
  afternoon winners (net unknown); stop on close lowers stop-outs and deepens the worst day; a
  re-entry adds trades and slippage and is expected negative at 1 %; the peak trail keeps the big
  days. Stage 2 is the only place these axes are read; a Stage-1 cell is never re-ranked on them.
- **Stage 3 — breadth and the day rule.** Each cohort's finalist (one per index × band, ≤ 8) at
  all 24 rotation slots of its index (`--slots all24`), its 0 % and 0.5 % figures, the CSCV PBO
  over the cohort's Stage-1 matrix (8 and 16 blocks), and the **day-rule test**: the finalist's
  day series (and the template's) under each rule — every day; the live top-10 rule; top 25;
  expiry day of the index only; non-expiry only; VIX band at the open ≤ 15 / 15–18 / > 18;
  gap open (|open − previous close| > 0.5 % of the index); each weekday; and "never" (₹0). The
  rules are the attributes `days.csv` already holds plus the rank from the T1 ranking rebuilt day
  by day with `pick.load_history` / `score.composite` (never a recorded entry edited). Expected:
  the index's expiry day pays and the rest does not; the rank rules do not sort. Ten rules × ≤ 8
  finalists; every result is reported, none dropped.
- **Look-ahead check:** every cell is a fixed rule applied day by day from the day's own bars;
  the premium contract is chosen at the start minute from that day's chain; the range is the
  window after the start; the day rule reads only the day's open (VIX, index open) and the
  ranking built from days before it. Selection reads the fit half only; the test half is scored
  once, after the finalists are named, and the names are committed before that score runs.
- **Scorecard.** Gates (all, on the fit half, before a cell is ranked): results on ≥ 95 % of the
  cohort's sessions; an entry (at least one leg filled) on ≥ 40 % of them; net after slippage and
  charges > 0; profit factor ≥ 1.05; **day-stop days ≤ 60 %** (the Buy cap BL-104 wanted, now
  registered); worst five days together no worse than −₹15,000 a lot. **Ranking: the lower bound
  of the 90 % block-bootstrap interval of ₹ a lot-day** (5-day circular blocks, 2,000 resamples,
  seed 20261103), tie-break Martin ratio. **Plateau rule:** a cell's robust score is
  min(own lower bound, median lower bound of its ±1-step neighbours along each axis chain); a
  candidate passes its own gates and at least half of its neighbours pass. Reported per cell:
  net, ₹/lot-day, lower bound, median day, day win rate, worst day, worst five days, max DD and
  recovery days, Ulcer, Martin, profit factor, payoff ratio, entry hit rate, hold minutes, exits
  by cause (target / stop / trail / time / day stop), orders a day, slippage a day, charges a
  day, net at 0 % and 0.5 % slippage.
- **Pass / kill rule.** Default: **Buy stays as it is**, and the verdict says whether it pays at
  1 % slippage at all. A cohort's finalist is a *pass* only if ALL hold on the **test half**:
  (1) its lower bound of ₹/lot-day > 0; (2) its lower bound of (finalist − template) > 0 at the
  band's slots pooled; (3) max drawdown no worse than the template's by more than 10 %;
  (4) Stage-2 neighbourhood median lower bound ≥ 70 % of its own; (5) sign of ₹/lot-day holds on
  ≥ 70 % of the band's rotation slots; (6) the cohort's PBO ≤ 0.5; (7) ≤ 60 % of the edge from
  one DTE bucket or one VIX band (else flagged "regime bet", still reported); (8) the fit half
  agrees in sign. A Stage-2 axis *passes* only if the Stage-2 winner beats its Stage-1 base cell
  by rule (2) on the test half; else the axis is reported as flat. A day rule *passes* only if,
  for a finalist that passed, the rule's lower bound of ₹ a lot-day beats "every day" and the
  rule's days are ≥ 15 % of sessions. **Kill:** a cohort whose best Stage-1 plateau cell fails
  the gates on the fit half has no Stage 2 and no finalist; a family with no finalist after
  Stage 3 is reported as "Buy does not pay at 1 % slippage" and the live rule is left as it is,
  with a recommendation to the owner, in a separate item, on whether the top-10 Buy should stay.
- **Trial count and multiplicity:** about 82k Stage-1 cells + ≤ 13.8k Stage-2 + ≤ 8 × 24 slots
  + ≤ 80 day-rule series, counted per cohort for the deflated Sharpe beside each finalist; the
  PBO is over the cohort's whole Stage-1 matrix. One finalist per cohort at most.
- **Will not run:** CE/PE asymmetry; a second pass on either grid after reading results; values
  outside the registered ranges or between Stage 2's steps; per-slot parameter sets (one set per
  band); a day rule not listed above; scoring on the whole window after the split was read;
  a Buy sized at two lots a leg; re-entry more than once or "ASAP" (BL-009 parity still open).
  Any of these needs `override: <reason>` in the Log, in the owner's words.

### Phase 1 — Stage 1: the coarse grid at 1 % slippage
- **Tasks:** `research/bl202/grid.py` (axes, cells, SHA; a unit test holds the counts);
  `run_grid.py` reusing BL-104's runner shape (one job per cohort, resumable parts, day × cell
  series, `--slippage 1.0` baked into the signature); `score.py` (gates, lower bound, plateau,
  band tables, fit and test halves apart); the template regression against BL-104's archive at
  0 % slippage. Smoke of ≤ 5 cells first. Runs at night, 2–3 workers, after BL-176's machinery is
  idle (its Stage 1 finished 2026-11-02).
- **Deliverables:** `research/bl202/results/stage1/{summary.csv, series/*.npy, ranked.csv,
  band_tables.md}` (git-ignored), the SHA and the regression numbers in this Log.
- **Done when:** every cohort has a part and a series; the 8 template cells reproduce BL-104's
  to the rupee at 0 %; the band tables are read by the owner.

### Phase 2 — Stage 2: the new axes
- **Tasks:** `stage2.py generate` (commit `stage2_cells_<date>.json`), run, `stage2.py evaluate`.
- **Deliverables:** `results/stage2/`, the Stage-2 table per cohort (each axis: flat / moves it,
  with the lower bounds), the finalists' names committed **before** Stage 3 scores the test half.
- **Done when:** every cohort has its ≤ 1 finalist named, or is killed, with the reason logged.

### Phase 3 — Stage 3: breadth, PBO, the test half and the day rule
- **Tasks:** the finalists at all 24 slots; 0 % / 0.5 % sensitivity; PBO; the test-half score;
  the day-rule series and their lower bounds; the verdict page.
- **Deliverables:** `results/stage3/`, the verdict (one page in this item's Log), the
  `research/options/strategies/buy-breakout/*.md` pages of every variable tested (gap, source,
  validity, window, exit time, leg SL, MTM, re-entry, premium, trail, VIX, weekday,
  days-to-expiry; a new `peak-trail.md` and `stop-on-close.md`), `INDEX.md` closed in the same
  commit.
- **Done when:** every finalist has a pass / kill against the eight rules; every day rule has
  its line; the owner has read the verdict. Anything that changes the live Buy rule is a new
  item.

## Risks

- **No clean hold-out exists.** The test half was read by BL-099 and BL-104. Mitigation: the
  split is still blind to this grid, the forward journal is the real test, and the verdict says so
  on its first line.
- **Buy is a few big days.** A 244-session fit half holds perhaps 20 days that carry a cell; a
  lower-bound ranking and the plateau rule limit the damage, but a finalist may still be three
  days. The worst-five-days gate and the "≤ 60 % from one bucket" flag are there for that.
- **82k cells at 1 % slippage is about 3 hours on three workers** (0.5–0.8 ms per cell-day in
  the Phase 1 probes; BL-104 ran at 1.86 ms with two). The runner is resumable; the Mac's cores
  are shared with the morning jobs (08:00–09:30 is kept free) and any Momentum re-run.
- **Slippage at 1 % may be harsher than real fills** on a ₹50 option (a tick is ₹0.05, the spread
  often ₹0.10–0.30 either side: about 0.2–0.6 %). That is why 0.5 % is reported beside it; but
  the pass rules are at 1 %, the owner's choice, so the verdict errs on the cautious side.
- **The ranking-rule test reuses the T1 ranking**, which was itself tuned on the fit half
  (BL-113). Its lines are advisory on the fit half and real only on the test half.

## Open questions

All six answered by the owner on 2026-11-03 (Log). Kept here as asked:

1. **1 % or 0.5 % as the scoring slippage?** The owner's display figure is 0.5 %; the owner asked
   for 1 % on 2026-11-03. Written at 1 % with 0.5 % beside it. Confirm.
2. **The split.** Fit 2024-10 → 2025-10-08, test after: as written. The alternative, fit on the
   whole window as BL-104 did and rely on the forward journal, gives twice the fit data and no
   test half. Confirm the split.
3. **Premium values.** ₹30 / 50 / 75 / 100 (SENSEX ₹90 / 150 / 225 / 300); ATM and OTM1 dropped.
   Add ₹125 (SENSEX ₹375)?
4. **Day stop "none".** A Buy's loss is bounded by its premium × lot, so "none" is a real setting
   (worst day about −₹7,500 at ₹50 premium, two legs); confirm it is wanted.
5. **Slots.** One slot per band (4) keeps Stage 1 at 82k; the seven BL-104 slots would be 143k.
   Confirm four.
6. **Run slot.** After the Momentum work; nights only; 2 or 3 workers.

## Log

- 2026-11-03 — created from the owner's request ("let's do a sweep only for buy") after three
  read-only looks at the T1 Buy (ranks and returns for October 2026; the rank cut-offs 10 → 100
  over 438 days at 1 % slippage; the best two Buys every day): no cut-off and no "every day" rule
  is positive after 1 % slippage and brokerage. Phase 0 written; nothing run. Open questions
  for the owner above.
- 2026-11-03 — **owner's answers** (asked in chat, before any run): (1) score at **1 %**
  slippage, 0.5 % beside; (2) **fit 2024-10-09 → 2025-10-08, test after**, as written; (3) grid
  values **as written** (₹30/50/75/100, SENSEX ₹90/150/225/300; "no day stop" kept); (4)
  asked whether the run could be shortened without losing quality, then chose the **full grid,
  four slots, ~82k cells**, over a screened design (BL-104's 5,541 Buy cells positive at 0 %
  re-run at 1 % at all seven slots, the new values stepped around each cohort's top 20; ~10k
  cells). Run at night on **three workers**, about 7 hours (the item's earlier "2–3 nights" was
  wrong: BL-104 ran at 1.86 ms per cell-day). Recorded for the record, not acted on: in BL-104's
  Buy archive the cells above ₹100 a day at 0 % slippage used the option's own premium as the
  range source 94 % of the time, the ₹30 / ₹90 premium 1 % of the time, and ATM / OTM1 strikes
  (dropped from this grid) more often than any premium value; NIFTY held 75 of those 1,452
  cells, SENSEX 1,377. Adding ATM and OTM1 back as strike values would be a one-line change to
  `grid.py` before the SHA is recorded, and is the owner's call. Status Ready.
- 2026-11-03 — **Phase 1 built** (`research/bl202/grid.py`, `run_grid.py`,
  `tests/unit/test_bl202_grid.py`; 18 tests pass). Grid SHA **`5f6d9595a141c13c`**, 10,240 cells a
  cohort, 81,920 in all, every cell at `slippage_pct` 1.0 inside the strategy. One rule fixed
  before the SHA was recorded: a Stage-2 exit earlier than start + 60 min is excluded, but the
  rotation's own 15:14 and 15:28 are always cells (else the 14:17 cohort would lose its template
  exit). Smoke: 5 cells of B_N_0917 over 503 days at 1 % (the template −₹85 a lot-day after
  charges, against +₹38 at 0 % in BL-104's archive: the slippage drag the item expects). Timing
  probes: 0.5–0.8 ms per cell-day at 300–2,500 cells a cohort, 212 MB a worker at 2,500 cells,
  so Stage 1 is about **3 hours on three workers**, not 7. Window: 2024-10-09 → 2026-11-02 (503
  sessions each index; fit half 247). Stage 1 queued for the night of 2026-11-03 on three
  workers; nothing scored yet.
- 2026-11-03 — **Scorer and regression anchor** (before the Stage 1 run, same day).
  `research/bl202/score.py`: every gating and ranking figure from ONE half of the window (split at
  `grid.FIT_TO`), rebuilt from the day × cell series; the runner now stores beside the net series
  the day-stop flags, winning and losing trade sums and charges (`series/<cohort>.aux.npz`) so
  profit factor, the day-stop rate and the entry rate exist per half. The bootstrap draws one
  index matrix a half (5-day circular blocks, 2,000 resamples, seed 20261103), shared by every
  cell, so the lower bound of (cell − template) is the paired one rule (2) wants. `--half test`
  refuses to run without a committed `--only` finalist list. 25 tests pass. **Regression anchor
  holds:** the four templates BL-104's archive has (NIFTY and SENSEX 09:17 and 10:17; 12:17 and
  14:17 were not in that grid) re-run at 0 % slippage over BL-104's 488 days give its net, worst
  day and trade count to the rupee (`results/regression0/`). Smoke at 1 %, fit half: the NIFTY
  09:17 template +₹40 a lot-day with a lower bound of −₹90 (whole window −₹85).

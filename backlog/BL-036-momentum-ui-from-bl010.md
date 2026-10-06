# BL-036 — Momentum dashboard: what the BL-010 review changes on screen

| | |
|---|---|
| **Priority** | P2 — the dashboard still shows one number per Broad run without saying how much to trust it; BL-029 (the universe choice) stays P1 and is part of this |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | dashboard, momentum |
| **Created** | 2026-10-07 |
| **Depends on** | BL-010 (done to Phase 6); BL-029 (Phase 1 here); BL-024 (journal); BL-001 (every new request field needs a frozen scenario) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner asked for this plan as BL-010's last task, once its analysis was complete. This is a
plan only: each phase below becomes its own PR when picked up.

**What the review found that a viewer of the dashboard cannot see today**
1. A Broad run's CAGR is an in-sample number. On a point-in-time universe the 50 best of the
   8,003 searched configs lose a median 22–25 points, and the typical config loses 5. The four
   configs frozen for Phase 6 made 32% a year in 2017–2026 and 20% in the unseen 2012–2016
   (Nifty200 Momentum 30 TRI: 21%); they failed the pre-registered hold-out.
2. The universe choice is invisible. The Broad selector offers `total_market` (today's 755
   names for every year) and `all_liquid`; the point-in-time `turnover_rank` universe, which
   every BL-010 result used, is accepted by the API since PR #59 but is not offered
   (`MomentumSettingsPanel.tsx:705-717`, `lib/momentumConfig.ts:104`).
3. A multi-week cadence has a phase (which Fridays trade). The UI shows "phase N" (the stored
   offset plus one, `lib/momentumConfig.ts:75`) with no rule behind it, and the weekly signal
   now returns an `explain` line for off weeks (PR #59) that no screen shows.
4. Of the six Phase 2 configs run at signal delay 0, two lost more than the 1-point flag when
   filled at Monday's open instead of Friday's close (`docs/evaluation-review.md`, Phase 2
   step 7). The engine has no Monday-fill option, and the Settings panel defaults `signal_delay`
   to 0 (`MomentumSettingsPanel.tsx:868`).
5. The honest comparators are the Midcap 150, Smallcap 250 and Nifty 500, plus the momentum
   index; `reference_benchmarks.compare` returns only Nifty 50 TRI and Nifty200 Momentum 30 TRI,
   so those are the only comparison lines on any chart.
6. The weekly journal stores weights, not value, and the Journal page does not show the new
   `target_weights` or the Broad data fingerprint.

**Already done, not to be redone:** realistic Broad defaults (circuit-lock fills and the
tradability filter on) and the "upper bound" warning (PRs #19, #20); the engine-faithful Broad
weekly signal (PR #59); the Journal page itself (BL-024).

## Goal

A person looking at a Broad result, a saved favourite or the weekly signal can tell, without
reading the research notes: which universe it used, what to compare it with, whether it traded
on a rebalance week, how it fared on years nobody tuned on, and how a paper-tracked strategy is
doing against its pre-set fail lines.

## Out of scope

- A search or overfitting-statistics UI. Research stays on the CLI (`mbt search ...`).
- Changing any strategy rule or default other than through a phase below.
- Real-money execution screens (BL-025).

## Plan

### Phase 1 — Say what the number is (no engine change)
- **Tasks:**
  1. The universe choice (BL-029 Phase 1): a third option "As each year saw it"; rename the
     first "Today's index list (survivors only)"; the universe on the result card and in Saved
     runs; the upper-bound warning no longer says "today's list" for a point-in-time run.
  2. The result's trust note: one short panel under the KPI cards for Broad and Custom Index:
     "In-sample. On a point-in-time list the typical config loses about 5 points a year and the
     best of a search about 22–25; the four frozen configs made 32% in 2017–2026 and 20% in the
     unseen 2012–2016", with a link to `docs/evaluation-review.md`. Wording is the owner's.
  3. Comparison lines: add Midcap 150 TRI, Smallcap 250 TRI and Nifty 500 TRI (all already in
     `load_references`) to the chart legend as optional lines; default on: Nifty200 Momentum 30
     and Midcap 150 (the BL-010 bar). `compare` gains an optional list; the default payload
     keeps its two lines so saved results and goldens do not move.
  4. Cadence on screen: show the `explain` line on the weekly signal and the Rebalance view
     ("Not a rebalance week: every 4 weeks, phase 3"), "next rebalance Friday", and a tooltip on
     "Which Fridays (phase)" giving the rule (weeks since 2016-01-01, mod the interval).
- **Deliverables:** dashboard changes and tests (`__tests__`), one accepted golden scenario for
  `turnover_rank` (BL-029's), docs (`technical.md`).
- **Done when:** a dashboard run on the new universe matches `mbt search pit-rerun` for the
  same config; the legend offers the four lines; an off-week signal says so.

### Phase 2 — Execution realism (engine + UI)
- **Tasks:** a "Fill at Monday's open" option in the Costs section (engine fill price for the
  signal week's orders; BL-010 Phase 2 step 7 has the replay that already prices it from raw
  bars); show the Friday-close versus Monday-open CAGR on the result card; decide the default
  (open question 3).
- **Deliverables:** engine option with a frozen scenario (BL-001), UI toggle and delta chip.
- **Done when:** the delta chip equals the Phase 2 audit's figure for the same config.

### Phase 3 — Follow the frozen four (starts only when the owner starts paper tracking)
- **Tasks:**
  1. Favourites: save the four frozen configs from `phase6.favourite_requests` as a group
     "Phase 6 ensemble" (read-only, with a badge: frozen 2026-10-06, hold-out failed, with the
     numbers).
  2. A Momentum › Tracking page: the ensemble (equal capital, reset each April), the median
     companion and Nifty200 Momentum 30 TRI since the start Friday, and the two fail lines
     (more than 10 points behind at 26 weeks; a fall deeper than 57.1%) with their status. The
     backend endpoint reads a cached `mbt search track` result that the Friday job refreshes
     (the tracker takes about ten minutes, so it is never run inside a request).
  3. The Journal page: show `target_weights` and the Broad data fingerprint per entry.
- **Deliverables:** endpoint, page, tests; the Friday job refreshes the tracking cache.
- **Done when:** the page reproduces `mbt search track` for the same start; a crossed fail line
  shows red and the weekly Telegram message mentions it.

### Phase 4 — Optional
- Show "picked from N searched configs" on a saved run that came from a search, so a favourite
  carries its own selection warning. Needs a field on saved runs; not worth building before the
  owner saves search winners from the UI.

## Risks

- Every new request field needs a frozen scenario (`tests/golden/test_coverage.py`), or CI fails.
- The point-in-time universe's first run is slower (about 1,700 distinct names); BL-005 may
  help. Measure it in Phase 1.
- The tracking page depends on favourites in the shared database; saving them changes the
  Friday job's workload and is the owner's call, not part of Phase 1 or 2.
- Phase 1 item 2 puts a research result on screen; if the owner prefers not to, it becomes the
  link only.

## Open questions

1. **Default universe for a new Broad run** (BL-029 question 1): today's list or point in time.
   Recommended: point in time, since the warning exists because of it; a default run's CAGR
   drops by roughly 20 points and saved runs keep their own universe.
2. **Which comparison lines are on by default?** Recommended: Nifty200 Momentum 30 and Midcap
   150; the rest one click away.
3. **The default for the trade delay and the Monday-open option.** New Broad runs trade on the
   newest ranking (delay 0). Recommended: keep delay 0, add the Monday-open toggle, and show
   its cost beside every result.
4. **Show the hold-out failure on the frozen four's badge?** Recommended: yes, with numbers.
5. **When does paper tracking start?** Phase 3 waits for that decision (BL-010 open question).

## Log

- 2026-10-07 — created as BL-010's last task: the owner asked for a UI plan once the analysis
  was complete. The current UI was read (settings panel, config summaries, result details,
  comparison lines, journal page) and each finding above is tied to a file.

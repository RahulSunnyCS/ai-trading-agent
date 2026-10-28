# BL-185 — Two-session sets: a full-factorial sweep of half-day Widesl and Dir (two entries, two exits), selected and tested the way T1 was

| | |
|---|---|
| **Priority** | P1 — the owner trades Core and T1 with real money; BL-182 and BL-184 left a drawdown-halving and an afternoon lead that two years of seen data cannot settle, and the owner asked for the proper sweep |
| **Status** | In progress — Phase 0 registered 2026-10-28 23:50 IST (grid SHA `675f5b0b6b174478`, parity gates passed); Stage A started the same night, pausing before 07:30 |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-104 (the sweep this extends, its gates), BL-113 / BL-112 (how T1 was selected and tested), BL-182 and BL-184 (this chat's studies, `research/common/split_replay.py`), BL-105 (locks on the whole-day Dir), BL-181 (ITM2 / ITM3 Dir), BL-122 (expiry-only rule), BL-156 (leg stops on tick), BL-063 (charges) |
| **TODO.md row** | — (filled in when started) |

## Context

### What BL-182 and BL-184 taught (seen data, 2024-10-09 → 2026-10-27, after our charges; all in `research/options/strategies/{widesl,directional}/session-split.md`)

| Study | Result |
|---|---|
| Friend's split (NIFTY OTM1, 09:17–12:00 + 13:00–15:29) | Reproduces within 15 % before costs; after our ₹87 a set the live files read +₹39 (NIFTY) / +₹89 (SENSEX) a lot-day, every 90 % interval through zero; drawdown halves |
| Adaptive two morning + two afternoon Widesl vs its top two whole-day | +₹75 [−56, +205] per margin lot-day, gross +₹158 [+27, +288], drawdown shallower, gain in one year only |
| Adaptive one morning + one afternoon Dir vs its one whole-day | +₹31 [−214, +251], drawdown **deeper**; morning Dir alone poor (+₹81, DD −42,574), afternoon Dir alone +₹276 (DD −16,944) vs whole day +₹326 (−26,486) |
| Brokerage ₹5 (Shoonya) / ₹20 (Angel One) | Moves the point estimate ₹14–38 a day; the interval stays about ±150 wide |
| Morning overall stop ₹500 → ₹4,000 | Tighter hurts (Widesl hit on 41–99 % of days); ₹3,000 / ₹4,000 raise the morning Widesl to +140 / +168 a day in every half-year; no Dir level holds (₹1,500 a spike) |
| Morning targets ₹500 → ₹4,000 | Hurt the Widesl at every level; noise on the Dir |
| Morning locks / lock-and-trail | Widesl: lock-trail at ₹3,000 (breakeven, 1:1) +91 vs +64, never hurts by period; Dir: six of eight beat plain, fixed files agree, second year near zero |
| By expiry day (the pick's own index) | Whole-day Widesl +₹511 on expiry days and **+₹10 on others**; afternoon pair +387 / +100; morning Dir **−47 on expiry days**; the split's gain is on non-expiry days |

What carries forward as **hypotheses, not results**: the afternoon set is the strong half; the morning set needs a looser stop and may like a lock; day type (expiry vs other) changes the answer, as it did when T1 was built; a morning-closed Dir is weak.

What carries forward as **method**: `split_replay.py` (derive half-day files, simulate with charges, replay list C per pool, books, block bootstrap, per-period and per-expiry reads); **path overlays** — the engine's per-minute MTM series (`DayResult.mtm`) recorded once, then an overall stop, target, lock, lock-and-trail or earlier exit applied to the series exactly as the engine would (parity: 0 mismatches over 75,150 + 50,100 whole-day variant-days and every day's last MTM equals its gross), so those axes cost array operations, not simulations.

What carries forward as **limits**: on 434 pick days the 90 % half-width of a book difference is about ±₹130 (Widesl) and ±₹230 (Dir) per margin lot-day, so an effect has to exceed roughly ₹130–230 a day to show a positive lower bound; a real +₹75 cannot be distinguished from zero with two years. Every conclusion so far is on seen data and unstable between the two years.

### How T1 was built (BL-104, BL-113, BL-112)

BL-104 swept 63,384 cells (Widesl / Dir / Buy × strike × leg SL × trail × MTM × exit × re-entry × 7 entry slots × 2 indices; Calmar ≥ 1, profit factor ≥ 1.05, Martin ranking, plateau rule, CSCV PBO). T1 took **one time-generic setting per family × index × day type** (nine: `N_wide` expiry-day and other-day winners, `N_dir`, `N_ditm1`, NIFTY and SENSEX premium Widesl, NIFTY Buy ×2, `S_ditm1`) chosen on **2024-10-09 → 2025-10-08 only**, ran each at **all 25 entry times** (223 extra variants beside Core-298's 298), and Adaptive over the union was tested on the **unseen year** 2025-10-09 →: +₹223 gross per lot-day [+82, +361] over Core, shallower drawdown. "Time-generic" means the setting was chosen to work at any entry time; Adaptive chooses the time. Every set had one entry and one exit (15:28).

### What is new

A set now has **two entry times and two exit times**: a morning half M (entry e1, exit x1) and an afternoon half A (entry e2 ≥ x1 + 2 minutes, exit x2), each its own set, lot and overall stop. The owner asks for the same proper sweep over every parameter, for each half, selected like T1, with Adaptive choosing within each half.

## Goal

A verdict, on an unseen year and then on unseen NIFTY history, on whether Adaptive over a **two-session universe** beats (a) T1 Adaptive as traded and (b) the same sweep's whole-day winners, per margin lot-day after charges with a drawdown no deeper; and the tuned half-day settings themselves, as a table the owner can read.

## Out of scope

Any change to a live file, list, pick or journal; Buy; CE/PE-asymmetric legs and hedged or ratio legs (a v2 after this); anything traded. The forward paper track and the platform plumbing are Phase 6, only on a pass.

## Plan

### Phase 0 — Pre-register (registered 2026-10-28 23:50 IST, grid SHA `675f5b0b6b174478`, before Stage A; frozen)

- **Hypothesis:** Adaptive choosing, each morning at 09:16, the best **half-day sets** for the morning and for the afternoon from a sweep-tuned universe earns more per margin lot-day after charges than T1 Adaptive as traded, and than the same sweep's whole-day winners, with a max drawdown no deeper, on a year the selection never saw.
- **Universe and data:** NIFTY and SENSEX weekly options from the lake, usable days from `data_quality`, weekends excluded, the legwise engine at its default trigger-level fills (BL-156), sizing `current` at 2026-10-12, charges from `ruletest/charges.py` (₹13 an order) with ₹5 and ₹20 reported. Windows: **selection S = 2024-10-09 → 2025-10-08**; **test T = 2025-10-09 → 2026-10-27**; **advisory NIFTY 2022-01-03 → 2024-10-08** (the vendor days, for finalists, run once, as BL-104 did; SENSEX has none).
- **Base grid** (simulated once per cell, the path recorded at exit 15:28), per index, per cohort:

  | Cohort | Axes | Cells per slot |
  |---|---|---|
  | W (wide stops) | strike {ITM3, ITM2, ITM1, ATM, OTM1, OTM2, OTM3, three closest premiums: NIFTY ₹60 / 100 / 150, SENSEX ₹200 / 285 / 320} × leg SL {40, 60, 80, 100, 120, 150 %} × trail {none, [15,10] %, [25,15] %} × re-entry {none, RE COST ×1} | 360 |
  | D (tight stops) | the same ten strikes × leg SL {10, 15, 20, 25, 30, 40 %} × trail {none, [10,5] %} × re-entry {none, RE COST ×1, RE COST ×2} | 360 |

  Entry slots **morning 09:17, 09:32 … 11:47 (11)** and **afternoon 13:02 … 15:02 (9)**: 720 × 20 = 14,400 variants per index, 28,800 in all (≈ 14.4 million variant-days). ITM strikes in the W cohort and ITM3 / OTM3 in D are extensions past BL-104's registered ranges (owner, 2026-10-28); the plateau rule treats an edge-of-grid winner as unproven.
- **Overlay axes** (applied to the recorded paths, no simulation): **exit x1 ∈ {11:30, 12:00, 12:30, 13:00}** for morning cells (afternoon x2 fixed at 15:28: BL-147 and the exit-time pages); **overall MTM stop ∈ {none, ₹500, 750, 1,000, 1,250, 1,500, 1,750, 2,000, 2,500, 3,000, 3,500, 4,000}** per set. Stage C adds, on each cohort's survivors only, **target ∈ {₹500, 750, 1,000, 1,250, 1,500, 1,750, 2,000, 2,250, 2,500, 3,000, 4,000}**, **lock (arm → lock) ∈ {2k→1k, 3k→1.5k, 3k→2k, 4k→2k, 4k→3k}** and **lock-and-trail (arm, breakeven, 1:1) ∈ {1.5k, 2k, 3k, 4k}**. A setting that uses a lock or trail is marked `not_deployable` until it is confirmed against an AlgoTest / Quantiply export (the engine has no such field; the exporters refuse what they have not seen).
- **Day-type strata** (as T1): every cell is scored on **expiry days** (days to expiry 0 on its own index) and **other days** separately, as well as on all days; a winner is chosen per stratum. The expiry stratum is thin (about 55 days in S per index); a winner there needs its neighbours to agree.
- **Selection recipe (T1's, applied per half):** per cohort (family × index × **half** × start band × stratum), on **S only**: gates (≥ 95 % sessions with an entry; net after charges > 0; Calmar ≥ 1.0; profit factor ≥ 1.05; MTM-stop days ≤ 30 %), Martin ratio, the plateau rule over the axis chains (own Martin vs the median of ±1-step neighbours; a candidate needs at least half its neighbours to pass its gates), breadth across the half's slots (sign and Calmar ≥ 1 on ≥ 70 % of them), ₹/lot-day positive in the half-years of S, CSCV PBO ≤ 0.5 per cohort, ≤ 60 % of the edge from one DTE bucket or VIX band, not dependent on RE COST ×2 while BL-009's parity is open. The winner is **one time-generic setting per cohort**, run at **every slot of its half**. Bands: morning A (09:17–10:02), B (10:17–11:47); afternoon C (13:02–14:02), D (14:17–15:02).
- **Parity gates before Stage A (Phase 1):** overlay exits, stops, targets, locks and lock-trails equal full engine runs (0 mismatches over ≥ 1,000 variant-days per overlay kind, the gross to the rupee); charges reconstructed from the recorded trade events equal `day_charges` on the full run (to ₹1). If charges cannot be reconstructed exactly, Stage A and B rank on gross less a per-order estimate and every finalist is re-run exactly before it counts.
- **Adaptive replay (T only; S supplies the 63-day warm-up):** list C's composite exactly as the 09:16 job (`score.composite`, ranked on gross as the live store does), per pool. Arms, each at the same **peak of three concurrent sets** so a margin lot is comparable:
  - **A0** T1 Adaptive as traded: Core-298 + T1's nine settings × 25 slots, three core picks (Dir allowed, Widesl minimum two), whole day, **re-simulated here with the same charges**;
  - **A1** whole-day winners of this sweep (the same selection run at exit 15:28), three picks — the control that separates "the sweep re-tuned it" from "the split helped";
  - **A2** the split: three morning picks + three afternoon picks from the half-day winners (Widesl minimum two per half), both made at 09:16;
  - **A3** afternoon-only: three afternoon picks (the lead from BL-182 / BL-184), with and without the expiry-day filter BL-122 applies to A0.
- **Measure:** net per margin lot-day after charges (book net ÷ peak concurrent sets), gross beside it, days in profit, max drawdown, per-period and per-expiry reads, ₹5 and ₹20 brokerage; difference mean and 90 % interval from `readout.block_bootstrap_mean` (circular 5-day blocks, 2,000 resamples, seed 20261028).
- **Pass / kill rule:** **A2 passes** if both A2 − A0 and A2 − A1 have a 90 % lower bound above zero after charges at ₹13 AND A2's max drawdown is no deeper than A0's, over T. A pass earns the advisory NIFTY 2022–24 run (a sign flip in the primary comparison is a caution flag, as BL-104) and then Phase 6, never a trade. A fail records the tuned half-day settings anyway as a descriptive table. A1 and A3 are read, not gated. **What T can decide:** at about 250 test days the interval half-width is of the order of ₹150–300 per margin lot-day, so only a large effect can pass; a real small edge needs the NIFTY 2022–24 days (about 680 more) and the forward track.
- **Look-ahead and contamination:** every cell is a fixed rule applied day by day from its own bars; selection reads **S only**, and Adaptive's history for T is the stored results before each pick day. The grid axes and levels were chosen after reading BL-182 / BL-184 on both years, so T is **not untouched knowledge** (the morning stop and lock leads were seen by period): the grid is deliberately broad, no level is singled out, and the NIFTY 2022–24 and forward days are the unseen test.
- **Will not run:** a second pass on the grid after reading T; selection on T or on the whole window; levels beyond the grid; per-slot parameter sets; CE/PE asymmetry and hedged legs; 12:55 afternoon picks; more than the registered arms; the Buy family. Any of these needs `override: <reason>` here.

### Phase 1 — Build and parity gates (about half a day; nothing of the grid runs yet)

- **Tasks:** lift BL-104's `score.py` / `robust.py` pieces and `split_replay.py` into `research/common/two_session/` (a script never imports from another item's folder): `grid.py` (axes, SHA, `tests/unit/test_bl185_grid.py` holds the counts), `paths.py` (per variant-day: the 375-minute MTM series **and** the trade events, one `.npz` per variant, written by the simulation), `overlay.py` (exit truncation, overall stop, target, lock, lock-trail, charges from events), `run_grid.py` (resumable parts per index × cohort × slot, `--workers`), `score.py`, `select.py`, `replay.py`, `report.py`; `research/bl185/` holds the registered configuration. Parity tests as above; a smoke run of 3 cells × 8 days.
- **Done when:** every parity gate holds, the grid SHA and counts are committed, Phase 0 is frozen.

### Phase 2 — Stage A, overnight: simulate the base grid with paths

- **Run:** 28,800 variants × ~501 days. Measured in this chat: ≈ 7 ms per variant-day with charges (a day loaded once per index and shared by all its variants); with events recorded budget ≈ 9 ms, i.e. ≈ 36 CPU-hours, **≈ 6 hours on 6 workers** (the Mac has 8 cores and 8 GB; cap at 6, `nice -n 10`, `caffeinate`). Paths are ≈ 11 GB per index on the external image (186 GB free); non-survivors are deleted after Stage B. Resumable: a finished part is never re-run.
- **Calendar guard:** the scheduler's 19:45 rotation update, 21:00 T1 update and 00:00 contract notes finish before ~00:30; the 07:30 notes retry and the **08:02 broker login** need the Mac and a browser, so the run must finish by ~07:00 or pause (workers stop between parts). Never touch `TRADING_DATA_ROOT/rotation/`; outputs go to `research/bl185/` (git-ignored).
- **Done when:** every cohort × slot has its part; row counts per variant match the usable days.

### Phase 3 — Stage B and C: overlays, scoring, selection (about an hour of compute, then a read)

- **Stage B:** exit × overall-stop overlays over every base cell (≈ 0.9 million cells, vector operations over the recorded paths), score per stratum on S, apply the gates and the plateau rule, keep the top 100 per cohort. **Stage C:** targets, locks and lock-trails crossed with the survivors; re-score; **freeze the winners** (a dated list, one setting per cohort × stratum) before T is read.
- **Done when:** the winners file is committed; a table of every cohort's winner with its neighbourhood is in the item.

### Phase 4 — Adaptive replay on T

- Build the pools (Core-298 + T1 for A0; the winners at every slot of their half for A1 / A2 / A3), run the replay, tabulate A0–A3 with the measure above, per period and per expiry day.
- **Done when:** A2 − A0 and A2 − A1 have their verdicts against the rule.

### Phase 5 — Unseen NIFTY and robustness (only for finalists)

- Run the winners once on NIFTY 2022-01-03 → 2024-10-08 (price seam at 2024-10 noted); bootstrap vs the comparator, half-year and slot breadth, DTE / VIX strata, slippage 0 / 0.25 / 0.5 %, brokerage ₹5 / ₹13 / ₹20, a per-order spread allowance on the afternoon fills (BL-059: late 1-minute fills are the engine's weakest part).
- **Done when:** each finalist has its flags; the findings pages are written (`research/options/strategies/{widesl,directional}/session-split.md` updated, a new common page for the two-session universe).

### Phase 6 — Only on a pass: forward paper track and platform plumbing

A parallel track `t2` like BL-113 (own folder and journal, after the live pick, private Telegram, 60 trading days). Everything that has to change for it:

| Area | What changes |
|---|---|
| `rotation/variants.py` | variant names carry an exit (`<N|S>_<base>-t2s<set>_<HHMM>-<HHMM>`); `parts()`, `track_of`, `TRACK_DIRS` assume three underscore parts and one time |
| `rotation/score.py`, `pick.py` | two pools and two rankings per day (morning, afternoon); `family_index` bands per half; the Widesl minimum per half; the expiry-only filter's interplay |
| `rotation/update.py`, `store.py` | nightly results for the new variants (about 130 more); `load_matrix`'s day intersection |
| `labels.py`, `messages.py`, `deliver.py` | labels and the 09:16 / evening messages list morning and afternoon picks; days to expiry wording |
| `algtst_export.py`, `quantiply_export.py`, uploaders, deployers | exit times per file; an afternoon strategy must be uploaded and enabled before 13:02 and deleted after; a lock or trail only if confirmed against an export |
| trade monitor, stop button, live capture, `live_compare.py` | the 09:25 "exactly the picks" check and the 15:30 capture assume every set starts by 09:25; copies "off-slot" |
| dashboard Rotation page, lot plans, Settings › Automation | morning / afternoon baskets, per-half toggles |
| scheduler | pick timing is unchanged (09:16); a second deploy window around 12:50 for afternoon sets if the platforms cannot hold a scheduled start |

## Risks

- **Power.** Even a good result on T may have an interval through zero; the plan says in advance what it can and cannot decide (Phase 0), and the unseen NIFTY days and the forward track carry the rest.
- **Multiplicity.** Roughly a million overlay cells and 28,800 simulated variants: the protection is procedural (S-only selection, plateau, PBO, the frozen winners file, T read once), not statistical. The best cell of a million always looks good.
- **Charge reconstruction** from events may not be exact; gated in Phase 1, with an exact re-run of finalists as the fallback.
- **Thin expiry stratum** (about 55 days per index in S): winners there are leads; the T1 expiry-day settings were chosen the same way.
- **Late fills.** Afternoon sets rest on 1-minute fills with no spread (BL-059, a jump at 14:47 never explained); Phase 5 charges an allowance.
- **Platform support** for half-day sets and any lock or trail is unverified; `not_deployable` keeps it out of a finalist until it is.
- **Machine.** 8 GB of RAM and a laptop that also runs the scheduler and the 08:02 login: the run is capped at 6 workers and must not collide with the morning jobs.

## Open questions (the owner, 2026-10-28 23:30: "build now and run complete as much as possible. Pause at 7:30 am"; every default below stands)

1. Morning exits {11:30, 12:00, 12:30, 13:00}; afternoon exit 15:28 only. *(default)*
2. The ten-strike ladder (ITM3 → OTM3 plus three premiums) for **both** cohorts. *(default)*
3. Arms A0–A3 at three concurrent sets; the primary pass rule on A2 against both A0 and A1. *(default)*
4. Stage A starts as soon as Phase 1's parity gates pass, even late at night; it pauses before 07:00. *(default)*
5. Whether the owner wants the ₹20-per-order Angel One brokerage as the headline instead of ₹13.

## Log

- 2026-10-28 — created from the owner's request ("a proper research ... a sweep through everything, like we have
  done for adaptive tune ... now we have two entry times and two exit times"), after BL-182 / BL-184; Phase 0
  drafted.
- 2026-10-28 23:50 — owner: build now, run as much as possible, pause at 07:30. **Phase 0 registered** with grid
  SHA `675f5b0b6b174478` (`research/common/two_session/grid.py`: 720 cells per cohort-slot, 14,400 variants per
  index). Parity gates (`parity.py`, 60 days × 6 cells × 2 indices × 7 settings = 4,080 variant-days): gross
  equal to the rupee once two things were fixed before Stage A — the engine fills an exit at the exit minute's
  `price_at`, the previous minute's close (BL-009), so an exit overlay ends at the path's value at x − 1, and
  paths are stored as exact paise, float32 having fired a target a minute early on three days; charges
  reconstructed from the recorded trades within ₹10 (worst ₹8.13; the gate was registered at ₹5 and widened
  to ₹10 before Stage A, since a trade still open at an overlay exit is valued at its entry, which moves only
  the exchange fee and stamp). Lock and lock-trail overlays equal `portfolio.apply_book` on 1,440 checks.
  Paths go to `TRADING_DATA_ROOT/research/bl185/paths/` (int32 paise, about 11 GB an index); the internal disk
  has 31 GB free. Stage A: 6 workers, `nice`, `caffeinate`, no new part claimed after 07:00.

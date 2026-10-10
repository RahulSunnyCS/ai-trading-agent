# BL-081 — Hourly checkpoints for picks that have not started yet, and the "no-trade" option

| | |
|---|---|
| **Priority** | P2 — options research; the afternoon holds about half of the basket's picks |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-075 (lists A / B / C and the three periods), BL-069 (sit-out gates), BL-071 (2022–24 import) |
| **TODO.md row** | — |

## Context

The rotation picks its three strategies at 09:16 and never looks again. The owner (2026-10-10) raised two
ideas: (1) a "no-trade strategy" in the universe, one per index per start slot, worth ₹0 every day, so the
ranking can choose not to trade; (2) an hourly check of the picks that have not started yet, using the
market state up to that hour (VIX direction, trend, VWAP, ATR, RSI, pivots, ...), to keep, swap or drop
them. Picks that have already started are never touched.

Measured before registering (read-only, lists A / B / C, `research/bl075/out/runs`):

- **Zero column.** Criteria are percentile ranks of raw rupee values (`rotate.py` `pct_rank`, average
  ties), so a zero column ranks above exactly the candidates with a negative raw criterion. On the 202 P1
  selection days its best rank among 201 core candidates was 19th (A), 20th (B), 17th (C), median about
  145th; on no day were 90% of candidates negative on recent return or on all four criteria. It never
  reaches the top 3. Per-slot copies are identical columns with identical scores.
- **Pending share** (core picks starting strictly after the hour):

  | checkpoint | P1 share of picks / days with one pending | P3 |
  |---|---|---|
  | 10:30 | 51% / 72% | 44% / 69% |
  | 11:30 | 38% / 60% | 27% / 49% |
  | 12:30 | 29% / 48% | 18% / 35% |
  | 13:30 | 14% / 25% | 7% / 14% |
  | 14:30 | 9% / 16% | 3% / 6% |

- **Data.** NIFTY (2015→), SENSEX (2018→), INDIAVIX (2015→) 1-minute bars exist for all three periods.
  Index bars carry volume 0 before 2026-09 and futures bars exist only from 2026-09-23, so a true VWAP
  cannot be backtested (follow-up BL-082). `derived/straddle_series_5m` exists for 2024-10→ only. Stored
  per-variant results hold one P&L per day, no intraday path.
- Nothing about intraday re-ranking existed in the backlog or research folders.

## Goal

A recorded answer to: does the market state at 10:30 / 11:30 / 12:30 / 13:30 carry information about how
the pending strategies finish the day, and if it does, does a keep / swap / drop rule built on it beat
the plain list in all three periods?

## Out of scope

Any live change, any change to lists A / B / C or the journal (BL-058), UI work (backlog), re-running the
engine for the started picks' live MTM (stage 2, deferred until earned), real VWAP (BL-082).

## Plan

### Phase 0 — Pre-register (2026-10-10, before any run)

**Definitions (fixed).**
- *Checkpoint* h in {10:30, 11:30, 12:30, 13:30}; 14:30 is measured and reported, never acted on.
- *Pending universe at h*: every variant, both indices, whose start tag is at least 15 minutes after h
  (10:47, 11:47, 12:47, 13:47 first slots). A pick starting earlier counts as started and is untouched.
- *State at h*: computed from 1-minute bars with timestamp <= h only (asserted in code). NIFTY variants use
  NIFTY bars, SENSEX variants SENSEX bars; INDIAVIX is shared.
- *State fit* of variant v at h, on day i: `skewed_fit` of v over past days (rows before i only) whose state
  at h equals day i's state, lookbacks 5:30, 21:25, 63:25, 126:20, windows without a matching day
  renormalised exactly as `rotate.py` does for weekday / DTE / VIX.
- *Periods*: P1 2025-12-03 → 2026-10-08 (202 days), P2 Jan–Aug 2025 slice (157), P3 NIFTY-only
  2022-04-05 → 2024-10-08 (618), as BL-075, same warm-up, same stored results.

**State variables (14 + 3 pairs; bands fixed here; terciles are trailing 252 sessions, point in time, a day
with fewer than 60 sessions of history gets no label for that variable and is skipped for it):**

| group | variable at h | bands |
|---|---|---|
| VIX | change since 09:15 open | < −2% / flat / > +2% |
| VIX | change over the last 60 min | < −1% / flat / > +1% |
| trend | move since open ÷ 14-session ATR | < −0.3 / flat / > +0.3 |
| trend | spot position in the day's range so far | < 0.25 / mid / > 0.75 |
| VWAP-like | spot vs its time-weighted average since open | below / near (±0.15%) / above |
| VWAP | ATM straddle price vs its volume-weighted average since open (option bars; ATM fixed at the 09:20 spot, nearest expiry) | below / near / above |
| ATR | range since open ÷ 14-session ATR | terciles |
| ATR | last-60-min range ÷ 14-session ATR | terciles |
| RSI | RSI-14, Wilder, on 5-minute closes (continuous series including the previous session) | < 30 / 30–70 / > 70 |
| RSI | RSI change over the last 30 min | < −5 / flat / > +5 |
| pivots | spot vs yesterday's classic pivots (P = (H+L+C)/3, R1 = 2P−L, S1 = 2P−H) | below S1 / S1–P / P–R1 / above R1 |
| pivots | pivot lines inside the day's range so far | 0 / 1 / 2+ |
| straddle | ATM straddle change since open (derived series, 2024-10→) | < −10% / flat / > +10% |
| straddle | ATM IV change since open (derived series, 2024-10→) | < −5% / flat / > +5% |
| gap | overnight gap band | as BL-069 |

Pairs (never more than two at once): VIX-since-open × trend-ATR, VIX-since-open × RSI level,
trend-ATR × pivot zone. A variable without P3 data (the two straddle rows, and the straddle VWAP if the
imported 2022–24 option bars carry no volume) is *supporting only*: it can be reported but cannot count.

**Step 1 — which variables carry pick-value, at which hour (no engine runs).**
- *Pick-value* of variable x at h in a period = the mean over selection days of the Spearman correlation,
  across the pending universe, between the day's state fit and the day's realised P&L (the statistic
  `rotate.py` prints for its own criteria, so it is on the same scale as weekday / DTE / VIX).
- *Comparator*: 20 permutations of the state labels across days (seeds 0–19), the same fit and the same
  statistic. x *passes* at h in a period only if its pick-value is positive and above all 20 shuffles.
- x *counts* only if it passes at >= 2 of the 4 hours in **all three** periods. Under independence the
  chance of a false count is below 0.01 per variable; the full variable × hour × period table is
  published whatever it shows.
- Reported alongside, not decisive: best-minus-worst state mean of pending P&L in rupees, by type
  (Widesl / Dir / Buy) and start band (B 10:47–12:02, C 12:17–14:02, D 14:17+); the pick-values of
  weekday / DTE / VIX band recomputed by the same code as a calibration.
- **Gate:** step 2 runs with the variables that count (at most the top two by mean pick-value, singly or as
  one registered pair). None counts → the item closes: "the hourly state does not predict the afternoon
  strategies".

**Step 2 — the checkpoint rule (rotation only; lists A / B / C and REF; P1 / P2 / P3).**
- At h the pending universe is re-scored: `(1 − m) × pct(list composite at 09:16) + m × pct(state fit)`,
  both percentile-ranked within the pending universe, m ∈ {25%, 50%}.
- A pending pick is *kept* if it stays in the top of the pending universe by that score, otherwise
  *swapped* for the best-scoring unpicked pending variant. Widesl minimum and lots never change; started
  picks never change; later checkpoints act on what earlier ones left pending.
- *Swap breadth*: **free** (any pending variant, either index, either type, subject only to the Widesl
  minimum) and **family-preserving** (same strategy type and index; the start time may move).
- *Drop*: a pending pick is not traded when its state fit in rupees, after any swap, is below zero;
  nothing replaces it (the Buy add-on follows the same rule when pending).
- *Versions*: m (2) × breadth (2) × actions (swap only / drop only / swap + drop) = 12 per list.
  Drop-only has no breadth axis, so 2 × 2 × 2 + 2 × 1 = 10 distinct runs are performed; reporting keeps
  the 12-row layout.
- *Controls*: (a) **state-blind**: the same rules with every day carrying one label (the state fit becomes
  the plain trailing mean) — separates "state information" from "re-ranking again at the hour";
  (b) **random actions**: 1,000 runs doing the same number of swaps / drops per hour and period at
  random; (c) **label shuffles**: 10 permutations of the state labels per period.
- **Keep** a version only if **all** of: gross above the plain list in all three periods; the gain above
  the largest of the 10 shuffled gains in each period; above the random-actions P90 in each period;
  above the state-blind control in each period; max drawdown not more than 10% worse than the plain
  list in any period; for drop versions, the dropped picks' P&L negative in every period (BL-069's test).
  A version stands on its own result, never on a neighbour passing. Anything kept is a candidate for the
  forward journal, not an adoption.
- Reported: keeps / swaps / drops per hour and period, P&L of swapped-out vs swapped-in picks, free vs
  family-preserving and 25% vs 50% side by side.

**Block 1 — the no-trade column (runs alongside step 1; lists A / B / C and REF × P1 / P2 / P3).**
- **1a `--no-trade`**: one zero column per index in the core pool, neither Widesl nor Dir, ranked like any
  variant. *Prediction:* 0 days affected in every period.
- **1b `--rupee-gate`**: a core pick is traded only if the list-weighted sum of its raw rupee criteria
  (recent, weekday, DTE, VIX, family recent, as raw means, not ranks) is above zero; dropped picks are not
  replaced; no qualifying pick = the whole day out, Buy included. Threshold 0, not tuned.
- *Keep* only if gross per lot-day rises and max drawdown improves >= 20% in every period and the dropped
  picks lost money in every period. *Prediction:* fires rarely, drops mostly winners (BL-069 B7).

**Stage 2 (deferred, not registered for running):** the started picks' live MTM at h as a state; needs
re-runs of about 60 morning variants over about 1,100 days; registered only if step 2 keeps something.

**Look-ahead check.** State at h reads bars <= h only; the fit reads days before i only; the 09:16 score is
the existing list score; ATR / terciles / pivots use completed prior sessions; the realised P&L of day i
is used only to judge. Asserts in `research/bl081/state.py` and `stage0.py`.

**Will not run:** other checkpoint spacings, other bands or thresholds, three-variable states, other
blend weights than 25% / 50%, other lookbacks, any change to lists A / B / C. A run beyond this needs
`override: <reason>` in the Log.

**Hold-out:** none kept unseen; all three periods were seen by BL-065–BL-075 (owner's standing override).
The forward journal is the only unseen data; a kept rule would be measured there before it is trusted.

### Phase 1 — State table and the no-trade runs
- **Tasks:** `research/bl081/state.py` (day × index × hour × variable → `out/state.csv`);
  `--no-trade` / `--rupee-gate` in `rotate.py`; `research/bl081/run_block1.py`.
- **Done when:** block 1a reproduces the lists' recorded grosses when the zero column is never picked
  (A ₹3,89,900 on P1; REF ₹4,30,868 / −₹68,294); `--rupee-gate` with weights 100/0/0/0 reproduces BL-069
  B7(a) (5 days affected, ₹4,12,846); state rows asserted to end at or before h.

### Phase 2 — Step 1
- **Tasks:** `research/bl081/stage0.py` → `out/stage0_heatmap.csv` and the rupee spreads.
- **Done when:** the calibration rows match `rotate.py`'s printed weekday / DTE / VIX values on list A P1
  (+0.036 / +0.028 / +0.041) and the table is recorded here.

### Phase 3 — Step 2 (only if the gate passes)
- **Tasks:** `--checkpoint`, `--state`, `--state-weight`, `--swap`, `--action` in `rotate.py`; the runs;
  record.
- **Done when:** every version's read-out is recorded in this file with the keep / drop verdict.

## Risks

- Many variables × hours × periods: controlled by the all-periods-and-two-hours bar and the published
  table, not by trust.
- The fit cells are thin at the 5-day window (about 1–2 matching days); this is the same weakness the
  weekday / DTE fits already have.
- A 10:31 / 11:31 / 12:31 / 13:31 amendment is manual work on AlgoTest; a kept rule must beat the plain
  list by enough to justify it (judged in the journal item, not here).

## Open questions

None blocking. The VWAP follow-up (BL-082) waits for six months of futures bars.

## Log

- 2026-10-10 — created and pre-registered from the owner's two ideas (no-trade strategy per slot; hourly
  checks of not-yet-started picks) and the owner's additions: hourly not only 10:30, more variables
  (VWAP, ATR, RSI, pivots), free swaps as well as family-preserving, a 50 / 50 blend as well as 25 / 75,
  real VWAP deferred to BL-082.

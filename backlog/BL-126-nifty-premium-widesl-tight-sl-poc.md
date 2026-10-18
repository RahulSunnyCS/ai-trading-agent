# BL-126 — POC: NIFTY Widesl ₹100 at SL 75 % and ₹120 at SL 60 %

| | |
|---|---|
| **Priority** | P3 — owner's idea, a quick look before anything is planned |
| **Status** | Done — informative, not adopted: neither setting positive standalone or in Adaptive |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (rotation lists, results store), BL-104 (the sweep the idea came from) |
| **TODO.md row** | — (POC only; a row is added if it goes further) |

## Context

Owner (2026-10-18): "I was thinking of trying N_100 with 75 % SL widesl", then "lets create a 120 with 60 % too",
"Backtest first", "initially do poc". Core's `N_p100_*` sells the CE and PE closest to ₹100 with SL 115 %,
trail 15 %/10 %, no re-entry, ₹2,500 overall max loss. Before choosing, the owner saw BL-104 stage-1 summaries
for NIFTY ₹100 Widesl (trail 15/10, no re-entry, MTM ₹2,000/₹3,000, 7 sampled slots, 2024-10 → 2026-10, net):
SL 80 % about +₹79–83 per lot-day against SL 120 % about +₹53–54, uneven by slot. Those summaries cover every
window used below, so this POC is **not** an independent test of that observation.

## Goal

Say, descriptively, whether the two settings do better than Core's ₹100 Widesl at the same entry times, and
whether Adaptive would have done better with them in its universe. Nothing is adopted from a POC.

## Out of scope

Changing Core-298, T1 or the live lists; a forward track (proposed separately, only if the POC reads positive);
other premiums, SENSEX, other stops.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Arms (owner-chosen, no data selection):** X1 = NIFTY Widesl closest premium ₹100, SL 75 %; X2 = NIFTY
  Widesl closest premium ₹120, SL 60 %. Everything else as Core's `N_p100`: sell CE + PE, 1 lot each, weekly
  expiry, trail 15 %/10 % (percent), no re-entry, overall max loss ₹2,500, exit 15:28, partial square-off,
  current lot sizing. Each at the 25 rotation entry times (50 variants). Comparator: Core `N_p100_<slot>`.
- **Simulation:** the same leg-wise engine, costs and data-quality exclusions as `obt rotation update`
  (results in this item's research folder only; the live results store, journal and strategy folders are
  never written).
- **Q1 (standalone, net of charges):** per day, the mean over the 25 slots of (arm minus Core `N_p100`) at the
  same slot; mean per lot-day with a two-sided 90 % circular block bootstrap (5-day blocks over ordered days,
  2,000 resamples, seed 20261018), on every collected day from 2024-10-09 to the latest scored day. Also per
  slot (descriptive) and max drawdown of the slot-averaged series.
- **Q2 (Adaptive):** list C (registered weights and lookbacks, no expiry rule), replayed over Core-298 + the
  50 variants against Core-298 on the same days (2025-01-10 → latest), gross per lot-day as the read-out
  defines it, paired difference with the same bootstrap; max drawdown; how many days and slots a new variant
  is picked. One replay with both arms added, and one each.
- **Reading (descriptive, in-sample):** "positive" = the 90 % interval above zero and the drawdown no deeper
  than the comparator's. A positive Q2 only allows proposing a pre-registered forward-only track; it does not
  change any live list.
- **Look-ahead check:** the strategy is chosen at entry from that minute's chain (engine rule); Adaptive's
  composite on day d uses results before d only (the existing replay code).
- **Hold-out:** none: every window was seen by the owner's sweep summary. Recorded as a known weakness.
- **Will not run:** other stop levels, other premiums, SENSEX, a selection among slots, a net-of-charges
  Adaptive replay beyond what the read-out already does.

### Phase 1 — POC run

- **Tasks:** strategy YAMLs and a runner in `packages/option-backtesting/research/bl126/`; Q1 and Q2 scripts;
  write `results/` (git-ignored) and a short JSON summary.
- **Done when:** the Log has Q1 and Q2 with intervals, drawdowns and pick counts, read under the rule above.

## Log

- 2026-10-18 — Created and Phase 0 registered before any run (owner chose the two settings).
- 2026-10-18 — POC run (exploratory, in-sample, no hold-out: every window was seen in the owner's BL-104 sweep
  summary). Rules exactly as registered above; no rule was changed. Code and a small JSON summary:
  `packages/option-backtesting/research/bl126/` (`bl126_poc_2026-10-18.json`; generated variants and results are
  git-ignored). Descriptive only; nothing is adopted and no list changes.

  **What was run.** 50 strategy files written by `gen_variants.py` from Core's `N_p100_<HHMM>` text: only the two
  legs' closest premium and stop-loss percent (and the strategy id) differ, checked by a parsed comparison and a line
  count. Ids `N_p10075_<HHMM>` (X1) and `N_p12060_<HHMM>` (X2): the family has to be `p` + digits for `is_wide` to be
  True, so `p100s75` could not be used. Simulated with the code path `obt rotation update` uses (`load_day` +
  `simulate_day`, same reference data, sizing date and row layout) over the 495 days Core's `N_p100` results exist
  (2024-10-09 to 2026-10-16, 2 of them weekend sessions), results written only under `research/bl126/results/`. The
  engine sets no per-order cost in these files, so net equals gross, as in the live store.

  **Parity (before trusting the path).** Core `N_p100_0917`, `N_p100_1202` and `N_p100_1517` simulated through this path
  against the stored live results: gross and net equal on 495 of 495 days for each of the three.

  **Q1, standalone, gross per lot-day (before charges; see the correction below), mean over the 25 slots, 495 days** (5-day circular blocks, 2,000 resamples, seed
  20261018, two-sided 90 %). Drawdown is the maximum fall of the cumulative slot-averaged series, per lot.

  | | Mean per lot-day | Arm minus Core | 90 % interval | Max drawdown | Slots with a positive difference | Reading |
  |---|---:|---:|---|---:|---:|---|
  | Core `N_p100` (SL 115 %) | +184 | | | -17,377 | | |
  | X1 (₹100, SL 75 %) | +225 | +41 | [-5, +89] | -18,365 | 20 of 25 | not positive (interval includes zero; drawdown deeper) |
  | X2 (₹120, SL 60 %) | +231 | +47 | [-18, +111] | -18,459 | 20 of 25 | not positive (interval includes zero; drawdown deeper) |

  Overall ₹2,500 stop fired on 16.3 % of Core variant-days, 13.8 % (X1) and 14.8 % (X2). Per slot, mean per lot-day
  and arm minus Core with a 90 % interval (descriptive; 25 slots looked at, no selection made):

  | Slot | Core | X1 | X1 minus Core | X2 | X2 minus Core |
  |---|---:|---:|---|---:|---|
  | 0917 | +282 | +289 | +7 [-150, +161] | +384 | +102 [-111, +308] |
  | 0932 | +267 | +273 | +6 [-138, +154] | +276 | +10 [-179, +209] |
  | 0947 | +180 | +351 | +171 [+34, +311] | +328 | +148 [-29, +328] |
  | 1002 | +226 | +275 | +49 [-97, +195] | +283 | +57 [-140, +256] |
  | 1017 | +202 | +333 | +131 [+1, +259] | +186 | -15 [-187, +161] |
  | 1032 | +191 | +317 | +126 [-1, +255] | +209 | +18 [-155, +195] |
  | 1047 | +225 | +245 | +20 [-103, +148] | +400 | +175 [+9, +344] |
  | 1102 | +96 | +255 | +159 [+27, +284] | +305 | +209 [+39, +382] |
  | 1117 | +95 | +205 | +111 [-12, +231] | +155 | +60 [-103, +231] |
  | 1132 | +116 | +135 | +19 [-93, +133] | +169 | +53 [-115, +223] |
  | 1147 | +106 | +118 | +11 [-103, +125] | +187 | +81 [-62, +235] |
  | 1202 | +206 | +144 | -62 [-158, +36] | +165 | -41 [-172, +88] |
  | 1217 | +215 | +134 | -82 [-190, +23] | +211 | -4 [-140, +134] |
  | 1232 | +165 | +256 | +90 [-5, +186] | +186 | +21 [-97, +136] |
  | 1247 | +165 | +224 | +59 [-35, +154] | +237 | +71 [-35, +181] |
  | 1302 | +185 | +220 | +35 [-54, +124] | +241 | +56 [-65, +178] |
  | 1317 | +223 | +196 | -27 [-118, +61] | +211 | -12 [-124, +100] |
  | 1332 | +172 | +234 | +62 [-9, +133] | +181 | +9 [-98, +115] |
  | 1347 | +223 | +259 | +36 [-30, +105] | +232 | +9 [-92, +112] |
  | 1402 | +195 | +273 | +78 [+2, +154] | +296 | +100 [-5, +204] |
  | 1417 | +257 | +261 | +4 [-51, +56] | +296 | +39 [-32, +106] |
  | 1432 | +209 | +245 | +36 [-9, +80] | +235 | +25 [-43, +91] |
  | 1447 | +201 | +196 | -4 [-45, +36] | +204 | +3 [-45, +53] |
  | 1502 | +93 | +108 | +15 [-0, +34] | +104 | +11 [-12, +38] |
  | 1517 | +99 | +84 | -15 [-35, +1] | +85 | -14 [-30, -2] |

  **Q2, Adaptive (list C, registered weights and lookbacks, no expiry rule), gross per lot-day, 428 days
  2025-01-10 to 2026-10-16, core + Buy picks.** Each replay is Core-298 plus the added variants against Core-298 alone on
  the same days (the Core replay reproduces the five recorded journal entries 12 to 16 Oct).

  | Added to the universe | Core-298 | With additions | Difference | 90 % interval | Max drawdown (Core / with) | Days a new variant was picked | New picks | Reading |
  |---|---:|---:|---:|---|---|---:|---:|---|
  | X1 + X2 (348) | +385 | +379 | -6 | [-71, +62] | -11,819 / -11,118 | 211 of 428 | 324 (X1 131, X2 193) | not positive (interval includes zero) |
  | X1 only (323) | +385 | +378 | -7 | [-48, +37] | -11,819 / -11,898 | 160 of 428 | 221 | not positive |
  | X2 only (323) | +385 | +408 | +23 | [-33, +81] | -11,819 / -8,478 | 161 of 428 | 239 | not positive (interval includes zero; drawdown shallower) |

  Slots where new variants were picked, both arms added (picks): 0917 53, 0932 37, 0947 38, 1002 25, 1017 24, 1032 19,
  1047 23, 1102 26, then 1 to 14 each from 1117 to 1517 (none at 1432, 1502). The ranking changes on more days than a new
  variant is picked (235 against 211 with both arms added) because the family-band criterion pools every Widesl in a
  band, so adding variants moves the pooled score. On the days a new variant was picked, the day's gross was +182 with
  both arms added against +187 without.

  **Read under the registered rule.** Neither arm is "positive" on Q1 or Q2: every 90 % interval includes zero, and
  on Q1 both arms' drawdown is deeper than Core's. Point estimates are higher standalone (about +40 to +50 per lot-day,
  20 of 25 slots) and mixed in Adaptive (X1 -7, X2 +23). Weaknesses as registered: in-sample, no hold-out, the window
  was seen in the BL-104 summaries, and the 25 slots overlap in time so their differences are not independent. Live
  store checked unchanged afterwards (journal checksum, 298 result files, newest modification time).
- 2026-10-18 — **Review corrections (Opus review on PR #244; no number changes, the reading stands).**
  - **Q1 is gross, not net.** Phase 0 asked for Q1 net of charges; the strategy files carry no per-order cost, so the
    engine's net equals gross. Departure from Phase 0 recorded here: the Q1 levels (+184 / +225 / +231) are before
    charges and cannot be read beside BL-098's after-charges figures. The arm-minus-Core differences hardly move with
    charges (each arm places the same four orders a day, no re-entry), so the reading is unchanged.
  - **Prior exposure was understated.** Besides the BL-104 summaries, BL-098 Phase 2 already tried 80 / 90 / 100 % leg
    stops on these NIFTY ₹100 files over the same window and ranked ₹100 at 80–90 % top in the 09:15–11:00 band
    (after charges). This POC's largest per-slot gains are in the same morning slots (0947–1102), so it repeats that
    look rather than confirming it; any forward track built on it must say so.
  - **"Live store unchanged" covers less than written.** The "before" fingerprint was taken after `simulate.py` and
    `parity.py` had run, so the pair covers `q2.py` only, and only `rotation/`. The review read every code path that
    touches the data root (reads only) and found today's fingerprint equal to the committed "after" one.
  - **Journal reproduction is not a committed check.** The Core replay matching the five journal entries (12–16 Oct)
    was checked during the run and again by the reviewer's script, not by `q2.py`.
  - `q2.py` now clears the reconstruction cache before each replay (the cache key did not include the universe; it
    did not affect this run).

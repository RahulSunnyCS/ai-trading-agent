# BL-154 — Adaptive: shrink the 09:16 fits by sample size, and two opening labels

| | |
|---|---|
| **Priority** | P2 — cheap to test from stored results, but the live read-out (60 days) comes first |
| **Status** | Done: killed |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-22 |
| **Depends on** | none to test; any live change waits for BL-058 / BL-113's 60-day read-outs |
| **TODO.md row** | 3.10.39 |

## Context

From the 2026-10-22 discussion of how to improve Adaptive (the same discussion started BL-022).

Adaptive (list C) scores each variant at 09:16 (`rotation/score.py`, `lists.py`). The criteria are:

| Criterion | Weight |
|---|---|
| Recent results | 15 |
| Weekday fit | 30 |
| Days-to-expiry fit | 30 |
| VIX-band fit | 20 |
| Family pooling | 5 |

A fit is the variant's average P&L on past days with the same label, over lookbacks of 5 / 21 / 63 /
126 sessions.

- **The fits look noisy.** They beat random picks on the 2022–24 hold-out, but a label shuffle did
  not show them to be real: 1 of 20 shuffles beat the true labels (`research/options/common/
  rotation-ranking.md`).
- **The samples are small.** In a 126-session lookback there are about 25 days per weekday, and fewer
  that share a days-to-expiry label or a VIX band. In the 21-session lookback there are about 4. An
  average over 4 days carries as much weight as one over 25.
- **Two facts are known at 09:15 that the ranking ignores:**
  - the opening gap;
  - the previous day's range. BL-110 found a lag-1 autocorrelation of 0.41 and 0.35 for the daily
    range.

## Goal

Find out whether a fit that trusts small samples less, and optionally two opening labels, picks
better than today's Adaptive on unseen days, under the label-shuffle control that the current fits
failed.

## Out of scope

- Any change to the live journal, T1 or the Telegram picks before the 60-day read-outs.
- Intraday information after 09:16 (BL-022).

## Plan

### Phase 0 — Pre-register (committed 2026-10-22, before any run)

Owner's choices (2026-10-22): **P1 decides**; shrink toward the **variant's own mean**; the rest
as proposed below.

- **Universe and replay:** list C (Adaptive) over Core-298, rebuilt day by day from the stored
  results under `TRADING_DATA_ROOT/rotation/results/` and `days.csv`, with the inputs
  `rotation.pick.load_history` / `score_history` use and `score.select` unchanged. Without the BL-122
  expiry rule (reconstructed history never applies it). Weekend sessions dropped as in the store. The
  baseline arm must reproduce `pick.score_history`'s list C picks on every replay day (parity check;
  any mismatch stops the run). `score.py` is never edited; the arms live in
  `packages/option-backtesting/research/bl154/`.
- **Arms** (list C's weights and lookbacks 5:30 / 21:25 / 63:25 / 126:20 unless stated):
  - **C0** — today's Adaptive (`score.skewed_fit`).
  - **S** — every fit shrunk, per lookback window: `(cnt × label mean + k × window mean) / (cnt + k)`,
    `k = 10`, where `cnt` is the number of days in the window with today's label and the window
    mean is the variant's mean over all days in that window. A window with no matching day is still
    left out and the window weights renormalised, as today, so only the shrinkage changes.
  - **SL** — S plus two opening labels, each a shrunk fit (k = 10) at weight 10 taken from weekday:
    recent 15 / weekday 10 / dte 30 / VIX 20 / gap 10 / prev-range 10 / family-band 5.
    - Per index (NIFTY, SENSEX; each variant uses its own index, as the DTE label), from the lake's
      1-minute index bars: daily open (09:15 bar open), high, low, close (last bar).
    - ATR%(d) = mean true range of the 14 sessions before d ÷ the previous close.
    - gap(d) = ln(open(d) ÷ previous close) ÷ ATR%(d), signed.
    - prev-range(d) = (high − low of the previous session) ÷ previous close ÷ ATR%(d).
    - Band = tercile (lo / mid / hi) against the 1/3 and 2/3 quantiles of the same quantity over the
      252 sessions before d. Everything is known by 09:16.
  - **M** (control, reported, not judged) — every fit replaced by the window mean (k = ∞, labels
    ignored). If M does as well as S, any gain from S is more "recent" leaking in, not better fits.
  - **Reported only, cannot change the verdict:** S at k = 5 and k = 20; S shrunk toward the family's
    same-label mean (the 12 BL-074 type × start-band cells) instead of the variant's own mean.
- **Measure:** gross per lot-day of the day's picks (core + Buy add-on, one lot each, the sum ÷ the
  number of picks: `daylog.list_block`'s `per_lot_day`); net after charges reported.
- **Periods:** **P1 = 2025-12-03 → 2026-10-08 decides.** P2 = 2025-01-10 → 2025-08-29 and the whole
  replayable span (2025-01-10 → the last stored day) reported. List C's weights were picked on
  2025-26 (BL-075), so P1 is in-sample for the baseline, which makes a pass harder, not easier.
- **Hypotheses and pass rule** (each judged on P1 alone, all three conditions):
  - **H1 (shrinkage): S vs C0.** H2 **(labels): SL vs S.**
  1. The 90% interval of the arm's minus the comparator's per lot-day, circular 5-day block
     bootstrap, 2,000 resamples, seed 20261022 (`readout.block_bootstrap_mean`), lies above zero.
  2. The arm's P1 total with the true labels is above all 20 label-shuffle runs of the same arm.
     A shuffle permutes the day-label rows (weekday, VIX band, DTE NIFTY / SENSEX, and for SL gap
     and prev-range NIFTY / SENSEX) together across every day of the replay, seeds 0..19, as BL-068;
     P&L untouched, so the recent criteria are unchanged. C0's shuffles reported beside them.
  3. The arm's max drawdown per lot is no more than 20% deeper than the comparator's.
  - SL vs C0 reported.
- **Look-ahead:** a day's composite reads only earlier rows' P&L; its own row contributes labels
  only. ATR and the tercile cut-offs use earlier sessions only; the open is the 09:15 bar's, known
  at the 09:16 pick. A shuffle moves labels across days, but each day still reads only earlier P&L.
- **Survivorship / selection:** Core-298 was chosen in BL-080 after seeing 2025-26; every arm uses
  the same universe, so it affects the level, not the comparison.
- **Data-snooping:** k = 10 and the label weights are fixed here, before any run; no k search, no
  weight search, no other labels. The fits are known to fail the shuffle (BL-068), which is why
  condition 2 is part of the rule. Tests counted: 2 judged (H1, H2), 5 reported.
- **Will not run:** other k, other weights, other labels, more than 20 shuffles, P2 or the whole span
  as the deciding period.
- **After a pass:** nothing changes live. A pass is a proposal for a shadow track (BL-113 pattern)
  after the BL-058 / BL-113 60-day read-outs, for the owner to decide.

### Phase 1 — Replay
- **Tasks:** replay list C with `rotation.pick.score_history`'s inputs and a modified `composite`,
  in a research folder. Never edit `score.py` for the test.
- **Done when:** a verdict is recorded against Phase 0.

### Result (2026-10-22): killed

`packages/option-backtesting/research/bl154/replay.py` (labels in `labels.py`, checks in
`test_bl154.py`); output `replay_2026-10-22.json` and `replay_daily_2026-10-22.csv` in that folder.
431 replay days, 2025-01-10 → 2026-10-22, Core-298, gross per lot-day. **Parity:** the C0 arm
reproduced `pick.score_history`'s list C picks and `score.composite` on all 431 days.

**P1 (decides, 202 days):**

| Test | Mean diff per lot-day | 90% interval | Shuffles beating the arm | Drawdown, arm vs comparator | Verdict |
|---|---|---|---|---|---|
| H1: S − C0 | −₹24 | [−₹116, +₹75] | 1 of 20 | −₹12,976 vs −₹10,688 (21% deeper) | **Fail** on all three |
| H2: SL − S | −₹20 | [−₹91, +₹48] | 2 of 20 | −₹11,778 vs −₹12,976 | **Fail** (interval, shuffles) |

**Per arm, ₹ per lot-day (gross; net after brokerage in brackets):**

| Arm | P1 | P2 (157 days) | Whole span |
|---|---|---|---|
| C0, today's Adaptive | 387 (283) | 344 (240) | 379 (275) |
| S, shrunk k = 10 | 363 (260) | 171 (67) | 308 (205) |
| SL, S + gap / prev-range | 343 (240) | 227 (124) | 330 (227) |
| M, window mean only (k = ∞) | 320 (218) | 186 (83) | 312 (210) |
| S at k = 5 / k = 20 | 397 / 331 | 196 / 190 | 326 / 300 |
| S toward the family's same-label mean | 351 | 277 | 325 |

**Reported, not deciding:**
- Shrinking costs money out of P1. S − C0 on P2 is −₹172 [−₹321, −₹38] and on the whole span
  −₹71 [−₹146, −₹1]: both intervals wholly below zero. Every shrunk variant is below C0 on P2 and
  the whole span; only k = 5 is above C0 on P1 (+₹10, [−₹79, +₹103]), with a 44% deeper drawdown.
- The pull goes the wrong way. M, which keeps only each variant's window mean, is the worst arm on
  P1. The more an arm leans on the variant's own mean (k = 5 → 10 → 20 → ∞), the lower P1 falls.
  So the small label samples carry something the plain mean does not.
- **New evidence about today's fits:** C0's true labels beat all 20 of its own shuffles on P2
  (₹53,934 vs a shuffle maximum of ₹51,366) and on the whole span (₹1,63,321 vs ₹1,45,304), and 17
  of 20 on P1 (BL-068 had 19 of 20 on P1, with an older universe and weights). That is the opposite
  of the worry behind this item: the fits look weakest in the period they were tuned on and
  strongest out of it.
- The opening labels: SL − S is +₹56 [−₹17, +₹130] on P2 and +₹22 [−₹24, +₹64] on the whole span:
  positive in both, but the intervals include zero and P1 is negative. Not shown real.

**Conclusion:** sample-size shrinkage of the fits does not help Adaptive and costs it out of
period. The gap and previous-range labels are not shown to add anything. Nothing goes to a shadow
track. Fit noise is not where Adaptive's weakness lies; if anything, the fits held up better than
BL-068 suggested.

## Risks

- Another tuned ranking, measured on the same 2 years the current one was built on. Only a forward
  shadow can settle it.

## Open questions

Answered 2026-10-22 (owner): 1. P1 (the recent period) decides; 2. shrink toward the variant's own
mean (the family's same-label mean is reported).

## Log

- 2026-10-22 — created from the owner's "how can we improve Adaptive" discussion, alongside
  starting BL-022. Not started.
- 2026-10-22 — started. Owner's answers recorded (P1 decides, the variant's own mean, the rest as
  proposed); Phase 0 committed before any run.
- 2026-10-22 — replayed (431 days, parity with `score_history` on every day). H1 and H2 both fail
  on P1; shrinkage is wholly negative on P2 and on the whole span. Killed. Implementation details
  not in Phase 0: an index session needs at least 300 one-minute bars (a Muhurat evening is not a
  session); the stored `net` equals `gross` (no costs stored), so the reported net uses
  `lot_plans`' brokerage (₹20 × 1.18 × 2 per trade).
- 2026-10-24 — review fix (PR #298), no rule changed: `labels.daily_ohlc` took each day's first bar
  as its open, but the lake has pre-open index bars (09:08–09:10) on 2026-09-07/08/09, sitting at the
  previous close; Phase 0 says the 09:15 bar. It now reads 09:15–15:29 in IST. Re-run over the same
  span (`replay.py --until 2026-10-22`: the shuffles permute every stored day, so a later day would
  move them): only SL moves. H2 is −₹20 [−₹91, +₹48] (was −₹19 [−₹90, +₹50]), 2 of 20 shuffles
  above it (was 1); still fails. H1, C0 and every S and M figure are unchanged.

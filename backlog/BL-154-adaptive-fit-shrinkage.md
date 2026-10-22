# BL-154 — Adaptive: shrink the 09:16 fits by sample size, and two opening labels

| | |
|---|---|
| **Priority** | P2 — cheap to test from stored results, but the live read-out (60 days) comes first |
| **Status** | Idea |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-22 |
| **Depends on** | none to test; any live change waits for BL-058 / BL-113's 60-day read-outs |
| **TODO.md row** | — (filled in when started) |

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

### Phase 0 — Pre-register (to be written when the item starts)
Proposed, to confirm with the owner:
- **Shrinkage:** each fit becomes `n / (n + k) × label mean + k / (n + k) × the variant's mean over
  the same lookback`. Here `n` is the number of days with that label and `k` is fixed in advance at
  10 (no k search).
- **Opening labels:** gap band (terciles of gap ÷ ATR on earlier days) and previous-day range band
  (terciles of the range ÷ ATR). Each is added as a fit at weight 10, taken from weekday.
- **Pass rule:** beat today's Adaptive replayed over the same days (₹ per lot-day, block bootstrap),
  and beat 20 label shuffles, on the period the owner chooses.

### Phase 1 — Replay
- **Tasks:** replay list C with `rotation.pick.score_history`'s inputs and a modified `composite`,
  in a research folder. Never edit `score.py` for the test.
- **Done when:** a verdict is recorded against Phase 0.

## Risks

- Another tuned ranking, measured on the same 2 years the current one was built on. Only a forward
  shadow can settle it.

## Open questions

1. Which period decides (the owner chose "recent decides" for BL-022)?
2. Shrink toward the variant's own mean, or toward its family's mean?

## Log

- 2026-10-22 — created from the owner's "how can we improve Adaptive" discussion, alongside
  starting BL-022. Not started.

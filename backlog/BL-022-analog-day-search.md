# BL-022 — "Days like today": analog-day search for intraday options

| | |
|---|---|
| **Priority** | P1 — owner wants it in week 3 of the October plan; still needs BL-009's clean data first |
| **Status** | In progress |
| **Type** | research |
| **Area** | options (+ trading-data, dashboard) |
| **Created** | 2026-10-06 |
| **Depends on** | BL-009 Phase 2 (vendor 1-minute history ingested) — met: NIFTY index 1-minute from 2015-01, India VIX from 2015-04, SENSEX from 2018-03; BL-015 (pre-registration) |
| **TODO.md row** | 3.10.37 |

## Context

The owner's idea (2026-10-06): traders read how the market is moving and anticipate what comes
next, a bit like an LLM predicting the next token from similar past contexts. Describe each day
as a vector; when a similar day comes, show what happened on the most similar past days, using
price, India VIX and other context.

Assessment from the same discussion:

- This is a known technique (analog or nearest-neighbour forecasting). It fits an option
  seller: predicting the rest-of-day *range* (volatility) is far more tractable than direction.
- The LLM comparison breaks down: about 2,400 NIFTY sessions, non-stationary rules (expiry
  weekdays, lot sizes, SEBI changes), and patterns that get traded away. An LLM should be the
  interface ("show me days like today and summarise"), via the existing `obt-mcp` server, not
  the predictor.
- Options Lab already has day forensics, day anatomy and market regimes to build on.

**2026-10-22 — pointed at Adaptive's late picks.** The owner asked how to improve Adaptive using
what today has done so far: "if 09–10 went up 1%, 10–11 down 1% and 11–12 is flat, and that
happened before, we can predict what comes next". Two findings shape the item:

- Adaptive (list C) ranks once at 09:16 on past results and calendar / VIX labels and never looks
  again. Of the 24 live picks from 2026-10-12 to 2026-10-22, about 18 start at 11:17 or later
  (11:17, 12:02, 13:02, 13:17, 13:47), so hours of today are known before most picks enter.
- The prior is weak. BL-081 asked nearly this question with 14 state variables at 10:30–13:30
  and nothing passed (0 of 252 swap / drop versions kept); BL-053 and BL-083 found nothing either
  (`research/options/common/intraday-state.md`). What is new here is the model: whole-path
  similarity to earlier days rather than single-variable thresholds. BL-110 found that range
  persists and that a narrow opening range leads to a quieter rest of the day, which is the effect
  this could sharpen for short-premium picks.

Claude's estimate given to the owner before Phase 0: about a 1-in-4 chance that the analog range
forecast clearly beats the simple baselines, and about 1-in-10 that the skip / swap rule passes
and then holds forward. Worth running because the gate stops it after the first step, and the
"20 days like today" view is useful to look at whatever the result.

**How shapes are compared** (owner asked whether this needs a vector database or embeddings): the
day *is* a vector — a hand-made one (the path since the open plus a few context numbers). About
2,900 days of about 16 numbers each is searched by brute force in milliseconds, so no vector
database. Learned embeddings or time-series foundation models (Chronos, TimesFM) come only if this
v0 shows something: with a few thousand days they tend to memorise noise and cannot say why two
days match. Text ("semantic") embeddings are for words, not price paths.

## Goal

At 10:30, 11:00 and 12:00, find the 20 earlier sessions most like today so far and (1) test whether
their rest-of-day range predicts today's better than simple baselines; if it does, (2) test whether
skipping or swapping Adaptive's not-yet-started picks on that basis would have made money after
charges, against random controls.

## Out of scope

- Learned embeddings or time-series foundation models until v0 shows something.
- Predicting direction.
- Using it as a live trade signal. A pass leads to a forward shadow track (BL-113 pattern), never
  straight to the live journal, AlgoTest or Quantiply.
- Changing Adaptive's 09:16 ranking (that is BL-154).

## Plan

### Phase 0 — Pre-register (committed 2026-10-22, before any run)

Owner's choices (2026-10-22): check times 10:30, 11:00, 12:00; the action is skip, or swap to what
the heatmap says worked on the similar days; live Adaptive decides and T1 is reported; **the recent
period decides** (2022–24 reported only). Everything else below is Claude's proposal, accepted with
the plan.

- **Hypothesis:**
  - **H1 (gate):** at a check time T, the mean rest-of-day range of the 20 nearest earlier days
    ranks today's rest-of-day range better than each baseline below.
  - **H2 (replay):** skipping or swapping Adaptive's pending picks from those neighbours beats the
    untouched picks after charges, and beats the same rule with random neighbours and random
    skips / swaps at the same rates.
- **Universe:**
  - H1: NIFTY sessions (decides) and SENSEX sessions (reported) from the 1-minute index bars in the
    lake (`bars_1m/asset=index`).
  - H2: Adaptive (list C) over Core-298, reconstructed day by day with `rotation.pick.score_history`
    from the stored results before each day, without the BL-122 expiry rule (reconstructed history
    never applies it). A pick is "pending at T" when its entry is at least 15 minutes after T. T1
    (Core-298 + `strategies/rotation_t1/`) is reported, not judged.
- **Day vector at T** (all from bars stamped before T, so complete at T):
  - **Path:** the index's close at every 15 minutes from 09:30 up to T, as ln(close ÷ 09:15 open)
    ÷ ATR%. That is 5 points at 10:30, 7 at 11:00, 11 at 12:00. ATR% = the mean true range of the
    previous 14 completed sessions ÷ the previous close.
  - **Context:** gap = ln(09:15 open ÷ previous close) ÷ ATR%; range so far = (high − low since
    09:15) ÷ 09:15 open ÷ ATR%; India VIX at T; ln(VIX at T ÷ VIX 09:15 open); weekdays to the
    index's nearest expiry, capped at 7.
  - Each feature is z-scored with the mean and standard deviation of the pool (earlier days only)
    and weighted equally.
- **Neighbours:**
  - The 20 nearest earlier days by Euclidean distance (**primary**).
  - Dynamic time warping on the path block (window ±1 step) plus Euclidean on the context block
    (**second variant**, counted in the same family).
  - H1 pool: every earlier session with VIX data (NIFTY from 2015-04), with at least 250 in the pool.
  - H2 pool: every earlier session that has the pick's stored result and the heatmap row (stored
    results start 2024-10-09), with at least 120 in the pool.
- **Outcome:** rest-of-day range = (highest high − lowest low over bars from T to 15:14) ÷ the close
  just before T.
- **H1 baselines,** each a forecast of the same outcome:
  - (a) VIX-implied: VIX at T ÷ 100 × √(minutes left ÷ (375 × 252));
  - (b) BL-110 opening range: range so far ÷ the mean range so far at the same T over the previous
    20 sessions, times the mean rest-of-day range of those 20 sessions;
  - (c) persistence: the mean rest-of-day range of the previous 20 sessions;
  - (d) random neighbours: 20 random earlier days from the same pool, 200 draws.
- **H2 rule, per pending pick:**
  - **Candidates:** four heatmap cells (`TRADING_DATA_ROOT/heatmap/<index>.parquet`, short ATM
    straddle, per-leg SL **100%**, exit **15:15**). Their entries are the first four heatmap times
    at or after T + 15 minutes; the grid has an entry every 30 minutes from 09:45 to 14:45, so at
    12:00 the cells are 12:15, 12:45, 13:15 and 13:45. Few options on purpose: choosing the best
    of about 280 cells from 20 noisy days would mostly pick luck. SL 100% is the grid's widest stop,
    closest to the live Widesl's 115%.
  - **Means:** m_pick = the pick's mean net P&L on the 20 neighbours; m_cell = the best of the four
    cells' means on the same days.
  - **Decision:** if both m_pick and m_cell are ≤ 0, **skip**. Otherwise, if m_cell > m_pick,
    **swap** to that cell at the same lots. Otherwise **keep**.
- **Money:**
  - Per lot, gross from the stored results and from the heatmap's points × today's lot size, as the
    rotation store does.
  - Charges: brokerage ₹20 + 18% GST per order, 2 orders per trade (as BL-135's `lot_plans`). A
    straddle counts as 2 trades.
  - STT and exchange fees are left out: the stored results carry no premium. This understates what
    a skip saves. Gross is reported too.
- **Look-ahead check:**
  - Features read only bars stamped before T and sessions before the day.
  - Pools hold only earlier days, and z-scores use pool statistics only.
  - A unit test perturbs every bar at or after T, and every later day, and asserts that the features
    and the chosen neighbours do not change.
  - Picks come from `score_history` over earlier results only.
- **Pass / kill rule:**
  - **Family:** 3 check times × 2 distance variants = 6 tests per hypothesis. Holm at a one-sided
    5% across the 6. Block bootstrap: 5-session blocks, 2,000 resamples.
  - **H1 passes at a (T, variant)** when Spearman(analog forecast, realised) minus Spearman(baseline,
    realised) has a 90% bootstrap lower bound above 0 for each of (a), (b) and (c), and the analog's
    Spearman is above the 95th percentile of (d). Judged on NIFTY, 2025-01-01 → 2026-10-21.
  - **If no (T, variant) passes after Holm, H2 is not run** and the item closes negative.
  - **H2 passes at a (T, variant) that passed H1** when the mean daily Δ (rule − untouched, ₹ per
    lot, net; 0 on days the rule changes nothing) has a 90% block-bootstrap lower bound above 0 after
    Holm, and Δ is above the 95th percentile of both controls (200 draws each):
    - random-day neighbours, the same rule;
    - random skips / swaps at the rule's own rates on the same days.
  - Judged on Core-298 Adaptive, 2025-04-01 → 2026-10-21. The pool needs at least 120 earlier days,
    which the store reaches around then.
  - A pass means a forward shadow track, read at 60 forward days. It never means a live change.
- **Hold-out:** none unseen. The owner chose the recent period as the decider. 2022-01 → 2024-12 is
  reported for H1 (NIFTY), and for H2 only if BL-081's 2022–24 per-variant results can be reused.
  Otherwise that part is written down as not run.
- **Will not run:** any k other than 20; other stops, exits or more cells; other check times;
  direction targets; learned embeddings; the BL-122 rule inside the replay. Running one needs
  `override: <reason>` in the Log.

### Phase 1 — Day features up to the cut-off
- **Tasks:** `packages/option-backtesting/research/bl022/features.py`. Use 1-minute index and VIX
  grids (reuse `research/bl081/state.py`'s `_con` / `load_grid` pattern) and the day vector above per
  (index, day, T). Add the look-ahead unit test.
- **Done when:** a feature table exists for every session from 2015-04, and the look-ahead test
  passes.

### Phase 2 — H1: does the analog forecast beat the baselines? (gate)
- **Tasks:** `research/bl022/forecast.py`. Find neighbours (both variants), the three baselines, 200
  random draws, Spearman differences with the block bootstrap, and Holm. Spot-check one day: list
  its 20 neighbours and overlay their paths.
- **Done when:** a pass or fail per (T, variant) is recorded here. On a fail, go to Phase 5.

### Phase 3 — H2: skip / swap replay on Adaptive's pending picks
- **Tasks:** `research/bl022/replay.py`. Reconstruct list C per day with `score_history`, read pick
  results from `rotation/results/` and heatmap cells, apply the rule, run both controls, and report T1
  alongside.
- **Done when:** a pass or fail per (T, variant) is recorded here.

### Phase 4 — Show it (whatever Phase 2 says)
- **Tasks:** Options Lab view of the 20 nearest days: rest-of-day charts overlaid, outcome
  distribution; an MCP tool `similar_days`.
- **Done when:** usable for research; labelled "not a signal" if Phase 2 failed. Not part of the
  2026-10-22 POC; offered after it.

### Phase 5 — Write-up
- **Tasks:** Result section and Log here, `INDEX.md` and `TODO.md` rows, and
  `research/options/common/intraday-state.md` (a row per hypothesis).
- **Done when:** merged with a code-review result on the PR.

## Risks

- Look-ahead: any feature that reads past the cut-off, or an analog pool that includes later
  days, makes the test meaningless.
- Rule changes make old days incomparable; test whether pre-2020 days help or add noise.
- H2's pool is small (stored results start 2024-10), so the neighbours are drawn from about
  120–500 days, not 2,900. A fail there may be the pool, not the idea; it is written down either
  way.
- The recent period alone decides (owner's choice), which roughly doubles the chance of a lucky
  pass compared with needing both periods. Hence the forward shadow before anything live.

## Open questions

1. ~~Cut-off times~~ — **answered 2026-10-22:** 10:30, 11:00, 12:00 (owner), judged together with
   Holm. Superseded proposal (30-minute grid 09:45 → 15:00, 12:30 primary) kept in the Log.
2. ~~Is the India VIX 1-minute series complete in the vendor data?~~ — The lake's VIX starts
   2015-04-01. Phase 1 counts the sessions without a VIX bar at T and drops them (reported).

## Log

- 2026-10-06 — created from the owner's idea and the discussion of it.
- 2026-10-06 — owner: make it generic over the time of day (e.g. every 30 minutes, including a
  first-half → second-half prediction) rather than one fixed cut-off; grid to be discussed.
- 2026-10-06 — owner decisions on PR #27: raised to P1.
- 2026-10-06 — owner delegated the remaining open questions to Claude's recommendations: proposed default for the cut-off grid recorded (30-minute grid, 12:30 primary, Holm
  correction); still to confirm in discussion when the item starts, as the owner asked.
- 2026-10-22 — started (owner: "Backlog + start POC"), aimed at Adaptive's late picks. Owner's
  answers:
  - check times 10:30, 11:00, 12:00, replacing the 30-minute grid;
  - action: skip the pick, or swap to what the heatmap says worked on the similar days;
  - lists: live Adaptive decides, T1 reported;
  - pass rule: **the recent period decides**, 2022–24 reported only;
  - shapes are compared as hand-made vectors, with no vector database or embeddings in v0.

  Phase 0 committed before any run. The ETA given was about 4 working days, with the gate's answer
  after about 1.

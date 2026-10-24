# BL-161 — Favourites: rank-sum and Blend instead of voladj, and a same-Friday fill

| | |
|---|---|
| **Priority** | P1 — the owner starts trading Friday 14:30–14:45 from 2026-10-10 and wants to know whether the delay and the score matter before then |
| **Status** | Done |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-09 |
| **Depends on** | none; informed BL-086 (voladj reading the lookbacks; written as BL-055 when this was run) and BL-010 E13 (Monday fill) |
| **TODO.md row** | 3.13.10 (added when the result reached `main`) |

## Context

Owner, 2026-10-09: 11 of the 14 favourite configs (all Broad Momentum) use the `voladj` score,
2 use `blend` and 1 uses `ranksum`, and the owner suspects the other scores do better. All 14 use
`signal_delay=1`: the ranking from week t is traded at week t+1's close, a week after the signal.
From 2026-10-10 the owner plans to trade on the signal Friday itself, around 14:30–14:45 IST. The
question is what changing only those two settings does to each favourite.

Things found while setting this up:

- `voladj` reads neither the lookbacks nor the weights (`engine.py` → `_compute_ranks_voladj`:
  a fixed 26/52-week return over 26-week volatility). So the voladj favourites differ only in their
  other settings. Under `ranksum` their saved lookbacks and weights apply **for the first time**, so
  the rank-sum and Blend runs are configs nobody tuned. BL-086 (written as BL-055 on the day of this
  run) is the item that changed voladj itself; it was killed on 2026-10-09.
- The favourites were chosen while they ran voladj, so their other settings suit voladj. A voladj
  win here says little; a rank-sum or Blend win against that head start says more.
- `signal_delay=0` fills at the **close of the same Friday the ranking uses**. Broad's Friday stock
  data arrives at 19:30 IST, so a fill at that close cannot really be made (BL-010 E13: about 1 pt of
  CAGR more optimistic than a Monday-open fill). A 14:30 trade uses a 14:30 ranking and a 14:30–14:45
  price; the weekly data has neither, so the Friday close stands in for both. Delay 0 is therefore
  a proxy for the planned Friday trade, not a measure of it.

## Plan

### Phase 0 — Pre-register (committed before any run)

### 2026-10-09 — Favourites × score × signal delay
- **Hypothesis:** (a) with every other saved setting unchanged, `ranksum` or `blend` gives the
  favourites a better Martin ratio (CAGR ÷ Ulcer index) than their `voladj`; (b) trading on the
  signal Friday (`signal_delay=0`) instead of a week later (`signal_delay=1`) changes CAGR by
  more than 1 pt.
- **Universe:** the 14 individual favourite configs as saved on 2026-10-09 (the "Phase 6 ensemble"
  group adds no config of its own: its four members are in the 14). Broad Momentum's point-in-time
  turnover-ranked universe, as each config already specifies. Each config runs 6 ways: score
  ∈ {voladj, ranksum, blend} × signal_delay ∈ {1, 0}; nothing else changes. 84 runs, including the
  14 controls (saved score, delay 1). All 84 count as trials against any later claim of an edge.
- **Look-ahead check:** delay 1 is the timing BL-010 verified (rank at t from closes ≤ t, fill at
  t+1). Delay 0 fills at the close of the ranking week, which cannot be traded; it is labelled an
  upper bound in every table, never quoted as achievable. The controls must reproduce each saved
  favourite's CAGR within 0.5 pt; a miss is reported as data drift before any comparison is read.
- **Metrics:** Martin ratio (primary, as BL-010 Phase 4 chooses), CAGR, excess CAGR over the
  config's benchmark, max drawdown, Ulcer index, CDaR-95 (mean of the worst 5% of weekly drawdowns),
  Sharpe. Window: each config's own (start 2017-01-01, through the latest data).
- **Pass / kill rule:**
  - (a) A score "beats voladj" if, at delay 1, the median Δ Martin across the 11 voladj favourites
    is > 0 **and** Martin improves on ≥ 8 of the 11 (one-sided sign test p ≈ 0.11 if independent,
    which they are not: shared universe and years, so this is a screen, not proof) **and** the
    median Δ max drawdown is no worse than −3 pts. Otherwise "no evidence it beats voladj". The 3 blend/rank-sum favourites are
    reported the same way, outside the rule.
  - (b) Delay "matters" if the median |Δ CAGR| (delay 0 − delay 1) across all 14 at their saved
    score is > 1 pt (the BL-010 E13 threshold). Reported with the sign: a positive Δ is mostly the
    untradable close fill plus the week saved.
  - Neither result changes a favourite. A config change goes through BL-010 / BL-055 and the
    live-money rules (BL-025).
- **Hold-out:** BL-010's 2012-01-01 → 2016-12-31 stays unread; every run starts 2017-01-01 as
  the favourites do.
- **Will not run:** any other setting change, any lookback or weight search, a Monday-open or
  intraday fill (not built; BL-010 E13), the hold-out, or a re-pick of favourites from these results.
- **Result:** (2026-10-09, 84 runs, no errors; every control reproduced its saved CAGR within
  0.5 pt; code at the pre-registration commit (b5de3c0 on the local branch it was written on), data as of
  2026-10-09, windows 2017-01-06 → 2026-10-02; rows in
  `packages/momentum-backtesting/search_spaces/bl161_results.jsonl`, rule applied by
  `scripts/bl161_report.py` → `bl161_summary.json`; the runner is
  `scripts/bl161_favourites_score_delay.py`)
  - **(a) Kill — no evidence rank-sum or Blend beats voladj.** Over the 11 voladj favourites at
    delay 1: rank-sum Martin improved on 1 of 11 (median Δ Martin −2.08, Δ max DD −6.9 pts,
    Δ CAGR −8.0 pts); Blend on 2 of 11 (median Δ Martin −1.20, Δ max DD −5.7 pts, Δ CAGR −4.1 pts).
    Medians across all 14 at delay 1: voladj 40.5% CAGR / −31.3% max DD / Martin 3.75; Blend
    36.9% / −38.4% / 2.92; rank-sum 33.8% / −41.4% / 2.06. Voladj's lead is mostly shallower,
    shorter drawdowns. Caveat as registered: these configs were chosen under voladj.
  - **(b) Delay matters, but in no fixed direction.** Median |Δ CAGR| (delay 0 − delay 1, saved
    score) 3.4 pts > 1 pt; signed median −1.1 pts. 8 of 14 are worse at delay 0 on each of CAGR, max DD,
    Martin and Sharpe (5 of them on all four); the spread runs from −7.1 pts (Five Sectors Monthly) to +6.9 pts
    (Four Sectors, Four Lookbacks). A one-week shift moving single configs by ±7 pts says each
    favourite's own CAGR is timing luck to within several points — the reason BL-010 Phase 6
    averages rebalance phases. Delay 0 also carries the untradable Friday-close fill (E13).

## Log

- 2026-10-09 — created and pre-registered at the owner's request; run overnight, report the
  next morning.
- 2026-10-09 — run and result recorded (both rules above). Neither changes a favourite. Follow-ups:
  BL-086 (voladj on the owner's lookbacks, then numbered BL-055); the Friday 14:30 trade should be
  judged on the journal's live fills, not on delay 0.
- 2026-10-24 — renumbered from BL-056 to BL-161 and ported to `main` (research-only; the
  pre-registration and result are unchanged). BL-056 on `main` is the options weekday / days-to-
  expiry / VIX breakdown, and the owner decided on 2026-10-10 (BL-087 Log) that this item takes a new
  number when pushed. The scripts and result files were renamed `bl056_*` → `bl161_*`; their
  contents are unchanged except the item number in the docstrings. The report script re-run on the
  stored rows reproduces `bl161_summary.json` value for value (the file was reformatted by Biome, as the pre-push hook requires; same values). The Monday-open half of the question
  (a real fill after the signal Friday) is BL-158 (open in PR #304 when this was ported). The
  Phase 0 text above is kept verbatim, so its "BL-055" is today's BL-086.

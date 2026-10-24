# BL-156 — Momentum: test the followed group at Monday's open, switch only if it passes

| | |
|---|---|
| **Priority** | P1 — decides how the real Kite money is traded; nothing changes until the test passes |
| **Status** | Done: killed 2026-10-24 (Phase 1 failed 3 of 5 rules); the followed group stays as it is |
| **Type** | research |
| **Area** | momentum (+ scheduler and dashboard if it passes) |
| **Created** | 2026-10-24 |
| **Depends on** | BL-036 Phase 2 (`execution="mon_open"`), BL-087 (all-Fridays split), BL-142 (Kite lots), BL-025 (live rules) |
| **TODO.md row** | 3.37 |

## Context

The followed strategy, "Four Sectors Monthly, No Tilt · all Fridays" (`search_spaces/bl142_followed.json`),
trades with a one-week signal delay at Friday's close. Its 14:15 orders are placed before the close
because the decision is fixed by last Friday's ranks.

On 2026-10-24 the owner asked what it returns at Monday's open. Monday-open fills need signal delay 0:
the ranks of Friday's own close, filled at the next session's open. One full-period run (2017 to
2026-10-23, pre-tax) gave 42.4% as followed against 44.0% at Monday's open, with a drawdown of -36.9%
against -27.1% and a lower Sharpe (1.25 against 1.31). Earlier, over 28 rolling windows, a one-week
delay beat delay 0 by about 4 points on another Broad config (TODO 3.9.23). The owner asked to switch,
then chose to test first. The same day showed that a 14:15 plan can differ from the close
(ACMESOLAR planned, THELEELA at the final), which a Friday-evening plan would avoid.

## Goal

A pre-registered yes or no on following arm C (delay 0, Monday open) instead of arm A (as followed).
If yes, the followed strategy, orders routine and every Kite lot move to it.

## Out of scope

Re-tuning any other setting at delay 0; Stock and Custom Index (they have no Monday fill, BL-036 Phase
2b); placing orders (the repo stays read-only toward Kite).

## Plan

### Phase 0 — Pre-register
Committed before any run; the numbers are in `packages/momentum-backtesting/search_spaces/bl156_criteria.json`,
which the runner reads and never restates.
- **Hypothesis:** the followed group filled at Monday's open with signal delay 0 (arm C) beats it as
  followed (arm A) on return without a materially deeper fall, in most 3-year windows.
- **Universe:** the followed config's own: Broad, `turnover_rank` point-in-time universe (BL-036
  Phase 1, delisted stocks included), curated category tags, four sleeves on staggered Fridays.
- **Look-ahead check:** arm C ranks on Friday's close and fills at the next session's open
  (`monday_fills.py`: the weekly adjusted close times one plus the session's `open_gap`), after the
  decision. The circuit masks are aligned to the Monday session (`lock_masks(session="first")`).
  Before the windows run, `tests/golden/test_lookahead.py` and the golden Monday-open scenario must
  pass on the code that runs them. Category tags are today's classification for every year (BL-074);
  that applies to both arms alike.
- **Pass / kill rule:** all five rules of `bl156_criteria.json` against arm A: C wins CAGR and Sharpe
  in more than half the windows; median CAGR gap at least +1.0 point; median drawdown at most 3.0
  points deeper; deepest window at most 5.0 points deeper; full-period after-tax CAGR not lower. Any
  miss is a kill. Arm B (delay 0, Friday close) is reported only.
- **Hold-out:** none unseen. 2017 to 2026-10-23 was used by the BL-010 search that chose this
  config, and its 2012–2016 backcast was a one-shot already spent. Already seen: the three
  full-period results above. Not seen: every rolling-window and after-tax result. The config was
  chosen at delay 1, which favours arm A, so the test leans toward not switching. If C passes, arm
  A is recorded forward beside it each Friday and read at 13 weeks (Phase 3), informative only.
- **Will not run:** re-tuning at delay 0; `mon_10am`; delay 2+; Stock or Custom Index; a second set of
  thresholds after the result. Running one needs `override: <reason>` in the Log.

### Phase 1 — Run the test
- **Tasks:** `scripts/bl156_monday_open.py` reads `bl156_criteria.json`, runs arms A, B and C over the
  rolling windows (`sweep.rerun_windows`, `compare_rolling` against A) and the full period after tax,
  writes the windows table and the verdict under `data/research/bl156/` (git-ignored) with the data
  version and code commit.
- **Deliverables:** the verdict with every rule's number in the Log; `research/momentum/common/execution.md`
  updated with the result (and its stale "no Monday-open option" line).
- **Done when:** the Log records pass or kill with the run's data version, and the research page cites it.

### Phase 2 — Switch (only if Phase 1 passes)
- **Tasks:**
  - A new followed file `search_spaces/bl156_followed.json` (the four sleeves at delay 0, `mon_open`),
    named in `live_rules.toml`; `bl142_followed.json` stays as written.
  - The four sleeves re-saved with the new settings, grouped, made the headline; the old group kept.
  - Orders on Friday evening from Friday's final data and that evening's Kite snapshot, sent on
    Telegram as orders to place as AMOs for Monday's open (owner, 2026-10-24); the 14:15 job no longer
    plans for this group. Kite read-only, as now.
  - Every Kite lot realigned to the new rule on the first Friday-evening run after the switch (owner,
    2026-10-24): one plan for all four lots, booked through the lot ledger.
  - This week, Your orders, the Guide pages and `technical.md` updated.
- **Done when:** a Friday-evening run sends the four lots' orders for Monday, the ledger books Monday's
  fills against them, and the live rules read the new followed file.

### Phase 3 — Forward read-out (only if switched)
- **Tasks:** record arm A's signal beside the followed one each Friday; after 13 weeks compare.
- **Done when:** the 13-week comparison is in the Log. Informative: it does not undo the switch alone.

## Risks

- **The Friday 19:30 run misses while the laptop sleeps** (it ran Saturday 10:06 on 2026-10-24, after the
  Kite token had died at 06:00). A Monday-open plan then needs a Kite read before Monday's open: Phase 2
  must plan from the Friday 14:15 snapshot or a Monday-morning Kite login when the evening read is missing.
- NSE's stock sync fails often (the Fyers fallback covers it, `packages/momentum-backtesting/CLAUDE.md`).
- A market AMO fills at the opening auction price, which can gap from the modelled open; a stock locked
  at the open does not fill.

## Open questions

Answered 2026-10-24 (owner): test first, then switch only on a pass; orders made Friday after 19:30 and
placed as AMOs for Monday's open; on a pass, realign all lots at once.

## Log

- 2026-10-24 — created; Phase 0 written with `bl156_criteria.json`, awaiting the owner's approval.
- 2026-10-24 — owner approved Phase 0 as written; committed (5eebb4ec) before any run. Look-ahead
  gate passed on commit 9f579d4c: `test_lookahead.py` (12 cuts, Broad among them, at Friday close)
  and the golden `broad_monday_open` scenario. The runner `scripts/bl156_monday_open.py` was
  committed before it ran.
- 2026-10-24 — **Phase 1: killed.** 28 rolling 3-year windows (2017-01-06 to 2026-09-25), code
  9f579d4c, criteria sha256 b393cc5e…, data through 2026-10-23; output in
  `data/research/bl156/verdict.json` (git-ignored). C against A:

  | Rule | Needs | C vs A | Holds |
  |---|---|---|---|
  | wins_most | CAGR and Sharpe better in > 14 of 28 | 5 of 28 | no |
  | median_cagr | ≥ +1.0 pt | +1.12 pts | yes |
  | median_drawdown | ≥ −3.0 pts | −3.34 pts | no |
  | worst_drawdown | ≥ −5.0 pts | −11.26 pts | no |
  | after_tax | ≥ 0 | +1.28 pts (A 32.54%, C 33.82%, full period, slab 30%) | yes |

  Medians over the windows: A 51.1% CAGR / 1.47 Sharpe / −26.4% max drawdown; C 52.2% / 1.38 /
  −26.6%; B (reference, delay 0 at Friday close) 54.0% / 1.52 / −25.2%. C's CAGR was higher in 61%
  of windows, its Sharpe in 18%. Most of the gain is dropping the delay (B); filling at Monday's open
  gives most of it back as volatility and a deeper worst fall. The followed group stays at delay 1,
  Friday close; Phases 2 and 3 are dropped. Arm B is not a candidate (no one can trade the close
  the ranks are made on); any test of it is a new pre-registered item.
- 2026-10-24 — runner fixes between the first and the reported run, no rule changed: `_run_broad`
  ignores `req.tax` (tax reaches a Broad run only through its `tax=` argument, BL-116), so the first
  run's after-tax figures were pre-tax; and the verdict's numpy booleans did not print. The re-run
  gave every window figure identical to the first, and the after-tax rule its real numbers. The
  dashboard offers no tax switch for Broad ("Costs & timing"), so no screen is affected.
- 2026-10-24 — review notes (PR #304), no rule or result changed. `wins_most` reads two ways: the
  runner counts windows where C beats A on CAGR and Sharpe at once; `compare_rolling`'s "wins most",
  which the rule cites, needs each win share above half on its own. Both say no (CAGR 61%, Sharpe 18%
  of windows). The criteria file's `written_before_running` (13:30 IST) is wrong: the file was
  committed in 5eebb4ec at 11:59 IST, before the runner and the 12:21 run; the file stays as written.

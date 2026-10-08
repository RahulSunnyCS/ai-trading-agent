# BL-050 handoff — Momentum filter POC

There are two prompts below. Paste one into a fresh Claude Code session on `ai-trading-agent`:

- **Prompt A (planning)** — use first. It starts BL-050, answers the open questions with you, and
  commits the pre-registration. It runs no backtests.
- **Prompt B (working)** — use after A is merged. It builds the features and runs the phases,
  stopping after each one for your review.

The plan itself lives in `backlog/BL-050-momentum-filter-poc.md`. The prompts point to that file
rather than repeating it.

## Where to run each step

The research data (`TRADING_DATA_ROOT`: the stock bars and the catalog) lives only on the owner's
laptop. A cloud session gets a fresh clone with no data.

| Step | Cloud session | Local session (laptop) |
|---|---|---|
| Prompt A (planning, criteria file) | Yes, since it only reads code and writes docs/JSON | Yes |
| Prompt B, Phase 1 (features, hooks, tests) | Yes, since the tests run on golden-fixture data | Yes |
| Prompt B, Phases 2–3 (screen, engine test) | No data | **Required**. Mount the data first (`uv run tdata mount`) |
| Prompt B, Phase 4 (weekly shadow arm) | No | **Required**, through the scheduler |

---

## Prompt A — Planning session

~~~text
Start BL-050 (backlog/BL-050-momentum-filter-poc.md) in ai-trading-agent. This is a PLANNING
session: no backtests, no feature code, no runs of any kind.

Background (already decided by me, 2026-10-07):
- Scope is Broad Momentum (stocks) only, on the point-in-time turnover_rank universe. No ETF track.
- Fundamentals are out of scope. No data spike.
- No clean unseen backtest window is left (BL-010's 2012–16 hold-out is spent; the frozen configs
  saw data through 2026-10). Backtests only rank candidates. Forward shadow tracking in the
  journal (BL-024) is the deciding test.
- The comparator is the BL-010 Phase 6 frozen ensemble
  (packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json). It must not change.
- Paper trading of that ensemble starts 2026-10-09 (BL-025). The Friday signal, saved
  favourites and goldens stay byte-identical.

Do this, in order:
1. Read CLAUDE.md (root, especially the Research gate), backlog/README.md, backlog/_TEMPLATE.md,
   backlog/_EXPERIMENT.md, BL-015, and BL-050 in full.
2. Read the code BL-050 touches:
   - packages/momentum-backtesting/src/momentum_backtesting/levers.py
   - categories/broad.py (run_broad_backtest: extra_no_buy, stock_tilt, stock_tilt_ranks)
   - categories/liquidity.py (turnover_rank_members_by_year)
   - reference_benchmarks.py (NIFTY500_TRI)
   - reversal.py (the up/down-week volume rule V2 reuses)
   - choose.py (ensemble_curve)
   - patterns/ (the BL-042 event study and ranking test)
   - stocks/schemas.py (DAILY_SCHEMA: volume, turnover)
   Use search_spaces/bl042_criteria.json and bl010_criteria.json as worked examples of a
   pre-registration.
3. Red-team the BL-050 Phase 0 draft for look-ahead, survivorship and data-snooping. Check
   specifically:
   - is weekly turnover built only from sessions up to the decision Friday;
   - is Nifty 500 TRI weekly-aligned with the stock closes;
   - do M2/T1 regressions use trailing windows only;
   - does M1's percentile use that week's PIT universe only;
   - is the trial count (6) honest, given the earlier 3.9.23 lever study.
   Report anything that should change BEFORE committing.
4. Ask me BL-050's three open questions (tilt weight 0.25; dashboard vs CLI for the shadow arm;
   one or two shadow arms if two features survive), plus any new ones from step 3. Wait for my
   answers.
5. Record my answers in BL-050 (Open questions → answers, Log entry). Set status In progress,
   update backlog/INDEX.md, and add a TODO.md row that links to BL-050.
6. Write search_spaces/bl050_criteria.json from Phase 0 (hypothesis, universe, comparator, the six
   trials with shape/setting/direction, look-ahead checks, dev window, pass/kill rules for the
   screen and the engine test, the sealed hold-out 2024-01-01 → 2026-09-25 with runs_allowed 1,
   the will-not-run list). Commit it in the same change as step 5.
7. Commit and push on a new branch, then stop. Report: what changed in the plan and why, the
   committed criteria file, and anything I still need to decide.

Rules: one fact lives in one file (the plan stays in BL-050; the criteria JSON holds the
machine-readable rules). Never edit a rule after a run. Do not open a PR unless I ask.
~~~

---

## Prompt B — Working session

~~~text
Continue BL-050 (backlog/BL-050-momentum-filter-poc.md) in ai-trading-agent. This is a WORKING
session. Before anything else, check that search_spaces/bl050_criteria.json is committed and
BL-050's status is In progress. If either is missing, stop and tell me: the research gate forbids
running without a committed pre-registration.

Ground rules:
- Follow bl050_criteria.json exactly. The six trials (V1, V2, R1, M1, M2, T1), their one setting
  each, their directions and the pass/kill rules are fixed. Anything outside them, including the
  will-not-run list, needs me to write "override: <reason>" in BL-050's Log first.
- The frozen ensemble, the Friday signal, saved favourites and goldens must stay byte-identical.
  New behaviour is off by default.
- Use turnover (₹), not share volume. Daily highs/lows are NOT split-adjusted; only weekly closes
  are. Indices and ETFs have no volume.
- Phases 2–3 need the real data under TRADING_DATA_ROOT (bars_1d_stock, the catalog). That
  lives on my laptop. If this session has no data, do Phase 1 only (tests run on golden-fixture
  data) and tell me which commands to run locally.
- Stop after EACH phase and report. Do not start the next phase until I say so.

Phase 1 — Features and hooks:
- Add the six features as pure, point-in-time functions next to levers.py.
- Add a general rank-tilt hook to run_broad_backtest, independent of stock_tilt (two frozen
  configs already use stock_tilt), off by default.
- Tests:
  - a prefix-invariance test per feature (computed on data cut at week t equals computed on
    full data);
  - with the hook off, the four frozen configs reproduce scored_curves_sha256;
  - `uv run python scripts/update-goldens.py` reports no change;
  - `uv run pytest` and the lefthook pre-push checks pass.

Phase 2 — Cheap screen:
- Run once per frozen config, 2012-01-01 → 2023-12-31, each on its OWN score definition, cadence
  and rebalance offset from bl010_phase6_frozen.json. Never pick one config or calendar by hand.
  At each of its rebalance dates take the top quintile by that config's score; split tilts top
  half vs bottom half, gates blocked vs passed.
- Report forward 4- and 13-week returns net of a 0.3% round trip, with a Newey-West t-stat per
  config. Pass only if the mean of the four 13-week t-stats is ≥ 2 in the pre-registered
  direction AND at least 3 of 4 configs have the right sign; otherwise kill.
- Also report how many names each gate blocks per week.
- Save search_spaces/bl050_screen_result.json and a table in BL-050.

Phase 3 — Engine test:
- Run ALL SIX features through all four frozen configs: gates via extra_no_buy, tilts via the new
  hook. Build each ensemble with choose.ensemble_curve. Compute CSCV/PBO over the six curves plus
  the baseline. Features killed in Phase 2 are in the PBO matrix but cannot pass.
- Score Phase 2 survivors only with the 3.9.23 yardstick (full-period CAGR/Sharpe/MaxDD; win
  shares over rolling 3-year windows stepped quarterly; median ΔCAGR).
- Report average holdings and cash share next to every result.
- Pass needs all of: median ΔCAGR ≥ +2.0; CAGR win share ≥ 70%; MaxDD no more than 3 pts worse;
  PBO < 0.5.
- Save bl050_dev_result.json.
- Only after the dev verdicts are committed: run the ONE confirmation on the sealed
  2024-01-01 → 2026-09-25 window for survivors. Pass = ΔCAGR ≥ 0 and MaxDD no more than 3 pts
  worse. Save bl050_holdout_result.json. It may never run twice.

Phase 4 — Shadow arm (only if something survived, and only when I say go):
- Make each survivor saveable as a favourite config (frozen ensemble + filter).
- Record it weekly in the forward journal (BL-024) next to the ensemble.
- Verdict after ≥ 26 weeks. Adoption is my decision under BL-025, never automatic.

Every phase: record results and a dated Log entry in BL-050, and update backlog/INDEX.md and the
TODO.md row in the same commit. Commit and push on a branch. No PR unless I ask.

Report format at each stop:
1. What was done (files, commits).
2. Results table (feature | verdict | key numbers).
3. Anything that looked wrong or surprising.
4. What the next phase needs from me.
~~~

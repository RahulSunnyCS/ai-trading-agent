# BL-025 — Live-money rules for Momentum: written before the first rupee, enforced by alerts

| | |
|---|---|
| **Priority** | P1 — becomes P0 the week real money goes into the strategy |
| **Status** | In progress (Phase 2); drawdown-rule test signed off 2026-10-28, running |
| **Type** | feature |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-024 (journal), BL-016 (validation status) |
| **TODO.md row** | [§3.22](../TODO.md) |

## Context

The owner plans to put 10–20% of their portfolio into Momentum and accepts a 25–35% drawdown, with
a hard ceiling of 40% (BL-010, 2026-10-04). Those limits exist in a backlog file, not in the
system. The moment that tests them, a deep drawdown or a strategy that has quietly stopped working,
is when deciding calmly is hardest. The rules should be fixed in advance and the system should say
when one is hit.

This item does not choose the numbers; the owner does. It makes the owner's own numbers explicit
and checked.

## Goal

A `live_rules` file the owner writes once, and a weekly check that alerts when a rule is breached.

## Plan

### Phase 1 — Write the rules (owner, with Claude)
- **Draft, from the owner's own statements in BL-010 (2026-10-04/05):** about ₹5 lakh, 10–20% of
  the portfolio; drawdown limits per basket 25% / 30% / 35% with a hard ceiling of 40%. Every other
  number (how far live may trail the backtest, over how many weeks, and what each breach triggers)
  is still the owner's to set — Claude does not choose them.
- **Tasks:** capital allocated; maximum drawdown before reducing and before stopping; how far
  live may trail the backtest (from BL-024) over how many weeks before review; what "review" means;
  which validation status (BL-016) is required before money goes in.
- **Done when:** the file is committed and the owner has signed it off in the log.

### Phase 2 — Check and alert
- **Tasks:** a weekly job (BL-012) that reads the rules, the journal and the realised P&L, and
  sends a Telegram alert naming the rule breached and the action the owner wrote for it.
- **Done when:** a simulated breach produces the alert.

## Open questions

0. ~~The rule numbers~~ **Answered when the item started (owner, 2026-10-07):**
   - **Paper-track first.** BL-010's frozen ensemble failed its 2012–16 backcast (+7.8 points
     over the Nifty 500 TRI, +2.5 over the Midcap 150 TRI; the bar was +5 over both). It is
     tracked in the journal before any money goes in.
   - **Drawdown:** cut half at a 20% fall from the peak, exit fully at 30%. These are stricter
     than the 25–35% tolerance and 40% ceiling stated in BL-010.
   - **Trailing:** review when live is 5 points behind the backtest over 13 weeks.
   - **Claude's drafted details (signed off by the owner, 2026-10-07):**
     - the money gate is at least 13 paper weeks, beating the Nifty200 Momentum 30 TRI, and
       neither drawdown rule hit;
     - after "cut half" the signal is followed at half size;
     - re-entry after an exit only by a logged review;
     - "review" means no new money, a check of what changed, and a logged decision (carry on,
       pause or stop).
1. ~~Friends and the rules?~~ **Shown for information only** (owner delegated to the recommendation, 2026-10-06): friends see the owner's rules as an
   example, and each friend's own money is their decision; the alerts go to the owner only.
2. **Drawdown-rule test (block under Experiments, drafted 2026-10-28). Answered by the owner 2026-10-28: a signed off as written; b X = 3 points; c do not wait for BL-176; d not asked separately, so the block stands as registered (2012–2016 not read here, left to BL-176).**
   - **a. Sign-off.** Do the six candidates, the lot ramps and the pass / kill rule stand as
     written? Nothing runs before "signed off" is in the Log.
   - **b. X = 3 points**, the CAGR a candidate may give up against holding through. 3 is the
     gap BL-010 already treats as meaningful. A smaller X makes "no candidate passes" likelier.
   - **c. Wait for BL-176?** Recommendation: **do not wait.** Run the block now on Four Sectors
     (the money is in it, and today's rules have no way back after an exit). Run the same block
     again, unchanged, on BL-176's choice if it changes the followed strategy.
   - **d. 2012–2016.** Leave it to BL-176 (recommended), or allow BL-025 one read of it now
     (`override: <reason>`). If BL-176 runs the followed strategy there, the registered rules
     can then be applied once to that same curve.

## Experiments

### 2026-10-28 — Drawdown rules with a way back in (pre-registered; awaiting the owner's sign-off)
Written before any run. **Nothing runs until the owner writes "signed off" in the Log.** The
numbers are also in `packages/momentum-backtesting/search_spaces/bl025_rules_criteria.json`. If
the two disagree, this block wins: before any run the JSON is corrected in place, after a run in
a new file. A rule here is never edited after a run. A changed rule is a new dated block that names this one.

- **Why.** `live_rules.toml` cuts half at −20% and exits at −30%, measured from the high since
  `paper_start`. It never says how to get back in or back to full size: `re_entry` is "only
  after a review logged in BL-025". The descriptive look of 2026-10-28 (Log) found that both
  past exits came within days of the bottom. Followed literally, the rules end at 1.26x against
  19.65x held through.
- **Hypotheses.**
  - **H1.** One of the rules below with a way back in keeps the worst fall of the money
    actually held within the owner's 35% on every sleeve, and costs no more than 3 points of
    CAGR a year against holding through.
  - **H2.** The rules as written (no way back) cost more than 3 points of CAGR against holding
    through on every object, not only on the blend. The descriptive look already shows this
    for the blend; H2 is registered so the test confirms it everywhere.
- **Strategy and ranking.** The followed strategy (`search_spaces/bl142_followed.json`: Four
  Sectors Monthly, No Tilt · all Fridays). Its four sleeves come from `tracker.run_config` on the
  `bias.Runner` that `live_rules.paper_curves` uses: pre-tax, itemised costs, signal delay 1,
  ₹2 lakh. Only the **post-F6 ranking** is used (BL-001, merge `778ba02e`). The window is fixed:
  **2017-01-06 to 2026-10-23**, the weeks the descriptive look already read. Later weeks are
  the forward data (Hold-out) and are never part of the judged window.
- **What the rules are applied to.**
  - **Each sleeve alone** (four objects).
  - **The blend:** equal capital, reset each April (`choose.ensemble_curve`).
  - **Lot ramps.** This is what the weekly check reads. Four lots go in from cash one Friday
    after another, each lot being the sleeve that trades that Friday. The result is measured as
    `live_rules.twr_index`, and the high is the high since the ramp's first Friday. There are
    18 registered first Fridays: the first Friday of each January and July, 2017 to 2025
    (listed in the JSON). Each ramp runs to 2026-10-23. Approximations, the same as the
    live check's: equal lots, no April reset, the engine's own fill convention.
- **How the rules work (all candidates).**
  - **Sizes** are 1, ½ or 0.
  - **What triggers them.** Every trigger reads the object's model curve at full size, never
    the money held, as the weekly check does.
  - **The high** is the highest weekly close since the object's first week, or since the last
    return to full size, whichever is later. A week that crosses both lines goes straight to 0.
    While at half size, the exit line is still measured from the same high.
  - **Timing.** The decision is made on the Friday close. The new size applies from the next
    week's return.
  - **Cash.** The share not invested earns the weekly table's `Cash (liquid fund)` series.
  - **Trades.** A size change sells or buys that share of every holding.
- **Candidates.** Six are scored, plus one non-mechanical option. Every number is fixed here:
  no grid, and no candidate is added after a run.

  | | Cut half | Exit | Back to full size after a cut, and re-entry after an exit (both straight to full) |
  |---|---|---|---|
  | **R0 Hold through** | — | — | — (the comparator) |
  | **R1 As written** | −20% | −30% | never (the logged review has no backtestable form) |
  | **R2 Back at the high** | −20% | −30% | when the model curve closes at or above the high it was measured from (drawdown back to zero: the simplest completion of today's lines) |
  | **R3 Trend back** | −20% | −30% | the first Friday the model curve closes above its **40-week** simple moving average, after it has closed below that average at least once since the action (the conventional 10-month trend rule). With fewer than 40 closes since the object's first week the average does not exist, and the condition is false |
  | **R4 Rebound back** | −20% | −30% | when the model curve closes **20%** above its lowest weekly close since the action (the conventional 20%-from-the-low mark of a new bull market) |
  | **R5 Owner's band, trend back** | −25% | −35% | as R3 (the lines sit at the ends of the owner's stated tolerance of 25–35%, below the 40% ceiling) |
  | **N Alert and review** | alert | alert | the owner decides each time: not backtestable, never scored, but the verdict may choose it |

- **Measures** (per object, after costs; pre-tax unless stated):
  - end wealth and CAGR of the money held;
  - worst fall of the money held, and its date;
  - weeks at half size and at zero, and their share of all weeks;
  - cuts not followed by an exit in the same fall;
  - exits within **8 weeks** before that fall's lowest close, and the weeks from each cut and
    exit to the low;
  - weeks from the low to each return to full size, and the model curve's rise over those weeks;
  - the number of size changes and their costs in rupees at ₹2 lakh (the engine's itemised
    rates);
  - the tax of each sale, estimated from the sleeve's open tax lots on the decision Friday
    (`tax.py`: STCG 20%, LTCG 12.5%, plus cess). Tax is reported but not judged, because the
    monthly rotation already makes almost every gain short-term, so the overlay moves tax in
    time more than in amount.
- **Pass / kill rule.**
  - **Pass.** A candidate replaces the current rules only if **all** of these hold:
    - (a) the worst fall of the money held is **≤ 35%** on each of the four sleeves, on the
      blend and on every one of the 18 lot ramps;
    - (b) it gives up **≤ 3.0 points** of CAGR against R0 on the blend, **and** ≤ 3.0 points as
      the median over the **qualifying ramps**: those whose model curve falls 20% or more from
      its high at some point, the same set for every candidate (fixed by R0's curve). A ramp
      the lines never touch would add a give-up of zero and pull the median towards a pass.
      With fewer than 3 qualifying ramps, the ramp median is reported, not judged.
  - **Kill.** Failing either condition kills the candidate for this strategy.
  - **Why X = 3.** BL-010's criteria use 2 to 3 points of CAGR as a difference that matters.
    2 is used for the jump-scan and category-layer kills, 3 for the offset-average,
    walk-forward and holdings-advice kills. 3 is the upper of those: an overlay is insurance,
    and the owner accepts some cost for it. 2 is the stricter choice, open question 2b.
  - **Several pass.** Let B be the passing candidate with the highest blend end wealth. Among the
    passing candidates whose blend CAGR is within 1 point of B's (B included), the first in the
    order R1, R2, R4, R3, R5 (fewest conditions first) is named. R0 is never named here (below).
  - **None pass.** The current lines stay, and the owner chooses R1 or N as the re-entry text.
  - **R0** is the comparator and is judged by (a) only, since (b) is zero by definition. If it passes (a) on its own,
    that is reported as "dropping the lines is consistent with your limits", for the owner to
    weigh.
- **Sample and wording.** The blend has about **three independent falls of 20% or more** in the
  sample (peaks 2018-08-31, 2021-10-15 and 2025-01-03), and the sleeves share them. Any verdict
  reads **"consistent with"**, never "proven" or "shown". The result also states:
  - **that 6 candidates were scored**;
  - **which fall decides each pass** (CAGR given up per fall);
  - **one fixed delay variant, reported only:** every action one week later, as if the owner
    acts a week late.
- **Data-snooping note.** The candidates were named after the descriptive look in the Log, so
  the dates of the past exits and the rebounds after them were already known. To keep the rules
  from being fitted to those dates, every number comes from somewhere else: standard practice
  (a 40-week average, a 20% rise from the low), the owner's stated limits (25 / 35 /
  40), or today's file (20 / 30). None was tried on the curves first. The commit that adds this
  block and the criteria file is the record of when they were written.
- **Look-ahead check.**
  - **The rule.** A decision on Friday t uses only the model curve up to and including t: the
    high is a running maximum, the average uses the closes of weeks t−39 to t (and is
    undefined before 40 closes exist), and the low is
    the lowest close since the action up to t.
  - **Verified three ways:**
    1. **Prefix check.** For every Friday t of every object, the size path computed on the curve
       cut at t equals the full run's path up to t. Any difference kills the run.
    2. **Unit test.** A synthetic curve whose weeks after t are replaced gives the same actions
       up to t.
    3. **Assertion in the code.** The size set at t multiplies the return from t to t+1, never
       the return ending at t.
  - **Known bias, shared by every candidate.** The curves use today's curated category tags,
    which carry survivorship (BL-010 F3). They may understate the falls.
- **Hold-out.**
  - **None clean.** The weeks from 2026-10-16 (`paper_start`) to 2026-10-23 were already read
    by the descriptive look, so they sit inside the judged window. The weeks from 2026-10-30 on
    are the only unseen data. They are too short to judge, and are reported separately (never
    pooled into the judged window) whenever the result is refreshed.
  - **2012-04 to 2016-12 is possible but not registered.** Stock bars, corporate-action factors
    and the point-in-time universe exist from 2011, with BL-010 addendum 5's patches. But
    BL-010 left that window spent and unread, and BL-176 may want it for the re-selection.
    Reading it here needs the owner's `override: <reason>`, and only after BL-176 has decided.
  - **If it is read:** one run, R0 and the named candidate only. Judged on the blend's worst
    fall of the money held ≤ 35%; CAGR given up is reported, not judged.
- **Will not run** (each needs `override: <reason>` from the owner in the Log first):
  - a grid or sweep of the lines, the average's length, the rebound, X or the delay;
  - a candidate not listed here, or a listed one with a changed number;
  - any figure on the pre-F6 ranking, except as labelled context;
  - volatility targeting, single-name stops (BL-084) or a change of strategy (BL-176);
  - the 2012–2016 window.
- **Depends on BL-176?** Open question 2c. **Recommendation: do not wait.** The money is in Four
  Sectors now, the rules as written have no way back, and the candidates do not depend on which
  strategy they are applied to. If BL-176 changes the followed strategy, this block runs again,
  unchanged, on the new `config_file`, as a new dated Result.
- **Result:** (after the run, after the owner's sign-off) pass / kill / inconclusive per
  candidate, with the numbers, the code commit and the data's last week.

## Log

- 2026-10-06 — created in the overnight review; not discussed with the owner yet.
- 2026-10-06 — owner delegated the remaining open questions to Claude's recommendations: the draft carries the owner's own stated limits; friends see rules for information only.
  The remaining numbers still need the owner's sign-off before Phase 1 is done.
- 2026-10-06 — owner: pending decisions stay here as open questions and are settled when the item is picked up; the rule numbers are open question 0.
- 2026-10-07 — started. Owner's answers under Open questions 0. Phase 1:
  `packages/momentum-backtesting/src/momentum_backtesting/live_rules.toml` drafted with those
  numbers (stage `paper`). It waits for the owner's sign-off of the drafted details, then
  Phase 2 (the weekly check and alert, a BL-012 scheduler job).
- 2026-10-07 — owner signed off the drafted details ("yes, signed off"). Phase 1 done. Phase 2
  (the weekly check and alert) started.
- 2026-10-07 — **Phase 2 built:** `mbt live-rules check [--send] [--simulate ...]`
  (`live_rules.py`) and the scheduler job `momentum-live-rules`, Fri 21:30 IST, after the
  journal check.
  - **Alerts:** a breach names the rule and quotes the action from `live_rules.toml`; it is sent
    untagged, so it cannot be switched off. The routine weekly status is the optional type
    `momentum.live_rules`. Exit 0 on a breach (the message is the alert); exit 1, with a Telegram
    error, only when the check cannot run or the data does not reach this week.
  - **File changes with no number moved:** the action text moved from comments into data
    fields, and `stage.paper_start = 2026-10-09` was added (the journal's first clean Friday,
    BL-024 decision 5) so the 13 weeks have a start.
  - **Simulated breach (the "done when"):** `--simulate drawdown-cut | drawdown-exit |
    trailing | gate-ready` runs the real evaluation on synthetic curves and sends the real
    message, prefixed SIMULATED.
  - **Limits, stated in every weekly message:**
    - *Trailing rule: not measurable yet.* It needs the journal scored week by week (BL-024
      Phase 2, not built). A paper curve from the same engine as the backtest is never used
      for it, because the gap would be zero by construction.
    - *Paper equity is the model portfolio, not the journal.* The drawdown and money-gate
      numbers come from the frozen ensemble's model portfolio rebased at `paper_start`
      (BL-010 Phase 6 step 3's definition).
    - *Stage `live` is reported as blocked.* Real-money equity needs BL-024 Phase 3 (recorded
      fills); until then the check refuses to read paper numbers as real money.
    - *A breach repeats weekly until the owner changes the file.* There is no "acknowledged"
      field yet.
  - **A bug the tests caught:** with the data ending before `paper_start` the check took an
    earlier week as the start and reported all clear. It now reports "paper tracking has not
    started".
- 2026-10-22 — the weekly check now measures the strategy the money is in: Four Sectors Monthly,
  No Tilt, all Fridays (BL-142, owner 2026-10-20), as its four sleeves
  (`search_spaces/bl142_followed.json`, named by `strategy.config_file` in `live_rules.toml`),
  not the BL-010 Phase 6 frozen ensemble. `stage.paper_start` moves from 2026-10-09 to
  2026-10-16, Friday 1 of 4 of the Kite lots (first buy Monday 2026-10-19). No rule number
  changed. Reason: the ensemble was never what the money followed, so its drawdown said nothing
  about the account. **Owner to confirm** the new start date and that the money gate's
  `min_paper_weeks = 13` still means what you want now that real money is already in; both are
  yours. Stage stays `paper`; real-fills equity (BL-024 Phase 3) is still not built, so these
  numbers are the model portfolio's, not the account's.
- 2026-10-22 — owner: model the ramp-in (review finding on PR 286). `live_rules.paper_curves`
  now puts the four lots in from cash one Friday after another from `paper_start` (16 Oct,
  23 Oct, 30 Oct, 6 Nov), each as the sleeve that trades that Friday (offsets 3, 0, 1, 2), and
  measures the drawdown on the time-weighted index of the lots, so a new lot adds money, not
  return. A lot put in this week shows no return yet (the engine needs two weeks). Approximations:
  each lot buys on the research engine's own fill convention (signal delay 1), lots are equal and
  not reset in April, and the Mom30 line it is compared with is a lump sum from `paper_start`.
- 2026-10-28 — owner chose "Pre-register a rule test". First, a **descriptive look**, done
  before any candidate rule was named. It is context, not a result of the test. A read-only
  script rebuilt the four sleeves (`tracker.run_config`, post-F6 ranking) and walked today's
  lines over them. The script and its outputs are not committed.
  - **Today's rules leave gaps.** The file has no rule for re-entry or for going back to full
    size, and nothing resets except a new high. The check repeats every Friday while the curve
    is below a line. After a cut it measures the model curve, not the halved money.
  - **The blend** (equal capital, April reset, 2017-01-06 to 2026-10-23): 35.5% CAGR, −34.8%
    worst fall (2020-04-03).
  - **The sleeves' worst falls:** −37.5 / −35.6 / −34.6 / −38.4%.
  - **Three falls of 20% or more on the blend**, from peaks on 2018-08-31, 2021-10-15 and
    2025-01-03. Two of them reached −30%:
    - exits on 2020-03-27 and 2022-06-24, both within days of the bottom;
    - the curve then rose +132.7% and +41.2% over the next 12 months.
  - **Followed literally with no re-entry:** 1.26x end wealth against 19.65x held through.
  - **The pre-registration** is under Experiments ("Drawdown rules with a way back in"), with
    its numbers in `search_spaces/bl025_rules_criteria.json`. It holds six candidates (hold
    through, as written, and four with a way back in) and the alert-and-review option, the
    pass rule (≤ 35% worst fall of money held everywhere, ≤ 3 points of CAGR given up) and the
    look-ahead checks. **Nothing has run. It awaits the owner's sign-off** (open question 2).
    The strategy itself was chosen on the pre-F6 ranking; BL-176 re-runs that search.
- 2026-10-28 — **signed off** by the owner (asked in chat): the Experiments block "Drawdown rules with a way back in" and `search_spaces/bl025_rules_criteria.json` stand as written at merge `a4045e3f`, with X = 3 points; run now, without waiting for BL-176. Nothing had run before this entry.

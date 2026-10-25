# BL-165 — BL-164's two leads: gap-and-go on gap-down days only, and on expiry days only (confirmation-period test)

| | |
|---|---|
| **Priority** | P2 — the owner asked for it (2026-10-25); two post-hoc slices of a killed strategy, so the expected value is a clean "no", but each is cheap and the 2022–24 period is unseen for them |
| **Status** | Done — killed (2026-10-25): both leads positive on 2022–24 but t 1.0 / 1.2, below 2.24 |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-25 |
| **Depends on** | BL-164 (the H1 rule, the grammar and engine additions), BL-120 (the rule tester, the locked confirmation period), BL-063 (charges) |
| **TODO.md row** | 3.10.44 |

## Context

BL-164 killed the published gap-and-go chain on the learning period (NIFTY 2024-10-09 → 2026-10-08):
gap-and-go (H1) made +₹111 a trade over 147 trades (t 0.33). Its result printed breakdowns, and two of
them looked good: **gap-down days** (H1's down side) +₹273 a trade over 64 trades, and **NIFTY weekly
expiry days** +₹724 over 23. The owner (2026-10-25): "Let's do that leads thing … whenever it is a gap
down day, and whenever it is an expiry day."

**These two leads are data-snooped.** They were picked after seeing about 16 breakdown cells of one
result (5 half-years, 2 sides, 5 weekdays, 2 expiry groups, plus H2 and H3's own), so the learning
period cannot test them: it is where they came from. The test is the **confirmation period**
(NIFTY 2022-01-03 → 2024-10-08), locked and unseen for these rules. The expiry slice had only 23
learning-period trades, below the 40-trade floor, so it was never more than a hint.

Revealing the confirmation period for these two subsets partly shows H1's own confirmation period
(its gap-down and expiry-day trades). H1 is killed and is not retested, so nothing is lost, but it is
recorded in BL-164's Log.

## Goal

A registered verdict on 2022–24 for each lead: does H1 restricted to gap-down days (L1), or to expiry
days (L2), earn money after charges, beat the same trade at a random later minute, and survive 0.5%
slippage, on data neither rule was chosen on.

## Out of scope

- Any other slice: the up side, a weekday, a half-year, a gap size, H2 or H3 sliced, combinations
  (gap-down AND expiry).
- Any change to H1's rules (band, window, strike, stops, trail) or to costs.
- SENSEX; the forward period after 2026-10-08.
- Trading anything. A pass becomes a forward-tracking proposal, its own item.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypotheses.**
  - **L1 (gap-down):** BL-164's H1 taken only when the gap is down (the PE side; `when: h1_down`),
    everything else as registered in BL-164, earns more than zero after charges on 2022–24 and beats the
    same trade at a random later minute while still beyond the band.
  - **L2 (expiry day):** H1 taken only on a NIFTY weekly expiry day (both sides; `when: all[h1,
    expiry_day]`), the same.
- **Expiry day.** A session whose nearest listed NIFTY expiry is that session itself: the same rule the
  simulator uses for the traded option (`legwise.market.pick_expiry(day, "weekly") == day`), read from
  the day's Fyers symbol master when there is one, else from the expiries in that day's option file (the
  vendor days). A new grammar leaf `expiry_day` (Phase 1), constant per session; an expiry date is known
  before the session, so it is not look-ahead.
- **Fills, stops, costs, strike, lot:** exactly BL-164's (ITM3 weekly bought, −30% stop, 105% / 80% peak
  trail, both on the 1-minute close, out at 15:15, BL-063 charges, today's lot, one lot).
- **Controls:** trend-matched as BL-164's H1 (the close beyond the band the minute before entry). For
  L2 the control must also be an expiry day (`control_when: all[expiry_day, beyond the band]`), so the
  placebo compares expiry days with expiry days. 200 random-time draws, 20 placebo days.
- **Universe:** NIFTY index 1-minute bars and the weekly option chain of each day from the trading-data
  lake (vendor files for 2022–24, BL-034), days `data_quality` excludes skipped and counted. The index
  has no constituents to be survivorship-biased.
- **Look-ahead check:** L1 and L2 only add conditions known at or before the firing stamp (the gap at
  09:15, the expiry calendar); `expiry_day` joins the grammar's causality test. Everything else is
  BL-164's checked rule.
- **Reproduction check (not evidence):** both rules are also run on the learning period, where they
  must reproduce BL-164's slices: L1 64 trades, mean net +₹273; L2 23 trades, +₹724 (to the rupee,
  rounded). A mismatch stops the item before the reveal.
- **Pass / kill rule** (confirmation period, after BL-063 charges, one lot), per lead:
  1. Fewer than 40 events is **thin**: the lead is **inconclusive** and cannot pass.
  2. **Passes** with mean net per trade > 0, **t ≥ 2.24** (two tests, Bonferroni at 5%), the event
     mean at or above the 90th percentile of its random-time draws, and mean net > 0 at 0.5% slippage.
  3. Otherwise **killed**. Each lead is judged on its own; neither rescues the other.
- **Hold-out:** the confirmation period is revealed once per spec hash (`store.reveal`, noted
  "BL-165"), for these two specs only. Sessions after 2026-10-08 are forward only.
- **Will not run** (each needs `override: <reason>` in the Log): any slice in Out of scope; a second
  look at the confirmation period; changing either rule after the reveal.

### Phase 1 — `expiry_day` in the grammar
- **Tasks:** `ruletest/expr.py` leaf `expiry_day` (bool, per session) from a frame loader;
  `ruletest/frame.py` builds it from the lake as defined above, cached under
  `TRADING_DATA_ROOT/ruletest/features/`; causality test row; unit test against `pick_expiry`.
- **Done when:** the two specs validate and read back.

### Phase 2 — Run and judge
- **Tasks:** `packages/option-backtesting/research/bl165/run.py`: the reproduction check on the
  learning period, then the reveal and the confirmation run of each spec, both recorded in the ledger,
  then the pass rule. Outputs under `research/bl165/out/` (git-ignored).
- **Done when:** the verdict is in the Log and Result, and the gap-and-go findings pages cite it.

## Result

**Killed, both.** Checks first: `expiry_day` matched `pick_expiry` on 100 sampled sessions (144 of 682
usable 2022–24 sessions and 103 of 486 learning sessions are expiry days), and both leads reproduced
BL-164's slices on the learning period exactly (L1 64 trades, +₹273; L2 23 trades, +₹724). Then the
confirmation period (NIFTY 2022-01-03 → 2024-10-08, revealed once per spec, BL-063 charges, one lot;
ledger tests `20261025-185402-cdd4`, `20261025-185405-6061`):

| Lead | Trades | Net / trade | t | Win rate | Median | Without the best 3 | Random-time pct | 0.5% slip | 1% slip | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| L1 gap-down | 75 | +₹485 | 1.01 | 40% | −₹552 | −₹44 | 1.00 | +₹363 | +₹235 | killed (t) |
| L2 expiry day | 43 | +₹746 | 1.21 | 51% | +₹449 | −₹18 | 1.00 | +₹649 | +₹543 | killed (t) |

- Neither is thin; neither reaches t ≥ 2.24, so both are killed by the registered rule.
- Both kept their sign on unseen data, which is more than most leads do, but the mean of each rests on
  three trades (L1's best +₹15,148 / +₹14,748 / +₹9,689); without them both are about zero.
- Description only: L1 by half-year +₹222 / +₹1,537 / −₹188 / −₹563 / +₹941 / +₹1,863 (2022H1 →
  2024H2); L2 down +₹961 (22), up +₹521 (21). At a t of about 1 on 75 trades, reaching 2 at the same
  mean would need roughly four times the trades, several years of forward data.

## Risks

- **Thin L2:** about one session in five is an expiry day and H1 fires on about a third of sessions, so
  2022–24 may give about 40 L2 trades; inconclusive is a likely and acceptable outcome.
- **Regime:** 2022–24 had different lot sizes, weekday expiries and volatility; the rules use today's
  lot and the real expiry calendar, so the comparison is like for like in the rule, not in the market.
- **Vendor bars:** 2022–24 options are vendor 1-minute files, not Fyers; BL-160 and BL-152's
  confirmation logic use the same data.

## Log

- 2026-10-25 — created from the owner's request after BL-164's verdict. Pre-registration written and
  committed before any code or run. Next: Phase 1.
- 2026-10-25 — **Phase 1 done** (nothing run). `expiry_day` leaf in `ruletest/expr.py` (in the
  causality test), built by `ruletest/frame.py`'s `ExpiryDayLoader` from `nearest_expiry` (the
  simulator's rule) and cached under `ruletest/features/`. BL-164's rule definitions moved to
  `research/common/gap_and_go_specs.py` (its spec hashes unchanged). `research/bl165/run.py` writes the
  two specs (L1 `cc2525aebfd4`, L2 `07b33d473cb1`); both validate and read back. Next: Phase 2.
- 2026-10-25 — **Phase 2 run.** Expiry check and reproduction check passed; both specs revealed
  (note "BL-165 …") and tested on the confirmation period. **Killed, both** (L1 +₹485 a trade, t 1.01;
  L2 +₹746, t 1.21; bar 2.24); numbers under Result. Findings: the gap-and-go pages. Closed.
- 2026-10-25 — **override:** owner, after being told both periods are now seen for this family and the
  strikes / expiries below are on BL-164's and BL-165's will-not-run lists: "Yes test the new variants"
  (asked: "Have you tried with 100, 80, 120 premium and next week options in expiry day. What is win
  rate"). Registered here before any run, as an **exploratory screen, not a verdict** (`mode:
  exploratory`, every variant counted in the ledger, `research/bl165/screen.py`); H1's rules otherwise
  unchanged (band, window, −30% stop, 105% / 80% trail on closes, 15:15, BL-063 charges, one lot):
  - **A** (all gap-and-go days, nearest weekly): `closest_premium` ₹80 / ₹100 / ₹120; both periods.
  - **B** (expiry days only, the same-day expiry): ₹80 / ₹100 / ₹120; both periods.
  - **C** (expiry days only, next week's expiry): ITM3 and ₹80 / ₹100 / ₹120; **learning period only**:
    the 2022–24 vendor files carry only the current weekly (41 of 43 confirmation expiry-day events have
    no next-week chain, and `pick_expiry(..., "next_weekly")` there falls on a long-dated contract), so
    a 2022–24 run would trade the wrong option. C has 23 events: thin by the 40-trade floor.
  - 10 variants. Read: trades, win rate, net / trade, t, 0.5% slippage, random-time percentile per
    period. A variant with t ≥ 2.0 in both periods would be a lead for forward tracking only; nothing
    here passes or fails anything.

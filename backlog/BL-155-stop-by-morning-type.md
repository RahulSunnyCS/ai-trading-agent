# BL-155 — Stop size by the morning: a wide stop after a quiet morning, a tight one after a wide morning

| | |
|---|---|
| **Priority** | P2 — a cheap test on stored data; the only untested way to use the morning range |
| **Status** | Done: killed at step 1 (2026-10-22) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-22 |
| **Depends on** | none (heatmap store; BL-127 / BL-128 scripts for step 2) |
| **TODO.md row** | 3.10.38 |

## Context

Owner's idea (2026-10-22), from the discussion that closed BL-022: choose a straddle's stop by how
the morning went.

- **Quiet morning:** the afternoon is likely quiet too, so give it room with a **wide stop (80% or
  more)**. A tight stop would mostly be hit by noise and give up premium the trade would have kept.
- **Wide morning:** a bigger afternoon is more likely, so use a **tight stop (under 80%)** and cut a
  losing leg early.

What is already known:

- **The morning range predicts the afternoon's size.** BL-022 found Spearman 0.49–0.52 at 10:30–12:00
  for today's range so far against recent mornings, better than VIX-implied (0.43–0.45). BL-110
  found range persistence.
- **It has not helped as a keep / skip / swap state.** BL-081's "range since open ÷ ATR" for pending
  picks failed, and cost about ₹40k against the state-blind rule in 2024–26.
- **Stop size alone looks good in-sample but does not carry forward** (`research/options/strategies/
  widesl/leg-sl.md`). BL-098 ranked 80–90% first. BL-127 / BL-128 found 60–80% best in the selection
  year, but in Adaptive the next year it was −₹10 / −₹2 per lot-day, with intervals including zero.
- **Never tested:** a stop that depends on the morning. A tight stop might help on wide days and hurt
  on quiet days, cancelling out in the unconditional tests.

Counter-argument, which is why the reversed rule is a comparator: on a choppy afternoon a tight stop
is whipsawed, both legs stop out and the market comes back, so the opposite assignment could be the
one that works.

## Goal

A verdict on whether the morning-type stop beats every fixed stop and the reversed rule after
charges: first on the heatmap's short ATM straddles, then (only if that passes) on the real
closest-premium Widesl strategies.

## Out of scope

- Any change to live strategies, the rotation files or Adaptive. A pass leads to a forward shadow
  track first.
- Morning thresholds, stop levels or check times other than those registered below.
- Entries before 11:15 (the morning is not known yet).

## Plan

### Phase 0 — Pre-register (committed 2026-10-22, before any run)

The owner's answer (2026-10-22): register and run with the rules proposed in the discussion, that
is quiet → wide stop, wide → tight stop, with both fixed stops and the reversed rule as comparators.
Decision period: the recent period decides, as the owner chose for BL-022 the same day.

- **Hypothesis:** setting each leg's stop by the morning type at 11:00 earns more per lot-day, after
  charges, than each fixed stop and than the reversed assignment, and more than shuffled day labels.
- **Morning type at 11:00:**
  - R = (highest high − lowest low of the index's 1-minute bars stamped 09:15–10:59) ÷ the 09:15
    open, divided by the mean of the same quantity over the previous 20 sessions.
  - **Quiet:** R ≤ 0.80. **Wide:** R ≥ 1.25. **Normal:** in between. These are BL-110 / BL-111's
    thresholds, there applied to whole sessions.
  - Index: NIFTY for NIFTY strategies, SENSEX for SENSEX.
- **Step 1 — heatmap (short ATM straddle).**
  - Data: `TRADING_DATA_ROOT/heatmap/<index>.parquet`, exit **15:15**, entries 11:15, 11:45 … 14:45
    (8 entries).
  - **Rule:** quiet → SL 100%, normal → SL 80%, wide → SL 60%.
  - **Comparators:** fixed 60%, fixed 80% and fixed 100% on every day; the reversed rule (quiet → 60%,
    normal → 80%, wide → 100%).
  - **Money:** points × today's lot size (the heatmap's own convention), minus charges per the BL-063
    model with ₹20 brokerage per order (BL-096 rate):
    - STT on sell-side premium (0.10%, 0.15% from 2026-04-01);
    - exchange 0.03503% NSE / 0.0325% BSE, both sides;
    - SEBI and IPFT; stamp 0.003% on the buy side;
    - GST 18% on brokerage, exchange, SEBI and IPFT.

    Exit premium = entry − points per leg. No slippage.
  - **Day value:** the mean over the 8 entries, ₹ per lot.
- **Step 2 — real Widesl (only if step 1 passes).**
  - Regenerate the per-day results of BL-127 (NIFTY closest-premium ₹80 / ₹100 / ₹120) and BL-128
    (SENSEX ₹240 / ₹300 / ₹350) with their own, unchanged `simulate.py` and `assemble` (SL 60–115%,
    trail 15/10, MTM ₹2,500, all slots).
  - **Rule:** quiet → SL 115% (live), normal → SL 80%, wide → SL 60%.
  - **Comparators:** fixed 60%, fixed 80%, fixed 115% (live); the reversed rule.
  - **Slots:** every slot with entry ≥ 11:17.
  - **Day value:** mean over slots and the three premiums.
  - **Money:** stored gross minus brokerage (₹20 + 18% GST per order, 2 orders × `n_trades`, as BL-135).
    The stored results carry no premium for STT.
- **Look-ahead check:**
  - R reads only bars stamped before 11:00 and earlier sessions.
  - Every entry is at or after 11:15, so the stop is chosen before entry.
  - A unit test perturbs every bar at or after 11:00, and every later session, and asserts that R and
    the label do not change.
- **Pass / kill rule (each step, the same):**
  - **Decides:** NIFTY over 2025-01-01 → 2026-10-21. Step 2 ends at its data's last day.
  - **All four comparisons:** the mean daily Δ (rule − comparator) has a 90% block-bootstrap lower
    bound above 0 (5-session blocks, 2,000 resamples) for each comparator.
  - **Placebo:** the rule's mean exceeds the 95th percentile of 1,000 within-period shuffles of the
    day labels.
  - All must hold. Step 1 failing ends the item: step 2 is not run.
  - A step 2 pass means a forward shadow track, never a live change.
- **Hold-out / reported only:**
  - NIFTY 2022-01-03 → 2024-12-31 (step 1);
  - SENSEX 2024-10 → 2026-10 (both steps);
  - per-type means and day counts.
- **Will not run:** other R thresholds, other stops (including the heatmap's 10–50% and no-SL
  columns), other check times or entry sets, 15:30 exits, per-entry tuning. Running one needs
  `override: <reason>` in the Log.

### Phase 1 — Step 1, heatmap
- **Tasks:**
  - `packages/option-backtesting/research/bl155/` with a morning-type module and the look-ahead test;
  - `step1_heatmap.py`, writing `out/step1_result.json`.
- **Done when:** a pass or fail is recorded here.

### Phase 2 — Step 2, real Widesl (only if Phase 1 passes)
- **Tasks:** regenerate BL-127 / BL-128 results, then `step2_widesl.py`.
- **Done when:** a pass or fail is recorded here.

### Phase 3 — Write-up
- **Tasks:**
  - Result and Log here; INDEX and TODO;
  - `research/options/strategies/widesl/leg-sl.md` (stop by morning type);
  - `research/options/common/intraday-state.md`.
- **Done when:** merged with a code-review result on the PR.

## Result (2026-10-22): killed at step 1

**The morning-type stop does not beat the alternatives.** On NIFTY's straddles from 11:15 to 14:45,
2025-01 → 2026-10 (436 days), the rule earns +₹40 per lot-day net, against:

| Comparator | Mean net | Rule minus it (90% lower bound) |
|---|---|---|
| Fixed 60% | +₹35 | +₹4 (−31) |
| Fixed 80% | +₹32 | +₹8 (−13) |
| Fixed 100% | +₹32 | +₹8 (−30) |
| Reversed rule | +₹32 | +₹8 (−31) |

Every lower bound is below zero, and +₹40 is below the shuffled-label 95th percentile (+₹55). Step 2
(the real Widesl) was **not run**, as registered.

**By morning type, ₹ net per lot-day** (descriptive; this is how the rule was built, not a test of it):

| Period | Type | Days | SL 60% | SL 80% | SL 100% |
|---|---|---|---|---|---|
| NIFTY 2025–26 (decides) | quiet | 144 | +61 | +83 | **+96** |
| | normal | 192 | **+40** | +23 | −3 |
| | wide | 100 | −9 | −25 | **+8** |
| NIFTY 2022–24 (reported) | quiet | 274 | +99 | +103 | **+137** |
| | normal | 294 | **+51** | +14 | −18 |
| | wide | 170 | **+120** | +77 | +58 |
| SENSEX 2024-10 → 2026-10 (reported) | quiet | 164 | **−40** | −72 | −73 |
| | normal | 212 | **−41** | −81 | −91 |
| | wide | 114 | **+100** | +20 | +59 |

**What it shows:**
- **The quiet half of the idea holds on NIFTY in both periods:** after a quiet morning the widest stop
  is best, by about ₹35–38 a lot-day over 60%. It does not hold on SENSEX, where 60% is best on every
  type.
- **The wide half does not hold where it decides.** After a wide morning on NIFTY 2025–26 the widest
  stop was best and 80% was worst. In 2022–24 and on SENSEX the tight stop was best, as the idea
  expected. The direction flips between periods, as BL-081 saw for other morning states.
- **The tight stop wins on normal days everywhere.** That is the unconditional BL-098 / BL-127 /
  BL-128 finding again, which did not carry into Adaptive.
- **What the rule gains is about the same as what a fixed stop gains**, and less than the variation
  random labels produce.

**A lead, not a finding:** "only quiet mornings get the wide stop" is visible after the fact. Testing
it would need its own pre-registration and unseen days (forward); it is not adopted.

**Evidence:** `packages/option-backtesting/research/bl155/`:
- `morning.py`, `step1_heatmap.py`, `test_lookahead.py` (3 tests);
- `out/step1_result.json` and `out/step1_days.csv` (git-ignored; regenerate with `step1_heatmap.py`,
  about a minute).

## Risks

- The heatmap is an ATM straddle without trail or MTM stop, not the live Widesl; that is why step 2
  exists.
- Quiet and wide days are the tails (about a quarter each), so each type has fewer days than the
  whole; the bootstrap is over all days, with Δ = 0 on days where rule and comparator agree.
- The recent period alone decides (owner's choice for BL-022, carried here), so a pass needs the
  forward shadow before anything live.

## Open questions

None at registration.

## Log

- 2026-10-22 — created and started from the owner's idea ("on a quiet morning prefer wider stops,
  above 80%; on a wide morning tighter, under 80%"). The owner approved the proposed rules and
  comparators ("Yes: add it as a new backlog item with the rules you described … commit Phase 0, then
  run the heatmap check and the real-Widesl check if it passes"). Phase 0 committed before any run.
- 2026-10-22 — Step 1 **failed**. Rule +₹40 / lot-day against +₹32–35 for the four comparators; every
  90% lower bound is below zero, and the rule is below the shuffle 95th percentile (+₹55). Step 2 was not
  run. Item closed: killed. Lead noted (quiet → widest stop, NIFTY both periods), not adopted.

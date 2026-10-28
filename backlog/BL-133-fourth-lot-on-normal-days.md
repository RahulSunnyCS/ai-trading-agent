# BL-133 — A fourth lot on non-expiry days: which pick in T1 (Widesl) and in Core (Dir)

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each, ₹8.5 lakh per account) |
| **Status** | Done — informative: the Dir is the best home for the fourth lot in both books (Core and, by Amendment 1, T1), but the edge over an even spread rests on a few days; no Widesl placement beats it |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (lists, results store), BL-113 (T1), BL-129 (rank 1 vs rank 2), BL-111 (H1 lot ladder, not run) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18): one ₹8.5 lakh broker account runs T1 (3 lots), another runs Core-298 (3 lots). A fourth lot
does not fit the expiry-day margin (≈ ₹10.2 lakh), so: 3 lots on expiry days, 4 on other days. Where should the
fourth lot go? Owner's idea: in T1 on a Widesl ("add one more Widesl, or put one Widesl at two lots"), in Core on the
Dir ("add one more directional, or make that directional two"). And what does it do to drawdown.

## Goal

For each book, the result, drawdown and worst day of each fourth-lot placement against 3 lots and against the same 4
lots spread evenly; nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Picks:** Adaptive list C (registered weights and lookbacks, no expiry rule) replayed day by day from the stored
  results over Core-298 and over T1 (Core-298 + 223 T1 variants), as in BL-129: the day's composite (`pick._rank`),
  core picks (Buy add-on left out), the runners-up from `score.runners_up` (best unpicked Widesl and Dir).
- **Expiry day:** NIFTY or SENSEX weekday days to expiry `0` in `days.csv` → 3 lots (one per pick) in every book.
  Other days → 4 lots as below.
- **T1 placements (owner's):** T-W1 = second lot on the higher-composite Widesl pick; T-W2 = second lot on the
  lower-composite Widesl pick; T-W+ = the best unpicked Widesl added as a fourth strategy.
- **Core placements (owner's):** C-D2 = second lot on the Dir pick (a three-Widesl day: the best unpicked Dir is
  added instead); C-D+ = the best unpicked Dir added as a fourth strategy.
- **Comparators:** B3 = 3 lots every day (today); B4 = 4 lots on non-expiry days spread as 4/3 of each pick (the same
  extra size with no choice of pick, the fair yardstick for "does this placement beat an average lot").
- **Measures (gross per one-lot results × lots):** per-day total, annualised; max drawdown; worst day; and, per
  placement, the extra lot's own result on non-expiry days (placement − B3), its 90 % circular block bootstrap over
  all days (5-day blocks, 2,000 resamples, seed 20261025), and placement − B4 with the same interval.
- **Charges, stated not modelled exactly:** a second lot of a picked strategy adds no brokerage (same orders), an
  added strategy adds about ₹94 a day of brokerage (2 orders × the stored `n_trades` × ₹20 × 1.18); turnover charges
  scale with lots in every arm alike. Net lines subtract the brokerage only.
- **Windows:** 2025-01-10 → 2026-10-16 and the last year 2025-10-09 → 2026-10-16.
- **Reading:** a placement "earns its lot" if placement − B4 has its interval above zero; "costs" if below. Drawdown
  and worst day reported, not judged. Descriptive, in-sample (days read by BL-115 and others; T1's two-year window
  overlaps its selection year). It changes no list.
- **Look-ahead check:** day d is ranked on results before d; runners-up come from day d's composite only.
- **Will not run:** other placements, 5+ lots, Buy, the 2-2-1-1 ladder (BL-111 H1, registered separately).

### Phase 0 — Amendment 1 (2026-10-18, owner override, after the first results were read)

- **Override (owner):** proposed text "override: test T1's 4th lot on the Dir pick (2 lots) on non-expiry days, same
  rules as BL-133"; owner, 2026-10-18: "ok". Reason given earlier by the owner: "I think on T1 also it would be better
  if we add dir in non expiry days." The first run's results (Core's Dir placement leading, T1's Widesl placements
  not beating the even spread) had been read, so this arm is chosen with knowledge of them.
- **New arm T-D2** (T1 book): the Dir pick at two lots on non-expiry days; on a three-Widesl day the best unpicked Dir
  is added instead (as C-D2), paying its brokerage. Everything else as Phase 0 (B3, B4, windows, seed 20261025).
- **Also reported for C-D2 and T-D2 (registered now):** the result against B4 with the 5 and the 10 best non-expiry
  days removed (date order kept), and the share of the excess those days carry.

### Phase 0 — Amendment 2 (2026-10-28, owner, after every BL-133 / BL-134 result had been read)

- **Owner (2026-10-28):** 3 lots on expiry days, 4 on other days; "if you double, do you double whichever pick scores
  highest that day, or always the top Directional or always Widesl?", and add a new strategy or double one. The rule
  of the double is the new question; the "highest-scoring pick" rule was never run. Chosen knowing BL-133's results
  (Dir ×2 led both books; no T1 Widesl placement beat the even spread), so every reading below is descriptive.
- **Arms, both books, the same matrix** (non-expiry days; expiry days = B3 in every arm):
  - **R1×2:** the core pick with the highest list C composite at 2 lots, whatever its family (ties by name). New.
  - **D×2:** the Dir pick at 2 lots (a three-Widesl day: the best unpicked Dir added). = C-D2 / T-D2, re-run.
  - **W×2:** the higher-composite Widesl pick at 2 lots. = T-W1; new for Core (C-W1).
  - **D+:** the best unpicked Dir added as a fourth strategy. = C-D+; new for T1.
  - **W+:** the best unpicked Widesl added as a fourth strategy. = T-W+; new for Core.
- **Comparators:** B3, B4 as Phase 0.
- **Money:** gross = one-lot results × lots; brokerage = 2 orders × the stored `n_trades` × ₹20 × 1.18 once per
  strategy placed (lots of one strategy share orders), for every arm and comparator (B4 pays B3's brokerage); net =
  gross − brokerage. Turnover charges scale with lots and are left out alike.
- **Measures (net):** per day; annualised (× 250); max drawdown (`readout.max_drawdown`); worst day; share of losing
  days; return ÷ drawdown (annualised net ÷ |max drawdown|); daily mean ÷ sd × √250. Intervals (90 % circular block
  bootstrap, 5-day blocks, 2,000 resamples, seed 20261028): arm − B3, arm − B4, and, head to head, R1×2 − D×2,
  R1×2 − W×2 and D×2 − W×2. For R1×2: the share of non-expiry days whose top pick is a Dir, a Widesl, other; arm −
  B4 with the 5 and 10 best days removed (date order kept) and their share of the excess.
- **Windows:** as Phase 0 (2025-01-10 → 2026-10-16; last year 2025-10-09 → 2026-10-16). Days from 2026-10-19 belong
  to BL-135's forward test and are not replayed here.
- **Reading:** as Phase 0 ("earns its lot" if arm − B4 after brokerage is above zero); a doubling rule "beats"
  another if their difference is above zero. This amendment adds 5 new arm-book cells to BL-133's 7 (12 in all, plus
  BL-134's 2 books), so one interval clearing zero by chance is expected; nothing is adopted from it.
- **Look-ahead check:** as Phase 0; the composite of day d is built from results before d only.
- **Will not run:** 5+ lots, Buy, the expiry rule (BL-122), any day after 2026-10-16.

### Phase 0 — Amendment 2 (2026-10-28, owner, after every BL-133 / BL-134 result had been read)

- **Owner (2026-10-28):** 3 lots on expiry days, 4 on other days. If the fourth lot doubles a pick, which one:
  "whichever pick scores highest that day, or always the top Directional, or always the top Widesl"; and doubling
  vs adding a new strategy. The highest-score rule was never run. Chosen knowing BL-133's results (Dir ×2 led both
  books), so every reading below is descriptive.
- **What is traded, as the owner runs it (new to this item):**
  - **Book stop:** each book runs under a portfolio MTM stop, ₹8,000 for Core, ₹9,000 for T1, replayed per minute
    with `rotation/portfolio.py` (`apply_book` over `one_lot_path`, BL-095). On a 4-lot day the stop rises by the
    extra lot's own MTM SL (`overall.stop_loss_inr` of its strategy file; ₹4,000 if it has none). A pick's MTM SL
    is per lot on both platforms (owner), so a 2-lot pick = 2 × its one-lot path.
  - **Expiry rule (BL-122):** on a day exactly one index expires, list C takes only that index's strategies
    (`expiry.filter_picks`; runners-up from `expiry.filtered_runners_up`), applied on every expiry day of the window
    as if live throughout.
- **Arms, both books** (non-expiry days; expiry days = B3 in every arm):
  - **R1×2:** the core pick with the highest list C composite at 2 lots, whatever its family (ties by name). New.
  - **D×2:** the Dir pick at 2 lots (a three-Widesl day: the best unpicked Dir added). = C-D2 / T-D2.
  - **W×2:** the higher-composite Widesl pick at 2 lots. = T-W1; new for Core.
  - **D+ / W+:** the best unpicked Dir / Widesl added as a fourth strategy. New for T1 / Core respectively.
  - **Comparators:** B3 (3 lots as picked, book stop ₹8k / ₹9k); B4 = B3 × 4/3 on non-expiry days (the 3-lot paths
    and the stop scaled 4/3: a fourth lot on an average pick).
  - Each arm with the book stop (the main reading) and without it (as BL-133).
- **Both accounts together:** per day Core arm + T1 arm, for R1×2, D×2 and W×2, three ways: **both** (each book
  doubles by its rule, overlap ignored); **cut** (when T1's doubled strategy is the one Core doubles, T1 doubles its
  highest-composite other core pick instead); **skip** (on such a day T1 stays at 3 lots). Plus how often the two
  books double the same strategy.
- **Margin (no history of margin used exists):** per arm, the peak number of lots open at the same minute (a lot is
  open from its path's first change to its last), and the count of non-expiry days with 4 lots open at once. The
  owner's capacity (4 lots on non-expiry days) is taken as given.
- **Money:** gross from the replayed paths × lots; brokerage = 2 orders × the stored `n_trades` × ₹20 × 1.18 once per
  strategy placed (taken as stored even on a stopped day); net = gross − brokerage; turnover charges left out alike.
- **Measures (net):** per day; annualised (× 250); max drawdown (`readout.max_drawdown`); worst day; worst 5-day
  week; longest drawdown in days; mean of the worst 5 % of days; share of losing days; annualised net ÷ |max
  drawdown|; drawdown per lot (÷ mean lots per day); book-stop hit days. Intervals (90 % circular block bootstrap,
  5-day blocks, 2,000 resamples, seed 20261028): arm − B3, arm − B4, and R1×2 − D×2, R1×2 − W×2, D×2 − W×2. For R1×2:
  the share of non-expiry days its top pick is a Dir / Widesl / other. For R1×2 and D×2: arm − B4 without the 5 and
  10 best days, and their share.
- **Steadiness:** arm − B3 and arm − B4 (net, book stop) per calendar quarter, per VIX band of the day's open
  (`vix_band`) and per the day's lower days-to-expiry label, means and day counts (no intervals).
- **Windows:** as Phase 0 (2025-01-10 → 2026-10-16; last year 2025-10-09 → 2026-10-16). Days from 2026-10-19 belong
  to BL-135's forward test and are not replayed here.
- **Reading:** an arm "earns its lot" if arm − B4 (net, book stop) is above zero; a doubling rule "beats" another if
  their difference is above zero. This adds about 6 new arm-book cells to BL-133's 7 (with BL-134's), so one interval
  clearing zero by chance is expected; nothing is adopted from it.
- **Pass bar for going live (owner to confirm; judged forward, not here):** a 4-lot rule replaces 3 lots only if, on
  60 forward scored days, its net per day minus As picked has a 90 % interval above zero AND its drawdown per lot is
  no deeper than As picked's (BL-135's rule), with the book stop.
- **Look-ahead check:** as Phase 0; day d's composite is built from results before d only; the book stop level is
  known before the day (the strategy files' stops).
- **Will not run:** 5+ lots, Buy, any day after 2026-10-16. **Later, owner (2026-10-28):** on a one-index expiry day,
  4 lots when the extra lot is on the non-expiring index; run after this amendment is read.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl133/fourth_lot.py`; JSON; Log.
- **Done when:** the Log has every placement and comparator for both books and windows.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the placements).
- 2026-10-18 — **Run as registered** (`research/bl133/fourth_lot.py`; `fourth_lot_2026-10-18.json`). Gross per
  one-lot results × lots; 3 lots on expiry days (181 of 428 days; 104 of 244 in the last year), 4 on the others.
  "Extra lot" = placement − B3 per day (all days); "vs B4" = placement − the same extra size spread 4/3 over the picks.

  | Book, window | Arm | Per day | Max drawdown | Worst day | Extra lot (90 %) | vs B4 (90 %) | vs B4 after added brokerage |
  |---|---|---|---|---|---|---|---|
  | Core, two years | B3 / B4 | +1,216 / +1,332 | −35,457 / −45,741 | −10,532 / −12,547 | | | |
  | | **C-D2 Dir ×2** | **+1,494** | −38,550 | −13,098 | +277 [+143, +407] | **+161 [+28, +292]** | +149 [+14, +279] |
  | | C-D+ add a Dir | +1,359 | −40,565 | −13,219 | +143 [+3, +273] | +27 [−116, +169] | −43 [−188, +100] |
  | Core, last year | B3 / B4 | +1,393 / +1,505 | −31,486 / −38,622 | −9,919 / −12,099 | | | |
  | | **C-D2 Dir ×2** | **+1,744** | −32,815 | −11,986 | +351 [+196, +501] | **+239 [+100, +388]** | +230 [+90, +379] |
  | | C-D+ add a Dir | +1,672 | −34,439 | −12,096 | +279 [+129, +425] | +167 [+2, +333] | +98 [−68, +265] |
  | T1, two years | B3 / B4 | +1,885 / +2,103 | −23,300 / −30,526 | −13,809 / −18,412 | | | |
  | | T-W1 top Widesl ×2 | +2,071 | −32,943 | −19,510 | +186 [+59, +298] | −31 [−110, +47] | −31 [−110, +47] |
  | | T-W2 lowest Widesl ×2 (corrected) | +2,008 | −27,314 | −17,050 | +123 [+13, +229] | **−95 [−170, −17]** | −95 [−170, −17] |
  | | T-W+ add a Widesl | +1,973 | −30,867 | −19,026 | +88 [−23, +199] | **−129 [−234, −20]** | −185 [−291, −76] |
  | T1, last year | B3 / B4 | +2,100 / +2,363 | −23,300 / −27,903 | −13,809 / −18,412 | | | |
  | | T-W1 | +2,305 | −29,001 | −19,510 | +205 [+52, +345] | −58 [−159, +41] | −58 [−159, +41] |
  | | T-W2 (corrected) | +2,258 | −27,314 | −16,884 | +158 [+32, +285] | **−105 [−195, −18]** | −105 [−195, −18] |
  | | T-W+ | +2,169 | −30,867 | −19,026 | +68 [−82, +214] | **−194 [−318, −73]** | −250 [−374, −129] |

  **Read under the rule.** Core C-D2 (the Dir at two lots) **earns its lot** in both windows (vs B4 above zero, also
  after brokerage), with a drawdown between B3's and B4's. Core C-D+ is above zero against B4 on the last year only.
  T1's Widesl placements do not beat an even spread (T-W1 / T-W2 include zero; T-W+ costs). Every fourth lot adds
  money against 3 lots and deepens the drawdown and the worst day. Weaknesses: in-sample (days read by BL-115, BL-129
  and others; T1 overlaps its selection year), gross, turnover charges taken as equal across arms. Consistent with
  BL-129's per-pick means (Core: Dir +580 vs Widesl +227 / +409 per lot-day; T1: other pick +745 vs Widesl +470 /
  +670), which also suggests T1's Dir as a candidate for the fourth lot; that placement was not registered here.
- 2026-10-18 — **Review corrections (Opus, PR #254).**
  - **T-W2 fixed and re-run:** the code doubled the middle Widesl (`wide[1]`) instead of the registered lowest-ranked
    one, which differs on three-Widesl days (33 non-expiry T1 days). With `wide[-1]` (rows above corrected) T-W2
    **costs** against the even spread in both windows; the T1 reading is stronger: no Widesl placement beats it.
  - **Core C-D2 rests on a few days:** the top 5 non-expiry days carry 37 % of the two-year excess over B4, the top 10
    68 %. Without the top 5 (reviewer's check, days set to zero): +101 [−29, +225] (two years), +148 [+12, +289] (last year; the registered deletion in Amendment 1 gives +102 [−22, +229] / +151 [+14, +286]); without the top 10 both
    include zero. The last year sits inside the two-year window, so the two are not independent confirmations. By Dir
    family: Dir ITM1 picked on 155 days (mean excess +219), plain Dir on 46 (+606); removing either leaves the two-year
    interval including zero. Read C-D2 as a lead, not a finding.
  - Execution: doubling a one-lot result assumes the pick's overall stop doubles too (₹3,000 → ₹6,000 for Dir ITM1 at
    two lots); with the stop unchanged the live result would differ.
  - Wording: the "after brokerage" figures are +149 [+14, +279] and +230 [+90, +379]; C-D+ on the last year is above
    zero against B4 but not after brokerage (+98 [−68, +265]). "B4" = the 3-lot result × 4/3 on non-expiry days, a
    yardstick that cannot be traded (it equals placing the fourth lot on a random pick). "Two years" is 21 months.
    C-D2 − B4 is the Dir minus the mean pick each day, the comparison BL-129 already made on these days, so the
    agreement with BL-129 restates it rather than confirming it.
- 2026-10-18 — Amendment 1 committed before T-D2 was run: the owner's override for T1's Dir placement.
- 2026-10-18 — **Amendment 1 run** (T-D2, and the top-days checks for C-D2 and T-D2; same script and JSON).

  | Book, window | Arm | Per day | Max drawdown | Worst day | Extra lot (90 %) | vs B4 (90 %) | after brokerage | vs B4 w/o top 5 (share) | w/o top 10 (share) |
  |---|---|---|---|---|---|---|---|---|---|
  | T1, two years | **T-D2 Dir ×2** | +2,200 | −33,690 | −17,598 | +315 [+168, +456] | +98 [−20, +215] | +87 [−32, +205] | +33 [−84, +146] (66 %) | −20 [−135, +91] (120 %) |
  | T1, last year | **T-D2** | +2,513 | −24,811 | −13,734 | +413 [+246, +570] | **+150 [+27, +270]** | +141 [+17, +262] | +48 [−67, +162] (68 %) | −22 [−141, +88] (114 %) |
  | Core, two years | C-D2 | | | | | +161 [+28, +292] | +149 [+14, +279] | +102 [−22, +229] (37 %) | +52 [−76, +170] (68 %) |
  | Core, last year | C-D2 | | | | | +239 [+100, +388] | +230 [+90, +379] | +151 [+14, +286] (38 %) | +74 [−52, +201] (70 %) |

  **Read (descriptive; the arm was chosen after the first results).** T1's Dir at two lots earns the most of any T1
  placement (+315 / +413 a day over 3 lots), is above the even spread on the last year (+150 [+27, +270]) but not
  over the 21 months (+98 [−20, +215]), and its edge over the even spread is carried by a handful of days (the top 5
  give two-thirds of it; without the top 10 it is gone). Its drawdown over 21 months (−33,690) is as deep as T-W1's;
  on the last year it is near B3's. Core's Dir is the sturdier of the two (without its top 5 days +102 [−22, +229] / +151 [+14, +286]).
  Both say the same thing: the Dir is at least as good a home for the fourth lot as any other pick, and probably
  better, but not by a margin these days can pin down.
- 2026-10-28 — Amendment 2 registered before any run: which pick to double (top score, Dir, Widesl) and add vs double, both books.
- 2026-10-28 — Amendment 2 registered before any run: which pick the fourth lot doubles (top score, Dir, Widesl) or adds, with the book stop and the expiry rule, both books and both accounts together.

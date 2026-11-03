# BL-188 — Fixed 14:00 Dir cut with the strongest 14:02 Widesl, tested on unseen NIFTY 2022-24

| | |
|---|---|
| **Priority** | P1 — the one lead BL-187 left; the owner asked to run it (2026-10-29) |
| **Status** | Done 2026-10-29: **FAIL**, the lead is closed. On unseen NIFTY 2022-24 (T1-N, 618 pick days) the fixed 14:00 Dir cut with the strongest 14:02 Widesl reads −₹44 [−78, −12] net per margin lot-day, negative in both halves and every year; Core-N −₹11 [−42, +21]. The live capture has no Widesl entry after 13:17, so 14:00 slippage stays unmeasured. |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-29 |
| **Depends on** | BL-187 (the rule, its F1400 arm and the code in `research/bl187/`), BL-185 (A0, the Adaptive replay), BL-034 (NIFTY 2022-24 in the lake), BL-141 (the live capture) |
| **TODO.md row** | 3.10.51 |

## Context

BL-187 (2026-10-29) failed its registered rule, but its arm F1400 — cut the picked Dir at 14:00 and run
the strongest Widesl that starts at 14:02 — read +₹40 [−2, +82] net per margin lot-day on T1's 434
pick days, +₹50 [+7, +92] at ₹5 an order. That reading came from seen data with nine arms read, so it
is a lead only. The owner (2026-10-29): "Yeah, we can run that", on "register the fixed 14:00 cut with
the 14:02 Widesl as its own item, with the late-fill slippage measured from live capture first".

Two things settle it: what a late Widesl really costs to enter (BL-187's gain was gone at about ₹115
a swapped-in lot), and whether the rule holds on days nobody has looked at.

## Goal

(1) Measure the live entry slippage of Widesl copies from the live capture, by entry time. (2) Test
F1400 against the book as picked on NIFTY 2022-01-03 → 2024-10-08, which no Adaptive-book item has
read, with nothing re-tuned.

## Out of scope

The ranking, the picks, the Buy add-on, the book stops, the live plumbing. A pass starts nothing live;
it goes to the owner as a candidate.

## Plan

### Phase 0 — Pre-register (registered 2026-10-29, before any run; frozen)

**Slippage, measured first (descriptive).** Every Widesl copy in `obt rotation live-compare` over every
captured day (2026-10-21 → 2026-10-28): slippage per lot (live per lot − paper per lot, signed, + =
live did better), median and mean, by entry slot before 12:00, 12:00–13:59, 14:00 and later. Read
before the backtest (2026-10-29, Log): 23 Widesl copies over six days, all entering 10:17–13:17,
none at 14:00 or later, so the live capture cannot measure 14:00 slippage yet. The cost allowance of
the pass rule therefore stays at BL-187's ₹300 a swapped-in lot, set before this read and not moved.

**Data (the clean set).** NIFTY only, 2022-01-03 → 2024-10-08: the 681 weekdays with option and index
bars that `data_quality` does not exclude. Every NIFTY variant of Core-298 (149) and of T1's 223 extras
(173) simulated over it with the same engine, sizing (`lot_sizing: current`, sizing date 2026-10-12),
reference fallback (`research/common/early_ref.py`) and charges (`ruletest/charges.py`, ₹13 an order,
the day's own STT) as BL-185's A0 — the **N22 set**, one CSV a variant, git-ignored, built by
`research/bl188/n22.py`. Day attributes: weekday, the 09:15 India VIX open and its band
(`rotation/attrs.py`), NIFTY's days to the nearest listed expiry on the weekday basis (`dte.py`);
SENSEX's label is a constant (no SENSEX variant is in the pool).

**Books.** Two NIFTY-only books: **T1-N** (all 322 NIFTY variants; primary) and **Core-N** (the 149;
reported, never decides). List C's composite on gross, `score.select` (three core picks, Widesl
minimum two), 63-day warm-up, no Buy add-on, no expiry-only rule — BL-187's replay unchanged, on this
pool. Per margin lot-day = book ÷ 3. **B** = the three picks to their own exits.

**The rule (F1400, from BL-187, unchanged).** On a day whose picks hold a Dir that enters before
14:00: the Dir's `exit_time` becomes 14:00 (engine re-run, nothing else changed) and the strongest
Widesl by the same morning composite among the 14:02 slots, not already picked, is added at 1 lot and
held to its own exit. Otherwise the day is as picked. Beside it, descriptive only: BL-187's R14 (the
strongest Widesl from 14:02, the Dir cut two minutes before it) and X14 (R14's cut, nothing added).

**Pass rule (F1400 − B, T1-N).** All of: (a) the 90 % lower bound is above zero over all pick days
(circular 5-day block bootstrap, 2,000 resamples, seed 20261028); (b) the point estimate is above zero
in each half of the pick days (split at the middle pick day); (c) F1400's max drawdown (net,
cumulative per margin lot-day) is no deeper than B's; (d) the point estimate is still above zero with
₹300 charged per swapped-in Widesl. Pass = a candidate for the owner; fail = the lead is closed.
Reported beside: net at ₹5 and ₹20 an order, ₹100 allowance, by expiry day, by year, Core-N.

**Parity gates (before any arm is read).** (1) The N22 rows for 2024-10-09 → 2024-10-31 (simulated
past the end for this check only) equal A0's rows for the same variants and days (gross within ₹1,
orders equal). (2) The day attributes computed for 2024-10-09 → 2026-10-27 the same way equal the
stored `rotation/days.csv` (band and NIFTY label) on every stored day. (3) BL-187's cut gates (original
exit reproduces N22; the cut curve is identical before the cut) on 20 sampled Dir picks. A failed gate
stops the item until fixed and logged.

**Red-team.**
- *Look-ahead:* the picks and the Widesl come from the morning composite (history before the day); the
  14:00 cut is fixed; nothing of the afternoon is read to choose.
- *Survivorship:* none; every variant is a fixed file, simulated on every day.
- *Data-snooping:* the rule was found on 2025-26 data (BL-187) and is carried over unchanged; N22 is
  read for the first time by an Adaptive book. One primary arm. The 2022-24 data were used before only
  as a confirmation set for intraday triggers (BL-083) and for single strategies, never for this rule.
- *Different market:* 2022-24 NIFTY had Thursday weekly expiries, higher VIX in 2022, and a smaller
  lot (the run uses today's lot on every day, as AlgoTest does); vendor 1-minute data (BL-034), no
  spread. Read as a different regime, which is the point of a clean test.
- *Not modelled:* book stops, the Buy add-on, the expiry-only rule, real 14:00 spreads (the allowance).

### Phase 1 — Build the N22 set and its gates (shared with BL-189 and BL-190)
`research/bl188/n22.py` (simulate, day attributes, the parity gates). Done when the gates pass.

### Phase 2 — Run, read, record
F1400 on T1-N and Core-N; findings pages (`directional/exit-time.md`, `widesl/entry-time.md`); item
closed.

## Result (2026-10-29)

Gates passed before any arm was read (Log; cut gates 20 of 20 on each book). The seen-set rows
reproduce BL-187 exactly (F1400 +40, R14 +32 on T1), a check on the code. Per margin lot-day (book ÷ 3),
net after ₹13 an order, 90 % 5-day block bootstrap.

**T1-N, NIFTY 2022-04-05 → 2024-10-08 (618 pick days; the primary test)**

| Arm | Net | Gross | Swap days | Max drawdown | Arm − B net | +₹300 a swapped Widesl |
|---|---|---|---|---|---|---|
| B (as picked) | +213 | +314 | 0 | −18,045 | | |
| **F1400** | +169 | +289 | 487 | −16,639 | **−44 [−78, −12]** | −123 [−158, −90] |
| R14 (BL-187's rule) | +180 | +300 | 490 | −16,093 | −33 [−61, −7] | −112 [−141, −86] |
| X14 (cut, nothing added) | +147 | +245 | 490 | −20,498 | −66 [−87, −44] | |

- **Pass rule (F1400, T1-N):** (a) lower bound above zero: no (−78); (b) above zero in both halves: no
  (−38, −50); (c) drawdown no deeper: yes (−16,639 against −18,045); (d) above zero with ₹300: no.
  **FAIL.** By year −8 (2022), −60 (2023), −58 (2024); expiry days −70, other days −37. At ₹5 an order
  −35 [−69, −4].
- **Core-N:** F1400 − B −11 [−42, +21], R14 −12, X14 −46 [−68, −24]. FAIL.
- **Same shape as BL-187, different sign:** cutting the Dir's last hour again loses (−66 T1-N, −46
  Core-N, as −43 on 2025-26), but in 2022-24 the late Widesl added earned too little to cover it (R14 − X14
  +33 on T1-N against +75 on 2025-26).
- **Slippage:** 23 live Widesl copies over 2026-10-21 → 28, all entering 10:17–13:17: live minus paper
  median −₹6.5 a lot, mean −₹100 (two stop fills of −₹3,608 and +₹1,703). Nothing after 14:00, so the
  ₹115 break-even of BL-187 can be neither confirmed nor ruled out live.

**Reading.** BL-187's afternoon swap was a 2025-26 effect. On days that no book rule had been tried on
it loses, before any late-fill cost. Not adopted; the lead is closed.

## Risks

- The 2022-24 vendor data may differ from Fyers data in ways the gates do not see; the gates check the
  engine and attributes, not the vendor.
- 14:00 slippage stays unmeasured until the owner trades a late Widesl live.

## Open questions

None blocking.

## Log

- 2026-10-29 Registered (Phase 0) before any run. Owner: "Yeah, we can run that."
- 2026-10-29 Slippage read (before the backtest): `obt rotation live-compare` over 2026-10-21 → 2026-10-28 has 23 Widesl copies (Quantiply and AlgoTest), all entering 10:17–13:17; none at 14:00 or later. Per lot, live minus paper: median about −₹7, mean dragged by single copies of −₹3,608 and +₹1,703 (stop fills). The live capture cannot measure 14:00 slippage yet; the ₹300 allowance stands as registered.
- 2026-10-29 Phase 1: the N22 set built (`research/bl188/n22.py`): 322 NIFTY variants × 699 days (2022-01-03 → 2024-10-31), no variant-day dropped; 682 attribute days to 2024-10-08 (the first count of 681 missed one; the set is what `backtest_days` returns). Gates: (1) 5,474 variant-days 2024-10-09 → 2024-10-31 equal A0 (largest gross difference ₹0.00); (2) band and NIFTY label equal the stored `days.csv` on all 500 stored days. PASS. Shared code for BL-188/189/190 in `research/common/books.py`.
- 2026-10-29 Phase 2: F1400 FAIL on T1-N (−44 [−78, −12]) and Core-N; the seen set reproduces BL-187. Findings pages updated. Item closed.
- 2026-10-29 Correction to the red-team, after the run: NIFTY 2022-04-05 → 2024-10-08 is BL-071's hold-out P3, and BL-075 kept list C's weight cell partly because it was above chance there, so the ranking itself has seen P3. The book rules tested here had not been run on it. No rule or verdict changes.

# BL-190 — When a pick is stopped out early, start the strongest later strategy in its place

| | |
|---|---|
| **Priority** | P1 — the owner asked; frees a margin lot on stopped days |
| **Status** | Done 2026-10-29: **FAIL** for both. A pick finished by 12:15 (96 replacements over T1's 434 pick days, 129 on Core) replaced by the strongest later Widesl reads −₹9 [−56, +38] (95 %) net per margin lot-day on T1, by the strongest Dir −₹10 [−55, +35]; both deepen the drawdown (−10,010 / −11,371 against −8,536). On NIFTY 2022-24 both are slightly positive (+₹9, +₹7); Core-N's Dir replacement +₹35 [+3, +74] (90 %) is the only interval above zero. |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-29 |
| **Depends on** | BL-185 (A0, the Adaptive replay), BL-188 (the N22 set), BL-187 (the swap code) |
| **TODO.md row** | 3.10.53 |

## Context

The owner (2026-10-29): if a Dir or Widesl is stopped out in the first two or three hours, should we
take another in its place? Answers: try both a strong Dir and a strong Widesl as the replacement; the
stop counts if it is by 12:15, with 11:15 beside.

## Goal

Measure, per margin lot-day after charges, the book in which a pick that is finished by 12:15 is
replaced by the strongest later strategy, against the book as picked.

## Out of scope

Chains (a replacement is never replaced), the Buy add-on, the book stops, the ranking, live plumbing.

## Plan

### Phase 0 — Pre-register (registered 2026-10-29, before any run; frozen)

**Books and data.** As BL-189: seen set A0 (T1 primary, Core), 434 pick days; clean set N22 (T1-N,
Core-N). Picks as BL-187/188. Per margin lot-day = book ÷ 3 (the stopped pick's lot is the
replacement's lot).

**Finished (no look-ahead).** A pick is *finished* at minute t when, from its own trades: the overall
stop or target closed it at t; or every leg has been stopped (SL / TRAIL / TARGET) as many times as it
can enter (1 + its re-entry count) and t is the last of those exits. A leg that could still re-enter
is not finished, even if it never does; an `EXIT_TIME` or `ROLL` exit is not finished. This is known at
t from what has happened by t. Each pick is re-simulated to get its trades (gate below).

**The replacement.** For a pick finished at t ≤ 12:15 (window **12**; window **11**: t ≤ 11:15), the
replacement is the variant with the highest composite (same morning ranking) among those of the given
kind whose entry slot is at least two minutes after t, that is not one of the day's picks or an
earlier replacement. It runs at 1 lot from its slot to its own exit; its stored row is used. If none
exists the pick is not replaced. Several picks finished on the same day are replaced in the order they
finished.

**Arms.** **B** as picked. **RW12**: replacement = the strongest Widesl. **RD12**: the strongest Dir.
**RF12**: same kind as the stopped pick (descriptive). **RW11, RD11**: window 11. **PW12, PD12**: the
average over every eligible Widesl / Dir instead of the strongest (does the ranking matter?).

**Pass rule (each of RW12 and RD12 against B, T1).** Two primary arms, so each needs a **95 %**
interval: (a) the 95 % lower bound of arm − B is above zero on the seen set (circular 5-day block
bootstrap, 2,000 resamples, seed 20261028); (b) arm − B is above zero in point estimate on the clean
set (T1-N); (c) the arm's max drawdown on the seen set is no deeper than B's; (d) on the seen set arm
− B is still above zero with ₹100 charged per replacement (replacements enter 09:47–14:00; the live
capture's midday Widesl copies show a median near zero with a wide spread, BL-188 Log). An arm that
passes is a candidate for the owner; if both pass, the larger seen-set mean.

Reported beside: replacement count per book and window; finish reasons (overall stop, legs) and kinds;
the replaced pick's day net and the replacement's; ₹300 allowance; ₹5 / ₹20 an order; periods; Core.

**Parity gate.** The re-simulated picks reproduce their stored rows (gross within ₹1, orders equal) on
every pick re-simulated. A failure stops the item.

**Red-team.**
- *Look-ahead:* the finish minute uses only exits up to t and the strategy's own re-entry allowance;
  the replacement comes from the morning composite; its row starts at its slot, after t.
- *Survivorship:* none.
- *Data-snooping:* new question on both sets; two primaries corrected by the 95 % interval; the seen
  set overlaps the data Adaptive was built on, the clean set does not.
- *Selection effect:* stopped days are volatile days; a replacement after a stop sells into a moving
  market. That is the question, not a bias.
- *Not modelled:* book stops (a book stop may already have ended the day), margins, spreads.

### Phase 1 — Build, gate, run, record
`research/bl190/run.py`; findings page `research/options/common/` (re-entry after a stop); closed.

## Result (2026-10-29)

Parity: every pick re-simulated equals its stored row (1,302 per seen book, 1,854 per clean book;
largest gross difference ₹0.00). Per margin lot-day (book ÷ 3), net after ₹13 an order.

How often: picks finished by 12:15 (no entry left): T1 96 of 1,302 (Widesl by the overall stop 68,
legs 4; Dir by the overall stop 16, legs 8); Core 129; T1-N 74 of 1,854; Core-N 102. The stopped
pick had already lost about ₹3,000–3,450 a lot by then.

| Arm − B (net) | T1 2025-26 (primary, 95 %) | Core 2025-26 (90 %) | T1-N 2022-24 (90 %) | Core-N 2022-24 (90 %) |
|---|---|---|---|---|
| **RW12** strongest Widesl, stop by 12:15 | **−9 [−56, +38]** | +10 [−19, +40] | +9 [−8, +25] | +7 [−16, +29] |
| **RD12** strongest Dir, stop by 12:15 | **−10 [−55, +35]** | −25 [−73, +20] | +7 [−19, +34] | +35 [+3, +74] |
| RF12 same kind as the stopped pick | −1 | +11 | +8 | +13 |
| RW11 / RD11 stop by 11:15 | −25 / −29 | −4 / −31 | −1 / −2 | −6 / +30 |
| PW12 / PD12 a random eligible one | +4 / +4 | +8 / +7 | +7 / +4 | +2 / +14 |

- **Pass rule (T1):** RW12: (a) no (−56), (b) yes (+9), (c) no (−10,010 against −8,536), (d) no (−16 at
  ₹100). RD12: (a) no, (b) yes (+7), (c) no (−11,371), (d) no (−18). **Both FAIL.**
- **What the replacement earns** (₹ a lot, net): T1 Widesl −119, Dir −138; Core Widesl +106, Dir −249;
  T1-N Widesl +235, Dir +165; Core-N Widesl +123, Dir +640. A day with a pick stopped out by noon is
  a moving day, and a fresh short entry earns about the average or less.
- **The ranking does not help here:** the strongest replacement does no better than a random eligible
  one (PW12 / PD12 within ₹10 of RW12 / RD12 or above them on T1).

**Reading.** Replacing a stopped pick adds nothing on the book the owner trades and makes the worst
run deeper, because a second short on a day that already stopped one out is exposed to the same move.
Not adopted.

## Risks

Few replacements in window 11; Dir replacements late in the morning may be few.

## Open questions

None. Owner (2026-10-29): replacement both a strong Dir and a strong Widesl; window 12:15, 11:15 beside.

## Log

- 2026-10-29 Registered (Phase 0) before any run; the owner's answers recorded.
- 2026-10-29 Phase 1 run: RW12 and RD12 FAIL. Findings page updated. Item closed.
- 2026-10-29 Correction to the red-team, after the run: NIFTY 2022-04-05 → 2024-10-08 is BL-071's hold-out P3, and BL-075 kept list C's weight cell partly because it was above chance there, so the ranking itself has seen P3. The book rules tested here had not been run on it. No rule or verdict changes.
- 2026-10-29 Code review of PR 386: N22 gate 1 now also fails on an A0 day missing from N22 (re-run: 0 missing, PASS); an overall target is labelled as such (no variant has one); `run_jobs` refuses a tagged job without `path_of`; this status line counts replacements, not days; the re-entry pages for Widesl and Dir now cite this item. Not changed: BL-188's cut gate still samples the 14:00 cut only (R14 / X14 are descriptive); the seen-set ranking is still computed per driver.

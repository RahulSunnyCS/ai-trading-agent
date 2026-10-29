# BL-189 — Strictly two Widesl and one Dir every day, or keep "at least two Widesl"?

| | |
|---|---|
| **Priority** | P1 — decides the shape of the book the owner trades every day |
| **Status** | Done 2026-10-29: **keep the rule as it is** (at least two Widesl, a third allowed). Forcing a Dir in on three-Widesl days costs T1 −₹55 [−97, −18] net per margin lot-day on 2025-26 (the third Widesl earned +₹1,168 a lot on those 68 days, the best Dir +₹119); on NIFTY 2022-24 T1-N is level (+₹4 [−19, +29]) and Core-N favours the strict rule (+₹66 [+36, +100]). |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-29 |
| **Depends on** | BL-185 (A0, the Adaptive replay), BL-188 (the N22 set, NIFTY 2022-24), BL-113 (T1) |
| **TODO.md row** | 3.10.52 |

## Context

`score.select` takes the three best-ranked Widesl/Dir variants and, if fewer than two are Widesl, swaps
the lowest-ranked Dir for the next Widesl (`MIN_WIDE_N = 2`). So a day can have two Widesl and a Dir,
or three Widesl (when no Dir ranks in the top three), never two Dirs. The owner (2026-10-29): "do we need
to keep some minimum for Widesl also, like strictly there will be two Widesl and one directional every
day? Or should we keep as it is now, minimum two Widesl, if it is more than two also it's fine, which
is better?"

## Goal

Measure, per margin lot-day and after charges, the book with exactly two Widesl and one Dir every day
against the book as picked.

## Out of scope

Two Dirs a day; the Buy add-on; the ranking itself; the live plumbing.

## Plan

### Phase 0 — Pre-register (registered 2026-10-29, before any run; frozen)

**Books and data.** Seen set: BL-185's A0, 434 pick days 2025-01-10 → 2026-10-27, books **T1**
(521 variants, primary) and **Core** (298). Clean set: BL-188's N22, NIFTY 2022-01-03 → 2024-10-08,
books **T1-N** (322) and **Core-N** (149). Picks as BL-187/188 (list C on gross, `select`, no Buy
add-on, no expiry-only rule). Per margin lot-day = book ÷ 3.

**Arms.** **B**: as picked. **S21** (strict): on a day whose three picks are all Widesl, the
lowest-composite Widesl is replaced by the best-composite Dir of the pool; every other day is
unchanged. So the two books differ only on three-Widesl days, and the difference on those days is
"the best Dir" minus "the third Widesl".

**Pass rule (adopt S21, T1).** All of: (a) S21 − B has a 90 % lower bound above zero on the seen set
(434 days, circular 5-day block bootstrap, 2,000 resamples, seed 20261028); (b) S21 − B is above zero
in point estimate on the clean set (T1-N); (c) S21's max drawdown on the seen set is no deeper than
B's. Otherwise the rule stays as it is. The reverse (B clearly better) is reported in the same
numbers and needs no rule: it is what runs today.

Reported beside: the number of three-Widesl days per book; on those days, the third Widesl's and the
best Dir's net (the days themselves, not an interval); by expiry day (either index's label `0`) and by
VIX band; net at ₹5 and ₹20 an order; each period (seen: to 2025-10-08 / after; clean: halves); Core
and Core-N.

**Red-team.**
- *Look-ahead:* the strict pick uses the same morning composite; nothing after the decision.
- *Survivorship:* none.
- *Data-snooping:* the minimum of two was set when Adaptive was built (BL-058) on data overlapping the
  seen set, so the seen set favours the current rule if anything; the clean set is read for the first
  time by this question. Only ~16 % of days differ (68 of 434 on T1, counted from A0's picks while
  planning BL-187), so the interval will be wide: a non-pass most likely means "no evidence to change",
  not "B is better".
- *Not modelled:* book stops, margins (a Dir's margin is not a Widesl's), the expiry-only rule.

### Phase 1 — Run, read, record
`research/bl189/run.py` on both sets; findings page `research/options/common/` (book shape); closed.

## Result (2026-10-29)

Per margin lot-day (book ÷ 3), net after ₹13 an order, 90 % 5-day block bootstrap. The books differ
only on three-Widesl days.

| Book | Days | Three-Widesl days | B net | S21 net | S21 − B | B drawdown | S21 drawdown |
|---|---|---|---|---|---|---|---|
| **T1, 2025-26 (seen; primary)** | 434 | 68 (16 %) | +505 | +451 | **−55 [−97, −18]** | −8,536 | −8,860 |
| Core, 2025-26 | 434 | 78 (18 %) | +298 | +273 | −25 [−69, +18] | −13,788 | −13,355 |
| T1-N, NIFTY 2022-24 (clean) | 618 | 120 (19 %) | +213 | +217 | +4 [−19, +29] | −18,045 | −15,205 |
| Core-N, NIFTY 2022-24 | 618 | 127 (21 %) | +222 | +288 | +66 [+36, +100] | −8,843 | −6,208 |

- **Pass rule (adopt S21):** (a) T1 lower bound above zero: no (the whole interval is below zero);
  (b) T1-N above zero: yes (+4); (c) drawdown no deeper on T1: no. **Keep as it is.**
- **On the three-Widesl days, ₹ a lot, net:** T1 2025-26: third Widesl +1,168, best Dir +119 (the Dir better on
  40 %); T1-N 2022-24: +108 against +170 (50 %); Core-N 2022-24: −221 against +736 (58 %). The third
  Widesl that outranks every Dir earned well in 2025-26 and badly in Core-N's 2022-24.
- **Expiry days** are where forcing the Dir hurts most in every book but Core-N (T1 −2,126 a lot over
  35 days; T1-N −920 over 18); on other days the Dir is level or better (T1 +92, T1-N +235, Core-N
  +904). Descriptive, small subsets, not tested.

**Reading.** On the book the owner trades (T1) the current rule is better, with an interval wholly on
its side; on 2022-24 it is level for T1. Only Core-N in 2022-24 says otherwise. No change.

## Risks

Small number of differing days; the answer may be "can't tell".

## Open questions

None. Owner confirmed the reading (2026-10-29): today's rule vs strict two Widesl + one Dir.

## Log

- 2026-10-29 Registered (Phase 0) before any run; the reading confirmed by the owner.
- 2026-10-29 Phase 1 run: keep as it is (S21 − B −55 [−97, −18] on T1). Findings page updated. Item closed.
- 2026-10-29 Correction to the red-team, after the run: NIFTY 2022-04-05 → 2024-10-08 is BL-071's hold-out P3, and BL-075 kept list C's weight cell partly because it was above chance there, so the ranking itself has seen P3. The book rules tested here had not been run on it. No rule or verdict changes.

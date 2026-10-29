# BL-190 — When a pick is stopped out early, start the strongest later strategy in its place

| | |
|---|---|
| **Priority** | P1 — the owner asked; frees a margin lot on stopped days |
| **Status** | In progress — Phase 0 registered 2026-10-29, before any run |
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

## Risks

Few replacements in window 11; Dir replacements late in the morning may be few.

## Open questions

None. Owner (2026-10-29): replacement both a strong Dir and a strong Widesl; window 12:15, 11:15 beside.

## Log

- 2026-10-29 Registered (Phase 0) before any run; the owner's answers recorded.

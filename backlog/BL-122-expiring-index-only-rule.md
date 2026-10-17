# BL-122 — Expiring-index rule: on a single-index expiry day Adaptive takes only that index's strategies

| | |
|---|---|
| **Priority** | P1 — a change to the live picks (and the T1 track) from Mon 2026-10-19 09:16, adopted by the owner |
| **Status** | In progress — built 2026-10-18; first rule day Mon 2026-10-19 (a moved NIFTY expiry) |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-111 (Amendment 1, H3, PR #240), BL-058 (the live journal and read-out), BL-113 (the T1 parallel track) |
| **TODO.md row** | 3.10.30 |

## Context

BL-111 Amendment 1 (PR #240) registered and ran H3, the expiring-index-only basket: on an expiry
day, Adaptive (list C) drawn only from the expiring index's variants, as a filter of the
unrestricted ranking. Exploratory and in-sample (2025-01-10 → 2026-10-08, 179 expiry days, no day
with both indices expiring). On the days where the basket changes, EXP minus the unrestricted list,
per lot-day gross, 90 % circular block bootstrap:

| Universe | Days differing | Mean per lot-day | Interval |
|---|---|---|---|
| Core-298, both indices | 53 of 179 | +₹427 | [+112, +733] |
| T1, both indices | 48 of 179 | +₹513 | [+259, +781] |

The research item said nothing would be adopted from it (exploratory, ~50 informative days, no
confirmation period, net of charges not computed). The owner, 2026-10-18 (chat): **"Let's add this
as a rule to production."**

## Goal

The rule, exactly:

- **Expiry day for an index:** its days-to-expiry label is `0` on the weekday basis (BL-109):
  `dte_n == '0'` for NIFTY, `dte_s == '0'` for SENSEX, from the same labels the 09:16 entry records.
- **The rule applies** when exactly one index expires. Both, neither, or either label not known
  (`unknown`) = no rule (the list stays unrestricted; with an unknown label it cannot be shown that
  only one index expires).
- **Adaptive (list C) only**, in the live journal and in the T1 parallel track (`pick --track t1`),
  through the same code path. Lists A, B and REF are recorded unfiltered, exactly as before (they
  are not followed).
- **A filter, not a re-ranking** (as in H3): the composite is computed over the full universe exactly
  as before; `score.select` then runs over the expiring index's variants only (top 3 by composite,
  Widesl minimum of 2 kept). Re-ranking over the restricted set would change picks even when the
  basket is already all from the expiring index.
- **Buy add-on:** the unrestricted list's Buy is kept only when it already is a variant of the
  expiring index. It is never replaced by another Buy (H3 had no Buy add-on; this keeps the add-on's
  own rule — top 10 overall — untouched).
- **The Next best, optional line** on a rule day names only the expiring index's variants.

**Effective date:** Mon 2026-10-19 09:16 (`rotation/expiry.py::EXPIRY_ONLY_FROM`). Every day
before it is unchanged: entries, re-scores and reconstructed history.

**Kill switch:** `ROTATION_EXPIRY_ONLY_FROM`, read at call time: `YYYY-MM-DD` moves the start, `off`
disables the rule. Any other value makes `obt rotation pick` fail loudly (not recorded + the error
alert) rather than silently recording the old rule.

**What is logged, so the old rule stays measurable:** on a rule day the entry carries a top-level
`expiry_only: "NIFTY" | "SENSEX"`, and list C's block carries `expiry_only` and
`unfiltered: {core, buy}` — the picks the unrestricted list would have recorded. On every other day
neither field exists, so those entries are byte-for-byte what they were. The fields are part of the
hashed entry content; `journal.py` hashing is unchanged.

## Out of scope

- Lists A, B, REF; the fixed base.
- Re-scoring past days under the rule: the daily log's reconstruction, research replays and the
  read-outs' reconstructed rows stay unfiltered for all past days.
- A day with both indices expiring (none in the window; left unrestricted).
- Net of charges (needs the BL-096 per-trade model).

## Plan

### Phase 1 — Build (done 2026-10-18)
- **Tasks:** `rotation/expiry.py` (`EXPIRY_ONLY_FROM`, the switch, `expiring_index`, `rule_index`,
  `filter_picks`, `filtered_runners_up`); `pick.score_history(..., expiry_only=None)` and
  `pick.next_best(..., expiry_only=None)` (default = unchanged); `pick.record` passes
  `rule_index(day, dte)` and writes `expiry_only`; `pick.render` adds one line,
  `Expiry rule (NIFTY): only NIFTY strategies`; everything that re-derives a recorded pick applies
  the entry's `expiry_only` (`daylog._rescore`, `explain.explain` — payload `expiry_rule` with the
  unfiltered picks —, `rankic.day_row`); `tomorrow.expected_picks` uses `rule_index(next session)`
  for its picks, likelihoods, scenarios and next best, and says so in one line; the daily log's
  list block passes `expiry_only` / `unfiltered` through when present; `obt rotation show` marks a
  rule day.
- **Deliverables:** `tests/unit/test_rotation_expiry.py`; docs (`packages/option-backtesting/CLAUDE.md`,
  `.claude/project/technical.md`, the Rotation guide pages).
- **Done when:** the suite passes; a read-only dry run on the real store for Mon 2026-10-19 (live and
  T1) records NIFTY-only Adaptive baskets with the rule line, and a dry run for Fri 2026-10-16 gives
  exactly the journal's entry.

### Phase 2 — First rule days
- **Tasks:** check the 2026-10-19 09:16 entries (live and T1): `expiry_only: NIFTY`, Adaptive all
  NIFTY, `unfiltered` present, `obt rotation verify` intact; the evening result reports the
  recorded picks; the daily log's re-score says `same_picks`.
- **Done when:** the first NIFTY and the first SENSEX rule day each recorded and scored cleanly.

## Risks

- **The forward read-outs now span a rule change.** BL-058's 60-day read-out (live Adaptive) and
  BL-113's (T1 minus live) began on 2026-10-12 / 2026-10-19 under the unrestricted rule; from
  2026-10-19 Adaptive's expiry days are filtered. The journal's `expiry_only` field marks every
  filtered day: read the read-outs on the filtered days and their `unfiltered` counterparts as well
  as in total. T1 and live both follow the rule, so BL-113's comparison stays like for like.
- **2026-10-19 is a moved NIFTY expiry day** (Tuesday 20 Oct is a holiday), so the first rule day's
  basket is NIFTY-only; BL-121 (on its research branch, not merged) found no evidence that
  moved-expiry days earn less, on only 11 days. T1's forward read-out begins on this same day.
- **The evidence is thin:** ~50 informative days, in-sample, exploratory, no confirmation period,
  net of charges not computed. The rule is the owner's decision, not a research result; the logged
  `unfiltered` picks let it be measured forward.
- **A bad switch value** stops the 09:16 pick (loud by design); `off` restores the old rule at once.

## Open questions

- None at build time. Whether to keep the rule after the forward read-out is the owner's call.

## Log

- 2026-10-18 — created and built. `override: owner request 2026-10-18 (chat: "Let's add this as a
  rule to production")` adopting BL-111 Amendment 1's exploratory, in-sample H3 result (Core +₹427,
  T1 +₹513 per lot-day on the ~50 differing days), which the research item had said would adopt
  nothing. Effective Mon 2026-10-19 09:16, live and T1 track; lists A, B, REF unchanged; the
  unfiltered picks are recorded on every rule day.
- 2026-10-18 — read-only dry run on the real store (`--day 2026-10-19 --vix-open 14.01`, live and
  `--track t1`): DTE NIFTY 0 / SENSEX 3 from the symbol master; both Adaptive baskets NIFTY-only with
  the `Expiry rule (NIFTY)` line (live: unfiltered had two SENSEX picks; T1: two SENSEX picks).
  A dry run for Fri 2026-10-16 reproduced the journal entry exactly (same lists, same `inputs_sha`).

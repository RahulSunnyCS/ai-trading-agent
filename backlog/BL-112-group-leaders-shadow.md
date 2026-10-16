# BL-112 — Group Leaders: run Adaptive on the best-setting-per-group pool as a forward shadow beside Core

| | |
|---|---|
| **Priority** | P1 — the owner will follow only Adaptive and wants two universes side by side |
| **Status** | Planned |
| **Type** | feature + research |
| **Area** | options |
| **Created** | 2026-10-16 |
| **Depends on** | BL-106 (pool definition and result; PR #231), BL-058 (the lists, the journal and its read-out rule) |
| **TODO.md row** | — |

## Context

Owner (2026-10-16): from now on only **Adaptive** (list C) is followed; the dashboard and Telegram show
only Adaptive. Two universes remain: the live **Core** (the 298 variants, "Core-298" in the research)
and a new pool the owner wants a generic name for. Chosen name: **Group Leaders**: for each group
(strategy family × index × time band) the setting that did best over the pool's selection year, one
fixed set per group, applied at every entry time of its band. The research pool BL-106 called
"New-556" is Group Leaders v1.

What BL-106 found for Adaptive over the 239 test days (2025-10-09 → 2026-10-09, gross, per lot):

| Universe | ₹ per lot-day | Max drawdown | Difference vs Core [90% interval] |
|---|---:|---:|---|
| Core-298 | 393 | −10,089 | |
| Group Leaders v1 (New-556) | 324 | −8,565 | −69 [−258, +111] |

No list passed the registered rule: every interval straddles zero and is about ±₹200 a day wide.
Group Leaders has the shallower drawdown and the lower gross return for Adaptive; twelve months cannot
separate differences that small. A forward shadow is the way to find out.

The dashboard names "Core" for the 298 (not "Base": "base" already means the fixed comparator basket).

## Goal

From the commit date, record every day what Adaptive would have picked from Group Leaders (a
hash-chained shadow journal separate from the live one), score it every evening, show it beside Core
on the dashboard, and read it out after 60 on-time days by the rule below.

## Out of scope

- Changing what is traded: Core stays the live universe; the shadow places no orders and sends no
  Telegram unless the owner asks.
- Re-selecting the pool during the test, changing Adaptive's weights or lookbacks, other lists.
- SENSEX Buy decisions beyond what the pool already contains.

## Plan

### Phase 0 — Pre-register (committed before the first shadow day)

- **Hypothesis:** Adaptive choosing from Group Leaders v1 earns at least as much net per lot-day as
  Adaptive choosing from Core, with a drawdown no deeper.
- **Pool, frozen:** Group Leaders v1 = BL-106's New-556 exactly (the 91 + 3 sets and their 556
  variants, selected from 2024-10-09 → 2025-10-08 only). The set files' hashes are recorded in the
  shadow journal's first entry. No re-selection, no edits, until a new dated version (v2) is
  registered with its own selection window; v1 and v2 are never mixed in one read-out.
- **List:** Adaptive (C) with its registered weights and 5 / 21 / 63 / 126-day lookbacks, using the
  same `score_history` as the live picker; history from the pool's own stored results (BL-106's
  replay history for the lookbacks, then daily).
- **Look-ahead check:** the shadow pick at 09:16 uses only results before the day and the 09:15 VIX
  open, the same inputs as the live pick; its recorded time is checked like the live journal's
  (late entries are marked and not forward).
- **Read-out (after 60 on-time shadow days, as BL-058):** net ₹ per lot-day after charges (BL-063
  model) and maximum drawdown per lot, Group Leaders minus Core on the same days, 90% circular
  block bootstrap (5-day blocks, 2,000 resamples, seed 20261012). **Adopt as the traded universe
  only if** the interval's lower bound is above zero **and** the drawdown is no worse; otherwise Core
  stays. A "no worse" outcome is reported as inconclusive, not as a win.
- **Will not run:** a mid-test pool change, other lists, a different window, any decision before 60
  days. Each needs a new dated block and `override: <reason>`.

### Phase 1 — Daily results for the 556 variants
- **Tasks:** generate the 556 variant YAMLs from the pool files into their own folder (never under
  `strategies/legwise/`, which `obt daily` runs in full); an evening step that scores them over the
  collected day into a separate store root (`rotation_gl/`), after the existing `obt rotation
  update`; measure its runtime against Core's nightly run (about 1.9 times the variants) and say if it
  fits the laptop's evening window.
- **Done when:** the pool's stored history reproduces BL-106's replay for Adaptive within rounding and
  a normal evening adds the new day.

### Phase 2 — The shadow pick
- **Tasks:** a 09:16 job that records Adaptive's Group Leaders picks in a separate hash-chained
  journal (`obt rotation shadow-pick` style; scheduler job after the live pick, failure alerts like the
  live job's); never touches the live journal; `verify` covers both.
- **Done when:** a dry run reproduces BL-106's picks for a past day and one live day is recorded.

### Phase 3 — Dashboard
- **Tasks:** the rotation page shows "Adaptive · Core (298 variants)" and, beside it,
  "Adaptive · Group Leaders", with each day's picks, evening result and the running read-out toward
  60 days; guide page updated in the same change.
- **Done when:** both series are visible per day and the read-out card states the registered rule.

## Risks

- **Runtime:** about 1.9 times Core's evening compute on the laptop; measured in Phase 1 before
  anything is scheduled.
- **Two selection effects:** the pool was selected on one year and tested on the next in BL-106;
  the shadow is the first fully forward look.
- **Small effect against a wide interval:** about ±₹200 a day at twelve months; 60 days will be
  wider. The rule treats a missed threshold as inconclusive and keeps Core.

## Open questions

- Should shadow picks be sent to Telegram (default: no, dashboard only)?
- Is a 60-day read-out the right length given the interval width (BL-058 chose 60)?

## Log

- 2026-10-16 — created from the owner's chat: follow Adaptive only, two universes (Core, Group
  Leaders), the second to run as a shadow. Name chosen by the owner.

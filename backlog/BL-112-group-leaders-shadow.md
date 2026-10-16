# BL-112 — Group Leaders: run Adaptive on the best-settings-per-group pool as a parallel forward track beside Core

| | |
|---|---|
| **Priority** | P1 — the owner will follow only Adaptive and wants two universes side by side |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-16 |
| **Depends on** | BL-106 (pool definition and result; merged), BL-058 (the lists, the journal and its read-out rule) |
| **TODO.md row** | — |

## Context

Owner (2026-10-16): from now on only **Adaptive** (list C) is followed; the dashboard and Telegram show
only Adaptive. Two universes remain: the live **Core** (the 298 variants, "Core-298" in the research) and
a new pool the owner wants a generic name for. Chosen name: **Group Leaders**. What it is, exactly: for
each of 23 groups (strategy family × index × time band) the pool keeps the **top few settings** (up to
four, five for three groups, three for one: **94 sets, 556 variants** in all), each applied at every entry
time of its band, chosen from the first year only. The research pool BL-106 called "New-556" is Group
Leaders v1. (An earlier draft of this item said "one best set per group"; that was wrong.)

What BL-106 found for Adaptive over the 239 test days (2025-10-09 → 2026-10-09, gross, per lot):

| Universe | ₹ per lot-day | Max drawdown | Difference vs Core [90% interval] |
|---|---:|---:|---|
| Core-298 | 393 | −10,089 | |
| Group Leaders v1 (New-556) | 324 | −8,565 | −69 [−258, +111] |

No list passed the registered rule: every interval straddles zero and is about ±₹200 a day wide.
Group Leaders has the shallower drawdown and the lower gross return for Adaptive. Charges are about ₹150
per lot-day for the pool (324 gross, 174 net), twice the gap, so the cost basis matters.

Naming: "Base" is avoided because "base" already means the owner's fixed comparator basket. "Parallel
track" is used instead of "shadow" because "Shadow" is the BL-083 scoreboard. "Core" also means a list's
non-Buy picks on a few screens (the "Core" chip in Why this pick); the pages name the universe "Core-298"
or "Core (298 variants)" so the two read differently.

## Goal

From the commit date, record every day what Adaptive would have picked from Group Leaders (a separate
hash-chained journal), score it every evening, show it beside Core on the dashboard, and read it out
descriptively at 60 on-time days and decisively at 250.

## Out of scope

- Changing what is traded: Core stays the live universe; the track places no orders and sends no
  Telegram unless the owner asks.
- Re-selecting the pool during the test, changing Adaptive's weights or lookbacks, other lists.
- Net-of-charges re-simulation of Core's stored results.

## Plan

### Phase 0 — Pre-register (committed before the first tracked day)

- **Hypothesis:** Adaptive choosing from Group Leaders v1 earns no less than Adaptive choosing from
  Core, by a margin, with a drawdown at least 10% shallower. (Non-inferiority in return, superiority in
  drawdown: the reason to want the pool is risk.)
- **Universe / pool, frozen:** Group Leaders v1 = BL-106's New-556 exactly: the 94 sets and 556
  variants in `research/bl106/pool_{sets,cells}{,_ext}_2026-10-15.json` (on `main`; the readable list
  is `research/bl106/group_leaders_v1.md`), selected
  from 2024-10-09 → 2025-10-08. Disclosed, as in BL-106: day-stop and entry rates came from the two-year
  Stage 1 summary (a small leak of behaviour rates, not P&L), and three NIFTY Dir ITM1 sets were added
  by the owner's amendment before any replay. The 556 generated variant YAMLs are **committed** in
  their own folder (never under `strategies/rotation/`, which `variant_names()` globs and would
  silently join Core), and a hash of their contents (not only names) is written into every entry.
  No re-selection, no edits, until a dated v2 with its own selection window; v1 and v2 are never mixed
  in one read-out.
- **List:** Adaptive (C), registered weights and 5 / 21 / 63 / 126-day lookbacks, the same
  `score_history` as the live picker; if list C changes (BL-111 is a separate, later arm), the track
  keeps the version registered here.
- **Look-ahead check:** the track's 09:16 pick uses only results before the day and the same 09:15 VIX
  open and days to expiry as the live pick (it is recorded in the same process, right after the live
  entry, so the two never differ in inputs).
- **Paired days.** An *on-time day* is a day on which both the live Core entry and the track entry
  were recorded before 09:17 and both baskets are fully scored. A day where the track's evening step or
  pick failed (`load_history` raising `PickError`, a missing result) is excluded for **both** arms and
  counted in the read-out as a gap. No peeking: until the read-outs below the dashboard shows each
  day's picks and results but no difference, running total or verdict.
- **Cost basis.** The stored `costs` column of Core is 0, so the primary comparison is **gross**; **net
  after charges** is reported beside it by re-running both arms' picks with one model at read-out time
  (the BL-096 model, `research/bl104/run_grid.py: trade_charges`, as BL-106 used). The pool's stored
  `net` column holds gross (costs 0) so the ranking basis is the same for both.
- **Read-outs (descriptive vs decision).**
  - *At 60 on-time days:* report only; no decision. Group Leaders minus Core in ₹ per lot-day and
    maximum drawdown per lot, 90% circular block bootstrap (5-day blocks, 2,000 resamples, seed
    20261012). At 60 days the interval is about ±₹370 per lot-day (BL-058's own estimate: ₹320 to 410),
    so it can only show a very large gap.
  - *At 250 on-time days (about a year): the decision.* **Adopt Group Leaders as the traded universe
    only if** the lower bound of the 90% interval of the per-lot-day difference is above **−₹100** (not
    worse than Core by more than about a quarter of Core's mean) **and** its maximum drawdown per lot is
    at least 10% shallower than Core's. Otherwise Core stays. Passing is reported as "no worse in
    return, shallower in drawdown", never as "better".
- **Hold-out:** none; this is forward-only data, nothing in it was used to select the pool.
- **Will not run:** a mid-test pool change, other lists, a different window, any decision before 250
  days. Each needs a new dated block and `override: <reason>`.

### Phase 1 — Daily results for the 556 variants
- **Tasks:** an evening step that scores the committed YAMLs over the collected day into their own
  results folder, inside `obt rotation update` and isolated from it as the fixed base is
  (`strategies/rotation_base/`, results under `rotation/base/`), so a failure never stops `tdata
  derived rebuild` or `rotation result`; history for the lookbacks rebuilt from the lake (BL-106's
  replay history is git-ignored and lives in one worktree, so it is not relied on); the pool's names
  (`N_wA1_0917` style) handled by the same name parsing BL-106 patched, put in `rotation/variants.py`
  properly, not monkey-patched.
- **Deliverables:** the YAML folder, the evening step, a runtime figure (BL-106's log works out to about
  0.06 s per variant-day, so about a minute for one day against a ten-minute evening job; measured, not
  assumed).
- **Done when:** the history reproduces BL-106's replay for Adaptive with **exact per-variant-day gross
  equality** (as BL-063 did) and a normal evening adds the new day.

### Phase 2 — The tracked pick
- **Tasks:** after the live entry in the same process, record Adaptive's Group Leaders pick in a
  separate hash-chained journal; never touch the live journal; `verify` covers both; `code_commit()`'s
  dirty check extended to the new folder; the root/`store.rotation_dir()` parameter threaded through
  rather than a hard-coded sibling.
- **Deliverables:** the journal, its `verify`, a scheduler hook inside the existing 09:16 job.
- **Done when:** a dry run reproduces BL-106's pick for a past day and one live day is recorded with the
  same VIX and DTE as the live entry.

### Phase 3 — Dashboard
- **Tasks:** the rotation page shows "Adaptive · Core-298" and, beside it, "Adaptive · Group Leaders":
  each day's picks and evening result, the count of on-time days toward 60 and 250, and, only at the
  read-outs, the registered table; the guide page in the same change.
- **Deliverables:** the two series and the read-out card.
- **Done when:** both are visible per day and the card states the registered rule.

## Risks

- **Power.** At twelve months the interval is about ±₹200 a day, wider at 60 days. The 250-day decision
  is likely to say "Core stays" unless the pool is clearly better in return; that is an acceptable
  outcome (the pool's value may be its shallower drawdown, which the rule asks for).
- **Cost basis.** Gross for the decision, net beside it; the pool pays more orders per lot than Core.
- **Isolation.** A mistake that puts the pool's YAMLs under `strategies/rotation/` or its results in the
  live store would contaminate Core; Phase 1 tests that Core's universe fingerprint is unchanged.
- **Two selection effects.** BL-106 selected on one year and tested on the next; this is the first fully
  forward look.

## Open questions

- Should the tracked picks be sent to Telegram (default: no, dashboard only)?
- Is a year the right length for the decision, given the owner's cash and appetite for waiting?

## Log

- 2026-10-16 — created from the owner's chat: follow Adaptive only, two universes (Core, Group
  Leaders), the second to run alongside. Name chosen by the owner.
- 2026-10-16 — Opus review (PR #236): pool corrected (94 sets over 23 groups, top few per group, not one
  best); net basis fixed (gross decides, net beside it, BL-096 model); rule made non-inferiority in
  return plus a drawdown margin, decision moved from 60 to 250 days after the power check; pool
  freezing, paired-day rules, isolation traps and the shadow/Shadow and Core/core name collisions
  recorded.

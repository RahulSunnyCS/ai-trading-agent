# BL-135 — Lot plans tracked forward: As picked, Dir Boost and Duo, for Core and T1

| | |
|---|---|
| **Priority** | P1 — the owner trades both books with real money (3 lots each); this measures the two alternative lot plans on unseen days |
| **Status** | In progress |
| **Type** | feature + research (forward) |
| **Area** | options / dashboard |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (journal, results store), BL-113 (T1 track), BL-122 (expiring-index rule), BL-133 (Dir Boost), BL-134 (Duo) |
| **TODO.md row** | 3.10.32 |

## Context

Owner (2026-10-18): track two lot plans forward from Mon 2026-10-19 for both books, the live Adaptive (Core-298,
list C, `rotation/journal.jsonl`) and the T1 track (BL-113, list C, `rotation/track_t1/journal.jsonl`), and show
them in the dashboard. Today each book trades 3 lots, one per core pick.

The two plans come from research on in-sample days: **Dir Boost** is BL-133's C-D2 / T-D2 (the Dir at two lots on
non-expiry days; PR #254), **Duo** is BL-134's P (the higher-composite Widesl and the Dir only; PR #255). Both were
chosen after reading results on 2025-01-10 → 2026-10-16 (days also read by BL-115, BL-129 and others; T1 overlaps its
selection year), so their research figures are not evidence. BL-133 found Dir Boost's edge over an even spread rests
on a handful of days; BL-134 found Duo worse than Dir Boost in T1. This item measures all three on days nobody has
seen yet.

## Goal

Every forward day, per book, what each plan would have made (gross, brokerage, net) from the stored one-lot results;
a read-out at 60 forward scored days of each plan against As picked. Nothing changes the live lists, the journal, the
picks, the scoring or the Telegram messages.

## Out of scope

- Any change to what is picked or traded; any write to the journal or the results store.
- A reconstructed (in-sample) history of the plans before 2026-10-19 (not built; if ever added, it is labelled
  in-sample and never joined to the forward series).
- Turnover charges (STT, exchange, SEBI, stamp, GST on them): they scale with lots and are left out alike.
- The Buy add-on (owner: "if there is buy, it is extra"): in no plan.

## Plan

### Phase 0 — Pre-register (committed before the first forward entry, 2026-10-19 09:16 IST)

- **Books:** Core = list C of the live journal over Core-298; T1 = list C of the T1 journal over Core-298 + the T1
  variants. Each book is read from its own journal and its own stored results (`store.result_path`).
- **Forward days:** journal entries dated 2026-10-19 or later. An entry recorded at or after 09:17 IST
  (`before_first_entry` false) is `late`: listed, never in a total. Entries before 2026-10-19 are never read.
- **Picks:** the entry's list C `core` (three strategies). W1 = the core Widesl pick with the higher composite
  recorded in the entry (list C `composite`; ties by name). Dir = the core Dir pick (Dir ATM or Dir ITM1, including a
  T1 Dir). A **three-Widesl day** has no Dir pick; its Dir is then the **best unpicked Dir** exactly as the 09:16
  message's optional Dir line gives it (`pick.next_best`, which on an expiring-index day comes from that index via
  `expiry.filtered_runners_up`), re-derived from the stored results before the day with the same calls the pick made
  (`pick.load_history` + `pick.score_history` / `next_best`, the entry's VIX open, days-to-expiry labels and
  `expiry_only`). The re-derivation must reproduce the entry: list C's core, Buy and override equal, the inputs digest
  equal to `inputs_sha` and the universe fingerprint equal to `universe`. If any differs (or it cannot run), the day
  is `unverified` and left out of every total; it is never guessed.
- **Expiry day:** the entry's own weekday days-to-expiry label (`dte.entry_labels`) is `0` for NIFTY or SENSEX.
- **Plans (lots):**
  - **As picked** (the comparator): 1 lot on each of the three core picks, every day (3 lots).
  - **Dir Boost** (BL-133): expiry day = As picked (3 lots). Other days: the three picks, the Dir pick at 2 lots
    (4 lots); on a three-Widesl day the three Widesl at 1 lot each plus the best unpicked Dir at 1 lot (4 lots).
  - **Duo** (BL-134): W1 at 2 lots + the Dir (picked, or the best unpicked Dir on a three-Widesl day) at 2 lots on
    other days (4 lots), at 1 lot on an expiry day (3 lots). The other Widesl pick(s) are not traded.
- **Money:** gross = Σ lots × the stored one-lot `gross` of the strategy that day. Brokerage = ₹20 × 1.18 per order,
  2 orders × the stored `n_trades`, once per strategy placed (lots of one strategy share its orders). Net = gross −
  brokerage. Doubling a one-lot result assumes the strategy's overall stop scales with its lots (BL-133 review).
- **Day status:** `scored` (every result a plan needs is stored) | `waiting` (one is not stored yet: its figures are
  withheld, never zero) | `late` | `unverified`. A day enters the totals only when it is `scored`, for all three plans
  at once, so the plans are always compared over the same days.
- **Measures, per book and plan:** days, lots, gross / brokerage / net per day, cumulative net, max drawdown of the
  cumulative net (from a peak starting at zero, `readout.max_drawdown`), worst day (net).
- **Read-out (registered, once 60 forward scored days exist per book):** on the first 60 scored days, each of Dir
  Boost and Duo minus As picked, net per day; mean and a two-sided 90 % circular block bootstrap interval (5-day
  blocks, 2,000 resamples, seed 20261019, `readout.block_bootstrap_mean`). Drawdown per lot = the plan's max drawdown
  over those days ÷ its mean lots per day.
- **Reading rule:** a plan **beats As picked** in a book if the interval's lower bound is above zero AND its drawdown
  per lot is no deeper than As picked's. Below zero = it costs; otherwise inconclusive. Days after the 60th are shown
  as descriptive, never re-judged. Under 60 days the read-out is `n/a` with the count. Nothing is changed by the
  result; adopting a plan is the owner's separate decision.
- **Look-ahead check:** the picks are the journal's (recorded before 09:17); the best unpicked Dir is re-derived from
  results before the day only and must match the entry's own digest; the results are the stored one-lot results
  written the evening after.
- **Will not run:** other lot splits, the Buy add-on, a re-ranked Dir, any day before 2026-10-19, statutory charges.
  Running one needs `override: <reason>` in the Log.

### Phase 1 — Build

- **Tasks:** `rotation/lot_plans.py` (pure plan functions + a read-only builder over either journal; per-day rows and
  a summary with the read-out); `GET /legwise/rotation/lot-plans?book=core|t1` (`api/rotation_lot_plans_routes.py`);
  `obt rotation lot-plans [--book t1] [--json]`; unit tests on a synthetic store built through the real
  `pick.record`; the dashboard's "Lot plans" card on Options Lab › Rotation (book switch, plans table, cumulative net
  chart, daily rows) and its Guide page.
- **Done when:** tests pass; the route answers for both books on the real store (read-only) with an empty forward set
  and "tracking starts Mon 19 Oct" before the first scored day.

### Phase 2 — Read-out

- **Tasks:** at 60 forward scored days per book, record the read-out in the Log and the findings pages.
- **Done when:** the Log has each plan − As picked with its interval and drawdown per lot, for both books.

## Risks

- A three-Widesl day whose re-derivation does not reproduce the entry (a variant file added or a stored result
  rewritten) is `unverified` and lost to the read-out; the count is shown.
- Sixty days is short and expiry days are a large share; the interval can be wide.

## Log

- 2026-10-18 — Created; Phase 0 registered before the first forward entry (owner named the plans). TODO 3.10.32.
- 2026-10-18 — Phase 1 built: `rotation/lot_plans.py`, `GET /legwise/rotation/lot-plans?book=core|t1` (+ Fastify proxy
  route), `obt rotation lot-plans`, the Rotation page's "Lot plans" card and its Guide page. Checked read-only on the
  real store: both books answer with no forward entry and "Tracking starts Mon 19 Oct"; with the start moved back to
  12 Oct in a scratch run, the best unpicked Dir re-derived and verified on all five recorded entries (digest equal).
- 2026-10-18 — **Amendment (code review, PR #256; before the first forward entry, so no forward day has been
  read).** The re-derivation is made robust and stricter, Phase 0's rule otherwise unchanged:
  - **The history the entry saw.** The best unpicked Dir is re-derived from the first `inputs_days` stored days
    before the day, with no requirement that the history reach the last collected day. A day stored later (a
    Fyers repair of an excluded day, a T1 backfill) can therefore no longer turn a correct day `unverified`. The
    `inputs_sha` digest must still match.
  - **The universe the entry ranked.** If strategy files were added since, the universe is rebuilt from the
    entry's `commit` (`git ls-tree`) and must match the entry's fingerprint. Otherwise the day is `unverified`, with
    the reason.
  - **Extra checks.** List C's recorded composites (4 dp) and the VIX band of the recorded open must also match.
  - **Caching.** Answers are cached against a stamp of the stored files, so they do not depend on API restarts.
  - **The read-out.** It is computed afresh from the files on each request, and the card and CLI show the dates
    judged. **This Log's entry at the 60th scored day is the record**; a later status change can move the shown
    window. Days after the 60th are shown as descriptive.

# BL-220 — Friday size-down: trade fewer Adaptive picks on Fridays, tested on days not used to find it

| | |
|---|---|
| **Priority** | P2 — a possible cost saving on one day in five; the evidence so far is a post-hoc look, under the noise bar |
| **Status** | In progress; Phase 1 passed (narrowly), A2: R1 and R2 passed on T1, R3 failed; Phase 2 waits for 20 Fridays (about 2 Apr 2027) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-12 |
| **Depends on** | none; [BL-221](BL-221-friday-by-family.md) is the descriptive companion and must not read this item's hold-out |
| **TODO.md row** | 3.10.69 |

## Context

On 2026-11-12 the owner asked for each book's return by weekday. The Rotation "Day by day" data (1 lot per
pick, no book stop, 0.5 % slippage after costs; T1 and Core 2025-01-10 → 2026-11-11, 444 days; the fixed
base 2024-11-12 → 2026-11-11, 486 days) gave Friday as the weakest day for all three books:

| ₹ a day | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Tuned Adaptive (T1) | 1,071 | 2,992 | 971 | 1,510 | **64** |
| Classic Adaptive (Core) | 537 | 1,924 | 22 | 999 | **58** |
| Fixed base | 728 | 1,438 | 554 | 608 | **85** |

A follow-up read the same days three ways (scripts in the session scratchpad, not committed):

- **Friday is the one day far from both expiries in both expiry regimes** (from Jan 2025). Calendar days to
  expiry (NIFTY / SENSEX) on a Friday were 6 / 4 from Jan to Aug 2025 and 4 / 6 after (weekdays: 4 / 2,
  then 2 / 4); every other weekday is at most 1 day from one expiry. Oct 2024 – Jan 2025 Fridays were
  SENSEX expiry days. Tuesday and Thursday hold an
  expiry in both regimes and carry 68 % of T1's total, 82 % of Core's, 60 % of the base's.
- **The whole universe makes about nothing on Fridays, not a loss.** The 298 stored strategies average
  ₹6 a strategy-day on Friday (0.5 % slippage), against −₹78 on Wednesday, the universe's weakest day.
  Friday was +₹118 before Sep 2025 and −₹55 after.
- **The ranking's edge vanishes on Fridays.** A T1 pick beats that day's universe mean by ₹300–800 on other
  weekdays but by ₹32 (before Sep 2025) and ₹8 (after) on Fridays. Core: −₹294 / +₹178; the base +₹124 / +₹46.

**This is a hint, not a result.** After Sep 2025 T1's Friday is −₹157 ± 649 a day against Monday's
+₹1,233 ± 569, about 1.6 standard errors. Earlier items put the noise bar at about ₹700 a day
([days to expiry](../research/options/strategies/widesl/days-to-expiry.md)). The pattern was found by
looking at 5 weekdays × 3 books (15 cells) after the fact, and BL-159 read 8's Monday screen found no
lead. So every day above is spent: none of it may be used for the verdict.

## Goal

A yes / no, on days not used to find it, on whether trading fewer Adaptive picks on Fridays improves
T1's result per rupee of risk without giving up more than a set share of its net.

## Out of scope

- Any other weekday (Wednesday is the universe's weakest day): its own item if wanted.
- Changing the ranking itself (its weekday / days-to-expiry ingredients).
- Turning a rule on in Settings › Automation. A pass ends in a proposal to the owner, not a switch.

## Plan

### Phase 0 — Pre-register (confirmed by the owner 2026-11-12, committed before any read of A or B)
A rule is never edited after a run: a new, dated rule supersedes it with a logged reason, and both stay here.
- **Hypothesis:** on Fridays far from expiry, the rotation's strategies earn less than on the other days
  (the mechanism), and Tuned Adaptive's Friday picks add little, so trading fewer of them raises its net per
  unit of drawdown (the book).
- **Candidate rules (fixed now, no others):**
  - **R0** — as now: every pick, every Friday (the comparator).
  - **R1** — Friday: drop the core pick with the lowest composite recorded in the journal (list C);
    the Buy add-on and Dir ×2 off on Fridays.
  - **R2** — Friday: trade nothing.
  - **R3** — Friday: drop every pick whose entry is 13:00 or later (from BL-221: Friday falls behind
    from 13:00 to the close).
- **Hold-out A (mechanism):** BL-071's per-day results of the 124 NIFTY variants
  (`research/bl071/results/`, Widesl OTM1, closest premium ₹80 / ₹100, Dir ATM, Buy at 25 start times),
  sessions **2022-04-05 → 2024-10-08**, minus the days `data_quality` excludes. BL-071 read rankings
  there, never a weekday split. NIFTY only. Read as stored: gross with costs 0 and **no slippage** (no
  slippage copy exists for those days; Friday's premiums are higher, so this flatters Friday and makes
  the test harder to pass).
- **Hold-out B (book):** the T1 journal's recorded entries for the first **20 Fridays from 2026-11-13**
  and every session in the same weeks (Monday of the first week to the 20th Friday), list C, one lot per
  pick, the stored results after 0.5 % slippage and brokerage at ₹20 × 1.18 × 2 per trade
  (`rotation/lot_plans.py`'s rule). Scored after the fact from the journal and the stored results; nothing
  changes what trades.
- **Spent (never used for the verdict):** everything from 2024-10-09 → 2026-11-12, including BL-221's reads.
- **Look-ahead check:** every rule reads only the calendar date, the point-in-time expiry list
  (`ref_expiries` in the trading-data catalog, holiday-shifted expiries included) and, for R1, the
  composites the journal recorded before the open; all known before the first entry. A Friday within 1
  weekday of a NIFTY expiry (a holiday-shifted week) is left out of the mechanism test and reported apart.
  Clarified 2026-11-12, before any result of A was read: the catalog's `ref_expiries` has no NIFTY expiry
  before 2024-10, so A's weekday and days-to-expiry labels come from BL-214's
  `TRADING_DATA_ROOT/_bl214/rotation/days.csv` (built from the lake's observed expiries, calendar days) and
  its `quality/data_quality.parquet` for the excluded days. Its 125 Fridays in A are 6 (120) or 5 (5)
  calendar days from expiry, so none is left out by the 1-weekday rule.
- **Pass / kill rule:**
  - *Mechanism (A):* per session, the mean of the variants' results that day; Friday sessions against
    all other weekday sessions. **Pass** if the other-days mean minus the Friday mean is **₹100 or more**
    and its one-sided p is **≤ 0.05**: the share of 2,000 circular 5-day block-bootstrap resamples of the
    session series (weekday labels kept with their sessions, seed 20261112) in which the gap is 0 or
    below. Fails → **killed**, Phase 2 not run.
  - *Book (B), each of R1, R2, R3 against R0 on the same weeks:* **passes** if its net per session over
    those weeks is **not more than 5 % lower** than R0's and its **worst 20-session drawdown is at least
    10 % smaller**. None passes → **killed**. More than one passes → the one with the higher net is proposed.
- **Will not run:** other weekdays, other drop counts or cut-off times, threshold tuning, SENSEX on A,
  any read of A or B before this block is committed. Running one needs `override: <reason>` in the Log.
- **Tests counted:** 4 (A; R1, R2, R3 against R0 on B), on top of the 15 weekday cells that suggested it
  and BL-221's ~70 descriptive cells.

### Amendment 1 (2026-11-12, owner: "both"; written and committed before either read)
Two more reads of the book rules, neither replacing Phase 2. **Hold-out B stays the verdict for R1–R3.**
- **A2 — the book rules on BL-214's NIFTY-only books (registered).** Root `TRADING_DATA_ROOT/_bl214`,
  BL-214's scored window **2021-11-01 → 2024-10-08**. Core (the 149 NIFTY variants of Core-298 in that store) and T1
  (those plus T1's 173 NIFTY variants), list C re-derived each day exactly as BL-214's
  `research/bl214/score.py` `book_picks` does (`pick._rank` on earlier rows only, the expiry-only filter
  where one index expires, the SL150 % cap on a day NIFTY does not expire), **core picks only, Buy left
  out** (as BL-214), one lot a pick, its 0.5 % slippage copy, brokerage ₹20 × 1.18 × 2 per trade; a session where a pick has no stored result is left out for
  every rule and counted. R1's
  "lowest composite" is that day's list C composite. Rules R0–R3 and the pass rule as in Phase 0, judged
  on **T1**; Core reported beside it. These sessions overlap hold-out A's (the mechanism read on BL-071's
  strategy results), so A2 is not independent of A. Each rule's A2 pass or fail is reported with its
  Phase 2 result; it does not kill or pass a rule on its own. Adds 3 tests (7 in all).
- **S — the same scoring on the last two years, in-sample, descriptive only.** Live root, the first
  re-derivable day from 2024-11-12 → 2026-11-12, T1 and Core, picks as the Rotation page's Day by day
  takes them (`candles.picks_by_day`: the journal where recorded, re-derived before it), Buy add-on
  included. These are the days that suggested the idea and that T1 was tuned on: no pass or fail is
  printed, the figures are an upper bound on what a Friday rule could have added, never evidence.

### Phase 1 — Mechanism on hold-out A (no engine runs)
- **Tasks:** the test above; descriptive beside it (not part of the verdict): Friday against each other
  weekday, by family, by NIFTY weekdays to expiry, and by calendar year.
- **Deliverables:** `research/bl220/mechanism.py`, the numbers in this file.
- **Done when:** the mechanism test is read and logged as pass or kill.

### Phase 2 — Forward book read (only if Phase 1 passes)
- **Tasks:** after the 20th Friday from 2026-11-13 (about 2 April 2027) has its stored results, score R0–R3
  over the weeks in hold-out B by the rule above.
- **Deliverables:** `research/bl220/book.py`, the table and the verdict.
- **Done when:** the book rule is read and logged as pass or kill.

### Phase 3 — Close
- **Tasks:** update `research/options/strategies/widesl/weekday.md`, `directional/weekday.md`,
  `buy-breakout/weekday.md` and the days-to-expiry pages with the result; a pass becomes a proposal to the
  owner for a Settings › Automation rule.
- **Done when:** the pages cite this item and INDEX shows Done or Dropped.

## Results

### Phase 1 — mechanism on hold-out A: **PASS** (2026-11-12)

`research/bl220/mechanism.py` over BL-071's 124 NIFTY variants, 618 sessions 2022-04-05 → 2024-10-08 (no day
excluded by quality; one result day without a BL-214 label dropped), gross at 0 % slippage, before
brokerage, the session mean over the variants:

| | Friday | other weekdays | gap | one-sided p | 90 % band of the gap |
|---|---|---|---|---|---|
| ₹ per strategy-day | 81 (125 sessions) | 192 (493) | **111** (bar 100) | **0.012** (bar 0.05) | 29 .. 190 |

Descriptive beside it (not part of the verdict), mean ± SE over sessions:

| | Mon | Tue | Wed | Thu (expiry) | Fri |
|---|---|---|---|---|---|
| All 124 | 103 ± 38 | 236 ± 38 | 137 ± 44 | 289 ± 45 | 81 ± 44 |
| Widesl (OTM1, ₹80, ₹100) | 170 ± 72 | 318 ± 72 | 60 ± 79 | 286 ± 80 | 46 ± 81 |
| Dir ATM | 2 ± 68 | 265 ± 85 | 361 ± 79 | 469 ± 52 | 214 ± 76 |
| Buy | −1 ± 47 | −52 ± 44 | 142 ± 61 | 112 ± 61 | 53 ± 56 |

By calendar days to the Thursday expiry: Friday (6 days) ₹88, Monday (3) ₹93, Tuesday (2) ₹229, Wednesday (1)
₹114, Thursday (0) ₹289; holiday weeks are 5–6 sessions a cell. By year: 2022 Friday ₹116 against ₹226,
2023 −₹3 against ₹154, 2024 ₹160 against ₹209.

Reading. The pass is narrow (₹111 against a ₹100 bar) and the band reaches down to ₹29. Monday, also far
from expiry, is about as weak as Friday, which fits days to expiry rather than the weekday. Unlike
BL-221's 2025–26 days, on these NIFTY years the Friday shortfall is in Widesl, not Dir (NIFTY Dir on a
Friday was mid-table). A first, defective read on 69 of the 124 variants (Log) printed a gap of ₹30; the
registered universe is the 124. Phase 2 goes ahead.

### Amendment 1 — A2: book rules on BL-214's NIFTY-only books (registered) (2026-11-12)

`book.py a2` with `TRADING_DATA_ROOT=…/_bl214`: 722 sessions 2021-11-02 → 2024-10-08, 144 Fridays, none left
out. One lot per core pick, 0.5 % slippage, after brokerage; ₹ per session.

| T1 (judged) | net / session | total | Friday mean | worst drawdown | verdict |
|---|---|---|---|---|---|
| R0 as now | 191 | 1,37,680 | −195 | 50,764 | — |
| R1 drop lowest | 195 | 1,40,562 | −175 | 43,275 | **pass** |
| R2 skip Friday | 230 | 1,65,701 | 0 | 39,761 | **pass** |
| R3 no starts from 13:00 | 155 | 1,12,018 | −373 | 50,512 | fail (net below the floor, drawdown not 10 % smaller) |

| Core (beside) | net / session | Friday mean | worst drawdown | verdict |
|---|---|---|---|---|
| R0 | 204 | −19 | 28,636 | — |
| R1 | 204 | −16 | 28,992 | fail (drawdown) |
| R2 | 208 | 0 | 28,505 | fail (drawdown) |
| R3 | 149 | −295 | 28,648 | fail (both) |

Reading. On T1 both size-downs passed: Friday cost T1 about ₹195 a Friday after brokerage there, so leaving
it out raised net and cut the worst drawdown by a fifth. Core's Fridays were about zero, so nothing changed
its drawdown. R3 hurt: the books' afternoon Friday picks made money, unlike the universe's afternoon in
BL-221. A2 shares its days with A and is NIFTY-only with a Thursday expiry; it does not decide (Phase 0:
B does).

### Amendment 1 — S: the last two years, in-sample (descriptive, 2026-11-12)

`book.py insample`: 445 sessions 2025-01-10 → 2026-11-12, 88 Fridays, picks as Day by day takes them.

| | T1 net / session | T1 Friday mean | T1 worst drawdown | Core net / session | Core Friday mean | Core worst drawdown |
|---|---|---|---|---|---|---|
| R0 | 951 | −279 | 45,112 | 396 | −257 | 52,780 |
| R1 | 1,014 | 40 | 39,788 | 393 | −272 | 47,280 |
| R2 | 1,006 | 0 | 30,926 | 447 | 0 | 36,661 |
| R3 | 929 | −389 | 45,112 | 378 | −346 | 52,780 |

The days that suggested the idea and that T1 was tuned on, so an upper bound, not evidence. T1's worst
drawdown is the current one (Oct–Nov 2026; its three Fridays averaged −₹4,664), which is most of R2's cut.
R3 again lowers net.

### Phase 2 — book rules on hold-out B: waiting

`research/bl220/book.py` is built and checked on spent days (`--dev`, no verdict). Its registered read
refuses to run until the T1 journal has 20 Fridays from 2026-11-13 (the 20th is about 2 April 2027) and
every pick's stored result. Hold-out B is a single read then.

## Risks

- 20 Fridays is thin; a 1.6-SE gap may not resolve in that time. The kill rule then decides by default.
- 2022–24 NIFTY had a different expiry weekday and rupee levels; hold-out A tests the mechanism, not
  today's book.
- Another weekday item running at the same time would add tests; count them here.

## Open questions

Answered 2026-11-12 (owner, at "lets do BL220"):

1. Hold-out A: **BL-071's results, as drafted** (not BL-214's store), so A tests the mechanism only.
2. Rules: **R1, R2 and R3** (R3, no Friday starts from 13:00, added from BL-221).
3. Thresholds: **as drafted** (₹100 gap, p ≤ 0.05; net within −5 %, drawdown 10 % smaller).
4. Forward: **20 Fridays**, T1 only.

## Log

- 2026-11-12 — created from the weekday read (owner: "Yes, add it"). Phase 0 is a draft; nothing has been
  run on either hold-out.
- 2026-11-12 — corrected the Context: the Friday days-to-expiry figures quoted (6 / 4, 4 / 6) are calendar
  days, not weekdays (weekdays 4 / 2 and 2 / 4), and Oct 2024 – Jan 2025 Fridays were SENSEX expiry days.
  The draft hypothesis now reads "within 1 weekday of expiry". Still nothing run.
- 2026-11-12 — started; the owner's answers recorded and Phase 0 confirmed (R3 added, 20 forward Fridays,
  hold-out A read at 0 % slippage as stored). Committed before any read of A or B.
- 2026-11-12 — **defective first read of A, not the registered test.** `mechanism.py` globbed `N_*.csv` and
  so read 69 of the 124 variants: BL-071 saved the 55 morning-start files without the `N_` prefix
  (`wide_0917.csv` …). On those 69 (later starts only) it printed Friday ₹122 against ₹152, gap ₹30,
  p 0.238. Fixed (all `*.csv`, a stop unless exactly 124 are found) and committed before the registered
  run; the registered verdict is the 124-variant run below, whatever it shows. Nothing else changed.
- 2026-11-12 — Phase 1 read once on the 124 variants: Friday ₹81 against ₹192, gap ₹111, p 0.012: **pass**.
  Phase 2's `book.py` built; its `--dev` check on spent days 2026-10-19 → 11-12 ran clean (no verdict).
  Clarified before B exists: the "worst 20-session drawdown" is the largest peak-to-trough fall of the
  cumulative net with the trough at most 20 sessions after the peak (`book.worst_drawdown`); the weeks of B
  start Monday 2026-11-09 (Mon–Thu are the same under every rule).
- 2026-11-12 — Amendment 1 run once each: A2 (registered) T1 R1 and R2 pass, R3 fails, Core none; S
  (in-sample, descriptive) the same order. Research page `research/options/common/friday-size-down.md`.

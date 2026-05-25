# GATE 2 SPECIALIST REVIEW — Plain English Summary

**Verdict: FAIL** — 2 Critical problems must be fixed before we can proceed.

---

## Overview

We had security, performance, and architecture specialists review the M5 milestone (support for BankNifty and Sensex indices, plus the S/R signal engine). The good news: the new S/R detection logic is solid, the safety rules for Clockwork and personality comparison are working correctly, and the code follows the project conventions. The bad news: the multi-index support has real gaps that prevent it from working in live trading, and the optimizer is running unnecessary backtest calculations that slow down the nightly job.

**Findings breakdown:**
- 🔴 **2 Critical** — must fix
- 🟠 **4 High** — serious but fixable
- 🟡 **5 Medium** — important refinements
- 🟢 **4 Low** — good-to-have notes

---

## 🔴 CRITICAL FINDINGS

### C1 — Risk controls reference a database column that doesn't exist

**What it is:** The daily loss-stop rule (to prevent losing more than a daily limit per index) checks the `paper_trades` table for a column called `underlying`, but that column doesn't exist in the database schema. The code instead has columns named `symbol` (the full option symbol like `NSE:NIFTY50-INDEX`) and `signal_id`.

**What breaks:** When this code runs against the real database, it throws an error and fails. The safety brake does not engage — you have no daily loss limit. The sibling rule that caps the number of legs per index also fails because it compares the bare word `'NIFTY'` to stored symbols like `NSE:NIFTY50-INDEX`, which never match. So both controls that T-45 was supposed to add are currently inert or broken.

**Why it matters:** Without a working daily stop-loss, the system could lose significantly more capital than intended on a bad day. You lose protection against concentrated index losses.

**What to do:** Use the `symbol` column and the signal ID to figure out which index a trade belongs to, fix the incorrect comment in the code, and write a test that runs against a real database schema instead of mocked data.

**File:** `src/trading/portfolio-risk.ts`, line 207; and `src/trading/personality-filter.ts`, lines 203–210.

---

### C2 — The nightly backtest runs the same test 3 times and loads data inefficiently

**What it is:** Every night, the system tests three personality variants (Precision, Adjuster, Reducer) to see how they would have performed. Right now it runs an identical 365-day backtest *three separate times* — once for each personality — even though they all have the same settings. Then it loads price snapshots one calendar day at a time, looping 365 times instead of fetching one big batch.

**What breaks:** The nightly job makes about 1,095 redundant database queries (three personalities × 365 days). This slows down EOD retrospection and ties up the database.

**Why it matters:** On a real trading night, the nightly summary could take minutes instead of seconds. If EOD retrospection blocks the next market day's start, you lose trading signals at the open.

**What to do:** Run the backtest once, then reuse the results for all three personalities. Instead of looping through 365 days one by one, fetch all the data in a single database query and process it in memory.

**File:** `src/trading/optimizer.ts` line 884; `src/trading/eod-retrospection-job.ts` line 268; `src/trading/backtest-runner.ts` lines 502–503.

---

## 🟠 HIGH FINDINGS

### H1 — Multi-index is broken in live trading for BankNifty and Sensex

**What it is:** The symbol builder (the part that constructs option symbols like `NSE:BANKNIFTY25O2900CE`) uses a Thursday-expiry formula for *all* indices. But BankNifty actually expires on Wednesday and Sensex on Friday. So every BankNifty and Sensex option gets assigned the wrong expiration date.

**What breaks:** In live mode with real broker data, no option prices arrive because the system is looking for the wrong symbols (with the wrong dates). You get zero straddle values for those indices and no trades execute. In simulation mode this doesn't show up because the simulator doesn't check expiry dates. **This is the headline M5 feature — multi-index support — and it doesn't actually work for 2 of the 3 indices in real trading.**

**Why it matters:** The whole point of M5 is to trade BankNifty and Sensex. If they don't work, the feature is broken.

**What to do:** Build the calendar expiry schedule once when the system starts (using the correct formula for each index) and pass it into the straddle calculator. When the week rolls over, refresh the cached expiry. (This was deferred from T-45 because straddle-calc was supposed to be off-limits, but it's the only place the bug is fixable.)

**File:** `src/ingestion/straddle-calc.ts`, lines 26 and 301.

---

### H2 — Null personality ID breaks the daily loss stop

**What it is:** The daily loss-stop rule sums up realised losses for each personality. But the database allows `personality_id` to be empty (NULL) for some older rows created before we had the concept of personalities. When SQL tries to match `personality_id = NULL`, it always fails (that's how SQL works — NULL never equals anything). So older rows are never counted.

**What breaks:** Realised losses are not fully tallied, so the daily stop can fail open and you might lose more than the daily limit if those old rows pile up.

**Why it matters:** The daily stop is your insurance against a runaway losing day. If it doesn't count all the losses, the insurance doesn't work.

**What to do:** Either require `personality_id` to always be filled in going forward (and fix old rows), or use SQL's `COALESCE` function to treat NULL as a specific value. Add a test to verify the stop works correctly.

**File:** `src/trading/portfolio-risk.ts`.

---

### H3 — A database query runs slowly because of how it filters by date

**What it is:** The code wraps the entry time in a SQL `DATE()` function when filtering for today's trades. This prevents the database from using a pre-built index (a shortcut that makes queries fast), so the database has to scan every single closed trade instead.

**What breaks:** Every time a signal is routed to an active personality (up to 10 personalities × many signals per day), this slow query runs. It scans thousands of old trades unnecessarily. Performance degrades as the database grows.

**Why it matters:** Slower queries mean delayed signal handling, which can miss the peak moment to enter a trade.

**What to do:** Compute the start and end of today in India Standard Time once in JavaScript, then filter using direct date boundaries (`entry_time >= ? AND entry_time < ?`) instead of wrapping the column in a function. This lets the database use its index.

**File:** `src/trading/personality-filter.ts`, lines 181–190.

---

### H4 — The evolution engine crashes for Levelhead personalities every night

**What it is:** The Levelhead personality detects S/R levels (a new signal type in M5). The nightly evolution engine tries to adjust parameters for all personalities but crashes when it hits Levelhead because Levelhead's signals are not in the momentum-exhaustion group that the evolution engine is looking at.

**What breaks:** Every EOD run logs an error for Levelhead (no data is lost, but you see false alarms). The nightly job slows down slightly.

**Why it matters:** False alarms make it hard to spot real problems. If the evolution engine consistently fails for a personality, you stop trusting the logs.

**What to do:** Add an early exit in the evolution engine: if the personality's signal type is not momentum-exhaustion, skip it silently (the optimizer already does this). Mirror the logic so the evolution engine and optimizer stay in sync.

**File:** `src/trading/eod-retrospection-job.ts`, lines 148–150 and 244.

---

## 🟡 MEDIUM FINDINGS

**M1** — The optimizer is hardcoded to test against NIFTY data only. If you add BankNifty or Sensex personalities later and the system auto-tunes them, they would be scored against NIFTY historical data instead of their own index. Add a guard: "multi-underlying backtesting not yet supported." (`src/trading/optimizer.ts`, lines 192 and 735.)

**M2** — When the system shuts down gracefully, it stops signal engines before it stops price snapshots, so unprocessed messages queue up and replay after restart. The straddle snapshot code is not idempotent (running the same INSERT twice creates duplicates). Reverse the shutdown order and add a `conflict do nothing` clause to prevent duplicates. (`src/index.ts`, lines 472–481.)

**M3** — The Phase B backtest is not discriminating: the optimizer hardcodes a 0.7 probability threshold so all candidates below it are lumped together and all above are excluded. If the backtest yields zero winners, we should skip it and return the kernel-peak candidate instead. This guard also solves a big piece of C2's inefficiency. (`src/trading/optimizer.ts`, lines 36–49 and 608–650.)

**M4** — The margin rule (how much capital to reserve before entering a trade) counts all open legs across all indices, then multiplies by the single new trade's size — this overestimates required margin if you're trading multiple indices at once. Either fix it per-index or document the error margin. (`src/trading/portfolio-risk.ts`, lines 263–267.)

**M5** — Two efficiency issues: the "blocked dates" JSON is parsed from environment variables every signal routing (should be parsed once at startup into a Set), and the "count of open trades" query runs twice in a row. Fix both by computing them once. (`src/trading/personality-filter.ts`, lines 334 and 576; `src/trading/portfolio-risk.ts`, lines 263 and 315.)

---

## 🟢 LOW FINDINGS

**L1** — The seed migration has 27 hardcoded expiry dates with no automated check that they are correct Wednesdays, Thursdays, or Fridays. Add documentation or a CI holiday-calendar check. (Already flagged at Gate 1.)

**L2** — The S/R engine stores confidence scores as database numbers with no range validation. Add bounds-checking (defence-in-depth).

**L3** — Code comment is stale; also, when the system groups retrospection results by signal type, it conflates plain momentum reversals with S/R-level reversals unless it also filters by the S/R subtype. Consider a separate `SR_REVERSAL` signal type in Phase 2 for clarity.

**L4** — The S/R levels code has magic numbers for confidence thresholds instead of named constants. Extract them to make the code more maintainable.

---

## CONFLICTS BETWEEN REVIEWERS

No conflicts — all three reviewers' findings converge and reinforce each other.

The most important convergence: three findings (C2, M1, M3) all point at the same root problem. Right now, the real backtest is wired into the optimizer and run every EOD. This is simultaneously **expensive** (three personalities × 365 days), **useless** (the hardcoded 0.7 threshold means the results don't discriminate between candidates), and **broken for non-NIFTY** (because the optimizer is hardcoded to test against NIFTY only). The cheapest fix is M3's `kernel_only` guard, which also makes C2 much cheaper and sidesteps M1's miscalibration.

A second convergence: C1, H1, and M4 all point at gaps in T-45's multi-index work. The daily-stop rule has the wrong column name, the symbol builder uses the wrong expiry formula for BankNifty/Sensex, and the margin rule doesn't account for mixed-index portfolios.

---

## VERDICT EXPLANATION

**FAIL.** We cannot proceed to testing until the two Critical findings are fixed. The multi-index feature does not work in live trading for BankNifty and Sensex (H1), and the daily loss-stop rule is inert or throws errors (C1). The nightly backtest also runs 1,095 unnecessary queries (C2), which is a performance issue that should be fixed in the same cycle.

The good news is that the defects are **contained**. The new S/R signal engine is solid. The safety rules for Clockwork (the frozen baseline personality) and personality comparison integrity are working correctly. All the naming conventions and code structure are sound.

The fixes are all in **T-45 (multi-index work)** and the **optimizer's backtest wiring** — neither of which requires touching the S/R detection core. With a focused Phase 6 fix cycle on C1, C2, and H1–H4, this should re-review cleanly.

---

## WHAT HAPPENS NEXT

We recommend a Phase 6 fix cycle:
1. Fix the database column references in C1 (daily stop and per-index leg cap)
2. Restructure the backtest runner to avoid the 3× and N+1 inefficiency (C2, with M3's guard)
3. Inject the pre-resolved expiry calendar for each index into the straddle calculator (H1)
4. Fix the null `personality_id` matching issue (H2)
5. Convert the date filter to use direct boundaries instead of wrapping the column (H3)
6. Add the early-exit for Levelhead in the evolution engine (H4)

After fixes, the Implementor will re-test and we will re-review before Gate 2 approval.

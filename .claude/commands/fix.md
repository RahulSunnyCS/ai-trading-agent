---
description: Run Phase 6 fix cycle only — delegate failing tests to the Implementor, re-run the test suite, and report results. Use when tests are already failing and you want to drive them to green without re-running the full pipeline.
---

Run Phase 6 (Test Execution Loop) as defined in CLAUDE.md. Do not re-run earlier phases.

Read the current test failure output (or run npm run test to get it fresh), then:

1. Identify exactly which tests are failing and why.
2. Delegate targeted fixes to the Implementor agent (.claude/agents/implementor.md).
   - The fix must stay within the scope of the failing test's subject — do not refactor surrounding code.
   - If a fix requires touching a file outside the original task scope, stop and ask before proceeding.
3. Re-run: npm run test
4. Repeat up to 2 automatic retry cycles maximum.

After each cycle, update pipeline/progress.md with the current pass/fail counts.

If tests are still failing after 2 retries:
- Stop immediately.
- Report: which tests are failing, the exact error messages, your diagnosis of the root cause, and what decision is needed from the user.
- Never silently retry more than twice.

If all tests pass:
- Report the final counts (X passing / Y total).
- Note any tests that were skipped or marked pending.
- Ask the user whether to proceed to Phase 7 (Final Review) or stop here.

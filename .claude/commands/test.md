---
description: Run Phase 5 test generation in parallel (unit tests, integration tests, docs), then execute them in the Phase 6 loop. Escalates test-writer to Opus at high effort when auth or PII risk flags are set.
---

Run Phase 5 (Test Generation) and Phase 6 (Test Execution Loop) as defined in CLAUDE.md.

Read pipeline/risk_manifest.json to check risk flags before starting:
- If auth or PII flags are set: use Opus at high effort for the test-writer agent.
- Otherwise: use Sonnet at medium effort.

Run these three agents simultaneously:
1. Unit Test Agent — .claude/agents/test-writer.md — cover happy path, edge cases, error cases, and all security-adjacent behaviour for auth/PII-flagged tasks.
2. Integration Test Agent — .claude/agents/test-writer.md with the integration flag — cover cross-module flows and API route behaviour.
3. Docs Agent — .claude/agents/docs-writer.md — add non-obvious inline comments, update pipeline/progress.md, write API reference entries for any new or changed endpoints.

Rules:
- Stub all external services (Anthropic, Stripe, Playwright, Lighthouse, Prisma, network). Never hit the network in any test.
- Test names must be clear and self-describing — a failing test name alone should tell a reader what broke.
- Each test must be isolated and runnable independently.
- Never use hardcoded secrets, real emails, or production credentials in test data.
- Security-adjacent tests are mandatory when the task involves auth, PII, or payment logic.

Then run Phase 6 (Test Execution Loop):
- Execute: npm run test
- If tests fail: delegate fixes to the Implementor agent (.claude/agents/implementor.md), then re-run.
- Maximum 2 automatic retry cycles.
- If still failing after 2 retries: stop immediately. Report exactly which tests are failing, why they are failing, and what decision is needed from the user. Never silently retry more than twice.

Update pipeline/progress.md after each cycle. Report final pass/fail counts when done.

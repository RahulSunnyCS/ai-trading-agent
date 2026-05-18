---
description: Run the QA Planner on demand to generate or refresh pipeline/qa-checklist.md from the current implementation plan. Useful for getting a QA checklist for an existing feature without running the full pipeline.
---

Run the QA Planner agent (.claude/agents/qa-planner.md) as defined in CLAUDE.md.

Read pipeline/risk_manifest.json to determine the risk level and flags before starting:
- If auth or PII flags are set: escalate qa-planner to Opus at high effort.
- Otherwise: run qa-planner on Sonnet at medium effort.

The agent reads the current implementation plan context and pipeline/risk_manifest.json, then writes pipeline/qa-checklist.md.

When done, display the full TIER SUMMARY from the checklist and ask: Shall I also run the E2E Test Writer to translate this checklist into Playwright tests?

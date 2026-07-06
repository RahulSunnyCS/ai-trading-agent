---
description: Generate the collated epic / large-chunk delivery document via the epic-doc-writer agent into docs/epics/.
---

Delegate to the Epic Doc Writer agent (.claude/agents/epic-doc-writer.md) to
produce the collated delivery document for the just-completed epic or large
work chunk.

The agent reads (read-only) pipeline/tasks/*.json, pipeline/reviews/*,
pipeline/progress.md, pipeline/risk_manifest.json, root TODO.md, the code/test
diff, and the latest test-run output, then writes a single file at
docs/epics/<epic-slug>.md following its template — what was done, how it helps,
limitations/tradeoffs and why, the tests the AI ran, manual test cases for
humans, and security/risk notes.

It must not modify TODO.md or pipeline/progress.md (orchestrator-owned). When
done, report the path written and a one-paragraph summary.

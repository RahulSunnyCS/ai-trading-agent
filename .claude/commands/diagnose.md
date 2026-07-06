---
description: Run Phase 0.7 Diagnosis for a bug whose root cause is not yet known. Read-only investigation — makes no code changes. Produces a Diagnosis Record at pipeline/diagnosis.md.
---

Run Phase 0.7 (Diagnosis) as defined in CLAUDE.md. This phase is read-only — make no code changes.

Use Sonnet at medium effort. Escalate to Opus at high effort if the root cause stays elusive after one full pass.

Goal: produce a Diagnosis Record at pipeline/diagnosis.md containing all four sections below. Do not proceed to planning until the root cause is confirmed with concrete evidence.

1. Reproduction steps
   - If reproducible: the exact steps, inputs, environment, and conditions that trigger the bug.
   - If not reproducible: document exactly what was tried and why it could not be reproduced.

2. Confirmed root cause
   - Cite specific file:line numbers and the mechanism — not a guess or hypothesis.
   - If the root cause cannot be confirmed with evidence, STOP and report to the user. Never hand a speculative cause to Phase 1.

3. Blast radius
   - What else does the same root cause touch?
   - Which other flows, modules, or users are affected by the same underlying issue?

4. Recommended fix direction
   - A brief, directional description of how to fix it — handed to Phase 1 planning, not implemented here.

Rules:
- Read code, logs, pipeline artifacts, and tests — but write nothing except pipeline/diagnosis.md.
- If the root cause cannot be confirmed, stop and surface findings to the user immediately (General Rule 4). Never let Phase 1 plan a speculative fix.
- An alarming finding (e.g. data exposure, auth bypass) must be surfaced immediately — do not wait for Phase 1.

When the Diagnosis Record is complete, report its path and a plain-English summary of the confirmed root cause, then wait. Phase 1 planning targets the confirmed cause; it does not run automatically.

---
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Run Phase 0.5 (Intent Extraction) as defined in CLAUDE.md, before Phase 1.

Interview me relentlessly about every aspect of this plan or design until we
reach a shared understanding. Walk down each branch of the decision tree,
resolving dependencies between decisions one-by-one. For each question,
provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase
instead of asking.

Stop when no open branch would change the plan, or when I say proceed. Then
emit a short resolved-decision record and feed it into Phase 1 planning. This
never replaces a Human Gate.

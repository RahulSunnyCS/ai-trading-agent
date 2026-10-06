# BL-015 — Research gate: pre-register every experiment, log every override

| | |
|---|---|
| **Priority** | P1 — protects every future result from the problems BL-010 had to undo after the fact |
| **Status** | In progress |
| **Type** | chore |
| **Area** | cross-cutting |
| **Created** | 2026-10-06 |
| **Depends on** | none (BL-010 is the worked example) |
| **TODO.md row** | 3.17 |

## Context

The process review on 2026-10-06 found that the rigorous research in this repo came from
hand-off specs written in planning sessions ("Do not run P4 … running it now would be
post-hoc"), while the default in working sessions was to build and explore. Examples:

- 2026-09-28: today's index list was accepted as the universe for every year. The session
  warned "no point-in-time history, no survivorship-bias-freedom"; the warning stayed in the
  chat and became BL-010's F1.
- 2026-10-03: the spec gated P4 off; P4 was run anyway on request.
- The search grew to about 44.6k logged runs before a pass rule existed.

## Goal

Every research item states its hypothesis, data cut-off and pass/kill rule *before* any run,
and any deviation is written down with a reason.

## Out of scope

- Fixing existing results (BL-010, BL-001).
- Showing validation status in the UI (BL-016).

## Plan

### Phase 1 — Experiment template
- **Tasks:** add a "Phase 0 — Pre-register" block to `_TEMPLATE.md` for `research` items:
  hypothesis, universe and its point-in-time source, look-ahead check, pass/kill rule,
  hold-out, what will *not* be run. Add `backlog/_EXPERIMENT.md` for single tests.
- **Deliverables:** template changes.
- **Done when:** the next research item is created from it.

### Phase 2 — Rule for sessions
- **Tasks:** one paragraph in `CLAUDE.md`: before a search or sweep, red-team the evaluation
  for look-ahead, survivorship and data-snooping; run a test the spec gated off only when the
  owner writes `override: <reason>`, and record that override in the spec's log.
- **Deliverables:** `CLAUDE.md` paragraph.
- **Done when:** a session asked to run a gated test asks for the override reason.

## Risks

- Too heavy a template gets skipped. Keep it to about 10 lines.

## Open questions

1. ~~Editable after a run, or replaced by a new dated rule?~~ **Replaced only** (owner took the
   recommendation, 2026-10-06): a rule is never edited after a run; a new, dated rule supersedes
   it with a logged reason, and both stay in the file.
2. ~~Where does a filled-in single experiment live?~~ **Inside the parent BL item**, in a dated
   `## Experiments` section (owner, 2026-10-06). `_EXPERIMENT.md` is only the block to paste.

## Log

- 2026-10-06 — created from the process review.
- 2026-10-06 — owner decisions on PR #27: recommendation taken; status Ready.
- 2026-10-06 — started; owner answered question 2. Built: Phase 0 — Pre-register in
  `_TEMPLATE.md`, `_EXPERIMENT.md`, both listed in `README.md`, and the research-gate paragraph
  in root `CLAUDE.md`. Phase 2 done. Phase 1 stays open until the next research item is
  created from the template.

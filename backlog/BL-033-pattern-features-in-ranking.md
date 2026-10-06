# BL-033 — Pattern and analog features in the Momentum ranking

| | |
|---|---|
| **Priority** | P2 — only meaningful once at least one of BL-030/031/032 passes its test |
| **Status** | Idea |
| **Type** | feature |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | a passed test in BL-030, BL-031 or BL-032; BL-010; BL-025 (live-money rules) before the weekly signal changes |
| **TODO.md row** | — (filled in when started) |

## Context

The owner's idea (2026-10-06): once pattern or analog work shows something, include it in the
backtesting ranking as an additional input for a better stock pick. Split from the same
discussion as BL-030, BL-031 and BL-032.

Assessment: fine, as a feature with a pre-registered incremental test — never as a new scoring
rule added because a chart looked good. The ranking must stay reproducible under BL-001's
goldens, and the weekly signal must not change until BL-025's rules and BL-024's journal are in
place.

## Goal

A passed feature becomes an optional, parameterised input to `compute_universe_ranking`, off by
default, covered by goldens, and selectable in the dashboard's Broad Momentum tab with its
validation status shown (BL-016).

## Out of scope

- Adding any feature that has not passed its own item's pre-registered test.
- Changing the default ranking without an explicit owner decision logged here.

## Plan

### Phase 1 — Engine hook
- **Tasks:** a generic "extra feature" input to the ranking (blend weight or filter), golden
  tests for on/off.
- **Done when:** off-state output is byte-identical to today's.

### Phase 2 — Wire the passed feature(s)
- **Tasks:** connect the passed feature; sweep its weight under BL-015; record results.
- **Done when:** results logged; default decision recorded.

### Phase 3 — UI and signal
- **Tasks:** toggle on the Broad tab with validation status; weekly signal unchanged unless the
  owner decides otherwise.
- **Done when:** owner decision logged.

## Risks

- Feature creep into the ranking erodes the clean momentum baseline that everything else is
  measured against.

## Open questions

1. Blend or filter as the integration shape?
2. Does a feature go into the live weekly signal at all, or stay research-only?

## Log

- 2026-10-06 — created from the owner's ranking-integration idea.

# BL-174 — Options rotation: the registered read-out at 60 trading days of the forward journal

| | |
|---|---|
| **Priority** | P1 — the verdict the whole forward test exists for; due once the journal has 60 scored trading days (first entry Mon 2026-10-12, so about early January 2027) |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | [BL-058](BL-058-options-rotation-forward-journal-and-ui.md) (the journal), BL-058 Phase 0 (the pre-registered rule) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-058 built a hash-chained forward paper journal of the rotation lists (A, B, C, REF), first entry Mon 2026-10-12 09:16. Its Phase 0 pre-registered a review at 60 trading days; BL-058 was closed on 2026-10-28 with that review split out to this item. `uv run obt rotation readout` already computes the registered figures (per list gross, ₹ per lot-day, drawdown, share of random baskets beaten, list minus REF and minus the fixed base with a 5-day block-bootstrap 90% interval).

## Goal

Once 60 forward trading days are scored: run `obt rotation verify` (chain intact) and `obt rotation readout` on exactly the first 60 days, apply BL-058 Phase 0's rule unchanged, and record the verdict (adopted / killed / inconclusive) here and on the `research/` pages it tested.

## Plan

- **Phase 1 — Read-out.** Verify the chain; run the read-out on days 1–60; write the verdict against the pre-registered rule; update `research/`. **Done when:** the verdict is in the Log and `research/` pages are updated in the same commit.

## Log

- 2026-10-28 — created when the owner closed its parent item (2026-10-28). Status `Planned`.

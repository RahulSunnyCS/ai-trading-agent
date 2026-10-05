# BL-023 — Personalities as strategy-plus-filters over historical data

| | |
|---|---|
| **Priority** | P3 — the owner has not decided the direction; revisit at the end of the month |
| **Status** | Idea |
| **Type** | research |
| **Area** | options, server |
| **Created** | 2026-10-06 |
| **Depends on** | BL-009 (verified engine on vendor history); BL-022 is a candidate filter |
| **TODO.md row** | — (filled in when started) |

## Context

The original product (`apps/server`) runs 10 personalities, each filtering live signals through
5 stages (hard filters → state → context → signal quality → profit gate). It is frozen
(BL-019): the probability scores were never calibrated and nothing is deployed.

Owner, 2026-10-06: not clear on this yet; once the backtester and data exist, personalities
could run over that data.

The direction suggested in the discussion: a personality becomes "a strategy plus a set of
filters", replayed over years of vendor history in the BL-009 engine instead of live ticks.
BL-022's analog-day result could be one context filter (e.g. skip straddle selling when today's
nearest analogs trended).

## Goal

To be set when the item is planned.

## Open questions

1. Keep the TypeScript live engine, or move personalities into the Python backtester?
2. Which of the 10 personalities are worth keeping as hypotheses?

## Log

- 2026-10-06 — created as an idea from the product discussion.

# BL-179 — Momentum Journal redesign, and the delay-0 estimates deferred from BL-051

| | |
|---|---|
| **Priority** | P2 — the Journal already records, verifies and scores every week (BL-024); this makes it readable, it does not change what is recorded |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum (dashboard + API) |
| **Created** | 2026-10-28 |
| **Depends on** | BL-051 (Done 2026-10-28; its This week page and Your orders), BL-024 (journal, forward score, Kite fills), BL-142 (lot ledger) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-051 was closed by the owner on 2026-10-28 (asked in chat). Two parts of it were never built and move
here:

- **Phase 6, the Journal redesign.** Planned in BL-051: a one-line tamper check, favourite and date
  filters, a weeks × favourites grid (final / preview), holdings over time with turnover, agreement
  between favourites, an entries list and an entry drawer (a correction beside the original, the model
  portfolio before and after, fills, record fields), and "Is it behaving like the backtest?" with a band
  from the backtest's own returns over the same number of weeks. Since then BL-024 added the Forward score
  card and the Real fills card (Kite contract notes, per lot rebalance) to Momentum › Journal; fills come
  from there now, not from BL-051's dropped Fyers Phase 4.
- **Deferred on 2026-10-09, not dropped:** delay-0 live estimates on This week, and the "Since your 14:15
  orders" card (what the 19:30 final changed against the stored 14:15 orders). Every followed favourite
  uses a one-week signal delay, so the 14:15 decision is exact and both would show nothing new. BL-158
  kept the followed group at delay 1. BL-024's Log notes one case where the 14:15 orders and the 19:30
  final disagreed for a lot, which is what the card would show.

## Goal

A missing week and a correction stand out on the Journal; an entry's drawer shows a correction against the
original; the "behaving like the backtest" chart matches `mbt journal score` / `mbt live-rules check` for
the headline. The delay-0 estimates and the "Since your 14:15 orders" card exist when a delay-0 favourite
is Paper or Invested, or earlier if the owner asks.

## Out of scope

- Changing what the journal records, its hash chain or the score (BL-024).
- Placing or preparing orders (BL-150).

## Plan

### Phase 1 — Journal redesign (BL-051 Phase 6)
- **Tasks:** the tamper line, filters, weeks × favourites grid, holdings over time with turnover, agreement
  between favourites, entries list and drawer, the backtest band chart; reuse the Forward score and Real
  fills cards; the Analytics page pattern (`apps/dashboard/CLAUDE.md`); Guide page updated.
- **Deliverables:** the page, any read-only API it needs, tests, Guide.
- **Done when:** on the live journal a missing week and a correction stand out in the grid, an entry's
  drawer shows the correction against the original, and the chart matches the score for the headline.

### Phase 2 — "Since your 14:15 orders"
- **Tasks:** compare the stored 14:15 orders (`momentum_orders`) with the 19:30 final per favourite (per
  lot under the lot ledger) and show the difference on This week.
- **Done when:** a Friday where the two differ shows the difference, and one where they agree says so.

### Phase 3 — Delay-0 live estimates (only when a delay-0 favourite is followed)
- **Tasks:** at 14:15, an estimate on live prices for a delay-0 favourite, in memory and marked
  provisional, never journalled or sent (BL-051's 2026-10-08 rules).
- **Done when:** a delay-0 favourite shows a provisional estimate on This week that the 19:30 run replaces.

## Risks

- The Journal reads the catalog while Friday jobs write it: read-only, and a locked catalog shows the last
  answer rather than nothing.

## Open questions

- Is the "Since your 14:15 orders" card wanted now, given the lot disagreement BL-024 found, or only with a
  delay-0 favourite? Ask when started.

## Log

- 2026-10-28 — created from BL-051's Phase 6 and its two deferred items when the owner closed BL-051
  (owner, asked in chat, 2026-10-28). P2.

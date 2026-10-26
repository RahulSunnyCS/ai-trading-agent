# BL-169 — Discretionary trade journal: why each manual trade was taken, what overriding the algos cost, behaviour patterns

| | |
|---|---|
| **Priority** | P2 — answers "does my discretion add value?" in rupees, but needs BL-168's trades by source first |
| **Status** | Planned |
| **Type** | feature |
| **Area** | contract-notes / scheduler / dashboard |
| **Created** | 2026-10-26 |
| **Depends on** | BL-168 Phase 4 (round trips with their source: `manual`, `own-algo`, `adaptive-core`, `t1`), BL-141 (live capture), BL-058 (paper results of the picks) |
| **TODO.md row** | — (filled in when started) |

## Context

Split out of BL-168 on 2026-10-26 (owner: "let's do all"). BL-168 records every fill from the
contract notes and tells the tool's trades from the owner's own: the live capture (BL-141)
already marks each platform strategy as the tool's or discretionary, and a fill that matches
no platform strategy is a pure manual trade. What the notes cannot say is *why* a manual trade
was taken, and what the owner's interventions in the algos (an early exit, a skipped pick)
did to the result. Those need either one tap from the owner or a comparison with the paper
journal.

## Goal

- Every manual round trip carries the owner's reason (setup, planned stop, followed plan),
  given in one Telegram tap or on the page, never typed at length.
- Every override of an algo leg (exited early, skipped, resized) is listed with what holding
  it would have made (paper), and the running total says in rupees whether interventions help.
- The page shows behaviour patterns computed with no input: trades after a losing trade the
  same day, trades per day, time of day, size after winning and losing streaks.

## Out of scope

- Any automatic action on the patterns (blocking a trade, a size cap): descriptive only. A
  pattern worth acting on ("no discretionary trades after 14:00") is pre-registered and tested
  on later days under the research gate before anything changes.
- Placing or cancelling orders.

## Plan

### Phase 1 — Tags, next morning
- **Tasks:** after the 00:00 contract-notes job, a Telegram message to the owner (private chat
  only) listing the previous session's manual round trips, each with one-tap buttons for the
  setup (a short fixed list, editable in Settings) and "followed plan: yes / no"; a planned
  stop as an optional reply. Taps go through the scheduler's one `getUpdates` consumer (the
  stop button's listener, BL-143), stored in `TRADING_DATA_ROOT/contract-notes/tags/<day>.jsonl`.
  The page shows and edits the same tags.
- **Done when:** a day's manual trades are tagged from the phone in under a minute, and the
  tags show on the page.

### Phase 2 — Overrides
- **Tasks:** for each tool strategy (Adaptive Core, T1) compare the live fills with the paper
  result of the same pick: exited earlier or later than the paper exit, skipped, different
  lots; for each, the paper P&L of holding as the strategy said; a running total.
- **Done when:** every override since 2026-10-19 is listed with its rupee effect, and the total
  reconciles with live minus paper for those legs.

### Phase 3 — Behaviour
- **Tasks:** from the round trips: trades after a losing trade the same day and their result,
  trades per day, time-of-day spread, lots after a winning or losing streak, holding time of
  winners against losers; the results by tag once Phase 1 has data.
- **Done when:** the page's behaviour card shows each figure with the number of trades behind
  it, and none is shown on fewer than 20 trades.

### Phase 4 (later) — Intraday prompt
- **Tasks:** the trade monitor (BL-143) already polls the platforms minute by minute; a new
  discretionary position could prompt the tag at once instead of next morning.
- **Done when:** decided with the owner after a month of Phase 1.

## Risks

- **Prompt fatigue** — a long list every morning goes unanswered. Mitigation: only manual trades,
  at most one message a day, untagged trades stay listed on the page.
- **False patterns** — many tags and slices always show one that looks good by chance; see Out
  of scope.

## Open questions

1. Where are discretionary trades placed: the same Finvasia and Angel One accounts, through
   AlgoTest / Quantiply as the owner's own strategies, or directly in the broker apps?
2. The setup list to start with (breakout, fade, hedge, news, other?).
3. Next-morning prompt time: right after the 00:00 job (silent notification), or with the 09:00
   morning summary?

## Log

- 2026-10-26 — created from BL-168 (owner: "let's do all"); Planned.

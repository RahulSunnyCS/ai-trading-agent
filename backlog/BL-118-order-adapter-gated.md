# BL-118 — Order adapter for the rotation picks on Angel One, gated (was the uncommitted BL-113 execution item)

| | |
|---|---|
| **Priority** | P2 — owner wants it later; it waits for the BL-058 read-out and for BL-117's paper desk anyway |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-16 |
| **Depends on** | BL-058 (the 60-day read-out is the gate), BL-117 (the live feed, the paper desk and its parity: this item's old Phases 1–2 live there as Phase 4), BL-093 / BL-026 (the real fill for the evening comparison) |
| **TODO.md row** | — (filled in when started) |

## Context

The 09:16 rotation pick (BL-058) records what Adaptive would trade, but placing it is manual.
Discussed 2026-10-16:

- **Quantiply** (the owner's platform for a long time; free on Angel One, about ₹750 a month for a
  3-basket plan on Shoonya) has Custom Scripts signals: a webhook with no parameters that fires
  algos set up beforehand. Quantiply paused all its algo services on 31 March 2026 for SEBI's
  retail algo framework (every algo order needs an exchange Algo-ID). Its notice is dated
  28 March 2026. Whether signals came back is unconfirmed.
- **AlgoTest's** custom-position API needs its Signals plan (declined on cost,
  `docs/algotest-execution.md`). Saved strategies carry their own entry time.
- **Interim, owner's choice (manual):** set up Core-298's shapes once on AlgoTest and on
  Quantiply, then each morning change the entry time of the picked ones and deploy them.
  - Within a shape, the 25 variants differ only in entry time. The two Buy shapes also move their
    range window end to entry + 10 min.
  - Exit times are fixed (15:28 sells, 15:14 Buy).
  - Over the BL-106 replay year (Adaptive on Core-298, 243 days):
    - The same shape was picked more than once in a day, so 12 algos are not enough on their own.
      12 shapes plus a second copy of N_wide, N_p80, N_p100, S_wide, S_p250 and S_p320 = **18**,
      which covers every day but 5.
      A third copy of N_p80, N_p100 and S_p320 = **21**, which covers all of them.
    - A 09:17 pick came on 64 days, about a minute after the 09:16 message. Keeping every saved
      copy at 09:17 means such a pick needs only Deploy.

This item replaces both platforms with our own engine: the code that picks a strategy also runs
it. The legwise engine already applies AlgoTest's rules and matches AlgoTest's backtests to the
rupee. But it runs over finished 1-minute bars. It takes the bar close as the price and checks
stops against each bar's high and low afterwards. It is not a live, tick-driven engine.

## Goal

Once BL-058's read-out passes, BL-117's paper desk has run the picks on live data with measured
parity, and the owner has said so on record: the same engine that picks a strategy places it on
Angel One, with stop-losses resident at the exchange, a kill switch and a daily loss cap.

The live paper run (old Phase 1) and the three-way comparison (old Phase 2) are BL-117 Phase 4:
`backlog/BL-117-live-desk-and-paper-agents.md`. This item is the order adapter only.

## Out of scope

- Automating AlgoTest or Quantiply (the interim stays manual).
- New-536 / New-556, until one beats Core-298 on forward days (BL-106).
- Any trade for anyone but the owner's own account.

## Plan

### Phases 1–2 — moved to BL-117 (Phase 4: paper desk, live = replay, slippage)

Kept here only as a pointer. The paper desk steps the existing legwise state machine on live bars,
logs the bar-rule fill and the quote fill for every event, and compares each evening against the
stored legwise result and (BL-093) the real fill.

### Phase 3 — Order adapter (gated: BL-058 read-out passed **and** BL-117 Phase 4 parity **and** an owner decision on record)
- **Tasks:**
  - Angel One order placement.
  - Right after each entry fill, an SL-M order at the exchange, with trailing done as SL
    modifications. If the process dies, the stop and the broker's intraday square-off remain.
    Only the trailing and the overall ₹ stop are lost.
  - A ledger row before every send, with no blind retries.
  - Position reconciliation against the broker after every fire.
  - A kill switch: exit all and cancel all, from Telegram and the dashboard.
  - A daily ₹ loss cap.
  - Paper/dry-run by default, then minimum lots, then 2 lots.
  - Compliance: the broker's API setup under the April 2026 framework (static IP, 2FA, algo
    tagging; personal use under 10 orders/sec). The `business.md` / `overview.md` line "places
    no orders" is rewritten in the same commit.
- **Deliverables:** `obt live orders` (the BL-117 paper desk with an order sink), the kill switch, and
  the compliance note in `business.md`.
- **Done when:** 10 days at minimum lots, with no unreconciled position and the kill switch
  tested live.

## Risks

- **Laptop asleep or offline during the session.** Mitigation: exchange-resident stops (Phase 3)
  and a missed entry is skipped and alerted, never fired late. Moving to the Mac mini removes most
  of it.
- **Live feed gaps and tick-vs-bar fills** are BL-117's (its Phases 2 and 4); this item inherits
  their measured numbers and does not start before they exist.
- **Regulation changes again** (Algo-ID, static IP). Phase 3 starts with a check of the broker's
  current rules.

## Open questions

- Which account places orders in Phase 3: Angel One only, or Shoonya too?
- Does the owner have a static IP, or does Phase 3 need the Mac mini or a small VPS?
- The daily loss cap in rupees, and whether BL-095's basket stop is part of Phase 3.

## Log

- 2026-10-16 — created (as BL-113) after the Quantiply / AlgoTest discussion. The owner places picks
  by hand on both platforms for now (12–21 saved shapes, entry time changed each morning). This
  engine waits.
- 2026-10-17 — renumbered BL-118 (BL-113 is the committed T1 track; this file was never committed).
  Phases 1–2 (live paper run, three-way comparison) moved to BL-117 Phase 4; this item keeps the
  order adapter, now gated on BL-117's parity as well. "Shadow" dropped from the title (it is the
  BL-083 scoreboard's name).

# BL-152 — Margin check: a free-margin read that does not need AlgoTest or Shoonya's login, a checked estimate, and switching it on

| | |
|---|---|
| **Priority** | P2 — a useful pre-market safety read, but nothing depends on it and the owner has parked it (2026-10-22) |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | broker-login |
| **Created** | 2026-10-22 |
| **Depends on** | BL-143 Phase 3 (the check is built); the owner's decision on AlgoTest / Shoonya (Phase 1) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-143 Phase 3 built a read-only margin check in the trade monitor (`MARGIN_CHECK=on`, 09:05–09:10): per broker
account, the free margin against what the day's picks need, one Telegram message, "look before 09:16" when an
account is short. It is **off**: `MARGIN_CHECK` is not in `.env`.

How it works today (`packages/broker-login/src/trade-monitor.ts`, `monitor-plan.ts`):
- **The picks counted:** the day's exports, per Settings › Automation row that uploads, scaled by the row's
  multiplier (BL-140 Phase 4); a Buy add-on switched off is not in the export, so not counted.
- **The need (an estimate):** half the underlying's short-straddle margin (`margin.csv`, NIFTY's when the underlying
  has none) per sold leg-lot; premium × lot per bought leg-lot, known only for a leg chosen by closest premium (a
  leg chosen by strike is "not estimated"); no hedge benefit; every pick counted at once.
- **Free margin:**
  - Angel One: one guarded SmartAPI login and one `getRMS` read (`obt angel funds`).
  - Shoonya (Finvasia): AlgoTest's `GET /brokers`, after an AlgoTest login, accepted only if AlgoTest refreshed it
    today. Shoonya's own API is never logged in to. A reading on 2026-10-22 gave ₹11,97,275 as of AlgoTest's
    08:17 IST broker login: a morning snapshot, not live.
- **Verdict:** ok, tight (free under a 20% cushion over the need), short (free below the need), unknown (picks or
  funds not read).

Owner, 2026-10-22: asked not to use AlgoTest or Shoonya for now, and asked whether a Shoonya API key that AlgoTest
uses can also be used by us. A search found no official statement. The belief (unverified) is one active session
per user, so our own Shoonya API login could log AlgoTest out mid-day; that is why the check never logs in to
Shoonya.

## Goal

The owner sees, before 09:16, whether each account that trades the day's picks has enough free margin, with no
login to a platform they have stopped using, and with the need estimate checked against what the broker really
blocked, so a "SHORT" or "ok" can be believed.

## Out of scope

Placing or changing anything; moving funds or pledging holdings; any order-time margin check.

## Plan

### Phase 1 — Decide the Shoonya source
- **Tasks:**
  - Ask Finvasia support: can one API key serve several apps, and does a login from one app end another's session?
  - Or settle it by a test the owner chooses (a Shoonya API login, then AlgoTest's broker-login count).
  - Or drop Shoonya from the check if AlgoTest · Shoonya is retired (a row that does not upload is already skipped, so
    turning that row off in Settings is enough).
- **Deliverables:** the owner's choice recorded here: direct Shoonya read, AlgoTest-mediated read, or Angel One only.
- **Done when:** the choice is in the Log.

### Phase 2 — Check the estimate against the broker
- **Tasks:**
  - On a trading day, compare the estimate with the margin Angel One actually blocked for the day's positions
    (the funds read before and after the entries) and, if SmartAPI offers a margin calculator, with its figure for
    the same legs (to be checked).
  - Say which legs the half-straddle rule gets wrong (hedged buys, Dir strategies chosen by strike).
- **Deliverables:** estimate vs actual for a few days; a corrected rule if the gap is large.
- **Done when:** the gap is known and either small or corrected.

### Phase 3 — Switch it on
- **Tasks:** set `MARGIN_CHECK=on`; restart the scheduler; watch 09:05–09:10 on a trading day.
- **Deliverables:** the Telegram message on a real morning.
- **Done when:** the figures match what the broker apps show (BL-143 Phase 3's own exit check).

## Risks

- **A second Shoonya session ending AlgoTest's** (Phase 1): the reason the direct read is not built.
- **A stale AlgoTest figure** looking current: the check already refuses one not refreshed today and says so.
- **A wrong "ok"** from an estimate that ignores hedges: Phase 2 exists to find out before it is trusted.
- **A login in the 09:10–09:25 window:** the monitor never logs in then; the check stays inside 09:05–09:10.

## Open questions

- Is AlgoTest · Shoonya being retired, or only paused? That decides Phase 1.
- Should "short" ever block anything? Proposed: no, alert only (as BL-143 decided).
- Is a 20% cushion the right "tight" line?

## Log

- 2026-10-22 — Created from the owner's "move the margin thing to a P2 backlog" after a conversation about how the
  check works, Shoonya's session rules (unconfirmed) and a one-off read of Shoonya's margin from AlgoTest. Priority
  P2 as the owner asked.

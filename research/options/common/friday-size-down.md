# Options: trading less on Fridays

**Status:** Tested (pending: the forward verdict reads about 2 April 2027) · **Last updated:** 2026-11-12

## What it is

Whether Adaptive should trade less on Fridays, the day furthest from both weekly expiries since January
2025. [BL-220][bl220] tests three rules against trading as now (R0): **R1** drops the core pick with the
lowest list C composite (and the Buy add-on) on Fridays, **R2** skips Fridays, **R3** drops every Friday pick
that starts at 13:00 or later. A rule passes if net per session falls no more than 5 % and the worst drawdown
(trough within 20 sessions of the peak) is at least 10 % smaller. Nothing in the product applies any of them.

## Live value

None: every pick trades every day.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-220][bl220] Phase 1 (A) | Friday against the other weekdays, the strategy universe | BL-071's 124 NIFTY variants, 2022-04-05 → 2024-10-08 (618 sessions, P3), gross at 0 % slippage | **Pass, narrowly**: Friday ₹81 against ₹192 a strategy-day, gap ₹111 (bar ₹100), one-sided p 0.012 (bar 0.05) | `research/bl220/out_mechanism_2026-11-12.txt` (tracked) |
| [BL-220][bl220] Amendment 1 (A2) | R1, R2, R3 against R0 on the books | BL-214's NIFTY-only T1 and Core, 2021-11-02 → 2024-10-08 (722 sessions, 144 Fridays), core picks, one lot, 0.5 % slippage, after brokerage | **T1: R2 and R1 pass, R3 fails. Core: none passes** (reported beside) | `research/bl220/out_a2_2026-11-12.txt` (tracked) |
| [BL-220][bl220] Amendment 1 (S) | the same, in-sample | live store, 2025-01-10 → 2026-11-12 (445 sessions, 88 Fridays), picks as Day by day takes them | Descriptive only (the days that suggested the idea; T1 tuned on them) | `research/bl220/out_insample_2026-11-12.txt` (tracked) |
| [BL-220][bl220] Phase 2 (B) | R1, R2, R3 against R0 | T1's journal, the first 20 Fridays from 2026-11-13 | **The verdict; not read yet** (about 2 April 2027) | `research/bl220/book.py b` |

## What we know

- **Strategies earn less on Fridays far from expiry.** On NIFTY 2022–24 (Thursday expiry) the universe made
  ₹81 a strategy-day on Fridays against ₹192 on other days, a narrow registered pass; Monday, also far from
  expiry, was nearly as weak (₹103). On 2025–26 the same shape (descriptive, [BL-221][bl221]; expiry
  Fridays left out). Days to expiry, not the weekday.
- **For T1, skipping Fridays or dropping the weakest Friday pick helped on 2021–24 (A2, NIFTY only).** R0
  ₹191 a session, worst drawdown ₹50,764; R2 ₹230 and ₹39,761; R1 ₹195 and ₹43,275. T1's Fridays averaged
  −₹195 after brokerage there. Core's Fridays were about zero (−₹19), so no rule moved its drawdown enough.
- **Dropping afternoon starts (R3) hurt in every read.** T1's Friday mean fell from −₹195 to −₹373 (A2) and
  from −₹279 to −₹389 (S): the books' afternoon Friday picks made money, although the universe's afternoon
  is where Friday falls behind (BL-221). A universe pattern does not carry to the picks.
- **In-sample (S) says the same, and is not evidence.** T1 R0 ₹951 a session (₹4.23 lakh), R1 ₹1,014, R2
  ₹1,006, R3 ₹929; R2's worst drawdown ₹30,926 against ₹45,112, mostly the Oct–Nov 2026 drawdown, whose
  three Fridays averaged −₹4,664.

## Not yet tested

- Phase 2 (hold-out B), the decision: 20 live T1 Fridays from 2026-11-13.
- SENSEX books before 2025, and any expiry calendar other than the two seen.

## Related

- [Widesl weekday](../strategies/widesl/weekday.md), [Directional weekday](../strategies/directional/weekday.md),
  [Buy weekday](../strategies/buy-breakout/weekday.md) (BL-221's family tables).
- [Rotation ranking](rotation-ranking.md) (the weekday and days-to-expiry fits inside the ranking).

[bl220]: ../../../backlog/BL-220-friday-size-down.md
[bl221]: ../../../backlog/BL-221-friday-by-family.md

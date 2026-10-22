# BL-157 — Overnight short straddle into expiry morning: far hedges, NIFTY and SENSEX, exit minute

| | |
|---|---|
| **Priority** | P2 — a follow-up of BL-156 read 4 on stored 1-minute bars |
| **Status** | In progress (registered 2026-10-23, before any run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-23 |
| **Depends on** | lake option and index 1-minute bars, BL-063 charges |
| **TODO.md row** | 3.10.40 |

## Context

BL-156 read 4 found an overnight ATM short straddle (sell at the 15:25 bucket, buy back at the 09:20 bucket's
close) made +₹232 a night on NIFTY 2024-10 → 2026-10, all of it from the first nine minutes of the morning; the
nights into expiry morning (dte 1 at entry) made +₹1,153 over 93 nights, worst −₹12,038. The owner (2026-10-23)
asked to try it with far hedges ("6 legs away"), on SENSEX as well as NIFTY, split by DTE 0 and 1, and with the
exit at 09:17.

This is a second look at a number already seen, so the learning-period table below is **descriptive only**; the
one registered test runs on days nobody has looked at.

## Definitions (registered)

- **Night:** trading day d and the next trading day d+1 (from the index lake's days; a night runs only if
  neither day is excluded by data_quality).
- **Entry (day d, 15:25):** spot = the index's price at 15:25 (the close of the 15:24 bar, the engine's
  convention). ATM = the strike nearest that spot (NIFTY step 50, SENSEX 100). Expiry = the nearest one listed
  that day that is **after** d (so an expiry-day entry sells next week's). Sell 1 lot ATM CE + ATM PE at their
  price at 15:25.
- **Hedge `h6`:** also buy 1 lot CE at ATM + 6 steps and PE at ATM − 6 steps, same expiry, same minutes
  (NIFTY ±300, SENSEX ±600 points). Variant `none`: no hedge.
- **Exit (day d+1):** buy back every leg at one of `0915` (the open of the 09:15 bar), `0917`, `0920`, `0924`
  (the close of the bar before that minute). "SL at 09:17" in the owner's words is read as the 09:17 exit.
- **Prices:** a leg's price at a minute is the close of the bar before it; if that bar is missing, the latest
  close in the 10 minutes before it on the same day; else the night is skipped for that variant and counted.
- **DTE at exit:** trading days from d+1 to the expiry: **DTE 0** = the exit morning is expiry day (the owner's
  "into expiry"), **DTE 1** = the day before expiry, **DTE 2+** the rest.
- **Lots and charges:** lot_sizing current (NIFTY 65, SENSEX 20); BL-063 charges on the night's turnover
  (4 orders unhedged, 8 hedged), dated d+1. No slippage; 0.5% and 1% per fill reported beside.

## Phase 0 — Pre-register (committed before any run)

**Learning period, descriptive (no verdict):** NIFTY and SENSEX, nights with d in 2024-10-09 → 2026-10-08. A
table index × hedge × exit × DTE group: nights, mean net, t, hit rate, worst night, max drawdown.

**The one registered test (primary):** NIFTY, **DTE 0** nights, hedge **h6**, exit **0917**, on the unseen
period **2022-01-03 → 2024-10-08**. **Pass** if the mean net per night is > 0 with t ≥ 2 (nights independent).
Fail otherwise. Reported beside it with the same bar, not counted toward the verdict: the same cell unhedged,
and the same cell on SENSEX 2023-07-26 → 2024-10-08 (all the earlier SENSEX option data there is).

**Will not run:** other wings, other times, a stop inside the night or the morning, other DTE groups as the
primary, any change after a result is seen. A pass makes a new item for a forward paper journal and the real
margin of the hedged position; it is not adopted from here.

## Risks

- **Second look:** the idea was chosen from BL-156's best cell; the 2022–24 test is why that is acceptable.
- **Thin far strikes in vendor data:** OTM6 may lack bars on some 2022–24 nights; skips are counted and
  reported, and a hedged cell with more than 10% skips is flagged.
- **Fills at the open:** 09:15–09:17 prints are wide; the 0.5% / 1% slippage lines matter more here than for
  intraday strategies.
- **Expiry weekday changed** (NIFTY Thursday until 2025-08, then Tuesday): DTE is counted in trading days
  from the expiry actually listed, so the groups stay comparable.

## Result

(after the run)

## Log

- 2026-10-23 — Registered from the owner's follow-up to BL-156 read 4, before any of these cells were
  computed.

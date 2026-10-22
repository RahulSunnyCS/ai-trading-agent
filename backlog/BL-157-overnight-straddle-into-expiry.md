# BL-157 — Overnight short straddle into expiry morning: far hedges, NIFTY and SENSEX, exit minute

| | |
|---|---|
| **Priority** | P2 — a follow-up of BL-156 read 4 on stored 1-minute bars |
| **Status** | Done: failed (2026-10-23) |
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

**Failed.** The registered test (NIFTY, DTE 0, hedged OTM6, exit 09:17, 2022-01-03 → 2024-10-08): **−₹34 a night,
t −0.29**, hit 61%, 143 nights (1 of 144 skipped for a missing price), worst −₹5,935, max drawdown −₹16,581. The same
cell unhedged: +₹168, t 0.90, worst −₹12,856. Neither is near t 2. SENSEX 2023-07 → 2024-10 is unusable: the vendor
SENSEX option files cover only about 8 nights, so the supporting check did not run in any useful sense.

Learning period, NIFTY and SENSEX 2024-10-09 → 2026-10-08 (descriptive; ₹ net per night, one lot, after charges;
the full table is what the script prints):

| Index | Exit DTE | Hedge | 09:15 open | 09:17 | 09:20 | 09:24 | Worst night (09:17) |
|---|---|---|---|---|---|---|---|
| NIFTY | 0 | none | +153 (t 0.31) | **+638 (t 1.57)** | +710 (1.61) | +731 (1.53) | −31,590 |
| NIFTY | 0 | OTM6 | +113 (0.75) | +140 (0.80) | +192 (1.03) | +206 (1.01) | −9,083 |
| NIFTY | 1 | none | +270 (1.52) | +461 (1.81) | +454 (1.65) | +381 (1.29) | −14,816 |
| NIFTY | 1 | OTM6 | +49 (0.31) | −87 (−0.98) | −113 | −178 | −3,759 |
| NIFTY | 2+ | none | −330 (−2.13) | −221 (−1.23) | −259 | −272 | −37,122 |
| NIFTY | 2+ | OTM6 | −214 | −209 (−5.25) | −225 | −246 | −5,331 |
| SENSEX | 0 | none | −410 (−1.56) | +266 (0.92) | +310 (1.05) | +202 (0.62) | −17,156 |
| SENSEX | 0 | OTM6 | −497 (−3.74) | −191 (−1.94) | −180 | −242 | −3,900 |
| SENSEX | 1 | none | −1,149 (−1.98) | −581 (−1.54) | −807 | −725 | −21,605 |
| SENSEX | 1 | OTM6 | −638 | −306 (−4.94) | −303 | −314 | −2,269 |

What the table says:

- **The hedge works as insurance and kills the return.** OTM6 wings cut NIFTY DTE 0's worst night from −₹31,590 to
  −₹9,083, but the mean falls from +₹638 to +₹140; on every other DTE and on SENSEX the hedged version loses with
  t down to −5 to −9 (the wings' premium and four extra orders cost more than the straddle keeps).
- **The 09:15 open is where it dies.** Exiting at the open gives little or nothing (NIFTY DTE 0 +₹153, SENSEX
  −₹410); the gain is the first two to nine minutes' premium fall, as BL-156 found. That is an intraday effect
  that does not need an overnight position.
- **SENSEX does not show it.** Unhedged DTE 0 +₹266 (t 0.92), DTE 1 −₹581.
- **Only NIFTY into expiry morning, unhedged, looks positive in the learning period**, and on 2022–24 that cell is
  +₹168, t 0.90: the effect roughly a quarter the size and not distinguishable from zero.
- Slippage of 0.5% a fill takes ₹100–150 a night off every hedged cell and ₹80–120 off the unhedged ones.

## Log

- 2026-10-23 — Registered from the owner's follow-up to BL-156 read 4, before any of these cells were
  computed.
- 2026-10-23 — Run (`research/bl157/overnight_hedged.py`, about two minutes). **Failed:** −₹34 a night, t −0.29 on
  NIFTY 2022–24; SENSEX 2023–24 had about 8 usable nights (vendor coverage), so no supporting read. Nothing was
  changed after the run.
- 2026-10-23 — **Descriptive, after the verdict (owner's request): the 09:17 cells by VIX band** (India VIX at
  15:25 on the entry day, the repo's bands < 13 / 13–15 / 15–18 / 18+; 48 cells, so this is data mining). The
  only band positive in all three sets for the unhedged DTE 0 night is **15–18**: NIFTY 2024–26 +₹846 a night
  (t 2.16, 16 nights, max drawdown −₹3,880), NIFTY 2022–24 +₹577 (t 2.79, 28 nights, −₹1,577), SENSEX 2024–26
  +₹923 (t 2.59, 17 nights, −₹1,375). Every other band flips sign between sets; 13–15 holds the three worst
  nights (−₹31,590, −₹37,122 and −₹25,479 across the cells). Hedged OTM6 loses in most bands (SENSEX every band, t
  −3 to −4). Because the band was chosen after looking at 2022–24 as well, no period is left to confirm it; only
  a forward record could, at about 13 qualifying nights a year per index.

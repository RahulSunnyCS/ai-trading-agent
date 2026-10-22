# BL-153 — Does Bank Nifty, Nifty IT and Reliance support make a NIFTY breakout better?

| | |
|---|---|
| **Priority** | P2 — the owner's follow-up to BL-152; evidence only |
| **Status** | In progress (Phase 0 registered 2026-10-22, before any BL-152 result was seen) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-22 |
| **Depends on** | BL-152 (its breakout rule, events and variants); a valid Fyers login for the data download |
| **TODO.md row** | 3.10.36 |

## Context

The owner (2026-10-22, while BL-152's grid was running): "whenever this breakout happens, if Nifty IT,
Reliance and Nifty Bank, if any of two are also supporting this, then there is more chance for
breakout." Asked what "supporting" means, the owner chose **own breakout**: the instrument is also
beyond its own level of the same type. Asked how to get the data, the owner chose **download from
Fyers**.

Data today: BANKNIFTY index 1-minute bars are in the lake from 2015. The NIFTY IT index is not collected
at all, and Reliance has only option bars (Sep 2023 onward), no share price. Phase 1 downloads both.

Why this may not work: Bank Nifty and the other financials (about a third of NIFTY), Reliance (about 9%)
and IT (about 13%) are large parts of NIFTY itself, so they often move with it because they are what
moved it. "Two of three support" may hold on most breakout days, and then the filter only removes
trades. The comparison below is built to show that.

**Registered before BL-152's results were seen:** this file was committed while BL-152's grid was still
running, and no BL-152 event row had been read.

## Goal

A registered answer: among BL-152's breakout trades, do the ones at least two of the three support earn
more after charges than the ones they do not, by more than dropping the same share of trades at random.

## Out of scope

- Other definitions of support (same direction since the open, the last 30 minutes), other thresholds
  (1 of 3, 3 of 3), other instruments or weights.
- Changing BL-152's rule, its variants or its verdict.
- SENSEX.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** BL-152 trades taken when at least two of {BANKNIFTY, NIFTY IT, RELIANCE} are also beyond
  their own level of the same type earn more, net per trade, than those taken when fewer are.
- **Support, per instrument X, per trade:** at the minute the NIFTY entry is decided (the signal minute,
  stamp j), X's 1-minute close is beyond X's own level, built from X's own bars exactly as the variant's
  NIFTY level is (`or30` X's 09:15-09:44 high; `roll30` X's high of the 30 one-minute bars ending 5 minutes
  before j; `held30` X's day high before j - 5 that was already its high 30 minutes earlier; `prevday`
  X's previous session high). Up: X close > X level; down: X close < X low level. No body or candle
  condition on X. A missing X bar at j, or a level X cannot form, is "not supporting".
- **Supported trade:** at least 2 of the 3 support. A day missing any of the three instruments entirely
  is excluded from the comparison and counted.
- **Trades judged:** the four reference variants of BL-152, one per level, with stop `lvl`, trade `atm`,
  exit `eod` (`bl152_<level>_lvl_atm_eod`), plus BL-152's advancing variants if it has any (at most 3):
  at most 7 tests, each counted in this item.
- **Comparison per variant (learning period 2024-10-09 to 2026-10-08):** D = mean net of supported trades
  minus mean net of unsupported trades, after BL-063 charges, 1 lot. The control is a permutation test:
  the "supported" labels are shuffled among the variant's trades 10,000 times (same count supported, seed
  20261022), which is "drop the same share of trades at random"; p = share of shuffles with D at least as
  large.
- **Pass rule:** a variant's support filter **passes** with D > 0, p <= 0.05 after Holm correction across
  the tests run, supported mean net > 0, and at least 20 supported and 20 unsupported trades. If more than
  80% of a variant's trades are supported, the filter is reported **non-selective** whatever D is.
- **Hold-out:** a passing variant's filter is tested once on the confirmation period (2022-01-03 to
  2024-10-08) with the same rule; it passes there with D > 0 and p <= 0.05. The confirmation period is not
  read for any variant that did not pass.
- **Look-ahead check:** X's level and close use only X's bars up to j and earlier sessions (the same
  operators as BL-152, under the grammar's causality test); support is read at the decision minute, before
  the entry fill.
- **Verdict:** *passed* if at least one variant's filter passes the confirmation period; *killed* if none
  passes learning or confirmation; *non-selective* if every tested variant is above 80% supported.
- **Will not run** (needs `override: <reason>` in the Log): the other support definitions or thresholds;
  any variant not listed above; a second look at the confirmation period.

### Phase 1 — Data
- **Tasks:** download 1-minute history for the NIFTY IT index (`NSE:NIFTYIT-INDEX`) and Reliance shares
  (`NSE:RELIANCE-EQ`) from 2022-01-01 to today with the Fyers history API, into the trading-data lake beside
  the other index bars (an equity 1-minute layout if one is needed), resumable, with a coverage check
  against NIFTY's sessions.
- **Done when:** both series cover at least 98% of NIFTY's sessions in both periods; gaps listed.

### Phase 2 — Rule tester: other instruments
- **Tasks:** let a rule read another instrument's bars on the same grid (e.g. `{of: {symbol: BANKNIFTY, x: close}}`
  and its levels), loaded beside NIFTY in `frame.py`, with tests and the causality test.
- **Done when:** the support condition for each level reads back in plain words and passes its tests.

### Phase 3 — Test and write up
- **Tasks:** `research/bl153/` marks each BL-152 trade supported or not and runs the comparison above;
  the Log gets the verdict; the findings pages `research/options/strategies/breakout/` get a support page.
- **Done when:** the verdict is in the Log with its numbers.

## Risks

- **Mechanical overlap:** the three are large NIFTY weights; expect a high supported share (hence the
  non-selective rule).
- **Fyers token:** the download needs the owner's daily Fyers login; it waits for one.
- **Reliance corporate actions:** a split or bonus in the window would break levels across days; the
  previous-day level is the only one that crosses days, and any such date is listed and excluded.

## Open questions

- None now; the owner chose the definition and the data source.

## Log

- 2026-10-22 — created from the owner's follow-up; support definition (own breakout) and data source
  (Fyers download) chosen by the owner. Phase 0 registered and committed while BL-152's grid was running,
  before any of its results were read.

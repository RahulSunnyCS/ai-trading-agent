# Overnight short straddle into expiry morning

**Status:** Tested (killed) · **Last updated:** 2026-10-24

## What it is

Sell the ATM call and put at the 15:25 bucket of one trading day and buy them back the next morning,
so the position is held across the night and across the gap. Not a Widesl or Dir file: it is not an
intraday strategy and has no YAML in `strategies/legwise/`. BL-159 read 4 screened it on NIFTY with the
exit at the 09:20 bucket's close (about 09:24), nearest expiry with at least one day to run. BL-160
followed up on the best cell, nights that end on expiry morning ("DTE 0"), with far hedges (the bought CE
at ATM + 6 steps and PE at ATM − 6 steps, "OTM6"), on NIFTY and SENSEX, with exits at 09:15, 09:17, 09:20 and
09:24. Scripts: `packages/option-backtesting/research/bl159/overnight.py` and
`research/bl160/overnight_hedged.py`.

## Live value

Not live; not in the rotation universe. Nothing here changes any list, file or trade.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-159 read 4 | Unhedged ATM straddle, 15:25 → next 09:24, nearest expiry with dte ≥ 1, one lot, after charges | NIFTY, 2024-10-09 → 2026-10-08, 481 nights | Screen: +₹232 a night, t 2.15, hit 59%, worst nights −₹12,327 (gaps of 1.4–2.4%). **Lead by the bar, explained away**: exiting at the 09:15 open gives −₹6 (t −0.08) | [BL-159][bl159] |
| BL-160 (registered test) | NIFTY, DTE 0 nights, hedged OTM6, exit 09:17 | NIFTY, unseen 2022-01-03 → 2024-10-08, 143 nights | **Failed**: −₹34 a night, t −0.29, hit 61%; the same cell unhedged +₹168, t 0.90 | [BL-160][bl160] |
| BL-160 (supporting) | Same cell on SENSEX | SENSEX, 2023-07-26 → 2024-10-08 | **Not usable**: the vendor SENSEX option files cover about 8 nights | [BL-160][bl160] |
| BL-160 (learning period) | Index × DTE × hedge × exit, descriptive | NIFTY and SENSEX, 2024-10-09 → 2026-10-08, after charges | Descriptive, no verdict (below) | [BL-160][bl160] |
| BL-160 (VIX band, post-hoc) | The 09:17 cells split by India VIX at 15:25: < 13, 13–15, 15–18, 18+ (48 cells) | all three sets above | **Post-hoc and descriptive**; ran after the verdict; owner override recorded after the run (2026-10-24). See What we know | [BL-160][bl160] |

BL-160 learning period, ₹ net per night, one lot, after charges, exit at 09:17 unless stated (the item's
table):

| Index | Exit DTE | Hedge | 09:15 open | 09:17 | Worst night (09:17) |
|---|---|---|---|---|---|
| NIFTY | 0 | none | +153 (t 0.31) | +638 (t 1.57) | −31,590 |
| NIFTY | 0 | OTM6 | +113 (t 0.75) | +140 (t 0.80) | −9,083 |
| NIFTY | 1 | none | +270 (t 1.52) | +461 (t 1.81) | −14,816 |
| NIFTY | 2+ | none | −330 (t −2.13) | −221 (t −1.23) | −37,122 |
| SENSEX | 0 | none | −410 (t −1.56) | +266 (t 0.92) | −17,156 |
| SENSEX | 1 | none | −1,149 (t −1.98) | −581 (t −1.54) | −21,605 |

## What we know

- **The registered test failed**, on days nobody had looked at. The learning-period cell (NIFTY, DTE 0,
  unhedged, +₹638, t 1.57) was +₹168 (t 0.90) on 2022–24: about a quarter the size and not distinguishable
  from zero.
- **The gain is the first minutes of the morning, not the night.** Exiting at the 09:15 open gives −₹6
  (BL-159) or +₹153 (BL-160, NIFTY DTE 0). The part that pays is the premium fall in the first two to nine
  minutes, which is an intraday effect that does not need a position held overnight.
- **The hedge is insurance that eats the return.** OTM6 wings cut NIFTY DTE 0's worst night from −₹31,590 to
  −₹9,083, but the mean falls from +₹638 to +₹140; on the other DTE groups and on SENSEX the hedged version
  loses, with large negative t.
- **SENSEX does not show it** (unhedged DTE 0 +₹266, t 0.92; DTE 1 −₹581).
- **The VIX 15–18 band is descriptive, post-hoc and unconfirmed.** The only band positive in all three sets for
  the unhedged DTE 0 night was 15–18 (NIFTY 2024–26 +₹846, 16 nights; NIFTY 2022–24 +₹577, 28 nights;
  SENSEX 2024–26 +₹923, 17 nights). It was found by looking at 48 cells after the verdict, every other band
  flips sign between sets, and the code that cut it is not committed. Only a forward record could confirm it (about 13 qualifying nights a year per index).
- **NIFTY 2022-01 → 2024-10 is now used up for overnight-straddle questions.** BL-160's registered test used
  it, and the VIX-band split looked at it afterwards. Any new overnight-straddle item needs a period neither
  has read (a forward record).
- BL-159 read 4 pairs consecutive days found in the 5-minute chain snapshots, without data_quality, so a
  missing day would show up as a two-night hold; BL-160 uses lake days plus data_quality.

## Not yet tested

- Nothing is registered. BL-160's "Will not run" list excludes other wings, other times, a stop inside the
  night or morning, and other DTE groups as the primary. A pass would have led to a forward paper journal and
  the real margin of the hedged position; neither exists.
- The real margin of the hedged position was never measured.

## Related

- [Long straddle hedge](../long-straddle-hedge/README.md) (another hedge test, killed);
  [Widesl entry time](../widesl/entry-time.md); [charges](../../common/charges.md).
- Scripts: `research/bl159/overnight.py`, `research/bl160/overnight_hedged.py`; outputs git-ignored,
  regenerate with them (they need the lake on `TRADING_DATA_ROOT`).

[bl159]: ../../../../backlog/BL-159-eight-poc-reads.md
[bl160]: ../../../../backlog/BL-160-overnight-straddle-into-expiry.md

# Directional: strike depth (ITM2 and ITM3) and the overall stop

**Status:** Tested · **Last updated:** 2026-10-26

## What it is

How deep in the money the Directional pair sits: ITM1 (live and in the rotation), ITM2 or ITM3 (one
more or two more strikes), with the overall MTM stop either left at the live ₹3,000 or widened until
the stop fires about as often as it does for ITM1 and ATM. Set by `legs[].strike: { strike_type:
ITMn }` and `overall.stop_loss_inr`. ITM2 and ITM3 are not in the rotation.

## Live value

ITM1, ₹3,000 overall stop, 21% leg stop, one re-entry at cost, exit 15:28
([strike page](strike-premium.md)). The rotation carries ATM and ITM1 only.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-166 | ITM2, ITM3 x overall stop {3,000, 4,000, 5,000, 6,000, 8,000, 10,000}; 25 start times; NIFTY and SENSEX; against ITM1 at ₹3,000 | 2024-10-09 → 2026-10-23; stop matched on the fit year, judged on the hold-out year from 2025-10-09; net after charges, 1 lot | **POC passes on SENSEX** (ITM2 +₹54, ITM3 +₹78 per slot-day, intervals above zero); **NIFTY inconclusive** (+₹36 and +₹44, intervals include zero) | [BL-166][bl166] |

## What we know

- **Deeper strikes stop out only a little more often.** Share of variant-days the ₹3,000 overall stop
  fired, fit year / hold-out: NIFTY ATM 9.5% / 9.8%, ITM1 13.7% / 14.5%, ITM2 15.9% / 17.0%, ITM3 16.6% /
  18.2%; SENSEX ATM 8.7% / 8.3%, ITM1 10.5% / 10.9%, ITM2 12.4% / 13.5%, ITM3 13.6% / 15.1%. Not 30 to
  40%.
- **A ₹4,000 stop brings ITM2 and ITM3 back inside ITM1's rate** on both indices (NIFTY 10.6% to
  11.9%, SENSEX 7.0% to 9.5%), chosen on the fit year by the registered rule.
- **SENSEX: both pass.** ITM2 at ₹4,000 minus ITM1 at ₹3,000: +₹54 a slot-day on the hold-out
  (90% interval +22 to +86); ITM3: +₹78 (+25 to +136). Drawdown on the hold-out is smaller than
  ITM1's (6,255 and 5,925 against 7,873). At the common ₹3,000 stop the gain is similar (+32 and
  +49), so on SENSEX it is mostly the depth, not the wider stop.
- **NIFTY: no clear gain.** +₹36 (−21 to +98) for ITM2 and +₹44 (−39 to +133) for ITM3 on the
  hold-out, slightly negative on the fit year, and a deeper drawdown (9,852 and 11,132 against 8,608).
- **Net keeps rising with the stop** up to ₹10,000 for ITM3 (hold-out SENSEX 304 at ₹3,000 to 355;
  NIFTY 241 to 293), with deeper drawdowns. That is in-sample and is a lead, not a finding; it
  matches the earlier finding that the ₹3,000 stop costs more than it saves ([overall stop](mtm-sl.md)).
- **Surviving four tests.** At a 97.5% interval (Bonferroni for the four comparisons) the SENSEX
  hold-out gains stay above zero: ITM2 +₹54 (+13 to +98), ITM3 +₹78 (+3 to +154), the latter only
  just. NIFTY stays inconclusive (+36: −41 to +119; +44: −68 to +165).
- **Caveats:** the fit-year intervals all include zero; the engine fills with no spread, and nothing
  was checked about the zero-volume minutes it forward-fills on thin deep strikes, so ITM2 and ITM3 may
  look better than they would trade; ATM and ITM1 carry settings tuned for them; one hold-out year.
  Stop rates are shares of strategy-days pooled over the 25 start times, not the share of days a
  basket hits its stop (late starts rarely reach it, so the day-level rate is higher).

## In the Adaptive ranking (BL-167, in-sample)

Adding the 50 ITM2 variants to the ranking universe (431 sessions from 2025-01-10, list C, ITM2 at the
BL-166 stop of ₹4,000):

| | Adaptive Classic (Core-298) | Adaptive Tuned (T1) |
|---|---|---|
| Net, base → with ITM2 (₹, 1 lot, 3 picks) | 379,202 → 354,613 | 653,498 → 621,694 |
| Mean difference a day, 90% interval | −57 (−235 to +118) | −74 (−258 to +108) |
| Maximum drawdown, base → with ITM2 | 42,326 → 31,849 | 25,887 → 28,840 |
| ITM2 share of core picks | 20.3% | 13.6% |
| Base ITM1 picks replaced | 77.5% | 49.7% |
| Base ATM picks replaced | 58.0% | 40.5% |
| Base Widesl picks replaced | 5.1% | 5.1% |

ITM2 mostly takes ITM1's slots and does not earn more for it: no gain in either universe by the
registered rule. The Core drawdown is shallower and T1's deeper. In-sample (weights and the stop were
chosen on this history, no spread), so the forward journal is the only clean test.

## Not yet tested

- Larger time frames (NIFTY 2022 → 2024 on the imported data), ITM4 and deeper, and putting ITM2 or
  ITM3 into the rotation's ranking: the next step if the owner wants it.

[bl166]: ../../../../backlog/BL-166-directional-itm2-itm3-with-matched-stop.md
[bl167]: ../../../../backlog/BL-167-itm2-in-adaptive-and-t1.md

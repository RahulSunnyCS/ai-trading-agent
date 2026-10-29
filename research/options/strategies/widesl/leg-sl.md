# Widesl: leg stop

**Status:** Tested · **Last updated:** 2026-10-29

## What it is

The stop on each short leg, as a rise over that leg's entry premium: 115% closes the leg once its premium
is 2.15 × the entry price. Set by `legs[].stop_loss: { percent: 115 }` (or `points`). With partial
square-off only the stopped leg closes; the other runs on. The trail moves this stop (see
[trail](trail.md)).

## Live value

115% on both NIFTY legs; SENSEX call 114%, put 115% (`sensex_widesl_917_otm2.yaml`, as set in
AlgoTest). Every rotation Widesl file keeps its base file's stops.

T1 (BL-113, traded since 2026-10-19) adds two NIFTY OTM1 settings with other stops, each at the 25 rotation
start times: `N_wide-t1s4` at 150% (trail 25/15, RE cost ×1, MTM ₹4,000) and `N_wide-t1s8` at 60% (trail
15/10, MTM ₹3,000); `N_p150-t1s11` is the ₹150-premium Widesl at 60%, `S_p285-t1s22` SENSEX ₹285 at 40%.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-098 Phase 2 | 80, 90, 100, 110, 115, 120, 130, 140, 150% (both legs), one factor at a time, all 150 rotation Widesl files | fit 2024-10-09 → 2025-10-08, holdout 2025-10-09 → 2026-10-09, **after charges** (₹20 an order + statutory), no slippage | Descriptive ranking; registered pass rule not yet applied; Phase 3 pending | [BL-098][bl098], [report][bl098q] |
| BL-126 (POC) | NIFTY ₹100 at 75 % and ₹120 at 60 % vs ₹100 at 115 %, trail 15/10, MTM ₹2,500, all 25 rotation slots | 2024-10-09 → 2026-10-16, gross (no charges), in-sample, no hold-out | Not positive: +₹41 [−5, +89] and +₹47 [−18, +111] per lot-day standalone, deeper drawdown; in Adaptive −₹7 / +₹23, intervals include zero. Repeats BL-098 Phase 2's morning look | [BL-126][bl126] |
| BL-127 | NIFTY ₹80 / ₹100 / ₹120 × SL 60, 70, 80, 90, 100, 115 %, trail 15/10, MTM ₹2,500, all 25 slots; a stop chosen per premium on the first year, then the best two in Adaptive on the second | Selection 2024-10-09 → 2025-10-08, test 2025-10-09 → 2026-10-16, gross (no charges) | Selection year: SL 70–80 % best (₹80 SL 80 % +230, ₹100 SL 70 % +281, ₹120 SL 70 % +295 per lot-day, vs +207 / +230 / +247 at 115 %; drawdown 35–60 % of the 115 % cell's). Test year, Adaptive with the best two added: −₹10 [−82, +63], drawdown deeper. **Not positive** (one replay; the interval includes zero) | [BL-127][bl127] |
| BL-128 | SENSEX ₹240 / ₹300 / ₹350 × SL 60, 70, 80, 90, 100, 115 % (same value on both legs), trail 15/10, MTM ₹2,500, all 25 slots; a stop chosen per premium on the first year, then the best two in Adaptive on the second | Selection 2024-10-09 → 2025-10-08, test 2025-10-09 → 2026-10-16, gross (no charges) | Selection year: SL 60 % best at all three premiums, the grid's lowest (₹240 +153, ₹300 +160, ₹350 +155 per lot-day, vs +86 / +103 / +92 at 115 %; drawdown 68–78 % of the 115 % cell's; positive at 22–25 of 25 slots). Test year, Adaptive with the best two (₹300, ₹240 at 60 %) added: −₹2 [−88, +79], drawdown deeper. **Not positive** (one replay; the interval includes zero) | [BL-128][bl128] |
| BL-155 | Stop set by the morning type at 11:00 (range so far vs the last 20 mornings): quiet 100 %, normal 80 %, wide 60 %; vs fixed 60 / 80 / 100 % and the reversed rule | Heatmap ATM straddles 11:15–14:45, exit 15:15, after charges; NIFTY 2025-01 → 2026-10 decides; NIFTY 2022–24 and SENSEX reported | **Killed**: +₹40 vs +₹32–35 a lot-day, every interval includes zero, below shuffled labels; the real-Widesl step was not run | [BL-155][bl155] |
| BL-156 Amendment 1 | Leg stop checked on every tick (the engine: bar high / low) vs at the 1-minute close (exit at that close), crossed with the MTM rule | T1's Adaptive picks, 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **Tick is better**: candle-close leg stops cost −₹432 a day on the book (−₹591 to −₹272), in every half-year; Widesl: −₹95 a pick | [BL-156][bl156] |
| BL-191 | T1's SL150% NIFTY OTM1 setting (`N_wide-t1s4`: SL150 %, trail 25/15, RE cost ×1, MTM ₹4,000, 25 slots) removed from T1's ranking, or allowed on NIFTY expiry days only | Adaptive (list C) over T1, 2025-01-10 → 2026-10-29, 1 lot, after brokerage; 2025-10-09 → 2026-10-09 decides | **Drop killed**: −₹116 a day [−365, +96], −₹150 over all days with a deeper drawdown. **Expiry only: no difference**: +₹55 [−92, +198], drawdown 1% shallower, 5th-percentile day worse. Post hoc (8 days): two or more copies on a non-expiry day −₹4,208 a day vs −₹1,148 without. **Amendment 1**: in its place on non-expiry days a 115% Widesl at a ₹3,000 overall stop (trail 15/10, or 25/15 with RE cost): +₹24 / +₹25 [−95, +144], **no difference** (drawdown 5% shallower, 5th-percentile day 7% worse). **Amendment 2**: at most one copy a day, no difference by the rule; capped on non-expiry days only +₹40 [+8, +77], 8 of 435 days changed. **Amendment 3**: none on non-expiry days, +₹111 [+12, +220] on 2025-10 → 2026-10 but −₹88 on the year before; no difference by the rule | [BL-191][bl191] |

Leg-stop rows in the post-charge top four (holdout, mean over the band's start-time files):

| Index, band | Row | Post-charge | ₹/day | Max DD | MTM stops |
|---|---|---|---|---|---|
| NIFTY 09:15–11:00 | ₹100, 90% | ₹27,683 | 114 | −₹34,102 | 23.4% |
| NIFTY 09:15–11:00 | ₹100, 80% | ₹32,029 | 132 | −₹36,676 | 21.4% |
| NIFTY 11:00–13:00 | OTM1, 80% / 90% / 100% | ₹15,242 / ₹10,983 / ₹6,817 | 63 / 45 / 28 | −₹28,615 / −₹34,028 / −₹36,962 | 12.5–14.5% |
| NIFTY 13:00–15:30 | ₹80, 150% | ₹19,964 | 82 | −₹18,698 | 6.0% |
| SENSEX, all three bands | ₹250, 80% | ₹5,697 / ₹11,119 / ₹14,702 | 24 / 46 / 61 | −₹33.0k / −₹34.1k / −₹16.9k | 17.6% / 12.1% / 5.2% |
| SENSEX 13:00–15:30 | ₹250, baseline 114/115% | ₹13,883 | 57 | −₹18,819 | 4.9% |

## What we know

- After charges, a tighter stop (80–90%) is the #1 row in five of the six index × band lists (the sixth
  is NIFTY afternoon, led by no MTM stop). On NIFTY OTM1 midday
  the order is monotone: 80% beats 90% beats 100% on net and on drawdown.
- The margins are small. The one direct pair, SENSEX ₹250 afternoon, is 80% ₹14,702 against the baseline
  ₹13,883 a year (+₹819, drawdown −₹16.9k vs −₹18.8k). Profit factors are 1.01–1.06.
- Tighter stops are not uniform: the NIFTY afternoon list has a 150% row, and NIFTY OTM1 midday at 80%
  still has a drawdown of −₹28.6k on a ₹15k net.
- One holdout year, one factor at a time, ranked after viewing the holdout. Nothing is adopted.
- NIFTY closest-premium Widesl, gross, selection year 2024-10 → 2025-10 (BL-127): the stop chosen per premium (₹80 SL 80 %, ₹100 SL 70 %, ₹120 SL 70 %) beat 115 % on the mean (+₹23 to +₹51 per lot-day; not every 70–80 % cell did: ₹120 at 80 % equals 115 %) and cut the drawdown to roughly 35–60 % of it, positive at all 25 slots. That did not carry into Adaptive on the next year (adding the two chosen stops: −₹10, interval includes zero, deeper drawdown). Standalone benefit, no Adaptive benefit; the test year had already been seen by BL-098 and BL-126.
- SENSEX closest-premium Widesl, gross, selection year 2024-10 → 2025-10 (BL-128): at ₹240, ₹300 and ₹350 the tightest stop tried (60 %) beat 115 % on the mean by +₹57 to +₹67 per lot-day and cut the drawdown by a fifth to a third, but the optimum is at the grid's edge and the cells are cells positive at only 18–25 of 25 slots across the grid, 22–25 for the 60 % winners (NIFTY: all 25). As for NIFTY it did not carry into Adaptive on the next year (adding the two chosen stops: −₹2, interval includes zero, deeper drawdown; either alone +₹20 / +₹25, intervals include zero). A second index with the same answer; the test year is the one BL-127 and BL-126 had already read.

- A 150 % stop inside T1 (BL-191): T1's SL150 % NIFTY OTM1 setting (`N_wide-t1s4`) earns its place in the
  ranking; taking it out costs about ₹116–150 a day and deepens the drawdown, and keeping it for expiry days only
  changes nothing measurable. Its risk is concentration: on the 8 non-expiry days T1 held two or more copies it
  averaged −₹4,208 (worst −₹14,092), against −₹1,148 for the same days without it. Post hoc, not a rule. Swapping
  it for a 115% / ₹3,000 Widesl on non-expiry days changes nothing measurable either (+₹24 a day, interval
  includes zero). Allowing only one copy on a non-expiry day (expiry days unchanged) is the best of the
  variants tried, +₹40 a day on 2025-10 → 2026-10, on 8 changed days; capping expiry days costs.

- By morning type (BL-155, heatmap ATM straddles from 11:15, descriptive): after a **quiet** morning the
  widest stop (100 %) is best on NIFTY in both periods (+₹96 vs +₹61 at 60 %, 2025–26). After a **normal**
  morning 60 % is best everywhere. After a **wide** morning the order flips between periods. The rule built
  on it did not beat fixed stops.

## Not yet tested

- BL-098 Phase 3, now BL-104: at most five candidates chosen on the fit period, then stop × strike, stop × MTM
  interactions, then the holdout once.
- CE/PE-asymmetric stops (out of scope by registration).
- The NIFTY 2022–24 period.
- SENSEX closest-premium Widesl stops below 60 % (BL-128's best stop was the tightest it tried).

## Related

- [Directional leg stop](../directional/leg-sl.md); [overall MTM stop](mtm-sl.md).
- Raw rows: `packages/option-backtesting/research/bl097/results/widesl_sweep_postcharge.csv` (BL-098 writes
  into `research/bl097/`; it has no folder of its own). Git-ignored; regenerate with
  `research/bl097/run_family_sweep.py --family widesl`.

[bl155]: ../../../../backlog/BL-155-stop-by-morning-type.md
[bl098]: ../../../../backlog/BL-098-widesl-parameter-sweep.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
[bl126]: ../../../../backlog/BL-126-nifty-premium-widesl-tight-sl-poc.md
[bl127]: ../../../../backlog/BL-127-nifty-premium-widesl-sl-selection.md
[bl128]: ../../../../backlog/BL-128-sensex-premium-widesl-sl-selection.md
[bl156]: ../../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md
[bl191]: ../../../../backlog/BL-191-t1-without-sl150-widesl.md

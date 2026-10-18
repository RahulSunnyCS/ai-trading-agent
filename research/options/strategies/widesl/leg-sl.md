# Widesl: leg stop

**Status:** Descriptive · **Last updated:** 2026-10-18

## What it is

The stop on each short leg, as a rise over that leg's entry premium: 115% closes the leg once its premium
is 2.15 × the entry price. Set by `legs[].stop_loss: { percent: 115 }` (or `points`). With partial
square-off only the stopped leg closes; the other runs on. The trail moves this stop (see
[trail](trail.md)).

## Live value

115% on both NIFTY legs; SENSEX call 114%, put 115% (`sensex_widesl_917_otm2.yaml`, as set in
AlgoTest). Every rotation Widesl file keeps its base file's stops.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-098 Phase 2 | 80, 90, 100, 110, 115, 120, 130, 140, 150% (both legs), one factor at a time, all 150 rotation Widesl files | fit 2024-10-09 → 2025-10-08, holdout 2025-10-09 → 2026-10-09, **after charges** (₹20 an order + statutory), no slippage | Descriptive ranking; registered pass rule not yet applied; Phase 3 pending | [BL-098][bl098], [report][bl098q] |
| BL-126 (POC) | NIFTY ₹100 at 75 % and ₹120 at 60 % vs ₹100 at 115 %, trail 15/10, MTM ₹2,500, all 25 rotation slots | 2024-10-09 → 2026-10-16, gross (no charges), in-sample, no hold-out | Not positive: +₹41 [−5, +89] and +₹47 [−18, +111] per lot-day standalone, deeper drawdown; in Adaptive −₹7 / +₹23, intervals include zero. Repeats BL-098 Phase 2's morning look | [BL-126][bl126] |

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

## Not yet tested

- BL-098 Phase 3: at most five candidates chosen on the fit period, then stop × strike, stop × MTM
  interactions, then the holdout once.
- CE/PE-asymmetric stops (out of scope by registration).
- The NIFTY 2022–24 period.

## Related

- [Directional leg stop](../directional/leg-sl.md); [overall MTM stop](mtm-sl.md).
- Raw rows: `packages/option-backtesting/research/bl097/results/widesl_sweep_postcharge.csv` (BL-098 writes
  into `research/bl097/`; it has no folder of its own). Git-ignored; regenerate with
  `research/bl097/run_family_sweep.py --family widesl`.

[bl098]: ../../../../backlog/BL-098-widesl-parameter-sweep.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
[bl126]: ../../../../backlog/BL-126-nifty-premium-widesl-tight-sl-poc.md

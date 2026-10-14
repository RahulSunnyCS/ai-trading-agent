# Buy (range breakout)

**Last updated:** 2026-10-14

## Definition

Buy a weekly call and a weekly put, each only if its own premium breaks out above a short opening
range. The two legs are independent: on a given day both, one or neither may enter.

| Part | Setting | YAML field (`legwise/schema.py`) |
|---|---|---|
| Legs | long CE + long PE, weekly expiry, 1 lot each | `legs[].position: buy`, `expiry: weekly` |
| Strike | the option whose premium is closest to ₹50 at the entry time | `strike: { closest_premium: 50 }` |
| Range | each leg's own premium high from `entry_time` to `until` (10 minutes) | `range_breakout: { until, side: high, source: instrument }` |
| Breakout | first later 1-minute bar whose high beats the range high; fills at the range high, or the bar's open if it gapped through | engine docstring, `legwise/engine.py` |
| Leg stop | 25% below the entry price, trailed 1 point for every 1 point in favour | `stop_loss: { percent: 25 }`, `trail_sl: { points: [1, 1] }` |
| Overall stop | ₹2,000 per lot on the combined P&L | `overall.stop_loss_inr: 2000` |
| Re-entry | none | `reentry_on_sl` absent |
| Exit | 15:14, partial square-off | `exit_time`, `square_off: partial` |

`gap_percent` and `valid_until` were added to `RangeBreakout` for BL-097; both are off (0 and none) in
every saved file.

## Live and rotation files

- Live (AlgoTest export of 2026-09-29): `packages/option-backtesting/strategies/legwise/nifty_buy_range_breakout.yaml`,
  entry 09:35, range to 09:45. It is run every evening by `obt daily`. No SENSEX Buy is live.
- Rotation universe (`strategies/rotation/`): `N_buy_<HHMM>` and `S_buy_<HHMM>` at 24 start times,
  09:17 to 15:02 every 15 minutes (48 files). Each is the live file with only `entry_time` and
  `until` (= entry + 10 minutes) changed. There is no 15:17 Buy, because it exits at 15:14
  ([BL-062][bl062]). SENSEX keeps the NIFTY rupee values: ₹50 premium, ₹2,000 stop ([BL-056][bl056]).
- How Buy reaches the journal lists: never in the core. When a Buy variant ranks in the overall top 10
  of the 298, the list adds one Buy strategy with 2 lots ([BL-058][bl058] Phase 0b).

## What we know in one paragraph

Before charges Buy is small: positive over two years on NIFTY but never better than Dir or Widesl at
any start time ([BL-054][bl054]). After charges it loses. In the BL-097 baseline (48 files, holdout
2025-10-09 → 2026-10-09, ₹20 an order plus statutory charges) the files made ₹1.31 lakh gross and paid
₹8.72 lakh of charges; 3 of 48 ended positive (summed from the sweep CSV, see below). The best one-factor change in every index and time band
is still negative after charges ([BL-097 report][bl097q]), and Buy never wins a band in the combined
list ([BL-099][bl099]). Inside the rotation it behaves differently: switching the Buy add-on off made
none of 19 robust weightings better and pushed 6 below chance, before charges ([BL-075][bl075]), and
Buy is the only family whose daily P&L moves against Widesl (Pearson −0.33 NIFTY, −0.25 SENSEX,
in-sample; [BL-090][bl090]). So the open question is Buy as a basket hedge, not Buy on its own.

## Variables

| Variable | Status | One-line takeaway |
|---|---|---|
| [Entry time](entry-time.md) | Descriptive | Before charges NIFTY Buy fades through the day (₹41 → −₹41 a day); no band survives charges |
| [Strike / premium](strike-premium.md) | Descriptive | ATM/OTM strikes lift gross in both periods but deepen drawdown; no premium beats ₹50 reliably |
| [Leg stop](leg-sl.md) | Descriptive | 15–20% beat 25% in the holdout year; the sign is not stable in the fit year for 20% |
| [Overall MTM stop](mtm-sl.md) | Descriptive | The ₹2,000 stop almost never fires; ₹2,500–₹4,000 change nothing |
| [Trail](trail.md) | Descriptive | No trail is better than [1, 1] in both periods; dropping the trail swings drawdown |
| [Re-entry](re-entry.md) | Descriptive | Every re-entry row loses after charges, mostly through charges |
| [Exit time](exit-time.md) | Descriptive | 14:50 / 15:00 help in the holdout and hurt in the fit year |
| [Days to expiry](days-to-expiry.md) | Descriptive | No usable pattern; one NIFTY cell (Thursday, 5 days out) stands out within noise |
| [India VIX](vix.md) | Descriptive | No band or intraday VIX state helps Buy consistently |
| [Weekday](weekday.md) | Descriptive | Cells run from −₹88 to +₹287 a day; inside BL-056's ₹700 noise yardstick |
| [Breakout window](breakout-window.md) | Descriptive | Longer ranges (20–30 minutes) are the most consistent lead; still negative after charges |
| [Breakout gap](breakout-gap.md) | Descriptive | A 0.5–2% buffer lowers gross; any net gain is from fewer trades |
| [Breakout validity](breakout-validity.md) | Descriptive | A deadline lowers gross; net improves only through skipped trades and charges |
| [Breakout source](breakout-source.md) | Descriptive | Underlying is the worst row outside re-entry, but the test kept `side: high` on the put leg |
| [30-minute consolidation](consolidation-30m.md) | Not tested | Owner's idea: require a tight band before the breakout |
| [Candle position](candle-position.md) | Not tested | Owner's idea: require closes to cluster near the breakout level |
| Square-off (no page) | Descriptive | `complete` instead of `partial`: holdout +₹1,123 net per file, gross lower; BL-097 |

## How to read the BL-097 tables on these pages

BL-097 Phase 2 changed one setting at a time on all 48 rotation Buy files, fit 2024-10-09 →
2025-10-08, holdout 2025-10-09 → 2026-10-09, 488 common sessions, ₹20 an order plus STT, exchange,
SEBI/IPFT, stamp and GST, no slippage ([BL-097][bl097]). It is a screen: Phase 3 (interactions, the
pass rule) has not run, so no row has a verdict.

The tables compare each variant with the baseline on the same file and give the mean over the valid
files. They were computed for these pages from `research/bl097/results/buy_sweep_postcharge.csv`
(git-ignored; regenerate with `uv run python research/bl097/run_family_sweep.py --family buy --output
research/bl097/results/buy_sweep_postcharge.csv --checkpoint-dir research/bl097/checkpoints/buy`).
Baseline per file, for scale: fit gross ₹6,516, net −₹11,239; holdout gross ₹2,720, charges ₹18,177,
net −₹15,456. "Files ≥ base" is the share of files whose holdout net is at or above the baseline's
(the pass rule asks for at least 60%). The ranked report ([BL-097 report][bl097q]) instead averages
each section's files and ranks by a balanced score.

## Shared pages

[Portfolio stop](../../common/portfolio-stop.md) · [Charges](../../common/charges.md) ·
[Rotation ranking](../../common/rotation-ranking.md) · [Intraday state](../../common/intraday-state.md) ·
[Correlation](../../common/correlation.md). Same variables in the other strategies:
[Widesl](../widesl/README.md), [Directional](../directional/README.md).

[bl054]: ../../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl058]: ../../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl062]: ../../../../backlog/BL-062-whole-day-rotation.md
[bl075]: ../../../../backlog/BL-075-drb-final-map-and-structural-switches.md
[bl090]: ../../../../backlog/BL-090-strategy-correlation-and-diverse-baskets.md
[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md
[bl099]: ../../../../backlog/BL-099-combined-final-qualified-list-post-charge.md

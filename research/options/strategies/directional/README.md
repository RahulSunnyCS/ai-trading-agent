# Directional ("Dir")

**Last updated:** 2026-10-14

## Definition

Sell one weekly call and one weekly put at the same distance from the money (ATM, or ITM1 on both
sides), with tight leg stops and one re-entry. Despite the name it takes no directional view: it is a
short straddle (ATM) or a short in-the-money pair (ITM1) that keeps the leg that survives a move. It is
not the Buy (range-breakout) family.

| Part | Setting | YAML field (`legwise/schema.py`) |
|---|---|---|
| Legs | short CE + short PE, weekly expiry, 1 lot each | `legs[].position: sell`, `expiry: weekly` |
| Strike | ITM1 (live) or ATM (rotation base and research) | `strike: { strike_type: ITM1 }` |
| Leg stop | 21% over the entry premium | `stop_loss: { percent: 21 }` |
| Re-entry | once, same contract, when it comes back to the entry price | `reentry_on_sl: { mode: cost, count: 1 }` |
| Trail | none | `trail_sl` absent |
| Overall stop | ₹3,000 per lot | `overall.stop_loss_inr: 3000` |
| Exit | 15:28, partial square-off | `exit_time`, `square_off: partial` |

## Live and rotation files

- Live: `packages/option-backtesting/strategies/legwise/nifty_dir_924_itm1_sl21_recost.yaml` (NIFTY, ITM1,
  09:24), transcribed from the owner's AlgoTest strategy.
- Fixed base for the forward journal: `strategies/rotation_base/N_dir_atm_0924.yaml`, the live file with
  ATM instead of ITM1 and nothing else (owner's choice, [BL-058][bl058]); the base is 2 × Widesl OTM1
  09:17 + 1 × this, 2 lots each.
- Rotation universe (`strategies/rotation/`, 298 variants): `N_dir` and `S_dir` (ATM), `N_ditm1` and
  `S_ditm1` (ITM1), each × 25 start times (09:17 to 15:17 every 15 minutes) = 100 files. ITM1 joined on
  2026-10-10 (BL-080, adopted by the BL-058 amendment); copies also sit in `strategies/rotation_ext/`.
- SENSEX Dir keeps the NIFTY rupee stops (₹3,000). SENSEX's lot (20) is much smaller than NIFTY's, so the rupee
  stops bind less often on SENSEX and its rupee results are not comparable with NIFTY's ([BL-056][bl056]).

## Variables

| Variable | Status | One-line takeaway |
|---|---|---|
| [Entry time](entry-time.md) | Tested | Positive at every start time before charges; after charges 11:00–13:00 is best and afternoons are near breakeven |
| [Strike (ATM vs ITM1)](strike-premium.md) | Tested | ITM1 beats ATM every year on both indices before charges and helps the rotation; post-charge band leaders are mostly ATM |
| [Leg stop](leg-sl.md) | Descriptive | The live 21% is the weakest of the shortlisted cells; 25–30% did better after charges |
| [Overall MTM stop](mtm-sl.md) | Tested | The ₹3,000 stop costs more than it saves; net rises with the stop up to ₹4,000, the grid edge |
| [Trail](trail.md) | Descriptive | Helps only with a 30% leg stop; mixed elsewhere |
| [Re-entry](re-entry.md) | Descriptive | COST ×2 is net-neutral after charges with a slightly smaller drawdown |
| [Exit time](exit-time.md) | Descriptive | 15:28 is clearly best after charges (₹136 a day vs ₹62 at 15:10) |
| [Days to expiry](days-to-expiry.md) | Descriptive | NIFTY strong at 0–1 days, negative 6 days out; SENSEX peaks 2 days out; within noise |
| [India VIX](vix.md) | Tested | Weak at VIX 15–18 in one year; VIX-based rules and states failed |
| [Weekday](weekday.md) | Descriptive | Same split as days to expiry within one expiry regime |

## Across strategies

- [Portfolio stop](../../common/portfolio-stop.md); [charges](../../common/charges.md): a 1-lot Dir pays
  about ₹36–42k a year at ₹20 an order ([BL-096][bl096]), more than Widesl's ₹27.7–29.5k (BL-098).
- [Rotation ranking](../../common/rotation-ranking.md); [intraday state](../../common/intraday-state.md)
  (event-triggered Dir entries, BL-083).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl058]: ../../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md

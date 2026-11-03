# Widesl (short wide strangle)

**Last updated:** 2026-10-28

## Definition

Sell one weekly call and one weekly put away from the money, hold to the close, and cap the loss
three ways.

| Part | Setting | YAML field (`legwise/schema.py`) |
|---|---|---|
| Legs | short CE + short PE, weekly expiry, 1 lot each | `legs[].position: sell`, `expiry: weekly` |
| Strike | NIFTY OTM1, SENSEX OTM2, or the strike whose premium is closest to a target | `strike: { strike_type: OTM1 }` or `{ closest_premium: 80 }` |
| Leg stop | 115% over the entry premium (SENSEX call 114%) | `stop_loss: { percent: 115 }` |
| Trail | every 15% in the leg's favour moves the stop 10% | `trail_sl: { percent: [15, 10] }` |
| Overall stop | ₹2,500 per lot on the combined P&L | `overall.stop_loss_inr: 2500` |
| Re-entry | none | `reentry_on_sl` absent |
| Exit | 15:28, partial square-off (a stopped leg closes alone) | `exit_time`, `square_off: partial` |

## Live and rotation files

- Live (AlgoTest transcriptions) in `packages/option-backtesting/strategies/legwise/`:
  `nifty_widesl_917_otm1.yaml` (09:17, OTM1), `sensex_widesl_917_otm2.yaml` (09:17, OTM2, call 114% /
  put 115%), `nifty_widesl_917_closest_premium.yaml` (09:17, closest ₹65, **exit 15:25, trail in
  points**). The ₹65 file differs from every research variant and has never been studied on its own.
- Rotation universe (`strategies/rotation/`, the 298 variants the BL-058 journal ranks): six Widesl
  families × 25 start times (09:17 to 15:17 every 15 minutes) = 150 files: `N_wide` (OTM1), `N_p80`,
  `N_p100`, `S_wide` (OTM2), `S_p250`, `S_p320`. Each is the live OTM file with only the start time and
  the strike rule changed.
- `strategies/rotation_ext/`: `N_p40`, `N_p60`, `S_p120`, `S_p200` × 25 (BL-080). Not in the journal
  universe.
- The fixed base the journal is judged against holds 2 × `N_wide_0917` (the live NIFTY OTM1 file) plus
  1 × Dir ATM 09:24, 2 lots each ([BL-058][bl058]).

## Full-factorial sweep (BL-104)

Registered grid ([BL-104][bl104], closed 2026-10-28): every combination of strike, leg stop, trail, MTM
stop and re-entry at seven entry slots, NIFTY and SENSEX, 2024-10-09 → 2026-10-09 (488 sessions,
after charges, ₹ per lot-day). The whole window is the fit, so every figure is **in-sample**; there was no
forward test. The template (today's rotation file) stays unless a band's winner passes all eight registered
rules. Figures from the tail-gated second selection and the Buy 60 % day-stop cut were never registered
(no owner `override:`) and are descriptive only.

| Band | Winner (return-only selection) | Winner | Template | Verdict |
|---|---|---:|---:|---|
| NIFTY 12:17–14:02 | ATM, SL 150 %, no trail, no MTM stop, RE cost ×1 | 308 | 124 | Regime flag (rule 7); rejected by the owner (no real stop) |
| SENSEX 12:17–14:02 | ₹320 premium, SL 40 %, trail 25/15, MTM ₹4,000, RE cost ×1 | 242 | 76 | Passes all but rule 7 (regime flag); not adopted |

- No Widesl band passed all eight rules. Breadth over the 25 slots (rule 4) failed for NIFTY 10:17–12:02 and
  14:17–15:02 and SENSEX 14:17–15:02.
- Wide-stop NIFTY winners have much worse worst days than the template (−₹16.6k against −₹4.5k at 09:17),
  though smaller drawdowns.
- NIFTY advisory run on 2022-01 → 2024-10 (681 days, not like-for-like): the return-only winners keep their
  sign in all four bands (+46, +26, +34, +28 over the template). SENSEX has no usable data before 2024-09.

## Variables

| Variable | Status | One-line takeaway |
|---|---|---|
| [Entry time](entry-time.md) | Tested | No time of day is reliably best before charges; event-triggered entries hurt Widesl |
| [Strike / premium](strike-premium.md) | Tested | NIFTY ₹80/₹100 and SENSEX ₹250 earn their place; ₹40/₹60/₹120/₹200 are harmful in the rotation |
| [Leg stop](leg-sl.md) | Descriptive | After charges, tighter 80–90% stops lead most time bands, by small margins |
| [Overall MTM stop](mtm-sl.md) | Tested | Before charges the ₹2,500 stop costs money except on SENSEX OTM2, where it cuts the drawdown |
| [Trail](trail.md) | Descriptive | Only one trail row (NIFTY ₹80, [5,5]%) reached a top-four list |
| [Re-entry](re-entry.md) | Descriptive | Re-entry rows rank only on SENSEX ₹250 mornings, with a deeper drawdown |
| [Exit time](exit-time.md) | Tested | No earlier exit made a top-four list; a 12:00 exit as half of a two-set day killed on the rule (BL-182); 15:28 stays |
| [Session split](session-split.md) | Tested | Two sets a day (09:17–12:00, 13:00–15:28) earn ₹120–180 more gross with half the drawdown, but after charges the net interval includes zero, fixed files and Adaptive two-plus-two alike; killed on the rule (BL-182); the afternoon pair alone is a lead |
| [Days to expiry](days-to-expiry.md) | Descriptive | NIFTY falls steadily away from expiry (₹616 → −₹52 a day); SENSEX has no gradient; at the edge of noise, one year |
| [India VIX](vix.md) | Tested | Weak at VIX 18+ in one year; VIX-based rules and intraday VIX states failed |
| [Weekday](weekday.md) | Descriptive | Same split as days to expiry within one expiry regime |

## Across strategies

- [Portfolio stop](../../common/portfolio-stop.md): daily stops over a whole mix (BL-055, BL-066).
- [Charges](../../common/charges.md): a 1-lot Widesl pays ₹27.7–29.5k of charges over the one-year
  holdout at ₹20 an order ([BL-098 report][bl098q]); for every band leader that is half or more of its
  pre-charge profit.
- [Rotation ranking](../../common/rotation-ranking.md): how the daily lists pick among the variants.
- [Intraday state](../../common/intraday-state.md): hourly checkpoints and event triggers (BL-081, BL-083).

[bl058]: ../../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
[bl104]: ../../../../backlog/BL-104-full-parameter-sweep.md

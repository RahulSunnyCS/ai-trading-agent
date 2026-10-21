# Options research, by strategy and variable

Intraday index-options strategies (NIFTY, SENSEX), backtested leg-wise on the collected 1-minute
data. Status words and the page template: [`../README.md`](../README.md).

## Strategy × variable

**T** = Tested · **D** = Descriptive · **N** = Not tested · — = does not apply

| Variable | [Widesl](strategies/widesl/README.md) | [Directional](strategies/directional/README.md) | [Buy breakout](strategies/buy-breakout/README.md) |
|---|---|---|---|
| Entry time | [T](strategies/widesl/entry-time.md) | [T](strategies/directional/entry-time.md) | [D](strategies/buy-breakout/entry-time.md) |
| Strike / premium | [T](strategies/widesl/strike-premium.md) | [T](strategies/directional/strike-premium.md) | [D](strategies/buy-breakout/strike-premium.md) |
| Leg SL | [D](strategies/widesl/leg-sl.md) | [D](strategies/directional/leg-sl.md) | [D](strategies/buy-breakout/leg-sl.md) |
| MTM (overall) SL | [T](strategies/widesl/mtm-sl.md) | [T](strategies/directional/mtm-sl.md) | [D](strategies/buy-breakout/mtm-sl.md) |
| Trail | [D](strategies/widesl/trail.md) | [D](strategies/directional/trail.md) | [D](strategies/buy-breakout/trail.md) |
| Re-entry | [D](strategies/widesl/re-entry.md) | [D](strategies/directional/re-entry.md) | [D](strategies/buy-breakout/re-entry.md) |
| Exit time | [D](strategies/widesl/exit-time.md) | [D](strategies/directional/exit-time.md) | [D](strategies/buy-breakout/exit-time.md) |
| Days to expiry | [D](strategies/widesl/days-to-expiry.md) | [D](strategies/directional/days-to-expiry.md) | [D](strategies/buy-breakout/days-to-expiry.md) |
| VIX | [T](strategies/widesl/vix.md) | [T](strategies/directional/vix.md) | [D](strategies/buy-breakout/vix.md) |
| Weekday | [D](strategies/widesl/weekday.md) | [D](strategies/directional/weekday.md) | [D](strategies/buy-breakout/weekday.md) |
| Breakout window | — | — | [D](strategies/buy-breakout/breakout-window.md) |
| Breakout gap | — | — | [D](strategies/buy-breakout/breakout-gap.md) |
| Breakout validity | — | — | [D](strategies/buy-breakout/breakout-validity.md) |
| Breakout source | — | — | [D](strategies/buy-breakout/breakout-source.md) |
| 30-min consolidation before breakout | — | — | [N](strategies/buy-breakout/consolidation-30m.md) |
| Candle position near the breakout | — | — | [N](strategies/buy-breakout/candle-position.md) |

## Across strategies ([`common/`](common/README.md))

| Page | Status | Items |
|---|---|---|
| [Portfolio (daily) stop](common/portfolio-stop.md) | Tested | BL-055, BL-066, BL-095 |
| [T1 on range-bound days](common/t1-range-bound-days.md) | Tested (re-scored) | BL-144 |
| [T1 breadth, regime lag, opening range](common/t1-robustness-and-lag.md) | Tested (re-scored) | BL-145 |
| [Special days: Budget, elections, RBI, high premium](common/special-days.md) | Tested (re-scored) | BL-146 |
| [Directional early exit at 14:55](common/directional-early-exit.md) | Tested (re-scored) | BL-147 |
| [Charges](common/charges.md) | Descriptive | BL-063, BL-096–099 |
| [Rotation ranking (DRB, lists A/B/C/REF)](common/rotation-ranking.md) | Tested | BL-054, 057, 062, 064–075, 080, 100 |
| [Intraday state and event triggers](common/intraday-state.md) | Tested | BL-053, BL-081, BL-083 |
| [Correlation and diverse baskets](common/correlation.md) | Descriptive | BL-090 |

## Other strategies

| Strategy | Status | Item |
|---|---|---|
| [Long straddle hedge](strategies/long-straddle-hedge/README.md) | Tested (killed) | BL-101 |
| [Straddle premium exhaustion](strategies/straddle-exhaustion/README.md) | Tested on the learning periods; P1 unread | BL-091 |
| [ATM Widesl, SENSEX](strategies/atm-widesl-sensex/README.md) | Descriptive (side look, no item) | — |

## Known mismatches between items and folders

- BL-098's Widesl sweep writes into `packages/option-backtesting/research/bl097/`; BL-098 and BL-099
  have no folder of their own.
- Two backlog files carry BL-074 (one options, one momentum); the options pages cite
  `BL-074-drb-family-by-type-and-start-band.md`.
- BL-063 charges ₹13 **per order** (the INDEX title still says "a lot"); BL-096–099 and BL-101 use
  ₹20 per order. Each page says which applies.

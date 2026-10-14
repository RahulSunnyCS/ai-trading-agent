# SENSEX Widesl at ATM (side look)

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

The SENSEX Widesl with both legs moved from OTM2 to ATM: a short ATM straddle with Widesl's wide
stops. Everything else is the `S_wide_<HHMM>` rotation file unchanged: SL 114% (call) / 115% (put)
trailed 15/10 percent, ₹2,500 overall stop, partial square-off, exit 15:28, 25 start times 09:17 to
15:17.

It is a **side look, not a research item**: it has no BL number, no pre-registration, it is not in the
298-variant rotation universe and nothing is in `strategies/rotation/` or `TRADING_DATA_ROOT/rotation/`.

## Where it lives

Only in the owner's main checkout, untracked:
`packages/option-backtesting/research/atm_widesl/`

- `run.py simulate` builds `variants/S_atm_<HHMM>.yaml` by text-replacing `OTM2` with `ATM` in each
  `S_wide_<HHMM>.yaml`, then simulates every day `S_wide_0917` has a stored result, writing
  `results/S_atm_<HHMM>.csv` (day, net, gross; costs 0, so net = gross).
- `run.py rank` adds the 25 ATM series to the stored 298 and prints where they would rank for
  2026-10-14 under lists A, B and C at two VIX opens (14.11 and 15.25), pooling them with Widesl for
  the family score. It prints only; no ranked output was saved.
- `variants/`, `results/` and `*.log` are ignored by the folder's own `.gitignore`. The YAML header
  comment still reads "short ATM weekly SENSEX strangle" after the text swap; the legs are a straddle.

## What the result files show

Computed for this page from the 25 result CSVs (492 SENSEX days, 2024-10-09 → 2026-10-13) beside the
stored `S_wide_<HHMM>` results on the same days. Gross, 1 lot, before charges, in-sample, no rule:

| | 09:17–11:47 (11 start times) | 12:02–15:17 (14 start times) | All 25 |
|---|---|---|---|
| ATM, summed gross | ₹4,30,085 | ₹10,22,093 | ₹14,52,178 |
| OTM2 (`S_wide`), summed gross | ₹5,70,842 | ₹7,31,087 | ₹13,01,929 |

- ATM earned more than OTM2 at 16 of 25 start times, mostly from 12:02 on; OTM2 earned more at most
  morning starts (09:17 OTM2 ₹1,78,525 against ATM ₹1,15,611).
- ATM drawdowns were deeper at most morning starts (09:32: −₹70,043 against −₹51,378) and mixed
  from 12:02 on.
- The afternoon lead echoes [BL-060][bl060], where SENSEX closest-premium ₹250 beat OTM2 mostly after
  12:02 (₹153–156 against ₹94–103 a day, before charges; [Widesl strike / premium](../widesl/strike-premium.md)).

These are descriptive sums over a period already used to build the rotation, before charges. ATM legs
are dearer, so STT and exchange charges per trade are higher than OTM2's; that was not computed.

## Not yet tested

- Anything. Adding ATM SENSEX Widesl to the rotation would need a BL item with a committed Phase 0,
  the same read-out BL-080 used for new families (does each list keep ≥ its gross in 2 of 3 periods,
  above random P90), and charges. SENSEX has no options data before 2023-07, so there is no
  2022–24 hold-out for it.

## Related

- [Widesl](../widesl/README.md), [Widesl strike / premium](../widesl/strike-premium.md),
  [rotation ranking](../../common/rotation-ranking.md), [charges](../../common/charges.md).
- [BL-080][bl080] (how new families were judged for the universe).

[bl060]: ../../../../backlog/BL-060-sensex-widesl-closest-premium.md
[bl080]: ../../../../backlog/BL-080-drb-wider-closest-premium-families.md

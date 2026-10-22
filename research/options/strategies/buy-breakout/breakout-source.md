# Buy: breakout source

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Which price the range and the breakout are measured on. `source: instrument` uses the leg's own
option premium (AlgoTest's "Strike Price" choice); `source: underlying` uses the index. With
`underlying` the range is the index's high/low over [entry, until), and the leg fills at the option's
**close** of the breakout minute (`legwise/engine.py`). `side: high` or `low` picks which edge
triggers.

## Live value

`source: instrument`, `side: high` on both legs, live and rotation.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | underlying (`source_underlying`; base instrument) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; the worst non-re-entry row (below) | [BL-097][bl097] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ gross | Fit Δ net | Holdout Δ gross | Holdout Δ net | Files ≥ base | Files net > 0 | No-entry days |
|---|---|---|---|---|---|---|---|---|
| underlying | 48 | −10,848 | −12,823 | −7,878 | −9,317 | 12% | 0 | 21.3% |

## What we know

- As run, the underlying source is clearly worse in both years and before charges.
- **Caveat on how it was run.** The sweep changed only `source` (`run_family_sweep.py`, variant kind
  `source`); both legs kept `side: high`. With the index as the source, the put leg is then bought when
  the index breaks **up** through its range, the wrong direction for a put. The result therefore says
  little about an underlying breakout done the natural way (call on an index break up, put on a break
  down).
- No-entry days jump to 21.3%: an index range is broken less often than an option's premium range,
  which also moves on time decay and implied volatility.

## Not yet tested

- The natural underlying version: CE leg `side: high`, PE leg `side: low`, both `source: underlying`.
  BL-097 ruled out asymmetric CE/PE parameters in its first study, so this needs its own
  pre-registration or a dated override.

## Related

- [Breakout window](breakout-window.md), [30-minute consolidation](consolidation-30m.md) (which
  also has an index-or-option choice).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
- The same ideas on the index with a 1-minute entry, tested in [BL-152](../breakout/README.md) (killed).

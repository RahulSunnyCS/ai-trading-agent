# Gap-and-go: the Williams back-up

**Status:** Tested (killed) · **Last updated:** 2026-10-25

## What it is

After a gap-and-go stand-down (`opposite_first` or `filled`, never `no_break`), on gaps under 0.2% or at
least 0.5%: the first 1-minute close beyond today's open ± 0.5 × the previous session's highest-minus-lowest
close, from the minute after the stand-down to 14:29. Rule `bl164_h2_williams` in `research/bl164/specs.py`;
grammar operator `prev_agg` (BL-164 Phase 1).

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| H2 | the published factor (0.5) and gap bands | NIFTY, 2024-10-09 to 2026-10-08, BL-063 charges, 1 lot | Killed: −₹119 a trade, t −0.35 (163 trades) | [BL-164][bl164] Result |
| H3 (H1, else H2) | — | same | Killed: −₹10 a trade, t −0.04 (310 trades) | [BL-164][bl164] Result |

## What we know

- 163 trades, win rate 34%; −₹252 a trade at 0.5% slippage. Adding it to gap-and-go turns the chain's total
  from +₹16,261 to −₹3,206.
- It beats a random later minute beyond the level (percentile 1.00, random mean −₹914), which says late
  entries are worse still, not that this one pays.
- The gap rule (trade below 0.2% and from 0.5%, never between) is non-monotonic; it was run as published,
  not tuned.

## Not yet tested

- Other factors, gap bands or windows (will-not-run in BL-164).

## Related

- [Band and gap direction](band-and-gap.md).

[bl164]: ../../../../backlog/BL-164-gap-and-go-williams-chain.md

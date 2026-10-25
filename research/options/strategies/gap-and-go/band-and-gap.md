# Gap-and-go: the band and the gap direction

**Status:** Tested (killed) · **Last updated:** 2026-10-25

## What it is

The 10% band beyond the 09:15–09:45 closing range, taken only in the gap's direction (gap = 09:15 open vs
the previous 15:15 close), with two stand-downs: the opposite band broke first (`opposite_first`), or NIFTY
had already touched the previous 15:15 close (`filled`). Rule `bl164_h1_gap_and_go` in
`research/bl164/specs.py`; grammar operators `prev_at`, `ever` (BL-164 Phase 1).

## Live value

None. Nothing trades this.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| H1 | the published band (10%), gap direction, both stand-downs | NIFTY, 2024-10-09 to 2026-10-08, BL-063 charges, 1 lot | Killed: +₹111 a trade, t 0.33 (147 trades) | [BL-164][bl164] Result |

## What we know

- 147 trades in two years (about 30% of sessions); win rate 39%, a fat right tail (best +₹18k, worst about
  −₹7k). +₹111 a trade before slippage, −₹35 at 0.5%, −₹210 at 1%.
- The trade beats the same trade at a random later minute beyond the band (percentile 1.00; random mean
  −₹484), like every BL-152 level: the first break is the best entry, not a profitable one.
- Description only: by half-year −₹674 / +₹80 / +₹377 / +₹352 / −₹26; down days +₹273 (64), up −₹15 (83);
  expiry days +₹724 (23). Not findings; any one of them would be a new, registered test.
- The pilot month (2024-10-09 to 11-08) had 2 H1 days in 22, and 11 stand-downs on 0.2–0.5% gap days.

## Not yet tested

- Any other band width, opening-range length or window (the published values only; BL-164's will-not-run list).
- SENSEX (a separate item, by the owner's decision, only after a NIFTY pass).

## Related

- [Five-minute breakout: the level](../breakout/level.md) (BL-152), where the 09:15–09:44 range was the worst level.
- [Intraday state and event triggers](../../common/intraday-state.md).

[bl164]: ../../../../backlog/BL-164-gap-and-go-williams-chain.md

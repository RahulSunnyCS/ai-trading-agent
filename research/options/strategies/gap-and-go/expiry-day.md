# Gap-and-go: expiry day

**Status:** Tested (killed) · **Last updated:** 2026-10-25

## What it is

Gap-and-go (BL-164's H1) taken only on a NIFTY weekly expiry day: a session whose nearest listed expiry is
that session (the rule the simulator uses for the traded option). Grammar leaf `expiry_day` (BL-165),
built by `ruletest/frame.py`'s `ExpiryDayLoader`. Rule `bl165_l2_expiry_day` in `research/bl165/run.py`.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| L2: H1 on expiry days | both sides, controls on expiry days only | NIFTY, 2022-01-03 to 2024-10-08 (unseen), BL-063 charges, 1 lot | Killed: +₹746 a trade, t 1.21 (43 trades; bar 2.24) | [BL-165][bl165] Result |

## What we know

- The lead came from BL-164's learning-period breakdown (+₹724 on 23 expiry-day trades, below the 40-trade
  floor), so it was tested only on 2022–24.
- There it stayed positive: +₹746 a trade, 51% winners, +₹649 at 0.5% slippage, better than a random later
  minute on every draw. But t is 1.21 and without its three best trades the mean is −₹18.
- Description only: down +₹961 (22 trades), up +₹521 (21).

## Not yet tested

- Expiry day combined with gap-down; days to expiry other than 0; SENSEX (will-not-run in BL-165).

## Related

- [Band and gap direction](band-and-gap.md); [Buy breakout: days to expiry](../buy-breakout/days-to-expiry.md).

[bl165]: ../../../../backlog/BL-165-gap-and-go-leads-gap-down-and-expiry.md

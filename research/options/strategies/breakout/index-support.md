# Five-minute breakout: Bank Nifty, Nifty IT and Reliance support

**Status:** Tested (killed) · **Last updated:** 2026-10-23

## What it is

The owner's hunch: a NIFTY breakout is more likely to hold when at least two of Bank Nifty, the Nifty IT index and
Reliance are also beyond their own level of the same type. "Supported" means, at the minute NIFTY's entry is
decided, an instrument's 1-minute close is beyond its own `or30` / `roll30` / `held30` / `prevday` level built from
its own bars (`research/bl153/support.py`).

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| Support (2 of 3) | the four reference variants (stop `lvl`, trade `atm`, exit `eod`) | NIFTY, 2024-10-09 to 2026-10-08, after charges | Killed: none passes | [BL-153][bl153] |

Difference D = mean net of supported minus unsupported trades, p from 10,000 shuffles of the labels, Holm over the
four tests:

| Level | Trades | Supported / not | D (₹ a trade) | p (Holm) | Why it fails |
|---|---|---|---|---|---|
| `or30` | 200 | 86 / 114 | +53 | 0.43 (0.87) | not significant |
| `roll30` | 370 | 185 / 185 | +224 | 0.23 (0.69) | not significant |
| `held30` | 52 | 4 / 48 | +4,090 | 0.03 (0.11) | 4 supported trades; Holm p above 0.05 |
| `prevday` | 113 | 45 / 68 | −500 | 0.78 (0.87) | negative |

## What we know

- Support was common on three levels (40% to 50% of trades), so the filter was selective enough to test; the
  largest gap, `roll30` +₹224, is well inside shuffle noise.
- The three instruments are large parts of NIFTY itself, so they tend to move with it; "two of three agree"
  carries little information beyond the NIFTY breakout.
- Both loaded series were checked before use: NIFTY IT and Reliance cover 99.6% to 99.9% of NIFTY's sessions
  (the missing days are Diwali muhurat sessions); ten Reliance files that arrived truncated were downloaded again.

## Not yet tested

- Other definitions of support (same direction since the open, the last 30 minutes), one of three or all three,
  other instruments (HDFC Bank, ICICI Bank). Each needs its own registered item.

## Related

- [Breakout level](level.md), [Trade, stop and exit](trade-and-exit.md).

[bl153]: ../../../../backlog/BL-153-breakout-support-from-bank-it-reliance.md

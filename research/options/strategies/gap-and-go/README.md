# Gap-and-go opening-range band → Williams back-up (NIFTY, 150-point ITM buys)

**Last updated:** 2026-10-25 · **Status:** Tested (killed) · Items: [BL-164][bl164], [BL-165][bl165]

## Definition

A published NIFTY intraday option-buying chain (OptionsBuyer.in), tested exactly as written and registered
before any run in [BL-164][bl164] Phase 0 (`packages/option-backtesting/research/bl164/specs.py`):

1. **Gap-and-go (H1).** The gap is the 09:15 open against the previous session's 15:15 close. The opening
   range is the highest and lowest 1-minute close 09:15–09:45; the band is 10% of its width beyond it. The
   first close through the band in the gap's direction, 09:46–12:00, buys the 150-point in-the-money weekly
   (CE up, PE down). It stands down if the opposite band breaks first, if the gap was already filled, or if
   nothing breaks by 12:00.
2. **Williams back-up (H2).** Only after an opposite-first or filled stand-down, and only when the gap is
   under 0.2% or at least 0.5%: the first close beyond today's open ± half the previous session's close range,
   up to 14:29, buys the same option.
3. **Exits.** −30% stop; once the premium has been above 105% of entry, out at 80% of its highest; out at
   15:15. Judged on 1-minute closes. One trade a day.
4. **The chain (H3)** is H1, else H2.

## What we know in one paragraph

Nothing passed. On 2024-10-09 to 2026-10-08, after charges, gap-and-go made +₹111 a trade over 147 trades
(t 0.33), the Williams back-up −₹119 over 163 (t −0.35) and the chain −₹10 over 310 (t −0.04); the bar was t
≥ 2.0. Gap-and-go's small gain goes negative at 0.5% slippage. Every test beat entering the same trade at a
random later minute while the index was still beyond its level, so the first break is the best moment in the
move, but buying the option there still does not pay after charges. This agrees with
[the five-minute breakout](../breakout/README.md) (BL-152) and the Buy range-breakout family. The locked 2022 to
2024 period was never opened for the full rules. Two slices that looked good on 2024–26, gap-down days
and expiry days, were then tested on 2022–24 ([BL-165][bl165]): both stayed positive (+₹485 and +₹746 a
trade) but neither came close to significance (t 1.0 and 1.2), and each rests on its three best trades.

## Variables

| Variable | Status | One-line takeaway |
|---|---|---|
| [Band and gap direction](band-and-gap.md) | Tested (killed) | +₹111 a trade, t 0.33; gap-down days only +₹485 on 2022–24, t 1.01 |
| [Expiry day](expiry-day.md) | Tested (killed) | +₹746 a trade on 2022–24 expiry days, t 1.21 (43 trades); about zero without the best three |
| [Williams back-up](williams-backup.md) | Tested (killed) | −₹119 a trade, t −0.35; a second chance on stand-down days loses |
| [ITM strike and premium stops](itm-strike-and-premium-stops.md) | Tested (one setting, killed) | 150 points ITM, −30% / 105% → 80% trail on closes; only the published values were run |

## Reproduce

The result files are git-ignored. `packages/option-backtesting/research/bl164/`: `specs.py` (the three rules),
`pilot.py` (one month, the grammar checked against the rules by hand), `run.py` (the three ledger tests and
the pass rule); the rules themselves are in `research/common/gap_and_go_specs.py`. BL-165:
`research/bl165/run.py`. Needs NIFTY 1-minute bars and the weekly option chain for 2024-10 to 2026-10.

[bl164]: ../../../../backlog/BL-164-gap-and-go-williams-chain.md
[bl165]: ../../../../backlog/BL-165-gap-and-go-leads-gap-down-and-expiry.md

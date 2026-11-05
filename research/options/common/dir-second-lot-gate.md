# Options: a gate on T1's second Dir lot

**Status:** Tested (killed) · **Last updated:** 2026-11-05

## What it is

T1's fourth lot is the Dir pick doubled on a non-expiry day (BL-133 / BL-183's Dir ×2). The owner's
aim was drawdown, not return: take the second Dir lot only when the Dir pick's own score is high,
accepting a lower return for a shallower drawdown (at two copies of T1 a bad Dir day is four lots of
its MTM stop, ≈ ₹16k before the Widesl). [BL-212][bl212] tested ten causal gates, each decided the
evening before from data to the previous close: the Dir pick's BL-210 confidence
([rotation confidence](rotation-confidence.md), one pick), its composite percentile and its 21-day
win rate, each at the trailing 250-day 50 / 67 / 75 % quantile, and VIX open ≤ 15. Nothing in the
product applies any of them.

## Live value

Dir ×2 on every non-expiry day with a Dir pick, where the row's toggle is on (BL-183). No gate.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-212][bl212] Phase 1 | ×1 (3 lots, stop ₹9k), ×2 (Dir doubled, stop ₹9k + its MTM SL), and ten gates: conf / rank / dirwin at trailing 50 / 67 / 75 %, VIX ≤ 15; judged on the share of ×2's extra return kept and of its extra drawdown and worst day taken | T1 list C as live, 220 normal days with a Dir pick 2025-01-10 → 2026-11-04, after brokerage, book stop, 0 % slippage (0.5 % reading beside it); fit ≤ 2025-10-08 / test after | **Killed** (primary conf @ 50 %: kept 0.53 of the extra return, took 1.00 of the extra drawdown and worst day; test half 0.53 / 0.17 / 1.00). No scored gate was off on the worst Dir day (−₹13,941) or week (−₹29,996) | `research/bl212/dir_gate_2026-11-05.json` (tracked); rows under `out/` git-ignored, regenerate with `dir_gate.py` |

## What we know

- **The Dir's own recent record does not mark its worst days.** Every confidence and win-rate gate at
  50 % was on for the −₹13,941 day and the −₹29,996 week; so was VIX ≤ 15. The drawdown a gate shed
  came from ordinary losing days, not the ones the owner wants to avoid.
- **The scored gates act as a dimmer.** conf @ 50 % kept half the extra return and, on the test half,
  a sixth of the extra drawdown but all of the extra worst day; conf @ 67 / 75 % are ×1 with the
  lot on a third of the days (kept 0.15–0.26). Win rate (dirwin @ 50 %) kept 0.62 and took 0.53 of
  the drawdown on the test half. A gate that sheds return and risk in proportion adds nothing a
  smaller fixed size does not.
- **A picked Dir's rank cannot gate itself.** Its composite percentile is in the top percentile by
  construction, so trailing quantile gates on it are on 89–99 % of days.
- **VIX ≤ 15 is the one lead, not a finding.** Over all days it kept 73 % of the extra return
  (+₹492/day vs ×1, [+262, +724]) with a max drawdown of −₹34,775, *smaller than ×1's* −₹40,047, and a
  shallower worst week, because it sat out April–May 2025. On the test half it was deeper than ×2
  (−₹28,299 vs −₹27,281: a 2026 episode came at a low VIX) and it never dodged the worst day. One
  episode decides it. Beside [Directional › VIX](../strategies/directional/vix.md).
- **Warm-up caveat for the trailing gates:** the period's deepest drawdown (Jan–May 2025) lies inside
  the 63 days they are forced on, so their all-days drawdown equals ×2's by construction; read their
  test-half columns.

## Not yet tested

- A pre-registered VIX-conditioned second Dir lot (no warm-up; the fixed cut-off declared, the 2026
  low-VIX episode in the record before the run).
- A smaller fixed second lot, or Dir ×2 at a smaller MTM stop, as the plain alternative a dimmer
  gate should be compared with.

## Related

- [Rotation confidence](rotation-confidence.md) (the figure the conf gate uses, killed for the
  basket), [Directional › entry time](../strategies/directional/entry-time.md) (BL-207: a spaced
  second Dir lot earns less than Dir ×2 with no smaller drawdown), [portfolio stop](portfolio-stop.md).
- Code: `packages/option-backtesting/research/bl212/dir_gate.py` (BL-207's replay with the gate
  arms; reads the live store, writes beside itself), `research/common/pick_confidence.py`.

[bl212]: ../../../backlog/BL-212-dir-second-lot-gate.md

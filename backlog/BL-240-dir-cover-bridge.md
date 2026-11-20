# BL-240 — Dir cover-bridge: when a sold leg is stopped, buy a ₹50 option of the same side and hold it until the leg is re-sold; the 21% Dir picks, overall stop ₹3k–₹7k

| | |
|---|---|
| **Priority** | P2 — the owner's idea (2026-11-20); cheap on the engine's existing stop-and-reverse code, no live change until it passes |
| **Status** | Done, killed (2026-11-20): fails all 5 rules; confirmation never opened |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-20 |
| **Depends on** | BL-186 (stop-and-reverse, `reverse_on_sl`, the ₹50 strike and `resell_after_reverse`), BL-074 (list C's picks), BL-096 / BL-181 (overall stop findings), BL-222 (the T1 Dir pick-day runner) |
| **TODO.md row** | — |

## Context

The owner (2026-11-20): when a Dir leg's stop is hit (say the CE), do not only close it: **buy a CE out of the money
and hold it until the stopped CE is sold again** (RE COST). The same for the PE. Between the stop and the re-entry
the book then has a bought option of the side that is moving, so a real breakout still pays and the loss is
capped; because that bounds the loss, the **overall MTM stop can sit higher** than today's ₹3,000. The owner asked
for ₹3k, ₹4k, ₹5k, ₹6k and ₹7k.

What is already known ([stop-and-reverse](../research/options/strategies/directional/stop-and-reverse.md), BL-186,
killed): buying the stopped option **earns on its own** (+₹104 to +₹135 a Dir pick after its two orders) but the book
lost, because (a) the reversed leg was not re-sold at cost (the RE COST re-sale is a large part of Dir's profit),
(b) the long's own stop whipsawed and tripped the overall stop, and (c) holding the long grew the drawdown (−₹50k
against −₹26k). Amendment 1 let RE COST re-sell after the long **closed** (a 30-minute exit or a stop), and a ₹50
strike cut the drawdown to about −₹39k, still deeper than the plain exit, and nothing was significant.

What is new here: the cover is **closed at the minute the short is re-sold** (the two are never held together), so the
RE COST re-sale is kept, the long has no stop of its own (no whipsaw), and the overall stop is swept up to ₹7,000
(BL-096 stopped at ₹4,000; BL-181 went to ₹10,000 on ITM2 / ITM3 only; no Dir pick was run above ₹5,000 with a
cover). The engine's reverse does not close the long on a re-entry, and allows one reversal per leg per day; both are
changed in Phase 1.

**Scope (owner, 2026-11-20): only Dir picks with the 21% leg stop.** Those are the 100 Dir files of Core's rotation
universe (`strategies/rotation/`: `N_dir`, `N_ditm1`, `S_dir`, `S_ditm1`, each at 25 start times: 21% leg stop, RE COST
×1, overall ₹3,000, exit 15:28) and the fixed base Dir (`N_dir_atm_0924`, the live file's ATM copy). **T1's Dir files
are not in scope**: `N_dir-t1s29` has a 40% stop and RE COST ×2, `N_ditm1-t1s36` 20% and `S_ditm1-t1s44` 15%, both with a
trail and RE COST ×2. T1 is the book the accounts trade, so a pass here is a result about the Core Dir and the live
file; it would need its own item to reach T1's.

## Goal

Know whether turning each stopped Dir leg into a bought ₹50 option of the same side, held until that leg is re-sold,
earns more per pick-day than the plain 21% Dir at the same overall stop, and whether it makes a higher overall stop
(₹5,000–₹7,000) pay without a deeper drawdown than today's.

## Out of scope

Any live change, the AlgoTest and Quantiply exports (no conditional-buy-on-stop form is captured; BL-186), a stop on
the cover itself, covers on Widesl or Buy picks, T1's own Dir files, SENSEX settings beyond the picks, other cover
strikes (OTM1 / OTM2 or premium bands other than ₹35–₹70), a cover that closes on a clock.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** with a ₹50 same-side cover bought on every leg stop and closed when that leg is re-sold, Dir earns
  more per pick-day than the same Dir with the plain stop at the same overall stop M, and the drawdown does not
  deepen as M rises.
- **Universe:** Core's Adaptive Dir picks (`research/common/adaptive_picks.py`, `book="core"`: list C's names matching
  `^[NS]_(dir|ditm1)_`, recorded from 2026-10-12, reconstructed before as in BL-222): 2025-01-10 → 2026-10-08. A day
  with two Dir picks counts both (the pick-day is the unit); the count is fixed in Phase 1 before any arm is run and
  written into this Log. Each pick's own YAML is re-run by `simulate_day`; the only changes are the cover and the overall stop.
  Sessions after 2026-10-08 are never read.
- **Look-ahead check:** the cover is bought at the **close of the stop bar** from prices already printed; the strike
  is the one priced nearest ₹50 (band ₹35–₹70, the engine's `strike_premium`, BL-186 Amendment 1) in that bar's
  chain; the close is the next-minute fill of the re-sale. Picks are the ranking's, from earlier days only. The 21%
  files are the registry's untuned defaults, so unlike T1's the baseline is not tuned on this window; every arm is run
  on the same days.
- **Cover rule:** at each leg stop (a stop, not a trail exit) buy 1 lot of the same option type, same expiry, at the
  strike nearest ₹50. It is closed at the fill of that leg's RE COST re-sale, at the overall stop, or at 15:28,
  whichever comes first; if the re-sale never comes it is held to 15:28. One cover at a time per leg; a later stop of the
  re-sold leg buys a new cover (RE COST ×1, so at most two covers a leg a day). No stop on the cover.
- **Arms (₹23.6 an order and 0.5% slippage on every fill, the cover's two orders included), per pick-day, one lot:**
  A(M) the pick as it is with overall stop M; H(M) the same with the cover; M ∈ {3,000, 4,000, 5,000, 6,000, 7,000}.
  A(3,000) is the live setting. W(M) is a placebo, the cover on the **opposite** option type (PE after a CE stop), same
  strike rule, closed on the same re-sale; reported, never a candidate.
- **Primary cell:** M = 5,000 (BL-186's A5 baseline). The other four are the owner's sweep; the best M is not
  selected as a candidate.
- **Pass / kill rule (primary cell, after charges and 0.5% slippage):** (i) H(5k) minus A(5k) and H(5k) minus A(3k)
  each have a circular 5-day block-bootstrap 90% interval (2,000 resamples, seed 20261120) with the 5th percentile above
  zero; (ii) H(5k) minus W(5k) has its 5th percentile above zero (the side matters, not just owning an option); (iii) the
  pick-days split into 4 equal consecutive blocks, H(5k) above A(5k) in at least 3; (iv) H(5k)'s maximum drawdown and
  worst 5-day sum are no worse than A(3k)'s (the live setting); (v) H(M) above A(M) at four of the five M values.
  Anything else: killed. Reported beside it: orders, covers bought, share of covers closed by a re-sale, cover net
  alone, the same at 0% and 1% slippage, up-trend and down-trend days separately.
- **Hold-out / confirmation:** sessions after 2026-10-08 unread. Only if the primary cell passes: the fixed base Dir
  (`strategies/rotation_base/N_dir_atm_0924.yaml`, 21%) with the same arms on NIFTY 2022-01-03 → 2024-10-08, opened once.
- **Will not run:** other cover strikes, a cover stop or clock exit, the cover on both sides, M above ₹7,000 or below
  ₹3,000, Widesl or Buy picks, a cover only on one leg; each needs `override: <reason>` in the Log.

### Phase 1 — Engine and runner

- **Tasks:** add to `reverse_on_sl` a `close_on_reentry` flag (the long closes at the fill of the re-sale; needs
  `resell_after_reverse`) and lift the one-reversal-a-day limit when it is set; an `opposite` flag for the placebo;
  `research/bl240/run.py` re-runs every in-scope Dir pick under the 11 arms (A and H at five M, W at the primary M) and stores the
  per pick-day net, orders, covers and stop-outs.
- **Deliverables:** engine change with unit tests (the cover closes at the re-sale minute; at the overall stop; at 15:28; a
  second stop buys a second cover; flags off = every existing golden unchanged), the runner.
- **Done when:** A(3,000) reproduces the stored Core result for each pick-day at 0% slippage with no charges, to the rupee;
  the golden tests pass unchanged.

### Phase 2 — Judge

- **Tasks:** the rule above, sensitivity rows (0% / 1% slippage), the trend splits.
- **Deliverables:** the verdict in the Log, a findings page update (`stop-and-reverse.md` row and `mtm-sl.md`), the
  INDEX row.
- **Done when:** the verdict is recorded.

## Risks

- **The re-sale is what BL-186 lost, and the re-sale price is the stop's own.** If the stopped leg usually comes back to
  cost within minutes, the cover is bought and sold for nothing but charges and spread (~₹50 a cover); if it
  does not, the cover rides a trend that Dir's tight stop was built to avoid. Either way the gain is the trend days'.
- **A higher overall stop is the real lever** (BL-096: net rises with the stop to ₹4,000); the cover must beat the plain
  Dir **at the same M**, not the live ₹3,000, which is why rule (i) has both.
- **Engine parity:** a long closed by another order is not captured in AlgoTest or Quantiply forms; nothing live is
  possible without that (BL-186).
- **Not the book that trades.** T1's Dir picks (40 / 20 / 15% stops) are outside the item; Core is not traded now
  (settings v9: both AlgoTest accounts trade T1). A pass is evidence for the 21% Dir and the live file only.
- **A shared window** with BL-186 and BL-222 (the same period): the cells are not independent of what was already read.

## Open questions

Answered 2026-11-20: cover strike nearest ₹50, hold to 15:28 if no re-sale; the 21% leg-stop Dir picks only (Core's list C Dir picks and the base; T1's excluded), 2025-01-10 → 2026-10-08.

## Log

- 2026-11-20 — created and pre-registered before any run, from the owner's idea.
- 2026-11-20 — scope narrowed by the owner to the 21% leg-stop Dir picks (Core's rotation Dir files and the base); first drafted on T1's Dir picks (40 / 20 / 15% stops), now out of scope.
- 2026-11-20 — **Phase 1 built, before any arm was run.** Engine: `reverse_on_sl.close_on_reentry` (RE COST does not wait for the long; it closes at the close of the re-sale bar, `price_at(m + 1)`, reason COVER, and the leg can reverse again) and `opposite` (the placebo); both off by default and out of the spec dump, 5 unit tests, goldens and exports unchanged. Pick-days fixed: **344** (Core list C Dir picks, one per day on 344 days, 2025-01-10 → 2026-10-08; NIFTY 176, SENSEX 168); `research/bl240/run.py --count`.
- 2026-11-20 — **Result** (344 Core Dir pick-days, 2025-01-10 → 2026-10-08; control at 0% slippage and no charges equals the stored Core result on all 344). ₹ per pick-day after ₹23.6 an order and 0.5% slippage, plain A(M) → cover H(M): ₹3k 231 → 2, ₹4k 278 → 94, **₹5k (primary) 270 → 128**, ₹6k 257 → 115, ₹7k 251 → 46; H(M) minus A(M) −229 / −184 / −142 / −143 / −205. Primary: H5 − A5 −142 [−366, +88], H5 − A3 −103 [−320, +132], H5 − placebo W5 +155 [−111, +431]; blocks H5 − A5 −267 / −176 / +188 / −314; max drawdown 44,703 against A3's 27,957, worst 5 days −19,467 against −13,256. All five rules fail (i, ii, iii, iv, v): **killed**. Covers: 533 bought at ₹5k (1.55 a pick-day), 263 closed by a re-sale (49%), the rest held to the exit; the covers alone lost ₹24,878 gross, about ₹47 each, so the bridge costs more than it earns whether or not the leg comes back. The placebo (opposite side) is the worst arm (−27 a day), so the side matters, but the right side still loses. Slippage: H5 − A5 is −80 at 0% and −248 at 1%. The plain overall stop alone peaks at ₹4,000 (278) and is flat to ₹7,000 (251), the same shape as BL-096. Descriptive, not tested: SENSEX picks H5 654 against A5 534 (168 days), NIFTY picks −374 against +19 (176 days); up-trend days H5 403 against A5 493, down-trend days −117 against +72. The SENSEX half is a lead found after the fact (its lot is 20, rupee stops bind less; BL-056): it needs its own registration and the 2022–24 confirmation.

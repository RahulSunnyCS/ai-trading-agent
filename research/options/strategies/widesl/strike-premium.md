# Widesl: strike and premium

**Status:** Tested · **Last updated:** 2026-10-18

## What it is

How far from the money the two short legs are. Either a fixed distance (`strike: { strike_type: OTM1 }`)
or the strike whose premium at entry is closest to a rupee target (`strike: { closest_premium: 80 }`),
chosen separately for the call and the put. SENSEX premiums run at about 3.2–3.3 × NIFTY's at every time
of day, so NIFTY ₹80 / ₹100 correspond to SENSEX ₹250 / ₹320 ([BL-060][bl060]).

## Live value

NIFTY OTM1 and SENSEX OTM2 (`nifty_widesl_917_otm1.yaml`, `sensex_widesl_917_otm2.yaml`); a third live
file sells the NIFTY strike closest to ₹65 (`nifty_widesl_917_closest_premium.yaml`). Rotation families:
`N_wide`, `N_p80`, `N_p100`, `S_wide`, `S_p250`, `S_p320`.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-055 | NIFTY OTM1 vs ₹80 vs ₹100, in fixed mixes | 2024-10-09 → 2026-10-08, before charges | Descriptive: closest premium earns 4–19% less, with the smaller drawdown in three of four mixes | [BL-055][bl055] |
| BL-060 | SENSEX OTM2 vs ₹250 vs ₹320, 24 start times | 2025-09-01 → 2026-10-08, before charges | Descriptive: ₹250 ₹110/day vs OTM2 ₹84 (higher at 17 of 24 times), same drawdown; ₹320 ₹82, deeper drawdown | [BL-060][bl060] |
| BL-065 | Rotation without the closest-premium families | P1 (2025-12 → 2026-10), before and after charges | **Worse**: gross −30%, net −37% | [BL-065][bl065] |
| BL-075 | Closest-premium families in vs out, 19 weightings × 3 periods | P1, P2 (Jan–Aug 2025), P3 (NIFTY 2022-04 → 2024-10) | **Kept**: removing them pushed 17 of 19 cells below chance | [BL-075][bl075] |
| BL-080 | Add NIFTY ₹40 / ₹60, SENSEX ₹120 / ₹200 | P1, P2, P3, before charges | **Harmful**; then leave-one-out: NIFTY ₹80 / ₹100 carry weight, SENSEX ₹250 / ₹320 dead weight, but pruning them was **not adopted** | [BL-080][bl080] |
| BL-098 | All six rotation families × one-factor stops | holdout 2025-10-09 → 2026-10-09, **after charges** | Descriptive: NIFTY leaders ₹100 / ₹80 (morning, afternoon) and OTM1 (midday); SENSEX ₹250 in every band | [BL-098 report][bl098q] |
| BL-126 (POC) | NIFTY ₹120 at SL 60 % (and ₹100 at SL 75 %) added beside Core ₹100, all 25 slots | 2024-10-09 → 2026-10-16, gross, in-sample | Not positive standalone or in Adaptive (₹120: +₹23 [−33, +81] per lot-day in Adaptive, shallower drawdown) | [BL-126][bl126] |
| BL-127 | NIFTY ₹80, ₹100, ₹120 × six leg stops (60–115 %), a stop chosen per premium on 2024-10 → 2025-10, the best two added to Adaptive and read on 2025-10 → 2026-10 | Gross, selection and test years | Standalone in the selection year ₹120 (SL 70 %, +295) > ₹100 (SL 70 %, +281) > ₹80 (SL 80 %, +230) per lot-day; Adaptive with ₹80 SL 80 % and ₹120 SL 70 % added: −₹10 [−82, +63] on the test year, deeper drawdown. **Not positive**; ₹120's own first-year Stage B gain (+₹15) did not repeat | [BL-127][bl127] |
| BL-128 | SENSEX ₹240, ₹300, ₹350 × six leg stops (60–115 %), a stop chosen per premium on 2024-10 → 2025-10, the best two added to Adaptive and read on 2025-10 → 2026-10 | Gross, selection and test years | Standalone in the selection year ₹300 (SL 60 %, +160) > ₹350 (SL 60 %, +155) > ₹240 (SL 60 %, +153) per lot-day; Adaptive with ₹300 and ₹240 at SL 60 % added: −₹2 [−88, +79] on the test year, drawdown deeper (₹300 alone +₹20, ₹240 alone +₹25, intervals include zero). **Not positive**; ₹300's first-year Stage B gain (+₹79 [+15, +149]) did not repeat | [BL-128][bl128] |

Fixed mixes, no portfolio stop, total / max drawdown, OTM1 | ₹80 | ₹100 ([BL-055][bl055], before
charges): 5 × Widesl ₹8.73L / −₹2.26L | ₹7.02L / −₹1.99L | ₹7.37L / −₹1.76L; 3 Widesl + 2 Dir ₹9.47L /
−₹1.67L | ₹8.45L / −₹1.05L | ₹8.66L / −₹1.01L.

## What we know

- **NIFTY.** As a fixed strategy, ₹80 / ₹100 earn a little less than OTM1 with a smaller drawdown (before
  charges). One year, 1 lot, family means with the ₹2,500 stop: OTM1 ₹41,881, closest premium ₹34,815
  ([BL-070][bl070]). In the rotation they carry weight in every check (BL-065, BL-075, BL-080). After
  charges, ₹100 leads the morning and afternoon bands and OTM1 the midday (BL-098).
- **SENSEX.** ₹250 beat OTM2 before charges (BL-060) and leads every SENSEX band after charges (₹24–61
  a day for the leader; OTM2's only listed row is −₹23 a day, BL-098). In the rotation
  ₹250 / ₹320 looked like dead weight, yet removing them dropped list C below chance in Jan–Aug 2025.
- **Further out is worse in the rotation.** ₹40 / ₹60 / ₹120 / ₹200 were picked often (14–22% of core
  slots) and made every list worse and more fragile (5% of weightings above chance everywhere, against
  19%) ([BL-080][bl080]).
- Closest premium balances the legs: at 09:17 OTM2 sold a ₹277 call and a ₹228 put on average; ₹250
  sold ₹249 / ₹252 (BL-060, last 15 sessions).
- The rotation picks closest premium most on expiry days (about half its core lots at 0 days to expiry,
  10–20% at 2–3 days; [BL-061][bl061], [BL-062][bl062]). A fixed premium sells near the money close to
  expiry, a different position; not tested.

## Not yet tested

- The live ₹65 file (exit 15:25, trail in points) on its own.
- BL-098's follow-up family screen: NIFTY OTM2 / OTM3 / ₹60 / ₹120; SENSEX OTM1 / OTM3 / ₹200 / ₹400.
- SENSEX before 2024-10 (not imported; none exists before 2023-07, [BL-071][bl071]). NIFTY 2022–24
  results exist for OTM1, ₹80 and ₹100 at every start time (run for BL-071), but no fixed-strategy
  comparison has been read from them.

## Related

- [Directional strike](../directional/strike-premium.md); [rotation ranking](../../common/rotation-ranking.md).
- Scripts: `research/bl055/gen_premium.py`, `research/bl060/`, `research/bl080/` (`ablate.py`,
  `family_years.py`); outputs git-ignored, regenerate with them.

[bl055]: ../../../../backlog/BL-055-daily-portfolio-stop-loss.md
[bl060]: ../../../../backlog/BL-060-sensex-widesl-closest-premium.md
[bl061]: ../../../../backlog/BL-061-rotation-with-closest-premium-widesl.md
[bl062]: ../../../../backlog/BL-062-whole-day-rotation.md
[bl065]: ../../../../backlog/BL-065-drb-two-lots-per-strategy.md
[bl070]: ../../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl071]: ../../../../backlog/BL-071-drb-out-of-period-and-2022-import.md
[bl075]: ../../../../backlog/BL-075-drb-final-map-and-structural-switches.md
[bl080]: ../../../../backlog/BL-080-drb-wider-closest-premium-families.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
[bl126]: ../../../../backlog/BL-126-nifty-premium-widesl-tight-sl-poc.md
[bl127]: ../../../../backlog/BL-127-nifty-premium-widesl-sl-selection.md
[bl128]: ../../../../backlog/BL-128-sensex-premium-widesl-sl-selection.md

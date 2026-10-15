# Directional: strike (ATM vs ITM1)

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Where both short legs sit: ATM (a short straddle) or ITM1 (the call one strike below, the put one strike
above the money). Set by `legs[].strike: { strike_type: ATM | ITM1 }`. Closest-premium strikes have not
been used for Dir.

## Live value

ITM1 in the live `nifty_dir_924_itm1_sl21_recost.yaml`. ATM in the fixed base
(`rotation_base/N_dir_atm_0924.yaml`, the owner's choice, [BL-058][bl058]). The rotation carries both
(`N_dir` / `S_dir` ATM, `N_ditm1` / `S_ditm1` ITM1).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-080 block 2 | ATM vs ITM1, 25 start times, both indices; and ITM1 added to the rotation | family by year NIFTY 2022–2026, SENSEX 2024–2026; rotation P1 / P2 / P3; before charges | **Useful**: ITM1 beats ATM every year; the 298 list beats the 248 list for A, B and C | [BL-080][bl080] |
| BL-080 blocks 3–4 | Leave each family out; the 100-weighting map on the 298 list | P1 / P2 / P3 | Both Dir ITM1 families and Dir ATM **carry weight**; the map is far less fragile (58% of weightings above chance everywhere, against 19%) | [BL-080][bl080] |
| BL-096 | ATM and ITM1 across the stop / MTM / exit grid | holdout 2025-10-09 → 2026-10-09, before and **after charges** | Descriptive ranking | [pre-charge][bl096q], [post-charge][bl096pc] |
| BL-099 | One winner per index × band across Dir, Buy, Widesl | same holdout, after charges | Every Dir winner is ATM | [BL-099][bl099] |

ITM1 minus ATM, mean per variant, 1 lot, before charges ([BL-080][bl080]): NIFTY +₹13k, +₹16k, +₹4k,
+₹7k, +₹12k (2022 → 2026); SENSEX +₹3k, +₹14k, +₹9k (2024 → 2026); both at about 60% winning days.

After charges, band leaders by strike ([BL-096 post-charge][bl096pc]):

| Index, band | Best ATM | Best ITM1 in the top three |
|---|---|---|
| NIFTY, all three bands | leads every band | none in the top three |
| SENSEX 09:15–11:00 | 25% / ₹3,000: ₹57,659, MTM stops 15.5% | 25% / ₹2,500: ₹66,975, MTM stops 23.5% |
| SENSEX 11:00–13:00 | 21% / ₹2,500: ₹61,149, 12.3% | 21% / ₹2,500: ₹78,049, 15.9% |
| SENSEX 13:00–15:30 | 35% / ₹2,000: ₹12,975, 8.8% | 35% / ₹2,000: ₹16,461, 10.5% |

## What we know

- Before charges ITM1 earns more than ATM in every year on both indices, at the same win rate (BL-080).
- In the rotation ITM1 adds return and robustness: with it, lists A, B and C gain in at least two of
  three periods and 58% of weightings are above chance in all three (BL-080). This is why the journal
  universe is 298, not 248.
- After charges, NIFTY's leaders are all ATM. On SENSEX, ITM1 nets more than the ATM leader in every
  band but stops out more often; the balanced score ranks ATM first (BL-096, BL-099).
- Pre-charge diagnostics put ITM1 first for NIFTY midday and SENSEX afternoon ([BL-096][bl096q]). The
  pre- and post-charge lists rank on different metrics and grids; read them side by side, not as one.
- The ATM family was never compared with AlgoTest; the live ITM1 file was ([BL-054][bl054] risks).

## Not yet tested

- ITM2 (BL-080: "will not run"), OTM, or a closest-premium Dir.
- Live ITM1 vs base ATM at 09:24 head to head, after charges, on the NIFTY 2022–24 days.

## Related

- [Widesl strike / premium](../widesl/strike-premium.md); [rotation ranking](../../common/rotation-ranking.md).
- Scripts: `research/bl080/` (`family_years.py`, `ablate.py`), `research/bl096/run_enriched.py`. Outputs
  git-ignored; regenerate with them.

[bl054]: ../../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl058]: ../../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl080]: ../../../../backlog/BL-080-drb-wider-closest-premium-families.md
[bl096q]: ../../../../backlog/BL-096-directional-qualified-list.md
[bl096pc]: ../../../../backlog/BL-096-directional-qualified-list-post-charge.md
[bl099]: ../../../../backlog/BL-099-combined-final-qualified-list-post-charge.md

# Buy: re-entry

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

What a leg does after its stop is hit. **RE COST** buys the same contract again when its price comes
back to the original entry price; **RE ASAP** re-selects the strike by the leg's own rule and buys at
the next bar's open. Set by `reentry_on_sl: { mode: cost | asap, count: N }`;
`no_reentry_after: "HH:MM"` blocks re-entries after a cut-off.

## Live value

None, live and rotation.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-097 | RE COST ×1, ×2; RE ASAP ×1, ×2; RE COST ×1 with cut-off 11:00 / 12:00 / 13:00 (base none) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; every row worse than none | [BL-097][bl097], [report][bl097q] |

BL-097 registered none, RE COST ×1, RE ASAP ×1 and RE COST ×2. The sweep script also ran RE ASAP ×2
and the three cut-offs (`run_family_sweep.py`), which are not in the registered table and have no
override line in the item's Log.

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ net | Holdout Δ gross | Holdout Δ charges | Holdout Δ net | Files ≥ base | Files net > 0 |
|---|---|---|---|---|---|---|---|
| RE COST ×1 | 48 | −8,628 | −1,410 | +11,188 | −12,598 | 10% | 0 |
| RE COST ×2 | 48 | −12,740 | +2,921 | +17,966 | −15,045 | 12% | 1 |
| RE ASAP ×1 | 48 | −13,148 | −2,641 | +15,214 | −17,855 | 6% | 0 |
| RE ASAP ×2 | 48 | −22,956 | −1,736 | +27,448 | −29,184 | 4% | 0 |
| RE COST ×1, cut-off 11:00 | 48 | −1,167 | −438 | +1,364 | −1,802 | 75% | 3 |
| RE COST ×1, cut-off 12:00 | 48 | −2,410 | −645 | +2,866 | −3,511 | 60% | 2 |
| RE COST ×1, cut-off 13:00 | 48 | −5,704 | −718 | +4,954 | −5,673 | 44% | 2 |

## What we know

- Before charges re-entry is roughly neutral: holdout gross moves by −₹2.6k to +₹2.9k a file, and in
  the fit year most re-entry rows earn more gross than the baseline.
- After charges every re-entry row loses, because each re-entry is a new pair of orders. The extra
  charges (₹11k–₹27k a file in the holdout) are several times any gross change.
- An earlier cut-off simply means fewer re-entries, hence fewer charges; none beats no re-entry.

## Not yet tested

- Nothing planned. A re-entry rule would need a gross edge large enough to pay a full extra round trip.

## Related

- [Widesl re-entry](../widesl/re-entry.md), [Directional re-entry](../directional/re-entry.md),
  [charges](../../common/charges.md).

[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md

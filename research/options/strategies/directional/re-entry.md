# Directional: re-entry

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Selling a leg again after its stop is hit. `legs[].reentry_on_sl: { mode: cost | asap, count: N }`:
`cost` re-sells the same contract when its price comes back to the original entry; `asap` re-selects the
strike by the leg's rule and sells at the next minute. `no_reentry_after` (HH:MM) is the cut-off.

## Live value

RE COST ×1 (`reentry_on_sl: { mode: cost, count: 1 }`) on both legs, no cut-off, in the live file, the
fixed base and every rotation Dir file.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-096 secondary | none, COST ×1, COST ×2, ASAP ×1, ASAP ×2; cut-off none / 11:00 / 12:00 / 13:00 (not crossed with everything) | 4,400 rows on four primary settings; holdout 2025-10-09 → 2026-10-09, before and **after charges** | Descriptive; exploratory (shortlist chosen after viewing the holdout) | [BL-096][bl096] |

Mean of the 100 bases, holdout, before charges: 25% / ₹4,000 with COST ×2 ₹83,541 (₹348 a day, drawdown
−₹17,242, Ulcer ₹5,384) against COST ×1 ₹81,783 (₹341 a day, −₹18,650, ₹5,967) ([BL-096][bl096]).

## What we know

- COST ×2 is net-neutral after charges: +₹7–12 gross, about ₹2k a year more charges, with a small
  drawdown and Ulcer benefit (BL-096).
- Re-entry is a large share of Dir's turnover: the post-charge band leaders made 59–156 re-entries over the
  holdout year ([BL-099][bl099]). Charges per strategy are ₹36–42k a year.
- The item gives no summary for no re-entry, ASAP or the cut-offs; those rows are in the raw files only.
- Engine/AlgoTest parity is still incomplete for some re-entry details (BL-096 risks), so re-entry results
  carry more model risk than stop results.

## Not yet tested

- A summary of the none / ASAP / cut-off rows, and their charged versions.
- Re-entry choices on the NIFTY 2022–24 days.

## Related

- [Stop-and-reverse](stop-and-reverse.md): buying the stopped leg instead of re-selling it (BL-186, killed; losing the RE COST re-sale is most of the cost).
- [Widesl re-entry](../widesl/re-entry.md) (none live); [charges](../../common/charges.md).
- Results: `research/bl096/results/` (git-ignored); `research/bl096/run_enriched.py` regenerates the
  diagnostic files; the 4,400-row secondary screen's script is not in the repo.

[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl099]: ../../../../backlog/BL-099-combined-final-qualified-list-post-charge.md

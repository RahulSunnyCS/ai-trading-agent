# BL-170 — Sheet against contract notes: explain the differences BL-168's reconciliation lists

| | |
|---|---|
| **Priority** | P2 — the Trade book replaces the sheet only once the two agree or every gap has a reason; nothing trades on it |
| **Status** | Planned (owner's review) |
| **Type** | chore |
| **Area** | contract-notes |
| **Created** | 2026-10-27 |
| **Depends on** | BL-168 Phase 3 (`node reconcile.js`, its report under `contract-notes/reconcile/`) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-168 Phase 3's "done when" asked the owner to explain every difference between the sheet and
the contract notes. On 2026-10-27 the owner moved that review into its own item, to do
themself, so BL-168 can close without it.

The report is `TRADING_DATA_ROOT/contract-notes/reconcile/sheet-vs-notes-<day>.md` (the store,
never the repo: it holds real figures). The run of 2026-10-27 covered 1 Apr 2025 – 23 Oct 2026:
312 day × broker rows match and 335 differ. Its reasons, as `reconcile.js` guesses them:

| Likely reason | Rows |
|---|---|
| differs, no reason found | 259 |
| the sheet has a figure, no note for this broker | 37 |
| the sheet has no figure, the notes do | 12 |
| the sheet matches one account only | 11 |
| a round difference — edited by hand? | 10 |
| a note with no sheet row | 5 |
| a day the sheet has twice | 1 |

250 of the 259 unexplained rows are ₹100 or more apart. Gaps that size on that many days
suggest one systematic cause (a column read wrongly, algo fees on one side only, a broker's
figure on the other's column) rather than 259 separate mistakes, so look for that first.
BL-168 already showed the formulas agree: the sheet's Profit is obligation − brokerage − other
charges − algo fees, which is what `obt realised` computes.

## Goal

Every row of the report has a reason: an extractor fix (in `packages/contract-notes`, with a
test on invented figures), a sheet edit made by hand, a note the sheet row missed, or a cause
that covers a group of rows.

## Out of scope

- Writing the sheet (this repo never does).
- Changing the Trade book's figures to match the sheet: the notes are the source.

## Plan

### Phase 1 — The owner's review
- **Tasks:** read the report; for the 259 unexplained rows, check a few against the sheet and
  the note's PDF (`contract-notes/raw/`) to find the systematic cause; mark the rest.
- **Deliverables:** the reasons, in this item's Log (no figures: the repo is public).
- **Done when:** every group of rows has a reason.

### Phase 2 — Fixes
- **Tasks:** any extractor fix the review finds, then `node run.js --reparse --from D --to D`
  and `node reconcile.js <sheet.csv>` again.
- **Done when:** a new report lists only rows whose reason is recorded.

## Risks

- Real figures in a commit. Reasons go in the Log as words and counts only.

## Open questions

None yet: the owner is doing the review.

## Log

- 2026-10-27 — created from BL-168 Phase 3's "done when", at the owner's request; the owner
  reviews it.

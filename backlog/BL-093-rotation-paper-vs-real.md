# BL-093 — Rotation: paper versus real (reconciliation widget)

| | |
|---|---|
| **Priority** | P2 — the only way paper and real divergence is measured, but nothing can be read before three inputs exist |
| **Status** | Blocked: contract-notes cutover (TODO §2), charge model in the nightly update, and the placement record in use |
| **Type** | feature |
| **Area** | options / dashboard |
| **Created** | 2026-10-11 |
| **Depends on** | BL-058 Phase 4 (the Daily log and its placement record, built 2026-10-11), BL-063 (the charge model, as arithmetic only), BL-168 Phase 3 (the contract notes in the repo, with the trade rows) |
| **TODO.md row** | — (filled in when started) |

## Context

Widget 10 of the Rotation workspace plan, split out of BL-058 Phase 4 on 2026-10-11 (owner: move it to its
own backlog item, to be taken later). The journal is paper: it records what each list picked and what the
variants' results were. The owner places the basket by hand on AlgoTest. Nothing yet joins the two, so a gap
between the journal and the broker statements would go unseen, and a gap made of skipped days or manual
changes would be indistinguishable from execution cost.

What exists on `main`:
- The Daily log (BL-058 Phase 4, PR #177) with the placement record: `POST /legwise/rotation/placement`
  appends `{day, list, status: placed | changed | not_placed, note, time}` to
  `TRADING_DATA_ROOT/rotation/placements.jsonl`. A separate file; the hash-chained journal is never edited.
- Stored results with `gross` and `net`, whose `costs` column is zero: net equals gross today.
- BL-063's charge arithmetic (brokerage ₹13 a lot plus STT, exchange, SEBI, stamp and GST) as research output,
  not applied in the nightly update.
- The contract-notes pipeline (`packages/contract-notes`), whose cutover from the `trade-analytics` repo is
  not finished (TODO §2.1–2.6); `trade-analytics` still owns the live cron.

## Goal

For every day the owner placed a basket, the dashboard shows what the journal says it earned after charges,
what the contract notes say it earned, and where the difference went: days not placed, changes the owner made,
execution and slippage. Each step is its own figure, so a gap cannot hide inside "other".

## Out of scope

- Any change to the journal, a list, a weight, the base or the 298 universe.
- Changing what "net" means in stored results other than by the registered change in Phase 1.
- Pulling contract notes from a broker directly; the contract-notes sheet is the only source.
- Paper-trading execution or placing orders from the repo.

## Plan

### Phase 1 — Charge model in the nightly update (its own registered change)
- **Tasks:** apply BL-063's model to each variant-day's trades in `rotation update` so the `costs` column
  carries it and `net` becomes net after charges. Pre-register the model and its constants in this item before
  the first run; keep `gross` unchanged. Re-score the stored history once and compare with BL-063's totals.
- **Deliverables:** the change, its tests, a Log line with the before/after totals per period.
- **Done when:** the stored `net` for BL-063's window equals BL-063's after-charges totals to the rupee, and
  `obt rotation verify` and every ranking input digest are unchanged (the ranking reads `gross`/`net` as it
  does today; confirm which one before the change and record it).
- **Caution:** `net` feeds the ranking's recent-score criterion (`score.recent_score` reads the NET history).
  Making `net` differ from `gross` would change picks. Decide before coding: add a separate `net_after_charges`
  column, or version the change at a date boundary with the owner's approval. This is the reason it needs its
  own registered change.

### Phase 2 — Reconcile endpoint and waterfall (can start before the cutover on a synthetic "real" series)
- **Tasks:** `rotation/reconcile.py` (pure functions); `GET /legwise/rotation/reconcile?list&from&to`; Fastify
  proxy; a card on the Rotation page: readiness strip (placement record, charge model, contract notes through
  day D), waterfall paper gross → charges → days not placed → changes the owner made → execution and slippage
  → real, a day table, and a Real column in the Daily log.
- **States:** not placed (paper only, counted in the "days not placed" bar); contract note not yet in (real
  pending, never zero); another trade on the same account that day (excluded by contract; a rotation contract
  that cannot be told apart marks the day "mixed" and leaves it out of the gap); a changed basket is compared
  as placed using the placement note.
- **Done when:** for every placed day real equals the contract-notes figure for those contracts, paper net
  equals the stored result after charges, and the waterfall's bars sum to the difference.

### Phase 3 — Real data
- **Tasks:** after the cutover, read the contract-notes sheet filtered to the rotation's contracts by day;
  replace the synthetic series; add the Guide page.
- **Done when:** a week of real placed days reconciles with the broker statements.

## Risks

- The rotation shares a broker account with other trades, so contract notes cannot be separated by contract.
  Mitigation: one account used only for the rotation (recommended), otherwise "mixed" days are left out.
- Phase 1 changes `net` and therefore potentially the ranking; see the caution above.
- The owner places baskets with changes the note does not describe; the "changes" bar is then wrong.
  Mitigation: the placement note is required when status is `changed`.

## Open questions

- Which broker account(s) carry the rotation trades, and does anything else trade there? (Recommended: one
  account used only for the rotation.)
- Phase 1: a separate column or a dated boundary for the charge model?
- Is slippage measured against the 09:17 / entry-minute close the engine fills at, or against the stored
  trigger-level fill? Decide when Phase 2 starts.

## Log

- 2026-10-11 — created from BL-058 Phase 4 widget 10 (design in the Rotation Workspace Plan page, widget 10).
  Blocked on the three inputs above; Phase 2 can be built on a synthetic series when the owner wants it.

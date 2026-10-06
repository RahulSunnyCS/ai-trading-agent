# BL-024 — Forward-signal journal: record every weekly signal from now on

| | |
|---|---|
| **Priority** | P0 — time-critical: every Friday not recorded is out-of-sample evidence lost for good, and real money is planned |
| **Status** | In progress (Phase 1) |
| **Type** | feature |
| **Area** | momentum (+ trading-data) |
| **Created** | 2026-10-06 |
| **Depends on** | none; BL-010 Phase 6 uses it; BL-030 picks the configs that matter most |
| **TODO.md row** | 3.15 |

## Context

Every Momentum number so far is a backtest, and BL-010 shows how far a backtest can flatter. The
only evidence nothing can flatter is a signal recorded *before* the week it trades, then compared
with what happened. BL-010 Phase 6 plans 6–12 months of paper tracking, but only after Phases
3–5, which are weeks away. Weeks that pass before tracking starts cannot be recorded afterwards.

Real money is not in yet (owner, 2026-10-06): it comes once the main BL-010 work is done, and only
the owner will trade it. The tool is being shared with friends this month.

**What existed before this item.** `mbt weekly` already saved each signal to `momentum_signals`,
but by delete-then-insert on (week, run, config): a rerun overwrote the earlier record. That is a
cache of the latest signal, not evidence, so the journal is a separate table.

**How the Friday runs reach each favourite (found 2026-10-06).** The 14:40 preview evaluates only
ETF favourites; Stock, Custom Index and Broad favourites are blocked in the preview and in the
16:45 final, because their bhavcopy data lands later. They are evaluated only by the 19:30
`momentum-weekly-stock-ingest` job (`mbt stocks sync` then `mbt weekly --run final
--only-dataset …`). On 2026-10-06 that LaunchAgent was in the repo but **not installed** on the
laptop, so 11 of the 12 favourites produced no Friday signal at all.

## Goal

From Friday 2026-10-09 on, every weekly signal of every favourite is stored unchangeably with its
timestamp, and a page and a weekly Telegram line compare it with the realised result and with the
benchmark.

## Out of scope

- Choosing which configs to trade (BL-010, then BL-030).
- Broker integration or order placement.
- Backfilling weeks before 2026-10-09: a reconstructed week is not forward evidence.

## Decisions (owner, 2026-10-06)

1. **Which configs:** every saved favourite, whatever is a favourite that Friday (12 on
   2026-10-06: ETF Weekly Core, Stock Weekly Core and 10 Broad candidates), plus the Nifty200
   Momentum 30 TRI as a **benchmark level**, not as a set of holdings. The owner will narrow the
   favourites to about 8 once BL-010 gives the context; that choice is **BL-030**. Removing a
   favourite stops its new rows; its history stays. The "BL-010 median config" moved to BL-030.
2. **Which run:** the owner trades at **Friday's close**. The final run (16:45, and 19:30 for
   Stock/Broad) comes after the 15:30 close, so it cannot be traded at that close; the 14:40
   preview can. Recommendation accepted: journal the **preview where one exists** (today only ETF
   favourites have one) and **the final for every favourite**. Phase 2 scores the preview from
   Friday's close, and the final from Friday's close as an *ideal fill* and from Monday's open as
   the *achievable fill*, labelled as such.
3. **Off weeks:** a favourite that rebalances every 2 or 4 weeks still gets a row every week
   (holding, no change), so every week can be scored without gaps.
4. **Tamper evidence:** DuckDB has no triggers, so the database cannot refuse an edit. Instead:
   the code only ever inserts; every row carries the hash of the row before it (a hash chain), so
   an edit or a deleted row is detectable (`mbt journal verify`); and the chain head goes out in
   the Friday Telegram message, so Telegram's timestamp is an outside witness of what was recorded
   and when.
5. **Start:** clean on Friday 2026-10-09; no backfill of 2026-10-02.
6. **Real fills (Phase 3):** waits until real money is in.

## Plan

### Phase 1 — Record (before Friday 2026-10-09)
- **Tasks:**
  - Migration `007_momentum_forward_journal.sql` in `packages/trading-data`: append-only table.
    Per row: entry ID, recorded-at, signal week, run (preview/final), source (favourite /
    benchmark), config ID and name, dataset, settings and settings hash, code commit (with a
    dirty-tree flag), data fingerprint, holdings before the signal's actions, the signal's rows
    as produced (its BUY/SELL/HOLD actions), the entry it supersedes, previous-row hash and its
    own hash.
  - `forward_journal.py` in `packages/momentum-backtesting`: `record` (skips a rerun that produced
    the identical signal; a changed one is a new row that supersedes the old), `verify`, `head`.
  - `_execute_weekly_run` journals every evaluated favourite (preview only on a Friday) and the
    benchmark level once its data covers the week; the chain head goes into the Telegram message.
    A journal failure is reported to Telegram, never silent, and never blocks the signal.
  - Broad / Stock / Custom Index signals carry their holdings as weights (from the backtest's
    open positions), like ETF signals already do.
  - `mbt journal show` and `mbt journal verify`.
  - Owner: install the 19:30 `momentum-weekly-stock-ingest` LaunchAgent, or the 11 non-ETF
    favourites are never journalled.
- **Deliverables:** migration, writer, CLI, tests (append-only, rerun idempotence, tamper
  detection for an edited and a deleted row).
- **Done when:** Friday 2026-10-09's runs write one row per favourite (preview for ETF, final for
  all 12) plus the benchmark, and `mbt journal verify` passes.

### Phase 1b — Check and Journal page (added 2026-10-06, owner request)
- **Tasks:** `mbt journal check [--send]` (expected vs recorded for the week, wrong-week labels,
  chain, uncommitted-code warning) on a Friday 21:00 LaunchAgent that sends one Telegram
  summary; a **Momentum › Journal** dashboard page showing the same check, the chain fingerprint
  and every entry by week (`GET /api/journal`).
- **Done when:** Friday 2026-10-09's 21:00 summary arrives and the page shows that week.

### Phase 2 — Score
- **Tasks:** each week, take the portfolio each journalled signal led to from the *next* week's
  row (its `holdings_before`), after checking that every recorded BUY appears there and every
  recorded SELL is gone (a mismatch is flagged, not scored); compute its realised return with the
  same cost and tax model as the backtest, at the fills in Decision 2; compare with what the backtest says for
  the same weeks. Score the **latest** row recorded before the fill (a Friday-morning dashboard
  preview is a what-if; the 14:40 run that supersedes it is what gets traded at the close); rows
  recorded after the fill are shown as corrections, never scored in its place.
- **Deliverables:** weekly scoring job (BL-012), a Momentum "Forward" page, one Telegram line.
- **Done when:** four weeks are scored and the live-vs-backtest gap is shown per config.

### Phase 3 — Real fills (when money is in)
- **Tasks:** let the owner record actual fills (manual entry or broker CSV) next to the journal,
  so slippage and missed trades are measured, not assumed.
- **Done when:** one real rebalance is reconciled.

## Risks

- **The recorded signal is the action list, not the post-trade weights.** The engine never
  trades its newest week (`trade_weeks` excludes it), so at signal time the backtest only knows
  the holdings *before* this week's BUY/SELLs. Found in the 2026-10-06 dry run: every Broad
  candidate with trades had its BUYs missing from, and its SELLs still in, the weights. The
  journal stores both honestly (`holdings_before` + actions); the post-trade weights come from
  next week's row, checked against the recorded actions. Making the engine also report the
  post-trade weights at signal time would remove that one-week dependency, but changes the
  golden-tested engine, so it was not done before the first Friday.
- The Stock Weekly Core signal was labelled 2026-09-25 in the 2026-10-06 dry run, a week behind
  the Broad ones (2026-10-02), on the same data. Check on Friday which week its signal is for.

- A journal that can be edited is worthless as evidence. The hash chain makes an edit visible but
  cannot prevent it, and deleting the newest rows is only caught against the Telegram witness.
- The 19:30 job not running means no Stock/Broad rows; its absence must be noticed, not assumed.
- The data fingerprint for Stock/Broad hashes the shared stock dataset, not every derived input
  (e.g. category tags); a tag edit between runs is not visible in the fingerprint.

## Open questions

None for Phase 1.

## Log

- 2026-10-06 — created in the overnight review; not discussed with the owner yet.
- 2026-10-06 — owner decisions on PR #27: approved in full; status Ready. Phase 1 is due before Friday 2026-10-09.
- 2026-10-06 — started. Owner answered the start questions (see Decisions); config choice split
  out as BL-030. Found that non-ETF favourites have no preview and that the 19:30 job was not
  installed. Status In progress, TODO.md 3.15.
- 2026-10-06 — code review before merge (BL-014): journalled signals now keep only acting,
  held and top-30 rows (a Broad signal was ~144 KB); Phase 2's rule changed from the earliest to
  the latest row before the fill; the check skips the preview on a Friday holiday and reports
  its own failure to Telegram.
- 2026-10-06 — Phase 1b added at the owner's request: the after-Friday check job and the
  Momentum › Journal page, so the owner does not have to run the CLI checks by hand.
- 2026-10-06 — Phase 1 code done: migration 007, `forward_journal.py`, wiring in
  `_execute_weekly_run`, `mbt journal show|verify`, 14 tests. Dry run on a copy of the real
  catalog recorded all 12 favourites, a rerun recorded nothing, verify passed. Awaiting the
  first Friday (2026-10-09) to close Phase 1.

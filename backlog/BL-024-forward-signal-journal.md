# BL-024 — Forward-signal journal: record every weekly signal from now on

| | |
|---|---|
| **Priority** | P0 — time-critical: every Friday not recorded is out-of-sample evidence lost for good, and real money is planned |
| **Status** | Done (2026-10-28) |
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
6. **Real fills (Phase 3):** waits until real money is in. Superseded 2026-10-28 (owner): "Phase 2 +
   3 from Kite" — the Momentum money has been on Zerodha Kite since 2026-10-19 (BL-142), so the
   fills come from the Kite contract notes and the lot ledger, with no manual entry.

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
- **Status: done** (confirmed 2026-10-28; see the Log).

### Phase 1b — Check and Journal page (added 2026-10-06, owner request)
- **Tasks:** `mbt journal check [--send]` (expected vs recorded for the week, wrong-week labels,
  chain, uncommitted-code warning) on a Friday 21:00 LaunchAgent that sends one Telegram
  summary; a **Momentum › Journal** dashboard page showing the same check, the chain fingerprint
  and every entry by week (`GET /api/journal`).
- **Done when:** Friday 2026-10-09's 21:00 summary arrives and the page shows that week.
- **Status: done** (the 21:00 check ran on 9, 16 and 23 Oct).

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
- **Status: built 2026-10-28**: `forward_score.py` + `forward_run.py`, `mbt journal score`, scheduler
  `momentum-journal-score` (Fri 20:30), the Forward score card on Momentum › Journal (a section
  there rather than a page of its own: it reads with the week's entries), and one line in the
  headline's 19:30 message. One week (16 Oct) scored at close; the four-week check lands on the
  scheduler by itself (weeks of 16, 23, 30 Oct and 6 Nov, scored by Fri 13 Nov).

### Phase 3 — Real fills (when money is in)
- **Tasks:** let the owner record actual fills (manual entry or broker CSV) next to the journal,
  so slippage and missed trades are measured, not assumed.
- **Done when:** one real rebalance is reconciled.
- **Status: done 2026-10-28** from the Kite contract notes, the lot ledger and the 14:15 orders
  (`forward_fills.py`; no manual entry): Lot 1 (16 Oct) and Lot 2 (23 Oct) reconciled.

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
- 2026-10-28 — Phases 1 / 1b closed, checked read-only on a copy of the live catalog. **9 Oct**
  was recorded (14 Broad finals at 19:30, the benchmark level on 11 Oct; the 21:00 check said 14
  of 15, the benchmark missing at the time), but the live chain was **reset on 12 Oct**: its 29
  rows (2 Oct dry-run rows 1-14, 9 Oct rows 15-29) are kept in
  `TRADING_DATA_ROOT/backups/momentum_forward_journal-2026-10-12-before-reset.parquet`, and no
  Log, commit or memory records why. The live chain starts at entry 1 on **16 Oct** (43 of 43:
  42 favourites incl. 38 BL-087 sleeves, plus the benchmark) and **23 Oct** (43 of 43, recorded
  Sat 24 Oct 10:31 after the Friday runs met an unmounted volume); `mbt journal verify` passes on
  86 entries, head `017129dfd58f3eb8`. The 9 Oct rows are not scored: they belong to the old
  chain (different config ids after the BL-087 split), and joining chains would weaken the tamper
  evidence.
- 2026-10-28 — owner: "Phase 2 + 3 from Kite". Research gate: this is forward measurement of
  signals recorded before their week, not a new search or backtest comparison, so no
  pre-registration applies; nothing is selected or tuned on these scores.
- 2026-10-28 — **Phase 2 built.** `forward_score.py` (pure), `forward_run.py` (wiring),
  `mbt journal score`, scheduler `momentum-journal-score` Fri 20:30, the Forward score card on
  Momentum › Journal (`GET /api/journal/forward`), one line in the headline's 19:30 message (no
  new message, BL-173). Choices: the start portfolio is the signal's `target_weights` (the
  engine's own post-trade portfolio, recorded since the Phase 6 parity work), checked against
  next week's `holdings_before` (BUY held, SELL gone); costs are the engine's `buy_cost` /
  `sell_cost` (pinned equal by a test) on the move from `holdings_before` drifted to W; pre-tax
  like the favourites. **F6 honesty:** the backtest is shown twice, *as recorded* (the
  `sleeve_value` of the two rows, i.e. the code that produced them; omitted when the rows sit on
  different sides of the F6 merge `778ba02e` or an April reset) and *today's code* (the same
  settings re-run now, point-in-time ranking). Only Broad is scored (the only journalled
  dataset); others would say `not_scored`. Full run on the live copy: 84 signal-weeks, the 42
  favourites' week of 16 Oct scored, 23 Oct waiting for 30 Oct's rows; 19 minutes.
  **Week of 16 Oct, headline group (Four Sectors Monthly, No Tilt · all Fridays):** live at
  Friday close -8.03%, backtest as recorded -7.99% (gap -0.04 pts), today's code -9.59%,
  Nifty200 Momentum 30 TRI -6.15%. Across the 11 groups live minus as recorded is 0.00 to
  -0.05 pts (the live figure pays the week's own costs, the recorded one the next week's), which
  is the check that the scoring reproduces the backtest; today's code differs by up to 2 pts
  (the F6 ranking). Review (#368) found the first version drifted `holdings_before` a second
  week, charging hold weeks about 0.04 pts of phantom costs; fixed before merge.
  The Monday-open figure for 16 Oct needs Mon 26 Oct's open, in the 30 Oct sync.
  **Done-when not met yet:** four scored weeks need 30 Oct, 6 Nov and 13 Nov's runs; the job
  scores them by itself (week of 6 Nov scored on Fri 13 Nov). Closed now on the owner's
  instruction; the check lands on the scheduler.
- 2026-10-28 — **Phase 3 built** (`forward_fills.py`): the Kite contract notes read as files,
  fills booked to lots FIFO against the lot ledger, then the pending plan; each lot's due week
  reconciled against its journal row and the 14:15 orders. Two rebalances reconciled:

  | Lot / week | Name | Signal | Orders | Done | Fill vs Fri close | vs Mon open | vs orders |
  |---|---|---|---|---|---|---|---|
  | Lot 1, 16 Oct (new, ₹50,000; bought Mon 19 Oct) | CUPID | BUY 25% | — | 28 @ 345.25, +12 on 22 Oct | -239 bps | -239 bps | — |
  | | NAZARA | BUY 25% | — | 24 @ 410.15, +9 on 22 Oct | -191 bps | -204 bps | — |
  | | RATEGAIN | BUY 25% | — | 12 @ 794.25, +4 on 21 Oct | -398 bps | -393 bps | — |
  | | Nasdaq 100 | BUY 25% | — | missed (premium gate) | | | |
  | | GRWRHITECH | not in signal | — | extra: 1 @ 6,998 ("replaces Nasdaq 100 (premium)") | +40 bps | +40 bps | — |
  | Lot 2, 23 Oct (new, ₹52,987; bought Fri 23 Oct 14:28) | ACMESOLAR | not in final | 35 @ 373.60 | 35 @ 373.00 | +31 bps | n/a | -16 bps |
  | | CUPID | BUY 29% | 42 @ 310.45 | 42 @ 309.60 | +103 bps | n/a | -27 bps |
  | | GRWRHITECH | BUY 24% | 1 @ 7,059 | 1 @ 7,065.50 | +45 bps | n/a | +9 bps |
  | | NAZARA | BUY 24% | 33 @ 400.70 | 33 @ 401.53 | -15 bps | n/a | +21 bps |
  | | THELEELA | BUY 24% | — | missed | | | |

  Charges: Lot 1 ₹54.13 on the notes vs ₹55.51 at the model's rates; Lot 2 ₹55.49 vs ₹55.19.
  Lot 1's first-day fills came in ₹796 under Friday's close (Monday fell); Lot 2's ₹23 under the
  orders' prices. Findings: (1) the 14:15 orders and the 19:30 final disagree for Lot 2
  (ACMESOLAR in the orders, THELEELA in the final), so the trade followed the orders, not the
  journalled final: the orders' week-ahead decision on 16 Oct's stored ranks and the final on the
  data the 19:30 sync rewrote differ; (2) Lot 1 was under-funded on the day (₹36,039 of
  strategy names plus 20MICRONS, sold 21 Oct, outside the lots) and topped up 21-22 Oct; (3) a
  second GRWRHITECH (14:33, ₹7,119.50) is booked to no lot yet; Lot 2's shares are matched
  through the 14:15 plan until the 30 Oct run books them.
- 2026-10-28 — **Done.** Follow-ups for the owner, not new items: the live-rules trailing rule
  and the money gate (BL-025) do not read the score or the fills yet; the 14:15-orders-vs-final
  disagreement deserves a look before more lots go in.

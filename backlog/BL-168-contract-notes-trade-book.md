# BL-168 — Contract notes in the repo: laptop job, data store, Trade book page

| | |
|---|---|
| **Priority** | P1 — the only record of real money the project measures itself against; unblocks BL-093 and BL-026 |
| **Status** | Planned |
| **Type** | feature |
| **Area** | contract-notes / scheduler / trading-data / dashboard |
| **Created** | 2026-10-26 |
| **Depends on** | BL-012 (the scheduler, installed); the `trade-analytics` secrets copied into the repo-root `.env` (owner) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner's realised F&O P&L lives in the Google Sheet "Trade Book 2025-26 FY" (one row per
trading day from 1 Apr 2025: the Finvasia and Angel One blocks, plus two hand-entered columns —
`Algos` and `Capital` — and formula columns: `algo charges` (`ROUNDUP((Algos-3)*12.5+62.5)` in
the committed copy), `Charges`, `Profit`, `Overall`, `DD`, 50/100-day averages, charge/profit
ratio, bps on capital; a second tab with monthly and FY returns). The sheet is filled nightly by the `trade-analytics` repo's GitHub Actions cron
(Gmail → PDF → parse → sheet). `packages/contract-notes` is the same pipeline merged here on
2026-09-19, never cut over: TODO §2.1–2.6 planned to move the *Actions* cron, re-seed the
`row-tracker` artifact and keep the sheet as the only store.

That plan predates the scheduler (BL-012). Today every other daily job runs on the laptop from
`apps/scheduler`, the research data lives under `TRADING_DATA_ROOT`, and two items wait on the
contract notes being in the repo: BL-093 (paper vs real for the rotation) and BL-026 (realised
vs backtest). Both need more than the five figures the sheet holds — they need the trades.

The sheet's five columns per account come from the note's *obligation table* (F&O rows only).
The parser already has the whole decrypted PDF in hand and throws the rest away: the itemised
charges (STT, exchange transaction, SEBI, stamp duty, GST, clearing, IPF), the trade rows
(contract, buy/sell, quantity, price, time), the note number and settlement, the cash-segment
rows it drops.

## Goal

- The daily pipeline runs as a scheduler job on the laptop, writes the day's figures to a store
  under `TRADING_DATA_ROOT` first, and mirrors them to the Google Sheet as today. The
  `trade-analytics` cron and the two Actions workflows here are retired; no `row_tracker.json`.
- The store holds, per broker account and day: the sheet's five figures, every charge itemised,
  every trade row, the note's identifiers, and the PDF itself. History from 1 Apr 2025 is in it
  (the sheet's rows at least; the trades wherever the e-mail still exists).
- The dashboard has a **Trade book** page with what the sheet shows today (cumulative net,
  drawdown, monthly and FY returns, charges, per-account split, the day table) and what it
  cannot (charges by kind, net per contract, missing-note days).
- The store is in the monthly backup, and the sheet remains a second copy for as long as the
  owner wants it.

## Out of scope

- Any order, square-off or broker API login: the e-mail is the only source.
- The paper-vs-real reconciliation itself (BL-093) and realised-vs-backtest (BL-026): this item
  gives them their data.
- Changing what the Google Sheet's hand-entered and formula columns compute.
- Hiding the page from the friends: the owner chose visible to all (2026-10-26); revisit if a
  second person starts using the hosted dashboard for it.

## Design

**Store — `TRADING_DATA_ROOT/contract-notes/`** (the BL-141 `rotation/live/` pattern: the Node
pipeline writes files, Python reads them with DuckDB; no catalog migration until something needs
a join the files cannot give):

- `raw/<broker>/<account>/<day>.pdf` — the note as received (encrypted) and
  `<day>.decrypted.pdf`. Provenance and a re-parse source when an extractor improves.
- `days/<day>.jsonl` — one line per account-day:
  `{day, broker, account, status: 'note' | 'no_trade', note_no, settlement_no, settlement_date,
  source: 'email' | 'sheet', pdf_sha256, segments: [{label, kind: 'fno' | 'cash' | …,
  obligation, brokerage, charges: {stt, transaction, sebi, stamp, gst, clearing, ipf}, net}],
  fno: {payin_payout_obligation, net_brokerage, other_charges, total_charges, final_net},
  trades: [{order_no, trade_no, time, exchange, segment, symbol, underlying, expiry, strike,
  kind: 'CE' | 'PE' | 'FUT' | 'EQ', side, qty, price, brokerage}], account_charges: [...],
  cross_checks: {note_total_net, matched: true}, sheet: {written_at, row} | null}`.
  The `fno` block is exactly what the sheet gets, so the two never disagree.
- `manual/<day>.json` — the hand-entered inputs the sheet carries today (`algos`, `capital`),
  written by the page (BL-140-style POST) or imported from the sheet; `algo_charges` is the
  sheet's formula, computed, not typed.
- **What "done" means.** A day is closed for an account when its note is stored (`note`), or
  as `no_trade` when a later session's note for that account has arrived and this day's has
  not (the broker issues a note only for a day with trades — Kite will be `no_trade` on most
  days), or when the owner marks it so. Until then it is **open** and every run re-scans it,
  for up to 10 trading days back; an open day older than that alerts. Done is read from
  `days/`, not from a sheet read or an artifact; the sheet mirror has its own marker (below).

**Job — `contract-notes`** in `apps/scheduler/src/jobs.ts`: **every day** 00:00 (`everyDay`,
not `tradingDays`: a session's notes arrive its evening, so the run after midnight takes it and
Saturday's run takes Friday) with `contract-notes-retry` at 07:30 for the days still open
(owner, 2026-10-26), `catchUpHours: 24`, one `group`, retries 1. Steps (argv, in
`packages/contract-notes`): for every open trading day (above) — `fetch` → `parse` → `store`,
then `sheet` for every stored day whose `sheet` marker is null. A note not in the mailbox yet
leaves the day open; a parse failure alerts with the `fixHint` and leaves it open, as the
Actions loop did. The sheet step finds the next row by reading column C (the dates; the
`row_tracker.json` shortcut is gone), refuses to write a date that is already there, and sets
the marker only after the write succeeds, so a failed sheet write is retried next run and never
duplicated. Needs `qpdf` from Homebrew (installed: 12.4.1) and Node 20: the runner's `jobPath`
already puts fnm's Node first (`env.ts`), so the shell's nvm v16 default is not what jobs see
(the package stays Node/CommonJS; TODO §2.9 is unchanged). Secrets (`BROKER_ACCOUNTS_JSON`,
`GOOGLE_CREDENTIALS`, `GOOGLE_SHEET_ID`, `SHEET_GID`, `SHEET_NAME`) go into the repo-root
`.env` — the keys are there, empty, as of 2026-10-26. The package does not import
`@trading/notify`; the scheduler's alert path does, so `alerts.ts` registers the Gmail and PDF
passwords from `BROKER_ACCOUNTS_JSON` with `registerSecret` before any failure alert can quote
a log line.

**Brokers.** Finvasia and Angel One as today, plus a `kite` plugin for Zerodha (owner,
2026-10-26): its note is read daily, and every transaction in it is booked to Momentum, since
that account trades nothing else. Angel One also debits outside the contract note — a daily
interest of about ₹80 on the non-cash part of the margin — which arrives as its own e-mail;
that e-mail is a second source (`fetch` by its subject, a small extractor), recorded as
`account_charges: [{kind: 'margin_interest', amount}]` on the day, so the day's net is the
account's net and not only the note's.

**API and page.** `obt-api` serves `GET /legwise/contract-notes/summary|days|months|day/{day}`
from the JSONL (DuckDB `read_json`, read-only, no catalog), proxied at
`/api/backtest/legwise/contract-notes/*` like the rotation routes (under `/legwise/` because
the dashboard's direct rewrite covers `/legwise/:path*` and nothing else). The dashboard gets a top-level **Trade book** page on the analytics
page pattern: headline strip (FY net, month net, last day, charge/profit ratio, max drawdown,
capital and bps), hero chart (cumulative net with drawdown shading), widgets: monthly table (the
second tab), per-account blocks, charges by kind, the day table, days with no note, and the
manual-input editor. Guide page in the same change.

**Backup.** `tdata backup` copies `lake/`, `raw/` and the catalog; add `contract-notes/` (and
`rotation/`, which the same gap leaves out today). Its skip rule is "same size at the
destination", right for immutable lake files and wrong for these: `days/` lines are rewritten
when a sheet day is upgraded to e-mail, `manual/` when edited, `rotation/` nightly. The new
folders compare size **and** mtime. The sheet mirror is the off-laptop copy.

## Additional data to collect (the answer to "what else")

From the note, already parsed text, currently discarded:

1. **Trade rows** — every fill with contract, side, quantity, price, time and per-trade
   brokerage. This is what lets BL-093 pick the rotation's contracts out of the account and
   compare each leg's fill with the paper fill; also AlgoTest's own charge per order check.
2. **Charges itemised** per segment — STT, exchange transaction, SEBI, stamp, GST, clearing,
   IPF — today folded into `other_charges`. Validates BL-063's charge model per kind rather than
   in total.
3. **Cash / other segment rows** — kept and labelled instead of dropped, so an equity trade on
   the same account is visible, not silently absent.
4. **Note identifiers** — contract-note number, settlement number and date, the account id as
   printed, the broker's own total net (the cross-check the parser already computes but only
   logs).
5. **The PDF** — original and decrypted, by hash, so an extractor fix can re-run history
   without Gmail.
6. **Days with no note** — recorded as such (holiday, no trade, or note missing) rather than
   left as an empty row.

Not in the note, worth attaching:

7. **The hand-entered sheet inputs** — `algos` (deploys that day) and `capital` — as a dated
   manual record; `algo_charges` is derived from `algos` by the sheet's formula. `algos` can
   later be pre-filled from the day's live capture (BL-141's `rotation/live/<day>.jsonl` lists
   every strategy that ran on each platform).
8. **Funds / margin at close** (optional, later) — `obt angel funds` already reads Angel One's
   free margin; a daily close reading gives the capital line a source other than a typed number.
9. **Debits outside the note** — Angel One's daily interest on the non-cash margin component
   (~₹80 a day, its own e-mail); any other ledger debit the brokers mail about (DP charges, AMC)
   once seen. Without these the month's net overstates the account.
10. **Zerodha Kite's notes** — every transaction booked to Momentum (the account trades nothing
   else), giving Momentum's realised buys and sells beside its paper journal.

## Plan

### Phase 1 — Store and the laptop job (replaces TODO §2.1–2.6)
- **Tasks:** `store.js` writing `days/<day>.jsonl` and the PDFs; open-day scanning and the
  `no_trade` rule from the store; `sheet` reads the stored `fno` block, finds the row from
  column C and sets the marker; the two scheduler jobs with their `fixHint`; `qpdf` checked at
  start; secrets into `.env` (and `.env.example` with placeholders) and the scheduler's secret
  registry; remove `contract-notes-daily.yml`, `contract-notes-row-tracker.yml` and
  `row_tracker.json` from this repo; stop the `trade-analytics` cron (owner merges its waiting
  branch) the same day the job is installed. TODO §2.1–2.6 are replaced by this phase; §2.7
  (archive the old repos) stays and follows Phase 1; §2.8's typed hand-off is the `days/` line.
- **Deliverables:** the jobs, their tests (Jest for the package, Vitest for the scheduler
  entries), `technical.md` and TODO §2 rewritten, the package `CLAUDE.md` and the runbook
  rewritten with the new rollback (Risks).
- **Done when:** one real overnight run writes a day to the store and the same five figures to
  the sheet's next row, nothing overwritten; a second run on the same day writes nothing; a
  laptop asleep at 00:00 and 07:30 catches up on wake; a sheet write made to fail once is
  retried and written once.

### Phase 2 — Richer extraction and history
- **Tasks:** both extractors emit the itemised charges, segment rows, trade rows and note
  identifiers (the obligation cross-check stays a hard error); the Angel One margin-interest
  e-mail and the `kite` plugin (a sample of each from the owner first); the one-time import of
  the sheet's rows since 1 Apr 2025 as `source: 'sheet'` (five figures and the manual inputs);
  a Gmail backfill by date range (`--from --to`) that re-parses the notes still in the mailbox
  and upgrades a `sheet` day to `email`. The owner wants the record recomputed from the notes
  (2026-10-26), so the e-mail figures win: an `email` line replaces the `sheet` line, and every
  difference from the sheet's five figures is listed in the backfill report, where each one
  must be explained (an extractor fix, a sheet edit made by hand, a note the sheet row missed)
  before the phase is called done. The sheet itself is not rewritten by the backfill.
- **Deliverables:** extractor tests on the sample PDFs and the fixtures; `contract-notes
  backfill`; `contract-notes retention` (a read-only IMAP look: oldest and newest note per
  account, the brokers' other e-mail subjects), run first once the `.env` has the credentials.
- **Done when:** every day since 1 Apr 2025 is in the store; every `email` day's trades sum to
  its obligation within the note's tolerance; every `email` day's five figures equal the sheet
  row's or the difference is listed and explained in the report.

### Phase 3 — Trade book page
- **Tasks:** the `obt-api` routes and Fastify proxy; the page (headline strip, hero, widgets
  above), the manual-input editor, the Guide page and `registry.ts` entry; visible to everyone
  on the dashboard (owner, 2026-10-26).
- **Deliverables:** the page behind the dashboard login; `formatInr`/`formatPct` only;
  tokens, no hex.
- **Done when:** the page's FY, monthly and drawdown figures equal the sheet's for the same
  days, and a day with no note shows as such.

### Phase 4 — Backup and the sheet's future
- **Tasks:** `tdata backup` copies `contract-notes/` and `rotation/`; the monthly job's report
  counts them; decide with the owner whether the sheet mirror stays, becomes read-only, or is
  retired once the page has done a month's work. BL-093 and BL-026 are unblocked at Phase 2.
- **Done when:** a backup run copies the new folders, and the decision is in the Log.

## Risks

- **Two writers on the sheet** while the `trade-analytics` cron still runs: the job must not be
  installed until that cron is off (Phase 1's last step, same day). **Rollback** is no longer
  the runbook's as written (that one relies on this repo's row-tracker workflow, which Phase 1
  deletes, and `trade-analytics`'s own tracker would lag the rows the laptop wrote, so a
  re-enabled cron would duplicate them): uninstall the two jobs, run `trade-analytics`'s
  **Update Last Updated Row** workflow with the last row the laptop wrote, then re-enable its
  cron. The runbook gets this text in Phase 1.
- **The laptop is asleep at 00:00 or 07:30** — the catch-up covers it; a note that has not
  arrived leaves the day open, never recorded as zeros; `no_trade` is set only by the rule
  above.
- **A new segment label or PDF layout** fails the day (by design); the alert names the file so
  the extractor can be fixed and the day re-run from `raw/`.
- **Gmail retention** — the history backfill may stop short of 1 Apr 2025; the sheet import
  covers the five figures regardless.
- **Secrets on the laptop** — Gmail app passwords and PDF passwords join the `.env` that already
  holds broker TOTP seeds; nothing new in kind, but the notify registry must cover them.

## Open questions

1. The sheet's hand-typed columns `Algos` (N) and `Capital` (X): what `Algos` counts (the
   day's AlgoTest deploys?), whether the `algo charges` formula (`(Algos-3)*12.5+62.5`, rounded
   up) is still the platform's fee, and whether they should be typed on the page or pre-filled
   (`Algos` from the live capture, `Capital` from a dated setting).
2. The Angel One margin-interest e-mail: its subject line and one sample, and whether other
   debits arrive the same way (DP charges, AMC).
3. A Zerodha Kite contract-note sample (subject and PDF password in `BROKER_ACCOUNTS_JSON`,
   not in chat).
4. `sheetStartColumn` in `BROKER_ACCOUNTS_JSON` still matches the live tab (Finvasia at I,
   Angel One at D), **and the column order within each block**: the committed xlsx labels
   Finvasia's L and M "Final Net" then "Total Charge", the reverse of `updateSheet.js`'s
   order. Checked against the live tab at the first run, before the sheet is written.

Answered 2026-10-26 (owner): the sheet stays as the mirror; the Trade book is visible to
everyone on the dashboard (only the owner uses it today); Kite's notes are read too, every
transaction booked to Momentum; the job runs at 00:00 with a 07:30 retry; two dedicated
mailboxes carry the broker e-mails; nobody else reads the sheet; `trade-analytics`'s cron is
still running; if Gmail still holds the notes, recompute the whole record from them.

## Log

- 2026-10-26 — created from the owner's note: move the trade-analytics sheet job into the
  repo, store the data, show it on its own page, run it from the scheduler, back it up.
  Replaces the Actions-based cutover in TODO §2.1–2.6 once started.
- 2026-10-26 — owner's answers recorded above; the Angel One margin-interest e-mail and the
  Kite plugin added to the design. Checked on the laptop: `qpdf` 12.4.1 at
  `/opt/homebrew/bin`; the scheduler's job PATH puts fnm's Node 20 first; the five `.env` keys
  exist but are empty, so Gmail retention could not be read yet (the retention look becomes a
  package command in Phase 2). Decision on the UI: Phases 1–2 first; the page is built once the
  store's figures are final (after the charges and the backfill), so it is written once.
- 2026-10-26 — review of PR #333: every day instead of trading days for the job; open days
  re-scanned and the `no_trade` rule; the sheet marker and column-C row lookup; the backup's
  size-only skip; e-mail figures win over the sheet in the backfill; `algo charges` is a
  formula; the rollback rewritten; BL-093 and BL-026 now depend on this item.

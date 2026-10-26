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
trading day from 1 Apr 2025: the Finvasia and Angel One blocks, plus hand-entered columns —
`Algos`, `algo charges`, `Capital` — and formula columns: `Charges`, `Profit`, `Overall`, `DD`,
50/100-day averages, charge/profit ratio, bps on capital; a second tab with monthly and FY
returns). The sheet is filled nightly by the `trade-analytics` repo's GitHub Actions cron
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
  `{day, broker, account, note_no, settlement_no, settlement_date, source: 'email' | 'sheet',
  pdf_sha256, segments: [{label, kind: 'fno' | 'cash' | …, obligation, brokerage, charges:
  {stt, transaction, sebi, stamp, gst, clearing, ipf}, net}], fno: {payin_payout_obligation,
  net_brokerage, other_charges, total_charges, final_net}, trades: [{order_no, trade_no, time,
  exchange, segment, symbol, underlying, expiry, strike, kind: 'CE' | 'PE' | 'FUT' | 'EQ',
  side, qty, price, brokerage}], cross_checks: {note_total_net, matched: true}}`.
  The `fno` block is exactly what the sheet gets, so the two never disagree.
- `manual/<day>.json` — the hand-entered inputs the sheet carries today (`algos`,
  `algo_charges`, `capital`), written by the page (BL-140-style POST) or imported from the sheet.
- Which days are done comes from `days/`, not from a sheet read or an artifact.

**Job — `contract-notes`** in `apps/scheduler/src/jobs.ts`: trading days 00:00 (the notes for
day D arrive the evening of D) with `contract-notes-retry` at 07:30 for the days still open
(owner, 2026-10-26), `catchUpHours: 24`, one `group`, retries 1. Steps (argv, in
`packages/contract-notes`): for every trading day from the day after the newest stored one up
to the last session — `fetch` → `parse` → `store` → `sheet`. A day whose note is not in the
mailbox yet stays open and is retried next run; a parse failure alerts with the `fixHint` and
leaves the day open, as the Actions loop did. Needs `qpdf` from Homebrew (installed: 12.4.1)
and Node 20 on the runner's PATH — the laptop's default `node` is nvm's v16; v20.18.0 is
installed under nvm and `node@20` under Homebrew, so the job's PATH must put one of those first
(the package stays Node/CommonJS; TODO §2.9 is unchanged). Secrets (`BROKER_ACCOUNTS_JSON`,
`GOOGLE_CREDENTIALS`, `GOOGLE_SHEET_ID`, `SHEET_GID`, `SHEET_NAME`) go into the repo-root
`.env` — the keys are there, empty, as of 2026-10-26 — and `@trading/notify` registers the
Gmail and PDF passwords as never-emit.

**Brokers.** Finvasia and Angel One as today, plus a `kite` plugin for Zerodha (owner,
2026-10-26): its note is read daily, and every transaction in it is booked to Momentum, since
that account trades nothing else. Angel One also debits outside the contract note — a daily
interest of about ₹80 on the non-cash part of the margin — which arrives as its own e-mail;
that e-mail is a second source (`fetch` by its subject, a small extractor), recorded as
`account_charges: [{kind: 'margin_interest', amount}]` on the day, so the day's net is the
account's net and not only the note's.

**API and page.** `obt-api` serves `GET /contract-notes/summary|days|months|day/{day}` from the
JSONL (DuckDB `read_json`, read-only, no catalog), proxied at `/api/backtest/contract-notes/*`
like the rotation routes. The dashboard gets a top-level **Trade book** page on the analytics
page pattern: headline strip (FY net, month net, last day, charge/profit ratio, max drawdown,
capital and bps), hero chart (cumulative net with drawdown shading), widgets: monthly table (the
second tab), per-account blocks, charges by kind, the day table, days with no note, and the
manual-input editor. Guide page in the same change.

**Backup.** `tdata backup` copies only `lake/` and `raw/`; add `contract-notes/` (and
`rotation/`, which the same gap leaves out today). The sheet mirror is the off-laptop copy.

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

7. **The hand-entered sheet inputs** — `algos` (deploys that day), `algo_charges`, `capital` —
   as a dated manual record. `algos` can later be pre-filled from the day's live capture
   (BL-141's `rotation/live/<day>.jsonl` lists every strategy that ran on each platform).
8. **Funds / margin at close** (optional, later) — `obt angel funds` already reads Angel One's
   free margin; a daily close reading gives the capital line a source other than a typed number.
9. **Debits outside the note** — Angel One's daily interest on the non-cash margin component
   (~₹80 a day, its own e-mail); any other ledger debit the brokers mail about (DP charges, AMC)
   once seen. Without these the month's net overstates the account.
10. **Zerodha Kite's notes** — every transaction booked to Momentum (the account trades nothing
   else), giving Momentum's realised buys and sells beside its paper journal.

## Plan

### Phase 1 — Store and the laptop job (replaces TODO §2.1–2.6)
- **Tasks:** `store.js` writing `days/<day>.jsonl` and the PDFs; gap detection from the store;
  `sheet` reads the stored `fno` block; the scheduler job with its `fixHint`; `qpdf` + Node 20
  on the runner's PATH checked at start; secrets into `.env` and the notify registry; remove
  `contract-notes-daily.yml`, `contract-notes-row-tracker.yml` and `row_tracker.json`; stop the
  `trade-analytics` cron (owner merges its waiting branch) the same day the job is installed.
- **Deliverables:** the job, its tests (Jest for the package, Vitest for the scheduler entry),
  `technical.md` and TODO §2 rewritten, the package `CLAUDE.md` and runbook updated.
- **Done when:** one real overnight run writes a day to the store and the same five figures to
  the sheet's next row, nothing overwritten; a second run on the same day writes nothing; a
  laptop asleep at 07:30 catches up on wake.

### Phase 2 — Richer extraction and history
- **Tasks:** both extractors emit the itemised charges, segment rows, trade rows and note
  identifiers (the obligation cross-check stays a hard error); the Angel One margin-interest
  e-mail and the `kite` plugin (a sample of each from the owner first); the one-time import of
  the sheet's rows since 1 Apr 2025 as `source: 'sheet'` (five figures and the manual inputs);
  a Gmail backfill by date range (`--from --to`) that re-parses the notes still in the mailbox
  and upgrades a `sheet` day to `email` without changing its five figures (a difference is
  reported, never written over). If Gmail holds the whole year, the owner wants the complete
  record recomputed from the notes; the sheet figures then become the cross-check.
- **Deliverables:** extractor tests on the sample PDFs and the fixtures; `contract-notes
  backfill`; a report of how far back Gmail still has the notes (first thing once the `.env`
  has the mailbox credentials: the read-only IMAP look is written, see the Log).
- **Done when:** every day since 1 Apr 2025 is in the store, the five figures match the sheet
  row for row, and each `email` day's trades sum to its obligation within the note's tolerance.

### Phase 3 — Trade book page
- **Tasks:** the `obt-api` routes and Fastify proxy; the page (headline strip, hero, widgets
  above), the manual-input editor, the Guide page and `registry.ts` entry; access (Open
  question 2).
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
  installed until that cron is off (Phase 1's last step, same day). Rollback is the runbook's.
- **The laptop is asleep at 07:30** — the catch-up covers it; a note that has not arrived is
  retried on the next run, never recorded as zeros.
- **A new segment label or PDF layout** fails the day (by design); the alert names the file so
  the extractor can be fixed and the day re-run from `raw/`.
- **Gmail retention** — the history backfill may stop short of 1 Apr 2025; the sheet import
  covers the five figures regardless.
- **Secrets on the laptop** — Gmail app passwords and PDF passwords join the `.env` that already
  holds broker TOTP seeds; nothing new in kind, but the notify registry must cover them.

## Open questions

1. The sheet's hand-typed columns `Algos` (N), `algo charges` (O) and `Capital` (X): what each
   is (the day's AlgoTest deploys and their platform fee?), who types them, and whether they
   should be typed on the page or pre-filled (`Algos` from the live capture, `Capital` from a
   dated setting).
2. The Angel One margin-interest e-mail: its subject line and one sample, and whether other
   debits arrive the same way (DP charges, AMC).
3. A Zerodha Kite contract-note sample (subject and PDF password in `BROKER_ACCOUNTS_JSON`,
   not in chat).
4. `sheetStartColumn` in `BROKER_ACCOUNTS_JSON` still matches the live tab (Finvasia at I,
   Angel One at D)? Checked at the first run, before the sheet is written.

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
  `/opt/homebrew/bin`, default `node` is v16 (nvm) with v20.18.0 and Homebrew `node@20`
  installed; the five `.env` keys exist but are empty, so Gmail retention could not be read
  yet. A read-only IMAP look (oldest and newest note per account, the brokers' other e-mail
  subjects of the last 45 days) is written and runs once `BROKER_ACCOUNTS_JSON` is filled in.
  Decision on the UI: Phases 1–2 first; the page is built once the store's figures are final
  (after the charges and the backfill), so it is written once.

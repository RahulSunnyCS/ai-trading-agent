# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies (also installs qpdf system dep via CI: sudo apt-get install -y qpdf)

npm run fetch        # Fetch contract note PDFs from Gmail via IMAP → saves to data/
npm run parse        # Parse decrypted PDFs in data/ → writes daily_summary.json
npm run sheet        # Update Google Sheet from daily_summary.json
npm run check-dates  # Detect date gaps in the sheet → writes gap_dates.txt

npm start            # Run the full pipeline: fetch → check-dates → parse → sheet
```

To process a specific date instead of yesterday:
```bash
TARGET_DATE=2025-04-30 npm run fetch
TARGET_DATE=2025-04-30 npm run parse
TARGET_DATE=2025-04-30 npm run sheet
```

## Architecture

This is a Node.js automation pipeline that processes daily equity/FNO contract notes from multiple brokers (currently **Finvasia / Shoonya** and **Angel One**) and records P&L summaries into a Google Sheet. It runs on a daily GitHub Actions schedule.

### Pipeline Flow

```
Gmail (IMAP) → fetchMail.js → data/*.pdf (encrypted)
                             ↓ qpdf decrypt
                           data/*_decrypted.pdf
                             ↓
                          parser.js → daily_summary.json
                             ↓
                        updateSheet.js → Google Sheet row
```

**`brokers/`** — Per-broker plugins. Each plugin exports `subject(accountId, date)` (the IMAP `SUBJECT` search string for that broker's contract-note emails) and `extract(text)` (returns `{ payin_payout_obligation, net_brokerage, other_charges, skipped_segments }` from decrypted PDF text; `total_charges` and `final_net` are derived later by `updateSheet.js`). `brokers/index.js` is the registry plus the `BROKER_ACCOUNTS_JSON` config loader and the filename helpers (`makeFileName` / `parseFileName`). `brokers/segments.js` holds the shared exchange-segment classifier — see **F&O-only extraction** below.

**`fetchMail.js`** — Loads `BROKER_ACCOUNTS_JSON`, opens **one IMAP connection per email**, then iterates the broker accounts inside that mailbox. For each account it runs the broker-specific subject search, saves attachments as `<safeEmail>__<broker>__<accountId>__<originalName>.pdf`, and decrypts via the system `qpdf` binary using `pdfPassword` from the same account entry.

**`parser.js`** — Reads all `*_decrypted.pdf` files from `data/`, parses the embedded `<broker>` and `<accountId>` from the filename, dispatches to the broker plugin's `extract`, and writes `daily_summary.json` with per-account and total values.

**`checkDates.js`** — Reads `row_tracker.json` for the last-updated sheet row, fetches the date in column C of that row from the Google Sheet, and writes `gap_dates.txt` listing all missing trading dates plus tomorrow. The CI workflow loops over this file to backfill gaps. Broker-agnostic.

**`updateSheet.js`** — Reads `daily_summary.json`, resolves the next empty row via `row_tracker.json` (falling back to the sheet itself), inserts a new row, copies all formulas from the previous row via `PASTE_FORMULA`, then overwrites columns A–C (serial / day / date) and a 5-column block per account at the `sheetStartColumn` declared in `BROKER_ACCOUNTS_JSON`. The 5 columns are: `payin_payout_obligation`, `net_brokerage`, `other_charges`, `total_charges` (= brokerage + other_charges), `final_net`.

**`row_tracker.json`** — Persisted between CI runs as a GitHub Actions artifact named `row-tracker`. It stores `{ "lastUpdatedRow": N }` to avoid a live sheet read on every run.

### Config: `BROKER_ACCOUNTS_JSON`

A single env var holds a JSON array of mailboxes. Each mailbox has one Gmail login and one or more broker accounts attached to it (1 email → N accounts → 1 broker per account):

```json
[
  {
    "email": "user1@gmail.com",
    "emailPassword": "gmail-app-password-1",
    "accounts": [
      { "broker": "finvasia", "accountId": "FA1234", "pdfPassword": "pdf-pwd-1", "sheetStartColumn": "D" },
      { "broker": "angelone",  "accountId": "R59799620", "pdfPassword": "pdf-pwd-2", "sheetStartColumn": "I" }
    ]
  },
  {
    "email": "user2@gmail.com",
    "emailPassword": "gmail-app-password-2",
    "accounts": [
      { "broker": "finvasia", "accountId": "FA9999", "pdfPassword": "pdf-pwd-3", "sheetStartColumn": "N" }
    ]
  }
]
```

`sheetStartColumn` is the leftmost Google Sheet column for that account's daily values. Each account writes a contiguous 5-column block at that position:

| Offset | Column (e.g. start = `D`) | Value |
|---|---|---|
| 0 | `D` | `payin_payout_obligation` |
| 1 | `E` | `net_brokerage` |
| 2 | `F` | `other_charges` |
| 3 | `G` | `total_charges` (= `net_brokerage + other_charges`, computed by `updateSheet.js`) |
| 4 | `H` | `final_net` (= `payin_payout_obligation - total_charges`, computed by `updateSheet.js`) |

Columns A–C are reserved for serial number / day name / formatted date. Pick `sheetStartColumn` for each account so the per-account 5-column blocks don't overlap; gaps between blocks (and any cells with formulas) are preserved from the previous row via `PASTE_FORMULA`.

### F&O-only extraction

The analytics track **equity derivatives (F&O) only**. A contract note is per-day, not per-segment: if an equity/cash trade is taken on the same day, the broker adds its row to the same note and folds it into the note's own totals. Reading those totals would mix equity P&L, brokerage and charges into the F&O numbers.

Both extractors therefore parse the **obligation table row by row** (one row per exchange/segment — `NSEFNO-NCL`, `NSECASH-NCL`, `BSE-FUTURES`, `NSE-CASH`, …), classify each label via `brokers/segments.js`, and aggregate the F&O rows only. Broker-reported grand totals (`TOTAL(NET)`, `Total Brokerage = …`) are never used as values, only as cross-checks, because they span every segment.

- **Brokerage per segment** is derived from the row's own *taxable value of supply*, which both brokers define as `brokerage + exchange transaction charges + SEBI turnover fees + IPF charges` (Finvasia also prints brokerage in the row directly).
- **Unknown segment labels** (`classifySegment` returns `"unknown"`) are a hard error rather than a guess — silently keeping or dropping an unrecognised segment would corrupt the day's P&L. Add the label to the patterns in `brokers/segments.js` when a new segment shows up.
- **Notes with no F&O row at all** (a pure equity day) extract as zeros rather than an error, so a cash-only contract note contributes nothing instead of failing the run.
- **Column-order guard**: each extractor verifies that `obligation − itemised charges` equals the note's own final-net cell, and refuses the row if it does not. This catches a change in the PDF layout instead of writing a wrong number to the sheet.
- `skipped_segments` lists the non-F&O rows that were dropped; `parser.js` logs it per account.

### Adding a New Broker

1. Create `brokers/<name>.js` exporting `subject(accountId, date)` and `extract(text)`. Use `finvasia.js` and `angelone.js` as templates, including the segment filtering described above.
2. Register it in `brokers/index.js` by adding it to the `BROKERS` map.
3. Reference it in `BROKER_ACCOUNTS_JSON` with `"broker": "<name>"`.

The rest of the pipeline (`fetchMail.js`, `parser.js`, `updateSheet.js`, `checkDates.js`, `row_tracker.json`) needs no changes.

### Components

`components/PaginatedPreview.tsx` is a standalone React component (Next.js `"use client"`) that renders HTML content paginated via `window.Paged.Previewer` (Paged.js). It is not wired into the Node.js pipeline — it appears to be a UI component for a separate front-end that previews paginated documents. It uses stable DOM refs to avoid re-mounts, debounces re-renders, and guards against concurrent pagination runs.

### Required Environment Variables

| Variable | Description |
|---|---|
| `BROKER_ACCOUNTS_JSON` | JSON array of mailboxes, each with `email`, `emailPassword`, and `accounts[]` (each account has `broker`, `accountId`, `pdfPassword`). See **Config** section above. |
| `GOOGLE_CREDENTIALS` | Base64-encoded Google service account JSON |
| `GOOGLE_SHEET_ID` | Google Sheet ID from URL |
| `SHEET_GID` | Numeric GID of the target tab |
| `SHEET_NAME` | Name of the target tab |

`TARGET_DATE` (optional) overrides the default of yesterday (`YYYY-MM-DD` format).

### CI Workflows

`.github/workflows/` contains two workflows:
- **Daily Trading Data Processing** — runs at 00:01 UTC daily; downloads the `row-tracker` artifact, calls `check-dates`, loops over `gap_dates.txt` processing each missing date, uploads the updated artifact.
- **Update Last Updated Row** — manual `workflow_dispatch` to correct `lastUpdatedRow` in the artifact when the sheet is manually edited.

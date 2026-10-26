# CLAUDE.md

Guidance for coding agents working in `packages/contract-notes`.

## What this package does

Reads the brokers' daily contract notes from Gmail and stores each session's realised F&O
figures (Finvasia, Angel One) and the Momentum account's equity notes (Zerodha, `kite`) under
`TRADING_DATA_ROOT/contract-notes/` (BL-168). It runs on the laptop from the
scheduler (`apps/scheduler`: `contract-notes` every day 00:00, `contract-notes-retry` 07:30).
It never writes the Google Sheet: the standalone `trade-analytics` repo keeps filling the
owner's "Trade Book" sheet on its own cron until the owner archives it (TODO §2.7). The two
read the same mailboxes and never touch each other's output.

Node 20, CommonJS, Jest. Needs the `qpdf` binary (Homebrew on the laptop; the scheduler's job
PATH has `/opt/homebrew/bin` and fnm's Node 20).

## Commands

```bash
node run.js                 # every account's new mail since its bookmark; window = last 10 sessions
node run.js --dry-run       # read and parse, write nothing (not even the bookmark)
node run.js --day D         # read session D again by date for every account, replacing its lines
node run.js --sessions N    # a wider window, e.g. after a long trip
node run.js --from D --to D # history by date (bookmark untouched; a stored note is never written over)
node reconcile.js <sheet.csv> [--import-manual] [--out DIR]   # the owner's Google Sheet (CSV export) against the notes
bun run test                # Jest
```

`BROKER_ACCOUNTS_JSON` comes from the repo-root `.env` (`run.js` loads it; the scheduler passes
it too). It must be one line, single-quoted: a pretty-printed value reads as `[` and fails.

## Layout

- `run.js` — the run. Per mailbox, one read-only IMAP connection on `[Gmail]/All Mail`; per
  account, the mail after its bookmark (or, with none, since the window's first session), every
  note's PDF kept, decrypted with `qpdf`, read by the broker plugin, stored as the session's
  line. Then `record.closeWithoutNotes` closes what can have no note. Exit 1 with a list of
  problems (a note that does not read, two different notes for one session, mail that matched
  the search but carries no note anyone in the mailbox can read, a mailbox that will not log in,
  an account newly quiet); the scheduler alerts with the job's `fixHint`. Mail, PDF reading and
  the clock are injectable (`main(argv, deps)`), which `tests/run.flow.test.js` uses.
- One run at a time: `run.js` holds `run.lock` (the pid) in the store for its whole run, so a
  history run by hand cannot overlap the nightly job; a lock left by a dead process is taken
  over. Only the nightly run writes `cursor.json`; `--day` and history leave it alone.
- `store.js` — the files. `storeRoot()` refuses a root on an unmounted `/Volumes/<name>` (like
  `trading_data.db.check_mounted`). `writeLine` replaces one account's line in
  `days/<day>.jsonl` atomically; `saveRaw` keeps `raw/<broker>/<account>/<day>.pdf` (and the
  run writes `<day>.decrypted.pdf` beside it); `cursor.json` holds the bookmarks.
- `record.js` — pure rules. `fnoBlock` (the sheet's five figures, Decimal until the boundary),
  `noteLine`, `openPairs`, `closeWithoutNotes`.
- `calendar.js` — trading days from `packages/option-backtesting`'s `holidays.csv` (the file
  `packages/market-reference` reads, by relative path, so the three never disagree);
  `lastSession()`: today after 16:00 IST on a trading day, else the previous session.
- `fetchMail.js` — `connect`, `searchNotes` (by UID after a bookmark, or by date; it gives up
  only when the mailbox sends nothing for 2 minutes, so a year of history is never cut off),
  and `decryptWithQpdf` (qpdf exit 3 = repaired with warnings, kept).
- `reconcile.js` — the owner's sheet (a CSV export of its first tab) against the notes: per day
  and broker, the sheet's net (obligation − brokerage − other, columns found by header; every
  Finvasia account counts towards its one Finvasia block) within ₹1 of the notes' final net, or
  a line with a likely reason. Writes `reconcile/sheet-vs-notes-<day>.md`; `--import-manual`
  stores the sheet's Algos and Capital as `manual/<day>.json` (never over a newer value).
- `brokers/` — one plugin per broker: `searchSubject(accountId)`, `noteDay({ subject,
  filename, accountId })` and `extract(text)`. `brokers/index.js` is the registry and the
  config loader (it never echoes the config: passwords).

## The store

`TRADING_DATA_ROOT/contract-notes/`:

| Path | What |
|---|---|
| `days/<day>.jsonl` | One line per broker account for the session: `status` `note` (an F&O broker's with `fno`, the sheet's five figures; a `kite` line with `eq` — obligation, each charge, total charges, final net — and `trades`, every fill; `skipped_segments`, the note's sha256, file, subject, received time, and `superseded` hashes when `--day` chose between notes), `no_trade`, `no_note` or `failed` (with `reason`) |
| `raw/<broker>/<account>/<day>.pdf` | The note as mailed (encrypted), and `<day>.decrypted.pdf` |
| `ledger/<day>.jsonl` | The brokers' ledger e-mails, one event per message (`ledger.js`): `deposit`, `withdrawal`, `collateral_interest` (amount, shortfall; on the session it is for), `margin_warning` (utilisation %, time, margin available and used), `settlement` (Finvasia's quarterly; its e-mail has no amount). `account` is null when a mailbox has two accounts of the broker (the e-mails do not name one) |
| `manual/<day>.json` | The inputs the sheet had typed by hand: `algos`, `capital_total`, `source` (`sheet`, later the page or the 15:50 reading) |
| `reconcile/` | `sheet-vs-notes-<day>.md`, each reconciliation report |
| `cursor.json` | Per `<mailbox>\|<broker>/<account>`: `uidvalidity`, `last_uid`, `checked_at` — how far that account's mail has been read — and `quiet_since`, the day a quiet spell began |

**When a session is done for an account** (`record.js`): a note is stored; or `no_trade`,
because a later session's note for the account arrived and this one has no line (brokers mail
a note only for a day with trades); or `no_note`, the oldest session of the window when the
account has had no note in the whole window (an account not trading lately). A `failed` line
(a note that does not read, two different notes) keeps its session open and is never closed as
`no_trade`; it alerts every run until `node run.js --day D` stores the note (with two notes,
`--day` takes the newest received and keeps the others' PDFs). A quiet spell alerts on every
run of the day it begins (so a successful retry cannot swallow the alert), then not until a
note has arrived. A note that arrives later for a session closed as `no_trade` or `no_note`
replaces that line. Sessions of an account whose mailbox could not be read are not judged.

**The bookmark.** Gmail's message numbers (UIDs) only grow within one UIDVALIDITY. A run asks
for UIDs after `last_uid`, or mail received in the 3 days before the last session
(`OVERLAP_DAYS`): a note Gmail indexed late is still found, a recent failed note is tried again,
and notes already stored are skipped by hash. (A count of UIDs would not do: one mailbox gets a
few mails a day, another thousands.) The bookmark
then moves to the newest UID the search returned; alerts about a message (a second note, mail
with no readable note) are raised only for messages past the old bookmark, so each fires once.
With no bookmark, or a changed UIDVALIDITY, the run reads the window by date. A second,
different note for a stored session is reported, never written over.

## F&O-only extraction (Finvasia, Angel One)

For the F&O brokers the analytics track **equity derivatives (F&O) only** (the Zerodha account is
the exception: it is read for equity, below). A contract note is per day, not per
segment: an equity trade the same day adds its row to the same note and its totals. So both
extractors parse the **obligation table row by row** (Finvasia prints `NSEFNO-NCL` and
`NSECAP-NCL`, Angel One `BSE-FUTURES` and `NSE-CASH`), classify each label with
`brokers/segments.js`, and add up the F&O rows only. A broker's grand totals are used only as
cross-checks.

- **Two Finvasia layouts.** Notes until 25 Aug 2025 head the table "Exchange Pay in/Payout
  Obligation" and label rows `NSE FNO` / `NSE CAP`; later ones "Name Of Exchange/CC & Segment"
  and `NSEFNO-NCL`. The columns and their order are the same; both are read.
- **Brokerage per segment** comes from the row's own *taxable value of supply* (brokerage +
  exchange transaction + SEBI + IPF, by both brokers' definition; Finvasia also prints it).
- **An unknown segment label** is a hard error, never a guess: add it to `segments.js`.
- **A note with no F&O row** (a cash-only day) reads as zeros.
- **Column-order guard**: `obligation − itemised charges` must equal the note's own final net,
  or the row is refused, so a changed PDF layout fails loudly instead of storing a wrong figure.
- `skipped_segments` lists the non-F&O rows dropped.

## Ledger e-mails

After the notes, each mailbox reads its brokers' ledger e-mails (`ledger.js` `READERS`: subject,
sender domain and a reader per kind), with the same bookmark-plus-3-days rule, one bookmark per
kind (`<mailbox>|ledger/<kind>` in `cursor.json`). An e-mail from the right sender that its
reader cannot understand is reported once (its wording changed), never skipped. Angel One's
margin warning has two wordings (Sep 2026: "as on 2026-09-09 12:45:58"; Oct 2026 on: "as on
22-Oct-2026, 10:05:58 AM"); both are read.

## Zerodha (`kite`): equity, for Momentum

The Momentum account trades nothing else, so its notes are read for the cash segment: the
totals block (Cash, F&O and Net total columns; a payable amount in brackets, a footnote digit
after "(₹)" on some rows, a receipt printed unbracketed) and Annexure A's trade rows, whose cells
pdf-parse runs together (order no, times, trade no, `SYMBOL-SERIES/ISIN`, B/S, exchange,
quantity glued to brokerage — split where quantity × rate = total —, rate, total). Two checks
refuse a note: obligation − charges ≠ the note's net, or the trades not summing to the
obligation. An F&O figure on that account is refused too.

## Adding a broker

1. `brokers/<name>.js` exporting `searchSubject`, `noteDay` and `extract` (copy `finvasia.js`
   or `angelone.js`, segment filtering included).
2. Add it to `BROKERS` in `brokers/index.js`.
3. Accounts with `"broker": "<name>"` in `BROKER_ACCOUNTS_JSON` are read from the next run.
   Until a plugin exists the run skips such an account with a notice.

An account may carry `"from": "YYYY-MM-DD"`: notes before that day are not stored and its
sessions before it are not judged. `kite` defaults to 2026-10-16, Momentum's start
(`DEFAULT_FROM` in `run.js`); earlier Zerodha notes are the owner's other trades. `kite` also
raises no quiet-account alert (`NO_QUIET_ALERT`): Momentum trades on Fridays, not every week.

## Not wired

`components/PaginatedPreview.tsx` and `styles/` came with the `trade-analytics` merge and are
not used by the pipeline. The two sample PDFs and the two `.xlsx` files are reference copies
(the committed sheet copy holds the formulas BL-168 Phase 4 reproduces).

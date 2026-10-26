# CLAUDE.md

Guidance for coding agents working in `packages/contract-notes`.

## What this package does

Reads the brokers' daily contract notes from Gmail and stores each session's realised F&O
figures under `TRADING_DATA_ROOT/contract-notes/` (BL-168). It runs on the laptop from the
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
bun run test                # Jest
```

`BROKER_ACCOUNTS_JSON` comes from the repo-root `.env` (`run.js` loads it; the scheduler passes
it too). It must be one line, single-quoted: a pretty-printed value reads as `[` and fails.

## Layout

- `run.js` — the run. Per mailbox, one read-only IMAP connection on `[Gmail]/All Mail`; per
  account, the mail after its bookmark (or, with none, since the window's first session), every
  note's PDF kept, decrypted with `qpdf`, read by the broker plugin, stored as the session's
  line. Then `record.closeWithoutNotes` closes what can have no note. Exit 1 with a list of
  problems (a note that does not parse, two different notes for one session, a mailbox that
  will not log in, an account newly quiet); the scheduler alerts with the job's `fixHint`.
- `store.js` — the files. `storeRoot()` refuses a root on an unmounted `/Volumes/<name>` (like
  `trading_data.db.check_mounted`). `writeLine` replaces one account's line in
  `days/<day>.jsonl` atomically; `saveRaw` keeps `raw/<broker>/<account>/<day>.pdf` (and the
  run writes `<day>.decrypted.pdf` beside it); `cursor.json` holds the bookmarks.
- `record.js` — pure rules. `fnoBlock` (the sheet's five figures, Decimal until the boundary),
  `noteLine`, `openPairs`, `closeWithoutNotes`.
- `calendar.js` — trading days from `packages/option-backtesting`'s `holidays.csv` (the file
  `packages/market-reference` reads, by relative path, so the three never disagree);
  `lastSession()`: today after 16:00 IST on a trading day, else the previous session.
- `fetchMail.js` — `connect`, `searchNotes` (by UID after a bookmark, or by date), and
  `decryptWithQpdf` (qpdf exit 3 = repaired with warnings, kept).
- `brokers/` — one plugin per broker: `searchSubject(accountId)`, `noteDay({ subject,
  filename, accountId })` and `extract(text)`. `brokers/index.js` is the registry and the
  config loader (it never echoes the config: passwords).

## The store

`TRADING_DATA_ROOT/contract-notes/`:

| Path | What |
|---|---|
| `days/<day>.jsonl` | One line per broker account for the session: `status` `note` (with `fno`, the sheet's five figures, `skipped_segments`, the note's sha256, file, subject, received time), `no_trade` or `no_note` (with `reason`) |
| `raw/<broker>/<account>/<day>.pdf` | The note as mailed (encrypted), and `<day>.decrypted.pdf` |
| `cursor.json` | Per `<mailbox>\|<broker>/<account>`: `uidvalidity`, `last_uid`, `checked_at` — how far that account's mail has been read |

**When a session is done for an account** (`record.js`): a note is stored; or `no_trade`,
because a later session's note for the account arrived and this one's did not (brokers mail a
note only for a day with trades); or `no_note`, the oldest session of the window when the
account has had no note in the whole window (an account not trading lately). `no_note` is
reported once per quiet spell, not daily. A note that arrives later for a session closed as
`no_trade` or `no_note` replaces that line.

**The bookmark.** Gmail's message numbers (UIDs) only grow within one UIDVALIDITY, so a run
asks only for UIDs after `last_uid`; with none matching it still moves the bookmark to the
mailbox's newest UID. A changed UIDVALIDITY drops the bookmark and the run reads the window by
date. The bookmark moves only when everything the account's search returned was stored, so a
note that fails is read again (and alerts again) until fixed; after a fix, `node run.js --day D`.
A second, different note for a stored session is reported, never written over.

## F&O-only extraction

The analytics track **equity derivatives (F&O) only**. A contract note is per day, not per
segment: an equity trade the same day adds its row to the same note and its totals. So both
extractors parse the **obligation table row by row** (Finvasia prints `NSEFNO-NCL` and
`NSECAP-NCL`, Angel One `BSE-FUTURES` and `NSE-CASH`), classify each label with
`brokers/segments.js`, and add up the F&O rows only. A broker's grand totals are used only as
cross-checks.

- **Brokerage per segment** comes from the row's own *taxable value of supply* (brokerage +
  exchange transaction + SEBI + IPF, by both brokers' definition; Finvasia also prints it).
- **An unknown segment label** is a hard error, never a guess: add it to `segments.js`.
- **A note with no F&O row** (a cash-only day) reads as zeros.
- **Column-order guard**: `obligation − itemised charges` must equal the note's own final net,
  or the row is refused, so a changed PDF layout fails loudly instead of storing a wrong figure.
- `skipped_segments` lists the non-F&O rows dropped.

## Adding a broker

1. `brokers/<name>.js` exporting `searchSubject`, `noteDay` and `extract` (copy `finvasia.js`
   or `angelone.js`, segment filtering included).
2. Add it to `BROKERS` in `brokers/index.js`.
3. Accounts with `"broker": "<name>"` in `BROKER_ACCOUNTS_JSON` are read from the next run.
   Until a plugin exists the run skips such an account with a notice (Zerodha `kite` until
   BL-168 Phase 3).

## Not wired

`components/PaginatedPreview.tsx` and `styles/` came with the `trade-analytics` merge and are
not used by the pipeline. The two sample PDFs and the two `.xlsx` files are reference copies
(the committed sheet copy holds the formulas BL-168 Phase 4 reproduces).

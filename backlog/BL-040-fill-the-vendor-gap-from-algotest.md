# BL-040 — Fill the vendor gap (26 Aug – 24 Sep 2026) from AlgoTest, for every index and stock

| | |
|---|---|
| **Priority** | P1 — the AlgoTest source only serves the last three months, so each day of the gap is lost for good once it ages out: 26 Aug 2026 drops out of the window around 24 Nov 2026 |
| **Status** | Planned — on hold while the owner asks the vendor (see Log) |
| **Type** | feature |
| **Area** | trading-data / options |
| **Created** | 2026-10-07 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) Phase 1 (done: lake, importer, `data_quality`); the AlgoTest connector (connected in the owner's Claude account on 2026-10-07); a merge writer for day files, shared with [BL-038](BL-038-monthly-expiry-stock-options-collection.md) |
| **TODO.md row** | — (filled in when started) |

## Context

The vendor's history ends 2026-08-25 and the daily Fyers collector starts 2026-09-23 (NIFTY) or
2026-09-25 (SENSEX), so the lake has a hole. Measured on 2026-10-07 from the lake and
`data_quality` (not from memory):

- **Hard holes** (the index has spot, there is no option file): NIFTY 16–22 Sep (5 days),
  SENSEX 18–24 Sep (5 days), BANKNIFTY / FINNIFTY / MIDCPNIFTY 19 days each, 26 Aug – 22 Sep.
- **Thin days** (a file exists, labelled `usable`, but the chain is running out): from 26 Aug
  the vendor listed fewer and fewer expiries. NIFTY goes from 4–5 expiries (about 480–590
  contracts) to 1 expiry (about 150) by 9 Sep; SENSEX from 4–5 to 1 by 11 Sep. Only the
  nearest weekly is complete late in the window; next-weekly and monthly series are absent.
- **Stocks** (51 stock partitions in the lake, from 47 loaded vendor folders, 169 of 216 staged
  folders not loaded — that part is [BL-037](BL-037-stock-options-in-the-lake.md), a load task,
  not a data gap): every stock's vendor data ends 2026-08-25 and nothing has been collected since
  (the forward collection is [BL-038](BL-038-monthly-expiry-stock-options-collection.md), first
  window 2026-10-27). So all 216 stocks are missing 26 Aug → about mid-October.

AlgoTest is reachable through its MCP connector (`https://api.algotest.in/mcp`; tools
`get_ohlc_by_data_source`, `fetch_greeks_by_data_source`, `search_symbols`, `get_underlyings`).
`get_underlyings` lists NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY, BANKEX and ~210 stocks
named `NSE_<SYMBOL>`; **NIFTYNXT50 is not listed**. The request must start within the last three
months.

### What the 2026-10-07 probe showed (do not re-derive)

- 1-minute option candles work for gap days (NIFTY weekly ATM CE, fixed at 09:17, 2026-09-01:
  all 375 bars plus the 15:30–15:40 closing prints).
- It is **strike-relative, not per-contract**: you ask for "weekly expiry, ATM / ITM2 / exact
  strike 23250" and a day range; the answer carries no strike or expiry date. A rolling-ATM
  series changes strike every minute, so it is not a contract. `EntryByExactStrike` with a
  relative expiry (`ExpiryType.Weekly`, `NextWeekly`, `Monthly`…) gives a real contract once
  the expiry is resolved from the expiry calendar.
- **It is not identical to the lake.** Same contract (NIFTY 23250 CE, weekly, 2026-09-24,
  15-minute): the first bucket matches on open/high/low (131.95 / 151.8 / 114.25), close
  122.5 vs 122.3 in the lake, volume 12,370,865 vs 12,371,255; later buckets differ by paise to
  about a rupee on high/low/close and a few hundred contracts of volume. Volume units agree.
  Candles are stamped by **end** time (AlgoTest 09:30 = the lake's 09:15 bucket).
- **Every response flows through the model's context**: one contract-day at 1 minute is
  about 15,000 tokens, and saving it means writing it back out (another ~15,000, with
  transcription risk). A full chain (hundreds of contracts a day) cannot be fetched that way;
  an ATM straddle for NIFTY and SENSEX over the 10 hard-hole days is about 300k tokens.

## Goal

For every index AlgoTest serves (NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY) and every stock
it lists, the lake holds option data for each trading day from 2026-08-26 until the Fyers/
BL-038 collection takes over, with each filled day labelled as AlgoTest-sourced in
`data_quality`, so a backtest can include or exclude them. "Filled" is stated honestly per day:
which expiries and strikes it covers and which it does not.

## Out of scope

- Loading the vendor's remaining 169 stock folders (BL-037).
- Collecting stock options going forward (BL-038).
- NIFTYNXT50 (not offered by AlgoTest; stays at the vendor's 2026-08-25).
- Greeks / IV from AlgoTest (`fetch_greeks_by_data_source`) — derived tables are BL-034 Phase 3.
- Replacing vendor or Fyers days. Existing files are never overwritten by this source.

## Plan

### Phase 1 — Spike: can the data bypass the model's context, and how good is it?
- **Tasks:** (a) find out whether the AlgoTest MCP (or its API) can be called from a script —
  an OAuth token the owner can issue, or a documented REST endpoint — so responses go straight
  to disk (`raw/algotest/…`, the `obt ingest` raw layout) without passing through a Claude
  session. This decides everything below. (b) Parity: pick 5 overlapping days (Fyers days in the
  last three months), fetch the same contracts, and report per-field differences (price,
  volume, bar alignment) so the owner can decide whether mixing sources is acceptable. (c) The
  contract mapping: resolve `ExpiryType.*` + exact strike to a real expiry date from
  `ref_expiries`, and confirm it for a past day against the lake. (d) Stock coverage and naming:
  which of the 216 stocks AlgoTest lists, renamed ones (GMRINFRA/GMRAIRPORT, LTIM/LTM,
  TATAMOTORS/TMPV, ZOMATO/ETERNAL), lot sizes. (e) Rate limits and per-call day limits.
- **Deliverables:** the answers recorded in this item; a go / no-go on scripted fetching; a cost
  estimate per index and for all stocks in calls and tokens.
- **Done when:** the cheapest viable fetch path is chosen and its total cost for Phases 3–4 is
  written down.

### Phase 2 — Importer and storage rules
- **Tasks:** an `algotest` source: raw JSON → lake day files in the existing schema (bar start
  stamps: shift the end-stamped candles back; contract identity from the resolved expiry and
  strike; instrument alias `algotest`); a migration adding `'algotest'` to `data_quality.source`;
  a **merge** mode in the lake writer (read the day file, add the new contracts' rows, write
  atomically) because a thin day must gain contracts without losing vendor ones — build it once
  and share it with BL-038; never overwrite a vendor or Fyers row on the same
  (contract, minute); the quality table records, per day, which source supplied which contracts.
- **Deliverables:** importer, merge writer, migration, tests with a fixed AlgoTest response
  fixture (including the end-stamp shift and a day that already has vendor rows).
- **Done when:** importing a fixture twice is a no-op; a thin vendor day gains AlgoTest
  contracts and keeps every vendor row; the legwise engine runs a strategy over a merged day.

### Phase 3 — Indices
- **Tasks:** NIFTY and SENSEX first: the 10 hard-hole days (all expiries listed that day, not
  only ATM, if Phase 1 makes it affordable; otherwise the ATM ± N band of the nearest weekly)
  and the thin days 26 Aug – 15 Sep (the next-weekly and monthly series). Then BANKNIFTY,
  FINNIFTY, MIDCPNIFTY (19 hard-hole days each). `tdata quality rebuild --asset option`.
- **Deliverables:** filled days with an honest coverage note in `data_quality`.
- **Done when:** no NIFTY or SENSEX trading day since 2024-10-01 lacks an option file, and
  `tdata quality status` shows the AlgoTest-sourced days.

### Phase 4 — Stocks
- **Tasks:** for the 216 F&O stocks, fill 2026-08-26 → the first BL-038 / Fyers day, within
  Phase 1's cost estimate; start with the owner's watchlist if the full set is too costly.
  Stock spot comes from Fyers history (it is not in AlgoTest's option data).
- **Deliverables:** stock gap days in the lake, per-stock coverage reported.
- **Done when:** every stock in scope has option data for each trading day from 2026-08-26 to the
  hand-over to BL-038, or the remainder is listed with a reason.

### Phase 5 — Verify and record
- **Tasks:** sample the filled days against the raw responses cell by cell (reuse
  `scripts/vendor/verify_values.py`'s approach); rerun the legwise exit checks on a filled day;
  update `.claude/project/technical.md`, `packages/trading-data/CLAUDE.md`, `DECISIONS.md` (why
  mixed sources are acceptable, what the parity numbers were), TODO.md, BL-034's log.
- **Done when:** zero differences between lake rows and raw AlgoTest responses on the sample,
  and docs updated in the same commit.

## Risks

- **A hard deadline, not a soft one.** The window moves forward every day; 26 Aug is gone around
  24 Nov. Phase 1 should finish within a week so the indices can be filled well before then.
- **Token cost** if Phase 1 finds no scripted path: only the ATM band for NIFTY and SENSEX is
  affordable; BANKNIFTY/FINNIFTY/MIDCPNIFTY and the stocks would shrink to ATM or be dropped.
- **Mixed sources.** AlgoTest differs slightly from Fyers/vendor data (see the probe). A backtest
  crossing the seam carries those differences; the quality table must make the source visible.
- **No spot for stocks** from AlgoTest; legwise cannot run a stock without Fyers spot and a
  lot size (BL-037's Phase 3 facts).
- **Transcription errors** if responses are saved by the model re-typing them; avoid by the
  scripted path or by hashing each saved file against a second fetch.
- **Contract mapping.** A wrong relative-expiry-to-date resolution would label real data with
  the wrong expiry; Phase 1(c) exists to prevent that.

## Open questions

- Is a script-callable AlgoTest endpoint available to the owner (token, REST docs)?
- Is the slight source difference acceptable for backtests, or should AlgoTest days be excluded
  by default and used only for fills the strategy tolerates?
- All 216 stocks, or a watchlist, for the stock gap?
- If only the ATM band is affordable, is that enough for the straddle-sell + adjust work?

## Log

- 2026-10-07 — created at P1 on the owner's request ("fix for all the indices and stocks").
  Gap numbers measured from the lake and `data_quality`; connector probe results above.
- 2026-10-07 — **Vendor first.** The owner will ask the data vendor for the missing days (26 Aug →
  the first Fyers day, all indices and stocks) before any AlgoTest work starts. If the vendor
  supplies them, this item closes as "Done by vendor": put the files in the staging set
  (`options_to_parquet.py --refresh`), run `tdata vendor import` (it picks up new rows by itself),
  then `tdata quality rebuild --asset option`, and compare the new files with the Fyers days that
  overlap. If the vendor has not confirmed by **2026-11-03**, start Phase 1 — the AlgoTest window
  loses 26 Aug around 2026-11-24, so anything left after that date cannot be recovered from it.


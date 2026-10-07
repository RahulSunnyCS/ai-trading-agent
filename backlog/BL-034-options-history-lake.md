# BL-034 — Options history lake: two years of vendor 1-minute data in `trading-data`, derived tables for straddle backtests, daily top-up

| | |
|---|---|
| **Priority** | P0 — owner wants it started next (2026-10-06); it is the data every options backtest (BL-009, BL-022, BL-026) runs on, and without it the engine has six sessions of history |
| **Status** | In progress (Phase 1 done 2026-10-07; Phase 2 next) |
| **Type** | feature |
| **Area** | trading-data (+ options, infra) |
| **Created** | 2026-10-06 |
| **Depends on** | the SSD conversion job finishing (in progress 2026-10-06); BL-012 for the daily steps in Phase 4; replaces BL-009 Phase 2 (vendor data layer) |
| **TODO.md row** | 3.11.18 |

## Context

The owner obtained the vendor's full history (the Drive share whose sample BL-009 examined) and
copied it to the external SSD (`/Volumes/RAHUL'S SSD/Stock Market Data`) on 2026-10-05/06:

| On the SSD | Content | Coverage |
|---|---|---|
| `options/index/{nifty,sensex,banknifty,finnifty,midcpnifty,niftynxt50}` | 1-minute OHLC + volume + OI, one CSV per contract, **full contract life** | expiries 2024-10-01 → 2026-09-17; most underlyings end **2026-08-25** (nifty/sensex 2026-09-17) |
| `options/stocks/<216 symbols>` | same shape | 2022-09 → 2026-08-25 |
| `2014-2024/{nifty,banknifty}` | 1-minute, **expiry-week only**; nifty monthly-only before 2019; banknifty from 2018-04 | expiries 2014-01 → 2024-11 (overlaps `options/` for Oct 2024) |
| `2014-2024/spot_data` | 1-minute spot: nifty (2015→), banknifty (2015→), sensex (2018→) | → mid-2026 |
| `India VIX/2567_INDIAVIX.csv` | 1-minute India VIX | 2015-04 → 2026-08-07 |

`options/` is being converted to a per-expiry Parquet staging set
(`Stock Market Data/parquet/options/<index|stocks>/<unit>/<expiry>.parquet`, columns
`underlying, contract, strike, option_type, expiry, ts, open, high, low, close, volume, oi`) by a
scratch script that verifies every batch (Drive listing = local listing by name+size; Parquet
rows = CSV rows) and merges the vendor's `stock options.zip` where it holds longer copies than
the Drive folders. Data-quality findings so far are in the Log.

What already exists in the repo and must be reused, not duplicated:

- `packages/trading-data`: DuckDB catalog (`instruments`, `instrument_aliases`, `ingest_runs`,
  `quality_issues`, effective-dated `ref_*`) over a hive-partitioned Parquet lake at
  `TRADING_DATA_ROOT`: `lake/bars_1m/asset={option,future}/underlying=U/date=D/data.parquet`,
  `asset=index/symbol=S/date=D/` (INDIAVIX lives there). Files immutable, zstd, atomic writes
  (`lake.write_parquet`); partition values only in folder names; every row carries
  `instrument_id`; `ts` tz-aware `Asia/Kolkata`, bar start. `tdata backup` copies `lake/` + `raw/`.
- `obt daily` / `obt fyers fetch` already writes **exactly that layout** every evening for the five
  index underlyings (spot, VIX, nearest future, option chain for current + next expiry) — from
  2026-09-23. `obt fyers history` backfills index + VIX 1-minute history.
- `option-backtesting/legwise` reads the lake on a fixed 375-minute 1-minute grid; strike
  resolution in `data/resolver.py` (round-half-up on the effective-dated strike step); the
  expiry calendar CSV is **wrong for NIFTY before 2025-09-01** (TODO 3.10.15) — the legwise engine
  uses the symbol master's listed expiries instead.

Owner decisions (2026-10-06):

- Scope is **two years** first: expiries from Oct 2024 (= the `options/` set), full contract
  lives even where they start earlier. `2014-2024` is Phase 5, later.
- Derived tables for **NIFTY and SENSEX** only; strategies: ATM/OTM straddle **sell + adjust**,
  with **IV** as a regime input ("when IV is high, do X").
- The lake lives in an **APFS sparse disk image on the SSD** (internal disk has ~39 GB free;
  on the ExFAT SSD every file costs two 256 KiB blocks — ~110k partition files would waste ~55 GB).
- Derived snapshot grid: **5-minute**; raw stays 1-minute and is always available.
- Index futures collected daily from now on: **yes**. Stock-option daily collection: **no**.
- Tick / bid-ask recording: **P2, low priority**, after a bigger SSD (see Out of scope).
- The **Aug 26 → Sep 22, 2026 gap** (vendor history ends, Fyers collection starts 09-23): the owner
  will try to source it; the plan treats it as a non-issue and just reports it.
- Greeks/IV: computed, not sourced.

## Goal

1. One canonical dataset: the vendor history and the daily Fyers collection sit in the same lake,
   same schema, same `instrument_id`s, with `vendor` recorded per `ingest_runs` row — the legwise
   engine runs over Oct 2024 → today without knowing which source a day came from.
2. A straddle-sell backtest for NIFTY/SENSEX reads **one derived table** (5-minute chain snapshots
   with spot, VIX, DTE, implied forward, IV and greeks) instead of scanning 1-minute bars.
3. Every day in the lake has a quality verdict (usable / excluded and why); nothing is guessed.
4. The daily job appends today to raw and derived tables idempotently.

## Out of scope

- Tick-level data, bid/ask/depth recording (P2, low priority; needs a bigger SSD and the
  `apps/server` live feed or a REST quote recorder — see Risks).
- Stock options: the vendor's stock history is deferred to [BL-037](BL-037-stock-options-in-the-lake.md) (P3;
  47 of 216 stocks were loaded when it was stopped) and the forward collection of stocks is
  [BL-038](BL-038-monthly-expiry-stock-options-collection.md). The minor indices (BANKNIFTY,
  FINNIFTY, MIDCPNIFTY, NIFTYNXT50) are loaded as raw bars only (no derived tables).
- Backfilling Aug 26 → Sep 22, 2026 (owner is sourcing it; load it with the Phase 1 loader if it arrives).
- Engine features (those are BL-009 Phases 3–6).
- Delta-based strike selection, full IV-surface research (needs greeks on every strike every
  bar — possible from the same code later, not built now).

## Plan

### Phase 0 — Finish the conversion and freeze the staging set
- **Tasks:** let the scratch pipeline finish (`index` done; `stocks` ~3,050/4,423 at 17:00
  2026-10-06); re-run failed folders; verify all 4,739 expiry folders have a Parquet file and
  that Parquet row totals equal the recorded CSV rows; summarise the zip-vs-Drive merge
  (contracts where the zip was longer / Drive longer / zip-only); remove staging leftovers
  (`options/` CSV remnants, `_zip_check/`, partial `stock options.zip` under `options/stocks/`)
  after the summary is saved; keep `2014-2024/`, `India VIX/`.
- **Deliverables:** `parquet/options/_done.jsonl` complete, a `CONVERSION-REPORT.md` next to it
  (counts, sizes, anomalies, decisions), the scratch script committed under
  `packages/trading-data/scripts/vendor/` for provenance.
- **Done when:** 4,739 Parquet files, zero rows lost versus the CSV counts, report written.

### Phase 1 — Disk image + loader into the lake
- **Tasks:** create `TradingData.sparsebundle` (APFS) on the SSD, mount it, set
  `TRADING_DATA_ROOT` to it, move the existing `~/TradingData` lake/catalog into it (keep the
  `~/TradingData` copy until Phase 2 passes); `tdata vendor import` — reads the staging Parquet,
  registers every contract (`NSE:OPT:<U>:<expiry>:<strike:g>:<CE|PE>`, alias vendor=`drive-vendor`),
  re-partitions by trading day into `bars_1m/asset=option/underlying=U/date=D/`, writes
  `vendor_symbol`, logs one `ingest_runs` row per (underlying, month) with `source='vendor'`;
  loads `2014-2024/spot_data` and the VIX file into `asset=index/symbol=…`; dedupes the Oct 2024
  overlap in favour of the full-life source; **skips any (underlying, day) that the Fyers collector
  already wrote** (collector wins from 2026-09-23); session clip 09:15–15:29 with dropped-bar counts
  logged; `data_quality` catalog table (migration `008_data_quality.sql` — 007 was taken by
  BL-024) with one row per (asset, name, day): bars present vs 375, contracts, first/last ts,
  verdict + reason.
- **Deliverables:** `tdata vendor import --from <staging> [--unit U] [--days A..B]`,
  migration 008, `LAKE_VIEWS` unchanged (same datasets), importer unit tests on a two-day fixture.
- **Done when:** `legwise` runs an existing strategy over a vendor day and a Fyers day with no code
  change; `tdata status` shows option days from 2022-03 (nifty) → today with no gap other than
  Aug 26 → Sep 22, 2026; `tdata backup` to a second location copies the new partitions.

**Phase 1 outcome (2026-10-07).** Done, in six PRs (#52, #55, #58, #61, #62, #63; two more
fixes in #68 and the docs PR). Loaded into the lake on the disk image, each unit's rows
verified equal to the staged rows from the Parquet footers:

| | Days | Rows |
|---|---|---|
| NIFTY options | 1,005 (2022-03 → 2026-09-15; usable range starts ~Sep 2024) | 143,649,872 |
| SENSEX options | 582 | 71,893,677 |
| BANKNIFTY / FINNIFTY / MIDCPNIFTY / NIFTYNXT50 options | 684 / 647 / 669 / 666 | 68.4M / 21.1M / 31.1M / 3.7M |
| Spot: NIFTY, BANKNIFTY, SENSEX; India VIX | 2,838 / 2,763 / 2,075 / 2,130 | 1.06M / 1.03M / 0.77M / 1.05M |
| Stock options (deferred, BL-037) | 47 of 216 folders | 0.41B of 1.77B |

Exit checks: the legwise engine, unchanged, backtests vendor days and Fyers days for NIFTY and
SENSEX (e.g. NIFTY 2026-06-24 vendor, 2026-09-23 Fyers; SENSEX 2026-07-22 vendor, 2026-09-25
Fyers), and a unit test proves a vendor-imported day equals a Fyers-written day trade for trade.
Reading is fast: a month-long straddle series 1.1 s, a year's aggregate 1.3 s, a full scan of
144M NIFTY rows 1.3 s. Differences from the plan above: every vendor row is kept (the quality
table labels special sessions and after-hours rows; nothing is clipped), the Oct-2024 overlap
with `2014-2024` does not arise yet (that set is Phase 5), and `data_quality` is migration 008.

**Two owner-gated follow-ups remain from Phase 1:** (1) after a Fyers login,
`obt fyers history --underlying <U>` for NIFTY (from 2026-06-30), SENSEX (from 2026-07-23),
BANKNIFTY (from 2026-05-30), FINNIFTY and MIDCPNIFTY (their whole range) fills the index spot the
vendor's CSVs lack, then `tdata quality rebuild --asset index` — until then 55 NIFTY, 39 SENSEX
and 61 BANKNIFTY option days are labelled `no_spot`; (2) install the `trading-data-mount`
LaunchAgent once the main checkout has the new code (`deploy/launchd/install.sh` also performs
the BL-012 scheduler cut-over, which is the owner's call).

### Phase 2 — Reference data the backtests need
- **Tasks:** `expiry_calendar_observed` — expiries derived from the data itself per underlying
  (replaces the wrong CSV for history; the symbol master remains the source going forward);
  lot sizes and strike steps **effective-dated for 2024-10 → today** for NIFTY/SENSEX (and the
  loaded underlyings) from NSE/BSE circulars into `ref_lot_sizes`/`ref_strike_steps` (the tables
  hold only 2026 rows today); holidays 2024–2026; a `ref_rates` table (91-day T-bill / repo,
  quarterly steps) for IV.
- **Deliverables:** migration for `expiry_calendar_observed` + `ref_rates`, CSV exports via
  `tdata reference export`, TODO 3.10.15 closed by the observed calendar.
- **Done when:** for every (underlying, day) in the lake the observed expiry list is non-empty and
  the lot size lookup returns a dated value; `legwise`'s `DTE_RELIABLE_FROM` guard can move back to
  2024-10-01 for the loaded range.

### Phase 3 — Derived tables (NIFTY, SENSEX)
- **Tasks:** `lake/derived/` datasets, each rebuilt from raw and versioned by a `derived_version`
  in the catalog:
  - `contracts_daily/year=Y/` — per contract per day: first/last ts, bars traded, day OHLC,
    volume, OI, min/max premium, DTE, `traded_minutes`.
  - `chain_snapshots_5m/underlying=U/date=D/` — at each 5-minute mark: ATM and ATM±1…±10 CE/PE
    (close of the 5-minute window, OI, volume), spot, VIX, DTE per live expiry, **implied forward
    from put–call parity at ATM**, Black-Scholes IV per strike (rate from `ref_rates`), delta/
    theta/vega/gamma, `iv_quality` flag (low premium < ₹2, last hour of expiry day, parity gap).
  - `straddle_series_5m/underlying=U/date=D/` — ATM straddle premium per live expiry every 5
    minutes (same definition as `apps/server`'s straddle calculator).
  - `iv_daily/underlying=U/` — per day × expiry: ATM IV, India VIX, trailing 1y/2y percentiles of
    both, skew (OTM-5 PE IV − OTM-5 CE IV), realised vol (20-day).
  - `tdata derived rebuild [--day D] [--underlying U]` — full or incremental; `--check` compares a
    rebuilt day with the stored one.
- **Deliverables:** the four datasets, `LAKE_VIEWS` entries, a lookahead test (every snapshot at T
  uses bars ≤ T), golden day fixtures (one NIFTY, one SENSEX day) with hand-checked ATM, forward
  and IV values.
- **Done when:** a straddle-sell + adjust backtest for one month reads only `chain_snapshots_5m`
  and `straddle_series_5m`, reproduces the same trades as the 1-minute engine for the same rules
  at 5-minute granularity, and full rebuild of two years runs within an evening.

### Phase 4 — Daily top-up (under BL-012)
- **Tasks:** extend `obt daily` to keep the nearest **and next** index future; after it, run
  `tdata derived rebuild --day <today>` and the `data_quality` verdict; Telegram summary adds the
  day's verdict and the current IV percentile; register both as BL-012 jobs.
- **Deliverables:** job definitions, run records, alert on a missing or excluded day.
- **Done when:** the evening after a trading day, the derived tables include that day and the
  summary reports it, with no manual step.

### Phase 5 — `2014-2024` (later, after the owner widens the window)
- **Tasks:** the same loader on the expiry-week-only history with a `coverage='expiry_week'` mark
  in `data_quality`; monthly-only nifty before 2019; sparse-bar handling per BL-009's findings
  (traded flag, duplicate rows, off-session bars, missing expiry day).
- **Done when:** every imported day carries its coverage mark and the derived tables refuse DTE
  features where the contract's life is not present.

## Risks

- **SSD space:** phase-1 lake ≈ 25 GB Parquet; the disk image avoids the ExFAT per-file cost. If
  the image is not acceptable, the fallback is one file per day across all stocks (wider files,
  fewer of them) — deviates from the lake convention and is to be avoided.
- **Vendor data defects are real** (found during conversion): an all-NUL contract file identical
  in Drive and the zip (`LTIM_5000_PE_27_FEB_25.csv`), a zip entry NUL-padded to a 256 KiB block,
  a "`- Copy`" file carrying a different series under the same contract name, contracts empty in
  one source and full in the other. The importer must keep quality gates on and never prefer a
  source by name.
- **Overlap seams** (Oct 2024 between the two vendor sets; 2026-09-23 between vendor and Fyers)
  can double-count if partitions are merged instead of replaced — the loader writes whole
  (underlying, day) files and skips existing ones.
- **IV noise** on expiry day and far OTM; the `iv_quality` flag exists so rules can exclude it,
  and `iv_daily` uses ATM only.
- **Bid/ask absent** in all of this data: option-selling results need a slippage model (the
  engine has one); real spreads come only with the P2 recorder.
- **DuckDB single writer:** the importer and `obt daily` must not run at the same time — the
  BL-012 scheduler serialises them.

## Open questions

Answered for Phase 1 (2026-10-06): image cap 200 GB; every vendor row is kept (no session
clip — see Log); staging stays on the SSD; root via env var + mount guard + login auto-mount.
Still open for Phase 3:

- Which slippage assumption to use in backtests until spreads are recorded (fixed ticks vs % of
  premium scaled by volume)?
- Should the derived tables also cover BANKNIFTY now that its data is loaded, or stay NIFTY+SENSEX?
- Disk image size cap (sparse, so the cap is only a ceiling): 200 GB?

## Log

- 2026-10-06 — created from the conversation while the SSD conversion ran. Owner answered:
  two-year scope; NIFTY+SENSEX straddle sell/adjust with IV regime; APFS disk image accepted;
  5-minute derived grid; index futures daily yes; stock options daily no; ticks P2 low; Aug 26 →
  Sep 22 gap is the owner's to source. Conversion findings recorded under Risks. BL-009 Phase 2 now
  points here.
- 2026-10-06 — re-prioritised P1 → P0 at the owner's request ("start it quickly"). Prerequisites:
  Phase 0 (conversion finishing) only; the disk image is a few-minute step inside Phase 1; BL-012
  is needed only for Phase 4.
- 2026-10-06 — **Started** (owner handoff: "do till completion of Phase 1, small PRs"). Plan:
  `~/.claude/plans/what-is-phase-1-luminous-matsumoto.md`, as a stack of PRs (schemas into
  `trading_data.lake` → root guard → `data_quality` → vendor importer → provenance scripts →
  close-out). Owner decisions taken while planning: **keep every vendor row** — the "weekend"
  dates are real sessions (Budget Saturdays 2025-02-01 and 2026-02-01, NSE DR-drill Saturdays
  2024-03-02 and 2024-05-18, Muhurat 2023-11-12) and Fyers' own files keep 15:30–15:39 closing
  bars, so the lake keeps both and `data_quality` labels the days instead of the importer
  dropping rows; the staging Parquet stays on the SSD as the vendor's raw copy; the root moves
  via `TRADING_DATA_ROOT` with a mount guard. The schema layout (one file per underlying per
  day) was re-chosen on its merits rather than inherited from the eight Fyers days. Vendor spot
  ends 2026-06-29 (NIFTY) / 2026-07-23 (SENSEX); `obt fyers history` fills the index days after.
- 2026-10-07 — **Phase 1 done** (outcome above). Learned on the way: the vendor groups a renamed
  stock's old and new contracts in one folder (handled, PR #68); catalog lock contention with the
  research servers can kill a long import after it wrote files (importer now waits up to 10
  minutes, judges days left by a crashed run, and resumes only when the staged row count is
  unchanged); NIFTY's usable range starts ~Sep 2024. Scope narrowed by the owner: stocks are not
  loaded further (BL-037, P3), and their forward collection from Fyers on monthly expiry days is
  BL-038 (P1).
- 2026-10-07 — **Value-level verification passed.** Row counts and checksums already matched, but
  that cannot catch a systematic value error, so every row of 158 randomly drawn ORIGINAL vendor CSVs
  (NIFTY 2025/2026 and stocks from the vendor's zips; SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY,
  NIFTYNXT50 re-downloaded from Drive) and of 25 random days per spot/VIX series was compared with
  the lake cell by cell: 957,290 option rows + 37,160 spot/VIX rows, zero differences, nothing
  missing on either side. A put-call-parity cross-check of the vendor spot against its own
  options agrees too (NIFTY 2025-03-12 within +-5 points all day; longer expiries differ by
  the cost of carry). Scripts: `packages/trading-data/scripts/vendor/verify_lake.py` and
  `verify_values.py` (BL-037's first task is to promote them to `tdata vendor verify`).
- 2026-10-07 — **Where it stands and what comes next.** Phase 1 is done and verified; the lake
  holds NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50 options from the vendor plus
  Fyers days, spot for all five indices and India VIX, and a `data_quality` verdict for every day.
  Open, in this order: (1) the owner asks the vendor for the 26 Aug → 24 Sep gap (BL-040 is the
  fallback; deadline 2026-11-03 to decide); (2) **Phase 2 — reference data** (observed expiries,
  dated lot sizes and strike steps for 2024-10 → today, `ref_rates`), the next piece of work and
  the one that lets legwise run pre-2026 days; (3) Phase 3 derived tables (NIFTY, SENSEX);
  (4) Phase 4 daily top-up under BL-012, after the owner decides on the scheduler cut-over
  (`deploy/launchd/install.sh`); (5) owner chores: keep a second copy of the staged Parquet, delete
  `~/TradingData.pre-bl034` after Phase 2 passes. Parked: BL-037 (the other 169 stocks, P3) and
  BL-038 (monthly-expiry stock collection, P1, first window 2026-10-27, needs a Fyers login).
- 2026-10-07 — **Phase 2 started** (owner: "lets go with BL-034 Phase 2"). First PR: lot sizes and
  strike steps 2024-10 → today for all six indices, keyed by the contract's expiry (not the trading
  day) and checked against the vendor volumes; the legwise engine sizes each leg from its own
  expiry. Before it, every legwise run on a day before 2026 raised "No lot_sizes row". Next:
  observed expiry calendar (and DTE back to 2024-10), the engine skipping `excluded` days,
  holidays audit, `ref_rates`.
- 2026-10-07 — Phase 2: **observed expiry calendar** (migration 009, `expiries_observed.csv`,
  `tdata reference derive-expiries`; three hand-added expiries for lake holes) — DTE now from
  2024-10, TODO 3.10.15 closed; **holidays audited** against the lake (8 added, 3 fixed).
- 2026-10-07 — Phase 2: **backtests leave out excluded days** — the engine reads a lock-free copy
  of `data_quality` (`quality/data_quality.parquet`), skips excluded days and names every day it
  could not run (no spot, no reference row) instead of crashing; `--include-excluded`.
- 2026-10-07 — Phase 2: **`ref_rates`** (migration 010, RBI repo rate by decision date) for Phase 3's
  IV. Phase 2's done-when met: every NIFTY/SENSEX lake day has a dated lot size and a real current
  expiry, DTE is emitted from 2024-10, and a NIFTY strategy runs 2024-10-01 → 2026-10-06 (492 days,
  2 excluded days named) with no code change.


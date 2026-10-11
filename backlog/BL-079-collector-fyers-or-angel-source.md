# BL-079 — Daily collector: Fyers when logged in, Angel One otherwise

| | |
|---|---|
| **Priority** | P1 — the 1-minute option data of an expiring contract cannot be downloaded later, and Fyers now needs a human tick each day |
| **Status** | Done (built 2026-10-10; confirm on the first evening without a Fyers login) |
| **Type** | feature |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-078 (Angel One spike), TODO 3.10 (`obt daily`) |
| **TODO.md row** | 1.12 |

## Context

Owner's rule (2026-10-10): drop the scheduled Fyers login; if the owner has logged into Fyers that
day, collect from Fyers, otherwise collect from Angel One. The 08:05 `fyers-login` job is already
removed (Fyers' login page has a human check; its refresh-token API is disabled; see BL-076).

Angel One logs in unattended over REST (client code, MPIN, TOTP; verified 2026-10-10), so it needs
no morning job: the collector logs in when it starts. BL-078's spike measured what it gives
compared with Fyers on NIFTY and on five MCX futures. Differences that matter here:

- NIFTY index: 14 minutes missing (15:15-15:28); index volume is 0.
- Options: close but not bar-identical (median worst-of-OHLC ₹0.30); volume in lots (x lot size);
  OI present (matches Fyers).
- MCX futures: no OI from `getOIData`; minutes with no trade are omitted.
- No expired contracts, like Fyers: forward-only.
- BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX (BFO) not yet tested.

## Goal

`obt daily` collects the day's data from Fyers when a valid token exists and from Angel One when
not, records which source each day came from, and no day is lost for want of a login.

## Out of scope

Momentum prices and the live quote screens (they keep their existing Fyers-or-public fallback)
unless the owner asks; any attempt to pass Fyers' human check.

## Plan

### Phase 1 — Spike the other underlyings
- **Tasks:** extend `research/bl078/angel_spike.py` to BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX
  (exchange BFO), and to strikes away from the ATM; count calls and note any rate-limit response.
- **Done when:** each underlying has the same field-by-field table as NIFTY, plus a call count
  for a full day's strike range.

### Phase 2 — Angel One collector
- **Tasks:** a provider beside `fyers/` that writes the same lake layout (`bars_1m_*` schemas);
  login inside the collector, one attempt, never retried on a rejection; scrip master for tokens;
  lot-size conversion of volume; a `source` recorded on the ingest run and the day's
  `data_quality` row; the index gap handled as decided (open question 2).
- **Done when:** a day collected from Angel One passes `data_quality` and `obt legwise run` on it
  completes; unit tests with recorded responses.

### Phase 2b — Day flags and the dashboard banner
- **Tasks:** record per day its source and what is missing (`source`, `missing_oi`,
  `index_gap`, `thin_minutes_filled`) in `data_quality` / the ingest run; an API field and a
  dashboard banner on every flagged day; a "repair from Fyers" step run by `obt daily` (and
  retries) whenever a Fyers token is valid and recent days are flagged.
- **Done when:** a flagged day shows the banner, and after a Fyers login the repair clears it for
  every contract still live.

### Phase 3 — Source selection in `obt daily`
- **Tasks:** at start, probe the stored Fyers token (the profile probe the status endpoint
  uses); valid -> Fyers collector, else Angel One; Telegram line saying which; both unavailable ->
  alert. Retries (17:45, 19:15) re-evaluate, so a Fyers login made during the evening is used.
- **Done when:** with the Fyers token cleared, `obt daily` collects from Angel One and says so;
  with it valid, from Fyers.

### Phase 4 — Momentum backup source
- **Tasks:** `mbt fetch` and the live quote paths try Fyers, then Angel One (daily candles, LTP),
  then the public sources; the Telegram line says which source was used.
- **Done when:** with the Fyers token cleared, `mbt fetch` completes from Angel One.
- **Status:** built 2026-10-10, see the Log entry "Phase 4 built". `mbt fetch` itself was not run
  against the real data folder (it rewrites `weekly_closes.csv`); it was exercised offline and the
  client was checked live on one session.

### Phase 5 — Docs
`technical.md`, the Guide's Jobs and Broker logins pages, `deploy/launchd/README.md`.

## Risks

- The two sources are not bar-identical: a series that mixes them differs by about ₹0.30 on option
  bars, which can move a tight stop. Mitigated by recording the source per day (open question 3).
- Angel One's static-IP whitelist: data calls worked from the registered home IP; a changed home IP
  could reject them (untested).
- One Angel One login per run; a wrong MPIN counts toward an account lockout.

## Decisions (owner, 2026-10-10)

1. **Source:** Fyers when its token is valid; otherwise Angel One only. No shadow copy of the second
   source on ordinary days.
2. **Index gap** (Angel One's missing 15:15-15:28, or a Fyers gap): do not fill it. Flag the day
   (a warning that shows on the day and in the Telegram summary) and keep the data.
3. **Cross-check** (the owner's "confirm with the other broker", as understood): where both
   sources are reachable, compare a small sample (index, VIX, one ATM CE/PE) against the other
   source and flag a mismatch beyond tolerance, instead of mixing the two silently. Interpretation
   to be confirmed with the owner when Phase 3 is built.
5. **SENSEX without OI is accepted** on Angel One days (its OI endpoint rejects BFO). Instead of
   skipping, flag it: a banner on every day collected from Angel One saying what is missing (OI for
   SENSEX, the index minutes 15:15-15:28, minutes with no trade) and asking for a Fyers login. The
   owner will try to log into Fyers every day; Angel One is the fallback when that did not happen.
   **Repair:** once a Fyers token is valid, a day flagged Angel One is re-collected from Fyers for
   the contracts that have not expired yet (Fyers serves earlier days of a live contract; verified
   for MCX futures on 2026-10-10), replacing the Angel One rows and clearing the flag. Contracts
   that expired in between stay as Angel One data.
4. **Momentum:** add Angel One as a backup price source, after Fyers and before the public sources.
   Out of scope for the collector phases; its own phase below.

## Log

- 2026-10-10 — created from the owner's rule after BL-078's spike. `fyers-login` removed from the
  scheduler the same day.
- 2026-10-10 — owner's decisions recorded (above); status In progress; TODO 1.12 added; Phase 1 started.
- 2026-10-10 — **Phase 1 done** (`research/bl078/underlyings_spike.py`, session 2026-10-09, nearest
  expiry shared by the master and the lake, ATM strike, 1 index + CE + PE + OI + nearest future per
  underlying, 24 Angel calls, one login).

  | Underlying | Index minutes (of 375) | ATM CE / PE minutes (of ~385) | OI vs Fyers | Volume unit |
  |---|---|---|---|---|
  | BANKNIFTY (monthly, 27 Oct) | 361 | 376 / 376 | 373/376, 372/376 equal | lots (ratio 1/30) |
  | FINNIFTY (27 Oct) | 361 | 124 / 133 (thin) | 119/124, 125/133 | lots (1/60) |
  | MIDCPNIFTY (27 Oct) | 361 | 290 / 245 (thin) | 278/289, 221/244 | lots (1/120) |
  | SENSEX (BSE, 15 Oct) | 361 | 376 / 376 | **none: `getOIData` rejects BFO, AB1012** | lots (1/20) |

  - The index gap is the same on all five: **15:15-15:28 is missing**, every time. It is the feed,
    not a one-off, so it is a standing flag on any Angel One day.
  - **Thin contracts lose minutes**: Angel returns a bar only for a minute that traded (FINNIFTY
    ATM call 124 of 382, FINNIFTY future 74 of 383); Fyers has a bar for every minute. The
    collector must record "no trade" explicitly (forward-fill the close, volume 0) so the engine
    sees the same grid.
  - Option OHLC: within 0.1% of price on 73-77% of BANKNIFTY and SENSEX option bars; futures
    100%. Not bar-identical, as for NIFTY.
  - OI is available for NSE F&O and **not for SENSEX options**; so an Angel One SENSEX day has no
    OI at all.
  - Untested: the rate limit at a full strike range (about 4 calls per strike per underlying), a
    non-whitelisted IP, deep out-of-the-money strikes.
- 2026-10-10 — owner accepted SENSEX without OI on Angel One days, with a daily banner and a Fyers-login repair (decision 5). Phase 2 started.
- 2026-10-10 — **Phase 2 built and checked on a full day.** `option_backtesting/angelone/`
  (`auth.py`, `symbols.py`, `client.py`) drives `fyers.daily.collect_day` unchanged apart from a
  `source` argument and a `bind_contracts` hook; `obt angel status|fetch` runs it. The Fyers
  tickers stay the instrument identity, so the lake, catalog and data-quality code are shared.
  Handled in the client: volume lots -> quantity, no-trade minutes carried forward from the first
  trade (flat bar, volume 0, last OI), OI via `getOIData` (NFO only), the index gap flagged and
  not filled. 11 unit tests, including a whole day through the collector against a faked API.

  Real run: NIFTY, 2026-10-09, into a scratch `TRADING_DATA_ROOT` (the real lake was not touched):
  **515 requests in 3 min 39 s, 0 errors, no rate-limit response** at 0.4 s pacing. Against the
  Fyers lake for the same day:

  | | Angel One | Fyers |
  |---|---|---|
  | Contracts | 231 | 236 (5 absent: 4 not in Angel's master, 1 with no bars) |
  | Option bars | 85,249 | 88,917 (Fyers also has 15:30-15:39) |
  | Common bars with identical OHLC | 58,157 of 85,247 (68%) | |
  | Common bars within ₹0.5 | 81,263 (95%) | |
  | OI equal on common bars | 83,631 of 85,247 (98%) | |
  | Volume equal on minutes Fyers traded | 43,437 of 62,060 (70%); median ratio 1.0 | |

  Run flags recorded: 14 index minutes missing, 23,201 minutes carried forward across 151 thin
  contracts, 4 unmapped contracts, OI available. Not done yet: Phases 2b (banner + repair), 3
  (source selection in `obt daily`), 4 (Momentum backup), 5 (docs).
- 2026-10-10 — **Phases 2b, 3 and 5 built** (Phase 4 handed to a separate agent, see its entry).
  - `legwise/evening.py`: `collect_with_fallback` tries Fyers; a missing, expired or rejected token
    (`FyersCredentialsError`, raised before any bar is written) sends the same day to Angel One. An
    Angel One login failure is not swallowed. When Fyers works, `repair_from_fyers` re-collects the
    last 7 days that came from Angel One with `force` + `merge_existing`; contracts no longer
    listed keep their Angel One rows (counted in `details.repair.kept_existing_contracts`), and
    each repaired day is re-judged and its strategies re-run.
  - The source of a day is the latest `bars_1m` run that wrote rows (`legwise/source.py`); a
    retry that found everything collected writes nothing and does not change it.
  - Telegram and the log now carry a Source section (why Angel One, what is missing); the message
    is `warn` on an Angel One day.
  - `GET /legwise/source` and a dashboard banner (`DataSourceBanner`) listing unrepaired Angel One
    days with a Login-with-Fyers button.
  - Docs: Guide Jobs and Broker logins pages, `deploy/launchd/README.md`, `technical.md`.
  - Tests: `test_evening_source.py` (fallback, repair, rejected-token stop, Angel failure
    propagation, merge keeps unlisted contracts, source read-back), `test_api_legwise.py` (the
    endpoint), `dataSource.test.ts`.
- 2026-10-10 — **Phase 4 built: Angel One is Momentum's backup price source**
  (`packages/momentum-backtesting/src/momentum_backtesting/angelone.py`, its own copy of the
  client: the two Python packages share no code).
  - **Order:** Fyers token valid (stored token not expired, and `fyers.probe_token` does not say
    "rejected") -> Angel One -> the public sources. `angelone.resolve_prices()` is the one place
    that decides; it re-raises the Fyers error when neither broker works, so every caller keeps its
    "no token" handling and message. `--no-fyers` still means public only and never looks for a
    broker. `mbt fetch` with neither broker still stops (a public-only fetch would drop most index
    series), as it did.
  - **Wiring:** `AngelSource` is passed where Fyers `Credentials` go; `fyers.daily_candles /
    daily_ohlcv / daily_closes / quotes / price_at` hand it the call, so callers did not change
    shape. Sites moved to `resolve_prices`: `fetch_all` (`mbt fetch`), the weekly job
    (`_execute_weekly_run` -> `weekly.refresh` / `live_prices`, incl. the Broad live preview), the
    dashboard rebalance preview, `_order_prices` (Your orders), and the `mbt stocks sync` Fyers
    fallback (stock top-ups). Left on Fyers alone: `mbt login`, token status, holdings sync (they
    are about the Fyers account itself).
  - **Unmapped instruments** go to the public source exactly as with no token (`fyers.serves`):
    niftyindices for an index with a backfill name, Yahoo for an ETF, else ETF-implied. An Angel One
    error on one series does the same for that series; a rejected session marks the source dead so
    the rest of the run uses public data. One login per process (reused up to 10 h); a rejected
    login is not repeated for 6 h.
  - **Telegram:** the weekly "Data ·" line reads `Fyers: no valid token · prices from Angel One
    (angel one 18, niftyindices 3, ETF-implied 1) · ...`; live preview kinds read `angel one live`.
    On a Fyers day the line is unchanged.
  - **Live check (one real session, 2026-10-10, read-only):** login ok; of 45 NSE series in the
    universe 41 map and 4 do not (Nifty Capital Markets, Chemicals, India Defence, Healthcare
    indices; all four have a public path or are ETF-implied). Nifty 50, NIFTYBEES and GOLDBEES daily
    candles for the last 9 sessions were identical to the stored Fyers-sourced files to the paisa
    (max abs diff 0.0000). LTP quote shape confirmed (`data.fetched[].{exchange, symbolToken,
    ltp}`; Nifty 50, Nifty Bank, NIFTYBEES, GOLDBEES came back). 15-minute candles work (10:00
    price from the 09:45 candle). A daily request whose from-time is `09:15` drops that day's own
    candle (stamped 00:00), so the client sends `00:00`. A 2016-to-today Nifty 50 history in 4
    calls returned 2657 days on the same dates as the stored file; **52 of those days differ from
    the stored Fyers-era file by more than 0.5 index points (largest 40.3, about 0.2%)**. Which
    days was not captured (only one login allowed); worth a follow-up that lists them before a
    full `mbt fetch` is ever run from Angel One, since the stored file also holds ETF-implied
    estimates on days the weekly job lacked a close.
  - **Tests:** `tests/test_angelone.py` (37, all against a faked API): login (no retry, secrets
    scrubbed), symbol mapping, candles/quotes shape and chunking, rate-limit back-off, rejected
    session, the Fyers hook, source choice and the one-login rule, `weekly.refresh` /
    `live_prices` / `fetch_all` on Angel One. `tests/conftest.py` gained an autouse fixture that
    blocks the real Angel One transport, scrip-master download and Fyers probe for the whole
    suite. Full momentum suite 1428 passed (goldens unchanged), ruff clean.
- 2026-10-10 — all phases built. To watch on the first evening with no Fyers login: the Telegram message's Source section, the dashboard banner, and that the next Fyers login clears the banner after the following run.

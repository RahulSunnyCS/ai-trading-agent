# BL-078 — Angel One SmartAPI as a second 1-minute data source

| | |
|---|---|
| **Priority** | P1 — Fyers needs a human tick every trading day (BL-076/077), and an expiring contract's 1-minute data cannot be re-downloaded |
| **Status** | Done 2026-10-24 — go as a backup source, not a replacement; shipped as BL-079 |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-034 (lake), TODO 3.10 (`obt fyers fetch`) |
| **TODO.md row** | 1.12 (through BL-079) |

## Context

The daily collector (`packages/option-backtesting/src/option_backtesting/fyers/`) writes 1-minute
OHLC + OI for the index, India VIX, two nearest futures and every option strike in the day's
traded range, forward-only. Its token needs a human to pass Fyers' human check each day
(BL-076 dropped, BL-077). Angel One's SmartAPI logs in over REST with client code, PIN and TOTP,
and serves candles for NSE/NFO. From forum posts (not official docs): candles are OHLCV only, OI
is a separate `getOIData` endpoint reported to return blanks, ~500 candles per call, no expired
contracts.

## Goal

A measured answer to: can Angel One replace the Fyers collector, or only back it up, and what
fields does it lack?

## Out of scope

Order placement, and any change to the lake or the collector in this phase.

## Plan

### Phase 1 — Spike (read-only, nothing written to the lake)
- **Tasks:** one SmartAPI login; for the last closed session fetch 1-minute candles for the index,
  India VIX, the nearest future and one ATM CE/PE of the nearest weekly; fetch OI for the option;
  compare to the Fyers lake for the same day: minute coverage, OHLC and volume equality, OI
  present or not; record call counts and limits met.
- **Deliverables:** findings in the Log: per field, equal / differs / missing.
- **Done when:** the table above is filled from real responses, and a go / no-go is written.

### Phase 2 — Adapter and collector (only if Phase 1 says go)
Written then, with the gaps Phase 1 finds as its constraints.

## Risks

- Static-IP whitelist rejecting calls when the home IP changes.
- A login lockout from repeated failures: one attempt per run, never retried on a rejection.

## Open questions

- Whether OI is needed from this source or Fyers stays the OI source.

## Log

- 2026-10-10 — created. App key, client code and PIN are in `.env`; the TOTP seed is
  `ANGELONE_TOTP_SECRET` (confirmed against the owner's authenticator). Phase 1 started.
- 2026-10-10 — **Phase 1 spike done** (`research/bl078/angel_spike.py`; session of 2026-10-09,
  NIFTY, nearest weekly 2026-10-13, ATM 22500, compared to the Fyers lake). Read-only; nothing
  written to the lake. One login per run, all four succeeded; about 15 calls per run, paced at
  0.5 s, no rate-limit response seen.

  | Field | Result |
  |---|---|
  | Login | `loginByPassword` with client code + MPIN + TOTP: HTTP 200, no human check, no browser |
  | Index (NIFTY) 1m | OHLC equal to Fyers on 357 of 361 bars; **missing 15:15-15:28 (14 minutes)**; volume always 0 |
  | India VIX 1m | OHLC equal on 374 of 375 bars; same minutes |
  | Future (Oct) 1m | Same contract as Fyers' `NIFTY26OCTFUT`: median close difference 0.0, 210 of 376 bars fully equal; Angel volume is in lots (ratio 1/65) |
  | Option 1m OHLC | Close but **not the same bars**: median worst-of-OHLC difference ₹0.30, 97% of bars within ₹1, 2-4% within ₹0.05 |
  | Option volume | Equal to Fyers after x65 (lots to quantity): median ratio 1.00, p10-p90 0.99-1.01 |
  | Option OI (`getOIData`) | **Present**, 376 rows of `[time, oi]`; equals Fyers on 369 of 376 minutes, within 1% on 375 |
  | Expired contracts | Not served: the scrip master lists only live contracts (earliest NIFTY option expiry 2026-10-13) |
  | After-close minutes | Angel stops at 15:30; Fyers has 15:31-15:39 |

  **Not tested:** BANKNIFTY / MIDCPNIFTY / FINNIFTY / SENSEX (BFO), strikes outside the ATM, the
  rate limit at a full day's volume (hundreds of contracts x two calls), a call from a
  non-whitelisted IP, and the token's lifetime.

  **Reading:** Angel One can do the daily forward capture unattended and carries OI, VIX and
  volume, so it can stand in for Fyers on the days Fyers has no token. It is not bar-identical
  on options (worst-of-OHLC about ₹0.30 off) and drops the last 14 index minutes, so a backtest
  must not mix the two sources inside one series without a decision on which wins. It adds no
  history: forward-only, like Fyers.
- 2026-10-10 — **Phase 1b: MCX commodities, Fyers vs Angel One** (`research/bl078/commodity_spike.py`,
  session 2026-10-09, nearest futures, same expiry on both sides). Futures only; commodity options
  were not tested.

  | Contract | Angel minutes | Fyers minutes | OHLC equal on common | Volume ratio |
  |---|---|---|---|---|
  | CRUDEOIL Oct | 868 | 870 | 505 of 868, median worst diff 0.0 | 1.0 |
  | GOLDM Nov | 870 | 870 | 497 of 870, median 0.0 | 1.0 |
  | SILVERM Nov | 866 | 870 | 418 of 866, median 1.0 | 1.0 |
  | NATURALGAS Oct | 866 | 870 | 634 of 866, median 0.0 | 1.0 |
  | COPPER Oct | 768 | 870 | 302 of 768, median 0.05 | 1.0 |

  - Both serve the full MCX session 09:00-23:29 (870 minutes). Volume is in the same unit on
    both (ratio 1.0); unlike NFO there is no lot-size factor.
  - **Angel omits minutes with no trade** (COPPER: 102 of 870 absent); Fyers returns a bar for
    every minute (116 zero-volume bars for COPPER, carried flat). A backtest on Angel data must
    forward-fill, or treat a missing minute as "no trade".
  - **OI:** Fyers carries it on every bar (870 of 870 non-zero on CRUDEOIL and COPPER).
    **Angel's `getOIData` returned no rows for any of the five MCX futures**, though it works for
    NFO options (Phase 1). So Angel is not an OI source for commodities.
  - **Shoonya not tested: its API needs three values that are not in `.env`.** The AlgoTest login
    credentials (`SHOONYA_CLIENT_ID`, `SHOONYA_PASSWORD`, `SHOONYA_TOTP_SECRET`) are present, but
    the Noren API also requires a vendor code, an API secret key and an IMEI string, all issued
    from Shoonya Prism's API key page. Protocol (from `ShoonyaApi-py`, NorenApi.py): POST
    `https://api.shoonya.com/NorenWClientTP/QuickAuth`, body `jData=<json>`, fields `uid`,
    `pwd` = sha256(password), `factor2` = TOTP, `vc`, `appkey` = sha256(`uid|api_secret`), `imei`,
    `source: API`; later calls `jData=...&jKey=<susertoken>`; candles from `/TPSeries`
    (`exch`, `token`, `st`, `et`, `intrv` of 1,3,5,10,15,30,60,120,240) and `/EODChartData`;
    masters from `/NFO_symbols.txt.zip` style files. Whether `/TPSeries` carries OI, how far back it
    goes and its rate limit are unverified.
- 2026-10-10 — **Phase 1c: Shoonya attempt, no result yet.** `SHOONYA_API_KEY` is in `.env`; vendor
  code and IMEI are not, so the spike (`research/bl078/shoonya_spike.py`) used `<uid>_U` and a
  fixed string. `api.shoonya.com/NorenWClientTP/*` answered **HTTP 502 from nginx on every route**
  (QuickAuth and a no-credential GetQuotes probe, repeated), on a Saturday afternoon, while the
  static masters (`NSE|NFO|MCX_symbols.txt.zip`) and the site root returned 200. The login never
  reached authentication, so no credential was tested and nothing counts toward a lockout. To
  repeat on a weekday before 08:30 IST and again in market hours, to see whether the API is simply
  down outside the week. Whether `<uid>_U` is the right vendor code is still unconfirmed.
- 2026-10-24 — closed. Verdict: **go, as a backup** (Phase 1's field table: Angel One can stand in for Fyers' daily collection, not replace its files). Phase 2 shipped as BL-079 (Done 2026-10-10: `obt daily` falls back to Angel One; TODO 1.12), and Angel One's VIX is in daily use. The 1c Shoonya re-probe is dropped: nothing needs it now that BL-143 reads Finvasia's margin through AlgoTest.

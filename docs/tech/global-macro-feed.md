# The Global Macro Feed

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series. This is
> the data source behind 5 of the 9 factors in
> [The Probability Scorer](./probability-scorer.md). Source:
> `src/ingestion/global-macro-feed.ts`.

`GlobalMacroFeed` is the system's only reach into **global** (non-Indian) market
data. It polls Yahoo Finance for five instruments and caches them in Redis; the
scorer reads that cache when grading a signal.

## Producer / consumer split

Like the rest of the system, it's decoupled through Redis:

```
GlobalMacroFeed.start() ── setInterval ──► _doPoll() ── fetch ×5 ──► Redis (macro:*, TTL 900s)
                                                                          │
peak-detection-engine ──► getMacroContext(redis) ◄────────────────────────┘
                                returns MacroContext (null per missing key)
```

- **Producer** (`GlobalMacroFeed`) is a long-running poller; **consumer**
  (`getMacroContext`) is a pure read used inside the signal pipeline.
- They share nothing but the Redis keys `macro:us_vix`, `macro:sp500`,
  `macro:dax`, `macro:crude_oil`, `macro:gold`.

## The five instruments

| Scorer key | Yahoo ticker | What it is |
|---|---|---|
| `us_vix` | `^VIX` | US volatility (fear gauge) — scorer reads its **level** |
| `sp500` | `^GSPC` | S&P 500 — scorer reads **change_pct** |
| `dax` | `^GDAXI` | German DAX — change_pct |
| `crude_oil` | `CL=F` | WTI crude future — change_pct (abs) |
| `gold` | `GC=F` | Gold future — change_pct |

Each stored value is a `MacroDataPoint { value, change_pct, timestamp }` where
`change_pct = ((regularMarketPrice − regularMarketPreviousClose) / prevClose) ×
100` — i.e. a **daily** change vs the previous session close, which is exactly
what the scorer's percentage thresholds expect.

## How polling works (`_doPoll`)

1. **Window gate** — skip silently if `clock.now()` is outside the IST poll
   window (`MACRO_POLL_START`/`END`, default 08:00–23:00). No point burning calls
   when US/EU markets are closed overnight. `clock.now()` is used *only* for this
   check.
2. **Parallel fetch** — all five via `Promise.allSettled`, so one instrument's
   failure can't block the others.
3. **Store** — each successful point is `SET macro:<key> <json> EX 900`.

The timer uses a native `setInterval` (not `clock.tick`) because this is
production-only code — tests mock `fetch` directly and call `_doPoll()`. The
**first poll fires after one full interval**, not immediately, to avoid a
startup burst — so there's a cold-start window (~5 min) where `getMacroContext`
returns all nulls (the scorer treats those as 0, i.e. neutral).

### Per-instrument fetch resilience (`fetchInstrument`)
- **Never throws** — every error path returns `null`.
- **5 s timeout** via `AbortSignal.timeout(FETCH_TIMEOUT_MS)`.
- **Retry policy**: retry **once on network errors only** (DNS, refused,
  timeout). HTTP status errors (429 rate-limit, 404 bad symbol) are **not**
  retried — an immediate retry would just trip the rate limit again.
- **Defensive shape validation** — Yahoo's response is checked at every level
  (`chart.result` array, `meta.regularMarketPrice`/`PreviousClose` numeric)
  because this is an undocumented public endpoint that can change without notice.
  A `User-Agent` header is required or Yahoo rejects the request.
- **Divide-by-zero guard** on `prevClose === 0`.

## How reads work (`getMacroContext`)

Reads all five keys in parallel. For each: absent key → leave `null`; present →
`JSON.parse` + a basic shape check (corrupt value → warn + `null`). It **never
throws** — every per-key error is caught and degraded to `null`. The result
feeds straight into the scorer, where any `null` contributes a 0 adjustment.

## Insights worth noting

1. **Staleness is enforced by Redis TTL, not by code.** The 15-minute `EX 900`
   TTL is the freshness guarantee: data older than that simply *vanishes* from
   Redis, so the read returns `null`. `getMacroContext` doesn't compare
   `timestamp` against "now" at all — "stale ⇒ absent ⇒ null ⇒ neutral" flows
   cleanly end-to-end. The poll interval (5 min) refreshes well inside the TTL,
   so a single failed poll cycle still leaves valid data; ~3 consecutive failures
   are needed before a key expires.
2. **This is the system's most fragile external dependency — and it's
   deliberately contained.** Yahoo's chart API is public, unauthenticated, and
   undocumented (hence the `User-Agent` spoof and exhaustive shape checks). But
   because every failure degrades to `null` → 0 adjustment, an outage *quietly
   removes the macro overlay* rather than breaking signal generation. Macro
   context is supplemental, never load-bearing.
3. **Fail-soft at three layers** — `fetchInstrument` (null on any error),
   `_doPoll` (`allSettled` isolates per-instrument failures), `getMacroContext`
   (per-key try/catch). No single bad instrument can poison the others or the
   pipeline.
4. **`value` vs `change_pct` split matches the scorer.** This feed stores both;
   the scorer reads `us_vix.value` (a level) but `sp500/dax/gold.change_pct`
   (signed daily moves) and `crude_oil` as an absolute change. The
   producer/consumer agree on semantics per instrument.
5. **No write races by construction.** Both the poll-store loop and the
   read loop touch a *distinct* Redis key / context field per instrument, so the
   parallel `Promise.all`/`allSettled` fan-outs need no locking.
6. **Interval guard against self-DoS.** `MACRO_POLL_INTERVAL_MS` below 10 s is
   rejected and reset to 300 000 ms, so a misconfig can't flood Yahoo (it
   reassigns the `readonly` field via a cast — an init-time-only escape hatch).

## Related code
- `src/ingestion/global-macro-feed.ts` — this feed + `getMacroContext`.
- `src/signals/probability-scorer.ts` — consumes `MacroContext` (factors 2–6).
- `src/signals/peak-detection-engine.ts` — calls `getMacroContext` with a
  fail-soft all-null fallback before scoring.

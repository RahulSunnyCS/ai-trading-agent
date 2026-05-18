# Security Audit Report

Branch: `claude/implement-milestones-0-1-JsHLr`
Scope: Secrets management, broker WebSocket/API data safety, SQL injection, API
input validation, process crash vectors. User auth / sessions / PII / payments
are explicitly out of scope (none exist in this project).

## Summary

Verdict: **CONDITIONAL PASS**

The credential-handling discipline is genuinely good: tokens are masked to a
4-char prefix in every log line, the TOTP secret is never logged, secrets stay
in memory only, `.env.example` contains only placeholders, lefthook blocks
`.env*` commits, `.env` is gitignored, no `.env` file is tracked, all SQL is
parameterised, and the lockfile (`bun.lock`) is committed. No Critical findings.

The conditions for full pass are: (1) fix the Angel One env-var name mismatch
between `.env.example` and `broker-factory.ts`, which is a real
misconfiguration footgun that can cause silent credential failure during
market hours; (2) add a global `unhandledRejection` / `uncaughtException`
process guard so a single rejected promise on a fire-and-forget path cannot
silently kill the trading loop. Both are Medium. The remaining items are Low /
informational.

## Findings

### 🔴 Critical

None.

### 🟡 Medium

**M1 — Angel One env-var name mismatch (`.env.example` vs `broker-factory.ts`)**
`broker-factory.ts` reads `AO_API_KEY`, `AO_CLIENT_CODE`, `AO_CLIENT_PIN`,
`AO_TOTP_SECRET` (`src/ingestion/brokers/broker-factory.ts:131-140`), but
`.env.example:45-48` documents `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`,
`ANGEL_CLIENT_PIN`, `ANGEL_TOTP_SECRET`. An operator who copies `.env.example`
and fills in real Angel One credentials (including the high-sensitivity TOTP
secret and client PIN) will have those secrets sitting in env vars the code
never reads, and `BROKER=angelone` will throw "missing env vars" at startup
despite the secrets being present. The security-relevant consequences: (a)
operators may paste real credentials into the wrong-named vars and, while
debugging the startup failure, be tempted to log/echo the environment to find
the mismatch — exposing the TOTP secret and PIN in shell history or logs; (b)
the failure mode surfaces during live market hours when Angel One is needed as
the fallback broker, exactly when it is least safe to be hand-editing secret
env vars. Fix: make the names consistent. Recommended — standardise on the
`ANGEL_*` names in `broker-factory.ts` (they are clearer than `AO_*` and match
the documented `.env.example`), or update `.env.example` and the
broker-factory doc comments to `AO_*`. Pick one prefix and use it in all three
places (`.env.example`, the `process.env.*` reads, and the doc comments).

**M2 — No global `unhandledRejection` / `uncaughtException` guard; trading
loop can die silently** `src/index.ts` registers SIGTERM/SIGINT handlers but
no `process.on("unhandledRejection")` or `process.on("uncaughtException")`.
Several hot paths are deliberately fire-and-forget:
`StraddleCalculator._publishToRedis` (`straddle-calc.ts:235-247`) chains
`.then().catch()` but a throw inside the `.then()` callback after the final
`.catch()` is attached is still covered — however `vix-feed.ts:186`
(`void this._poll()`), `position-monitor.ts:171` and the
`streamConsume` top-level IIFE (`redis/client.ts:169`) rely on their own inner
`try/catch`. Any future code path, or an unexpected synchronous throw inside an
async tick callback (e.g. `Decimal` constructor throwing on a malformed stream
field — see L1), that escapes these local catches becomes an unhandled
rejection. Under Bun/Node this can terminate the process with no operator
signal, taking the trading loop down mid-session. Fix: in `src/index.ts` add
`process.on("unhandledRejection", ...)` and
`process.on("uncaughtException", ...)` that log at fatal level (with the
existing token-redaction discipline — log `err.message`, never the raw env)
and trigger the existing graceful `shutdown()` rather than letting the process
die abruptly or, worse, continue in an undefined state.

### 🟢 Low / Informational

**L1 — Untrusted Redis stream values flow into `new Decimal()` without a
guard** `position-monitor.ts` and `trigger-engine.ts` build `new Decimal(...)`
directly from `fields.straddleValue` / `position.*` values that originate from
Redis stream messages (`trigger-engine.ts:93-97`,
`paper-trade-executor.ts:74,186`). `new Decimal("abc")` throws. `entry-engine`
guards `straddleValue === ""` but not non-numeric content, and the
position-monitor path passes the value into `updateTrailingStop` /
`evaluateTriggers` which call `new Decimal()` with no try/catch. A malformed or
hostile stream message (anyone with Redis access — see L2) could throw inside
the snapshot handler. The handler error is caught by `streamConsume`'s
per-message `try/catch` (`redis/client.ts:162-166`) so the process survives and
the message stays pending, which is acceptable containment — but the message
will be redelivered and fail forever (poison message), and combined with M2 any
path that throws outside that catch is fatal. Fix: validate stream numeric
fields (e.g. `Number.isFinite(Number(v))`) before constructing `Decimal`, and
skip + warn on poison messages so they are ACKed/dead-lettered rather than
retried indefinitely.

**L2 — Redis and PostgreSQL connections are unauthenticated by default**
`redis/client.ts:5` defaults `REDIS_URL` to `redis://localhost:6379` (no
password) and `docker-compose.yml` uses `POSTGRES_PASSWORD: trading` (dev-only,
documented as override-in-prod). The Redis stream is the trust boundary for all
trade decisions — anything that can `XADD` to `straddle.values` can drive the
entry/position engines. For a single-operator localhost research tool this is
an accepted risk (documented in `business.md`), but it should be called out:
if this is ever exposed beyond loopback (Railway/Fly.io deploy), an
unauthenticated Redis is a direct path to injecting fabricated market data and
forcing paper trades. Recommendation: document a hard requirement that any
non-local deployment must set a Redis password (`requirepass`) and a strong
`POSTGRES_PASSWORD`, and bind Redis to loopback in dev compose.

**L3 — CORS default `*` is acceptable here, with a caveat** `server.ts:57-59`
defaults `CORS_ORIGIN` to `*`. Per `business.md` this is a single-operator,
non-public tool with no auth and only read-only GET endpoints plus a read-only
WebSocket, so `*` is acceptable as documented. Caveat: the API exposes full
paper-trade history and live straddle data with no auth at all; `*` plus no
auth means any web page the operator visits while the server is reachable can
read this data cross-origin. Low impact (research data only, no PII, no
mutation endpoints). Recommendation: keep the env override and document setting
`CORS_ORIGIN` to the dashboard origin for any non-localhost deployment.

**L4 — Broker error objects emitted to consumers may carry SDK internals**
`fyers.ts:363` wraps the broker error message into a new `Error` and emits it;
`angelone.ts:320,337,341` similarly include `response.message` /
`(err as Error).message` in thrown errors. The credential-redaction discipline
in these files is good (only 4-char prefixes, TOTP never logged), and Fyers/
Angel One error messages are not expected to echo back the token. This is
informational: when adding any new logging of caught broker errors, continue to
log `err.message` only and never `JSON.stringify(err)` or the raw config
object, since SDK error objects can sometimes attach the request (which for the
auth call contains the PIN/TOTP). Current code is compliant; flagging to keep
it that way.

**L5 — `.env.example` credential-scan hook is a heuristic, not a guarantee**
`lefthook.yml:22-37` scans `.env.example` for alphanumeric strings ≥25 chars
containing a letter and a digit. A real Fyers access token or Angel API key
that happens to be shorter than 25 chars, or all-letters, would pass the scan.
The current `.env.example` is clean (placeholders only), so no live issue.
Informational: the hook is a useful backstop but should not be relied on as
the sole control — the env-guard hook blocking `.env*` commits is the real
protection and it is correctly scoped.

**L6 — Migration runner executes raw SQL files (expected, noted for
completeness)** `db/migrate.ts:164` runs `client.query(sql)` with the full
contents of each migration file. This is standard and correct for a migration
runner — migration files are trusted, version-controlled, developer-authored
artifacts, not user input. No action needed; recorded so it is not re-flagged
as "SQL execution from a string."

## Accepted / Out-of-scope

- **User authentication / sessions / PII / payments** — none exist in this
  project (`business.md`); explicitly out of audit scope per the risk manifest.
- **CORS `*` default (L3)** — accepted for the single-operator localhost
  research tool per project context; surfaced as Low with a deployment caveat
  rather than a blocking finding.
- **Dev-only DB/Redis credentials (L2)** — accepted for local dev; flagged Low
  with an explicit non-local-deployment hardening requirement.
- **SQL parameterisation** — reviewed in full: every query in `dashboard.ts`,
  `paper-trades.ts`, `trades.ts`, `straddle-calc.ts`, `paper-trade-executor.ts`,
  `entry-engine.ts`, `position-monitor.ts`, `migrate.ts` uses `$1..$n`
  parameter binding. The dynamic `statusClause` in `paper-trades.ts:149-158`
  builds only parameter placeholders (`$N`), never interpolated values, and the
  status value is additionally AJV-enum-validated. No SQL injection found.
- **API input validation** — all routes use Fastify AJV schemas;
  `paper-trades.ts` validates `date` with a strict `^\d{4}-\d{2}-\d{2}$`
  pattern, `status` with an enum, `page` as a bounded integer, and
  `additionalProperties: false`. Adequate.

# Security Audit Report — M4 EOD Retrospection + Rule-Based Evolution

Scope: migration 010, daily-metrics, brier-score, management-effectiveness,
evolution-engine, eod-retrospection-job, retrospection API routes, server wiring.

Context: paper-trading research tool, single instance, no user auth by design.
Risk flags: backend, financial-logic. The threat model here is data-integrity
and the protection of the Clockwork benchmark and the comparison group — not
classic web auth. The audit weighs findings accordingly.

---

## 🔴 Critical

None.

No SQL injection, no FROZEN_VIOLATION bypass, and no financial-logic corruption
path was found that would silently produce wrong numbers or mutate a protected
row. The parameterisation, NUMERIC-as-string handling, and is_frozen checks are
all correct on the paths examined.

---

## 🟡 Medium

### M1 — Evolution engine ignores the injected pool; uses the module singleton for all locked writes
File: `src/retrospection/evolution-engine.ts:97-177` (and `src/db/client.ts:67`)

What it is: `runEvolutionEngine(pool, …)` accepts a `pool` parameter, but the
transaction body uses `withTransaction(...)` from `db/client.ts`, which always
binds to the module-level singleton pool — the `pool` argument is never used.
The function header documents this as intentional. In production it happens to
be harmless because `src/index.ts` passes the same singleton pool into
`startServer`, so the worker pool and the transaction pool point at the same
database. But the contract is a lie: the SELECT FOR UPDATE lock, the
FROZEN_VIOLATION re-check, the cooldown read, and the autonomous-mode write all
run on the singleton, while the *metrics* fed in were computed against the
injected pool.

Why it matters: the moment anyone deploys or tests with a different pool (a test
harness injecting a transactional/mock pool, or a future refactor that gives the
worker its own pool against a read replica or a second database) the lock and
the write silently target the wrong database. The frozen-guard and cooldown
checks would then run against rows that are not the ones being read elsewhere,
defeating the entire TOCTOU protection the SELECT FOR UPDATE was added to
provide. This is the single most fragile assumption in the milestone.

How to fix it: make `withTransaction` accept an optional pool/client
(`withTransaction(fn, pool)`), and have `runEvolutionEngine` thread its `pool`
argument through. Until then, either drop the `pool` parameter entirely (so the
shared-pool requirement is explicit and unavoidable) or assert at runtime that
the injected pool is the singleton. Do not leave a parameter that is accepted
and silently discarded on a security-relevant lock path.

### M2 — UUID validation regex is too loose; accepts malformed IDs
File: `src/api/routes/retrospection.ts:47` and `:228-231`

What it is: `UUID_PATTERN = /^[0-9a-fA-F-]{36}$/` only checks "36 characters of
hex digits or hyphens." It accepts `------------------------------------`,
`00000000000000000000000000000000-0-0`, and many other non-UUIDs. The same weak
pattern is duplicated in the Fastify path-param schema on the apply route.

Why it matters: this is not an injection vector (values are still parameterised),
so the blast radius is limited to a confusing failed DB lookup rather than a
breach. But it gives a false sense of input validation, and a malformed-but-
accepted ID reaches the query layer where it produces a generic 404/500 instead
of a clean 400. On the apply route it weakens the only structural guard on the
privileged mutation endpoint.

How to fix it: use a real UUID pattern, e.g.
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Apply it in
both the regex constant and the Fastify schema `pattern`.

### M3 — `POST /retrospection/trigger` enqueues an unauthenticated, deduplicated job for an arbitrary date
File: `src/api/routes/retrospection.ts:150-167`; worker ignores the body date at
`src/jobs/eod-retrospection-job.ts:114`

What it is: any caller who can reach the API can enqueue an EOD retrospection
job for any `YYYY-MM-DD` string. There is no auth on this instance by design, so
"any caller" means anyone with network access to port 3000. Worse, the worker
does **not** read `job.data.trade_date` — it always recomputes "today" in IST
(line 114). So a trigger for `2099-01-01` silently runs retrospection for today
instead. The jobId is `manual-<date>`, so triggering the same date twice is
deduplicated, but triggering 365 distinct future dates enqueues 365 jobs that
each run a full today-retrospection (each of which can fire the evolution
engine).

Why it matters: (a) a confusing correctness bug — the date param is accepted,
validated, echoed back as `{ queued: true, trade_date }`, and then ignored; (b)
a low-effort amplification/DoS vector against the evolution engine and DB, since
distinct date strings bypass the jobId dedup; (c) in autonomous mode
(`EVOLUTION_REQUIRE_APPROVAL=false`) repeated triggers each advance
`evolution_consecutive_applications` and can drive parameters toward the clamp
faster than the 7-day cooldown intends — though the cooldown does ultimately
gate same-day re-application.

How to fix it: (1) make the worker actually honour `job.data.trade_date` (fall
back to today only when absent) so the API contract is truthful; (2) key the
jobId on the *resolved* trade date so dedup is meaningful; (3) given there is no
auth, at minimum bind the API to localhost / an internal network and document
that `/trigger` is an operator-only endpoint, and consider a simple shared-secret
header or rate limit on the mutating endpoints (`/trigger` and
`/evolution/apply`).

### M4 — No rate limiting or body-size limits on the API
File: `src/server/index.ts` (no `@fastify/rate-limit`, default body limits)

What it is: the server registers CORS and websocket but no rate limiter, and the
mutating endpoints (`/trigger`, `/evolution/apply`) have no throttling. Combined
with M3 this makes the evolution-apply and trigger paths cheap to hammer.

Why it matters: an unauthenticated instance with mutating endpoints and DB-
locking transactions (`FOR UPDATE`) is exposed to lock contention / connection-
pool exhaustion (pool max is 10 on the server pool) under a burst of apply
requests.

How to fix it: register `@fastify/rate-limit` (a modest global cap plus a
tighter cap on the two POST routes), and confirm the deployment binds the API to
a private network rather than `0.0.0.0` on a public host.

### M5 — CORS `origin: true` reflects every origin
File: `src/server/index.ts:101`

What it is: `fastifyCors({ origin: true })` echoes back any `Origin` as allowed.
The comment acknowledges this is dev-only and "production will lock this down,"
but there is no environment gate enforcing that — it ships as-is.

Why it matters: with no auth and no cookies the practical risk is lower (there is
no session to ride), but it still allows any website a user visits to call this
API from the browser and read retrospection data / trigger jobs. Once any
credential or session is ever added, this becomes a real CSRF/data-exfil hole.

How to fix it: drive the allowed origin from an env var
(`CORS_ALLOWED_ORIGINS`) and default to a deny/empty list in production; keep
`origin: true` only when `NODE_ENV !== 'production'`.

---

## 🟢 Low / Informational

### L1 — Secrets-in-logs: sensitive trading parameters and IDs logged in cleartext
Files: `evolution-engine.ts:216-221, 399`; `daily-metrics.ts:142-145, 264-267`;
`brier-score.ts:161-165`; `management-effectiveness.ts:141-145, 197-199`;
`eod-retrospection-job.ts:135, 188-190, 262`

What it is: warnings and the audit reason string log personality IDs, raw
`min_probability` values, win rates, and raw pnl strings. These are not
credentials (no API keys, tokens, or payment data appear in these modules — good),
but in a commercial-SaaS framing the per-personality tuned parameters are the
product's "secret sauce."

Why it matters: low. There are no auth secrets or PII here. The exposure is
business-confidential strategy parameters in application logs.

How to fix it: optional — gate the verbose value logging behind a debug level,
or log the trade ID without the raw parameter value. The audit-log `reason`
string (evolution-engine.ts:399) storing numeric values is intentional and
appropriate (immutable audit record) — leave it.

### L2 — `buildRedisConnection` falls back to `localhost:6379` and `Number(port) || 6379` masks a malformed REDIS_URL
File: `src/jobs/eod-retrospection-job.ts:45-51`

What it is: a missing or malformed `REDIS_URL` silently degrades to
`localhost:6379` rather than failing fast. `Number(redisUrl.port) || 6379` also
turns an empty port into 6379.

Why it matters: low — operational, not a breach. In production a misconfigured
Redis URL would silently connect to a local (likely absent) Redis instead of
erroring, which could mask a deploy misconfiguration and cause EOD jobs to
silently never run.

How to fix it: in production (`NODE_ENV === 'production'`) require `REDIS_URL`
to be set and throw if absent, mirroring the DATABASE_URL "throw at first query"
philosophy.

### L3 — Apply route does not re-validate the cooldown or integrity cap that the engine enforces
File: `src/api/routes/retrospection.ts:218-406`

What it is: the manual apply route applies the stored `proposed_adjustments`
value directly after validating only `Number.isFinite` and `is_frozen`. It does
not re-run the integrity-cap (8pp spread) or cooldown checks that
`runEvolutionEngine` enforces. A proposal generated when the cap was satisfied
could be applied later after siblings have drifted, breaching the comparison-
integrity invariant documented in technical.md.

Why it matters: low-to-medium for *data integrity* (it can invalidate the
comparison group), but it is a deliberate human-approval action, not an attack
path, and the value is still clamped at proposal time to [0.30, 0.90].

How to fix it: re-check `checkComparisonIntegrity()` (or recompute the spread)
inside the apply transaction before the UPDATE, and reject with a clear error if
applying the stored value would breach the 8pp cap.

### L4 — `proposed_adjustments` JSONB shape is trusted on read in the apply route
File: `src/api/routes/retrospection.ts:326-337`

What it is: `retroRow.proposed_adjustments?.min_probability` is read and only
`Number.isFinite`-checked. The rest of the JSONB blob (`rule`, `original`) is
not validated, and only `min_probability` is applied — which is correct here.
Informational: the value is system-generated by the engine, not user-supplied,
so the trust is acceptable. The `Number.isFinite` guard is the right defensive
check and is correctly placed.

How to fix it: no action required; noted for completeness.

### L5 — `migration 010` `params JSONB NOT NULL DEFAULT '{}'` plus `max_daily_trades: 5` hardcoded default
File: `src/db/migrations/010_retrospection_evolution.sql:37-43`

What it is: informational. The data-migration backfills `max_daily_trades = 5`
as a literal because no M1 column exists. This is a documented operational
default, not a security issue. The `group_type` CHECK-on-IF-NOT-EXISTS caveat in
the comment (constraint only fires if the column is newly created) is correctly
called out — verify in a fresh migration run that `group_type` actually carries
the CHECK constraint, since on a re-run against an existing column it would not.

How to fix it: no security action; verify the CHECK constraint is present in the
deployed schema (`\d personality_configs`).

---

## Positive observations (verified, not findings)

- All SQL across all eight files uses parameterised placeholders. The one
  dynamically-built query (`GET /retrospection`) appends only `$N` placeholders;
  values are pushed to the params array, never interpolated. No SQLi.
- pg NUMERIC-as-string is handled correctly everywhere: `Number()` +
  `Number.isFinite()` guards before arithmetic; the brier-score module correctly
  avoids the `Boolean('-5.00') === true` trap (brier-score.ts:169-181).
- Division-by-zero is guarded in every metric (zero-trade fast paths, `weightSum
  === 0`, `validCount === 0`, `clockworkCount === 0`).
- FROZEN_VIOLATION is enforced on both write paths: the engine throws inside the
  locked transaction (evolution-engine.ts:197-201) and the apply route returns
  403 inside the transaction after FOR UPDATE (retrospection.ts:319-322). No
  bypass path found.
- `EVOLUTION_REQUIRE_APPROVAL` defaults to safe (approval required) — only the
  exact string `'false'` opts out (evolution-engine.ts:111). Fail-safe is correct.
- The apply route's manual BEGIN/ROLLBACK/COMMIT is correct: every early return
  rolls back first, the catch rolls back and releases with a double-release guard
  (`released` flag), and COMMIT happens only after all writes. Transaction
  integrity is sound.
- Worker `concurrency: 1` plus the comparison-group SELECT FOR UPDATE correctly
  prevents the documented evolution race.
- No authentication is present by design (single-instance tool). No privilege-
  escalation vector exists because there are no privilege tiers to escalate
  between — the relevant risk is the lack of *any* network gate on mutating
  endpoints (see M3/M4/M5), not auth bypass.

---

## Verdict: CONDITIONAL PASS

No Critical findings. No SQL injection, no FROZEN_VIOLATION bypass, no financial-
logic corruption path. The core security-relevant invariants (frozen guard,
approval-default, transactional locking, NUMERIC handling) are implemented
correctly.

The conditions to clear before production:
- M1: stop silently discarding the injected pool on the locked write path (the
  lock protection rests on an undocumented "same pool" assumption).
- M3: make `/trigger` honour its own date argument and gate the two mutating,
  unauthenticated POST endpoints (network binding + rate limit).
- M2, M4, M5: tighten the UUID regex, add rate limiting, and env-gate CORS.

These are hardening and correctness items, not active exploits, hence
CONDITIONAL PASS rather than FAIL — appropriate given the paper-trading,
single-instance threat model. If this instance is exposed on a public host
before M3/M4/M5 are addressed, treat M3 as the blocking item.

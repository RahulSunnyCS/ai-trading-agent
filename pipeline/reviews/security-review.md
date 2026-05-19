# Security Review — Milestone 2

Branch: `claude/complete-milestone-2-bFvPs`
Scope: M2 signal pipeline, personality engine, management handlers, portfolio
risk, personality CRUD API, and the modified ingestion/entry-engine files.

Project security profile (per `.claude/project/business.md`): no auth, no PII,
no payments. Single-operator internal research tool. Findings are weighted
accordingly — operational robustness and data-integrity issues dominate over
classic web-app attack surface.

## Verdict: CONDITIONAL PASS

No SQL injection, no secret leakage, and no SSRF were found. Every database
write in scope uses parameterised queries. The conditions below are all
robustness / data-integrity issues that can crash the process or silently
corrupt the comparison being researched — none is a remote exploit, but two
should be fixed before this runs unattended over a trading session.

---

### 🔴 Critical

None.

No remotely exploitable vulnerability exists. The two highest-impact items are
filed as Medium because exploitation requires local environment/Redis access
(this is a single-operator tool with no external surface), but C1 below should
be treated as a release blocker for unattended operation.

---

### 🟡 Medium

**M1 — Unguarded `JSON.parse(process.env.BLOCKED_DATES)` crashes the portfolio
risk check on every signal**
`src/trading/portfolio-risk.ts:92`

```ts
const blockedDates: string[] = JSON.parse(process.env.BLOCKED_DATES ?? "[]");
```

`portfolioRiskCheck` is on the hot path for every trade-open decision. If
`BLOCKED_DATES` is set but is not valid JSON (a trailing comma, a bare date
string, a shell-quoting mistake — exactly the kind of thing that happens when
an operator edits this env var the morning of an RBI policy day, which is
precisely when this variable matters most), `JSON.parse` throws a
`SyntaxError`. That error propagates out of `portfolioRiskCheck`. Depending on
the caller's error handling it either blocks all trading for the session or
crashes the consumer loop.

Note the inconsistency: `personality-filter.ts` parses the *same* env var
defensively in `parseBlockedDates()` (try/catch, returns `[]` on failure,
filters to strings). `portfolio-risk.ts` does not. The safe pattern already
exists in the codebase and should be reused here.

Also: the parsed value is type-asserted as `string[]` with no runtime check.
`JSON.parse('{"a":1}')` yields an object on which `.includes` is undefined →
`TypeError`. `JSON.parse('5')` yields a number, same outcome.

Fix: wrap in try/catch, validate `Array.isArray`, filter to strings — mirror
`parseBlockedDates()` in `personality-filter.ts`, ideally by extracting that
helper to a shared module so the two blocked-date readers cannot drift.

---

**M2 — PUT /personalities/:id accepts an unbounded, unvalidated JSONB params
object that is shallow-merged and written verbatim**
`src/api/routes/personalities.ts:276-345`

The Fastify body schema is `params: { type: "object" }` with no
`additionalProperties`/key constraints on the nested object (only the top-level
body has `additionalProperties: false`). The handler then does:

```ts
const mergedParams = { ...existing.params, ...body.params };
```

and writes the result with `$3::jsonb`. The query itself is safe
(parameterised — no SQL injection), but there are real integrity problems:

1. **Arbitrary key injection into params.** A caller can add any keys, of any
   JSON type, of any size. Nothing validates that `min_probability` is a
   number in `[0,1]`, that `max_daily_loss` is a positive number, or that
   `roll_trigger_points` is sane. `checkComparisonIntegrity` only runs when
   `min_probability` happens to be numeric — set `min_probability: "high"` and
   the integrity guard is silently skipped (`typeof minProb !== "number"` →
   `continue`), defeating the comparison-integrity invariant that the whole
   research design depends on. The same skip lets a non-numeric value sail
   into the DB and later break consumers that do `params.min_probability as
   number`.
2. **No size bound.** `params` is persisted to `personality_configs.params`
   and copied in full into every `personality_audit_log` row on every update.
   A large object is amplified into the append-only audit table indefinitely.
3. **Prototype-pollution-shaped keys** (`__proto__`, `constructor`) are inert
   here because the value is JSON-serialised into Postgres, not merged into a
   live prototype chain — but they will round-trip back out and could bite a
   future consumer that does a recursive merge. Worth rejecting at the schema.

Fix: define an explicit allow-list JSON schema for the known param keys with
types and ranges (min_probability number 0–1, max_daily_loss number ≥ 0,
roll_trigger_points/cut_trigger_points/max_open_legs positive numbers, etc.),
set `additionalProperties: false` on the nested `params` object, and reject
non-numeric `min_probability` explicitly so the integrity check can never be
bypassed by a type trick.

---

**M3 — Portfolio daily-stop query has no IST upper bound and double-counts
across personalities**
`src/trading/portfolio-risk.ts:147-151`

```sql
SELECT COALESCE(SUM(net_pnl), 0) AS total_pnl
FROM paper_trades
WHERE entry_time >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamptz
```

Two correctness issues with a safety/financial impact:

- **No upper bound on the range.** The filter is `entry_time >= start-of-IST-
  day` with no `< next IST day` cap. If the process runs across an IST midnight
  without a restart (the code elsewhere assumes a daily restart but does not
  enforce it), trades from the new day are summed together with the previous
  day's, so the "daily" stop is no longer daily. The hypertable-scan concern
  also applies — `technical.md` explicitly warns that `paper_trades`-style
  time queries should be bounded.
- **`(NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamptz` mixes zones.**
  `NOW() AT TIME ZONE 'Asia/Kolkata'` yields a `timestamp` (no zone) of IST
  wall-clock; casting back to `timestamptz` reinterprets it in the *session*
  zone, not IST, so the day boundary is off by the session-zone offset unless
  the DB session is UTC by accident. `fetchDailyState` in
  `personality-filter.ts` does this correctly with
  `DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date` — use that pattern
  here too.

The net effect is a risk control (portfolio daily stop-loss) that can fail to
trigger when it matters. For a paper-trading research tool the dollar impact is
simulated, but the *research conclusion* about how a daily stop performs would
be invalid, which is the product's whole purpose.

Fix: bound both ends of the IST day using the same `AT TIME ZONE
'Asia/Kolkata'` date-comparison pattern already used in `fetchDailyState`.

---

### 🟢 Low / Informational

**L1 — Advisory lock is correct, but the surrounding transaction does no
work and the `BEGIN`/`COMMIT` is wasted on the non-lock path**
`src/trading/portfolio-risk.ts:222-262`

The advisory-lock logic itself is sound: `pg_try_advisory_xact_lock($1)` is
parameterised, the lock auto-releases on COMMIT/ROLLBACK (xact-scoped, no leak
possible), the `finally { client.release() }` prevents pool exhaustion, and
the secondary `ROLLBACK().catch()` correctly preserves the original error.
No lock leak. One minor note: the `COMMIT` is issued *before* the `openLegs >=
4` decision, which is fine because the only thing inside the transaction is the
lock + a COUNT (no writes), so there is nothing to lose by committing early —
but the comment "COMMIT releases the advisory lock so other checks can proceed
immediately" is slightly misleading since the check result is computed after
the lock is already gone. The serialisation guarantee still holds because the
COUNT was read while the lock was held. No change required; documenting so a
future maintainer does not "fix" it incorrectly by moving the decision inside.

**L2 — Redis stream field parsing is robust; numeric money handled as strings
correctly**
`peak-detection-engine.ts`, `personality-router.ts`,
`scheduled-signal-emitter.ts`

All three stream consumers validate parsed fields with `Number.isFinite`
before use and skip malformed messages rather than throwing. NUMERIC money
values (straddle_value, spot, net_pnl) are kept as strings end-to-end and
written with `String(...)` / Decimal — no `parseInt`/`parseFloat` precision
loss on money is introduced. `adjuster.ts` correctly uses `decimal.js` for
the roll P&L computation inside the transaction. The flat `[k,v,k,v]` parse
loop uses `i < length - 1` which silently drops a trailing odd field — benign
here since all producers emit even-length field lists, but noting it.

**L3 — `signal_id` written to `straddle_signals` row, then echoed to the
signals stream as `signal_id` and later stored on `paper_trades.signal_id`**
`peak-detection-engine.ts:541-588`, `personality-router.ts:538-544`

The chain is parameterised at every DB hop. `signalId` originates from
`gen_random_uuid()` (DB-generated) for momentum signals and `randomUUID()` for
scheduled/pullback signals — never attacker-influenced. No injection path. The
`?? "unknown"` fallback on a failed `RETURNING id` would write the literal
string `"unknown"` as `signal_id` on the stream; downstream the FK update
`SET signal_id = $2` would then fail the `straddle_signals(id)` FK and be
caught/logged (trade left unlinked). Acceptable degradation; consider skipping
the publish entirely if the insert did not return an id.

**L4 — Fire-and-forget paths are individually guarded but rely on an
undocumented daily-restart assumption**
`global-macro-feed.ts:362`, `straddle-calc.ts` `_updateOiTracking`,
`position-monitor.ts` watchdog, `personality-router.ts` read loop

Every `void`/`.catch(() => {})` path I checked terminates an error rather than
leaving an unhandled rejection: `_doPoll` catches internally, the OI Redis
write swallows intentionally, the watchdog `.then().catch()` chain logs, and
the router/emitter loops back off 500ms on Redis error instead of tight-
looping. No process-crashing unhandled rejection found. The systemic caveat is
that several modules (ReducerManager re-entry Map, peak-detection in-memory
state, position-monitor personality cache) explicitly assume a daily process
restart and have no mid-session invalidation. This is documented in-code and
acceptable for the stated research use, but it should be written down as an
operational requirement (a cron/systemd daily restart) so M3 cannot be exposed
by it (see M3 — same root assumption).

**L5 — External HTTP (Yahoo Finance) is well-hardened**
`global-macro-feed.ts`

URL is a hardcoded constant (not env-derived → no SSRF), symbols are a fixed
internal allow-list and `encodeURIComponent`-escaped, `AbortSignal.timeout`
enforces a 5s per-request cap, `Promise.allSettled` isolates per-instrument
failures, response shape is defensively validated before field access, and the
poll interval is floored at 10s to prevent a misconfig DoS against Yahoo. No
issue — called out as a clean area.

**L6 — `:id` route params passed unvalidated to parameterised queries**
`personalities.ts:244, 288, 433`

A malformed UUID reaches Postgres and surfaces as a 500 (invalid input syntax
for type uuid). Not injectable (parameterised), and on an internal no-auth
tool this is low impact, but the module's own header comment already
recommends adding a UUID-format regex to the route schema — worth doing for a
cleaner 400 and to keep invalid input from reaching the DB at all.

---

### ✅ No issues found in

- **SQL injection** — every query in scope (`personalities.ts`,
  `portfolio-risk.ts`, `peak-detection-engine.ts`, `personality-router.ts`,
  `personality-filter.ts`, `adjuster.ts`, `reducer.ts`, `position-monitor.ts`)
  uses `$1,$2,…` placeholders. No string interpolation of values into SQL.
  `ROLL`/`CUT`/exit-reason constants are parameterised as defence-in-depth.
- **Migrations 003/004/005** — DDL only, idempotent (`IF NOT EXISTS`,
  `ON CONFLICT DO NOTHING`), CHECK constraints on enums, FK references correct,
  hypertable created `if_not_exists`. No dynamic SQL, no seeded secrets.
- **Secrets hygiene** — no credentials, tokens, or sensitive env vars are
  logged anywhere in scope. Yahoo URL hardcoded (correctly not from env). Log
  lines contain trade/personality IDs and prices only — no PII (none exists)
  and no secret material.
- **SSRF** — `global-macro-feed.ts` builds its URL from a hardcoded base plus
  a fixed internal symbol list; no attacker- or env-controlled host.
- **Advisory lock correctness** — xact-scoped lock, no leak, client always
  released, conservative fail-closed on contention (see L1).
- **Numeric/money precision** — NUMERIC values kept as strings/Decimal;
  no money value is round-tripped through `parseInt`/`parseFloat` in a way
  that loses precision (the `Number(...)` uses are on counts and threshold
  comparisons, not on persisted money).
- **probability-scorer.ts** — pure, no I/O, all factor outputs bounded and
  clamped, final probability clamped to [0,1]; no injection or overflow path.
- **Redis stream injection** — all consumed fields are validated
  (`Number.isFinite`, presence checks) and only flow into parameterised DB
  writes; a hostile/garbled stream message is skipped, not executed.

# Security Audit — Payment Implementation

## Summary

The payment module gets the most-cited high-risk paths *conceptually* right: HMAC
verification uses `crypto.timingSafeEqual`, the webhook verifier correctly demands
a raw `Buffer`, secrets are never echoed in errors or logs, and the idempotency /
append-only ledger schema is sound. The lazy-init / `isPaymentEnabled` design is
correct and fails open (free mode) when the key is absent.

However, the audit found **one Critical bug that breaks credit consumption
entirely and silently removes the race protection it claims to provide**, plus a
High-severity input-trust gap in `consumeCredit`, and several Medium issues
around the `.env.example` shipping an active-looking key, IP→URL interpolation,
and per-order credit accounting. The headline Critical (`FOR UPDATE` on an
aggregate) means the atomicity design described in the file's own header comment
does not actually work and will throw at runtime.

**Verdict: FAIL** — one Critical must be fixed before this code can be trusted
with money/credits. The HMAC and secret-handling paths themselves are sound.

---

## Critical Findings 🔴

### C-1 — `SELECT SUM(...) ... FOR UPDATE` is invalid SQL; credit consumption is broken and unserialised
**File:** `src/payment/razorpay.ts:244-248` (`consumeCredit`)

```sql
SELECT COALESCE(SUM(credits_delta), 0) AS balance
FROM credit_transactions
FOR UPDATE
```

**What it is:** PostgreSQL does **not** allow `FOR UPDATE` together with an
aggregate function. This query raises `ERROR: FOR UPDATE is not allowed with
aggregate functions` (SQLSTATE `0A000`) on **every** invocation. The `catch`
block in `consumeCredit` will roll back and `throw err`, so every credit
consumption attempt fails with an unhandled exception.

Even setting the hard error aside: `FOR UPDATE` locks the *rows returned by the
query*. An aggregate returns a single synthetic row that maps to no underlying
tuple, so it locks nothing. When `credit_transactions` is empty (no purchases
yet) there are also literally zero rows to lock. The TOCTOU race that the file
header (design note 3, lines 20-24) and the inline comment (lines 242-243)
claim to prevent is **not** prevented. Two concurrent `consumeCredit` calls can
both read the same balance, both pass the `currentBalance < amount` check, and
both insert a negative delta — driving the balance negative (free features /
credit theft).

**Exploit scenario:** With the bug as written, all paid features that gate on
`consumeCredit` are dead (denial of the paid product). If the `FOR UPDATE` is
naively "fixed" by simply removing it (the tempting one-line patch), the code
*runs* but the race is wide open: a user with 1 credit fires N concurrent
backtest requests and gets N backtests for the price of one. Balance goes
negative with no floor (no CHECK constraint — see H-1 / M-4).

**Remediation:** Do not lock via an aggregate. Use one of:
1. **Advisory lock** for the single-instance product:
   `SELECT pg_advisory_xact_lock(<constant>)` at the top of the transaction,
   then the plain `SUM` read, the check, and the INSERT. Serialises all
   consumers cleanly without row-lock semantics.
2. **`SERIALIZABLE` isolation** on the transaction plus retry-on-40001.
3. A **running-balance row** (`balances(id, balance)`) updated with
   `UPDATE balances SET balance = balance - $1 WHERE balance >= $1` and check
   `rowCount === 1` — atomic, no read-then-write window, and gives a natural
   non-negative guard.
   Add an integration test that fires concurrent `consumeCredit` calls against
   a balance of 1 and asserts exactly one succeeds.

---

## High Findings 🟠

### H-1 — `consumeCredit` trusts the `amount` parameter; a negative `amount` mints credits
**File:** `src/payment/razorpay.ts:231-282`

`amount` is accepted as `number` with a default of `1` and never validated.
- A negative `amount` (e.g. `-100`) passes `currentBalance < amount` trivially
  (any balance ≥ a negative number), then inserts `credits_delta = -amount`
  = **+100**, fabricating credits out of thin air with a `feature` label.
- A non-integer (`0.5`) or `NaN`/`Infinity` produces a corrupt ledger row /
  bypasses the balance check (`x < NaN` is always false → INSERT proceeds).
- `amount = 0` inserts a no-op `0` row and returns `success: true`.

The function is exported and will be called from the not-yet-written feature
gate (T-68); whatever passes `amount` (potentially derived from a request) must
not be able to do this. Defence belongs in this function, not only the caller.

**Remediation:** At the top of `consumeCredit`, reject anything that is not a
positive safe integer:
`if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');`
(or return `{ success: false }`). Mirror the same guard wherever purchase
deltas are inserted.

### H-2 — Per-order credit accounting is incorrect; balance is a single global pool
**File:** `src/payment/razorpay.ts:202-210`, `244-282`; `src/db/migrations/004_credit_system.sql:42-44`

`getCreditBalance` and `consumeCredit` both compute `SUM(credits_delta)` across
**all** rows for **all** orders. The consumption row's FK is set to "the most
recently paid `credits_pack` order" (lines 261-268) regardless of whether that
order still has unconsumed credits. Consequences:
- Credits from an *expired* or *refunded/cancelled* order still count toward the
  spendable balance (no per-order remaining-credit check; `status IN
  ('paid','active')` is checked only to *find an FK target*, not to scope the
  balance).
- A `monthly_pass` purchase that erroneously writes a positive
  `credits_delta` would inflate the credit pool (no constraint stops it — see
  M-4).
- The audit-trail claim in the migration header ("Consumed credits reference
  the same order that originally funded them") is not enforced — the FK points
  at *an* order, not the funding order.

For a single-instance product this is a lower-blast-radius design choice, but
it silently breaks refund/expiry correctness and the stated audit guarantee.

**Remediation:** Decide and document whether credits are a single global pool
(then drop the misleading "funding order" language and stop selecting an
arbitrary FK target) or per-order (then compute remaining credits per order and
consume FIFO, refusing consumption when no order has remaining balance).
Exclude non-spendable order statuses from the balance computation either way.

---

## Medium Findings 🟡

### M-1 — `.env.example` ships a populated-looking `RAZORPAY_KEY_ID`, defeating the fail-open dev default
**File:** `.env.example:45`

```
RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXX
```

`isPaymentEnabled()` returns `Boolean(process.env.RAZORPAY_KEY_ID)` — a
**non-empty** placeholder string is truthy. A developer who copies
`.env.example` → `.env` (the normal workflow) silently enables payment mode
with a garbage key, while `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`
stay blank. Result: `initRazorpay()` throws ("secret missing"), and every
webhook/payment signature verification returns `false` (no secret) — i.e. the
documented "absent = pass all traffic freely / dev mode" behaviour is *not*
what a fresh checkout gets. This is the classic insecure-default footgun and
also risks a placeholder key reaching a real deploy.

**Remediation:** Ship `RAZORPAY_KEY_ID=` (blank) in `.env.example`, with the
example value only in a comment. Optionally make `isPaymentEnabled()` treat
known placeholder patterns (`rzp_test_XXXX...`) / blank as disabled, and fail
*loudly* at startup if `RAZORPAY_KEY_ID` is set but a secret is missing
(half-configured payment mode is more dangerous than off or fully on).

### M-2 — `getClientCountry` interpolates the IP into the request URL with no format validation (SSRF / injection surface)
**File:** `src/payment/geolocation.ts:31-39`

```ts
const url = `${baseUrl}/${ip}?fields=status,country,countryCode`;
```

`ip` is concatenated raw. Today it derives from Fastify's resolved `request.ip`
(see `extractClientIp`), which limits exposure if `trustProxy` is configured
correctly. But there is no validation that `ip` is a syntactically valid
IPv4/IPv6 literal before it is placed into a URL path, and `GEOLOCATION_API_URL`
is operator-controlled. A value containing `/`, `?`, `#`, `@`, or `..` would
allow path/query/host manipulation of the outbound request (e.g.
`evil.com/?x=` style host smuggling against some base URLs, cache poisoning,
or pointing the lookup at an internal endpoint via `GEOLOCATION_API_URL`).
Defence-in-depth is missing on a function that does an outbound fetch.

**Remediation:** Validate `ip` against an IPv4/IPv6 regex (or Node's
`net.isIP(ip) !== 0`) and bail to the `unknown` result if it fails. Construct
the URL with `encodeURIComponent(ip)` and/or the `URL` API rather than string
interpolation. Constrain `GEOLOCATION_API_URL` to an allowlisted host.

### M-3 — Payment/webhook verifiers silently accept arbitrary attacker input shape and reuse `Buffer.from` without explicit encoding
**File:** `src/payment/razorpay.ts:135-157`, `175-192`

`signature` / `headerSignature` are typed `string` but unvalidated at the
boundary. `Buffer.from(signature)` uses the default `utf8` encoding; Razorpay
sends a lowercase hex digest, and the computed side is `.digest('hex')`
(64-char ASCII). A length mismatch makes `crypto.timingSafeEqual` throw a
`RangeError`, which the `catch` converts to `false` (fail-safe — good), but
this means *every* malformed or wrong-length signature takes the exception
path rather than a constant-time comparison, and a non-string input
(`undefined`/object passed from a future caller) also silently returns `false`
instead of surfacing a programming error. This is correct *today* but fragile
and obscures misuse.

**Remediation:** Validate inputs are non-empty strings matching `^[a-f0-9]+$`
of the expected length before comparing; decode both sides with explicit
`'hex'` encoding (`Buffer.from(expected, 'hex')` /
`Buffer.from(signature, 'hex')`) so the comparison is over raw digest bytes,
not ASCII. Keep the fail-safe `catch`.

### M-4 — `credit_transactions` has no value/sign integrity constraints
**File:** `src/db/migrations/004_credit_system.sql:24-30`

`credits_delta INTEGER NOT NULL` permits any value, including absurd magnitudes
and the wrong sign for the row's purpose. There is no DB-level guard that a
`feature`-tagged (consumption) row is negative, that a purchase row is
positive, or that the running balance cannot go negative. The application-level
checks (already shown to be broken in C-1/H-1) are the *only* protection.
Defence-in-depth at the schema level is absent.

**Remediation:** Add `CHECK (credits_delta <> 0)`; consider
`CHECK ((feature IS NULL AND credits_delta > 0) OR (feature IS NOT NULL AND
credits_delta < 0))` to enforce purchase/consumption sign semantics. A negative
floor (running balance ≥ 0) is best enforced via the running-balance approach
in C-1's remediation.

---

## Low Findings 🟢

### L-1 — No statement/transaction timeout on the `consumeCredit` transaction
**File:** `src/payment/razorpay.ts:236-295`

With proper locking (post-C-1 fix), a stuck/long transaction holding the
serialising lock can stall all feature consumption. There is no
`statement_timeout` / `idle_in_transaction_session_timeout` set for this path.

**Remediation:** Set a short `statement_timeout` on the consume transaction (or
pool) so a hung consumer cannot block the queue indefinitely.

### L-2 — `processed_webhook_events` has no retention / TTL and no event recording helper in this module
**File:** `src/db/migrations/003_payment_tables.sql:45-48`; `src/payment/razorpay.ts` (absent)

The idempotency table is correctly modelled (TEXT PK on Razorpay's globally
unique event id) but grows unbounded, and `razorpay.ts` exposes **no**
function to record/check a processed event — the idempotency contract depends
entirely on the not-yet-written route handler (T-67) doing it correctly inside
the same transaction as the grant write. Flagging so it is not lost: idempotency
recording must be transactional with the side effect it guards, not best-effort
after.

**Remediation:** Add a `markWebhookProcessed`/`isWebhookProcessed` helper that
is called *within* the same DB transaction that applies the grant, using
`INSERT ... ON CONFLICT DO NOTHING` and treating "0 rows inserted" as
"already processed → skip". Add a periodic prune (e.g. delete events older than
N days). Track as an explicit acceptance criterion for T-67.

### L-3 — `getCreditBalance`/`consumeCredit` parse a NUMERIC aggregate with `parseFloat` for an INTEGER ledger
**File:** `src/payment/razorpay.ts:209`, `251`

`credits_delta` is `INTEGER`; `SUM` returns `BIGINT` (pg → string).
`Number.parseFloat` works but invites silent precision loss if the column ever
becomes NUMERIC, and accepts trailing garbage. Minor robustness nit.

**Remediation:** Use `Number.parseInt(value, 10)` (or `BigInt`) and assert the
parse is finite/integer.

---

## Confirmed Secure

- **Webhook HMAC over raw bytes (`verifyWebhookSignature`, lines 175-192):**
  Correctly requires a `Buffer` and hashes it directly via `hmac.update(rawBody)`
  with no re-serialisation. The contract and the header doc note (2) are sound.
  *(The raw-body Fastify parser is correctly noted as T-67 future work.)*
- **`crypto.timingSafeEqual` used for both payment and webhook comparisons**
  (lines 152, 188) — constant-time comparison, no early-return string `===`.
- **No secrets in errors/logs:** `initRazorpay` (lines 65-75),
  `verifyPaymentSignature` (140-145), `verifyWebhookSignature` (176-180) all
  avoid echoing `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`. Error
  messages name the variable, never its value. Verified clean.
- **Missing-secret fail-safe:** both verifiers return `false` (not throw, not
  pass) when the secret is unset (lines 141-145, 177-180) — correct fail-closed
  for verification while the app overall fails *open* only via the explicit
  `isPaymentEnabled()` gate.
- **Lazy init / `isPaymentEnabled()` (lines 45-49, 61-78):** importing the
  module with no key does not throw; SDK construction is deferred. Design is
  correct (subject to M-1, which is about the *example file*, not this logic).
- **Append-only ledger + idempotency schema:** `credit_transactions` is
  INSERT-only by design; `access_grants.razorpay_order_id` `UNIQUE` and
  `processed_webhook_events` TEXT PK give correct idempotency keys. FK from
  `credit_transactions.razorpay_order_id` → `access_grants` ties credits to a
  payment record. Schema modelling itself is sound (integrity-constraint gaps
  noted in M-4).
- **`extractClientIp` (geolocation.ts:93-104):** correctly relies on Fastify's
  `request.ip` (trustProxy-resolved) instead of reading `X-Forwarded-For`
  directly — avoids trivial header IP spoofing. The doc comment accurately
  states geolocation is display-only and not a security gate.
- **`getClientCountry` failure handling:** 5s abort timeout, strict response
  shape validation, ISO-3166 `countryCode` regex, and a catch-all that degrades
  to `unknown` without throwing — robust (subject to M-2 on the URL build).

---

## Out of Scope (not yet implemented)

The following are intentionally absent and were **not** flagged as missing
defects, only referenced where they affect the security contract:

- **T-67 — Fastify route handlers + raw-body parser.** The webhook idempotency
  *enforcement* and the `addContentTypeParser(parseAs:'buffer')` wiring live
  here. L-2 records the transactional-idempotency requirement so T-67 inherits
  it as an explicit acceptance criterion.
- **T-68 — Access gate middleware.** The consumer of `consumeCredit` /
  `getCreditBalance`. H-1's input validation must be in place before this is
  wired, since the gate may pass request-influenced values.
- **T-69 — React pricing page.** Consumes `getClientCountry` for UPI display
  only; no security surface beyond M-2's outbound-fetch hardening.

These remain correctly blocked on M1 and are out of audit scope. The Critical
(C-1) and High (H-1, H-2) findings are in *already-written* code and must be
resolved before T-67/T-68 build on top of them.

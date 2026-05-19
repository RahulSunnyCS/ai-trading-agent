# Architecture Review — Payment Implementation

## Summary

The payment module (`src/payment/`) and its DB schema (migrations 003, 004)
are generally well-structured. The module boundary is clean, the Buffer
contract on webhook signature verification is correct, the lazy-init pattern
for the Razorpay client is the right call for dev-mode safety, and the
append-only ledger design for `credit_transactions` is sound.

There is one critical runtime defect that will crash in production: `FOR UPDATE`
is used on an aggregate query inside `consumeCredit`, which PostgreSQL rejects
outright. Everything else is design-level — schema invariants that are enforced
only in application code, a duplicated aggregate implementation, missing DB
triggers, and minor extensibility gaps for Phase 2 (Stripe).

---

## Critical Issues

### FINDING: `FOR UPDATE` on aggregate query — runtime crash
Severity: High
File or area: `src/payment/razorpay.ts` lines 244-248

**What it is:**
```sql
SELECT COALESCE(SUM(credits_delta), 0) AS balance
FROM credit_transactions
FOR UPDATE
```
PostgreSQL raises `ERROR: FOR UPDATE is not allowed with aggregate functions`
the moment this query executes. The transaction cannot proceed. Every call to
`consumeCredit` will throw, regardless of whether the balance is sufficient.

**Why it matters:**
All feature-gated functionality (backtest runs, any credit-consuming call) is
broken at runtime. The TOCTOU concern the comment describes is real and valid,
but `FOR UPDATE` cannot be placed on an aggregate — it must target rows
directly.

**Recommendation:**
Use an advisory lock to serialise concurrent consumers, or insert a sentinel
row (balance_checkpoint) and lock that. The simplest approach for a
single-instance product is `SELECT pg_advisory_xact_lock(<constant>)` at the
start of the transaction, which serialises all concurrent `consumeCredit`
calls without needing `FOR UPDATE`:

```sql
SELECT pg_advisory_xact_lock(1234567890);  -- constant per-feature lock key
SELECT COALESCE(SUM(credits_delta), 0) AS balance FROM credit_transactions;
```
The advisory lock is released automatically when the transaction commits or
rolls back, giving the same serialisation guarantee the author intended.

---

## Warnings

### FINDING: FK attribution in `consumeCredit` is always "most recent order"
Severity: Medium
File or area: `src/payment/razorpay.ts` lines 260-275

**What it is:**
When inserting a consumption row, `consumeCredit` queries for the most recently
paid `credits_pack` order and uses that as the FK reference — regardless of
which order's credits are actually being consumed. If an operator has purchased
two credit packs, all consumption is attributed to the most recent order, even
if that order's credits are exhausted and the remaining balance came from the
older one.

**Why it matters:**
The comment at line 229 states the intent is to "clearly show which purchase
funded which feature call." That invariant is already broken the moment a
second credits pack is purchased. Audit queries like "how many credits remain
from order X?" will give misleading answers.

**Recommendation:**
For a single-instance product this is low-risk operationally (the total balance
is always correct), but the per-order attribution is unreliable. Either (a)
document that per-order attribution is best-effort, not guaranteed; or (b)
implement a FIFO-consumption model that deducts from the oldest order first.
The schema already supports (b) — it requires ordering the balance check and
the insert by `created_at ASC` and joining to the specific order that still
has remaining headroom.

---

### FINDING: `days_granted` column is semantically overloaded for `credits_pack`
Severity: Medium
File or area: `src/db/migrations/003_payment_tables.sql` line 24

**What it is:**
`days_granted INTEGER NOT NULL CHECK (days_granted > 0)` is present on all
rows, including `credits_pack` grants where the concept of "days" has no
meaning. The schema enforces `> 0` but every `credits_pack` row must be
inserted with an arbitrary positive integer (presumably 0 intent but forced
to ≥ 1 by the constraint).

**Why it matters:**
Any query that reads `days_granted` to compute access windows must separately
guard on `grant_type`. A future developer writing `expires_at = created_at +
days_granted * interval '1 day'` for all rows will silently produce wrong
expiry dates for credit pack rows. The schema is a trap.

**Recommendation:**
Two options:
(a) Make `days_granted` nullable and enforce `days_granted IS NOT NULL` only
    when `grant_type = 'monthly_pass'` via a CHECK constraint:
    `CHECK (grant_type != 'monthly_pass' OR days_granted IS NOT NULL)`
(b) Add a separate `access_window_days INTEGER` column that is `NULL` by
    default and only populated for `monthly_pass` rows. The `credits_pack`
    row then has no spurious data.

---

### FINDING: No DB constraint linking `monthly_pass` to non-null `expires_at`
Severity: Medium
File or area: `src/db/migrations/003_payment_tables.sql` lines 25-29

**What it is:**
`expires_at TIMESTAMPTZ` is nullable with no constraint ensuring that
`monthly_pass` rows always carry an expiry. The business rule "monthly_pass
grants have an expiry; credits_pack grants do not" is enforced only at the
application layer, not in the schema.

**Why it matters:**
If the webhook handler omits `expires_at` when processing a `monthly_pass`
payment — through a bug or future code change — the row will be inserted
successfully. The access gate (T-68) will then find a `monthly_pass` with no
expiry and will either grant indefinite access or throw a null-dereference
error, depending on how it handles `NULL`. Neither outcome is correct and
neither is caught at write time.

**Recommendation:**
Add a table-level CHECK constraint to the migration:
```sql
CHECK (
  (grant_type = 'monthly_pass' AND expires_at IS NOT NULL) OR
  (grant_type = 'credits_pack' AND expires_at IS NULL)
)
```
This makes the business rule a schema invariant rather than an application
convention.

---

### FINDING: `getCreditBalance` duplicates the `credit_balance` view
Severity: Medium
File or area: `src/payment/razorpay.ts` lines 202-210 vs `src/db/migrations/004_credit_system.sql` lines 42-44

**What it is:**
The migration creates a `credit_balance` view with `COALESCE(SUM(credits_delta), 0)`.
`getCreditBalance()` in `razorpay.ts` re-implements the identical aggregate
inline against the raw table. Two implementations of the same computation exist
independently. The view is not used anywhere in the application code.

**Why it matters:**
If the aggregate definition ever changes (e.g. filtering by a date range, or
scoping to a specific operator), one implementation will be updated and the
other will not. The divergence is silent — both will return a number, just
different numbers.

**Recommendation:**
`getCreditBalance` should query `SELECT balance FROM credit_balance` (the view)
rather than re-computing the aggregate inline. The view becomes the single
source of truth. If the view ever needs to be a materialized view for
performance, only the migration changes.

---

### FINDING: `initRazorpay()` creates a new SDK instance on every call
Severity: Low
File or area: `src/payment/razorpay.ts` lines 61-78, called at lines 104, 261 (indirectly)

**What it is:**
`createOrder` calls `initRazorpay()` which constructs `new Razorpay(...)` on
each invocation. There is no module-level singleton. For the current code the
only caller is `createOrder`, but as more route handlers are wired up (T-67),
each will call `initRazorpay()` independently.

**Why it matters:**
Constructing a new SDK client per request is harmless for now (the Razorpay SDK
is lightweight), but the pattern diverges from the intent of "lazy init" — lazy
means "initialise once, reuse." It also means any future SDK client that holds
connection pools or HTTP keep-alive handles will be recreated unnecessarily.

**Recommendation:**
Cache the result after first successful construction:
```typescript
let _client: Razorpay | null = null;

export function initRazorpay(): Razorpay {
  if (_client) return _client;
  // ... validation ...
  _client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return _client;
}
```

---

### FINDING: No `updated_at` auto-update trigger on `access_grants`
Severity: Low
File or area: `src/db/migrations/003_payment_tables.sql` lines 29

**What it is:**
`access_grants.updated_at` is defined as `NOT NULL DEFAULT NOW()` but there is
no `BEFORE UPDATE` trigger to keep it current. Every `UPDATE` statement against
this table must manually include `updated_at = NOW()` in the SET clause or
the column will stay frozen at insertion time.

**Why it matters:**
When the webhook handler (not yet implemented) updates `status` from `pending`
to `paid`, omitting `updated_at = NOW()` leaves a stale timestamp. Any query
ordered by `updated_at` (e.g. "most recently activated grant") returns
incorrect results. This is a correctness trap that grows more dangerous as more
code touches `access_grants`.

**Recommendation:**
Add a trigger in the migration:
```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_access_grants_updated_at
BEFORE UPDATE ON access_grants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```
The trigger is unconditional — callers do not need to remember to set
`updated_at`.

---

### FINDING: No CHECK constraint ensuring consumption rows supply `feature`
Severity: Low
File or area: `src/db/migrations/004_credit_system.sql` line 28

**What it is:**
`feature TEXT` is nullable, documented as "NULL for purchases." The inverse —
that consumption rows (negative `credits_delta`) must have a non-null `feature`
— is enforced only in `consumeCredit` at the application layer, not in the
schema.

**Why it matters:**
A future direct SQL insert or a second consumption path that forgets to pass
`feature` will produce a consumption row with `feature = NULL`. Audit queries
like "which features consumed credits this month?" will silently under-count.

**Recommendation:**
Add a table-level CHECK:
```sql
CHECK (credits_delta > 0 OR feature IS NOT NULL)
```
This reads: "if this is a consumption row (negative delta), feature must be
provided."

---

### FINDING: Geolocation has no request caching or rate-limit protection
Severity: Low
File or area: `src/payment/geolocation.ts` lines 29-83

**What it is:**
`getClientCountry` makes a live HTTP call to ip-api.com on every invocation.
The free tier of ip-api.com allows 45 requests per minute. There is no
in-process cache keyed by IP and no circuit-breaker. If the pricing page is
hit repeatedly (e.g. a scraper, or a user refreshing) the limit will be
exhausted and all callers will start receiving `confidence: 'unknown'`, which
hides the UPI option for legitimate Indian users.

**Why it matters:**
Although this is cosmetic (not a security gate), degrading the UPI display for
Indian users during a rate-limit window directly affects conversion. A cache
is also cheap — IPs do not change country between requests.

**Recommendation:**
Add a simple in-process `Map<string, { result: GeolocationResult, expiresAt: number }>`
cache with a TTL of, for example, 10 minutes. For most single-instance deployments
this is sufficient. If Redis is already running (it is in this stack), a Redis
key with a 10-minute TTL is the more robust choice.

---

## Informational

### FINDING: `grant_type` and `status` as `TEXT + CHECK` rather than `ENUM`
Severity: Low (informational)
File or area: `src/db/migrations/003_payment_tables.sql` lines 23, 27

**What it is:**
`grant_type` and `status` use `TEXT NOT NULL CHECK (... IN (...))` rather than
PostgreSQL `ENUM` types. The `GrantType` and `GrantStatus` TypeScript union
types in `schema.ts` (lines 178-179) correctly mirror the allowed values, so
type safety at the application layer is intact.

**Why it matters for Phase 2:**
Adding a new status (e.g. `'refunded'`) requires an `ALTER TABLE ... DROP
CONSTRAINT ... ADD CONSTRAINT` round-trip — verbose but safe. With `ENUM`,
adding a value is `ALTER TYPE ... ADD VALUE` which is simpler but irreversible
(you cannot remove an ENUM value without dropping and recreating). For a
billing table where new statuses are likely (refunds, chargebacks), the
`TEXT + CHECK` approach is actually the more extensible choice.

**No action required** — this is already the better pattern for Phase 2
extensibility. Noting it to counter any future temptation to convert to ENUM.

---

### FINDING: No index on `credit_transactions(created_at)`
Severity: Low (informational)
File or area: `src/db/migrations/004_credit_system.sql` lines 32-34

**What it is:**
The only index on `credit_transactions` is on `razorpay_order_id`. There is no
index on `created_at`, which will be the natural sort key for audit queries
("credit movements in the last 30 days") and dashboard queries.

**Why it matters:**
For a single-instance product with a few hundred credit transactions, a full
table scan is acceptable. If credit usage grows to thousands of rows (multiple
SKUs, high-volume backtest usage), the absence of a `created_at` index will
slow audit and reporting queries. The time to add it is now, before the table
is large.

**Recommendation:**
Add in migration 004 or a new migration 005:
```sql
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at
ON credit_transactions(created_at DESC);
```

---

### FINDING: No explicit `idempotency_key` surface for Stripe Phase 2
Severity: Low (informational)
File or area: `src/payment/razorpay.ts` lines 84-121, `src/db/migrations/003_payment_tables.sql`

**What it is:**
The current `CreateOrderParams` interface and `access_grants` schema are
Razorpay-specific. When Stripe is added in Phase 2, Stripe uses a client-side
`idempotencyKey` header and its own `payment_intent_id` / `checkout_session_id`
identifiers — none of which map directly to `razorpay_order_id`.

**Why it matters:**
The FK from `credit_transactions.razorpay_order_id` to
`access_grants.razorpay_order_id` means adding Stripe will require either:
(a) renaming the column to a generic `payment_order_id` and using a convention
    like `rzp_<id>` vs `pi_<id>` prefixes; or
(b) adding a `stripe_payment_intent_id` column alongside the Razorpay one.

Neither is hard, but it requires a migration that touches the FK — the riskier
kind. Planning now avoids a more disruptive schema change later.

**Recommendation:**
In Phase 2 planning, budget a migration that renames `razorpay_order_id` on
both `access_grants` and `credit_transactions` to `payment_order_id` (or
`external_order_id`) and adds a `payment_provider TEXT NOT NULL DEFAULT
'razorpay'` column. This is straightforward with a single transaction-safe
`ALTER TABLE ... RENAME COLUMN` but is easier to do before the Stripe route
handlers are written than after.

---

## Confirmed Well-Designed

**Buffer contract on webhook signature** (`razorpay.ts` lines 175-192):
Requiring `rawBody: Buffer` makes it structurally impossible to accidentally
pass a re-serialised string. The comment explains the exact failure mode. This
is the correct contract.

**`timingSafeEqual` in both signature verifiers** (`razorpay.ts` lines 152, 188):
Both `verifyPaymentSignature` and `verifyWebhookSignature` use
`crypto.timingSafeEqual` to prevent timing-based secret recovery. Correct.

**Never-throw signature verifiers** (`razorpay.ts` lines 135-157, 175-192):
Both verifiers return `false` on any error rather than throwing. This prevents
a malformed request from causing an unhandled rejection in the route handler
and inadvertently revealing information through error responses.

**Lazy init + silent-fail pattern** (`razorpay.ts` lines 45-78):
`isPaymentEnabled()` checks the env var without constructing an SDK instance.
`initRazorpay()` throws clearly when called without credentials. The module is
safely importable in dev mode.

**Append-only ledger design** (`004_credit_system.sql`):
`credit_transactions` has no `UPDATE` or `DELETE` path. The balance is always
derivable from history. This is the correct pattern for a financial ledger.

**`fetchFn` injection on `getClientCountry`** (`geolocation.ts` line 28):
The dependency-injection approach for the HTTP client makes the function fully
unit-testable without network access. The default is `fetch`, so production
callers pass nothing.

**5-second AbortController timeout** (`geolocation.ts` lines 35-37):
A geolocation lookup that hangs will not block the response indefinitely. The
timeout is correctly wired through `AbortController`, not a `Promise.race`.

**`UNIQUE` on `razorpay_order_id` in `access_grants`** (`003_payment_tables.sql` line 21):
The UNIQUE constraint is the natural idempotency guard. Double-processing of
the same webhook event cannot create a duplicate grant row.

**`processed_webhook_events` deduplication table** (`003_payment_tables.sql` lines 45-48):
Explicit event-ID deduplication is the correct pattern for Razorpay's
at-least-once delivery. Using the Razorpay-provided `event_id` as PRIMARY KEY
is both correct and efficient.

**TypeScript union types for DB enum values** (`schema.ts` lines 178-179):
`GrantType` and `GrantStatus` are defined as string union types that exactly
mirror the SQL CHECK constraints. This gives compile-time enforcement without
depending on ORM codegen.

---

## Finding Counts

| Severity | Count |
|----------|-------|
| High     | 1     |
| Medium   | 4     |
| Low      | 5     |

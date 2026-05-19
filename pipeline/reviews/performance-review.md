# Performance Review — Payment Implementation

Reviewed files:
- `src/payment/razorpay.ts`
- `src/payment/geolocation.ts`
- `src/db/migrations/003_payment_tables.sql`
- `src/db/migrations/004_credit_system.sql`

Context: single-instance tool, low transaction volume, India-only Razorpay UPI payments.

---

## Summary

Four findings total: no criticals, one high (geolocation blocks every request with an external HTTP call and no cache), two mediums (missing composite index on the order lookup inside consumeCredit, and extra round-trips inside the credit transaction), one informational. Core correctness of the locking approach and schema design is good.

---

## Critical Issues

None.

---

## Warnings

### FINDING: Geolocation HTTP call on every request — no caching
Severity: High
File and line: `src/payment/geolocation.ts`, lines 29–83; `getClientCountry()`

What it is: Every time a request needs to know whether to show the UPI payment option, `getClientCountry` makes a fresh HTTP call to ip-api.com with a 5-second timeout. There is no in-memory cache, no TTL, and no short-circuit for repeated calls from the same IP address. If ip-api.com is slow or unreachable, every affected request stalls for up to 5 seconds before falling through to the `unknown` result.

Impact at scale: At current volume (one operator, infrequent payments) this is largely invisible. The risk is not load — it is latency. A user hitting the checkout page, having it respond slowly, and refreshing will fire two back-to-back 5-second-timeout calls. If the operator deploys behind a CDN or the page gets any organic traffic, this compounds immediately. Additionally, ip-api.com's free tier has a rate limit of 45 requests per minute; exceeding it returns a failure response and the UPI option silently disappears.

How to fix it: Cache the result keyed by IP address in a `Map` or in Redis with a TTL of 10–30 minutes. IP-to-country mappings are stable over hours. A simple module-level `Map<string, { result: GeolocationResult; cachedAt: number }>` with a 15-minute TTL adds roughly 10 lines of code and eliminates repeated external calls entirely. Example shape:

```typescript
const geoCache = new Map<string, { result: GeolocationResult; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function getClientCountry(ip: string, fetchFn = fetch): Promise<GeolocationResult> {
  const cached = geoCache.get(ip);
  if (cached && Date.now() < cached.expiresAt) return cached.result;
  // ... existing fetch logic ...
  geoCache.set(ip, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
```

---

### FINDING: Missing composite index for the "latest paid credits_pack order" lookup
Severity: Medium
File and line: `src/db/migrations/003_payment_tables.sql`, lines 34–35 (existing index); `src/payment/razorpay.ts`, lines 261–268 (the query)

What it is: Inside `consumeCredit`, after the balance lock is acquired, the code runs:

```sql
SELECT razorpay_order_id
FROM access_grants
WHERE grant_type = 'credits_pack'
  AND status IN ('paid', 'active')
ORDER BY created_at DESC
LIMIT 1
```

The only index on `access_grants` is `idx_access_grants_status` (on `status` alone). PostgreSQL will use that index to narrow to rows with `status IN ('paid', 'active')`, but it then has to filter those rows for `grant_type = 'credits_pack'` and sort by `created_at` without index support — an in-memory sort of the filtered result set. For a table with tens of rows this is undetectable, but the pattern is structurally inefficient: a covering composite index on `(grant_type, status, created_at DESC)` would satisfy the WHERE clause, eliminate the sort, and allow an index-only scan.

Impact at scale: At current scale (handful of payment records ever), zero measurable impact. If the table ever grows (e.g. historical archiving of past orders), this query degrades linearly with the number of `credits_pack` rows. More practically, this query runs inside a locked transaction — the longer it takes, the longer the `FOR UPDATE` lock is held on `credit_transactions`, blocking any concurrent credit consumer.

How to fix it: Add to `003_payment_tables.sql` (or a new migration):

```sql
CREATE INDEX IF NOT EXISTS idx_access_grants_grant_type_status_created
  ON access_grants (grant_type, status, created_at DESC);
```

---

## Informational

### FINDING: consumeCredit makes five sequential database round-trips inside one transaction
Severity: Low
File and line: `src/payment/razorpay.ts`, lines 239–284

What it is: The `consumeCredit` function issues five separate SQL statements sequentially inside a single transaction: BEGIN, SELECT FOR UPDATE (balance), SELECT (latest order), INSERT, COMMIT. Each statement is an individual network round-trip to PostgreSQL. In a low-latency local Docker environment this is negligible, but in a cloud deployment where the app and database are in different availability zones (e.g. Railway app talking to a managed Postgres instance), each round-trip adds 1–5ms. Five round-trips can easily add 10–25ms to every credit consumption call.

Impact at scale: At current volume, this is not a problem. Flagging it here so the team knows the headroom: if credit consumption ever becomes frequent (e.g. automated batch backtests), the transaction can be collapsed into a single CTE-based statement that does the balance check, order lookup, and insert in one round-trip, keeping the same TOCTOU safety.

How to fix it (when it matters): Collapse into a single CTE:

```sql
WITH locked_balance AS (
  SELECT COALESCE(SUM(credits_delta), 0) AS balance
  FROM credit_transactions
  FOR UPDATE
),
latest_order AS (
  SELECT razorpay_order_id
  FROM access_grants
  WHERE grant_type = 'credits_pack'
    AND status IN ('paid', 'active')
  ORDER BY created_at DESC
  LIMIT 1
),
inserted AS (
  INSERT INTO credit_transactions (razorpay_order_id, credits_delta, feature)
  SELECT lo.razorpay_order_id, $2, $3
  FROM locked_balance lb, latest_order lo
  WHERE lb.balance >= $1
  RETURNING *
)
SELECT lb.balance, i.id IS NOT NULL AS consumed
FROM locked_balance lb
LEFT JOIN inserted i ON true
```

This is a non-trivial rewrite; defer it until you have a concrete latency problem.

---

## Confirmed Efficient

- **`FOR UPDATE` on the aggregate in `consumeCredit`** (razorpay.ts lines 244–248): Correct approach. Locking all rows in `credit_transactions` during the balance check and insert serialises concurrent consumers and prevents the time-of-check/time-of-use race described in the comments. For a single-instance tool this is the right tradeoff — simpler than a row-level lock on a dedicated balance counter, and the table stays tiny.

- **`credit_balance` as a plain view** (004_credit_system.sql lines 42–44): Acceptable at this scale. The comment in the migration correctly notes that a materialized view or running-total trigger can replace it if the table grows. At tens to low-hundreds of rows a full-table SUM is effectively instantaneous.

- **Webhook idempotency via `processed_webhook_events` primary key** (003_payment_tables.sql lines 45–48): TEXT PRIMARY KEY on `razorpay_event_id` is the correct pattern. Primary key lookups are O(log n) on the B-tree index automatically created by PostgreSQL. No secondary index needed.

- **`idx_access_grants_expires_at` partial index** (003_payment_tables.sql lines 38–39): Good practice. Excluding `credits_pack` rows (which have NULL `expires_at`) keeps the expiry-check index small and directly sized to the rows it actually needs to scan.

- **5-second abort timeout in `getClientCountry`** (geolocation.ts lines 35–37): Correctly implemented with `AbortController`. The `finally { clearTimeout(timeoutId) }` at line 81 prevents a timer leak if the fetch resolves before the timeout fires. This is the correct pattern.

- **Lazy `initRazorpay()`** (razorpay.ts lines 61–78): No SDK client is created at module load. This avoids startup failures in dev mode where `RAZORPAY_KEY_ID` is absent, and means the cost of constructing the SDK client is paid only when payment is actually used — not on every cold start.

- **`timingSafeEqual` for HMAC comparison** (razorpay.ts lines 152, 188): Both signature verification paths use constant-time comparison, which is the correct defence against timing-based secret-recovery attacks. This adds negligible overhead and prevents a real attack class.

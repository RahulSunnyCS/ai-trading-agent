# Epic: UPI India Payment Integration

| Field      | Value                                         |
|------------|-----------------------------------------------|
| Status     | Completed (T-67/T-68/T-69 blocked — see §7)  |
| Date       | 2026-05-19                                    |
| Branch     | claude/add-upi-india-payment-hYLhC            |
| Tasks      | T-64, T-65, T-66, T-71, T-72                 |
| Risk level | HIGH — payment/billing logic, public webhook  |

---

## 1. What was done

Five tasks introduced the complete server-side foundation for India-only UPI payments via Razorpay. The work covers the database schema (three new tables, a balance view, and a constraint-tightening migration), the TypeScript payment service (order creation, dual HMAC signature verification, credit balance query, and atomic credit consumption), a server-side geolocation service to detect Indian users for display purposes, environment variable documentation, and a governance update to pipeline configuration to reflect that payment logic is now present and must be reviewed on every future pipeline run.

Concrete deliverables:

- **`src/db/migrations/003_payment_tables.sql`** — `access_grants` table (one row per Razorpay order; tracks grant type, status, and expiry) and `processed_webhook_events` table (idempotency log using Razorpay's own event ID as primary key).
- **`src/db/migrations/004_credit_system.sql`** — `credit_transactions` append-only ledger (positive deltas for purchases, negative for feature consumption) and `credit_balance` view (single-source `COALESCE(SUM(credits_delta), 0)` aggregate).
- **`src/db/migrations/005_payment_schema_constraints.sql`** — makes `days_granted` nullable; adds cross-column CHECK constraints enforcing `monthly_pass` always has `days_granted + expires_at` and `credits_pack` has neither; composite index for the credit-consumption order lookup; `updated_at` auto-maintenance trigger; schema-level CHECK that consumption rows must supply a feature name.
- **`src/payment/razorpay.ts`** — `isPaymentEnabled`, `initRazorpay` (lazy singleton), `createOrder`, `verifyPaymentSignature`, `verifyWebhookSignature` (Buffer-only contract), `getCreditBalance`, `consumeCredit` (advisory-lock transaction).
- **`src/payment/geolocation.ts`** — `getClientCountry` (injectable fetch, 5 s timeout, 15-minute in-process cache, path-injection guard) and `extractClientIp` (Fastify-proxy-aware).
- **`src/db/schema.ts`** — `AccessGrant`, `CreditTransaction`, `ProcessedWebhookEvent` TypeScript interfaces; `GrantType` and `GrantStatus` union types.
- **`.env.example`** — documented all seven payment-related environment variables with inline safety comments.
- **`.claude/project/business.md`** — updated Pipeline Scope to mark `pricing-reviewer` as applicable and document the PCI/PII boundary.

---

## 2. How this helps the project

The platform is transitioning from a personal research tool to a commercial SaaS product with India-only subscription billing. Before this work, there was no way to gate access or charge users — the app ran openly with no payment concept in the codebase. This epic puts the financial plumbing in place: operators can now create Razorpay orders for two products (a 30-day Monthly Access Pass and feature-token Credit Packs), verify that payments actually succeeded using cryptographic HMAC signatures rather than trusting the client, and consume credits atomically so concurrent requests cannot cheat the balance. The geolocation service detects Indian visitors so the frontend can show UPI as the payment method — the correct default for the India-only launch. Without this foundation, the three remaining tasks (API routes, access gate, and pricing page) cannot be built.

---

## 3. Limitations and tradeoffs (and why we chose this)

**Razorpay Orders API, not Subscriptions.** Razorpay offers a Subscriptions API with automatic recurring mandates. We use the one-time Orders API instead. Reason: Indian UPI mandate/autopay is still subject to RBI's e-mandate limits and requires extra user consent steps. One-time payments are simpler to explain to users, easier to refund, and keep us out of the RBI recurring-payment regulatory surface for Phase 1. Users repurchase manually; this is the intentional model documented in business.md.

**UPI as the anti-spoofing mechanism, not IP geolocation.** UPI requires an Indian bank account verified through Indian KYC. This is the primary reason a non-Indian user cannot purchase the India-only plan — not because we block their IP. Geolocation is used only to decide whether to render the UPI button on the frontend. Consequence: a VPN user can see the UPI button, but they cannot complete UPI payment without an Indian bank account. We chose this because IP-based access control is trivially bypassable and creates false confidence; making the payment instrument itself the gate is far more robust.

**Silent fail when `RAZORPAY_KEY_ID` is absent.** If the environment variable is not set, `isPaymentEnabled()` returns `false` and the entire payment subsystem is dormant — the app runs in free/open access mode. We chose this to make local development with no Razorpay account frictionless and to match the documented dev-mode contract. The tradeoff is that a misconfigured production environment (key accidentally deleted) silently gives free access rather than erroring loudly. Operators must monitor for this.

**Advisory lock for credit consumption atomicity.** PostgreSQL does not permit `FOR UPDATE` on an aggregate function. The original implementation used `FOR UPDATE` on `SUM(credits_delta)`, which throws at runtime (Critical finding C-1 in the security audit). The fix uses `SELECT pg_advisory_xact_lock(7241964)` at the top of the transaction, which serialises all concurrent `consumeCredit` calls for the lifetime of the transaction. The advisory lock key is an arbitrary stable constant. The tradeoff versus a dedicated balance row with `UPDATE ... WHERE balance >= amount` is that advisory locks are process-level — in a multi-process deployment they would not serialise across processes. For a single-instance product (which this is by design), advisory locks are the simpler and correct choice.

**Append-only credit ledger.** The `credit_transactions` table is never updated or deleted from; the running balance is always derived from `SUM(credits_delta)`. This preserves a complete audit trail but means the balance computation is a full-table aggregate. For a single-instance product with at most a few hundred credit transactions, a full-table `SUM` is instantaneous. The migration comment explicitly documents that this can be replaced with a materialized view or running-balance trigger if the table grows — the `credit_balance` view is the interface, so the implementation can change without touching application code.

**Per-order credit attribution is best-effort.** When `consumeCredit` inserts a consumption row, it must supply a foreign key to `access_grants.razorpay_order_id`. The code picks the most recently paid `credits_pack` order as the FK target. This is correct for the common case (one credits pack at a time) but breaks down if multiple packs are purchased: all consumption is attributed to the most recent order regardless of which order's credits are actually being used. The architecture review (H-2) flagged this. We accepted it for Phase 1 because: (a) the global balance is always correct; (b) the single-instance deployment is unlikely to have concurrent credits packs; and (c) implementing true FIFO-per-order attribution requires a more complex query. This is documented as a known gap, not an oversight.

**ip-api.com free tier (45 requests/minute), mitigated by in-process cache.** The geolocation service calls ip-api.com, whose free tier rate-limits at 45 requests per minute. Without caching, a user refreshing the pricing page multiple times could exhaust the limit and hide the UPI option for other users. The implementation caches results in a module-level `Map` keyed by IP address with a 15-minute TTL. This means a single process restart clears the cache, but for a single-instance deployment this is acceptable. The `GEOLOCATION_API_URL` env var allows substituting a self-hosted MaxMind proxy if rate limits become an issue. Stripe international payments are deferred to Phase 2.

**No FIFO credit allocation, no per-order remaining balance.** The balance is a single global pool. There is no concept of "credits remaining on order X" — only total credits remaining. This was a deliberate Phase 1 simplification. The consequence is that refunding one credits pack does not automatically reduce the spendable balance (refund handling is out of scope for this phase; it would require negative-delta entries on refund events).

---

## 4. Tests the AI ran to verify this works

Tests run via `bunx vitest run src/payment/ --reporter=verbose`. All 57 tests passed.

**File:** `src/payment/__tests__/razorpay.test.ts` — 36 tests, all passing

| Test group | What it proves |
|---|---|
| `isPaymentEnabled()` (3 tests) | Returns `true` when `RAZORPAY_KEY_ID` is non-empty; `false` when absent or empty string. |
| `initRazorpay()` (5 tests) | Throws a descriptive error (without echoing the secret) when `KEY_ID` or `KEY_SECRET` is missing; returns a Razorpay instance when both are present; returns the same singleton instance on repeated calls. |
| `verifyPaymentSignature()` (5 tests) | Returns `true` for a correctly computed HMAC-SHA256 of `orderId\|paymentId`; `false` for a wrong signature, an absent secret, or a right-length but wrong-value signature; uses `crypto.timingSafeEqual`. |
| `verifyWebhookSignature()` (6 tests) | Returns `true` for the correct HMAC of a raw Buffer; `false` when the body bytes are tampered; `false` for a correct body but wrong signature; `false` when `RAZORPAY_WEBHOOK_SECRET` is absent; handles non-ASCII bytes; returns `false` (does not throw) for a malformed header signature. The tampered-body test specifically verifies that the re-serialization attack (`JSON.parse` → `JSON.stringify`) fails, confirming the Buffer-only contract works as intended. |
| `getCreditBalance()` (3 tests) | Queries the `credit_balance` view (not the raw table); parses the NUMERIC result as a number; returns 0 when no rows exist. |
| `consumeCredit()` (14 tests) | Throws for negative, zero, NaN, and non-integer amounts (credit-minting prevention); returns `{success: false}` on insufficient balance and calls `ROLLBACK`; returns `{success: false}` when no paid `credits_pack` order exists; returns `{success: true, remainingBalance: N-amount}` on a successful debit; calls `BEGIN`, `pg_advisory_xact_lock(7241964)`, and `COMMIT` in that order; calls `ROLLBACK` and rethrows on unexpected DB errors; calls `client.release()` in `finally` on success, DB error, and insufficient balance — confirming connection pool hygiene in all exit paths. |

**File:** `src/payment/__tests__/geolocation.test.ts` — 21 tests, all passing

| Test group | What it proves |
|---|---|
| `getClientCountry()` India detection (2 tests) | Returns `{country: "India", isIndia: true, confidence: "high"}` for an Indian IP; `{country: "United States", isIndia: false, confidence: "high"}` for a US IP. |
| `getClientCountry()` failure modes (5 tests) | Returns the `unknown` sentinel and never throws on: network error, non-200 HTTP response, `status !== "success"` in the JSON, missing required JSON fields, and null JSON. |
| `getClientCountry()` timeout (1 test) | Returns `unknown` when the fetch rejects with an `AbortError` (simulated timeout). |
| `getClientCountry()` env var (2 tests) | Uses `GEOLOCATION_API_URL` as the base URL when set; falls back to `https://ip-api.com/json` when absent. |
| `getClientCountry()` URL construction (1 test) | Embeds the IP address in the request URL as `/{ip}?fields=...`. |
| `getClientCountry()` caching (3 tests) | Calls the fetch function only once for the same IP across multiple calls; returns the cached result on repeat; maintains separate cache entries for different IPs. |
| `getClientCountry()` path injection guard (1 test) | A path-injection string (`../etc/passwd`) is replaced with `0.0.0.0` before URL construction. |
| `extractClientIp()` (4 tests) | Returns `request.ip` when present; returns `"0.0.0.0"` when `request.ip` is `undefined` or empty string; passes IPv6 addresses through unchanged. |

Note: `bun test` (Bun's native test runner) fails these tests because they use `vi.resetModules()` and `vi.unstubAllEnvs()` from Vitest's mock API, which Bun's runner does not implement. The tests must be run with `bunx vitest run`. This is a known environment mismatch documented for the team.

---

## 5. Manual test cases (for human verification)

**MTC-1 — Dev mode: payment system is dormant when `RAZORPAY_KEY_ID` is absent**
- Preconditions: Local environment with no `.env` file, or `.env` with `RAZORPAY_KEY_ID=` (blank).
- Steps:
  1. Start the application (`SIMULATE=true bun run dev`).
  2. Call `isPaymentEnabled()` from a REPL or add a temporary log line.
  3. Attempt to call `initRazorpay()` directly.
- Expected result: `isPaymentEnabled()` returns `false`. `initRazorpay()` throws `"Payment mode is not enabled: RAZORPAY_KEY_ID is not set."` The error message does not contain any secret value.

**MTC-2 — Migrations apply cleanly and are idempotent**
- Preconditions: PostgreSQL 16 + TimescaleDB running via `docker compose up -d`. No prior payment tables.
- Steps:
  1. Run `bun run migrate`.
  2. Inspect the output — should show migrations 003, 004, 005 applied.
  3. Run `bun run migrate` a second time.
  4. Connect to the database: `psql $DATABASE_URL`.
  5. Run `\d access_grants` and verify columns, constraints, and indexes.
  6. Run `\d credit_transactions` and verify the FK to `access_grants` and the `chk_credit_transactions_feature_required` constraint.
  7. Run `SELECT * FROM credit_balance;` — should return `{ balance: 0 }`.
- Expected result: First migration run applies three files without error. Second run is a no-op (idempotency). Schema matches the specification in T-64 and T-72.

**MTC-3 — Cross-column CHECK constraints enforce grant type semantics**
- Preconditions: PostgreSQL running with migrations applied (MTC-2 complete).
- Steps:
  1. Connect to the database.
  2. Attempt to insert a `monthly_pass` row with `expires_at = NULL`: `INSERT INTO access_grants (razorpay_order_id, grant_type, days_granted, expires_at, status) VALUES ('rzp_test_order_1', 'monthly_pass', 30, NULL, 'pending');`
  3. Attempt to insert a `credits_pack` row with `days_granted = 5`: `INSERT INTO access_grants (razorpay_order_id, grant_type, days_granted, expires_at, status) VALUES ('rzp_test_order_2', 'credits_pack', 5, NULL, 'pending');`
  4. Attempt a valid `monthly_pass` insert with `expires_at` set to 30 days from now.
  5. Attempt a valid `credits_pack` insert with `days_granted = NULL` and `expires_at = NULL`.
- Expected result: Steps 2 and 3 fail with a PostgreSQL CHECK constraint violation. Steps 4 and 5 succeed.

**MTC-4 — Webhook signature: re-serialized JSON body fails verification**
- Preconditions: Node/Bun REPL with `RAZORPAY_WEBHOOK_SECRET=test-secret` set.
- Steps:
  1. Import `verifyWebhookSignature` from `src/payment/razorpay.ts`.
  2. Create a raw JSON string: `const raw = '{"event":"payment.captured","payload":{"z":1,"a":2}}'`.
  3. Compute the correct HMAC: `const sig = crypto.createHmac('sha256','test-secret').update(Buffer.from(raw)).digest('hex')`.
  4. Call `verifyWebhookSignature(Buffer.from(raw), sig)` — this should return `true`.
  5. Re-serialize the body: `const reserialized = JSON.stringify(JSON.parse(raw))`.
  6. Call `verifyWebhookSignature(Buffer.from(reserialized), sig)` — this should return `false`.
- Expected result: Step 4 returns `true`. Step 6 returns `false`, because `JSON.stringify(JSON.parse(...))` produces `{"event":"payment.captured","payload":{"a":2,"z":1}}` (key order may differ) or otherwise alters whitespace/escaping, changing the byte content the HMAC was computed over.

**MTC-5 — Credit consumption atomicity: concurrent requests with balance = 1**
- Preconditions: PostgreSQL running with migrations applied. A `credits_pack` grant row exists with status `paid`. The `credit_transactions` table has exactly 1 credit (one row with `credits_delta = 1`).
- Steps:
  1. From a Bun script, import `consumeCredit` and a database pool.
  2. Fire two concurrent calls simultaneously: `Promise.all([consumeCredit(db, 'backtest'), consumeCredit(db, 'backtest')])`.
  3. Inspect the results array.
  4. Query `SELECT balance FROM credit_balance;`.
- Expected result: Exactly one of the two `consumeCredit` calls returns `{success: true, remainingBalance: 0}`. The other returns `{success: false, remainingBalance: 1}` (or `0` depending on execution order). The final `credit_balance` is `0`, not `-1`.

**MTC-6 — Geolocation graceful degradation on timeout**
- Preconditions: Application running locally.
- Steps:
  1. Set `GEOLOCATION_API_URL` to an address that hangs (e.g. a local netcat listener that accepts connections but never responds: `nc -l 9999`).
  2. Call `getClientCountry('1.2.3.4')` from a test script.
  3. Observe the return value and timing.
- Expected result: The function returns `{country: null, isIndia: false, confidence: 'unknown'}` after approximately 5 seconds (the abort timeout). It does not throw, does not hang indefinitely, and does not propagate an exception to the caller.

**MTC-7 — `.env.example` safety: no active-looking key reaches production**
- Preconditions: A fresh checkout of the repository, no local `.env` file.
- Steps:
  1. Copy `.env.example` to `.env`: `cp .env.example .env`.
  2. Inspect `RAZORPAY_KEY_ID` in the new `.env`.
  3. Note that the value is `rzp_test_XXXXXXXXXXXX` — a placeholder, not blank.
  4. Start the application; observe whether `isPaymentEnabled()` is `true`.
- Expected result: The placeholder value is non-empty, so `isPaymentEnabled()` returns `true`. This is a known medium-severity issue (M-1 in the security audit) — the `.env.example` should ship with `RAZORPAY_KEY_ID=` (blank). The workaround is to manually blank the value before starting. This is flagged as a deferred fix for T-67 when the route handler work begins.

---

## 6. Security and risk notes

**Resolved findings (from Phase 4 specialist review + Phase 6 fix cycle):**

- **Critical C-1 — `FOR UPDATE` on aggregate crashes `consumeCredit` at runtime (security + architecture).** Fixed in Phase 6. The `SELECT SUM(...) FOR UPDATE` was replaced with `SELECT pg_advisory_xact_lock(7241964)` at the top of the transaction, followed by a plain `SUM` read. The advisory lock serialises concurrent consumers without the illegal aggregate+lock combination. Tests confirm `BEGIN`, `pg_advisory_xact_lock`, and `COMMIT` are called in order.

- **High H-1 — Negative/NaN/zero `amount` in `consumeCredit` mints credits (security).** Fixed in Phase 6. The function now validates `Number.isFinite(amount) && amount > 0 && Number.isInteger(amount)` and throws `"consumeCredit: amount must be a positive integer"` for any other input. Tests cover negative, zero, NaN, and float inputs.

- **High (performance) — Geolocation blocks every request with no cache.** Fixed in Phase 6 (concurrent with the security fixes). A 15-minute in-process `Map` cache was added. The performance reviewer (Severity: High) and architecture reviewer (Severity: Low) both flagged this independently.

- **Medium (architecture) — `days_granted` semantically wrong for `credits_pack`; missing cross-column constraints.** Fixed in migration 005. `days_granted` is now nullable; CHECK constraints enforce type-specific invariants at the schema level.

- **Medium (architecture) — No `updated_at` trigger.** Fixed in migration 005. A `BEFORE UPDATE` trigger now maintains `updated_at` automatically on `access_grants`.

- **Medium (architecture) — `getCreditBalance` duplicated the `credit_balance` view.** Fixed in Phase 6. `getCreditBalance` now queries `SELECT balance FROM credit_balance` rather than recomputing the aggregate inline.

- **Medium (architecture) — No schema-level audit constraint on `feature` for consumption rows.** Fixed in migration 005. `CHECK (credits_delta > 0 OR feature IS NOT NULL)` is now enforced at the database level.

**Accepted risks:**

- **Medium M-1 — `.env.example` ships a non-blank `RAZORPAY_KEY_ID` placeholder.** The value `rzp_test_XXXXXXXXXXXX` is truthy, so copying `.env.example` to `.env` activates payment mode with a garbage key while secrets remain blank — a misconfigured state that silently breaks payment flows. Accepted for Phase 1 because: the route handlers (T-67) are not yet built, so there is no user-facing payment surface to misconfigure. The fix (blank the default) will be applied when T-67 ships. Mitigation: the inline comment in `.env.example` instructs operators to set this only when enabling payment mode.

- **Medium M-2 — IP interpolated into geolocation URL without full format validation.** A basic IP character-set regex (`/^[\d.:a-fA-F]+$/`) is in place. Full validation via `net.isIP()` and `encodeURIComponent` would be stronger. Accepted because `getClientCountry` is called with values from Fastify's `request.ip` (itself proxy-trust-resolved), not directly from user input, and the geolocation result is cosmetic-only (UPI display, not a pricing or access gate).

- **High H-2 / Medium (arch) — Per-order credit attribution is best-effort.** Consumption rows always reference the most recent paid `credits_pack` order. The total balance is correct; per-order attribution is unreliable if multiple packs are purchased. Accepted for Phase 1 single-instance use; the architecture review recommends a FIFO model for Phase 2 if multi-pack purchases become common.

- **Low L-2 — `processed_webhook_events` has no idempotency helper in this module.** The idempotency check (insert-or-ignore on event ID, inside the same transaction as the grant write) must be implemented in the not-yet-written T-67 route handler. If T-67 does it outside the transaction, a crash between the grant write and the event-ID record could allow duplicate processing. This is an explicit acceptance criterion carried forward to T-67.

**Feature flag / rollback:** The entire payment subsystem is disabled by omitting or blanking `RAZORPAY_KEY_ID`. No code deletion is required to revert to free/open mode. The database tables are additive and do not affect existing trading functionality.

---

## 7. Follow-ups and deferred work

- **T-67 — Fastify payment API routes** (not yet built): POST `/payment/create-order`, POST `/payment/webhook` (with raw-body parser and transactional idempotency using `processed_webhook_events`). Blocked on M1 Fastify server setup. The webhook route inherits L-2's idempotency requirement as an explicit acceptance criterion.

- **T-68 — Access gate middleware** (not yet built): reads `access_grants` to determine whether the current session has an active `monthly_pass`, and calls `consumeCredit` for feature-gated endpoints. Blocked on M1 Fastify server setup. Inherits H-1's input-validation requirement — the gate may pass request-influenced `amount` values to `consumeCredit`.

- **T-69 — React pricing page** (not yet built): renders the Monthly Access Pass and Credits Pack purchase options; uses `getClientCountry` to show/hide the UPI payment method. Blocked on M1 React dashboard setup.

- **M-1 fix — blank `RAZORPAY_KEY_ID` in `.env.example`**: change the default from `rzp_test_XXXXXXXXXXXX` to empty. Should be done alongside T-67 so the change is tested in context.

- **L-1 — Statement timeout on `consumeCredit` transaction**: a stuck transaction holding the advisory lock can stall all feature consumption. Adding `SET LOCAL statement_timeout = '5s'` inside the transaction is a one-liner; deferred until T-68 ships and real traffic is observed.

- **Phase 2 — Stripe + international payments**: the `razorpay_order_id` column on `access_grants` and `credit_transactions` will need renaming to a provider-agnostic name (e.g. `payment_order_id`) with a `payment_provider` column added. Budget a non-trivial migration that touches the FK. Easier to do before Stripe route handlers are written.

- **Phase 2 — DPDP Act 2023 compliance review**: deferred. No raw payment instrument (card number, UPI PIN, VPA) is stored in this application — Razorpay is the data processor — but a formal review against the Digital Personal Data Protection Act 2023 is required before the product is opened to subscribers at scale.

---

## 8. References

**Task contracts:** `pipeline/tasks/T-64.json`, `pipeline/tasks/T-65.json`, `pipeline/tasks/T-66.json`, `pipeline/tasks/T-71.json`, `pipeline/tasks/T-72.json`

**Review reports:** `pipeline/reviews/security-audit.md`, `pipeline/reviews/performance-review.md`, `pipeline/reviews/architecture-review.md`

**Key changed files:**
- `src/payment/razorpay.ts` — payment service module
- `src/payment/geolocation.ts` — geolocation service
- `src/payment/__tests__/razorpay.test.ts` — 36 unit tests
- `src/payment/__tests__/geolocation.test.ts` — 21 unit tests
- `src/db/migrations/003_payment_tables.sql` — access_grants, processed_webhook_events
- `src/db/migrations/004_credit_system.sql` — credit_transactions, credit_balance view
- `src/db/migrations/005_payment_schema_constraints.sql` — constraint tightening, trigger
- `src/db/schema.ts` — AccessGrant, CreditTransaction, ProcessedWebhookEvent interfaces
- `.env.example` — payment environment variables
- `.claude/project/business.md` — Pipeline Scope governance update

**Related docs:** `.claude/project/business.md` §Payment/Billing, §PCI/PII boundary, §Pipeline Scope

# E2E Test Catalog

All Playwright end-to-end tests live in the `e2e/` directory. They run against the Vite dev server at `http://localhost:5173`. HTTP API calls are **fully intercepted via `page.route()`** — no running backend is needed for the UI tests. The personality API tests (`personalities-api.spec.ts`) are the exception: they target the live Fastify server at `http://localhost:3000` and require a migrated database.

## How to Run

```bash
# Start the Vite dev server first (required for all UI tests)
SIMULATE=true bun run dev &   # Fastify on :3000
# In another terminal: bun run vite (if you've separated front + back)

# Run all E2E tests
bun run test:e2e

# Run a single spec file
npx playwright test e2e/live-view.spec.ts

# Run only critical tests
npx playwright test --grep @critical

# Run with headed browser (shows the browser window)
npx playwright test --headed

# Debug a single test
npx playwright test --debug e2e/navigation.spec.ts
```

## Test Tag Definitions

| Tag | Meaning | Gate impact |
|-----|---------|-------------|
| `@critical` | Blocking — a failing critical test blocks Gate 2 | Must be green before merge |
| `@functional` | CONDITIONAL PASS — failures surface as named conditions at Gate 2 | Should be green; noted if not |
| `@non-blocker` | Informational — logged but does not block the gate | Track but do not block |

---

## File 1 — `e2e/live-view.spec.ts`

**Purpose:** Verify the Live dashboard tab renders correctly, handles the WebSocket connection lifecycle, and correctly distinguishes synthetic tick data from real straddle data.

All HTTP calls to `/api/straddle/latest` are mocked. WebSocket behaviour is tested by observing what happens when no WS server is reachable (connection transitions to Disconnected).

**Test count:** 7

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | The tick chart area labels the feed as synthetic/dev — not real straddle data | `@critical` | Confirms the NIFTY heading is present, the straddle section shows "not yet connected", and forbidden phrases ("live straddle", "real price") do not appear in the page body |
| 2 | When /api/straddle/latest returns `{ data: null }` the UI shows a graceful "not yet connected" notice | `@critical` | Stubs the straddle endpoint with `null`; asserts the "Straddle feed not yet connected" text is visible and no large decimal-formatted number appears in the straddle card |
| 3 | LiveView shows a connection-status pill in Connecting state when no WS server is reachable | `@critical` | Locates the `[role="status"]` pill with `aria-label^="WebSocket status"` and asserts it shows a valid state string (Connecting / Connected / Disconnected) |
| 4 | Connection pill transitions to Disconnected or reconnecting state when the WebSocket cannot connect | `@critical` | Polls the pill's `aria-label` for up to 8 seconds until it shows "disconnected" or "connected" (i.e. the Connecting initial state resolves) |
| 5 | Switching away from LiveView to another tab does not leave stale console errors | `@critical` | Listens to `console error` and `pageerror` events; navigates to Trades tab (unmounting LiveView) and asserts no React "state update on unmounted component" warnings fire |
| 6 | Switching away from LiveView and back does not crash or show visual corruption | `@non-blocker` | Round-trips Live → Trades → Live; asserts NIFTY heading and straddle notice are both present after remount, with no JS errors |
| 7 | Connection status pill has an accessible aria-label with the current status | `@non-blocker` | Asserts the pill exists and its `aria-label` is longer than 10 characters (is descriptive, not empty) |

---

## File 2 — `e2e/navigation.spec.ts`

**Purpose:** Verify the app shell and tab-switching behaviour. Confirms that each tab renders the correct view, the payment test-mode banner persists across tabs, error states surface when the backend is unreachable, and tab buttons are keyboard-accessible.

All API routes are mocked. The "backend unreachable" test aborts all `/api/**` requests.

**Test count:** 4

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | Switching between Live / Trades / P&L / Pricing tabs renders the right view | `@functional` | Clicks each of the four tabs and asserts the expected heading appears and the previous heading disappears: Live→ "NIFTY Index", Trades→ "Paper Trades", P&L→ "P&L Summary", then back to Live |
| 2 | All three wired tabs show an error or unavailable state when the backend is completely unreachable | `@functional` | Aborts all `/api/**` requests to simulate offline backend; visits Live (WS pill must appear), Trades (error alert must appear), and P&L (error alert must appear) — no white screen, no JS exceptions |
| 3 | PaymentTestModeBanner remains visible on all four tabs | `@non-blocker` | Cycles through all four tabs and confirms the `<header>` element is visible after each tab switch (the payment test-mode banner lives in the header) |
| 4 | Tab buttons are keyboard-focusable and activatable via Enter | `@non-blocker` | Focuses the "Live" button, presses Tab to move focus to "Trades", presses Enter, and asserts the "Paper Trades" heading becomes visible |

---

## File 3 — `e2e/personalities-api.spec.ts`

**Purpose:** Test the personality CRUD REST API (`/personalities`) at the HTTP level using Playwright's `APIRequestContext`. No browser window is opened — these are pure API tests. Requires a running Fastify server on `http://localhost:3000` with a migrated database.

Personality IDs are fetched dynamically from `GET /personalities` rather than hardcoded, so the tests are not brittle to UUID changes.

**Test count:** 7

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | GET /personalities returns a list of personalities | `@critical` | Status 200, response body is a non-empty JSON array |
| 2 | GET /personalities returns 9 active personalities by default (Levelhead excluded) | `@functional` | Array length is exactly 9, all items have `isActive:true`, Levelhead is absent |
| 3 | GET /personalities?include_inactive=true returns 10 personalities | `@functional` | With the flag, all 10 seed rows are returned (including Levelhead with `is_active=FALSE`) |
| 4 | GET /personalities/:id returns 404 for unknown UUID | `@non-blocker` | A well-formed but non-existent UUID (`00000000-0000-...`) returns 404 with `{"error":"NOT_FOUND"}` |
| 5 | PUT /personalities/:id returns 403 FROZEN_VIOLATION when target is Clockwork | `@critical` | Fetches the frozen personality ID dynamically; PUT to that ID returns 403 with `error:"FROZEN_VIOLATION"` and a message matching `/immutable/i` |
| 6 | PUT /personalities/:id returns 409 COMPARISON_INTEGRITY_VIOLATION when min_probability drift > 8pp | `@critical` | Reads current `min_probability` for all momentum_exhaustion personalities, computes a violating value (+9pp from the minimum), PUTs it, and asserts 409 with `error:"COMPARISON_INTEGRITY_VIOLATION"` |
| 7 | PUT /personalities/:id validates param ranges and returns 400 for out-of-range values | `@functional` | Tests two cases: `min_probability:0.95` (above 0.90 ceiling) and `min_probability:0.30` (below 0.40 floor) — both must return 400 |
| 8 | PUT /personalities/:id writes audit log entry on successful change | `@functional` | Makes a valid +0.01 change, asserts 200 with updated params, then restores the original value — confirms the happy-path HTTP contract (DB-level audit log is verified in integration tests) |
| 9 | GET /personalities/:id/performance excludes pre-M2 NULL personality_id rows | `@critical` | Fetches performance for an active personality; asserts `personalityId` matches, `winRate` ∈ [0,1], `totalTrades` ≥ 0 — proves the `WHERE personality_id = $1` query does not leak NULL rows |
| 10 | GET /personalities/:id/performance returns personality-scoped stats only | `@critical` | Fetches performance for two different personality IDs in parallel; asserts each response's `personalityId` matches the requested ID |

---

## File 4 — `e2e/pnl-view.spec.ts`

**Purpose:** Verify the P&L dashboard tab computes and displays financial figures correctly. All critical arithmetic invariants are tested: correct decimal summation, exclusion of open trades from totals, win-rate denominator, IST date boundaries, and correct error/empty states.

All `/api/trades` responses are mocked via `page.route()`. Trade payloads are constructed using the `makeTrade()` factory with field overrides.

**Test count:** 8

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | Total net P&L is the correct arithmetic sum — not string concatenation | `@critical` | Feeds 3 trades (100.00, 200.50, −50.25); asserts the Realized P&L card shows `250.25`, not string concatenation (`"100.00200.50"`) or NaN |
| 2 | Open trades with null net_pnl are excluded from the total P&L sum | `@critical` | 1 closed trade (300.00) + 1 open trade (null); asserts total is 300.00 and no NaN appears |
| 3 | When /api/trades returns HTTP 500 PnlView shows an error notice, not a zeroed-out P&L dashboard | `@critical` | Stubs `/api/trades` with 500; asserts `role="alert"` appears with error text, and the Realized P&L stat card is **not** visible (zeroed data looks like a quiet day — very misleading) |
| 4 | Today's P&L uses IST date boundaries | `@critical` | Uses a trade with `exit_time` at midnight IST on "today"; asserts the value `500.00` appears and no NaN is present — confirms the IST `+05:30` offset logic |
| 5 | Win rate is computed as closed-wins / total-closed — open trades excluded from denominator | `@functional` | 2 winning + 1 losing closed trades + 2 open trades; asserts win rate shows `66.7%` (2/3), not `40.0%` (2/5) |
| 6 | Cumulative P&L chart renders without crash when there are only open trades | `@functional` | Single open trade; asserts "No closed trades yet" text visible, cumulative chart is not rendered, no JS errors |
| 7 | When /api/trades returns an empty array PnlView shows a no-closed-trades empty state | `@functional` | Empty array; asserts "No closed trades yet" visible, Realized P&L card not visible |
| 8 | Open and closed position counts are displayed separately and accurately | `@functional` | 3 open + 5 closed trades; asserts "Closed Trades" card shows `5` and "Open Positions" card shows `3` |
| 9 | Total net P&L is colored green for positive values and red for negative | `@non-blocker` | Positive total: asserts a `p.text-green-400` element is visible |

---

## File 5 — `e2e/trades-view.spec.ts`

**Purpose:** Verify the Trades dashboard tab renders paper trades correctly — including correct parsing of NUMERIC string fields from the API, color-coded P&L, IST timestamps, status badges, and appropriate error/empty states.

All `/api/trades` responses are mocked. Trades are built with the `makeTrade()` factory.

**Test count:** 9

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | NUMERIC string fields render as formatted numbers, not raw strings | `@critical` | Trade with `net_pnl:"-45.00"` and `straddle_at_entry:"22456.75"` — asserts numbers are formatted (not raw JSON strings with quotes), digits `45` and `22...456` visible in the row |
| 2 | Negative net_pnl is colored red and positive net_pnl is colored green | `@critical` | 1 negative and 1 positive trade; asserts `span.text-red-400` contains the negative value and `span.text-green-400` contains the positive value |
| 3 | Open trades with null net_pnl show an em dash placeholder — never NaN or undefined | `@critical` | Open trade with `net_pnl:null`; asserts `span.text-gray-500` with `—` is visible, page body contains neither `NaN` nor `undefined` |
| 4 | When /api/trades returns an empty array TradesView shows a "No trades yet" empty state | `@critical` | Empty array; asserts "No paper trades yet" text visible, no table rows present (table is not rendered in empty state) |
| 5 | When /api/trades returns HTTP 500 TradesView shows an error notice and does not crash | `@critical` | 500 stub; asserts `role="alert"` appears, alert text matches `/couldn\|load\|error\|fail/`, no JS exceptions |
| 6 | Entry times are displayed in IST — 04:00 UTC renders as 09:30 IST | `@functional` | Trade with `entry_time:"2026-05-23T04:00:00.000Z"` (= 09:30 IST); asserts row text contains `09:30` and does not contain `04:00` |
| 7 | Status badges render for open and closed trade status values | `@functional` | 1 open + 1 closed trade; asserts both "Open" and "Closed" badge texts visible, no "undefined" in page |
| 8 | When /api/trades returns HTTP 404 TradesView shows an error notice rather than an empty table | `@functional` | 404 stub; asserts `role="alert"` visible, "No paper trades yet" is NOT shown (404 is not the same as no data) |
| 9 | Exit reason is shown for closed trades and a dash for open trades | `@non-blocker` | Closed trade with `exit_reason:"stop_loss"` + open trade; asserts `stop_loss` text in page body |
| 10 | Straddle-at-entry column shows a formatted decimal number, not scientific notation | `@non-blocker` | `straddle_at_entry:"22456.75"`; asserts no `e+4` notation in page body, and `22456` digits are present |

---

## Coverage Summary

| Spec file | Tests | @critical | @functional | @non-blocker |
|-----------|-------|-----------|-------------|--------------|
| live-view.spec.ts | 7 | 4 | 0 | 3 |
| navigation.spec.ts | 4 | 0 | 2 | 2 |
| personalities-api.spec.ts | 10 | 6 | 4 | 1 |
| pnl-view.spec.ts | 9 | 4 | 4 | 1 |
| trades-view.spec.ts | 10 | 5 | 4 | 2 |
| **Total** | **40** | **19** | **14** | **9** |

---

## What Is Not Covered by E2E Tests

These scenarios are covered in unit or integration tests instead:

| Scenario | Covered in |
|----------|-----------|
| DB-level audit log row exists after PUT | `src/test/integration/personalities-api.integration.test.ts` |
| TimescaleDB hypertable migration idempotency | `src/test/integration/migrations.integration.test.ts` |
| Peak detection algorithm correctness | `src/signals/__tests__/peak-detection-engine.test.ts` |
| Replay determinism (100× identical-ledger gate) | `src/ingestion/historical/__tests__/replay-determinism.test.ts` |
| Clockwork evolution guard (`is_frozen` check) | `src/trading/__tests__/entry-engine.test.ts` |
| Razorpay webhook HMAC verification | `src/payment/__tests__/razorpay.test.ts` |
| ATM strike rounding (property tests) | `src/utils/__tests__/atm-strike.property.test.ts` |
| P&L arithmetic sign convention | `src/utils/__tests__/pnl.property.test.ts` |

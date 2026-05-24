# Epic: Frontend Dashboard Wiring

| Field      | Value                                      |
|------------|--------------------------------------------|
| Status     | Completed                                  |
| Date       | 2026-05-24                                 |
| Branch     | claude/sweet-wright-ORLM0                  |
| Tasks      | T-01, T-02, T-03, T-04, T-05              |
| Risk level | LOW                                        |

## 1. What was done

Three dashboard tabs that previously showed placeholder content were wired to
the endpoints the running backend (`src/server/index.ts`) actually serves. The
entire scope was strictly frontend-only — zero backend files were modified.

**T-04 — Shared scaffolding** (`src/frontend/lib/`, `src/frontend/types/`)

- `api.ts`: a typed `apiGet<T>()` helper that returns a discriminated union
  (`{ ok: true; data }` / `{ ok: false; error, status }`). Callers must handle
  the error branch explicitly; a 404 is never silently treated as empty data.
  Also exports `unwrapData()` to unpack the server's `{ data: T }` envelope.
- `format.ts`: `toNumberOrNull()` for safe coercion of PostgreSQL NUMERIC
  strings; `formatPnl()` for signed Indian-locale P&L strings; `formatIstDateTime()`
  and `istToday()` for IST-correct date/time display using `Intl.DateTimeFormat`
  with `timeZone: 'Asia/Kolkata'` throughout.
- `types/trading.ts`: `PaperTrade`, `ApiEnvelope<T>`, and the `TickMessage`
  discriminated union (`WsConnectedMessage | WsTickMessage`) shared across hooks
  and components.

**T-01 — Live tab** (`hooks/useLiveTicks.ts`, `components/LiveView.tsx`)

- `useLiveTicks`: manages a single WebSocket to `/ws/ticks`, maintains a 300-
  point ring buffer, reconnects with exponential backoff + jitter (3 s base,
  30 s cap), and is React 18 StrictMode-safe (detaches `onclose` before
  `close()` to prevent double-mount reconnect storms).
- `LiveView`: renders a NIFTY index LTP, a Lightweight Charts sparkline of the
  tick buffer, a colour-coded connection-status pill (green/amber/red), and a
  separate `StraddleSection` that polls `GET /api/straddle/latest` every 10 s.
  The synthetic tick feed is labeled with an amber "Synthetic dev feed" warning.
  The straddle section shows a "Straddle feed not yet connected" notice while the
  endpoint returns null, and will display the real value automatically once the
  straddle calculator connects.

**T-02 — Trades tab** (`hooks/usePaperTrades.ts`, `components/TradesView.tsx`)

- `usePaperTrades`: polls `GET /api/trades` every 10 s with an AbortController
  for clean unmount cancellation and an `inFlightRef` guard that prevents
  overlapping requests when the server is slow.
- `TradesView`: renders four distinct states — loading skeleton, empty-state,
  error banner (amber, with the previous data still visible if available), and
  the trade table. NUMERIC string fields from PostgreSQL are coerced via
  `toNumberOrNull()` before display. P&L cells are green for positive, red for
  negative, and show an em dash for open trades. Entry times are IST.

**T-03 — P&L tab** (`src/frontend/lib/pnl.ts`, `components/PnlView.tsx`)

- `computePnlSummary()` in `pnl.ts`: a pure function (no React dependency)
  that computes total realized P&L, today's realized P&L (IST day boundaries),
  win rate, open/closed counts, and a cumulative P&L series sorted by
  `exit_time` for the chart. Null P&L values are skipped, never counted as zero.
- `PnlView`: displays the five metric tiles and a Lightweight Charts cumulative
  P&L line. The chart is split into two effects (create once on mount; push data
  on each poll) so user zoom/scroll survives background polling. Error state does
  not render metrics — showing "0.00" during a failed fetch would be misleading
  to a trader.

**T-05 — Delete stale frontend tree**

The top-level `frontend/` directory (an old duplicate of `src/frontend/`) was
confirmed unreferenced (no import or script pointed to it) and deleted. The
stale `"frontend/node_modules"` ignore entry in `biome.json` was also removed.

## 2. How this helps the project

Before this epic the dashboard had four tabs, three of which showed static
placeholder text regardless of what the backend was doing. A trader running the
system in simulation mode would see no live data, no trade log, and no P&L
history — making the dashboard useless for monitoring.

After this epic:
- The Live tab shows a real-time NIFTY index feed the moment the backend starts.
  When the straddle calculator is eventually connected, the straddle value
  appears automatically with no code change needed.
- The Trades tab shows all paper trades from the database, colour-coded by
  outcome, refreshing every 10 seconds.
- The P&L tab shows realized P&L totals, today's P&L, win rate, and a running
  cumulative chart — the primary at-a-glance view for evaluating whether the
  strategy is working.

The frontend will continue to degrade gracefully if the backend is unreachable:
each tab shows an error or "not yet connected" state rather than crashing or
displaying misleading zeros.

## 3. Limitations & tradeoffs (and why we chose this)

**Synthetic tick feed, not real straddle data**

The Live tab's WebSocket feed (`/ws/ticks`) emits a random-walk NIFTY index
ticker, not the actual ATM straddle premium. The straddle value section is
genuinely a stub: `/api/straddle/latest` returns `{data: null}` until the
straddle calculator in `src/ingestion/straddle-calc.ts` is connected to the
running server. This is not a frontend deficiency — the real-data server
(`src/api/server.ts`) exists and is tested, but it is not yet mounted at
runtime. Mounting it requires a backend refactor that touches payment routes;
the user explicitly chose to defer that as a separate backend task (Gate 1
decision A). The UI labels the synthetic feed clearly so a trader cannot
confuse it with real option data.

**Realized-only P&L**

The P&L tab reports only realized P&L (closed trades with a non-null
`exit_time` and `net_pnl`). Open trades are counted and displayed separately
but contribute no P&L figure because the frontend has no access to current
market prices. Inventing an unrealized P&L would require the frontend to know
the current straddle value — which is exactly what the still-stubbed straddle
endpoint would provide. This constraint is documented in the component and is
the correct choice for a trading dashboard where a misleading P&L number is
worse than no number.

**Frontend excluded from `bun run typecheck`**

`tsconfig.json` excludes `src/frontend/**/*`, so the standard `bun run
typecheck` command does not type-check any frontend TypeScript. This is a
pre-existing project posture, not introduced by this task. A manual one-off
`tsc` pass was run during Phase 6 and returned clean. The consequence is that
future PRs touching frontend files will not have an automated type-safety gate
in CI unless a `tsconfig.frontend.json` + `typecheck:frontend` script are
added. This is flagged as a follow-up (see section 7).

**E2E tests deferred to CI**

Playwright requires a Chromium binary and a running Vite dev server. Neither is
available in the pipeline execution environment, so the 30 E2E specs were
written and parsed (zero syntax errors, correct tag breakdown confirmed by
`playwright test --list`) but not executed. They use `page.route()` intercepts
to mock `/api/trades` and `/api/straddle/latest`, making them deterministic and
not dependent on real DB data. They will run in any environment with Chromium
and a live Vite server.

**`usePaperTrades` state is per-instance, not shared**

Both `TradesView` and `PnlView` import `usePaperTrades`. Each import creates a
separate polling loop. This is safe today because `App.tsx` renders tabs
exclusively (only one tab is mounted at a time), so only one polling loop ever
runs. The hook's doc-comment was updated to document this constraint explicitly.
If a future layout mounts both tabs simultaneously, the correct fix is to lift
the state into a Zustand store or React context — not to duplicate the logic.

## 4. Tests the AI ran to verify this works

**Unit tests (Vitest) — executed during Phase 6**

`bun run test:unit` → 360 passed / 4 skipped (pre-existing skips for Redis/
Docker integration tests that require running services).

The unit suite covers all business logic in the new shared library:

| File | What it proves | Result |
|---|---|---|
| `src/frontend/lib/format.test.ts` | `toNumberOrNull` null/NaN/number cases; `formatPnl` sign and Indian-locale formatting; `formatIstDateTime` IST correctness (UTC input → IST output); `istToday` IST day boundary (18:30 UTC = IST midnight) | Pass |
| `src/frontend/lib/pnl.test.ts` | `computePnlSummary` numeric string coercion; null-skip (not zero) for missing P&L; open-trade exclusion from totals; IST today-boundary filter; win-rate denominator (closed only); `cumulativeSeries` sorted by `exit_time` with running total; divide-by-zero guard on empty input | Pass |

These tests do not cover React hooks or components (no jsdom / testing-library
in this environment). Hook and component tests were deferred per the
frontend-only scope constraint.

**Frontend one-off typecheck — executed during Phase 6**

A `tsc` invocation against the frontend files with `--jsx react-jsx
--moduleResolution bundler` returned exit code 0 (clean). One
`exactOptionalPropertyTypes` error in `api.ts` was caught and fixed during
Phase 3 before this check.

**E2E tests (Playwright) — not executed; CI-only**

30 specs written across four files. Confirmed parseable via `playwright test
--list` with zero errors. Tag breakdown:
- 14 `@critical` tests (Automation Gate: FAIL if any fail)
- 9 `@functional` tests (Automation Gate: CONDITIONAL PASS if any fail)
- 7 `@non-blocker` tests (logged only)

The specs were not run end-to-end. No pass/fail counts are available from this
pipeline run. To execute:

```bash
npx playwright install chromium
SIMULATE=true bun run sim          # backend on port 3000
bunx vite                          # frontend on port 5173
bun run test:e2e
```

## 5. Manual test cases (for human verification)

**Prerequisites for all MTCs:**
- Docker services running: `docker compose up -d && docker compose ps` (both healthy)
- Backend started: `SIMULATE=true bun run sim` (port 3000, wait for "server listening")
- Frontend started: `bunx vite` (port 5173)
- Open `http://localhost:5173` in a browser

---

**MTC-1 — Live tab: synthetic feed label is visible and honest**
- Preconditions: App loaded, Live tab active (default).
- Steps:
  1. Look at the NIFTY Index section.
  2. Read every label near the LTP number.
- Expected result: An amber warning strip reading "Synthetic dev feed — not real
  straddle data" appears above the sparkline. No label uses the words "live
  straddle", "real price", or any phrasing implying actual option data.

**MTC-2 — Live tab: WebSocket connection indicator**
- Preconditions: App loaded on Live tab with backend running.
- Steps:
  1. Observe the status pill in the top-right of the NIFTY Index card.
  2. Stop the backend process (`Ctrl-C` on `bun run sim`).
  3. Wait 5–10 seconds. Observe the pill.
  4. Restart the backend.
- Expected result: Pill reads "Connected" (green) when backend is up. Switches
  to "Disconnected — reconnecting" (red, pulsing) within a few seconds of the
  backend stopping. Returns to "Connected" after the backend restarts and the
  automatic reconnect fires.

**MTC-3 — Live tab: straddle stub shows honest notice**
- Preconditions: App loaded on Live tab.
- Steps:
  1. Look at the "NIFTY Straddle Value" card below the sparkline.
- Expected result: The card shows "Straddle feed not yet connected" with a note
  that it will update automatically once the feed is live. No numeric value,
  no zero, no NaN.

**MTC-4 — Live tab: LTP updates in real time**
- Preconditions: App loaded on Live tab, WebSocket connected.
- Steps:
  1. Note the current LTP value.
  2. Wait 10 seconds.
  3. Note the new LTP value and the "Last update" timestamp.
- Expected result: LTP changes (simulator sends a new random-walk tick every
  ~5 s). The "Last update" timestamp increments and shows a time in IST (e.g.
  "23/05/2026, 14:30:12"), not UTC.

**MTC-5 — Trades tab: empty state when no trades exist**
- Preconditions: Database has no paper trades (fresh Docker volume, or
  `docker compose down -v && docker compose up -d && bun run migrate`).
- Steps:
  1. Click the Trades tab.
  2. Wait for the initial load (skeleton shimmer disappears, ~1 s).
- Expected result: A "No paper trades yet" message with a sub-line "Trades will
  appear here once the engine enters a position." No table, no NaN, no crash.

**MTC-6 — Trades tab: data display with real trades**
- Preconditions: At least one paper trade exists in the database.
- Steps:
  1. Click the Trades tab.
  2. Read the Entry Time column for any row.
  3. Read the Net P&L column for a closed trade.
  4. Read the Net P&L column for an open trade.
  5. Note the Status badge.
- Expected result: Entry times show IST (format "DD/MM/YYYY, HH:mm:ss"). Closed
  trades with a positive net P&L show a green formatted number (e.g. "+1,234.50").
  Closed trades with a negative net P&L show a red formatted number (e.g.
  "-300.00"). Open trades show an em dash "—" in the P&L columns. Status badges
  show "Open" (green pill) or "Closed" (gray pill).

**MTC-7 — Trades tab: error state**
- Preconditions: App loaded on Trades tab.
- Steps:
  1. Stop the backend process.
  2. Wait for the next 10 s poll cycle.
- Expected result: An amber banner "Couldn't load trades — retrying…" appears.
  If trades were already loaded, the existing table remains visible below the
  banner (stale data is shown, not blanked). No crash.

**MTC-8 — P&L tab: error state does not show fake zeros**
- Preconditions: App loaded on P&L tab.
- Steps:
  1. Stop the backend.
  2. Switch to the P&L tab (or stay if already there).
  3. Wait for the next poll.
- Expected result: An amber "Couldn't load P&L data — retrying…" banner appears.
  The metric tiles and chart are NOT shown. A blank P&L tab is preferable to
  showing "Realized P&L: 0.00" when the data is unavailable.

**MTC-9 — P&L tab: realized totals and win rate with closed trades**
- Preconditions: At least two closed paper trades with different net_pnl signs.
- Steps:
  1. Click the P&L tab.
  2. Read "Realized P&L (closed trades)", "Today's P&L (IST)", and "Win Rate".
  3. Verify the cumulative chart renders without a flash every 10 s by watching
     it for ~30 s.
- Expected result: Totals match the signed sum of `net_pnl` values for closed
  trades. Win rate = (profitable closed trades) / (total closed trades) ×
  100%. Chart does not flicker, disappear, or reset zoom between poll cycles.

**MTC-10 — P&L tab: open positions reported separately**
- Preconditions: At least one trade with `status = 'open'` in the database.
- Steps:
  1. Click the P&L tab.
  2. Read the "Open Positions" tile.
- Expected result: Count matches the number of open trades. The tile includes a
  note "Unrealized P&L not shown". No unrealized P&L figure appears anywhere.

**MTC-11 — Tab switching cleans up background activity**
- Preconditions: App loaded, Live tab active, WebSocket connected.
- Steps:
  1. Open browser DevTools → Network panel, filter to WS connections.
  2. Switch to the Trades tab.
  3. Watch the Network panel for 30 s.
- Expected result: The WebSocket connection closes on leaving the Live tab. No
  reconnect attempts fire while on the Trades tab. No `/api/trades` requests
  appear while on the Live tab (and vice versa after switching back).

**MTC-12 — All tabs show graceful state when backend is completely unreachable**
- Preconditions: Backend not running (or never started).
- Steps:
  1. Open `http://localhost:5173`.
  2. Click through Live, Trades, and P&L tabs.
- Expected result: Live tab shows "Connecting…" / "Disconnected — reconnecting"
  pill. Straddle section shows "Straddle feed not yet connected". Trades tab
  shows an error banner after the first failed poll. P&L tab shows an error
  banner. No white screen, no unhandled JavaScript exception in the console.

## 6. Security & risk notes

**Risk level:** LOW. This epic touches only frontend display code. No
authentication, no session handling, no PII, and no payment code was modified.
The scope did not expand the server's API surface — the frontend consumes
endpoints that were already running.

**Architecture review findings resolved (Phase 4 — CONDITIONAL PASS → fixed)**

The single Medium finding from the architecture review was fixed before Gate 3:

- **M1 (Medium) — CumulativeChart rebuild on every poll:** `PnlView` was
  updated to use `useMemo(() => computePnlSummary(trades), [trades])` and
  `CumulativeChart` was restructured into the split-effect pattern (create on
  mount; `setData` on series change). The chart no longer tears down and
  rebuilds every 10 seconds. Commit: `fix(frontend): address Gate 2 review`.

Low findings status:

- **L1 — `usePaperTrades` doc-comment ambiguity:** resolved — comment updated
  to explicitly state "state is per-hook-instance, not shared across mounts."
- **L2 — `React.ReactNode` without import in `TradesView.tsx`:** resolved —
  replaced with `import type { ReactNode } from 'react'`.
- **L3 — Frontend excluded from `bun run typecheck`:** accepted as a pre-
  existing project posture; deferred as a follow-up (see section 7).
- **L4 — Stale `biome.json` ignore entry:** resolved — `"frontend/node_modules"`
  removed from `files.ignore`.
- **L5 — Extensionless imports in `App.tsx`:** accepted as a cosmetic Vite
  no-op; no functional impact.

**Accepted risks:**

- The synthetic WebSocket feed could be misread as real straddle data by a user
  who misses the amber label. Mitigation: the label is always visible above the
  chart when ticks are present; the straddle section is explicitly separated
  into its own card with a "not yet connected" notice.

**Feature flag / rollback:** No feature flag was introduced. The change is
frontend-only. To disable: revert the `feat(frontend): wire Live and Trades
tabs` and `feat(frontend): P&L tab` commits, or switch `App.tsx` back to
the placeholder components. The backend is unaffected in either case.

## 7. Follow-ups & deferred work

1. **Mount the real-data server (`src/api/server.ts`)** — The fully-tested
   real-data server is not yet wired as the runtime server. Doing so requires
   a backend refactor that touches payment routes and was deliberately deferred
   to avoid breaking that boundary in a frontend-only task. Once mounted, the
   straddle feed will light up automatically with no frontend changes needed.

2. **Add `tsconfig.frontend.json` + `typecheck:frontend` script** — Frontend
   TypeScript is excluded from `bun run typecheck`. Adding a separate frontend
   tsconfig and a CI step would catch type regressions in `.tsx` files before
   they reach production. This is a two-file, one-script change with high
   ongoing value.

3. **Run E2E tests in CI** — The 30 Playwright specs were written and
   validated for syntax but not executed in this pipeline (no Chromium binary).
   Add `npx playwright install chromium` to the CI environment setup and
   `bun run test:e2e` to the CI pipeline.

4. **Hook/component unit tests** — Unit tests cover the pure lib functions
   (`format.ts`, `pnl.ts`) but not the React hooks or components. Adding
   `@testing-library/react` + `jsdom` would allow testing `useLiveTicks`
   cleanup, `usePaperTrades` polling, and component state transitions. Deferred
   because it requires a dev-dependency change beyond the frontend-only scope.

5. **Lift `usePaperTrades` state to Zustand** — If a future layout ever
   renders both `TradesView` and `PnlView` simultaneously, two independent
   polling loops will hit `/api/trades`. The correct fix is a Zustand store or
   React context at the App level. No action needed while tabs are exclusive.

## 8. References

**Task contracts:**
- `pipeline/tasks/T-01.json` — Live tab (WebSocket + straddle poll)
- `pipeline/tasks/T-02.json` — Trades tab
- `pipeline/tasks/T-03.json` — P&L tab
- `pipeline/tasks/T-04.json` — Shared scaffolding (api, format, pnl, types)
- `pipeline/tasks/T-05.json` — Delete stale `frontend/` tree

**Review reports:**
- `pipeline/reviews/architecture-report.md` — Full architecture findings
- `pipeline/reviews/synthesis.md` — Phase 4 synthesis (CONDITIONAL PASS)
- `pipeline/reviews/automation-gate.md` — E2E gate result (CI-ONLY)

**Key changed files:**
- `src/frontend/lib/api.ts`
- `src/frontend/lib/format.ts`
- `src/frontend/lib/pnl.ts`
- `src/frontend/types/trading.ts`
- `src/frontend/hooks/useLiveTicks.ts`
- `src/frontend/hooks/usePaperTrades.ts`
- `src/frontend/components/LiveView.tsx`
- `src/frontend/components/TradesView.tsx`
- `src/frontend/components/PnlView.tsx`
- `e2e/live-view.spec.ts`
- `e2e/trades-view.spec.ts`
- `e2e/pnl-view.spec.ts`
- `e2e/navigation.spec.ts`
- `biome.json` (stale ignore entry removed)

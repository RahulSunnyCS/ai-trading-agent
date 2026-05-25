/**
 * E2E tests for M5 Dashboard and Charting (user-observable, browser-based).
 *
 * Covers the QA checklist items from "Dashboard and Charting" and
 * "Performance and Observability" (UI-observable parts) for Milestone 5.
 *
 * These tests use page.route() to mock API responses — no running backend is
 * required. Only the Vite dev server (http://localhost:5173) must be up.
 *
 * What M5 adds that is user-observable on the dashboard:
 *   - Multi-index: the live view should not break when backend returns straddle
 *     data for a non-NIFTY underlying (resilience test).
 *   - SR level overlay: NOT implemented in the frontend yet — tests for this
 *     are skipped with an explicit reason.
 *   - Per-index selector: NOT implemented in the frontend yet — skipped.
 *   - Levelhead in Personalities tab: covered in personalities-dashboard.spec.ts.
 *
 * Required env vars: none — all data is mocked.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function installBaseMocks(page: Page): Promise<void> {
  await page.route('**/api/straddle/latest', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    });
  });

  await page.route('**/api/trades', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.route('**/api/personalities*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.route('**/api/meta', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ simulate: true, broker: 'sim', authDegraded: false }),
    });
  });
}

// ---------------------------------------------------------------------------
// SKIPPED: SR level overlay on chart
//
// QA: "SR level overlay renders on the dashboard when Levelhead is active and
//     SR levels are computed" @non-blocker
//
// Reason: The SR level overlay is not yet implemented in the React frontend
// (src/frontend/components/LiveView.tsx). The chart (lightweight-charts) does
// not yet have any S/R level overlay code. This is a Phase 2 frontend feature
// planned for after T-43 backend completion is verified.
// ---------------------------------------------------------------------------

test.skip('SR level overlay renders on the chart when Levelhead is active and SR levels are seeded — SKIPPED: SR overlay not implemented in frontend (Phase 2 UI backlog)', () => {});

// ---------------------------------------------------------------------------
// SKIPPED: Per-index selector in Live view
//
// QA: "The dashboard displays a per-index selector allowing the user to switch
//     between NIFTY, BankNifty, and Sensex views" @non-blocker
//
// Reason: LiveView is currently hardcoded to display "NIFTY Index (Live Feed)"
// only. No index selector UI exists in src/frontend/components/LiveView.tsx.
// Multi-index display is planned as a Phase 2 frontend enhancement.
// ---------------------------------------------------------------------------

test.skip('Dashboard shows per-index selector for NIFTY/BankNifty/Sensex — SKIPPED: index selector not implemented in frontend (Phase 2 UI backlog)', () => {});

// ---------------------------------------------------------------------------
// SKIPPED: SR strength score and level_source displayed in active signals panel
//
// QA: "The SR strength score and level_source breakdown are visible somewhere
//     in the dashboard UI for active SR signals" @non-blocker
//
// Reason: There is no "active signals" panel or signal detail view in the
// current frontend. Signal data (including SR strength and level_source) is
// stored in the database but not yet surfaced in any React component.
// ---------------------------------------------------------------------------

test.skip('SR strength score and level_source visible in active signals panel — SKIPPED: active signals panel not implemented in frontend (Phase 2 UI backlog)', () => {});

// ---------------------------------------------------------------------------
// Live View does not break when straddle data has an underlying field
//
// QA: "Tripling the number of active underlyings does not increase tick-to-signal
//     latency by more than 3x" @non-blocker (UI-observable part: page does not crash)
//
// The straddle/latest endpoint may return an underlying field. The frontend
// must not crash or show errors when this field is present.
// ---------------------------------------------------------------------------

test('LiveView renders without errors when /api/straddle/latest returns data with an underlying field @non-blocker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Return a straddle snapshot that includes the underlying field
  // (as the multi-index backend would return for NIFTY straddle data).
  await page.route('**/api/straddle/latest', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          value: 22456.75,
          symbol: 'NSE:NIFTY50-INDEX',
          underlying: 'NIFTY',
          timestamp: '2026-05-25T04:00:00.000Z',
        },
      }),
    });
  });

  await page.route('**/api/meta', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ simulate: true, broker: 'sim', authDegraded: false }),
    });
  });

  await page.goto('/');
  // Default tab is Live.
  await expect(page.getByRole('heading', { name: /NIFTY Index/i })).toBeVisible();

  // Wait for the straddle poll to fire and render the value.
  // The StraddleSection component renders a numeric value once snapshot is non-null.
  await expect(async () => {
    const bodyText = await page.locator('body').innerText();
    // The value 22456.75 should appear, or at minimum no NaN/crash.
    expect(bodyText).not.toContain('NaN');
  }).toPass({ timeout: 5_000 });

  // No unhandled page errors.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// LiveView shows synthetic dev feed label when meta says simulate=true
//
// QA: Performance and Observability — UI remains stable under simulation
// @non-blocker
// ---------------------------------------------------------------------------

test('LiveView shows "Synthetic dev feed" banner when /api/meta returns simulate=true @non-blocker', async ({
  page,
}) => {
  await installBaseMocks(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /NIFTY Index/i })).toBeVisible();

  // The FeedModeBanner component renders an <output> element with the aria-label
  // "Feed mode: synthetic dev feed — not real straddle data" when simulate=true.
  const banner = page.locator('[aria-label*="synthetic dev feed"]');
  await expect(banner).toBeVisible({ timeout: 5_000 });

  // The banner text must match.
  const bannerText = await banner.innerText();
  expect(bannerText.toLowerCase()).toContain('synthetic');
});

// ---------------------------------------------------------------------------
// Dashboard does not white-screen when all tabs are visited in sequence
//
// QA: "Tripling the number of active underlyings does not increase tick-to-signal
//     latency by more than 3x" @non-blocker (UI-observable: no crash across tabs)
// ---------------------------------------------------------------------------

test('All eight dashboard tabs render without crash or JS error @non-blocker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await installBaseMocks(page);

  // Suppress additional route errors for other tabs.
  await page.route('**/api/backfill*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route('**/api/regime-tags*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route('**/api/pricing/**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.goto('/');

  // Visit all eight tabs in sequence.
  const tabs = ['Live', 'Trades', 'Personalities', 'P&L', 'Pricing', 'Regimes', 'Backfill', 'Replay'];
  for (const tabName of tabs) {
    await page.getByRole('button', { name: tabName }).click();
    // Wait briefly for the tab content to render.
    await page.waitForTimeout(300);
  }

  // No unhandled JS errors across all tab visits.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Personalities tab shows correct phase numbers for all personalities
//
// QA: "The Personalities dashboard tab shows Levelhead as inactive when
//     ACTIVE_PHASE=1 and active when ACTIVE_PHASE=2" @non-blocker (visual)
//
// Mocked variant — verifies the phase column renders correctly in the UI.
// ---------------------------------------------------------------------------

test('Personalities tab renders phase numbers correctly for Phase-1 and Phase-2 personalities @non-blocker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Mock with one Phase-1 and one Phase-2 personality.
  await page.route('**/api/personalities*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 'aaa-001',
            name: 'precision',
            display_name: 'Precision',
            group_type: 'learning',
            entry_type: 'momentum_exhaustion',
            management_style: 'hold',
            is_frozen: false,
            is_active: true,
            phase: 1,
            params: { min_probability: 0.7 },
            created_at: '2026-05-01T00:00:00.000Z',
            updated_at: '2026-05-01T00:00:00.000Z',
          },
          {
            id: 'bbb-010',
            name: 'levelhead',
            display_name: 'Levelhead',
            group_type: 'learning',
            entry_type: 'sr_anchored',
            management_style: 'hold',
            is_frozen: false,
            is_active: false,
            phase: 2,
            params: { sr_strength_threshold: 0.6 },
            created_at: '2026-05-01T00:00:00.000Z',
            updated_at: '2026-05-01T00:00:00.000Z',
          },
        ],
      }),
    });
  });

  await page.route('**/api/straddle/latest', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Personalities' }).click();
  await expect(page.getByRole('heading', { name: 'Trading Personalities' })).toBeVisible();

  // Both rows should be visible.
  await expect(page.getByText('Precision')).toBeVisible();
  await expect(page.getByText('Levelhead')).toBeVisible();

  // Phase column values: "1" for Precision, "2" for Levelhead.
  const precisionRow = page.getByRole('row').filter({ hasText: 'Precision' });
  const levelheadRow = page.getByRole('row').filter({ hasText: 'Levelhead' });

  const precisionText = await precisionRow.innerText();
  const levelheadText = await levelheadRow.innerText();

  // Precision is phase 1 — the phase cell should contain "1".
  // (The phase cell renders the raw number, so "1" appears in the row text.)
  expect(precisionText).toContain('1');

  // Levelhead is phase 2 — the phase cell should contain "2".
  expect(levelheadText).toContain('2');

  // "sr anchored" entry type renders for Levelhead.
  expect(levelheadText).toContain('sr anchored');

  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// LiveView connection status pill is present and accessible (M5 stability)
//
// QA: Performance and Observability — WebSocket connection status accessible
// @non-blocker
// ---------------------------------------------------------------------------

test('LiveView connection status pill is visible and accessible during M5 session @non-blocker', async ({
  page,
}) => {
  await installBaseMocks(page);
  await page.goto('/');

  // The ConnectionPill renders as an <output> element with aria-label.
  const pill = page.locator('[role="status"][aria-label^="WebSocket status"]');
  await expect(pill).toBeVisible({ timeout: 6_000 });

  const ariaLabel = await pill.getAttribute('aria-label');
  expect(ariaLabel).toBeTruthy();
  expect(ariaLabel?.length).toBeGreaterThan(10);
});

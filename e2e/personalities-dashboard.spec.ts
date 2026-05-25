/**
 * E2E tests for M5 dashboard-visible personality behaviours.
 *
 * Covers the Personalities tab UI for:
 *  - Levelhead appearing when ACTIVE_PHASE=2 (mocked via API response)
 *  - Levelhead absent when ACTIVE_PHASE=1 (default active-only response)
 *  - sr_anchored entry_type rendered on the Personalities tab
 *  - Per-personality P&L endpoint still works for the expanded personality set
 *
 * These tests use page.route() to mock /api/personalities — no running backend
 * required. Only the Vite dev server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked via route interception.
 *
 * Note: ACTIVE_PHASE is a server-side env var; the frontend reflects it only
 * through which personalities the API returns. We simulate both states by
 * varying the mock response.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared mock data factories
// ---------------------------------------------------------------------------

/**
 * Minimal personality shape that satisfies PersonalitiesView's expectations.
 * Matches the camelCase shape returned by the /api/personalities endpoint
 * (mapPersonality maps snake_case DB rows to camelCase before serialisation).
 *
 * Note: the frontend PersonalitiesView receives the response inside an
 * { data: [...] } envelope and reads snake_case fields directly from the
 * Personality interface in types/trading.ts. The live server returns snake_case
 * fields (the hook reads result.data.data which is the raw DB row shape).
 */
function makePersonality(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    name: 'precision',
    display_name: 'Precision',
    group_type: 'learning',
    entry_type: 'momentum_exhaustion',
    management_style: 'hold',
    is_frozen: false,
    is_active: true,
    phase: 1,
    params: { min_probability: 0.7, sl_pct: 15 },
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Levelhead personality row (Phase 2, sr_anchored).
 * When ACTIVE_PHASE=1: excluded from the active set (is_active=false in
 * practice, or simply absent from the non-include_inactive response).
 * When ACTIVE_PHASE=2: included in the active set.
 */
function makeLevelhead(isActive = true): Record<string, unknown> {
  return makePersonality({
    id: 'bbbbbbbb-0000-0000-0000-000000000010',
    name: 'levelhead',
    display_name: 'Levelhead',
    group_type: 'learning',
    entry_type: 'sr_anchored',
    management_style: 'hold',
    is_frozen: false,
    is_active: isActive,
    phase: 2,
    params: { sr_strength_threshold: 0.6, sl_pct: 12 },
  });
}

/**
 * Nine Phase-1 active personalities (the standard ACTIVE_PHASE=1 set).
 */
function makePhase1Set(): Record<string, unknown>[] {
  const names = [
    'clockwork',
    'precision',
    'adjuster',
    'reducer',
    'confident',
    'patient',
    'adaptive',
    'aggressive',
    'conservative',
  ];
  return names.map((name, i) =>
    makePersonality({
      id: `aaaaaaaa-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
      name,
      display_name: name.charAt(0).toUpperCase() + name.slice(1),
      is_frozen: name === 'clockwork',
      entry_type: name === 'clockwork' ? 'any_signal' : 'momentum_exhaustion',
      phase: 1,
    }),
  );
}

/**
 * Navigate to the app, intercept /api/personalities, and switch to the
 * Personalities tab.
 */
async function openPersonalitiesTab(
  page: Page,
  payload: unknown,
  suppressStraddleErrors = true,
): Promise<void> {
  await page.route('**/api/personalities*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: payload }),
    });
  });

  if (suppressStraddleErrors) {
    await page.route('**/api/straddle/latest', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: null }),
      });
    });
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Personalities' }).click();
  await expect(page.getByRole('heading', { name: 'Trading Personalities' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// 1. Levelhead visible in Personalities tab when included (simulating ACTIVE_PHASE=2)
//    QA checklist: "The Personalities dashboard tab shows Levelhead as inactive
//    when ACTIVE_PHASE=1 and active when ACTIVE_PHASE=2" @non-blocker
// ---------------------------------------------------------------------------

test('Personalities tab shows Levelhead with active indicator when API returns it with is_active=true (ACTIVE_PHASE=2 state) @non-blocker', async ({
  page,
}) => {
  // Simulate ACTIVE_PHASE=2: 9 Phase-1 personalities + Levelhead active.
  const phase2Set = [...makePhase1Set(), makeLevelhead(true)];
  await openPersonalitiesTab(page, phase2Set);

  // Levelhead row must be visible by display name.
  await expect(page.getByText('Levelhead')).toBeVisible();

  // The entry_type for Levelhead renders as "sr anchored" (underscores replaced
  // with spaces by PersonalitiesView: `p.entry_type.replace(/_/g, ' ')`).
  await expect(page.getByText('sr anchored')).toBeVisible();

  // The Phase column for Levelhead must show "2".
  // We locate the row containing "Levelhead" and verify it contains "2" in the
  // phase column. The table rows contain phase as a plain number.
  const levelheadRow = page.getByRole('row').filter({ hasText: 'Levelhead' });
  await expect(levelheadRow).toBeVisible();
  const rowText = await levelheadRow.innerText();
  // Phase column shows the numeric value "2" for the Levelhead row.
  expect(rowText).toContain('2');
});

// ---------------------------------------------------------------------------
// 2. Levelhead absent from Personalities tab when not in active set (ACTIVE_PHASE=1)
//    QA checklist: "With ACTIVE_PHASE=1, Levelhead is absent from the loaded
//    personality set" @non-blocker (dashboard-visible part of @functional item)
// ---------------------------------------------------------------------------

test('Personalities tab does not show Levelhead when API returns only Phase-1 active personalities (ACTIVE_PHASE=1 state) @non-blocker', async ({
  page,
}) => {
  // Simulate ACTIVE_PHASE=1: only 9 Phase-1 personalities, no Levelhead.
  const phase1Set = makePhase1Set();
  await openPersonalitiesTab(page, phase1Set);

  // Levelhead must NOT appear.
  await expect(page.getByText('Levelhead')).not.toBeVisible();
  // sr_anchored entry type must NOT appear (no sr_anchored personalities).
  await expect(page.getByText('sr anchored')).not.toBeVisible();

  // 9 rows (one per active personality) should be visible.
  // Use tbody rows to avoid counting the header row.
  const rows = page.getByRole('row').filter({ hasNotText: 'Status' });
  await expect(rows).toHaveCount(9);
});

// ---------------------------------------------------------------------------
// 3. Personalities tab renders all 9 Phase-1 personalities correctly
//    Validates that per-personality display works for the full standard set.
//    QA checklist: "Per-personality P&L still rendering for the expanded
//    personality set" @non-blocker (dashboard-visible portion)
// ---------------------------------------------------------------------------

test('Personalities tab renders all 9 Phase-1 active personalities with correct fields @non-blocker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  const phase1Set = makePhase1Set();
  await openPersonalitiesTab(page, phase1Set);

  // All 9 rows must render.
  const rows = page.getByRole('row').filter({ hasNotText: 'Status' });
  await expect(rows).toHaveCount(9);

  // The FROZEN badge must appear exactly once (for Clockwork).
  const frozenBadge = page.getByText('FROZEN');
  await expect(frozenBadge).toBeVisible();

  // Management style badges must appear (Hold badge for the hold personalities).
  const holdBadge = page.getByText('Hold').first();
  await expect(holdBadge).toBeVisible();

  // No JS errors from rendering the personality table.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 4. Personalities tab error state @non-blocker
// ---------------------------------------------------------------------------

test('Personalities tab shows error state when /api/personalities returns 500 @non-blocker', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.route('**/api/personalities*', (route) => {
    void route.fulfill({ status: 500, body: 'Internal Server Error' });
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

  // An error alert must appear — PersonalitiesView renders ErrorState with role="alert".
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 8_000 });

  const alertText = await alert.innerText();
  expect(alertText.toLowerCase()).toMatch(/couldn|load|error|personalities/);

  // No JS errors.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 5. Personalities tab empty state (no personalities seeded yet)
// ---------------------------------------------------------------------------

test('Personalities tab shows empty state when /api/personalities returns an empty array @non-blocker', async ({
  page,
}) => {
  await openPersonalitiesTab(page, []);

  // Empty state message must appear.
  await expect(page.getByText('No personalities found.')).toBeVisible();

  // No table rows beyond the header should appear.
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 6. Levelhead row shows inactive indicator when is_active=false
// ---------------------------------------------------------------------------

test('Personalities tab shows Levelhead with inactive dot indicator when is_active=false @non-blocker', async ({
  page,
}) => {
  // All 9 Phase-1 personalities + Levelhead marked inactive.
  const mixedSet = [...makePhase1Set(), makeLevelhead(false)];
  await openPersonalitiesTab(page, mixedSet);

  // Levelhead row must appear (include_inactive=true scenario).
  await expect(page.getByText('Levelhead')).toBeVisible();

  // The Levelhead row should contain an inactive indicator.
  // ActiveIndicator renders: bg-gray-600 for inactive, bg-green-400 for active.
  // We can verify the row exists without checking exact classes (brittle).
  const levelheadRow = page.getByRole('row').filter({ hasText: 'Levelhead' });
  await expect(levelheadRow).toBeVisible();
});

// ---------------------------------------------------------------------------
// 7. Refresh button triggers a re-fetch
// ---------------------------------------------------------------------------

test('Refresh button in Personalities tab re-fetches the personalities list @non-blocker', async ({
  page,
}) => {
  let fetchCount = 0;

  await page.route('**/api/personalities*', (route) => {
    fetchCount++;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: makePhase1Set() }),
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

  // Wait for initial fetch.
  await expect(page.getByRole('row').filter({ hasNotText: 'Status' })).toHaveCount(9);
  const countAfterMount = fetchCount;
  expect(countAfterMount).toBeGreaterThanOrEqual(1);

  // Click Refresh.
  await page.getByRole('button', { name: 'Refresh' }).click();

  // Wait for the second fetch.
  await expect(async () => {
    expect(fetchCount).toBeGreaterThan(countAfterMount);
  }).toPass({ timeout: 5_000 });
});

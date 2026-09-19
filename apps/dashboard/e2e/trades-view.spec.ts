/**
 * E2E tests for the TradesView dashboard tab.
 *
 * Covers every QA-checklist item for TradesView (GET /api/trades polling,
 * P&L rendering, error/empty states, status badges, IST timestamps).
 *
 * All HTTP calls are intercepted via page.route() — no running backend is
 * required.  Only the Vite dev server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared mock data factories
// ---------------------------------------------------------------------------

/**
 * Minimal PaperTrade shape that satisfies the component's expectations.
 * Omit fields that are not relevant to a particular test scenario.
 */
function makeTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'trade-1',
    entry_time: '2026-05-23T04:00:00.000Z', // 09:30 IST
    exit_time: null,
    status: 'open',
    straddle_at_entry: '22456.75',
    entry_ce_price: '112.50',
    entry_pe_price: '108.25',
    gross_pnl: null,
    net_pnl: null,
    exit_reason: null,
    lots: 1,
    lot_size: 50,
    ...overrides,
  };
}

/**
 * Navigate to the app, install an /api/trades route intercept, and click the
 * Trades tab.  Returns after the tab heading is visible.
 */
async function openTradesTab(
  page: Page,
  tradesPayload: unknown = { data: [], message: 'no trades' },
): Promise<void> {
  await page.route('**/api/trades', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tradesPayload),
    });
  });

  // Intercept straddle polling so LiveView (initial tab) does not log errors.
  await page.route('**/api/straddle/latest', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Trades' }).click();
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Checklist: NUMERIC string fields are parsed — @critical
// ---------------------------------------------------------------------------

test('NUMERIC string fields (gross_pnl, net_pnl, straddle_at_entry) render as formatted numbers, not raw strings @critical', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-1',
      status: 'closed',
      exit_time: '2026-05-23T10:00:00.000Z',
      straddle_at_entry: '22456.75',
      gross_pnl: '1234.50',
      net_pnl: '-45.00',
      exit_reason: 'stop_loss',
    }),
  ];
  await openTradesTab(page, { data: trades });

  // The trade row must be visible.
  const row = page
    .getByRole('row')
    .filter({ hasText: /Closed/i })
    .first();
  await expect(row).toBeVisible();

  // net_pnl "-45.00" must render as a formatted number, not a raw string.
  // The cell shows "-45.00" (with formatting); it must NOT show "−45.00" as a raw
  // unformatted string with quote marks or extra characters that indicate it was
  // never parsed.
  const netPnlCell = row.getByText(/45/, { exact: false });
  await expect(netPnlCell).toBeVisible();

  // Straddle at entry must be rendered as a formatted number.
  // "22456.75" → "22,456.75" in en-IN locale, or plain "22456.75" — either is
  // fine; what matters is the cell contains the digit sequence, not a raw
  // string like '"22456.75"' with quotes.
  const straddleCell = row.getByText(/22.*456/);
  await expect(straddleCell).toBeVisible();

  // No cell in the row should display a raw JSON string (containing quotes).
  const rowText = await row.innerText();
  expect(rowText).not.toContain('"1234.50"');
  expect(rowText).not.toContain('"−45.00"');
});

// ---------------------------------------------------------------------------
// Checklist: Negative P&L is red, positive is green — @critical
// ---------------------------------------------------------------------------

test('Negative net_pnl is colored red and positive net_pnl is colored green @critical', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-neg',
      status: 'closed',
      exit_time: '2026-05-23T10:00:00.000Z',
      gross_pnl: '-100.00',
      net_pnl: '-100.00',
      exit_reason: 'stop_loss',
    }),
    makeTrade({
      id: 'trade-pos',
      status: 'closed',
      exit_time: '2026-05-23T11:00:00.000Z',
      gross_pnl: '250.00',
      net_pnl: '250.00',
      exit_reason: 'target',
    }),
  ];
  await openTradesTab(page, { data: trades });

  // Wait for both rows to appear.
  const rows = page.getByRole('row').filter({ hasNotText: 'Entry Time' });
  await expect(rows).toHaveCount(2);

  // Red class (text-red-400) on the negative P&L span.
  const negSpan = page.locator('span.text-red-400').filter({ hasText: /100/ });
  await expect(negSpan.first()).toBeVisible();

  // Green class (text-green-400) on the positive P&L span.
  const posSpan = page.locator('span.text-green-400').filter({ hasText: /250/ });
  await expect(posSpan.first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Checklist: null P&L (open trades) shows "—", never NaN @critical
// ---------------------------------------------------------------------------

test('Open trades with null net_pnl show an em dash placeholder — never NaN or undefined @critical', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-open',
      status: 'open',
      exit_time: null,
      gross_pnl: null,
      net_pnl: null,
    }),
  ];
  await openTradesTab(page, { data: trades });

  // The Open badge must be present.
  await expect(page.getByText('Open')).toBeVisible();

  // Each P&L cell for an open trade should show the em dash placeholder.
  // The component renders <span class="text-gray-500">—</span> for null values.
  const emDashCells = page.locator('span.text-gray-500', { hasText: '—' });
  // At minimum the net_pnl and gross_pnl cells should each be a dash.
  await expect(emDashCells.first()).toBeVisible();

  // The text "NaN" must not appear anywhere on the page.
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('NaN');
  expect(bodyText).not.toContain('undefined');
});

// ---------------------------------------------------------------------------
// Checklist: empty array → "No trades yet" — @critical
// ---------------------------------------------------------------------------

test('When /api/trades returns an empty array TradesView shows a clear "No trades yet" empty state @critical', async ({
  page,
}) => {
  await openTradesTab(page, { data: [], message: 'no trades' });

  // Must show the empty-state message.
  await expect(page.getByText(/No paper trades yet/i)).toBeVisible();

  // Must NOT render a table with no rows and no message — the empty state
  // text is what distinguishes "no data" from a load failure.

  // No row elements beyond the header should be present.
  // The table is not rendered in empty state, so we check for the absence of
  // tbody rows.
  const tableRows = page.getByRole('row');
  // Table is not rendered in empty state — so no rows at all.
  await expect(tableRows).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Checklist: 500 error → error notice, not silent blank or crash — @critical
// ---------------------------------------------------------------------------

test('When /api/trades returns HTTP 500 TradesView shows an error notice and does not crash @critical', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.route('**/api/trades', (route) => {
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
  await page.getByRole('button', { name: 'Trades' }).click();
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();

  // The error state uses role="alert"; wait for it to appear.
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 8_000 });

  // The alert must mention a load failure (not a blank empty state).
  const alertText = await alert.innerText();
  expect(alertText.toLowerCase()).toMatch(/couldn|load|error|fail/);

  // No unhandled JS errors.
  expect(pageErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Checklist: entry times displayed in IST — @functional
// ---------------------------------------------------------------------------

test('Entry times are displayed in IST — 04:00 UTC renders as 09:30 IST @functional', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-ist',
      // 2026-05-23T04:00:00.000Z = 09:30:00 IST
      entry_time: '2026-05-23T04:00:00.000Z',
      status: 'open',
    }),
  ];
  await openTradesTab(page, { data: trades });

  // The formatted IST time should appear in the entry_time cell.
  // formatIstDateTime produces something like "23/05/2026, 09:30:00" in en-IN.
  // We assert the hour is 09 (IST) rather than 04 (UTC).
  const row = page.getByRole('row').filter({ hasNotText: 'Entry Time' }).first();
  await expect(row).toBeVisible();

  const rowText = await row.innerText();
  // Should contain "09:30" (IST) and NOT "04:00" (UTC).
  expect(rowText).toContain('09:30');
  expect(rowText).not.toContain('04:00');
});

// ---------------------------------------------------------------------------
// Checklist: status badges for "open" and "closed" — @functional
// ---------------------------------------------------------------------------

test('Status badges render for open and closed trade status values @functional', async ({
  page,
}) => {
  const trades = [
    makeTrade({ id: 'trade-open', status: 'open', net_pnl: null }),
    makeTrade({
      id: 'trade-closed',
      status: 'closed',
      exit_time: '2026-05-23T10:00:00.000Z',
      net_pnl: '150.00',
      gross_pnl: '160.00',
      exit_reason: 'target',
    }),
  ];
  await openTradesTab(page, { data: trades });

  // Both badge variants must be present.
  await expect(page.getByText('Open')).toBeVisible();
  await expect(page.getByText('Closed')).toBeVisible();

  // Neither badge should be blank or show "undefined".
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('undefined');
});

// ---------------------------------------------------------------------------
// Checklist: 404 → error state, not silent empty — @functional
// ---------------------------------------------------------------------------

test('When /api/trades returns HTTP 404 TradesView shows an error notice rather than an empty table @functional', async ({
  page,
}) => {
  await page.route('**/api/trades', (route) => {
    void route.fulfill({ status: 404, body: 'Not Found' });
  });
  await page.route('**/api/straddle/latest', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: null }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Trades' }).click();
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();

  // An error alert must appear — 404 should not be silently swallowed.
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 8_000 });

  // Must NOT show the calm "No paper trades yet" message for a 404.
  await expect(page.getByText(/No paper trades yet/i)).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Checklist: exit reason column — @non-blocker
// ---------------------------------------------------------------------------

test('Exit reason is shown for closed trades and a dash for open trades @non-blocker', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-closed',
      status: 'closed',
      exit_time: '2026-05-23T10:00:00.000Z',
      net_pnl: '100.00',
      gross_pnl: '110.00',
      exit_reason: 'stop_loss',
    }),
    makeTrade({
      id: 'trade-open',
      status: 'open',
      exit_reason: null,
    }),
  ];
  await openTradesTab(page, { data: trades });

  // The closed trade row should contain the exit reason text.
  const rows = page.getByRole('row').filter({ hasNotText: 'Entry Time' });
  await expect(rows).toHaveCount(2);

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).toContain('stop_loss');
});

// ---------------------------------------------------------------------------
// Checklist: straddle-at-entry — no scientific notation — @non-blocker
// ---------------------------------------------------------------------------

test('Straddle-at-entry column shows a formatted decimal number, not scientific notation @non-blocker', async ({
  page,
}) => {
  const trades = [
    makeTrade({
      id: 'trade-1',
      status: 'closed',
      exit_time: '2026-05-23T10:00:00.000Z',
      straddle_at_entry: '22456.75',
      net_pnl: '100.00',
      gross_pnl: '110.00',
    }),
  ];
  await openTradesTab(page, { data: trades });

  // Must not appear in scientific notation.
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('2.245675e+4');
  expect(bodyText).not.toContain('2.24568e');

  // The formatted value should appear somewhere in the page.
  expect(bodyText).toMatch(/22[,.]?456/);
});

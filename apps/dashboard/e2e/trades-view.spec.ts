/**
 * E2E tests for the TradesView dashboard tab (/trades).
 *
 * Covers every QA-checklist item for TradesView (GET /api/trades polling,
 * P&L rendering, error/empty states, status badges, IST timestamps).
 *
 * Each test opens /trades directly — every view has its own URL (see
 * src/lib/routes.ts), so no sidebar click is needed.
 *
 * The HTTP calls the assertions depend on (/api/trades, /api/personalities) are
 * intercepted via page.route() with URL predicates, so a query string on either
 * request still matches. No running backend is required — only the Next.js
 * dashboard dev server (http://localhost:5173) must be up.
 *
 * Required env vars: none — all data is mocked.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

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

function fulfillJson(route: Route, body: unknown): void {
  void route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Mock GET /api/personalities (TradesView maps personality ids to names). It may carry a
 * query string, so match on the pathname.
 */
async function mockPersonalities(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/personalities',
    (route) => fulfillJson(route, { data: [] }),
  );
}

/** Open /trades and wait for the card heading. */
async function gotoTrades(page: Page): Promise<void> {
  await page.goto('/trades');
  await expect(page.getByRole('heading', { name: 'Paper Trades' })).toBeVisible();
}

/**
 * Install an /api/trades route intercept and open /trades. Returns after the
 * tab heading is visible.
 */
async function openTradesTab(
  page: Page,
  tradesPayload: unknown = { data: [], message: 'no trades' },
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/trades',
    (route) => fulfillJson(route, tradesPayload),
  );
  await mockPersonalities(page);
  await gotoTrades(page);
}

/**
 * The page's error alerts. Next.js mounts an always-present, empty
 * role="alert" route announcer (#__next-route-announcer__); it is not an app
 * alert, so leave it out.
 */
function appAlerts(page: Page): Locator {
  return page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));
}

/** Body rows of the trades table (the header row is excluded). */
function bodyRows(page: Page): Locator {
  return page.locator('tbody').getByRole('row');
}

/**
 * The cell of `row` under the column headed `label`. Header text is read with
 * textContent (innerText would apply the headers' CSS uppercase), and the column
 * index is looked up rather than hard-coded because Contract/Regime/VIX columns
 * appear only when some row carries the field.
 */
async function cellUnder(page: Page, row: Locator, label: string): Promise<Locator> {
  const headers = await page.getByRole('columnheader').allTextContents();
  const index = headers.findIndex((text) => text.trim().startsWith(label));
  expect(index, `column "${label}" in ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0);
  return row.getByRole('cell').nth(index);
}

// ---------------------------------------------------------------------------
// Checklist: NUMERIC string fields are parsed — @critical
// ---------------------------------------------------------------------------

test('NUMERIC string fields (net_pnl, straddle_at_entry) render as formatted numbers, not raw strings @critical', async ({
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
  const row = bodyRows(page).filter({ hasText: 'Closed' }).first();
  await expect(row).toBeVisible();

  // net_pnl "-45.00" must be parsed and run through the rupee formatter
  // (formatInr), not echoed back as the raw API string.
  await expect(await cellUnder(page, row, 'Net P&L')).toHaveText('-₹45.00');

  // straddle_at_entry "22456.75" → "₹22,456.75" with en-IN digit grouping.
  await expect(await cellUnder(page, row, 'Straddle @ entry')).toHaveText('₹22,456.75');

  // No cell in the row should display a raw JSON string (containing quotes) or
  // the unformatted API value.
  const rowText = await row.innerText();
  expect(rowText).not.toContain('"');
  expect(rowText).not.toContain('22456.75');
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
  const rows = bodyRows(page);
  await expect(rows).toHaveCount(2);

  // Colours come from design tokens: text-negative (red) / text-positive (green).
  const negRow = rows.filter({ hasText: '-₹100.00' });
  const negSpan = (await cellUnder(page, negRow, 'Net P&L')).locator('span', {
    hasText: '-₹100.00',
  });
  await expect(negSpan).toHaveClass(/\btext-negative\b/);
  await expect(negSpan).not.toHaveClass(/\btext-positive\b/);

  const posRow = rows.filter({ hasText: '+₹250.00' });
  const posSpan = (await cellUnder(page, posRow, 'Net P&L')).locator('span', {
    hasText: '+₹250.00',
  });
  await expect(posSpan).toHaveClass(/\btext-positive\b/);
  await expect(posSpan).not.toHaveClass(/\btext-negative\b/);
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

  // The Open badge must be present in the trade row.
  const row = bodyRows(page).first();
  await expect(row.getByText('Open', { exact: true })).toBeVisible();

  // The Net P&L and P&L % cells of an open trade show the em dash placeholder.
  await expect(await cellUnder(page, row, 'Net P&L')).toHaveText('—');
  await expect(await cellUnder(page, row, 'P&L %')).toHaveText('—');

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
  await expect(appAlerts(page)).toHaveCount(0);

  // The table is not rendered in empty state — so no rows at all.
  const tableRows = page.getByRole('row');
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

  await page.route(
    (url) => url.pathname === '/api/trades',
    (route) => {
      void route.fulfill({ status: 500, body: 'Internal Server Error' });
    },
  );
  await mockPersonalities(page);
  await gotoTrades(page);

  // The error state uses role="alert"; wait for it to appear.
  const alert = appAlerts(page);
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

  // formatIstDateTimeShort renders the entry as "<IST date>, 09:30".
  // We assert the hour is 09 (IST) rather than 04 (UTC).
  const row = bodyRows(page).first();
  await expect(row).toBeVisible();

  const entryCell = await cellUnder(page, row, 'Entry (IST)');
  await expect(entryCell).toContainText('09:30');
  const entryText = await entryCell.innerText();
  expect(entryText).toContain('2026');
  expect(entryText).not.toContain('04:00');
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

  // Both badge variants must be present in the table (the toolbar's status
  // filter and the summary cards also say Open/Closed, so scope to the rows).
  const rows = bodyRows(page);
  await expect(rows).toHaveCount(2);
  const statuses = await Promise.all(
    [0, 1].map(async (i) => (await cellUnder(page, rows.nth(i), 'Status')).innerText()),
  );
  expect(statuses.map((s) => s.trim()).sort()).toEqual(['Closed', 'Open']);

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
  await page.route(
    (url) => url.pathname === '/api/trades',
    (route) => {
      void route.fulfill({ status: 404, body: 'Not Found' });
    },
  );
  await mockPersonalities(page);
  await gotoTrades(page);

  // An error alert must appear — 404 should not be silently swallowed.
  const alert = appAlerts(page);
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

  const rows = bodyRows(page);
  await expect(rows).toHaveCount(2);

  // The raw exit reason is shown as a readable label ("stop_loss" → "Stop-loss"),
  // with the raw code kept in the title attribute.
  const closedReason = await cellUnder(page, rows.filter({ hasText: 'Closed' }), 'Exit reason');
  await expect(closedReason).toHaveText('Stop-loss');
  await expect(closedReason.locator('[title="stop_loss"]')).toBeVisible();

  // An open trade has no exit reason yet: a dash.
  const openReason = await cellUnder(page, rows.filter({ hasText: 'Open' }), 'Exit reason');
  await expect(openReason).toHaveText('—');
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
  await expect(bodyRows(page)).toHaveCount(1);

  // Must not appear in scientific notation.
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('2.245675e+4');
  expect(bodyText).not.toContain('2.24568e');

  // The formatted value should appear somewhere in the page.
  expect(bodyText).toMatch(/22[,.]?456/);
});

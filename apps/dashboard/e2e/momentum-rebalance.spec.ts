import { expect, test } from '@playwright/test';

test('Momentum rebalance shows Fyers login and indicative changes', async ({ page, context }) => {
  await page.route('**/api/momentum/meta?dataset=*', (route) => {
    const dataset = new URL(route.request().url()).searchParams.get('dataset');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instruments: dataset === 'stock'
          ? [{ name: 'C0001', display_name: 'Example Ltd', include: 'core', group: 'Nifty 50', has_data: true }]
          : [],
        first_week: '2024-01-05',
        last_week: '2026-09-25',
        defaults: { start: '2024-01-05', top_n: 1, exit_rank: 2, lookbacks: [1] },
      }),
    });
  });
  await page.route('**/api/auth/fyers/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, connected: false, degraded: false, needsReauth: true }),
  }));
  await context.route('**/api/auth/fyers/start', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<p>Fyers login started</p>',
  }));
  await page.route('**/api/momentum/rebalance-preview', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      dataset: 'stock', as_of: '2026-09-30T11:00:00+05:30', signal_week: '2026-10-02',
      price_source: 'Fyers last traded price', portfolio_value: 100000,
      current_pct: { C0001: 40, 'Idle cash': 60 }, target_pct: { C0001: 60, 'Idle cash': 40 },
      rows: [{ asset: 'C0001', symbol: 'NSE:EXAMPLE-EQ', action: 'BUY', current_pct: 40,
        target_pct: 60, delta_pct: 20, ltp: 100, indicative_value: 20000,
        indicative_quantity: 200 }],
      note: 'No orders were placed.',
    }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await page.getByRole('button', { name: 'Rebalance now' }).click();
  await expect(page.getByRole('button', { name: 'Login with Fyers' })).toBeVisible();

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Login with Fyers' }).click();
  const popup = await popupPromise;
  await expect(popup.getByText('Fyers login started')).toBeVisible();
  await popup.close();

  await page.getByRole('button', { name: 'Nifty 50 Stocks' }).click();
  await page.getByRole('textbox', { name: 'Holdings (asset, percent)' }).fill('C0001, 40');
  await page.getByRole('button', { name: 'Preview rebalance' }).click();

  await expect(page.getByRole('heading', { name: 'Indicative changes' })).toBeVisible();
  await expect(page.getByRole('row', { name: /BUY C0001/ })).toContainText('200');
  await expect(page.getByText('No orders were placed.')).toBeVisible();
});

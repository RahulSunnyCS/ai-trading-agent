import { expect, test } from '@playwright/test';

test('standalone momentum metadata does not crash the default Live tab', async ({ page }) => {
  await page.route('**/api/meta', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instruments: [], defaults: {} }),
    }),
  );

  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/meta'),
    page.goto('/'),
  ]);
  await expect(page.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
  if (
    await page
      .getByRole('button', { name: 'Open navigation' })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Momentum sections' })).toBeVisible();
});

test('Momentum rebalance previews holdings without changing Backtest dataset', async ({ page }) => {
  await page.route('**/api/momentum/meta?dataset=*', (route) => {
    const dataset = new URL(route.request().url()).searchParams.get('dataset');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instruments:
          dataset === 'stock'
            ? [
                {
                  name: 'C0001',
                  display_name: 'Example Ltd',
                  include: 'core',
                  group: 'Nifty 50',
                  has_data: true,
                },
              ]
            : [],
        first_week: '2024-01-05',
        last_week: '2026-09-25',
        defaults: { start: '2024-01-05', top_n: 1, exit_rank: 2, lookbacks: [1] },
      }),
    });
  });
  await page.route('**/api/momentum/saved-runs?dataset=*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/momentum/rebalance-preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dataset: 'stock',
        as_of: '2026-09-30T11:00:00+05:30',
        signal_week: '2026-10-02',
        price_source: 'Fyers last traded price',
        portfolio_value: 100000,
        current_pct: { C0001: 40, 'Idle cash': 60 },
        target_pct: { C0001: 60, 'Idle cash': 40 },
        rows: [
          {
            asset: 'C0001',
            symbol: 'NSE:EXAMPLE-EQ',
            action: 'BUY',
            current_pct: 40,
            target_pct: 60,
            delta_pct: 20,
            ltp: 100,
            indicative_value: 20000,
            indicative_quantity: 200,
          },
        ],
        note: 'No orders were placed.',
      }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await page.getByRole('tab', { name: 'Rebalance preview' }).click();

  await page.getByRole('button', { name: 'Nifty 50 Stocks' }).click();
  await page.getByRole('combobox', { name: 'Asset 1' }).fill('C0001');
  await page.getByRole('spinbutton', { name: 'Weight %' }).fill('40');
  await expect(page.getByText('Cash remainder 60.00%')).toBeVisible();
  await page.getByRole('button', { name: 'Preview rebalance' }).click();

  await expect(page.getByRole('heading', { name: 'Indicative changes' })).toBeVisible();
  await expect(page.getByRole('row', { name: /BUY C0001/ })).toContainText('200');
  await expect(page.getByText('No orders were placed.')).toBeVisible();
  await page.getByRole('tab', { name: 'Backtest' }).click();
  await expect(page.getByRole('button', { name: 'ETF Rotation' })).toHaveClass(/border-primary/);
});

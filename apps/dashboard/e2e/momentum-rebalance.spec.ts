import { expect, test } from '@playwright/test';

test('standalone momentum metadata does not crash the default Live tab', async ({ page }) => {
  await page.route('**/api/meta', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ instruments: [], defaults: {} }),
    }),
  );

  await page.goto('/');
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
  await page.route('**/api/momentum/rebalance-preview', async (route) => {
    const request = route.request().postDataJSON();
    expect(request.strategy_start_date).toBe('2026-09-18');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dataset: 'stock',
        as_of: '2026-10-02',
        signal_week: '2026-10-02',
        price_mode: 'last_close',
        price_source: 'Latest database close',
        portfolio_value: 100000,
        first_allocation: false,
        rebalance_schedule: {
          strategy_start_date: '2026-09-18',
          cadence: 'every_n_weeks',
          interval_weeks: 4,
          effective_rebalance_offset: 3,
          is_rebalance_week: false,
          previous_rebalance_date: '2026-09-18',
          current_rebalance_date: null,
          next_rebalance_date: '2026-10-16',
        },
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
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await page.getByRole('tab', { name: 'Rebalance preview' }).click();

  await page.getByRole('radio', { name: 'Nifty 50 Stocks' }).click();
  await expect(page.getByText('First allocation', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Asset 1' }).fill('C0001');
  await page.getByRole('spinbutton', { name: 'Weight %' }).fill('40');
  await page.getByLabel('Strategy live start date').fill('2026-09-18');
  await expect(page.getByText('First allocation', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Cash remainder 60.00%')).toBeVisible();
  await page.getByRole('button', { name: 'Preview rebalance' }).click();

  await expect(page.getByRole('heading', { name: 'Indicative changes' })).toBeVisible();
  await expect(page.getByText(/Latest database close · as of 2026-10-02/)).toBeVisible();
  await expect(page.getByText('No rebalance is scheduled this week')).toBeVisible();
  await expect(page.getByText(/Previous rebalance: 18 Sept 2026/)).toBeVisible();
  await expect(page.getByText(/Next rebalance: 16 Oct 2026/)).toBeVisible();
  await expect(page.getByRole('row', { name: /BUY C0001/ })).toContainText('200');
  await expect(page.getByText('No orders were placed.')).toBeVisible();
  await page.getByRole('tab', { name: 'Backtest' }).click();
  await expect(page.getByRole('radio', { name: 'ETF Rotation' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

import { type Page, type Route, expect, test } from '@playwright/test';

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Uncaught page errors: a crash in a /api/meta consumer surfaces here. */
function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

test('standalone momentum metadata does not crash the shell, Overview or Live', async ({
  page,
}) => {
  // With MOMENTUM_DIRECT on, /api/meta can be answered by the Momentum service, whose payload
  // has a different shape. useMeta feeds the shell (system status, token banner), Overview's
  // feed card and the Live view; none of them may crash on it.
  await page.route(
    (url) => url.pathname === '/api/meta',
    (route) => json(route, { instruments: [], defaults: {} }),
  );
  const errors = collectPageErrors(page);

  // "/" redirects to the landing tab, Overview.
  await page.goto('/');
  await expect(page).toHaveURL(/\/overview$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Overview', exact: true }),
  ).toBeVisible();

  await page.goto('/live');
  await expect(page.getByRole('heading', { level: 1, name: 'Live', exact: true })).toBeVisible();

  // The shell still navigates after rendering that payload.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Momentum', exact: true })
    .click();
  await expect(page).toHaveURL(/\/momentum(\/|$)/);
  await expect(page.getByRole('tablist', { name: 'Momentum sections' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Momentum rebalance previews holdings without changing Backtest dataset', async ({ page }) => {
  await page.route(
    (url) => url.pathname === '/api/momentum/meta',
    (route) => {
      const dataset = new URL(route.request().url()).searchParams.get('dataset');
      return json(route, {
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
            : dataset === 'etf'
              ? [{ name: 'Nifty 50', include: 'core', group: 'Broad', has_data: true }]
              : [],
        first_week: '2024-01-05',
        last_week: '2026-09-25',
        defaults: { start: '2024-01-05', top_n: 1, exit_rank: 2, lookbacks: [1] },
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/momentum/saved-runs',
    (route) => json(route, []),
  );
  // The rebalance view opens on Broad Momentum, whose asset suggestions come from Scores.
  await page.route(
    (url) => url.pathname === '/api/momentum/scores',
    (route) =>
      json(route, {
        as_of: '2026-09-25',
        universe_size: 0,
        lookbacks: [4],
        missing_symbols: [],
        stocks: [],
        sectors: [],
      }),
  );
  // The Momentum view always checks for a weekly-signal run in flight; keep the owner's out.
  await page.route(
    (url) => url.pathname === '/api/momentum/weekly/jobs/latest',
    (route) => json(route, { job: null }),
  );
  const previewRequests: Array<Record<string, unknown>> = [];
  await page.route(
    (url) => url.pathname === '/api/momentum/rebalance-preview',
    (route) => {
      previewRequests.push(route.request().postDataJSON());
      return json(route, {
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
      });
    },
  );

  // Pin the Backtest dataset to ETF Rotation through the URL, then switch section in place.
  await page.goto('/momentum/backtest/etf');
  await expect(page.getByRole('radio', { name: 'ETF Rotation' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByRole('tab', { name: 'Rebalance preview' }).click();
  await expect(page).toHaveURL(/\/momentum\/rebalance$/);

  await page.getByRole('radio', { name: 'Nifty 50 stock dataset' }).click();
  await expect(page.getByRole('radio', { name: 'Nifty 50 stock dataset' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByText('First allocation', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Asset 1' }).fill('C0001');
  await page.getByRole('spinbutton', { name: 'Weight %' }).fill('40');
  await page.getByLabel('Strategy live start date').fill('2026-09-18');
  await expect(page.getByText('First allocation', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Cash remainder 60.00%')).toBeVisible();
  await page.getByRole('button', { name: 'Preview rebalance' }).click();

  await expect(page.getByRole('heading', { name: 'Indicative changes' })).toBeVisible();
  // The request carries the stock dataset's default settings, the holdings and the start date.
  expect(previewRequests).toHaveLength(1);
  expect(previewRequests[0]).toMatchObject({
    dataset: 'stock',
    universe: ['C0001'],
    holdings_pct: { C0001: 40 },
    portfolio_value: 100000,
    strategy_start_date: '2026-09-18',
  });
  await expect(page.getByText(/Latest database close · as of 02 Oct 2026/)).toBeVisible();
  await expect(page.getByText('No rebalance is scheduled this week')).toBeVisible();
  await expect(page.getByText(/Previous rebalance: 18 Sept 2026/)).toBeVisible();
  await expect(page.getByText(/Next rebalance: 16 Oct 2026/)).toBeVisible();
  await expect(page.getByRole('row', { name: /C0001.*BUY/ })).toContainText('200');
  await expect(page.getByText('No orders were placed.')).toBeVisible();

  // Previewing the stock dataset must not have moved the Backtest tab off ETF Rotation.
  await page.getByRole('tab', { name: 'Backtest', exact: true }).click();
  await expect(page).toHaveURL(/\/momentum\/backtest\/etf$/);
  await expect(page.getByRole('radio', { name: 'ETF Rotation' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

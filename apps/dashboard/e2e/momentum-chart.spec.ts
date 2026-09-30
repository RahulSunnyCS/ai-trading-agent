import { expect, test } from '@playwright/test';

test('Momentum backtest renders an interactive chart with optional touchpad zoom', async ({ page }) => {
  await page.route('**/api/momentum/meta?dataset=etf', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        instruments: [{ name: 'Nifty 50', include: 'core', group: 'Broad', has_data: true }],
        first_week: '2024-01-05',
        last_week: '2024-01-19',
        defaults: { start: '2024-01-05', top_n: 1, exit_rank: 2, lookbacks: [1] },
      }),
    }),
  );
  await page.route('**/api/momentum/backtest', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        benchmark_name: 'Nifty 50',
        kpis: { cagr: 0.12 },
        rotations: [{ week: '2024-01-12' }],
        latest: { week: '2024-01-19', explain: 'Hold current position.', rows: [] },
        open_positions: [],
        trades: [],
        instruments: [],
        timeline: [],
        yearly: [],
        crashes: [],
        series: {
          dates: ['2024-01-05', '2024-01-12', '2024-01-19'],
          strategy: [100000, 102000, 103000],
          benchmark: [100000, 101000, 102000],
          cash: [100000, 100100, 100200],
          drawdown_strategy: [0, 0, -0.01],
          drawdown_benchmark: [0, -0.01, 0],
          rolling_52w_excess: [null, null, 0.01],
          idle_share: [0, 0, 0],
          holdings_count: [1, 1, 1],
        },
      }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await page.getByRole('button', { name: 'Run momentum backtest' }).click();

  const chart = page.getByRole('img', { name: /Strategy, benchmark and cash values/ });
  await expect(chart.locator('.main-svg').first()).toBeVisible();
  await expect(chart.getByText('Strategy', { exact: true }).first()).toBeVisible();

  const zoom = page.getByRole('button', { name: 'Touchpad zoom off' });
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  await zoom.click();
  await expect(page.getByRole('button', { name: 'Touchpad zoom on' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Saved runs (1)' }).click();
  await expect(page.getByRole('heading', { name: 'Saved runs' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name for run 1' })).toHaveValue('Run 1');
});

test('Momentum Scores exposes stock and sector details', async ({ page }) => {
  await page.route('**/api/momentum/scores', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      as_of: '2024-01-19', universe_size: 1, lookbacks: [4, 13, 26], missing_symbols: [],
      stocks: [{
        symbol: 'TEST', company_name: 'Test Company', parent_group: 'Industry', subgroup: 'Metals',
        last_price: 120, change_1w_pct: 0.02,
        returns: { '4': 0.08, '13': 0.12, '26': 0.20 },
        scores: { '4': 75, '13': 80, '26': 90 },
      }],
      sectors: [{
        cid: 'metals', parent_group: 'Industry', subgroup: 'Metals',
        member_count: 2, qualifying_count: 1, scores: { '4': 75, '13': 80, '26': 90 },
      }],
    }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Momentum', exact: true }).click();
  await page.getByRole('button', { name: 'Momentum Scores' }).click();
  await expect(page.getByText('Test Company')).toBeVisible();
  await page.getByRole('button', { name: 'TEST', exact: true }).click();
  await expect(page.getByText('Return: 8%')).toBeVisible();
  await page.getByRole('button', { name: 'Sectors', exact: true }).click();
  await page.getByRole('button', { name: 'Metals' }).click();
  await expect(page.getByText('TEST', { exact: true })).toBeVisible();
});

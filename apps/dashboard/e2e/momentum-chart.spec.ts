import { expect, test } from '@playwright/test';

test('Momentum backtest renders an interactive chart with optional touchpad zoom', async ({
  page,
}) => {
  const savedRuns: Array<Record<string, unknown>> = [];
  // URL predicates rather than globs: the app adds `?dataset=…` to these calls.
  await page.route(
    (url) => url.pathname === '/api/momentum/saved-runs',
    async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        const run = {
          id: 'run-1',
          n: 1,
          created_at: '2024-01-19T12:00:00+05:30',
          name: body.name,
          config: body.config,
          kpis: body.kpis,
          dates: body.dates,
          strategy: body.strategy,
          overlay: false,
          favorite: false,
          active: false,
        };
        savedRuns.unshift(run);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(run),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(savedRuns),
        });
      }
    },
  );
  await page.route(
    (url) => url.pathname === '/api/momentum/meta' && url.searchParams.get('dataset') === 'etf',
    (route) =>
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
  const result = {
    benchmark_name: 'Nifty 50',
    kpis: { cagr: 0.12 },
    rotations: [
      {
        week: '2024-01-12',
        value: 102000,
        outs: [],
        ins: [],
        trims: [],
        parked: false,
        holdings: [{ asset: 'Nifty 50', share: 1 }],
      },
    ],
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
  };
  await page.route('**/api/momentum/backtest/jobs', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'job-1', status: 'running', result: null, error: null } }),
    }),
  );
  await page.route('**/api/momentum/backtest/jobs/job-1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'job-1', status: 'done', result, error: null } }),
    }),
  );

  await page.goto('/momentum/backtest/etf');
  await page.getByRole('button', { name: 'Run momentum backtest' }).click();

  const chart = page.getByRole('img', { name: /Strategy, benchmark and cash values/ });
  await expect(chart.locator('.main-svg').first()).toBeVisible();
  // The line key is our own row under the plot: one toggle per line, with its value.
  const strategy = page
    .getByRole('group', { name: 'Chart series' })
    .getByRole('button', { name: /^Strategy/ });
  await expect(strategy).toHaveAttribute('aria-pressed', 'true');
  await strategy.click();
  await expect(strategy).toHaveAttribute('aria-pressed', 'false');
  await strategy.click();
  await expect(
    page.getByRole('group', { name: 'Chart series' }).getByRole('button', { name: /added/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  // The week box sits in the plot's top-left corner.
  const readout = page.getByRole('region', { name: 'Week readout' });
  await expect(readout).toContainText('Latest');
  await expect(readout).toContainText('Week of 19 Jan 2024');
  const advanced = page.getByRole('button', { name: 'Advanced tooltip' });
  await expect(advanced).toHaveAttribute('aria-pressed', 'false');
  await advanced.click();
  await expect(advanced).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Week changes/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Show drawdown & 52-week edge' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  const zoom = page.getByRole('button', { name: 'Touchpad zoom off' });
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  await zoom.click();
  await expect(page.getByRole('button', { name: 'Touchpad zoom on' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('tab', { name: 'Saved runs (1)' }).click();
  await expect(page.getByRole('heading', { name: /Saved runs/ })).toBeVisible();
  // The name is plain text until Rename turns it into a field holding the current name.
  await page.getByRole('button', { name: 'Rename Run 1' }).click();
  await expect(page.getByRole('textbox', { name: 'Name for run 1' })).toHaveValue('Run 1');
});

test('Momentum Scores exposes stock and sector details', async ({ page }) => {
  await page.route('**/api/momentum/scores', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        as_of: '2024-01-19',
        universe_size: 1,
        lookbacks: [4, 13, 26],
        missing_symbols: [],
        stocks: [
          {
            symbol: 'TEST',
            company_name: 'Test Company',
            parent_group: 'Industry',
            subgroup: 'Metals',
            last_price: 120,
            change_1w_pct: 0.02,
            returns: { '4': 0.08, '13': 0.12, '26': 0.2 },
            scores: { '4': 75, '13': 80, '26': 90 },
          },
        ],
        sectors: [
          {
            cid: 'metals',
            parent_group: 'Industry',
            subgroup: 'Metals',
            member_count: 2,
            qualifying_count: 1,
            scores: { '4': 75, '13': 80, '26': 90 },
          },
        ],
      }),
    }),
  );

  await page.goto('/momentum/scores/stocks');
  await expect(page.getByText('Test Company')).toBeVisible();
  // Raw returns sit beside each score pill; stock rows no longer expand.
  const stockRow = page.getByRole('row', { name: /Test Company/ });
  await expect(stockRow).toContainText('+8.0%');
  await expect(stockRow).toContainText('+2.00%');
  await page.getByRole('radio', { name: 'Sectors', exact: true }).click();
  await page.getByRole('button', { name: /Metals/ }).click();
  // Anchored: the sector's own row contains the member table, so its name includes this text too.
  const memberRow = page.getByRole('row', { name: /^TEST · Test Company/ });
  await expect(memberRow).toContainText('₹120');
  await expect(memberRow).toContainText('+20.0%');
});

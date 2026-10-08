import { type Page, expect, test } from '@playwright/test';

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
  // BL-052: Saved runs lists strategies; each saved run here is its own strategy.
  await page.route(
    (url) => url.pathname.startsWith('/api/momentum/saved-strategies'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const strategies = savedRuns.map((run) => ({
        ...run,
        version_id: `momentum:etf:${run.id}`,
        dataset: 'etf',
        fingerprint: String(run.id),
        config_full: run.config,
        name_typed: true,
        notes: null,
        status: null,
        group: null,
        member_of: null,
        runs: 1,
        repeats: 0,
        first_saved: run.created_at,
        last_run: run.created_at,
        latest: {
          id: run.id,
          created_at: run.created_at,
          kpis: run.kpis,
          dates: run.dates,
          strategy: run.strategy,
          data_through: null,
          versions: null,
          outcome: 'new',
        },
        change: null,
        unreviewed: 0,
        trust: 'in_sample',
        history: [],
      }));
      const body = path.endsWith('/summary')
        ? { count: strategies.length, unreviewed: 0 }
        : path.endsWith('/merge')
          ? { merges: [], conflicts: [], runs: 0, strategies: 0 }
          : path === '/api/momentum/saved-strategies'
            ? { strategies, unreviewed: 0, ignored_fields: {} }
            : strategies[0];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
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

  // The headline strip: the deciding numbers against the benchmark. This result predates the
  // benchmark picker (no `benchmarks`), so it shows the run's own benchmark, fixed.
  const headline = page.getByRole('region', { name: 'Headline numbers' });
  await expect(headline).toContainText('CAGR');
  await expect(headline).toContainText('Benchmark Nifty 50');

  const chart = page.getByRole('img', { name: /Strategy and benchmark values/ });
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
  await expect(page.getByRole('button', { name: /Week changes/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Drawdown pane' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  // Below the chart: widgets, not tabs.
  await expect(page.getByRole('region', { name: 'Drawdowns' })).toBeVisible();

  const zoom = page.getByRole('button', { name: 'Touchpad zoom off' });
  await expect(zoom).toHaveAttribute('aria-pressed', 'false');
  await zoom.click();
  await expect(page.getByRole('button', { name: 'Touchpad zoom on' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('tab', { name: 'Saved runs (1)' }).click();
  await expect(page.getByRole('heading', { name: 'Strategies' })).toBeVisible();
  // A row opens its drawer; Rename there turns the name into a field holding it.
  await page.getByText('Run 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Rename Run 1' }).click();
  await expect(page.getByRole('textbox', { name: 'Strategy name' })).toHaveValue('Run 1');
});

/** One scored stock in a sector, with the history the drawer asks for. */
async function mockScores(page: Page): Promise<void> {
  const lookbacks = [1, 2, 4, 8, 13, 26, 52];
  const byLookback = (value: (weeks: number) => number) =>
    Object.fromEntries(lookbacks.map((weeks) => [String(weeks), value(weeks)]));
  await page.route('**/api/momentum/scores', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        as_of: '2024-01-19',
        universe_size: 1,
        ranked_count: 1,
        lookbacks,
        breadth: {
          above_ma40: { now: 0.6, week_ago: 0.55, month_ago: 0.5 },
          positive_13w: { now: 0.58, week_ago: 0.5 },
          median_26w: 0.08,
          top_decile_26w: 0.4,
        },
        missing_symbols: [],
        stocks: [
          {
            symbol: 'TEST',
            company_name: 'Test Company',
            parent_group: 'Industry',
            subgroup: 'Metals',
            tags: [{ parent_group: 'Industry', subgroup: 'Metals' }],
            last_price: 120,
            change_1w_pct: 0.02,
            returns: byLookback((weeks) => (weeks === 13 ? 0.12 : weeks === 26 ? 0.2 : 0.08)),
            scores: byLookback(() => 95),
            composite_rank: 1,
            composite_rank_prev: 4,
            high_52w_gap: -0.03,
            spark: Array.from({ length: 26 }, (_, i) => 100 + i),
          },
        ],
        rotation: {
          weeks: Array.from({ length: 18 }, (_, i) => `2023-09-${String(i + 1).padStart(2, '0')}`),
          groups: [
            {
              key: 'Industry',
              parent_group: 'Industry',
              subgroup: null,
              theme: false,
              member_count: 6,
              scored_count: 6,
              s4: Array.from({ length: 18 }, () => 60),
              s26: Array.from({ length: 18 }, () => 80),
            },
          ],
          subs: [
            {
              key: 'Industry / Metals',
              parent_group: 'Industry',
              subgroup: 'Metals',
              theme: false,
              member_count: 6,
              scored_count: 6,
              s4: Array.from({ length: 18 }, () => 60),
              s26: Array.from({ length: 18 }, () => 80),
            },
          ],
        },
        sectors: [
          {
            cid: 'metals',
            parent_group: 'Industry',
            subgroup: 'Metals',
            member_count: 2,
            qualifying_count: 1,
            scores: byLookback(() => 95),
          },
        ],
      }),
    }),
  );

  await page.route('**/api/momentum/scores/stock/TEST', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        symbol: 'TEST',
        weeks: Array.from(
          { length: 53 },
          (_, i) => `2023-01-${String((i % 28) + 1).padStart(2, '0')}`,
        ),
        closes: Array.from({ length: 53 }, (_, i) => 100 + i),
        ma40: Array.from({ length: 53 }, (_, i) => (i < 39 ? null : 110 + i / 2)),
        score_weeks: Array.from(
          { length: 12 },
          (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`,
        ),
        scores: byLookback(() => Array.from({ length: 12 }, (_, i) => 50 + i * 4)),
        rank_weeks: Array.from(
          { length: 26 },
          (_, i) => `2023-07-${String((i % 28) + 1).padStart(2, '0')}`,
        ),
        ranks: Array.from({ length: 26 }, (_, i) => 30 - i),
      }),
    }),
  );
}

test('Momentum Scores exposes stock and sector details', async ({ page }) => {
  await mockScores(page);

  // Sectors is the default view: the rotation map's table, then a group's page.
  await page.goto('/momentum/scores');
  await expect(page.getByRole('region', { name: 'Market momentum' })).toContainText('60%');
  await expect(page.getByRole('radio', { name: 'Sectors', exact: true })).toBeChecked();
  await page
    .getByRole('region', { name: 'Sector groups' })
    .getByRole('row', { name: /Industry/ })
    .click();
  await expect(page).toHaveURL(/\/momentum\/scores\/sectors\/industry/);
  await page
    .getByRole('region', { name: 'Industry sub-sectors' })
    .getByRole('row', { name: /Metals/ })
    .click();
  await expect(page).toHaveURL(/sub=/);

  // The stocks list: rank, movement, returns and price beside the strip.
  await page.getByRole('radio', { name: 'Stocks', exact: true }).click();
  await expect(page).toHaveURL(/\/momentum\/scores\/stocks/);
  const stockRow = page.getByRole('row', { name: /Test Company/ });
  await expect(stockRow).toBeVisible();
  await expect(stockRow).toContainText('▲3');
  await expect(stockRow).toContainText('+12.0%');
  await expect(stockRow).toContainText('+20.0%');
  await expect(stockRow).toContainText('₹120');
  await expect(stockRow.getByRole('img', { name: /Deciles by lookback/ })).toBeVisible();

  // A stock opens in a drawer; Esc closes it and the address loses ?stock.
  await stockRow.click();
  await expect(page.getByRole('dialog', { name: /TEST/ })).toBeVisible();
  await expect(page).toHaveURL(/stock=TEST/);
  await expect(page.getByRole('img', { name: /Weekly closes over the last year/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/stock=/);
});

test('Momentum Scores keeps saved views, shows circuit locks and folds the strip guide', async ({
  page,
}) => {
  await mockScores(page);
  let circuitCalls = 0;
  await page.route('**/api/momentum/scores/stock/TEST/circuits', (route) => {
    circuitCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        symbol: 'TEST',
        since: '2023-01-20',
        until: '2024-01-19',
        weeks: 52,
        sessions: 250,
        min_days: 3,
        total: 2,
        locks: [
          {
            direction: 'UC',
            start: '2024-02-09',
            end: '2024-02-12',
            days: 4,
            band_pct: 20,
            move_pct: 21.5,
            ongoing: false,
          },
          {
            direction: 'LC',
            start: '2023-05-29',
            end: '2023-06-02',
            days: 3,
            band_pct: 20,
            move_pct: -14.3,
            ongoing: true,
          },
        ],
      }),
    });
  });

  await page.goto('/momentum/scores/stocks');
  await expect(page.getByRole('row', { name: /Test Company/ })).toBeVisible();
  // The drawer's circuit call is made only once a stock is opened.
  expect(circuitCalls).toBe(0);

  // The strip guide starts open; "Got it" folds it, and it stays folded after a reload.
  const guide = page.getByRole('region', { name: 'How to read the strip' });
  await expect(guide.getByRole('button', { name: 'Got it' })).toBeVisible();
  await guide.getByRole('button', { name: 'Got it' }).click();
  await expect(guide.getByRole('button', { name: 'Got it' })).toHaveCount(0);

  // Save the current view (the Leaders chip) under a name, go back to All, then apply it.
  await page.getByRole('radio', { name: /^Leaders/ }).click();
  await page.getByRole('button', { name: 'Saved views' }).click();
  await page.getByRole('menuitem', { name: /Save current view/ }).click();
  await page.getByRole('textbox', { name: 'Name for this view' }).fill('My leaders');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('radio', { name: /^All/ }).click();
  await page.getByRole('button', { name: 'Saved views' }).click();
  await page.getByRole('menuitemradio', { name: /My leaders/ }).click();
  await expect(page.getByRole('radio', { name: /^Leaders/ })).toBeChecked();

  // A reload keeps the view and the folded guide, and the list still opens on All.
  await page.reload();
  await expect(page.getByRole('radio', { name: /^All/ })).toBeChecked();
  await expect(guide.getByRole('button', { name: 'Got it' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Saved views' }).click();
  await expect(page.getByRole('menuitemradio', { name: /My leaders/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Opening a stock fetches its circuit locks, newest first.
  await page.getByRole('row', { name: /Test Company/ }).click();
  const drawer = page.getByRole('dialog', { name: /TEST/ });
  await expect(drawer.getByText('Circuit locks')).toBeVisible();
  await expect(drawer.getByText('Upper', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Lower', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Ongoing', { exact: true })).toBeVisible();
  expect(circuitCalls).toBeGreaterThan(0);
});

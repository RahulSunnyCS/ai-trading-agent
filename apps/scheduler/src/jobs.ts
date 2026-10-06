import { type Schedule, firstWeekdayOfMonth, onWeekdays, tradingDays } from './schedule.js';

/**
 * Every recurring job, in one place (BL-012). Adding a job means adding an
 * entry here — no plist, no cron line elsewhere.
 */
export interface Job {
  id: string;
  description: string;
  schedule: Schedule;
  /**
   * Steps run in order; the run stops at the first non-zero exit. Each step is
   * argv (no shell), executed in `cwd`, relative to the repo root.
   */
  steps: string[][];
  cwd: string;
  timeoutMinutes: number;
  /** Extra attempts after a failure, `retryDelayMinutes` apart. */
  retries: number;
  retryDelayMinutes: number;
  /**
   * After a missed slot (laptop asleep or off), run it if no more than this
   * many hours late; otherwise report it as missed. 0 = never catch up.
   */
  catchUpHours: number;
  /**
   * Jobs in the same group never run at the same time. `catalog` = anything
   * that writes the DuckDB catalog, which allows one writer process.
   */
  group?: 'catalog';
  /**
   * Where it can run: `home` needs a residential IP (NSE, niftyindices),
   * `gui` a desktop session for a headed browser, `postgres` the local DB.
   */
  needs?: Array<'home' | 'gui' | 'postgres'>;
  /** The command to put in a failure alert, so the fix is one copy-paste. */
  fixHint: string;
  /**
   * The job sends its own Telegram alert when it fails, so the scheduler does
   * not repeat it. The scheduler still alerts when the job was missed, timed
   * out or could not start, because then the job never got the chance.
   */
  alertsItself?: boolean;
  /**
   * Write the run log to this fixed file (repo-relative) instead of
   * `<logDir>/<job>/<date>.log`. The Momentum dashboard reads the Friday jobs'
   * `data/launchd-weekly-*.log` for "when did it last run" — kept until that
   * panel reads the scheduler API instead (BL-012 PR 16).
   */
  logFile?: string;
  /** Run an in-process job (see runner's `builtins`) instead of `steps`. */
  builtin?: 'morning-summary' | 'backup';
}

const MOMENTUM = 'packages/momentum-backtesting';
const OPTIONS = 'packages/option-backtesting';
const BROKER_LOGIN = 'packages/broker-login';
const FRIDAY = onWeekdays(5);

export const JOBS: Job[] = [
  {
    id: 'broker-login',
    description: 'Trigger the AlgoTest broker login workflow on GitHub',
    schedule: { at: '08:00', on: tradingDays, label: 'trading days 08:00' },
    steps: [['node_modules/.bin/tsx', 'src/dispatch.ts']],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 0, // dispatch.ts retries itself and must never dispatch twice
    retryDelayMinutes: 0,
    catchUpHours: 7, // dispatch.ts itself refuses after 15:35
    alertsItself: true,
    fixHint: 'Start "Daily broker login" by hand from GitHub Actions',
  },
  {
    id: 'fyers-login',
    description: 'Headless Fyers login; stores the token in broker_tokens',
    schedule: { at: '08:05', on: tradingDays, label: 'trading days 08:05' },
    steps: [['node_modules/.bin/tsx', 'src/fyers.ts', '--store']],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 1, // fyers.ts does not retry a rejected PIN, so a second run is safe
    retryDelayMinutes: 5,
    catchUpHours: 10,
    needs: ['postgres'],
    alertsItself: true,
    fixHint: 'Log in from the dashboard (Broker logins), or: uv run mbt login',
  },
  {
    id: 'momentum-preview',
    description: 'Momentum weekly preview on live prices',
    schedule: { at: '14:40', on: FRIDAY, label: 'Fri 14:40' },
    steps: [['uv', 'run', 'mbt', 'weekly', '--run', 'preview']],
    cwd: MOMENTUM,
    timeoutMinutes: 30,
    retries: 1,
    retryDelayMinutes: 5,
    catchUpHours: 0.5, // a preview after ~15:15 is too late to trade on
    group: 'catalog',
    alertsItself: true,
    logFile: `${MOMENTUM}/data/launchd-weekly-preview.log`,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt weekly --run preview',
  },
  {
    id: 'momentum-final',
    description: 'Momentum weekly final signal',
    schedule: { at: '16:45', on: FRIDAY, label: 'Fri 16:45' },
    steps: [['uv', 'run', 'mbt', 'weekly', '--run', 'final']],
    cwd: MOMENTUM,
    timeoutMinutes: 45,
    retries: 1,
    retryDelayMinutes: 10,
    catchUpHours: 48,
    group: 'catalog',
    alertsItself: true,
    logFile: `${MOMENTUM}/data/launchd-weekly-final.log`,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt weekly --run final',
  },
  {
    id: 'momentum-stock-ingest',
    description: 'NSE stock sync, then the stock / Custom Index / Broad final',
    schedule: { at: '19:30', on: FRIDAY, label: 'Fri 19:30' },
    steps: [
      ['uv', 'run', 'mbt', 'stocks', 'sync'],
      [
        'uv',
        'run',
        'mbt',
        'weekly',
        '--run',
        'final',
        '--only-dataset',
        'stock',
        '--only-dataset',
        'custom_index',
        '--only-dataset',
        'broad',
      ],
    ],
    cwd: MOMENTUM,
    timeoutMinutes: 120,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 48,
    group: 'catalog',
    needs: ['home', 'gui'],
    logFile: `${MOMENTUM}/data/launchd-weekly-stock-ingest.log`,
    fixHint:
      'cd packages/momentum-backtesting && uv run mbt stocks sync && uv run mbt weekly --run final --only-dataset stock --only-dataset custom_index --only-dataset broad',
  },
  {
    id: 'momentum-journal-check',
    description: "Check this week's forward journal recorded every favourite",
    schedule: { at: '21:00', on: FRIDAY, label: 'Fri 21:00' },
    steps: [['uv', 'run', 'mbt', 'journal', 'check', '--send']],
    cwd: MOMENTUM,
    timeoutMinutes: 15,
    retries: 1,
    retryDelayMinutes: 10,
    catchUpHours: 48,
    group: 'catalog',
    alertsItself: true,
    logFile: `${MOMENTUM}/data/launchd-weekly-journal-check.log`,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt journal check --send',
  },
  {
    id: 'options-daily',
    description:
      "Collect the day's 1-minute option data from Fyers and run every leg-wise strategy",
    schedule: { at: '16:15', on: tradingDays, label: 'trading days 16:15' },
    steps: [['uv', 'run', 'obt', 'daily']],
    cwd: OPTIONS,
    timeoutMinutes: 90,
    // Contracts that expire today cannot be downloaded tomorrow, so keep trying through
    // the evening (16:15, 17:45, 19:15) — usually it is waiting on a Fyers login. obt
    // daily skips data already collected, so a retry is cheap.
    retries: 2,
    retryDelayMinutes: 90,
    catchUpHours: 6.75, // until 23:00
    group: 'catalog',
    alertsItself: true,
    fixHint: 'Log in to Fyers, then: cd packages/option-backtesting && uv run obt daily',
  },
  {
    id: 'backup',
    description: 'Copy the research database (TRADING_DATA_ROOT) to the external SSD',
    schedule: { at: '10:00', on: firstWeekdayOfMonth(0), label: '1st Sunday of the month 10:00' },
    steps: [],
    builtin: 'backup',
    cwd: '.',
    timeoutMinutes: 120,
    retries: 1,
    retryDelayMinutes: 60,
    catchUpHours: 7 * 24, // any time that week
    group: 'catalog', // tdata backup CHECKPOINTs the catalog
    fixHint:
      'Plug in the SSD, then: cd packages/trading-data && uv run tdata backup --to "/Volumes/RAHUL\'S SSD/TradingData"',
  },
  {
    id: 'morning-summary',
    description: 'One Telegram message: did the morning logins work, is the data current',
    schedule: { at: '09:00', on: tradingDays, label: 'trading days 09:00' },
    steps: [],
    builtin: 'morning-summary',
    cwd: '.',
    timeoutMinutes: 5,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 3,
    fixHint: 'bun run --filter @ata/scheduler jobs run morning-summary',
  },
];

export function findJob(id: string): Job | undefined {
  return JOBS.find((job) => job.id === id);
}

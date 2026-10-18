import { CHECK_JOBS } from './checks/index.js';
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
  builtin?: string;
}

const MOMENTUM = 'packages/momentum-backtesting';
const OPTIONS = 'packages/option-backtesting';
const TRADING_DATA = 'packages/trading-data';
const BROKER_LOGIN = 'packages/broker-login';
const FRIDAY = onWeekdays(5);

const BASE_JOBS: Job[] = [
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
    // BL-051 Phase 3: the headline's orders before the close. With a signal delay of 1 the
    // decision is already fixed by last Friday's ranks, so they can be placed at 14:15.
    id: 'momentum-orders',
    description: 'Momentum: your orders for the headline favourite',
    schedule: { at: '14:15', on: FRIDAY, label: 'Fri 14:15' },
    steps: [['uv', 'run', 'mbt', 'orders', 'run', '--send']],
    cwd: MOMENTUM,
    timeoutMinutes: 20,
    retries: 1,
    retryDelayMinutes: 5,
    catchUpHours: 1, // orders after ~15:15 are too late to place before the close
    group: 'catalog',
    alertsItself: true,
    logFile: `${MOMENTUM}/data/launchd-weekly-orders.log`,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt orders run',
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
    id: 'momentum-live-rules',
    description:
      "Check the owner's live-money rules (drawdown, trailing, money gate) against the followed money",
    schedule: { at: '21:30', on: FRIDAY, label: 'Fri 21:30' },
    steps: [['uv', 'run', 'mbt', 'live-rules', 'check', '--send']],
    cwd: MOMENTUM,
    // Runs the four frozen configs through the latest week, like `mbt search track`.
    timeoutMinutes: 30,
    retries: 1,
    retryDelayMinutes: 15,
    catchUpHours: 48,
    group: 'catalog',
    // The command sends its own message, including when it cannot run or the data is stale.
    alertsItself: true,
    logFile: `${MOMENTUM}/data/launchd-weekly-live-rules.log`,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt live-rules check --send',
  },
  {
    id: 'options-evening',
    description:
      "The evening run: collect the day's 1-minute option data and run every leg-wise strategy (`obt daily`), store the rotation results (`obt rotation update`, BL-058), rebuild missing derived tables, store the T1 track's results, then (only from 16:00, so normally a no-op) send the result. The 16:00 Telegram result is the next job's (`options-rotation-result`)",
    schedule: { at: '15:45', on: tradingDays, label: 'trading days 15:45' },
    // One job, five steps in order: each needs the day the one before it collected, and the run
    // stops at the first failure. Every step is idempotent (obt daily skips data already
    // collected, a stored rotation variant-day is never rewritten, derived rebuilds only what is
    // missing), so a retry re-runs the whole chain cheaply. The last two (BL-125) are
    // `--soft-fail`: a problem Telegrams its own alert and exits 0, so neither ever fails this job
    // (whose retries would re-run `obt daily` and resend its summary).
    // - The T1 update takes seconds; if it fails, the 16:00 message says T1 is not ready and the
    //   21:00 job is the catch-up.
    // - The result step sends nothing before 16:00 (the 16:00 job does). It is there for the day
    //   this job only succeeds on a late retry (17:15, ...): the 16:00 job has given up by then and
    //   a failed slot is never caught up, so this sends the result as soon as the data is in.
    //   The sent markers make the two jobs safe together.
    steps: [
      ['uv', 'run', '--directory', OPTIONS, 'obt', 'daily'],
      ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'update'],
      ['uv', 'run', '--directory', TRADING_DATA, 'tdata', 'derived', 'rebuild'],
      [
        'uv',
        'run',
        '--directory',
        OPTIONS,
        'obt',
        'rotation',
        'update',
        '--track',
        't1',
        '--soft-fail',
      ],
      [
        'uv',
        'run',
        '--directory',
        OPTIONS,
        'obt',
        'rotation',
        'result',
        '--not-before',
        '16:00',
        '--soft-fail',
      ],
    ],
    cwd: '.',
    timeoutMinutes: 90, // per step
    // Contracts that expire today cannot be downloaded tomorrow, so keep trying through
    // the evening (15:45, 17:15, 18:45, 20:15) — usually it is waiting on a Fyers login.
    retries: 3,
    retryDelayMinutes: 90,
    catchUpHours: 7.25, // until 23:00
    group: 'catalog',
    fixHint:
      'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt daily && uv run --directory packages/option-backtesting obt rotation update && uv run --directory packages/option-backtesting obt rotation update --track t1',
  },
  {
    id: 'options-rotation-result',
    description:
      "Telegram the day's rotation result at 16:00 (BL-125): Adaptive's and the T1 track's one-lot net paper gain and tomorrow's strategies in full (`obt rotation result`). Retried every 5 minutes while the evening run's results are incomplete; sends what exists at 16:25, and the T1 part later if it was missing",
    // The evening run (15:45) takes about 10 minutes and its last step (the T1 update) takes
    // seconds, so 16:00 is normally enough. Not in the catalog group: it only reads the rotation
    // journal and result files. An attempt that finds Adaptive (or, before 16:25, T1) incomplete
    // exits 2 and is retried; when the retries run out the owner gets the scheduler's failure
    // alert instead of silence. Sent markers make every retry safe (no double send).
    schedule: { at: '16:00', on: tradingDays, label: 'trading days 16:00' },
    steps: [
      ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'result', '--wait-until', '16:25'],
    ],
    cwd: '.',
    timeoutMinutes: 10,
    retries: 7, // 16:00, 16:05 ... 16:35
    retryDelayMinutes: 5,
    // Catch-up covers a 16:00 slot missed while the laptop slept (until 22:00), not a failed run:
    // when the evening run only succeeds on a late retry, its own last step (`result
    // --not-before 16:00`) sends the message, and the 21:00 job's result step is the net under it.
    catchUpHours: 6,
    fixHint:
      'uv run --directory packages/option-backtesting obt rotation result  (the evening run must have stored the results first; add --force to resend)',
  },
  {
    id: 'options-rotation-t1-update',
    description:
      "Catch-up for the T1 parallel track (`obt rotation update --track t1`): stores any day the evening run did not (its 223 extra variants only, in their own folder; the live results are never touched), then `obt rotation result` sends the T1 part of the day's result if it was not ready at 16:00",
    // The evening run does this at about 15:55 now (BL-125); this is the net under it, after the
    // last retry (20:15). Idempotent: it scores every Core-298 day the track lacks, and the result
    // step is a no-op once everything has been sent (or sends the main message late if nothing
    // else could). The update is `--soft-fail` (alerts, exits 0) so the result step always runs:
    // a T1 problem must never cost the day's Adaptive result. The 09:16 job repeats the update as
    // a catch-up before the track pick.
    schedule: { at: '21:00', on: tradingDays, label: 'trading days 21:00' },
    steps: [
      [
        'uv',
        'run',
        '--directory',
        OPTIONS,
        'obt',
        'rotation',
        'update',
        '--track',
        't1',
        '--soft-fail',
      ],
      ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'result'],
    ],
    cwd: '.',
    timeoutMinutes: 20,
    retries: 2,
    retryDelayMinutes: 60,
    catchUpHours: 2.5, // until 23:30
    group: 'catalog',
    fixHint:
      'uv run --directory packages/option-backtesting obt rotation update --track t1  (add --backfill to fill every missing day), then obt rotation result',
  },
  {
    id: 'options-rotation-pick',
    description:
      "Record the day's rotation picks (lists A, B, C, REF) before 09:17 (BL-058) and the T1 parallel track's Adaptive pick in its own journal, and Telegram ONE message: Adaptive, then T1 labelled testing phase (BL-125). Adaptive is never held back by T1; the friends' group gets Adaptive alone",
    // Needs the 09:15 VIX bar, which Fyers serves from 09:16, and yesterday's results (the evening
    // job above). A late entry is flagged (before_first_entry: false), never silently accepted,
    // and a missed slot is not caught up: it would not be forward.
    schedule: { at: '09:16', on: tradingDays, label: 'trading days 09:16' },
    // One step: the live pick first, then the track in the same process, so one message can carry
    // both. A failed track step still alerts and fails the run (exit 2), and the retry finds the
    // live entry already recorded and only completes the track (its own message). The command
    // stores any missing T1 results itself when that is why the track cannot be ranked.
    steps: [['uv', 'run', 'obt', 'rotation', 'pick', '--with-t1']],
    cwd: OPTIONS,
    timeoutMinutes: 5,
    retries: 2,
    retryDelayMinutes: 1,
    catchUpHours: 0,
    alertsItself: true,
    fixHint:
      'cd packages/option-backtesting && uv run obt rotation pick --with-t1  (a late entry is flagged, not forward)',
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

/** Every job: the ones above plus each check group's (src/checks/). */
export const JOBS: Job[] = [...BASE_JOBS, ...CHECK_JOBS];

export function findJob(id: string): Job | undefined {
  return JOBS.find((job) => job.id === id);
}

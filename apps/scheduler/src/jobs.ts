import { CHECK_JOBS } from './checks/index.js';
import { type Schedule, firstWeekdayOfMonth, onWeekdays, tradingDays } from './schedule.js';

/**
 * Every recurring job, in one place (BL-012). Adding a job means adding an
 * entry here — no plist, no cron line elsewhere.
 */
/**
 * The longest a run of `job` can take while the scheduler lives: every step of every attempt to
 * its timeout (the timeout is per step), the delays between attempts, and (for a grouped job) the
 * wait for its group, which gives up after one timeout. BL-143's trade monitor ignores a "running"
 * row older than this, only when the row's processes are gone (`GET /jobs` says `alive`).
 */
export function maxRunMinutes(job: Job): number {
  const attempts = job.retries + 1;
  return (
    job.timeoutMinutes * Math.max(1, job.steps.length) * attempts +
    job.retryDelayMinutes * job.retries +
    (job.group ? job.timeoutMinutes : 0)
  );
}

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
  /**
   * Exit codes that are never retried: the step says a retry cannot help (a refused password,
   * a conflict the owner must look at). Retrying those would only repeat them.
   */
  noRetryExitCodes?: number[];
  retryDelayMinutes: number;
  /**
   * After a missed slot (laptop asleep or off), run it if no more than this
   * many hours late; otherwise report it as missed. 0 = never catch up.
   */
  catchUpHours: number;
  /**
   * Jobs in the same group never run at the same time. `catalog` = anything
   * that writes the DuckDB catalog, which allows one writer process.
   * `quantiply` = the jobs that log in to Quantiply and change its algos: a deploy then always
   * runs after the upload before it, retries included. (The group does not space their logins:
   * the next job starts the moment one ends. `quantiply-session.ts` does, with a file stamp of
   * the last TOTP window each account typed a code from.)
   */
  group?: 'catalog' | 'quantiply';
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
  /**
   * `HH:MM` IST: a run of today's slot cut off by a scheduler or laptop restart (reaped as
   * interrupted) is started again until then (BL-143's all-session trade monitor). Without it an
   * interrupted slot counts as served.
   */
  restartIfInterruptedUntil?: string;
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
    // ONE Angel One SmartAPI login (nothing fetched): is the evening run's fallback source ready?
    // The same guarded check as the Broker logins card's Test connection: it waits out a test in
    // flight or the 60 s cool-down rather than fail, and its retry (5 minutes later, past its
    // own cool-down) is for a network blip; a login Angel One refused is never sent again by the
    // retry (`--scheduled`), since each wrong attempt counts toward a lockout. 08:00 is the
    // owner's choice (2026-10-18). `broker-login` above also logs in to Angel One with the same
    // account, from GitHub, where this job's refusal hold can't see it: AlgoTest's Angel One login
    // (off while BROKER_LOGIN_ONLY=finvasia; from 08:15) and, with QUANTIPLY_LOGIN on, Quantiply's
    // at about 08:02. A wrong PIN is therefore refused once here and once or twice there per day
    // (that workflow never resends a refused PIN, and its backstops skip Quantiply once a run
    // happened). They seldom share a 30-second TOTP window; when they do and Angel refuses the
    // reused code, the GitHub side retries with the next window's code.
    id: 'angel-login-check',
    description: 'Angel One: one SmartAPI login, to check the fallback data source works',
    schedule: { at: '08:00', on: tradingDays, label: 'trading days 08:00' },
    steps: [['uv', 'run', 'obt', 'angel', 'test', '--scheduled']],
    cwd: OPTIONS,
    timeoutMinutes: 8,
    retries: 1,
    retryDelayMinutes: 5,
    catchUpHours: 70 / 60, // until 09:10
    fixHint:
      'Check the ANGELONE_* settings in .env, then Broker logins › Angel One › Test connection (or: cd packages/option-backtesting && uv run obt angel test)',
  },
  {
    // BL-142: the 14:15 orders read the Kite holdings and free cash, and a Kite token dies at
    // 06:00. When Kite is the holdings source and today has no valid login, Telegram the owner
    // to log in (Broker logins › Kite). Says nothing when the login is fine or Kite is not used.
    id: 'kite-login-reminder',
    description: 'Kite: remind to log in before the 14:15 orders',
    schedule: { at: '13:30', on: FRIDAY, label: 'Fri 13:30' },
    steps: [['uv', 'run', 'mbt', 'kite', 'remind', '--send']],
    cwd: MOMENTUM,
    timeoutMinutes: 5,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 0.5, // after ~14:00 a reminder comes too late for 14:15
    group: 'catalog',
    fixHint: 'cd packages/momentum-backtesting && uv run mbt kite login',
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
    // The evening run (15:45) takes about 10 minutes and its T1 update takes seconds, so 16:00
    // is normally enough. Not in the catalog group: it only reads the rotation
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
      'If the evening run only finished on a later retry, its last step sends the result itself; otherwise: uv run --directory packages/option-backtesting obt rotation result  (the evening run must have stored the results first; add --force to resend)',
  },
  {
    id: 'options-rotation-t1-update',
    description:
      "Catch-up for the T1 parallel track (`obt rotation update --track t1`): stores any day the evening run did not (its 223 extra variants only, in their own folder; the live results are never touched), then `obt rotation result` sends the T1 part of the day's result if it was not ready at 16:00",
    // The evening run does this at about 15:55 now (BL-125); this is the net under it, after the
    // last retry (20:15). Idempotent: it scores every Core-298 day the track lacks, and the result
    // step is a no-op once everything has been sent. Steps: first `result --soft-fail` sends
    // anything still owed (a T1 problem must never cost the day's Adaptive result, and it never
    // fails the job), then the update is strict, so a T1 failure fails the job and its 22:00 /
    // 23:00 retries try again, and the last `result` sends the T1 part once it is in. The 09:16
    // job repeats the update as a catch-up before the track pick.
    schedule: { at: '21:00', on: tradingDays, label: 'trading days 21:00' },
    steps: [
      ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'result', '--soft-fail'],
      ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'update', '--track', 't1'],
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
    id: 'algotest-evening',
    description:
      "Put tomorrow's expected picks into AlgoTest as saved strategies (BL-137): the lists the dashboard's Settings › Automation gives AlgoTest (BL-140; T1 until changed). Exports them (`obt rotation algotest-export --from-settings --next`), then deletes the strategies the tool uploaded that tomorrow drops and uploads the missing ones. Never deploys. Does nothing until ALGOTEST_UPLOAD=on",
    // After the 16:00 result message (its retries end 16:35). The export exits 2 while the day's
    // results are incomplete (a late Fyers login), so the retries carry it to 20:40. It deletes the
    // strategies it uploaded that tomorrow drops (--allow-delete, owner 2026-10-20): AlgoTest's own
    // API call by each strategy's id, never one deployed on /live or one it did not upload, and it
    // stops at once if any other strategy vanishes with a delete.
    schedule: { at: '16:40', on: tradingDays, label: 'trading days 16:40' },
    steps: [
      [
        'uv',
        'run',
        '--directory',
        '../option-backtesting',
        'obt',
        'rotation',
        'algotest-export',
        '--from-settings',
        '--next',
      ],
      [
        'node_modules/.bin/tsx',
        'src/strategy-upload.ts',
        '--from-settings',
        '--mode',
        'evening',
        '--apply',
        '--allow-delete',
      ],
    ],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 15,
    retries: 4,
    noRetryExitCodes: [3], // a conflict, a read-back that differs, a delete only the owner can sort out, or a STOP
    retryDelayMinutes: 60,
    catchUpHours: 4,
    fixHint:
      'cd packages/option-backtesting && uv run obt rotation algotest-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode evening (add --apply once the plan looks right)',
  },
  {
    id: 'algotest-topup',
    description:
      "After the 09:16 pick, upload any recorded pick of AlgoTest's lists (dashboard settings, BL-140) that last night's upload does not have (BL-137); deletes nothing and names the strategies that are not today's. Does nothing until ALGOTEST_UPLOAD=on",
    // The pick is recorded at about 09:16:20; a changed 09:17 pick cannot be deployed in time
    // anyway, so 09:18 costs nothing. Not caught up after a long sleep: the picks would be stale.
    schedule: { at: '09:18', on: tradingDays, label: 'trading days 09:18' },
    steps: [
      [
        'uv',
        'run',
        '--directory',
        '../option-backtesting',
        'obt',
        'rotation',
        'algotest-export',
        '--from-settings',
      ],
      [
        'node_modules/.bin/tsx',
        'src/strategy-upload.ts',
        '--from-settings',
        '--mode',
        'topup',
        '--apply',
      ],
    ],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 2,
    noRetryExitCodes: [3], // a conflict or a read-back that differs: retrying only repeats it
    retryDelayMinutes: 2,
    catchUpHours: 0.5,
    fixHint:
      'cd packages/option-backtesting && uv run obt rotation algotest-export --from-settings; then cd ../broker-login && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode topup --apply',
  },
  {
    id: 'algotest-deploy',
    description:
      "Deploy the day's recorded T1 picks on AlgoTest's /live (BL-138), right after the 09:16 pick: 1 lot each, today only, never a pick whose entry minute has come. Built ready but OFF: does nothing until ALGOTEST_DEPLOY=on",
    // Starts with the pick and waits (up to 120 s) for its journal entry. A 09:17 pick may still be
    // too late through the website; it is then reported, never deployed late. Not caught up.
    schedule: { at: '09:16', on: tradingDays, label: 'trading days 09:16' },
    steps: [
      [
        'uv',
        'run',
        '--directory',
        '../option-backtesting',
        'obt',
        'rotation',
        'algotest-export',
        '--book',
        't1',
        '--wait',
        '120',
      ],
      ['node_modules/.bin/tsx', 'src/strategy-deploy.ts', '--latest', 't1', '--apply'],
    ],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 0, // a second attempt could deploy what the first already did; the run alerts instead
    retryDelayMinutes: 0,
    catchUpHours: 0,
    fixHint:
      "First read each pick's Deployed count on algotest.in/live (the alert says what it showed): a pick that is already deployed must not be deployed again. Deploy only the rest by hand; then: cd packages/broker-login && node_modules/.bin/tsx src/strategy-deploy.ts --latest t1  (dry run)",
  },
  {
    id: 'algotest-deploy-check',
    description:
      'At 15:35, alert if any strategy the tool deploys on AlgoTest has an execution day ticked (it would trade again on its own). Does nothing until ALGOTEST_DEPLOY=on',
    schedule: { at: '15:35', on: tradingDays, label: 'trading days 15:35' },
    steps: [['node_modules/.bin/tsx', 'src/strategy-deploy.ts', '--latest', 't1', '--check']],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 5,
    retries: 1,
    retryDelayMinutes: 2,
    catchUpHours: 0,
    fixHint: 'Open algotest.in/live and untick the execution days of the T1 strategies',
  },
  {
    id: 'live-capture',
    description:
      "Record the day's live results (BL-141): for each platform + broker the dashboard's Settings › Automation has on, every strategy that ran today, the tool's (in the uploaders' ledgers) or the owner's own (discretionary), with its live ₹, multiplier and fills where the platform gives them, to TRADING_DATA_ROOT/rotation/live/<day>.jsonl; also back-fills the last 5 trading days that miss a section. Read-only on AlgoTest and Quantiply (GET calls only). One attempt; live-capture-retry reads what it missed. The 16:00 result message puts it beside paper (owner only)",
    // 15:40: every pick has exited (15:28). In the Quantiply group, ahead of quantiply-disable at
    // the same minute, so its Angel One login never overlaps another Quantiply job's (the TOTP
    // window stamp in quantiply-session.ts spaces them). One attempt with a short timeout, so the
    // disable starts by 15:48 at the latest; --soft-fail leaves the alert to the retry job.
    // The evening uploads do not wait for it: both platforms keep a day's P&L after its
    // strategies are deleted (checked 2026-10-20), so a missed day is back-filled later.
    schedule: { at: '15:40', on: tradingDays, label: 'trading days 15:40' },
    steps: [['node_modules/.bin/tsx', 'src/live-capture.ts', '--soft-fail']],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 8,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 6,
    group: 'quantiply',
    fixHint:
      'cd packages/broker-login && node_modules/.bin/tsx src/live-capture.ts  (reads what is missing; --day D for one day, --force to read it again, --dry-run prints only)',
  },
  {
    id: 'live-capture-retry',
    description:
      "Read again whatever the 15:40 live capture could not (BL-141): only the platform + broker sections the day's file does not have as read, so an account already read is never logged in to again. Alerts once if the day is still not captured by about 16:30; the next evening's capture back-fills it",
    // After quantiply-disable (15:40, a few minutes), still in the Quantiply group so its logins
    // never overlap another Quantiply job's; its retries end by about 16:30, before the 16:45
    // upload. With everything read it logs in nowhere and exits at once, so a catch-up after a
    // sleep costs nothing.
    schedule: { at: '15:55', on: tradingDays, label: 'trading days 15:55' },
    steps: [['node_modules/.bin/tsx', 'src/live-capture.ts', '--no-backfill']],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 6,
    retries: 2, // 15:55, about 16:09, about 16:23
    noRetryExitCodes: [3], // missing credentials, a Quantiply login held or refused
    retryDelayMinutes: 8,
    catchUpHours: 6,
    group: 'quantiply',
    fixHint:
      'cd packages/broker-login && node_modules/.bin/tsx src/live-capture.ts --day <day>  (the next evening back-fills it by itself; the 16:00 message said "live not captured")',
  },
  {
    id: 'quantiply-disable',
    description:
      "After the session, switch off on each Quantiply account the algos the uploader made for today that are still enabled, and any of an earlier session (BL-139 Phase 4): an enabled Quantiply algo runs again on its weekday next week. Only the tool's algos (its ledger), only finished ones, confirmed by reading the list again. The safety net: always runs, whatever QUANTIPLY_DEPLOY and Automated deployment say",
    // 15:40: every pick has exited (15:28), and the 16:45 upload comes after (same group), so it
    // can delete them. Never gated (not by QUANTIPLY_DEPLOY, the deploy switch or the account's
    // row): switching off only lowers what trades, and whatever was enabled must not repeat. An
    // account with nothing of the tool's for today or earlier is not logged in. Safe to retry.
    schedule: { at: '15:40', on: tradingDays, label: 'trading days 15:40' },
    steps: [['/bin/sh', '-c', quantiplyBoth((b) => quantiplyDeploy(b, 'disable'))]],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 2,
    noRetryExitCodes: [3], // an algo still running, or a change not made by this run: the owner looks
    retryDelayMinutes: 5,
    catchUpHours: 8, // before the next session of that weekday, any time this evening will do
    group: 'quantiply',
    fixHint:
      'In Quantiply, switch off every "Core · " / "T1 · " algo that is still enabled; then check with: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker angelone --mode check',
  },
  {
    id: 'quantiply-evening',
    description:
      "Put tomorrow's expected picks into Quantiply as algos for tomorrow's weekday (BL-139): for each Quantiply account (Angel One, Shoonya), the list the dashboard's Settings › Automation gives it (BL-140; Core on Angel One until changed). Exports them (`obt rotation quantiply-export --from-settings --next`), then, through Quantiply's API, deletes the finished algos the tool created that tomorrow drops and creates the missing ones; an account the settings leave off is not touched. Never enables (deploys). Does nothing until QUANTIPLY_UPLOAD=on",
    // After algotest-evening (16:40), so the two never log in at once. The export exits 2 while
    // the day's results are incomplete (a late Fyers login), so the retries carry it to 20:45.
    schedule: { at: '16:45', on: tradingDays, label: 'trading days 16:45' },
    steps: [
      [
        'uv',
        'run',
        '--directory',
        '../option-backtesting',
        'obt',
        'rotation',
        'quantiply-export',
        '--from-settings',
        '--next',
      ],
      // Both accounts always run (a failed step would stop the next); the job fails if either did.
      ['/bin/sh', '-c', quantiplyUploads('evening')],
    ],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 4,
    noRetryExitCodes: [3], // a refused login or a conflict: retrying only repeats it
    retryDelayMinutes: 60,
    catchUpHours: 4,
    group: 'quantiply',
    fixHint:
      'cd packages/option-backtesting && uv run obt rotation quantiply-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/quantiply-upload.ts --broker angelone|finvasia --from-settings --mode evening (add --apply once the plan looks right)',
  },
  {
    id: 'quantiply-topup',
    description:
      "After the 09:16 pick, create on each Quantiply account any recorded pick of its list (dashboard settings, BL-140) that last night's upload does not have (BL-139); deletes nothing and names the algos that are not today's. Does nothing until QUANTIPLY_UPLOAD=on",
    // 09:19, not 09:18: a minute clear of the pick's own Angel One work, so two logins never type
    // codes from one TOTP window. A changed 09:17 pick is too late either way. Not caught up.
    schedule: { at: '09:19', on: tradingDays, label: 'trading days 09:19' },
    steps: [
      [
        'uv',
        'run',
        '--directory',
        '../option-backtesting',
        'obt',
        'rotation',
        'quantiply-export',
        '--from-settings',
      ],
      // Both accounts always run (a failed step would stop the next); the job fails if either did.
      ['/bin/sh', '-c', quantiplyUploads('topup')],
    ],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 1,
    noRetryExitCodes: [3], // a refused login or a conflict: retrying only repeats it
    retryDelayMinutes: 2,
    catchUpHours: 0.5,
    group: 'quantiply',
    fixHint:
      'cd packages/option-backtesting && uv run obt rotation quantiply-export --from-settings; then cd ../broker-login && node_modules/.bin/tsx src/quantiply-upload.ts --broker angelone|finvasia --from-settings --mode topup --apply',
  },
  {
    id: 'quantiply-deploy',
    description:
      "Enable (deploy) on each Quantiply account the next session's picks the evening upload made (BL-139 Phase 4): REAL MONEY on the owner's account. Only the tool's algos for that session and weekday, each read back against its export and set to the account's own broker first; never a second time; confirmed by reading the list again. Needs QUANTIPLY_DEPLOY=on, Automated deployment on and the account's row uploading a list",
    // After quantiply-evening (16:45; same group, so it waits for the upload and its retries).
    // After 15:30 the session is the next trading day. Never retried: a second attempt could
    // act on a half-finished first; the run alerts instead. An account the settings leave off,
    // or with nothing uploaded for that session, is not logged in.
    schedule: { at: '16:55', on: tradingDays, label: 'trading days 16:55' },
    steps: [['/bin/sh', '-c', quantiplyBoth((b) => quantiplyDeploy(b, 'enable'))]],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 6,
    group: 'quantiply',
    fixHint:
      'Read the alert first: an algo it enabled must not be enabled again. Then: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker angelone --mode enable  (dry run; add --apply). Undo: --mode disable --day <session> --apply',
  },
  {
    id: 'quantiply-deploy-topup',
    description:
      "After the 09:19 top-up, enable on each Quantiply account today's recorded picks that are not enabled yet (a pick 09:16 changed) and switch off an enabled algo 09:16 dropped, if it has not started (BL-139 Phase 4). Never an algo within 90 s of its start (TOO LATE, reported). Same gates as quantiply-deploy",
    // 09:21: after quantiply-topup (same group). A 09:17 pick that changed is too late either way.
    // Caught up for 3 hours: later picks (12:02, 13:17) still have time; the 90 s rule protects
    // each one.
    schedule: { at: '09:21', on: tradingDays, label: 'trading days 09:21' },
    steps: [['/bin/sh', '-c', quantiplyBoth((b) => quantiplyDeploy(b, 'enable'))]],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 10,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 3,
    group: 'quantiply',
    fixHint:
      'Read the alert first: an algo it enabled must not be enabled again. Then: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker angelone --mode enable  (dry run; add --apply)',
  },
  {
    id: 'trade-monitor',
    description:
      "Watch the day's real trades, read-only (BL-143): 09:05-09:10 free margin per broker account vs the day's picks (MARGIN_CHECK=on); no login and no open session 09:10-09:25 (the deploy and top-up jobs log in then), nor on a platform while a job that logs in to it runs; 09:25 AlgoTest /live and Quantiply hold exactly the picks at 1 lot, per Settings › Automation row (a pick missing from a platform reads \"not in AlgoTest\" / \"not in Quantiply\"; when a pause is on the check says so instead of reporting expected gaps) (DEPLOY_CHECK=on); 09:25-15:30 the combined MTM every minute with a -₹5,000 warning and a -₹8,000 alert, once each (LOSS_ALERTS=on). Never clicks, changes or squares off anything. Does nothing until a switch is on",
    // ONE process for the three parts, so each platform is logged in to once a day: the Quantiply
    // JWT is never written to a file, so separate jobs would each need their own TOTP login.
    // Not in the 'quantiply' group (it would hold the 09:19 / 09:21 top-ups all day); every
    // platform login, here and in the uploaders and deployers, takes the cross-process login lock
    // (packages/broker-login/src/login-lock.ts), and the monitor makes none 09:10-09:25, nor after
    // while a job that logs in to that platform runs (it reads `GET /jobs` before every login: the
    // morning top-ups and deploys, the evening uploads, enable, disable; a due one until 10:00 /
    // 17:30). A
    // crash is retried, and a run cut off by a scheduler or laptop restart starts again until
    // 15:25 (`restartIfInterruptedUntil`); the day's state file under TRADING_DATA_ROOT/monitor/ stops a
    // check or a level being sent twice, and a lock file stops two monitors. Exit 3 = a refused or
    // held Quantiply login, or another monitor running: never retried.
    schedule: { at: '09:04', on: tradingDays, label: 'trading days 09:04' },
    // caffeinate -i: macOS does not idle-sleep while the monitor runs (a power assertion held only
    // by this process, gone when it exits; not a system setting). A closed lid on battery still sleeps.
    steps: [['/usr/bin/caffeinate', '-i', 'node_modules/.bin/tsx', 'src/trade-monitor.ts']],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 400, // 09:04 to 15:44
    retries: 2,
    noRetryExitCodes: [3],
    retryDelayMinutes: 2,
    catchUpHours: 6,
    restartIfInterruptedUntil: '15:25',
    alertsItself: true,
    fixHint:
      "After 09:25: cd packages/broker-login && node_modules/.bin/tsx src/trade-monitor.ts --parts deploy --now --print  (a read-only look, nothing sent; its login counts toward the day's cap)",
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
/** BL-140: one Quantiply upload per account, each told by the settings whether it has work. */
function quantiplyUploads(mode: 'evening' | 'topup'): string {
  return quantiplyBoth(
    (broker) =>
      `node_modules/.bin/tsx src/quantiply-upload.ts --broker ${broker} --from-settings --mode ${mode} --apply`,
  );
}

/** BL-139 Phase 4: one account's enable or disable run (it reads the settings itself). */
function quantiplyDeploy(broker: string, mode: 'enable' | 'disable'): string {
  return `node_modules/.bin/tsx src/quantiply-deploy.ts --broker ${broker} --mode ${mode} --apply`;
}

/** Run a command for both Quantiply accounts, Angel One then Shoonya. */
function quantiplyBoth(run: (broker: string) => string): string {
  // Both always run. The job's exit: 1 if either may succeed on a retry, else 3 (never retried:
  // a refused login or something the owner must look at) if either needs that, else 0.
  return `${run('angelone')}; a=$?; ${run('finvasia')}; b=$?; if [ "$a" -eq 1 ] || [ "$b" -eq 1 ]; then exit 1; elif [ "$a" -ne 0 ]; then exit "$a"; else exit "$b"; fi`;
}

export const JOBS: Job[] = [...BASE_JOBS, ...CHECK_JOBS];

export function findJob(id: string): Job | undefined {
  return JOBS.find((job) => job.id === id);
}

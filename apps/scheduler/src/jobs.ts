import { CHECK_JOBS } from './checks/index.js';
import {
  type DayRule,
  type Schedule,
  everyDay,
  firstWeekdayOfMonth,
  onWeekdays,
  tradingDays,
} from './schedule.js';

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
  const wait = job.group ? job.timeoutMinutes : 0;
  // BL-234: a chain's steps each have their own timeout, retries and delays
  if (job.chain) {
    return (
      job.chain.reduce((sum, step) => {
        const retries = step.retries ?? 0;
        const timeout = step.timeoutMinutes ?? job.timeoutMinutes;
        return sum + timeout * (retries + 1) + (step.retryDelayMinutes ?? 0) * retries;
      }, 0) + wait
    );
  }
  const attempts = job.retries + 1;
  return (
    job.timeoutMinutes * Math.max(1, job.steps.length) * attempts +
    job.retryDelayMinutes * job.retries +
    wait
  );
}

/**
 * One step of a chain (BL-234). A chain is a job whose steps start when the one before ends, not
 * at a clock time, and each carries what a whole job used to: its own timeout, retries, failure
 * policy, alert, log file and hold. A step's id is also its name in the run's step table and in
 * `jobs run <chain> --from <id>`.
 */
export interface ChainStep {
  id: string;
  /** argv, no shell. */
  argv: string[];
  /** Repo-relative; the chain's `cwd` when omitted. */
  cwd?: string;
  /** The chain's `timeoutMinutes` when omitted. */
  timeoutMinutes?: number;
  /** Extra attempts of this step alone, `retryDelayMinutes` apart. 0 when omitted. */
  retries?: number;
  retryDelayMinutes?: number;
  /** Exit codes that are never retried (a refused login, a conflict the owner must look at). */
  noRetryExitCodes?: number[];
  /**
   * What a failure of this step does to the steps after it: `stop` (the default) ends the chain,
   * `continue` runs on. A step that must not run without another says so in `requires`.
   */
  onFail?: 'stop' | 'continue';
  /**
   * Steps that must have succeeded (run, or done earlier in a run this one resumes). When one did
   * not, this step is skipped and the run says why. A step whose required step was held (stop
   * button, pause) is held too.
   */
  requires?: string[];
  /** `HH:MM` IST: the step waits until then, never starts earlier (e.g. the 16:00 message). */
  notBefore?: string;
  /**
   * `HH:MM` IST: a step the chain reaches after this is not run and is recorded `late`, which is
   * not a failure (a laptop that slept through the morning has no use for the 09:19 top-up).
   */
  notAfter?: string;
  /**
   * A `notAfter` skip is reported: the run counts it as a problem and its alert names the step (a morning
   * login or activation that never ran is something the owner must know, not a quiet skip).
   */
  alertLate?: boolean;
  /** The step's command sends its own Telegram on failure, so the scheduler does not repeat it. */
  alertsItself?: boolean;
  /** Repo-relative fixed log file for this step's output, instead of the chain's log. */
  logFile?: string;
  /**
   * The id the stop button's hold (`STOP_HELD_JOBS`) and the settings pause (`PAUSE_JOBS`) know this
   * step by: the id of the job it was before it joined the chain. Set on every step that uploads,
   * enables or deploys; without it the step is never held.
   */
  holdId?: string;
  /**
   * The group this step needs (see `Job.group`). A chain holds the groups of the steps that run, from
   * its start to its end, so give a group only to the steps that need it: an Apply now of one
   * platform's upload then does not wait for the catalog.
   */
  group?: JobGroup;
  /** The command to put in this step's failure alert. */
  fixHint: string;
}

/** Jobs that never run at the same time (see `Job.group`). */
export type JobGroup = 'catalog' | 'quantiply' | 'contract-notes';

/**
 * The groups a run of `job` holds: its own `group`, and (BL-234) those of the chain steps that run,
 * which is every step, or only the `only` ones of a run that picks some (the dashboard's Apply now).
 */
export function groupsOf(job: Job, only?: readonly string[]): JobGroup[] {
  const groups = new Set<JobGroup>();
  if (job.group) groups.add(job.group);
  for (const step of job.chain ?? [])
    if (step.group && (!only || only.includes(step.id))) groups.add(step.group);
  return [...groups].sort();
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
  /**
   * BL-234: a chain, instead of `steps`/`builtin` (leave `steps` empty). Its steps follow each
   * other without a clock time and fail, retry and alert one by one. A chain has no job-level
   * retries: `retries` stays 0, and a step retries on its own.
   */
  chain?: ChainStep[];
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
   * `contract-notes` = the contract-notes run (one job at four times since BL-234); the group keeps a hand run from overlapping the scheduler's, as both write the same store and bookmark.
   */
  group?: JobGroup;
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
const CONTRACT_NOTES = 'packages/contract-notes';
const CONTRACT_NOTES_FIX =
  'cd packages/contract-notes && node run.js --dry-run  (the log names the account, session and PDF; after a fix, node run.js --day <day>)';

const FRIDAY = onWeekdays(5);
const THURSDAY = onWeekdays(4);
/** Mondays that are trading days: nothing reads Kite on a Monday holiday. */
const TRADING_MONDAY: DayRule = (day) => tradingDays(day) && onWeekdays(1)(day);

/**
 * The Fyers login reminder (`mbt token-remind`): silent when Fyers accepts today's token, else one
 * Telegram message with a link to the hosted Broker logins page, so the owner logs in from a phone.
 * Fyers has no unattended login (its page has a human check; the refresh-token grant is off).
 */
function fyersReminder(
  id: string,
  at: string,
  when: 'morning' | 'evening',
  catchUpHours: number,
): Job {
  return {
    id,
    description:
      when === 'morning'
        ? 'Fyers: remind to log in (link to the hosted Broker logins page) for the day'
        : 'Fyers: remind again before the evening collection if still not logged in',
    schedule: { at, on: tradingDays, label: `trading days ${at}` },
    steps: [['uv', 'run', 'mbt', 'token-remind', '--send', '--when', when]],
    cwd: MOMENTUM,
    timeoutMinutes: 5,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours, // no group: it never opens the catalog, so nothing should queue it
    fixHint:
      'Dashboard › Broker logins › Fyers › Log in (or: cd packages/momentum-backtesting && uv run mbt login)',
  };
}

const BASE_JOBS: Job[] = [
  {
    // BL-234 Phase 4: the morning's four clock-chained jobs (the 08:00 Angel One check, the 08:02 broker
    // login, the 08:10 Quantiply switch-on and the 08:11 AlgoTest activation) as one chain: each step starts
    // when the one before ends. Owner, 2026-11-18: Quantiply is switched on FIRST, before AlgoTest's 08:16
    // broker window (about 08:06, not about 08:20), and the one Telegram message that used to go at 08:10
    // goes once, at the end, when both logins and the activation are known (2026-11-19).
    // REAL MONEY: every login and activation step has no retries (a second run would resend a refused PIN or
    // activate twice) and a step cut off mid-run is never repeated unasked (resume refuses; chain.ts). What a
    // failure skips: the Angel One check never stops anything; a failed Quantiply · Angel One login skips only
    // that account's switch-on (Shoonya's own switch-on does not depend on it; the 09:19 `morning-topup` chain
    // enables what is left); a failed AlgoTest login skips nothing (the old 08:11 job did not depend on the login:
    // the activation reads its own state and reports each broker not logged in). A step past its latest useful
    // time is not run and is NAMED in the alert (`alertLate`), never waited for; the logins keep the old
    // `broker-login` window (to 15:00), the switch-ons and the activation theirs (09:05, 12:40).
    // `options-rotation-pick` (08:45) and `morning-summary` (09:00) stay fixed-time jobs.
    // The `quantiply` group is taken at the first login step and let go after the last step that has it
    // (`algotest-activate`; the message step needs none), the span the old jobs held it.
    id: 'morning-open',
    description:
      "The morning, in order (BL-234 Phase 4): Angel One's SmartAPI check (the fallback data source), the Quantiply · Angel One login and Kite's (BL-172), Quantiply's switch-on of today's algos on each account, Angel One then Shoonya (BL-139 Phase 4: the clientwise MTM SL kept at the Settings figure, then today's algos from last evening's upload, REAL MONEY), AlgoTest's broker logins from 08:16 (Finvasia, Angel One; then Quantiply · Shoonya), last evening's list activated on AlgoTest's /live (BL-197 Phase 2, REAL MONEY: a list switched in after 16:40 is exported, uploaded and set up first), and one Telegram message with the logins and the Quantiply switch-on. What a failure skips: a failed Quantiply · Angel One login skips only that account's switch-on, a failed AlgoTest login nothing (the activation reports each broker not logged in); a step past its latest time is not run and the alert names it",
    schedule: { at: '08:00', on: tradingDays, label: 'trading days 08:00' },
    steps: [],
    chain: [
      {
        // ONE Angel One SmartAPI login (nothing fetched): is the evening run's fallback source ready? The same
        // guarded check as the Broker logins card's Test connection. It ends before the next step starts, and the
        // Quantiply login then takes its first Angel One code from the NEXT 30-second window (local-login.ts), so
        // the two never type a code from one window (they were two minutes apart for this before). No retry: the
        // old 5-minute retry only helped a network blip and would hold Quantiply's switch-on back.
        id: 'angel-check',
        argv: ['uv', 'run', 'obt', 'angel', 'test', '--scheduled'],
        cwd: OPTIONS,
        timeoutMinutes: 5,
        onFail: 'continue',
        notAfter: '09:10',
        alertLate: true,
        fixHint:
          'Check the ANGELONE_* settings in .env, then Broker logins › Angel One › Test connection (or: cd packages/option-backtesting && uv run obt angel test)',
      },
      {
        // Quantiply · Angel One, and Kite (every trading day with KITE_AUTO_LOGIN=on); `--part quantiply`. A part
        // that fails for a reason another machine could fix is handed to GitHub, never a refused PIN, and the
        // run's outcome goes into `<state>/broker-login/<day>.json` for the morning message and the 09:00 summary.
        id: 'quantiply-login',
        argv: ['node_modules/.bin/tsx', 'src/local-login.ts', '--part', 'quantiply'],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 15,
        onFail: 'continue',
        // the old `broker-login` window (7 h from its slot: Quantiply any time, Kite too). The switch-on
        // below stops at 09:05: after that the 09:19 top-up chain's enable is the way in
        notAfter: '15:00',
        alertLate: true,
        group: 'quantiply',
        alertsItself: true,
        fixHint:
          'Read the login report first (a refused PIN must not be sent again). Then start "Daily broker login" by hand from GitHub Actions, or: cd packages/broker-login && node_modules/.bin/tsx src/local-login.ts --part quantiply',
      },
      {
        // Quantiply · Angel One's account. The two accounts write their report to one file
        // (`morning-report.ts --path`); the last step sends it. Needs this account's login.
        id: 'quantiply-deploy',
        argv: [
          '/bin/sh',
          '-c',
          `F=$(node_modules/.bin/tsx src/morning-report.ts --path) && rm -f "$F" && export MORNING_REPORT_FILE="$F"; ${quantiplyDeploy('angelone', 'enable', true)}`,
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        // no retries: a second attempt could act on a half-finished first
        requires: ['quantiply-login'],
        onFail: 'continue',
        notAfter: '09:05',
        alertLate: true,
        holdId: 'quantiply-deploy',
        group: 'quantiply',
        fixHint:
          'Read the alert first: an algo it enabled must not be enabled again. Then: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker angelone --mode enable  (dry run; add --apply). Undo: --mode disable --day <session> --apply',
      },
      {
        // Quantiply · Shoonya's account. It logs in by itself and does NOT wait on the Angel One login (the old
        // 08:10 job needed none for either account), so one failed Angel One login leaves this one switched on.
        id: 'quantiply-deploy-shoonya',
        argv: [
          '/bin/sh',
          '-c',
          `F=$(node_modules/.bin/tsx src/morning-report.ts --path) && export MORNING_REPORT_FILE="$F"; ${quantiplyDeploy('finvasia', 'enable', true)}`,
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        // no retries: a second attempt could act on a half-finished first
        onFail: 'continue',
        notAfter: '09:05',
        alertLate: true,
        holdId: 'quantiply-deploy',
        group: 'quantiply',
        fixHint:
          'Read the alert first: an algo it enabled must not be enabled again. Then: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker finvasia --mode enable  (dry run; add --apply). Undo: --mode disable --day <session> --apply',
      },
      {
        // AlgoTest rejects broker logins before 08:16: the chain waits for it, so the login starts at 08:16.
        id: 'algotest-login',
        argv: ['node_modules/.bin/tsx', 'src/local-login.ts', '--part', 'algotest'],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 25,
        notBefore: '08:16',
        // the old `broker-login` window (7 h from its slot; AlgoTest refuses broker logins after 15:40). The
        // catch-up and the activation below stop at 12:40, the old `algotest-activate` window
        notAfter: '15:00',
        alertLate: true,
        onFail: 'continue',
        group: 'quantiply',
        alertsItself: true,
        fixHint:
          'Read the login report first (a refused PIN must not be sent again). Then start "Daily broker login" by hand from GitHub Actions, or: cd packages/broker-login && node_modules/.bin/tsx src/local-login.ts --part algotest',
      },
      {
        // 2026-11-05: a row switched after 16:40 to a list no row had then has no export or upload.
        // Catch it up first: export only the missing lists (exit 3 when none, which ends the shell at
        // once, so a normal morning adds no AlgoTest login), upload them (top-up never deletes) and
        // set them up. Never fails the step: the activation below reports any list still missing.
        id: 'algotest-catch-up',
        argv: [
          'bash',
          '-c',
          'uv run --directory ../option-backtesting obt rotation algotest-export --from-settings --preview --only-missing && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode topup --apply && node_modules/.bin/tsx src/strategy-deploy.ts --from-settings --setup --apply; exit 0',
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 25,
        onFail: 'continue',
        notAfter: '12:40',
        holdId: 'algotest-activate',
        group: 'quantiply',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation algotest-export --from-settings --preview --only-missing; then cd ../broker-login && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode topup --apply',
      },
      {
        // Never retried: a second attempt could activate what the first already did. Caught up until about
        // 12:40 (a pick whose entry has come is reported, never activated; the last entry, the 12:17
        // add-on, has come by then, so a later wake could only alert).
        id: 'algotest-activate',
        argv: [
          'node_modules/.bin/tsx',
          'src/strategy-deploy.ts',
          '--from-settings',
          '--morning',
          '--apply',
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 15,
        // No `requires: algotest-login`: the old 08:11 job did not depend on the login (it reads each broker's
        // state itself and reports the one not logged in), and the login part exits 1 when only one broker, or
        // only Quantiply · Shoonya, failed, which must not cost every AlgoTest account its day.
        onFail: 'continue',
        notAfter: '12:40',
        alertLate: true,
        holdId: 'algotest-activate',
        group: 'quantiply',
        fixHint:
          "First read each strategy's Deployed count on algotest.in/live (the alert says what it showed): one already deployed must not be activated again. Activate only the rest by hand (Activate, tick both brokers); then: cd packages/broker-login && node_modules/.bin/tsx src/strategy-deploy.ts --latest t1 --morning  (dry run)",
      },
      {
        // The one message: both logins (the status file), then each Quantiply account's switch-on report. When
        // the switch-on did not run it says so. The 09:00 summary stays a fixed-time job.
        id: 'morning-message',
        argv: ['node_modules/.bin/tsx', 'src/morning-report.ts', '--chain', '2'],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 5,
        onFail: 'continue',
        fixHint:
          'The message could not be sent: read the Quantiply accounts on app.quantiply.angelone.in and quantiply.shoonya.com, and the login line in the 09:00 summary',
      },
    ],
    cwd: BROKER_LOGIN,
    timeoutMinutes: 25, // also how long a step waits for another job's group
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 7, // the logins' old window; each step has its own notAfter
    restartIfInterruptedUntil: '12:40',
    fixHint:
      'Each failed step in the alert names its own fix. Read the alert first: a login sent or an algo switched on must not be sent or switched on again; run the rest with: bun run --filter @ata/scheduler jobs run morning-open --resume (or --from <step>)',
  },
  fyersReminder('fyers-login-reminder', '08:05', 'morning', 1), // after ~09:05 the pick is near
  {
    // BL-142: the 14:15 orders read the Kite holdings and free cash, and a Kite token dies at
    // 06:00. When Kite is the holdings source and today has no valid login, Telegram the owner
    // to log in, with a link to the hosted Broker logins page (a phone login works). Says nothing
    // when the login is fine or Kite is not used.
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
    // The same on a trading Monday, before the open: Kite's holdings, free cash and fills.
    id: 'kite-login-reminder-monday',
    description: 'Kite: remind to log in before the Monday open',
    schedule: { at: '08:45', on: TRADING_MONDAY, label: 'trading Mondays 08:45' },
    steps: [['uv', 'run', 'mbt', 'kite', 'remind', '--send', '--when', 'monday']],
    cwd: MOMENTUM,
    timeoutMinutes: 5,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 0.5,
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
    // Owner, 2026-11-05: with a signal delay of 1 the names are fixed by last Friday's ranks, so
    // Friday's orders can be shown the evening before. `mbt orders tentative` plans them exactly
    // as the 14:15 run will (lots included) and writes only tentative_orders.json in the state
    // dir: no orders row, no lot booking, no pending lot. One Telegram, headed tentative; This
    // week shows the plan until Friday's real orders exist. Kite logs in with the morning login (`morning-open`) every trading day,
    // so the holdings are usually as last read; the plan says so.
    id: 'momentum-orders-tentative',
    description: "Momentum: Friday's orders planned early (tentative), nothing saved",
    schedule: { at: '18:30', on: THURSDAY, label: 'Thu 18:30' },
    steps: [['uv', 'run', 'mbt', 'orders', 'tentative', '--send']],
    cwd: MOMENTUM,
    timeoutMinutes: 20,
    retries: 1,
    retryDelayMinutes: 10,
    catchUpHours: 12, // any time before Friday morning is still early
    group: 'catalog',
    // the CLI sends no alert on an uncaught failure: the scheduler's failure alert is the one
    alertsItself: false,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt orders tentative --send',
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
    // BL-024 Phases 2-3: last week's journalled signals scored against this week (the 19:30
    // run has just recorded the rows and prices it needs), each config re-run on today's code
    // for the comparison, and the Kite fills reconciled. Writes forward_scores.json only and
    // sends nothing: the headline's line rides in its 19:30 message.
    id: 'momentum-journal-score',
    description:
      'Score the forward journal against the week after each signal, and reconcile the Kite fills',
    schedule: { at: '20:30', on: FRIDAY, label: 'Fri 20:30' },
    steps: [['uv', 'run', 'mbt', 'journal', 'score']],
    cwd: MOMENTUM,
    // One engine pass per favourite on cached rankings: about the 19:30 run's own backtests.
    timeoutMinutes: 60,
    retries: 1,
    retryDelayMinutes: 15,
    catchUpHours: 48,
    group: 'catalog',
    fixHint: 'cd packages/momentum-backtesting && uv run mbt journal score',
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
    id: 'momentum-history',
    description:
      "Check that the stored market history up to a fixed anchor Friday has not changed (BL-001 Phase 4): names each price series, stock's bars or corporate action restated since the baseline",
    // After the 19:30 stock sync and the evening's other catalog jobs. Read-only on the
    // catalog (it writes only its baseline file in the Momentum state folder).
    schedule: { at: '22:00', on: FRIDAY, label: 'Fri 22:00' },
    steps: [['uv', 'run', 'mbt', 'verify', 'history', '--send']],
    cwd: MOMENTUM,
    timeoutMinutes: 15,
    retries: 1,
    retryDelayMinutes: 10,
    catchUpHours: 48,
    group: 'catalog',
    // A restated history is its own Telegram and exits 0 once Telegram took it; an undelivered
    // one exits 1 (retried, red on the Jobs page), and a check that cannot run sends its own
    // message and exits 1.
    alertsItself: true,
    fixHint: 'cd packages/momentum-backtesting && uv run mbt verify history --send',
  },
  {
    id: 'options-rotation-pick',
    description:
      "Record the day's rotation entry (lists A, B, C, REF) and the T1 parallel track's Adaptive entry from last evening's list, before 09:17 (BL-058). The evening list is the source of truth (owner, 2026-11-09): no 09:16 re-pick and no morning Telegram message; only a failure alerts the owner, privately",
    // Was the 09:16 pick on the 09:15 VIX open until 2026-11-09. It now ranks with the evening's
    // VIX (the previous close) and records last evening's saved list when the two differ, so it no
    // longer waits for the open. 08:45: after the `morning-open` activation, before the 09:04 monitor and
    // the 09:18 live board, both of which read the entry. Caught up until 09:15, so a missed run
    // still records before the first entry minute.
    schedule: { at: '08:45', on: tradingDays, label: 'trading days 08:45' },
    // One step: the live entry first, then the track's (it stores any missing T1 results itself
    // when that is why the track cannot be ranked). A retry finds the live entry recorded and only
    // completes the track.
    steps: [['uv', 'run', 'obt', 'rotation', 'pick', '--with-t1']],
    cwd: OPTIONS,
    timeoutMinutes: 10,
    retries: 2,
    retryDelayMinutes: 5,
    catchUpHours: 0.5,
    alertsItself: true,
    fixHint:
      "cd packages/option-backtesting && uv run obt rotation pick --with-t1  (records last evening's list; a run after 09:17 is flagged late)",
  },
  {
    id: 'rotation-live-board',
    description:
      "The Rotation page's Live board (BL-203): today's Adaptive picks, Classic and Tuned, run through the backtest engine on Angel One's 1-minute bars so far, every 5 minutes until 15:31 and whenever the card's Refresh button asks (`obt rotation live-board run`). One Angel One login for the day; nothing written to the lake, nothing sent, nothing traded",
    // After the 08:45 entry (the board reads last evening's list, else the entry). One process all session, so the
    // day takes one Angel One login: the session stays in memory and the login guard's lock is held
    // only while a refresh reads (angelone/check.py `held`), so the 15:45 collection, a connection
    // test or `obt angel funds` are never refused for long. A refresh Angel One throttles keeps the
    // last snapshot and is tried again at the next slot. Exit 3 = a refused login: never retried.
    // Not in the catalog group: it writes only TRADING_DATA_ROOT/rotation/live-board/*.json.
    schedule: { at: '09:18', on: tradingDays, label: 'trading days 09:18' },
    // caffeinate -i: macOS does not idle-sleep while the board runs (as the trade monitor)
    steps: [['/usr/bin/caffeinate', '-i', 'uv', 'run', 'obt', 'rotation', 'live-board', 'run']],
    cwd: OPTIONS,
    timeoutMinutes: 380, // 09:18 to 15:38
    retries: 2,
    noRetryExitCodes: [3],
    retryDelayMinutes: 2,
    catchUpHours: 6,
    restartIfInterruptedUntil: '15:25',
    fixHint:
      "cd packages/option-backtesting && uv run obt rotation live-board refresh  (one refresh now, the same as the card's Refresh button)",
  },
  {
    // BL-234 Phase 2: what used to be six jobs from 15:30 to 15:55, as one chain. Each step starts when
    // the one before it ends (a clock time only where one is real: every pick has exited at 15:28,
    // and the evening collector's Angel One login starts 15:45), and a failed step never stops the
    // next ones: `quantiply-disable` is the safety net (a Quantiply algo left enabled trades again on
    // its weekday) and must run whatever the capture did. In the quantiply group, so its logins never
    // overlap another Quantiply job's (the TOTP window stamp in quantiply-session.ts spaces them).
    id: 'close-out',
    description:
      "The close of the session, in order (BL-234): the Fyers login re-check, the 15:35 AlgoTest deploy check (a strategy with an execution day ticked would trade again on its own), the live capture (BL-141: every strategy that ran today, read from AlgoTest and Quantiply), the Quantiply switch-off (BL-139: the algos the tool made for today or earlier that are still enabled), Angel One's free margin at the close (BL-168), and the capture's retry. A step that fails does not stop the others; the failure alert names each step with its own fix",
    schedule: { at: '15:30', on: tradingDays, label: 'trading days 15:30' },
    steps: [],
    chain: [
      {
        id: 'fyers-login-recheck',
        argv: ['uv', 'run', 'mbt', 'token-remind', '--send', '--when', 'evening'],
        cwd: MOMENTUM,
        timeoutMinutes: 5,
        onFail: 'continue',
        // a reminder to log in before the 15:45 collection is of no use after it
        notAfter: '15:45',
        fixHint:
          'Dashboard › Broker logins › Fyers › Log in (or: cd packages/momentum-backtesting && uv run mbt login)',
      },
      {
        id: 'algotest-deploy-check',
        argv: ['node_modules/.bin/tsx', 'src/strategy-deploy.ts', '--from-settings', '--check'],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 5,
        retries: 1,
        retryDelayMinutes: 2,
        onFail: 'continue',
        // 15:35: every pick has exited. Never run late: it was not caught up before either.
        notBefore: '15:35',
        notAfter: '15:45',
        fixHint: 'Open algotest.in/live and untick the execution days of the T1 strategies',
      },
      {
        id: 'live-capture',
        argv: ['node_modules/.bin/tsx', 'src/live-capture.ts', '--soft-fail'],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 8,
        onFail: 'continue',
        // 15:40: every pick has exited (15:28). One attempt with a short timeout, so the switch-off
        // starts by 15:48 at the latest; --soft-fail leaves the alert to the retry step. The
        // evening uploads do not wait for it: both platforms keep a day's P&L after its strategies
        // are deleted (checked 2026-10-20), so a missed day is back-filled later.
        notBefore: '15:40',
        fixHint:
          'cd packages/broker-login && node_modules/.bin/tsx src/live-capture.ts  (reads what is missing; --day D for one day, --force to read it again, --dry-run prints only)',
      },
      {
        id: 'quantiply-disable',
        argv: ['/bin/sh', '-c', quantiplyBoth((b) => quantiplyDeploy(b, 'disable'))],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        retries: 2,
        // an algo still running, or a change not made by this run: the owner looks
        noRetryExitCodes: [3],
        retryDelayMinutes: 5,
        // Never gated (not by QUANTIPLY_DEPLOY, the deploy switch, the account's row, the stop hold
        // or a pause): switching off only lowers what trades, and whatever was enabled must not
        // repeat. An account with nothing of the tool's for today or earlier is not logged in.
        // Safe to retry. The 16:45 upload comes after (same group), so it can delete them.
        onFail: 'continue',
        fixHint:
          'In Quantiply, switch off every "Core · " / "T1 · " algo that is still enabled; then check with: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker angelone --mode check',
      },
      {
        id: 'contract-notes-capital',
        argv: ['uv', 'run', 'obt', 'realised', 'capital'],
        cwd: OPTIONS,
        timeoutMinutes: 10,
        retries: 1,
        retryDelayMinutes: 15,
        onFail: 'continue',
        // BL-168 Phase 4: the Trade book's capital line, one guarded SmartAPI login (it waits behind
        // the evening collector's, if any). Finvasia is not read: its only figure is AlgoTest's, and
        // an AlgoTest login now would collide with the live capture; its capital is typed on the page.
        notBefore: '15:50',
        fixHint:
          'Check the ANGELONE_* settings in .env, then run it by hand: cd packages/option-backtesting && uv run obt realised capital',
      },
      {
        id: 'live-capture-retry',
        argv: ['node_modules/.bin/tsx', 'src/live-capture.ts', '--no-backfill'],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 6,
        retries: 2, // 15:55, about 16:09, about 16:23: before the 16:45 upload
        // missing credentials, a Quantiply login held or refused
        noRetryExitCodes: [3],
        retryDelayMinutes: 8,
        // Reads only the sections the day's file does not have as read, so with everything read it
        // logs in nowhere and exits at once, and a catch-up after a sleep costs nothing.
        onFail: 'continue',
        notBefore: '15:55',
        fixHint:
          'cd packages/broker-login && node_modules/.bin/tsx src/live-capture.ts --day <day>  (the next evening back-fills it by itself; the 16:00 message said "live not captured")',
      },
    ],
    cwd: '.',
    timeoutMinutes: 10,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 6,
    group: 'quantiply',
    // A scheduler or laptop restart in the middle resumes the chain at the first step not done; a
    // step that was running is never repeated unasked (the alert says so).
    restartIfInterruptedUntil: '16:30',
    fixHint:
      'Each failed step in the alert names its own fix. Run the rest with: bun run --filter @ata/scheduler jobs run close-out --resume',
  },
  {
    id: 'trade-monitor',
    description:
      'Watch the day\'s real trades, read-only (BL-143): 09:05-09:10 free margin per broker account vs the day\'s picks (MARGIN_CHECK=on); no login and no open session 09:10-09:25 (the deploy and top-up jobs log in then), nor on a platform while a job that logs in to it runs; 09:25 AlgoTest /live and Quantiply hold exactly the picks at 1 lot, per Settings › Automation row (a pick missing from a platform reads "not in AlgoTest" / "not in Quantiply"; when a pause is on the check says so instead of reporting expected gaps) (DEPLOY_CHECK=on); 09:25-15:30 the combined MTM every minute with a -₹5,000 warning and a -₹8,000 alert, once each (LOSS_ALERTS=on). Never clicks, changes or squares off anything. Does nothing until a switch is on',
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
  {
    // BL-148 Phase 4: the nightly MCX option collection. One job, not one per season: MCX's close
    // is 23:30 or 23:55 IST and the switch dates follow no calendar rule (10 Mar / 3 Nov in 2025,
    // 18 Mar / 30 Oct in 2026), so the command waits for 23:31, looks at the nearest future's last
    // bar and waits on to 23:56 only if the session is still trading. Expiring contracts trade to
    // the close and cannot be fetched after they expire, so a run that fired early would lose
    // their last 25 minutes for good.
    id: 'mcx-collect',
    description:
      "Collect the MCX session's 1-minute option bars with open interest (`obt fyers mcx-daily`): every strike of each commodity's nearest two expiries from Fyers' /data/history, from each contract's last stored day, into the lake (BL-148). Waits for the MCX close (23:30 or 23:55, read from the data), replaces only the rows of the contracts it fetches, never touches an expired contract",
    // Weekdays, holidays included: MCX trades its evening session on most NSE holidays, and a
    // day it is shut gives "no session" (exit 0). The Fyers token from the morning login lasts
    // until 06:00, so a run that crosses midnight needs no new login.
    schedule: {
      at: '23:31',
      on: onWeekdays(1, 2, 3, 4, 5),
      label: 'weekdays 23:31 (after the MCX close)',
    },
    steps: [['uv', 'run', '--directory', OPTIONS, 'obt', 'fyers', 'mcx-daily']],
    cwd: '.',
    timeoutMinutes: 120, // per step: up to 25 min waiting for the close, then ~35 min of requests
    retries: 2,
    retryDelayMinutes: 15,
    // exit 2 = no Fyers token (or a refused one): a retry cannot help before a login
    noRetryExitCodes: [2],
    catchUpHours: 6, // until 05:30: the token dies at 06:00 and a later day's run starts from the last stored day
    group: 'catalog',
    fixHint:
      'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt fyers mcx-daily (before 06:00 it takes the evening just held; the next night completes any days missed)',
  },
  {
    // BL-219: the forward paper test of GOLDM Dir in the expiry week (BL-218's one pass). Read-only:
    // nothing here places an order. At 18:00 on a window weekday it reads Fyers' live quotes for
    // the future and the two entry contracts (bid, ask) and keeps them beside the journal; outside
    // a gold expiry window (the last five sessions before an option expiry from 2026-11-27) the
    // command prints that and exits 0.
    id: 'mcx-forward-spread',
    description:
      "Gold Dir forward test (BL-219): at 18:00 on an expiry-window weekday, the live bid/ask of the gold future and the two entry options (`obt mcx-forward spread`), kept to compare the real spread with the backtest's 1% slippage. Read-only; does nothing outside a window",
    schedule: { at: '18:00', on: onWeekdays(1, 2, 3, 4, 5), label: 'weekdays 18:00' },
    steps: [['uv', 'run', '--directory', OPTIONS, 'obt', 'mcx-forward', 'spread']],
    cwd: '.',
    timeoutMinutes: 5,
    retries: 1,
    retryDelayMinutes: 2, // a retry past ~18:05 would read quotes after the entry minute
    noRetryExitCodes: [2],
    catchUpHours: 0.1,
    fixHint:
      'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt mcx-forward spread (only meaningful at about 18:00 on a gold expiry-window weekday)',
  },
  {
    // BL-219: after the nightly collector. Scores the session just closed (and any window session
    // missed earlier whose bars are collected) into the hash-chained paper journal, one private
    // Telegram line each. The session is the evening just held (default_session): at 01:30 that
    // is yesterday's. Group `catalog`: it queues behind the 23:31 collector and the 21:00 T1 job.
    id: 'mcx-forward-score',
    description:
      "Gold Dir forward test (BL-219): score the MCX session just closed (`obt mcx-forward score`): extend the gold contract calendar from the live master, fetch the settling future's day, simulate the frozen BL-218 rule on the collected option bars, append the session to the paper journal and send one private Telegram line. Nothing is ever ordered. Does nothing outside a gold expiry window",
    schedule: {
      at: '01:30',
      on: onWeekdays(2, 3, 4, 5, 6),
      label: 'Tue-Sat 01:30 (the evening before)',
    },
    steps: [['uv', 'run', '--directory', OPTIONS, 'obt', 'mcx-forward', 'score']],
    cwd: '.',
    timeoutMinutes: 20,
    retries: 2,
    retryDelayMinutes: 30,
    noRetryExitCodes: [2], // no Fyers token: a retry cannot log in
    catchUpHours: 4, // until 05:30, while the morning's Fyers token still holds
    group: 'catalog',
    fixHint:
      'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt mcx-forward score (before 06:00 it takes the evening just held; a later night completes any session missed while its bars are still collectable)',
  },
  {
    id: 'contract-notes',
    description:
      "Read the brokers' contract notes (BL-168): each account's new mail since its bookmark, the PDF kept and its figures stored under TRADING_DATA_ROOT/contract-notes/ (F&O for Finvasia and Angel One, equity for the Momentum account on Zerodha); sessions that can have no note are closed (no trade / no note). Never writes the Google Sheet (trade-analytics keeps it)",
    // Every day, not trading days: a session's notes arrive its evening (Angel One's after
    // midnight), so Saturday's run takes Friday.
    // BL-234: one job, four times. It was the 00:00 run plus three jobs for the same command at
    // 07:30, 10:30 and 15:30. Angel One mails a session's note the next morning, and about one
    // in four came after 07:30 (up to 17:10), which left the Trade book a day short until
    // midnight; the owner added 10:30 and 15:30 (2026-10-28). Each run reads only mail newer than
    // the bookmark, so with nothing new it is a few seconds. Before 16:00 a run never looks for
    // that day's own note (`lastSession` in packages/contract-notes/calendar.js); a 15:30 attempt
    // retried after 16:00 lists today as waiting, as the 00:00 run does, and closes nothing
    // wrongly. The longest gap between slots is 8.5 h (15:30 to 00:00), inside `catchUpHours`, so
    // a laptop that slept through one slot runs the latest once and sends no "missed" alert while
    // that run did the same work. `group` stays: a hand run (`jobs run`) never overlaps the
    // scheduler's.
    schedule: {
      at: ['00:00', '07:30', '10:30', '15:30'],
      on: everyDay,
      label: 'every day 00:00, 07:30, 10:30, 15:30',
    },
    steps: [['node', 'run.js']],
    cwd: CONTRACT_NOTES,
    timeoutMinutes: 15,
    retries: 1,
    retryDelayMinutes: 20,
    catchUpHours: 24,
    group: 'contract-notes',
    fixHint: CONTRACT_NOTES_FIX,
  },
  {
    // BL-234 Phase 3: the evening as one chain (it was five jobs: `options-evening` 15:45,
    // `options-rotation-result` 16:00, `algotest-evening` 16:40, `quantiply-evening` 16:45 and the
    // 21:00 `options-rotation-t1-update`). Each step starts when the one before ends, so the uploads
    // no longer wait for a clock time or retry until the results are in: they cannot start before.
    // A step that fails ends the chain only where the next steps need it (the data steps); the
    // message, each platform's upload and the T1 recheck go on whatever the one before did, and the
    // alert names each step with its own fix. Both platforms' uploads must be in by next morning
    // (the `morning-open` logins and activation), which is the real deadline.
    // The groups: the data steps write the catalog (`catalog`); the Quantiply steps log in to
    // Quantiply (`quantiply`), so they start after the close-out's switch-off, which is listed
    // before this chain. The AlgoTest steps have none. A run holds the groups of the steps that run
    // (an Apply now of one platform holds only that platform's).
    id: 'evening',
    description:
      "The evening, in order (BL-234): collect the day's 1-minute option data and run every leg-wise strategy (`obt daily`), store the rotation results (BL-058), rebuild the derived tables, store the T1 track's results (a T1 problem alerts itself and never stops the rest); at 16:00 or when the data is in, send the day's rotation result (BL-125); then put tomorrow's expected picks into AlgoTest (BL-137: export, replace, set up execution; never deploys) and into Quantiply (BL-139: export, create, delete the finished algos; never enables), each only once its switch (`ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD`) is on; last, the T1 catch-up: store a T1 day that is still missing and send its part of the result. A step that fails does not stop the ones that do not need it; the failure alert names each step with its own fix",
    schedule: { at: '15:45', on: tradingDays, label: 'trading days 15:45' },
    steps: [],
    chain: [
      {
        id: 'collect',
        argv: ['uv', 'run', '--directory', OPTIONS, 'obt', 'daily'],
        cwd: '.',
        // Contracts that expire today cannot be downloaded tomorrow, so keep trying through the
        // evening (15:45, 17:15, 18:45, 20:15): usually it is waiting on a Fyers login.
        timeoutMinutes: 90,
        retries: 3,
        retryDelayMinutes: 90,
        group: 'catalog',
        fixHint:
          'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt daily && uv run --directory packages/option-backtesting obt rotation update && uv run --directory packages/option-backtesting obt rotation update --track t1',
      },
      {
        id: 'rotation-update',
        argv: ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'update'],
        cwd: '.',
        timeoutMinutes: 90,
        retries: 3,
        retryDelayMinutes: 90,
        group: 'catalog',
        fixHint:
          'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt daily && uv run --directory packages/option-backtesting obt rotation update && uv run --directory packages/option-backtesting obt rotation update --track t1',
      },
      {
        id: 'derived-rebuild',
        argv: ['uv', 'run', '--directory', TRADING_DATA, 'tdata', 'derived', 'rebuild'],
        cwd: '.',
        timeoutMinutes: 90,
        retries: 3,
        retryDelayMinutes: 90,
        group: 'catalog',
        fixHint:
          'Log in to Fyers, then run: uv run --directory packages/option-backtesting obt daily && uv run --directory packages/option-backtesting obt rotation update && uv run --directory packages/option-backtesting obt rotation update --track t1',
      },
      {
        id: 't1-update',
        // --soft-fail: a problem Telegrams its own alert and exits 0, so it never stops the chain.
        // It takes seconds; if it fails, the message says T1 is not ready and `t1-catch-up` below
        // is the net. The live update runs before it: the track ranks over the same days.
        argv: [
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
        cwd: '.',
        timeoutMinutes: 90,
        group: 'catalog',
        fixHint:
          'uv run --directory packages/option-backtesting obt rotation update --track t1  (add --backfill to fill every missing day), then obt rotation result',
      },
      {
        id: 'result',
        // The 16:00 message (BL-125): Adaptive's and the T1 track's one-lot net paper gain and
        // tomorrow's strategies in full. Never before 16:00. An attempt that finds Adaptive (or,
        // before 16:25, T1) incomplete exits 2 and is retried every 5 minutes to about 16:35; the
        // message goes at 16:25 at the latest, the T1 part later if it was missing. Sent markers make
        // every retry safe (no double send). A failure does not stop the uploads.
        argv: [
          'uv',
          'run',
          '--directory',
          OPTIONS,
          'obt',
          'rotation',
          'result',
          '--wait-until',
          '16:25',
        ],
        cwd: '.',
        timeoutMinutes: 10,
        retries: 7,
        retryDelayMinutes: 5,
        onFail: 'continue',
        notBefore: '16:00',
        fixHint:
          'If the evening run only finished on a later retry, its last step sends the result itself; otherwise: uv run --directory packages/option-backtesting obt rotation result  (the evening run must have stored the results first; add --force to resend)',
      },
      // AlgoTest (BL-137, BL-197). The export exits 2 while the day's results are incomplete; here
      // they are complete by construction. Exit 3 (a conflict, a read-back that differs, a delete
      // only the owner can sort out, or a STOP) is never retried. Held by the stop button and a
      // pause under the old job's id.
      {
        id: 'algotest-export',
        argv: [
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
        cwd: BROKER_LOGIN,
        timeoutMinutes: 15,
        retries: 4,
        noRetryExitCodes: [3],
        retryDelayMinutes: 60,
        onFail: 'continue',
        group: 'quantiply',
        holdId: 'algotest-evening',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation algotest-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode evening (add --apply once the plan looks right); then node_modules/.bin/tsx src/strategy-deploy.ts --latest t1 --setup (add --apply likewise)',
      },
      {
        id: 'algotest-upload',
        // It deletes the strategies it uploaded for an earlier session, kept or dropped
        // (--allow-delete, owner 2026-10-20; kept ones too since 2026-11-18): AlgoTest's own API
        // call by each strategy's id, never one deployed on /live or one it did not upload, and it
        // stops at once if any other strategy vanishes with a delete.
        argv: [
          'node_modules/.bin/tsx',
          'src/strategy-upload.ts',
          '--from-settings',
          '--mode',
          'evening',
          '--apply',
          '--allow-delete',
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 15,
        retries: 4,
        noRetryExitCodes: [3],
        retryDelayMinutes: 60,
        requires: ['algotest-export'],
        onFail: 'continue',
        group: 'quantiply',
        holdId: 'algotest-evening',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation algotest-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode evening (add --apply once the plan looks right); then node_modules/.bin/tsx src/strategy-deploy.ts --latest t1 --setup (add --apply likewise)',
      },
      {
        id: 'algotest-setup',
        // BL-197: Setup Execution for every list's picks just uploaded (re-saving a set-up sheet is
        // safe), so the `morning-open` chain's `algotest-activate` only has to activate: this list is what trades tomorrow.
        argv: [
          'node_modules/.bin/tsx',
          'src/strategy-deploy.ts',
          '--from-settings',
          '--setup',
          '--apply',
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 15,
        retries: 4,
        noRetryExitCodes: [3],
        retryDelayMinutes: 60,
        requires: ['algotest-upload'],
        onFail: 'continue',
        group: 'quantiply',
        holdId: 'algotest-evening',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation algotest-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/strategy-upload.ts --from-settings --mode evening (add --apply once the plan looks right); then node_modules/.bin/tsx src/strategy-deploy.ts --latest t1 --setup (add --apply likewise)',
      },
      // Quantiply (BL-139). Same exit-3 rule: a refused login or a conflict, retrying only repeats it.
      {
        id: 'quantiply-export',
        argv: [
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
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        retries: 4,
        noRetryExitCodes: [3],
        retryDelayMinutes: 60,
        onFail: 'continue',
        group: 'quantiply',
        holdId: 'quantiply-evening',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation quantiply-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/quantiply-upload.ts --broker angelone|finvasia --from-settings --mode evening (add --apply once the plan looks right)',
      },
      {
        id: 'quantiply-upload',
        // Both accounts always run; the step fails if either did.
        argv: ['/bin/sh', '-c', quantiplyUploads('evening')],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        retries: 4,
        noRetryExitCodes: [3],
        retryDelayMinutes: 60,
        requires: ['quantiply-export'],
        onFail: 'continue',
        group: 'quantiply',
        holdId: 'quantiply-evening',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation quantiply-export --from-settings --next; then cd ../broker-login && node_modules/.bin/tsx src/quantiply-upload.ts --broker angelone|finvasia --from-settings --mode evening (add --apply once the plan looks right)',
      },
      // The T1 catch-up, last: stores any day the track lacks (strict, so a failure is reported and
      // retried), then sends the T1 part of the result if it was not ready at 16:00 (a no-op once
      // everything has been sent). It is the net under `t1-update`; it never delays an upload.
      {
        id: 't1-catch-up',
        argv: ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'update', '--track', 't1'],
        cwd: '.',
        timeoutMinutes: 20,
        retries: 2,
        retryDelayMinutes: 60,
        onFail: 'continue',
        group: 'catalog',
        fixHint:
          'uv run --directory packages/option-backtesting obt rotation update --track t1  (add --backfill to fill every missing day), then obt rotation result',
      },
      {
        id: 't1-result',
        argv: ['uv', 'run', '--directory', OPTIONS, 'obt', 'rotation', 'result'],
        cwd: '.',
        timeoutMinutes: 20,
        onFail: 'continue',
        fixHint:
          'If the evening run only finished on a later retry, its last step sends the result itself; otherwise: uv run --directory packages/option-backtesting obt rotation result  (the evening run must have stored the results first; add --force to resend)',
      },
    ],
    cwd: '.',
    timeoutMinutes: 20,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 7.25, // until 23:00
    // A restart in the middle resumes at the first step not done; a step that was running is never
    // repeated unasked (the alert says so).
    restartIfInterruptedUntil: '23:00',
    fixHint:
      'Each failed step in the alert names its own fix. Run the rest with: bun run --filter @ata/scheduler jobs run evening --resume',
  },
  {
    // BL-234 Phase 2: the 09:19 top-up and the 09:21 enable, as one chain. 09:19 was a minute after
    // the 09:16 pick (retired 2026-11-09; the entry is recorded at 08:45 from the evening's list); a
    // changed 09:17 pick is too late either way, so the top-up steps are not run after 09:49. The
    // enable is the `morning-open` switch-on's net and ran for 3 hours after a missed slot (later picks,
    // 12:02 and 13:17, still have time; the 90 s rule protects each one), so the chain is caught up
    // for 3 hours and only the top-up steps drop out when late. A failed top-up does not stop the
    // enable, as before. Each step is held by the stop button and a pause under its old job's id.
    id: 'morning-topup',
    description:
      "Create on each Quantiply account any pick of today's entry that last night's upload does not have (BL-139), under the owner's 09:17 rule (BL-172); deletes nothing and names the algos that are not in the day's entry. Then enable on each account today's recorded picks that are not enabled yet (the morning switch-on's net) and switch off an enabled algo the day's entry does not have, if it has not started (BL-139 Phase 4). Never an algo within 90 s of its start (TOO LATE, reported)",
    schedule: { at: '09:19', on: tradingDays, label: 'trading days 09:19' },
    steps: [],
    chain: [
      {
        id: 'quantiply-export',
        argv: [
          'uv',
          'run',
          '--directory',
          '../option-backtesting',
          'obt',
          'rotation',
          'quantiply-export',
          '--from-settings',
          '--morning-rule',
        ],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        retries: 1,
        retryDelayMinutes: 2,
        onFail: 'continue',
        notAfter: '09:49',
        holdId: 'quantiply-topup',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation quantiply-export --from-settings; then cd ../broker-login && node_modules/.bin/tsx src/quantiply-upload.ts --broker angelone|finvasia --from-settings --mode topup --apply',
      },
      {
        id: 'quantiply-topup',
        argv: ['/bin/sh', '-c', quantiplyUploads('topup')],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        retries: 1,
        // a refused login or a conflict: retrying only repeats it
        noRetryExitCodes: [3],
        retryDelayMinutes: 2,
        requires: ['quantiply-export'],
        onFail: 'continue',
        notAfter: '09:49',
        holdId: 'quantiply-topup',
        fixHint:
          'cd packages/option-backtesting && uv run obt rotation quantiply-export --from-settings; then cd ../broker-login && node_modules/.bin/tsx src/quantiply-upload.ts --broker angelone|finvasia --from-settings --mode topup --apply',
      },
      {
        id: 'quantiply-deploy-topup',
        argv: ['/bin/sh', '-c', quantiplyBoth((b) => quantiplyDeploy(b, 'enable'))],
        cwd: BROKER_LOGIN,
        timeoutMinutes: 10,
        // no retries: a second attempt could act on a half-finished first
        onFail: 'continue',
        holdId: 'quantiply-deploy-topup',
        fixHint:
          'Read the alert first: an algo it enabled must not be enabled again. Then: cd packages/broker-login && node_modules/.bin/tsx src/quantiply-deploy.ts --broker angelone --mode enable  (dry run; add --apply)',
      },
    ],
    cwd: '.',
    timeoutMinutes: 10,
    retries: 0,
    retryDelayMinutes: 0,
    catchUpHours: 3,
    group: 'quantiply',
    restartIfInterruptedUntil: '10:00',
    fixHint:
      'Each failed step in the alert names its own fix. Read the alert first: an algo the enable step switched on must not be enabled again; run the rest with: bun run --filter @ata/scheduler jobs run morning-topup --resume',
  },
];

/** Every job: the ones above plus each check group's (src/checks/). */
/** BL-140: one Quantiply upload per account, each told by the settings whether it has work. */
function quantiplyUploads(mode: 'evening' | 'topup'): string {
  // BL-172 (owner, 2026-10-28): the evening deletes every finished, switched-off algo on the
  // account, the owner's own too (`--delete-all`); never an enabled or running one. And it sets
  // Shoonya's paid subscription to the next session's algo count (`--subscription`; Angel One's
  // Quantiply is free, so the flag does nothing there).
  const all = mode === 'evening' ? ' --delete-all --subscription' : '';
  const both = quantiplyBoth(
    (broker) =>
      `node_modules/.bin/tsx src/quantiply-upload.ts --broker ${broker} --from-settings --mode ${mode}${all} --apply`,
  );
  if (mode !== 'evening') return both;
  // BL-173: the evening's reports (failures, credits spent, a list unlike the 16:00 one) as one
  // message for both accounts, none when neither has anything to say; the exit stays theirs.
  return `F=$(mktemp -t quantiply-evening) && export REPORT_FILE="$F"; (${both}); code=$?; node_modules/.bin/tsx src/morning-report.ts "$F" --evening; exit $code`;
}

/** BL-139 Phase 4: one account's enable or disable run (it reads the settings itself). */
function quantiplyDeploy(broker: string, mode: 'enable' | 'disable', morning = false): string {
  return `node_modules/.bin/tsx src/quantiply-deploy.ts --broker ${broker} --mode ${mode}${morning ? ' --morning' : ''} --apply`;
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

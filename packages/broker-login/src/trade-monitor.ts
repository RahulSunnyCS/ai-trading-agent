import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Underlying, isTradingDay, lotSize } from '@trading/market-reference';
import { sendText } from '@trading/notify';
import { type Browser, type Page, chromium } from 'playwright';
import { BASE_URL, algotestLogin } from './algotest.js';
import {
  type Automation,
  type Book,
  type Broker,
  effectiveRow,
  pausedFor,
  readAutomation,
} from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { istMinutes, parseLive } from './deploy-plan.js';
import { describe } from './diagnose.js';
import {
  LockBusy,
  lastLoginAt,
  lockDir,
  pidAlive,
  tryLock,
  unlock,
  withLoginLock,
} from './login-lock.js';
import {
  ALGOTEST_BROKER_ID,
  type AccountMargin,
  type AlgoTestRowPicks,
  DEPLOY_CHECK_AT,
  LOGIN_CAP,
  LONG_WAIT_MS,
  type LegNeed,
  type LoginLog,
  MARGIN_AT,
  type MtmNoticeState,
  type MtmPart,
  PLATFORM_JOBS,
  type PlatformCheck,
  type PnlSeen,
  type QListed,
  QUIET_FROM,
  SESSION_CLOSE,
  type SchedulerJobView,
  WAIT_WINDOWS,
  type WaitItem,
  type WaitWindow,
  algotestInstant,
  checkAlgoTest,
  checkQuantiply,
  commitMtmNotice,
  deployMessage,
  inLossWindow,
  inQuietWindow,
  inr,
  isReplacing,
  istClock,
  istDayOf,
  jobsStillToEnd,
  jobsWait,
  legLots,
  legsFromAlgtst,
  legsFromQuantiply,
  loginRefusal,
  lossCrossings,
  lossMessage,
  marginMessage,
  mergeLogins,
  mtmNotice,
  mtmNoticeText,
  parseAlgotestBrokers,
  parseDayWiseListed,
  parseDeployedOn,
  parseMarginCsv,
  pauseNote,
  pickNeed,
  pnlFromSocketFrame,
  quantiplyReading,
  readMtmCardsInPage,
  readTotalMtm,
  switchOn,
  waitKey,
} from './monitor-plan.js';
import type { QuantiplyApi } from './quantiply-api.js';
import { istWeekday } from './quantiply-plan.js';
import { QUANTIPLY_SITES, type QuantiplyBroker } from './quantiply-rules.js';
import {
  LoginHeld,
  LoginRefused,
  checkLoginHold,
  lastTotpLoginAt,
  openQuantiplyApp,
  quantiplyCredentials,
  quantiplyLedgerPath,
} from './quantiply-session.js';
import { redact, registerSecret } from './secrets.js';
import { livePage } from './selectors.js';
import { otherStopRunning } from './stop-hold.js';
import { ALGOTEST_API, csrfToken } from './strategy-delete.js';
import { istToday } from './strategy-plan.js';

/**
 * BL-143 Phases 2-3: one process per trading day (the scheduler's `trade-monitor`, 09:04):
 *
 *   09:05-09:10  margin check   (MARGIN_CHECK=on)   free margin per broker account vs the day's picks
 *   09:10-09:25  nothing: no login, no open session (the 09:16-09:21 deploy and top-up jobs log in)
 *   09:25        deploy check   (DEPLOY_CHECK=on)   AlgoTest /live and Quantiply hold exactly the picks
 *   09:25-15:30  loss alerts    (LOSS_ALERTS=on)    combined MTM every minute; -₹5,000 / -₹8,000 once each
 *
 * READ-ONLY: it opens pages and makes GET calls; it never clicks a button on a platform, never
 * sends a PUT/POST/DELETE to one, and never squares anything off. Its writes: Telegram messages
 * and `TRADING_DATA_ROOT/monitor/<day>.json` (what was sent, the logins used, Quantiply's last
 * MTM per algo), so a retry or a restart never sends a level or a check twice. A message is
 * marked sent only when Telegram took it (or its type is muted); a failed send goes again on the
 * next tick.
 *
 * Logins (each the same login the jobs already make), under the platform's cross-process login
 * lock (`login-lock.ts`): AlgoTest's website login, Quantiply's per account whose Settings ›
 * Automation row uploads a list (`quantiply-session.ts`: the refused-login hold, the TOTP window
 * claimed before the code is typed), Angel One SmartAPI once (`obt angel funds`, its own guard).
 * Each platform: a daily cap of codes typed, no new login for 10 min after a failed one, none
 * within 10 min of losing a session (logged out / 401: someone else's login most likely ended it),
 * a replacement only when no other process logged in to the platform in the last 10 min and at
 * most every 30 min, said once as "degraded". No login while PR #275's stop button runs
 * (`stop-running.json`, `stop-hold.ts`'s `otherStopRunning`). Before every login, at any hour, the scheduler's
 * `GET /jobs`: a run in progress of a job that logs in to the platform (`PLATFORM_JOBS`, morning
 * and evening) always blocks; a due or imminent one, or an API that does not answer, blocks until
 * its window's cap (10:00 / 17:30), then it logs in anyway and says so. Shoonya's own API: never.
 *
 *   tsx src/trade-monitor.ts [--parts margin,deploy,loss] [--now] [--print] [--headed]
 *
 * `--now` runs the asked parts at once (one loss reading, then exit; still no login or open
 * session 09:10-09:25, checked at each login and each use); `--print` prints the messages instead
 * of sending them and keeps no once-only flags, but its logins count toward the day's caps (merged
 * into the state file, never overwriting a running monitor's). Without `--print` a part also needs
 * its switch.
 */

const VIEWPORT = { width: 1440, height: 900 };
/** AlgoTest's /live is reloaded at most this often (its MTM is computed in the page). */
const RELOAD_EVERY_MS = 3 * 60_000;
/** Quantiply's list is re-read this often (which algos trade today; the MTM comes by socket). */
const LIST_EVERY_MS = 2 * 60_000;
const TICK_MS = 15_000;
/** `obt angel funds` must answer before the quiet window. */
const FUNDS_TIMEOUT_MS = 150_000;

/** 3: a refused or held login, or another monitor running: never retried by the scheduler. */
const EXIT_NO_RETRY = 3;

type Part = 'margin' | 'deploy' | 'loss';
/** What the monitor counts its logins (codes typed) against. */
type LoginPlatform = 'algotest' | 'quantiply-angelone' | 'quantiply-finvasia';
const SWITCH: Record<Part, string> = {
  margin: 'MARGIN_CHECK',
  deploy: 'DEPLOY_CHECK',
  loss: 'LOSS_ALERTS',
};
const ACCOUNT_NAME: Record<Broker, string> = { finvasia: 'Finvasia', angelone: 'Angel One' };
const BOOK_NAME: Record<Book, string> = { core: 'Core', t1: 'T1' };

interface DayState {
  /** `skipped`: the monitor started after 09:10, said once */
  margin?: { at: string; ok: boolean; skipped?: boolean };
  deploy?: { at: string; ok: boolean };
  loss: MtmNoticeState & {
    warned: boolean;
    alerted: boolean;
    /** said once: this platform's session ended and monitoring is degraded */
    degraded: Record<string, boolean>;
  };
  /** Quantiply algo id -> its last MTM figure and when it arrived, kept across restarts */
  qpnl: Record<string, PnlSeen>;
  logins: Partial<Record<LoginPlatform, LoginLog>>;
  /** said once: a platform's deploy jobs were still running at 10:00 and it logged in anyway */
  jobsWaitCapped?: Record<string, boolean>;
  /** said once: the monitor waited over 30 minutes on this job */
  longWaitSaid?: Record<string, boolean>;
}

const fresh = (): DayState => ({
  loss: {
    warned: false,
    alerted: false,
    unreadable: {},
    readableRun: {},
    unreadableSaid: {},
    degraded: {},
  },
  qpnl: {},
  logins: {},
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const istSecondsNow = () => {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
};

/** No login now, and why (said in the log). */
class LoginNotAllowed extends Error {}
/** A login waits for the morning's deploy jobs to end: said in the log only, not a reading failure. */
class LoginWaiting extends LoginNotAllowed {}
/** The platform ended the session: the next use logs in again, within the limits. */
class SessionLost extends Error {}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: timeoutMs, env: process.env },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: `${stdout ?? ''}` });
      },
    );
  });
}

class Monitor {
  private state: DayState = fresh();
  private algotest: { browser: Browser; page: Page; reloadedAt: number } | null = null;
  private readonly quantiply = new Map<
    QuantiplyBroker,
    { api: QuantiplyApi; browser: Browser; list: QListed[]; listedAt: number }
  >();
  /** a platform whose session was lost: its next login is a replacement */
  private readonly lost = new Set<LoginPlatform>();
  /** what a platform's last check found still running (this process waited for it) */
  private readonly jobsWaitedFor = new Map<'algotest' | 'quantiply', string>();
  /** per platform: since when each wait item has been seen (ms, by `waitKey`) */
  private readonly waitFirstSeen: Partial<
    Record<'algotest' | 'quantiply', Record<string, number>>
  > = {};
  private refused = false;

  constructor(
    private readonly day: string,
    private readonly root: string,
    private readonly automation: Automation,
    private readonly opts: { print: boolean; headed: boolean },
  ) {}

  private get statePath(): string {
    return join(this.root, 'monitor', `${this.day}.json`);
  }

  async load(): Promise<void> {
    try {
      const disk = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<DayState>;
      const base = fresh();
      this.state = {
        ...base,
        ...disk,
        loss: { ...base.loss, ...(disk.loss ?? {}) },
        logins: disk.logins ?? {},
      };
    } catch {
      this.state = fresh();
    }
  }

  private async disk(): Promise<DayState | null> {
    try {
      return { ...fresh(), ...JSON.parse(await readFile(this.statePath, 'utf8')) } as DayState;
    } catch {
      return null; // nothing on disk yet
    }
  }

  /**
   * Writes the state. The logins are merged with the file's (the higher count, the later times):
   * a `--print` run beside the scheduled monitor counts toward the caps, and neither overwrites the
   * other's logins. A `--print` run writes only the logins.
   */
  private async save(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const disk = await this.disk();
    this.state.logins = mergeLogins(disk?.logins, this.state.logins);
    let out: DayState = this.state;
    if (this.opts.print) out = { ...(disk ?? fresh()), logins: this.state.logins };
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(out, null, 1)}\n`);
    await rename(tmp, this.statePath);
  }

  /** True when the message is delivered (or its type muted): only then is it marked sent. */
  async send(text: string, type?: string): Promise<boolean> {
    const safe = redact(text);
    if (this.opts.print) {
      console.log(`\n--- message (${type ?? 'always sent'}; --print: not sent) ---\n${safe}\n`);
      return true;
    }
    console.log(safe);
    const outcome = await sendText(readTelegramConfig(), safe, type).catch(() => 'failed' as const);
    if (outcome === 'failed') console.error('  Telegram did not take it: tried again next tick');
    return outcome !== 'failed';
  }

  /** The lists each platform row uploads today (BL-140): only those rows have exports. */
  rowBooks(platform: 'algotest' | 'quantiply'): Array<{ broker: Broker; book: Book }> {
    const out: Array<{ broker: Broker; book: Book }> = [];
    for (const broker of ['finvasia', 'angelone'] as Broker[]) {
      const row = effectiveRow(this.automation, platform, broker);
      if (row.upload && row.list !== 'none') out.push({ broker, book: row.list });
    }
    return out;
  }

  // --- reading the exports ------------------------------------------------------------------

  async picks(platform: 'algotest' | 'quantiply', book: Book) {
    const pointer = join(this.root, 'rotation', platform, `latest-${book}.json`);
    const dir = (JSON.parse(await readFile(pointer, 'utf8')) as { dir: string }).dir;
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      day: string;
      source: string;
      strategies: { name: string; file: string }[];
    };
    const picks: { name: string; legs: LegNeed[]; lots: number[] }[] = [];
    for (const s of manifest.strategies) {
      const doc = JSON.parse(await readFile(join(dir, s.file), 'utf8'));
      const legs = platform === 'algotest' ? legsFromAlgtst(doc) : legsFromQuantiply(doc);
      picks.push({
        name: s.name,
        legs,
        lots: platform === 'quantiply' ? legLots(doc) : legs.map((l) => l.lots),
      });
    }
    return { day: manifest.day, source: manifest.source, picks };
  }

  // --- logins --------------------------------------------------------------------------------

  private log(platform: LoginPlatform): LoginLog {
    this.state.logins[platform] ??= { count: 0 };
    return this.state.logins[platform] as LoginLog;
  }

  /** Is PR #275's stop button running (its marker beside HOLD.json)? */
  private stopRunning(): boolean {
    // #275's rule (`otherStopRunning`): a marker in either place (`stopRunningPaths`) counts while
    // its pid lives, is not this process, it is under 20 minutes old and from today (IST)
    return otherStopRunning(this.root) !== null;
  }

  /** When another process last logged in to this platform (ms), for a replacement's check. */
  private async otherLoginAt(platform: LoginPlatform): Promise<number | null> {
    // the monitor's own logins under the lock are not "another" login
    if (platform === 'algotest') return lastLoginAt('algotest', undefined, process.pid);
    const broker = platform === 'quantiply-angelone' ? 'angelone' : 'finvasia';
    return lastTotpLoginAt(dirname(quantiplyLedgerPath(this.root, broker)), broker);
  }

  /**
   * Why no login now, or null: the quiet window, the stop button, the cap, the backoffs and, for a
   * replacement, another recent login. The logins on disk are merged in first, so a `--print`
   * run's count.
   */
  private async refusal(platform: LoginPlatform, firstAttempt: boolean): Promise<string | null> {
    const disk = await this.disk();
    this.state.logins = mergeLogins(disk?.logins, this.state.logins);
    const replacing = isReplacing(this.log(platform), this.lost.has(platform));
    return loginRefusal({
      log: this.log(platform),
      cap: platform === 'algotest' ? LOGIN_CAP.algotest : LOGIN_CAP.quantiply,
      minutes: istMinutes(),
      nowMs: Date.now(),
      replacing,
      // a retried code in the next window sees this login's own stamp: only the first is checked
      otherLoginAtMs: replacing && firstAttempt ? await this.otherLoginAt(platform) : null,
      stopRunning: this.stopRunning(),
    });
  }

  /** Count one login (code) now, or refuse it. Called under the platform's login lock. */
  private async allowLogin(platform: LoginPlatform, firstAttempt = true): Promise<void> {
    const why = await this.refusal(platform, firstAttempt);
    if (why) throw new LoginNotAllowed(`${platform}: ${why}`);
    // again right before the login, under the lock: a job that started since the first look
    const busy = await this.platformJobs(platform === 'algotest' ? 'algotest' : 'quantiply');
    if (busy) throw new LoginWaiting(`${platform}: ${busy}`);
    const entry = this.log(platform);
    entry.count += 1;
    if (isReplacing(entry, this.lost.has(platform))) entry.reloginAt = new Date().toISOString();
    await this.save();
  }

  /** A login worked: a loss before it is no longer a reason to treat the next one as a replacement. */
  private async loggedIn(platform: LoginPlatform): Promise<void> {
    this.log(platform).loggedInAt = new Date().toISOString();
    await this.save();
  }

  private async loginFailed(platform: LoginPlatform): Promise<void> {
    this.log(platform).failedAt = new Date().toISOString();
    await this.save();
  }

  /**
   * Before every login on `platform` (and again under its login lock), at any hour: may the
   * scheduler's jobs that log in to it be interrupted? Null = go ahead; else what still runs.
   * Read from the scheduler's loopback `GET /jobs` (`jobsStillToEnd`, `jobsWait`): a run in
   * progress always blocks (a row older than the job's longest run is ignored, and the scheduler
   * closes a dead one); a due or imminent slot, or an API that does not answer, blocks until its
   * window's cap (10:00 / 17:30), a due slot inside its catch-up window a little longer. Past the
   * cap it logs in anyway and says so once per window; waiting over 30 minutes on one job is said
   * once, unmuted. Never waits itself: the caller tries again on its next pass.
   */
  async platformJobs(platform: 'algotest' | 'quantiply'): Promise<string | null> {
    const now = new Date();
    let items: WaitItem[];
    try {
      const port = Number(process.env.SCHEDULER_API_PORT) || 8790;
      const res = await fetch(`http://127.0.0.1:${port}/jobs`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const views = (await res.json()) as SchedulerJobView[];
      items = jobsStillToEnd(views, PLATFORM_JOBS[platform], now);
    } catch (error) {
      items = jobsStillToEnd(null, PLATFORM_JOBS[platform], now, describe(error));
    }
    // since when each item has been seen (kept per platform; dropped once it is gone)
    this.waitFirstSeen[platform] ??= {};
    const seen = this.waitFirstSeen[platform];
    const keys = new Set(items.map(waitKey));
    for (const k of Object.keys(seen)) if (!keys.has(k)) delete seen[k];
    for (const k of keys) seen[k] ??= now.getTime();
    const wait = jobsWait(items, now.getTime(), seen);
    for (const i of wait.blocking) {
      if (now.getTime() - (seen[waitKey(i)] ?? now.getTime()) >= LONG_WAIT_MS) {
        await this.longWait(platform, i);
      }
    }
    if (wait.blocking.length) {
      const why = wait.blocking.map((i) => i.text).join('; ');
      this.jobsWaitedFor.set(platform, why);
      return why;
    }
    for (const w of [...new Set(wait.pastCap.map((i) => i.window))]) {
      const text = wait.pastCap
        .filter((i) => i.window === w)
        .map((i) => i.text)
        .join('; ');
      await this.jobsWaitCapped(platform, w, text);
    }
    if (!wait.pastCap.length && this.jobsWaitedFor.delete(platform)) {
      console.log(`${platform}: its jobs have ended: logging in`);
    }
    return null;
  }

  /** A window's cap passed while a platform's job still looked due: logging in anyway, said once. */
  private async jobsWaitCapped(
    platform: 'algotest' | 'quantiply',
    window: WaitWindow,
    why: string,
  ): Promise<void> {
    const key = `${platform}-${window}`;
    this.state.jobsWaitCapped ??= {};
    if (this.state.jobsWaitCapped[key]) return;
    const name = platform === 'algotest' ? 'AlgoTest' : 'Quantiply';
    // never muted: logging in now may end that job's session
    const sent = await this.send(
      `⚠️ Trade monitor ${hhmm(istMinutes())}: past ${hhmm(WAIT_WINDOWS[window].until)} (${why}); logging in to ${name} anyway: if that job starts now, check it`,
    );
    if (sent) {
      this.state.jobsWaitCapped[key] = true;
      await this.save();
    }
  }

  /** Waiting over 30 minutes on one job: said once a day for that job, unmuted. */
  private async longWait(platform: 'algotest' | 'quantiply', item: WaitItem): Promise<void> {
    this.state.longWaitSaid ??= {};
    if (this.state.longWaitSaid[item.job]) return;
    const name = platform === 'algotest' ? 'AlgoTest' : 'Quantiply';
    const sent = await this.send(
      `⚠️ Trade monitor ${hhmm(istMinutes())}: waiting over 30 minutes for ${item.text}. No ${name} login until it ends: the deploy check and ${name}'s MTM wait for it (the other platform is still read). Check that job (said once today)`,
    );
    if (sent) {
      this.state.longWaitSaid[item.job] = true;
      await this.save();
    }
  }

  /** The session closed while the deploy check still waited for a job: said once, unmuted. */
  async deployNotDone(why: string): Promise<void> {
    const sent = await this.send(
      `⚠️ Trade monitor ${this.day}: deploy check not done today: at ${hhmm(SESSION_CLOSE)} it was still waiting for ${why}`,
    );
    if (sent) {
      this.state.deploy = { at: new Date().toISOString(), ok: false };
      await this.save();
    }
  }

  /** What the deploy check waits for (the platforms it reads), or null: checked once per pass. */
  async deployBlocked(): Promise<string | null> {
    const out: string[] = [];
    for (const platform of ['algotest', 'quantiply'] as const) {
      if (!this.rowBooks(platform).length) continue;
      const busy = await this.platformJobs(platform);
      if (busy) out.push(`${platform}: ${busy}`);
    }
    return out.length ? out.join(' · ') : null;
  }

  /** The platform ended our session: no login for 10 minutes, and say once it is degraded. */
  private async sessionLost(platform: LoginPlatform, label: string): Promise<void> {
    this.lost.add(platform);
    this.log(platform).lostAt = new Date().toISOString();
    if (!this.state.loss.degraded[platform]) {
      const sent = await this.send(
        `⚠️ Trade monitor ${hhmm(istMinutes())}: ${label}'s session ended (another login may have replaced it). Monitoring is degraded: it logs in again no sooner than 10 minutes from now, while no other login to it is recent, at most every 30 minutes and ${platform === 'algotest' ? LOGIN_CAP.algotest : LOGIN_CAP.quantiply} logins a day (said once today)`,
      );
      if (sent) this.state.loss.degraded[platform] = true;
    }
    await this.save();
  }

  // --- AlgoTest -----------------------------------------------------------------------------

  private async algotestPage(): Promise<Page> {
    if (this.algotest) {
      // an open session is never used in the deploy window (a `--now` run that started before it)
      if (!inQuietWindow(istMinutes())) return this.algotest.page;
      await this.dropAlgotest();
      throw new LoginNotAllowed('algotest: no open session between 09:10 and 09:25');
    }
    const phone = process.env.ALGOTEST_PHONE?.trim();
    const password = process.env.ALGOTEST_PASSWORD?.trim();
    if (!phone || !password)
      throw new Error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    registerSecret(password);
    const busy = await this.platformJobs('algotest');
    if (busy) throw new LoginWaiting(`algotest: ${busy}`);
    // the cheap refusals before a browser starts; all of them again under the lock
    const early = await this.refusal('algotest', true);
    if (early) throw new LoginNotAllowed(`algotest: ${early}`);
    const browser = await chromium.launch({ headless: !this.opts.headed });
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      // Before 09:10 the lock is waited for only until 09:10; the quiet window, the cap and the
      // backoffs are checked again once it is held (re-review of #276, D), right before the login.
      const untilQuiet = (QUIET_FROM * 60 - istSecondsNow()) * 1000;
      let attempted = false;
      await withLoginLock(
        'algotest',
        'trade-monitor',
        async () => {
          await this.allowLogin('algotest');
          attempted = true;
          await algotestLogin(page, { phone: normalizePhone(phone), password });
        },
        {
          // a login refused inside the lock leaves login-algotest.last alone
          stampIf: () => attempted,
          ...(istMinutes() < QUIET_FROM ? { waitMs: Math.max(0, untilQuiet) } : {}),
        },
      );
      await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
      await livePage.header(page).waitFor({ timeout: 30_000 });
      this.algotest = { browser, page, reloadedAt: Date.now() };
      this.lost.delete('algotest');
      await this.loggedIn('algotest');
      return page;
    } catch (error) {
      await browser.close().catch(() => undefined);
      // a refusal or a busy lock is not a failed login
      if (!(error instanceof LoginNotAllowed) && !(error instanceof LockBusy)) {
        await this.loginFailed('algotest');
      }
      throw error;
    }
  }

  private async dropAlgotest(): Promise<void> {
    await this.algotest?.browser.close().catch(() => undefined);
    this.algotest = null;
  }

  /** /live, reloaded when due; a logged-out page is dropped (and said once). */
  private async livePageReady(reload: boolean): Promise<Page> {
    const page = await this.algotestPage();
    const at = this.algotest as { reloadedAt: number };
    if (reload || Date.now() - at.reloadedAt >= RELOAD_EVERY_MS) {
      await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
      at.reloadedAt = Date.now();
    }
    if (new URL(page.url()).pathname.includes('/login')) {
      await this.dropAlgotest();
      await this.sessionLost('algotest', 'AlgoTest');
      throw new SessionLost('AlgoTest logged the session out');
    }
    await livePage.header(page).waitFor({ timeout: 30_000 });
    return page;
  }

  private async algotestGet(path: string): Promise<unknown> {
    const page = await this.algotestPage();
    const response = await page.request.get(`${ALGOTEST_API}${path}`, {
      headers: { 'X-CSRF-TOKEN-ACCESS': await csrfToken(page.context()) },
      failOnStatusCode: false,
      timeout: 20_000,
    });
    if (response.status() === 401) {
      await this.dropAlgotest();
      await this.sessionLost('algotest', 'AlgoTest');
      throw new SessionLost(`AlgoTest GET ${path.split('?')[0]} answered 401`);
    }
    if (!response.ok()) {
      throw new Error(`AlgoTest GET ${path.split('?')[0]} answered ${response.status()}`);
    }
    return response.json();
  }

  /**
   * Each saved strategy's Quantity Multiplier, every strategy (no weekday filter: the tool's
   * deploys have no day ticked). Falls back to today's weekday; null when neither reads.
   */
  private async multipliers(): Promise<Map<string, number> | null> {
    const read = async (query: string) => {
      const out = new Map<string, number>();
      for (let n = 1; n <= 5; n += 1) {
        const json = (await this.algotestGet(
          `/executable-strategies?page=${n}&page_size=50${query}`,
        )) as { data?: { name?: unknown; multiplier?: unknown }[] };
        const data = json.data ?? [];
        for (const s of data) {
          if (typeof s.name === 'string' && typeof s.multiplier === 'number') {
            out.set(s.name, s.multiplier);
          }
        }
        if (data.length < 50) break;
      }
      return out;
    };
    try {
      return await read('');
    } catch (error) {
      if (error instanceof SessionLost) throw error;
      const weekday = new Date(`${this.day}T00:00:00Z`)
        .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        .toLowerCase();
      return read(`&weekday=${weekday}`).catch((e) => {
        if (e instanceof SessionLost) throw e;
        return null;
      });
    }
  }

  // --- Quantiply ----------------------------------------------------------------------------

  private async quantiplyApp(broker: QuantiplyBroker) {
    const platform: LoginPlatform = `quantiply-${broker}`;
    const open = this.quantiply.get(broker);
    if (open) {
      // an open session is never used in the deploy window (a `--now` run that started before it)
      if (!inQuietWindow(istMinutes())) return open;
      await open.browser.close().catch(() => undefined);
      this.quantiply.delete(broker);
      throw new LoginNotAllowed(`${platform}: no open session between 09:10 and 09:25`);
    }
    const creds = quantiplyCredentials(broker);
    const stateDir = dirname(quantiplyLedgerPath(this.root, broker));
    try {
      await checkLoginHold(creds, stateDir);
    } catch (error) {
      if (error instanceof LoginHeld) this.refused = true;
      throw error;
    }
    // Waited out before the login lock is taken, so the stop button is never held up by it.
    const busy = await this.platformJobs('quantiply');
    if (busy) throw new LoginWaiting(`${platform}: ${busy}`);
    const early = await this.refusal(platform, true);
    if (early) throw new LoginNotAllowed(`${platform}: ${early}`);
    let attempt = 0;
    let app: Awaited<ReturnType<typeof openQuantiplyApp>>;
    try {
      app = await openQuantiplyApp(creds, stateDir, {
        headed: this.opts.headed,
        retryTotpOnce: true,
        // under the account's login lock: every code typed counts toward the cap, and each is
        // checked again (the quiet window, the stop button, the backoffs) right before it is typed
        beforeAttempt: () => {
          attempt += 1;
          return this.allowLogin(platform, attempt === 1);
        },
        onPage: (page) => {
          page.on('websocket', (ws) => {
            ws.on('framereceived', (frame) => {
              const payload = typeof frame.payload === 'string' ? frame.payload : '';
              for (const { id, pnl } of pnlFromSocketFrame(payload)) {
                this.state.qpnl[id] = { pnl, at: Date.now() };
              }
            });
          });
        },
      });
    } catch (error) {
      if (error instanceof LoginRefused) this.refused = true;
      if (!(error instanceof LoginNotAllowed)) await this.loginFailed(platform);
      throw error;
    }
    this.lost.delete(platform);
    await this.loggedIn(platform);
    const entry = { api: app.api, browser: app.browser, list: [] as QListed[], listedAt: 0 };
    this.quantiply.set(broker, entry);
    return entry;
  }

  private async dropQuantiply(): Promise<void> {
    for (const app of this.quantiply.values()) await app.browser.close().catch(() => undefined);
    this.quantiply.clear();
  }

  private async quantiplyList(broker: QuantiplyBroker, force = false): Promise<QListed[]> {
    const app = await this.quantiplyApp(broker);
    if (force || Date.now() - app.listedAt >= LIST_EVERY_MS) {
      try {
        app.list = parseDayWiseListed(await app.api.dayWise());
        app.listedAt = Date.now();
      } catch (error) {
        if (/answered 401/.test(describe(error))) {
          await app.browser.close().catch(() => undefined);
          this.quantiply.delete(broker);
          await this.sessionLost(`quantiply-${broker}`, QUANTIPLY_SITES[broker].name);
          throw new SessionLost(`${QUANTIPLY_SITES[broker].name}: the session answered 401`);
        }
        throw error;
      }
    }
    return app.list;
  }

  /** Close every session (09:10, before the deploy window; and at the end). */
  async closeSessions(): Promise<void> {
    if (this.algotest || this.quantiply.size) console.log('closing the platform sessions');
    await this.dropAlgotest();
    await this.dropQuantiply();
  }

  // --- the three parts ----------------------------------------------------------------------

  async margin(): Promise<void> {
    const accounts: AccountMargin[] = [];
    const csv = readFileSync(
      new URL(
        '../../option-backtesting/src/option_backtesting/data/reference/margin.csv',
        import.meta.url,
      ),
      'utf8',
    );
    const perStraddle = parseMarginCsv(csv);
    const lotOf = (u: string) => {
      try {
        return lotSize(u as Underlying);
      } catch {
        return null;
      }
    };
    const uses = [
      ...this.rowBooks('algotest').map((r) => ({ ...r, platform: 'algotest' as const })),
      ...this.rowBooks('quantiply').map((r) => ({ ...r, platform: 'quantiply' as const })),
    ];
    for (const broker of ['finvasia', 'angelone'] as Broker[]) {
      const mine = uses.filter((u) => u.broker === broker);
      if (!mine.length) continue;
      const account: AccountMargin = {
        account: ACCOUNT_NAME[broker],
        uses: [],
        picks: [],
        free: null,
        source: '',
      };
      for (const u of mine) {
        const label = `${u.platform === 'algotest' ? 'AlgoTest' : 'Quantiply'} ${BOOK_NAME[u.book]}`;
        try {
          const p = await this.picks(u.platform, u.book);
          if (p.day !== this.day) {
            account.uses.push(`${label}: no export for today (latest ${p.day})`);
            account.picksMissing = true;
            continue;
          }
          account.uses.push(`${label} ${p.source}`);
          for (const pick of p.picks) {
            account.picks.push(pickNeed(pick.name, pick.legs, perStraddle, lotOf));
          }
        } catch (error) {
          account.uses.push(`${label}: picks not read (${describe(error)})`);
          account.picksMissing = true;
        }
      }
      try {
        if (istMinutes() >= QUIET_FROM) throw new Error('09:10 came first: not read');
        if (broker === 'finvasia') {
          const funds = parseAlgotestBrokers(await this.algotestGet('/brokers')).find(
            (b) => b.broker === ALGOTEST_BROKER_ID.finvasia,
          );
          const at = algotestInstant(funds?.updatedAt ?? null);
          if (!funds || funds.available === null) {
            account.source = 'AlgoTest shows no Finvasia funds';
          } else if (!at || istDayOf(at) !== this.day) {
            account.source = `not read: AlgoTest's Finvasia figure ${inr(funds.available)} is from ${at ? `${istDayOf(at)} ${istClock(at)} IST` : '?'} (AlgoTest's broker login has not run today)`;
          } else {
            account.free = funds.available;
            account.source = `free margin as AlgoTest read it at its broker login (${istClock(at)} IST); Shoonya's own API is never logged in to`;
          }
        } else {
          // The AlgoTest session (Finvasia's read above) is not kept open while SmartAPI answers:
          // that can take until after 09:10 (re-review of #276, D). Margin is the only part
          // before 09:10, so nothing else needs it.
          await this.dropAlgotest();
          const out = await runCommand(
            'uv',
            ['run', '--directory', '../option-backtesting', 'obt', 'angel', 'funds', '--json'],
            FUNDS_TIMEOUT_MS,
          );
          const line = out.stdout.trim().split('\n').at(-1) ?? '';
          let json: { ok?: boolean; net?: number; error?: string } = {};
          try {
            json = JSON.parse(line || '{}');
          } catch {
            // reported below
          }
          if (json.ok && typeof json.net === 'number') {
            account.free = json.net;
            account.source = 'free margin (net) from Angel One SmartAPI getRMS, one guarded login';
          } else {
            account.source = `not read: ${json.error ?? `obt angel funds exited ${out.code}`}`;
          }
        }
      } catch (error) {
        account.source = `not read: ${describe(error)}`;
      }
      accounts.push(account);
    }
    if (!accounts.length) {
      console.log(
        'margin: no platform row uploads a list in Settings › Automation: nothing to check',
      );
      this.state.margin = { at: new Date().toISOString(), ok: true };
      await this.save();
      return;
    }
    const m = marginMessage(this.day, accounts);
    if (await this.send(m.text, 'monitor.margin')) {
      this.state.margin = { at: new Date().toISOString(), ok: m.ok };
      await this.save();
    }
  }

  /** Started after 09:10 (a late start, a restart): say once that the margin was not checked. */
  async marginSkipped(minute: number): Promise<void> {
    const sent = await this.send(
      `ℹ️ Trade monitor ${hhmm(minute)}: started after 09:10, so the margin check did not run today (it logs in only 09:05-09:10)`,
      'monitor.margin',
    );
    if (sent) {
      this.state.margin = { at: new Date().toISOString(), ok: false, skipped: true };
      await this.save();
    }
  }

  async deploy(): Promise<void> {
    const checks: PlatformCheck[] = [];
    const algotestRows = this.rowBooks('algotest');
    if (algotestRows.length) {
      const label = `AlgoTest ${[...new Set(algotestRows.map((r) => BOOK_NAME[r.book]))].join('+')}`;
      try {
        const rows: AlgoTestRowPicks[] = [];
        const notes: string[] = [];
        const missing: string[] = [];
        for (const r of algotestRows) {
          const p = await this.picks('algotest', r.book);
          if (p.day !== this.day) {
            missing.push(`no ${r.book} picks exported for today (latest ${p.day})`);
            continue;
          }
          if (p.source !== 'recorded') {
            notes.push(
              `checked against last evening's expected ${r.book} picks (no recorded export yet)`,
            );
          }
          rows.push({ broker: r.broker, picks: p.picks.map((x) => x.name) });
        }
        const page = await this.livePageReady(true);
        const text = await page.evaluate(() => document.body.innerText);
        const live = parseLive(text);
        const names = rows.flatMap((r) => r.picks);
        const c = checkAlgoTest(
          label,
          rows,
          live,
          await this.multipliers(),
          parseDeployedOn(text, names),
        );
        c.problems.unshift(...missing);
        c.notes.push(...notes);
        const note = pauseNote(pausedFor(this.automation, this.day));
        if (note) c.notes.push(note);
        checks.push(c);
      } catch (error) {
        checks.push({
          label,
          expected: 0,
          good: [],
          problems: [],
          extra: [],
          notes: [],
          error: describe(error),
        });
      }
    }
    for (const { broker, book } of this.rowBooks('quantiply')) {
      const label = `Quantiply ${BOOK_NAME[book]}${broker === 'finvasia' ? ' (Shoonya)' : ''}`;
      try {
        const p = await this.picks('quantiply', book);
        const notes: string[] = [];
        const missing = p.day !== this.day ? [`no picks exported for today (latest ${p.day})`] : [];
        if (!missing.length && p.source !== 'recorded') {
          notes.push("checked against last evening's expected picks (no recorded export yet)");
        }
        const picks =
          p.day === this.day ? p.picks.map((x) => ({ name: x.name, lots: x.lots })) : [];
        const list = await this.quantiplyList(broker, true);
        const weekday = istWeekday();
        const app = await this.quantiplyApp(broker);
        const lots = new Map<string, number[]>();
        for (const a of list.filter(
          (x) => x.day === weekday && x.enabled && picks.some((pk) => pk.name === x.name),
        )) {
          try {
            lots.set(a.id, legLots(await app.api.get(a.id)));
          } catch (error) {
            notes.push(`${a.name}: lots not read (${describe(error)})`);
          }
        }
        const c = checkQuantiply(label, picks, list, weekday, lots);
        c.problems.unshift(...missing);
        c.notes.push(...notes);
        const note = pauseNote(pausedFor(this.automation, this.day));
        if (note) c.notes.push(note);
        checks.push(c);
      } catch (error) {
        checks.push({
          label,
          expected: 0,
          good: [],
          problems: [],
          extra: [],
          notes: [],
          error: describe(error),
        });
      }
    }
    if (!checks.length) {
      console.log(
        'deploy: no platform row uploads a list in Settings › Automation: nothing to check',
      );
      this.state.deploy = { at: new Date().toISOString(), ok: true };
      await this.save();
      return;
    }
    const m = deployMessage(this.day, hhmm(istMinutes()), checks);
    if (await this.send(m.text, 'monitor.deploy')) {
      this.state.deploy = { at: new Date().toISOString(), ok: m.ok };
      await this.save();
    }
  }

  /** One reading of the day's combined MTM; sends a level the first time it is reached. */
  async lossTick(): Promise<string> {
    const parts: MtmPart[] = [];
    // waiting for the morning's deploy jobs to end: no "cannot read" notice for that
    const waiting = new Set<string>();
    if (this.rowBooks('algotest').length) {
      let value: number | null = null;
      try {
        for (const reload of [false, true]) {
          const page = await this.livePageReady(reload);
          const read = readTotalMtm(await page.evaluate(readMtmCardsInPage));
          if ('inr' in read) {
            value = read.inr;
            break;
          }
          console.log(`AlgoTest MTM: ${read.error}`);
        }
      } catch (error) {
        if (error instanceof LoginWaiting) waiting.add('AlgoTest');
        console.log(`AlgoTest MTM not read: ${describe(error)}`);
      }
      parts.push({ label: 'AlgoTest', inr: value });
    }
    for (const { broker } of this.rowBooks('quantiply')) {
      const label = `Quantiply ${broker === 'angelone' ? 'Angel One' : 'Shoonya'}`;
      let value: number | null = null;
      try {
        const list = await this.quantiplyList(broker);
        const r = quantiplyReading(
          list,
          istWeekday(),
          this.state.qpnl,
          Date.now(),
          istSecondsNow(),
        );
        if (r.inr === null) console.log(`${label}: no fresh MTM for ${r.unread.join(', ')}`);
        value = r.inr;
      } catch (error) {
        if (error instanceof LoginWaiting) waiting.add(label);
        console.log(`${label} MTM not read: ${describe(error)}`);
      }
      parts.push({ label, inr: value });
    }
    const at = hhmm(istMinutes());
    for (const p of parts) {
      if (waiting.has(p.label)) continue;
      const notice = mtmNotice(this.state.loss, p.label, p.inr !== null);
      if (!notice) continue;
      // never muted: it says the loss alert is blind (or no longer blind) for this platform
      if (await this.send(mtmNoticeText(this.state.loss, p.label, notice, at))) {
        commitMtmNotice(this.state.loss, p.label, notice);
      }
    }
    const total = parts.reduce((s, p) => s + (p.inr ?? 0), 0);
    for (const level of lossCrossings(total, this.state.loss)) {
      // the alert is never optional: untagged, so no notification setting can mute it
      const sent = await this.send(
        lossMessage(level, total, parts, at),
        level === 'alert' ? undefined : 'monitor.loss',
      );
      if (!sent) break; // the next tick sends it again
      if (level === 'warning') this.state.loss.warned = true;
      else this.state.loss.alerted = true;
    }
    await this.save();
    return `${at} ${parts.map((p) => `${p.label} ${p.inr === null ? 'cannot read' : inr(p.inr)}`).join(' · ')} · counted ${inr(total)}`;
  }

  get hadRefusal(): boolean {
    return this.refused;
  }

  get done(): DayState {
    return this.state;
  }
}

/** Sends the failure (the job alerts itself, so the scheduler stays quiet) and returns `code`. */
async function failed(code: number, text: string, print: boolean): Promise<number> {
  console.error(text);
  if (!print) {
    await Promise.resolve()
      .then(() => sendText(readTelegramConfig(), redact(`⚠️ Trade monitor: ${text}`)))
      .catch(() => undefined);
  }
  return code;
}

async function main(): Promise<number> {
  const print = process.argv.includes('--print');
  let values: { parts?: string; now?: boolean; print?: boolean; headed?: boolean };
  try {
    values = parseArgs({
      options: {
        parts: { type: 'string' },
        now: { type: 'boolean', default: false },
        print: { type: 'boolean', default: false },
        headed: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    return failed(64, `bad arguments: ${describe(error)}`, print);
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const asked = (values.parts ?? 'margin,deploy,loss').split(',').map((p) => p.trim()) as Part[];
  if (asked.some((p) => !(p in SWITCH))) {
    return failed(
      64,
      `usage: [--parts margin,deploy,loss] [--now] [--print]; got --parts ${values.parts}`,
      print,
    );
  }
  // A part runs when its switch is on; `--print` (a look by hand, nothing sent) needs none.
  const parts = new Set(asked.filter((p) => values.print || switchOn(process.env, SWITCH[p])));
  if (!parts.size) {
    console.log(
      `DEPLOY_CHECK / MARGIN_CHECK / LOSS_ALERTS: none of ${asked.join(', ')} is "on": nothing to do`,
    );
    return 0;
  }
  const day = istToday();
  if (!isTradingDay(day) && !values.print) {
    console.log(`${day} is not a trading day: nothing to do`);
    return 0;
  }
  const root = process.env.TRADING_DATA_ROOT?.trim();
  if (!root) return failed(1, 'did not run: TRADING_DATA_ROOT is not set', print);
  let automation: Automation;
  try {
    automation = readAutomation();
  } catch (error) {
    return failed(
      1,
      `did not run: the automation settings cannot be read (${describe(error)})`,
      print,
    );
  }

  // One monitor at a time (a hand run and the scheduled one would both send the levels).
  const monitorLock = join(lockDir(), `trade-monitor-${day}.lock`);
  if (!values.print) {
    await mkdir(dirname(monitorLock), { recursive: true });
    if (!tryLock(monitorLock, 'trade-monitor', 12 * 3_600_000)) {
      const holder = readFileSync(monitorLock, 'utf8').slice(0, 120);
      return failed(
        EXIT_NO_RETRY,
        `another trade monitor is running (${holder}): this one stops`,
        false,
      );
    }
  }

  const m = new Monitor(day, root, automation, { print: !!values.print, headed: !!values.headed });
  await m.load();
  console.log(
    `trade monitor ${day}: ${[...parts].join(', ')}${values.print ? ' (--print: nothing sent; logins still count)' : ''}`,
  );

  const run = async (part: Part, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      // one attempt per process: a check that cannot run is said once, never retried every tick
      parts.delete(part);
      await m.send(
        `⚠️ Trade monitor ${day}: the ${part} check could not run: ${describe(error)}`,
        `monitor.${part}`,
      );
    }
  };

  try {
    if (values.now) {
      if (inQuietWindow(istMinutes())) {
        console.log('09:10-09:25: no login in the deploy window; run it after 09:25');
        return 0;
      }
      if (parts.has('margin')) await run('margin', () => m.margin());
      if (parts.has('deploy')) {
        // one look by hand: wait here for the platforms' jobs (bounded: a row nothing closed is
        // ignored, a due one ends at its cap)
        let said = '';
        for (let busy = await m.deployBlocked(); busy; busy = await m.deployBlocked()) {
          if (busy !== said) console.log(`deploy: waiting before logging in: ${busy}`);
          said = busy;
          await sleep(30_000);
        }
        await run('deploy', () => m.deploy());
      }
      if (parts.has('loss')) console.log(await m.lossTick());
      return m.hadRefusal ? EXIT_NO_RETRY : 0;
    }
    let lastLossMinute = -1;
    let deployWaitSaid = '';
    for (;;) {
      const minute = istMinutes();
      if (inQuietWindow(minute)) await m.closeSessions();
      if (parts.has('margin') && !m.done.margin && minute >= MARGIN_AT) {
        if (minute < QUIET_FROM) {
          await run('margin', () => m.margin());
          // nothing stays open into the deploy window
          if (istMinutes() >= QUIET_FROM - 1) await m.closeSessions();
        } else {
          console.log(`margin: ${hhmm(minute)} is past 09:10: not checked today`);
          await m.marginSkipped(minute);
          parts.delete('margin');
        }
      }
      if (
        parts.has('deploy') &&
        !m.done.deploy &&
        minute >= DEPLOY_CHECK_AT &&
        minute < SESSION_CLOSE
      ) {
        // Checked once per pass, never waited for here: the loss readings go on meanwhile.
        const busy = await m.deployBlocked();
        if (!busy) await run('deploy', () => m.deploy());
        else if (busy !== deployWaitSaid) console.log(`deploy: waiting before logging in: ${busy}`);
        deployWaitSaid = busy ?? '';
      }
      if (parts.has('loss') && inLossWindow(minute) && minute !== lastLossMinute) {
        lastLossMinute = minute;
        try {
          const line = await m.lossTick();
          if (minute % 15 === 0) console.log(line);
        } catch (error) {
          console.error(`loss reading: ${describe(error)}`);
        }
      }
      const marginLeft = parts.has('margin') && !m.done.margin && minute < QUIET_FROM;
      const deployLeft = parts.has('deploy') && !m.done.deploy && minute < SESSION_CLOSE;
      const lossLeft = parts.has('loss') && minute < SESSION_CLOSE;
      if (!marginLeft && !deployLeft && !lossLeft) {
        // the deploy check waited all session for a platform's job: say once it did not run
        if (parts.has('deploy') && !m.done.deploy && deployWaitSaid) {
          await m.deployNotDone(deployWaitSaid);
        }
        break;
      }
      // margin done and nothing else before 09:25: no session waits through the quiet window
      if (minute < QUIET_FROM && !marginLeft) await m.closeSessions();
      await sleep(TICK_MS);
    }
    // A refused Quantiply login stopped only that platform's reading; say so by the exit.
    return m.hadRefusal ? EXIT_NO_RETRY : 0;
  } finally {
    await m.closeSessions();
    if (!values.print) unlock(monitorLock);
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (error: unknown) => {
    // Unexpected. The job alerts itself (the scheduler stays quiet on its exit), so say it here;
    // the state file stops a check or a level being sent twice on a retry.
    const code = await failed(
      1,
      `stopped: ${describe(error)} (the scheduler retries it while attempts are left)`,
      process.argv.includes('--print'),
    );
    process.exit(code);
  });

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Underlying, isTradingDay, lotSize } from '@trading/market-reference';
import { sendText } from '@trading/notify';
import { type Browser, type Page, chromium } from 'playwright';
import { BASE_URL } from './algotest.js';
import {
  type Automation,
  type Book,
  type Broker,
  effectiveRow,
  readAutomation,
} from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { istMinutes, parseLive } from './deploy-plan.js';
import { describe } from './diagnose.js';
import { algotestLoginLocked, lockDir, tryLock, unlock } from './login-lock.js';
import {
  ALGOTEST_BROKER_ID,
  type AccountMargin,
  type AlgoTestRowPicks,
  DEPLOY_CHECK_AT,
  LOGIN_CAP,
  type LegNeed,
  type LoginLog,
  MARGIN_AT,
  type MtmPart,
  type PlatformCheck,
  type PnlSeen,
  type QListed,
  QUIET_FROM,
  SESSION_CLOSE,
  algotestInstant,
  checkAlgoTest,
  checkQuantiply,
  deployMessage,
  inLossWindow,
  inQuietWindow,
  inr,
  istClock,
  istDayOf,
  legLots,
  legsFromAlgtst,
  legsFromQuantiply,
  loginRefusal,
  lossCrossings,
  lossMessage,
  marginMessage,
  parseAlgotestBrokers,
  parseDayWiseListed,
  parseDeployedOn,
  parseMarginCsv,
  pickNeed,
  pnlFromSocketFrame,
  quantiplyReading,
  readMtmCardsInPage,
  readTotalMtm,
  switchOn,
} from './monitor-plan.js';
import type { QuantiplyApi } from './quantiply-api.js';
import { istWeekday } from './quantiply-plan.js';
import { QUANTIPLY_SITES, type QuantiplyBroker } from './quantiply-rules.js';
import {
  LoginHeld,
  LoginRefused,
  checkLoginHold,
  openQuantiplyApp,
  quantiplyCredentials,
  quantiplyLedgerPath,
} from './quantiply-session.js';
import { redact, registerSecret } from './secrets.js';
import { livePage } from './selectors.js';
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
 * Each platform: a daily cap of codes typed, no new login for 10 min after a failed one, a lost
 * session (logged out / 401) replaced at most every 30 min, said once as "degraded". Shoonya's own
 * API: never.
 *
 *   tsx src/trade-monitor.ts [--parts margin,deploy,loss] [--now] [--print] [--headed]
 *
 * `--now` runs the asked parts at once (one loss reading, then exit; still no login 09:10-09:25);
 * `--print` prints the messages instead of sending them and keeps no once-only flags, but its
 * logins count toward the day's caps. Without `--print` a part also needs its switch.
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
  margin?: { at: string; ok: boolean };
  deploy?: { at: string; ok: boolean };
  loss: {
    warned: boolean;
    alerted: boolean;
    /** said once: this platform's MTM cannot be read */
    unreadable: Record<string, boolean>;
    /** said once: this platform's session ended and monitoring is degraded */
    degraded: Record<string, boolean>;
  };
  /** Quantiply algo id -> its last MTM figure and when it arrived, kept across restarts */
  qpnl: Record<string, PnlSeen>;
  logins: Partial<Record<LoginPlatform, LoginLog>>;
}

const fresh = (): DayState => ({
  loss: { warned: false, alerted: false, unreadable: {}, degraded: {} },
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

  /** Writes the state; a `--print` run writes only its logins (they count toward the caps). */
  private async save(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    let out: DayState = this.state;
    if (this.opts.print) {
      let disk: DayState = fresh();
      try {
        disk = { ...fresh(), ...JSON.parse(await readFile(this.statePath, 'utf8')) };
      } catch {
        // nothing on disk yet
      }
      out = { ...disk, logins: this.state.logins };
    }
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

  /** Count one login (code) now, or refuse it: the quiet window, the cap, the backoffs. */
  private async allowLogin(platform: LoginPlatform): Promise<void> {
    const cap = platform === 'algotest' ? LOGIN_CAP.algotest : LOGIN_CAP.quantiply;
    const why = loginRefusal(
      this.log(platform),
      cap,
      istMinutes(),
      Date.now(),
      this.lost.has(platform),
    );
    if (why) throw new LoginNotAllowed(`${platform}: ${why}`);
    const entry = this.log(platform);
    entry.count += 1;
    if (this.lost.has(platform)) entry.reloginAt = new Date().toISOString();
    await this.save();
  }

  private async loginFailed(platform: LoginPlatform): Promise<void> {
    this.log(platform).failedAt = new Date().toISOString();
    await this.save();
  }

  /** The platform ended our session: say once that monitoring is degraded. */
  private async sessionLost(platform: LoginPlatform, label: string): Promise<void> {
    this.lost.add(platform);
    if (this.state.loss.degraded[platform]) return;
    const sent = await this.send(
      `⚠️ Trade monitor ${hhmm(istMinutes())}: ${label}'s session ended (another login may have replaced it). Monitoring is degraded: it logs in again at most every 30 minutes, ${platform === 'algotest' ? LOGIN_CAP.algotest : LOGIN_CAP.quantiply} logins a day (said once today)`,
    );
    if (sent) {
      this.state.loss.degraded[platform] = true;
      await this.save();
    }
  }

  // --- AlgoTest -----------------------------------------------------------------------------

  private async algotestPage(): Promise<Page> {
    if (this.algotest) return this.algotest.page;
    const phone = process.env.ALGOTEST_PHONE?.trim();
    const password = process.env.ALGOTEST_PASSWORD?.trim();
    if (!phone || !password)
      throw new Error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    registerSecret(password);
    await this.allowLogin('algotest');
    const browser = await chromium.launch({ headless: !this.opts.headed });
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await algotestLoginLocked(page, { phone: normalizePhone(phone), password }, 'trade-monitor');
      await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
      await livePage.header(page).waitFor({ timeout: 30_000 });
      this.algotest = { browser, page, reloadedAt: Date.now() };
      this.lost.delete('algotest');
      return page;
    } catch (error) {
      await browser.close().catch(() => undefined);
      await this.loginFailed('algotest');
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
    const open = this.quantiply.get(broker);
    if (open) return open;
    const platform: LoginPlatform = `quantiply-${broker}`;
    const creds = quantiplyCredentials(broker);
    const stateDir = dirname(quantiplyLedgerPath(this.root, broker));
    try {
      await checkLoginHold(creds, stateDir);
    } catch (error) {
      if (error instanceof LoginHeld) this.refused = true;
      throw error;
    }
    let app: Awaited<ReturnType<typeof openQuantiplyApp>>;
    try {
      app = await openQuantiplyApp(creds, stateDir, {
        headed: this.opts.headed,
        retryTotpOnce: true,
        // every code typed counts toward the cap, and each is refused in the quiet window
        beforeAttempt: () => this.allowLogin(platform),
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
        console.log(`${label} MTM not read: ${describe(error)}`);
      }
      parts.push({ label, inr: value });
    }
    const at = hhmm(istMinutes());
    for (const p of parts) {
      if (p.inr === null && !this.state.loss.unreadable[p.label]) {
        // never muted: it says the loss alert is blind for this platform
        const sent = await this.send(
          `⚠️ Loss monitor ${at}: cannot read ${p.label}'s MTM; the loss levels count the other platform only until it can (said once today)`,
        );
        if (sent) this.state.loss.unreadable[p.label] = true;
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
      if (parts.has('deploy')) await run('deploy', () => m.deploy());
      if (parts.has('loss')) console.log(await m.lossTick());
      return m.hadRefusal ? EXIT_NO_RETRY : 0;
    }
    let lastLossMinute = -1;
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
          parts.delete('margin');
        }
      }
      if (
        parts.has('deploy') &&
        !m.done.deploy &&
        minute >= DEPLOY_CHECK_AT &&
        minute < SESSION_CLOSE
      ) {
        await run('deploy', () => m.deploy());
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
      if (!marginLeft && !deployLeft && !lossLeft) break;
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

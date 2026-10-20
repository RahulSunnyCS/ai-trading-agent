import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isTradingDay } from '@trading/market-reference';
import { sendText } from '@trading/notify';
import { type Browser, type Page, chromium } from 'playwright';
import { BASE_URL, algotestLogin } from './algotest.js';
import { type Automation, type Book, type Broker, readAutomation } from './automation-settings.js';
import { normalizePhone, readTelegramConfig } from './config.js';
import { type LiveState, istMinutes, parseLive } from './deploy-plan.js';
import { describe } from './diagnose.js';
import {
  ALGOTEST_BROKER_ID,
  type AccountMargin,
  DEPLOY_CHECK_AT,
  LOSS_LOGIN_AT,
  type LegNeed,
  MARGIN_AT,
  type MtmPart,
  type PlatformCheck,
  type QListed,
  SESSION_CLOSE,
  SESSION_OPEN,
  algotestInstant,
  checkAlgoTest,
  checkQuantiply,
  deployMessage,
  inLossWindow,
  inr,
  istDayOf,
  legLots,
  legsFromAlgtst,
  legsFromQuantiply,
  lossCrossings,
  lossMessage,
  marginMessage,
  parseAlgotestBrokers,
  parseDayWiseListed,
  parseMarginCsv,
  parseTotalMtm,
  pickNeed,
  pnlFromSocketFrame,
  quantiplyMtm,
  switchOn,
  unreadActive,
} from './monitor-plan.js';
import type { QuantiplyApi } from './quantiply-api.js';
import { istWeekday } from './quantiply-plan.js';
import { QUANTIPLY_SITES, type QuantiplyBroker } from './quantiply-rules.js';
import {
  LoginHeld,
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
 * BL-143 Phases 2-3: one process per trading day (the scheduler's `trade-monitor`, 09:04) that
 * logs in to each platform ONCE and keeps the session for the day:
 *
 *   09:05  margin check   (MARGIN_CHECK=on)   free margin per broker account vs the day's picks
 *   09:25  deploy check   (DEPLOY_CHECK=on)   AlgoTest /live and Quantiply hold exactly the picks
 *   09:15-15:30 loss alerts (LOSS_ALERTS=on)  combined MTM every minute; -₹5,000 / -₹8,000 once each
 *
 * READ-ONLY: it opens pages and makes GET calls; it never clicks a button on a platform, never
 * sends a PUT/POST/DELETE to one, and never squares anything off. Its only writes are Telegram
 * messages and a small state file per day (`TRADING_DATA_ROOT/monitor/<day>.json`), so a retry
 * or a restart never sends a level or a check twice.
 *
 * Logins (each the same as the jobs already make):
 * - AlgoTest: the website login (phone + password, no broker login), once; re-login only if the
 *   site logs the session out, at most `MAX_ALGOTEST_LOGINS` a day.
 * - Quantiply: per account with a list in Settings › Automation, the login the uploader uses
 *   (`quantiply-session.ts`: the refused-login hold and the TOTP window stamp), once, the app kept
 *   open; at most `MAX_QUANTIPLY_LOGINS` a day.
 * - Angel One SmartAPI: `obt angel funds` (the shared guard), once, for the margin check only.
 * - Shoonya's own API: never. Finvasia's free margin is AlgoTest's figure (`GET /brokers`).
 *
 *   tsx src/trade-monitor.ts [--parts margin,deploy,loss] [--now] [--print] [--headed]
 *
 * `--now` runs the asked parts at once (one loss reading, then exit) instead of waiting for
 * their times; `--print` prints the messages instead of sending them and writes no state, so a
 * look by hand never uses up the day's once-only messages. Without `--print` a part also needs
 * its switch.
 */

const VIEWPORT = { width: 1440, height: 900 };
const MAX_ALGOTEST_LOGINS = 3;
const MAX_QUANTIPLY_LOGINS = 2;
/** AlgoTest's /live is reloaded at most this often (its MTM is computed in the page). */
const RELOAD_EVERY_MS = 3 * 60_000;
/** Quantiply's list is re-read this often (which algos trade today; the MTM comes by socket). */
const LIST_EVERY_MS = 5 * 60_000;
const TICK_MS = 15_000;

/** 3: a refused or held login, never retried by the scheduler. */
const EXIT_NO_RETRY = 3;

type Part = 'margin' | 'deploy' | 'loss';
const SWITCH: Record<Part, string> = {
  margin: 'MARGIN_CHECK',
  deploy: 'DEPLOY_CHECK',
  loss: 'LOSS_ALERTS',
};
const ACCOUNT_NAME: Record<Broker, string> = { finvasia: 'Finvasia', angelone: 'Angel One' };

interface DayState {
  margin?: { at: string; ok: boolean };
  deploy?: { at: string; ok: boolean };
  loss: { warned: boolean; alerted: boolean; unreadable: Record<string, boolean> };
  /** Quantiply algo id -> its last MTM figure, kept across restarts (a closed algo's booked P&L) */
  qpnl: Record<string, number>;
  logins: { algotest: number; quantiply: Record<string, number> };
}

const fresh = (): DayState => ({
  loss: { warned: false, alerted: false, unreadable: {} },
  qpnl: {},
  logins: { algotest: 0, quantiply: {} },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

class Monitor {
  private state: DayState = fresh();
  private algotest: { browser: Browser; page: Page; reloadedAt: number } | null = null;
  private readonly quantiply = new Map<
    QuantiplyBroker,
    { api: QuantiplyApi; browser: Browser; list: QListed[]; listedAt: number; unreadTicks: number }
  >();
  private readonly failed = new Set<string>();
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
      this.state = {
        ...fresh(),
        ...(JSON.parse(await readFile(this.statePath, 'utf8')) as DayState),
      };
    } catch {
      this.state = fresh();
    }
  }

  private async save(): Promise<void> {
    if (this.opts.print) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 1)}\n`);
    await rename(tmp, this.statePath);
  }

  async send(text: string, type?: string): Promise<void> {
    const safe = redact(text);
    if (this.opts.print) {
      console.log(`\n--- message (${type ?? 'always'}; --print: not sent) ---\n${safe}\n`);
      return;
    }
    console.log(safe);
    await sendText(readTelegramConfig(), safe, type).catch(() => undefined);
  }

  /** Which lists each platform row holds today (BL-140): `list` set, whatever upload says. */
  books(platform: 'algotest' | 'quantiply', broker?: Broker): Book[] {
    const brokers: Broker[] = broker ? [broker] : ['finvasia', 'angelone'];
    const out = new Set<Book>();
    for (const b of brokers) {
      const row = this.automation.rows[`${platform}.${b}`];
      if (row.list !== 'none') out.add(row.list);
    }
    return [...out].sort();
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

  // --- AlgoTest -----------------------------------------------------------------------------

  private async algotestPage(): Promise<Page> {
    if (this.algotest) return this.algotest.page;
    if (this.state.logins.algotest >= MAX_ALGOTEST_LOGINS) {
      throw new Error(
        `AlgoTest: ${MAX_ALGOTEST_LOGINS} logins today already, not logging in again`,
      );
    }
    const phone = process.env.ALGOTEST_PHONE?.trim();
    const password = process.env.ALGOTEST_PASSWORD?.trim();
    if (!phone || !password)
      throw new Error('ALGOTEST_PHONE / ALGOTEST_PASSWORD missing from .env');
    registerSecret(password);
    const browser = await chromium.launch({ headless: !this.opts.headed });
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      this.state.logins.algotest += 1;
      await this.save();
      await algotestLogin(page, { phone: normalizePhone(phone), password });
      await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
      await livePage.header(page).waitFor({ timeout: 30_000 });
      this.algotest = { browser, page, reloadedAt: Date.now() };
      return page;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  private async dropAlgotest(): Promise<void> {
    await this.algotest?.browser.close().catch(() => undefined);
    this.algotest = null;
  }

  /** /live's text, the page reloaded when it is due; a logged-out page is dropped (re-login next). */
  private async liveText(reload: boolean): Promise<string> {
    const page = await this.algotestPage();
    const at = this.algotest as { reloadedAt: number };
    if (reload || Date.now() - at.reloadedAt >= RELOAD_EVERY_MS) {
      await page.goto(`${BASE_URL}/live`, { waitUntil: 'domcontentloaded' });
      at.reloadedAt = Date.now();
    }
    if (new URL(page.url()).pathname.includes('/login')) {
      await this.dropAlgotest();
      throw new Error('AlgoTest logged the session out');
    }
    await livePage.header(page).waitFor({ timeout: 30_000 });
    return page.evaluate(() => document.body.innerText);
  }

  private async algotestGet(path: string): Promise<unknown> {
    const page = await this.algotestPage();
    const response = await page.request.get(`${ALGOTEST_API}${path}`, {
      headers: { 'X-CSRF-TOKEN-ACCESS': await csrfToken(page.context()) },
      failOnStatusCode: false,
      timeout: 20_000,
    });
    if (!response.ok())
      throw new Error(`AlgoTest GET ${path.split('?')[0]} answered ${response.status()}`);
    return response.json();
  }

  /** Each saved strategy's Quantity Multiplier for today's weekday (`GET /executable-strategies`). */
  private async multipliers(): Promise<Map<string, number>> {
    const weekday = new Date(Date.now() + 330 * 60_000)
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
      .toLowerCase();
    const out = new Map<string, number>();
    for (let page = 1; page <= 5; page += 1) {
      const json = (await this.algotestGet(
        `/executable-strategies?page=${page}&page_size=50&weekday=${weekday}`,
      )) as { data?: { name?: unknown; multiplier?: unknown }[] };
      const data = json.data ?? [];
      for (const s of data) {
        if (typeof s.name === 'string' && typeof s.multiplier === 'number')
          out.set(s.name, s.multiplier);
      }
      if (data.length < 50) break;
    }
    return out;
  }

  // --- Quantiply ----------------------------------------------------------------------------

  private async quantiplyApp(broker: QuantiplyBroker) {
    const open = this.quantiply.get(broker);
    if (open) return open;
    const n = this.state.logins.quantiply[broker] ?? 0;
    if (n >= MAX_QUANTIPLY_LOGINS) {
      throw new Error(
        `${QUANTIPLY_SITES[broker].name}: ${MAX_QUANTIPLY_LOGINS} logins today already, not logging in again`,
      );
    }
    const creds = quantiplyCredentials(broker);
    const stateDir = dirname(quantiplyLedgerPath(this.root, broker));
    try {
      await checkLoginHold(creds, stateDir);
    } catch (error) {
      if (error instanceof LoginHeld) this.refused = true;
      throw error;
    }
    this.state.logins.quantiply[broker] = n + 1;
    await this.save();
    const app = await openQuantiplyApp(creds, stateDir, {
      headed: this.opts.headed,
      retryTotpOnce: true,
      onPage: (page) => {
        page.on('websocket', (ws) => {
          ws.on('framereceived', (frame) => {
            const payload = typeof frame.payload === 'string' ? frame.payload : '';
            for (const { id, pnl } of pnlFromSocketFrame(payload)) this.state.qpnl[id] = pnl;
          });
        });
      },
    });
    const entry = {
      api: app.api,
      browser: app.browser,
      list: [] as QListed[],
      listedAt: 0,
      unreadTicks: 0,
    };
    this.quantiply.set(broker, entry);
    return entry;
  }

  private async quantiplyList(broker: QuantiplyBroker, force = false): Promise<QListed[]> {
    const app = await this.quantiplyApp(broker);
    if (force || Date.now() - app.listedAt >= LIST_EVERY_MS) {
      try {
        app.list = parseDayWiseListed(await app.api.dayWise());
        app.listedAt = Date.now();
      } catch (error) {
        if (/answered 401/.test(describe(error))) {
          // the token ended (or another login replaced it): log in again next time, within the cap
          await app.browser.close().catch(() => undefined);
          this.quantiply.delete(broker);
        }
        throw error;
      }
    }
    return app.list;
  }

  // --- the three parts ----------------------------------------------------------------------

  async margin(): Promise<void> {
    type Use = { platform: 'algotest' | 'quantiply'; book: Book };
    const accounts: AccountMargin[] = [];
    const csv = readFileSync(
      new URL(
        '../../option-backtesting/src/option_backtesting/data/reference/margin.csv',
        import.meta.url,
      ),
      'utf8',
    );
    const perStraddle = parseMarginCsv(csv);
    for (const broker of ['finvasia', 'angelone'] as Broker[]) {
      const uses: Use[] = [];
      for (const platform of ['algotest', 'quantiply'] as const) {
        const row = this.automation.rows[`${platform}.${broker}`];
        if (row.list !== 'none') uses.push({ platform, book: row.list });
      }
      if (!uses.length) continue;
      const account: AccountMargin = {
        account: ACCOUNT_NAME[broker],
        uses: [],
        picks: [],
        free: null,
        source: '',
      };
      for (const u of uses) {
        const label = `${u.platform === 'algotest' ? 'AlgoTest' : 'Quantiply'} ${u.book === 't1' ? 'T1' : 'Core'}`;
        try {
          const p = await this.picks(u.platform, u.book);
          if (p.day !== this.day) {
            account.uses.push(`${label}: no export for today (latest ${p.day})`);
            account.picksMissing = true;
            continue;
          }
          account.uses.push(`${label} ${p.source}`);
          for (const pick of p.picks)
            account.picks.push(pickNeed(pick.name, pick.legs, perStraddle));
        } catch (error) {
          account.uses.push(`${label}: picks not read (${describe(error)})`);
          account.picksMissing = true;
        }
      }
      try {
        if (broker === 'finvasia') {
          const funds = parseAlgotestBrokers(await this.algotestGet('/brokers')).find(
            (b) => b.broker === ALGOTEST_BROKER_ID.finvasia,
          );
          const at = algotestInstant(funds?.updatedAt ?? null);
          if (!funds || funds.available === null)
            account.source = 'AlgoTest shows no Finvasia funds';
          else if (!at || istDayOf(at) !== this.day) {
            account.source = `not read: AlgoTest's Finvasia figure ${inr(funds.available)} is from ${at ? at.toISOString().slice(0, 16) : '?'} UTC (AlgoTest's broker login has not run today)`;
          } else {
            account.free = funds.available;
            account.source = `free margin as AlgoTest read it at its broker login (${new Date(at.getTime() + 330 * 60_000).toISOString().slice(11, 16)} IST); Shoonya's own API is never logged in to`;
          }
        } else {
          const out = spawnSync(
            'uv',
            ['run', '--directory', '../option-backtesting', 'obt', 'angel', 'funds', '--json'],
            {
              encoding: 'utf8',
              timeout: 6 * 60_000,
              env: process.env,
            },
          );
          const line = `${out.stdout ?? ''}`.trim().split('\n').at(-1) ?? '';
          const json = JSON.parse(line || '{}') as { ok?: boolean; net?: number; error?: string };
          if (json.ok && typeof json.net === 'number') {
            account.free = json.net;
            account.source = 'free margin (net) from Angel One SmartAPI getRMS, one guarded login';
          } else
            account.source = `not read: ${json.error ?? `obt angel funds exited ${out.status}`}`;
        }
      } catch (error) {
        account.source = `not read: ${describe(error)}`;
      }
      accounts.push(account);
    }
    if (!accounts.length) {
      console.log(
        'margin: no platform row holds a list in Settings › Automation: nothing to check',
      );
      return;
    }
    const m = marginMessage(this.day, accounts);
    await this.send(m.text, 'monitor.margin');
    this.state.margin = { at: new Date().toISOString(), ok: m.ok };
    await this.save();
  }

  async deploy(): Promise<void> {
    const checks: PlatformCheck[] = [];
    const algotestBooks = this.books('algotest');
    if (algotestBooks.length) {
      const label = `AlgoTest ${algotestBooks.map((b) => (b === 't1' ? 'T1' : 'Core')).join('+')}`;
      try {
        const names: string[] = [];
        const notes: string[] = [];
        const missing: string[] = [];
        for (const book of algotestBooks) {
          const p = await this.picks('algotest', book);
          if (p.day !== this.day)
            missing.push(`no ${book} picks exported for today (latest ${p.day})`);
          else if (p.source !== 'recorded')
            notes.push(
              `checked against last evening's expected ${book} picks (no recorded export yet)`,
            );
          if (p.day === this.day) names.push(...p.picks.map((x) => x.name));
        }
        const live: LiveState = parseLive(await this.liveText(true));
        let mult = new Map<string, number>();
        try {
          mult = await this.multipliers();
        } catch (error) {
          notes.push(`multipliers not read (${describe(error)}): deploy counts only`);
        }
        const c = checkAlgoTest(label, names, live, mult);
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
    for (const broker of ['angelone', 'finvasia'] as QuantiplyBroker[]) {
      const book = this.books('quantiply', broker)[0];
      if (!book) continue;
      const label = `Quantiply ${book === 't1' ? 'T1' : 'Core'}${broker === 'finvasia' ? ' (Shoonya)' : ''}`;
      try {
        const p = await this.picks('quantiply', book);
        const notes: string[] = [];
        const missing = p.day !== this.day ? [`no picks exported for today (latest ${p.day})`] : [];
        if (!missing.length && p.source !== 'recorded')
          notes.push("checked against last evening's expected picks (no recorded export yet)");
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
        'deploy: no platform row holds a list in Settings › Automation: nothing to check',
      );
      return;
    }
    const m = deployMessage(this.day, checks);
    await this.send(m.text, 'monitor.deploy');
    this.state.deploy = { at: new Date().toISOString(), ok: m.ok };
    await this.save();
  }

  /** One reading of the day's combined MTM; sends a level the first time it is reached. */
  async lossTick(): Promise<string> {
    const parts: MtmPart[] = [];
    if (this.books('algotest').length) {
      let value: number | null = null;
      try {
        value = parseTotalMtm(await this.liveText(false));
        if (value === null) value = parseTotalMtm(await this.liveText(true));
      } catch (error) {
        console.log(`AlgoTest MTM not read: ${describe(error)}`);
      }
      parts.push({ label: 'AlgoTest', inr: value });
    }
    for (const broker of ['angelone', 'finvasia'] as QuantiplyBroker[]) {
      if (!this.books('quantiply', broker).length) continue;
      const label = `Quantiply ${broker === 'angelone' ? 'Angel One' : 'Shoonya'}`;
      let value: number | null = null;
      try {
        const list = await this.quantiplyList(broker);
        const weekday = istWeekday();
        const unread = unreadActive(list, weekday, this.state.qpnl);
        const app = this.quantiply.get(broker);
        if (app) app.unreadTicks = unread.length ? app.unreadTicks + 1 : 0;
        value = app && app.unreadTicks >= 3 ? null : quantiplyMtm(list, weekday, this.state.qpnl);
      } catch (error) {
        console.log(`${label} MTM not read: ${describe(error)}`);
      }
      parts.push({ label, inr: value });
    }
    const at = hhmm(istMinutes());
    for (const p of parts) {
      if (p.inr === null && !this.state.loss.unreadable[p.label]) {
        this.state.loss.unreadable[p.label] = true;
        await this.send(
          `⚠️ Loss monitor ${at}: ${p.label}'s MTM cannot be read; the loss levels watch the other platform only until it can (said once today)`,
          'monitor.loss',
        );
      }
    }
    const total = parts.reduce((s, p) => s + (p.inr ?? 0), 0);
    for (const level of lossCrossings(total, this.state.loss)) {
      // the alert is never optional: untagged, so no notification setting can mute it
      await this.send(
        lossMessage(level, total, parts, at),
        level === 'alert' ? undefined : 'monitor.loss',
      );
      if (level === 'warning') this.state.loss.warned = true;
      else this.state.loss.alerted = true;
    }
    await this.save();
    return `${at} ${parts.map((p) => `${p.label} ${p.inr === null ? '?' : inr(p.inr)}`).join(' · ')} · total ${inr(total)}`;
  }

  /** Open every session the loss readings need; a failure is only logged (each reading retries). */
  async warmUp(): Promise<void> {
    if (this.books('algotest').length) {
      await this.algotestPage().catch((e) => console.log(`AlgoTest: ${describe(e)}`));
    }
    for (const broker of ['angelone', 'finvasia'] as QuantiplyBroker[]) {
      if (!this.books('quantiply', broker).length) continue;
      await this.quantiplyList(broker, true).catch((e) =>
        console.log(`${QUANTIPLY_SITES[broker].name}: ${describe(e)}`),
      );
    }
  }

  async close(): Promise<void> {
    await this.dropAlgotest();
    for (const app of this.quantiply.values()) await app.browser.close().catch(() => undefined);
    this.quantiply.clear();
  }

  markFailed(part: string, error: unknown): void {
    this.failed.add(part);
    console.error(`${part}: ${describe(error)}`);
  }

  get hadRefusal(): boolean {
    return this.refused;
  }

  get done(): DayState {
    return this.state;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      parts: { type: 'string' },
      now: { type: 'boolean', default: false },
      print: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (existsSync('.env')) process.loadEnvFile('.env');
  const asked = (values.parts ?? 'margin,deploy,loss').split(',').map((p) => p.trim()) as Part[];
  if (asked.some((p) => !(p in SWITCH))) {
    console.error('usage: [--parts margin,deploy,loss] [--now] [--print] [--headed]');
    return 64;
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
  if (!root) {
    console.error('TRADING_DATA_ROOT is not set');
    return 1;
  }
  let automation: Automation;
  try {
    automation = readAutomation();
  } catch (error) {
    console.error(`automation settings: ${describe(error)}`);
    return 1;
  }
  const m = new Monitor(day, root, automation, { print: values.print, headed: values.headed });
  await m.load();
  console.log(
    `trade monitor ${day}: ${[...parts].join(', ')}${values.print ? ' (--print: nothing sent, no state written)' : ''}`,
  );

  const run = async (part: Part, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      m.markFailed(part, error);
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
      if (parts.has('margin')) await run('margin', () => m.margin());
      if (parts.has('deploy')) await run('deploy', () => m.deploy());
      if (parts.has('loss')) console.log(await m.lossTick());
      return m.hadRefusal ? EXIT_NO_RETRY : 0;
    }
    let lastLossMinute = -1;
    let warmed = false;
    for (;;) {
      const minute = istMinutes();
      const s = m.done;
      if (parts.has('margin') && !s.margin && minute >= MARGIN_AT) {
        if (minute < SESSION_OPEN + 1) await run('margin', () => m.margin());
        else {
          console.log(`margin: ${hhmm(minute)} is past the 09:16 deploys: not checked today`);
          parts.delete('margin');
        }
      }
      if (parts.has('deploy') && !s.deploy && minute >= DEPLOY_CHECK_AT && minute < SESSION_CLOSE) {
        await run('deploy', () => m.deploy());
      }
      if (parts.has('loss') && minute >= LOSS_LOGIN_AT && minute < SESSION_CLOSE) {
        if (!warmed) {
          warmed = true;
          // log in a few minutes before the first entries (09:17), not at the first reading
          await m.warmUp();
        }
        if (inLossWindow(minute) && minute !== lastLossMinute) {
          lastLossMinute = minute;
          try {
            const line = await m.lossTick();
            if (minute % 15 === 0) console.log(line);
          } catch (error) {
            console.error(`loss reading: ${describe(error)}`);
          }
        }
      }
      const marginLeft = parts.has('margin') && !m.done.margin;
      const deployLeft = parts.has('deploy') && !m.done.deploy && minute < SESSION_CLOSE;
      const lossLeft = parts.has('loss') && minute < SESSION_CLOSE;
      if (!marginLeft && !deployLeft && !lossLeft) break;
      await sleep(TICK_MS);
    }
    // A held (refused) Quantiply login stopped only that platform's reading; say so by the exit.
    return m.hadRefusal ? EXIT_NO_RETRY : 0;
  } finally {
    await m.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (error: unknown) => {
    // Unexpected. The job alerts itself (the scheduler stays quiet on its exit), so say it here;
    // the scheduler retries, and the state file stops a check or a level being sent twice.
    const text = `⚠️ Trade monitor stopped: ${describe(error)} (the scheduler retries it)`;
    console.error(text);
    if (!process.argv.includes('--print')) {
      await Promise.resolve()
        .then(() => sendText(readTelegramConfig(), redact(text)))
        .catch(() => undefined);
    }
    process.exit(1);
  });
